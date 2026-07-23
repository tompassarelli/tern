;; orchestration-vocab-cli.clj — Phase 0 (inert) seed for the Gaffer -> North
;; Orchestration migration vocabulary (thread 019f8f5c-74e0-7be7-ba65-3179f1bccde1;
;; design doc: north-orchestration-vocabulary-design.md in the repo's private docs —
;; packaged code must not embed checkout paths, per the package path-hygiene lint).
;;
;; This registers DATA only: the 13 new @entity-kind:* kind definitions (source
;; of truth: schema-migrate.clj ORCHESTRATION-ENTITY-KINDS, read the same way
;; schema-migrate.clj reads pred-cli.clj's VOCAB — literal source parsing, not a
;; runtime require, so this script needs no fram classpath) and the five
;; @shape:<kind> subjects design section 2.1 spells out explicitly
;; (template, model, selection_rule, task, shape-the-meta-shape).
;;
;; Every shape is seeded with enforcement "unshaped" — the inert dial (design
;; section 2.3). Nothing reads or enforces these facts yet; no interpreter,
;; write path, or spawn/dispatch code changed. New predicate registration
;; itself is `bb pred-cli.clj <port> seed` (VOCAB already carries the new rows).
;;
;; usage:
;;   bb orchestration-vocab-cli.clj <port> seed     assert kind + shape data (idempotent)
;;   bb orchestration-vocab-cli.clj <port> show     print what is on the graph
;;   bb orchestration-vocab-cli.clj <port> retract  undo seed (rollback path)
(require '[clojure.java.io :as io] '[clojure.string :as str])

(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op  north.coord/send-op)
(def put!     north.coord/put!)
(def retract! north.coord/retract!)

(defn read-forms [path]
  (with-open [rdr (java.io.PushbackReader. (io/reader path))]
    (let [eof (Object.)]
      (loop [acc []]
        (let [f (read {:eof eof :read-cond :allow} rdr)]
          (if (= f eof) acc (recur (conj acc f))))))))

