#!/usr/bin/env bb
;; Shared coordinator-wire regressions that do not require a Fram checkout:
;; a pre-fence daemon must see only the unknown :for-log envelope, and a peer
;; that accepts but never replies must hit North's bounded read deadline.
(require '[babashka.process :as proc]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def child-form
  (str "(load-file (str (System/getenv \"NORTH_ROOT\") \"/cli/coord.clj\")) "
       "(prn (north.coord/append! (Integer/parseInt (System/getenv \"NORTH_TEST_PORT\")) "
       "\"@wire-test\" \"note\" \"must-not-land\"))"))
(def stream-child-form
  (str "(load-file (str (System/getenv \"NORTH_ROOT\") \"/cli/coord.clj\")) "
       "(with-open [s (north.coord/connect-socket "
       "(Integer/parseInt (System/getenv \"NORTH_TEST_PORT\")))] "
       "(let [w (.getOutputStream s) "
       "reader (north.coord/coordinator-reader s)] "
       "(.write w (.getBytes "
       "(str (pr-str (north.coord/log-envelope {:op :subscribe})) \"\\n\") "
       "java.nio.charset.StandardCharsets/UTF_8)) "
       "(.flush w) "
       "(north.coord/validate-subscription! "
       "(north.coord/read-line-bounded! reader)) "
       "(.setSoTimeout s 0) "
       "(prn (north.coord/read-stream-line-bounded! reader))))"))
(def large-child-form
  (str "(load-file (str (System/getenv \"NORTH_ROOT\") \"/cli/coord.clj\")) "
       "(println (count (:ok (north.coord/send-op "
       "(Integer/parseInt (System/getenv \"NORTH_TEST_PORT\")) "
       "{:op :version}))))"))
(def checks (atom []))
(defn check! [label value]
  (swap! checks conj [label (boolean value)]))

(load-file (str root "/cli/coord.clj"))
(let [ordinary
      (with-redefs [north.coord/send-op-for-log
                    (fn [_ _ _] (throw (ex-info "ordinary" {})))]
        (north.coord/strict-coordinator-status
         7977 "/tmp/north expected corpus.log"))
      fatal-propagates?
      (with-redefs [north.coord/send-op-for-log
                    (fn [_ _ _] (throw (Error. "fatal")))]
        (try
          (north.coord/strict-coordinator-status
           7977 "/tmp/north expected corpus.log")
          false
          (catch Error _ true)))]
  (check! "strict probe normalizes ordinary transport failures"
          (= :probe-failed (:reason ordinary)))
  (check! "strict probe does not swallow VM-fatal Errors"
          fatal-propagates?))

(defn child
  ([port] (child port {}))
  ([port extra-env]
   (proc/shell
    {:continue true
     :out :string
     :err :string
     :extra-env
     (merge {"NORTH_ROOT" root
             "NORTH_TEST_PORT" (str port)
             "FRAM_LOG" "/tmp/north expected corpus.log"
             "NORTH_COORD_CONNECT_TIMEOUT_MS" "150"
             "NORTH_COORD_READ_TIMEOUT_MS" "150"}
            extra-env)}
    "bb" "-e" child-form)))

(defn stream-child [port]
  (proc/shell
   {:continue true
    :out :string
    :err :string
    :extra-env {"NORTH_ROOT" root
                "NORTH_TEST_PORT" (str port)
                "FRAM_LOG" "/tmp/north expected corpus.log"
                "NORTH_COORD_CONNECT_TIMEOUT_MS" "150"
                "NORTH_COORD_READ_TIMEOUT_MS" "150"
                "NORTH_COORD_MAX_RESPONSE_BYTES" "256"}}
   "bb" "-e" stream-child-form))

(defn large-child [port]
  (proc/shell
   {:continue true
    :out :string
    :err :string
    :extra-env {"NORTH_ROOT" root
                "NORTH_TEST_PORT" (str port)
                "FRAM_LOG" "/tmp/north expected corpus.log"
                "NORTH_COORD_CONNECT_TIMEOUT_MS" "500"
                "NORTH_COORD_READ_TIMEOUT_MS" "3000"
                "NORTH_COORD_MAX_RESPONSE_BYTES" "1048576"}}
   "bb" "-e" large-child-form))

(defn scripted-peer [write-response extra-env]
  (let [server (java.net.ServerSocket. 0)
        worker
        (future
          (with-open [socket (.accept server)
                      reader (io/reader (.getInputStream socket))]
            (.readLine reader)
            (write-response socket)))
        started (System/nanoTime)
        result (child (.getLocalPort server) extra-env)
        elapsed-ms (/ (- (System/nanoTime) started) 1e6)]
    (.close server)
    (try (deref worker 2000 nil) (catch Throwable _ nil))
    {:result result :elapsed-ms elapsed-ms}))

