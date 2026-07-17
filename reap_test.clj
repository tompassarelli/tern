;; reap_test.clj — the reactor's liveness-reap verdict (north.reap, split from
;; north-reactor.clj so it is testable off in-memory facts). A terminal is usable
;; only after its publication marker: terminal_manifest_sha256 for a modern lane
;; and kind=run for a run. These cases pin both markers, the legacy lane boundary,
;; and the genuinely silent lane that should be reaped.
;;   bb reap_test.clj      (run from the repo root; no daemon, no classpath needed)
(load-file "cli/reap.clj")

;; Fixed "now" (epoch ms) so lease/spawned deltas are exact and clock-free.
(def now   1000000000000)
(def STALE north.reap/LANE-STALE-MS)           ; 30min
(def lapsed-exp (- now (* 40 60 1000)))       ; lease expired 40min ago -> stale
(def fresh-exp  (+ now (* 20 60 1000)))       ; lease valid 20min out    -> live
(def recent-exp (- now (* 5  60 1000)))       ; lease expired  5min ago  -> too new
(def old-spawn  (- now (* 3 60 60 1000)))     ; spawned 3h ago  -> leaseless-dead
(def new-spawn  (- now (* 2 60 1000)))        ; spawned 2min ago -> leaseless too new

;; reap-lane? [now resolved? lease-exp spawned-ms]
(def modern-terminal
  {"outcome" "ran"
   "process_outcome" "ran"
   "delivery_outcome" "unverified"
   "delivery_reason" "provider_terminal_success_without_external_verification"})
(def marked-terminal
  (assoc modern-terminal "terminal_manifest_sha256"
         (north.terminal-projection/terminal-manifest-sha256 modern-terminal)))
(def partial-run
  {"agent" "sdk-run" "outcome" "ran" "process_outcome" "ran"})
(def committed-run (assoc partial-run "kind" "run"))

(defn resolved? [h lane runs]
  (north.reap/lane-resolved? h lane runs))
(defn reap? [& args] (apply north.reap/reap-lane? args))

