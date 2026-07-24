#!/usr/bin/env bb
;; orchestration-shape-interpreter-test.clj — Phase 3 slice 1 probe for the
;; generic default-deny shape interpreter (thread 019f8f5c, design §2.1-2.3,
;; cli/orchestration-shape.clj). Pure unit test — no live coordinator: it drives
;; the interpreter over hand-built shape specs to prove the phase-table bar
;; (write of an undeclared predicate on a `kind template` subject is REJECTED
;; with a message naming @shape:template; `kind thread` writes stay unrestricted)
;; plus the per-kind unshaped→warn→enforce dial and the structural-rule vocabulary.
;;
;; usage: bb orchestration-shape-interpreter-test.clj
(require '[clojure.java.io :as io])
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/../orchestration-shape.clj"))
(alias 'shape 'north.orchestration-shape)

(def failures (atom 0))
(defn check [label pass?]
  (if pass?
    (println (str "  ✓ " label))
    (do (swap! failures inc) (println (str "  ✗ " label)))))

;; The real seeded template shape (design §2.1), with an explicit dial per case.
(defn template-shape [dial]
  {"template" {:required ["name" "task_grade" "topology" "tier" "reasoning" "posture" "capability" "tagline" "doc"]
               :extra-allowed ["prompt_block" "doctrine_source" "kind" "minted_by" "minted_at"]
               :enforcement dial}})

;; The task shape carries the position-3 structural rule.
(def task-shape
  {"task" {:required ["proposed_by" "delegate" "done_when"]
           :extra-allowed ["kind" "minted_by" "minted_at" "progress" "outcome"]
           :structural-rules ["distinct:proposed_by,delegate"]
           :enforcement "enforce"}})

(println "orchestration shape-interpreter — default-deny + dial + structural rules")

;; --- BAR: undeclared predicate on kind template is REJECTED, naming @shape:template
(let [r (shape/evaluate-write (template-shape "enforce") "template" "temperature")]
  (check "enforce: undeclared predicate on kind template is :reject" (= :reject (:decision r)))
  (check "enforce: rejection message names @shape:template"
         (clojure.string/includes? (:message r) "@shape:template")))

;; --- BAR: kind thread writes remain unrestricted (open accretion; no shape)
(let [r (shape/evaluate-write (template-shape "enforce") "thread" "anything_at_all")]
  (check "kind thread (unshaped) admits any predicate" (= :admit (:decision r))))

;; --- declared predicate on a shaped kind admits
(let [r (shape/evaluate-write (template-shape "enforce") "template" "tier")]
  (check "enforce: declared predicate (tier) admits" (= :admit (:decision r))))

;; --- the dial: unshaped is inert, warn admits-with-report, enforce rejects
(check "unshaped dial: undeclared predicate still admits (inert)"
       (= :admit (:decision (shape/evaluate-write (template-shape "unshaped") "template" "temperature"))))
(let [r (shape/evaluate-write (template-shape "warn") "template" "temperature")]
  (check "warn dial: undeclared predicate is :warn (documented rollback for enforce)" (= :warn (:decision r)))
  (check "warn message still names @shape:template" (clojure.string/includes? (:message r) "@shape:template")))

;; --- structural-rule vocabulary: distinct:proposed_by,delegate
(check "structural: self-delegation (same value) is a violation"
       (seq (shape/evaluate-structural task-shape "task"
                                       {"proposed_by" #{"@director-x"} "delegate" #{"@director-x"}})))
(check "structural: distinct proposer/delegate is clean"
       (empty? (shape/evaluate-structural task-shape "task"
                                          {"proposed_by" #{"@director-x"} "delegate" #{"@child-y"}})))
(check "structural: an unknown bound rule code is surfaced, never ignored"
       (seq (shape/evaluate-structural
             {"task" {:structural-rules ["distinct:foo,bar"] :enforcement "enforce"}}
             "task" {})))
(check "structural: unshaped dial runs no structural rules"
       (empty? (shape/evaluate-structural
                (assoc-in task-shape ["task" :enforcement] "unshaped") "task"
                {"proposed_by" #{"@x"} "delegate" #{"@x"}})))

;; --- vocabulary hygiene: the seeded rule code is known
(check "distinct:proposed_by,delegate is a registered structural rule"
       (contains? shape/structural-rule-vocabulary "distinct:proposed_by,delegate"))

(if (zero? @failures)
  (do (println "  ✓ all interpreter checks passed") (System/exit 0))
  (do (println (format "  ✗ %d interpreter check(s) failed" @failures)) (System/exit 1)))
