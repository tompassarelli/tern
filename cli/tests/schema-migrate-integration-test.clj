#!/usr/bin/env bb
;; Exact-fold + real-coordinator proof for the executable schema cutover.
(require '[babashka.process :as proc]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str]
         '[fram.fold :as fold]
         '[fram.rt :as rt])

(def root (.getCanonicalPath (io/file (.getParent (io/file *file*)) "../..")))
(load-file (str root "/cli/schema-migrate.clj"))
(require '[north.runtime-attestation :as runtime-attestation])
(def fram (.getCanonicalPath
           (io/file (or (System/getenv "FRAM_PATH") (str root "/../fram")))))
(when-not (.isFile (io/file fram "coord_daemon.clj"))
  (throw (ex-info "Fram checkout not found; set FRAM_PATH or keep it beside North" {:fram fram})))

(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))

(defn port-open? [port]
  (try (with-open [_ (java.net.Socket. "127.0.0.1" (int port))] true)
       (catch Exception _ false)))

(defn eventually [f]
  (loop [remaining 1200]
    (cond
      (try (f) (catch Exception _ false)) true
      (zero? remaining) false
      :else (do (Thread/sleep 25) (recur (dec remaining))))))

(defn op [tx operation subject predicate object]
  (pr-str {:tx tx :op operation :l subject :p predicate :r object :frame "schema-test"}))

(defn live-facts [log telemetry]
  (:facts (fold/fold (concat (rt/read-log log) (rt/read-log telemetry)))))

(defn values [facts subject predicate]
  (set (map :r (filter #(and (= subject (:l %)) (= predicate (:p %))) facts))))

(defn runtime-record-for-log [log]
  (.getCanonicalPath
   (io/file (.getParentFile (io/file log)) "runtime.identity")))

(defn run-schema [port log telemetry receipt-dir & args]
  (apply proc/shell
         {:dir root
          :out :string
          :err :string
          :continue true
          :extra-env {"FRAM_LOG" log "FRAM_TELEMETRY_LOG" telemetry
                      "FRAM_SINGLE_VALUED" ""
                      "NORTH_SCHEMA_STAGE_PYTHON"
                      (or (System/getenv "NORTH_SCHEMA_STAGE_PYTHON")
                          "/run/current-system/sw/bin/python3")
                      "NORTH_COORD_RUNTIME_FILE" (runtime-record-for-log log)}}
         "bb" "-cp" (str fram "/out")
         (str root "/cli/schema-migrate.clj") (str port)
         (concat args ["--log" log "--telemetry" telemetry
                       "--receipt-dir" receipt-dir])))

(defn write-reviewed-manifest!
  [path log telemetry predicate-semantics other-entries]
  (let [corpus (read-corpus (resolve-corpus-paths! log telemetry))
        manifest {:format REPAIR-MANIFEST-FORMAT
                  :source (source-seal corpus)
                  :review {:by "schema-migrate-integration-test"
                           :at "2026-07-22T00:00:00Z"
                           :basis "Explicit fixture semantics and classifications."}
                  :predicate_semantics predicate-semantics
                  :cardinality_repairs []
                  :fact_repairs []
                  :other_allowlist
                  {:name "schema-migrate-integration-reviewed-other/v1"
                   :entries other-entries}}]
    (spit path (str (pr-str manifest) "\n"))
    path))

(defn run-pred [port log telemetry & args]
  (apply proc/shell
         {:dir root :out :string :err :string :continue true
          :extra-env {"FRAM_LOG" log "FRAM_TELEMETRY_LOG" telemetry}}
         "bb" (str root "/cli/pred-cli.clj") (str port) args))

(defn fram-git-value [expression]
  (let [result (proc/shell {:out :string :err :string :continue true}
                           "git" "-C" fram "rev-parse" "--verify" expression)]
    (when-not (zero? (:exit result))
      (throw (ex-info "schema integration requires a Git Fram source"
                      {:fram fram :expression expression :error (:err result)})))
    (str/trim (:out result))))

(defn write-runtime-record! [path pid owner]
  (spit path
        (str "PID=" pid "\n"
             "PID_BIRTH=" (runtime-attestation/process-birth-token pid) "\n"
             "OWNER_TOKEN=" owner "\n"
             "FRAM_RUNTIME_SOURCE=" fram "\n"
             "FRAM_RUNTIME_REV=" (fram-git-value "HEAD") "\n"
             "FRAM_RUNTIME_TREE=" (fram-git-value "HEAD^{tree}") "\n"
             "FRAM_RUNTIME_DAEMON=" fram "/bin/fram-daemon\n"))
  path)

(defn start-daemon [port log telemetry]
  (let [owner (str (java.util.UUID/randomUUID))
        daemon
        (proc/process {:dir fram :out :string :err :string
                       :extra-env
                       {"FRAM_LOG" log
                        "FRAM_TELEMETRY_LOG" telemetry
                        "FRAM_REQUIRE_LOG_FENCE" "1"
                        "FRAM_SINGLE_VALUED" ""
                        "FRAM_RUNTIME_SOURCE" fram
                        "FRAM_RUNTIME_REV" (fram-git-value "HEAD")
                        "FRAM_RUNTIME_TREE" (fram-git-value "HEAD^{tree}")
                        "FRAM_RUNTIME_DAEMON" (str fram "/bin/fram-daemon")
                        "FRAM_RUNTIME_OWNER_TOKEN" owner}}
                      "bb" "-cp" "out" "coord_daemon.clj"
                      "serve-flat" (str port) log)
        pid (.pid ^Process (:proc daemon))]
    (write-runtime-record! (runtime-record-for-log log) pid owner)
    daemon))

(defn stop-daemon! [daemon]
  (when daemon
    (proc/destroy-tree daemon)
    (try @daemon (catch Exception _ nil))))

(defn start-request-counter []
  (let [server (java.net.ServerSocket. 0)
        count (atom 0)
        running (atom true)
        worker
        (future
          (while @running
            (try
              (with-open [_ (.accept server)]
                (swap! count inc))
              (catch java.net.SocketException _ nil))))]
    {:port (.getLocalPort server)
     :count count
     :stop (fn []
             (reset! running false)
             (.close server)
             (deref worker 2000 nil))}))

(defn exact-file-seal [path]
  (let [nio (.toPath (io/file path))
        attrs (java.nio.file.Files/readAttributes
               nio java.nio.file.attribute.BasicFileAttributes
               (make-array java.nio.file.LinkOption 0))]
    {:bytes (.size attrs)
     :sha256 (north.corpus-transaction/sha256-file path)
     :file_key (str (.fileKey attrs))
     :permissions
     (set (java.nio.file.Files/getPosixFilePermissions
           nio (make-array java.nio.file.LinkOption 0)))
     :links (long (java.nio.file.Files/getAttribute
                   nio "unix:nlink" (make-array java.nio.file.LinkOption 0)))}))

(defn candidate-authority-seals [store]
  (into (sorted-map)
        (keep (fn [^java.io.File file]
                (when (and (.isFile file)
                           (or (re-matches
                                #"schema-candidate-[0-9a-f]{64}\.edn"
                                (.getName file))
                               (re-matches
                                #"schema-payload-(coordination|telemetry)-[0-9a-f]{64}\.log"
                                (.getName file))))
                  [(.getName file) (exact-file-seal (.getPath file))])))
        (or (.listFiles (io/file store))
            (make-array java.io.File 0))))

(defn capture-fixture-snapshot! [store log telemetry]
  (let [identity {:fixture "schema-migrate-integration-snapshot/v1"}]
    (north.snapshot/create-snapshot!
     {:store store
      :live {:coordination log :telemetry telemetry}
      :runtime! (fn [] identity)
      :controller! (fn [] identity)
      :runtime-current! (fn [_] true)
      :controller-current! (fn [_] true)
      :provenance {:fixture "schema-migrate-integration-snapshot/v1"}
      :execute? true})))

(defn delete-tree! [file]
  (when (.isDirectory file)
    (doseq [child (.listFiles file)] (delete-tree! child)))
  (.delete file))

(let [port (free-port)
      temp (.toFile (java.nio.file.Files/createTempDirectory
                     "north-schema-migrate-"
                     (make-array java.nio.file.attribute.FileAttribute 0)))
      log (.getCanonicalPath (io/file temp "coordination.log"))
      telemetry (.getCanonicalPath (io/file temp "telemetry.log"))
      log-alias (.getAbsolutePath (io/file temp "coordination-alias.log"))
      receipts (.getCanonicalPath (io/file temp "receipts"))
      snapshot-store (.getCanonicalPath (io/file temp "snapshots"))
      workspace-root (.getCanonicalPath (io/file temp "workspaces"))
      candidate-store (.getCanonicalPath (io/file temp "candidates"))
      manifest-path (.getCanonicalPath (io/file temp "reviewed-manifest.edn"))
      invalid-log (.getCanonicalPath (io/file temp "acyclic-invalid.log"))
      invalid-telemetry (.getCanonicalPath (io/file temp "acyclic-invalid-telemetry.log"))
      invalid-receipts (.getCanonicalPath (io/file temp "acyclic-invalid-receipts"))
      corrupt-log (.getCanonicalPath (io/file temp "corrupt.log"))
      corrupt-telemetry (.getCanonicalPath (io/file temp "corrupt-telemetry.log"))
      corrupt-receipts (.getCanonicalPath (io/file temp "corrupt-receipts"))
      corrupt-snapshot-store (.getCanonicalPath (io/file temp "corrupt-snapshots"))
      corrupt-workspace-root (.getCanonicalPath (io/file temp "corrupt-workspaces"))
      corrupt-candidate-store (.getCanonicalPath (io/file temp "corrupt-candidates"))
      corrupt-manifest (.getCanonicalPath (io/file temp "corrupt-manifest.edn"))
      unterminated-log (.getCanonicalPath (io/file temp "unterminated.log"))
      unterminated-telemetry (.getCanonicalPath (io/file temp "unterminated-telemetry.log"))
      unterminated-receipts (.getCanonicalPath (io/file temp "unterminated-receipts"))
      unterminated-snapshots (.getCanonicalPath (io/file temp "unterminated-snapshots"))
      unterminated-manifest (.getCanonicalPath (io/file temp "unterminated-manifest.edn"))
      _ (spit log (str (str/join "\n"
                                 [(op 1 "assert" "@thread-a" "title" "one")
                                  (op 2 "assert" "@thread-a" "custom_ref" "@thread-b")
                                  (op 3 "assert" "@thread-b" "title" "two")
                                  ;; A valid executable declaration is authority even
                                  ;; when bootstrap intent disagrees.
                                  (op 4 "assert" "@title" "cardinality" "multi")
                                  (op 5 "assert" "@topic-schema" "title" "schema")
                                  (op 6 "assert" "@concern-schema" "kind" "concern")
                                  (op 7 "assert" "@msg:schema" "body" "hello")
                                  (op 8 "assert" "@run-schema" "kind" "run")
                                  (op 9 "assert" "@client-clock" "kind" "client_session")
                                  (op 10 "assert" "@denial:schema" "kind" "guard_denial")
                                  (op 11 "assert" "@agent:schema" "display_name" "Agent Schema")
                                  (op 12 "assert" "@person-schema" "display_name" "Person Schema")
                                  ;; Explicit namespace/name extensions are preserved.
                                  (op 13 "assert" "@vendor-subject" "entity_kind" "vendor/widget")
                                  (op 14 "assert" "@vendor-subject" "note" "extension")
                                  ;; No structural signal: remain visible as `other`.
                                  (op 15 "assert" "@ambiguous" "opaque" "value")
                                  ;; Valid explicit policy, including false, is
                                  ;; authoritative and must survive migration.
                                  (op 16 "assert" "@part_of" "acyclic" "false")
                                  (op 17 "assert" "@depends_on" "acyclic" "true")])
                       "\n")
              :append true)
      _ (spit telemetry "")
      _ (java.nio.file.Files/createSymbolicLink
         (.toPath (io/file log-alias))
         (.toPath (io/file log))
         (make-array java.nio.file.attribute.FileAttribute 0))
      _ (spit invalid-log
              (str/join "\n"
                        [(op 1 "assert" "@part_of" "acyclic" "true")
                         (op 2 "assert" "@part_of" "acyclic" "false")
                         (op 3 "assert" "@custom_edge" "acyclic" "maybe")]))
      _ (spit invalid-telemetry "")
      _ (spit corrupt-log (str (op 1 "assert" "@thread-a" "\"\"" "") "\n"))
      _ (spit corrupt-telemetry "")
      _ (spit unterminated-log (op 1 "assert" "@thread-a" "title" "one"))
      _ (spit unterminated-telemetry "")
      _ (write-reviewed-manifest!
         manifest-path log telemetry
         {"custom_ref" {:cardinality "multi"
                        :value_kind "ref"
                        :doc "Reviewed integration-test reference edge."
                        :rationale "The fixture explicitly targets @thread-b."}
          "opaque" {:cardinality "multi"
                    :value_kind "literal"
                    :doc "Reviewed opaque integration-test literal."
                    :rationale "The fixture value is literal test data."}}
         {"@ambiguous" {:entity_kind "vendor/opaque"
                         :rationale "Fixture-owned extension with no North structural signal."}})
      _ (write-reviewed-manifest!
         unterminated-manifest unterminated-log unterminated-telemetry {} {})
      _ (write-reviewed-manifest!
         corrupt-manifest corrupt-log corrupt-telemetry {}
         {"@thread-a" {:entity_kind "north/quarantined_legacy_artifact"
                       :rationale "Keeps the corrupt fixture classification explicit during preflight."}})
      daemon (atom (start-daemon port log telemetry))
      active-log (atom log)
      active-telemetry (atom telemetry)
      prepared-workspace (atom nil)
      source-snapshot (atom nil)
      finalized-candidate (atom nil)
      checks (atom [])
      check! (fn [label ok detail]
               (swap! checks conj {:label label :ok (boolean ok) :detail detail}))]
  (try
    (let [synthetic-facts [{:l "@part_of" :p "acyclic" :r "true"}
                           {:l "@part_of" :p "acyclic" :r "false"}
                           {:l "@custom_edge" :p "acyclic" :r "maybe"}]
          synthetic-schema (desired-schema synthetic-facts)
          defects (malformed-schema synthetic-facts synthetic-schema)
          by-key (into {} (map (fn [defect]
                                 [[(:predicate defect) (:field defect)] (:values defect)]))
                       defects)]
      (check! "strict schema audit detects synthetic multiple and malformed acyclic state"
              (and (= ["false" "true"] (get by-key ["part_of" "acyclic"]))
                   (= ["maybe"] (get by-key ["custom_edge" "acyclic"])))
              (pr-str by-key)))

    (let [log-before (slurp log)
          telemetry-before (slurp telemetry)
          empty-telemetry-plan (run-schema port log telemetry receipts "plan")
          missing-coordination (run-schema port
                                           (.getAbsolutePath (io/file temp "missing-coordination.log"))
                                           telemetry receipts "migrate" "--execute")
          missing-telemetry (run-schema port log
                                        (.getAbsolutePath (io/file temp "missing-telemetry.log"))
                                        receipts "migrate" "--execute")
          blank-telemetry (run-schema port log "" receipts "plan")
          directory-telemetry (run-schema port log (.getCanonicalPath temp) receipts "audit" "--strict")
          duplicate-runs (mapv (fn [args]
                                 (apply run-schema port log log receipts args))
                               [["plan"]
                                ["audit" "--strict"]
                                ["migrate" "--execute"]
                                ["repair-corrupt" "--execute" "--offline-confirm"]])
          alias-duplicate (run-schema port log log-alias receipts "plan")
          direct-before (run-schema port log telemetry receipts "migrate" "--execute")
          unterminated-before (slurp unterminated-log)
          unterminated-execute
          (try
            (capture-fixture-snapshot! unterminated-snapshots
                                       unterminated-log unterminated-telemetry)
            {:exit 0 :err ""}
            (catch Throwable error
              {:exit 1 :err (.getMessage error)}))]
      (check! "mandatory zero-byte telemetry log is accepted as a corpus member"
              (zero? (:exit empty-telemetry-plan))
              (str "exit=" (:exit empty-telemetry-plan) " err=" (:err empty-telemetry-plan)))
      (check! "missing coordination log fails before migration work"
              (and (not (zero? (:exit missing-coordination)))
                   (str/includes? (:err missing-coordination) "coordination corpus log is missing or unreadable"))
              (:err missing-coordination))
      (check! "missing configured telemetry log fails before migration work"
              (and (not (zero? (:exit missing-telemetry)))
                   (str/includes? (:err missing-telemetry) "telemetry corpus log is missing or unreadable"))
              (:err missing-telemetry))
      (check! "blank telemetry configuration is rejected instead of silently omitted"
              (and (not (zero? (:exit blank-telemetry)))
                   (str/includes? (:err blank-telemetry) "telemetry corpus log path is required"))
              (:err blank-telemetry))
      (check! "non-file telemetry corpus path is rejected as unreadable"
              (and (not (zero? (:exit directory-telemetry)))
                   (str/includes? (:err directory-telemetry) "telemetry corpus log is missing or unreadable"))
              (:err directory-telemetry))
      (check! "every verb rejects a directly duplicated corpus path"
              (every? #(and (not (zero? (:exit %)))
                            (str/includes? (:err %) "same canonical path"))
                      duplicate-runs)
              (pr-str (mapv #(select-keys % [:exit :err]) duplicate-runs)))
      (check! "canonical path identity rejects a symlink alias"
              (and (not (zero? (:exit alias-duplicate)))
                   (str/includes? (:err alias-duplicate) "same canonical path"))
              (:err alias-duplicate))
      (check! "direct migration is disabled before the first write"
              (and (not (zero? (:exit direct-before)))
                   (str/includes? (:err direct-before) "direct migrate --execute is disabled")
                   (= log-before (slurp log))
                   (= telemetry-before (slurp telemetry)))
              (str "exit=" (:exit direct-before) " err=" (:err direct-before)))
      (check! "execute rejects an unterminated append boundary before coordinator work"
              (and (not (zero? (:exit unterminated-execute)))
                   (str/includes? (:err unterminated-execute) "lacks a terminal LF")
                   (= unterminated-before (slurp unterminated-log))
                   (not (.exists (io/file unterminated-receipts))))
              (str "exit=" (:exit unterminated-execute) " err=" (:err unterminated-execute)))
      (check! "corpus validation failures perform no work or receipt writes"
              (and (= log-before (slurp log))
                   (= telemetry-before (slurp telemetry))
                   (not (.exists (io/file receipts))))
              nil))

    (let [invalid-plan (run-schema port invalid-log invalid-telemetry invalid-receipts
                                   "plan" "--verbose")
          invalid-audit (run-schema port invalid-log invalid-telemetry invalid-receipts
                                    "audit" "--strict")]
      (check! "malformed acyclic declarations remain a nonwriting diagnostic plan"
              (and (zero? (:exit invalid-plan))
                   (not (re-find #"(?m)^  set @part_of\s+acyclic\s" (:out invalid-plan)))
                   (not (re-find #"(?m)^  set @custom_edge\s+acyclic\s" (:out invalid-plan))))
              (:out invalid-plan))
      (check! "strict audit reports a malformed persisted acyclic declaration exactly"
              (and (= 1 (:exit invalid-audit))
                   (str/includes? (:out invalid-audit) "@custom_edge acyclic = [\"maybe\"]"))
              (str "exit=" (:exit invalid-audit) " out=" (:out invalid-audit))))

    (check! "real Fram coordinator starts" (eventually #(port-open? port)) nil)

    (let [valid-plan (run-schema port log telemetry receipts "plan" "--verbose")]
      (check! "valid explicit true and false acyclic policy require no rewrite"
              (and (zero? (:exit valid-plan))
                   (not (re-find #"(?m)^  set @part_of\s+acyclic\s" (:out valid-plan)))
                   (not (re-find #"(?m)^  set @depends_on\s+acyclic\s" (:out valid-plan))))
              (:out valid-plan)))

    (let [listing (run-pred port log telemetry "ls")
          show-missing (run-pred port log telemetry "show" "owner")
          lint-before (run-pred port log telemetry "lint" "--strict")]
      (check! "connected predicate listing is generated only from graph authority"
              (and (zero? (:exit listing))
                   (str/includes? (:out listing) "1 on")
                   (str/includes? (:out listing) "title")
                   (not (str/includes? (:out listing) "owner")))
              (:out listing))
      (check! "connected show never fills absent graph metadata from bootstrap"
              (and (zero? (:exit show-missing))
                   (not (str/includes? (:out show-missing) "organizational owner")))
              (:out show-missing))
      (check! "connected strict lint fails when graph declarations are absent"
              (= 1 (:exit lint-before))
              (str "exit=" (:exit lint-before) " out=" (:out lint-before))))

    (let [before (run-schema port log telemetry receipts "audit" "--strict")]
      (check! "strict audit fails before migration"
              (= 1 (:exit before)) (str "exit=" (:exit before) " out=" (:out before))))

    (let [corrupt-before (run-schema port corrupt-log corrupt-telemetry corrupt-receipts
                                     "audit" "--strict")
          corrupt-snapshot
          (capture-fixture-snapshot! corrupt-snapshot-store
                                     corrupt-log corrupt-telemetry)
          corrupt-workspace
          (prepare-workspace!
           {:snapshot-store corrupt-snapshot-store
            :source-snapshot (:snapshot-id corrupt-snapshot)
            :workspace-root corrupt-workspace-root
            :manifest corrupt-manifest
            :execute true})
          corrupt-workspace-log (get-in corrupt-workspace
                                        [:records :coordination :path])
          corrupt-workspace-telemetry (get-in corrupt-workspace
                                              [:records :telemetry :path])
          refused
          (run-schema
           port corrupt-workspace-log corrupt-workspace-telemetry corrupt-receipts
           "build-candidate" "--execute" "--offline-confirm"
           "--manifest" corrupt-manifest
           "--snapshot-store" corrupt-snapshot-store
           "--source-snapshot" (:snapshot-id corrupt-snapshot)
           "--workspace-root" corrupt-workspace-root
           "--workspace" (:workspace_id corrupt-workspace)
           "--candidate-store" corrupt-candidate-store)]
      (check! "strict audit names the malformed predicate"
              (and (= 1 (:exit corrupt-before))
                   (str/includes? (:out corrupt-before) "corrupt predicate"))
              (:out corrupt-before))
      (check! "candidate preflight refuses to register around corrupt bytes"
              (and (not (zero? (:exit refused)))
                   (str/includes? (:out refused) "corrupt-facts-present")
                   (str/includes? (:err refused) "zero coordinator writes attempted"))
              (str "exit=" (:exit refused) " out=" (:out refused) " err=" (:err refused))))

    (let [log-before (slurp corrupt-log)
          telemetry-before (slurp corrupt-telemetry)
          diagnostic (run-schema port corrupt-log corrupt-telemetry corrupt-receipts
                                 "repair-corrupt")
          refused-repair (run-schema port corrupt-log corrupt-telemetry corrupt-receipts
                                     "repair-corrupt" "--execute" "--offline-confirm")]
      (check! "repair-corrupt dry-run names the exact malformed triple"
              (and (zero? (:exit diagnostic))
                   (str/includes? (:out diagnostic) "1 live non-registrable predicate fact(s)")
                   (str/includes? (:out diagnostic) "would retract exact triple")
                   (str/includes? (:out diagnostic) ":p \"\\\"\\\"\""))
              (str "exit=" (:exit diagnostic) " out=" (:out diagnostic) " err=" (:err diagnostic)))
      (check! "repair-corrupt execute fails closed without the corpus transaction surface"
              (and (not (zero? (:exit refused-repair)))
                   (str/includes? (:err refused-repair) "corpus transaction required")
                   (str/includes? (:err refused-repair) "no bytes written"))
              (str "exit=" (:exit refused-repair) " out=" (:out refused-repair)
                   " err=" (:err refused-repair)))
      (check! "diagnostic and refused repair leave both corpus logs byte-identical"
              (and (= log-before (slurp corrupt-log))
                   (= telemetry-before (slurp corrupt-telemetry))
                   (not (.exists (io/file corrupt-receipts))))
              nil))

    ;; The source snapshot remains immutable. The coordinator is switched to
    ;; the exact owned workspace, and only the finalized object is consumable.
    (stop-daemon! @daemon)
    (reset! daemon nil)
    (let [snapshot (capture-fixture-snapshot! snapshot-store log telemetry)
          _ (reset! source-snapshot (:snapshot-id snapshot))
          workspace
          (prepare-workspace!
           {:snapshot-store snapshot-store
            :source-snapshot (:snapshot-id snapshot)
            :workspace-root workspace-root
            :manifest manifest-path
            :execute true})
          workspace-log (get-in workspace [:records :coordination :path])
          workspace-telemetry (get-in workspace [:records :telemetry :path])
          _ (reset! prepared-workspace workspace)
          _ (reset! active-log workspace-log)
          _ (reset! active-telemetry workspace-telemetry)
          _ (reset! daemon (start-daemon port workspace-log workspace-telemetry))
          daemon-ready (eventually #(port-open? port))
          migrate
          (run-schema
           port workspace-log workspace-telemetry receipts
           "build-candidate" "--execute" "--offline-confirm"
           "--manifest" manifest-path
           "--snapshot-store" snapshot-store
           "--source-snapshot" (:snapshot-id snapshot)
           "--workspace-root" workspace-root
           "--workspace" (:workspace_id workspace)
           "--candidate-store" candidate-store)
          receipt-files (when (.isDirectory (io/file receipts))
                          (->> (.listFiles (io/file receipts))
                               (filter #(and (.isFile ^java.io.File %)
                                             (re-matches
                                              #"schema-(converged|rejected)-[0-9a-f]{64}\.edn"
                                              (.getName ^java.io.File %))))
                               vec))
          retained-receipt-stages
          (when (.isDirectory (io/file receipts))
            (->> (.listFiles (io/file receipts))
                 (filter #(str/starts-with?
                           (.getName ^java.io.File %)
                           ".schema-receipt-stage-v1."))
                 vec))
          receipt-data (when (= 1 (count receipt-files))
                         (edn/read-string (slurp (first receipt-files))))
          candidate-id (get-in receipt-data
                               [:finalized_candidate :candidate_id])
          _ (reset! finalized-candidate candidate-id)
          verified
          (when candidate-id
            (run-schema
             port workspace-log workspace-telemetry receipts
             "verify-candidate"
             "--snapshot-store" snapshot-store
             "--candidate-store" candidate-store
             "--candidate" candidate-id))
          candidate-authority-before (candidate-authority-seals candidate-store)
          workspace-before
          {:coordination (exact-file-seal workspace-log)
           :telemetry (exact-file-seal workspace-telemetry)}
          _ (stop-daemon! @daemon)
          _ (reset! daemon nil)
          counter (start-request-counter)
          resume
          (run-schema
           (:port counter) workspace-log workspace-telemetry receipts
           "build-candidate" "--execute" "--offline-confirm"
           "--manifest" manifest-path
           "--snapshot-store" snapshot-store
           "--source-snapshot" (:snapshot-id snapshot)
           "--workspace-root" workspace-root
           "--workspace" (:workspace_id workspace)
           "--candidate-store" candidate-store)
          _ ((:stop counter))
          resume-request-count @(:count counter)
          candidate-authority-after (candidate-authority-seals candidate-store)
          retained-candidate-stages-after
          (->> (or (.listFiles (io/file candidate-store))
                   (make-array java.io.File 0))
               (filter #(and (.isDirectory ^java.io.File %)
                             (str/starts-with?
                              (.getName ^java.io.File %)
                              ".schema-candidate-stage-v1.")))
               vec)
          workspace-after
          {:coordination (exact-file-seal workspace-log)
           :telemetry (exact-file-seal workspace-telemetry)}
          retained-receipt-stages-after
          (when (.isDirectory (io/file receipts))
            (->> (.listFiles (io/file receipts))
                 (filter #(str/starts-with?
                           (.getName ^java.io.File %)
                           ".schema-receipt-stage-v1."))
                 vec))
          resume-verified
          (when candidate-id
            (run-schema
             (:port counter) workspace-log workspace-telemetry receipts
             "verify-candidate"
             "--snapshot-store" snapshot-store
             "--candidate-store" candidate-store
             "--candidate" candidate-id))
          _ (reset! daemon (start-daemon port workspace-log workspace-telemetry))
          daemon-resumed (eventually #(port-open? port))]
      (check! "real Fram coordinator restarts on the exact owned workspace"
              (and daemon-ready daemon-resumed) nil)
      (check! "offline candidate build exits 0 on the completely reviewed workspace"
              (zero? (:exit migrate))
              (str "exit=" (:exit migrate) " out=" (:out migrate)
                   " err=" (:err migrate)))
      (check! "finalized candidate independently verifies"
              (and verified (zero? (:exit verified))
                   (str/includes? (:out verified) ":candidate_id")
                   (zero? (:exit resume))
                   (zero? resume-request-count)
                   (= workspace-before workspace-after)
                   (= candidate-authority-before candidate-authority-after)
                   (<= 2 (count retained-candidate-stages-after))
                   resume-verified (zero? (:exit resume-verified)))
              (pr-str {:initial verified :resume resume
                       :resume_request_count resume-request-count
                       :workspace_unchanged (= workspace-before workspace-after)
                       :candidate_authority_unchanged
                       (= candidate-authority-before candidate-authority-after)
                       :retained_candidate_stages
                       (count retained-candidate-stages-after)
                       :resume_verified resume-verified}))
      (check! "successful candidate emits exactly one attested converged receipt"
              (and (str/includes? (:out migrate) "receipt ")
                   (.isDirectory (io/file receipts))
                   (= 1 (count receipt-files))
                   (<= 2 (count retained-receipt-stages-after))
                   (str/starts-with? (.getName (first receipt-files))
                                     "schema-converged-")
                   (= CANDIDATE-RECEIPT-FORMAT (:format receipt-data))
                   (= "converged" (:result receipt-data))
                   (true? (:converged receipt-data))
                   (true? (:post_matches_simulation receipt-data))
                   (= (:actions_acknowledged receipt-data)
                      (count (:requested_action_identities receipt-data)))
                   (empty? (:remaining_action_identities receipt-data))
                   (= "advisory-file-locks"
                      (get-in receipt-data [:source_authority :lock :mode]))
                   (= "cooperating-processes-only"
                      (get-in receipt-data [:source_authority :lock :scope]))
                   (true? (get-in receipt-data
                                  [:source_authority
                                   :held_through_candidate_and_receipt_publication]))
                   (= 2 (count (get-in receipt-data
                                      [:source_authority :revalidated_files])))
                   (every? #(and (re-matches #"[0-9]+:[0-9]+"
                                             (:file_key %))
                                 (integer? (:bytes %))
                                 (re-matches #"[0-9a-f]{64}" (:sha256 %)))
                           (get-in receipt-data
                                   [:source_authority :revalidated_files]))
                   (= runtime-attestation/attestation-format
                      (get-in receipt-data [:daemon :runtime :format]))
                   (pos-int? (get-in receipt-data
                                     [:daemon :runtime :authority :pid]))
                   (re-matches #"[0-9a-f]{40,64}"
                               (get-in receipt-data
                                       [:daemon :runtime :identity :revision]))
                   (re-matches #"[0-9a-f]{40,64}"
                               (get-in receipt-data
                                       [:daemon :runtime :identity :tree]))
                   (re-matches #"[0-9a-f]{64}"
                               (get-in receipt-data
                                       [:daemon :runtime :identity
                                        :artifact-sha256]))
                   (<= (count runtime-attestation/required-runtime-artifacts)
                       (get-in receipt-data
                               [:daemon :runtime :identity :artifact-count]))
                   (same-existing-file?
                    (str fram "/coord_daemon.clj")
                    (get-in receipt-data
                            [:daemon :runtime :identity :script :path]))
                   (same-existing-file?
                    workspace-log
                    (get-in receipt-data
                            [:daemon :runtime :identity :served-log]))
                   (= candidate-id
                      (get-in receipt-data
                              [:finalized_candidate :candidate_id])))
              (pr-str {:exit (:exit migrate)
                       :receipt_file (some-> receipt-files first .getName)
                       :receipt (select-keys receipt-data
                                             [:format :result :converged
                                              :source_authority :daemon
                                              :finalized_candidate])})))
    (let [after (run-schema port @active-log @active-telemetry
                            receipts "audit" "--strict")]
      (check! "strict audit passes after migration"
              (zero? (:exit after)) (str "exit=" (:exit after) " out=" (:out after)))
      (check! "audit reports executable authority + governed entity kinds"
              (str/includes? (:out after) "executable predicate entities are authoritative")
              (:out after)))

    (let [lint-after (run-pred port @active-log @active-telemetry
                               "lint" "--strict")]
      (check! "connected strict lint passes from migrated graph authority"
              (zero? (:exit lint-after))
              (str "exit=" (:exit lint-after) " out=" (:out lint-after))))

    (let [facts (live-facts @active-log @active-telemetry)]
      (check! "valid graph declaration wins over bootstrap intent"
              (= #{"multi"} (values facts "@title" "cardinality")) nil)
      (check! "valid explicit false acyclic policy survives migration"
              (= #{"false"} (values facts "@part_of" "acyclic")) nil)
      (check! "valid explicit true acyclic policy survives migration"
              (= #{"true"} (values facts "@depends_on" "acyclic")) nil)
      (check! "observed unknown ref predicate gains complete executable metadata"
              (and (= #{"multi"} (values facts "@custom_ref" "cardinality"))
                   (= #{"ref"} (values facts "@custom_ref" "value_kind"))
                   (= #{"predicate"} (values facts "@custom_ref" "entity_kind"))
                   (= 1 (count (values facts "@custom_ref" "doc")))) nil)
      (check! "meta-schema is self-describing"
              (and (= #{"single"} (values facts "@cardinality" "cardinality"))
                   (= #{"literal"} (values facts "@cardinality" "value_kind"))) nil)
      (check! "core entity-kind definitions are explicit and open-taxonomy shaped"
              (and (= #{"north/entity_kind_definition"}
                      (values facts "@entity-kind:thread" "entity_kind"))
                   (= #{"thread"}
                      (values facts "@entity-kind:thread" "entity_kind_name"))) nil)
      (let [expected {"@thread-a" "thread"
                      "@topic-schema" "topic"
                      "@concern-schema" "concern"
                      "@msg:schema" "message"
                      "@run-schema" "run"
                      "@client-clock" "client_session"
                      "@denial:schema" "guard_denial"
                      "@agent:schema" "agent"
                      "@person-schema" "person"
                      "@custom_ref" "predicate"}]
        (check! "migration assigns every unambiguous core entity kind"
                (every? (fn [[subject kind]]
                          (= #{kind} (values facts subject "entity_kind")))
                        expected)
                (pr-str (into {} (map (fn [[subject _]]
                                        [subject (values facts subject "entity_kind")])
                                      expected)))))
      (check! "explicit namespaced entity-kind extension is preserved"
              (= #{"vendor/widget"} (values facts "@vendor-subject" "entity_kind")) nil)
      (check! "reviewed ambiguous extension receives only its explicit classification"
              (= #{"vendor/opaque"} (values facts "@ambiguous" "entity_kind")) nil))

    (let [second (run-schema port @active-log @active-telemetry
                             receipts "plan")]
      (check! "post-candidate plan is a zero-delta idempotence proof"
              (and (zero? (:exit second)) (str/includes? (:out second) "0 action(s)"))
              (str "exit=" (:exit second) " out=" (:out second))))

    (let [defined (run-pred port @active-log @active-telemetry
                            "define" "extension/example" "single" "literal"
                            "extension predicate")]
      (check! "pred define writes the exact executable entity"
              (zero? (:exit defined)) (str "exit=" (:exit defined) " out=" (:out defined))))
    (let [facts (live-facts @active-log @active-telemetry)]
      (check! "pred define stores executable metadata on @name"
              (and (= #{"single"} (values facts "@extension/example" "cardinality"))
                   (= #{"literal"} (values facts "@extension/example" "value_kind"))
                   (= #{"predicate"} (values facts "@extension/example" "entity_kind"))) nil)
      (check! "pred define never creates a historical @pred:* authority"
              (empty? (filter #(= "@pred:extension/example" (:l %)) facts)) nil))

    (let [alias (run-pred port @active-log @active-telemetry
                          "alias" "old" "new")]
      (check! "unsound executable predicate alias is rejected"
              (= 2 (:exit alias)) (str "exit=" (:exit alias) " err=" (:err alias))))

    (finally
      (stop-daemon! @daemon)
      (delete-tree! temp)))

  (let [results @checks failures (remove :ok results)
        passed (- (count results) (count failures))]
    (doseq [{:keys [label ok detail]} results]
      (println (format "  [%s] %s" (if ok "PASS" "FAIL") label))
      (when (and (not ok) detail) (println (str "         " detail))))
    (println (format "\nschema migration integration: %d / %d PASS" passed (count results)))
    (System/exit (if (empty? failures) 0 1))))
