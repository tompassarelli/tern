;; dispatch-guard.clj — should the coordinator reuse this agent or spawn fresh?
;; Returns exit code: 0=GREEN (reuse), 1=YELLOW (reuse with caution), 2=RED (migrate), 3=PINNED (always reuse)
;;
;; usage:
;;   bb dispatch-guard.clj <port> <uuid>
;;   bb dispatch-guard.clj <port> <role>    — resolves role to its current holder
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str])

;; shared coord substrate (Foundation Part B): send-op/resolved live once in cli/coord.clj.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op  north.coord/send-op)
(def resolved north.coord/resolved)

(defn resolve-role [port slug]
  (let [rows (:ok (send-op port {:op :query
                                 :query {:find "h"
                                         :rules [{:head {:rel "h" :args [{:var "a"}]}
                                                  :body [{:rel "triple" :args [{:var "a"} "holds" (str "@role:" slug)]}]}]}}))]
    (when (seq rows) (str/replace (ffirst rows) #"^@agent:" ""))))

(let [[port-s target] *command-line-args*
      port (Integer/parseInt port-s)
      now (System/currentTimeMillis)
      uuid (if (re-matches #"[0-9a-f]{12}" target)
             target
             (or (resolve-role port target)
                 (do (println (str "no holder for role '" target "'"))
                     (System/exit 10))))
      ae (str "@agent:" uuid)
      pinned (= "true" (resolved port ae "pinned"))
      needs-rotation (= "true" (resolved port ae "needs_rotation"))
      last-run (resolved port ae "last_run_at")
      gen (or (some-> (resolved port ae "generation") parse-long) 0)
      playbook-count (try (count (:values (send-op 7977 {:op :resolved :te "@2026-06-22-232740" :p "learning"})))
                          (catch Exception _ 0))
      boot-pb (or (some-> (resolved port ae "playbook_count_at_boot") parse-long) 0)
      pb-drift (- playbook-count boot-pb)
      idle-h (when last-run
               (try (/ (- now (.toEpochMilli (java.time.Instant/parse last-run))) 3600000.0)
                    (catch Exception _ nil)))
      idle-score (if idle-h (min 1.0 (/ idle-h 24.0)) 0.5)
      gen-score (min 1.0 (/ (double gen) 5.0))
      pb-score (if (pos? playbook-count) (/ (double pb-drift) playbook-count) 0.0)
      score (+ (* 0.4 idle-score) (* 0.35 gen-score) (* 0.25 pb-score))
      bucket (cond needs-rotation :rotate pinned :pinned (< score 0.3) :green (< score 0.7) :yellow :else :red)]
  (println (str (str/upper-case (name bucket))
                " score=" (format "%.2f" score)
                " idle=" (if idle-h (format "%.0fh" idle-h) "?")
                " gen=" gen
                " playbook_drift=" pb-drift
                (when pinned " [PINNED]")
                (when needs-rotation " [NEEDS ROTATION]")))
  (case bucket
    :rotate (do (println (str "-> COMPACT: agent flagged for rotation (input_tokens exceeded threshold). Run: bash ~/code/north/sdk/src/compact.sh " uuid))
                (System/exit 2))
    :pinned (do (println "-> REUSE (pinned — user trusts this context)") (System/exit 3))
    :green  (do (println "-> REUSE (fresh)") (System/exit 0))
    :yellow (do (println "-> REUSE WITH CAUTION (inject rehydration hint into ping)") (System/exit 1))
    :red    (do (println (str "-> MIGRATE: spawn fresh with MIGRATE_FROM=" uuid))
                (System/exit 2))))
