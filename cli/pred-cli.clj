;; pred-cli.clj — the human and lint surface over Fram's executable predicate
;; entities.  A predicate named p is represented only by @p; cardinality,
;; value_kind, acyclic, doc, entity_kind, and extension metadata all live there.
;; The historical @pred:p descriptive registry is intentionally never read.
;;
;; VOCAB below is migration bootstrap material, not a second live authority.
;; `seed` fills those values into executable entities. Connected reads, census,
;; and strict lint use only graph facts; `lint-offline` is the deliberately weak
;; bootstrap-only source check for CI without a coordinator.
;;
;; usage:
;;   bb pred-cli.clj <port> seed                                  register the whole vocabulary ONCE
;;   bb pred-cli.clj <port> define <name> <single|multi> <literal|ref> ["doc"] [minted_by]
;;   bb pred-cli.clj <port> alias  ...                            rejected: executable predicate aliases are unsound
;;   bb pred-cli.clj <port> ls                                    graph-generated schema projection
;;   bb pred-cli.clj <port> show   <name>                         one exact executable predicate
;;   bb pred-cli.clj <port> lint   [--strict]                     compare source literals with graph authority
;;   bb pred-cli.clj <port> lint-offline [--strict]               weak bootstrap-only source check
;;   bb pred-cli.clj <port> census [logpath] [--strict]           compare log literals with graph authority
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str] '[clojure.walk :as walk])

;; shared coord substrate (Foundation Part B): the wire helpers live once in cli/coord.clj.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op  north.coord/send-op)
(def append!  north.coord/append!)
(def put!     north.coord/put!)
(def retract! north.coord/retract!)
(def resolved north.coord/resolved)
(def many     north.coord/many)

(defn pred-ent [nm] (str "@" nm))
(defn pred-name [ent]
  (let [s (str ent)] (if (str/starts-with? s "@") (subs s 1) s)))

;; Predicate subjects are not thread/name-resolvable. Query the exact subject.
(defn exact-values [port subject predicate]
  (->> (:ok (send-op port {:op :query
                           :query {:find "v"
                                   :rules [{:head {:rel "v" :args [{:var "v"}]}
                                            :body [{:rel "triple" :args [subject predicate {:var "v"}]}]}]}}))
       (map first)))

(defn exact-one [port subject predicate]
  (first (exact-values port subject predicate)))

(defn exact-facts [port subject]
  (->> (:ok (send-op port {:op :query
                           :query {:find "p,v"
                                   :rules [{:head {:rel "p,v" :args [{:var "p"} {:var "v"}]}
                                            :body [{:rel "triple" :args [subject {:var "p"} {:var "v"}]}]}]}}))
       (map (fn [row] [(nth row 0) (nth row 1)]))
       (sort-by (juxt first second))))

;; Supersede explicitly so bootstrap works even before the meta-predicates have
;; acquired their own executable cardinality facts in this same seed operation.
(defn set-1! [port te p v]
  (doseq [old (exact-values port te p)] (retract! port te p old))
  (put! port te p (str v)))

