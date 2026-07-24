;; orchestration-project-cli.clj — Phase 1 catalog PROJECTOR for the Gaffer ->
;; North Orchestration migration (thread 019f8f5c-74e0-7be7-ba65-3179f1bccde1).
;;
;; Reconstructs the canonical JSON of the imported catalog subgraph (staffing
;; catalog.json / providers/{anthropic,openai}.json) from graph facts, reading
;; via the @catalog:current pointer so it always sees the atomically-flipped
;; version. This ONE projection is consumed twice: the equality gate proves it
;; is byte-equal (after normalization) to the source files, and the TS dual-read
;; path (NORTH_STAFFING_SOURCE=graph) feeds it through the existing loaders.
;;
;; usage:
;;   bb orchestration-project-cli.clj <port> staffing            catalog.json projection
;;   bb orchestration-project-cli.clj <port> provider <name>     providers/<name>.json projection
;;   bb orchestration-project-cli.clj <port> policy-pin          §3.2 three-way rule digests
;;   bb orchestration-project-cli.clj <port> catalog-pin         §3.1(6) receipt graph-digest + tx watermark
(require '[clojure.java.io :as io]
         '[clojure.string :as str]
         '[cheshire.core :as json])

(def CLI-DIR (.getParent (io/file (System/getProperty "babashka.file"))))
(load-file (str CLI-DIR "/coord.clj"))
(load-file (str CLI-DIR "/orchestration-selection.clj"))
(def send-op north.coord/send-op)
(def enumerate-selection-rules north.orchestration-selection/enumerate-selection-rules)
(def rule-map                  north.orchestration-selection/rule-map)
(def rules-digest              north.orchestration-selection/rules-digest)

(def POINTER "@catalog:current")
(def REASONING-RANK ["low" "medium" "high" "xhigh" "max"])
(defn by-reasoning [xs] (sort-by #(.indexOf REASONING-RANK %) xs))

(defn current-version [port]
  (or (some-> (:value (send-op port {:op :resolved :te POINTER :p "catalog_version"})) parse-long)
      (throw (ex-info "no @catalog:current pointer — import first" {}))))

(defn facts
  "All (p o) facts for one subject."
  [port subj]
  (->> (:ok (send-op port {:op :query
                           :query {:find "p,o" :rules [{:head {:rel "p,o" :args [{:var "p"} {:var "o"}]}
                                                        :body [{:rel "triple" :args [subj {:var "p"} {:var "o"}]}]}]}}))
       (reduce (fn [m [p o]] (update m p (fnil conj []) o)) {})))

(defn one [f p] (first (get f p)))
(defn many [f p] (vec (get f p)))
;; `name` is an engine-reserved predicate (unwritable), so a subject's display
;; name is derived from its id's last colon-segment, not stored.
(defn id-name [subj] (last (str/split subj #":")))

(defn subjects-of-kind
  "Version-scoped subject ids carrying kind=k."
  [port ver k]
  (let [prefix (str "@catalog:v" ver ":")]
    (->> (:ok (send-op port {:op :query
                             :query {:find "s" :rules [{:head {:rel "s" :args [{:var "s"}]}
                                                        :body [{:rel "triple" :args [{:var "s"} "kind" k]}]}]}}))
         (map first)
         (filter #(str/starts-with? % prefix))
         sort)))

;; ---------------------------------------------------------------------------
;; Staffing projection.
;; ---------------------------------------------------------------------------
(def AXIS-KEY {"task_grade" "taskGrades" "tier" "semanticTiers" "reasoning" "deliberations"
               "topology" "topologies" "posture" "postures" "capability" "capabilities"})

(defn project-staffing [port]
  (let [ver (current-version port)
        st (facts port (str "@catalog:v" ver ":staffing"))
        axis-values (subjects-of-kind port ver "axis_value")
        by-axis (reduce (fn [m s]
                          (let [f (facts port s)]
                            (update m (one f "axis") (fnil conj [])
                                    [(parse-long (one f "rank")) (id-name s)])))
                        {} axis-values)
        vocab (reduce (fn [m [axis vk]]
                        (assoc m vk (mapv second (sort-by first (get by-axis axis)))))
                      {} AXIS-KEY)
        ;; preset capability arrays are listed in vocabulary (capability-axis
        ;; rank) order in the source, so reproduce that order — not lexical.
        cap-rank (into {} (map (fn [[r n]] [n r]) (get by-axis "capability")))
        presets (for [s (subjects-of-kind port ver "template")]
                  (let [f (facts port s)]
                    {"name" (id-name s)
                     "taskGrade" (one f "task_grade")
                     "tier" (one f "tier")
                     "deliberation" (one f "reasoning")
                     "topology" (one f "topology")
                     "posture" (one f "posture")
                     "capabilities" (vec (sort-by cap-rank (many f "capability")))
                     "tagline" (one f "tagline")
                     "description" (one f "doc")}))]
    {"$schema" "./catalog.schema.json"
     "version" (parse-long (one st "catalog_version"))
     "vocabulary" vocab
     "defaults" {"taskGrade" (one st "default_task_grade")
                 "tier" (one st "default_tier")
                 "deliberation" (one st "default_reasoning")
                 "topology" (one st "default_topology")
                 "posture" (one st "default_posture")}
     "presets" (vec presets)
     "aliases" []}))

;; ---------------------------------------------------------------------------
;; Provider projection. Levels unify on the "reasoning" knob (the graph's
;; canonical deliberation vocabulary); normalization renames the file's
;; "efforts"/"defaultEffort" to match — the design's byte-equal-after-
;; normalization contract.
;; ---------------------------------------------------------------------------
(defn project-provider [port provider]
  (let [ver (current-version port)
        prefix (str "@catalog:v" ver ":")
        p (facts port (str prefix "provider:" provider))
        model-subjs (filter #(str/starts-with? % (str prefix "model:" provider ":"))
                            (subjects-of-kind port ver "model"))
        tier-subjs (filter #(str/starts-with? % (str prefix "tier-row:" provider ":"))
                          (subjects-of-kind port ver "tier_row"))
        model-facts (into {} (map (fn [s] [(id-name s) (facts port s)]) model-subjs))
        aliases (into {} (for [[m f] model-facts a (many f "alias")] [a m]))
        models (into {} (for [[m f] model-facts]
                          (let [routes (reduce (fn [acc r]
                                                 (let [[tier lvl] (str/split r #"/")]
                                                   (update acc tier (fnil conj []) lvl)))
                                               {} (many f "calibrated_route"))]
                            [m (cond-> {"reasoning" (by-reasoning (many f "deliberation_support"))
                                        "contextWindow" {"tokens" (parse-long (one f "context_window_tokens"))
                                                         "effectiveFrom" (one f "context_window_from")}}
                                 (seq routes)
                                 (assoc "routes" (into {} (map (fn [[t ls]] [t (by-reasoning ls)]) routes))))])))
        deltas (into {} (for [[m f] model-facts]
                          [m (if (= "calibrated" (one f "delta_kind"))
                               {"kind" "calibrated" "path" (one f "doctrine_source")}
                               {"kind" (one f "delta_kind") "reason" (one f "delta_reason")})]))
        tiers (into {} (for [s tier-subjs]
                         (let [f (facts port s)]
                           [(one f "tier") {"model" (one f "model")
                                            "reasoning" (by-reasoning (many f "level"))
                                            "defaultReasoning" (one f "default_level")}])))]
    {"$schema" "./catalog.schema.json"
     "provider" provider
     "provenance" {"asOf" (one p "as_of")
                   "reviewAfter" (one p "review_after")
                   "sources" (mapv json/parse-string (many p "provenance_source"))}
     "transports" (many p "transport")
     "modelAliases" aliases
     "models" models
     "modelDeltas" deltas
     "tiers" tiers}))

;; ---------------------------------------------------------------------------
;; §3.2 digest pin. Three digests over the canonical selection-rule table that
;; MUST be equal for admission to proceed (the TS consumer refuses otherwise):
;;   storedSha256     — the policy_sha256 fact the importer wrote.
;;   projectionSha256 — recomputed here from the live rule subjects (a bare
;;                      graph write to a floor changes THIS but not the stored
;;                      fact, so the pin catches it).
;;   validatorSha256  — enumerated from the canonical validator's baked table
;;                      (changing a floor without a validator/policy version
;;                      bump changes stored+projection but not THIS).
;; A floor therefore moves only by a policy version bump, never a bare write.
;; ---------------------------------------------------------------------------
(defn gaffer-root []
  (or (System/getenv "GAFFER_HOME")
      (str (System/getenv "HOME") "/code/gaffer")))

(defn project-policy-pin [port]
  (let [ver (current-version port)
        policy (str "@catalog:v" ver ":selection-policy:minimum-sufficient-v1")
        pf (facts port policy)
        stored (one pf "policy_sha256")
        rule-subjs (many pf "rule")
        graph-rules (for [s rule-subjs]
                      (let [f (facts port s)]
                        (rule-map (one f "signal") (one f "signal_value")
                                  (one f "rule_code") (one f "min_tier") (one f "min_reasoning"))))
        validator-rules (enumerate-selection-rules (gaffer-root))]
    {"policyVersion" "minimum-sufficient-v1"
     "catalogVersion" ver
     "storedSha256" stored
     "projectionSha256" (rules-digest graph-rules)
     "validatorSha256" (rules-digest validator-rules)}))

;; ---------------------------------------------------------------------------
;; §3.1 point 6 — receipt catalog pin. The admission receipt's catalog-FILE
;; sha256s (staffingCatalogSha256/providerCatalogsSha256 in routing-economics.ts,
;; computed over Gaffer JSON on disk) are replaced, under NORTH_STAFFING_SOURCE=
;; graph, by (a) the digest of the canonical JSON projection of the catalog
;; subgraph and (b) two version watermarks — so the receipt names the EXACT graph
;; state admission accepted rather than a file the graph may no longer mirror:
;;   catalogVersion      — the @catalog:current pointer version (which versioned
;;                         subgraph was projected).
;;   coordinatorVersion  — the daemon's global tx watermark at projection time
;;                         (design §3.1's "tell-ack version", e.g. v322995).
;;   catalogDigestSha256 — sha256 over canonical JSON of {staffing, providers}.
;; The digest is computed here (one subprocess) over the SAME projections the
;; loaders read, with sorted-key canonicalization so it is deterministic and
;; recomputable for audit.
;; ---------------------------------------------------------------------------
(defn- canon
  "Recursively sort map keys so the JSON serialization is order-independent."
  [x]
  (cond
    (map? x)        (into (sorted-map) (map (fn [[k v]] [k (canon v)]) x))
    (sequential? x) (mapv canon x)
    :else           x))

(defn- sha256-hex [^String s]
  (let [md (java.security.MessageDigest/getInstance "SHA-256")
        bs (.digest md (.getBytes s java.nio.charset.StandardCharsets/UTF_8))]
    (str/join (map #(format "%02x" (bit-and % 0xff)) bs))))

(defn project-catalog-pin [port]
  (let [ver (current-version port)
        coord-ver (:version (send-op port {:op :version}))
        subgraph {"staffing"  (project-staffing port)
                  "providers" {"anthropic" (project-provider port "anthropic")
                               "openai"    (project-provider port "openai")}}]
    {"catalogVersion"      ver
     "coordinatorVersion"  coord-ver
     "catalogDigestSha256" (sha256-hex (json/generate-string (canon subgraph)))}))

(let [[ps verb arg] *command-line-args*
      port (Integer/parseInt (or ps "7977"))]
  (case verb
    "staffing"    (println (json/generate-string (project-staffing port)))
    "provider"    (println (json/generate-string (project-provider port arg)))
    "policy-pin"  (println (json/generate-string (project-policy-pin port)))
    "catalog-pin" (println (json/generate-string (project-catalog-pin port)))
    (do (println "usage: orchestration-project-cli.clj <port> {staffing | provider <name> | policy-pin | catalog-pin}")
        (System/exit 2))))
