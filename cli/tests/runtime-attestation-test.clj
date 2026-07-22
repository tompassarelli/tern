#!/usr/bin/env bb
(require '[babashka.process :as proc]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(load-file (str root "/cli/runtime-attestation.clj"))
(require '[north.runtime-attestation :as attestation])
(def failures (atom []))

(defn check! [label value]
  (if value
    (println "  ✓" label)
    (do (println "  ✗" label) (swap! failures conj label))))

(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))

(defn delete-tree! [file]
  (when (and (.isDirectory file)
             (not (java.nio.file.Files/isSymbolicLink (.toPath file))))
    (doseq [child (or (.listFiles file) (make-array java.io.File 0))]
      (delete-tree! child)))
  (java.nio.file.Files/deleteIfExists (.toPath file)))

(defn previous-instant [[seconds nanos]]
  (if (pos? nanos)
    [seconds (dec nanos)]
    [(dec seconds) 999999999]))

(defn instant-millis [[seconds nanos]]
  (+ (* seconds 1000) (quot nanos 1000000)))

(def fram-origin
  (.getCanonicalPath
   (io/file (or (System/getenv "FRAM_PATH") (str root "/../fram")))))
(def fram-fixture-root
  (.toFile
   (java.nio.file.Files/createTempDirectory
    "north-clean-fram-checkout-"
    (make-array java.nio.file.attribute.FileAttribute 0))))
(def fram (.getCanonicalPath (io/file fram-fixture-root "fram")))

(defn clone-fram! [source target]
  (let [clone (proc/shell {:out :string :err :string :continue true}
                          "git" "clone" "--quiet" "--shared"
                          source target)]
    (when-not (zero? (:exit clone))
      (throw (ex-info "runtime attestation test requires a cloneable Git Fram source"
                      {:fram source :error (:err clone)})))
    target))

(clone-fram! fram-origin fram)

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

(def active-record-order
  ["FORMAT" "GENERATION" "GENERATION_IDENTITY"
   "GENERATION_IDENTITY_SHA256" "NORTH_FRAM_RUNTIME"
   "FRAM_RUNTIME_SOURCE" "FRAM_RUNTIME_REV" "FRAM_RUNTIME_TREE"
   "FRAM_RUNTIME_ORIGIN" "FRAM_RUNTIME_DAEMON" "FRAM_PORT"
   "FRAM_LOG" "FRAM_TELEMETRY_LOG" "PID" "PID_BIRTH"
   "OWNER_TOKEN" "CONTROLLER_UNIT" "CONTROLLER_MAIN_PID"])

(defn git-value-at [source expression]
  (let [result (proc/shell {:out :string :err :string :continue true}
                           "git" "-C" source "rev-parse" "--verify" expression)]
    (when-not (zero? (:exit result))
      (throw (ex-info "active runtime fixture requires a Git Fram source"
                      {:source source :error (:err result)})))
    (str/trim (:out result))))

(defn sha256-file [path]
  (let [digest (java.security.MessageDigest/getInstance "SHA-256")
        buffer (byte-array 65536)]
    (with-open [input (io/input-stream path)]
      (loop []
        (let [n (.read input buffer)]
          (when (pos? n)
            (.update digest buffer 0 n)
            (recur)))))
    (apply str (map #(format "%02x" %) (.digest digest)))))

(defn create-symlink! [path target]
  (java.nio.file.Files/createSymbolicLink
   (.toPath (io/file path))
   (.toPath (io/file target))
   (make-array java.nio.file.attribute.FileAttribute 0)))

(defn prepare-active-selection! [temp source generation-name]
  (let [root (.getCanonicalPath (io/file temp "runtime-state"))
        generations (io/file root "generations")
        generation (io/file generations generation-name)
        source (.getCanonicalPath (io/file source))
        identity (io/file generation "current.identity")]
    (.mkdirs generation)
    (create-symlink! (str root "/current") "active/current")
    (create-symlink! (str root "/active") (str "generations/" generation-name))
    (create-symlink! (str generation "/current") source)
    (spit identity
          (str "north-fram-runtime-v1\n"
               "checkout\n"
               source "\n"
               (git-value-at source "HEAD") "\n"
               (git-value-at source "HEAD^{tree}") "\n"
               source "\n"
               source "/bin/fram-daemon\n"))
    {:root root
     :generation (.getCanonicalPath generation)
     :identity (.getCanonicalPath identity)
     :record (.getCanonicalPath (io/file generation "active.runtime"))
     :source source
     :revision (git-value-at source "HEAD")
     :tree (git-value-at source "HEAD^{tree}")
     :daemon (str source "/bin/fram-daemon")}))

(defn active-record-values [selection port log telemetry pid token]
  {"FORMAT" attestation/active-runtime-record-format
   "GENERATION" (:generation selection)
   "GENERATION_IDENTITY" (:identity selection)
   "GENERATION_IDENTITY_SHA256" (sha256-file (:identity selection))
   "NORTH_FRAM_RUNTIME" "checkout"
   "FRAM_RUNTIME_SOURCE" (:source selection)
   "FRAM_RUNTIME_REV" (:revision selection)
   "FRAM_RUNTIME_TREE" (:tree selection)
   "FRAM_RUNTIME_ORIGIN" (:source selection)
   "FRAM_RUNTIME_DAEMON" (:daemon selection)
   "FRAM_PORT" (str port)
   "FRAM_LOG" log
   "FRAM_TELEMETRY_LOG" telemetry
   "PID" (str pid)
   "PID_BIRTH" (attestation/process-birth-token pid)
   "OWNER_TOKEN" token
   "CONTROLLER_UNIT" "direct"
   "CONTROLLER_MAIN_PID" (str pid)})

(defn write-active-record! [selection values]
  (spit (:record selection)
        (str (str/join "\n"
                       (map #(str % "=" (get values %)) active-record-order))
             "\n"))
  (java.nio.file.Files/setPosixFilePermissions
   (.toPath (io/file (:record selection)))
   (java.util.HashSet.
    ^java.util.Collection
    [java.nio.file.attribute.PosixFilePermission/OWNER_READ
     java.nio.file.attribute.PosixFilePermission/OWNER_WRITE]))
  (:record selection))

(defn start-active-daemon! [selection port log telemetry]
  (let [token (str (java.util.UUID/randomUUID))
        daemon
        (proc/process
         {:dir (:source selection) :out :string :err :string
          :extra-env
          {"NORTH_FRAM_RUNTIME" "checkout"
           "NORTH_COORD_RUNTIME_STATE" (:root selection)
           "NORTH_COORD_RUNTIME_GENERATION" (:generation selection)
           "NORTH_COORD_RUNTIME_IDENTITY" (:identity selection)
           "NORTH_COORD_RUNTIME_FILE" (:record selection)
           "NORTH_COORD_SYSTEMD_UNIT" "direct"
           "FRAM_LOG" log
           "FRAM_TELEMETRY_LOG" telemetry
           "FRAM_PORT" (str port)
           "FRAM_REQUIRE_LOG_FENCE" "1"
           "FRAM_RUNTIME_SOURCE" (:source selection)
           "FRAM_RUNTIME_REV" (:revision selection)
           "FRAM_RUNTIME_TREE" (:tree selection)
           "FRAM_RUNTIME_ORIGIN" (:source selection)
           "FRAM_RUNTIME_DAEMON" (:daemon selection)
           "FRAM_RUNTIME_OWNER_TOKEN" token}}
         "bb" "-cp" "out" "coord_daemon.clj"
         "serve-flat" (str port) log)
        pid (.pid ^Process (:proc daemon))
        values (active-record-values selection port log telemetry pid token)]
    (write-active-record! selection values)
    (loop [remaining 300]
      (cond
        (= [pid] (attestation/listener-pids port))
        {:daemon daemon :pid pid :token token :values values}

        (not (.isAlive ^Process (:proc daemon)))
        (throw (ex-info "active runtime fixture daemon exited"
                        {:out (:out @daemon) :err (:err @daemon)}))

        (zero? remaining)
        (throw (ex-info "active runtime fixture daemon did not own its port"
                        {:port port :pid pid}))

        :else (do (Thread/sleep 20) (recur (dec remaining)))))))

(defn active-request [selection port log telemetry]
  {:port port :served-log log :telemetry-log telemetry
   :state-root (:root selection) :record-path (:record selection)
   :controller-mode "direct"})

(defn denied-type [operation]
  (try
    (operation)
    nil
    (catch clojure.lang.ExceptionInfo error (:type (ex-data error)))))

(let [temp (.toFile
            (java.nio.file.Files/createTempDirectory
             "north-active-runtime-attestation-"
             (make-array java.nio.file.attribute.FileAttribute 0)))
      log (.getCanonicalPath (io/file temp "coordination.log"))
      telemetry (.getCanonicalPath (io/file temp "telemetry.log"))
      selection (prepare-active-selection! temp fram "generation-a")
      port (free-port)
      running (atom nil)]
  (try
    (spit log "")
    (spit telemetry "")
    (check! "missing generation-scoped active record is rejected"
            (= :active-runtime-path-invalid
               (denied-type #(attestation/attest-active-runtime!
                              (active-request selection port log telemetry)))))
    (spit (:record selection) "FORMAT=wrong\n")
    (java.nio.file.Files/setPosixFilePermissions
     (.toPath (io/file (:record selection)))
     (java.util.HashSet.
      ^java.util.Collection
      [java.nio.file.attribute.PosixFilePermission/OWNER_READ
       java.nio.file.attribute.PosixFilePermission/OWNER_WRITE]))
    (check! "malformed active record is rejected before process trust"
            (= :active-runtime-record-invalid
               (denied-type #(attestation/attest-active-runtime!
                              (active-request selection port log telemetry)))))
    (reset! running (start-active-daemon! selection port log telemetry))
    (let [request (active-request selection port log telemetry)
          first-attestation (atom (attestation/attest-active-runtime! request))
          valid-values (:values @running)]
      (check! "generation-scoped record binds the sole direct fixture listener"
              (= (:pid @running)
                 (get-in @first-attestation [:authority :pid])))
      (check! "active runtime identity carries both exact split corpus paths"
              (= [log telemetry]
                 [(get-in @first-attestation [:identity :served-log])
                  (get-in @first-attestation [:identity :telemetry-log])]))
      (check! "unchanged generation-scoped authority re-attests"
              (true? (attestation/assert-current! @first-attestation)))

      (write-active-record! selection valid-values)
      (check! "same-byte active record republication invalidates prior authority"
              (= :runtime-authority-lost
                 (denied-type #(attestation/assert-current!
                                @first-attestation))))
      (reset! first-attestation (attestation/attest-active-runtime! request))

      (write-active-record!
       selection
       (assoc valid-values
              "CONTROLLER_UNIT" "north-coord.service"
              "CONTROLLER_MAIN_PID"
              (str (.pid (java.lang.ProcessHandle/current)))))
      (check! "manual systemd record with wrong declared MainPID is rejected"
              (= :active-runtime-record-invalid
                 (denied-type
                  #(attestation/attest-active-runtime!
                    (assoc request :controller-mode "systemd"
                           :controller-unit "north-coord.service")))))

      (write-active-record!
       selection
       (assoc valid-values "CONTROLLER_UNIT" "north-coord.service"))
      (check! "record PID must equal the actual systemd MainPID"
              (= :active-runtime-controller-invalid
                 (with-redefs
                  [attestation/systemd-main-pid!
                   (fn [unit]
                     {:kind "systemd" :unit unit
                      :main-pid (inc (:pid @running))
                      :load-state "loaded" :active-state "active"
                      :sub-state "running"})]
                  (denied-type
                   #(attestation/attest-active-runtime!
                     (assoc request :controller-mode "systemd"
                            :controller-unit "north-coord.service"))))))
      (write-active-record! selection valid-values)

      (doseq [[label patch]
              [["record PID/listener mismatch is rejected"
                {"PID" (str (.pid (java.lang.ProcessHandle/current)))}]
               ["record token/process environment mismatch is rejected"
                {"OWNER_TOKEN" (str (java.util.UUID/randomUUID))}]
               ["record coordination log mismatch is rejected"
                {"FRAM_LOG" telemetry}]
               ["record telemetry alias is rejected"
                {"FRAM_TELEMETRY_LOG" log}]
               ["static generation identity digest mismatch is rejected"
                {"GENERATION_IDENTITY_SHA256" (apply str (repeat 64 "0"))}]
               ["selected source tuple mismatch is rejected"
                {"FRAM_RUNTIME_REV" (apply str (repeat 40 "0"))}]]]
        (write-active-record! selection (merge valid-values patch))
        (check! label
                (some? (denied-type #(attestation/attest-active-runtime!
                                     request)))))
      (write-active-record! selection valid-values)
      (reset! first-attestation (attestation/attest-active-runtime! request))

      (let [original attestation/fram-artifact-identity!
            record-state (get-in @first-attestation
                                 [:authority :active-record :state])
            record-barrier
            (let [mtime (:mtime-instant record-state)
                  ctime (:ctime-instant record-state)]
              (if (neg? (compare mtime ctime)) mtime ctime))
            artifact-instant (previous-instant record-barrier)
            artifact-time (instant-millis artifact-instant)
            coarse-process-start (- artifact-time 249)
            after-publication [Long/MAX_VALUE 999999999]]
        (check! "immediate launch accepts artifacts after coarse process start but before record publication"
                (map?
                 (with-redefs
                  [attestation/process-start-millis
                   (fn [_] coarse-process-start)
                   attestation/fram-artifact-identity!
                   (fn [& args]
                     (assoc (apply original args)
                            :latest-artifact-mtime-millis artifact-time
                            :latest-artifact-mtime-instant artifact-instant
                            :latest-artifact-ctime-millis artifact-time
                            :latest-artifact-ctime-instant artifact-instant))]
                  (attestation/attest-active-runtime! request))))
        (check! "artifact mtime after active record publication is rejected"
                (= :active-runtime-process-attestation-failed
                   (with-redefs
                    [attestation/fram-artifact-identity!
                     (fn [& args]
                       (assoc (apply original args)
                              :latest-artifact-mtime-millis Long/MAX_VALUE
                              :latest-artifact-mtime-instant
                              after-publication))]
                    (denied-type #(attestation/attest-active-runtime!
                                  request)))))
        (check! "artifact ctime after active record publication is rejected"
                (= :active-runtime-process-attestation-failed
                   (with-redefs
                    [attestation/fram-artifact-identity!
                     (fn [& args]
                       (assoc (apply original args)
                              :latest-artifact-ctime-millis Long/MAX_VALUE
                              :latest-artifact-ctime-instant
                              after-publication))]
                    (denied-type #(attestation/attest-active-runtime!
                                  request))))))

      (let [generation-b (io/file (:root selection) "generations/generation-b")]
        (.mkdirs generation-b)
        (create-symlink! (str generation-b "/current") (:source selection))
        (spit (io/file generation-b "current.identity")
              (slurp (:identity selection)))
        (java.nio.file.Files/delete (.toPath (io/file (:root selection) "active")))
        (create-symlink! (str (:root selection) "/active")
                         "generations/generation-b")
        (check! "selector rebind invalidates prior active authority"
                (= :runtime-authority-lost
                   (denied-type #(attestation/assert-current!
                                  @first-attestation))))))

    (finally
      (when @running (stop-daemon! (:daemon @running)))
      (delete-tree! temp))))

