#!/usr/bin/env bb
;; The live roster must scale with live leases, not the lifetime count of
;; historical sessions. Exercise the live-only projection against a throwaway
;; coordinator and prove a lapsed session remains visible historically but is
;; excluded from the bounded roster input.
(require '[babashka.process :as proc]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram (str (System/getProperty "user.home") "/code/fram"))
(def presence-cli (str root "/cli/presence-cli.clj"))
(def checks (atom []))
(def test-log (atom nil))

(defn check [label ok?] (swap! checks conj [label (boolean ok?)]))
(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))
(defn port-open? [port]
  (try
    (with-open [socket (java.net.Socket.)]
      (.connect socket (java.net.InetSocketAddress. "127.0.0.1" (int port)) 100)
      true)
    (catch Exception _ false)))
(defn await-port [port]
  (loop [attempt 0]
    (cond (port-open? port) true
          (>= attempt 200) false
          :else (do (Thread/sleep 25) (recur (inc attempt))))))
(defn coordinator-op [port request]
  (with-open [socket (java.net.Socket. "127.0.0.1" (int port))]
    (.setSoTimeout socket 5000)
    (let [writer (.getOutputStream socket)
          reader (io/reader (.getInputStream socket))]
      (.write writer
              (.getBytes
               (str (pr-str {:op :for-log
                             :expected-log @test-log
                             :request request})
                    "\n")))
      (.flush writer)
      (edn/read-string (.readLine reader)))))
(defn run-presence [port & args]
  (apply proc/sh {:out :string :err :string :continue true
                  :extra-env {"FRAM_LOG" @test-log}}
         "bb" presence-cli (str port) args))
(defn run-against-response [response]
  (with-open [server (java.net.ServerSocket. 0)]
    (let [served
          (future
            (with-open [socket (.accept server)
                        reader (io/reader (.getInputStream socket))]
              (.readLine reader)
              (let [writer (.getOutputStream socket)]
                (.write writer
                        (.getBytes (str (pr-str response) "\n")
                                   java.nio.charset.StandardCharsets/UTF_8))
                (.flush writer))))
          result (run-presence (.getLocalPort server) "presence-online-json")]
      @served
      result)))

(let [port (free-port)
      tmp (.toFile
           (java.nio.file.Files/createTempDirectory
            "north-presence-online" (make-array java.nio.file.attribute.FileAttribute 0)))
      facts (io/file tmp "facts.log")
      daemon (do
               (spit facts "")
               (proc/process {:dir fram :out :string :err :string
                              :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"
                                          "FRAM_SINGLE_VALUED" "agent dir session_id started_at"}}
                             "bb" "-cp" "out" "coord_daemon.clj"
                             "serve-flat" (str port) (.getPath facts)))]
  (reset! test-log (.getCanonicalPath facts))
  (try
    (check "throwaway Fram coordinator starts" (await-port port))
    (check "live session registers"
           (zero? (:exit (run-presence port "register" "live-session" "/tmp/live" "live-session"))))
    (check "historical session registers"
           (zero? (:exit (run-presence port "register" "lapsed-session" "/tmp/lapsed" "lapsed-session"))))
    (coordinator-op port {:op :release-lease :res "session:lapsed-session" :holder "lapsed-session"})
    (let [live (:out (run-presence port "presence-online"))
          full (:out (run-presence port "presence"))]
      (check "live-only projection includes the unexpired session"
             (str/includes? live "live-session"))
      (check "live-only projection excludes historical lapsed sessions"
             (not (str/includes? live "lapsed-session")))
      (check "full historical projection remains available"
             (and (str/includes? full "live-session")
                  (str/includes? full "lapsed-session")
                  (str/includes? full "lapsed"))))
    (let [error-result
          (run-against-response
           {:error ["coordinator unavailable"] :version 1 :engine "index"})
          malformed-row-result
          (run-against-response
           {:ok [["@lease:session:broken"]] :version 1 :engine "index"})
          unsafe-version-result
          (run-against-response
           {:ok [] :version 9007199254740992 :engine "index"})
          malformed-lease-result
          (run-against-response
           {:ok [["@lease:session:broken" "not-a-lease"]]
            :version 1 :engine "index"})
          wrong-holder-result
          (run-against-response
           {:ok [["@lease:session:broken" "someone-else|9999999999999|1"]]
            :version 1 :engine "index"})
          overflow-result
          (run-against-response
           {:ok [["@lease:session:broken"
                  "broken|9007199254740992|1"]]
            :version 1 :engine "index"})
          duplicate-distinct-result
          (run-against-response
           {:ok [["@lease:session:duplicate" "duplicate|9999999999999|1"]
                 ["@lease:session:duplicate" "duplicate|9999999999998|2"]]
            :version 1 :engine "index"})
          duplicate-exact-result
          (run-against-response
           {:ok [["@lease:session:duplicate" "duplicate|9999999999999|1"]
                 ["@lease:session:duplicate" "duplicate|9999999999999|1"]]
            :version 1 :engine "index"})]
      (check "coordinator error cannot become a successful empty JSON roster"
             (and (not (zero? (:exit error-result)))
                  (not (str/includes? (:out error-result)
                                      "north:presence-online:v1"))))
      (check "malformed coordinator rows fail the JSON roster closed"
             (and (not (zero? (:exit malformed-row-result)))
                  (not (str/includes? (:out malformed-row-result)
                                      "north:presence-online:v1"))))
      (check "unsafe coordinator versions fail the JSON roster closed"
             (not (zero? (:exit unsafe-version-result))))
      (check "malformed lease values fail the JSON roster closed"
             (and (not (zero? (:exit malformed-lease-result)))
                  (not (str/includes? (:out malformed-lease-result)
                                      "north:presence-online:v1"))))
      (check "session lease holder mismatch fails the JSON roster closed"
             (not (zero? (:exit wrong-holder-result))))
      (check "overflowing lease integers fail the JSON roster closed"
             (not (zero? (:exit overflow-result))))
      (check "distinct duplicate session leases fail the JSON roster closed"
             (not (zero? (:exit duplicate-distinct-result))))
      (check "exact duplicate session leases fail the JSON roster closed"
             (not (zero? (:exit duplicate-exact-result)))))
    (finally
      (proc/destroy-tree daemon)
      (doseq [file (reverse (file-seq tmp))]
        (io/delete-file file true)))))

(let [results @checks
      passed (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\npresence online integration: %d / %d PASS" passed (count results)))
  (System/exit (if (= passed (count results)) 0 1)))