;; ============================================================================
;; VOCAB — bootstrap + offline lint inventory. [name card kind doc]
;; Drawn from the cross-language writer inventory: Clojure coordination CLIs,
;; SDK identity/run/lifecycle telemetry, native hooks, and the Linear bridge.
;; ref = the object is an @-ref to another entity; literal = an interned value.
;; ============================================================================
(def VOCAB
  [;; --- executable schema meta-predicates (the schema describes itself) ---
   ["cardinality" "single" "literal" "executable Fram cardinality: single or multi"]
   ["value_kind" "single" "literal" "executable Fram object kind: literal or ref"]
   ["acyclic" "single" "literal" "true makes a ref-valued edge cycle-free"]
   ["entity_kind" "single" "literal" "open structural taxonomy; extensions use namespace/name"]
   ["entity_kind_name" "single" "literal" "canonical value represented by an @entity-kind:* definition"]
   ;; Historical @pred:* facts remain ordinary data until a later archival pass;
   ;; registering their predicates here makes that history schema-complete without
   ;; making it authoritative.
   ["pred_cardinality" "single" "literal" "single|multi — is this predicate single-valued?"]
   ["pred_value_kind"  "single" "literal" "literal|ref — interned value vs @-ref object"]
   ["doc"         "single" "literal" "human description of a predicate"]
   ["minted_by"   "single" "literal" "who registered this predicate"]
   ["minted_at"   "single" "literal" "instant the predicate was registered"]
   ["same_as"     "multi"  "ref"     "historical descriptive-alias edge; executable predicate identity never follows it"]
   ;; Cross-cutting operational predicates discovered by strict source lint.
   ["burn_limit_microusd_per_hour" "single" "literal" "maximum reserved spend burn admitted per rolling hour"]
   ["forced" "single" "literal" "whether an operator explicitly forced a guarded reset"]
   ["lane" "single" "literal" "managed lane identifier associated with a resource reservation"]
   ["north_restore_checkpoint" "multi" "literal" "content-sealed audit marker for a planned snapshot restoration; paired assert/retract preserves raw provenance without a live graph fact"]
   ["period" "single" "literal" "budget/accounting period identifier"]
   ["pid" "single" "literal" "operating-system process id associated with a live reservation"]
   ["reserved_microusd" "single" "literal" "currently reserved spend in integer micro-USD"]
   ["preflight_cause" "single" "literal" "typed terminal cause when provider execution ended during preflight"]
   ;; --- agent / session / role (presence-cli, dispatch-guard) ---
   ["agent"          "single" "literal" "handle this session/run belongs to"]
   ["dir"            "single" "literal" "working directory of a session"]
   ["session_id"     "single" "literal" "session id of a presence registration"]
   ["started_at"     "single" "literal" "instant a session started"]
   ["task"           "single" "literal" "current task description"]
   ["role"           "single" "literal" "functional agent responsibility"]
   ["model"          "single" "literal" "model id an agent runs"]
   ["effort"         "single" "literal" "reasoning-effort knob"]
   ["provider_target" "single" "literal" "exact provider account/target active for an agent or run"]
   ["live_input" "single" "literal" "resolved adapter live-input capability (streaming|unsupported)"]
   ["live_input_state" "single" "literal" "current managed live-input route state (pending|armed|frozen)"]
   ["live_input_epoch" "single" "literal" "opaque UUIDv4 generation for one exact managed route publication"]
   ["target_identity_manifest_sha256" "single" "literal" "exact committed managed-route manifest against which a steer was admitted"]
   ["delivery_rejection" "multi" "literal" "bounded canonical evidence for a permanently impossible recipient delivery"]
   ["delivery_rejected_by" "multi" "literal" "recipient whose permanently impossible delivery was terminally rejected, never acknowledged"]
   ["display_handle" "single" "literal" "stable human-facing semantic agent handle"]
   ["display_name"   "single" "literal" "human-facing agent or entity label"]
   ["composition_kind" "single" "literal" "managed Gaffer composition kind (preset|bespoke); absent on native sessions"]
   ["composition_id" "single" "literal" "Gaffer preset or bespoke composition id"]
   ["composition_overrides" "single" "literal" "JSON array of preset axes deliberately overridden"]
   ["composition_override_reason" "single" "literal" "full rationale for a preset override"]
   ["nearest_preset" "single" "literal" "nearest catalog preset considered for a bespoke composition"]
   ["bespoke_reason" "single" "literal" "why no catalog preset honestly fits a bespoke composition"]
   ["promotion_candidate" "single" "literal" "whether a bespoke composition should be considered for promotion"]
   ["composition_contract_sha256" "single" "literal" "SHA-256 fingerprint of a bespoke Gaffer authority contract"]
   ["composition_contract_fingerprint_version" "single" "literal" "canonical bespoke-contract fingerprint algorithm version"]
   ["composition_contract_fingerprint_domain" "single" "literal" "domain separator for the canonical bespoke-contract fingerprint"]
   ["identity_manifest_sha256" "single" "literal" "commit marker for an exact read-back-acknowledged managed identity projection"]
   ["terminal_manifest_sha256" "single" "literal" "commit marker for an exact managed process/delivery terminal projection"]
   ["goal"           "single" "literal" "bounded objective currently assigned to a managed agent"]
   ["coordinator"    "single" "literal" "spawning coordinator handle for a managed agent"]
   ["applied_capability" "multi" "literal" "canonical Gaffer capability actually enforced for a run"]
   ["applied_comms_contract_sha256" "single" "literal" "SHA-256 fingerprint of the Gaffer communications contract applied to a run"]
   ["context_tokens" "single" "literal" "agent context window size"]
   ["lifecycle"      "single" "literal" "agent lifecycle (standing|ephemeral|…)"]
   ["supervisor"     "single" "literal" "supervising agent handle"]
   ["generation"     "single" "literal" "agent context generation counter"]
   ["last_run_at"    "single" "literal" "instant of the agent's last run"]
   ["spawned_at"     "single" "literal" "instant an agent was spawned"]
   ["prev_input_tokens"      "single" "literal" "input tokens of the previous run"]
   ["playbook_count_at_boot" "single" "literal" "playbook size at boot (drift baseline)"]
   ["needs_rotation" "single" "literal" "legacy flag: do not reuse; replace with a fresh managed lane"]
   ["pinned"         "single" "literal" "flag: agent surfaces first in the roster"]
   ["pin_reason"     "single" "literal" "why an agent is pinned"]
   ["current_thread" "single" "literal" "the agent's current thread focus"]
   ["worktree"        "single" "literal" "abspath of a lane's git worktree"]
   ["branch"          "single" "literal" "git branch a lane's worktree is on"]
   ["worktree_orphaned" "multi" "literal" "a resolved lane's worktree left for manual salvage (dirty/crash)"]
   ["worktree_allocation_version" "single" "literal" "physical worktree allocation record contract version"]
   ["worktree_repository_identity" "single" "literal" "content-free digest identity of the exact git common-dir"]
   ["worktree_git_common_dir" "single" "literal" "absolute canonical git common-dir owned by an allocation"]
   ["worktree_source_root" "single" "literal" "absolute checkout root from which an allocation was provisioned"]
   ["worktree_repository_layout" "single" "literal" "source repository layout: standalone or linked"]
   ["worktree_durable_ref" "single" "literal" "full durable local refs/heads name allocated to a worktree"]
   ["worktree_base_oid" "single" "literal" "exact full Git OID used as the allocation base"]
   ["worktree_head_oid" "single" "literal" "exact full Git OID observed for the allocated worktree"]
   ["worktree_allocation_run" "single" "ref" "managed run that requested a physical worktree allocation"]
   ["worktree_allocation_agent" "single" "ref" "managed agent that owns a physical worktree allocation"]
   ["worktree_allocation_thread" "single" "ref" "exact thread owner or explicit ad-hoc sentinel entity"]
   ["worktree_allocation_concern" "single" "ref" "exact concern owner or explicit unattributed sentinel entity"]
   ["worktree_allocation_nonce" "single" "literal" "UUIDv4 identity of one physical allocation generation"]
   ["worktree_allocation_lease" "single" "literal" "canonical content-free record-only allocation lease"]
   ["worktree_provider_authority_profile" "multi" "literal" "append-only canonical provider target authority profile"]
   ["worktree_allocation_event" "multi" "literal" "append-only canonical physical allocation lifecycle event"]
   ["worktree_allocation_manifest_sha256" "single" "literal" "commit marker for an exact read-back-acknowledged allocation projection"]
   ["active_workflow" "single" "literal" "the agent's current workflow focus"]
   ["exclusivity"    "single" "literal" "exclusive|inclusive role occupancy"]
   ["holds"          "multi"  "ref"     "roles (@role:*) an agent holds"]
   ["watches"        "multi"  "ref"     "threads (@…) an agent subscribes to"]
   ["lease"          "single" "literal" "coordinator-issued holder, expiry, and epoch lease tuple"]
   ["stalled"        "multi"  "literal" "observed agent stream-stall event"]
   ["turn_capped"    "multi"  "literal" "observed agent turn-cap event"]
   ["early_exit_children" "multi" "literal" "agent exit event naming children still live"]
   ["agent_death"    "multi"  "literal" "agent-death event recorded on a thread or shared roster"]
   ["outcome"        "single" "literal" "terminal result for a thread, agent, or run"]
   ["process_outcome" "single" "literal" "terminal state of the provider process or preflight"]
   ["delivery_outcome" "single" "literal" "delivery state: unverified, run-scoped reported, legacy verified, or blocked; current shared-UID lanes cannot issue verified"]
   ["delivery_reason" "single" "literal" "stable machine reason for the delivery outcome"]
   ["delivery_evidence" "single" "literal" "canonical self-reported done-bar evidence snapshot for one managed delivery"]
   ["delivery_evidence_sha256" "single" "literal" "SHA-256 of the exact canonical delivery evidence snapshot"]
   ["delivery_attestation" "single" "literal" "legacy verifier attestation envelope; current shared-UID lanes cannot issue or promote it"]
   ["delivery_attestation_sha256" "single" "literal" "SHA-256 of a legacy canonical delivery attestation"]
   ["run_reservation_version" "multi" "literal" "conflict-visible version of the pre-execution managed run reservation"]
   ["run_reservation_agent" "multi" "ref" "conflict-visible exact managed reporter reserved for a run"]
   ["run_reservation_contract_origin" "multi" "literal" "conflict-visible accepted or worker-defined contract origin committed before execution"]
   ["run_reservation_done_when" "multi" "literal" "conflict-visible canonical JSON baseline done-bar set committed before execution"]
   ["run_reservation_thread" "multi" "ref" "conflict-visible exact driven thread reserved for a run"]
   ["run_capability_sha256" "multi" "literal" "conflict-visible digest of the unpersisted per-run evidence capability"]
   ["run_reserved_at" "multi" "literal" "conflict-visible strict UTC instant at which a run subject was reserved"]
   ["run_reservation_manifest_sha256" "multi" "literal" "conflict-visible digest committing the exact run reservation projection"]
   ["run_bar_evidence" "multi" "literal" "canonical writer-scoped self-reported done-bar observation for one run/thread/reporter"]
   ["learning"       "multi"  "literal" "playbook learnings accumulated on a thread"]
   ["progress"       "multi"  "literal" "append-only progress update on a thread"]
   ["done_when"      "multi"  "literal" "probe and expected result that define completion"]
   ["bar_evidence"   "multi"  "literal" "observed result satisfying a done_when bar"]
   ["judgment_grade" "single" "literal" "dispatcher's S/M/L estimate of a thread's judgment saturation (s|m|l)"]
   ["judgment_grade_status" "single" "literal" "run-local validation status of the admission-time judgment grade (valid|unavailable|invalid)"]
   ["judgment_grade_source" "single" "literal" "run-local origin of the judgment-grade snapshot (thread|ad-hoc)"]
   ["owner"          "single" "literal" "organizational owner of a thread"]
   ["source"         "single" "literal" "system from which an entity originated"]
   ["created_by"     "single" "ref"     "person or agent that created an entity"]
   ["lead"           "single" "ref"     "person or agent accountable for an entity"]
   ["proposed_by"    "multi"  "ref"     "people or agents that proposed an entity"]
   ["updated_at"     "single" "literal" "most recent externally meaningful update date"]
   ["committed"      "single" "literal" "date a thread became committed work"]
   ;; --- messaging (msg-cli, inbox-peek, north-listen) ---
   ["from"     "single" "literal" "sender handle of a message"]
   ["to"       "single" "literal" "recipient handle/role/wildcard of a message"]
   ["broadcast_audience_version" "single" "literal" "finite send-time broadcast audience contract version"]
   ["broadcast_to" "multi" "literal" "concrete session handle included in a finite broadcast audience"]
   ["subject"  "single" "literal" "message subject line"]
   ["body"     "single" "literal" "message body (text or command envelope)"]
   ["sent_at"  "single" "literal" "instant a message was sent"]
   ["schema"   "single" "literal" "JSON schema a message's reply must satisfy"]
   ["acked_at" "single" "literal" "instant a message was acked"]
   ["acked_by" "multi"  "literal" "handles that have acked this message"]
   ["known_op" "multi" "literal" "peer command operations currently admitted by the reactor"]
   ["op"       "single" "literal" "operation carried by a peer command"]
   ["target"   "single" "literal" "peer-command routing address or guard target"]
   ["id"       "single" "literal" "subject argument carried by a peer tell command"]
   ["pred"     "single" "literal" "predicate argument carried by a peer tell command"]
   ["value"    "single" "literal" "value argument carried by a peer tell command"]
   ["resource" "single" "literal" "resource argument carried by a peer acquire command"]
   ["holder"   "single" "literal" "holder argument carried by a peer acquire command"]
   ["retry_command" "single" "ref" "command reactivated by a retry wake entity"]
   ["retry_requested" "multi" "literal" "instant an explicit command retry was requested"]
   ["execution_status" "multi" "literal" "peer-command execution status event; rival terminal reports may coexist"]
   ["reply"     "multi" "literal" "peer-command execution diagnostic"]
   ["retryable" "single" "literal" "whether the current peer-command failure may be retried"]
   ["failed_at" "multi" "literal" "instant of a peer-command failure report"]
   ["failed_by" "multi"  "literal" "handles that reported a terminal command failure"]
   ;; --- concerns (concern-cli) ---
   ["title"   "single" "literal" "human-readable title (presence ⇒ a thread)"]
   ["kind"    "single" "literal" "structural kind tag (e.g. concern)"]
   ["intent"  "single" "literal" "what a concern is building"]
   ["repo"    "multi"  "literal" "repository associated with an entity; threads may span repositories"]
   ["status"  "single" "literal" "DERIVED concern status (max `reached` level); legacy single-write retained for lint only"]
   ["reached" "multi"  "literal" "monotone maturity level a concern has reached (exploring|building|likely-to-land|landed); status = max level (decision 8: status is derived, never set)"]
   ["driver"  "single" "ref"     "the @handle currently driving a thread/concern (presence ⇒ active)"]
   ["touches" "multi"  "literal" "file paths a concern touches (display label + the path-string footprint fallback for non-flipped repos)"]
   ["footprint" "multi" "ref"    "code NODE (@mod#n) in a concern's footprint — the cross-frame bridge (thread 019f1010-2705); asserted on the repo's warm CODE port, joined via the daemon's calls_defn blast closure (calls_defn itself is a fram daemon-internal derived edge, not a :7977 fact)"]
   ["code_port" "single" "literal" "port of the repo's warm code daemon, so a reader finds where a concern's footprint code store lives"]
   ["code_log" "single" "literal" "canonical log identity served by a concern's per-repo code daemon"]
   ;; --- fan-out / barrier (north-map) ---
   ["batch_kind"     "single" "literal" "kind of fan-out batch"]
   ["expected_count" "single" "literal" "N workers expected in a fan-out batch"]
   ["barrier_k"      "single" "literal" "K threshold for the K-of-N barrier"]
   ["barrier_status" "single" "literal" "derived barrier state of a batch"]
   ["role_template"  "single" "literal" "role-slug template for a fan-out batch"]
   ["created_at"     "single" "literal" "creation instant"]
   ["done_schema"    "single" "literal" "JSON schema a batch's DONE payloads must satisfy"]
   ["done_batch"     "single" "ref"     "the @batch this DONE belongs to"]
   ["done_worker"    "single" "literal" "handle of the worker that reported DONE"]
   ["done_payload"   "single" "literal" "a worker's DONE payload"]
   ["done_at"        "single" "literal" "instant a worker reported DONE"]
   ["worker"         "multi"  "literal" "worker handles spawned under a batch"]
   ;; --- run telemetry (presence-cli runmeta / north-reconcile) ---
   ["tokens"         "single" "literal" "exact provider-authoritative run total; absent when unknown"]
   ["ended_at"       "single" "literal" "instant a run ended"]
   ["at"             "single" "literal" "instant a run was recorded"]
   ["input_tokens"   "single" "literal" "run input tokens"]
   ["output_tokens"  "single" "literal" "run output tokens"]
   ["cache_read_tokens"   "single" "literal" "run cache-read tokens"]
   ["cache_create_tokens" "single" "literal" "run cache-create tokens"]
   ["cached_input_tokens" "single" "literal" "run cached-input subset (included in input_tokens)"]
   ["reasoning_output_tokens" "single" "literal" "run reasoning-output subset (included in output_tokens)"]
   ["agent_run_ledger_version" "single" "literal" "version of the privacy-bounded append-only AgentRun observation contract"]
   ["run_event_status" "single" "literal" "whether a finalized append-only run event ledger is complete or unavailable"]
   ["response_strategy_id" "single" "literal" "response-compression strategy identity, separate from Gaffer routing axes"]
   ["response_strategy_implementation" "single" "literal" "attested response strategy implementation"]
   ["response_strategy_version" "single" "literal" "immutable response strategy implementation version"]
   ["caveman_requested_mode" "single" "literal" "managed Caveman mode requested for this run"]
   ["caveman_mode" "single" "literal" "managed Caveman mode resolved for this run"]
   ["caveman_source" "single" "literal" "managed Caveman request, env, or default precedence source"]
   ["caveman_decision_reason" "single" "literal" "explicit, inherited, or default-off-unproven-savings decision reason"]
   ["caveman_implementation" "single" "literal" "attested Caveman implementation or disabled state"]
   ["caveman_measurement_coverage" "single" "literal" "coverage of before/after Caveman rendering measurements"]
   ["caveman_repository" "single" "literal" "privacy-safe canonical Caveman repository identity"]
   ["caveman_revision" "single" "literal" "full immutable Caveman repository revision"]
   ["caveman_skill_sha256" "single" "literal" "SHA-256 of immutable Caveman skill artifact"]
   ["caveman_skill_bytes" "single" "literal" "byte count of immutable Caveman skill artifact"]
   ["caveman_rendered_sha256" "single" "literal" "SHA-256 of rendered Caveman instructions"]
   ["caveman_rendered_bytes" "single" "literal" "byte count of rendered Caveman instructions"]
   ["caveman_source_kind" "single" "literal" "git-object or immutable-file Caveman artifact source"]
   ["caveman_resolution_provenance" "single" "literal" "explicit or local-dev Caveman resolution path"]
   ["mcp_activity_source" "single" "literal" "provider adapter source for actual MCP activity"]
   ["mcp_activity_coverage" "single" "literal" "exact, partial, or unknown actual MCP observation coverage"]
   ["mcp_actual_calls" "single" "literal" "deduplicated actual MCP calls observed for this run"]
   ["mcp_actual_tool" "multi" "literal" "argument-free JSON server, tool, and actual call count"]
   ["parent_run" "single" "ref" "exact parent run identity recorded without lineage inference"]
   ["parent_thread" "single" "ref" "exact parent thread identity recorded without lineage inference"]
   ["run_coordinator" "single" "literal" "exact coordinator handle responsible for the run"]
   ["prompt_composition_version" "single" "literal" "version of the prompt construction contract; prompt content is never retained"]
   ["prompt_composition_sha256" "single" "literal" "SHA-256 of the privacy-bounded prompt composition identity"]
   ["capability_class" "single" "literal" "canonical capability class used to construct the run prompt"]
   ["prompt_capability_count" "single" "literal" "number of canonical capabilities applied during prompt construction"]
   ["prompt_stable_prefix_bytes" "single" "literal" "exact UTF-8 bytes in the stable shared prompt prefix"]
   ["prompt_unique_tail_bytes" "single" "literal" "exact UTF-8 bytes in the run-specific prompt tail"]
   ["prompt_total_bytes" "single" "literal" "exact UTF-8 bytes in the complete constructed prompt"]
   ["prompt_byte_measurement_source" "single" "literal" "authoritative source of prompt byte measurements"]
   ["prompt_stable_prefix_tokens" "single" "literal" "authoritative tokenizer count for the stable prompt prefix when available"]
   ["prompt_unique_tail_tokens" "single" "literal" "authoritative tokenizer count for the unique prompt tail when available"]
   ["prompt_total_composition_tokens" "single" "literal" "authoritative tokenizer count for the full prompt when available"]
   ["prompt_token_measurement_status" "single" "literal" "observed or unknown prompt tokenizer coverage"]
   ["prompt_token_measurement_source" "single" "literal" "authoritative tokenizer source or stable unavailable reason"]
   ["provider_context_window_tokens" "single" "literal" "observed provider model context-window metadata; never an allocation input"]
   ["context_window_effective_from" "single" "literal" "catalog effective date for observed context-window metadata"]
   ["context_window_status" "single" "literal" "observed or unknown provider context-window metadata coverage"]
   ["context_window_source" "single" "literal" "catalog source or stable unavailable reason for context-window metadata"]
   ["effective_context_budget_tokens" "single" "literal" "observed effective context budget when an authoritative producer supplies it"]
   ["context_budget_status" "single" "literal" "observed or unknown effective context-budget coverage"]
   ["context_budget_source" "single" "literal" "authoritative context-budget source or stable unavailable reason"]
   ["compaction_policy" "single" "literal" "observed managed compaction policy"]
   ["compaction_policy_version" "single" "literal" "versioned managed compaction policy identity"]
   ["run_event_count" "single" "literal" "number of committed events in the finalized run ledger"]
   ["run_event_first_sequence" "single" "literal" "first sequence in the finalized run ledger"]
   ["run_event_last_sequence" "single" "literal" "last sequence in the finalized run ledger"]
   ["run_event_terminal_sequence" "single" "literal" "terminal_cleanup sequence that finalized the run ledger"]
   ["run_event_ledger_sha256" "single" "literal" "SHA-256 committing the ordered event digest sequence"]
   ["run_observation_coverage" "multi" "literal" "canonical JSON source coverage statement for the finalized run ledger"]
   ["run" "single" "ref" "exact run header referenced by an append-only run event"]
   ["run_event_sequence" "single" "literal" "zero-based append-only event sequence within one run"]
   ["run_event_type" "single" "literal" "typed AgentRun observation class from the versioned ledger contract"]
   ["run_event_observed_at" "single" "literal" "UTC instant at which the event source observed the event"]
   ["run_event_source" "single" "literal" "canonical adapter or harness source of an event observation"]
   ["run_event_coverage" "single" "literal" "event source coverage: exact, partial, or unknown"]
   ["run_event_data" "single" "literal" "strict allowlisted content-free JSON measurements and identifiers for one event"]
   ["run_event_sha256" "single" "literal" "SHA-256 binding an event's identity, ordering, source, coverage, and data"]
   ["usage_terminal_count" "single" "literal" "authoritative provider usage terminals observed"]
   ["usage_scope" "single" "literal" "provider-declared scope of terminal usage"]
   ["usage_total_status" "single" "literal" "whether aggregate tokens are exact or why unknown"]
   ["duration_ms"    "single" "literal" "run wall duration (ms)"]
   ["provider_duration_ms" "single" "literal" "provider-reported duration when available (ms)"]
   ["num_turns"      "single" "literal" "agent turns in a run"]
   ["compactions"    "single" "literal" "automatic context-compaction boundaries observed during a run"]
   ["compaction_count" "single" "literal" "automatic context-compaction boundaries observed, including exact zero"]
   ["compaction_evidence" "single" "literal" "authoritative compaction event source"]
   ["provider"       "single" "literal" "provider that executed a run"]
   ["execution_source" "single" "literal" "whether North or a provider-native surface originated the run"]
   ["execution_transport" "single" "literal" "exact provider transport that executed the run"]
   ["provider_session_persistence" "single" "literal" "whether the provider session was persisted, ephemeral, or unknown"]
   ["north_session_id" "single" "literal" "redacted North-managed provider session identifier"]
   ["thread_provenance" "single" "literal" "whether the run thread identity is exact, ad-hoc, or unknown"]
   ["turn_provenance" "single" "literal" "whether turn evidence came from a provider terminal, pre-provider phase, or is unknown"]
   ["routing_admission_receipt_version" "single" "literal" "version of the immutable route admission receipt"]
   ["routing_request_sha256" "single" "literal" "SHA-256 of the canonical routing request"]
   ["routing_assessment_sha256" "single" "literal" "SHA-256 of the canonical routing assessment"]
   ["routing_policy_sha256" "single" "literal" "SHA-256 of the routing policy used at admission"]
   ["provider_catalogs_sha256" "single" "literal" "SHA-256 of provider catalogs used at admission"]
   ["staffing_catalog_sha256" "single" "literal" "SHA-256 of the staffing catalog used at admission"]
   ["routing_assessment_status" "single" "literal" "whether a routing assessment was available at admission"]
   ["routing_override_evidence_status" "single" "literal" "whether route override evidence was required and available"]
   ["routing_override_exception_code" "single" "literal" "canonical admission override exception code"]
   ["routing_receipt_override" "multi" "literal" "one axis changed from the stock route in the admission receipt"]
   ["routing_assessment_policy" "single" "literal" "version of the routing assessment policy"]
   ["routing_derived_tier" "single" "literal" "minimum semantic tier derived by routing assessment"]
   ["routing_derived_reasoning" "single" "literal" "minimum reasoning derived by routing assessment"]
   ["routing_rule_code" "multi" "literal" "canonical routing assessment rule that fired"]
   ["routing_selected_tier" "single" "literal" "semantic tier selected after assessment"]
   ["routing_selected_reasoning" "single" "literal" "reasoning level selected after assessment"]
   ["routing_exception_code" "single" "literal" "canonical routing exception code"]
   ["routing_exception_detail" "single" "literal" "bounded routing exception detail"]
   ["routing_exceptional_deliberation" "single" "literal" "explicit exceptional deliberation selected for a route"]
   ["routing_pin_policy" "single" "literal" "version of the route pin policy"]
   ["routing_pin_issued_at" "single" "literal" "instant route pin evidence was issued"]
   ["routing_pin_expires_at" "single" "literal" "instant route pin evidence expires"]
   ["routing_pin_reason_code" "single" "literal" "canonical reason code for a route pin"]
   ["routing_pin_detail" "single" "literal" "bounded operator detail for a route pin"]
   ["routing_pin" "multi" "literal" "canonical JSON pin entry for one explicitly fixed routing axis"]
   ["routing_pin_evidence_status" "single" "literal" "whether route pin evidence was valid or unavailable"]
   ["routing_pin_evidence_sha256" "single" "literal" "SHA-256 of canonical route pin evidence"]
   ["effective_authority_provider" "single" "literal" "provider whose exact executable authority surface was admitted for the final run route"]
   ["effective_native_multi_agent" "single" "literal" "native provider subagent authority admitted for the run"]
   ["effective_authoring_hooks" "single" "literal" "authoring-hook authority boundary admitted for the final run route"]
   ["effective_live_input" "single" "literal" "live-input capability admitted for the final run route"]
   ["effective_authority_capability" "multi" "literal" "canonical Gaffer capability compiled into the final provider executable surface"]
   ["effective_north_enabled_tool" "multi" "literal" "North MCP tool enabled in the final provider executable surface"]
   ["effective_sandbox" "single" "literal" "provider sandbox admitted for the final run route"]
   ["effective_web" "single" "literal" "provider web authority admitted for the final run route"]
   ["effective_builtin" "multi" "literal" "provider built-in tool enabled in the final executable surface"]
   ["effective_mcp_tool" "multi" "literal" "fully qualified MCP tool enabled in the final executable surface"]
   ["thread"         "single" "literal" "thread handle driven by a run, or (ad-hoc)"]
   ["posture"        "single" "literal" "execution posture recorded for a run"]
   ["provider_reason" "single" "literal" "explanation for the provider route selected"]
   ["model_availability_target" "single" "literal" "exact provider target whose supportedModels evidence admitted the final route"]
   ["model_availability_source" "single" "literal" "provider control surface that observed exact model availability"]
   ["model_availability_observed_at" "single" "literal" "instant exact model availability was observed"]
   ["model_availability_model" "single" "literal" "exact model matched by supportedModels admission"]
   ["model_availability_digest" "single" "literal" "SHA-256 digest of the admitted target-scoped model observation"]
   ["requested_provider" "single" "literal" "provider preference originally requested"]
   ["requested_target" "single" "literal" "exact provider target requested for a run"]
   ["requested_tier" "single" "literal" "semantic model tier originally requested"]
   ["requested_model" "single" "literal" "provider model originally requested"]
   ["requested_effort" "single" "literal" "reasoning effort originally requested"]
   ["allocation_mode" "single" "literal" "account allocation policy active for a run"]
   ["entitlement_pressure" "single" "literal" "subscription entitlement pressure observed for the selected route"]
   ["allocation_evidence" "multi" "literal" "JSON allocation evidence for one candidate provider target"]
   ["fallback_count" "single" "literal" "provider fallbacks before side effects"]
   ["fallback_path"  "single" "literal" "provider path attempted by a run"]
   ["fallback_target_path" "single" "literal" "provider target path attempted by a run"]
   ["fallback_reason" "multi" "literal" "JSON reason for one pre-side-effect route fallback"]
   ["envelope_scope" "multi" "literal" "resource-envelope scope charged by a run"]
   ["envelope_retries" "single" "literal" "resource-envelope retries consumed by a run"]
   ["envelope_advisory" "multi" "literal" "non-blocking resource-envelope advisory"]
   ["spend_target" "single" "literal" "resource-budget target reserved for a run"]
   ["spend_envelope_microusd" "single" "literal" "maximum resource-budget envelope admitted for a run"]
   ["spend_reserved_microusd" "single" "literal" "resource-budget amount reserved before execution"]
   ["spend_evidence" "single" "literal" "whether resource-budget settlement used exact or conservative evidence"]
   ["requested_role" "single" "literal" "Gaffer role requested in routing metadata"]
   ["routing_tier" "single" "literal" "semantic tier requested in routing metadata"]
   ["requested_reasoning" "single" "literal" "reasoning level requested in routing metadata"]
   ["routing_posture" "single" "literal" "delivery posture requested in routing metadata"]
   ["task_grade" "single" "literal" "real-world task seniority grade used for routing"]
   ["topology" "single" "literal" "worker or orchestrator topology requested for a run"]
   ["domain_requirement" "multi" "literal" "domain capability requested for a run"]
   ["composition_override" "multi" "literal" "one Gaffer preset axis overridden for a run"]
   ["prompt_composition_applied" "single" "literal" "whether a Gaffer prompt composition was applied"]
   ["applied_role_contract" "single" "literal" "Gaffer role contract actually applied to a run"]
   ["applied_bespoke_contract_sha256" "single" "literal" "SHA-256 of the bespoke Gaffer contract actually applied"]
   ["applied_bespoke_contract_fingerprint_version" "single" "literal" "canonical bespoke-contract fingerprint version actually applied"]
   ["applied_bespoke_contract_fingerprint_domain" "single" "literal" "bespoke-contract fingerprint domain separator actually applied"]
   ["applied_preset_override" "multi" "literal" "one preset axis actually overridden in the applied prompt"]
   ["applied_preset_override_reason_sha256" "single" "literal" "SHA-256 of the applied preset-override rationale"]
   ["applied_task_grade" "single" "literal" "task grade actually applied to the prompt"]
   ["applied_topology" "single" "literal" "topology actually applied to the prompt"]
   ["applied_routing_tier" "single" "literal" "semantic tier actually applied to the prompt"]
   ["applied_reasoning" "single" "literal" "reasoning level actually applied to the prompt"]
   ["applied_posture" "single" "literal" "delivery posture actually applied to the prompt"]
   ["applied_domain_requirement" "multi" "literal" "domain capability actually applied to the prompt"]
   ["applied_domain_requirement_count" "single" "literal" "number of applied domain requirements, including explicit zero"]
   ["model_delta_provider" "single" "literal" "provider named by an applied model-delta contract"]
   ["model_delta_model" "single" "literal" "model named by an applied model-delta contract"]
   ["model_delta_kind" "single" "literal" "kind of applied model delta"]
   ["model_delta_path" "single" "literal" "source path of an applied model-delta contract"]
   ["model_delta_reason" "single" "literal" "rationale from an applied model-delta contract"]
   ["error_count" "single" "literal" "tool-result errors observed during a run or mined session"]
   ["struggle" "multi" "literal" "harness-observed struggle sensor that fired during a run (consecutive_errors|tool_loop|no_progress)"]
   ["struggle_detector_policy_version" "single" "literal" "version of the provider-neutral struggle detector policy used for a run"]
   ["struggle_topology" "single" "literal" "topology whose struggle thresholds were effective for a run"]
   ["struggle_error_streak_threshold" "single" "literal" "effective consecutive tool-error threshold for a run"]
   ["struggle_loop_repeat_threshold" "single" "literal" "effective identical-call repeat threshold for a run"]
   ["struggle_loop_window" "single" "literal" "effective recent-call window for tool-loop detection"]
   ["struggle_no_progress_turn_threshold" "single" "literal" "effective assistant-turn threshold for no-progress detection"]
   ["scope_escalation" "multi" "literal" "versioned JSON checkpoint for a managed scope-overrun/needs-replan escalation"]
   ["escalation_tier" "single" "literal" "legacy final escalation tier (historical reads only)"]
   ["escalation_count" "single" "literal" "legacy in-flight escalation count (historical reads only)"]
   ["escalation_path" "single" "literal" "legacy ordered escalation path (historical reads only)"]
   ["escalation_reasons" "single" "literal" "legacy escalation reasons (historical reads only)"]
   ["stop_reason"    "single" "literal" "why a run stopped"]
   ["wall_s"         "single" "literal" "run wall duration (s)"]
   ["estimate_output_tokens" "single" "literal" "predicted output tokens"]
   ["confidence"     "single" "literal" "agent self-reported confidence"]
   ["caveman"        "single" "literal" "caveman-mode flag for a run"]
   ["timed_out"      "single" "literal" "flag: a run hit its time budget"]
   ;; --- Linear synchronization bridge ---
   ["linked_thread" "single" "ref" "canonical North thread owned by an integration link"]
   ["remote_uuid" "single" "literal" "immutable remote issue UUID"]
   ["remote_workspace" "single" "literal" "immutable remote workspace UUID"]
   ["remote_fingerprint" "single" "literal" "bootstrap identity fingerprint when remote UUIDs are unavailable"]
   ["bootstrap_election" "single" "literal" "deterministic bootstrap election key for a Linear integration link"]
   ["bootstrap_initial_key" "single" "literal" "initial human-readable issue key observed during link bootstrap"]
   ["bootstrap_connector" "single" "literal" "connector identity admitted during link bootstrap"]
   ["bootstrap_created_at" "single" "literal" "remote creation instant used during deterministic link bootstrap"]
   ["canonical_link" "single" "ref" "canonical integration link selected for an immutable remote identity"]
   ["remote_workspace_slug" "single" "literal" "current human-readable remote workspace slug"]
   ["remote_scope" "single" "literal" "current remote team or project scope"]
   ["remote_key" "single" "literal" "current human-readable remote issue key"]
   ["remote_server" "single" "literal" "connector or server that owns the remote record"]
   ["identity_kind" "single" "literal" "identity strategy used by an integration link"]
   ["sync_policy" "single" "literal" "authority policy governing an integration link"]
   ["sync_schema" "single" "literal" "versioned synchronization projection contract"]
   ["sync_manifest" "single" "literal" "canonical JSON synchronization baseline and transaction manifest"]
   ["last_synced_at" "single" "literal" "instant a synchronization completed"]
   ["remote_missing_at" "single" "literal" "reserved instant at which a linked remote record was first observed missing"]
   ["unlinked_at" "single" "literal" "reserved instant at which an integration link was intentionally severed"]
   ["linear_link" "single" "ref" "canonical Linear integration-link entity for a North thread"]
   ["conflict_field" "multi" "literal" "reserved field carrying a synchronization conflict"]
   ["linear" "single" "literal" "legacy human-readable Linear issue-key alias"]
   ;; --- operational telemetry outside @run ---
   ["guard" "single" "literal" "authoring guard that denied an operation"]
   ["tool" "single" "literal" "tool denied by an authoring guard"]
   ["reason" "single" "literal" "bounded diagnostic reason"]
   ["note" "multi" "literal" "mined observation attached to a session summary"]
   ["verb_vote" "multi" "literal" "mined suggestion for a repeated workflow verb"]
   ;; --- verbosity advisory (north-mine W2): emit-only aggregate on @advisory:*,
   ;;     never a routing/posture/model predicate ---
   ["advises" "single" "literal" "subject a mined advisory addresses (e.g. response_verbosity)"]
   ["sample_responses" "single" "literal" "count of assistant text turns in an advisory sample"]
   ["sample_sessions" "single" "literal" "count of sessions in an advisory sample"]
   ["long_response_rate" "single" "literal" "fraction of mined responses over the long threshold"]
   ["corrective_interruption_rate" "single" "literal" "fraction of responses met by a corrective interrupt"]
   ["fast_skip_rate" "single" "literal" "fraction of responses a human skipped/abandoned quickly"]
   ["verdict" "single" "literal" "advisory verdict (insufficient-evidence|within-norms|verbose-tendency)"]
   ["run_at" "single" "literal" "instant an operational audit ran"]
   ["window" "single" "literal" "date window covered by an operational audit"]
   ["uncovered_count" "single" "literal" "uncovered commit count from a clock audit"]
   ["repo_summary" "multi" "literal" "per-repository summary emitted by an operational audit"]
   ;; --- resource-budget breaker lifecycle ---
   ["spend_override" "multi" "literal" "operator-authored resource-budget override event"]
   ["tripped" "single" "literal" "instant the resource-budget breaker entered its tripped state"]
   ["trip_reason" "single" "literal" "bounded reason the resource-budget breaker tripped"]
   ["trip_note" "multi" "literal" "diagnostic event attached to a resource-budget breaker trip"]
   ["killed_at" "single" "literal" "instant a breaker enforcement action terminated a run"]
   ["settled_at" "single" "literal" "instant a resource-budget reservation was settled"]
   ["reset_at" "single" "literal" "instant a resource-budget breaker reset was recorded"]
   ["reset_by" "single" "literal" "actor that reset the resource-budget breaker"]
   ["reset_reason" "single" "literal" "operator-supplied reason for a resource-budget breaker reset"]
   ;; --- clock / billing (north-timelog, north-invoice, clock-audit; cardinality
   ;;     mirrors bin/north FRAM_SINGLE_VALUED for the executable fallback) ---
   ["clocked_by"    "single" "literal" "clock actor; user is human billing, managed handles are legacy audit-only"]
   ["start_time"    "single" "literal" "clock session start instant"]
   ["end_time"      "single" "literal" "clock session end instant (absent ⇒ session still open)"]
   ["clock_orphaned" "single" "literal" "flag: a clock session was orphaned before a clean stop"]
   ["estimate_hours" "single" "literal" "estimated hours of work for a thread"]
   ["actual_hours"  "single" "literal" "reconciled actual billable hours for a thread"]
   ["rate"          "single" "literal" "hourly billing rate on a thread or snapshotted client session"]
   ["invoice_id"    "single" "literal" "invoice a billable thread/session is stamped onto"]
   ["invoice_state" "single" "literal" "billing state: uninvoiced | invoice-sent | invoice-paid"]
   ["billing_note"  "multi"  "literal" "manual billing-reconciliation note attached to a thread"]
   ["clock_note"    "multi"  "literal" "clock-correction note attached to a thread"]
   ["time_note"     "multi"  "literal" "billable-window note recorded for invoice reconstruction"]
   ["time_evidence" "multi"  "literal" "observed evidence of a clock anomaly for time reconstruction"]
   ;; --- thread lifecycle (dispatch, posture, north-invoice, merge) ---
   ["abandoned"     "single" "literal" "date/marker a thread was abandoned (derived canceled lifecycle)"]
   ["canceled"      "single" "literal" "reason/marker a thread was canceled"]
   ["merged_into"   "single" "ref"     "the thread/topic this thread was merged into"]
   ["do_on"         "single" "literal" "scheduled date to surface or act on a thread"]
   ["valid_until"   "single" "literal" "date until which a thread's knowledge/reservation stays valid"]
   ["planned"       "single" "literal" "flag: a thread's plan has been ratified"]
   ["atomic"        "single" "literal" "flag: a thread is atomic and must not be decomposed"]
   ["priority"      "single" "literal" "priority band of a thread (e.g. low|med|high)"]
   ;; --- claims-log split snapshots (acquire claims substrate / log-split) ---
   ["byte_offset"   "single" "literal" "byte offset a snapshot covers within the source claims log"]
   ["covers_through" "single" "literal" "highest claim/tx a log snapshot covers"]
   ["snapshot_hash" "single" "literal" "content hash of a claims-log snapshot"]
   ["image_path"    "single" "literal" "filesystem path of a claims-log snapshot image"]
   ["claim_count"   "single" "literal" "number of claims a snapshot covers"]
   ;; --- aggregate batch usage rollup (north-map aggregate harness) ---
   ["agg_run_tokens" "single" "literal" "tokens attributed to one aggregate batch run member"]
   ["agg_done_worker" "single" "literal" "worker handle recorded for one aggregate batch DONE slot"]
   ["agg_charge_tokens" "single" "literal" "charge tokens attributed to one aggregate batch member"]])

