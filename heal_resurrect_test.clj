;; Pure orchestration regression: --resurrect alone must enter the coordinator
;; adoption path. No daemon or filesystem writes; all boundaries are redefined.
(require '[fram.kernel :as k] '[fram.rt])
(require '[north.main])

(def tomb (k/->Fact "@thread" "driver" "@agent:old"))
(def probe (north.main/->Probe true true true 7977 "up" 1 1 [] nil [] [] [] [tomb]))
(def adopted (atom []))
(def healed (atom false))

(with-redefs-fn
  {#'north.main/probe (fn [_ _] probe)
   #'fram.rt/coord-port (fn [] 7977)
   #'fram.rt/coord-version (fn [_] 1)
   #'north.main/live-idx (fn [_] nil)
   #'north.main/adopt-hand-facts
   (fn [_ _ facts]
     (reset! adopted facts)
     (north.main/->AdoptResult (count facts) 0 0 0))
   #'north.main/heal-project (fn [_ _] (reset! healed true))}
  #(north.main/cmd-heal "/tmp/unused" "/tmp/unused.log" false true))

(when-not (= @adopted [tomb])
  (binding [*out* *err*] (println "FAIL --resurrect did not adopt tombstone" @adopted))
  (System/exit 1))
(when-not @healed
  (binding [*out* *err*] (println "FAIL --resurrect did not re-render after adoption"))
  (System/exit 1))
(println "heal-resurrect: passed")
