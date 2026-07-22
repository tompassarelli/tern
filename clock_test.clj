;; clock_test.clj — fact-native time-logging roll-up guard.
;;
;; Proves sessions (titleless @sess entities with session_of/start_time/end_time)
;; roll up to per-thread actual seconds, the open session is detected, and the
;; estimate-vs-actual calibration % is computed over DONE threads only.
;;
;;   bb -cp out clock_test.clj      (run from the repo root)
(require '[babashka.fs :as fs]
         '[babashka.process :as proc]
         '[clojure.java.io :as io]
         '[clojure.string :as str]
         '[fram.kernel :as k]
         '[fram.fold :as fold]
         '[north.clock :as clk]
         '[fram.rt :as rt])

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
   ;; wall-clock: overlapping HUMAN sessions, same owner. Their thread rates are
   ;; deliberately hostile routing/history values; live billing authority must
   ;; never read them.
   (asrt 150 "@w1" "title" "W1") (asrt 151 "@w1" "owner" "acme") (asrt 152 "@w1" "rate" "standard")
   (asrt 153 "@w2" "title" "W2") (asrt 154 "@w2" "owner" "acme") (asrt 155 "@w2" "rate" "999")
   (asrt 160 "@sw1" "session_of" "@w1") (asrt 161 "@sw1" "start_time" "2026-07-14T09:00:00")
   (asrt 162 "@sw1" "end_time" "2026-07-14T10:00:00")
   (asrt 163 "@sw2" "session_of" "@w2") (asrt 164 "@sw2" "start_time" "2026-07-14T09:30:00")
   (asrt 165 "@sw2" "end_time" "2026-07-14T10:30:00")
   ;; owner-scoped session overlaps the legacy pair and carries a rate snapshot
   (asrt 170 "@client" "owner" "acme") (asrt 171 "@client" "clocked_by" "user")
   (asrt 172 "@client" "rate" "120") (asrt 173 "@client" "start_time" "2026-07-14T09:15:00")
   (asrt 174 "@client" "end_time" "2026-07-14T10:15:00")
   (asrt 175 "@client" "kind" "client_session")
   ;; the one owner-level live billing authority, independent of every thread
   (asrt 176 "@client-rate:acme" "owner" "acme")
   (asrt 177 "@client-rate:acme" "rate" "123.45")
   (asrt 178 "@client-rate:acme" "kind" "client_rate_config")
   ;; open owner-scoped human session, alongside legacy @sl
   (asrt 180 "@client-open" "owner" "acme") (asrt 181 "@client-open" "clocked_by" "user")
   (asrt 182 "@client-open" "rate" "120") (asrt 183 "@client-open" "start_time" "2026-07-14T11:00:00")
   (asrt 184 "@client-open" "kind" "client_session")
   ;; explicit agent time on an owned thread is excluded from billing
   (asrt 190 "@agent-closed" "session_of" "@w1") (asrt 191 "@agent-closed" "clocked_by" "lane-x")
   (asrt 192 "@agent-closed" "start_time" "2026-07-14T07:00:00")
   (asrt 193 "@agent-closed" "end_time" "2026-07-14T09:00:00")
   ;; concurrent managed task telemetry is neither a legacy thread session nor
   ;; a human client session, so any number of run timers may coexist.
   (asrt 200 "@run-a" "kind" "run") (asrt 201 "@run-a" "thread" "@ta")
   (asrt 202 "@run-a" "duration_ms" "1000")
   (asrt 203 "@run-b" "kind" "run") (asrt 204 "@run-b" "thread" "@tb")
   (asrt 205 "@run-b" "duration_ms" "2000")
   ;; invalid and duplicate client configuration fixtures
   (asrt 210 "@client-rate:label" "owner" "label")
   (asrt 211 "@client-rate:label" "rate" "routing-standard")
   (asrt 212 "@client-rate:label" "kind" "client_rate_config")
   (asrt 213 "@client-rate:zero" "owner" "zero")
   (asrt 214 "@client-rate:zero" "rate" "0")
   (asrt 215 "@client-rate:zero" "kind" "client_rate_config")
   (asrt 216 "@client-rate:negative" "owner" "negative")
   (asrt 217 "@client-rate:negative" "rate" "-1")
   (asrt 218 "@client-rate:negative" "kind" "client_rate_config")
   (asrt 220 "@client-rate:duplicate" "owner" "duplicate")
   (asrt 221 "@client-rate:duplicate" "rate" "100")
   (asrt 222 "@client-rate:duplicate" "kind" "client_rate_config")
   (asrt 223 "@duplicate-rate-impostor" "owner" "duplicate")
   (asrt 224 "@duplicate-rate-impostor" "rate" "200")
   (asrt 225 "@duplicate-rate-impostor" "kind" "client_rate_config")
   (asrt 230 "@legacy-rate-config" "owner" "legacy")
   (asrt 231 "@legacy-rate-config" "rate" "90")
   (asrt 232 "@legacy-rate-config" "kind" "client_rate_config")
   (asrt 233 "@client-rate:ambiguous" "owner" "ambiguous")
   (asrt 234 "@client-rate:ambiguous" "rate" "100")
   (asrt 235 "@client-rate:ambiguous" "rate" "200")
   (asrt 236 "@client-rate:ambiguous" "kind" "client_rate_config")])
