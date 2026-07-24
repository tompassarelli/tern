#!/usr/bin/env bb
;; Harness-owned agent identity writer. This file is deliberately not routed by
;; `north` or MCP. Its surface is typed and fail-closed: one safe @agent subject,
;; five exact operations, and an exhaustive predicate vocabulary. It is an
;; application-integrity boundary, not same-UID hostile-process isolation.
(require '[cheshire.core :as json]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/agent-provenance.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/terminal-projection.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/lifecycle-projection.clj"))

(def marker-predicate "identity_manifest_sha256")
(def terminal-marker-predicate "terminal_manifest_sha256")
(def base-terminal-predicates
  (set north.terminal-projection/terminal-predicates))
(def delivery-proof-predicates
  (set north.terminal-projection/delivery-proof-predicates))
(def terminal-predicates
  (disj north.agent-provenance/terminal-predicates terminal-marker-predicate))
(def terminal-publication-order
  ;; Readers treat process_outcome without the marker as a partial new-style
  ;; publication. Keep the legacy outcome alias last so it cannot masquerade as
  ;; a complete legacy terminal while a new projection is still being written.
  ["process_outcome" "delivery_evidence" "delivery_evidence_sha256"
   "delivery_attestation" "delivery_attestation_sha256"
   "delivery_outcome" "delivery_reason" "outcome"])
(def terminal-retraction-order
  ;; Once the marker is gone, remove the legacy alias before process_outcome.
  ;; The remaining process_outcome forces modern validation to fail closed; if
  ;; process_outcome disappeared first, a crash could expose stale outcome as a
  ;; valid legacy singleton.
  ["outcome" "process_outcome" "delivery_outcome" "delivery_reason"
   "delivery_attestation_sha256" "delivery_attestation"
   "delivery_evidence_sha256" "delivery_evidence"])
(def route-authority-predicates
  #{"provider" "provider_target" "live_input" "live_input_state"
    "live_input_epoch" "model" "effort"})