;; These are deliberately open predicate-authoring surfaces. Internal transports
;; with variable names (runFacts -> recordRun, identity projection -> scoped
;; writer, Linear GraphStore.put) are NOT open: their fixed producer tuples must
;; remain covered by VOCAB and the parity test.
(def DYNAMIC-PREDICATE-SURFACES
  [{:id "cli-tell" :path "bin/north"
    :reason "north tell/retract accepts user-authored graph predicates"}
   {:id "mcp-tell" :path "bin/north-mcp"
    :reason "the generic MCP tell tool accepts a caller-supplied predicate"}
   {:id "peer-tell" :path "sdk/src/harness.ts"
    :reason "peer tell carries a caller-supplied predicate to a non-agent subject"}
   {:id "peer-command-args" :path "cli/msg-cli.clj"
    :reason "extensible peer command argument keys become fact predicates"}
   {:id "legacy-runmeta" :path "cli/presence-cli.clj"
    :reason "legacy runmeta accepts extension fields; fixed SDK run telemetry does not"}
   {:id "registry-define" :path "cli/pred-cli.clj"
    :reason "operators may explicitly define an additional executable predicate entity"}])

(def VOCAB-CARD (into {} (map (fn [[n c k d]] [n {:card c :kind k :doc d}]) VOCAB)))

