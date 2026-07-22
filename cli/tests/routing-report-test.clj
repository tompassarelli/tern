#!/usr/bin/env bb
(require '[babashka.process :as proc]
         '[cheshire.core :as json]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root (.getCanonicalPath (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(load-file (str root "/cli/routing-report.clj"))
(def tmp (.toFile (java.nio.file.Files/createTempDirectory "north-routing-report" (make-array java.nio.file.attribute.FileAttribute 0))))
(def coord (io/file tmp "coordination.log"))
(def telem (io/file tmp "telemetry.log"))

(defn fact [file l p r]
  (spit file (str (pr-str {:op "assert" :l l :p p :r r}) "\n") :append true))

(defn run! [kind & flags]
  (let [opts {:out :string :err :string :extra-env {"FRAM_LOG" (.getPath coord)
                                                     "FRAM_TELEMETRY_LOG" (.getPath telem)}}
        argv (into ["bb" (str root "/cli/routing-report.clj")
                    "report" kind "--json"]
                   flags)
        result (apply proc/shell opts argv)]
    (when-not (zero? (:exit result)) (throw (ex-info (:err result) result)))
    (json/parse-string (str/trim (:out result)) true)))

(defn check [label ok]
  (println (str (if ok "ok:   " "FAIL: ") label))
  (when-not ok (System/exit 1)))

(def fingerprint-version "v1")
(def fingerprint-domain "north:bespoke-contract:v1")
(def hash-a (apply str (repeat 64 "a")))
(def hash-b (apply str (repeat 64 "b")))
(def hash-c (apply str (repeat 64 "c")))
(def hash-d (apply str (repeat 64 "d")))
(def hash-e (apply str (repeat 64 "e")))
(def hash-f (apply str (repeat 64 "f")))

(defn verified-thread! [id]
  (fact coord id "title" (str "Thread " id))
  (fact coord id "outcome" "landed")
  (fact coord id "done_when" "tests pass")
  (fact coord id "bar_evidence" "tests pass → exit 0"))

(doseq [id ["@thread-a" "@thread-b" "@thread-d" "@thread-e" "@thread-f"
            "@thread-g" "@thread-h" "@thread-i" "@thread-j"
            "@thread-legacy-a" "@thread-legacy-b" "@thread-preset"]]
  (verified-thread! id))

(defn run-facts!
  ([run thread provider outcome tokens]
   (run-facts! run thread provider outcome tokens "1000" nil))
  ([run thread provider outcome tokens duration turns]
   (fact telem run "kind" "run")
   (fact telem run "agent" (str "agent-" (subs run 5)))
   (fact telem run "thread" thread)
   (when provider (fact telem run "provider" provider))
   (fact telem run "requested_tier" "senior")
   (fact telem run "model" "test-model")
   (fact telem run "effort" "high")
   (fact telem run "role" "migration-forensics")
   (fact telem run "task_grade" "staff")
   (fact telem run "outcome" outcome)
   (fact telem run "process_outcome" outcome)
   (fact telem run "delivery_outcome" (if (= outcome "ran") "unverified" "blocked"))
   (fact telem run "delivery_reason"
         (if (= outcome "ran")
           "provider process completed without external delivery proof"
           "provider process did not complete"))
   (when tokens (fact telem run "tokens" tokens))
   (when duration (fact telem run "duration_ms" duration))
   (when turns (fact telem run "num_turns" turns))))

(defn struggle-observation! [run topology no-progress error-count triggers]
  (fact telem run "struggle_detector_policy_version" "north:struggle-observer:v1")
  (fact telem run "struggle_topology" topology)
  (fact telem run "struggle_error_streak_threshold" "3")
  (fact telem run "struggle_loop_repeat_threshold" "3")
  (fact telem run "struggle_loop_window" "20")
  (fact telem run "struggle_no_progress_turn_threshold" (str no-progress))
  (fact telem run "error_count" (str error-count))
  (doseq [trigger triggers] (fact telem run "struggle" trigger)))

(defn requested-fingerprint! [run hash version domain]
  (let [identity (str "@agent:agent-" (subs run 5))]
    (when hash (fact coord identity "composition_contract_sha256" hash))
    (when version (fact coord identity "composition_contract_fingerprint_version" version))
    (when domain (fact coord identity "composition_contract_fingerprint_domain" domain))))

(defn applied-bespoke!
  ([run composition-id hash domains] (applied-bespoke! run composition-id hash domains true))
  ([run composition-id hash domains emit-domain-count?]
   (fact telem run "composition_kind" "bespoke")
   (fact telem run "composition_id" composition-id)
   (fact telem run "role" composition-id)
   (fact telem run "nearest_preset" "analyst")
   (fact telem run "bespoke_reason" "PRIVATE RATIONALE CANARY: provenance plus schema recovery")
   (fact telem run "promotion_candidate" "true")
   (fact telem run "prompt_composition_applied" "true")
   (fact telem run "applied_role_contract" (str "bespoke:" composition-id))
   (when hash
     (fact telem run "applied_bespoke_contract_sha256" hash)
     (fact telem run "applied_bespoke_contract_fingerprint_version" fingerprint-version)
     (fact telem run "applied_bespoke_contract_fingerprint_domain" fingerprint-domain)
     (requested-fingerprint! run hash fingerprint-version fingerprint-domain))
   ;; Reverse input order on selected fixtures; the report must restore Gaffer's
   ;; canonical vocabulary order before building the semantic variant key.
   (doseq [capability (if (= run "@run-b")
                        ["web" "filesystem.read" "filesystem.search"]
                        ["filesystem.search" "filesystem.read" "web"])]
     (fact telem run "applied_capability" capability))
   (fact telem run "applied_task_grade" "staff")
   (fact telem run "task_grade" "staff")
   (fact telem run "applied_topology" "worker")
   (fact telem run "topology" "worker")
   (fact telem run "applied_routing_tier" "senior")
   (fact telem run "routing_tier" "senior")
   (fact telem run "applied_reasoning" "high")
   (fact telem run "requested_reasoning" "high")
   (fact telem run "applied_posture" "preserve")
   (fact telem run "routing_posture" "preserve")
   (doseq [domain domains]
     (fact telem run "domain_requirement" domain)
     (fact telem run "applied_domain_requirement" domain))
   (when emit-domain-count?
     (fact telem run "applied_domain_requirement_count" (str (count domains))))))

(defn applied-preset! [run composition-id]
  (fact telem run "composition_kind" "preset")
  (fact telem run "composition_id" composition-id)
  (fact telem run "role" composition-id)
  (fact telem run "prompt_composition_applied" "true")
  (fact telem run "applied_role_contract" (str "preset:" composition-id))
  (doseq [capability ["filesystem.read" "filesystem.search" "filesystem.write" "shell"]]
    (fact telem run "applied_capability" capability))
  (fact telem run "applied_task_grade" "senior")
  (fact telem run "task_grade" "senior")
  (fact telem run "applied_topology" "worker")
  (fact telem run "topology" "worker")
  (fact telem run "applied_routing_tier" "senior")
  (fact telem run "routing_tier" "senior")
  (fact telem run "applied_reasoning" "high")
  (fact telem run "requested_reasoning" "high")
  (fact telem run "applied_posture" "deliver")
  (fact telem run "routing_posture" "deliver")
  (fact telem run "applied_domain_requirement_count" "0"))

(defn verified-lane! [run thread]
  (let [agent (str "agent-" (subs run 5))
        subject (str "@agent:" agent)
        evidence (json/generate-string
                  (array-map
                   "version" "north:done-bars:v1"
                   "run" run
                   "thread" (str "@" thread)
                   "reporter" subject
                   "capturedAt" "2026-07-18T10:00:00Z"
                   "baselineEvidenceSha256" (sha256 "[]")
                   "doneWhen" ["tests pass"]
                   "matches" [{"bar" "tests pass"
                               "evidence" ["tests pass → exit 0"]}]))
        evidence-hash (sha256 evidence)
        attestation (json/generate-string
                     (array-map
                      "version" "north:delivery-attestation:v1"
                      "target" subject
                      "run" run
                      "thread" (str "@" thread)
                      "evidenceSha256" evidence-hash
                      "actor" "@agent:verifier-proof"
                      "role" "verifier"
                      "authority" "managed-independent-verifier"
                      "attestedAt" "2026-07-18T10:01:00Z"))
        terminal {"outcome" "ran" "process_outcome" "ran"
                  "delivery_outcome" "verified"
                  "delivery_reason" "independent_managed_verifier_attested"
                  "delivery_evidence" evidence
                  "delivery_evidence_sha256" evidence-hash
                  "delivery_attestation" attestation
                  "delivery_attestation_sha256" (sha256 attestation)}
        marker (north.terminal-projection/terminal-manifest-sha256 terminal)]
    (doseq [[predicate value] terminal]
      (fact coord subject predicate value))
    (fact coord subject "terminal_manifest_sha256" marker)))

(let [template (get-in (current-preset-catalog) [:presets "integrator"])
      exact-axes (:axes template)
      changed-axes (assoc exact-axes :tier "standard")
      override-reason "test override rationale"
      override-reason-hash (sha256 override-reason)
      exact (preset-application-debt
             template exact-axes (:capabilities template) [] nil [] nil)
      matched (preset-application-debt
               template changed-axes (:capabilities template)
               ["tier"] override-reason ["tier"] override-reason-hash)
      stale (preset-application-debt
             template changed-axes (:capabilities template) [] nil [] nil)
      malformed (preset-application-debt
                 template changed-axes (:capabilities template)
                 ["tier" "bogus"] override-reason ["taskGrade"] "not-a-digest")
      wrong-rationale-hash (preset-application-debt
                            template changed-axes (:capabilities template)
                            ["tier"] override-reason ["tier"] hash-a)
      unexpected (preset-application-debt
                  template exact-axes (:capabilities template)
                  ["tier"] override-reason ["tier"] override-reason-hash)
      capability-drift (preset-application-debt
                        template exact-axes ["filesystem.read"] [] nil [] nil)
      requested-exact (requested-applied-axis-debt exact-axes exact-axes)
      requested-corrupt (requested-applied-axis-debt
                         (-> exact-axes
                             (assoc :tier "economy")
                             (assoc :domains ["wrong-domain"]))
                         exact-axes)
      requested-missing (requested-applied-axis-debt
                         (assoc exact-axes :reasoning nil)
                         exact-axes)]
  (check "exact current stock template needs no override evidence" (empty? exact))
  (check "a real preset delta with exact dual evidence and rationale hash is current"
         (empty? matched))
  (check "stale preset axes without override provenance are rejected"
         (= #{"composition-override-coverage-mismatch"
              "applied-preset-override-coverage-mismatch"
              "missing-composition-override-reason"
              "missing-applied-preset-override-reason-sha256"}
            (set stale)))
  (check "malformed override names, coverage, and digest are rejected"
         (= #{"invalid-composition-override-evidence"
              "applied-preset-override-coverage-mismatch"
              "invalid-applied-preset-override-reason-sha256"}
            (set malformed)))
  (check "a well-formed digest must match the requested override rationale"
         (= ["applied-preset-override-reason-sha256-mismatch"]
            wrong-rationale-hash))
  (check "override evidence is forbidden when the template is exact"
         (= ["unexpected-preset-override-evidence"] unexpected))
  (check "current template capability drift is rejected"
         (= ["preset-applied-capabilities-mismatch"] capability-drift))
  (check "requested Gaffer axes matching applied evidence add no debt"
         (empty? requested-exact))
  (check "requested tier and normalized domains cannot mislabel applied cohorts"
         (= ["requested-applied-axes-mismatch:tier,domainRequirements"]
            requested-corrupt))
  (check "missing requested Gaffer axes are hard current-evidence debt"
         (= ["missing-requested-axes:reasoning"]
            requested-missing)))