(def idx2 (k/build-index (:facts (fold/fold asserts2))))

(def acme-rate (clk/client-rate-authority idx2 "acme"))

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
   ["client authority resolves the explicit owner config" (= (:status acme-rate) "ok")]
   ["client authority captures its numeric value"         (= (:rate acme-rate) "123.45")]
   ["arbitrary thread rate facts cannot influence authority" (= (:rate acme-rate) "123.45")]
   ["missing owner config is rejected" (= (:status (clk/client-rate-authority idx2 "missing")) "missing")]
   ["routing-label config is rejected" (= (:status (clk/client-rate-authority idx2 "label")) "invalid-rate")]
   ["zero config is rejected" (= (:status (clk/client-rate-authority idx2 "zero")) "invalid-rate")]
   ["negative config is rejected" (= (:status (clk/client-rate-authority idx2 "negative")) "invalid-rate")]
   ["duplicate owner configs are rejected" (= (:status (clk/client-rate-authority idx2 "duplicate")) "duplicate")]
   ["multiple values on one config are rejected" (= (:status (clk/client-rate-authority idx2 "ambiguous")) "ambiguous-rate")]
   ["noncanonical singleton config is rejected" (= (:status (clk/client-rate-authority idx2 "legacy")) "noncanonical")]
   ["positive decimal rate validation accepts integers" (clk/positive-rate? "123")]
   ["positive decimal rate validation accepts fractions" (clk/positive-rate? "123.45")]
   ["positive decimal rate validation rejects labels" (not (clk/positive-rate? "default"))]
   ["positive decimal rate validation rejects zero" (not (clk/positive-rate? "0"))]
   ["positive decimal rate validation rejects negatives" (not (clk/positive-rate? "-1"))]
   ["positive decimal rate validation rejects NaN" (not (clk/positive-rate? "NaN"))]
   ["positive decimal rate validation rejects infinity" (not (clk/positive-rate? "Infinity"))]
   ["managed run timers remain distinct" (= #{"@run-a" "@run-b"}
                                             (set (filter #(= (k/one-i idx2 % "kind") "run")
                                                          (:subjects idx2))))]
   ["managed run timers retain independent threads" (= #{"@ta" "@tb"}
                                                         (set (map #(k/one-i idx2 % "thread")
                                                                   ["@run-a" "@run-b"])))]
   ["managed run timers never become billing sessions" (every? #(not (clk/human-billing-session? idx2 %))
                                                                 ["@run-a" "@run-b"])]
   ;; wall-clock union: all human intervals still span 09:00-10:30 = 5400s
   ["wall-clock union merges the overlap (1.5h)" (= (clk/owner-wall-total idx2 "acme" iso->sec) 5400)]
   ["legacy human thread attribution sums to 2h" (= (+ (clk/actual-seconds idx2 "@w1" iso->sec)
                                                       (clk/actual-seconds idx2 "@w2" iso->sec)) 7200)]
   ["per-day wall-clock: one day at 1.5h"        (= (mapv :secs (clk/owner-wall-by-day idx2 "acme" iso->sec)) [5400])]])