(let [deployed
      (io/file
       (or (System/getenv "NORTH_DEPLOYED_FRAM_FIXTURE")
           (str (System/getProperty "user.home")
                "/code/north-data/fram-runtime/deployments/"
                "3383de745fc1166fa0525b390e4f04a06d9cf00e")))]
  (when (.isDirectory deployed)
    (let [temp (.toFile
                (java.nio.file.Files/createTempDirectory
                 "north-deployed-runtime-attestation-"
                 (make-array java.nio.file.attribute.FileAttribute 0)))
          log (.getCanonicalPath (io/file temp "coordination.log"))
          telemetry (.getCanonicalPath (io/file temp "telemetry.log"))
          selection (prepare-active-selection! temp deployed "deployed-3383")
          port (free-port)
          running (atom nil)]
      (try
        (spit log "")
        (spit telemetry "")
        (reset! running (start-active-daemon! selection port log telemetry))
        (let [verified
              (attestation/attest-active-runtime!
               (active-request selection port log telemetry))]
          (check! "sealed deployed Fram 3383 generation earns active authority"
                  (and (= "3383de745fc1166fa0525b390e4f04a06d9cf00e"
                          (get-in verified [:identity :revision]))
                       (true? (attestation/assert-current! verified)))))
        (finally
          (when @running (stop-daemon! (:daemon @running)))
          (delete-tree! temp))))))

