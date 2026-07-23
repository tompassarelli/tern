#!/usr/bin/env bb
;; Canonical executable schema migration for North.
;;
;; A predicate has exactly one authority: the Fram predicate entity @<name>.
;; cardinality, value_kind, acyclic, doc, entity_kind, and any extension metadata
;; are ordinary facts on that entity.  The old @pred:<name> catalog is never read
;; here; pred-cli now renders the executable entities directly.
;;
;; The migration is deliberately additive for valid declarations.  Existing
;; executable metadata wins. BOOTSTRAP VOCAB and the fixed legacy-kernel singleton
;; set are used only to fill an absent declaration during the one-time cutover;
;; caller environment fallback is deliberately excluded from sealed planning.
;; Once every live predicate has explicit facts, engine fallback is inert.
;;
;; Run through bin/north (it supplies Fram's classpath and corpus paths):
;;   north schema-migrate plan
;;   north schema-migrate migrate                         # plan-only compatibility
;;   north schema-migrate build-candidate --execute \
;;     --offline-confirm --manifest REVIEWED.edn          # disposable copies only
;;   north schema-migrate audit --strict
;;   north schema-migrate repair-corrupt                 # diagnostics only
(require '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.set :as set]
         '[clojure.string :as str]
         '[cheshire.core :as json]
         '[fram.fold :as fold]
         '[fram.kernel :as kernel]
         '[fram.rt :as rt])

(def SCHEMA-MIGRATE-SOURCE
  (.getCanonicalPath (io/file (or *file* (System/getProperty "babashka.file")))))

(load-file (str (.getParent (io/file SCHEMA-MIGRATE-SOURCE)) "/coord.clj"))
(load-file (str (.getParent (io/file SCHEMA-MIGRATE-SOURCE))
                "/corpus-transaction.clj"))
(load-file (str (.getParent (io/file SCHEMA-MIGRATE-SOURCE))
                "/runtime-attestation.clj"))
(load-file (str (.getParent (io/file SCHEMA-MIGRATE-SOURCE)) "/snapshot.clj"))
(load-file (str (.getParent (io/file SCHEMA-MIGRATE-SOURCE))
                "/schema-candidate.clj"))
(require '[north.corpus-transaction :as corpus-transaction]
         '[north.schema-candidate :as schema-candidate]
         '[north.snapshot :as snapshot]
         '[north.runtime-attestation :as runtime-attestation])

(def VALID-PREDICATE #"^[A-Za-z][A-Za-z0-9_-]*(?:/[A-Za-z][A-Za-z0-9_-]*)?$")
(def VALID-ENTITY-KIND #"^[a-z][a-z0-9_-]*(?:/[a-z][a-z0-9_-]*)?$")
(def META-PREDICATES #{"cardinality" "value_kind" "acyclic"})
(def ACYCLIC-PREDICATES #{"depends_on" "part_of"})
(def REPAIR-MANIFEST-FORMAT "north-schema-repair-manifest/v1")
(def PLAN-FORMAT "north-schema-plan/v2")
(def AUDIT-FORMAT "north-schema-audit/v2")
(def CANDIDATE-RECEIPT-FORMAT "north-schema-candidate-build/v2")
(def WORKSPACE-FORMAT "north-schema-workspace/v1")
(def FINAL-CANDIDATE-FORMAT "north-schema-finalized-candidate/v1")
(def OWNED-STAGE-FORMAT "north-schema-owned-stage/v1")
(def WORKSPACE-ID-PATTERN
  #"schema-workspace-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
(def FINAL-CANDIDATE-ID-PATTERN #"schema-candidate-[0-9a-f]{64}")
(def OWNED-STAGE-NAME-PATTERN
  #"^\.schema-(workspace|candidate)-stage-v1\.([1-9][0-9]*)\.proc-([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$")
(def RECEIPT-STAGE-NAME-PATTERN
  #"^\.schema-receipt-stage-v1\.([1-9][0-9]*)\.proc-([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$")
(def WORKSPACE-FILE-NAMES
  {:coordination "coordination.log" :telemetry "telemetry.log"})

;; Fram's transitional fallback is copied only into the migration input.  The
;; migration materializes each applicable value as @p cardinality single; no
;; North runtime decision reads this set after migration.
(def LEGACY-KERNEL-SINGLE
  #{"title" "owner" "lead" "driver" "source" "part_of" "do_on" "valid_until"
    "estimate_hours" "created_at" "updated_at" "name" "body" "created_by"
    "committed" "outcome" "abandoned" "superseded_by" "merged_into"
    "session_of" "start_time" "end_time" "clockify_id"})

(def CORE-ENTITY-KINDS
  (sorted-map
   "agent" "A human-facing or managed execution identity."
   "client_rate_config" "A per-owner client billing rate configuration read by clock rate lookups; never a session interval."
   "client_session" "One human/client billing-clock interval; never a managed run."
   "concern" "A concurrent implementation footprint and intent declaration."
   "guard_denial" "An admission-guard refusal with its diagnostic evidence."
   "message" "A durable coordination message or peer command envelope."
   "person" "A human identity with a display_name."
   "predicate" "An executable Fram predicate entity carrying its own schema facts."
   "run" "One managed task-duration and delivery telemetry record."
   "thread" "A durable unit of intended or possible work."
   "topic" "A thread-shaped relatedness anchor."))

;; North Orchestration vocabulary kinds (Gaffer -> North Orchestration migration,
;; Phase 0 inert seed; thread 019f8f5c, design doc sections 1-2). Registration
;; only: no interpreter reads these entity_kind values yet, and the sibling
;; @shape:<kind> subjects (seeded by orchestration-vocab-cli.clj) carry an
;; explicit unshaped/warn enforcement dial per design section 2.3 — nothing here
;; rejects a write. Kept as a separate table so the Phase-0 vocabulary is
;; mechanically distinguishable from core North domain kinds above.
(def ORCHESTRATION-ENTITY-KINDS
  (sorted-map
   "template" "A named role composition (axes + capabilities + prompt block) resolved by spawn."
   "axis_value" "A first-class value of an orchestration axis (task_grade/tier/reasoning/posture/topology/capability/...)."
   "provider_catalog" "A provider's calibrated model/transport/provenance catalog vintage."
   "model" "One provider model with its calibrated routes, context window, and delta."
   "tier_row" "The canonical model + deliberation levels resolved for one provider/tier pair."
   "selection_policy" "A named, digest-pinned set of selection_rule subjects (e.g. minimum-sufficient-v1)."
   "selection_rule" "One signal -> minimum tier/reasoning floor rule under a selection_policy."
   "selection_signal" "A routing signal's name and enumerated legal values."
   "shape" "A kind-scoped default-deny predicate allowlist, itself governed by @shape:shape."
   "wire_contract" "A queryable subject documenting one coordinator wire contract (fields, example, error codes)."
   "staffing_catalog" "Catalog-level defaults for template axes (task_grade/tier/reasoning/posture/topology)."
   "doctrine_block" "A graph-resident prompt_block not attached to a template (e.g. comms doctrine)."
   "task" "An accepted delegation subject: proposed_by (director) != delegate (child lane), position 3."))

(def LEGACY-ENTITY-KINDS
  (sorted-map
   "north/clock_audit_run" "One historical clock-coverage audit execution."
   "north/integration_link" "A deterministic external-integration identity link."
   "north/legacy_agent_session" "A pre-run-model managed-agent timing session; audit-only and never billable."
   "north/legacy_human_session" "A pre-client-session human billing interval retained for historical billing."
   "north/legacy_schema_projection" "A deprecated @pred:* catalog projection; never executable schema authority."
   "north/legacy_session" "A historical session whose actor was not recorded."
   "north/linear_bootstrap_reservation" "A deterministic Linear bootstrap reservation."
   "north/test_fixture" "A historical test or scratch entity retained outside domain authority."))

(def ENTITY-KINDS
  (into (sorted-map) (concat CORE-ENTITY-KINDS LEGACY-ENTITY-KINDS ORCHESTRATION-ENTITY-KINDS)))

(def ENTITY-KIND-DEFINITION "north/entity_kind_definition")

(def LEGACY-KIND->ENTITY-KIND
  {"agent" "agent" "lane" "agent" "managed" "agent" "session" "agent"
   "client_rate_config" "client_rate_config"
   "client_session" "client_session"
   "concern" "concern"
   "guard_denial" "guard_denial"
   "message" "message" "msg" "message" "command" "message"
   "mine" "north/mine" "snapshot" "north/snapshot"
   "person" "person"
   "predicate" "predicate"
   "run" "run"
   "thread" "thread"
   "topic" "topic"
   "clock_audit_run" "north/clock_audit_run"
   "integration_link" "north/integration_link"
   "linear_bootstrap_reservation" "north/linear_bootstrap_reservation"})

(def BUILTIN-SCHEMA
  {"acyclic" {:card "single" :kind "literal"
              :doc "Whether this reference predicate must remain cycle-free (true enables the rule)."}
   "cardinality" {:card "single" :kind "literal"
                  :doc "Executable Fram cardinality: single or multi."}
   "doc" {:card "single" :kind "literal"
          :doc "Human-readable documentation attached to a schema entity."}
   "entity_kind" {:card "single" :kind "literal"
                  :doc "Open structural entity taxonomy; core values are defined by @entity-kind:* and extensions use namespace/name."}
   "entity_kind_name" {:card "single" :kind "literal"
                       :doc "Canonical value represented by an @entity-kind:* definition entity."}
   "value_kind" {:card "single" :kind "literal"
                 :doc "Executable Fram object kind: literal or ref."}})

;; These predicates predate the connected registry but their semantics are not
;; inferable from object spelling. `notify` is prose even when it begins with an
;; @handle. `blocks` remains a reference edge; prose-valued legacy rows require
;; an exact manifest repair into a distinct literal reason/note predicate.
(def CURATED-CUTOVER-SCHEMA
  {"notify" {:card "multi" :kind "literal"
             :doc "Durable human-readable completion, stall, or coordination notification."}
   "blocks" {:card "multi" :kind "ref"
             :doc "Reference edge from a blocker to the entity it blocks; explanatory prose belongs in a reason/note predicate."}
   "depends_on" {:card "multi" :kind "ref" :acyclic "true"
                 :doc "Dependency edge from an entity to a prerequisite that must precede it."}
   "part_of" {:card "single" :kind "ref" :acyclic "true"
              :doc "Containment edge from a child entity to its single parent."}})

(def LEGACY-SESSION-SIGNATURES
  #{#{"clocked_by" "end_time" "session_of" "start_time"}
    #{"end_time" "session_of" "start_time"}
    #{"clock_orphaned" "clocked_by" "end_time" "session_of" "start_time"}
    #{"clocked_by" "session_of" "start_time"}})

(def TEST-FIXTURE-SIGNATURES
  #{#{"agg_done_batch" "agg_done_worker"}
    #{"agg_run_batch" "agg_run_tokens"}
    #{"agg_charge_tokens" "agg_charged_to"}
    #{"end_time" "start_time"}})

(def LEGACY-SCHEMA-PROJECTION-SIGNATURE
  #{"doc" "minted_at" "minted_by" "pred_cardinality" "pred_value_kind"})

(defn script-dir [] (.getParent (io/file SCHEMA-MIGRATE-SOURCE)))
(defn pred-cli-path [] (str (script-dir) "/pred-cli.clj"))

(defn read-forms [path]
  (with-open [rdr (java.io.PushbackReader. (io/reader path))]
    (let [eof (Object.)]
      (loop [acc []]
        (let [form (read {:eof eof :read-cond :allow} rdr)]
          (if (= eof form) acc (recur (conj acc form))))))))

(defn literal-def [path sym]
  (some (fn [form]
          (when (and (seq? form) (= 'def (first form)) (= sym (second form)))
            (nth form 2 nil)))
        (read-forms path)))

;; The code table is bootstrap material and offline-lint inventory, not a live
;; schema read path.  Valid graph facts always win over it.
(defn bootstrap-schema []
  (let [rows (or (literal-def (pred-cli-path) 'VOCAB) [])]
    (merge
     (into {} (keep (fn [row]
                      (when (and (vector? row) (>= (count row) 4))
                        [(nth row 0) {:card (nth row 1)
                                      :kind (nth row 2)
                                      :doc (nth row 3)}]))
                    rows))
     CURATED-CUTOVER-SCHEMA
     BUILTIN-SCHEMA)))

(defn file-sha256 [path]
  (let [md (java.security.MessageDigest/getInstance "SHA-256")]
    (with-open [in (io/input-stream path)]
      (let [buf (byte-array 65536)]
        (loop []
          (let [n (.read in buf)]
            (when (pos? n)
              (.update md buf 0 n)
              (recur))))))
    (format "%064x" (java.math.BigInteger. 1 (.digest md)))))

(defn text-sha256 [s]
  (let [md (java.security.MessageDigest/getInstance "SHA-256")]
    (.update md (.getBytes (str s) java.nio.charset.StandardCharsets/UTF_8))
    (format "%064x" (java.math.BigInteger. 1 (.digest md)))))

(defn bytes-sha256 [bytes]
  (let [md (java.security.MessageDigest/getInstance "SHA-256")]
    (.update md ^bytes bytes)
    (format "%064x" (java.math.BigInteger. 1 (.digest md)))))

(defn corpus-file-stat [path]
  (let [file (io/file path)
        nio (.toPath file)
        attrs (java.nio.file.Files/readAttributes
               nio
               java.nio.file.attribute.BasicFileAttributes
               (make-array java.nio.file.LinkOption 0))
        unix (java.nio.file.Files/readAttributes
              nio "unix:dev,ino" (make-array java.nio.file.LinkOption 0))
        dev (get unix "dev")
        ino (get unix "ino")]
    (when-not (and (integer? dev) (integer? ino))
      (throw (ex-info "filesystem did not expose a stable corpus file identity"
                      {:type :corpus-file-identity-unavailable
                       :path (.getCanonicalPath file)})))
    {:file_key (str dev ":" ino)
     :bytes (.size attrs)
     :modified_millis (.toMillis (.lastModifiedTime attrs))}))

(defn corpus-file-record [path]
  (let [canonical (.getCanonicalPath (io/file path))
        before (corpus-file-stat canonical)
        sha256 (file-sha256 canonical)
        after (corpus-file-stat canonical)]
    (when-not (= before after)
      (throw (ex-info "corpus file changed while its content seal was being computed"
                      {:type :corpus-seal-raced :path canonical
                       :before before :after after})))
    {:path canonical
     :file_key (:file_key after)
     :bytes (:bytes after)
     :sha256 sha256}))

(defn configured-path? [path]
  (and (string? path) (not (str/blank? path))))

(defn canonical-readable-file! [role path]
  (when-not (configured-path? path)
    (throw (ex-info (str role " corpus log path is required")
                    {:type :missing-corpus-path :role role :path path})))
  (let [file (io/file path)]
    (when-not (and (.isFile file) (.canRead file))
      (throw (ex-info (str role " corpus log is missing or unreadable: " path)
                      {:type :unreadable-corpus-path :role role :path path})))
    (.getCanonicalPath file)))

(defn distinct-corpus-paths! [paths]
  (when-not (= (count paths) (count (set paths)))
    (throw (ex-info "coordination and telemetry corpus logs resolve to the same canonical path"
                    {:type :duplicate-corpus-path :paths paths})))
  paths)

(defn resolve-corpus-paths! [coordination telemetry]
  (distinct-corpus-paths!
   [(canonical-readable-file! "coordination" coordination)
    (canonical-readable-file! "telemetry" telemetry)]))

(defn op-tx [op]
  (let [tx (:tx op)] (if (integer? tx) tx 0)))

(defn effective-single?
  "Cutover planning deliberately models the selected no-env runtime: explicit
  graph cardinality wins, then Fram's transitional kernel fallback. The caller's
  FRAM_SINGLE_VALUED never changes a plan hash or hides a production conflict."
  [card-map predicate]
  (if (contains? card-map predicate)
    (true? (get card-map predicate))
    (contains? LEGACY-KERNEL-SINGLE predicate)))

(defn fold-for-cutover [ops]
  (let [valid (filterv #(and (some? (:l %)) (some? (:p %)) (some? (:r %))) ops)
        cards (fold/card-map valid)
        keyed
        (reduce (fn [latest op]
                  (let [key (if (effective-single? cards (:p op))
                              [(:l op) (:p op)]
                              [(:l op) (:p op) (:r op)])
                        prior (get latest key)]
                    (if (and prior (> (op-tx prior) (op-tx op)))
                      latest
                      (assoc latest key op))))
                {} valid)
        facts (->> (vals keyed)
                   (filter #(= "assert" (:op %)))
                   (mapv #(select-keys % [:l :p :r])))]
    {:facts facts :version (fold/max-tx ops) :card_map cards}))

(defn read-corpus [paths]
  (when (empty? paths)
    (throw (ex-info "coordination corpus log path is required"
                    {:type :missing-corpus-path :role "coordination"})))
  (let [paths (->> paths
                   (mapv #(canonical-readable-file! "configured" %))
                   distinct-corpus-paths!)
        before-files (mapv corpus-file-record paths)
        ops (vec (mapcat rt/read-log paths))
        files (mapv corpus-file-record paths)
        _ (when-not (= before-files files)
            (throw (ex-info "corpus changed while the sealed fold was being read"
                            {:type :corpus-read-raced
                             :before before-files :after files})))
        folded (fold-for-cutover ops)]
    {:paths paths
     :ops ops
     :facts (:facts folded)
     :version (:version folded)
     :card_map (:card_map folded)
     :files files}))

(defn source-seal [corpus]
  {:fold_version (:version corpus)
   :corpus (mapv (fn [role file]
                   {:role role :bytes (:bytes file) :sha256 (:sha256 file)})
                 ["coordination" "telemetry"] (:files corpus))})

(defn nonblank-string? [value]
  (and (string? value) (not (str/blank? value))))

(defn reviewed-string? [value]
  (and (nonblank-string? value)
       (not (re-find #"[A-Z][A-Z0-9_]*_REQUIRED" value))))

(defn manifest-predicate-semantics [manifest]
  (or (:predicate_semantics manifest) {}))

(defn manifest-other-entries [manifest]
  (or (get-in manifest [:other_allowlist :entries]) {}))

(defn normalize-manifest-schema-row [row]
  {:card (:cardinality row)
   :kind (:value_kind row)
   :doc (:doc row)
   :acyclic (:acyclic row)})

(declare registrable-predicate?)

(defn validate-manifest-structure! [manifest]
  (when-not (= REPAIR-MANIFEST-FORMAT (:format manifest))
    (throw (ex-info "unsupported or missing schema repair manifest format"
                    {:type :invalid-repair-manifest-format
                     :expected REPAIR-MANIFEST-FORMAT :actual (:format manifest)})))
  (when-not (and (map? (:source manifest))
                 (integer? (get-in manifest [:source :fold_version]))
                 (= ["coordination" "telemetry"]
                    (mapv :role (get-in manifest [:source :corpus]))))
    (throw (ex-info "repair manifest source seal is malformed"
                    {:type :invalid-repair-manifest-source})))
  (when-not (every? reviewed-string?
                    [(get-in manifest [:review :by])
                     (get-in manifest [:review :at])
                     (get-in manifest [:review :basis])])
    (throw (ex-info "repair manifest requires nonblank review by/at/basis"
                    {:type :unreviewed-repair-manifest})))
  (doseq [[predicate row] (manifest-predicate-semantics manifest)]
    (when-not (and (registrable-predicate? predicate)
                   (map? row)
                   (contains? #{"single" "multi"} (:cardinality row))
                   (contains? #{"literal" "ref"} (:value_kind row))
                   (reviewed-string? (:doc row))
                   (or (nil? (:acyclic row))
                       (contains? #{"true" "false"} (:acyclic row)))
                   (reviewed-string? (:rationale row)))
      (throw (ex-info (str "invalid reviewed predicate semantics for " (pr-str predicate))
                      {:type :invalid-predicate-semantics
                       :predicate predicate :row row}))))
  (when-let [allowlist (:other_allowlist manifest)]
    (when-not (and (reviewed-string? (:name allowlist))
                   (map? (:entries allowlist)))
      (throw (ex-info "other allowlist requires a name and subject entry map"
                      {:type :invalid-other-allowlist})))
    (doseq [[subject row] (:entries allowlist)]
      (when-not (and (nonblank-string? subject)
                     (map? row)
                     (nonblank-string? (:entity_kind row))
                     (re-matches VALID-ENTITY-KIND (:entity_kind row))
                     (reviewed-string? (:rationale row)))
        (throw (ex-info (str "invalid reviewed other classification for " (pr-str subject))
                        {:type :invalid-other-classification
                         :subject subject :row row})))))
  (doseq [repair (:cardinality_repairs manifest)]
    (when-not (and (map? repair)
                   (nonblank-string? (:subject repair))
                   (registrable-predicate? (:predicate repair))
                   (vector? (:retract repair))
                   (reviewed-string? (:policy repair))
                   (reviewed-string? (:rationale repair)))
      (throw (ex-info "cardinality repair entries require exact identity, retract vector, policy, and rationale"
                      {:type :invalid-cardinality-repair :repair repair}))))
  (doseq [repair (:fact_repairs manifest)]
    (when-not (and (map? repair)
                   (contains? #{"assert" "retract"} (:action repair))
                   (nonblank-string? (:subject repair))
                   (nonblank-string? (:predicate repair))
                   (string? (:value repair))
                   (reviewed-string? (:policy repair))
                   (reviewed-string? (:rationale repair)))
      (throw (ex-info "fact repair entries require an exact append action, triple, policy, and rationale"
                      {:type :invalid-fact-repair :repair repair}))))
  manifest)

(defn read-repair-manifest! [path corpus]
  (when-not (configured-path? path)
    (throw (ex-info "offline candidate construction requires --manifest PATH"
                    {:type :missing-repair-manifest})))
  (let [canonical (canonical-readable-file! "repair manifest" path)
        manifest (-> canonical slurp edn/read-string validate-manifest-structure!)]
    (when-not (= (source-seal corpus) (:source manifest))
      (throw (ex-info "repair manifest source seal does not match the exact input corpus"
                      {:type :repair-manifest-source-mismatch
                       :expected (source-seal corpus) :actual (:source manifest)})))
    (assoc manifest :_path canonical :_sha256 (file-sha256 canonical))))

(defn append-boundary-ready? [path]
  (let [file (io/file path)
        length (.length file)]
    (or (zero? length)
        (with-open [raf (java.io.RandomAccessFile. file "r")]
          (.seek raf (dec length))
          (= 10 (.read raf))))))

(defn require-append-boundaries! [paths]
  (doseq [path paths]
    (when-not (append-boundary-ready? path)
      (throw (ex-info
              (str "corpus log is not newline-terminated; coordinator append would merge two EDN records: " path)
              {:type :unsafe-corpus-append-boundary
               :path path}))))
  paths)

(defn with-corpus-authority [paths f]
  (let [channels (atom [])
        locks (atom [])]
    (try
      (doseq [path paths]
        (let [channel (java.nio.channels.FileChannel/open
                       (.toPath (io/file path))
                       (into-array java.nio.file.OpenOption
                                   [java.nio.file.StandardOpenOption/READ
                                    java.nio.file.StandardOpenOption/WRITE]))]
          (swap! channels conj channel)
          (swap! locks conj (.lock channel))))
      (f {:mode "advisory-file-locks"
          :scope "cooperating-processes-only"
          :paths (mapv #(.getCanonicalPath (io/file %)) paths)})
      (finally
        (doseq [lock (reverse @locks)]
          (try (.release lock) (catch Exception _ nil)))
        (doseq [channel (reverse @channels)]
          (try (.close channel) (catch Exception _ nil)))))))

(defn revalidate-sealed-corpus! [corpus]
  (let [expected (:files corpus)
        actual (mapv corpus-file-record (:paths corpus))
        identity-fields [:path :file_key :bytes :sha256]]
    (when-not (= (mapv #(select-keys % identity-fields) expected)
                 (mapv #(select-keys % identity-fields) actual))
      (throw (ex-info "sealed candidate source changed after planning; zero candidate writes attempted"
                      {:type :sealed-source-drift
                       :expected (mapv #(select-keys % identity-fields) expected)
                       :actual (mapv #(select-keys % identity-fields) actual)})))
    (require-append-boundaries! (:paths corpus))
    actual))

(defn registrable-predicate? [p]
  (and (string? p) (boolean (re-matches VALID-PREDICATE p))))

(defn facts-by-lp [facts]
  (reduce (fn [m fact]
            (update m [(:l fact) (:p fact)] (fnil conj #{}) (:r fact)))
          {} facts))

(defn values-at [by-lp subject predicate]
  (get by-lp [subject predicate] #{}))

(defn valid-singleton [values allowed]
  (when (and (= 1 (count values)) (contains? allowed (first values)))
    (first values)))

(defn live-predicate-values [facts]
  (reduce (fn [m fact]
            (if (registrable-predicate? (:p fact))
              (update m (:p fact) (fnil conj #{}) (:r fact))
              m))
          (sorted-map) facts))

(defn declared-predicate-names [facts]
  (->> facts
       (filter #(contains? META-PREDICATES (:p %)))
       (keep (fn [fact]
               (let [subject (:l fact)]
                 (when (and (string? subject) (str/starts-with? subject "@"))
                   (let [predicate (subs subject 1)]
                     (when (registrable-predicate? predicate) predicate))))))
       set))

(defn corrupt-facts [facts]
  (->> facts
       (remove #(registrable-predicate? (:p %)))
       (sort-by (juxt :l :p :r))
       vec))

(defn collisions [facts predicates]
  (let [by-lp (facts-by-lp facts)]
    (->> predicates
         (filter #(seq (values-at by-lp (str "@" %) "title")))
         sort vec)))

(defn preferred-doc [current policy]
  (or (when (= 1 (count current))
        (let [v (first current)] (when-not (str/blank? (str v)) (str v))))
      (let [v (:doc policy)]
        (when-not (str/blank? (str v)) (str v)))))

(defn desired-schema
  ([facts] (desired-schema facts nil))
  ([facts manifest]
   (let [by-lp (facts-by-lp facts)
         observed (live-predicate-values facts)
         bootstrap (bootstrap-schema)
         reviewed (into {} (map (fn [[predicate row]]
                                  [predicate (normalize-manifest-schema-row row)]))
                        (manifest-predicate-semantics manifest))
         predicates (sort (set/union (set (keys observed))
                                     (declared-predicate-names facts)
                                     (set (keys bootstrap))
                                     (set (keys reviewed))
                                     META-PREDICATES
                                     (set (keys BUILTIN-SCHEMA))))]
     (into (sorted-map)
           (map (fn [predicate]
                  (let [entity (str "@" predicate)
                        card-values (values-at by-lp entity "cardinality")
                        kind-values (values-at by-lp entity "value_kind")
                        doc-values (values-at by-lp entity "doc")
                        acyclic-values (values-at by-lp entity "acyclic")
                        existing-card (valid-singleton card-values #{"single" "multi"})
                        existing-kind (valid-singleton kind-values #{"literal" "ref"})
                        existing-acyclic (valid-singleton acyclic-values #{"true" "false"})
                        policy (merge (get bootstrap predicate) (get reviewed predicate))
                        cardinality (or existing-card
                                        (:card policy)
                                        (when (contains? LEGACY-KERNEL-SINGLE predicate) "single"))
                        value-kind (or existing-kind (:kind policy))
                        doc (preferred-doc doc-values policy)
                        unresolved (cond-> []
                                     (nil? cardinality) (conj "cardinality")
                                     (nil? value-kind) (conj "value_kind")
                                     (nil? doc) (conj "doc"))]
                    [predicate
                     {:cardinality cardinality
                      :value_kind value-kind
                      :doc doc
                      :unresolved_fields unresolved
                      :policy_source (cond
                                       (or existing-card existing-kind (seq doc-values)) "graph"
                                       (contains? reviewed predicate) "reviewed-manifest"
                                       (contains? bootstrap predicate) "curated-bootstrap"
                                       :else "unresolved")
                      ;; A valid explicit false is policy, not absence. Bootstrap
                      ;; only when no declaration exists at all; malformed or
                      ;; multiple values remain untouched for strict audit.
                      :acyclic (cond
                                 existing-acyclic existing-acyclic
                                 (empty? acyclic-values)
                                 (or (:acyclic policy)
                                     (when (contains? ACYCLIC-PREDICATES predicate) "true"))
                                 :else nil)}]))
                predicates)))))

(defn set-action [by-lp subject predicate value]
  (let [current (values-at by-lp subject predicate)]
    (when (and (some? value) (not= current #{value}))
      {:action "set" :subject subject :predicate predicate
       :value value :before (vec (sort current))})))

(defn schema-actions [facts schema]
  (let [by-lp (facts-by-lp facts)]
    (->> schema
         (mapcat (fn [[predicate row]]
                   (let [subject (str "@" predicate)]
                     (remove nil?
                             [(set-action by-lp subject "cardinality" (:cardinality row))
                              (set-action by-lp subject "value_kind" (:value_kind row))
                              (set-action by-lp subject "doc" (:doc row))
                              (set-action by-lp subject "entity_kind" "predicate")
                              (when-let [acyclic (:acyclic row)]
                                (set-action by-lp subject "acyclic" acyclic))]))))
         (sort-by (juxt :subject :predicate))
         vec)))

(defn entity-kind-definition-actions [facts]
  (let [by-lp (facts-by-lp facts)]
    (->> ENTITY-KINDS
         (mapcat (fn [[kind doc]]
                   (let [subject (str "@entity-kind:" kind)]
                     (remove nil?
                             [(set-action by-lp subject "entity_kind" ENTITY-KIND-DEFINITION)
                              (set-action by-lp subject "entity_kind_name" kind)
                              (set-action by-lp subject "doc" doc)]))))
         (sort-by (juxt :subject :predicate))
         vec)))

(defn subject-bare [subject]
  (let [s (str subject)] (if (str/starts-with? s "@") (subs s 1) s)))

(defn one-valid-entity-kind [values]
  (when (and (= 1 (count values))
             (string? (first values))
             (re-matches VALID-ENTITY-KIND (first values)))
    (first values)))

(defn deterministic-legacy-kind [by-lp subject predicates]
  (let [clocked-by (values-at by-lp subject "clocked_by")
        bare (subject-bare subject)]
    (cond
      (contains? LEGACY-SESSION-SIGNATURES predicates)
      (cond
        (empty? clocked-by) "north/legacy_session"
        (= #{"user"} clocked-by) "north/legacy_human_session"
        (contains? clocked-by "user") nil
        :else "north/legacy_agent_session")

      (and (or (str/starts-with? bare "aggtest:")
               (str/starts-with? bare "aggtest-"))
           (contains? TEST-FIXTURE-SIGNATURES predicates))
      "north/test_fixture"

      (and (or (str/starts-with? bare "scratch-sess-")
               (str/starts-with? bare "scratch2-sess-"))
           (contains? TEST-FIXTURE-SIGNATURES predicates))
      "north/test_fixture"

      (and (str/starts-with? (str subject) "@pred:")
           (= LEGACY-SCHEMA-PROJECTION-SIGNATURE predicates))
      "north/legacy_schema_projection"

      :else nil)))

(defn infer-entity-kind [by-lp predicate-names subject predicates other-entries]
  ;; Explicit valid values are open and authoritative, including namespace/name
  ;; extensions. Otherwise infer only when one structural signal is unambiguous.
  (let [explicit-values (values-at by-lp subject "entity_kind")
        explicit (one-valid-entity-kind explicit-values)
        legacy-values (values-at by-lp subject "kind")
        legacy (when (= 1 (count legacy-values))
                 (get LEGACY-KIND->ENTITY-KIND (first legacy-values)))
        bare (subject-bare subject)
        predicate? (and (str/starts-with? (str subject) "@")
                        (contains? predicate-names bare))
        prefixed (cond
                   (str/starts-with? bare "topic-") "topic"
                   (str/starts-with? bare "concern-") "concern"
                   (or (str/starts-with? bare "msg:")
                       (str/starts-with? bare "cmd:")) "message"
                   (str/starts-with? bare "agent:") "agent"
                   (or (str/starts-with? bare "run-")
                       (str/starts-with? bare "run:")) "run"
                   (or (str/starts-with? bare "session:")
                       (str/starts-with? bare "sess-")
                       (str/starts-with? bare "cc-")) "agent"
                   (str/starts-with? bare "denial:") "guard_denial"
                   (str/starts-with? bare "mine:") "north/mine"
                   (str/starts-with? bare "snapshot:") "north/snapshot"
                   (str/starts-with? bare "arena-") "north/arena_run"
                   :else nil)
        shaped (cond
                 (seq (values-at by-lp subject "title")) "thread"
                 (seq (values-at by-lp subject "display_name")) "person"
                 :else nil)
        deterministic (deterministic-legacy-kind by-lp subject predicates)
        reviewed-other (get-in other-entries [subject :entity_kind])]
    (cond
      ;; Predicate identity is the executable schema boundary. A stale or
      ;; extension-valued entity_kind on @p cannot turn the schema entity into a
      ;; domain entity; the migration normalizes it to predicate.
      predicate? {:kind "predicate" :source "schema-entity" :values explicit-values}
      explicit {:kind explicit :source "explicit" :values explicit-values}
      legacy {:kind legacy :source "legacy-kind" :values explicit-values}
      deterministic {:kind deterministic :source "deterministic-legacy-signature" :values explicit-values}
      prefixed {:kind prefixed :source "namespace" :values explicit-values}
      shaped {:kind shaped :source "shape" :values explicit-values}
      reviewed-other {:kind reviewed-other :source "named-reviewed-other-allowlist" :values explicit-values}
      :else {:kind "other" :source "ambiguous" :values explicit-values})))

(defn entity-classifications
  ([facts schema] (entity-classifications facts schema nil))
  ([facts schema manifest]
  (let [by-lp (facts-by-lp facts)
        predicate-names (set (keys schema))
        subject-predicates (reduce (fn [m fact]
                                     (update m (:l fact) (fnil conj #{}) (:p fact)))
                                   {} facts)
        subjects (sort-by str (keys subject-predicates))
        other-entries (manifest-other-entries manifest)]
    (into (sorted-map)
          (map (fn [subject]
                 [subject (infer-entity-kind by-lp predicate-names subject
                                             (get subject-predicates subject #{})
                                             other-entries)]))
          subjects))))

(defn entity-assignment-actions
  ([facts schema] (entity-assignment-actions facts schema nil))
  ([facts schema manifest]
  (let [by-lp (facts-by-lp facts)]
    (->> (entity-classifications facts schema manifest)
         (keep (fn [[subject classification]]
                 (when-not (= "other" (:kind classification))
                   (set-action by-lp subject "entity_kind" (:kind classification)))))
         (sort-by :subject)
         vec))))

(defn dedupe-actions [actions]
  (->> actions
       (reduce (fn [m action]
                 (assoc m [(:subject action) (:predicate action)] action)) {})
       vals
       (sort-by (juxt :subject :predicate))
       vec))

(defn unresolved-predicate-semantics [schema]
  (->> schema
       (keep (fn [[predicate row]]
               (when (seq (:unresolved_fields row))
                 {:predicate predicate :fields (:unresolved_fields row)})))
       vec))

(defn cardinality-conflicts [corpus schema]
  (let [facts-by-predicate (group-by :p (:facts corpus))
        cards (:card_map corpus)]
    (->> schema
         (mapcat (fn [[predicate row]]
                   (when (and (= "single" (:cardinality row))
                              (not (effective-single? cards predicate)))
                     (->> (get facts-by-predicate predicate [])
                          (group-by :l)
                          (keep (fn [[subject facts]]
                                  (let [values (vec (sort (set (map :r facts))))]
                                    (when (> (count values) 1)
                                      {:subject subject :predicate predicate
                                       :values values}))))))))
         (sort-by (juxt :predicate :subject))
         vec)))

(defn reference-shaped? [value]
  (and (string? value)
       (boolean (re-matches #"^@[^@\s][^\s]*$" value))))

(defn reference-shape-defects [facts schema]
  (->> facts
       (keep (fn [fact]
               (when (and (= "ref" (get-in schema [(:p fact) :value_kind]))
                          (not (reference-shaped? (:r fact))))
                 (select-keys fact [:l :p :r]))))
       (sort-by (juxt :p :l :r))
       vec))

(defn dangling-reference-defects [facts schema]
  (let [entities (set (map :l facts))]
    (->> facts
         (keep (fn [fact]
                 (when (and (= "ref" (get-in schema [(:p fact) :value_kind]))
                            (reference-shaped? (:r fact))
                            (not (contains? entities (:r fact))))
                   (select-keys fact [:l :p :r]))))
         (sort-by (juxt :p :l :r))
         vec)))

(defn acyclic-cycle-defects [facts schema]
  (let [index (kernel/build-index facts)
        predicates (->> schema
                        (keep (fn [[predicate row]]
                                (when (= "true" (:acyclic row)) predicate)))
                        set)]
    (->> facts
         (keep (fn [fact]
                 (when (and (contains? predicates (:p fact))
                            (kernel/cycle-i? index (:p fact) (:l fact)))
                   {:l (:l fact) :p (:p fact)})))
         distinct
         (sort-by (juxt :p :l))
         vec)))

(defn repair-identity [repair]
  [(:subject repair) (:predicate repair)])

(defn manifest-cardinality-defects [conflicts manifest]
  (let [repairs (vec (:cardinality_repairs manifest))
        grouped (group-by repair-identity repairs)
        expected (set (map (juxt :subject :predicate) conflicts))
        duplicate-keys (->> grouped (keep (fn [[key rows]] (when (> (count rows) 1) key))) set)
        actual (set (keys grouped))]
    (vec
     (concat
      (map (fn [key] {:type "duplicate-cardinality-repair" :identity key})
           (sort duplicate-keys))
      (map (fn [key] {:type "unexpected-cardinality-repair" :identity key})
           (sort (set/difference actual expected)))
      (mapcat
       (fn [{:keys [subject predicate values]}]
         (let [key [subject predicate]
               repair (first (get grouped key))
               value-set (set values)
               retain-present? (and repair (contains? repair :retain))
               retain (:retain repair)
               retain-set (if (some? retain) #{retain} #{})
               retract-set (set (:retract repair))]
           (cond
             (nil? repair)
             [{:type "missing-cardinality-repair" :identity key :values values}]

             (not retain-present?)
             [{:type "cardinality-repair-missing-retain-decision" :identity key}]

             (not (set/subset? retain-set value-set))
             [{:type "cardinality-repair-retains-unknown-value" :identity key
               :retain retain :values values}]

             (not= retract-set (set/difference value-set retain-set))
             [{:type "cardinality-repair-not-exact" :identity key
               :expected_retract (vec (sort (set/difference value-set retain-set)))
               :actual_retract (vec (sort retract-set))}]

             (not= (count retract-set) (count (:retract repair)))
             [{:type "cardinality-repair-duplicates-retraction" :identity key}]

             :else [])))
       conflicts)))))

(defn manifest-fact-repair-defects [facts manifest]
  (let [live (set (map (juxt :l :p :r) facts))
        repairs (vec (:fact_repairs manifest))
        identities (mapv (juxt :action :subject :predicate :value) repairs)]
    (vec
     (concat
      (when-not (= (count identities) (count (set identities)))
        [{:type "duplicate-fact-repair"}])
      (keep (fn [repair]
              (let [triple [(:subject repair) (:predicate repair) (:value repair)]
                    present? (contains? live triple)]
                (cond
                  (and (= "retract" (:action repair)) (not present?))
                  {:type "fact-repair-retracts-nonlive-triple" :triple triple}

                  (and (= "assert" (:action repair)) present?)
                  {:type "fact-repair-asserts-live-triple" :triple triple}

                  :else nil)))
            repairs)))))

(defn manifest-predicate-conflicts [facts manifest]
  (let [by-lp (facts-by-lp facts)]
    (->> (manifest-predicate-semantics manifest)
         (mapcat
          (fn [[predicate reviewed]]
            (let [subject (str "@" predicate)
                  checks [["cardinality" (:cardinality reviewed) #{"single" "multi"}]
                          ["value_kind" (:value_kind reviewed) #{"literal" "ref"}]
                          ["doc" (:doc reviewed) nil]
                          ["acyclic" (:acyclic reviewed) #{"true" "false"}]]]
              (keep (fn [[field wanted allowed]]
                      (when (some? wanted)
                        (let [actual (values-at by-lp subject field)
                              valid (if allowed (valid-singleton actual allowed)
                                        (when (= 1 (count actual)) (first actual)))]
                          (when (and valid (not= wanted valid))
                            {:type "reviewed-semantics-conflict-with-graph"
                             :predicate predicate :field field
                             :graph valid :reviewed wanted}))))
                    checks))))
         vec)))

(defn plan-for
  ([corpus] (plan-for corpus nil))
  ([corpus manifest]
  (let [facts (:facts corpus)
        schema (desired-schema facts manifest)
        corrupt (corrupt-facts facts)
        colliding (collisions facts (keys schema))
        base-classifications (entity-classifications facts schema)
        base-ambiguous (->> base-classifications
                            (keep (fn [[subject classification]]
                                    (when (= "other" (:kind classification)) subject)))
                            set)
        allowlist-subjects (set (keys (manifest-other-entries manifest)))
        allowlist-defects (->> (set/difference allowlist-subjects base-ambiguous)
                               sort
                               (mapv (fn [subject]
                                       {:type "other-allowlist-subject-is-not-unresolved"
                                        :subject subject})))
        classifications (entity-classifications facts schema manifest)
        ambiguous (->> classifications
                       (keep (fn [[subject classification]]
                               (when (= "other" (:kind classification)) subject)))
                       vec)
        unresolved-semantics (unresolved-predicate-semantics schema)
        conflicts (cardinality-conflicts corpus schema)
        ref-defects (reference-shape-defects facts schema)
        dangling-refs (dangling-reference-defects facts schema)
        cycles (acyclic-cycle-defects facts schema)
        manifest-defects (vec (concat allowlist-defects
                                      (manifest-cardinality-defects conflicts manifest)
                                      (manifest-fact-repair-defects facts manifest)
                                      (manifest-predicate-conflicts facts manifest)))
        actions (dedupe-actions
                 (concat (schema-actions facts schema)
                         (entity-kind-definition-actions facts)
                         (entity-assignment-actions facts schema manifest)))
        receipt {:format PLAN-FORMAT
                 :corpus (:files corpus)
                 :source_seal (source-seal corpus)
                 :fold_version (:version corpus)
                 :predicate_count (count schema)
                 :entity_kinds (vec (keys ENTITY-KINDS))
                 :manifest_sha256 (:_sha256 manifest)
                 :manifest_review (:review manifest)
                 :unresolved_predicate_semantics unresolved-semantics
                 :cardinality_conflicts conflicts
                 :reference_shape_defects ref-defects
                 :dangling_reference_defects dangling-refs
                 :acyclic_cycle_defects cycles
                 :manifest_defects manifest-defects
                 :ambiguous_subjects ambiguous
                 :collisions colliding
                 :corrupt (mapv #(select-keys % [:l :p :r]) corrupt)
                 :actions actions}]
    {:schema schema :corrupt corrupt :collisions colliding :actions actions
     :ambiguous ambiguous :classifications classifications
     :unresolved-semantics unresolved-semantics
     :cardinality-conflicts conflicts :reference-shape-defects ref-defects
     :dangling-reference-defects dangling-refs
     :acyclic-cycle-defects cycles
     :manifest-defects manifest-defects
     :receipt receipt :sha256 (text-sha256 (pr-str receipt))})))

(defn malformed-schema [facts schema]
  (let [by-lp (facts-by-lp facts)]
    (->> schema
         (mapcat (fn [[predicate row]]
                   (let [subject (str "@" predicate)
                         card (values-at by-lp subject "cardinality")
                         kind (values-at by-lp subject "value_kind")
                         acyclic (values-at by-lp subject "acyclic")
                         docs (values-at by-lp subject "doc")
                         ek (values-at by-lp subject "entity_kind")]
                     (remove nil?
                             [(when-not (and (= 1 (count card))
                                             (contains? #{"single" "multi"} (first card)))
                                {:predicate predicate :field "cardinality" :values (vec (sort card))})
                              (when-not (and (= 1 (count kind))
                                             (contains? #{"literal" "ref"} (first kind)))
                                {:predicate predicate :field "value_kind" :values (vec (sort kind))})
                              (when (or (seq acyclic) (some? (:acyclic row)))
                                (when-not (and (= 1 (count acyclic))
                                               (contains? #{"true" "false"} (first acyclic))
                                               (= (:acyclic row) (first acyclic)))
                                  {:predicate predicate :field "acyclic" :values (vec (sort acyclic))}))
                              (when-not (and (= 1 (count docs)) (not (str/blank? (str (first docs)))))
                                {:predicate predicate :field "doc" :values (vec (sort docs))})
                              (when-not (= #{"predicate"} ek)
                                {:predicate predicate :field "entity_kind" :values (vec (sort ek))})]))))
         (sort-by (juxt :predicate :field))
         vec)))

(defn malformed-entity-kind-definitions [facts]
  (let [by-lp (facts-by-lp facts)]
    (->> ENTITY-KINDS
         (keep (fn [[kind doc]]
                 (let [subject (str "@entity-kind:" kind)
                       actual {:entity_kind (values-at by-lp subject "entity_kind")
                               :entity_kind_name (values-at by-lp subject "entity_kind_name")
                               :doc (values-at by-lp subject "doc")}
                       expected {:entity_kind #{ENTITY-KIND-DEFINITION}
                                 :entity_kind_name #{kind}
                                 :doc #{doc}}]
                   (when-not (= expected actual)
                     {:kind kind :actual actual}))))
         vec)))

(defn invalid-entity-kind-values [facts]
  (->> facts
       (filter #(= "entity_kind" (:p %)))
       (group-by :l)
       (keep (fn [[subject subject-facts]]
               (let [values (set (map :r subject-facts))]
                 (when-not (and (= 1 (count values))
                                (string? (first values))
                                (re-matches VALID-ENTITY-KIND (first values)))
                   {:l subject :values (vec (sort-by str values))}))))
       (sort-by (comp str :l))
       vec))

(defn entity-assignment-defects [facts schema]
  (let [by-lp (facts-by-lp facts)]
    (->> (entity-classifications facts schema)
         (keep (fn [[subject classification]]
                 (let [kind (:kind classification)
                       actual (values-at by-lp subject "entity_kind")]
                   (when (and (not= "other" kind) (not= #{kind} actual))
                     {:subject subject :expected kind :actual (vec (sort-by str actual))
                      :source (:source classification)}))))
         vec)))

(defn audit-report [corpus]
  (let [facts (:facts corpus)
        schema (desired-schema facts)
        unresolved-semantics (unresolved-predicate-semantics schema)
        malformed (malformed-schema facts schema)
        kind-defects (malformed-entity-kind-definitions facts)
        assignment-defects (entity-assignment-defects facts schema)
        ambiguous (->> (entity-classifications facts schema)
                       (keep (fn [[subject classification]]
                               (when (= "other" (:kind classification)) subject)))
                       vec)
        corrupt (corrupt-facts facts)
        colliding (collisions facts (keys schema))
        invalid-kinds (invalid-entity-kind-values facts)
        ref-defects (reference-shape-defects facts schema)
        dangling-refs (dangling-reference-defects facts schema)
        cycles (acyclic-cycle-defects facts schema)]
    {:format AUDIT-FORMAT
     :corpus (:files corpus)
     :fold_version (:version corpus)
     :predicate_count (count schema)
     :corrupt (mapv #(select-keys % [:l :p :r]) corrupt)
     :collisions colliding
     :schema_defects malformed
     :unresolved_predicate_semantics unresolved-semantics
     :reference_shape_defects ref-defects
     :dangling_reference_defects dangling-refs
     :acyclic_cycle_defects cycles
     :entity_kind_definition_defects kind-defects
     :entity_assignment_defects assignment-defects
     :ambiguous_subjects ambiguous
     :invalid_entity_kind_values invalid-kinds
     :ok (and (empty? corrupt) (empty? colliding) (empty? malformed)
              (empty? unresolved-semantics) (empty? ref-defects)
              (empty? dangling-refs)
              (empty? cycles)
              (empty? kind-defects) (empty? assignment-defects)
              (empty? invalid-kinds) (empty? ambiguous))}))

(defn cardinality-retraction-actions [manifest]
  (->> (:cardinality_repairs manifest)
       (mapcat (fn [repair]
                 (map (fn [value]
                        {:action "retract" :subject (:subject repair)
                         :predicate (:predicate repair) :value value
                         :policy (:policy repair) :rationale (:rationale repair)
                         :source "reviewed-cardinality-repair"})
                      (:retract repair))))
       (sort-by (juxt :predicate :subject :value))
       vec))

(defn schema-wire-actions [actions]
  (->> actions
       (mapcat (fn [{:keys [subject predicate value before]}]
                 (concat
                  (map (fn [old]
                         {:action "retract" :subject subject :predicate predicate
                          :value old :source "schema-set"})
                       before)
                  [{:action "assert" :subject subject :predicate predicate
                    :value value :source "schema-set"}])))
       vec))

(defn candidate-wire-actions [plan manifest]
  (vec (concat (:fact_repairs manifest)
               (cardinality-retraction-actions manifest)
               (schema-wire-actions (:actions plan)))))

(defn simulate-wire-actions [corpus wire-actions]
  (let [base (long (:version corpus))
        appended (mapv (fn [index action]
                         {:tx (+ base index 1)
                          :op (:action action)
                          :l (:subject action)
                          :p (:predicate action)
                          :r (:value action)
                          :frame "schema-candidate-preflight"})
                       (range) wire-actions)
        ops (into (vec (:ops corpus)) appended)
        folded (fold-for-cutover ops)]
    {:paths (:paths corpus)
     :ops ops
     :facts (:facts folded)
     :version (:version folded)
     :card_map (:card_map folded)
     :files (:files corpus)}))

(defn initial-preflight-defects [plan]
  (vec
   (concat
    (when (seq (:corrupt plan))
      [{:type "corrupt-facts-present" :count (count (:corrupt plan))}])
    (when (seq (:collisions plan))
      [{:type "predicate-thread-collisions" :subjects (:collisions plan)}])
    (map #(assoc % :type "unresolved-predicate-semantics")
         (:unresolved-semantics plan))
    (map (fn [subject] {:type "unresolved-other-subject" :subject subject})
         (:ambiguous plan))
    (:manifest-defects plan))))

(defn candidate-preflight [corpus manifest]
  (let [plan (plan-for corpus manifest)
        initial-defects (initial-preflight-defects plan)
        wire-actions (candidate-wire-actions plan manifest)
        simulated (when (empty? initial-defects)
                    (simulate-wire-actions corpus wire-actions))
        post-plan (when simulated (plan-for simulated))
        post-audit (when simulated (audit-report simulated))
        defects (vec
                 (concat
                  initial-defects
                  (when (and post-plan (seq (:actions post-plan)))
                    [{:type "candidate-does-not-converge"
                      :remaining_action_identities
                      (mapv #(select-keys % [:subject :predicate :value])
                            (:actions post-plan))}])
                  (when (and post-plan (seq (:cardinality-conflicts post-plan)))
                    [{:type "candidate-retains-cardinality-conflicts"
                      :conflicts (:cardinality-conflicts post-plan)}])
                  (when (and post-audit (not (:ok post-audit)))
                    [{:type "candidate-strict-audit-fails"
                      :audit post-audit}])))]
    {:ok (empty? defects)
     :plan plan
     :wire_actions wire-actions
     :simulated_corpus simulated
     :post_plan post-plan
     :post_audit post-audit
     :defects defects}))

(defn apply-wire-action! [port {:keys [action subject predicate value] :as wire-action}]
  (let [result (case action
                 "assert" (north.coord/put! port subject predicate value)
                 "retract" (north.coord/retract! port subject predicate value))]
    (when-not (:ok result)
      (throw (ex-info "offline candidate append action failed"
                      {:type :candidate-action-failed
                       :action (select-keys wire-action [:action :subject :predicate :value])
                       :result result})))
    true))

(defn apply-wire-actions! [port actions]
  (doseq [action actions] (apply-wire-action! port action))
  (count actions))

(defn possible-live-corpus-paths []
  (let [home (System/getProperty "user.home")]
    [(str home "/.local/state/north/coordination.log")
     (str home "/.local/state/north/telemetry.log")
     (str home "/.local/state/north/facts.log")
     (str home "/code/north-data/coordination.log")
     (str home "/code/north-data/telemetry.log")
     (str home "/code/north-data/facts.log")]))

(defn same-existing-file? [a b]
  (let [left (io/file a) right (io/file b)]
    (and (.exists left) (.exists right)
         (try (java.nio.file.Files/isSameFile (.toPath left) (.toPath right))
              (catch Exception _ false)))))

(defn live-corpus-aliases [paths]
  (->> paths
       (mapcat (fn [path]
                 (keep (fn [live]
                         (when (same-existing-file? path live)
                           {:candidate path :live (.getCanonicalPath (io/file live))}))
                       (possible-live-corpus-paths))))
       vec))

(defn assert-offline-candidate! [paths]
  (let [aliases (live-corpus-aliases paths)]
    (when (seq aliases)
      (throw (ex-info "candidate builder refuses canonical/live North corpus aliases before the first write"
                      {:type :live-corpus-candidate-refused :aliases aliases}))))
  (when (nonblank-string? (System/getenv "FRAM_SINGLE_VALUED"))
    (throw (ex-info "candidate builder requires FRAM_SINGLE_VALUED unset so graph declarations are the only post-cutover authority"
                    {:type :candidate-fallback-environment-refused})))
  true)

(defn state-home []
  (or (when (configured-path? (System/getenv "XDG_STATE_HOME"))
        (System/getenv "XDG_STATE_HOME"))
      (str (System/getProperty "user.home") "/.local/state")))

(defn runtime-record-path [port]
  (or (when (configured-path? (System/getenv "NORTH_COORD_RUNTIME_FILE"))
        (System/getenv "NORTH_COORD_RUNTIME_FILE"))
      (str (state-home) "/north/fram-daemon-" port ".runtime")))

(defn attest-selected-fram-runtime! [port log]
  (runtime-attestation/attest-runtime!
   {:port port
    :served-log (.getCanonicalPath (io/file log))
    :record-path (runtime-record-path port)}))

(defn action-identities [actions]
  (mapv #(select-keys % [:subject :predicate :value]) actions))

(defn validate-receipt-verdict! [receipt]
  (when-not (= CANDIDATE-RECEIPT-FORMAT (:format receipt))
    (throw (ex-info "candidate receipt requires the canonical format"
                    {:type :invalid-candidate-receipt-format
                     :expected CANDIDATE-RECEIPT-FORMAT
                     :actual (:format receipt)})))
  (let [expected (case (:converged receipt)
                   true "converged"
                   false "rejected"
                   nil)]
    (when-not (and expected
                   (= expected (:result receipt))
                   (if (:converged receipt)
                     (let [candidate (:finalized_candidate receipt)]
                       (and (map? candidate)
                            (re-matches FINAL-CANDIDATE-ID-PATTERN
                                        (str (:candidate_id candidate)))
                            (re-matches #"[0-9a-f]{64}"
                                        (str (:manifest_sha256 candidate)))))
                     (nil? (:finalized_candidate receipt))))
      (throw (ex-info "candidate receipt requires an explicit result consistent with :converged"
                      {:type :invalid-candidate-receipt-verdict
                       :converged (:converged receipt) :result (:result receipt)
                       :finalized_candidate (:finalized_candidate receipt)})))
    receipt))

(defn receipt-bytes [receipt]
  (snapshot/canonical-edn-bytes (validate-receipt-verdict! receipt)))

(defn receipt-target [dir receipt]
  (let [bytes (receipt-bytes receipt)
        sha (bytes-sha256 bytes)]
    (io/file dir (str "schema-" (:result receipt) "-" sha ".edn"))))

(defn bytes-equal? [path expected]
  (try
    (java.util.Arrays/equals ^bytes expected
                             ^bytes (java.nio.file.Files/readAllBytes (.toPath (io/file path))))
    (catch Exception _ false)))

(defn regular-receipt-target? [path]
  (let [nio (.toPath (io/file path))
        no-follow (into-array java.nio.file.LinkOption
                              [java.nio.file.LinkOption/NOFOLLOW_LINKS])]
    (and (not (java.nio.file.Files/isSymbolicLink nio))
         (java.nio.file.Files/isRegularFile nio no-follow))))

(declare same-receipt-stage-file!)

(defn write-receipt-stage-bytes! [directory stage bytes]
  (let [current (same-receipt-stage-file! directory stage)]
  (with-open [channel (java.nio.channels.FileChannel/open
                       (.toPath (io/file (:path current)))
                       (into-array java.nio.file.OpenOption
                                   [java.nio.file.StandardOpenOption/WRITE
                                    java.nio.file.LinkOption/NOFOLLOW_LINKS]))]
    (.truncate channel 0)
    (.position channel 0)
    (let [buffer (java.nio.ByteBuffer/wrap bytes)]
      (loop []
        (when (.hasRemaining buffer)
          (.write channel buffer)
          (recur))))
    (.force channel true))
  (same-receipt-stage-file! directory current)))

(defn force-directory! [directory]
  (with-open [channel (java.nio.channels.FileChannel/open
                       (.toPath (io/file directory))
                       (into-array java.nio.file.OpenOption
                                   [java.nio.file.StandardOpenOption/READ]))]
    (.force channel true))
  directory)

(def receipt-stage-permissions
  #{#{java.nio.file.attribute.PosixFilePermission/OWNER_READ
      java.nio.file.attribute.PosixFilePermission/OWNER_WRITE}
    #{java.nio.file.attribute.PosixFilePermission/OWNER_READ
      java.nio.file.attribute.PosixFilePermission/GROUP_READ
      java.nio.file.attribute.PosixFilePermission/OTHERS_READ}})

(defn receipt-stage-name-parts [file]
  (when-let [[_ pid ticks nonce]
             (re-matches RECEIPT-STAGE-NAME-PATTERN
                         (.getName (io/file file)))]
    {:pid (parse-long pid)
     :pid-birth (str "proc:" ticks)
     :nonce nonce}))

(defn process-owner-state [{:keys [pid pid-birth]}]
  (try
    (let [optional (java.lang.ProcessHandle/of (long pid))]
      (if-not (.isPresent optional)
        :dead
        (let [handle (.get optional)]
          (if-not (.isAlive handle)
            :dead
            (let [actual (runtime-attestation/process-birth-token pid)]
              (cond
                (nil? actual) :ambiguous
                (= pid-birth actual) :live
                :else :dead))))))
    (catch Throwable _ :ambiguous)))

(defn current-process-owner! []
  (let [pid (.pid (java.lang.ProcessHandle/current))
        birth (runtime-attestation/process-birth-token pid)]
    (when-not (and (pos-int? pid)
                   (string? birth)
                   (re-matches #"proc:[1-9][0-9]*" birth))
      (throw (ex-info "cannot establish receipt-stage process ownership"
                      {:type :candidate-receipt-stage-owner-unavailable
                       :pid pid :pid-birth birth})))
    {:pid pid :pid-birth birth}))

(defn file-owner [path]
  (java.nio.file.Files/getOwner
   (.toPath (io/file path))
   (into-array java.nio.file.LinkOption
               [java.nio.file.LinkOption/NOFOLLOW_LINKS])))

(defn assert-owned-receipt-stage! [directory candidate]
  (let [directory (.getCanonicalPath (io/file directory))
        file (io/file candidate)
        path (.toPath file)
        parts (receipt-stage-name-parts file)
        no-follow (into-array java.nio.file.LinkOption
                              [java.nio.file.LinkOption/NOFOLLOW_LINKS])]
    (when-not (and parts
                   (= directory
                      (.getCanonicalPath (.getParentFile file)))
                   (not (java.nio.file.Files/isSymbolicLink path))
                   (java.nio.file.Files/isRegularFile path no-follow)
                   (= (file-owner directory) (file-owner file))
                   (contains? receipt-stage-permissions
                              (set (java.nio.file.Files/getPosixFilePermissions
                                    path no-follow))))
      (throw (ex-info "matching receipt stage lacks exact schema ownership evidence"
                      {:type :candidate-receipt-stage-ownership-invalid
                       :path (.getAbsolutePath file)})))
    (let [attributes
          (java.nio.file.Files/readAttributes
           path java.nio.file.attribute.BasicFileAttributes no-follow)
          links (long (java.nio.file.Files/getAttribute
                       path "unix:nlink" no-follow))]
      (when-not (and (.isRegularFile attributes)
                     (.fileKey attributes)
                     (<= 1 links 2))
        (throw (ex-info "receipt stage file identity is ambiguous"
                        {:type :candidate-receipt-stage-ownership-invalid
                         :path (.getAbsolutePath file) :links links})))
      (assoc parts :path (.getCanonicalPath file)
             :file-key (str (.fileKey attributes))
             :fd-identity
             (schema-candidate/file-fd-identity! path)
             :links links))))

(defn same-receipt-stage-file! [directory expected]
  (let [actual (assert-owned-receipt-stage! directory (:path expected))]
    (when-not (= (select-keys expected [:file-key :fd-identity])
                 (select-keys actual [:file-key :fd-identity]))
      (throw (ex-info "receipt stage identity changed before inspection"
                      {:type :candidate-receipt-stage-ownership-invalid
                       :expected expected :actual actual})))
    actual))

(defn inspect-retained-receipt-stages! [directory]
  (let [directory (.getCanonicalPath (io/file directory))
        prefix ".schema-receipt-stage-v1."
        candidates (->> (or (.listFiles (io/file directory))
                            (make-array java.io.File 0))
                        (filter #(str/starts-with? (.getName ^java.io.File %)
                                                  prefix))
                        (sort-by #(.getName ^java.io.File %)))]
    (reduce
     (fn [inspected candidate]
       (try
         (let [owned (assert-owned-receipt-stage! directory candidate)]
           (case (process-owner-state owned)
             :live inspected
             :dead
             (let [current (same-receipt-stage-file! directory owned)]
               (schema-candidate/run-stage-io-helper!
                ["inspect-retained-file" directory
                 (.getName (io/file (:path current)))
                 (json/generate-string (:fd-identity current))])
               (inc inspected))
             :ambiguous
             (throw (ex-info "receipt-stage owner process identity is ambiguous"
                             {:type :candidate-receipt-stage-owner-ambiguous
                              :path (:path owned)
                              :pid (:pid owned)
                              :pid-birth (:pid-birth owned)}))))
         (catch java.nio.file.NoSuchFileException _ inspected))
       )
     0 candidates)))

(defn create-owned-receipt-stage! [directory]
  (let [{:keys [pid pid-birth]} (current-process-owner!)
        ticks (subs pid-birth 5)
        permissions
        (java.nio.file.attribute.PosixFilePermissions/asFileAttribute
         (java.util.HashSet.
          ^java.util.Collection
          [java.nio.file.attribute.PosixFilePermission/OWNER_READ
           java.nio.file.attribute.PosixFilePermission/OWNER_WRITE]))]
    (loop []
      (let [nonce (str (java.util.UUID/randomUUID))
            path (.toPath
                  (io/file directory
                           (str ".schema-receipt-stage-v1."
                                pid ".proc-" ticks "." nonce ".tmp")))
            created
            (try
              (java.nio.file.Files/createFile
               path (into-array java.nio.file.attribute.FileAttribute
                                [permissions]))
              true
              (catch java.nio.file.FileAlreadyExistsException _ false))]
        (if created
          (do
            (force-directory! directory)
            (assert-owned-receipt-stage! directory (.toFile path)))
          (recur))))))

(defn assert-existing-receipt! [target bytes]
  (let [no-follow (into-array java.nio.file.LinkOption
                              [java.nio.file.LinkOption/NOFOLLOW_LINKS])]
  (when-not (and (regular-receipt-target? target)
                 (bytes-equal? target bytes)
                 (= #{java.nio.file.attribute.PosixFilePermission/OWNER_READ
                      java.nio.file.attribute.PosixFilePermission/GROUP_READ
                      java.nio.file.attribute.PosixFilePermission/OTHERS_READ}
                    (set (java.nio.file.Files/getPosixFilePermissions
                          (.toPath (io/file target)) no-follow)))
                 (= 1 (long (java.nio.file.Files/getAttribute
                             (.toPath (io/file target)) "unix:nlink"
                             no-follow))))
    (throw (ex-info "content-addressed candidate receipt already exists with different bytes"
                    {:type :candidate-receipt-content-collision
                       :path (.getCanonicalPath (io/file target))})))
  (.getCanonicalPath (io/file target))))

(defn ensure-receipt-directory! [dir]
  (let [directory (io/file dir)]
    (.mkdirs directory)
    (when-not (and (.isDirectory directory)
                   (not (java.nio.file.Files/isSymbolicLink
                         (.toPath directory))))
      (throw (ex-info "candidate receipt directory is unavailable"
                      {:type :candidate-receipt-directory-unavailable
                       :path (.getAbsolutePath directory)})))
    (.getCanonicalPath directory)))

(defn reserve-receipt-publication! [dir]
  (let [directory (ensure-receipt-directory! dir)
        parent-identity (schema-candidate/file-fd-identity! directory)]
    (inspect-retained-receipt-stages! directory)
    (let [stage (create-owned-receipt-stage! directory)
          current-parent (schema-candidate/file-fd-identity! directory)]
      (when-not (= parent-identity current-parent)
        (throw (ex-info "receipt sink changed while publication was reserved"
                        {:type :candidate-receipt-publication-unreserved
                         :directory directory :expected-parent parent-identity
                         :actual-parent current-parent})))
      {:directory directory :parent-identity parent-identity
       :stage stage})))

(defn release-receipt-publication! [reservation]
  ;; Linux exposes no unlink-by-FD. The private reservation is retained rather
  ;; than converting an identity check into a later pathname deletion that
  ;; could remove a replacement inode.
  nil)

(defn write-receipt!
  ([dir receipt]
   (let [reservation (reserve-receipt-publication! dir)]
     (write-receipt! dir receipt reservation)))
  ([dir receipt reservation]
  (let [bytes (receipt-bytes receipt)
        directory (ensure-receipt-directory! dir)
        target (receipt-target directory receipt)
        tmp (:stage reservation)]
    (when-not (and (= directory (:directory reservation))
                   (= (:parent-identity reservation)
                      (schema-candidate/file-fd-identity! directory)))
      (throw (ex-info "candidate receipt publication was not reserved for this sink"
                      {:type :candidate-receipt-publication-unreserved})))
    (try
      (let [written (write-receipt-stage-bytes! directory tmp bytes)
            response
            (schema-candidate/run-stage-io-helper!
             ["publish-receipt" directory
              (.getName (io/file (:path written))) (.getName target)
              (json/generate-string (:fd-identity written))
              (bytes-sha256 bytes)
              (json/generate-string (:parent-identity reservation))])]
        (when-not (and (= (.getName target) (:target response))
                       (= (:parent-identity reservation)
                          (:parent_identity response)))
          (throw (ex-info "receipt helper returned the wrong target"
                          {:type :candidate-receipt-publication-invalid
                           :response response})))
        (assert-existing-receipt! target bytes))
      (finally
        (release-receipt-publication! reservation))))))

(defn required-option! [opts key option]
  (let [value (get opts key)]
    (when-not (configured-path? value)
      (throw (ex-info (str option " is required")
                      {:type :schema-option-required :option option})))
    value))

(defn verify-source-snapshot! [opts]
  (schema-candidate/verify-source!
   (required-option! opts :snapshot-store "--snapshot-store")
   (required-option! opts :source-snapshot "--source-snapshot")))

(defn verify-workspace! [opts source repair-manifest-sha]
  (let [verified
        (schema-candidate/verify-origin!
         {:workspace-root (required-option! opts :workspace-root "--workspace-root")
          :workspace (required-option! opts :workspace "--workspace")
          :snapshot-store (required-option! opts :snapshot-store "--snapshot-store")
          :source-snapshot (required-option! opts :source-snapshot "--source-snapshot")
          :repair-manifest-sha256 repair-manifest-sha})]
    (when-not (= (:provenance source) (get-in verified [:source :provenance]))
      (throw (ex-info "schema workspace source snapshot changed"
                      {:type :schema-source-snapshot-drift})))
    (dissoc verified :source)))

(defn prepare-workspace! [opts]
  (let [source (verify-source-snapshot! opts)
        source-corpus
        (read-corpus
         (mapv #(get-in source [:records % :path])
               [:coordination :telemetry]))
        manifest (read-repair-manifest!
                  (required-option! opts :manifest "--manifest") source-corpus)]
    (schema-candidate/prepare-workspace!
     {:workspace-root (required-option! opts :workspace-root "--workspace-root")
      :snapshot-store (required-option! opts :snapshot-store "--snapshot-store")
      :source-snapshot (required-option! opts :source-snapshot "--source-snapshot")
      :repair-manifest-sha256 (:_sha256 manifest)
      :execute? (:execute opts)})))

(defn workspace-identity [workspace]
  (schema-candidate/workspace-identity workspace))

(defn assert-explicit-workspace-paths! [opts workspace]
  (doseq [[option role] [[:log :coordination] [:telemetry :telemetry]]]
    (when-let [selected (get opts option)]
      (let [actual (.getCanonicalPath (io/file selected))
            expected (get-in workspace [:records role :path])]
        (when-not (= expected actual)
          (throw (ex-info
                  (str "explicit --" (name option)
                       " does not name the verified schema workspace payload")
                  {:type :schema-workspace-path-mismatch
                   :option option :expected expected :actual actual}))))))
  workspace)

(defn candidate-build-input! [opts]
  (let [source (verify-source-snapshot! opts)
        source-corpus
        (read-corpus
         (mapv #(get-in source [:records % :path])
               [:coordination :telemetry]))
        manifest (read-repair-manifest!
                  (required-option! opts :manifest "--manifest") source-corpus)
        workspace (assert-explicit-workspace-paths!
                   opts (verify-workspace! opts source (:_sha256 manifest)))
        corpus (read-corpus (:paths workspace))]
    (doseq [[role file]
            (map vector [:coordination :telemetry] (:files corpus))]
      (when-not (= (select-keys (get-in workspace [:records role])
                                [:path :file_key :bytes :sha256])
                   (select-keys file [:path :file_key :bytes :sha256]))
        (throw (ex-info "schema workspace changed between verification and planning"
                        {:type :schema-workspace-planning-raced :role role}))))
    {:source source :source_corpus source-corpus :origin_corpus source-corpus
     :workspace workspace :corpus corpus :manifest manifest}))

(def BUILT-PROOF-FORMAT "north-schema-built-proof/v1")

(defn canonical-value-sha256 [value]
  (bytes-sha256 (snapshot/canonical-edn-bytes value)))

(defn corpus-facts-sha256 [corpus]
  (canonical-value-sha256
   (->> (:facts corpus) (sort-by (juxt :l :p :r)) vec)))

(defn semantic-plan-evidence [plan]
  ;; `plan-for` also carries file paths, inode keys, byte modes, and source
  ;; seals. Those correctly bind a migration attempt, but they must not make an
  ;; exact byte-for-byte immutable copy look like a different logical schema.
  (select-keys plan
               [:schema :corrupt :collisions :actions :ambiguous
                :unresolved-semantics :cardinality-conflicts
                :reference-shape-defects :dangling-reference-defects
                :acyclic-cycle-defects :manifest-defects]))

(defn semantic-audit-evidence [report]
  (dissoc report :corpus))

(defn finalized-domain-evidence [corpus]
  (let [plan (plan-for corpus)
        report (audit-report corpus)
        proof {:format BUILT-PROOF-FORMAT
               :post_version (:version corpus)
               :post_facts_sha256 (corpus-facts-sha256 corpus)
               :post_plan_sha256
               (canonical-value-sha256 (semantic-plan-evidence plan))
               :post_audit_sha256
               (canonical-value-sha256 (semantic-audit-evidence report))}
        ok (and (empty? (:actions plan))
                (empty? (:cardinality-conflicts plan))
                (:ok report))]
    {:ok (boolean ok) :proof proof :plan plan :audit report}))

(defn same-logical-corpus? [left right]
  (and (= (:version left) (:version right))
       (= (set (:facts left)) (set (:facts right)))))

(defn classify-workspace [workspace current preflight]
  (let [prepared? (schema-candidate/current-matches-origin? workspace)
        expected (:simulated_corpus preflight)
        domain (when (same-logical-corpus? current expected)
                 (finalized-domain-evidence current))
        built? (and (:ok domain)
                    (or (nil? (:built_seal_path workspace))
                        (try
                          (= (:proof domain)
                             (get-in (schema-candidate/verify-built-seal!
                                      workspace)
                                     [:seal :proof]))
                          (catch Throwable _ false))))]
    (cond
      (and prepared? (nil? (:built_seal_path workspace)))
      {:state :prepared :current current}

      built?
      {:state :built :current current :domain domain}

      :else
      {:state :diverged :current current
       :expected_version (:version expected)
       :actual_version (:version current)})))

(defn finalized-corpus-from-pinned-records! [candidate]
  (let [records (:records candidate)
        _ (when-not (every? #(vector? (get-in records [% :ops]))
                            [:coordination :telemetry])
            (throw (ex-info
                    "finalized candidate validator requires pinned payload operations"
                    {:type :final-schema-candidate-validator-input-invalid})))
        ops (vec (mapcat #(get-in records [% :ops])
                         [:coordination :telemetry]))
        folded (fold-for-cutover ops)]
    {:paths (mapv #(get-in records [% :path])
                  [:coordination :telemetry])
     :ops ops
     :facts (:facts folded)
     :version (:version folded)
     :card_map (:card_map folded)
     :files
     (mapv (fn [role]
             (select-keys (get records role)
                          [:path :file_key :bytes :sha256]))
           [:coordination :telemetry])}))

(defn validate-finalized-domain! [candidate]
  (let [corpus (finalized-corpus-from-pinned-records! candidate)
        domain (finalized-domain-evidence corpus)
        expected (get-in candidate [:manifest :build :proof])]
    {:ok (and (:ok domain) (= expected (:proof domain)))
     :proof (:proof domain)
     :remaining_actions (count (get-in domain [:plan :actions]))
     :audit_ok (get-in domain [:audit :ok])}))

(defn verify-final-candidate! [store selector snapshot-store]
  (schema-candidate/verify-finalized!
   {:candidate-store store :candidate selector :snapshot-store snapshot-store
    :validate! validate-finalized-domain!}))

(defn publish-final-candidate! [opts workspace post _attempt-evidence]
  (let [current (schema-candidate/verify-origin!
                 {:workspace-root
                  (required-option! opts :workspace-root "--workspace-root")
                  :workspace (required-option! opts :workspace "--workspace")
                  :snapshot-store
                  (required-option! opts :snapshot-store "--snapshot-store")
                  :source-snapshot
                  (required-option! opts :source-snapshot "--source-snapshot")
                  :repair-manifest-sha256
                  (get-in workspace [:manifest :repair_manifest_sha256])
                 })
        _ (doseq [[role file]
                  (map vector [:coordination :telemetry] (:files post))]
            (when-not (= (select-keys (get-in current [:records role])
                                      [:path :file_key :bytes :sha256])
                         (select-keys file [:path :file_key :bytes :sha256]))
              (throw (ex-info "workspace changed after postcondition validation"
                              {:type :schema-workspace-post-drift
                               :role role}))))
        domain (finalized-domain-evidence post)
        _ (when-not (:ok domain)
            (throw (ex-info "workspace is not semantically converged"
                            {:type :schema-workspace-not-converged})))
        _ (schema-candidate/seal-built! current (:proof domain))
        built (schema-candidate/verify-origin!
               {:workspace-root (:workspace-root opts)
                :workspace (:workspace opts)
                :snapshot-store (:snapshot-store opts)
                :source-snapshot (:source-snapshot opts)
                :repair-manifest-sha256
                (get-in workspace [:manifest :repair_manifest_sha256])})]
    (schema-candidate/verify-built-seal! built)
    (schema-candidate/publish-finalized!
     {:snapshot-store (required-option! opts :snapshot-store "--snapshot-store")
      :workspace built :validate! validate-finalized-domain!
      :publication (:candidate-publication opts)})))

(defn option-value! [option remaining]
  (let [value (first remaining)]
    (when (or (nil? value) (str/starts-with? value "--"))
      (throw (ex-info (str option " requires a value")
                      {:type :missing-option-value :option option})))
    value))

(defn parse-opts [args]
  (loop [remaining args opts {:execute false :strict false :repair-corrupt false
                              :offline-confirm false :verbose false}]
    (if (empty? remaining)
      opts
      (let [[arg & more] remaining]
        (case arg
          "--execute" (recur more (assoc opts :execute true))
          "--strict" (recur more (assoc opts :strict true))
          "--verbose" (recur more (assoc opts :verbose true))
          "--repair-corrupt" (recur more (assoc opts :repair-corrupt true))
          "--offline-confirm" (recur more (assoc opts :offline-confirm true))
          "--log" (recur (rest more) (assoc opts :log (option-value! arg more)))
          "--telemetry" (recur (rest more) (assoc opts :telemetry (option-value! arg more)))
          "--manifest" (recur (rest more) (assoc opts :manifest (option-value! arg more)))
          "--receipt-dir" (recur (rest more) (assoc opts :receipt-dir (option-value! arg more)))
          "--snapshot-store" (recur (rest more) (assoc opts :snapshot-store (option-value! arg more)))
          "--source-snapshot" (recur (rest more) (assoc opts :source-snapshot (option-value! arg more)))
          "--workspace-root" (recur (rest more) (assoc opts :workspace-root (option-value! arg more)))
          "--workspace" (recur (rest more) (assoc opts :workspace (option-value! arg more)))
          "--candidate-store" (recur (rest more) (assoc opts :candidate-store (option-value! arg more)))
          "--candidate" (recur (rest more) (assoc opts :candidate (option-value! arg more)))
          ;; Compatibility with the abandoned lane's positional log argument.
          (if (or (:log opts) (str/starts-with? arg "--"))
            (throw (ex-info (str "unknown argument: " arg) {}))
            (recur more (assoc opts :log arg))))))))

(defn default-receipt-dir []
  (str (System/getProperty "user.home") "/.local/state/north/schema-receipts"))

(defn manifest-template [corpus plan]
  {:format REPAIR-MANIFEST-FORMAT
   :source (source-seal corpus)
   :review {:by "REVIEWER_REQUIRED"
            :at "REVIEW_INSTANT_REQUIRED"
            :basis "REVIEW_BASIS_REQUIRED"}
   :predicate_semantics
   (into (sorted-map)
         (map (fn [{:keys [predicate]}]
                [predicate {:cardinality nil :value_kind nil :doc nil
                            :rationale "SEMANTIC_REVIEW_REQUIRED"}]))
         (:unresolved-semantics plan))
   :cardinality_repairs
   (mapv (fn [{:keys [subject predicate values]}]
           {:subject subject :predicate predicate :retain nil :retract values
            :policy "SEMANTIC_POLICY_REQUIRED"
            :rationale "REVIEW_REQUIRED; do not accept the template's retain/retract placeholders"})
         (:cardinality-conflicts plan))
   :fact_repairs []
   :other_allowlist
   {:name "NAMED_REVIEWED_ALLOWLIST_REQUIRED"
    :entries (into (sorted-map)
                   (map (fn [subject]
                          [subject {:entity_kind nil
                                    :rationale "QUARANTINE_OR_EXTENSION_REVIEW_REQUIRED"}]))
                   (:ambiguous plan))}})

(defn print-omitted [label total shown]
  (when (> total shown)
    (println (str "  … " (- total shown) " more " label " omitted"))))

(defn print-plan [plan verbose]
  (println (format "schema plan — %d predicate(s), %d action(s), %d corrupt fact(s), %d collision(s), %d unresolved predicate(s), %d cardinality conflict group(s), %d ref-shape defect(s), %d dangling ref(s), %d cycle node(s), %d ambiguous other"
                   (count (:schema plan)) (count (:actions plan))
                   (count (:corrupt plan)) (count (:collisions plan))
                   (count (:unresolved-semantics plan))
                   (count (:cardinality-conflicts plan))
                   (count (:reference-shape-defects plan))
                   (count (:dangling-reference-defects plan))
                   (count (:acyclic-cycle-defects plan))
                   (count (:ambiguous plan))))
  (println (str "  plan_sha256 " (:sha256 plan)))
  (doseq [collision (:collisions plan)]
    (println (str "  ✗ predicate/thread subject collision: @" collision)))
  (doseq [fact (:corrupt plan)]
    (println (str "  ✗ non-registrable predicate: " (pr-str (:p fact))
                  " on " (:l fact) " -> " (pr-str (:r fact)))))
  (doseq [unresolved (take 50 (:unresolved-semantics plan))]
    (println (str "  ✗ predicate semantics unresolved: " (:predicate unresolved)
                  " needs " (str/join "," (:fields unresolved)))))
  (print-omitted "unresolved predicate(s)"
                 (count (:unresolved-semantics plan)) 50)
  (doseq [conflict (take 50 (:cardinality-conflicts plan))]
    (println (str "  ✗ reviewed cardinality repair required: "
                  (:subject conflict) " " (:predicate conflict) " "
                  (pr-str {:value_count (count (:values conflict))
                           :first_values (vec (take 5 (:values conflict)))}))))
  (print-omitted "cardinality conflict group(s)"
                 (count (:cardinality-conflicts plan)) 50)
  (doseq [defect (take 50 (:reference-shape-defects plan))]
    (println (str "  ✗ ref predicate carries non-reference value: "
                  (:l defect) " " (:p defect) " " (pr-str (:r defect)))))
  (doseq [defect (take 50 (:dangling-reference-defects plan))]
    (println (str "  ✗ ref predicate references missing entity: "
                  (:l defect) " " (:p defect) " " (pr-str (:r defect)))))
  (doseq [defect (take 50 (:acyclic-cycle-defects plan))]
    (println (str "  ✗ acyclic predicate participates in a cycle: "
                  (:l defect) " " (:p defect))))
  (let [manifest-defects (remove #(= "missing-cardinality-repair" (:type %))
                                 (:manifest-defects plan))]
    (doseq [defect (take 50 manifest-defects)]
      (println (str "  ✗ repair manifest: " (pr-str defect))))
    (print-omitted "repair-manifest defect(s)" (count manifest-defects) 50))
  (when (seq (:ambiguous plan))
    (println (str "  ✗ unresolved subjects remain `other`; name a reviewed quarantine/extension allowlist; first 20: "
                  (str/join ", " (take 20 (:ambiguous plan))))))
  (when verbose
    (doseq [{:keys [subject predicate value before]} (:actions plan)]
      (println (format "  set %-38s %-22s %-10s  was %s"
                       subject predicate value (pr-str before))))))

(defn print-audit [report]
  (println (format "schema audit — %d predicate(s), %d schema defect(s), %d unresolved predicate(s), %d corrupt fact(s), %d ref-shape defect(s), %d dangling ref(s), %d cycle node(s), %d entity-kind defect(s), %d unresolved other"
                   (:predicate_count report) (count (:schema_defects report))
                   (count (:unresolved_predicate_semantics report))
                   (count (:corrupt report))
                   (count (:reference_shape_defects report))
                   (count (:dangling_reference_defects report))
                   (count (:acyclic_cycle_defects report))
                   (+ (count (:entity_kind_definition_defects report))
                      (count (:entity_assignment_defects report))
                      (count (:invalid_entity_kind_values report)))
                   (count (:ambiguous_subjects report))))
  (doseq [fact (:corrupt report)]
    (println (str "  ✗ corrupt predicate " (pr-str (:p fact)) " on " (:l fact))))
  (doseq [collision (:collisions report)]
    (println (str "  ✗ predicate/thread collision @" collision)))
  (doseq [defect (:schema_defects report)]
    (println (str "  ✗ @" (:predicate defect) " " (:field defect)
                  " = " (pr-str (:values defect)))))
  (doseq [defect (:unresolved_predicate_semantics report)]
    (println (str "  ✗ predicate semantics unresolved: " (:predicate defect)
                  " needs " (str/join "," (:fields defect)))))
  (doseq [defect (take 50 (:reference_shape_defects report))]
    (println (str "  ✗ ref predicate carries non-reference value: "
                  (:l defect) " " (:p defect) " " (pr-str (:r defect)))))
  (doseq [defect (take 50 (:dangling_reference_defects report))]
    (println (str "  ✗ ref predicate references missing entity: "
                  (:l defect) " " (:p defect) " " (pr-str (:r defect)))))
  (doseq [defect (take 50 (:acyclic_cycle_defects report))]
    (println (str "  ✗ acyclic predicate participates in a cycle: "
                  (:l defect) " " (:p defect))))
  (doseq [defect (:entity_kind_definition_defects report)]
    (println (str "  ✗ entity kind definition " (:kind defect) " is incomplete")))
  (doseq [defect (take 50 (:entity_assignment_defects report))]
    (println (str "  ✗ " (:subject defect) " entity_kind=" (pr-str (:actual defect))
                  ", expected " (:expected defect) " from " (:source defect))))
  (doseq [defect (:invalid_entity_kind_values report)]
    (println (str "  ✗ invalid/ambiguous entity_kind " (pr-str (:values defect)) " on " (:l defect))))
  (when (seq (:ambiguous_subjects report))
    (println (str "  ✗ unresolved subjects remain `other`; reviewed quarantine/extension classification required; first 20: "
                  (str/join ", " (take 20 (:ambiguous_subjects report))))))
  (println (if (:ok report)
             "  ✓ executable predicate entities are authoritative; entity kinds are governed; unresolved other is empty"
             "  -> if corruption is listed, use `repair-corrupt` for exact diagnostics; mutation requires the corpus transaction surface")))

(defn usage! []
  (binding [*out* *err*]
    (println "usage: schema-migrate.clj <port> {plan|manifest-template|migrate|prepare-workspace|build-candidate|verify-candidate|audit|repair-corrupt} [options]")
    (println "       prepare-workspace: --snapshot-store DIR --source-snapshot ID --workspace-root DIR --manifest PATH [--execute]")
    (println "       build-candidate: --snapshot-store DIR --source-snapshot ID --workspace-root DIR --workspace ID --candidate-store DIR --manifest PATH [--execute --offline-confirm]")
    (println "       verify-candidate: --snapshot-store DIR --candidate-store DIR --candidate ID")
    (println "       read-only graph verbs retain --log PATH --telemetry PATH; finalized candidates install only through corpus-transaction"))
  (System/exit 2))

(defn print-preflight [preflight]
  (if (:ok preflight)
    (println (str "  ✓ complete preflight simulated "
                  (count (:wire_actions preflight))
                  " append action(s); post-plan 0 and strict audit green"))
    (doseq [defect (:defects preflight)]
      (println (str "  ✗ candidate preflight: " (pr-str defect))))))

(defn require-offline-daemon!
  ([port log version]
   (require-offline-daemon! port log version
                            (attest-selected-fram-runtime! port log)))
  ([port log version runtime]
   (let [status (north.coord/strict-coordinator-status port log)]
     (when-not (and (:ready status) (= version (:version status)))
       (throw (ex-info "offline candidate coordinator is not strict-ready on the exact sealed corpus version"
                       {:type :offline-candidate-daemon-mismatch
                        :expected_version version :status status})))
     (assoc status :runtime runtime))))

(defn reverify-source-snapshot! [opts expected]
  (let [actual (verify-source-snapshot! opts)]
    (when-not (= (:provenance expected) (:provenance actual))
      (throw (ex-info "source snapshot identity changed during schema candidate construction"
                      {:type :schema-source-snapshot-drift
                       :expected (:provenance expected)
                       :actual (:provenance actual)})))
    actual))

(defn execute-offline-candidate!
  [port source workspace origin-corpus current-corpus manifest opts]
  (when-not (:offline-confirm opts)
    (throw (ex-info "build-candidate --execute requires --offline-confirm"
                    {:type :offline-confirm-required})))
  (let [paths (:paths workspace)
        preflight (candidate-preflight origin-corpus manifest)
        initial-state (classify-workspace workspace current-corpus preflight)]
    (assert-offline-candidate! paths)
    (require-append-boundaries! paths)
    (print-plan (:plan preflight) (:verbose opts))
    (print-preflight preflight)
    (when-not (:ok preflight)
      (throw (ex-info "complete candidate preflight failed; zero coordinator writes attempted"
                      {:type :candidate-preflight-failed
                       :defects (:defects preflight)})))
    (when (= :diverged (:state initial-state))
      (throw (ex-info "schema workspace is neither prepared nor exactly converged"
                      {:type :schema-workspace-diverged
                       :state initial-state})))
    ;; Both publication sinks prove create/retained-stage authority before the first
    ;; coordinator request. Their live owned stages remain reserved through the
    ;; locked build/finalization callback.
    (let [candidate-publication
          (schema-candidate/reserve-publication!
           (required-option! opts :candidate-store "--candidate-store"))
          receipt-dir (or (:receipt-dir opts) (default-receipt-dir))
          receipt-publication
          (try
            (reserve-receipt-publication! receipt-dir)
            (catch Throwable error
              (schema-candidate/release-publication! candidate-publication)
              (throw error)))
          execution-opts (assoc opts :candidate-publication
                               candidate-publication)]
      (try
        (with-corpus-authority
          paths
          (fn [authority]
            (let [locked-source (reverify-source-snapshot! opts source)
                  locked-workspace
                  (verify-workspace! opts locked-source (:_sha256 manifest))
                  current (read-corpus paths)
                  locked-state (classify-workspace
                                locked-workspace current preflight)
                  _ (when (= :diverged (:state locked-state))
                      (throw (ex-info
                              "schema workspace drifted before coordinator access"
                              {:type :schema-workspace-diverged
                               :state locked-state})))
                  prepared? (= :prepared (:state locked-state))
                  runtime (when prepared?
                            (attest-selected-fram-runtime! port (first paths)))
                  daemon-status
                  (if prepared?
                    (require-offline-daemon!
                     port (first paths) (:version origin-corpus) runtime)
                    {:ready true :resumed_finalization true
                     :wire_skipped true :version (:version current)})
                  _ (when runtime
                      (runtime-attestation/assert-current! runtime))
                  _ (reverify-source-snapshot! opts source)
                  immediately-before
                  (if prepared?
                    (let [sealed (read-corpus paths)
                          state (classify-workspace
                                 locked-workspace sealed preflight)]
                      (when-not (= :prepared (:state state))
                        (throw (ex-info
                                "schema workspace changed immediately before append"
                                {:type :schema-workspace-drift
                                 :state state})))
                      (revalidate-sealed-corpus! sealed)
                      sealed)
                    current)
                  acknowledged
                  (if prepared?
                    (apply-wire-actions! port (:wire_actions preflight))
                    0)
                  post (read-corpus paths)
                  post-plan (plan-for post)
                  report (audit-report post)
                  expected-post (:simulated_corpus preflight)
                  expected-version (:version expected-post)
                  exact-simulation? (same-logical-corpus? post expected-post)
                  converged? (and exact-simulation?
                                  (empty? (:actions post-plan))
                                  (empty? (:cardinality-conflicts post-plan))
                                  (:ok report))
                  result (if converged? "converged" "rejected")
                  _ (reverify-source-snapshot! opts source)
                  _ (when runtime
                      (runtime-attestation/assert-current! runtime))
                  build-evidence
                  {:daemon daemon-status
                   :workspace_entry_state (:state locked-state)
                   :source_plan_sha256 (get-in preflight [:plan :sha256])
                   :simulated_post_plan_sha256
                   (get-in preflight [:post_plan :sha256])
                   :requested_action_identities
                   (mapv #(select-keys
                           % [:action :subject :predicate :value])
                         (:wire_actions preflight))
                   :actions_acknowledged acknowledged
                   :expected_post_version expected-version
                   :actual_post_version (:version post)
                   :post_matches_simulation exact-simulation?
                   :post_plan_sha256 (:sha256 post-plan)
                   :remaining_action_identities
                   (action-identities (:actions post-plan))
                   :post_audit report}
                  finalized
                  (when converged?
                    (publish-final-candidate!
                     execution-opts locked-workspace post build-evidence))
                  finalized-summary
                  (when finalized
                    {:candidate_id (:candidate_id finalized)
                     :manifest_sha256 (:manifest_sha256 finalized)})
                  receipt
                  {:format CANDIDATE-RECEIPT-FORMAT
                   :result result
                   :source (source-seal origin-corpus)
                   :source_snapshot (:provenance source)
                   :workspace_preimage
                   {:workspace_id (:workspace_id workspace)
                    :manifest_sha256 (:manifest_sha256 workspace)
                    :files (get-in workspace [:manifest :files])}
                   :source_authority
                   {:lock authority
                    :revalidated_files (:files immediately-before)
                    :held_through_candidate_and_receipt_publication true}
                   :manifest_sha256 (:_sha256 manifest)
                   :plan_sha256 (get-in preflight [:plan :sha256])
                   :simulated_post_plan_sha256
                   (get-in preflight [:post_plan :sha256])
                   :daemon daemon-status
                   :requested_action_identities
                   (mapv #(select-keys
                           % [:action :subject :predicate :value])
                         (:wire_actions preflight))
                   :actions_acknowledged acknowledged
                   :expected_post_version expected-version
                   :actual_post_version (:version post)
                   :post_matches_simulation exact-simulation?
                   :post_plan_sha256 (:sha256 post-plan)
                   :remaining_action_identities
                   (action-identities (:actions post-plan))
                   :converged converged?
                   :post_audit report
                   :candidate_corpus (:files post)
                   :finalized_candidate finalized-summary}
                  receipt-path
                  (write-receipt! receipt-dir receipt receipt-publication)]
              (print-audit report)
              (println (str "  receipt " receipt-path " result=" result))
              (when-not converged?
                (throw (ex-info
                        "offline candidate diverged from its complete simulation"
                        {:type :candidate-postcondition-failed
                         :receipt receipt-path :result result
                         :post_matches_simulation exact-simulation?
                         :expected_version expected-version
                         :actual_version (:version post)
                         :remaining (count (:actions post-plan))
                         :audit_ok (:ok report)})))
              receipt)))
        (finally
          (release-receipt-publication! receipt-publication)
          (schema-candidate/release-publication!
           candidate-publication))))))
(defn main! [args]
  (let [[port-arg verb & raw-args] args]
    (when-not (and port-arg verb) (usage!))
    (let [port (Integer/parseInt port-arg)
          opts (parse-opts raw-args)]
      (cond
        (= "prepare-workspace" verb)
        (println (pr-str (prepare-workspace! opts)))

        (= "verify-candidate" verb)
        (println
         (pr-str
          (verify-final-candidate!
           (required-option! opts :candidate-store "--candidate-store")
           (required-option! opts :candidate "--candidate")
           (required-option! opts :snapshot-store "--snapshot-store"))))

        (= "build-candidate" verb)
        (let [{:keys [source workspace origin_corpus corpus manifest]}
              (candidate-build-input! opts)
              preflight (candidate-preflight origin_corpus manifest)
              state (classify-workspace workspace corpus preflight)]
          (if (:execute opts)
            (execute-offline-candidate!
             port source workspace origin_corpus corpus manifest opts)
            (do
              (print-plan (:plan preflight) (:verbose opts))
              (print-preflight preflight)
              (println (str "  workspace_state " (name (:state state)))))))

        :else
        (let [log (or (:log opts) (System/getenv "FRAM_LOG")
                      (north.coord/expected-log))
              telemetry (or (:telemetry opts)
                            (System/getenv "FRAM_TELEMETRY_LOG"))
              paths (resolve-corpus-paths! log telemetry)
              corpus (read-corpus paths)
              manifest (when (:manifest opts)
                         (read-repair-manifest! (:manifest opts) corpus))]
          (case verb
            "plan"
            (print-plan (plan-for corpus manifest) (:verbose opts))

            "manifest-template"
            (let [plan (plan-for corpus)]
              (println (pr-str (manifest-template corpus plan))))

            "audit"
            (let [report (audit-report corpus)]
              (print-audit report)
              (when (and (:strict opts) (not (:ok report))) (System/exit 1)))

            "migrate"
            (let [plan (plan-for corpus manifest)]
              (print-plan plan (:verbose opts))
              (if (:execute opts)
                (throw (ex-info "direct migrate --execute is disabled before the first write; build a reviewed offline candidate, then install it with north corpus-transaction"
                                {:type :direct-schema-migration-disabled
                                 :route "prepare-workspace + build-candidate + corpus-transaction"}))
                (println "  plan-only compatibility verb; use prepare-workspace, then build-candidate on that exact owned workspace")))

            "repair-corrupt"
            (let [bad (corrupt-facts (:facts corpus))]
              (println (str "repair-corrupt — " (count bad) " live non-registrable predicate fact(s)"))
              (doseq [fact bad]
                (println (str "  would retract exact triple "
                              (pr-str (select-keys fact [:l :p :r])))))
              (if (:execute opts)
                (throw (ex-info "repair-corrupt execute unavailable: corpus transaction required; no bytes written"
                                {:type :corpus-transaction-required
                                 :count (count bad)}))
                (println "  diagnostic dry-run only; no bytes written")))

            (usage!)))))))

(defn invoked-as-script? []
  (when-let [main-source (System/getProperty "babashka.file")]
    (= SCHEMA-MIGRATE-SOURCE (.getCanonicalPath (io/file main-source)))))

(when (invoked-as-script?)
  (main! *command-line-args*))
