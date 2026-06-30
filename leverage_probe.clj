;; leverage_probe.clj — the ONE honest empirical test of "claim-native = less code".
;; Computes leverage TWO ways over the live log and proves they agree, so the LOC
;; comparison rests on identical output, not hand-waving:
;;   (A) shipped imperative: proj/transitive-dependents (manual loop+cycle-guard over k/Index)
;;   (B) Datalog: a recursive `reaches` rule over the reified store (the chartroom-proven closure)
;; Honest accounting (printed below): (B)'s RULE is tiny, but it cannot run without the
;; reified-store loader + the hand-listed predicate schema — a cost tern does NOT pay today.
;;   FRAM_LOG=~/.local/state/tern/claims.log bb -cp out leverage_probe.clj
(require '[fram.cnf :as c] '[fram.schema :as s] '[fram.datalog :as d]
         '[fram.kernel :as k] '[tern.projections :as proj] '[fram.fold :as fold]
         '[fram.rt] '[clojure.string :as str] '[clojure.set :as set] '[clojure.java.io :as io])

(def log (System/getenv "FRAM_LOG"))
(when (or (nil? log) (not (.exists (io/file log))))
  (println "leverage_probe: skipped — set FRAM_LOG") (System/exit 0))

(def flat-claims (:claims (fold/fold (fram.rt/read-log log))))
(def idx (k/build-index flat-claims))
(def work-ids (k/work-thread-ids-i idx))

;; --- (A) shipped imperative closure ----------------------------------------
(def imp-closure (into {} (map (fn [te] [te (set (proj/transitive-dependents idx te))]) work-ids)))
(def imp-score   (into {} (map (fn [te] [te (proj/leverage-score idx te)]) work-ids)))

;; --- reified-store loader (the scaffolding (B) requires; tern pays NONE of this today) ---
(def single-preds #{"title" "owner" "lead" "driver" "assignee" "source" "part_of"
                    "do_on" "valid_until" "estimate_hours" "created_at" "updated_at"
                    "body" "created_by" "committed" "outcome" "abandoned"
                    "superseded_by" "merged_into" "session_of" "start_time" "end_time" "clockify_id"})
(def ref-preds #{"depends_on" "part_of" "relates_to" "clarifies" "amends" "created_by"
                 "lead" "driver" "assignee" "proposed_by" "session_of" "superseded_by" "merged_into"})
(def ctx (c/new-store))
(def tx (c/begin-tx! ctx "leverage"))
(s/setup! ctx tx)
(doseq [p (distinct (map :p flat-claims))]
  (s/def-predicate! ctx p (if (single-preds p) "single" "multi") (if (ref-preds p) "ref" "literal") tx))
(def memo (atom {}))
(defn ent-for! [sid] (or (get @memo sid) (let [id (c/entity! ctx)] (swap! memo assoc sid id) (s/name! ctx id sid tx) id)))
(defn ref? [x] (str/starts-with? x "@"))
(doseq [cl flat-claims]
  (let [subj (ent-for! (:l cl)) p (:p cl) r (:r cl)]
    (if (ref? r) (s/link! ctx subj p (ent-for! r) tx) (s/assert! ctx subj p r tx))))

;; --- (B) the recursive reaches closure: x reaches y iff y (transitively) depends_on x ----
(def dep-p (c/value-id ctx "depends_on"))
(def rules
  [(d/rule "reaches" [(d/v :x) (d/v :y)] [(d/lit "triple" [(d/v :y) dep-p (d/v :x)])])
   (d/rule "reaches" [(d/v :x) (d/v :z)] [(d/lit "reaches" [(d/v :x) (d/v :y)])
                                          (d/lit "triple" [(d/v :z) dep-p (d/v :y)])])])
(def db (d/run-rules ctx rules))
(def reaches-pairs (d/facts db "reaches"))
(def dl-closure
  (reduce (fn [m [x y]] (update m (s/name-of ctx x) (fnil conj #{}) (s/name-of ctx y)))
          {} reaches-pairs))

;; --- compare the CLOSURES per work-thread (the recursive part the rule replaces) ----
(def diffs
  (keep (fn [te]
          (let [a (get imp-closure te #{}) b (get dl-closure te #{})]
            (when (not= a b) [te (set/difference a b) (set/difference b a)])))
        work-ids))

(println "== leverage probe: imperative closure vs Datalog reaches closure ==")
(println (str "  live log: " (count flat-claims) " claims, " (count work-ids) " work-threads"))
(println (str "  threads with non-empty leverage (imperative): "
              (count (filter (fn [[_ s]] (pos? s)) imp-score))))
(if (empty? diffs)
  (println "  [PASS] every work-thread's transitive-dependents set is IDENTICAL under both methods")
  (do (println (str "  [FAIL] " (count diffs) " threads differ:"))
      (doseq [[te only-a only-b] (take 8 diffs)]
        (println (str "    " te "  only-imperative=" only-a "  only-datalog=" only-b)))
      (System/exit 1)))
(println)
(println "== honest LOC accounting ==")
(println "  (A) imperative, shipped:  transitive-dependents (12) + leverage-score (4) = 16 lines, ZERO setup, runs on k/Index.")
(println "  (B) Datalog reaches:      the rule itself = 4 lines (2 d/rule clauses).")
(println "      BUT (B) cannot run without the reified store: ~17-line loader (single-preds/ref-preds")
(println "      schema + def-predicate! loop + ent-for! memo + ref? + load loop) that tern pays NOWHERE today.")
(println "  => marginal (store already populated): 4 < 16, real win on the RECURSIVE case.")
(println "  => single-derivation adoption (leverage alone): 4+17 = 21 > 16, NET LOSS + a rotting predicate schema.")
