#!/usr/bin/env bb
;; Evidence-aware routing feedback. Operational completion, self-reported thread
;; evidence, and independent delivery verification remain separate axes; none is
;; presented as causal model quality.

(require '[cheshire.core :as json]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def NORTH (some-> *file* io/file .getCanonicalFile .getParentFile .getParentFile str))
(load-file (str NORTH "/cli/gaffer-staffing.clj"))
(load-file (str NORTH "/cli/terminal-projection.clj"))

(def multi-preds #{"done_when" "bar_evidence" "domain_requirement"
                   "applied_capability" "applied_domain_requirement"
                   "composition_override" "applied_preset_override" "struggle"})

(def canonical-gaffer-capabilities
  ["filesystem.read" "filesystem.search" "filesystem.write" "shell"
   "shell.readonly" "web" "coordination"])
(def bespoke-fingerprint-version "v1")
(def bespoke-fingerprint-domain "north:bespoke-contract:v1")
(def applied-axis-preds
  [[:taskGrade "applied_task_grade"]
   [:topology "applied_topology"]
   [:tier "applied_routing_tier"]
   [:reasoning "applied_reasoning"]
   [:posture "applied_posture"]])
(def applied-axis-values
  {:taskGrade #{"novice" "junior" "mid" "senior" "staff" "principal" "research-grade"}
   :topology #{"worker" "orchestrator"}
   :tier #{"economy" "standard" "senior" "frontier"}
   :reasoning #{"low" "medium" "high" "xhigh" "max"}
   :posture #{"explore" "evaluate" "deliver" "preserve"}})
(def sha256-pattern #"^[0-9a-f]{64}$")
(def safe-role-id-pattern #"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
(def managed-composition-kinds #{"preset" "bespoke"})
(def delivery-outcomes #{"unverified" "reported" "verified" "blocked"})
(def judgment-grade-values #{"s" "m" "l"})
(def judgment-grade-status-values #{"valid" "unavailable" "invalid"})
(def judgment-grade-source-values #{"thread" "ad-hoc"})
(def struggle-trigger-values #{"consecutive_errors" "tool_loop" "no_progress"})
(def routing-override-fields
  ["taskGrade" "domainRequirements" "tier" "reasoning" "posture"])
(declare normalized-token normalized-domains capability-summary attributed?)

(defn normalized-preset-template [defaults preset]
  (let [effective (merge defaults preset)
        capabilities (capability-summary (get effective "capabilities" []))]
    {:axes {:taskGrade (normalized-token (get effective "taskGrade"))
            :domains (normalized-domains (get effective "domainRequirements" []))
            :topology (normalized-token (get effective "topology"))
            :tier (normalized-token (get effective "tier"))
            :reasoning (normalized-token (get effective "deliberation"))
            :posture (normalized-token (get effective "posture"))}
     :capabilities (:canonical capabilities)
     :unknownCapabilities (:unknown capabilities)}))

(defn current-preset-catalog []
  (try
    (let [catalog (north.gaffer-staffing/load-catalog)
          defaults (get catalog "defaults")
          presets (into {}
                        (map (fn [[id preset]]
                               [id (normalized-preset-template defaults preset)]))
                        (north.gaffer-staffing/presets-by-name catalog))]
      (if (seq presets)
        {:available true :ids (set (keys presets)) :presets presets}
        {:available false :ids #{} :presets {}}))
    (catch Exception _
      {:available false :ids #{} :presets {}})))

(defn default-paths []
  (let [home (System/getenv "HOME")
        dir (str home "/.local/state/north")
        split (io/file dir "coordination.log")]
    [(or (System/getenv "FRAM_LOG")
         (if (.exists split) (.getPath split) (str dir "/facts.log")))
     (or (System/getenv "FRAM_TELEMETRY_LOG")
         (let [path (str dir "/telemetry.log")] (when (.exists (io/file path)) path)))]))

(defn read-ops [paths]
  (mapcat (fn [path]
            (if (and path (.exists (io/file path)))
              (with-open [reader (io/reader path)]
                (doall
                 (keep (fn [line]
                         (try (edn/read-string line) (catch Exception _ nil)))
                       (line-seq reader))))
              []))
          (distinct (remove nil? paths))))

(defn fold-facts [ops]
  (reduce
   (fn [facts {:keys [op l p r]}]
     (if-not (and l p) facts
       (let [current (get-in facts [l p] [])]
         (cond
           (= op "assert")
           (assoc-in facts [l p]
                     (if (multi-preds p) (if (some #{r} current) current (conj current r)) [r]))
           (= op "retract")
           (let [remaining (vec (remove #{r} current))]
             (if (seq remaining) (assoc-in facts [l p] remaining) (update facts l dissoc p)))
           :else facts))))
   {} ops))

(defn one [facts entity pred] (last (get-in facts [entity pred])))
(defn many [facts entity pred] (get-in facts [entity pred] []))
(defn long' [value] (try (parse-long (str value)) (catch Exception _ 0)))
(defn maybe-long [value] (when (some? value) (try (parse-long (str value)) (catch Exception _ nil))))
(defn maybe-positive-long [value]
  (let [parsed (maybe-long value)]
    (when (and parsed (pos? parsed)) parsed)))
(defn observed-turns [value process-outcome]
  (let [parsed (maybe-long value)]
    (when (and (some? parsed)
               (not (neg? parsed))
               (or (pos? parsed)
                   ;; A preflight block proves that no provider turn began.
                   ;; Historical successful runs used 0 as a missing-value
                   ;; sentinel, so zero is not evidence for any other outcome.
                   (and (zero? parsed)
                        (= "blocked_preflight" process-outcome))))
      parsed)))
(defn thread-ref [value]
  (when (and value (not= value "(ad-hoc)"))
    (if (str/starts-with? value "@") value (str "@" value))))

(defn normalized-token [value]
  (let [token (some-> value str str/trim)] (when (seq token) token)))

(defn json-map [value]
  (try
    (let [parsed (when value (json/parse-string value))]
      (when (map? parsed) parsed))
    (catch Exception _ nil)))

(defn normalized-domain [value]
  (some-> (normalized-token value)
          (java.text.Normalizer/normalize java.text.Normalizer$Form/NFC)
          (.toLowerCase java.util.Locale/ROOT)))

(defn normalized-domains [values]
  (->> values (keep normalized-domain) distinct sort vec))

(defn capability-summary [values]
  (let [normalized (->> values (keep normalized-token) distinct vec)
        requested (set normalized)
        unknown (->> normalized (remove (set canonical-gaffer-capabilities)) sort vec)]
    {:canonical (vec (filter requested canonical-gaffer-capabilities))
     :unknown unknown}))

(defn sha256 [value]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        (.getBytes (str value) "UTF-8"))]
    (apply str (map #(format "%02x" (bit-and % 0xff)) digest))))

(defn override-summary [values]
  (let [normalized (->> values (keep normalized-token) distinct vec)
        known (set routing-override-fields)]
    {:values normalized
     :canonical (set (filter known normalized))
     :unknown (vec (remove known normalized))}))

(defn preset-application-debt
  "Compare one run's applied prompt authority with the current stock template.
  Overrides are valid only when both requested and applied evidence cover the
  exact semantic delta, and a nonempty delta carries its rationale digest."
  [template effective-axes applied-capabilities requested-overrides requested-reason
   applied-overrides reason-hash]
  (let [expected (:axes template)
        actual (select-keys effective-axes (keys expected))
        topology-mismatch? (not= (:topology actual) (:topology expected))
        deltas (->> [["taskGrade" :taskGrade]
                     ["domainRequirements" :domains]
                     ["tier" :tier]
                     ["reasoning" :reasoning]
                     ["posture" :posture]]
                    (keep (fn [[field axis]]
                            (when (not= (get actual axis) (get expected axis)) field)))
                    set)
        requested (override-summary requested-overrides)
        applied (override-summary applied-overrides)
        override-evidence? (or (seq (:values requested))
                               (some? requested-reason)
                               (seq (:values applied))
                               (some? reason-hash))]
    (vec
     (concat
      (when (seq (:unknownCapabilities template))
        ["current-preset-has-noncanonical-capabilities"])
      (when (not= applied-capabilities (:capabilities template))
        ["preset-applied-capabilities-mismatch"])
      (when topology-mismatch?
        ["preset-topology-mismatch"])
      (when (seq (:unknown requested))
        ["invalid-composition-override-evidence"])
      (when (seq (:unknown applied))
        ["invalid-applied-preset-override-evidence"])
      (if (empty? deltas)
        (when override-evidence? ["unexpected-preset-override-evidence"])
        (concat
         (when (not= deltas (:canonical requested))
           ["composition-override-coverage-mismatch"])
         (when (not= deltas (:canonical applied))
           ["applied-preset-override-coverage-mismatch"])
         (when (nil? requested-reason)
           ["missing-composition-override-reason"])
         (cond
           (nil? reason-hash) ["missing-applied-preset-override-reason-sha256"]
           (not (re-matches sha256-pattern reason-hash))
           ["invalid-applied-preset-override-reason-sha256"]
           :else [])
         (when (and requested-reason
                    reason-hash
                    (re-matches sha256-pattern reason-hash)
                    (not= (sha256 requested-reason) reason-hash))
           ["applied-preset-override-reason-sha256-mismatch"])))))))

(def requested-axis-order
  [[:taskGrade "taskGrade"] [:topology "topology"] [:tier "tier"]
   [:reasoning "reasoning"] [:posture "posture"] [:domains "domainRequirements"]])

(defn requested-applied-axis-debt [requested applied]
  (let [missing (->> requested-axis-order
                     (keep (fn [[axis label]]
                             (when (and (not= axis :domains)
                                        (nil? (get requested axis)))
                               label)))
                     vec)
        mismatched (->> requested-axis-order
                        (keep (fn [[axis label]]
                                (when (and (or (= axis :domains)
                                               (some? (get requested axis)))
                                           (not= (get requested axis)
                                                 (get applied axis)))
                                  label)))
                        vec)]
    (vec
     (concat
      (when (seq missing)
        [(str "missing-requested-axes:" (str/join "," missing))])
      (when (seq mismatched)
        [(str "requested-applied-axes-mismatch:" (str/join "," mismatched))])))))

(defn evidence [facts thread]
  (if-not thread
    {:status "no-contract" :bars 0 :evidenced 0 :hasOutcome false}
    (let [bars (many facts thread "done_when")
          evs (many facts thread "bar_evidence")
          outcome? (boolean (one facts thread "outcome"))
          evidenced
          (count
           (filter
            (fn [bar]
              (some #(north.terminal-projection/evidence-reports-bar? bar %) evs))
            bars))
          total (count bars)
          status (cond
                   (zero? total) "no-contract"
                   (and outcome? (= evidenced total)) "thread-closed-evidenced"
                   (= evidenced total) "thread-open-evidenced"
                   (pos? evidenced) "partial"
                   :else "unevidenced")]
      {:status status :bars total :evidenced evidenced :hasOutcome outcome?})))

(defn run-rows [facts]
  (let [preset-catalog (current-preset-catalog)]
   (for [[entity predicates] facts
        :when (and (= "run" (one facts entity "kind"))
                   ;; both legacy `@run-` and telemetry-routable `@run:` ids
                   (or (str/starts-with? entity "@run-")
                       (str/starts-with? entity "@run:")))]
    (let [agent (one facts entity "agent")
          identity (str "@agent:" agent)
          get' (fn [pred fallback] (or (one facts entity pred) (one facts identity pred) fallback))
          thread (thread-ref (one facts entity "thread"))
          composition-kind (get' "composition_kind" nil)
          composition-id (normalized-token (get' "composition_id" nil))
          role (normalized-token (get' "role" nil))
          process-outcome (normalized-token (one facts entity "process_outcome"))
          effective-process-outcome (or process-outcome (get' "outcome" "unrecorded"))
          run-facts (get facts entity {})
          lane-facts (get facts identity {})
          lane-process-outcome
          (north.terminal-projection/terminal-process-outcome lane-facts)
          lane-delivery-candidate
          (north.terminal-projection/terminal-delivery-outcome lane-facts)
          lane-evidence-candidate
          (json-map (north.terminal-projection/singleton-value
                     lane-facts "delivery_evidence"))
          lane-delivery-outcome
          (when (and (= effective-process-outcome lane-process-outcome)
                     (#{"reported" "verified"} lane-delivery-candidate)
                     (= entity (get lane-evidence-candidate "run"))
                     (= thread (get lane-evidence-candidate "thread"))
                     (= identity (get lane-evidence-candidate "reporter")))
            lane-delivery-candidate)
          run-delivery-outcome (normalized-token (one facts entity "delivery_outcome"))
          run-evidence-candidate
          (json-map (north.terminal-projection/singleton-value
                     run-facts "delivery_evidence"))
          run-delivery-valid
          (and run-delivery-outcome
               (north.terminal-projection/delivery-projection-valid? run-facts)
               (or (#{"unverified" "blocked"} run-delivery-outcome)
                   (and (= entity (get run-evidence-candidate "run"))
                        (= thread (get run-evidence-candidate "thread"))
                        (= identity (get run-evidence-candidate "reporter")))))
          delivery-outcome (or lane-delivery-outcome
                               (when run-delivery-valid run-delivery-outcome))
          delivery-source (cond
                            lane-delivery-outcome "lane-terminal"
                            run-delivery-valid "run"
                            :else nil)
          delivery-projection-facts (cond
                                      lane-delivery-outcome lane-facts
                                      run-delivery-valid run-facts
                                      :else {})
          delivery-evidence
          (json-map (north.terminal-projection/singleton-value
                     delivery-projection-facts "delivery_evidence"))
          delivery-attestation
          (json-map (north.terminal-projection/singleton-value
                     delivery-projection-facts "delivery_attestation"))
          delivery-reason
          (normalized-token
           (if lane-delivery-outcome
             (north.terminal-projection/singleton-value lane-facts "delivery_reason")
             (when run-delivery-valid (one facts entity "delivery_reason"))))
          delivery-proof-valid (boolean delivery-outcome)
          prompt-composition-applied (normalized-token
                                      (one facts entity "prompt_composition_applied"))
          applied-role-contract (normalized-token (one facts entity "applied_role_contract"))
          expected-role-contract (when (and composition-kind composition-id)
                                   (str composition-kind ":" composition-id))
          applied-hash (normalized-token (one facts entity "applied_bespoke_contract_sha256"))
          applied-version (normalized-token
                           (one facts entity "applied_bespoke_contract_fingerprint_version"))
          applied-domain (normalized-token
                          (one facts entity "applied_bespoke_contract_fingerprint_domain"))
          requested-hash (normalized-token (one facts identity "composition_contract_sha256"))
          requested-version (normalized-token
                             (one facts identity "composition_contract_fingerprint_version"))
          requested-domain (normalized-token
                            (one facts identity "composition_contract_fingerprint_domain"))
          requested-values [requested-hash requested-version requested-domain]
          requested-integrity (cond
                                (not-any? some? requested-values) "not-observed"
                                (not-every? some? requested-values) "incomplete-requested-evidence"
                                (= requested-values [applied-hash applied-version applied-domain]) "matched"
                                :else "mismatch")
          capability-evidence (capability-summary (many facts entity "applied_capability"))
          applied-capabilities (:canonical capability-evidence)
          composition-overrides (many facts entity "composition_override")
          composition-override-reason
          (normalized-token (one facts entity "composition_override_reason"))
          applied-preset-overrides (many facts entity "applied_preset_override")
          applied-preset-override-reason-hash
          (normalized-token (one facts entity "applied_preset_override_reason_sha256"))
          applied-domain-values (many facts entity "applied_domain_requirement")
          applied-domain-count-raw (one facts entity "applied_domain_requirement_count")
          applied-domain-count (maybe-long applied-domain-count-raw)
          effective-axes (assoc
                          (into {} (map (fn [[axis pred]]
                                         [axis (normalized-token (one facts entity pred))])
                                       applied-axis-preds))
                          :domains (normalized-domains
                                    applied-domain-values))
          requested-axes
          {:taskGrade (normalized-token (one facts entity "task_grade"))
           :topology (normalized-token (one facts entity "topology"))
           :tier (normalized-token (one facts entity "routing_tier"))
           :reasoning (normalized-token (one facts entity "requested_reasoning"))
           :posture (normalized-token (one facts entity "routing_posture"))
           :domains (normalized-domains (many facts entity "domain_requirement"))}
          requested-applied-axis-debt
          (requested-applied-axis-debt requested-axes effective-axes)
          missing-axes (->> applied-axis-preds
                            (keep (fn [[axis _]] (when-not (get effective-axes axis) (name axis))))
                            vec)
          invalid-axes (->> applied-axis-values
                            (keep (fn [[axis values]]
                                    (let [value (get effective-axes axis)]
                                      (when (and value (not (values value))) (name axis)))))
                            sort vec)
          common-applied-debt
          (concat
           (cond
             (nil? role) ["missing-role"]
             (not= role composition-id) ["role-composition-id-mismatch"]
             :else [])
           (when-not (= "true" prompt-composition-applied)
             ["missing-or-invalid-prompt-composition-applied"])
           (cond
             (nil? applied-role-contract) ["missing-applied-role-contract"]
             (not= expected-role-contract applied-role-contract)
             ["applied-role-contract-mismatch"]
             :else [])
           (cond
             (nil? applied-domain-count-raw) ["missing-applied-domain-count"]
             (or (nil? applied-domain-count) (neg? applied-domain-count))
             ["invalid-applied-domain-count"]
             (not= applied-domain-count (count applied-domain-values))
             ["applied-domain-count-mismatch"]
             :else [])
           (when (empty? applied-capabilities) ["missing-applied-capabilities"])
           (when (seq (:unknown capability-evidence)) ["noncanonical-applied-capabilities"])
           (when (seq missing-axes)
             [(str "missing-applied-axes:" (str/join "," missing-axes))])
           (when (seq invalid-axes)
             [(str "invalid-applied-axes:" (str/join "," invalid-axes))])
           (when-not delivery-proof-valid ["missing-or-invalid-delivery-proof"])
           requested-applied-axis-debt)
          preset-applied-debt
          (when (= "preset" composition-kind)
            (let [template (get-in preset-catalog [:presets composition-id])]
              (cond
                (not (:available preset-catalog)) ["current-preset-catalog-unavailable"]
                (nil? template) ["unknown-current-preset"]
                :else (preset-application-debt
                       template effective-axes applied-capabilities
                       composition-overrides composition-override-reason
                       applied-preset-overrides
                       applied-preset-override-reason-hash))))
          bespoke-applied-debt
          (when (= "bespoke" composition-kind)
            (concat
             (cond
               (nil? applied-hash) ["missing-applied-hash"]
               (not (re-matches sha256-pattern applied-hash)) ["invalid-applied-hash"]
               :else [])
             (when (not= bespoke-fingerprint-version applied-version)
               ["missing-or-unsupported-applied-fingerprint-version"])
             (when (not= bespoke-fingerprint-domain applied-domain)
               ["missing-or-unsupported-applied-fingerprint-domain"])
             (case requested-integrity
               "matched" []
               "not-observed" ["missing-requested-fingerprint"]
               [(str "requested-applied-fingerprint-" requested-integrity)])
             (when-not (and composition-id
                            (re-matches safe-role-id-pattern composition-id))
               ["missing-or-invalid-bespoke-composition-id"])))
          legacy-debt (vec (concat common-applied-debt preset-applied-debt
                                   bespoke-applied-debt))]
      {:entity entity :thread thread
       ;; Calibration evidence is immutable and RUN-LOCAL. Never fall back to
       ;; current thread/agent facts for these fields: later grade edits must not
       ;; relabel a completed run.
       :judgmentGrade (normalized-token (one facts entity "judgment_grade"))
       :judgmentGradeStatus (normalized-token (one facts entity "judgment_grade_status"))
       :judgmentGradeSource (normalized-token (one facts entity "judgment_grade_source"))
       :struggleTriggers (vec (many facts entity "struggle"))
       :struggleDetectorPolicyVersion
       (normalized-token (one facts entity "struggle_detector_policy_version"))
       :struggleTopology (normalized-token (one facts entity "struggle_topology"))
       :struggleErrorStreakThreshold
       (maybe-positive-long (one facts entity "struggle_error_streak_threshold"))
       :struggleLoopRepeatThreshold
       (maybe-positive-long (one facts entity "struggle_loop_repeat_threshold"))
       :struggleLoopWindow (maybe-positive-long (one facts entity "struggle_loop_window"))
       :struggleNoProgressTurnThreshold
       (maybe-positive-long (one facts entity "struggle_no_progress_turn_threshold"))
       :struggleErrorCount (maybe-long (one facts entity "error_count"))
       :provider (get' "provider" "unattributed")
       :tier (or (:tier effective-axes)
                 (when-let [value (:tier requested-axes)]
                   (str "requested:" value))
                 (when-let [value (normalized-token (get' "requested_tier" nil))]
                   (str "requested-route:" value))
                 "unattributed")
       :tierProvenance (cond
                         (:tier effective-axes) "applied"
                         (:tier requested-axes) "requested-gaffer-fallback"
                         (attributed? (get' "requested_tier" nil)) "requested-route-fallback"
                         :else "unattributed")
       :model (get' "model" "unattributed") :effort (get' "effort" "unattributed")
       :modelAvailability
       (when-let [source (normalized-token (one facts entity "model_availability_source"))]
         {:target (normalized-token (one facts entity "model_availability_target"))
          :source source
          :observedAt (normalized-token (one facts entity "model_availability_observed_at"))
          :model (normalized-token (one facts entity "model_availability_model"))
          :digest (normalized-token (one facts entity "model_availability_digest"))})
       :role (or role "unattributed")
       :taskGrade (or (:taskGrade effective-axes)
                      (when-let [value (:taskGrade requested-axes)]
                        (str "requested:" value))
                      "unattributed")
       :taskGradeProvenance (cond
                              (:taskGrade effective-axes) "applied"
                              (:taskGrade requested-axes) "requested-gaffer-fallback"
                              :else "unattributed")
       :outcome (get' "outcome" "unrecorded")
       :processOutcome effective-process-outcome
       :processOutcomeObserved (boolean process-outcome)
       :deliveryOutcome (or delivery-outcome "unrecorded")
       :deliveryOutcomeObserved (boolean delivery-outcome)
       :deliveryOutcomeSource delivery-source
       :deliveryProofValid delivery-proof-valid
       :deliveryEvidenceThread (get delivery-evidence "thread")
       :deliveryReporter (get delivery-evidence "reporter")
       :deliveryEvidenceSha256
       (north.terminal-projection/singleton-value
        delivery-projection-facts "delivery_evidence_sha256")
       :deliveryVerifier (get delivery-attestation "actor")
       :deliveryVerifierRole (get delivery-attestation "role")
       :deliveryAuthority (get delivery-attestation "authority")
       :deliveryReason delivery-reason
       :deliveryReasonObserved (boolean delivery-reason)
       :tokens (maybe-long (get' "tokens" nil))
       ;; Historical adapters wrote 0 when they had no wall-clock observation.
       ;; A completed process cannot provide a real zero-millisecond duration, so
       ;; only positive observations count as evidence.
       :durationMs (maybe-positive-long (get' "duration_ms" nil))
       :turns (observed-turns (get' "num_turns" nil) effective-process-outcome)
       :fallbacks (long' (get' "fallback_count" 0))
       :escalations (long' (get' "escalation_count" 0))
       :compositionKind composition-kind
       :compositionId composition-id
       :nearestPreset (get' "nearest_preset" nil)
       :bespokeReason (get' "bespoke_reason" nil)
       :promotionCandidate (= "true" (get' "promotion_candidate" "false"))
       :promptCompositionApplied (= "true" prompt-composition-applied)
       :appliedRoleContract applied-role-contract
       ;; Applied evidence is intentionally read from the run only. Requested
       ;; identity facts are not proof that the harness enforced a contract.
       :appliedContractSha256 applied-hash
       :appliedFingerprintVersion applied-version
       :appliedFingerprintDomain applied-domain
       :requestedAppliedIntegrity requested-integrity
       :requestedContractSha256 requested-hash
       :requestedFingerprintVersion requested-version
       :requestedFingerprintDomain requested-domain
       :appliedCapabilities applied-capabilities
       :compositionOverrides composition-overrides
       :appliedPresetOverrides applied-preset-overrides
       :appliedPresetOverrideReasonSha256 applied-preset-override-reason-hash
       :appliedDomainRequirementCount applied-domain-count
       :requestedAxes requested-axes
       :effectiveAxes effective-axes
       :legacyDebtReasons legacy-debt
       :evidence (evidence facts thread)}))))

(def cohort-fields [:provider :tier :role :taskGrade])
(def complete-attribution-fields (into cohort-fields [:model :effort]))
(defn cohort-label [row] (str/join "/" (map #(get row %) cohort-fields)))

(defn attributed? [value]
  (let [token (normalized-token value)]
    (and token (not (#{"?" "unknown" "unobserved" "unrecorded" "unattributed"} token)))))

(defn complete-current-managed-run? [row]
  (and (managed-composition-kinds (:compositionKind row))
       (attributed? (:compositionId row))
       (:processOutcomeObserved row)
       (:deliveryOutcomeObserved row)
       (:deliveryReasonObserved row)
       (delivery-outcomes (:deliveryOutcome row))
       (every? #(attributed? (get row %)) complete-attribution-fields)
       (empty? (:legacyDebtReasons row))))

(defn performance-row [[label rows]]
  (let [statuses (frequencies (map #(get-in % [:evidence :status]) rows))
        deliveries (frequencies (map :deliveryOutcome rows))
        delivery-sources (frequencies (keep :deliveryOutcomeSource rows))
        delivery-authorities (frequencies (keep :deliveryAuthority rows))]
    {:cohort label :runs (count rows)
     :operationalRan (count (filter #(= "ran" (:processOutcome %)) rows))
     :deliveryVerified (get deliveries "verified" 0)
     :deliveryReported (get deliveries "reported" 0)
     :deliveryUnverified (get deliveries "unverified" 0)
     :deliveryBlocked (get deliveries "blocked" 0)
     :deliveryUnrecorded (get deliveries "unrecorded" 0)
     :deliveryOutcomeSources delivery-sources
     :deliveryAuthorities delivery-authorities
     :threadOutcomes (count (filter #(get-in % [:evidence :hasOutcome]) rows))
     :threadClosedEvidenced (get statuses "thread-closed-evidenced" 0)
     :threadOpenEvidenced (get statuses "thread-open-evidenced" 0)
     :threadPartialEvidence (get statuses "partial" 0)
     :threadUnevidenced (get statuses "unevidenced" 0)
     :threadNoContract (get statuses "no-contract" 0)
     :escalated (count (filter #(pos? (:escalations %)) rows))}))

(defn performance-report
  ([rows] (performance-report rows false))
  ([rows all?]
   (let [all-rows (vec rows)
         selected (if all? all-rows (vec (filter complete-current-managed-run? all-rows)))]
     {:report "performance"
      :scope (if all? "all-history" "complete-current-managed")
      :evidenceVersion "v4"
      :claim "complete applied Gaffer contract plus proof-valid process/delivery outcomes; reported is run-scoped self-report, independent verification is unavailable under shared-UID lanes, and mutable thread review context is separate; not causal model quality"
      :runs (count selected)
      :availableRuns (count all-rows)
      :excludedRuns (- (count all-rows) (count selected))
      :cohorts (->> selected (group-by cohort-label) (map performance-row) (sort-by :cohort) vec)})))

(defn usage-row [[provider rows]]
  (let [tokens (keep :tokens rows)
        token-runs (count tokens)
        runs (count rows)
        durations (keep :durationMs rows)
        duration-runs (count durations)
        duration-ms (when (seq durations) (reduce + durations))
        turns (keep :turns rows)
        turn-runs (count turns)]
    {:provider provider :runs (count rows)
     :tokens (when (seq tokens) (reduce + tokens)) :tokenRuns token-runs
     :tokenCoverage {:exactRuns token-runs :runs runs}
     :tokenEvidence (cond
                      (zero? token-runs) "unobserved"
                      (= token-runs runs) "exact"
                      :else "lower-bound")
     :wallMilliseconds duration-ms
     :wallSeconds (when duration-ms (/ (double duration-ms) 1000.0))
     :durationRuns duration-runs
     :durationCoverage {:exactRuns duration-runs :runs runs}
     :durationEvidence (cond
                         (zero? duration-runs) "unobserved"
                         (= duration-runs runs) "exact"
                         :else "lower-bound")
     :turns (when (seq turns) (reduce + turns))
     :turnRuns turn-runs
     :turnCoverage {:exactRuns turn-runs :runs runs}
     :turnEvidence (cond
                     (zero? turn-runs) "unobserved"
                     (= turn-runs runs) "exact"
                     :else "lower-bound")
     :fallbacks (reduce + (map :fallbacks rows))
     :escalatedRuns (count (filter #(pos? (:escalations %)) rows))}))

(defn usage-report [rows]
  {:report "usage" :unit "observed work, never dollars or API credits"
   :runs (count rows) :providers (->> rows (group-by :provider) (map usage-row) (sort-by :provider) vec)})

(defn promotion-variant-key [row]
  (if (seq (:legacyDebtReasons row))
    ;; Incomplete historical evidence is debt local to this run. Never let two
    ;; missing hashes manufacture semantic recurrence merely by sharing an ID.
    [:legacy (:entity row)]
    [:variant (:appliedFingerprintVersion row) (:appliedFingerprintDomain row)
     (:appliedContractSha256 row) (:appliedCapabilities row)
     (get-in row [:effectiveAxes :taskGrade])
     (get-in row [:effectiveAxes :domains])
     (get-in row [:effectiveAxes :topology])
     (get-in row [:effectiveAxes :tier])
     (get-in row [:effectiveAxes :reasoning])
     (get-in row [:effectiveAxes :posture])]))

(defn promotion-row [[_ rows]]
  (let [threads (set (keep :thread rows))
        ;; Managed lanes currently share one OS uid. Historical "verified"
        ;; projections used caller-controlled AGENT_ID and are display-only:
        ;; they cannot qualify a reusable staffing pattern for promotion.
        independently-verified 0
        qualified []
        qualified-threads (set (map :thread qualified))
        flagged (some :promotionCandidate rows)
        debt (vec (sort (set (mapcat :legacyDebtReasons rows))))
        legacy? (boolean (seq debt))
        recurrent (and (not legacy?) (>= (count qualified-threads) 2))
        review-status (cond
                        legacy? "legacy-debt"
                        (not flagged) "not-requested"
                        (not recurrent) "verification-boundary-unavailable"
                        :else "review-candidate")
        composition-ids (vec (sort (set (keep :compositionId rows))))
        labels (if legacy?
                 ["gaffer:legacy-debt"]
                 (mapv #(str "gaffer:bespoke:" %) composition-ids))
        representative (first rows)]
    {:compositionId (when (= 1 (count composition-ids)) (first composition-ids))
     :compositionIds composition-ids :compositionLabels labels
     :appliedContractSha256 (when-not legacy? (:appliedContractSha256 representative))
     :fingerprintVersion (when-not legacy? (:appliedFingerprintVersion representative))
     :fingerprintDomain (when-not legacy? (:appliedFingerprintDomain representative))
     :appliedDomainRequirementCount (when-not legacy?
                                      (:appliedDomainRequirementCount representative))
     :requestedAppliedIntegrity (vec (sort (set (map :requestedAppliedIntegrity rows))))
     :appliedCapabilities (when-not legacy? (:appliedCapabilities representative))
     :effectiveAxes (when-not legacy? (:effectiveAxes representative))
     :legacyDebt legacy? :legacyDebtReasons debt
     :runs (count rows) :distinctThreads (count threads)
     :qualifiedRuns (count qualified) :qualifiedThreads (count qualified-threads)
     :recurrent recurrent
     :nearestPresets (vec (sort (set (keep :nearestPreset rows))))
     :operationalRan (count (filter #(= "ran" (:processOutcome %)) rows))
     :independentlyVerified independently-verified
     :promotionRequested (boolean flagged)
     :reviewStatus review-status
     :note "recurrence is evidence for human review; this report never promotes a role"}))

(defn promotions-report [rows]
  (let [bespoke (filter #(= "bespoke" (:compositionKind %)) rows)
        groups (group-by promotion-variant-key bespoke)
        id-variants (reduce (fn [acc row]
                              (if (or (seq (:legacyDebtReasons row)) (nil? (:compositionId row))) acc
                                (update acc (:compositionId row) (fnil conj #{})
                                        (promotion-variant-key row))))
                            {} bespoke)
        variant-counts (into {} (map (fn [[id variants]] [id (count variants)]) id-variants))
        composition-rows
        (map (fn [group]
               (let [row (promotion-row group)
                     ids (:compositionIds row)
                     aliases (if (> (count ids) 1) ids [])
                     drifted (vec (filter #(> (get variant-counts % 0) 1) ids))]
                 (assoc row
                        :aliasCompositionIds aliases
                        :driftedCompositionIds drifted
                        :hasAliasEvidence (boolean (seq aliases))
                        :hasDriftEvidence (boolean (seq drifted)))))
             groups)]
    {:report "promotions"
     :fingerprintVersion bespoke-fingerprint-version
     :fingerprintDomain bespoke-fingerprint-domain
     :claim (str "observed bespoke variants grouped by applied canonical contract hash, canonical "
                 "capabilities, and effective routing axes (including normalized domains); "
                 "version/domain, explicit domain-count evidence, and requested/applied integrity "
                 "are checked; incomplete evidence remains per-run legacy debt; never automatic promotion")
     :compositions (->> composition-rows
                        (sort-by (juxt :legacyDebt (comp - :distinctThreads)
                                      #(or (:appliedContractSha256 %) "")
                                      #(str/join "," (:compositionIds %))))
                        vec)}))

(defn calibration-observation-valid? [row]
  (let [grade (:judgmentGrade row)
        status (:judgmentGradeStatus row)
        source (:judgmentGradeSource row)
        topology (:struggleTopology row)
        repeat-threshold (:struggleLoopRepeatThreshold row)
        loop-window (:struggleLoopWindow row)
        triggers (:struggleTriggers row)]
    (and (= "valid" status)
         (judgment-grade-values grade)
         (= "thread" source)
         (#{"worker" "orchestrator"} topology)
         (attributed? (:struggleDetectorPolicyVersion row))
         (every? pos-int?
                 [(:struggleErrorStreakThreshold row)
                  repeat-threshold loop-window
                  (:struggleNoProgressTurnThreshold row)])
         (<= repeat-threshold loop-window)
         (some? (:struggleErrorCount row))
         (not (neg? (:struggleErrorCount row)))
         (= (count triggers) (count (distinct triggers)))
         (every? struggle-trigger-values triggers))))

(defn calibration-cohort-key [row]
  [(:judgmentGrade row) (:struggleTopology row)
   (:struggleDetectorPolicyVersion row)
   (:struggleErrorStreakThreshold row)
   (:struggleLoopRepeatThreshold row)
   (:struggleLoopWindow row)
   (:struggleNoProgressTurnThreshold row)])

(defn calibration-row [[[grade topology version error-streak loop-repeat loop-window no-progress]
                        rows]]
  (let [triggers (mapcat :struggleTriggers rows)]
    {:judgmentGrade grade
     :topology topology
     :policyVersion version
     :thresholds {:errorStreak error-streak
                  :loopRepeat loop-repeat
                  :loopWindow loop-window
                  :noProgressTurns no-progress}
     :runs (count rows)
     :struggleRuns (count (filter #(seq (:struggleTriggers %)) rows))
     :triggerCounts (into (sorted-map) (frequencies triggers))
     :errorCount (reduce + (map :struggleErrorCount rows))}))

(defn calibration-report [rows]
  (let [all-rows (vec rows)
        valid-rows (vec (filter calibration-observation-valid? all-rows))
        exact-grade-counts (frequencies (map :judgmentGrade valid-rows))
        statuses (frequencies (map #(or (:judgmentGradeStatus %) "unrecorded") all-rows))]
    {:report "calibration"
     :claim (str "judgment grade and detector configuration are immutable run-local observations; "
                 "current thread facts are never calibration inputs")
     :runs (count all-rows)
     :eligibleRuns (count valid-rows)
     :excludedRuns (- (count all-rows) (count valid-rows))
     :gradeStatus {:valid (get statuses "valid" 0)
                   :unavailable (get statuses "unavailable" 0)
                   :invalid (get statuses "invalid" 0)
                   :unrecorded (get statuses "unrecorded" 0)}
     :gradeCounts {:s (get exact-grade-counts "s" 0)
                   :m (get exact-grade-counts "m" 0)
                   :l (get exact-grade-counts "l" 0)}
     :cohorts (->> valid-rows
                   (group-by calibration-cohort-key)
                   (map calibration-row)
                   (sort-by (juxt :judgmentGrade :topology :policyVersion))
                   vec)}))

(defn report [kind rows & [{:keys [all?] :or {all? false}}]]
  (case kind
    "performance" (performance-report rows all?)
    "usage" (usage-report rows)
    "promotions" (promotions-report rows)
    "calibration" (calibration-report rows)
    (throw (ex-info "usage: north routing report [performance|usage|promotions|calibration] [--json] [--all]" {}))))

(defn print-table [data]
  (case (:report data)
    "performance"
    (do (println (str "ROUTING PERFORMANCE — "
                      (if (= "all-history" (:scope data))
                        "all historical rows"
                        "complete current managed runs")))
        (println "Current rows require complete applied Gaffer evidence; reported delivery is exact run-scoped self-report, independent verification is unavailable under shared-UID lanes, and mutable thread evidence is not model quality.")
        (when (pos? (:excludedRuns data))
          (println (format "%d legacy/incomplete/unattributed row(s) excluded; use --all to inspect them."
                           (:excludedRuns data))))
        (println (format "%-38s %5s %5s %5s %5s %5s %5s %5s %5s %5s %5s"
                         "COHORT provider/tier/role/grade" "runs" "ran"
                         "d-ver" "d-rpt" "d-unv" "d-blk" "t-cls" "t-part" "t-none" "esc"))
        (doseq [row (:cohorts data)]
          (println (format "%-38s %5d %5d %5d %5d %5d %5d %5d %5d %5d %5d"
                           (:cohort row) (:runs row) (:operationalRan row)
                           (:deliveryVerified row) (:deliveryReported row)
                           (:deliveryUnverified row) (:deliveryBlocked row)
                           (:threadClosedEvidenced row)
                           (:threadPartialEvidence row)
                           (+ (:threadUnevidenced row) (:threadNoContract row))
                           (:escalated row))))
        (when (empty? (:cohorts data))
          (println "  (no complete current managed runs; use --all for historical rows)")))
    "usage"
    (do (println "ROUTING USAGE — observed work (never dollars or API credits)")
        (println (format "%-14s %6s %16s %11s %14s %11s %12s %11s %9s %9s"
                         "PROVIDER" "runs" "tokens" "tok exact" "wall-s"
                         "wall exact" "turns" "turn exact" "fallbacks" "escalated"))
        (doseq [row (:providers data)]
          (let [{token-exact :exactRuns token-runs :runs} (:tokenCoverage row)
                {duration-exact :exactRuns duration-runs :runs} (:durationCoverage row)
                {turn-exact :exactRuns turn-runs :runs} (:turnCoverage row)
                token-label (case (:tokenEvidence row)
                              "exact" (str (:tokens row))
                              "lower-bound" (str (:tokens row) "+")
                              "unobserved")
                wall-value (when-let [seconds (:wallSeconds row)]
                             (if (== seconds (Math/floor seconds))
                               (format "%.0f" seconds)
                               (format "%.3f" seconds)))
                wall-label (case (:durationEvidence row)
                             "exact" wall-value
                             "lower-bound" (str wall-value "+")
                             "unobserved")
                turn-label (case (:turnEvidence row)
                             "exact" (str (:turns row))
                             "lower-bound" (str (:turns row) "+")
                             "unobserved")]
            (println (format "%-14s %6d %16s %11s %14s %11s %12s %11s %9d %9d"
                             (:provider row) (:runs row)
                             token-label (str token-exact "/" token-runs)
                             wall-label (str duration-exact "/" duration-runs)
                             turn-label (str turn-exact "/" turn-runs)
                             (:fallbacks row)
                             (:escalatedRuns row))))))
    "promotions"
    (do (println "BESPOKE PATTERNS — stock-template review candidates")
        (println "Variants use applied canonical hash + capabilities + effective axes; missing hashes are per-run legacy debt.")
        (println "Recurrence nominates human review; it never adds or changes a stock template.")
        (if (empty? (:compositions data)) (println "  (no bespoke compositions observed)")
          (doseq [row (:compositions data)]
            (let [label (str/join "," (:compositionLabels row))
                  hash (or (:appliedContractSha256 row) "missing")
                  capabilities (str/join "," (or (:appliedCapabilities row) []))]
              (println (format "%-34s threads=%d runs=%d verified=%d  %s"
                               label (:distinctThreads row) (:runs row)
                               (:independentlyVerified row) (:reviewStatus row)))
              (println (str "  hash=" hash " capabilities=" capabilities))
              (println "  requested↔applied="
                       (str/join "," (:requestedAppliedIntegrity row)))
              (when-let [axes (:effectiveAxes row)] (println "  axes=" (pr-str axes)))
              (when (:hasAliasEvidence row)
                (println "  aliases=" (str/join "," (:aliasCompositionIds row))))
              (when (:hasDriftEvidence row)
                (println "  drift=" (str/join "," (:driftedCompositionIds row))))
              (when (:legacyDebt row)
                (println "  debt=" (str/join "," (:legacyDebtReasons row))))))))
    "calibration"
    (do
      (println "ROUTING CALIBRATION — immutable run-local judgment + struggle evidence")
      (println (format "runs=%d eligible=%d excluded=%d status=%s grades=%s"
                       (:runs data) (:eligibleRuns data) (:excludedRuns data)
                       (pr-str (:gradeStatus data)) (pr-str (:gradeCounts data))))
      (if (empty? (:cohorts data))
        (println "  (no complete run-local calibration observations)")
        (doseq [row (:cohorts data)]
          (println (format "%s/%s runs=%d struggle=%d errors=%d thresholds=%s triggers=%s"
                           (:judgmentGrade row) (:topology row) (:runs row)
                           (:struggleRuns row) (:errorCount row)
                           (pr-str (:thresholds row))
                           (pr-str (:triggerCounts row)))))))))

(defn -main [& args]
  (let [[verb kind & flags] args
        allowed-flags #{"--json" "--all"}
        unknown-flags (remove allowed-flags flags)
        all? (some #{"--all"} flags)]
    (when-not (= verb "report")
      (binding [*out* *err*] (println "usage: north routing report [performance|usage|promotions|calibration] [--json] [--all]"))
      (System/exit 2))
    (when (seq unknown-flags)
      (binding [*out* *err*]
        (println "unknown routing report option:" (first unknown-flags))
        (println "usage: north routing report [performance|usage|promotions|calibration] [--json] [--all]"))
      (System/exit 2))
    (when (and all? (not= (or kind "performance") "performance"))
      (binding [*out* *err*] (println "--all applies only to the performance report"))
      (System/exit 2))
    (let [facts (fold-facts (read-ops (default-paths)))
          data (report (or kind "performance") (run-rows facts) {:all? all?})]
      (if (some #{"--json"} flags)
        (println (json/generate-string data))
        (print-table data)))))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
