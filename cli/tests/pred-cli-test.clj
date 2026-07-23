#!/usr/bin/env bb
(require '[clojure.java.io :as io]
         '[clojure.set :as set]
         '[clojure.string :as str]
         '[clojure.walk :as walk])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(defn path [relative] (io/file root relative))
(defn slurp-source [relative] (slurp (path relative)))

(defn read-forms [file]
  (with-open [reader (java.io.PushbackReader. (io/reader file))]
    (let [eof (Object.)]
      (loop [forms []]
        (let [form (read {:eof eof :read-cond :allow} reader)]
          (if (= eof form) forms (recur (conj forms form))))))))

(defn literal-def [relative symbol]
  (let [form (some #(when (and (seq? %) (= 'def (first %)) (= symbol (second %))) %)
                   (read-forms (path relative)))]
    (when-not form (throw (ex-info (str "missing def " symbol " in " relative) {})))
    (nth form 2)))

(def vocab (literal-def "cli/pred-cli.clj" 'VOCAB))
(def registry (into {} (map (fn [[name card kind doc]]
                              [name {:card card :kind kind :doc doc}]) vocab)))
(def registry-names (set (keys registry)))
(def dynamic-surfaces (literal-def "cli/pred-cli.clj" 'DYNAMIC-PREDICATE-SURFACES))
(def checks (atom []))

(defn check
  ([label value] (check label value nil))
  ([label value detail]
   (swap! checks conj {:label label :ok (boolean value) :detail detail})))

(defn set-detail [expected actual]
  (str "missing=" (pr-str (sort (set/difference expected actual)))
       " unexpected=" (pr-str (sort (set/difference actual expected)))))

(defn section [text start end]
  (let [from (str/index-of text start)
        to (and from (str/index-of text end (+ from (count start))))]
    (when-not (and from to)
      (throw (ex-info "source section marker drift" {:start start :end end})))
    (subs text from to)))

(defn pair-predicates [text]
  (set (map second (re-seq #"\[\s*\"([a-z][a-z0-9_]*)\"\s*," text))))

(def graph-write-predicate-index
  {"append!" 3
   "put!" 3
   "assert!" 3
   "assert-after-read!" 3
   "retract!" 3
   "set-single!" 3
   "set-1!" 3
   ;; Fenced verbs carry the lease envelope before subject/predicate.
   "put-with-fence!" 4
   "retract-with-fence!" 4
   "assert-after-read-with-fence!" 4})

(defn fixed-graph-predicates [form]
  (let [found (atom #{})]
    (walk/postwalk
     (fn [node]
       (when (and (seq? node) (symbol? (first node))
                  (contains? graph-write-predicate-index (name (first node))))
         (let [predicate (nth (vec node)
                              (get graph-write-predicate-index
                                   (name (first node)))
                              nil)]
           (when (string? predicate) (swap! found conj predicate))))
       (when (and (map? node) (#{:assert :retract} (:op node)) (string? (:p node)))
         (swap! found conj (:p node)))
       node)
     form)
    @found))

(defn variable-graph-sites [relative form]
  (let [found (atom #{})]
    (walk/postwalk
     (fn [node]
       (when (and (seq? node) (symbol? (first node))
                  (contains? graph-write-predicate-index (name (first node))))
         (let [predicate (nth (vec node)
                              (get graph-write-predicate-index
                                   (name (first node)))
                              nil)]
           (when (and predicate (not (string? predicate)))
             (swap! found conj [relative (name (first node)) (pr-str predicate)]))))
       node)
     form)
    @found))

(defn production-clj-files []
  (->> (file-seq (path "cli"))
       (filter #(str/ends-with? (.getName %) ".clj"))
       (remove #(some #{"tests"} (str/split (.getPath %) #"[/\\]")))
       (sort-by #(.getPath %))))

(def engine-schema-predicates #{"acyclic" "cardinality" "value_kind"})
(def clj-fixed
  (set/difference
   (reduce into #{}
           (for [file (production-clj-files)
                 form (read-forms file)]
             (fixed-graph-predicates form)))
   ;; These predicate-position literals configure Fram's executable schema;
   ;; they are not North domain predicates and never belong in VOCAB.
   engine-schema-predicates))

(def clj-variable-sites
  (reduce into #{}
          (for [file (production-clj-files)
                :let [relative (str (.relativize (.toPath (io/file root)) (.toPath file)))]
                form (read-forms file)]
            (variable-graph-sites relative form))))

;; Variable predicate expressions are reviewed explicitly. Some are open user
;; surfaces; the others are closed transports whose producer sets are audited
;; elsewhere in this test. A new variable writer cannot silently become exempt.
(def audited-clj-variable-sites
  #{["cli/agent-fact-internal.clj" "put-with-fence!" "predicate"]
    ["cli/agent-fact-internal.clj" "put-with-fence!" "marker-predicate"]
    ["cli/agent-fact-internal.clj" "assert-after-read-with-fence!" "terminal-marker-predicate"]
    ["cli/agent-fact-internal.clj" "retract-with-fence!" "predicate"]
    ["cli/coord.clj" "assert-after-read!" "p"]
    ["cli/coord.clj" "assert-after-read-with-fence!" "p"]
    ["cli/delivery-evidence-internal.clj" "append!" "predicate"]
    ;; lease-cli put-fenced carries a caller-supplied predicate under the fence.
    ["cli/lease-cli.clj" "put-with-fence!" "(required-text \"predicate\" (nth args 4 nil))"]
    ["cli/msg-cli.clj" "put!" "(arg-pred k)"]
    ["cli/msg-cli.clj" "put!" "target-identity-manifest-predicate"]
    ["cli/msg-cli.clj" "retract!" "predicate"]
    ["cli/message-audience.clj" "append!" "rejected-by-predicate"]
    ["cli/message-audience.clj" "append!" "rejection-predicate"]
    ["cli/north-listen.clj" "append!" "pred"]
    ["cli/north-mine.clj" "append!" "pred"]
    ["cli/north-mine.clj" "put!" "pred"]
    ["cli/pred-cli.clj" "put!" "p"]
    ["cli/pred-cli.clj" "retract!" "p"]
    ["cli/presence-cli.clj" "retract!" "p"]
    ["cli/presence-cli.clj" "append!" "(name k)"]
    ["cli/run-event-internal.clj" "put!" "predicate"]
    ["cli/run-fact-internal.clj" "put!" "predicate"]
    ["cli/schema-migrate.clj" "put!" "predicate"]
    ["cli/schema-migrate.clj" "retract!" "predicate"]
    ["cli/spend-breaker.clj" "retract!" "p"]
    ["cli/spend-cli.clj" "append!" "p"]
    ["cli/spend-cli.clj" "put!" "p"]
    ["cli/worktree-allocation-internal.clj" "append!" "marker-predicate"]
    ["cli/worktree-allocation-internal.clj" "append!" "predicate"]
    ["cli/worktree-allocation-internal.clj" "retract!" "predicate"]})

;; Fixed SDK fact constructors are audited instead of their variable transport
;; loops. A variable p in recordRun is not permission to omit a runFacts tuple.
(def telemetry-source (slurp-source "sdk/src/telemetry.ts"))
(def run-predicates
  (pair-predicates (section telemetry-source
                            "export function runFacts"
                            "export function recordRun")))
(def run-event-source (slurp-source "sdk/src/run-ledger.ts"))
(def run-event-predicates
  (pair-predicates (section run-event-source
                            "export function eventFacts"
                            "export type RunEventPublicationStatus")))
(def audited-run-multi
  #{"allocation_evidence" "applied_capability" "applied_domain_requirement"
    "applied_preset_override" "composition_override" "domain_requirement"
    "effective_authority_capability" "effective_builtin" "effective_mcp_tool"
    "effective_north_enabled_tool" "envelope_advisory" "envelope_scope"
    "fallback_reason" "routing_pin" "routing_receipt_override" "routing_rule_code"
    "run_observation_coverage" "struggle" "mcp_actual_tool" "provider_turn_key"
    "native_command_completion"})
(def audited-run-ref #{"parent_run" "parent_thread"})
(def audited-run-single
  #{"agent" "agent_run_ledger_version" "allocation_mode" "applied_bespoke_contract_sha256"
    "applied_bespoke_contract_fingerprint_domain"
    "applied_bespoke_contract_fingerprint_version"
    "applied_comms_contract_sha256" "applied_domain_requirement_count" "applied_posture"
    "applied_preset_override_reason_sha256" "applied_reasoning"
    "applied_role_contract" "applied_routing_tier" "applied_task_grade"
    "applied_topology" "at" "bespoke_reason" "cache_create_tokens"
    "cache_read_tokens" "cached_input_tokens" "composition_id"
    "composition_kind" "composition_override_reason" "delivery_attestation"
    "delivery_attestation_sha256" "delivery_evidence" "delivery_evidence_sha256"
    "compactions" "compaction_count" "compaction_evidence" "compaction_policy"
    "compaction_policy_version" "delivery_outcome" "delivery_reason" "duration_ms" "provider_duration_ms" "effort"
    "entitlement_pressure" "envelope_retries" "error_count" "escalation_count"
    "escalation_path" "escalation_reasons" "escalation_tier" "fallback_count"
    "fallback_path" "fallback_target_path" "input_tokens" "kind" "model"
    "model_availability_digest" "model_availability_model"
    "model_availability_observed_at" "model_availability_source"
    "model_availability_target"
    "model_delta_kind" "model_delta_model" "model_delta_path"
    "model_delta_provider" "model_delta_reason" "nearest_preset" "num_turns"
    "outcome" "preflight_cause" "process_outcome" "output_tokens" "posture" "promotion_candidate"
    "prompt_composition_applied" "prompt_composition_version" "prompt_composition_sha256"
    "capability_class" "prompt_capability_count" "prompt_stable_prefix_bytes"
    "prompt_unique_tail_bytes" "prompt_total_bytes" "prompt_byte_measurement_source"
    "prompt_stable_prefix_tokens" "prompt_unique_tail_tokens"
    "prompt_total_composition_tokens" "prompt_token_measurement_status"
    "prompt_token_measurement_source" "provider_context_window_tokens"
    "context_window_effective_from" "context_window_status" "context_window_source"
    "effective_context_budget_tokens" "context_budget_status" "context_budget_source"
    "provider" "provider_reason" "provider_target"
    "effective_authoring_hooks" "effective_authority_provider" "effective_live_input"
    "effective_native_multi_agent" "effective_sandbox" "effective_web"
    "reasoning_output_tokens" "requested_effort" "requested_model"
    "requested_provider" "requested_reasoning" "requested_role"
    "requested_target" "requested_tier" "role" "routing_posture" "routing_tier"
    "execution_source" "execution_transport" "north_session_id"
    "provider_join_key_version" "provider_join_coverage" "provider_session_key"
    "provider_session_persistence" "thread_provenance" "turn_provenance"
    "routing_admission_receipt_version" "routing_request_sha256"
    "routing_assessment_sha256" "routing_policy_sha256" "provider_catalogs_sha256"
    "staffing_catalog_sha256" "routing_assessment_status"
    "routing_override_evidence_status" "routing_override_exception_code"
    "routing_assessment_policy" "routing_derived_tier" "routing_derived_reasoning"
    "routing_selected_tier" "routing_selected_reasoning" "routing_exception_code"
    "routing_exception_detail" "routing_exceptional_deliberation"
    "routing_pin_policy" "routing_pin_issued_at" "routing_pin_expires_at"
    "routing_pin_reason_code" "routing_pin_detail" "routing_pin_evidence_status"
    "routing_pin_evidence_sha256"
    "judgment_grade" "judgment_grade_status" "judgment_grade_source"
    "struggle_detector_policy_version" "struggle_topology"
    "struggle_error_streak_threshold" "struggle_loop_repeat_threshold"
    "struggle_loop_window" "struggle_no_progress_turn_threshold"
    "spend_envelope_microusd" "spend_evidence" "spend_reserved_microusd"
    "run_coordinator" "run_event_count" "run_event_first_sequence"
    "run_event_last_sequence" "run_event_ledger_sha256" "run_event_status"
    "run_event_terminal_sequence" "spend_target" "task_grade" "thread" "tokens"
    "response_strategy_id" "response_strategy_implementation" "response_strategy_version"
    "caveman_requested_mode" "caveman_mode" "caveman_source" "caveman_decision_reason"
    "caveman_implementation" "caveman_measurement_coverage" "caveman_repository"
    "caveman_revision" "caveman_skill_sha256" "caveman_skill_bytes"
    "caveman_rendered_sha256" "caveman_rendered_bytes" "caveman_source_kind"
    "caveman_resolution_provenance" "mcp_activity_source" "mcp_activity_coverage"
    "mcp_actual_calls"
    "native_command_activity_source" "native_command_activity_coverage"
    "native_north_binary_probe" "native_command_total" "native_command_successful"
    "native_command_failed" "native_command_declined" "native_command_truncated"
    "completed" "passed"
    "topology" "usage_scope" "usage_terminal_count" "usage_total_status"})
(def audited-run-predicates
  (set/union audited-run-single audited-run-multi audited-run-ref))
(def audited-run-event-ref #{"run" "parent_run" "parent_thread"})
(def audited-run-event-single
  #{"kind" "agent_run_ledger_version" "thread" "agent" "run_coordinator"
    "run_event_sequence" "run_event_type" "run_event_observed_at"
    "run_event_source" "run_event_coverage" "run_event_data" "run_event_sha256"
    "caveman_mode" "caveman_source"})
(def audited-run-event-predicates
  (set/union audited-run-event-ref audited-run-event-single))

(def identity-source (slurp-source "sdk/src/identity.ts"))
(def identity-predicates
  (into
   (set/union
    (pair-predicates (section identity-source
                              "export function agentRouteFacts"
                              "function writeHarnessAgentOperation"))
    (pair-predicates (section identity-source
                              "export function agentIdentityFacts"
                              "export function updateAgentRoute")))
   #{(literal-def "cli/agent-fact-internal.clj" 'marker-predicate)
     (literal-def "cli/agent-fact-internal.clj" 'terminal-marker-predicate)
     "outcome" "process_outcome" "delivery_outcome" "delivery_reason"
     "delivery_evidence" "delivery_evidence_sha256"
     "delivery_attestation" "delivery_attestation_sha256"}))

(def guard-source (slurp-source "sdk/src/guard-log.ts"))
(def guard-predicates
  (pair-predicates (section guard-source
                            "export function denialFacts"
                            "export function recordDenial")))

(defn tell-command-predicates [text]
  (set (map second
            (re-seq #"args:\s*\[\s*\"tell\"\s*,[^,\n]+,\s*\"([a-z][a-z0-9_]*)\"" text))))

(def lifecycle-predicates
  (reduce set/union #{}
          (map (comp tell-command-predicates slurp-source)
               ["sdk/src/death.ts" "sdk/src/watchdog.ts" "sdk/src/children.ts"])))

(defn native-hook-predicates [relative]
  (set (map second
            (re-seq #"\btell\s+\"agent:\$ID\"\s+([a-z][a-z0-9_]*)" (slurp-source relative)))))

(def native-predicates
  (set/union (native-hook-predicates "bin/north-on-spawn")
             (native-hook-predicates "bin/north-on-tooluse")))

;; Linear's executable schema is authoritative for this adapter. The first
;; column names domain predicates; bare cardinality/value_kind in columns 2/3
;; are engine metadata and intentionally are not @pred:* domain entries.
(def linear-state-source (slurp-source "sdk/src/integrations/linear/north-state.ts"))
(def linear-schema-section
  (section linear-state-source "export const LINEAR_SCHEMA_FACTS" "] as const;"))
(def linear-cardinality
  (into {} (map (fn [[_ predicate card]] [predicate card])
                (re-seq #"\[\s*\"([a-z][a-z0-9_]*)\"\s*,\s*\"cardinality\"\s*,\s*\"(single|multi)\"\s*\]"
                        linear-schema-section))))
(def linear-kinds
  (merge (zipmap (keys linear-cardinality) (repeat "literal"))
         (into {} (map (fn [[_ predicate kind]] [predicate kind])
                       (re-seq #"\[\s*\"([a-z][a-z0-9_]*)\"\s*,\s*\"value_kind\"\s*,\s*\"(literal|ref)\"\s*\]"
                               linear-schema-section)))))
(def linear-schema-predicates (set (keys linear-cardinality)))
(def linear-fixed-predicates
  (set/union
   linear-schema-predicates
   (pair-predicates (section linear-state-source
                             "export async function ensureLinearLinkFacts"
                             "export async function loadLinkBySubject"))
   (pair-predicates (section linear-state-source
                             "export async function createImportedThread"
                             "export function assertImportableDescription"))
   (set (map second (re-seq #"graph\.put\([^,\n]+,\s*\"([a-z][a-z0-9_]*)\""
                            linear-state-source)))
   (set (map second (re-seq #"graph\.put\([^,\n]+,\s*\"([a-z][a-z0-9_]*)\""
                            (slurp-source "sdk/src/integrations/linear/cli.ts"))))))

(def clock-predicates
  (pair-predicates (section (slurp-source "cli/clock-audit.clj")
                            "(defn- persist-run!"
                            ";; ---- main")))

(def emitted-predicates
  (reduce set/union #{}
          [clj-fixed run-predicates run-event-predicates identity-predicates guard-predicates
           lifecycle-predicates native-predicates linear-fixed-predicates
           clock-predicates]))

(check "registry names are unique"
       (= (count vocab) (count registry))
       (str "rows=" (count vocab) " unique=" (count registry)))
(check "every registry row has valid descriptive metadata"
       (every? (fn [[_ {:keys [card kind doc]}]]
                 (and (#{"single" "multi"} card)
                      (#{"literal" "ref"} kind)
                      (string? doc) (not (str/blank? doc))))
               registry))
(check "bootstrap inventories Fram's executable meta-schema"
       (and (= {:card "single" :kind "literal"}
               (select-keys (registry "cardinality") [:card :kind]))
            (= {:card "single" :kind "literal"}
               (select-keys (registry "value_kind") [:card :kind]))
            (= {:card "single" :kind "literal"}
               (select-keys (registry "entity_kind") [:card :kind]))))

(let [restore-checkpoint (registry "north_restore_checkpoint")]
  (check "snapshot restoration evidence is repeatable literal history"
         (and (= {:card "multi" :kind "literal"}
                 (select-keys restore-checkpoint [:card :kind]))
              (= "content-sealed audit marker for a planned snapshot restoration; paired assert/retract preserves raw provenance without a live graph fact"
                 (:doc restore-checkpoint)))))

(check "worktree ownership sentinels are honest literals"
       (every? #(= {:card "single" :kind "literal"}
                    (select-keys (registry %) [:card :kind]))
               ["worktree_allocation_thread" "worktree_allocation_concern"]))

(let [missing (set/difference emitted-predicates registry-names)]
  (check "all fixed cross-language fact emitters are registered"
         (empty? missing)
         (str "missing=" (pr-str (sort missing)))))

(check "run fact inventory is deliberately cardinality-classified"
       (= audited-run-predicates run-predicates)
       (set-detail audited-run-predicates run-predicates))
(check "single-valued run facts are cataloged single/literal"
       (every? #(= {:card "single" :kind "literal"}
                    (select-keys (registry %) [:card :kind]))
               audited-run-single))
(check "run lineage facts are cataloged single/ref"
       (every? #(= {:card "single" :kind "ref"}
                    (select-keys (registry %) [:card :kind]))
               audited-run-ref))
(check "loop-valued run facts are cataloged multi/literal"
       (every? #(= {:card "multi" :kind "literal"}
                    (select-keys (registry %) [:card :kind]))
               audited-run-multi))
(check "run event inventory is deliberately cardinality-classified"
       (= audited-run-event-predicates run-event-predicates)
       (set-detail audited-run-event-predicates run-event-predicates))
(check "run event scalar facts are cataloged single/literal"
       (every? #(= {:card "single" :kind "literal"}
                    (select-keys (registry %) [:card :kind]))
               audited-run-event-single))
(check "run event entity facts are cataloged single/ref"
       (every? #(= {:card "single" :kind "ref"}
                    (select-keys (registry %) [:card :kind]))
               audited-run-event-ref))

(check "managed identity is single/literal except globally repeatable repo"
       (every? (fn [predicate]
                 (= (if (= predicate "repo")
                      {:card "multi" :kind "literal"}
                      {:card "single" :kind "literal"})
                    (select-keys (registry predicate) [:card :kind])))
               identity-predicates))
(check "native identity hook facts are registered"
       (set/subset? native-predicates registry-names)
       (set-detail native-predicates registry-names))
(check "lifecycle event history is multi/literal"
       (and (= #{"agent_death" "early_exit_children" "stalled" "turn_capped"}
               lifecycle-predicates)
            (every? #(= {:card "multi" :kind "literal"}
                         (select-keys (registry %) [:card :kind]))
                    lifecycle-predicates)))
(check "guard denial facts are single/literal"
       (every? #(= {:card "single" :kind "literal"}
                    (select-keys (registry %) [:card :kind]))
               guard-predicates))

(let [peer-single #{"op" "target" "id" "pred" "value" "resource" "holder" "retryable"}
      peer-multi #{"known_op" "retry_requested" "execution_status" "reply" "failed_at" "failed_by"}]
  (check "peer command singleton fields are cataloged single/literal"
         (every? #(= {:card "single" :kind "literal"}
                      (select-keys (registry %) [:card :kind]))
                 peer-single))
  (check "peer command event and rival-report fields are cataloged multi/literal"
         (every? #(= {:card "multi" :kind "literal"}
                      (select-keys (registry %) [:card :kind]))
                 peer-multi))
  (check "peer retry wake points at exactly one command"
         (= {:card "single" :kind "ref"}
            (select-keys (registry "retry_command") [:card :kind]))))

(check "broadcast contract version is single/literal"
       (= {:card "single" :kind "literal"}
          (select-keys (registry "broadcast_audience_version") [:card :kind])))
(check "broadcast audience members are multi/literal"
       (= {:card "multi" :kind "literal"}
          (select-keys (registry "broadcast_to") [:card :kind])))

(check "Linear adapter cardinality matches its executable schema"
       (every? (fn [[predicate card]] (= card (get-in registry [predicate :card])))
               linear-cardinality))
(check "Linear adapter value kinds match its executable schema"
       (every? (fn [[predicate kind]] (= kind (get-in registry [predicate :kind])))
               linear-kinds))
(check "Linear integration handle is a canonical entity ref"
       (= {:card "single" :kind "ref"}
          (select-keys (registry "linear_link") [:card :kind])))
(check "Linear imported-thread reference semantics stay explicit"
       (and (= {:card "single" :kind "ref"}
               (select-keys (registry "created_by") [:card :kind]))
            (= {:card "single" :kind "ref"}
               (select-keys (registry "lead") [:card :kind]))
            (= {:card "multi" :kind "ref"}
               (select-keys (registry "proposed_by") [:card :kind]))
            (= {:card "multi" :kind "literal"}
               (select-keys (registry "repo") [:card :kind]))))

(let [expected-ids #{"cli-tell" "mcp-tell" "peer-tell" "peer-command-args"
                     "legacy-runmeta" "registry-define"}
      actual-ids (set (map :id dynamic-surfaces))]
  (check "open predicate surfaces are explicit and exhaustively named"
         (= expected-ids actual-ids)
         (set-detail expected-ids actual-ids))
  (check "every open predicate surface has a real path and rationale"
         (every? (fn [{:keys [path reason]}]
                   (and (.isFile (io/file root path))
                        (string? reason) (not (str/blank? reason))))
                 dynamic-surfaces))
  (let [evidence
        {"cli-tell" (str/includes? (slurp-source "bin/north")
                                    "north tell <id> <pred> <val>")
         "mcp-tell" (and (str/includes? (slurp-source "bin/north-mcp")
                                         "(get a \"predicate\")")
                         (str/includes? (slurp-source "bin/north-mcp")
                                        ":name \"tell\""))
         "peer-tell" (and (str/includes? (slurp-source "sdk/src/harness.ts")
                                           "[\"id\", \"pred\", \"value\"]")
                           (str/includes? (slurp-source "cli/north-listen.clj")
                                          "(append! port id pred value)"))
         "peer-command-args" (str/includes? (slurp-source "cli/msg-cli.clj")
                                              "(arg-pred k)")
         "legacy-runmeta" (str/includes? (slurp-source "cli/presence-cli.clj")
                                           "(name k)")
         "registry-define" (str/includes? (slurp-source "cli/pred-cli.clj")
                                            "\"define\"")}]
    (check "every named open surface still has dynamic implementation evidence"
           (and (= expected-ids (set (keys evidence))) (every? true? (vals evidence)))
           (str "missing-evidence=" (pr-str (sort (for [[id ok] evidence :when (not ok)] id)))))))

(check "every variable Clojure fact writer is explicitly classified"
       (= audited-clj-variable-sites clj-variable-sites)
       (set-detail audited-clj-variable-sites clj-variable-sites))

;; Removing the compatibility fallback is sequenced after snapshot + canonical
;; migration + strict audit + restart proof. Until then it must be loudly marked
;; transitional, while executable graph facts retain engine precedence.
(let [launcher (slurp-source "bin/north")]
  (check "launcher cardinality fallback is explicitly transitional until live cutover"
         (and (str/includes? launcher "TRANSITIONAL_SCHEMA_BOOTSTRAP")
              (str/includes? launcher "export FRAM_SINGLE_VALUED=")
              (= 1 (count (re-seq #"export FRAM_SINGLE_VALUED=" launcher))))))

(let [results @checks
      failures (remove :ok results)
      pass (- (count results) (count failures))]
  (doseq [{:keys [label ok detail]} results]
    (println (format "  [%s] %s" (if ok "PASS" "FAIL") label))
    (when (and (not ok) detail) (println (str "         " detail))))
  (println (format "\npredicate registry parity: %d / %d PASS · %d fixed predicate names · %d catalog rows"
                   pass (count results) (count emitted-predicates) (count registry)))
  (System/exit (if (empty? failures) 0 1)))
