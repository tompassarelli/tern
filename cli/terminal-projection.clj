(ns north.terminal-projection
  "Pure read contract for crash-safe lane terminals and run publications.

  A managed lane terminal is committed by terminal_manifest_sha256 after its
  four exact terminal facts. A run is committed by kind=run, which its scoped
  writer publishes last. Legacy lane rows remain readable only when they have
  no process_outcome fact at all.")

(require '[clojure.string :as str])

(def terminal-predicates
  ["outcome" "process_outcome" "delivery_outcome" "delivery_reason"])

(defn- values-of [facts predicate]
  (let [value (get facts predicate ::absent)]
    (cond
      (= ::absent value) []
      (set? value) (vec value)
      (and (sequential? value) (not (string? value))) (vec value)
      :else [value])))

(defn fact-present?
  [facts predicate]
  (boolean (seq (values-of facts predicate))))

(defn singleton-value
  "One exact nonblank string value, or nil for absent/conflicting/malformed
  facts. Maps folded to scalar values and maps folded to sets are both accepted."
  [facts predicate]
  (let [values (values-of facts predicate)]
    (when (= 1 (count values))
      (let [value (first values)]
        (when (and (string? value) (not (str/blank? value))) value)))))

(defn- sha256 [value]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        (.getBytes (str value)
                                   java.nio.charset.StandardCharsets/UTF_8))]
    (format "%064x" (java.math.BigInteger. 1 digest))))

(defn terminal-manifest-sha256
  "Digest the exact terminal projection using the writer's canonical encoding,
  or nil when any terminal predicate is absent or non-singleton."
  [facts]
  (let [projection (into (sorted-map)
                         (keep (fn [predicate]
                                 (when-let [value (singleton-value facts predicate)]
                                   [predicate value])))
                         terminal-predicates)]
    (when (= (count terminal-predicates) (count projection))
      (sha256
       (apply str
              (map (fn [[predicate value]]
                     (str predicate "\u0000" value "\n"))
                   projection))))))

(defn terminal-manifest-valid?
  [facts]
  (let [marker (singleton-value facts "terminal_manifest_sha256")
        process (singleton-value facts "process_outcome")
        legacy-alias (singleton-value facts "outcome")
        expected (terminal-manifest-sha256 facts)]
    (boolean (and marker process legacy-alias expected
                  (= process legacy-alias)
                  (= marker expected)))))

(defn terminal-process-outcome
  "Resolve a lane terminal. The presence of process_outcome selects the modern
  protocol and therefore requires a valid terminal manifest; it never falls
  back to the concurrently published legacy alias. A true legacy row is
  accepted only when process_outcome is absent."
  [facts]
  (if (fact-present? facts "process_outcome")
    (when (terminal-manifest-valid? facts)
      (some-> (singleton-value facts "process_outcome") str/trim))
    (some-> (singleton-value facts "outcome") str/trim)))

(defn committed-run?
  "kind=run is the run writer's last-write commit marker."
  [facts]
  (= "run" (singleton-value facts "kind")))

(defn committed-run-process-outcome
  "Resolve a run terminal only after kind=run committed the row. Modern run
  rows prefer process_outcome; committed historical rows may carry only outcome."
  [facts]
  (when (committed-run? facts)
    (if (fact-present? facts "process_outcome")
      (some-> (singleton-value facts "process_outcome") str/trim)
      (some-> (singleton-value facts "outcome") str/trim))))
