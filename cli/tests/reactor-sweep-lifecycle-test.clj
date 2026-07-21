#!/usr/bin/env bb
;; Whole-run lifecycle regression for the production north-reactor sweep-once
;; entrypoint. Fixtures are isolated: an empty temporary log, a throwaway Fram
;; coordinator, and a planted blackhole socket. Canonical Fram is never mutated.
(require '[babashka.process :as proc]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def test-file (io/file (System/getProperty "babashka.file")))
(def root (-> test-file .getParentFile .getParentFile .getParentFile .getCanonicalPath))
(def reactor (str root "/cli/north-reactor.clj"))
(def fram "/home/tom/code/fram")
(def checks (atom []))

(defn check [label ok detail]
  (swap! checks conj [label ok detail]))

(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))

(defn await-port [port]
  (loop [attempt 0]
    (let [connected?
          (try
            (with-open [socket (java.net.Socket.)]
              (.connect socket (java.net.InetSocketAddress. "127.0.0.1" (int port)) 50)
              true)
            (catch Throwable _ false))]
      (cond
        connected? true
        (< attempt 100) (do (Thread/sleep 20) (recur (inc attempt)))
        :else false))))

(defn common-env [tmp port log lock timeout-ms]
  {"HOME" (.getCanonicalPath (io/file tmp "home"))
   "FRAM_PORT" (str port)
   "FRAM_LOG" (.getCanonicalPath log)
   "NORTH_AGENT_LOGS_DIR" (.getCanonicalPath (io/file tmp "agent-logs"))
   "NORTH_REACTOR_HEARTBEAT" (.getCanonicalPath (io/file tmp "heartbeat"))
   "NORTH_REACTOR_SWEEP_LOCK_PATH" (.getCanonicalPath lock)
   "NORTH_REACTOR_SWEEP_TIMEOUT_MS" (str timeout-ms)
   "NORTH_REACTOR_SWEEP_RETRY_MS" "50"
   "NORTH_COORD_CONNECT_TIMEOUT_MS" "50"
   "NORTH_COORD_READ_TIMEOUT_MS" "10000"})

(defn start-sweep [environment]
  (proc/process {:dir root :out :string :err :string :extra-env environment}
                "bb" reactor "sweep-once" "--dry-run"))

(defn start-coordinator [port log]
  (proc/process {:dir fram :out :string :err :string
                 :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"}}
                "bb" "-cp" "out" "coord_daemon.clj"
                "serve-flat" (str port) (.getCanonicalPath log)))

(defn start-blackhole [port]
  (let [server (java.net.ServerSocket. port)
        sockets (atom [])
        stopped (atom false)
        acceptor
        (future
          (while (not @stopped)
            (try
              (let [socket (.accept server)]
                (swap! sockets conj socket))
              (catch java.net.SocketException _ nil))))]
    {:sockets sockets
     :stop (fn []
             (reset! stopped true)
             (try (.close server) (catch Throwable _ nil))
             (doseq [socket @sockets]
               (try (.close ^java.net.Socket socket) (catch Throwable _ nil)))
             (future-cancel acceptor))}))

(def tmp (.toFile
          (java.nio.file.Files/createTempDirectory
           "north-reactor-sweep-lifecycle-"
           (make-array java.nio.file.attribute.FileAttribute 0))))

(try
  (doto (io/file tmp "home") .mkdirs)
  (doto (io/file tmp "agent-logs") .mkdirs)

  ;; The sweep begins while the coordinator is down, observes connection
  ;; refusal, and completes after the isolated coordinator comes online.
  (let [port (free-port)
        log (io/file tmp "reconnect.log")
        lock (io/file tmp "reconnect.lock")
        environment (common-env tmp port log lock 5000)
        _ (spit log "")
        started (System/nanoTime)
        sweep (start-sweep environment)
        _ (Thread/sleep 250)
        daemon (start-coordinator port log)]
    (try
      (when-not (await-port port)
        (throw (ex-info "throwaway coordinator did not start"
                        {:stdout (deref (:out daemon))
                         :stderr (deref (:err daemon))})))
      (let [result @sweep
            elapsed-ms (long (/ (- (System/nanoTime) started) 1000000))
            output (str (:out result) (:err result))]
        (check "disconnect/reconnect completes inside the whole-run deadline"
               (and (zero? (:exit result)) (< elapsed-ms 5000)
                    (str/includes? output "coordinator unavailable")
                    (str/includes? output "terminal=completed")
                    (re-find #"attempts=(?:[2-9]|[1-9][0-9]+)\b" output))
               output))
      (finally
        (try (proc/destroy-tree daemon) (catch Throwable _ nil)))))

  ;; A server that accepts but never answers defeats the coordinator's normal
  ;; read path. The whole-run deadline must still terminate the process cleanly.
  ;; While that run holds the lock, a second invocation must not reach the socket.
  (let [port (free-port)
        log (doto (io/file tmp "blocked.log") (spit ""))
        lock (io/file tmp "blocked.lock")
        blackhole (start-blackhole port)
        environment (common-env tmp port log lock 800)
        started (System/nanoTime)
        first-sweep (start-sweep environment)]
    (try
      (loop [attempt 0]
        (when (and (empty? @(:sockets blackhole)) (< attempt 100))
          (Thread/sleep 10)
          (recur (inc attempt))))
      (let [second-started (System/nanoTime)
            second-result @(start-sweep environment)
            second-elapsed-ms (long (/ (- (System/nanoTime) second-started) 1000000))
            second-output (str (:out second-result) (:err second-result))
            accepted-before-first-exit (count @(:sockets blackhole))
            first-result @first-sweep
            first-elapsed-ms (long (/ (- (System/nanoTime) started) 1000000))
            first-output (str (:out first-result) (:err first-result))]
        (check "concurrent sweep is deferred without reaching coordinator"
               (and (zero? (:exit second-result)) (< second-elapsed-ms 500)
                    (= 1 accepted-before-first-exit)
                    (str/includes? second-output
                                   "terminal=deferred reason=already-running"))
               second-output)
        (check "blocked coordinator has bounded clean terminal result"
               (and (zero? (:exit first-result)) (< first-elapsed-ms 2000)
                    (str/includes? first-output
                                   "terminal=deferred reason=deadline")
                    (str/includes? first-output
                                   "action=retry-on-next-scheduled-run"))
               first-output))
      (finally ((:stop blackhole)))))

  ;; A bad lifecycle setting is a real operator/configuration failure, not a
  ;; transient coordinator condition, and must remain actionable + nonzero.
  (let [port (free-port)
        log (doto (io/file tmp "invalid.log") (spit ""))
        lock (io/file tmp "invalid.lock")
        result @(start-sweep
                 (assoc (common-env tmp port log lock 100)
                        "NORTH_REACTOR_SWEEP_TIMEOUT_MS" "300000"))
        output (str (:out result) (:err result))]
    (check "invalid timeout is a nonzero actionable terminal failure"
           (and (= 1 (:exit result))
                (str/includes? output "terminal=failed")
                (str/includes? output "check-sweep-lifecycle-configuration"))
           output))

  (finally
    (doseq [file (reverse (file-seq tmp))]
      (try (io/delete-file file true) (catch Throwable _ nil)))))

(let [results @checks
      passed (count (filter second results))]
  (doseq [[label ok detail] results]
    (println (format "  [%s] %s" (if ok "PASS" "FAIL") label))
    (when-not ok (println (str "        " detail))))
  (println (format "\nreactor sweep lifecycle: %d / %d PASS"
                   passed (count results)))
  (System/exit (if (= passed (count results)) 0 1)))