(doseq [[label mutation]
        [["dirty Git worktree is rejected as runtime provenance" :worktree]
         ["dirty Git index is rejected as runtime provenance" :index]
         ["untracked Git content is rejected as runtime provenance" :untracked]]]
  (let [temp (.toFile
              (java.nio.file.Files/createTempDirectory
               "north-dirty-fram-checkout-"
               (make-array java.nio.file.attribute.FileAttribute 0)))
        source (.getCanonicalPath (io/file temp "fram"))]
    (try
      (clone-fram! fram source)
      (let [revision (git-value-at source "HEAD")
            tree (git-value-at source "HEAD^{tree}")]
        (case mutation
          :worktree
          (spit (io/file source "coord.clj") "\n" :append true)

          :index
          (do
            (spit (io/file source "coord.clj") "\n" :append true)
            (let [added (proc/shell {:out :string :err :string :continue true}
                                    "git" "-C" source "add" "--" "coord.clj")]
              (when-not (zero? (:exit added))
                (throw (ex-info "could not stage dirty-index fixture"
                                {:error (:err added)})))))

          :untracked
          (spit (io/file source "north-untracked-runtime.clj") "fixture\n"))
        (check! label
                (= :runtime-source-checkout-dirty
                   (denied-type #(attestation/fram-artifact-identity!
                                  source revision tree)))))
      (finally
        (delete-tree! temp)))))

