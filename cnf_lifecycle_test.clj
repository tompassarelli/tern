;; cnf_lifecycle_test.clj — Stage 4 gate: the tern lifecycle derivations
;; (terminal / work-thread / blocked / ready) expressed AS Datalog rules over the
;; reified store must produce the SAME results as the hand-coded flat projections.
;; Derivation replaces bespoke code — the CNF thesis, checked on the live corpus.
;;   FRAM_LOG=/path bb -cp out cnf_lifecycle_test.clj
(require '[fram.cnf :as c] '[fram.schema :as s] '[fram.datalog :as d]
         '[fram.kernel :as k] '[tern.projections :as proj] '[fram.fold :as fold]
         '[fram.rt] '[clojure.string :as str] '[clojure.set :as set] '[clojure.java.io :as io])

(def log (System/getenv "FRAM_LOG"))
(when (or (nil? log) (not (.exists (io/file log))))
  (println "cnf_lifecycle_test: skipped — set FRAM_LOG") (System/exit 0))

(def flat-claims (:claims (fold/fold (fram.rt/read-log log))))

;; --- hand-coded (flat) projections = the golden reference -------------------
;; proj/ready now takes today + before? and excludes future-do_on (dormant)
;; threads (the-model §3/§7). The Datalog twin below has no schedule axis, so for
;; the golden EQUALITY we drive ready with a far-future `today` (no live do_on can
;; be in the future of it) — a dormancy-FREE base. Dormancy itself is covered
;; directly in projections_test.clj, not pushed into the Datalog layer.
(def flat-idx (k/build-index flat-claims))
(def far-future "9999-12-31")
(defn before? [a b] (neg? (compare a b)))
(def flat-ready (set (proj/ready flat-idx far-future before?)))
(def flat-blocked (set (proj/blocked flat-idx)))

;; --- load the corpus into the reified store (schema loader) -----------------
(def single-preds #{"title" "owner" "lead" "driver" "assignee" "source" "part_of"
                    "do_on" "valid_until" "estimate_hours" "created_at" "updated_at"
                    "body" "created_by" "committed" "outcome" "abandoned"
                    "superseded_by" "merged_into" "session_of" "start_time" "end_time" "clockify_id"})
(def ref-preds #{"depends_on" "part_of" "relates_to" "clarifies" "amends" "created_by"
                 "lead" "driver" "assignee" "proposed_by" "session_of" "superseded_by" "merged_into"})
(def ctx (c/new-store))
(def tx (c/begin-tx! ctx "lifecycle"))
(s/setup! ctx tx)
(doseq [p (distinct (map :p flat-claims))]
  (s/def-predicate! ctx p (if (single-preds p) "single" "multi") (if (ref-preds p) "ref" "literal") tx))
(def memo (atom {}))
(defn ent-for! [sid] (or (get @memo sid) (let [id (c/entity! ctx)] (swap! memo assoc sid id) (s/name! ctx id sid tx) id)))
(defn ref? [x] (str/starts-with? x "@"))
(doseq [cl flat-claims]
  (let [subj (ent-for! (:l cl)) p (:p cl) r (:r cl)]
    (if (ref? r) (s/link! ctx subj p (ent-for! r) tx) (s/assert! ctx subj p r tx))))

;; --- the tern lifecycle, AS RULES (lifecycle DERIVED from the explicit
;;     committed/outcome/abandoned claims — never a stored heuristic) -----------
(def out-p (c/value-id ctx "outcome"))
(def ab-p  (c/value-id ctx "abandoned"))
(def tit-p (c/value-id ctx "title"))
(def dep-p (c/value-id ctx "depends_on"))
(def com-p (c/value-id ctx "committed"))
;; the STRUCTURAL anchor (the-model §2/§7) replaces source=migrated: an anchor is
;; a titled, committed node with NO work axis at all. These are the work-axis
;; predicate value-ids — any one present disqualifies a node from being an anchor.
;; Mirrors fram.kernel/anchor-i? exactly, so flat work == reified work both pre-
;; AND post-migration (after source=migrated is dropped).
(def work-axis-preds
  (->> ["outcome" "abandoned" "driver" "depends_on" "part_of" "do_on"
        "valid_until" "estimate_hours" "lead" "proposed_by" "created_at"
        "updated_at" "repo"]
       (map (fn [p] (c/value-id ctx p)))
       (remove nil?)
       vec))