;; ---- registry reads ----
(defn register! [port nm card kind doc minter]
  (let [e (pred-ent nm)]
    (set-1! port e "cardinality" card)
    (set-1! port e "value_kind" kind)
    (when (seq (str doc)) (set-1! port e "doc" doc))
    (set-1! port e "entity_kind" "predicate")
    (set-1! port e "minted_by" (or minter "pred-cli"))
    (set-1! port e "minted_at" (str (java.time.Instant/now)))
    e))

;; Executable predicate identity is exact.  A same_as edge cannot make Fram use
;; another entity's cardinality, so aliases are never followed here.
(defn canonical [_port nm] nm)

;; Every executable @<name> carrying cardinality in the live graph.  Colon-bearing
;; subjects are entity namespaces (@agent:*, @entity-kind:*), not predicate names.
(defn graph-pred-names [port]
  (->> (:ok (send-op port {:op :query
                           :query {:find "e"
                                   :rules [{:head {:rel "e" :args [{:var "e"}]}
                                            :body [{:rel "triple" :args [{:var "e"} "cardinality" {:var "_"}]}]}]}}))
       (map first)
       (filter #(and (str/starts-with? (str %) "@")
                     (not (str/includes? (str %) ":"))))
       (map pred-name)
       set))

;; The connected registry is generated solely from executable graph entities.
;; Keeping the bootstrap set separately makes its weaker, migration-only role
;; mechanically visible to callers and tests.
(def BOOTSTRAP-SET (set (keys VOCAB-CARD)))

