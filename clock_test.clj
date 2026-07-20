;; clock_test.clj — fact-native time-logging roll-up guard.
;;
;; Proves sessions (titleless @sess entities with session_of/start_time/end_time)
;; roll up to per-thread actual seconds, the open session is detected, and the
;; estimate-vs-actual calibration % is computed over DONE threads only.
;;
;;   bb -cp out clock_test.clj      (run from the repo root)
(require '[fram.kernel :as k]
         '[fram.fold :as fold]
         '[north.clock :as clk]
         '[fram.rt])

(defn asrt [tx l p r] (fold/->FactOp tx "assert" l p r "agent"))

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

(def idx (k/build-index (:facts (fold/fold asserts))))
(defn iso->sec [s] (fram.rt/iso-to-seconds s))
(defn str->int [s] (fram.rt/parse-int s))

(def run (clk/running-session-for idx "user"))   ; @s3 has no clocked_by -> legacy user
(def t1-act (clk/actual-seconds idx "@t1" iso->sec))
(def t2-act (clk/actual-seconds idx "@t2" iso->sec))
(def rs (clk/rows idx iso->sec str->int))
(def row-tes (set (map :te rs)))
(def cal (clk/calibration rs))
(def syncable (set (clk/syncable-sessions idx)))
(def today-rows (set (map :te (clk/logged-rows idx ["2026-06-16"] iso->sec))))
(def other-day  (set (map :te (clk/logged-rows idx ["2020-01-01"] iso->sec))))

(def checks
  [["running-session-for(user) finds open session" (= run "@s3")]
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

;; --- orthogonal human billing + managed run telemetry ------------------------
;; Human billing is one owner-scoped session. Historical user sessions remain
;; compatible, while explicit managed actors stay available to audit/orphan
;; tooling but never enter billed actuals or wall-clock totals.
(def asserts2
  [;; two agents, concurrent OPEN sessions on different threads — neither blocks
   (asrt 100 "@ta" "title" "TA")
   (asrt 101 "@tb" "title" "TB")
   (asrt 110 "@sa" "session_of" "@ta") (asrt 111 "@sa" "start_time" "2026-07-14T09:00:00")
   (asrt 112 "@sa" "clocked_by" "a1")
   (asrt 120 "@sb" "session_of" "@tb") (asrt 121 "@sb" "start_time" "2026-07-14T09:05:00")
   (asrt 122 "@sb" "clocked_by" "a2")
   ;; a legacy OPEN session (no clocked_by) reads as agent "user"
   (asrt 130 "@tl" "title" "TL")
   (asrt 131 "@sl" "session_of" "@tl") (asrt 132 "@sl" "start_time" "2026-07-14T09:10:00")
   ;; a legacy managed-agent orphan: retained for audit, never billed
   (asrt 140 "@to" "title" "TO")
   (asrt 141 "@so" "session_of" "@to") (asrt 142 "@so" "start_time" "2026-07-14T08:00:00")
   (asrt 143 "@so" "end_time" "2026-07-14T08:30:00") (asrt 144 "@so" "clocked_by" "a3")
   (asrt 145 "@so" "clock_orphaned" "true")
   ;; wall-clock: overlapping HUMAN sessions, same owner
   (asrt 150 "@w1" "title" "W1") (asrt 151 "@w1" "owner" "acme") (asrt 152 "@w1" "rate" "120")
   (asrt 153 "@w2" "title" "W2") (asrt 154 "@w2" "owner" "acme") (asrt 155 "@w2" "rate" "120")
   (asrt 160 "@sw1" "session_of" "@w1") (asrt 161 "@sw1" "start_time" "2026-07-14T09:00:00")
   (asrt 162 "@sw1" "end_time" "2026-07-14T10:00:00")
   (asrt 163 "@sw2" "session_of" "@w2") (asrt 164 "@sw2" "start_time" "2026-07-14T09:30:00")
   (asrt 165 "@sw2" "end_time" "2026-07-14T10:30:00")
   ;; owner-scoped session overlaps the legacy pair and carries a rate snapshot
   (asrt 170 "@client" "owner" "acme") (asrt 171 "@client" "clocked_by" "user")
   (asrt 172 "@client" "rate" "120") (asrt 173 "@client" "start_time" "2026-07-14T09:15:00")
   (asrt 174 "@client" "end_time" "2026-07-14T10:15:00")
   (asrt 175 "@client" "kind" "client_session")
   ;; open owner-scoped human session, alongside legacy @sl
   (asrt 180 "@client-open" "owner" "acme") (asrt 181 "@client-open" "clocked_by" "user")
   (asrt 182 "@client-open" "rate" "120") (asrt 183 "@client-open" "start_time" "2026-07-14T11:00:00")
   (asrt 184 "@client-open" "kind" "client_session")
   ;; explicit agent time on an owned thread is excluded from billing
   (asrt 190 "@agent-closed" "session_of" "@w1") (asrt 191 "@agent-closed" "clocked_by" "lane-x")
   (asrt 192 "@agent-closed" "start_time" "2026-07-14T07:00:00")
   (asrt 193 "@agent-closed" "end_time" "2026-07-14T09:00:00")
   ;; missing and ambiguous owner-rate fixtures
   (asrt 200 "@bad1" "title" "Bad1") (asrt 201 "@bad1" "owner" "amb") (asrt 202 "@bad1" "rate" "100")
   (asrt 203 "@bad2" "title" "Bad2") (asrt 204 "@bad2" "owner" "amb") (asrt 205 "@bad2" "rate" "200")])
(def idx2 (k/build-index (:facts (fold/fold asserts2))))

(def checks2
  [;; (a) two agents open concurrently — each sees ONLY its own; a fresh agent is
   ;;     unblocked (running-session-for = nil => clock start is allowed).
   ["a1 running session is its own"              (= (clk/running-session-for idx2 "a1") "@sa")]
   ["a2 running session is its own"              (= (clk/running-session-for idx2 "a2") "@sb")]
   ["fresh agent never blocked (nil session)"    (nil? (clk/running-session-for idx2 "nobody"))]
   ;; (b) a1 stop closes ONLY a1's — the selector distinguishes the two agents
   ["per-agent selector separates a1 vs a2"      (not= (clk/running-session-for idx2 "a1")
                                                       (clk/running-session-for idx2 "a2"))]
   ;; (c) legacy session (no clocked_by) reads as user; explicit clocked_by wins
   ["legacy session clocked-by = user"           (= (clk/clocked-by idx2 "@sl") "user")]
   ["user selector finds the legacy session"     (= (clk/running-session-for idx2 "user") "@sl")]
   ["explicit clocked_by is honored"             (= (clk/clocked-by idx2 "@sa") "a1")]
   ;; open-sessions spans all agents; orphan-closed is excluded
   ["open-sessions = the 3 open ones"            (= (set (clk/open-sessions idx2)) #{"@sa" "@sb" "@sl"})]
   ["orphan-closed session is not open"          (not (contains? (set (clk/open-sessions idx2)) "@so"))]
   ;; managed session remains readable but cannot leak into human billing
   ["managed orphan is excluded from billed actual" (= (clk/actual-seconds idx2 "@to" iso->sec) 0)]
   ["clock_orphaned flag is readable"            (= (k/one-i idx2 "@so" "clock_orphaned") "true")]
   ["explicit managed time is excluded from owned-thread actual"
    (= (clk/actual-seconds idx2 "@w1" iso->sec) 3600)]
   ["client session has direct owner"             (= (clk/session-owner idx2 "@client") "acme")]
   ["human open set includes legacy and owner session"
    (= (set (clk/open-human-sessions idx2)) #{"@sl" "@client-open"})]
   ["multiple human opens are surfaced as invalid" (nil? (clk/running-human-session idx2))]
   ["owner has one unambiguous live rate"          (= (clk/unique-owner-rate idx2 "acme") "120")]
   ["missing owner rate refuses resolution"        (nil? (clk/unique-owner-rate idx2 "missing"))]
   ["ambiguous owner rates refuse resolution"      (nil? (clk/unique-owner-rate idx2 "amb"))]
   ;; wall-clock union: all human intervals still span 09:00-10:30 = 5400s
   ["wall-clock union merges the overlap (1.5h)" (= (clk/owner-wall-total idx2 "acme" iso->sec) 5400)]
   ["legacy human thread attribution sums to 2h" (= (+ (clk/actual-seconds idx2 "@w1" iso->sec)
                                                       (clk/actual-seconds idx2 "@w2" iso->sec)) 7200)]
   ["per-day wall-clock: one day at 1.5h"        (= (mapv :secs (clk/owner-wall-by-day idx2 "acme" iso->sec)) [5400])]])

(def all-checks (into checks checks2))

(let [fails (remove second all-checks)]
  (doseq [[nm ok] all-checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
  (if (empty? fails)
    (println "\nclock:" (count all-checks) "/" (count all-checks) "PASS")
    (do (println "\nclock:" (count fails) "FAILED") (System/exit 1))))
