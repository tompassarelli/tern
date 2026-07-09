;; reap.clj — PURE liveness-reap decisions, split from tern-reactor.clj's I/O so the
;; verdict is unit-testable off in-memory facts (../reap_test.clj) with no live daemon.
;; The reactor GATHERS facts through the coordinator, then calls these; the test feeds
;; the same shapes directly. No coordinator, no clock, no atoms here — inputs in, verdict
;; out. Loaded (not required) the same way tern-reactor.clj loads coord.clj.
(ns tern.reap
  (:require [clojure.string :as str]))

(def LANE-STALE-MS    (* 30 60 1000))      ; 30min silent + no outcome -> dead lane
(def CONCERN-STALE-MS (* 24 60 60 1000))   ; 24h owner-lapsed -> abandoned-stale concern

(defn lane-resolved?
  "RESOLVED (never reap) iff a terminal fact exists for lane <h> — even though it may
   live on a DIFFERENT subject than @agent:<h>. recordRun (sdk/src/spawn.ts) lands the
   outcome on @run-<h>-<ts> carrying `agent`=<h>, NOT on the lane, so a clean-finishing
   lane has an EMPTY @agent:<h> outcome — its missing lane outcome is NOT proof of death.
   Join through agent=<h>: `tagged-outcomes` = the outcome-seq of EACH subject carrying
   agent=<h> (runs + session); `deaths` = @swarm agent_death lines (`<id> | reason | ts`)."
  [h tagged-outcomes deaths]
  (boolean (or (some seq tagged-outcomes)
               (some #(str/starts-with? (str %) (str h " | ")) deaths))))

(defn lane-lapse-ms
  "Ms the lane has been SILENT, or nil if live / too-new-to-judge. Expired lease -> the
   EXACT lapse; live (unexpired) lease -> nil (alive); NO lease at all -> spawned_at age
   (leases are GC'd, so their absence must not make a dead lane invisible — cross-ref the
   @agent identity's spawned_at instead). lease-exp / spawned-ms are epoch-ms or nil."
  [now lease-exp spawned-ms]
  (cond
    (and lease-exp (> lease-exp now)) nil
    lease-exp                         (- now lease-exp)
    spawned-ms                        (- now spawned-ms)
    :else                             nil))

(defn reap-lane?
  "Terminal verdict. Reap iff the lane's OWN outcome is empty (not already terminal), it
   is NOT resolved elsewhere (@run outcome / agent_death), and its silence lapse has
   reached LANE-STALE-MS."
  [now lane-outcome resolved? lease-exp spawned-ms]
  (and (empty? lane-outcome)
       (not resolved?)
       (let [lp (lane-lapse-ms now lease-exp spawned-ms)]
         (boolean (and lp (>= lp LANE-STALE-MS))))))
