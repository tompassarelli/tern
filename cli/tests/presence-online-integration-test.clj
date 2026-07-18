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