(defn registry-set [port]
  (graph-pred-names port))

;; ============================================================================
;; structural predicate extraction — the local lint engine. Read each production
;; cli/*.clj with the
;; babashka reader (no regex fragility) and walk for predicate-POSITION string
;; literals: the 3rd arg of a wire helper, a :p map key, and the middle of a
;; datalog `triple` arg-vector. Returns {predicate -> #{files}}.
;; ============================================================================
(def pred-fns '#{append! put! swap! assert! retract! resolved one many rf rmany set-single! set-1!})

(defn read-forms [path]
  (with-open [rdr (java.io.PushbackReader. (io/reader path))]
    (let [eof (Object.)]
      (loop [acc []]
        (let [f (read {:eof eof :read-cond :allow} rdr)]
          (if (= f eof) acc (recur (conj acc f))))))))

(def pred-fn-names (set (map name pred-fns)))   ; match on simple name so a fully-qualified
                                                ; north.coord/append! is caught like a bare append!
(defn preds-in-form [form]
  (let [found (atom #{})]
    (walk/postwalk
     (fn [x]
       (when (and (seq? x) (symbol? (first x)) (contains? pred-fn-names (name (first x))))
         (let [p (nth (vec x) 3 nil)] (when (string? p) (swap! found conj p))))
       (when (map? x)
         (when (string? (:p x)) (swap! found conj (:p x)))
         (when (and (= "triple" (:rel x)) (vector? (:args x)) (= 3 (count (:args x))))
           (let [p (nth (:args x) 1)] (when (string? p) (swap! found conj p)))))
       x)
     form)
    @found))

(defn lint-files []
  (->> (file-seq (io/file (str (.getParent (io/file (System/getProperty "babashka.file"))))))
       (filter #(str/ends-with? (.getName %) ".clj"))
       (remove #(some #{"tests"} (str/split (.getPath %) #"[/\\]")))
       ;; the wire substrate + the pure validator carry no domain predicates.
       (remove #(#{"coord.clj" "schema-validate.clj"} (.getName %)))
       (sort-by #(.getName %))))

(defn scan-preds []
  (let [acc (atom {})]
    (doseq [f (lint-files)]
      (doseq [p (reduce into #{} (map preds-in-form (read-forms (str f))))]
        (swap! acc update p (fnil conj #{}) (.getName f))))
    @acc))

;; ============================================================================
;; CENSUS — lightweight source/log inventory. The authoritative strict audit is
;; schema-migrate.clj, which reuses Fram's exact two-pass fold across both corpus
;; logs. This literal-only view never decides runtime schema semantics.
;;
;; A predicate name is registrable only if it is a bare identifier — the `define`
;; verb and every wire writer produce such names. A torn merge write can leave a
;; garbage predicate (e.g. a literal two-quote-char string) that can NEVER become
;; an executable @<predicate> entity; the fold skips it rather than reporting an un-fixable miss,
;; and `census` prints the skipped set so the corruption stays visible.
;; ============================================================================
(def FRAM-SCHEMA-PREDICATES #{"cardinality" "value_kind" "acyclic"})
(def VALID-PRED-NAME #"^[A-Za-z][A-Za-z0-9_]*$")

(defn census-literal-preds
  "Fold logpath → {:counts {pred->n} :skipped {non-registrable-pred->n}} over
   assert/retract records whose value is a literal (non-@ref)."
  [logpath]
  (let [counts (atom {}) skipped (atom {})]
    (with-open [rdr (io/reader logpath)]
      (loop []
        (when-let [line (.readLine rdr)]
          (when-let [m (try (edn/read-string line) (catch Exception _ nil))]
            (when (and (map? m) (#{"assert" "retract"} (:op m)))
              (let [p (:p m) r (:r m)]
                (when (and (string? p) (not (str/blank? p))
                           (not (contains? FRAM-SCHEMA-PREDICATES p))
                           (string? r) (not (str/starts-with? r "@")))
                  (if (re-matches VALID-PRED-NAME p)
                    (swap! counts update p (fnil inc 0))
                    (swap! skipped update p (fnil inc 0)))))))
          (recur))))
    {:counts @counts :skipped @skipped}))

;; ============================================================================
(let [[ps verb & args] *command-line-args*
      port (Integer/parseInt (or ps "7977"))]
  (case verb
    "seed"
    (do (doseq [[n c k d] VOCAB] (register! port n c k d "seed"))
        (println (str "✓ seeded " (count VOCAB) " executable predicate entities on :" port)))

    "define"
    (let [[nm card kind doc minter] args]
      (when-not (and nm
                     (re-matches #"^[A-Za-z][A-Za-z0-9_-]*(?:/[A-Za-z][A-Za-z0-9_-]*)?$" nm)
                     (#{"single" "multi"} card) (#{"literal" "ref"} kind))
        (println "usage: pred-cli.clj <port> define <name> <single|multi> <literal|ref> [\"doc\"] [minted_by]")
        (System/exit 2))
      (let [e (register! port nm card kind doc minter)]
        (println (str "✓ " e "  cardinality=" card " value_kind=" kind (when (seq (str doc)) (str " doc=" (pr-str doc)))))))

    "alias"
    (do
      (binding [*out* *err*]
        (println "predicate alias REFUSED — Fram executes the exact @<predicate> entity; migrate fact uses explicitly instead"))
      (System/exit 2))

    "ls"
    (let [names (sort (registry-set port))]
      (println (format "EXECUTABLE PREDICATES — %d on :%d" (count names) port))
      (println (format "  %-28s %-7s %-8s %s" "NAME" "CARD" "KIND" "DOC"))
      (doseq [nm names]
        (let [entity (pred-ent nm)
              card (or (exact-one port entity "cardinality") "?")
              kind (or (exact-one port entity "value_kind") "?")
              doc (or (exact-one port entity "doc") "")]
          (println (format "  %-28s %-7s %-8s %s" nm card kind doc)))))

    "show"
    (let [[nm] args]
      (when-not nm (println "usage: pred-cli.clj <port> show <name>") (System/exit 2))
      (let [entity (pred-ent nm)
            graph (exact-facts port entity)
            predicates (distinct (concat ["cardinality" "value_kind" "acyclic" "doc" "entity_kind"]
                                         (map first graph)))]
        (println entity)
        (doseq [predicate predicates]
          (let [values (vec (exact-values port entity predicate))
                rendered (if (seq values) (str/join " · " values) "-")]
            (println (format "  %-17s %s" predicate rendered))))))

    "census"
    (let [strict (some #{"--strict"} args)
          logpath (or (first (remove #{"--strict"} args)) (north.coord/expected-log))
          reg (registry-set port)
          {:keys [counts skipped]} (census-literal-preds logpath)
          misses (->> (keys counts) (remove reg) sort)]
      (println (format "predicate source census — %d literal predicate(s) in %s; %d graph-authoritative names"
                       (count counts) logpath (count reg)))
      (when (seq skipped)
        (println (str "  ⚠ " (count skipped) " non-registrable predicate name(s) skipped (torn/garbage writes):"))
        (doseq [p (sort (keys skipped))] (println (format "    %-28s %d assertion(s)" (pr-str p) (skipped p)))))
      (if (empty? misses)
        (println "  ✓ every observed literal predicate has an executable graph declaration")
        (do (println (str "  ✗ " (count misses) " predicate(s) lack an executable graph declaration:"))
            (doseq [p misses] (println (format "    %-28s %d assertion(s)" p (counts p))))
            (println "  -> run `north schema-migrate migrate --execute`; authoritative strict audit is `north schema-migrate audit --strict`")
            (when strict (System/exit 1)))))

    "lint"
    (let [strict (some #{"--strict"} args)
          reg (registry-set port)
          used (scan-preds)
          misses (->> used (remove (fn [[p _]] (contains? reg p))) (sort-by first))]
      (println (format "pred lint — %d predicate literals across %d files, %d graph-authoritative names"
                       (count used) (count (lint-files)) (count reg)))
      (if (empty? misses)
        (println "  ✓ clean — every predicate-position literal has an executable graph declaration")
        (do (println (str "  ✗ " (count misses) " predicate literal(s) with NO entry:"))
            (doseq [[p fs] misses] (println (format "    %-24s used in %s" p (str/join "," (sort fs)))))
            (println "  -> run `north schema-migrate migrate --execute` or `pred-cli.clj <port> define ...`")
            (when strict (System/exit 1)))))

    "lint-offline"
    (let [strict (some #{"--strict"} args)
          used (scan-preds)
          misses (->> used (remove (fn [[p _]] (contains? BOOTSTRAP-SET p))) (sort-by first))]
      (println (format "pred lint-offline (WEAK, BOOTSTRAP-ONLY) — %d predicate literals across %d files, %d bootstrap names"
                       (count used) (count (lint-files)) (count BOOTSTRAP-SET)))
      (if (empty? misses)
        (println "  ✓ clean against migration bootstrap inventory (not a runtime schema verdict)")
        (do (println (str "  ✗ " (count misses) " predicate literal(s) absent from migration bootstrap:"))
            (doseq [[p fs] misses] (println (format "    %-24s used in %s" p (str/join "," (sort fs)))))
            (println "  -> add bootstrap material only if the predicate is intentional; runtime authority remains the graph")
            (when strict (System/exit 1)))))

    (do (println "usage: pred-cli.clj <port> {seed | define <n> <card> <kind> [doc] | alias (refused) | ls | show <n> | lint [--strict] | lint-offline [--strict] | census [logpath] [--strict]}")
        (System/exit 2))))
