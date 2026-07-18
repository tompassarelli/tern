#!/usr/bin/env bb
;; Adversarial effects-shell coverage for the gateway's registry, request, and
;; coordinator byte boundaries. Run with GATEWAY_LIB_ONLY=1.
(require '[clojure.java.io :as io]
         '[clojure.string :as str]
         '[north.gatepolicy :as gp])
(import '[java.io ByteArrayInputStream]
        '[java.net InetAddress ServerSocket]
        '[java.nio.file Files LinkOption]
        '[java.nio.file.attribute FileTime])

(when-not (= "1" (System/getenv "GATEWAY_LIB_ONLY"))
  (throw (ex-info "gateway-boundary-test requires GATEWAY_LIB_ONLY=1" {})))

(load-file
 (str (.getCanonicalPath
       (io/file (.getParent (io/file (System/getProperty "babashka.file")))
                "../.."))
      "/deploy/gateway/gateway.clj"))

(def checks (atom []))
(defn check! [label ok?] (swap! checks conj [label (boolean ok?)]))
(def tmp-dir (.toFile (Files/createTempDirectory "north-gateway-boundary-" (make-array java.nio.file.attribute.FileAttribute 0))))
(def registry-file (io/file tmp-dir "tenants.edn"))
(alter-var-root #'tenants-path (constantly (.getCanonicalPath registry-file)))

(defn registry-map [entries] (spit registry-file (pr-str entries)))
(defn route [hashes]
  {:tokens (set hashes)
   :coordinator-host "127.0.0.1"
   :coordinator-port 7977
   :coordinator-log "/tmp/north-gateway-test.log"})
(def token-a "token-a")
(def token-b "token-b")
(def hash-a (gp/sha256-hex token-a))
(def hash-b (gp/sha256-hex token-b))

(defn coordinator-probe [write-response deadline-ms]
  (with-open [server (ServerSocket. 0)]
    (let [worker
          (future
            (try
              (with-open [socket (.accept server)
                          reader (io/reader (.getInputStream socket))]
                (.readLine reader)
                (write-response socket (.getOutputStream socket)))
              (catch Exception _ nil)))
          result
          (try
            {:response
             (coord-rpc (InetAddress/getLoopbackAddress)
                        (.getLocalPort server)
                        {:op :version}
                        1024
                        deadline-ms)}
            (catch java.net.SocketTimeoutException error
              {:timeout (.getMessage error)})
            (catch Exception error
              {:kind (:kind (ex-data error))
               :message (.getMessage error)}))]
      (deref worker 2000 nil)
      result)))

(try
  ;; Content, not mtime/size, is the cache identity.
  (registry-map {"tenant" (route [hash-a])})
  (reset! registry {:sig nil :by-token {} :tenants 0})
  (check! "valid registry authenticates its token"
          (= "tenant" (:tid (tenant-for-token token-a))))
  (let [stamp (Files/getLastModifiedTime (.toPath registry-file)
                                         (make-array LinkOption 0))
        size (.length registry-file)]
    (registry-map {"tenant" (route [hash-b])})
    (Files/setLastModifiedTime (.toPath registry-file) stamp)
    (check! "same-size same-mtime replacement is detected by content digest"
            (and (= size (.length registry-file))
                 (nil? (tenant-for-token token-a))
                 (= "tenant" (:tid (tenant-for-token token-b))))))

  ;; A malformed rewrite must revoke the previously cached authorization.
  (doseq [[label write-invalid!]
          [["trailing registry form"
            #(spit registry-file
                   (str (pr-str {"tenant" (route [hash-b])}) " {}"))]
           ["invalid registry UTF-8"
            #(with-open [out (io/output-stream registry-file)]
               (.write out (byte-array [(unchecked-byte 0xc3)
                                        (unchecked-byte 0x28)])))]]]
    (write-invalid!)
    (let [loaded (try (load-registry!) (catch Throwable _ ::threw))]
      (check! (str label " fails closed without throwing")
              (and (not= ::threw loaded)
                   (empty? (:by-token loaded))
                   (nil? (tenant-for-token token-b))))))

  ;; A hash shared by two tenants authenticates neither; unrelated hashes still
  ;; route deterministically.
  (registry-map
   {"a" (route [hash-a])
    "b" (route [hash-a hash-b])})
  (reset! registry {:sig nil :by-token {} :tenants 0})
  (check! "duplicate token hash is rejected for every owner"
          (nil? (tenant-for-token token-a)))
  (check! "non-colliding token remains routable"
          (= "b" (:tid (tenant-for-token token-b))))

  (doseq [host ["169.254.169.254"
                "224.0.0.1"
                "fe80::1"
                "fe90::1"
                "fea0::1"
                "febf::1"
                "ff02::1"]]
    (check! (str "SSRF classifier blocks " host)
            (ip-blocked? (InetAddress/getByName host))))
  (doseq [host ["127.0.0.1" "10.0.0.1" "::1" "fd00::1"]]
    (check! (str "SSRF classifier permits ordinary route " host)
            (not (ip-blocked? (InetAddress/getByName host)))))
  (let [mapped
        (InetAddress/getByAddress
         "mapped-metadata"
         (byte-array
          (map unchecked-byte
               [0 0 0 0 0 0 0 0 0 0 255 255 169 254 169 254])))]
    (check! "SSRF classifier blocks IPv4-mapped metadata"
            (ip-blocked? mapped)))

  (let [tenant (gp/->Tenant "test" "127.0.0.1" 7977 "/tmp/north-gateway-test.log")
        connects (atom 0)
        request (fn [bytes]
                  {:remote-addr "127.0.0.1"
                   :headers {"authorization" "Bearer ignored"}
                   :body (ByteArrayInputStream. bytes)})]
    (with-redefs [tenant-for-token (constantly tenant)
                  allow? (constantly true)
                  resolve-coord-address
                  (fn [_] (InetAddress/getLoopbackAddress))
                  coord-rpc
                  (fn [& _]
                    (swap! connects inc)
                    "{:version 1}")]
      (let [trailing (.getBytes "{:op :version} junk" "UTF-8")
            malformed (byte-array [(unchecked-byte 0xc3)
                                   (unchecked-byte 0x28)])
            trailing-response (handle-rpc (request trailing))
            malformed-response (handle-rpc (request malformed))]
        (check! "trailing request form returns 400"
                (= 400 (:status trailing-response)))
        (check! "malformed request UTF-8 returns 400"
                (= 400 (:status malformed-response)))
        (check! "invalid request bytes never reach coordinator connect"
                (zero? @connects))))

    (let [valid
          (coordinator-probe
           (fn [_ out]
             (.write out (.getBytes "{:version 1}\n" "UTF-8"))
             (.flush out))
           500)
          same-chunk
          (coordinator-probe
           (fn [_ out]
             (.write out (.getBytes "{:version 1}\n{:version 2}\n" "UTF-8"))
             (.flush out))
           500)
          later-frame
          (coordinator-probe
           (fn [_ out]
             (.write out (.getBytes "{:version 1}\n" "UTF-8"))
             (.flush out)
             (Thread/sleep 20)
             (.write out (.getBytes "{:version 2}\n" "UTF-8"))
             (.flush out))
           500)
          held-open
          (coordinator-probe
           (fn [_ out]
             (.write out (.getBytes "{:version 1}\n" "UTF-8"))
             (.flush out)
             (Thread/sleep 150))
           50)]
      (check! "one coordinator frame followed by EOF is accepted"
              (= "{:version 1}" (:response valid)))
      (check! "same-chunk second coordinator frame is rejected"
              (= :coord-response-surplus (:kind same-chunk)))
      (check! "later second coordinator frame is rejected"
              (= :coord-response-surplus (:kind later-frame)))
      (check! "held-open terminal frame is bounded by the original deadline"
              (str/includes? (or (:timeout held-open) "") "deadline exceeded")))

    ;; Exercise the real response decoder through handle-rpc: invalid UTF-8 is a
    ;; protocol framing failure (502), never an uncaught/generic 500.
    (with-open [server (ServerSocket. 0)]
      (let [worker
            (future
              (with-open [socket (.accept server)
                          reader (io/reader (.getInputStream socket))]
                (.readLine reader)
                (let [out (.getOutputStream socket)]
                  (.write out
                          (byte-array [(unchecked-byte 0xc3)
                                       (unchecked-byte 0x28)
                                       (unchecked-byte 0x0a)]))
                  (.flush out))))
            wire-tenant
            (gp/->Tenant "wire" "127.0.0.1" (.getLocalPort server)
                         "/tmp/north-gateway-test.log")]
        (with-redefs [tenant-for-token (constantly wire-tenant)
                      allow? (constantly true)]
          (let [response
                (handle-rpc
                 {:remote-addr "127.0.0.1"
                  :headers {"authorization" "Bearer ignored"}
                  :body (ByteArrayInputStream.
                         (.getBytes "{:op :version}" "UTF-8"))})]
            (check! "malformed coordinator UTF-8 maps to 502"
                    (= 502 (:status response)))))
        (deref worker 2000 nil)))

    ;; A syntactically valid first frame plus any second frame is still invalid
    ;; framing at the HTTP boundary, never a generic gateway 500.
    (with-open [server (ServerSocket. 0)]
      (let [worker
            (future
              (with-open [socket (.accept server)
                          reader (io/reader (.getInputStream socket))]
                (.readLine reader)
                (let [out (.getOutputStream socket)]
                  (.write out (.getBytes "{:version 1}\n{:version 2}\n" "UTF-8"))
                  (.flush out))))
            wire-tenant
            (gp/->Tenant "wire" "127.0.0.1" (.getLocalPort server)
                         "/tmp/north-gateway-test.log")]
        (with-redefs [tenant-for-token (constantly wire-tenant)
                      allow? (constantly true)]
          (let [response
                (handle-rpc
                 {:remote-addr "127.0.0.1"
                  :headers {"authorization" "Bearer ignored"}
                  :body (ByteArrayInputStream.
                         (.getBytes "{:op :version}" "UTF-8"))})]
            (check! "surplus coordinator frame maps to framing 502"
                    (and (= 502 (:status response))
                         (str/includes? (:body response)
                                       "invalid coordinator response framing")))))
        (deref worker 2000 nil))))

  (finally
    (doseq [f (reverse (file-seq tmp-dir))] (.delete f))))

(let [results @checks
      passed (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\ngateway boundary: %d / %d PASS" passed (count results)))
  (System/exit (if (= passed (count results)) 0 1)))
