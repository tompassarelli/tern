#!/usr/bin/env bb
;; orchestration-shape-lint-test.clj — Phase 0 readonly probe for the Gaffer ->
;; North Orchestration migration (thread 019f8f5c-74e0-7be7-ba65-3179f1bccde1,
;; design doc section 2, ~/code/north/docs/private/north-orchestration-vocabulary-design.md).
;;
;; Simulates default-deny shape enforcement (design section 2.1) as a pure fold
;; over the corpus log — no live coordinator required, mirrors pred-cli.clj's
;; `census-literal-preds` two-pass log fold. For every subject whose CURRENT
;; `kind` fact equals one of the five shaped kinds design section 2.1 spells out
;; (template, model, selection_rule, task, shape), every predicate the subject
;; currently carries must be in that shape's allowed_predicate set (required ∪
;; extra-allowed, `cli/orchestration-vocab-cli.clj` SHAPES — read via literal-def
;; so this stays one source of truth, not a second copy that can drift).
;;
;; This is Phase 0: the seeded @shape:* subjects carry enforcement "unshaped"
;; (inert dial, design section 2.3) and nothing in the corpus yet asserts
;; kind=template/model/selection_rule/task/shape (no code emits the new
;; predicates), so a clean run is expected to report 0 violations by
;; construction *and* by absence of any such subject — both are printed so a
;; later phase's flip to warn/enforce has a real, already-exercised check to
;; reuse rather than a probe that only ever vacuously passes.
;;
;; usage: bb orchestration-shape-lint-test.clj [logpath] [--strict]
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(defn path [relative] (io/file root relative))

(defn read-forms [file]
  (with-open [rdr (java.io.PushbackReader. (io/reader file))]
    (let [eof (Object.)]
      (loop [acc []]
        (let [f (read {:eof eof :read-cond :allow} rdr)]
          (if (= f eof) acc (recur (conj acc f))))))))

(defn literal-def [relative sym]
  (let [form (some #(when (and (seq? %) (= 'def (first %)) (= sym (second %))) %)
                   (read-forms (path relative)))]
    (when-not form (throw (ex-info (str "missing def " sym " in " relative) {})))
    (nth form 2)))

;; SHAPES is written as a literal map form using `["a" "b"]` vectors, evaluable
;; directly by the reader (no runtime require of orchestration-vocab-cli.clj —
;; that script loads coord.clj and expects a live coordinator to be reachable,
;; which a readonly corpus lint must not require).
(def SHAPES (literal-def "cli/orchestration-vocab-cli.clj" 'SHAPES))

;; The allowed-predicate sets come from the ONE generic interpreter (design
;; §2.1-2.3, cli/orchestration-shape.clj) — pure + stdlib-only, so this readonly
;; lint reuses the same allowed-set logic a future coordinator write gate would,
;; instead of a second copy that can drift.
(load-file (str (io/file root "cli/orchestration-shape.clj")))
(def SHAPE-ALLOWED (north.orchestration-shape/allowed-by-kind SHAPES))

(def default-log
  (or (System/getenv "FRAM_LOG") (str (System/getenv "HOME") "/.local/state/north/coordination.log")))

(defn fold-subject-state
  "Two-pass-equivalent single fold over the corpus log: {subject {predicate #{active-values}}}."
  [logpath]
  (let [state (atom {})]
    (with-open [rdr (io/reader logpath)]
      (loop []
        (when-let [line (.readLine rdr)]
          (when-let [rec (try (edn/read-string line) (catch Exception _ nil))]
            (when (and (map? rec) (#{"assert" "retract"} (:op rec))
                       (string? (:l rec)) (string? (:p rec)) (string? (:r rec)))
              (let [{:keys [op l p r]} rec]
                (swap! state update-in [l p]
                       (fnil (fn [vs] (if (= op "assert") (conj vs r) (disj vs r))) #{}))))
            (recur)))))
    @state))

(defn violations [subject-state]
  (for [[subject preds] subject-state
        :let [kinds (get preds "kind" #{})]
        :when (= 1 (count kinds))
        :let [kind (first kinds)
              allowed (get SHAPE-ALLOWED kind)]
        :when allowed
        [predicate values] preds
        :when (and (seq values) (not (contains? allowed predicate)))]
    {:subject subject :kind kind :predicate predicate}))

(defn shaped-subject-count [subject-state]
  (count (filter (fn [[_ preds]]
                   (let [kinds (get preds "kind" #{})]
                     (and (= 1 (count kinds)) (contains? SHAPE-ALLOWED (first kinds)))))
                 subject-state)))

(let [args *command-line-args*
      strict (some #{"--strict"} args)
      logpath (or (first (remove #{"--strict"} args)) default-log)]
  (if-not (.isFile (io/file logpath))
    (do (println (str "✗ corpus log not found: " logpath))
        (System/exit 2))
    (let [subject-state (fold-subject-state logpath)
          shaped (shaped-subject-count subject-state)
          bad (violations subject-state)]
      (println (format "orchestration shape-lint — %s over %s" (str/join "," (sort (keys SHAPE-ALLOWED))) logpath))
      (println (format "  %d subject(s) currently carry a shaped kind" shaped))
      (if (empty? bad)
        (println "  ✓ 0 violations — every shaped subject's predicates are within its allowed_predicate set")
        (do (println (str "  ✗ " (count bad) " violation(s):"))
            (doseq [{:keys [subject kind predicate]} (sort-by (juxt :subject :predicate) bad)]
              (println (format "    %-30s kind=%-16s undeclared predicate %s" subject kind predicate)))
            (when strict (System/exit 1))))
      (System/exit 0))))
