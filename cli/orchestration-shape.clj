;; orchestration-shape.clj — the generic default-deny SHAPE INTERPRETER for the
;; Gaffer -> North Orchestration migration (thread 019f8f5c-74e0-7be7-ba65-
;; 3179f1bccde1, design §2.1-2.3). Pure + stdlib-only by design so it can be
;; exercised offline (the shape-lint corpus fold, cli/tests/*) AND lifted verbatim
;; onto the coordinator's ONE serialized write path when that is authorized.
;;
;; PLACEMENT (load-bearing, recorded on 019f8f5c): the "coordinator's single
;; serialized write path" the design names is fram's coord_daemon.clj `do-assert`
;; (the F3 schema-write gate precedent lives there). fram is a rev-pinned FLAKE
;; INPUT of north, not north-repo source, and the live :7977 daemon runs it from
;; the nix store — so wiring this interpreter into that path is a fram change plus
;; a coordinator restart, BOTH forbidden by the Phase 3 orders. This library is
;; therefore the terminal north-side deliverable for slice 1: the generic
;; interpreter + the finite structural-rule vocabulary, proven at interpreter
;; level, shaped for a drop-in lift. The client (cli/coord.clj) cannot reject a
;; raw `tell`; only the daemon can.
;;
;; MODEL (design §2.1): every subject whose CURRENT `kind` fact has a @shape:<kind>
;; subject is default-deny — a write of predicate p is admitted iff p is in that
;; shape's allowed_predicate set. Value legality comes from the predicate entity
;; (cardinality/value_kind already fram-enforced; one_of_kind membership is a
;; separate layer). Cross-fact invariants (e.g. proposed_by ≠ delegate) are
;; `structural_rule` facts naming entries in THIS finite vocabulary — the rule
;; IMPLEMENTATIONS are code, the BINDING (which rule on which kind) is data.
;; Kinds WITHOUT a shape (crucially `thread`) keep open accretion.
(ns north.orchestration-shape
  (:require [clojure.set :as set]
            [clojure.string :as str]))

;; --- allowed-predicate set ------------------------------------------------
(defn shape-allowed
  "required ∪ extra-allowed for one shape spec {:required [..] :extra-allowed [..]}."
  [{:keys [required extra-allowed]}]
  (set (concat required extra-allowed)))

(defn allowed-by-kind
  "{kind -> allowed-predicate-set} across a SHAPES map."
  [shapes]
  (into {} (map (fn [[k spec]] [k (shape-allowed spec)]) shapes)))

;; --- the per-kind enforcement dial (design §2.3) --------------------------
;; A `enforcement` fact on @shape:<kind>; the ONLY way to move a kind along the
;; dial is a governed graph edit, never a code deploy (so warn is the documented
;; reversible rollback for enforce).
(def dial-levels #{"unshaped" "warn" "enforce"})

;; --- structural-rule vocabulary (finite, coordinator-registered) ----------
;; code -> (fn [subject-preds] -> violation-string | nil). `subject-preds` is the
;; subject's CURRENT state {predicate #{live-values}} (the shape lint's fold
;; shape). A `structural_rule` fact naming a code absent from this map is itself a
;; shape error (unknown-rule), never silently ignored.
(defn- distinct-preds-rule
  "Two single-valued authority predicates must not share a value (position 3:
   proposed_by = director ≠ delegate = child; a subject may not delegate to itself)."
  [subject-preds a b]
  (let [overlap (set/intersection (get subject-preds a #{}) (get subject-preds b #{}))]
    (when (seq overlap)
      (format "structural_rule distinct:%s,%s violated — shared value(s): %s"
              a b (str/join ", " (sort overlap))))))

(def structural-rule-vocabulary
  {"distinct:proposed_by,delegate"
   (fn [subject-preds] (distinct-preds-rule subject-preds "proposed_by" "delegate"))})

(defn unknown-structural-rules
  "The structural_rule codes on a shape spec that this vocabulary does not know."
  [{:keys [structural-rules]}]
  (remove structural-rule-vocabulary (or structural-rules [])))

;; --- single-predicate write decision (default-deny) -----------------------
;; The hot path a coordinator write gate calls per assert. `enforcement` is the
;; dial value read from @shape:<kind>; when omitted it defaults to "unshaped"
;; (inert) so an un-dialed shape never rejects.
(defn evaluate-write
  "Decide the write of `predicate` on a subject whose current kind is `kind`.
   shapes: {kind {:required.. :extra-allowed.. :structural-rules.. :enforcement..}}.
   Returns {:decision :admit|:warn|:reject, :message s?}. A kind with no shape,
   or a shape whose dial is unshaped, always admits (open accretion / inert)."
  [shapes kind predicate]
  (let [spec (get shapes kind)]
    (if (nil? spec)
      {:decision :admit}
      (let [dial (or (:enforcement spec) "unshaped")]
        (cond
          (= dial "unshaped") {:decision :admit}
          (contains? (shape-allowed spec) predicate) {:decision :admit}
          :else
          (let [msg (format
                     "@shape:%s default-deny: predicate '%s' is not in allowed_predicate; allowed: %s"
                     kind predicate (str/join ", " (sort (shape-allowed spec))))]
            (if (= dial "enforce")
              {:decision :reject :message msg}
              {:decision :warn :message (str "@shape:" kind " warn — " msg)})))))))

;; --- whole-subject structural check ---------------------------------------
;; Cross-fact invariants can only be judged once the relevant facts coexist, so
;; they run at subject completion (or in the corpus lint), not per single write.
(defn evaluate-structural
  "Run every bound structural_rule for `kind` over the subject's current state.
   Returns a seq of violation strings ([] = ok). Unknown rule codes are surfaced
   as their own violation so a shape can never bind a rule the coordinator lacks."
  [shapes kind subject-preds]
  (let [spec (get shapes kind)]
    (if (or (nil? spec) (= "unshaped" (or (:enforcement spec) "unshaped")))
      []
      (keep (fn [code]
              (if-let [f (structural-rule-vocabulary code)]
                (f subject-preds)
                (format "@shape:%s binds unknown structural_rule '%s'" kind code)))
            (or (:structural-rules spec) [])))))