(doseq [[run thread provider outcome tokens duration turns]
        [["@run-a" "thread-a" "openai" "ran" "100" "1000" "2"]
         ;; The SDK historically emitted 0 when a successful result omitted
         ;; num_turns. It is absence, not exact zero-turn evidence.
         ["@run-b" "thread-b" "anthropic" "ran" "200" "1000" "0"]
         ["@run-c" "(ad-hoc)" "openai" "died" "50" "0" nil]
         ["@run-unknown" "(ad-hoc)" "anthropic" "died" nil "1000" nil]
         ["@run-unattributed" "(ad-hoc)" nil "died" nil "1000" "3"]
         ["@run-preset" "thread-preset" "openai" "ran" nil "1000" nil]
         ["@run-incomplete" "(ad-hoc)" "openai" "ran" nil "1000" nil]
         ["@run-unknown-preset" "(ad-hoc)" "openai" "ran" nil "1000" nil]]]
  (run-facts! run thread provider outcome tokens duration turns))

;; Same applied contract + effective axes, deliberately different improvised IDs.
(applied-bespoke! "@run-a" "migration-forensics" hash-a [" NIX " "Beagle"])
(applied-bespoke! "@run-b" "schema-archaeologist" hash-a ["beagle " "nix"])
(fact telem "@run-b" "model_availability_target" "claude-personal")
(fact telem "@run-b" "model_availability_source" "claude-agent-sdk:Query.supportedModels")
(fact telem "@run-b" "model_availability_observed_at" "2026-07-20T10:00:00.000Z")
(fact telem "@run-b" "model_availability_model" "test-model")
(fact telem "@run-b" "model_availability_digest" hash-b)
(verified-lane! "@run-a" "thread-a")
(verified-lane! "@run-b" "thread-b")
(fact telem "@run-c" "composition_kind" "none")
(fact telem "@run-c" "composition_id" "old-managed-row")
(fact telem "@run-preset" "role" "integrator")
(fact telem "@run-preset" "task_grade" "senior")
(applied-preset! "@run-preset" "integrator")
(verified-lane! "@run-preset" "thread-preset")
(fact telem "@run-incomplete" "composition_kind" "preset")
(fact telem "@run-incomplete" "composition_id" "integrator")
(fact telem "@run-incomplete" "role" "integrator")
(fact telem "@run-incomplete" "task_grade" "senior")
(applied-preset! "@run-incomplete" "integrator")
(fact telem "@run-incomplete" "role" "designer")
(fact telem "@run-incomplete" "applied_role_contract" "preset:designer")
(applied-preset! "@run-unknown-preset" "removed-template")