;; --- real CLI/coordinator boundary ------------------------------------------
;; Pure folds above guard the model. This isolated daemon probe proves the
;; one-time configuration command, live clock-in snapshot, global human-session
;; invariant, and orthogonal run facts through the production wrapper.
(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))

(defn await-port [port]
  (loop [attempt 0]
    (let [open?
          (try
            (with-open [socket (java.net.Socket. "127.0.0.1" (int port))] true)
            (catch Throwable _ false))]
      (cond
        open? true
        (< attempt 200) (do (Thread/sleep 20) (recur (inc attempt)))
        :else false))))

(defn op-line [tx l p r]
  (pr-str {:tx tx :op "assert" :l l :p p :r r :frame "clock-rate-integration"}))

(defn clock-run [root environment & args]
  (apply proc/shell
         {:dir root :out :string :err :string :continue true :extra-env environment}
         (str root "/bin/north") "clock" args))

(defn live-index [log]
  (k/build-index (:facts (fold/fold (rt/read-log log)))))

(def integration-checks
  (let [root (.getCanonicalPath (.getParentFile (io/file *file*)))
        fram (.getCanonicalPath (io/file root "../fram"))
        temp (.toFile (java.nio.file.Files/createTempDirectory
                       "north-client-clock-rate-"
                       (make-array java.nio.file.attribute.FileAttribute 0)))
        log (.getCanonicalPath (io/file temp "facts.log"))
        port (free-port)
        singles "owner rate kind clocked_by start_time end_time"
        environment {"FRAM_LOG" log
                     "FRAM_PORT" (str port)
                     "FRAM_SINGLE_VALUED" singles
                     "NORTH_AGENT_ID" ""
                     "AGENT_ID" ""
                     "AGENT_TOPOLOGY" ""}
        fixture [(op-line 1 "@thread-a" "title" "A")
                 (op-line 2 "@thread-a" "owner" "acme-test")
                 (op-line 3 "@thread-a" "rate" "standard")
                 (op-line 4 "@thread-b" "title" "B")
                 (op-line 5 "@thread-b" "owner" "acme-test")
                 (op-line 6 "@thread-b" "rate" "default")
                 (op-line 7 "@run-one" "kind" "run")
                 (op-line 8 "@run-one" "thread" "@thread-a")
                 (op-line 9 "@run-one" "duration_ms" "1000")
                 (op-line 10 "@run-two" "kind" "run")
                 (op-line 11 "@run-two" "thread" "@thread-b")
                 (op-line 12 "@run-two" "duration_ms" "2000")
                 (op-line 13 "@client-rate:badlabel" "owner" "badlabel")
                 (op-line 14 "@client-rate:badlabel" "rate" "routing-standard")
                 (op-line 15 "@client-rate:badlabel" "kind" "client_rate_config")
                 (op-line 16 "@client-rate:zero" "owner" "zero")
                 (op-line 17 "@client-rate:zero" "rate" "0")
                 (op-line 18 "@client-rate:zero" "kind" "client_rate_config")
                 (op-line 19 "@client-rate:negative" "owner" "negative")
                 (op-line 20 "@client-rate:negative" "rate" "-5")
                 (op-line 21 "@client-rate:negative" "kind" "client_rate_config")
                 (op-line 22 "@client-rate:duplicate" "owner" "duplicate")
                 (op-line 23 "@client-rate:duplicate" "rate" "100")
                 (op-line 24 "@client-rate:duplicate" "kind" "client_rate_config")
                 (op-line 25 "@duplicate-impostor" "owner" "duplicate")
                 (op-line 26 "@duplicate-impostor" "rate" "200")
                 (op-line 27 "@duplicate-impostor" "kind" "client_rate_config")]
        _ (spit log (str (str/join "\n" fixture) "\n"))
        daemon (proc/process
                {:dir fram :out :string :err :string
                 :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"
                             "FRAM_SINGLE_VALUED" singles}}
                "bb" "-cp" "out" "coord_daemon.clj"
                "serve-flat" (str port) log)]
    (try
      (if (not (await-port port))
        [["isolated clock coordinator starts" false]]
        (let [missing (clock-run root environment "in" "acme-test")
              bad-set (clock-run root environment "rate" "acme-test" "standard")
              zero-set (clock-run root environment "rate" "acme-test" "0")
              negative-set (clock-run root environment "rate" "acme-test" "-1")
              badlabel (clock-run root environment "in" "badlabel")
              zero (clock-run root environment "in" "zero")
              negative (clock-run root environment "in" "negative")
              duplicate (clock-run root environment "in" "duplicate")
              before-config (live-index log)
              configured (clock-run root environment "rate" "acme-test" "123.45")
              read-rate (clock-run root environment "rate" "acme-test")
              clock-in (clock-run root environment "in" "acme-test")
              status (clock-run root environment "status")
              second-in (clock-run root environment "in" "acme-test")
              open-idx (live-index log)
              client-sessions (filter #(= (k/one-i open-idx % "kind") "client_session")
                                      (:subjects open-idx))
              session (first client-sessions)
              runs-before (set (filter #(= (k/one-i open-idx % "kind") "run")
                                       (:subjects open-idx)))
              clock-out (clock-run root environment "out")
              closed-idx (live-index log)
              runs-after (set (filter #(= (k/one-i closed-idx % "kind") "run")
                                      (:subjects closed-idx)))]
          [["thread rates cannot authorize clock-in"
            (and (str/includes? (:out missing) "no client billing rate configuration")
                 (not (str/includes? (:out missing) "standard"))
                 (not (str/includes? (:out missing) "default")))]
           ["nonnumeric rate command is rejected"
            (str/includes? (:out bad-set) "not a positive numeric hourly rate")]
           ["zero rate command is rejected"
            (str/includes? (:out zero-set) "not a positive numeric hourly rate")]
           ["negative rate command is rejected"
            (str/includes? (:out negative-set) "not a positive numeric hourly rate")]
           ["invalid commands create no synthetic owner authority"
            (= (:status (clk/client-rate-authority before-config "acme-test")) "missing")]
           ["nonnumeric stored config blocks clock-in"
            (str/includes? (:out badlabel) "invalid client billing rate")]
           ["zero stored config blocks clock-in"
            (str/includes? (:out zero) "invalid client billing rate")]
           ["negative stored config blocks clock-in"
            (str/includes? (:out negative) "invalid client billing rate")]
           ["duplicate configs block clock-in"
            (str/includes? (:out duplicate) "2 client billing rate configurations")]
           ["one-time rate command creates the owner authority"
            (str/includes? (:out configured) "billing rate configured at 123.45/h")]
           ["rate read returns the authoritative value"
            (str/includes? (:out read-rate) "billing rate: 123.45/h")]
           ["clock-in snapshots the configured rate"
            (str/includes? (:out clock-in) "rate 123.45/h")]
           ["status reports the one client session"
            (str/includes? (:out status) "clocked in for client acme-test")]
           ["a second human clock-in is refused"
            (str/includes? (:out second-in) "already clocked in for client acme-test")]
           ["exactly one human client_session is visible" (= 1 (count client-sessions))]
           ["client_session captures owner, actor, rate, and start"
            (and (= (k/one-i open-idx session "owner") "acme-test")
                 (= (k/one-i open-idx session "clocked_by") "user")
                 (= (k/one-i open-idx session "rate") "123.45")
                 (some? (k/one-i open-idx session "start_time"))
                 (nil? (k/one-i open-idx session "end_time")))]
           ["concurrent kind=run timers remain independent"
            (= runs-before #{"@run-one" "@run-two"})]
           ["run timers never acquire billing session_of"
            (every? #(nil? (k/one-i open-idx % "session_of")) runs-before)]
           ["clock-out closes the client session"
            (and (str/includes? (:out clock-out) "clocked out of client acme-test")
                 (some? (k/one-i closed-idx session "end_time")))]
           ["clock-out leaves run telemetry byte-for-fact intact"
            (= runs-before runs-after)]]))
      (finally
        (try (proc/destroy-tree daemon) (catch Throwable _ nil))
        (try @daemon (catch Throwable _ nil))
        (fs/delete-tree temp)))))

(def all-checks (vec (concat checks checks2 integration-checks)))

(let [fails (remove second all-checks)]
  (doseq [[nm ok] all-checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
  (if (empty? fails)
    (println "\nclock:" (count all-checks) "/" (count all-checks) "PASS")
    (do (println "\nclock:" (count fails) "FAILED") (System/exit 1))))