;; A legacy daemon understands raw :assert but not :for-log. The new client
;; must send only the latter and accept the unknown-op response as a refusal.
(let [server (java.net.ServerSocket. 0)
      request (promise)
      worker
      (future
        (with-open [socket (.accept server)
                    reader (io/reader (.getInputStream socket))
                    writer (io/writer (.getOutputStream socket))]
          (let [received (edn/read-string (.readLine reader))]
            (deliver request received)
            (.write writer (str (pr-str {:error "unknown op"}) "\n"))
            (.flush writer))))
      result (child (.getLocalPort server))
      received (deref request 2000 ::timeout)]
  (.close server)
  (deref worker 2000 nil)
  (check! "pre-fence daemon receives one explicit log envelope"
          (and (zero? (:exit result))
               (= :for-log (:op received))
               (= :assert (get-in received [:request :op]))
               (= "/tmp/north expected corpus.log" (:expected-log received))))
  (check! "pre-fence unknown-op response never becomes a successful write"
          (and (not (:ok (edn/read-string (:out result))))
               (re-find #"unknown op" (:out result)))))

;; Large query responses must be linearly bounded without reverting to one
;; interpreted/native socket read per byte.
(let [payload-size 524288
      payload (apply str (repeat payload-size "x"))
      server (java.net.ServerSocket. 0)
      worker
      (future
        (with-open [socket (.accept server)
                    reader (io/reader (.getInputStream socket))]
          (.readLine reader)
          (let [output (.getOutputStream socket)]
            (.write output
                    (.getBytes (str "{:ok \"" payload "\"}\n")
                               java.nio.charset.StandardCharsets/UTF_8))
            (.flush output))))
      started (System/nanoTime)
      result (large-child (.getLocalPort server))
      elapsed-ms (/ (- (System/nanoTime) started) 1e6)]
  (.close server)
  (try (deref worker 2000 nil) (catch Throwable _ nil))
  (println
   (format "  [METRIC] 512 KiB fenced EDN response parsed in %.1fms"
           elapsed-ms))
  (check! "chunked reader handles a 512 KiB EDN response within the latency budget"
          (and (zero? (:exit result))
               (= (str payload-size) (str/trim (:out result)))
               (< elapsed-ms 1500.0))))

;; Accept the connection and then remain silent. The child must terminate from
;; SO_TIMEOUT; without it every auxiliary CLI/hook can hang indefinitely.
(let [server (java.net.ServerSocket. 0)
      accepted (promise)
      worker
      (future
        (with-open [socket (.accept server)]
          (deliver accepted true)
          (Thread/sleep 5000)))
      started (System/nanoTime)
      result (child (.getLocalPort server))
      elapsed-ms (/ (- (System/nanoTime) started) 1e6)]
  (.close server)
  (future-cancel worker)
  (check! "silent accepted peer reaches the read timeout"
          (and (true? (deref accepted 1000 false))
               (not (zero? (:exit result)))
               (str/includes?
                (:err result)
                "coordinator response deadline exceeded")))
  (check! "silent-peer failure is deterministically bounded"
          (and (>= elapsed-ms 100.0) (< elapsed-ms 2000.0))))

;; Inactivity timeouts are insufficient: a peer can drip one byte just under
;; SO_TIMEOUT forever. The absolute deadline must still end this response.
(let [{:keys [result elapsed-ms]}
      (scripted-peer
       (fn [socket]
         (let [output (.getOutputStream socket)]
           (try
             (dotimes [_ 10]
               (.write output (.getBytes " "
                                         java.nio.charset.StandardCharsets/UTF_8))
               (.flush output)
               (Thread/sleep 40))
             (catch java.net.SocketException _ nil))))
       {})]
  (check! "drip peer cannot extend the absolute response deadline"
          (and (not (zero? (:exit result)))
               (str/includes?
                (:err result)
                "coordinator response deadline exceeded")
               (>= elapsed-ms 100.0)
               (< elapsed-ms 2000.0))))

(let [{:keys [result]}
      (scripted-peer
       (fn [socket]
         (let [output (.getOutputStream socket)]
           (.write output
                   (.getBytes
                    (str (apply str (repeat 65 "x")) "\n")
                    java.nio.charset.StandardCharsets/UTF_8))
           (.flush output)))
       {"NORTH_COORD_MAX_RESPONSE_BYTES" "64"})]
  (check! "oversized response line is rejected before EDN parsing"
          (and (not (zero? (:exit result)))
               (str/includes? (:err result)
                              "coordinator response line exceeds 64 bytes"))))

(let [{:keys [result]}
      (scripted-peer
       (fn [socket]
         (let [output (.getOutputStream socket)]
           (.write output
                   (byte-array [(unchecked-byte 0xC3)
                                (unchecked-byte 0x28)
                                (unchecked-byte 0x0A)]))
           (.flush output)))
       {})]
  (check! "malformed UTF-8 response is rejected deterministically"
          (and (not (zero? (:exit result)))
               (str/includes? (:err result)
                              "coordinator response line is not valid UTF-8"))))

(let [{:keys [result]}
      (scripted-peer
       (fn [socket]
         (let [output (.getOutputStream socket)]
           (.write output
                   (.getBytes "{:ok\n"
                              java.nio.charset.StandardCharsets/UTF_8))
           (.flush output)))
       {})]
  (check! "malformed EDN response is rejected deterministically"
          (and (not (zero? (:exit result)))
               (str/includes?
                (:err result)
                "coordinator response line is not exactly one valid EDN form"))))

;; A request/response connection has exactly one terminal frame. Silently
;; accepting the first line would let a desynchronized or hostile peer smuggle
;; surplus protocol data past the client boundary.
(let [{:keys [result]}
      (scripted-peer
       (fn [socket]
         (let [output (.getOutputStream socket)]
           (.write output
                   (.getBytes
                    (str (pr-str {:ok "first"}) "\n"
                         (pr-str {:ok "surplus"}) "\n")
                    java.nio.charset.StandardCharsets/UTF_8))
           (.flush output)))
       {})]
  (check! "multiple terminal response frames are rejected"
          (and (not (zero? (:exit result)))
               (str/includes?
                (:err result)
                "coordinator sent more than one terminal response frame"))))

;; One valid line without terminal EOF is still incomplete. The same absolute
;; request deadline owns both the line and the connection terminator.
(let [{:keys [result elapsed-ms]}
      (scripted-peer
       (fn [socket]
         (let [output (.getOutputStream socket)]
           (.write output
                   (.getBytes
                    (str (pr-str {:ok "first"}) "\n")
                    java.nio.charset.StandardCharsets/UTF_8))
           (.flush output)
           (Thread/sleep 500)))
       {})]
  (check! "terminal response must close within the absolute deadline"
          (and (not (zero? (:exit result)))
               (str/includes?
                (:err result)
                "coordinator response deadline exceeded")
               (>= elapsed-ms 100.0)
               (< elapsed-ms 2000.0))))

;; After the validated handshake an idle subscription intentionally has no
;; deadline, but one unterminated event still cannot grow without bound.
(let [server (java.net.ServerSocket. 0)
      worker
      (future
        (with-open [socket (.accept server)
                    reader (io/reader (.getInputStream socket))]
          (.readLine reader)
          (let [output (.getOutputStream socket)]
            (.write output
                    (.getBytes
                     (str (pr-str
                           {:subscribed 0
                            :log "/tmp/north expected corpus.log"})
                          "\n"
                          (apply str (repeat 257 "x")))
                     java.nio.charset.StandardCharsets/UTF_8))
            (.flush output)
            (Thread/sleep 500))))
      result (stream-child (.getLocalPort server))]
  (.close server)
  (try (deref worker 2000 nil) (catch Throwable _ nil))
  (check! "post-handshake unterminated event is byte-capped without an idle timeout"
          (and (not (zero? (:exit result)))
               (str/includes? (:err result)
                              "coordinator response line exceeds 256 bytes"))))

(doseq [path ["cli/north-listen.clj" "cli/north-reactor.clj"]
        :let [source (slurp (io/file root path))
              bounded (str/index-of source
                                    "(north.coord/read-line-bounded! reader)")
              idle (str/index-of source "(.setSoTimeout s 0)")
              stream (str/index-of
                      source
                      "(north.coord/read-stream-line-bounded! reader)")]]
  (check! (str path " bounds handshake and post-handshake stream lines")
          (and bounded idle stream (< bounded idle stream))))

(doseq [[label ok?] @checks]
  (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
(let [failed (remove second @checks)]
  (println (format "\ncoord wire boundary: %d / %d PASS"
                   (- (count @checks) (count failed))
                   (count @checks)))
  (System/exit (if (empty? failed) 0 1)))
