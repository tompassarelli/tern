#!/usr/bin/env bb
(require '[babashka.process :as proc]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(load-file (str root "/cli/runtime-attestation.clj"))
(require '[north.runtime-attestation :as attestation])
(def fram
  (.getCanonicalPath
   (io/file (or (System/getenv "FRAM_PATH") (str root "/../fram")))))
(def failures (atom []))

(defn check! [label value]
  (if value
    (println "  ✓" label)
    (do (println "  ✗" label) (swap! failures conj label))))

(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))

(defn delete-tree! [file]
  (when (.isDirectory file)
    (doseq [child (or (.listFiles file) (make-array java.io.File 0))]
      (delete-tree! child)))
  (java.nio.file.Files/deleteIfExists (.toPath file)))

(defn git-value [expression]
  (let [result (proc/shell {:out :string :err :string :continue true}
                           "git" "-C" fram "rev-parse" "--verify" expression)]
    (when-not (zero? (:exit result))
      (throw (ex-info "runtime attestation test requires a Git Fram source"
                      {:fram fram :error (:err result)})))
    (str/trim (:out result))))

(defn write-record! [path pid owner]
  (spit path
        (str "PID=" pid "\n"
             "PID_BIRTH=" (attestation/process-birth-token pid) "\n"
             "OWNER_TOKEN=" owner "\n"
             "FRAM_RUNTIME_SOURCE=" fram "\n"
             "FRAM_RUNTIME_REV=" (git-value "HEAD") "\n"
             "FRAM_RUNTIME_TREE=" (git-value "HEAD^{tree}") "\n"
             "FRAM_RUNTIME_DAEMON=" fram "/bin/fram-daemon\n"))
  (java.nio.file.Files/setPosixFilePermissions
   (.toPath (io/file path))
   (java.util.HashSet.
    ^java.util.Collection
    [java.nio.file.attribute.PosixFilePermission/OWNER_READ
     java.nio.file.attribute.PosixFilePermission/OWNER_WRITE])))

(defn start-daemon! [port log telemetry record]
  (let [owner (str (java.util.UUID/randomUUID))
        daemon
        (proc/process
         {:dir fram :out :string :err :string
          :extra-env
          {"FRAM_LOG" log
           "FRAM_TELEMETRY_LOG" telemetry
           "FRAM_REQUIRE_LOG_FENCE" "1"
           "FRAM_RUNTIME_SOURCE" fram
           "FRAM_RUNTIME_REV" (git-value "HEAD")
           "FRAM_RUNTIME_TREE" (git-value "HEAD^{tree}")
           "FRAM_RUNTIME_DAEMON" (str fram "/bin/fram-daemon")
           "FRAM_RUNTIME_OWNER_TOKEN" owner}}
         "bb" "-cp" "out" "coord_daemon.clj"
         "serve-flat" (str port) log)
        pid (.pid ^Process (:proc daemon))]
    (write-record! record pid owner)
    (loop [remaining 300]
      (cond
        (= [pid] (attestation/listener-pids port)) daemon
        (not (.isAlive ^Process (:proc daemon)))
        (throw (ex-info "disposable Fram daemon exited"
                        {:out (:out @daemon) :err (:err @daemon)}))
        (zero? remaining)
        (throw (ex-info "disposable Fram daemon did not own its port"
                        {:port port :pid pid}))
        :else (do (Thread/sleep 20) (recur (dec remaining)))))))

(defn stop-daemon! [daemon]
  (when daemon
    (proc/destroy-tree daemon)
    (try @daemon (catch Exception _ nil))))

(let [temp (.toFile
            (java.nio.file.Files/createTempDirectory
             "north-runtime-attestation-"
             (make-array java.nio.file.attribute.FileAttribute 0)))
      log (.getCanonicalPath (io/file temp "coordination.log"))
      telemetry (.getCanonicalPath (io/file temp "telemetry.log"))
      record (.getCanonicalPath (io/file temp "runtime.identity"))
      port (free-port)
      daemon (atom nil)]
  (try
    (spit log "")
    (spit telemetry "")
    (reset! daemon (start-daemon! port log telemetry record))
    (let [first-attestation
          (attestation/attest-runtime!
           {:port port :served-log log :record-path record})]
      (check! "one real listener is bound to its launcher PID and birth"
              (= (.pid ^Process (:proc @daemon))
                 (get-in first-attestation [:authority :pid])))
      (check! "the serving process is bound to the selected Git tree"
              (= (git-value "HEAD^{tree}")
                 (get-in first-attestation [:identity :tree])))
      (check! "unchanged serving authority re-attests without a wire call"
              (true? (attestation/assert-current! first-attestation)))

      (stop-daemon! @daemon)
      (reset! daemon nil)
      (reset! daemon (start-daemon! port log telemetry record))
      (let [denied (try
                     (attestation/assert-current! first-attestation)
                     nil
                     (catch clojure.lang.ExceptionInfo error (ex-data error)))]
        (check! "process restart invalidates the captured authority"
                (= :runtime-authority-lost (:type denied))))
      (check! "the replacement process earns a fresh attestation"
              (true?
               (attestation/assert-current!
                (attestation/attest-runtime!
                 {:port port :served-log log :record-path record})))))

    (finally
      (stop-daemon! @daemon)
      (delete-tree! temp))))

(let [port (free-port)
      socket (java.net.ServerSocket. port)
      temp (.toFile
            (java.nio.file.Files/createTempDirectory
             "north-runtime-fake-listener-"
             (make-array java.nio.file.attribute.FileAttribute 0)))
      record (.getCanonicalPath (io/file temp "runtime.identity"))
      current-pid (.pid (java.lang.ProcessHandle/current))]
  (try
    ;; A forged static record plus a listening socket is deliberately
    ;; insufficient: this process is not executing Fram's selected script and
    ;; classpath, even if a protocol shim were layered over the same socket.
    (write-record! record current-pid (str (java.util.UUID/randomUUID)))
    (let [denied (try
                   (attestation/attest-runtime!
                    {:port port :served-log (str temp "/coordination.log")
                     :record-path record})
                   nil
                   (catch clojure.lang.ExceptionInfo error (ex-data error)))]
      (check! "a socket listener plus forged static identity is rejected"
              (= :runtime-process-attestation-failed (:type denied))))
    (finally
      (.close socket)
      (delete-tree! temp))))

(if (seq @failures)
  (do (binding [*out* *err*]
        (println "runtime attestation tests failed:" (pr-str @failures)))
      (System/exit 1))
  (println "runtime attestation owner tests: PASS"))