(defn literal-def [path sym]
  (some (fn [form] (when (and (seq? form) (= 'def (first form)) (= sym (second form)))
                     (nth form 2 nil)))
        (read-forms path)))

(defn script-dir [] (.getParent (io/file (System/getProperty "babashka.file"))))
(defn schema-migrate-path [] (str (script-dir) "/schema-migrate.clj"))

;; Single source of truth: schema-migrate.clj ORCHESTRATION-ENTITY-KINDS. Its def
;; form is `(sorted-map "kind" "doc" ...)`, a data-only call (not a self-evaluating
;; literal like pred-cli's VOCAB vector), so the parsed form is evaluated — no
;; other code from schema-migrate.clj is read or run.
(def ORCHESTRATION-ENTITY-KINDS (eval (literal-def (schema-migrate-path) 'ORCHESTRATION-ENTITY-KINDS)))

(defn exact-values [port subject predicate]
  (->> (:ok (send-op port {:op :query
                           :query {:find "v"
                                   :rules [{:head {:rel "v" :args [{:var "v"}]}
                                            :body [{:rel "triple" :args [subject predicate {:var "v"}]}]}]}}))
       (map first)))

(defn exact-facts [port subject]
  (->> (:ok (send-op port {:op :query
                           :query {:find "p,v" :rules [{:head {:rel "p,v" :args [{:var "p"} {:var "v"}]}
                                                        :body [{:rel "triple" :args [subject {:var "p"} {:var "v"}]}]}]}}))
       (map (fn [row] [(nth row 0) (nth row 1)]))
       (sort-by (juxt first second))))

(defn set-1! [port subject predicate value]
  (doseq [old (exact-values port subject predicate)] (retract! port subject predicate old))
  (put! port subject predicate (str value)))

(defn set-multi! [port subject predicate values]
  (let [current (set (exact-values port subject predicate))
        wanted  (set (map str values))]
    (doseq [v (clojure.set/difference current wanted)] (retract! port subject predicate v))
    (doseq [v (clojure.set/difference wanted current)] (put! port subject predicate v))))

;; ============================================================================
;; Entity-kind definitions — mirrors schema-migrate.clj's entity-kind-definition
;; shape exactly (entity_kind ENTITY-KIND-DEFINITION, entity_kind_name, doc) so
;; a later `north schema-migrate migrate --execute` sees these as already
;; satisfied, idempotent facts rather than a divergent second writer.
;; ============================================================================
(def ENTITY-KIND-DEFINITION "north/entity_kind_definition")

(defn seed-entity-kinds! [port]
  (doseq [[kind doc] ORCHESTRATION-ENTITY-KINDS]
    (let [subject (str "@entity-kind:" kind)]
      (set-1! port subject "entity_kind" ENTITY-KIND-DEFINITION)
      (set-1! port subject "entity_kind_name" kind)
      (set-1! port subject "doc" doc)))
  (count ORCHESTRATION-ENTITY-KINDS))

(defn retract-entity-kinds! [port]
  (doseq [[kind _] ORCHESTRATION-ENTITY-KINDS]
    (let [subject (str "@entity-kind:" kind)]
      (doseq [p ["entity_kind" "entity_kind_name" "doc"]]
        (doseq [v (exact-values port subject p)] (retract! port subject p v)))))
  (count ORCHESTRATION-ENTITY-KINDS))

;; ============================================================================
;; Shape subjects — design section 2.1, verbatim. Five shapes only: the ones
;; the design spells out explicitly. Every other new kind (axis_value,
;; provider_catalog, tier_row, selection_policy, selection_signal, wire_contract,
;; staffing_catalog, doctrine_block) stays unshaped in Phase 0 — its kind
;; definition is registered (above) but it gets no @shape:* subject yet; a later
;; phase mints one as a governed graph edit (design section 2.2), never a code
;; change.
;; ============================================================================
(def SHAPES
  {"template"
   {:required ["name" "task_grade" "topology" "tier" "reasoning" "posture" "capability" "tagline" "doc"]
    :extra-allowed ["prompt_block" "doctrine_source" "kind" "minted_by" "minted_at"]}
   "model"
   {:required ["provider" "deliberation_support" "calibrated_route"
               "context_window_tokens" "context_window_from" "delta_kind"]
    :extra-allowed ["delta_reason" "prompt_block" "doctrine_source" "alias" "kind" "minted_by" "minted_at"]}
   "selection_rule"
   {:required ["signal" "signal_value" "min_tier" "min_reasoning" "rule_code"]
    :extra-allowed ["kind" "minted_by" "minted_at"]}
   "task"
   {:required ["proposed_by" "delegate" "done_when"]
    :extra-allowed ["kind" "minted_by" "minted_at" "progress" "outcome"]
    :structural-rules ["distinct:proposed_by,delegate"]}
   "shape"
   {:required ["applies_to_kind" "required_predicate" "allowed_predicate" "enforcement"]
    :extra-allowed ["structural_rule" "kind" "minted_by" "minted_at" "doc"]}})

;; Phase 0's own enforcement dial value: inert. `unshaped` reads as "no shape
;; governs this kind yet" in design prose; seeding the shape subject itself with
;; `enforcement "unshaped"` keeps the same self-description machine-readable —
;; a later governed `tell @shape:<kind> enforcement warn` is the sole way to
;; move a kind along the dial (design section 2.3), never a code deploy.
(def PHASE-0-ENFORCEMENT "unshaped")

(defn seed-shape! [port kind {:keys [required extra-allowed structural-rules]}]
  (let [subject (str "@shape:" kind)
        allowed (vec (distinct (concat required extra-allowed)))]
    (set-1! port subject "kind" "shape")
    (set-1! port subject "applies_to_kind" kind)
    (set-multi! port subject "required_predicate" required)
    (set-multi! port subject "allowed_predicate" allowed)
    (set-multi! port subject "structural_rule" (or structural-rules []))
    (set-1! port subject "enforcement" PHASE-0-ENFORCEMENT)
    subject))

(defn seed-shapes! [port]
  (doseq [[kind spec] SHAPES] (seed-shape! port kind spec))
  (count SHAPES))

(defn retract-shape! [port kind]
  (let [subject (str "@shape:" kind)]
    (doseq [p ["kind" "applies_to_kind" "enforcement"]]
      (doseq [v (exact-values port subject p)] (retract! port subject p v)))
    (doseq [p ["required_predicate" "allowed_predicate" "structural_rule"]]
      (doseq [v (exact-values port subject p)] (retract! port subject p v)))))

(defn retract-shapes! [port]
  (doseq [[kind _] SHAPES] (retract-shape! port kind))
  (count SHAPES))

;; ============================================================================
(let [[ps verb] *command-line-args*
      port (Integer/parseInt (or ps "7977"))]
  (case verb
    "seed"
    (let [kinds (seed-entity-kinds! port)
          shapes (seed-shapes! port)]
      (println (format "✓ seeded %d @entity-kind:* definitions and %d @shape:* subjects on :%d (enforcement=%s)"
                       kinds shapes port PHASE-0-ENFORCEMENT)))

    "retract"
    (let [kinds (retract-entity-kinds! port)
          shapes (retract-shapes! port)]
      (println (format "✓ retracted %d @entity-kind:* definitions and %d @shape:* subjects on :%d"
                       kinds shapes port)))

    "show"
    (do
      (doseq [[kind _] ORCHESTRATION-ENTITY-KINDS]
        (let [subject (str "@entity-kind:" kind)
              facts (exact-facts port subject)]
          (println subject)
          (doseq [[p v] facts] (println (format "  %-20s %s" p v)))))
      (doseq [[kind _] SHAPES]
        (let [subject (str "@shape:" kind)
              facts (exact-facts port subject)]
          (println subject)
          (doseq [[p v] facts] (println (format "  %-20s %s" p v))))))

    (do (println "usage: orchestration-vocab-cli.clj <port> {seed | show | retract}")
        (System/exit 2))))
