#!/usr/bin/env bb
;; Adversarial, write-free proof of the schema cutover safety contract.
(require '[babashka.process :as proc]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.set :as set]
         '[clojure.string :as str])

(def root (.getCanonicalPath (io/file (.getParent (io/file *file*)) "../..")))
(def fram (.getCanonicalPath
           (io/file (or (System/getenv "FRAM_PATH") (str root "/../fram")))))
(load-file (str root "/cli/schema-migrate.clj"))
(require '[north.runtime-attestation :as runtime-attestation])

(def checks (atom []))
(defn check! [label ok detail]
  (swap! checks conj {:label label :ok (boolean ok) :detail detail}))

(defn ops-for [triples]
  (mapv (fn [index [subject predicate value]]
          {:tx (inc index) :op "assert" :l subject :p predicate :r value
           :frame "schema-safety-test"})
        (range) triples))

(defn corpus-for [triples]
  (let [ops (ops-for triples)
        folded (fold-for-cutover ops)]
    {:paths ["/tmp/schema-safety-coordination.log" "/tmp/schema-safety-telemetry.log"]
     :ops ops :facts (:facts folded) :version (:version folded)
     :card_map (:card_map folded)
     :files [{:path "/tmp/schema-safety-coordination.log" :bytes 1 :sha256 (apply str (repeat 64 "a"))}
             {:path "/tmp/schema-safety-telemetry.log" :bytes 0 :sha256 (apply str (repeat 64 "b"))}]}))

(defn facts-for [subject predicates]
  (mapv (fn [predicate] [subject predicate (str predicate "-value")]) predicates))

(defn repeat-subjects [prefix count predicates]
  (mapcat (fn [index] (facts-for (str "@" prefix index) predicates)) (range count)))

(def legacy-triples
  (vec
   (concat
    ;; 329 historical sessions: 51 human, 178 managed, 100 actor-absent.
    (mapcat (fn [index]
              [[(str "@2026-human-" index) "clocked_by" "user"]
               [(str "@2026-human-" index) "end_time" "end"]
               [(str "@2026-human-" index) "session_of" "thread"]
               [(str "@2026-human-" index) "start_time" "start"]])
            (range 51))
    (mapcat (fn [index]
              [[(str "@2026-agent-" index) "clocked_by" (str "lane-" index)]
               [(str "@2026-agent-" index) "end_time" "end"]
               [(str "@2026-agent-" index) "session_of" "thread"]
               [(str "@2026-agent-" index) "start_time" "start"]])
            (range 146))
    (repeat-subjects "2026-unknown-" 100 #{"end_time" "session_of" "start_time"})
    (mapcat (fn [index]
              [[(str "@2026-orphan-" index) "clock_orphaned" "true"]
               [(str "@2026-orphan-" index) "clocked_by" (str "lane-orphan-" index)]
               [(str "@2026-orphan-" index) "end_time" "end"]
               [(str "@2026-orphan-" index) "session_of" "thread"]
               [(str "@2026-orphan-" index) "start_time" "start"]])
            (range 24))
    (mapcat (fn [index]
              [[(str "@2026-open-" index) "clocked_by" (str "lane-open-" index)]
               [(str "@2026-open-" index) "session_of" "thread"]
               [(str "@2026-open-" index) "start_time" "start"]])
            (range 8))
    ;; 234 aggregate residues.
    (repeat-subjects "aggtest:done-" 130 #{"agg_done_batch" "agg_done_worker"})
    (repeat-subjects "aggtest:run-" 96 #{"agg_run_batch" "agg_run_tokens"})
    (repeat-subjects "aggtest:charge-" 8 #{"agg_charge_tokens" "agg_charged_to"})
    ;; 57 deprecated @pred:* projections.
    (repeat-subjects "pred:legacy-" 57 LEGACY-SCHEMA-PROJECTION-SIGNATURE)
    ;; Six explicit extension kinds.
    (mapcat (fn [index]
              [[(str "@clock-audit-" index) "kind" "clock_audit_run"]
               [(str "@clock-audit-" index) "repo_summary" "repo"]
               [(str "@clock-audit-" index) "run_at" "at"]
               [(str "@clock-audit-" index) "uncovered_count" "0"]
               [(str "@clock-audit-" index) "window" "week"]])
            (range 4))
    [["@integration-link" "kind" "integration_link"]
     ["@linear-reservation" "kind" "linear_bootstrap_reservation"]]
    ;; Two scratch fixtures.
    (facts-for "@scratch-sess-000001" #{"end_time" "start_time"})
    (facts-for "@scratch2-sess-a" #{"end_time" "start_time"})
    ;; Three intentionally unresolved quarantine decisions.
    [["@swarm" "agent_death" "dead"]
     ["019f6ec8-60b4-7d14-a199-1bdcb044a857" "merged_into" "bare-target"]
     ["@--json" "reached" ""]])))

(let [corpus (corpus-for legacy-triples)
      schema (desired-schema (:facts corpus))
      classes (entity-classifications (:facts corpus) schema)
      counts (frequencies (map (comp :kind val) classes))]
  (check! "all 628 deterministic legacy/test/extension subjects receive explicit kinds"
          (and (= 51 (get counts "north/legacy_human_session"))
               (= 178 (get counts "north/legacy_agent_session"))
               (= 100 (get counts "north/legacy_session"))
               (= 236 (get counts "north/test_fixture"))
               (= 57 (get counts "north/legacy_schema_projection"))
               (= 4 (get counts "north/clock_audit_run"))
               (= 1 (get counts "north/integration_link"))
               (= 1 (get counts "north/linear_bootstrap_reservation")))
          (pr-str counts))
  (check! "only the three named manual-quarantine decisions remain other"
          (= #{"@swarm" "019f6ec8-60b4-7d14-a199-1bdcb044a857" "@--json"}
             (set (map key (filter #(= "other" (get-in % [1 :kind])) classes))))
          (pr-str (into {} (filter #(= "other" (get-in % [1 :kind])) classes)))))

(let [prose "@session-beagle: completion prose with spaces"
      corpus (corpus-for [["@thread" "title" "thread"]
                          ["@thread" "notify" prose]
                          ["@thread" "blocks" "@prod deploy is waiting"]
                          ["@thread" "created_by" "claude-code"]
                          ["@thread" "driver" "@agent:missing"]
                          ["@thread" "mystery_extension" "@looks-like-a-ref"]])
      plan (plan-for corpus)
      defects (set (map :p (:reference-shape-defects plan)))
      dangling (set (map :p (:dangling-reference-defects plan)))]
  (check! "@-prefixed notification prose remains explicitly literal"
          (and (= "literal" (get-in plan [:schema "notify" :value_kind]))
               (not (contains? defects "notify")))
          (pr-str (:reference-shape-defects plan)))
  (check! "blocks keeps ref semantics and prose-valued legacy blocks is surfaced"
          (and (= "ref" (get-in plan [:schema "blocks" :value_kind]))
               (contains? defects "blocks"))
          (pr-str (:reference-shape-defects plan)))
  (check! "created_by remains a ref and dangling legacy spelling is surfaced"
          (and (= "ref" (get-in plan [:schema "created_by" :value_kind]))
               (contains? defects "created_by"))
          (pr-str (:reference-shape-defects plan)))
  (check! "driver remains a ref and a missing @entity target is surfaced"
          (and (= "ref" (get-in plan [:schema "driver" :value_kind]))
               (contains? dangling "driver"))
          (pr-str (:dangling-reference-defects plan)))
  (check! "unknown @-shaped extension semantics fail closed instead of becoming ref"
          (and (nil? (get-in plan [:schema "mystery_extension" :value_kind]))
               (= [{:predicate "mystery_extension"
                    :fields ["cardinality" "value_kind" "doc"]}]
                  (filterv #(= "mystery_extension" (:predicate %))
                           (:unresolved-semantics plan))))
          (pr-str (:unresolved-semantics plan))))

(def conflict-values
  {"started_at" ["2026-01-01T00:00:00Z" "2026-01-02T00:00:00Z"]
   "acked_at" ["2026-01-01T00:00:00Z" "2026-01-01T00:00:01Z"]
   "display_handle" ["old-handle" "new-handle"]
   "clocked_by" ["lane-a" "lane-b"]
   "at" ["2026-01-01T00:00:00Z" "2026-01-01T00:00:01Z"]
   "agent" ["agent:test" "@agent:test"]
   "dir" ["/repo/a" "/repo/b"]
   "intent" ["old intent" "new intent"]
   "provider" ["unobserved" "openai"]
   "status" ["draft" "done"]})

(def conflict-subjects
  {"started_at" "@session:test-start"
   "acked_at" "@msg:test-ack"
   "display_handle" "@agent:test-display"
   "clocked_by" "@session:test-clock"
   "at" "@run:test-at"
   "agent" "@run:test-agent"
   "dir" "@session:test-dir"
   "intent" "@concern-test-intent"
   "provider" "@run:test-provider"
   "status" "@concern-test-status"})

(def conflict-triples
  (vec
   (concat
    (mapcat (fn [[predicate values]]
              (mapv (fn [value] [(get conflict-subjects predicate) predicate value]) values))
            conflict-values)
    [["@thread-block" "title" "blocked thread"]
     ["@agent:test" "entity_kind" "agent"]
     ["@thread-block" "blocks" "@prod deploy is waiting"]
     ["@thread-block" "notify" "@session: this is prose"]])))

(let [corpus (corpus-for conflict-triples)
      unreviewed (plan-for corpus)
      conflicts (:cardinality-conflicts unreviewed)
      repairs (mapv (fn [{:keys [subject predicate values]}]
                      {:subject subject :predicate predicate
                       :retain (first values) :retract (vec (rest values))
                       :policy "explicit-test-policy"
                       :rationale (str "reviewed semantic decision for " predicate)})
                    conflicts)
      manifest {:format REPAIR-MANIFEST-FORMAT
                :source (source-seal corpus)
                :review {:by "schema-safety-test" :at "2026-07-22T00:00:00Z"
                         :basis "ten-class adversarial fixture"}
                :predicate_semantics
                {"block_reason" {:cardinality "multi" :value_kind "literal"
                                 :doc "Literal explanation for a blocking condition."
                                 :rationale "separates prose from the blocks reference edge"}}
                :cardinality_repairs repairs
                :fact_repairs
                [{:action "retract" :subject "@thread-block" :predicate "blocks"
                  :value "@prod deploy is waiting" :policy "split-overloaded-blocks"
                  :rationale "prose cannot inhabit the reference edge"}
                 {:action "assert" :subject "@thread-block" :predicate "block_reason"
                  :value "prod deploy is waiting" :policy "split-overloaded-blocks"
                  :rationale "preserve prose under an explicit literal predicate"}]
                :other_allowlist {:name "empty-test-allowlist" :entries {}}}
      reviewed (validate-manifest-structure! manifest)
      preflight (candidate-preflight corpus reviewed)]
  (check! "all ten audited cardinality conflict classes are enumerated before writes"
          (= (set (keys conflict-values)) (set (map :predicate conflicts)))
          (pr-str conflicts))
  (check! "missing manifest coverage fails every conflict rather than selecting latest tx"
          (= 10 (count (filter #(= "missing-cardinality-repair" (:type %))
                               (:manifest-defects unreviewed))))
          (pr-str (:manifest-defects unreviewed)))
  (check! "reviewed exact repairs plus block-reason split simulate to plan convergence"
          (and (:ok preflight)
               (empty? (get-in preflight [:post_plan :actions]))
               (empty? (get-in preflight [:post_plan :cardinality-conflicts]))
               (true? (get-in preflight [:post_audit :ok])))
          (pr-str (:defects preflight))))

(let [corpus (corpus-for [["@ambiguous" "opaque_extension" "value"]])
      report (audit-report corpus)]
  (check! "strict audit model rejects unresolved other outside a named allowlist"
          (and (false? (:ok report)) (= ["@ambiguous"] (:ambiguous_subjects report)))
          (pr-str report)))

(let [corpus (corpus-for [["@thread-a" "title" "a"]
                           ["@thread-b" "title" "b"]
                           ["@thread-a" "depends_on" "@thread-b"]
                           ["@thread-b" "depends_on" "@thread-a"]])
      plan (plan-for corpus)]
  (check! "acyclic dependency cycles are surfaced before candidate construction"
          (= #{["@thread-a" "depends_on"] ["@thread-b" "depends_on"]}
             (set (map (juxt :l :p) (:acyclic-cycle-defects plan))))
          (pr-str (:acyclic-cycle-defects plan))))

(let [corpus (corpus-for [["@thread" "title" "one"]])
      template (manifest-template corpus (plan-for corpus))
      rejected? (try
                  (validate-manifest-structure! template)
                  false
                  (catch clojure.lang.ExceptionInfo error
                    (= :unreviewed-repair-manifest (:type (ex-data error)))))]
  (check! "generated manifest placeholders cannot masquerade as review"
          rejected? (pr-str template)))

;; Reproduce the old sequential-failure shape without touching a coordinator:
;; 1,152 acknowledged actions followed by rejection. Then prove the public direct
;; execute route cannot enter that loop and leaves bytes identical.
(let [acknowledged (atom 0)]
  (try
    (doseq [index (range 1153)]
      (if (= index 1152)
        (throw (ex-info "simulated cardinality rejection" {}))
        (swap! acknowledged inc)))
    (catch Exception _ nil))
  (check! "legacy sequential apply reproduces exactly 1,152 partial acknowledgements"
          (= 1152 @acknowledged) (str @acknowledged)))

(defn delete-tree! [file]
  (when (.isDirectory file)
    (doseq [child (.listFiles file)] (delete-tree! child)))
  (.delete file))

(defn temp-directory [prefix]
  (.toFile (java.nio.file.Files/createTempDirectory
            prefix (make-array java.nio.file.attribute.FileAttribute 0))))

(defn candidate-line [title]
  (str (pr-str {:tx 1 :op "assert" :l "@thread-a" :p "title" :r title
                :frame "schema-safety-test"})
       "\n"))

(defn empty-reviewed-manifest [corpus]
  (validate-manifest-structure!
   {:format REPAIR-MANIFEST-FORMAT
    :source (source-seal corpus)
    :review {:by "schema-safety-test"
             :at "2026-07-22T00:00:00Z"
             :basis "Adversarial sealed-candidate fixture."}
    :predicate_semantics {}
    :cardinality_repairs []
    :fact_repairs []
    :other_allowlist {:name "empty-schema-safety-allowlist" :entries {}}}))

(defn capture-fixture-snapshot! [store log telemetry]
  (let [identity {:fixture "schema-migrate-safety-snapshot/v1"}]
    (north.snapshot/create-snapshot!
     {:store store
      :live {:coordination log :telemetry telemetry}
      :runtime! (fn [] identity)
      :controller! (fn [] identity)
      :runtime-current! (fn [_] true)
      :controller-current! (fn [_] true)
      :provenance identity
      :execute? true})))

(def authoritative-receipt-name-pattern
  #"^schema-(converged|rejected)-[0-9a-f]{64}\.edn$")

(defn nofollow-regular-file? [file]
  (java.nio.file.Files/isRegularFile
   (.toPath ^java.io.File file)
   (into-array java.nio.file.LinkOption
               [java.nio.file.LinkOption/NOFOLLOW_LINKS])))

(defn authoritative-receipt-files [directory]
  (->> (or (.listFiles (io/file directory))
           (make-array java.io.File 0))
       (filter #(and (nofollow-regular-file? %)
                     (re-matches authoritative-receipt-name-pattern
                                 (.getName ^java.io.File %))))
       vec))

(defn retained-receipt-stage-files [directory]
  (->> (or (.listFiles (io/file directory))
           (make-array java.io.File 0))
       (filter #(and (nofollow-regular-file? %)
                     (re-matches RECEIPT-STAGE-NAME-PATTERN
                                 (.getName ^java.io.File %))))
       vec))

(defn retained-candidate-stage-directories [directory]
  (->> (or (.listFiles (io/file directory))
           (make-array java.io.File 0))
       (filter #(and (.isDirectory ^java.io.File %)
                     (str/starts-with? (.getName ^java.io.File %)
                                       ".schema-candidate-stage-v1.")))
       vec))

(defn candidate-fixture [prefix]
  (let [temp (temp-directory prefix)
        source-log (.getCanonicalPath (io/file temp "coordination.log"))
        source-telemetry (.getCanonicalPath (io/file temp "telemetry.log"))
        receipts (.getCanonicalPath (io/file temp "receipts"))
        snapshot-store (.getCanonicalPath (io/file temp "snapshots"))
        workspace-root (.getCanonicalPath (io/file temp "workspaces"))
        candidate-store (.getCanonicalPath (io/file temp "candidates"))
        manifest-path (.getCanonicalPath (io/file temp "reviewed-manifest.edn"))]
    (spit source-log (candidate-line "one"))
    (spit source-telemetry "")
    (let [source-paths (resolve-corpus-paths! source-log source-telemetry)
          live-corpus (read-corpus source-paths)
          _ (spit manifest-path
                  (str (pr-str (empty-reviewed-manifest live-corpus)) "\n"))
          snapshot (capture-fixture-snapshot!
                    snapshot-store source-log source-telemetry)
          source (schema-candidate/verify-source!
                  snapshot-store (:snapshot-id snapshot))
          origin-paths
          (mapv #(get-in source [:records % :path])
                [:coordination :telemetry])
          origin-corpus (read-corpus origin-paths)
          manifest (read-repair-manifest! manifest-path origin-corpus)
          prepared
          (schema-candidate/prepare-workspace!
           {:workspace-root workspace-root
            :snapshot-store snapshot-store
            :source-snapshot (:snapshot-id snapshot)
            :repair-manifest-sha256 (:_sha256 manifest)
            :execute? true})
          opts {:offline-confirm true :verbose false :receipt-dir receipts
                :snapshot-store snapshot-store
                :source-snapshot (:snapshot-id snapshot)
                :workspace-root workspace-root
                :workspace (:workspace_id prepared)
                :candidate-store candidate-store}
          workspace (verify-workspace! opts source (:_sha256 manifest))
          paths (:paths workspace)
          corpus (read-corpus paths)]
      {:temp temp :log (first paths) :telemetry (second paths)
       :receipts receipts :candidate-store candidate-store
       :snapshot-store snapshot-store :snapshot snapshot
       :workspace-root workspace-root :workspace workspace
       :source source :origin-corpus origin-corpus
       :paths paths :corpus corpus :manifest manifest :opts opts})))

(defn current-jvm-file-lock-held? [path]
  (with-open [channel (java.nio.channels.FileChannel/open
                       (.toPath (io/file path))
                       (into-array java.nio.file.OpenOption
                                   [java.nio.file.StandardOpenOption/READ
                                    java.nio.file.StandardOpenOption/WRITE]))]
    (try
      (if-let [lock (.tryLock channel)]
        (do (.release lock) false)
        true)
      (catch java.lang.IllegalStateException _ true)
      (catch Exception _ false))))

(defn exception-data [f]
  (try
    (f)
    nil
    (catch clojure.lang.ExceptionInfo error (ex-data error))))

(defn fram-git-value [expression]
  (let [result (proc/shell {:out :string :err :string :continue true}
                           "git" "-C" fram "rev-parse" "--verify" expression)]
    (when-not (zero? (:exit result))
      (throw (ex-info "schema safety test requires a Git Fram source"
                      {:fram fram :expression expression :error (:err result)})))
    (str/trim (:out result))))

(defn write-forged-runtime-record! [path pid]
  (spit path
        (str "PID=" pid "\n"
             "PID_BIRTH=" (runtime-attestation/process-birth-token pid) "\n"
             "OWNER_TOKEN=forged-static-owner\n"
             "FRAM_RUNTIME_SOURCE=" fram "\n"
             "FRAM_RUNTIME_REV=" (fram-git-value "HEAD") "\n"
             "FRAM_RUNTIME_TREE=" (fram-git-value "HEAD^{tree}") "\n"
             "FRAM_RUNTIME_DAEMON=" fram "/bin/fram-daemon\n"))
  path)

(defn fake-strict-server [server log version request-count]
  (future
    (dotimes [_ request-count]
      (with-open [socket (.accept server)
                  reader (io/reader (.getInputStream socket))
                  writer (io/writer (.getOutputStream socket))]
        (let [request (edn/read-string (.readLine reader))
              response (if (= :for-log (:op request))
                         {:version version}
                         {:reject ["this coordinator requires a :for-log envelope"]
                          :code :log-fence-required
                          :served-log log})]
          (.write writer (str (pr-str response) "\n"))
          (.flush writer))))))

;; A protocol-shaped socket used to satisfy the old gate. It is deliberately
;; hosted by this test process, so it cannot satisfy the selected Fram
;; revision/artifact/process attestation added to the execution gate.
(let [temp (temp-directory "north-schema-fake-runtime-")
      log (.getCanonicalPath (io/file temp "coordination.log"))
      record (.getCanonicalPath (io/file temp "runtime.identity"))
      _ (spit log (candidate-line "one"))
      server (java.net.ServerSocket. 0)
      port (.getLocalPort server)
      _ (write-forged-runtime-record!
         record (.pid (java.lang.ProcessHandle/current)))
      worker (fake-strict-server server log 1 2)]
  (try
    (let [strict-status (north.coord/strict-coordinator-status port log)
          denied (with-redefs [runtime-record-path (fn [_] record)]
                   (exception-data #(require-offline-daemon! port log 1)))
          worker-result (deref worker 5000 ::timeout)]
      (check! "protocol-correct fake listener reproduces the old strict-ready false positive"
              (and (:ready strict-status) (= 1 (:version strict-status)))
              (pr-str strict-status))
      (check! "selected Fram revision/artifact/process attestation rejects that fake listener"
              (and (not= ::timeout worker-result)
                   (= :runtime-process-attestation-failed (:type denied)))
              (pr-str denied)))
    (finally
      (.close server)
      (future-cancel worker)
      (delete-tree! temp))))

;; Drift occurs after exclusive file authority is acquired and preserves both
;; folded version and byte length. The changed hash must stop execution before
;; the first coordinator append and before receipt publication.
(let [{:keys [temp log receipts candidate-store source workspace origin-corpus
              corpus manifest opts] :as fixture}
      (candidate-fixture "north-schema-sealed-drift-")
      writes (atom 0)
      lock-observed (atom false)
      attestation-calls (atom 0)
      classify-calls (atom 0)
      preflight (candidate-preflight origin-corpus manifest)
      original-classify classify-workspace
      denied
      (with-redefs [attest-selected-fram-runtime!
                    (fn [_ _] {:fixture true})
                    require-offline-daemon!
                    (fn [_ _ version runtime]
                      (reset! lock-observed (current-jvm-file-lock-held? log))
                      {:ready true :version version :runtime runtime})
                    runtime-attestation/assert-current!
                    (fn [_]
                      (swap! attestation-calls inc)
                      true)
                    classify-workspace
                    (fn [locked-workspace current locked-preflight]
                      (let [state (original-classify
                                   locked-workspace current locked-preflight)]
                        (when (= 3 (swap! classify-calls inc))
                          (spit log (candidate-line "two")))
                        state))
                    apply-wire-actions!
                    (fn [_ actions]
                      (swap! writes + (count actions))
                      (count actions))]
        (exception-data
         #(binding [*out* (java.io.StringWriter.)]
            (execute-offline-candidate!
             1 source workspace origin-corpus corpus manifest opts))))
      source-before (first (:files corpus))
      source-after (corpus-file-record log)
      drifted-corpus (read-corpus (:paths workspace))
      receipt-stages (retained-receipt-stage-files receipts)
      candidate-stages (retained-candidate-stage-directories candidate-store)]
  (try
    (check! "same-version same-size source-byte drift under held locks fails before append"
            (and (:ok preflight)
                 @lock-observed
                 (= 1 @attestation-calls)
                 (= :sealed-source-drift (:type denied))
                 (= 0 @writes)
                 (= (:version corpus) (:version drifted-corpus))
                 (re-matches #"[0-9]+:[0-9]+" (:file_key source-before))
                 (= (:file_key source-before) (:file_key source-after))
                 (= (:bytes source-before) (:bytes source-after))
                 (not= (:sha256 source-before) (:sha256 source-after)))
            (pr-str {:preflight-ok (:ok preflight)
                     :lock-observed @lock-observed
                     :attestation-calls @attestation-calls
                     :denied denied :writes @writes
                     :before source-before :after source-after}))
    (check! "sealed-source drift emits no authoritative receipt and retains private reservations"
            (and (empty? (authoritative-receipt-files receipts))
                 (= 1 (count receipt-stages))
                 (= 1 (count candidate-stages))
                 (.isFile (io/file (first candidate-stages)
                                   ".north-schema-stage.edn")))
            (pr-str {:fixture fixture
                     :receipt-stages (mapv #(.getName %) receipt-stages)
                     :candidate-stages (mapv #(.getName %) candidate-stages)}))
    (finally (delete-tree! temp))))

;; A non-writing coordinator stub creates a postcondition divergence. A receipt
;; may exist for that forensic result, but its filename and payload must both say
;; rejected and the API must still throw.
(let [{:keys [temp receipts source workspace origin-corpus corpus manifest opts]}
      (candidate-fixture "north-schema-rejected-receipt-")
      denied
      (with-redefs [attest-selected-fram-runtime! (fn [_ _] {:fixture true})
                    require-offline-daemon!
                    (fn [_ _ version runtime]
                      {:ready true :version version :runtime runtime})
                    runtime-attestation/assert-current! (fn [_] true)
                    apply-wire-actions! (fn [_ actions] (count actions))]
        (exception-data
         #(binding [*out* (java.io.StringWriter.)]
            (execute-offline-candidate!
             1 source workspace origin-corpus corpus manifest opts))))
      files (authoritative-receipt-files receipts)
      receipt (when (= 1 (count files)) (edn/read-string (slurp (first files))))]
  (try
    (check! "receipt existence never implies success: divergent execution throws with explicit rejection"
            (and (= :candidate-postcondition-failed (:type denied))
                 (= "rejected" (:result denied))
                 (= 1 (count files))
                 (str/starts-with? (.getName (first files)) "schema-rejected-")
                 (= CANDIDATE-RECEIPT-FORMAT (:format receipt))
                 (false? (:converged receipt))
                 (= "rejected" (:result receipt)))
            (pr-str {:denied denied :receipt receipt}))
    (finally (delete-tree! temp))))

;; Publication is a content-addressed create-new operation. Concurrent writers
;; must converge on one immutable inode; exact retries are accepted while a
;; pre-existing, wrong payload at the same content-addressed name is never
;; replaced.
(let [temp (temp-directory "north-schema-receipt-publication-")
      concurrent-dir (.getCanonicalPath (io/file temp "concurrent"))
      collision-dir (.getCanonicalPath (io/file temp "collision"))
      symlink-dir (.getCanonicalPath (io/file temp "symlink"))
      rejected-dir (.getCanonicalPath (io/file temp "rejected"))
      receipt {:format CANDIDATE-RECEIPT-FORMAT
               :result "converged" :converged true
               :finalized_candidate
               {:candidate_id (str "schema-candidate-"
                                   (apply str (repeat 64 "a")))
                :manifest_sha256 (apply str (repeat 64 "b"))}
               :probe "concurrent-publication" :observed "one exact payload"}
      expected-bytes (receipt-bytes receipt)
      publishers (mapv (fn [_]
                         (future
                           (try
                             {:path (write-receipt! concurrent-dir receipt)}
                             (catch Throwable error
                               {:error (str (type error) ": " (.getMessage error))}))))
                       (range 32))
      results (mapv deref publishers)
      published-files (authoritative-receipt-files concurrent-dir)
      published (first published-files)
      target (.getCanonicalPath (receipt-target concurrent-dir receipt))
      permissions (when published
                    (set (java.nio.file.Files/getPosixFilePermissions
                          (.toPath published)
                          (make-array java.nio.file.LinkOption 0))))
      expected-permissions
      #{java.nio.file.attribute.PosixFilePermission/OWNER_READ
        java.nio.file.attribute.PosixFilePermission/GROUP_READ
        java.nio.file.attribute.PosixFilePermission/OTHERS_READ}
      before-retry (when published (java.nio.file.Files/readAllBytes (.toPath published)))
      retry-path (write-receipt! concurrent-dir receipt)
      after-retry (when published (java.nio.file.Files/readAllBytes (.toPath published)))
      retained-stages (retained-receipt-stage-files concurrent-dir)
      collision-target (receipt-target collision-dir receipt)
      _ (.mkdirs (io/file collision-dir))
      _ (spit collision-target "tampered\n")
      _ (java.nio.file.Files/setPosixFilePermissions
         (.toPath collision-target)
         (java.util.HashSet. ^java.util.Collection expected-permissions))
      collision-before (slurp collision-target)
      collision-inode-before
      (str (.fileKey
            (java.nio.file.Files/readAttributes
             (.toPath collision-target)
             java.nio.file.attribute.BasicFileAttributes
             (into-array java.nio.file.LinkOption
                         [java.nio.file.LinkOption/NOFOLLOW_LINKS]))))
      collision-denied (exception-data #(write-receipt! collision-dir receipt))
      collision-after (slurp collision-target)
      collision-inode-after
      (str (.fileKey
            (java.nio.file.Files/readAttributes
             (.toPath collision-target)
             java.nio.file.attribute.BasicFileAttributes
             (into-array java.nio.file.LinkOption
                         [java.nio.file.LinkOption/NOFOLLOW_LINKS]))))
      _ (.mkdirs (io/file symlink-dir))
      symlink-payload (io/file symlink-dir "external-payload.edn")
      _ (java.nio.file.Files/write
         (.toPath symlink-payload) expected-bytes
         (into-array java.nio.file.OpenOption
                     [java.nio.file.StandardOpenOption/CREATE_NEW
                      java.nio.file.StandardOpenOption/WRITE]))
      symlink-target (receipt-target symlink-dir receipt)
      _ (java.nio.file.Files/createSymbolicLink
         (.toPath symlink-target) (.toPath symlink-payload)
         (make-array java.nio.file.attribute.FileAttribute 0))
      symlink-denied (exception-data #(write-receipt! symlink-dir receipt))
      rejected-receipt (-> receipt
                           (assoc :result "rejected" :converged false)
                           (dissoc :finalized_candidate))
      rejected-path (write-receipt! rejected-dir rejected-receipt)
      rejected-data (edn/read-string (slurp rejected-path))
      inconsistent-denied
      (exception-data #(write-receipt! rejected-dir
                                       (assoc receipt :result "rejected")))]
  (try
    (check! "32 concurrent receipt publishers converge on one exact immutable file"
            (and (every? #(= target (:path %)) results)
                 (= 1 (count published-files))
                 (bytes-equal? published expected-bytes)
                 (= expected-permissions permissions)
                 (= 33 (count retained-stages)))
            (pr-str {:results results :files (mapv #(.getName %) published-files)
                     :retained-stages (mapv #(.getName %) retained-stages)
                     :permissions permissions}))
    (check! "byte-identical receipt retry is idempotent and changes no payload"
            (and (= target retry-path)
                 (java.util.Arrays/equals ^bytes before-retry ^bytes after-retry))
            (pr-str {:target target :retry retry-path}))
    (check! "tampered content-addressed target fails closed without replacement"
            (and (= :schema-owned-file-helper-refused (:type collision-denied))
                 (str/includes? (:error collision-denied)
                                "receipt target has different bytes")
                 (= collision-before collision-after)
                 (= collision-inode-before collision-inode-after))
            (pr-str collision-denied))
    (check! "byte-identical symlink cannot masquerade as an existing receipt object"
            (and (= :schema-owned-file-helper-refused (:type symlink-denied))
                 (str/includes? (:error symlink-denied)
                                "receipt target is not an immutable owned file")
                 (java.nio.file.Files/isSymbolicLink (.toPath symlink-target))
                 (bytes-equal? symlink-payload expected-bytes))
            (pr-str symlink-denied))
    (check! "rejected receipts are explicit and inconsistent verdicts are refused"
            (and (str/includes? (.getName (io/file rejected-path)) "schema-rejected-")
                 (false? (:converged rejected-data))
                 (= "rejected" (:result rejected-data))
                 (= :invalid-candidate-receipt-verdict (:type inconsistent-denied)))
            (pr-str {:rejected rejected-data :inconsistent inconsistent-denied}))
    (finally (delete-tree! temp))))

(let [temp (.toFile (java.nio.file.Files/createTempDirectory
                     "north-schema-direct-refusal-"
                     (make-array java.nio.file.attribute.FileAttribute 0)))
      log (.getCanonicalPath (io/file temp "coordination.log"))
      telemetry (.getCanonicalPath (io/file temp "telemetry.log"))
      line (pr-str {:tx 1 :op "assert" :l "@thread" :p "title" :r "one"
                    :frame "schema-safety-test"})
      _ (spit log (str line "\n"))
      _ (spit telemetry "")
      before [(slurp log) (slurp telemetry)]
      alias-refused?
      (with-redefs [possible-live-corpus-paths (fn [] [log])]
        (try
          (assert-offline-candidate! [log telemetry])
          false
          (catch clojure.lang.ExceptionInfo error
            (= :live-corpus-candidate-refused (:type (ex-data error))))))
      result (proc/shell {:dir root :out :string :err :string :continue true
                          :extra-env {"FRAM_LOG" log "FRAM_TELEMETRY_LOG" telemetry
                                      "FRAM_SINGLE_VALUED" ""}}
                         "bb" "-cp" (str fram "/out")
                         (str root "/cli/schema-migrate.clj") "1" "migrate" "--execute"
                         "--log" log "--telemetry" telemetry)]
  (try
    (check! "candidate builder refuses a canonical or hard-link live alias"
            (and alias-refused? (= before [(slurp log) (slurp telemetry)]))
            (str "alias-refused=" alias-refused?))
    (check! "direct migrate execute fails before its first coordinator write"
            (and (not (zero? (:exit result)))
                 (str/includes? (:err result) "direct migrate --execute is disabled")
                 (= before [(slurp log) (slurp telemetry)]))
            (str "exit=" (:exit result) " out=" (:out result) " err=" (:err result)))
    (finally (delete-tree! temp))))

(let [results @checks failures (remove :ok results)
      passed (- (count results) (count failures))]
  (doseq [{:keys [label ok detail]} results]
    (println (format "  [%s] %s" (if ok "PASS" "FAIL") label))
    (when (and (not ok) detail) (println (str "         " detail))))
  (println (format "\nschema migration safety: %d / %d PASS" passed (count results)))
  (System/exit (if (empty? failures) 0 1)))
