;; clock_test.clj — claim-native time-logging roll-up guard.
;;
;; Proves sessions (titleless @sess entities with session_of/start_time/end_time)
;; roll up to per-thread actual seconds, the open session is detected, and the
;; estimate-vs-actual calibration % is computed over DONE threads only.
;;
;;   bb -cp out clock_test.clj      (run from the repo root)
(require '[fram.kernel :as k]
         '[fram.fold :as fold]
         '[tern.clock :as clk]
         '[fram.rt])

(defn asrt [tx l p r] (fold/->Assertion tx "assert" l p r "agent"))

;; iso datetimes one hour apart are easy to reason about: 3600s each.
(def asserts
  [;; @t1 — done, estimate 2h, two closed sessions = 1h + 2h = 3h actual (150%)
   (asrt 1 "@t1" "title" "T1")
   (asrt 2 "@t1" "estimate_hours" "2")
   (asrt 3 "@t1" "outcome" "shipped")
   (asrt 4 "@s1" "session_of" "@t1")
   (asrt 5 "@s1" "start_time" "2026-06-16T09:00:00")
   (asrt 6 "@s1" "end_time"   "2026-06-16T10:00:00")
   (asrt 7 "@s2" "session_of" "@t1")
   (asrt 8 "@s2" "start_time" "2026-06-16T13:00:00")
   (asrt 9 "@s2" "end_time"   "2026-06-16T15:00:00")
   ;; @t2 — open (running) session, no end_time -> excluded from actual + is running
   (asrt 20 "@t2" "title" "T2")
   (asrt 21 "@t2" "estimate_hours" "5")
   (asrt 22 "@s3" "session_of" "@t2")
   (asrt 23 "@s3" "start_time" "2026-06-16T16:00:00")
   ;; @t3 — NOT done (no outcome), estimate + 1h actual -> excluded from calibration
   (asrt 30 "@t3" "title" "T3")
   (asrt 31 "@t3" "estimate_hours" "1")
   (asrt 32 "@s4" "session_of" "@t3")
   (asrt 33 "@s4" "start_time" "2026-06-16T08:00:00")
   (asrt 34 "@s4" "end_time"   "2026-06-16T09:00:00")
   ;; @t4 — estimate only, no sessions -> in rows, 0 actual
   (asrt 40 "@t4" "title" "T4")
   (asrt 41 "@t4" "estimate_hours" "3")
   ;; @s5 — a CLOSED but already-synced session (has clockify_id) -> not syncable
   (asrt 50 "@s5" "session_of" "@t3")
   (asrt 51 "@s5" "start_time" "2026-06-16T20:00:00")
   (asrt 52 "@s5" "end_time"   "2026-06-16T20:30:00")
   (asrt 53 "@s5" "clockify_id" "cf-abc")])

(def idx (k/build-index (:claims (fold/fold asserts))))
(defn iso->sec [s] (fram.rt/iso-to-seconds s))
(defn str->int [s] (fram.rt/parse-int s))

(def run (clk/running-session idx))
(def t1-act (clk/actual-seconds idx "@t1" iso->sec))
(def t2-act (clk/actual-seconds idx "@t2" iso->sec))
(def rs (clk/rows idx iso->sec str->int))
(def row-tes (set (map :te rs)))
(def cal (clk/calibration rs))
(def syncable (set (clk/syncable-sessions idx)))
(def today-rows (set (map :te (clk/logged-rows idx ["2026-06-16"] iso->sec))))
(def other-day  (set (map :te (clk/logged-rows idx ["2020-01-01"] iso->sec))))

(def checks
  [["running-session finds the open session"     (= run "@s3")]
   ["actual sums two closed sessions (3h)"        (= t1-act 10800)]
   ["actual excludes the open session (0)"        (= t2-act 0)]
   ["rows include estimate-only thread"           (contains? row-tes "@t4")]
   ["rows are titleless-session-free"             (not (contains? row-tes "@s1"))]
   ["calibration sample = only done w/ both"      (= (:sample cal) 1)]
   ["calibration % = actual/estimate (150)"       (= (:pct cal) 150)]
   ["syncable: closed + unsynced sessions"        (= syncable #{"@s1" "@s2" "@s4"})]
   ["syncable excludes open session"              (not (contains? syncable "@s3"))]
   ["syncable excludes already-synced session"    (not (contains? syncable "@s5"))]
   ["windowed totals match the date"              (contains? today-rows "@t1")]
   ["windowed totals exclude other days"          (empty? other-day)]])

(let [fails (remove second checks)]
  (doseq [[nm ok] checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
  (if (empty? fails)
    (println "\nclock:" (count checks) "/" (count checks) "PASS")
    (do (println "\nclock:" (count fails) "FAILED") (System/exit 1))))