(def strata
  [;; stratum 0 — positive base over the EDB
   (into
    [(d/rule "terminal" [(d/v :x)] [(d/lit "triple" [(d/v :x) out-p (d/v :o)])])
     (d/rule "terminal" [(d/v :x)] [(d/lit "triple" [(d/v :x) ab-p (d/v :a)])])
     (d/rule "titled"   [(d/v :x)] [(d/lit "triple" [(d/v :x) tit-p (d/v :t)])])
     (d/rule "committed-r" [(d/v :x)] [(d/lit "triple" [(d/v :x) com-p (d/v :c)])])]
    ;; work-axis: positive disjunction over the EDB (any work-axis pred present).
    (mapv (fn [wp] (d/rule "work-axis" [(d/v :x)] [(d/lit "triple" [(d/v :x) wp (d/v :w)])]))
          work-axis-preds))
   ;; stratum 1 — anchor needs ¬work-axis (computed in stratum 0)
   [(d/rule "anchor" [(d/v :x)]
            [(d/lit "titled" [(d/v :x)]) (d/lit "committed-r" [(d/v :x)]) (d/nlit "work-axis" [(d/v :x)])])]
   ;; stratum 2 — needs ¬anchor, ¬terminal
   [(d/rule "work" [(d/v :x)] [(d/lit "titled" [(d/v :x)]) (d/nlit "anchor" [(d/v :x)])])
    (d/rule "open-dep" [(d/v :x)]
            [(d/lit "triple" [(d/v :x) dep-p (d/v :y)]) (d/lit "titled" [(d/v :y)]) (d/nlit "terminal" [(d/v :y)])])]
   ;; stratum 3 — needs ¬terminal, ¬open-dep
   [(d/rule "blocked" [(d/v :x)] [(d/lit "work" [(d/v :x)]) (d/nlit "terminal" [(d/v :x)]) (d/lit "open-dep" [(d/v :x)])])
    (d/rule "ready"   [(d/v :x)] [(d/lit "work" [(d/v :x)]) (d/nlit "terminal" [(d/v :x)]) (d/nlit "open-dep" [(d/v :x)])])]])

(def viols (d/strata-violations strata))
(def db (d/run-strata ctx strata))
(defn names [rel] (set (map (fn [t] (s/name-of ctx (first t))) (d/facts db rel))))
(def r-ready (names "ready"))
(def r-blocked (names "blocked"))

(def checks
  [["program is stratifiable"                 (empty? viols)]
   ["reified ready == hand-coded ready"        (= flat-ready r-ready)]
   ["reified blocked == hand-coded blocked"    (= flat-blocked r-blocked)]
   ["ready is non-trivial"                     (> (count r-ready) 0)]])

(println "flat ready:" (count flat-ready) " reified ready:" (count r-ready)
         " | flat blocked:" (count flat-blocked) " reified blocked:" (count r-blocked))
(let [rd (set/difference flat-ready r-ready) rg (set/difference r-ready flat-ready)]
  (when (seq rd) (println "  ready only-flat:" (take 6 rd)))
  (when (seq rg) (println "  ready only-reified:" (take 6 rg))))
(let [fails (remove second checks)]
  (doseq [[nm ok] checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
  (if (empty? fails)
    (println "\nStage 4: lifecycle-as-rules == hand-coded PASS")
    (do (println "\nStage 4: FAIL") (System/exit 1))))