(let [temp (.toFile
            (java.nio.file.Files/createTempDirectory
             "north-hostile-git-marker-"
             (make-array java.nio.file.attribute.FileAttribute 0)))
      marker (io/file temp ".git")
      revision (git-value "HEAD")
      tree (git-value "HEAD^{tree}")]
  (try
    (create-symlink! marker (str fram "/.git"))
    (check! "symlink .git marker is not accepted as source provenance"
            (= :runtime-source-version-unavailable
               (denied-type #(attestation/fram-artifact-identity!
                              (.getCanonicalPath temp) revision tree))))
    (java.nio.file.Files/delete (.toPath marker))
    (let [mkfifo (proc/shell {:out :string :err :string :continue true}
                             "mkfifo" (.getPath marker))]
      (when-not (zero? (:exit mkfifo))
        (throw (ex-info "mkfifo unavailable for hostile marker regression"
                        {:error (:err mkfifo)}))))
    (check! "FIFO .git marker is not accepted as source provenance"
            (= :runtime-source-version-unavailable
               (denied-type #(attestation/fram-artifact-identity!
                              (.getCanonicalPath temp) revision tree))))
    (finally
      (delete-tree! temp))))

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

(delete-tree! fram-fixture-root)

(if (seq @failures)
  (do (binding [*out* *err*]
        (println "runtime attestation tests failed:" (pr-str @failures)))
      (System/exit 1))
  (println "runtime attestation owner tests: PASS"))