(def cases
  [;; --- crash-safe publication boundaries ---------------------------------------
   ["terminal digest canonical encoding is stable across runtimes"
    (= "9514cd8eaf6900c116c6c2ae68e7918f423e45bb187b97ae067ddf729f2d55cd"
       (north.terminal-projection/terminal-manifest-sha256 modern-terminal))        true]
   ["marked modern lane terminal resolves"
    (resolved? "sdk-a" marked-terminal [])                                       true]
   ["partial modern lane terminal does not fall back to its outcome alias"
    (resolved? "sdk-a" modern-terminal [])                                       false]
   ["a mismatched terminal digest is rejected"
    (resolved? "sdk-a" (assoc marked-terminal "terminal_manifest_sha256" "bad") []) false]
   ["true legacy lane outcome resolves only without process_outcome"
    (resolved? "sdk-a" {"outcome" "ran"} [])                                     true]
   ["committed kind=run fallback resolves"
    (resolved? "sdk-run" {} [committed-run])                                     true]
   ["partial run body without kind=run stays invisible"
    (resolved? "sdk-run" {} [partial-run])                                       false]

   ;; --- the true-positive: truly-silent lane IS reaped ---------------------------
   ["silent lane (lease lapsed >30min, no committed terminal) => reaped"
    (reap? now (resolved? "sdk-b" {} []) lapsed-exp nil)                          true]

   ;; --- liveness axis ------------------------------------------------------------
   ["live lease => NOT reaped"
    (reap? now false fresh-exp nil)                                               false]
   ["expired lease but <30min lapse => NOT reaped (too new)"
    (reap? now false recent-exp nil)                                              false]

   ;; --- leaseless-dead class (lease GC'd / never taken): judge by spawned_at ------
   ["no lease, spawned 3h ago, unresolved => reaped (vanished-lease dead)"
    (reap? now (resolved? "sdk-c" {} []) nil old-spawn)                           true]
   ["no lease, spawned 2min ago => NOT reaped (too new)"
    (reap? now false nil new-spawn)                                               false]
   ["no lease, spawned 3h ago, but resolved via committed @run => NOT reaped"
    (reap? now (resolved? "sdk-d" {} [committed-run]) nil old-spawn)              false]
   ["no lease AND no spawned_at => NOT reaped (no staleness axis)"
    (reap? now false nil nil)                                                     false]

   ;; --- other terminal short-circuits --------------------------------------------
   ["legacy reactor terminal is still terminal"
    (reap? now (resolved? "sdk-legacy" {"outcome" "died-unreported"} [])
           lapsed-exp nil)                                                        false]
   ["agent_death alone does not resolve a stale lane"
    (reap? now (resolved? "sdk-e" {} []) lapsed-exp nil)                          true]
   ["agent_death exact receipt suppresses only duplicate notification"
    (north.reap/death-reported? "sdk-e" ["sdk-e | SIGKILL | 2026-07-09"])         true]

   ;; --- lane-resolved? join precision --------------------------------------------
   ["resolved?: unrelated tagged subjects without kind=run stay false"
    (resolved? "sdk-f" {} [{"kind" "session" "outcome" "ran"}])                   false]
   ["resolved?: empty lane and runs, no deaths => false"
    (resolved? "sdk-g" {} [])                                                     false]
   ["resolved?: death line prefix must be exact (sdk-01 not matched by sdk-011)"
    (north.reap/death-reported? "sdk-01" ["sdk-011 | boom | ts"])                 false]])

(def fails (filter (fn [[_ got want]] (not= got want)) cases))
(doseq [[nm got want] cases]
  (println (if (= got want) "  ok  " " FAIL ") nm "=> got" got))
(if (seq fails)
  (do (println "\nreap:" (count fails) "FAILED") (System/exit 1))
  (println "\nreap: all" (count cases) "passed"))

(let [drivers [["@thread-a" "@sdk-dead"]
               ["@thread-b" "@sdk-live"]
               ["@thread-c" "@sdk-dead"]
               ["@thread-a" "@sdk-dead"]]
      got (north.reap/orphaned-driver-subjects "sdk-dead" drivers)
      want ["@thread-a" "@thread-c"]]
  (println (if (= got want) "  ok  " " FAIL ")
           "reaped lane releases only its exact driver refs => got" got)
  (when-not (= got want) (System/exit 1)))

;; A dispatch can be hard-killed after atomically claiming `driver` but before
;; publishing kind=lane/spawned_at. Current SDK IDs carry the only trustworthy
;; age axis for that gap. Pin the fail-safe boundary and refuse every old shape.
(let [clock-now (.toEpochMilli (java.time.Instant/parse "2026-07-17T12:00:00Z"))
      uuid "123e4567-e89b-42d3-a456-426614174000"
      id-at (fn [ms] (str "sdk-thread-fragment-" (Long/toString ms 36) "-" uuid))
      exact-id (id-at (- clock-now STALE))
      recent-id (id-at (- clock-now (dec STALE)))
      future-id (id-at (+ clock-now 60000))
      old-id (id-at (dec north.reap/SDK-AGENT-ID-EPOCH-FLOOR-MS))
      malformed-id (str "sdk-thread-fragment-not!base36-" uuid)
      legacy-id "sdk-a70c74e0"
      drivers [["@thread-exact" (str "@" exact-id)]
               ["@thread-exact" (str "@" exact-id)] ; duplicate scan row: one retraction
               ["@thread-recent" (str "@" recent-id)]
               ["@thread-future" (str "@" future-id)]
               ["@thread-old" (str "@" old-id)]
               ["@thread-malformed" (str "@" malformed-id)]
               ["@thread-legacy" (str "@" legacy-id)]
               ["@thread-unsigiled" exact-id]]
      got (north.reap/orphaned-unpublished-driver-pairs clock-now #{} drivers)
      want [["@thread-exact" (str "@" exact-id)]]
      known-got (north.reap/orphaned-unpublished-driver-pairs clock-now #{exact-id} drivers)
      remaining (remove (set got) drivers)
      second-pass (north.reap/orphaned-unpublished-driver-pairs clock-now #{} remaining)
      mint-got (north.reap/sdk-agent-mint-ms exact-id)
      selected-refs (set (map second got))
      checks [["current ID exposes its exact mint time" (= mint-got (- clock-now STALE))]
              ["exactly 30min unpublished is recoverable" (= got want)]
              ["one millisecond before 30min is never released" (not (contains? selected-refs (str "@" recent-id)))]
              ["future-minted driver is never released" (not (contains? selected-refs (str "@" future-id)))]
              ["known/live lane is never handled by unpublished recovery" (empty? known-got)]
              ["recovery is idempotent after exact pair removal" (empty? second-pass)]
              ["legacy short ID fails safe" (nil? (north.reap/sdk-agent-mint-ms legacy-id))]
              ["malformed timestamp fails safe" (nil? (north.reap/sdk-agent-mint-ms malformed-id))]
              ["pre-format old timestamp fails safe" (nil? (north.reap/sdk-agent-mint-ms old-id))]]
      failed (remove second checks)]
  (doseq [[label ok?] checks]
    (println (if ok? "  ok  " " FAIL ") label))
  (when (seq failed)
    (println "\nunpublished driver recovery:" (count failed) "FAILED")
    (System/exit 1)))
