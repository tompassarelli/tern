;; reap_test.clj — the reactor's liveness-reap verdict (tern.reap, split from
;; tern-reactor.clj so it is testable off in-memory facts). The bug this guards:
;; recordRun (sdk/src/spawn.ts) lands a lane's `outcome` on @run-<id>-<ts> (with an
;; `agent <id>` fact), NOT on @agent:<id> — so the old sweep, checking the lane's OWN
;; outcome, read a clean-finishing lane as silent and reaped it (false positive on
;; sdk-4890385a / sdk-76b1fa19). The fix joins through the agent fact; these cases pin
;; both halves: a finished lane (outcome on @run) is NOT reaped, a truly-silent lane
;; (lease lapsed >30min, no @run outcome, no agent_death) IS.
;;   bb reap_test.clj      (run from the repo root; no daemon, no classpath needed)
(load-file "cli/reap.clj")

;; Fixed "now" (epoch ms) so lease/spawned deltas are exact and clock-free.
(def now   1000000000000)
(def STALE tern.reap/LANE-STALE-MS)           ; 30min
(def lapsed-exp (- now (* 40 60 1000)))       ; lease expired 40min ago -> stale
(def fresh-exp  (+ now (* 20 60 1000)))       ; lease valid 20min out    -> live
(def recent-exp (- now (* 5  60 1000)))       ; lease expired  5min ago  -> too new
(def old-spawn  (- now (* 3 60 60 1000)))     ; spawned 3h ago  -> leaseless-dead
(def new-spawn  (- now (* 2 60 1000)))        ; spawned 2min ago -> leaseless too new

;; reap-lane? [now lane-outcome resolved? lease-exp spawned-ms]
(defn resolved? [h touts deaths] (tern.reap/lane-resolved? h touts deaths))
(defn reap? [& args] (apply tern.reap/reap-lane? args))

(def cases
  [;; --- the false-positive gate: finished lane (outcome on @run) NEVER reaped -----
   ["finished lane (outcome=ran on @run), lease lapsed => NOT reaped"
    (reap? now [] (resolved? "sdk-a" [["ran"]] []) lapsed-exp nil)                 false]
   ;; --- the true-positive: truly-silent lane IS reaped ---------------------------
   ["silent lane (lease lapsed >30min, no @run outcome, no death) => reaped"
    (reap? now [] (resolved? "sdk-b" [[] []] []) lapsed-exp nil)                   true]

   ;; --- liveness axis ------------------------------------------------------------
   ["live lease => NOT reaped"
    (reap? now [] false fresh-exp nil)                                            false]
   ["expired lease but <30min lapse => NOT reaped (too new)"
    (reap? now [] false recent-exp nil)                                           false]

   ;; --- leaseless-dead class (lease GC'd / never taken): judge by spawned_at ------
   ["no lease, spawned 3h ago, unresolved => reaped (vanished-lease dead)"
    (reap? now [] (resolved? "sdk-c" [] []) nil old-spawn)                         true]
   ["no lease, spawned 2min ago => NOT reaped (too new)"
    (reap? now [] false nil new-spawn)                                            false]
   ["no lease, spawned 3h ago, but resolved via @run => NOT reaped"
    (reap? now [] (resolved? "sdk-d" [["ran"]] []) nil old-spawn)                 false]
   ["no lease AND no spawned_at => NOT reaped (no staleness axis)"
    (reap? now [] false nil nil)                                                  false]

   ;; --- other terminal short-circuits --------------------------------------------
   ["lane already carries its OWN outcome => NOT reaped"
    (reap? now ["died-unreported"] false lapsed-exp nil)                          false]
   ["agent_death names the lane => resolved => NOT reaped"
    (reap? now [] (resolved? "sdk-e" [] ["sdk-e | SIGKILL | 2026-07-09"]) lapsed-exp nil) false]

   ;; --- lane-resolved? join precision --------------------------------------------
   ["resolved?: any tagged subject with a non-empty outcome => true"
    (resolved? "sdk-f" [[] ["ran"]] [])                                           true]
   ["resolved?: all tagged outcomes empty, no deaths => false"
    (resolved? "sdk-g" [[] []] [])                                                false]
   ["resolved?: death line prefix must be exact (sdk-01 not matched by sdk-011)"
    (resolved? "sdk-01" [] ["sdk-011 | boom | ts"])                               false]])

(def fails (filter (fn [[_ got want]] (not= got want)) cases))
(doseq [[nm got want] cases]
  (println (if (= got want) "  ok  " " FAIL ") nm "=> got" got))
(if (seq fails)
  (do (println "\nreap:" (count fails) "FAILED") (System/exit 1))
  (println "\nreap: all" (count cases) "passed"))
