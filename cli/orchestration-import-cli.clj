;; orchestration-import-cli.clj — Phase 1 (publish + dual-read) catalog importer
;; for the Gaffer -> North Orchestration migration (thread
;; 019f8f5c-74e0-7be7-ba65-3179f1bccde1; design doc:
;; north-orchestration-vocabulary-design.md in the repo's private docs —
;; packaged code must not embed checkout/home paths, per the package
;; path-hygiene lint, so the Gaffer source root is resolved at runtime from
;; $GAFFER_HOME / $HOME, never a literal).
;;
;; Lifts the machine catalog into the fact graph as DRAFT subjects under a
;; version namespace (@catalog:v<N>:*), then flips the @catalog:current
;; pointer in one serialized coordinator write — the atomic pointer flip of
;; design R3. Consumers read the pointer, so a torn/partial import is never
;; visible. Sources (all Gaffer-repo-relative, read at runtime):
;;   staffing/catalog.json          templates + axis vocabulary + defaults
;;   providers/{anthropic,openai}.json  provider_catalog/model/tier_row
;;   docs/{roles,comms,task-grades,topologies,postures}.md  prompt_block fences
;;   docs/deltas/*.md               calibrated model delta prompt_blocks
;;   scripts/selection-assessment.mjs  selection_signal/policy/rule (via node,
;;                                     the canonical source — no hand-mirror)
;;
;; usage:
;;   bb orchestration-import-cli.clj <port> import   [gaffer-home]  stage + flip pointer
;;   bb orchestration-import-cli.clj <port> measure  [gaffer-home]  R2 throwaway interning probe
;;   bb orchestration-import-cli.clj <port> retract  <version>      undo one imported version
;;   bb orchestration-import-cli.clj <port> show     [version]      print the pointed subgraph ids
(require '[clojure.java.io :as io]
         '[clojure.string :as str]
         '[cheshire.core :as json]
         '[babashka.process :as p])

(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op  north.coord/send-op)
(def put!     north.coord/put!)
(def append!  north.coord/append!)
(def retract! north.coord/retract!)

;; ---------------------------------------------------------------------------
;; Source resolution — runtime only, never an embedded path.
;; ---------------------------------------------------------------------------
(defn gaffer-home [arg]
  (or arg
      (System/getenv "GAFFER_HOME")
      (str (System/getenv "HOME") "/code/gaffer")))

(defn read-json [root & segs]
  (json/parse-string (slurp (apply io/file root segs))))

;; ---------------------------------------------------------------------------
;; Prompt-block fence extraction — mirrors sdk/src/harness.ts
;; extractFenceFromSection / extractFirstFence so the imported prompt_block is
;; byte-identical to what the harness reads from GAFFER_HOME today.
;; ---------------------------------------------------------------------------
(defn extract-section-fence [text heading]
  (let [lines (str/split text #"\n" -1)
        want (str "## " (str/lower-case heading))
        start (some (fn [[i l]] (when (= want (str/lower-case (str/trim l))) (inc i)))
                    (map-indexed vector lines))]
    (when start
      (loop [i start open nil]
        (when (< i (count lines))
          (let [t (str/trim (nth lines i))]
            (cond
              (and (nil? open) (str/starts-with? t "## ")) nil
              (and (nil? open) (str/starts-with? t "```")) (recur (inc i) (inc i))
              (and (some? open) (str/starts-with? t "```")) (str/join "\n" (subvec lines open i))
              :else (recur (inc i) open))))))))

(defn extract-first-fence [text]
  (let [lines (str/split text #"\n" -1)]
    (loop [i 0 open nil]
      (when (< i (count lines))
        (let [t (str/trim (nth lines i))]
          (cond
            (and (nil? open) (str/starts-with? t "```")) (recur (inc i) (inc i))
            (and (some? open) (str/starts-with? t "```")) (str/join "\n" (subvec lines open i))
            :else (recur (inc i) open)))))))

(defn section-fence [root doc heading]
  (let [text (slurp (io/file root "docs" doc))
        block (extract-section-fence text heading)]
    (when-not (and block (seq (str/trim block)))
      (throw (ex-info (str "no fenced block: " doc " ## " heading) {})))
    block))

;; ---------------------------------------------------------------------------
;; Selection rules — enumerated FROM the canonical validator (never mirrored).
;; A tiny node module imports selection-assessment.mjs and probes each single
;; signal value through deriveSelectionAssessment, so the route floor recorded
;; per rule is exactly what the canonical policy computes. Baseline holds every
;; other signal at its no-route floor.
;; ---------------------------------------------------------------------------
(defn selection-enum-js [mjs-url]
  (str "
import { deriveSelectionAssessment } from '" mjs-url "';
const SIGNAL_VALUES = {
  decisionOwnership: ['none','bounded','cross-boundary','system-shaping','open-solution-class'],
  seamScope: ['none','established','consequential','system-wide'],
  errorExposure: ['contained-reversible','material-recoverable','high-or-hard-to-reverse'],
  oracleStrength: ['not-applicable','objective-local','objective-end-to-end','partial','judgment-only'],
  foundationalImpact: ['none','implementation-only','invariant-decision-owned'],
  dependencyShape: ['atomic-cohesive','deterministic-workflow','parallel-breadth','dynamic-decomposition','tightly-coupled-sequential'],
  reasoningShape: ['deterministic','bounded-branching','multi-hypothesis','system-synthesis','exceptional'],
};
const kebab = { decisionOwnership:'decision-ownership', seamScope:'seam-scope', errorExposure:'error-exposure', oracleStrength:'oracle-strength', foundationalImpact:'foundational-impact', dependencyShape:'dependency-shape', reasoningShape:'reasoning-shape' };
const baseline = { decisionOwnership:'none', seamScope:'none', errorExposure:'contained-reversible', oracleStrength:'not-applicable', foundationalImpact:'none', dependencyShape:'atomic-cohesive', reasoningShape:'deterministic' };
const rules = [];
for (const [sig, values] of Object.entries(SIGNAL_VALUES)) {
  for (const v of values) {
    const code = `${kebab[sig]}:${v}`;
    const signals = { ...baseline, [sig]: v };
    const d = deriveSelectionAssessment(signals);
    if (!d.ruleCodes.includes(code)) continue; // this value imposes no route floor
    rules.push({ signal: sig, signal_value: v, rule_code: code, min_tier: d.minimumTier, min_reasoning: d.minimumReasoning });
  }
}
process.stdout.write(JSON.stringify(rules));
"))

;; The Gaffer contract root is read-only (nix store), so the probe module lives
;; in a writable temp dir and imports the canonical validator by absolute URL.
(defn enumerate-selection-rules [root]
  (let [mjs (io/file root "scripts" "selection-assessment.mjs")
        url (str (.toURI (.getCanonicalFile mjs)))
        js (java.io.File/createTempFile "north-selection-enum" ".mjs")]
    (try
      (spit js (selection-enum-js url))
      (let [{:keys [exit out err]} (p/sh "node" (.getCanonicalPath js))]
        (when-not (zero? exit)
          (throw (ex-info (str "selection enum failed: " err) {})))
        (json/parse-string out))
      (finally (.delete js)))))

(defn selection-signal-values []
  {"decisionOwnership" ["none" "bounded" "cross-boundary" "system-shaping" "open-solution-class"]
   "seamScope" ["none" "established" "consequential" "system-wide"]
   "errorExposure" ["contained-reversible" "material-recoverable" "high-or-hard-to-reverse"]
   "oracleStrength" ["not-applicable" "objective-local" "objective-end-to-end" "partial" "judgment-only"]
   "foundationalImpact" ["none" "implementation-only" "invariant-decision-owned"]
   "dependencyShape" ["atomic-cohesive" "deterministic-workflow" "parallel-breadth" "dynamic-decomposition" "tightly-coupled-sequential"]
   "reasoningShape" ["deterministic" "bounded-branching" "multi-hypothesis" "system-synthesis" "exceptional"]})

;; ---------------------------------------------------------------------------
;; Pointer / version.
;; ---------------------------------------------------------------------------
(def POINTER "@catalog:current")

(defn exact-values [port subject predicate]
  (->> (:ok (send-op port {:op :query
                           :query {:find "v" :rules [{:head {:rel "v" :args [{:var "v"}]}
                                                      :body [{:rel "triple" :args [subject predicate {:var "v"}]}]}]}}))
       (map first)))

(defn current-version [port]
  (some-> (first (exact-values port POINTER "catalog_version")) parse-long))

(defn ns-subject [ver & parts] (str "@catalog:v" ver ":" (str/join ":" parts)))

;; ---------------------------------------------------------------------------
;; Emit — every write goes to the version namespace (draft) until the flip.
;; ---------------------------------------------------------------------------
(defn s1! [port subj p v] (when (some? v) (put! port subj p (str v))))
(defn smulti! [port subj p vs] (doseq [v vs] (append! port subj p (str v))))

(defn emit-staffing! [port ver catalog]
  (let [subj (ns-subject ver "staffing")
        d (get catalog "defaults")]
    (s1! port subj "kind" "staffing_catalog")
    (s1! port subj "catalog_version" (get catalog "version"))
    (s1! port subj "default_task_grade" (get d "taskGrade"))
    (s1! port subj "default_tier" (get d "tier"))
    (s1! port subj "default_reasoning" (get d "deliberation"))
    (s1! port subj "default_topology" (get d "topology"))
    (s1! port subj "default_posture" (get d "posture"))
    subj))

;; Axes whose values carry a doctrine prompt_block fence (design section 1.2).
(def AXIS-DOC
  {"taskGrades"   {:axis "task_grade" :doc "task-grades.md"}
   "topologies"   {:axis "topology"   :doc "topologies.md"}
   "postures"     {:axis "posture"    :doc "postures.md"}})
;; Axes that are enum-only vocabulary (no doctrine fence of their own).
(def AXIS-PLAIN
  {"semanticTiers" "tier"
   "deliberations" "reasoning"
   "capabilities"  "capability"})

(defn emit-axis-values! [port ver root catalog]
  (let [vocab (get catalog "vocabulary")]
    (doseq [[vkey {:keys [axis doc]}] AXIS-DOC
            [rank v] (map-indexed vector (get vocab vkey))]
      (let [subj (ns-subject ver "axis" axis v)]
        (s1! port subj "kind" "axis_value")
        (s1! port subj "axis" axis)
        (s1! port subj "rank" rank)
        (s1! port subj "prompt_block" (section-fence root doc v))
        (s1! port subj "doctrine_source" (str "docs/" doc "#" v))))
    (doseq [[vkey axis] AXIS-PLAIN
            [rank v] (map-indexed vector (get vocab vkey))]
      (let [subj (ns-subject ver "axis" axis v)]
        (s1! port subj "kind" "axis_value")
        (s1! port subj "axis" axis)
        (s1! port subj "rank" rank)))))

(defn emit-comms! [port ver root]
  (let [subj (ns-subject ver "comms" "universal")]
    (s1! port subj "kind" "doctrine_block")
    (s1! port subj "prompt_block" (section-fence root "comms.md" "universal"))
    (s1! port subj "doctrine_source" "docs/comms.md#universal")))

(defn emit-templates! [port ver root catalog]
  (doseq [preset (get catalog "presets")]
    (let [name (get preset "name")
          subj (ns-subject ver "template" name)]
      (s1! port subj "kind" "template")
      (s1! port subj "task_grade" (get preset "taskGrade"))
      (s1! port subj "topology" (get preset "topology"))
      (s1! port subj "tier" (get preset "tier"))
      (s1! port subj "reasoning" (get preset "deliberation"))
      (s1! port subj "posture" (get preset "posture"))
      (s1! port subj "tagline" (get preset "tagline"))
      (s1! port subj "doc" (get preset "description"))
      (smulti! port subj "capability" (get preset "capabilities"))
      (s1! port subj "prompt_block" (section-fence root "roles.md" name))
      (s1! port subj "doctrine_source" (str "docs/roles.md#" name)))))

;; Provider catalogs — provider derives from the subject namespace, so no
;; `provider` ref fact is emitted (the R9 ref/literal collision stays deferred).
(defn emit-provider! [port ver root provider]
  (let [cat (read-json root "providers" (str provider ".json"))
        psubj (ns-subject ver "provider" provider)
        prov (get cat "provenance")]
    (s1! port psubj "kind" "provider_catalog")
    (s1! port psubj "as_of" (get prov "asOf"))
    (s1! port psubj "review_after" (get prov "reviewAfter"))
    (smulti! port psubj "transport" (get cat "transports"))
    (smulti! port psubj "provenance_source"
             (map json/generate-string (get prov "sources")))
    ;; alias index inverted onto each model
    (let [aliases (get cat "modelAliases")
          alias-of (reduce (fn [m [a model]] (update m model (fnil conj []) a)) {} aliases)
          deltas (get cat "modelDeltas")]
      (doseq [[model spec] (get cat "models")]
        (let [msubj (ns-subject ver "model" provider model)
              levels (or (get spec "efforts") (get spec "reasoning"))
              routes (get spec "routes")
              cw (get spec "contextWindow")
              delta (get deltas model)]
          (s1! port msubj "kind" "model")
          (smulti! port msubj "alias" (sort (get alias-of model)))
          (smulti! port msubj "deliberation_support" levels)
          (smulti! port msubj "calibrated_route"
                   (for [[tier ls] routes l ls] (str tier "/" l)))
          (s1! port msubj "context_window_tokens" (get cw "tokens"))
          (s1! port msubj "context_window_from" (get cw "effectiveFrom"))
          (s1! port msubj "delta_kind" (get delta "kind"))
          (when (= "none" (get delta "kind"))
            (s1! port msubj "delta_reason" (get delta "reason")))
          (when (= "calibrated" (get delta "kind"))
            (let [path (get delta "path")]
              (s1! port msubj "doctrine_source" path)
              (s1! port msubj "prompt_block"
                   (extract-first-fence (slurp (io/file root path)))))))))
    ;; tier rows — model id stored as a literal (value-kind compatible with the
    ;; existing single-literal `model` predicate); the row's own tier + levels.
    (doseq [[tier spec] (get cat "tiers")]
      (let [tsubj (ns-subject ver "tier-row" provider tier)]
        (s1! port tsubj "kind" "tier_row")
        (s1! port tsubj "tier" tier)
        (s1! port tsubj "model" (get spec "model"))
        (smulti! port tsubj "level" (or (get spec "efforts") (get spec "reasoning")))
        (s1! port tsubj "default_level" (or (get spec "defaultEffort") (get spec "defaultReasoning")))))))

(defn emit-selection! [port ver root]
  (let [signals (selection-signal-values)
        rules (enumerate-selection-rules root)
        policy (ns-subject ver "selection-policy" "minimum-sufficient-v1")]
    (doseq [[sig vals] signals]
      (let [subj (ns-subject ver "signal" sig)]
        (s1! port subj "kind" "selection_signal")
        (smulti! port subj "one_of" vals)))
    (s1! port policy "kind" "selection_policy")
    (doseq [r rules]
      (let [code (get r "rule_code")
            subj (ns-subject ver "rule" code)]
        (s1! port subj "kind" "selection_rule")
        (s1! port subj "signal" (get r "signal"))
        (s1! port subj "signal_value" (get r "signal_value"))
        (s1! port subj "min_tier" (get r "min_tier"))
        (s1! port subj "min_reasoning" (get r "min_reasoning"))
        (s1! port subj "rule_code" code)
        (append! port policy "rule" subj)))
    ;; digest over the canonical rule projection (design section 1.5)
    (let [digest (-> (java.security.MessageDigest/getInstance "SHA-256")
                     (.digest (.getBytes (json/generate-string (sort-by #(get % "rule_code") rules))
                                         java.nio.charset.StandardCharsets/UTF_8)))]
      (s1! port policy "policy_sha256"
           (apply str (map #(format "%02x" %) digest))))))

;; ---------------------------------------------------------------------------
;; Verbs.
;; ---------------------------------------------------------------------------
(defn import! [port root]
  (let [ver (inc (or (current-version port) 0))
        catalog (read-json root "staffing" "catalog.json")]
    (emit-staffing! port ver catalog)
    (emit-axis-values! port ver root catalog)
    (emit-comms! port ver root)
    (emit-templates! port ver root catalog)
    (emit-provider! port ver root "anthropic")
    (emit-provider! port ver root "openai")
    (emit-selection! port ver root)
    ;; ATOMIC FLIP — one serialized write; consumers never see a torn import.
    (put! port POINTER "catalog_version" (str ver))
    ver))

;; measure — R2: import ONLY the multi-KB prompt_block literals to a throwaway
;; namespace, measure coordination.log growth + query latency, then retract.
(defn log-size []
  (let [f (io/file (north.coord/expected-log))]
    (if (.isFile f) (.length f) 0)))

(defn query-latency-ms [port subj]
  (let [t0 (System/nanoTime)]
    (dotimes [_ 20] (exact-values port subj "prompt_block"))
    (/ (- (System/nanoTime) t0) 1e6 20.0)))

(defn measure! [port root]
  (let [catalog (read-json root "staffing" "catalog.json")
        blocks (concat
                (for [p (get catalog "presets")] [(get p "name") (section-fence root "roles.md" (get p "name"))])
                (for [g (get-in catalog ["vocabulary" "taskGrades"])] [g (section-fence root "task-grades.md" g)])
                (for [t (get-in catalog ["vocabulary" "topologies"])] [t (section-fence root "topologies.md" t)])
                (for [ps (get-in catalog ["vocabulary" "postures"])] [ps (section-fence root "postures.md" ps)])
                [["comms" (section-fence root "comms.md" "universal")]]
                (for [d ["gpt-5.6-luna" "gpt-5.6-terra" "gpt-5.6-sol" "opus" "sonnet"]]
                  [d (extract-first-fence (slurp (io/file root "docs" "deltas" (str d ".md"))))]))
        subs (map (fn [[k _]] (str "@throwaway:probe:" k)) blocks)
        total-bytes (reduce + (map (fn [[_ b]] (count (.getBytes ^String b "UTF-8"))) blocks))
        before (log-size)
        t0 (System/nanoTime)]
    (doseq [[k b] blocks] (put! port (str "@throwaway:probe:" k) "prompt_block" b))
    (let [write-ms (/ (- (System/nanoTime) t0) 1e6)
          after (log-size)
          lat (/ (reduce + (map #(query-latency-ms port %) subs)) (count subs))]
      (doseq [s subs] (doseq [v (exact-values port s "prompt_block")] (retract! port s "prompt_block" v)))
      {:blocks (count blocks)
       :prompt_block_bytes total-bytes
       :log_growth_bytes (- after before)
       :write_ms (Math/round (double write-ms))
       :mean_query_ms (Double/parseDouble (format "%.3f" lat))})))

(defn retract-version! [port ver]
  ;; retract every fact whose subject is under @catalog:v<ver>: plus the pointer
  (let [prefix (str "@catalog:v" ver ":")
        rows (:ok (send-op port {:op :query
                                 :query {:find "s,p,o"
                                         :rules [{:head {:rel "s,p,o" :args [{:var "s"} {:var "p"} {:var "o"}]}
                                                  :body [{:rel "triple" :args [{:var "s"} {:var "p"} {:var "o"}]}]}]}}))
        mine (filter (fn [[s _ _]] (str/starts-with? s prefix)) rows)]
    (doseq [[s p o] mine] (retract! port s p o))
    (when (= ver (current-version port))
      (doseq [v (exact-values port POINTER "catalog_version")] (retract! port POINTER "catalog_version" v)))
    (count mine)))

(defn show! [port ver]
  (let [prefix (str "@catalog:v" ver ":")
        rows (:ok (send-op port {:op :query
                                 :query {:find "s" :rules [{:head {:rel "s" :args [{:var "s"}]}
                                                            :body [{:rel "triple" :args [{:var "s"} "kind" {:var "k"}]}]}]}}))
        mine (sort (distinct (filter #(str/starts-with? % prefix) (map first rows))))]
    (println (format "pointer @catalog:current -> v%s (%d subjects)" ver (count mine)))
    (doseq [s mine] (println "  " s))))

(let [[ps verb arg] *command-line-args*
      port (Integer/parseInt (or ps "7977"))]
  (case verb
    "import"  (let [ver (import! port (gaffer-home arg))]
                (println (format "✓ imported catalog v%d on :%d; @catalog:current -> v%d" ver port ver)))
    "measure" (let [m (measure! port (gaffer-home arg))]
                (println (json/generate-string m)))
    "retract" (let [ver (Integer/parseInt (or arg (str (current-version port))))
                    n (retract-version! port ver)]
                (println (format "✓ retracted %d facts under @catalog:v%d:" n ver)))
    "show"    (show! port (or (some-> arg parse-long) (current-version port)))
    (do (println "usage: orchestration-import-cli.clj <port> {import|measure|retract <ver>|show [ver]} [gaffer-home]")
        (System/exit 2))))
