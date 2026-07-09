;; staleness_test.clj — belief-revision layer (D8) rule guard.
;;
;; Proves each needs-review rule fires on the real signal and stays silent on the
;; noise — especially that estimate-staleness ignores bulk-import tx-ordering
;; (serialization, not causality) yet fires on a genuine later edit.
;;
;;   bb -cp out staleness_test.clj      (run from the repo root)
(require '[fram.kernel :as k]
         '[fram.fold :as fold]
         '[north.staleness :as stale])

(defn asrt [tx l p r frame] (fold/->FactOp tx "assert" l p r frame))

(def asserts
  [;; @t1 — past valid_until, committed, non-terminal  -> time-stale
   (asrt 1 "@t1" "title" "T1" "import")
   (asrt 2 "@t1" "body" "b" "import")
   (asrt 3 "@t1" "estimate_hours" "10" "import")
   (asrt 4 "@t1" "valid_until" "2020-01-01" "import")
   (asrt 5 "@t1" "committed" "2026-01-01" "import")
   ;; @t2 — estimate, then a LATER agent-frame depends_on  -> estimate-stale (positive)
   (asrt 20 "@t2" "title" "T2" "import")
   (asrt 21 "@t2" "body" "b" "import")
   (asrt 22 "@t2" "estimate_hours" "5" "import")
   (asrt 23 "@t2" "committed" "2026-01-01" "import")
   (asrt 100 "@t2" "depends_on" "@t1" "agent")
   ;; @t3 — estimate, then a LATER *import* body re-assert -> NOT estimate-stale (noise guard)
   (asrt 30 "@t3" "title" "T3" "import")
   (asrt 31 "@t3" "body" "b0" "import")
   (asrt 32 "@t3" "estimate_hours" "5" "import")
   (asrt 33 "@t3" "committed" "2026-01-01" "import")
   (asrt 110 "@t3" "body" "b1" "import")
   ;; @t5 — abandoned (terminal); a past valid_until here must be IGNORED
   (asrt 50 "@t5" "title" "T5" "import")
   (asrt 51 "@t5" "abandoned" "dropped" "import")
   (asrt 52 "@t5" "valid_until" "2020-01-01" "import")
   ;; @t4 — clarifies @t5 (abandoned)  -> edge-stale
   (asrt 40 "@t4" "title" "T4" "import")
   (asrt 41 "@t4" "body" "b" "import")
   (asrt 42 "@t4" "clarifies" "@t5" "import")
   (asrt 43 "@t4" "committed" "2026-01-01" "import")
   ;; @t6 — relates_to @t5 (abandoned) BUT terminal subject -> NOT edge-stale
   (asrt 60 "@t6" "title" "T6" "import")
   (asrt 61 "@t6" "relates_to" "@t5" "import")
   (asrt 62 "@t6" "outcome" "done" "import")
   ;; @t7 — depends_on @t5 (abandoned) -> NOT edge-stale (depends_on excluded)
   (asrt 70 "@t7" "title" "T7" "import")
   (asrt 71 "@t7" "depends_on" "@t5" "import")
   ;; @t8 — uncommitted + depends_on  -> promotable
   (asrt 80 "@t8" "title" "T8" "import")
   (asrt 81 "@t8" "body" "b" "import")
   (asrt 82 "@t8" "depends_on" "@t1" "import")
   ;; @t9 — uncommitted bare draft  -> NOT promotable
   (asrt 90 "@t9" "title" "T9" "import")
   (asrt 91 "@t9" "body" "b" "import")
   ;; @t10 — committed + estimate  -> NOT promotable
   (asrt 95 "@t10" "title" "T10" "import")
   (asrt 96 "@t10" "estimate_hours" "3" "import")
   (asrt 97 "@t10" "committed" "2026-01-01" "import")
   ;; @t11 — superseded_by @t12 (terminal via superseded_by, the-model §7) +
   ;; a past valid_until that must be IGNORED (terminal-i? true => no time-stale).
   (asrt 120 "@t11" "title" "T11" "import")
   (asrt 121 "@t11" "superseded_by" "@t12" "import")
   (asrt 122 "@t11" "valid_until" "2020-01-01" "import")
   (asrt 123 "@t12" "title" "T12" "import")])

(def idx (k/build-index (:facts (fold/fold asserts))))
(def latest (fold/fold-latest asserts))
(def today "2026-06-16")
(defn before? [a b] (neg? (compare a b)))

(def time-tes (set (map :te (stale/time-stale idx today before?))))
(def edge-tes (set (map :te (stale/edge-stale idx))))
(def est-tes  (set (map :te (stale/estimate-stale idx latest))))
(def promo    (set (stale/promotable idx)))

(def checks
  [["time-stale flags past valid_until"          (contains? time-tes "@t1")]
   ["time-stale skips terminal thread"           (not (contains? time-tes "@t5"))]
   ["time-stale skips superseded_by terminal"    (not (contains? time-tes "@t11"))]
   ["edge-stale flags clarifies->abandoned"      (contains? edge-tes "@t4")]
   ["edge-stale excludes depends_on->abandoned"  (not (contains? edge-tes "@t7"))]
   ["edge-stale skips terminal subject"          (not (contains? edge-tes "@t6"))]
   ["estimate-stale fires on later agent edit"   (contains? est-tes "@t2")]
   ["estimate-stale ignores import-order body"   (not (contains? est-tes "@t3"))]
   ["promotable flags uncommitted+structure"     (contains? promo "@t8")]
   ["promotable skips bare draft"                (not (contains? promo "@t9"))]
   ["promotable skips committed"                 (not (contains? promo "@t10"))]])

(let [fails (remove second checks)]
  (doseq [[nm ok] checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
  (if (empty? fails)
    (println "\nstaleness:" (count checks) "/" (count checks) "PASS")
    (do (println "\nstaleness:" (count fails) "FAILED") (System/exit 1))))
