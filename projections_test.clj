;; projections_test.clj — the ONE precedence classifier + the schedule (dormancy)
;; axis (the-model §3/§7). Asserts the EXACT precedence terminal > blocked >
;; active > ready > dormant > draft, and that a future do_on drops a thread out of
;; `ready`/`next` (dormant) while a past do_on does not.
;;
;;   bb -cp out:$FRAM/out projections_test.clj      (run from the repo root)
(require '[fram.kernel :as k]
         '[fram.fold :as fold]
         '[tern.projections :as proj])

(defn asrt [tx l p r frame] (fold/->Assertion tx "assert" l p r frame))

;; today = 2026-06-16 ; future do_on = 2026-12-01 ; past do_on = 2020-01-01
(def today "2026-06-16")
(defn before? [a b] (neg? (compare a b)))

(def asserts
  [;; @a — outcome (terminal) AND driver  -> classify "terminal" (terminal>active)
   (asrt 1 "@a" "title" "A" "import")
   (asrt 2 "@a" "committed" "2026-01-01" "import")
   (asrt 3 "@a" "outcome" "done" "import")
   (asrt 4 "@a" "driver" "@p" "import")
   ;; @b — committed + open-dep (@dep non-terminal) + driver  -> "blocked" (blocked>active)
   (asrt 10 "@b" "title" "B" "import")
   (asrt 11 "@b" "committed" "2026-01-01" "import")
   (asrt 12 "@b" "depends_on" "@dep" "import")
   (asrt 13 "@b" "driver" "@p" "import")
   ;; @dep — a plain non-terminal thread (the open dependency). created_at keeps
   ;; it a real work thread, not an anchor (anchor = titled+committed+NO work axis).
   (asrt 14 "@dep" "title" "DEP" "import")
   (asrt 15 "@dep" "committed" "2026-01-01" "import")
   (asrt 16 "@dep" "created_at" "2026-01-01" "import")
   ;; @c — committed + driver, no deps  -> "active"
   (asrt 20 "@c" "title" "C" "import")
   (asrt 21 "@c" "committed" "2026-01-01" "import")
   (asrt 22 "@c" "driver" "@p" "import")
   ;; @d — committed real work thread (created_at => not an anchor)  -> "ready"
   (asrt 30 "@d" "title" "D" "import")
   (asrt 31 "@d" "committed" "2026-01-01" "import")
   (asrt 32 "@d" "created_at" "2026-01-01" "import")
   ;; @e — UNCOMMITTED + future do_on  -> "dormant" (and NOT in ready)
   (asrt 40 "@e" "title" "E" "import")
   (asrt 41 "@e" "do_on" "2026-12-01" "import")
   ;; @f — UNCOMMITTED + past do_on  -> "draft" (not dormant; IS in ready)
   (asrt 50 "@f" "title" "F" "import")
   (asrt 51 "@f" "do_on" "2020-01-01" "import")
   ;; @g — committed + future do_on  -> "ready" (committed dominates the schedule)
   (asrt 60 "@g" "title" "G" "import")
   (asrt 61 "@g" "committed" "2026-01-01" "import")
   (asrt 62 "@g" "do_on" "2026-12-01" "import")])

(def idx (k/build-index (:claims (fold/fold asserts))))

(defn cls [te] (proj/condition-i idx te today before?))
(def ready-set (set (proj/ready idx today before?)))

(def checks
  [;; precedence
   ["(a) outcome+driver => terminal (terminal>active)"   (= (cls "@a") "terminal")]
   ["(b) committed+open-dep+driver => blocked (blocked>active)" (= (cls "@b") "blocked")]
   ["(c) committed+driver => active"                     (= (cls "@c") "active")]
   ["(d) committed only => ready"                        (= (cls "@d") "ready")]
   ["(e) uncommitted+future-do_on => dormant"            (= (cls "@e") "dormant")]
   ["(f) uncommitted+past-do_on => draft"                (= (cls "@f") "draft")]
   ["(g) committed+future-do_on => ready"                (= (cls "@g") "ready")]
   ;; dormancy predicate
   ["dormant? true for future do_on"                     (proj/dormant? idx "@e" today before?)]
   ["dormant? false for past do_on"                      (not (proj/dormant? idx "@f" today before?))]
   ;; ready excludes dormant, includes the past-do_on draft
   ["ready EXCLUDES uncommitted future-do_on (@e)"       (not (contains? ready-set "@e"))]
   ["ready INCLUDES uncommitted past-do_on (@f)"         (contains? ready-set "@f")]
   ["ready INCLUDES committed work thread (@d)"          (contains? ready-set "@d")]
   ;; classify buckets committed+future-do_on as "ready" (committed dominates the
   ;; schedule — both-true semantics, case (g) above), but the ready PROJECTION
   ;; (the work queue) still drops every dormant thread until its date. The two
   ;; legitimately differ here: condition is "ready", queue-membership is false.
   ["ready PROJECTION excludes dormant committed (@g)"   (not (contains? ready-set "@g"))]
   ["ready EXCLUDES terminal (@a)"                       (not (contains? ready-set "@a"))]
   ["ready EXCLUDES blocked (@b)"                        (not (contains? ready-set "@b"))]])

(let [fails (remove second checks)]
  (doseq [[nm ok] checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
  (if (empty? fails)
    (println "\nprojections:" (count checks) "/" (count checks) "PASS")
    (do (println "\nprojections:" (count fails) "FAILED") (System/exit 1))))
