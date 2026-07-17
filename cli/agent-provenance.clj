(ns north.agent-provenance
  "Canonical managed-agent identity and Gaffer provenance validation shared by
  startup acknowledgement, roster rendering, and lifecycle trace.")

(require '[cheshire.core :as json]
         '[clojure.string :as str])

(def routing-override-fields
  #{"taskGrade" "domainRequirements" "topology" "tier" "reasoning" "posture"})
(def identity-predicates
  #{"kind" "role" "model" "provider" "provider_target" "effort"
    "composition_kind" "composition_id" "composition_overrides"
    "composition_override_reason" "nearest_preset" "bespoke_reason"
    "promotion_candidate" "composition_contract_sha256"
    "composition_contract_fingerprint_version" "composition_contract_fingerprint_domain"
    "repo" "goal"
    "coordinator" "spawned_at"})
(def required-identity-predicates
  ["kind" "role" "goal" "provider" "provider_target" "model" "effort"
   "composition_kind" "composition_id" "repo" "spawned_at" "display_handle"
   "display_name" "identity_manifest_sha256"])
(def terminal-predicates
  #{"outcome" "process_outcome" "delivery_outcome" "delivery_reason"
    "terminal_manifest_sha256"})
(def conflict-key "__identity_conflicts")

(defn- fold-terminal-value [prior value]
  (cond
    (nil? prior) #{value}
    (set? prior) (conj prior value)
    (and (sequential? prior) (not (string? prior))) (conj (set prior) value)
    :else #{prior value}))

(defn fold-fact
  "Fold one graph row without hiding a second live managed value. Identity
  conflicts retain their explicit defect marker; terminal values remain sets so
  terminal projection validation rejects ambiguity instead of accepting the
  graph row that happened to arrive last."
  [facts predicate value]
  (if (terminal-predicates predicate)
    (update facts predicate fold-terminal-value value)
    (let [managed-predicate? (or (identity-predicates predicate)
                                 (= "identity_manifest_sha256" predicate))
          prior (get facts predicate)]
      (cond-> (assoc facts predicate value)
        (and managed-predicate? (some? prior) (not= prior value))
        (update conflict-key (fnil conj #{}) predicate)))))

(defn known [value]
  (let [s (some-> value str str/trim)] (when (seq s) s)))

(defn safe-role-id? [value]
  (boolean (and (string? value)
                (re-matches #"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" value))))

(defn composition-overrides [facts]
  (let [raw (known (get facts "composition_overrides"))]
    (if-not raw {:valid false :value []}
      (try
        (let [value (json/parse-string raw)]
          (if (and (sequential? value) (every? routing-override-fields value)
                   (= (count value) (count (set value))))
            {:valid true :value (vec value)}
            {:valid false :value []}))
        (catch Exception _ {:valid false :value []})))))

(defn canonical-identity [facts]
  (->> identity-predicates
       (keep (fn [predicate]
               (when-let [value (known (get facts predicate))]
                 [predicate value])))
       (sort-by first)
       (map (fn [[predicate value]] (str predicate "\u0000" value "\n")))
       (apply str)))

(defn sha256 [value]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        (.getBytes (str value) java.nio.charset.StandardCharsets/UTF_8))]
    (format "%064x" (java.math.BigInteger. 1 digest))))

(defn manifest-sha256 [facts]
  (sha256 (canonical-identity facts)))

(defn preset-evidence-defects [facts]
  (let [raw (get facts "composition_overrides")
        reason (known (get facts "composition_override_reason"))
        {:keys [valid value]} (composition-overrides facts)]
    (cond-> []
      (nil? raw) (conj "composition_overrides(required for preset)")
      (and (some? raw) (not valid)) (conj "composition_overrides(valid unique routing axes)")
      (and valid (not= (boolean (seq value)) (boolean reason)))
      (conj "composition_override_reason(exactly when overrides nonempty)"))))

(defn bespoke-evidence-defects [facts]
  (let [reason (known (get facts "bespoke_reason"))
        promotion (get facts "promotion_candidate")
        fingerprint (known (get facts "composition_contract_sha256"))
        version (known (get facts "composition_contract_fingerprint_version"))
        domain (known (get facts "composition_contract_fingerprint_domain"))]
    (cond-> []
      (nil? reason) (conj "bespoke_reason")
      (not (contains? #{"true" "false"} promotion)) (conj "promotion_candidate(boolean)")
      (not (boolean (and fingerprint (re-matches #"^[0-9a-f]{64}$" fingerprint))))
      (conj "composition_contract_sha256")
      (not= "v1" version) (conj "composition_contract_fingerprint_version(v1)")
      (not= "north:bespoke-contract:v1" domain)
      (conj "composition_contract_fingerprint_domain(north:bespoke-contract:v1)"))))

(defn identity-defects
  "Return every missing or contradictory proof for a managed lane, including a
  commit marker matching the current canonical projection."
  [facts]
  (let [missing (remove #(known (get facts %)) required-identity-predicates)
        kind (get facts "kind")
        composition-kind (get facts "composition_kind")
        role (get facts "role")
        composition-id (get facts "composition_id")
        marker (known (get facts "identity_manifest_sha256"))
        conflicts (seq (get facts conflict-key))]
    (vec (distinct
          (concat missing
                  (when conflicts [(str "single-valued identity predicates(" (str/join "," (sort conflicts)) ")")])
                  (when (and (some? kind) (not= "lane" kind)) ["kind(lane)"])
                  (when (and (some? composition-kind)
                             (not (contains? #{"preset" "bespoke"} composition-kind)))
                    ["composition_kind(preset|bespoke)"])
                  (when (and (known role) (known composition-id) (not= role composition-id))
                    ["composition_id(matches role)"])
                  (when (and (some? role) (not (safe-role-id? role))) ["role(safe Gaffer id)"])
                  (when (and (some? composition-id) (not (safe-role-id? composition-id)))
                    ["composition_id(safe Gaffer id)"])
                  (case composition-kind
                    "preset" (preset-evidence-defects facts)
                    "bespoke" (bespoke-evidence-defects facts)
                    [])
                  (when (and marker (not= marker (manifest-sha256 facts)))
                    ["identity_manifest_sha256(matches current projection)"]))))))

(defn managed-valid? [facts] (empty? (identity-defects facts)))

(defn gaffer-provenance
  "Exact public provenance state. Native provider sessions are honest absence;
  malformed or uncommitted managed lanes are migration/corruption debt."
  [{:strs [kind role composition_kind composition_id] :as facts}]
  (cond
    (= kind "session") "gaffer:not-selected"
    (not (managed-valid? facts)) "gaffer:legacy-debt"
    (= composition_kind "preset")
    (let [{:keys [value]} (composition-overrides facts)
          base (str "gaffer:" composition_id)]
      (if (seq value) (str base "+override(" (str/join "," value) ")") base))
    (= composition_kind "bespoke") (str "gaffer:bespoke:" composition_id)
    :else "gaffer:legacy-debt"))

(defn provenance-detail [facts]
  (let [kind (get facts "composition_kind")
        {:keys [value]} (composition-overrides facts)]
    (cond-> {:label (gaffer-provenance facts) :kind kind}
      (= kind "preset")
      (assoc :overrides value :override-reason (known (get facts "composition_override_reason")))
      (= kind "bespoke")
      (assoc :why (known (get facts "bespoke_reason"))
             :nearest-reference-only (known (get facts "nearest_preset"))
             :promotion-candidate (get facts "promotion_candidate")
             :contract-sha256 (known (get facts "composition_contract_sha256"))
             :contract-fingerprint-version (known (get facts "composition_contract_fingerprint_version"))
             :contract-fingerprint-domain (known (get facts "composition_contract_fingerprint_domain"))))))
