;; orchestration-parity-test.clj — Phase 1 EQUALITY GATE for the Gaffer -> North
;; Orchestration migration (thread 019f8f5c-74e0-7be7-ba65-3179f1bccde1).
;;
;; Proves the graph catalog projection is byte-equal (AFTER normalization) to the
;; Gaffer source files. Normalization = deep key-sort + scalar/object array sort
;; + the deliberation-knob unification (efforts/defaultEffort -> reasoning/
;; defaultReasoning, the graph's canonical vocabulary) + $schema drop. So the gate
;; proves every template, axis value, model, route, tier, alias, contextWindow,
;; delta, and provenance survived the round-trip; a genuine content divergence
;; fails it. Requires a live coordinator with @catalog:current already imported.
;;
;;   bb cli/tests/orchestration-parity-test.clj [port] [gaffer-home]
(require '[clojure.java.io :as io]
         '[clojure.string :as str]
         '[cheshire.core :as json]
         '[babashka.process :as p])

(def port (or (some-> (first *command-line-args*) Integer/parseInt) 7977))
(def root (or (second *command-line-args*)
              (System/getenv "GAFFER_HOME")
              (str (System/getenv "HOME") "/code/gaffer")))
(def cli-dir (.getParent (io/file (System/getProperty "babashka.file"))))
(def project-cli (str (io/file (.getParentFile (io/file cli-dir)) "orchestration-project-cli.clj")))

(defn canon
  "Order- and knob-independent normal form: recursively sort object keys, sort
   every array by its canonical string, drop $schema, and rename the deliberation
   knob to the graph's canonical spelling."
  [x]
  (cond
    (sequential? x) (->> x (map canon) (sort-by json/generate-string) vec)
    (map? x) (->> (dissoc x "$schema")
                  (map (fn [[k v]]
                         [(case k "efforts" "reasoning" "defaultEffort" "defaultReasoning" k)
                          (canon v)]))
                  (into (sorted-map)))
    :else x))

(defn project [& args]
  (let [{:keys [exit out err]} (apply p/sh "bb" project-cli (str port) args)]
    (when-not (zero? exit) (throw (ex-info (str "projector failed: " err) {})))
    (json/parse-string out)))

(def results (atom []))
(defn check [label graph-json file-json]
  (let [g (canon graph-json) f (canon file-json)]
    (if (= g f)
      (do (swap! results conj true) (println (format "  ✓ %s byte-parity (normalized)" label)))
      (do (swap! results conj false)
          (println (format "  ✗ %s DIVERGES" label))
          ;; first differing top-level key
          (doseq [k (sort (distinct (concat (keys g) (keys f))))]
            (when (not= (get g k) (get f k))
              (println (format "      key %s: graph=%.180s" k (pr-str (get g k))))
              (println (format "               file=%.180s" (pr-str (get f k))))))))))

(println (format "orchestration parity gate — port %d, root %s" port root))
(check "staffing/catalog.json"
       (project "staffing")
       (json/parse-string (slurp (io/file root "staffing" "catalog.json"))))
(doseq [prov ["anthropic" "openai"]]
  (check (str "providers/" prov ".json")
         (project "provider" prov)
         (json/parse-string (slurp (io/file root "providers" (str prov ".json"))))))

(let [rs @results]
  (println (format "\n%d/%d parity checks passed" (count (filter true? rs)) (count rs)))
  (System/exit (if (every? true? rs) 0 1)))
