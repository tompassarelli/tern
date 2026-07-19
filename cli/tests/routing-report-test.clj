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