(let [rows (vec (run-rows (fold-facts (read-ops [(.getPath coord) (.getPath telem)]))))
      preset (first (filter #(= "@run-preset" (:entity %)) rows))
      bespoke (first (filter #(= "@run-a" (:entity %)) rows))
      incomplete (first (filter #(= "@run-incomplete" (:entity %)) rows))
      unknown-preset (first (filter #(= "@run-unknown-preset" (:entity %)) rows))
      historical-zero-duration (first (filter #(= "@run-c" (:entity %)) rows))
      historical-zero-turn-success (first (filter #(= "@run-b" (:entity %)) rows))]
  (check "an exact preset is complete without bespoke fingerprint debt"
         (and (complete-current-managed-run? preset)
              (empty? (:legacyDebtReasons preset))
              (= "unverified" (:deliveryOutcome preset))
              (= "run" (:deliveryOutcomeSource preset))
              (nil? (:deliveryVerifier preset))
              (nil? (:deliveryAuthority preset))
              (not-any? #(str/includes? % "fingerprint")
                        (:legacyDebtReasons preset))))
  (check "a delivery reason is part of a complete current terminal record"
         (not (complete-current-managed-run?
               (assoc preset :deliveryReasonObserved false))))
  (check "current managed evidence requires attributed model and effort"
         (and (not (complete-current-managed-run? (assoc preset :model "unattributed")))
              (not (complete-current-managed-run? (assoc preset :effort "unrecorded")))))
  (check "mutable thread closure is review context, never labeled verification"
         (= "thread-closed-evidenced" (get-in bespoke [:evidence :status])))
  (check "a complete bespoke run satisfies current v4 evidence"
         (and (complete-current-managed-run? bespoke)
              (= "matched" (:requestedAppliedIntegrity bespoke))
              (empty? (:legacyDebtReasons bespoke))))
  (check "a nominally current row with mismatched applied-role evidence is excluded"
         (and (not (complete-current-managed-run? incomplete))
              (= #{"role-composition-id-mismatch" "applied-role-contract-mismatch"}
                 (set (:legacyDebtReasons incomplete)))))
  (check "a removed or corrupt preset cannot claim current Gaffer evidence"
         (and (not (complete-current-managed-run? unknown-preset))
              (= ["unknown-current-preset"]
                 (:legacyDebtReasons unknown-preset))))
  (check "legacy zero duration is absence, not manufactured wall-clock evidence"
         (nil? (:durationMs historical-zero-duration)))
  (check "historical fallback cohort axes are labeled as requested, never applied"
         (and (= "requested-route:senior" (:tier historical-zero-duration))
              (= "requested:staff" (:taskGrade historical-zero-duration))
              (= "requested-route-fallback" (:tierProvenance historical-zero-duration))
              (= "requested-gaffer-fallback"
                 (:taskGradeProvenance historical-zero-duration))))
  (check "legacy zero-turn success is absence, not exact turn evidence"
         (nil? (:turns historical-zero-turn-success)))
  (check "routing report projects structured exact-model availability evidence"
         (= {:target "claude-personal"
             :source "claude-agent-sdk:Query.supportedModels"
             :observedAt "2026-07-20T10:00:00.000Z"
             :model "test-model"
             :digest hash-b}
            (:modelAvailability historical-zero-turn-success)))
  (check "an explicit preflight zero remains exact zero-turn evidence"
         (= 0 (observed-turns "0" "blocked_preflight"))))

(let [performance (run! "performance")
      all-performance (run! "performance" "--all")
      usage (run! "usage")
      promotions (run! "promotions")
      cohorts (:cohorts performance)
      candidate (first (:compositions promotions))
      openai-usage (first (filter #(= "openai" (:provider %)) (:providers usage)))
      anthropic-usage (first (filter #(= "anthropic" (:provider %)) (:providers usage)))
      unattributed-usage (first (filter #(= "unattributed" (:provider %)) (:providers usage)))]
  (check "performance defaults to complete current managed-run evidence"
         (and (= "complete-current-managed" (:scope performance))
              (= "v4" (:evidenceVersion performance))
              (= 3 (:runs performance)) (= 8 (:availableRuns performance))
              (= 5 (:excludedRuns performance))
              (= 3 (reduce + (map :threadClosedEvidenced cohorts)))
              (= 3 (reduce + (map :runs cohorts)))
              (zero? (reduce + (map :deliveryVerified cohorts)))
              (= 3 (reduce + (map :deliveryUnverified cohorts)))
              (zero? (reduce + (map #(get-in % [:deliveryAuthorities
                                                :managed-independent-verifier] 0)
                                    cohorts)))
              (zero? (reduce + (map :deliveryBlocked cohorts)))))
  (check "performance --all retains legacy and unattributed history explicitly"
         (and (= "all-history" (:scope all-performance))
              (= 8 (:runs all-performance))
              (zero? (:excludedRuns all-performance))
              (= 3 (reduce + (map :deliveryBlocked (:cohorts all-performance))))))
  (check "performance carries an explicit non-causal quality disclaimer"
         (str/includes? (:claim performance) "not causal model quality"))
  (check "usage is subscription-safe and contains no dollar measure"
         (and (= "observed work, never dollars or API credits" (:unit usage))
              (= 350 (reduce + (keep :tokens (:providers usage))))
              (= 3 (reduce + (map :tokenRuns (:providers usage))))
              (= "lower-bound" (:tokenEvidence anthropic-usage))
              (= {:exactRuns 1 :runs 2} (:tokenCoverage anthropic-usage))
              (= "unobserved" (:tokenEvidence unattributed-usage))
              (nil? (:cost usage))))
  (check "mixed duration and turn evidence stays a lower bound with coverage"
         (and (= 4000 (:wallMilliseconds openai-usage))
              (= 4.0 (:wallSeconds openai-usage))
              (= "lower-bound" (:durationEvidence openai-usage))
              (= {:exactRuns 4 :runs 5} (:durationCoverage openai-usage))
              (= 2 (:turns openai-usage))
              (= "lower-bound" (:turnEvidence openai-usage))
              (= {:exactRuns 1 :runs 5} (:turnCoverage openai-usage))))
  (check "fully observed duration and turns remain exact"
         (and (= "exact" (:durationEvidence unattributed-usage))
              (= {:exactRuns 1 :runs 1} (:durationCoverage unattributed-usage))
              (= 1.0 (:wallSeconds unattributed-usage))
              (= "exact" (:turnEvidence unattributed-usage))
              (= {:exactRuns 1 :runs 1} (:turnCoverage unattributed-usage))
              (= 3 (:turns unattributed-usage))))
  (check "entirely absent turns remain unobserved rather than zero"
         (and (= "unobserved" (:turnEvidence anthropic-usage))
              (= {:exactRuns 0 :runs 2} (:turnCoverage anthropic-usage))
              (nil? (:turns anthropic-usage))))
  (check "bespoke recurrence cannot promote without an enforceable verifier boundary"
         (and (= ["migration-forensics" "schema-archaeologist"] (:compositionIds candidate))
              (= 2 (:distinctThreads candidate)) (zero? (:qualifiedThreads candidate))
              (= "verification-boundary-unavailable" (:reviewStatus candidate))
              (= hash-a (:appliedContractSha256 candidate))
              (= ["filesystem.read" "filesystem.search" "web"] (:appliedCapabilities candidate))
              (= ["beagle" "nix"] (get-in candidate [:effectiveAxes :domains]))
              (= 2 (:appliedDomainRequirementCount candidate))
              (= ["matched"] (:requestedAppliedIntegrity candidate))
              (:hasAliasEvidence candidate)
              (str/includes? (:note candidate) "never promotes")))
  (check "promotion JSON declares the canonical fingerprint version/domain"
         (and (= fingerprint-version (:fingerprintVersion promotions))
              (= fingerprint-domain (:fingerprintDomain promotions))
              (str/includes? (:claim promotions) "effective routing axes")))
  (check "promotion output never exposes bespoke rationale text"
         (not (str/includes? (json/generate-string promotions) "PRIVATE RATIONALE CANARY"))))

;; Same ID, three different effective variants: hash drift and domain drift must
;; split rather than borrow recurrence from the established hash-a/nix+beagle row.
(run-facts! "@run-d" "thread-d" "openai" "ran" nil)
(applied-bespoke! "@run-d" "migration-forensics" hash-b ["nix" "beagle"])
(run-facts! "@run-e" "thread-e" "openai" "ran" nil)
(applied-bespoke! "@run-e" "migration-forensics" hash-a ["database"])

;; Two apparently recurrent legacy rows share an ID but lack applied hashes.
;; They must remain two one-run debt records, never one recurrent composition.
(run-facts! "@run-legacy-a" "thread-legacy-a" "anthropic" "ran" nil)
(applied-bespoke! "@run-legacy-a" "old-improvisation" nil ["nix"])
(run-facts! "@run-legacy-b" "thread-legacy-b" "anthropic" "ran" nil)
(applied-bespoke! "@run-legacy-b" "old-improvisation" nil ["nix"])

;; Two threads are not qualified recurrence when only one run both ran and has
;; verified thread evidence.
(run-facts! "@run-f" "thread-f" "openai" "ran" nil)
(applied-bespoke! "@run-f" "partial-recurrence" hash-c ["nix"])
(run-facts! "@run-g" "thread-g" "openai" "died" nil)
(applied-bespoke! "@run-g" "partial-recurrence" hash-c ["nix"])

;; Requested identity and applied prompt evidence must agree. A mismatch is hard
;; debt even when every other applied field is complete.
(run-facts! "@run-h" "thread-h" "openai" "ran" nil)
(applied-bespoke! "@run-h" "fingerprint-mismatch" hash-d [])
(requested-fingerprint! "@run-h" hash-a fingerprint-version fingerprint-domain)

;; Empty domains are valid only with explicit zero proof; missing or inconsistent
;; counts are evidence debt, not an empty semantic axis.
(run-facts! "@run-i" "thread-i" "openai" "ran" nil)
(applied-bespoke! "@run-i" "domain-count-mismatch" hash-e ["nix"])
(fact telem "@run-i" "applied_domain_requirement_count" "2")
(run-facts! "@run-j" "thread-j" "openai" "ran" nil)
(applied-bespoke! "@run-j" "domain-count-missing" hash-f [] false)

(let [promotions (run! "promotions")
      rows (:compositions promotions)
      recurrent (first (filter #(= hash-a (:appliedContractSha256 %)) rows))
      hash-drift (first (filter #(= hash-b (:appliedContractSha256 %)) rows))
      domain-drift (first (filter #(= ["database"] (get-in % [:effectiveAxes :domains])) rows))
      legacy (filter :legacyDebt rows)
      missing-hash-debt (filter #(some #{"missing-applied-hash"} (:legacyDebtReasons %)) rows)
      partial (first (filter #(= hash-c (:appliedContractSha256 %)) rows))
      fingerprint-debt (first (filter #(some #{"requested-applied-fingerprint-mismatch"}
                                             (:legacyDebtReasons %)) rows))
      count-mismatch (first (filter #(some #{"applied-domain-count-mismatch"}
                                          (:legacyDebtReasons %)) rows))
      count-missing (first (filter #(some #{"missing-applied-domain-count"}
                                         (:legacyDebtReasons %)) rows))]
  (check "applied hash and normalized domains split semantic variants"
         (and (zero? (:qualifiedThreads hash-drift))
              (zero? (:qualifiedThreads domain-drift))
              (= "verification-boundary-unavailable" (:reviewStatus hash-drift))
              (= "verification-boundary-unavailable" (:reviewStatus domain-drift))))
  (check "same semantic variant exposes alias evidence while reused IDs expose drift"
         (and (:hasAliasEvidence recurrent)
              (:hasDriftEvidence recurrent)
              (= ["migration-forensics"] (:driftedCompositionIds recurrent))))
  (check "missing applied hashes are isolated as per-run legacy debt"
         (and (= 2 (count missing-hash-debt))
              (every? #(and (= 1 (:runs %)) (false? (:recurrent %))
                            (= ["gaffer:legacy-debt"] (:compositionLabels %))
                            (= "legacy-debt" (:reviewStatus %)))
                      missing-hash-debt)))
  (check "failed or unverified rows cannot manufacture qualified recurrence"
         (and (= 2 (:distinctThreads partial)) (zero? (:qualifiedThreads partial))
              (= "verification-boundary-unavailable" (:reviewStatus partial))))
  (check "requested/applied fingerprint mismatch is hard per-run debt"
         (and fingerprint-debt (= ["mismatch"] (:requestedAppliedIntegrity fingerprint-debt))
              (= "legacy-debt" (:reviewStatus fingerprint-debt))))
  (check "missing and inconsistent domain-count proofs are hard debt"
         (and count-mismatch count-missing
              (= "legacy-debt" (:reviewStatus count-mismatch))
              (= "legacy-debt" (:reviewStatus count-missing)))))

(try
  (let [env {"FRAM_LOG" (.getPath coord) "FRAM_TELEMETRY_LOG" (.getPath telem)
             "NO_COLOR" "1"}
        performance (:out (proc/shell {:out :string :err :string :extra-env env}
                                      (str root "/bin/north") "routing" "report" "performance"))
        usage (:out (proc/shell {:out :string :err :string :extra-env env}
                                (str root "/bin/north") "routing" "report" "usage"))
        promotions (:out (proc/shell {:out :string :err :string :extra-env env}
                                     (str root "/bin/north") "routing" "report" "promotions"))]
    (check "north routing report is wired through the public CLI"
           (and (str/includes? performance "ROUTING PERFORMANCE")
                (str/includes? performance "complete current managed runs")
                (str/includes? performance "d-unv")
                (str/includes? performance "10 legacy/incomplete/unattributed row(s) excluded")))
    (check "human usage labels mixed evidence as a lower bound with coverage"
           (and (str/includes? usage "200+")
                (re-find #"anthropic\s+4\s+200\+\s+1/4\s+4\s+4/4\s+unobserved\s+0/4"
                         usage)
                (re-find #"openai\s+12\s+150\+\s+2/12\s+11\+\s+11/12\s+2\+\s+1/12"
                         usage)
                (str/includes? usage "unattributed")
                (str/includes? usage "unobserved")
                (not (str/includes? usage "?"))))
    (check "human promotion title frames bespoke patterns as template candidates"
           (str/includes? promotions
                          "BESPOKE PATTERNS — stock-template review candidates"))

    ;; Admission-time run facts are the only calibration input. Mutating the
    ;; current thread grade after the run must not relabel its S cohort.
    (run-facts! "@run-calibration-valid" "thread-preset" "openai" "ran" nil)
    (fact telem "@run-calibration-valid" "judgment_grade" "s")
    (fact telem "@run-calibration-valid" "judgment_grade_status" "valid")
    (fact telem "@run-calibration-valid" "judgment_grade_source" "thread")
    (struggle-observation! "@run-calibration-valid" "worker" 6 2
                           ["no_progress" "tool_loop"])
    (fact coord "@thread-preset" "judgment_grade" "l")

    (run-facts! "@run-calibration-invalid" "thread-preset" "openai" "ran" nil)
    (fact telem "@run-calibration-invalid" "judgment_grade_status" "invalid")
    (fact telem "@run-calibration-invalid" "judgment_grade_source" "thread")
    (struggle-observation! "@run-calibration-invalid" "worker" 6 0 [])

    (run-facts! "@run-calibration-adhoc" "(ad-hoc)" "openai" "ran" nil)
    (fact telem "@run-calibration-adhoc" "judgment_grade_status" "unavailable")
    (fact telem "@run-calibration-adhoc" "judgment_grade_source" "ad-hoc")
    (struggle-observation! "@run-calibration-adhoc" "worker" 6 0 [])

    (let [calibration (run! "calibration")
          cohort (first (:cohorts calibration))]
      (check "calibration uses immutable run-local grade and full detector policy"
             (and (= 20 (:runs calibration))
                  (= 1 (:eligibleRuns calibration))
                  (= {:valid 1 :unavailable 1 :invalid 1 :unrecorded 17}
                     (:gradeStatus calibration))
                  (= {:s 1 :m 0 :l 0} (:gradeCounts calibration))
                  (= "s" (:judgmentGrade cohort))
                  (= "worker" (:topology cohort))
                  (= {:errorStreak 3 :loopRepeat 3 :loopWindow 20 :noProgressTurns 6}
                     (:thresholds cohort))
                  (= 1 (:struggleRuns cohort))
                  (= 2 (:errorCount cohort))
                  (= 1 (get-in cohort [:triggerCounts :no_progress]))
                  (= 1 (get-in cohort [:triggerCounts :tool_loop]))))
      (check "mutable thread grade cannot bleed into completed-run calibration"
             (and (= "l" (one (fold-facts (read-ops [(.getPath coord)]))
                              "@thread-preset" "judgment_grade"))
                  (= "s" (:judgmentGrade cohort)))))

    (let [human-calibration
          (:out (proc/shell {:out :string :err :string :extra-env env}
                            (str root "/bin/north") "routing" "report" "calibration"))]
      (check "human calibration view exposes status and immutable cohorts"
             (and (str/includes? human-calibration "ROUTING CALIBRATION")
                  (str/includes? human-calibration "grades={:s 1, :m 0, :l 0}")
                  (str/includes? human-calibration "s/worker runs=1")))))
  (finally
    (doseq [file (reverse (file-seq tmp))] (io/delete-file file true))))

;; --by-model / --by-effort + read-time alias normalization + provider
;; derivation from a bare model id when no provider fact was recorded.
;; Isolated fixture set so counts here never entangle with the fixed-count
;; assertions above.
(let [tmp2 (.toFile (java.nio.file.Files/createTempDirectory
                     "north-routing-report-models" (make-array java.nio.file.attribute.FileAttribute 0)))
      coord2 (io/file tmp2 "coordination.log")
      telem2 (io/file tmp2 "telemetry.log")
      env2 {"FRAM_LOG" (.getPath coord2) "FRAM_TELEMETRY_LOG" (.getPath telem2)}]
 (try
  (doseq [id ["@thread-model-a" "@thread-model-b"]]
    (fact coord2 id "title" (str "Thread " id)))
  (letfn [(fact2 [l p r] (fact telem2 l p r))
          (run! [kind & flags]
            (let [argv (into ["bb" (str root "/cli/routing-report.clj")
                              "report" kind "--json"] flags)
                  result (apply proc/shell {:out :string :err :string :extra-env env2} argv)]
              (when-not (zero? (:exit result)) (throw (ex-info (:err result) result)))
              (json/parse-string (str/trim (:out result)) true)))
          (run-facts2! [run thread provider tokens model effort]
            (fact2 run "kind" "run")
            (fact2 run "agent" (str "agent-" (subs run 5)))
            (fact2 run "thread" thread)
            (when provider (fact2 run "provider" provider))
            (fact2 run "model" model)
            (fact2 run "effort" effort)
            (fact2 run "outcome" "ran")
            (fact2 run "process_outcome" "ran")
            (fact2 run "delivery_outcome" "unverified")
            (fact2 run "delivery_reason" "provider process completed without external delivery proof")
            (when tokens (fact2 run "tokens" tokens)))]
    (run-facts2! "@run-model-sol" "@thread-model-a" "openai" "500" "gpt-5.6-sol" "high")
    (run-facts2! "@run-model-terra" "@thread-model-b" nil "300" "gpt-5.6-terra" "medium")
    (run-facts2! "@run-model-alias-opus" "@thread-model-a" nil "400" "opus" "high")
    (run-facts2! "@run-model-alias-sonnet" "@thread-model-b" "anthropic" "150" "sonnet" "low")

    (let [rows (vec (run-rows (fold-facts (read-ops [(.getPath coord2) (.getPath telem2)]))))
          terra (first (filter #(= "@run-model-terra" (:entity %)) rows))
          opus (first (filter #(= "@run-model-alias-opus" (:entity %)) rows))
          sonnet (first (filter #(= "@run-model-alias-sonnet" (:entity %)) rows))
          sol (first (filter #(= "@run-model-sol" (:entity %)) rows))]
      (check "a run with a model fact but no provider fact derives provider from the model id"
             (and (= "openai" (:provider terra))
                  (= "derived-from-model" (:providerProvenance terra))))
      (check "a bare alias model normalizes to its canonical id at read time"
             (and (= "claude-opus-4-8" (:model opus))
                  (= "anthropic" (:provider opus))
                  (= "derived-from-model" (:providerProvenance opus))
                  (= "claude-sonnet-5" (:model sonnet))
                  (= "observed" (:providerProvenance sonnet))))
      (check "an observed provider fact is never overridden by derivation"
             (= "openai" (:provider sol))))

    (let [usage (run! "usage")
          usage-by-model (run! "usage" "--by-model")
          usage-by-effort-only (run! "usage" "--by-effort")
          usage-by-model-effort (run! "usage" "--by-model" "--by-effort")
          sol-row (first (filter #(= "gpt-5.6-sol" (:model %)) (:models usage-by-model)))
          terra-row (first (filter #(= "gpt-5.6-terra" (:model %)) (:models usage-by-model)))
          opus-row (first (filter #(= "claude-opus-4-8" (:model %)) (:models usage-by-model)))
          sol-high-row (first (filter #(and (= "gpt-5.6-sol" (:model %)) (= "high" (:effort %)))
                                      (:models usage-by-model-effort)))
          opus-high-row (first (filter #(and (= "claude-opus-4-8" (:model %)) (= "high" (:effort %)))
                                       (:models usage-by-model-effort)))
          unattributed-provider (first (filter #(= "unattributed" (:provider %)) (:providers usage)))]
      (check "usage --json omits models unless --by-model is requested" (nil? (:models usage)))
      (check "usage --by-model includes gpt-5.6-sol and gpt-5.6-terra rows"
             (and sol-row terra-row (= 1 (:runs sol-row)) (= 500 (:tokens sol-row))
                  (= 1 (:runs terra-row)) (= 300 (:tokens terra-row))))
      (check "usage --by-model normalizes alias models into the model row"
             (and opus-row (= 1 (:runs opus-row)) (= 400 (:tokens opus-row))))
      (check "usage --by-model --by-effort splits model rows by effort"
             (and (nil? (:effort sol-row))
                  sol-high-row (= 1 (:runs sol-high-row))
                  opus-high-row (= 1 (:runs opus-high-row))))
      (check "usage --by-effort alone still implies the model x effort breakdown"
             (some? (:models usage-by-effort-only)))
      (check "provider derivation shrinks the unattributed bucket: no unattributed runs remain"
             (nil? unattributed-provider)))

    (let [human-usage-by-model (:out (proc/shell {:out :string :err :string :extra-env env2}
                                                 "bb" (str root "/cli/routing-report.clj")
                                                 "report" "usage" "--by-model"))]
      (check "human usage --by-model table lists per-model rows"
             (and (str/includes? human-usage-by-model "MODEL —")
                  (str/includes? human-usage-by-model "gpt-5.6-sol")
                  (str/includes? human-usage-by-model "gpt-5.6-terra"))))

    (let [bad-flag (proc/shell {:out :string :err :string :continue true :extra-env env2}
                               "bb" (str root "/cli/routing-report.clj")
                               "report" "performance" "--by-model")]
      (check "--by-model is rejected outside the usage report" (not (zero? (:exit bad-flag))))))
  (finally
    (doseq [file (reverse (file-seq tmp2))] (io/delete-file file true)))))

;; Bounded usage is account-complete, deterministically sliced, and keeps
;; unknown token totals distinct from exact zero.
(let [tmp3 (.toFile (java.nio.file.Files/createTempDirectory
                     "north-routing-window" (make-array java.nio.file.attribute.FileAttribute 0)))
      coord3 (io/file tmp3 "coordination.log")
      telem3 (io/file tmp3 "telemetry.log")
      policy3 (io/file tmp3 "routing-policy.json")
      accounts3 (io/file tmp3 "accounts")
      env3 {"FRAM_LOG" (.getPath coord3)
            "FRAM_TELEMETRY_LOG" (.getPath telem3)
            "NORTH_ROUTING_POLICY" (.getPath policy3)
            "NORTH_ACCOUNTS_ROOT" (.getPath accounts3)}]
  (try
    (spit policy3 (json/generate-string
                   {"version" 1
                    "targets" [{"id" "codex-a" "provider" "openai"}
                               {"id" "claude-b" "provider" "anthropic"}]}))
    (let [codex-dir (io/file accounts3 "openai/codex-a/sessions/2026/07/22")
          claude-dir (io/file accounts3 "anthropic/claude-b/projects/test")
          turn-context (fn [at turn model effort]
                         {"timestamp" at "type" "turn_context"
                          "payload" {"turn_id" turn "model" model "effort" effort}})
          token-count (fn [at cumulative tokens]
                        {"timestamp" at "type" "event_msg"
                         "payload" {"type" "token_count"
                                    "info" {"total_token_usage" {"total_tokens" cumulative}
                                            "last_token_usage" {"total_tokens" tokens}}}})
          claude-message (fn [at id tokens]
                           {"timestamp" at "type" "assistant"
                            "message" {"id" id "model" "claude-fable-5"
                                       "usage" {"input_tokens" tokens
                                                "cache_creation_input_tokens" 0
                                                "cache_read_input_tokens" 0
                                                "output_tokens" 0}}})]
      (.mkdirs codex-dir)
      (.mkdirs claude-dir)
      ;; Fork clone: the same turn+cumulative event appears twice. Earliest wins.
      (spit (io/file codex-dir "one.jsonl")
            (str (json/generate-string (turn-context "2026-07-21T18:00:00Z" "turn-a" "gpt-5.6-sol" "high")) "\n"
                 (json/generate-string (token-count "2026-07-21T18:01:00Z" 1000 40)) "\n"
                 (json/generate-string (turn-context "2026-07-22T04:00:00Z" "turn-b" "gpt-5.6-terra" "medium")) "\n"
                 (json/generate-string (token-count "2026-07-22T04:01:00Z" 2000 60)) "\n"))
      (spit (io/file codex-dir "fork.jsonl")
            (str (json/generate-string (turn-context "2026-07-22T05:00:00Z" "turn-a" "gpt-5.6-sol" "high")) "\n"
                 (json/generate-string (token-count "2026-07-22T05:01:00Z" 1000 40)) "\n"))
      ;; Claude repeats the same message while streaming; message.id dedups it.
      (spit (io/file claude-dir "one.jsonl")
            (str (json/generate-string (claude-message "2026-07-22T03:00:00Z" "msg-a" 50)) "\n"
                 (json/generate-string (claude-message "2026-07-22T03:00:01Z" "msg-a" 50)) "\n")))
    (letfn [(window-run! [id target provider model effort at tokens]
              (fact telem3 id "kind" "run")
              (fact telem3 id "agent" (str "agent-" (subs id 5)))
              (fact telem3 id "thread" "(ad-hoc)")
              (fact telem3 id "provider_target" target)
              (fact telem3 id "provider" provider)
              (fact telem3 id "model" model)
              (fact telem3 id "effort" effort)
              (fact telem3 id "at" at)
              (fact telem3 id "outcome" "ran")
              (when (some? tokens) (fact telem3 id "tokens" (str tokens))))
            (window-report []
              (let [result (proc/shell {:out :string :err :string :extra-env env3}
                                       "bb" (str root "/cli/routing-report.clj")
                                       "report" "usage" "--json"
                                       "--window" "24h" "--slice" "12h"
                                       "--now" "2026-07-22T12:00:00Z")]
                (when-not (zero? (:exit result)) (throw (ex-info (:err result) result)))
                (json/parse-string (str/trim (:out result)) true)))]
      (window-run! "@run-window-sol" "codex-a" "openai" "gpt-5.6-sol" "high"
                   "2026-07-21T12:00:00Z" 100)
      (window-run! "@run-window-terra" "codex-a" "openai" "gpt-5.6-terra" "medium"
                   "2026-07-22T01:00:00Z" 300)
      (window-run! "@run-window-unknown" "codex-a" "openai" "gpt-5.6-terra" "medium"
                   "2026-07-22T02:00:00Z" nil)
      (window-run! "@run-window-retired" "retired-codex" "openai" "gpt-5.6-luna" "low"
                   "2026-07-22T03:00:00Z" 50)
      (window-run! "@run-window-claude-overlap" "claude-b" "anthropic" "claude-fable-5" "max"
                   "2026-07-22T03:30:00Z" 70)
      (doseq [[entity values]
               [["@run-window-sol"
                [["response_strategy_id" "none"] ["response_strategy_implementation" "disabled"]
                 ["caveman_mode" "off"] ["caveman_measurement_coverage" "unknown"]
                 ["caveman_source" "default"]
                 ["caveman_decision_reason" "default-off-unproven-savings"]
                 ["mcp_activity_source" "codex-app-server:item-completed"]
                 ["mcp_activity_coverage" "exact"] ["mcp_actual_calls" "0"]]]
               ["@run-window-terra"
                [["response_strategy_id" "caveman"]
                 ["response_strategy_implementation" "fork-skill"]
                 ["response_strategy_version" "020f650daa42a506660a2959f62f2a999d7e1018"]
                 ["caveman_mode" "lite"] ["caveman_measurement_coverage" "exact"]
                 ["caveman_source" "request"] ["caveman_decision_reason" "explicit-request"]
                 ["caveman_repository" "github.com/tompassarelli/caveman"]
                 ["caveman_revision" "020f650daa42a506660a2959f62f2a999d7e1018"]
                 ["caveman_skill_sha256" "e38ec671ecbee47ce234190be12615daf60ac667d775b7340d49d07f4f63c7bc"]
                 ["caveman_skill_bytes" "5009"]
                 ["caveman_rendered_sha256" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
                 ["caveman_rendered_bytes" "3210"] ["caveman_source_kind" "git-object"]
                 ["caveman_resolution_provenance" "local-dev"]
                 ["mcp_activity_source" "codex-app-server:item-completed"]
                 ["mcp_activity_coverage" "exact"] ["mcp_actual_calls" "3"]
                 ["mcp_actual_tool" "{\"server\":\"north\",\"tool\":\"tell\",\"count\":2}"]
                 ["mcp_actual_tool" "{\"server\":\"north\",\"tool\":\"ready\",\"count\":1}"]]]
               ["@run-window-claude-overlap"
                [["response_strategy_id" "caveman"] ["caveman_mode" "full"]
                 ["caveman_source" "env"] ["caveman_decision_reason" "inherited-env"]
                 ["mcp_activity_source" "anthropic-agent-sdk:assistant-tool-use"]
                 ["mcp_activity_coverage" "exact"] ["mcp_actual_calls" "1"]
                 ["mcp_actual_tool" "{\"server\":\"north\",\"tool\":\"show\",\"count\":1}"]]]]]
        (doseq [[predicate value] values] (fact telem3 entity predicate value)))
      ;; The end boundary belongs to a future report, never both adjacent windows.
      (window-run! "@run-window-at-end" "codex-a" "openai" "gpt-5.6-sol" "high"
                   "2026-07-22T12:00:00Z" 999)
      (doseq [[agent provider model effort started]
              [["native-window-opus" "anthropic" "opus" "high" "2026-07-21T18:00:00Z"]
               ["native-window-sol" "openai" "gpt-5.6-sol" "unobserved" "2026-07-22T06:00:00Z"]]]
        (let [identity (str "@agent:" agent)
              session (str "@session:" agent)]
          (fact telem3 identity "kind" "session")
          (fact telem3 identity "provider" provider)
          (fact telem3 identity "model" model)
          (fact telem3 identity "effort" effort)
          (fact telem3 session "agent" agent)
          (fact telem3 session "session_id" agent)
          (fact telem3 session "started_at" started)))
      (let [report (window-report)
            [older recent] (:intervals report)
            cumulative (:cumulative report)
            accounts (:accounts cumulative)
            codex (first (filter #(= "codex-a" (:providerTarget %)) accounts))
            claude (first (filter #(= "claude-b" (:providerTarget %)) accounts))
            retired (first (filter #(= "retired-codex" (:providerTarget %)) accounts))
            sol (first (filter #(= "gpt-5.6-sol" (:model %)) (:breakdown codex)))
            terra (first (filter #(= "gpt-5.6-terra" (:model %)) (:breakdown codex)))]
        (check "window usage emits two adjacent deterministic 12-hour intervals plus cumulative"
               (and (= "bounded-intervals" (:scope report))
                    (= 2 (count (:intervals report)))
                    (= (:end older) (:start recent))
                    (= "2026-07-21T12:00:00Z" (:start older))
                    (= "2026-07-22T12:00:00Z" (:end recent))))
        (check "every configured and in-window used target appears in every interval"
               (and (= ["codex-a" "claude-b" "retired-codex"]
                       (mapv :providerTarget (:accounts older)))
                    (= ["codex-a" "claude-b" "retired-codex"]
                       (mapv :providerTarget (:accounts recent)))))
        (check "unknown token runs remain explicit and never become zero tokens"
               (and (= 5 (:terminalRuns cumulative))
                    (= 4 (:exactTokenRuns cumulative))
                    (= 1 (:unknownTokenRuns cumulative))
                    (= 520 (:exactObservedTokens cumulative))
                    (= 3 (:terminalRuns codex))
                    (= 1 (:unknownTokenRuns codex))
                    (= "lower-bound" (:tokenEvidence codex))
                    (= 70 (:exactObservedTokens claude))))
        (check "account model-effort rows expose exact totals and within-account percentages"
               (and (= 100 (:exactObservedTokens sol))
                    (= 25.0 (:percentageOfAccountExactObservedTokens sol))
                    (= 300 (:exactObservedTokens terra))
                    (= 1 (:unknownTokenRuns terra))
                    (= 75.0 (:percentageOfAccountExactObservedTokens terra))
                    (= 50 (:exactObservedTokens retired))
                    (false? (:configuredNow retired))))
        (check "bounded usage records dated/undated time coverage"
               (= {:datedRuns 6 :undatedRuns 0} (:timeCoverage report)))
        (check "window telemetry reports Caveman provenance and actual MCP calls without guessing legacy"
               (let [older-op (:operationalTelemetry older)
                     recent-op (:operationalTelemetry recent)
                     cumulative-op (:operationalTelemetry cumulative)
                     terra-op (first (filter #(and (= "codex-a" (:account %))
                                                   (= "gpt-5.6-terra" (:model %)))
                                             (:byProviderAccountModel cumulative-op)))
                     provenance (first (filter #(= "caveman" (:strategyId %))
                                               (:responseStrategyProvenance terra-op)))]
                 (and (= {:off 1} (get-in older-op [:coverage :cavemanModeCounts]))
                      (= 0 (get-in older-op [:coverage :mcpActualCalls]))
                      (= {:full 1 :legacy-unknown 2 :lite 1}
                         (get-in recent-op [:coverage :cavemanModeCounts]))
                      (= 4 (get-in recent-op [:coverage :mcpActualCalls]))
                      (= 4 (get-in cumulative-op [:coverage :mcpActualCalls]))
                      (= [{:server "north" :tool "ready" :calls 1}
                          {:server "north" :tool "show" :calls 1}
                          {:server "north" :tool "tell" :calls 2}]
                         (get-in cumulative-op [:coverage :mcpToolDistribution]))
                      ;; One run carries two distinct multi-valued tool facts.
                      (= 2 (count (:mcpToolDistribution terra-op)))
                      (= {:complete 1 :legacy-unknown 1}
                         (:responseStrategyProvenanceCoverageCounts terra-op))
                      (= {:strategyId "caveman" :implementation "fork-skill"
                          :version "020f650daa42a506660a2959f62f2a999d7e1018"
                          :mode "lite" :source "request" :decisionReason "explicit-request"
                          :repository "github.com/tompassarelli/caveman"
                          :revision "020f650daa42a506660a2959f62f2a999d7e1018"
                          :skillSha256 "e38ec671ecbee47ce234190be12615daf60ac667d775b7340d49d07f4f63c7bc"
                          :skillBytes 5009
                          :renderedSha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                          :renderedBytes 3210
                          :sourceKind "git-object" :resolutionProvenance "local-dev"
                          :measurementCoverage "exact" :runs 1}
                         (select-keys provenance
                                      [:strategyId :implementation :version :mode :source
                                       :decisionReason :repository :revision :skillSha256
                                       :skillBytes :renderedSha256 :renderedBytes :sourceKind
                                       :resolutionProvenance :measurementCoverage :runs])))))
        (check "native interactive activity is separate per slice and cumulative"
               (let [older-native (:nativeInteractiveActivity older)
                     recent-native (:nativeInteractiveActivity recent)
                     cumulative-native (:nativeInteractiveActivity cumulative)]
                 (and (= 1 (:sessions older-native))
                      (= 1 (:sessions recent-native))
                      (= 2 (:sessions cumulative-native))
                      (nil? (:exactObservedTokens cumulative-native))
                      (nil? (:providerTarget cumulative-native))
                      (= "unobserved" (:accountAttribution cumulative-native))
                      (false? (:includedInManagedRunPercentages cumulative-native))
                      (= ["claude-opus-4-8" "gpt-5.6-sol"]
                         (mapv :model (:groups cumulative-native)))
                      ;; Managed-run token totals and percentages remain unchanged.
                      (= 520 (:exactObservedTokens cumulative))
                      (= 25.0 (:percentageOfAccountExactObservedTokens sol)))))
        (check "bounded report warns managed token observations are not total subscription consumption"
               (and (= "managed-terminal-runs-only" (:usageScope cumulative))
                    (str/includes? (:claim report) "lower bounds on subscription consumption")))
        (check "account-observed OpenAI dedups fork clones but never assumes managed additivity"
               (let [account (first (filter #(= "codex-a" (:providerTarget %))
                                            (get-in cumulative [:accountObserved :accounts])))
                     persisted (first (:sources account))
                     managed (:managedLedger account)]
                 (and (= 100 (:exactObservedTokens account))
                      (= 100 (:providerOwnedExactObservedTokens account))
                      (nil? (:combinedExactObservedTokens account))
                      (nil? (:combinedPercentageBasis account))
                      (= "cannot-determine" (:overlapStatus account))
                      (= 2 (:observations persisted))
                      (= 2 (:turnAttributedObservations persisted))
                      (= 0 (:fallbackDedupObservations persisted))
                      (= 100 (:exactObservedTokens persisted))
                      (= "north-managed-terminal" (:source managed))
                      (= 2 (:exactTokenRuns managed))
                      (= 400 (:exactObservedTokens managed))
                      (= 1 (:unknownTokenRuns managed))
                      (str/includes? (:overlapReason account) "do not prove")
                      (str/includes? (:combinationSemantics account) "non-additive"))))
        (check "account-observed Anthropic dedups message ids and never adds overlapping managed usage"
               (let [account (first (filter #(= "claude-b" (:providerTarget %))
                                            (get-in cumulative [:accountObserved :accounts])))
                     source (first (:sources account))]
                 (and (= 50 (:exactObservedTokens account))
                      (= 1 (:observations source))
                      (= "known-overlap" (:overlapStatus account))
                      (= 70 (get-in account [:managedLedger :exactObservedTokens]))
                      (nil? (:combinedExactObservedTokens account))
                      ;; The 70-token North managed Anthropic run is deliberately
                      ;; not added: the provider-owned log is the overlap ledger.
                      (not= 120 (:exactObservedTokens account))
                      (nil? (:effort (first (:breakdown account))))
                      (str/includes? (:combinationSemantics account) "non-additive"))))
        (check "account-observed aggregate is provider-owned only and refuses a combined total"
               (and (= 150 (get-in cumulative [:accountObserved :exactObservedTokens]))
                    (= 150 (get-in cumulative [:accountObserved :providerOwnedExactObservedTokens]))
                    (nil? (get-in cumulative [:accountObserved :combinedExactObservedTokens]))
                    (str/includes? (get-in cumulative [:accountObserved :claim])
                                   "non-additive ledgers")))
        (check "fixed event-time windows disclose late/backfill rerun instability"
               (let [repro (:reproducibility report)]
                 (and (= "provider-event-time" (:boundaryBasis repro))
                      (false? (:fixedWindowRerunStable repro))
                      (str/includes? (:caveat repro) "late-appended or backfilled"))))))
  (finally
    (doseq [file (reverse (file-seq tmp3))] (io/delete-file file true)))))

(let [tmp4 (.toFile (java.nio.file.Files/createTempDirectory
                     "north-routing-economics" (make-array java.nio.file.attribute.FileAttribute 0)))
      coord4 (io/file tmp4 "coordination.log")
      telem4 (io/file tmp4 "telemetry.log")
      harness4 (io/file tmp4 "harness.conf")
      policy4 (io/file tmp4 "routing-policy.json")
      accounts4 (io/file tmp4 "accounts")
      env4 {"FRAM_LOG" (.getPath coord4) "FRAM_TELEMETRY_LOG" (.getPath telem4)
            "NORTH_HARNESS_STATE" (.getPath harness4)
            "NORTH_ROUTING_POLICY" (.getPath policy4)
            "NORTH_ACCOUNTS_ROOT" (.getPath accounts4)}]
  (try
    (spit harness4 "dispatch=north\n")
    (spit policy4 (json/generate-string
                   {"version" 1
                    "targets" [{"id" "claude-a" "provider" "anthropic"}
                               {"id" "claude-b" "provider" "anthropic"}
                               {"id" "codex-a" "provider" "openai"}
                               {"id" "codex-b" "provider" "openai"}
                               {"id" "codex-c" "provider" "openai"}]}))
    (let [codex-dir (io/file accounts4 "openai/codex-a/sessions/2026/07/22")]
      (.mkdirs codex-dir)
      (spit (io/file codex-dir "turns.jsonl")
            (apply str
                   (for [i (range 11)
                         row [{"timestamp" (format "2026-07-22T06:00:%02dZ" (* i 2))
                               "type" "turn_context"
                               "payload" {"turn_id" (str "turn-" i)
                                          "model" "gpt-5.6-sol" "effort" "ultra"}}
                              {"timestamp" (format "2026-07-22T06:00:%02dZ" (inc (* i 2)))
                               "type" "event_msg"
                               "payload" {"type" "token_count"
                                          "info" {"total_token_usage" {"total_tokens" (* 10 (inc i))}
                                                  "last_token_usage" {"total_tokens" 10}}}}]]
                     (str (json/generate-string row) "\n")))))
    (doseq [i (range 11)]
      (let [entity (str "@run:economics-" i)
            pin-status (cond (< i 3) "current" (= i 10) "legacy-missing" :else "none")]
        (doseq [[p r] [["kind" "run"] ["agent" (str "economics-lane-" i)]
                       ["thread" "thread-economics"] ["provider" "openai"]
                       ["provider_target" "codex-a"] ["model" "gpt-5.6-sol"]
                       ["effort" "high"] ["tokens" "1000"]
                       ["at" (format "2026-07-22T06:10:%02dZ" i)] ["outcome" "ran"]
                       ["applied_routing_tier" "senior"]
                       ["routing_admission_receipt_version" "1"]
                       ["routing_assessment_status" "recorded"]
                       ["routing_assessment_policy" "minimum-sufficient-v1"]
                       ["routing_derived_tier" "standard"] ["routing_derived_reasoning" "medium"]
                       ["routing_selected_tier" "senior"] ["routing_selected_reasoning" "high"]
                       ["routing_exception_code" "unmodeled-risk"]
                       ["routing_pin_evidence_status" pin-status]
                       ["execution_source" "north-managed"]
                       ["execution_transport" "codex-app-server"]
                       ["provider_session_persistence" "unknown"] ["thread_provenance" "exact"]
                       ["turn_provenance" "provider-terminal"]]]
          (fact telem4 entity p r))))
    (doseq [i (range 11)]
      (let [entity (str "@run:economics-" i)]
        (doseq [[p r] [["prompt_composition_version" "north-harness-prompt:v1"]
                       ["capability_class" "authoring"]
                       ["prompt_stable_prefix_bytes" "8000"]
                       ["prompt_unique_tail_bytes" "2000"]
                       ["prompt_total_bytes" "10000"]
                       ["input_tokens" "800"] ["output_tokens" "200"]
                       ["cache_read_tokens" "400"] ["cache_create_tokens" "100"]
                       ["context_window_status" "observed"]
                       ["provider_context_window_tokens" "400000"]
                       ["context_budget_status" "unknown"]
                       ["compaction_count" "0"]]]
          (fact telem4 entity p r))))
    (doseq [[p r] [["kind" "session"] ["provider" "openai"] ["model" "gpt-5.6-sol"]
                   ["effort" "ultra"] ["native_actor_kind" "subagent"] ["native_depth" "1"]
                   ["dispatch_mode_at_start" "north"]
                   ["execution_source" "provider-native"] ["execution_transport" "provider-hook"]
                   ["provider_session_persistence" "unknown"]]]
      (fact telem4 "@agent:native-economics" p r))
    (doseq [[p r] [["kind" "session"] ["provider" "openai"] ["model" "gpt-5.6-sol"]
                   ["effort" "unobserved"] ["native_actor_kind" "unknown"]
                   ["execution_source" "provider-native"] ["execution_transport" "provider-hook"]
                   ["provider_session_persistence" "unknown"]]]
      (fact telem4 "@agent:native-legacy" p r))
    (doseq [[p r] [["agent" "native-economics"] ["session_id" "native-economics"]
                   ["started_at" "2026-07-22T07:00:00Z"]]]
      (fact telem4 "@session:native-economics" p r))
    (doseq [[p r] [["agent" "native-legacy"] ["session_id" "native-legacy"]
                   ["started_at" "2026-07-22T07:30:00Z"]]]
      (fact telem4 "@session:native-legacy" p r))
    (let [result (proc/shell {:out :string :err :string :extra-env env4}
                             "bb" (str root "/cli/routing-report.clj")
                             "report" "economics" "--json" "--window" "24h" "--slice" "12h"
                             "--now" "2026-07-22T12:00:00Z")
          report (json/parse-string (str/trim (:out result)) true)
          cumulative (:cumulative report)
          codes (set (map :code (:alerts cumulative)))
          human (:out (proc/shell {:out :string :err :string :extra-env env4}
                                   "bb" (str root "/cli/routing-report.clj")
                                   "report" "economics" "--window" "24h" "--slice" "12h"
                                   "--now" "2026-07-22T12:00:00Z"))]
      (check "economics report exits successfully" (zero? (:exit result)))
      (check "economics report exposes premium, promotion, pin, and assessment evidence"
             (and (= 100.0 (get-in cumulative [:managed :premiumTokenSharePercent]))
                  (= 100.0 (get-in cumulative [:managed :promotions :percent]))
                  (= 3 (get-in cumulative [:managed :pins :current]))
                  (= 1 (get-in cumulative [:managed :pins :legacyCompatibleMissing]))
                  (= 0 (get-in cumulative [:managed :pins :legacyUnknown]))
                  (= 100.0 (get-in cumulative [:managed :assessmentCoverage :percentOfCurrent]))
                  (= 11 (get-in cumulative [:managed :provenanceCoverage :complete]))))
      (check "economics alerts have stable alert-only codes"
             (every? codes ["ROUTING_PREMIUM_TOKEN_SHARE_HIGH"
                            "ROUTING_PROMOTION_SHARE_HIGH"
                            "ROUTING_EXACT_PIN_SHARE_HIGH"
                            "ROUTING_LEGACY_PIN_EVIDENCE_MISSING"
                            "OPENAI_PROVIDER_OWNED_HIGH_EFFORT_TOKEN_SHARE_HIGH"
                            "OPENAI_PROVIDER_OWNED_ULTRA_TOKENS_OBSERVED"
                            "NATIVE_DESCENDANTS_UNDER_NORTH_DISPATCH"]))
      (check "economics ratios become cannot-determine below the sample and coverage gates"
             (let [older (first (:intervals report))
                   finding (some #(when (= "ROUTING_PREMIUM_TOKEN_SHARE_INSUFFICIENT_EVIDENCE"
                                          (:code %)) %)
                                 (:findings older))]
               (and (= "cannot-determine" (:status finding))
                    (= 10 (:minimumEligibleRuns finding))
                    (= 80.0 (:minimumEvidenceCoveragePercent finding))
                    (not (some #{"ROUTING_PREMIUM_TOKEN_SHARE_HIGH"}
                               (map :code (:alerts older)))))))
      (check "economics composes the bounded five-account model-effort ledger"
             (and (= 5 (count (get-in cumulative [:usage :accounts])))
                  (= 5 (count (get-in cumulative [:usage :accountObserved :accounts])))
                  (= "ultra" (get-in cumulative [:usage :accountObserved :accounts 2
                                                  :breakdown 0 :effort]))))
      (check "headroom attribution groups exact prompt/cache observations without causal savings claims"
             (let [headroom (:headroomAttribution cumulative)
                   group (first (:groups headroom))]
               (and (= 100.0 (:promptEvidenceCoveragePercent headroom))
                    (= "north-harness-prompt:v1" (:promptCompositionVersion group))
                    (= "authoring" (:capabilityClass group))
                    (= 110000 (:totalPromptBytes group))
                    (= 4400 (:cacheReadTokens group))
                    (= "cannot-determine" (get-in headroom [:savingsVerdict :status]))
                    (= ["controlled-cohort-unavailable"
                        "matched-workload-identity-unavailable"]
                       (get-in headroom [:savingsVerdict :reasons])))))
      (check "native economics exposes root/subagent/depth without guessing legacy rows"
             (and (= "north" (get-in cumulative [:native :currentDispatchModeContext]))
                  (= 1 (get-in cumulative [:native :subagentSessions]))
                  (= 1 (get-in cumulative [:native :unknownActorKind]))
                  (= 1 (get-in cumulative [:native :sessionsByDepth :1]))
                  (= 1 (get-in cumulative [:native :sessionsByDepth :unknown]))))
      (check "human economics output includes all account/model/effort ledgers without stale nulls"
             (and (str/includes? human "ACCOUNT LEDGER")
                  (every? #(str/includes? human %) ["claude-a" "claude-b" "codex-a"
                                                    "codex-b" "codex-c"])
                  (str/includes? human "gpt-5.6-sol")
                  (str/includes? human "/ ultra")
                  (str/includes? human "HEADROOM prompt=11/11")
                  (str/includes? human "savings=cannot-determine")
                  (not (str/includes? human "native-high=null"))
                  (not (str/includes? human "native-ultra=null")))))
  (finally
    (doseq [file (reverse (file-seq tmp4))] (io/delete-file file true)))))