(def projection-predicates #{"display_handle" "display_name"})
(def route-predicates (into route-authority-predicates projection-predicates))
(def retask-overlay-predicates #{"goal" "display_name"})
(def route-generation-predicates (disj route-predicates "display_name"))
(def identity-predicates north.agent-provenance/identity-predicates)
(def publish-predicates (into identity-predicates projection-predicates))
(def managed-projection-predicates
  (set north.lifecycle-projection/managed-agent-predicates))
(def required-identity-predicates
  (disj (set north.agent-provenance/required-identity-predicates)
        marker-predicate))
(def writer-timeout-bound-ms
  (parse-long (or (System/getenv "NORTH_IDENTITY_WRITER_TIMEOUT_MS") "10000")))
(def write-lease-ttl-ms
  (parse-long (or (System/getenv "NORTH_IDENTITY_WRITE_LEASE_TTL_MS") "60000")))
(def max-write-lease-wait-ms 5000)
(def ^:dynamic *write-lease* nil)

(defn fail! [message data]
  (throw (ex-info message data)))

(defn checked! [result operation]
  (when (:reject result)
    (fail! "coordinator rejected harness identity write"
           {:operation operation
            :reject (:reject result)
            :version (:version result)}))
  result)

(defn entity [subject]
  (let [raw (str/replace (str subject) #"^@?agent:" "")
        canonical (str "@agent:" raw)]
    (when-not (north.terminal-projection/valid-agent-entity? canonical)
      (fail! "invalid managed agent id" {:subject subject}))
    canonical))

(defn payload [raw]
  (let [parsed (try (json/parse-string (str raw))
                    (catch Exception e
                      (fail! "invalid managed identity JSON" {:cause (.getMessage e)})))]
    (when-not (map? parsed) (fail! "managed identity payload must be an object" {}))
    (into (sorted-map)
          (map (fn [[predicate value]]
                 (when-not (and (string? predicate) (string? value) (not (str/blank? value)))
                   (fail! "managed identity facts must be nonblank strings"
                          {:predicate predicate :value-type (type value)}))
                 ;; The canonical reader intentionally trims display inputs when
                 ;; deciding whether a value is known. Persisting a different raw
                 ;; boundary here would make writer and reader hash different
                 ;; bytes. Reject that ambiguity instead of silently changing the
                 ;; caller's signed projection.
                 (when-not (= value (str/trim value))
                   (fail! "managed identity facts may not carry boundary whitespace"
                          {:predicate predicate}))
                 [predicate value]))
          parsed)))

(defn facts-of
  ([port subject]
   (facts-of port subject north.lifecycle-projection/managed-agent-predicates))
  ([port subject predicates]
   (north.lifecycle-projection/raw-point-facts
    (fn [entity predicate] (north.coord/many port entity predicate))
    subject
    predicates)))

(defn write-lease-resource [subject]
  (str "managed-agent-write:"
       (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                             (.getBytes (str subject)
                                        java.nio.charset.StandardCharsets/UTF_8))]
         (format "%064x" (java.math.BigInteger. 1 digest)))))

(defn write-fence-valid? [port]
  (let [{:keys [resource holder epoch]} *write-lease*]
    (and resource holder epoch
         (:fence-ok
          (north.coord/send-op port {:op :fence-ok
                                     :res resource
                                     :holder holder
                                     :epoch epoch})))))

(defn canonical-record [record]
  (json/generate-string (into (sorted-map) record)))

(defn retract-values! [port subject predicate values]
  (doseq [value values]
    (checked! (north.coord/retract-with-fence!
               port *write-lease* subject predicate value)
              [:retract-with-fence subject predicate value])))

(defn put-facts! [port subject facts]
  (doseq [[predicate value] facts]
    (checked! (north.coord/put-with-fence!
               port *write-lease* subject predicate value)
              [:put-with-fence subject predicate value])))

(defn put-values! [port subject predicate values]
  (doseq [value (sort values)]
    (checked! (north.coord/put-with-fence!
               port *write-lease* subject predicate value)
              [:put-with-fence subject predicate value])))

(defn exact-projection [facts predicates]
  (into (sorted-map)
        (keep (fn [predicate]
                (when-let [values (seq (get facts predicate))]
                  [predicate (set values)])))
        predicates))

(defn managed-projection [facts]
  (exact-projection facts managed-projection-predicates))

(defn singleton-facts [facts predicates]
  (into (sorted-map)
        (keep (fn [predicate]
                (when-let [value (first (get facts predicate))]
                  [predicate value])))
        predicates))

(defn desired-projection [facts]
  (into (sorted-map) (map (fn [[predicate value]] [predicate #{value}])) facts))

(defn canonical [facts]
  (apply str (map (fn [[predicate value]] (str predicate "\u0000" value "\n")) facts)))

(defn sha256 [s]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        (.getBytes (str s) java.nio.charset.StandardCharsets/UTF_8))]
    (format "%064x" (java.math.BigInteger. 1 digest))))

(defn verify-exact-snapshot! [snapshot desired predicates]
  (let [actual (exact-projection snapshot predicates)
        expected (desired-projection desired)]
    (when-not (= expected actual)
      (fail! "managed identity readback did not match the published projection"
             {:expected expected :actual actual}))))

(defn verify-exact! [port subject desired predicates]
  (verify-exact-snapshot! (facts-of port subject) desired predicates))

(defn singleton-projection! [facts predicates]
  (doseq [predicate predicates
          :let [values (get facts predicate #{})]
          :when (> (count values) 1)]
    (fail! "managed identity contains multiple live values for one predicate"
           {:predicate predicate :values values})))

(defn validate-publish! [facts]
  (let [unknown (seq (remove publish-predicates (keys facts)))
        missing (seq (remove #(contains? facts %) required-identity-predicates))]
    (when unknown (fail! "unsupported managed identity predicate" {:predicates unknown}))
    (when missing (fail! "incomplete managed identity projection" {:predicates missing}))
    (when-not (= "lane" (get facts "kind"))
      (fail! "managed SDK identity kind must be lane" {:kind (get facts "kind")}))
    (when-not (contains? #{"streaming" "unsupported"} (get facts "live_input"))
      (fail! "managed SDK identity has invalid live_input"
             {:live-input (get facts "live_input")}))
    (when-not (contains? #{"pending" "armed" "frozen"} (get facts "live_input_state"))
      (fail! "managed SDK identity has invalid live_input_state"
             {:live-input-state (get facts "live_input_state")}))
    (when-not (re-matches
               #"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
               (get facts "live_input_epoch"))
      (fail! "managed SDK identity has invalid live_input_epoch"
             {:live-input-epoch (get facts "live_input_epoch")}))
    (when (and (= "unsupported" (get facts "live_input"))
               (not= "frozen" (get facts "live_input_state")))
      (fail! "unsupported live_input must remain frozen"
             {:live-input-state (get facts "live_input_state")}))
    (when-not (= (get facts "role") (get facts "composition_id"))
      (fail! "managed role and Gaffer composition id must agree"
             {:role (get facts "role") :composition-id (get facts "composition_id")}))
    (case (get facts "composition_kind")
      "preset" (do
                 (when-not (contains? facts "composition_overrides")
                   (fail! "preset identity requires composition_overrides" {}))
                 (when (some #(contains? facts %)
                             ["bespoke_reason" "promotion_candidate" "composition_contract_sha256"
                              "composition_contract_fingerprint_version"
                              "composition_contract_fingerprint_domain"])
                   (fail! "preset identity carries bespoke-only evidence" {})))
      "bespoke" (do
                  (doseq [predicate ["bespoke_reason" "promotion_candidate"
                                     "composition_contract_sha256"
                                     "composition_contract_fingerprint_version"
                                     "composition_contract_fingerprint_domain"]]
                    (when-not (contains? facts predicate)
                      (fail! "bespoke identity is missing authority evidence"
                             {:predicate predicate})))
                  (when-not (contains? #{"true" "false"} (get facts "promotion_candidate"))
                    (fail! "invalid bespoke promotion_candidate" {}))
                  (when-not (re-matches #"^[0-9a-f]{64}$"
                                        (get facts "composition_contract_sha256"))
                    (fail! "invalid bespoke contract fingerprint" {}))
                  (when-not (= "v1" (get facts "composition_contract_fingerprint_version"))
                    (fail! "unsupported bespoke contract fingerprint version" {}))
                  (when-not (= "north:bespoke-contract:v1"
                               (get facts "composition_contract_fingerprint_domain"))
                    (fail! "unsupported bespoke contract fingerprint domain" {})))
      (fail! "managed identity composition_kind must be preset or bespoke"
             {:composition-kind (get facts "composition_kind")}))))

(defn commit-marker! [port subject facts]
  ;; Display strings are derived caches, never authority. Roster/trace rebuild
  ;; names from provider/model/effort/composition, and legacy UI writers cannot
  ;; invalidate a committed identity by decorating a cached label.
  (let [authoritative (into (sorted-map) (select-keys facts identity-predicates))
        marker (sha256 (canonical authoritative))]
    ;; Identity authority is wholly subject-local. The per-agent write lease
    ;; excludes another supported publisher for this subject, while unrelated
    ;; graph traffic must not make publication fail. The marker itself remains
    ;; a digest of the exact authority projection: an unsupported same-subject
    ;; mutation can only invalidate readback, never bless a mixed generation.
    ;; Cross-subject delivery validation deliberately keeps global CAS below.
    (let [snapshot (facts-of port subject)
          markers (get snapshot marker-predicate #{})]
      (verify-exact-snapshot! snapshot authoritative identity-predicates)
      (when-not (or (empty? markers) (= #{marker} markers))
        (fail! "managed identity has a competing generation marker"
               {:subject subject})))
    (checked! (north.coord/put-with-fence!
               port *write-lease* subject marker-predicate marker)
              [:put-subject-local-marker subject marker-predicate marker])
    (let [snapshot (facts-of port subject)]
      (verify-exact-snapshot! snapshot authoritative identity-predicates)
      (when-not (= #{marker} (get snapshot marker-predicate))
        (fail! "managed identity commit marker was not acknowledged"
               {:marker marker})))
    marker))

(defn terminal-marker! [port subject facts validate-current!]
  (let [marker (north.terminal-projection/terminal-manifest-sha256 facts)]
    (when-not marker
      (fail! "cannot commit an incomplete managed terminal projection" {}))
    (checked! (north.coord/assert-after-read-with-fence!
               port *write-lease* subject terminal-marker-predicate marker
               validate-current!)
              [:assert-after-read-with-fence
               subject terminal-marker-predicate marker])
    (when-not (= marker (north.coord/resolved port subject terminal-marker-predicate))
      (fail! "managed terminal commit marker was not acknowledged" {:marker marker}))
    marker))

(declare validate-terminal!)

(defn validate-existing-managed-projection! [subject snapshot]
  (singleton-projection! snapshot managed-projection-predicates)
  (let [identity (singleton-facts snapshot publish-predicates)
        identity-marker (first (get snapshot marker-predicate))]
    (validate-publish! identity)
    (when-not (= identity-marker
                 (sha256
                  (canonical
                   (into (sorted-map)
                         (select-keys identity identity-predicates)))))
      (fail! "existing managed identity is not an exact committed generation"
             {:subject subject})))
  (let [terminal-view
        (exact-projection
         snapshot (conj terminal-predicates terminal-marker-predicate))]
    (when (seq terminal-view)
      (let [terminal (singleton-facts snapshot terminal-predicates)
            terminal-marker (first (get snapshot terminal-marker-predicate))]
        (validate-terminal! subject terminal)
        (when-not (= terminal-marker
                     (north.terminal-projection/terminal-manifest-sha256 terminal))
          (fail! "existing managed terminal is not an exact committed projection"
                 {:subject subject}))))))

(defn clear-managed-projection! [port subject]
  ;; Markers disappear first. Readers can never accept one body while this
  ;; writer is clearing or reconstructing the projection under its fence.
  (let [current (facts-of port subject)]
    (retract-values! port subject marker-predicate
                     (get current marker-predicate #{}))
    (retract-values! port subject terminal-marker-predicate
                     (get current terminal-marker-predicate #{}))
    (doseq [predicate terminal-retraction-order]
      (retract-values! port subject predicate (get current predicate #{})))
    (doseq [predicate (sort publish-predicates)]
      (retract-values! port subject predicate (get current predicate #{})))))

(defn restore-managed-projection! [port subject snapshot]
  (let [expected (managed-projection snapshot)]
    (clear-managed-projection! port subject)
    ;; Restore every body while both commit markers remain absent, then expose
    ;; identity before terminal. A terminal marker can therefore never become
    ;; visible without its exact body and committed actor identity.
    (doseq [predicate (sort publish-predicates)]
      (put-values! port subject predicate (get snapshot predicate #{})))
    (doseq [predicate terminal-publication-order]
      (put-values! port subject predicate (get snapshot predicate #{})))
    (put-values! port subject marker-predicate
                 (get snapshot marker-predicate #{}))
    (put-values! port subject terminal-marker-predicate
                 (get snapshot terminal-marker-predicate #{}))
    (let [actual (managed-projection (facts-of port subject))]
      (when-not (= expected actual)
        (fail! "managed projection rollback readback mismatch"
               {:subject subject :expected expected :actual actual})))))

(defn rollback-managed-projection! [port subject snapshot original-error]
  ;; Never erase a successor after expiry/takeover. Every restoration mutation
  ;; is itself fenced, but this preflight avoids starting a rollback that cannot
  ;; possibly complete under the original lease.
  (try
    (when (write-fence-valid? port)
      (restore-managed-projection! port subject snapshot)
      nil)
    (catch Throwable rollback-error
      ;; A dead coordinator/socket is part of the failed cleanup path. Keep the
      ;; original mutation rejection as the primary error and attach diagnostics
      ;; without changing what the SDK reports.
      (.addSuppressed ^Throwable original-error ^Throwable rollback-error))))

(defn with-managed-rollback! [port subject snapshot operation!]
  (try
    (operation!)
    (catch Throwable operation-error
      (rollback-managed-projection! port subject snapshot operation-error)
      (throw operation-error))))

(defn publish! [port subject facts]
  (validate-publish! facts)
  (let [before (facts-of port subject)
        fresh? (empty? (managed-projection before))
        exact-uncommitted-retry?
        (and (nil? (get before marker-predicate))
             (empty?
              (exact-projection
               before (conj terminal-predicates terminal-marker-predicate)))
             (= (desired-projection facts)
                (exact-projection before publish-predicates)))
        mutating? (atom false)]
    ;; A genuinely fresh id may be cleared on a failed initial publication. A
    ;; byte-identical markerless body is the durable crash-retry state: complete
    ;; its marker without rewriting. Every other reused id must name an exact
    ;; prior generation, preserved byte-for-byte if replacement cannot commit.
    (when-not (or fresh? exact-uncommitted-retry?)
      (validate-existing-managed-projection! subject before))
    (try
      (if exact-uncommitted-retry?
        (do
          (verify-exact-snapshot! before facts publish-predicates)
          (commit-marker! port subject facts))
        (do
          ;; Withdraw both generation markers deterministically before touching
          ;; either projection body; readers cannot mistake a partial identity
          ;; rewrite or stale terminal for a committed current generation.
          (reset! mutating? true)
          (clear-managed-projection! port subject)
          (put-facts! port subject facts)
          (verify-exact! port subject facts publish-predicates)
          (commit-marker! port subject facts)))
      (catch Throwable publication-error
        ;; Never let cleanup mask the publication failure. If the lease was lost,
        ;; the digest/marker contract remains the fail-closed fallback.
        (when @mutating?
          (rollback-managed-projection!
           port subject before publication-error))
        (throw publication-error)))))

(defn validate-terminal! [subject facts]
  (let [predicates (set (keys facts))
        unknown (seq (remove terminal-predicates predicates))
        missing (seq (remove predicates base-terminal-predicates))]
    (when unknown
      (fail! "terminal carries unsupported predicates" {:predicates unknown}))
    (when missing
      (fail! "terminal is missing base process/delivery predicates" {:predicates missing})))
  (when-not (= (get facts "outcome") (get facts "process_outcome"))
    (fail! "legacy outcome must equal process_outcome" {}))
  (when-not (contains? #{"unverified" "blocked" "reported" "verified"}
                       (get facts "delivery_outcome"))
    (fail! "invalid delivery_outcome" {:delivery-outcome (get facts "delivery_outcome")}))
  (when-not (north.terminal-projection/delivery-projection-valid? facts)
    (fail! "delivery outcome lacks a valid proof projection"
           {:delivery-outcome (get facts "delivery_outcome")}))
  (when-let [evidence-raw (get facts "delivery_evidence")]
    (let [evidence (json/parse-string evidence-raw)]
      (when-not (= subject (get evidence "reporter"))
        (fail! "delivery reporter must be the managed terminal subject"
               {:subject subject :reporter (get evidence "reporter")}))))
  (when-let [attestation-raw (get facts "delivery_attestation")]
    (let [attestation (json/parse-string attestation-raw)]
      (when-not (= subject (get attestation "target"))
        (fail! "delivery attestation target must be the managed terminal subject"
               {:subject subject :target (get attestation "target")})))))

(defn validate-reported-run!
  "A syntactically valid snapshot is not proof by itself. Before exposing a
  reported lane terminal, bind it to the committed reservation and exact
  writer-scoped self-report already present on the named run subject."
  [port subject facts]
  (when (= "reported" (get facts "delivery_outcome"))
    (let [evidence (json/parse-string (get facts "delivery_evidence"))
          run (get evidence "run")
          thread (get evidence "thread")
          run-facts
          (facts-of port run north.lifecycle-projection/reported-run-predicates)
          reservation-origin
          (north.terminal-projection/singleton-value
           run-facts "run_reservation_contract_origin")
          reservation-baseline
          (north.terminal-projection/run-reservation-done-when run-facts)
          current-bars
          (north.terminal-projection/canonical-done-when
           (facts-of port thread
                     north.lifecycle-projection/reported-thread-predicates))
          cited-records
          (set
           (mapcat (fn [match]
                     (map canonical-record (get match "evidence")))
                   (get evidence "matches")))
          evidence-state
          (north.terminal-projection/run-evidence-state
           run-facts run thread subject)
          stored-records (:raws evidence-state)]
      (when-not (north.terminal-projection/run-reservation-valid? run-facts)
        (fail! "reported delivery requires a committed run reservation"
               {:subject subject :run run}))
      (when-not (= #{subject} (get run-facts "run_reservation_agent"))
        (fail! "reported delivery reservation agent mismatch"
               {:subject subject :run run}))
      (when-not (= #{thread} (get run-facts "run_reservation_thread"))
        (fail! "reported delivery reservation thread mismatch"
               {:subject subject :run run :thread thread}))
      (when-not (= reservation-origin (get evidence "contractOrigin"))
        (fail! "reported delivery contract origin differs from its reservation"
               {:subject subject :run run}))
      (when-not (= reservation-baseline (get evidence "baselineDoneWhen"))
        (fail! "reported delivery baseline differs from its reservation"
               {:subject subject :run run}))
      (when-not (= current-bars (get evidence "doneWhen"))
        (fail! "reported delivery contract changed before terminal publication"
               {:subject subject :run run :thread thread}))
      (when-not (:valid? evidence-state)
        (fail! "reported delivery run contains malformed, cross-scoped, duplicate, or excessive evidence"
               {:subject subject :run run}))
      (when-not (= stored-records cited-records)
        (fail! "reported delivery snapshot must cite the exact reserved-run evidence set"
               {:subject subject :run run
                :missing (vec (remove stored-records cited-records))
                :uncited (vec (remove cited-records stored-records))})))))

(defn publish-terminal! [port subject facts]
  (let [before (facts-of port subject)]
    (with-managed-rollback!
      port subject before
      (fn []
        (retract-values! port subject terminal-marker-predicate
                         (get before terminal-marker-predicate #{}))
        (doseq [predicate terminal-retraction-order]
          (retract-values! port subject predicate (get before predicate #{})))
        (doseq [predicate terminal-publication-order
                :let [value (get facts predicate)]]
          (when value
            (checked! (north.coord/put-with-fence!
                       port *write-lease* subject predicate value)
                      [:put-with-fence subject predicate value])))
        ;; Capture the coordinator version before the load-bearing reads, then commit
        ;; the marker only against that exact version. Any concurrent done-bar, run,
        ;; or terminal mutation rejects the marker and re-runs both checks.
        (terminal-marker!
         port subject facts
         (fn []
           (verify-exact! port subject facts terminal-predicates)
           (validate-reported-run! port subject facts)))))))

(defn terminal! [port subject facts]
  (validate-terminal! subject facts)
  (validate-reported-run! port subject facts)
  (publish-terminal! port subject facts))

(defn terminal-thread [raw]
  (when-not (str/blank? raw)
    (let [bare (str/replace-first raw #"^@" "")]
      (when-not (and (= raw (str/trim raw))
                     (<= (count bare) 512)
                     (re-matches #"[A-Za-z0-9][A-Za-z0-9._:-]*" bare))
        (fail! "invalid managed terminal thread id" {:thread raw}))
      (str "@" bare))))

(defn settle-terminal-cleanup!
  "Withdraw every ephemeral lifecycle claim owned by SUBJECT. This runs under
   the same recoverable logical terminal operation as the durable projection.
   Every mutation is exact/idempotent: a replay cannot erase a successor's
   driver or another holder's presence lease."
  [port subject thread]
  (let [agent-id (subs subject (count "@agent:"))
        presence-resource (str "session:" agent-id)
        presence-result
        (north.coord/send-op
         port {:op :release-lease :res presence-resource :holder agent-id})]
    (checked! presence-result [:release-terminal-presence presence-resource])
    (when (= agent-id (:holder (north.coord/lease-of port presence-resource)))
      (fail! "managed terminal presence withdrawal was not acknowledged"
             {:subject subject :resource presence-resource})))
  (when thread
    (let [agent-id (subs subject (count "@agent:"))
          driver (str "@" agent-id)
          current (set (north.coord/many port thread "driver"))]
      (when (contains? current driver)
        (checked! (north.coord/retract-with-fence!
                   port *write-lease* thread "driver" driver)
                  [:retract-terminal-driver thread driver]))
      (when (contains? (set (north.coord/many port thread "driver")) driver)
        (fail! "managed terminal driver withdrawal was not acknowledged"
               {:subject subject :thread thread :driver driver})))))

(defn publish-managed-terminal!
  "Publish a recoverable terminal generation with its terminal marker LAST,
   after presence and exact driver withdrawal. Unlike the legacy replacement
   verb, a managed terminal never rolls back: any killed durable prefix is
   markerless and the same logical operation reconstructs it on replay."
  [port subject facts thread]
  (let [before (facts-of port subject)]
    (retract-values! port subject terminal-marker-predicate
                     (get before terminal-marker-predicate #{}))
    (doseq [predicate terminal-retraction-order]
      (retract-values! port subject predicate (get before predicate #{})))
    (doseq [predicate terminal-publication-order
            :let [value (get facts predicate)]
            :when value]
      (checked! (north.coord/put-with-fence!
                 port *write-lease* subject predicate value)
                [:put-managed-terminal-with-fence subject predicate value]))
    (verify-exact! port subject facts terminal-predicates)
    (validate-reported-run! port subject facts)
    (settle-terminal-cleanup! port subject thread)
    (terminal-marker!
     port subject facts
     (fn []
       (verify-exact! port subject facts terminal-predicates)
       (validate-reported-run! port subject facts)
       ;; A late activity renewal or driver mutation must invalidate this
       ;; marker attempt rather than bless a terminal with live ownership.
       (settle-terminal-cleanup! port subject thread)))))

(defn identity-marker [facts]
  (sha256
   (canonical
    (into (sorted-map) (select-keys facts identity-predicates)))))

(defn exact-committed-identity?
  [snapshot desired]
  (and desired
       (try
         (validate-publish! desired)
         (singleton-projection!
          snapshot (conj publish-predicates marker-predicate))
         (and (= (desired-projection desired)
                 (exact-projection snapshot publish-predicates))
              (= #{(identity-marker desired)}
                 (get snapshot marker-predicate #{})))
         (catch Throwable _ false))))

(defn committed-identity
  "Return the exact committed identity map, or nil for a partial, malformed, or
  multiply-valued generation. Terminal facts are deliberately orthogonal."
  [snapshot]
  (try
    (singleton-projection!
     snapshot (conj publish-predicates marker-predicate))
    (let [identity (singleton-facts snapshot publish-predicates)]
      (validate-publish! identity)
      (when (= #{(identity-marker identity)}
               (get snapshot marker-predicate #{}))
        identity))
    (catch Throwable _ nil)))

(defn identity-matches-except?
  [actual expected ignored]
  (= (apply dissoc actual ignored)
     (apply dissoc expected ignored)))

(defn retask-drift?
  [actual expected]
  (not= (get actual "goal") (get expected "goal")))

(defn effective-route-desired
  "Rebase caller-owned route axes onto the graph's current retask overlay. Goal
  is authoritative and independently mutable. display_name is a cross-derived
  cache: update it from the caller only when goal did not move; otherwise keep
  the retask writer's cache instead of restoring stale text."
  [actual expected desired]
  (let [retasked? (retask-drift? actual expected)]
    (cond-> (assoc desired "goal" (get actual "goal"))
      retasked? (assoc "display_name" (get actual "display_name")))))

(defn route-mutation-predicates
  [actual expected]
  (cond-> route-generation-predicates
    (not (retask-drift? actual expected)) (conj "display_name")))

(declare values-compatible-with-transition?)

(defn route-prefix-compatible?
  "Recognize only a killed route prefix. Route publication never mutates the
  retask-owned goal and preserves display_name when goal has advanced, so that
  overlay remains recoverable even when the SDK carried a stale full identity."
  [snapshot expected desired]
  (let [actual (singleton-facts snapshot publish-predicates)
        retasked? (retask-drift? actual expected)
        mutation-predicates (route-mutation-predicates actual expected)
        stable-predicates (apply disj publish-predicates mutation-predicates)
        stable-expected (effective-route-desired actual expected expected)]
    (and
     (empty? (get snapshot marker-predicate #{}))
     (empty? (exact-projection
              snapshot (conj terminal-predicates terminal-marker-predicate)))
     ;; Every non-route predicate remains exact. For a retasked generation this
     ;; intentionally accepts its one nonblank goal/cache value, not the stale
     ;; caller copy; the route writer never withdrew either value.
     (every?
      (fn [predicate]
        (let [values (get snapshot predicate #{})
              expected-value (get stable-expected predicate)]
          (if expected-value
            (= #{expected-value} values)
            (empty? values))))
      stable-predicates)
     (or (not retasked?)
         (and (not (str/blank? (get actual "goal")))
              (not (str/blank? (get actual "display_name")))))
     (values-compatible-with-transition?
      snapshot expected desired mutation-predicates))))

(defn replace-route-projection!
  [port subject before expected desired]
  (let [actual (singleton-facts before publish-predicates)
        effective (effective-route-desired actual expected desired)
        mutation-predicates (route-mutation-predicates actual expected)]
    (retract-values! port subject marker-predicate
                     (get before marker-predicate #{}))
    (doseq [predicate mutation-predicates]
      (retract-values! port subject predicate (get before predicate #{})))
    (put-facts! port subject (select-keys effective mutation-predicates))
    (verify-exact! port subject
                   (select-keys effective mutation-predicates)
                   mutation-predicates)
    (let [identity (singleton-facts (facts-of port subject) publish-predicates)]
      (validate-publish! identity)
      (commit-marker! port subject identity))))

(defn exact-committed-terminal?
  [subject snapshot desired]
  (and desired
       (try
         (validate-terminal! subject desired)
         (singleton-projection!
          snapshot (conj terminal-predicates terminal-marker-predicate))
         (and (= (desired-projection desired)
                 (exact-projection snapshot terminal-predicates))
              (= #{(north.terminal-projection/terminal-manifest-sha256 desired)}
                 (get snapshot terminal-marker-predicate #{})))
         (catch Throwable _ false))))

(defn valid-committed-terminal?
  [subject snapshot]
  (try
    (let [terminal (singleton-facts snapshot terminal-predicates)]
      (validate-terminal! subject terminal)
      (= #{(north.terminal-projection/terminal-manifest-sha256 terminal)}
         (get snapshot terminal-marker-predicate #{})))
    (catch Throwable _ false)))

(defn terminal-projection-present?
  [snapshot]
  (boolean
   (seq
    (exact-projection
     snapshot (conj terminal-predicates terminal-marker-predicate)))))

(defn values-compatible-with-transition?
  "True only for a markerless killed prefix made entirely from the caller's
  expected and desired exact projections. The stable holder/rotating epoch
  establishes who may repair; this value check prevents that owner from
  blessing an unrelated mixed generation."
  [snapshot expected desired predicates]
  (every?
   (fn [predicate]
     (let [actual (get snapshot predicate #{})
           allowed (set (keep identity [(get expected predicate)
                                        (get desired predicate)]))]
       (and (<= (count actual) 1)
            (every? allowed actual))))
   predicates))

(defn replace-identity-projection!
  [port subject desired]
  (clear-managed-projection! port subject)
  (put-facts! port subject desired)
  (verify-exact! port subject desired publish-predicates)
  (commit-marker! port subject desired))

(defn committed-result [operation-id & [reason]]
  (cond-> {:status "committed" :operation_id operation-id}
    reason (assoc :reason reason)))

(defn unresolved-result [status operation-id reason]
  {:status status :operation_id operation-id :reason reason})

(defn recover-identity-write!
  "Apply or recover one caller-owned publish/route transition. `expected` and
  `desired` are complete projections. A replay may repair only an exact prior
  generation or a markerless prefix composed from those two projections."
  [port subject operation operation-id delta desired expected]
  (when-not desired
    (fail! "managed identity recovery requires a complete desired projection"
           {:operation-id operation-id}))
  (validate-publish! desired)
  (when expected (validate-publish! expected))
  (case operation
    "publish"
    (when-not (= desired delta)
      (fail! "managed publish payload must equal its complete desired projection"
             {:operation-id operation-id}))

    "route"
    (do
      (when-not expected
        (fail! "managed route recovery requires a complete expected projection"
               {:operation-id operation-id}))
      (when-not (= route-predicates (set (keys delta)))
        (fail! "managed route operation requires the exact route predicate set"
               {:operation-id operation-id :predicates (set (keys delta))}))
      (when-not (= delta (select-keys desired route-predicates))
        (fail! "managed route delta disagrees with desired projection"
               {:operation-id operation-id}))
      (when-not (= (apply dissoc expected route-predicates)
                   (apply dissoc desired route-predicates))
        (fail! "managed route operation changed non-route identity authority"
               {:operation-id operation-id})))

    (fail! "unsupported recoverable managed identity operation"
           {:operation operation}))
  (let [before (facts-of port subject)
        current (committed-identity before)
        desired-committed?
        (if (= "route" operation)
          (and current
               (identity-matches-except?
                current desired retask-overlay-predicates))
          (exact-committed-identity? before desired))]
    (cond
      ;; Lost acknowledgement after the marker committed: acknowledge without
      ;; withdrawing it or touching a feed-visible generation. A later retask is
      ;; a legitimate successor overlay, not evidence that the route failed.
      desired-committed?
      (committed-result operation-id "exact_replay")

      ;; A terminal generation is irreversible. An exact older route replay may
      ;; be acknowledged above, but no new identity mutation may cross it.
      (terminal-projection-present? before)
      (if (valid-committed-terminal? subject before)
        (unresolved-result "not_committed" operation-id "terminal_committed")
        (unresolved-result "indeterminate" operation-id "partial_or_invalid_terminal"))

      ;; Ordinary first attempt or a retry after the caller's expected marker
      ;; remained intact.
      (and (= "publish" operation)
           expected (exact-committed-identity? before expected))
      (do
        (replace-identity-projection! port subject desired)
        (committed-result operation-id))

      ;; Retask owns goal/display_name independently. Rebase route axes onto a
      ;; valid committed overlay rather than restoring the SDK's stale copy.
      (and (= "route" operation)
           current
           (identity-matches-except?
            current expected retask-overlay-predicates))
      (do
        (replace-route-projection! port subject before expected desired)
        (committed-result operation-id
                          (when (retask-drift? current expected)
                            "rebased_retask_overlay")))

      ;; Fresh initial publication.
      (and (= "publish" operation)
           (nil? expected) (empty? (managed-projection before)))
      (do
        (replace-identity-projection! port subject desired)
        (committed-result operation-id))

      ;; A route rewrite touches only its owned projection. Non-route identity,
      ;; including a concurrent retask overlay, stays durable across every
      ;; killed prefix and supplies the exact rebase inputs on retry.
      (and (= "route" operation)
           (route-prefix-compatible? before expected desired))
      (do
        (replace-route-projection! port subject before expected desired)
        (committed-result operation-id "recovered_killed_prefix"))

      ;; Crash after marker withdrawal and at any durable body prefix. The new
      ;; same-holder acquisition already rotated the fence epoch, so the killed
      ;; writer cannot resume; rebuild the complete desired state exactly.
      (and (= "publish" operation)
           (empty? (get before marker-predicate #{}))
           (empty? (exact-projection
                    before (conj terminal-predicates terminal-marker-predicate)))
           (values-compatible-with-transition?
            before expected desired publish-predicates))
      (do
        (replace-identity-projection! port subject desired)
        (committed-result operation-id "recovered_killed_prefix"))

      ;; A complete generation outside the caller's expected→desired edge is a
      ;; successor or another authority. Never overwrite it during recovery.
      current
      (unresolved-result "not_committed" operation-id "conflicting_generation")

      (seq (get before marker-predicate #{}))
      (unresolved-result "indeterminate" operation-id "invalid_identity_generation")

      :else
      (unresolved-result "indeterminate" operation-id "unrecognized_partial_generation"))))

(defn terminal-prefix-compatible?
  [snapshot desired]
  (and (empty? (get snapshot terminal-marker-predicate #{}))
       (every?
        (fn [predicate]
          (let [actual (get snapshot predicate #{})
                wanted (get desired predicate)]
            (and (<= (count actual) 1)
                 (or (empty? actual) (= #{wanted} actual)))))
        terminal-predicates)))

(defn recover-terminal-write!
  [port subject operation-id desired expected-identity thread]
  (validate-terminal! subject desired)
  (validate-reported-run! port subject desired)
  (let [before (facts-of port subject)
        current (committed-identity before)]
    (cond
      (exact-committed-terminal? subject before desired)
      (do
        (settle-terminal-cleanup! port subject thread)
        (committed-result operation-id "exact_replay"))

      (valid-committed-terminal? subject before)
      (do
        ;; The lane is irrevocably terminal even if this caller carried a stale
        ;; terminal body. Heal its ephemeral ownership without rewriting the
        ;; already-committed terminal generation.
        (settle-terminal-cleanup! port subject thread)
        (unresolved-result "not_committed" operation-id "conflicting_terminal"))

      (not (and current expected-identity
                (identity-matches-except?
                 current expected-identity retask-overlay-predicates)))
      (unresolved-result "indeterminate" operation-id "identity_generation_changed")

      (terminal-prefix-compatible? before desired)
      (do
        (publish-managed-terminal! port subject desired thread)
        (committed-result operation-id
                          (when (terminal-projection-present? before)
                            "recovered_killed_prefix")))

      :else
      (unresolved-result "indeterminate" operation-id "unrecognized_partial_terminal"))))

(defn committed-managed-actor!
  [port raw-actor]
  (let [actor (entity raw-actor)
        before (facts-of port actor)]
    (singleton-projection! before (conj publish-predicates marker-predicate))
    (let [identity (into (sorted-map)
                         (keep (fn [predicate]
                                 (when-let [value (first (get before predicate))]
                                   [predicate value])))
                         publish-predicates)
          marker (first (get before marker-predicate))]
      (validate-publish! identity)
      (when-not (= marker
                   (sha256 (canonical (into (sorted-map)
                                             (select-keys identity identity-predicates)))))
        (fail! "attesting actor has no committed managed identity" {:actor actor}))
      (when-not (#{"verifier" "judge"} (get identity "role"))
        (fail! "delivery attestation requires a verifier or judge lane"
               {:actor actor :role (get identity "role")}))
      {:actor actor :role (get identity "role")})))

(defn attest!
  "Fail closed until verifier identity is backed by an isolation boundary rather
  than caller-controlled same-UID environment provenance."
  [port subject request]
  (fail! "independent delivery attestation unavailable under shared-UID lanes"
         {:subject subject :request-keys (set (keys request))
          :highest-supported-delivery-state "reported"}))

(defn update-route! [port subject facts]
  (let [unknown (seq (remove route-predicates (keys facts)))
        missing (seq (remove #(contains? facts %) route-predicates))]
    (when unknown (fail! "unsupported managed route predicate" {:predicates unknown}))
    (when missing (fail! "incomplete managed route projection" {:predicates missing})))
  ;; Route fallback is still pre-provider-side-effect. Withdraw the previous
  ;; commit marker before changing any route axis; a crash cannot leave a mixed
  ;; route looking like an acknowledged identity generation.
  (let [before (facts-of port subject)
        current (singleton-facts before publish-predicates)
        marker (first (get before marker-predicate))]
    (singleton-projection! before (conj publish-predicates marker-predicate))
    (validate-publish! current)
    (when-not (= marker (sha256 (canonical (into (sorted-map)
                                                   (select-keys current identity-predicates)))))
      (fail! "cannot update an uncommitted or corrupted managed route" {}))
    (with-managed-rollback!
      port subject before
      (fn []
        (retract-values! port subject marker-predicate
                         (get before marker-predicate #{}))
        ;; The coordinator defaults undeclared predicates to multi cardinality.
        ;; Never rely on descriptive pred registry rows to supersede executable
        ;; facts: explicitly clear every old route value before asserting the new
        ;; exact projection.
        (doseq [predicate route-predicates]
          (retract-values! port subject predicate (get before predicate #{})))
        (put-facts! port subject facts)
        (verify-exact! port subject facts route-predicates)
        (let [identity (singleton-facts (facts-of port subject)
                                        publish-predicates)]
          (validate-publish! identity)
          (commit-marker! port subject identity))))))

(defn retask! [port subject facts]
  (when-not (= #{"goal" "display_name"} (set (keys facts)))
    (fail! "retask requires exactly goal and display_name" {:predicates (keys facts)}))
  (let [before (facts-of port subject)
        current (singleton-facts before publish-predicates)
        marker (first (get before marker-predicate))]
    (singleton-projection! before (conj publish-predicates marker-predicate))
    (validate-publish! current)
    (when-not (= marker (sha256 (canonical (into (sorted-map)
                                                   (select-keys current identity-predicates)))))
      (fail! "cannot retask an uncommitted or corrupted managed identity" {}))
    (with-managed-rollback!
      port subject before
      (fn []
        (retract-values! port subject marker-predicate
                         (get before marker-predicate #{}))
        (doseq [predicate ["goal" "display_name"]]
          (retract-values! port subject predicate (get before predicate #{})))
        (put-facts! port subject facts)
        (verify-exact! port subject facts #{"goal" "display_name"})
        (let [projection (singleton-facts (facts-of port subject)
                                          publish-predicates)]
          (validate-publish! projection)
          (commit-marker! port subject projection))))))

(def uuid-v4-pattern
  #"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

(defn require-write-lease-policy!
  ;; The SDK's process timeout is the stale-writer boundary. The lease must
  ;; outlive it, otherwise a timed-out writer could wake after expiry and race a
  ;; successor. This holds on EVERY write path — the atomic fenced publish takes
  ;; the same per-subject lease server-side, and its fallback is the sequential
  ;; path, so the policy gates both before any wire op.
  []
  (when-not (and (integer? writer-timeout-bound-ms)
                 (pos? writer-timeout-bound-ms)
                 (integer? write-lease-ttl-ms)
                 (> write-lease-ttl-ms writer-timeout-bound-ms))
    (fail! "managed agent write lease must outlive the writer process timeout"
           {:writer-timeout-ms writer-timeout-bound-ms
            :lease-ttl-ms write-lease-ttl-ms})))

(defn validated-writer-holder [supplied-holder]
  (let [holder (or supplied-holder
                   (str "managed-agent-writer:" (java.util.UUID/randomUUID)))
        holder-id (str/replace holder #"^managed-agent-writer:" "")]
    (when-not (and (str/starts-with? holder "managed-agent-writer:")
                   (re-matches uuid-v4-pattern holder-id))
      (fail! "invalid managed agent writer holder" {:holder holder}))
    holder))

(defn acquire-write-lease! [port subject wait-on-held? supplied-holder]
  ;; Lifecycle updates may wait for an in-flight same-subject writer,
  ;; but at most half the declared process budget (capped at 5s), leaving a
  ;; deterministic margin for mutation, rollback, diagnostics, and SDK startup.
  (require-write-lease-policy!)
  (let [resource (write-lease-resource subject)
        holder (validated-writer-holder supplied-holder)
        wait-budget-ms
        (if wait-on-held?
          (min max-write-lease-wait-ms (quot writer-timeout-bound-ms 2))
          0)
        deadline (+ (System/nanoTime) (* wait-budget-ms 1000000))]
    (loop [attempt 1]
      (let [result (north.coord/send-op
                    port {:op :acquire-lease
                          :res resource
                          :holder holder
                          :ttl-ms write-lease-ttl-ms})]
        (cond
          (:ok result)
          {:resource resource
           :holder holder
           :epoch (:epoch result)}

          (and wait-on-held?
               (= :held (:reject result))
               (< (System/nanoTime) deadline))
          (do
            (Thread/sleep 25)
            (recur (inc attempt)))

          :else
          (fail! "managed agent subject already has a writer"
                 {:subject subject
                  :resource resource
                  :reject (:reject result)
                  :current-holder (:holder result)
                  :expires-at (:exp result)
                  :attempts attempt
                  :acquisition-budget-ms wait-budget-ms}))))))

(defn with-write-lease [port subject operation supplied-holder operation!]
  (let [{:keys [resource holder epoch] :as lease}
        (acquire-write-lease! port subject (not= "publish" operation)
                              supplied-holder)]
    (binding [*write-lease* lease]
      (try
        (operation!)
        (finally
          ;; Release is advisory after the durable marker acknowledgement. A
          ;; killed writer cannot run past the 10s SDK timeout while this 60s
          ;; lease is live; if release transport fails, expiry recovers it.
          (try
            (north.coord/send-op
             port {:op :release-lease :res resource :holder holder :epoch epoch})
            (catch Throwable _ nil)))))))

(defn optional-payload [raw]
  (when-not (str/blank? raw) (payload raw)))

;; Guard predicates for the atomic op's clean-fresh gate. identity-predicates
;; already feed the manifest (the server verifies each present/absent), the facts
;; carry the projection predicates, so these are the terminal bodies + terminal
;; marker whose presence must force a publish-conflict — byte-for-byte the
;; fresh?/reuse discriminant the sequential publish! applies.
(def managed-agent-guard-predicates
  (vec (distinct (concat projection-predicates
                         terminal-predicates
                         [terminal-marker-predicate]))))

(defn atomic-fresh-publish!
  "Attempt the ONE server-side :managed-agent-publish op (fram, promoted 2893706):
  the whole identity body + manifest marker committed in a single transaction under
  the canonical per-subject write lease. Returns a committed result on success, or
  nil so the caller falls back to the sequential lease-fenced path, which owns every
  reused, partial, or recovery generation (the atomic op rejects those WITHOUT
  mutating, so the fallback starts from the exact prior state). A coordinator that
  does not advertise the op answers {:error \"unknown op\"} and is likewise treated
  as a fallback. validate-publish! runs FIRST so North's vocabulary/shape rejection
  reaches the caller before any wire op, exactly as the sequential path would."
  [port subject facts supplied-holder operation-id]
  (validate-publish! facts)
  (require-write-lease-policy!)
  (let [marker (identity-marker facts)
        holder (validated-writer-holder supplied-holder)
        response (try
                   (north.coord/send-op
                    port {:op :managed-agent-publish
                          :te subject
                          :holder holder
                          :ttl-ms write-lease-ttl-ms
                          :facts (mapv (fn [[predicate value]]
                                         {:p predicate :r value})
                                       (sort-by key facts))
                          :identity-preds (vec identity-predicates)
                          :guard-preds managed-agent-guard-predicates
                          :manifest-sha256 marker})
                   (catch Throwable _ nil))]
    (when (and (map? response)
               (:ok response)
               (:fenced-publish response)
               (= subject (:te response))
               (= marker (:marker response)))
      (committed-result operation-id (when (:idempotent response) "exact_replay")))))

(let [[port-s operation subject raw supplied-holder supplied-operation-id
       desired-raw expected-raw terminal-thread-raw] *command-line-args*
      port (Integer/parseInt (or port-s (or (System/getenv "NORTH_PORT") "7977")))
      subject (entity subject)
      terminal-thread (terminal-thread terminal-thread-raw)
      managed-recovery? (not (str/blank? supplied-operation-id))
      operation-id (or supplied-operation-id (str (java.util.UUID/randomUUID)))
      _ (when-not (re-matches uuid-v4-pattern operation-id)
          (fail! "invalid managed agent logical operation id"
                 {:operation-id operation-id}))
      desired (optional-payload desired-raw)
      expected (optional-payload expected-raw)
      operation!
      (fn []
        (case operation
          "publish" (if managed-recovery?
                      (recover-identity-write!
                       port subject operation operation-id
                       (payload raw) desired expected)
                      (publish! port subject (payload raw)))
          "route" (if managed-recovery?
                    (recover-identity-write!
                     port subject operation operation-id
                     (payload raw) desired expected)
                    (update-route! port subject (payload raw)))
          "retask" (retask! port subject (payload raw))
          "terminal" (if managed-recovery?
                       (recover-terminal-write!
                        port subject operation-id (payload raw) expected terminal-thread)
                       (terminal! port subject (payload raw)))
          (fail! "internal agent fact operation must be publish, route, retask, terminal, or attest"
                 {:operation operation})))
      ;; Fresh publish preferred path: ONE atomic server-side fenced publish
      ;; (thread 019f9374), collapsing the ~115 sequential lease-fenced ops. Only
      ;; a genuinely fresh subject (or a byte-identical idempotent replay) commits
      ;; through it; every reused/partial/recovery generation returns nil and falls
      ;; back to with-write-lease below with no atomic mutation to reconcile. Route
      ;; carries its own overlay semantics and stays on the sequential path. A
      ;; recovery publish only shortcuts when its delta IS the complete desired
      ;; projection, the precondition recover-identity-write! enforces anyway.
      atomic-result
      (when (and (= "publish" operation)
                 (or (not managed-recovery?)
                     (= desired (payload raw))))
        (atomic-fresh-publish! port subject (payload raw)
                               supplied-holder operation-id))
      result (cond
               (= "attest" operation)
               (attest! port subject (payload raw))
               atomic-result atomic-result
               :else
               (with-write-lease port subject operation supplied-holder operation!))]
  (println (json/generate-string {:ok true :result result})))
