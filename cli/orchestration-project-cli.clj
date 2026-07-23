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
(require '[clojure.java.io :as io]
         '[clojure.string :as str]
         '[cheshire.core :as json])

(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op north.coord/send-op)

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

(let [[ps verb arg] *command-line-args*
      port (Integer/parseInt (or ps "7977"))]
  (case verb
    "staffing" (println (json/generate-string (project-staffing port)))
    "provider" (println (json/generate-string (project-provider port arg)))
    (do (println "usage: orchestration-project-cli.clj <port> {staffing | provider <name>}")
        (System/exit 2))))
