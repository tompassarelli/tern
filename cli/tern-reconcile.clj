;; tern-reconcile.clj — telemetry reconciliation: reads all @run:* claims, surfaces
;; estimate-vs-actual drift, cost distribution, model-tier patterns. This is the CONSUMER
;; that closes the feedback loop — without it, runmeta data is inert.
;;
;; usage:
;;   bb tern-reconcile.clj <port>                    — full report
;;   bb tern-reconcile.clj <port> by-model            — breakdown by model tier
;;   bb tern-reconcile.clj <port> drift               — estimate vs actual, sorted by overshoot
;;   bb tern-reconcile.clj <port> recent [N]           — last N runs (default 20)
;;   bb tern-reconcile.clj <port> agent <uuid>         — runs for one agent
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str])

;; shared coord substrate (Foundation Part B): send-op lives once in cli/coord.clj.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op tern.coord/send-op)

(defn all-runs [port]
  (->> (:ok (send-op port {:op :query
                           :query {:find "r"
                                   :rules [{:head {:rel "r" :args [{:var "e"}]}
                                            :body [{:rel "triple" :args [{:var "e"} "cost_usd" {:var "_"}]}]}]}}))
       (map first)
       (filter #(str/starts-with? (str %) "@run:"))
       sort))

(defn run-meta [port re]
  (let [preds ["agent" "cost_usd" "input_tokens" "output_tokens" "cache_read_tokens"
               "cache_create_tokens" "duration_ms" "num_turns" "stop_reason" "model"
               "effort" "caveman" "wall_s" "estimate_output_tokens" "confidence" "ended_at"]]
    (reduce (fn [m p]
              (let [v (:value (send-op port {:op :resolved :te re :p p}))]
                (if v (assoc m (keyword p) v) m)))
            {:entity re} preds)))

(defn parse-num [s] (when s (try (parse-double s) (catch Exception _ nil))))

(defn drift-ratio [est act]
  (when (and est act (pos? est))
    (/ (double act) (double est))))

(defn fmt-drift [ratio]
  (when ratio
    (let [pct (int (* 100 (- ratio 1)))]
      (cond (> pct 50)  (format "+%d%% !!!" pct)
            (> pct 20)  (format "+%d%% !" pct)
            (> pct 0)   (format "+%d%%" pct)
            (< pct -20) (format "%d%% (under)" pct)
            :else       (format "%d%%" pct)))))

(defn print-summary [runs]
  (let [costs (keep #(parse-num (:cost_usd %)) runs)
        total (reduce + 0 costs)
        drifts (keep (fn [r]
                       (let [est (parse-num (:estimate_output_tokens r))
                             act (parse-num (:output_tokens r))]
                         (drift-ratio est act)))
                     runs)
        confs (keep #(parse-num (:confidence %)) runs)]
    (println (format "%-20s %d" "total runs" (count runs)))
    (println (format "%-20s $%.2f" "total cost" total))
    (when (seq costs)
      (println (format "%-20s $%.3f" "avg cost/run" (/ total (count costs))))
      (println (format "%-20s $%.3f" "max cost" (apply max costs))))
    (when (seq drifts)
      (let [avg-drift (/ (reduce + drifts) (count drifts))]
        (println (format "%-20s %.1fx (1.0 = perfect)" "avg estimate drift" avg-drift))
        (println (format "%-20s %.1fx" "worst overshoot" (apply max drifts)))))
    (when (seq confs)
      (println (format "%-20s %.1f / 5" "avg confidence" (/ (reduce + confs) (count confs)))))))

(defn print-by-model [runs]
  (let [groups (group-by #(or (:model %) "unknown") runs)]
    (println (format "%-12s %5s %10s %10s %10s" "MODEL" "RUNS" "TOTAL$" "AVG$" "AVG_DRIFT"))
    (doseq [[model rs] (sort groups)]
      (let [costs (keep #(parse-num (:cost_usd %)) rs)
            total (reduce + 0 costs)
            drifts (keep (fn [r]
                           (drift-ratio (parse-num (:estimate_output_tokens r))
                                        (parse-num (:output_tokens r))))
                         rs)]
        (println (format "%-12s %5d %10s %10s %10s"
                         model (count rs)
                         (format "$%.2f" total)
                         (if (seq costs) (format "$%.3f" (/ total (count costs))) "-")
                         (if (seq drifts) (format "%.1fx" (/ (reduce + drifts) (count drifts))) "-")))))))

(defn print-drift [runs]
  (let [with-drift (->> runs
                        (keep (fn [r]
                                (let [est (parse-num (:estimate_output_tokens r))
                                      act (parse-num (:output_tokens r))
                                      d (drift-ratio est act)]
                                  (when d (assoc r ::drift d)))))
                        (sort-by ::drift >))]
    (println (format "%-36s %6s %6s %8s %10s %s" "RUN" "EST" "ACTUAL" "DRIFT" "COST" "MODEL"))
    (doseq [r with-drift]
      (println (format "%-36s %6s %6s %8s %10s %s"
                       (subs (str (:entity r)) 0 (min 36 (count (str (:entity r)))))
                       (or (:estimate_output_tokens r) "?")
                       (or (:output_tokens r) "?")
                       (or (fmt-drift (::drift r)) "?")
                       (str "$" (or (:cost_usd r) "?"))
                       (or (:model r) "?"))))))

(defn print-recent [runs n]
  (let [recent (take-last n (sort-by :ended_at runs))]
    (println (format "%-36s %10s %6s %5s %s" "RUN" "COST" "OUT_TK" "CONF" "MODEL/EFFORT"))
    (doseq [r recent]
      (println (format "%-36s %10s %6s %5s %s"
                       (subs (str (:entity r)) 0 (min 36 (count (str (:entity r)))))
                       (str "$" (or (:cost_usd r) "?"))
                       (or (:output_tokens r) "?")
                       (or (:confidence r) "-")
                       (str (or (:model r) "?") "/" (or (:effort r) "?")))))))

(let [[port-s verb & args] *command-line-args*
      port (Integer/parseInt port-s)
      entities (all-runs port)
      runs (mapv #(run-meta port %) entities)]
  (case (or verb "full")
    "full"
    (do (println "=== SWARM TELEMETRY RECONCILIATION ===\n")
        (print-summary runs)
        (println) (print-by-model runs)
        (println "\n--- recent (last 10) ---")
        (print-recent runs 10))

    "by-model" (print-by-model runs)

    "drift" (print-drift runs)

    "recent"
    (let [n (if (seq args) (Integer/parseInt (first args)) 20)]
      (print-recent runs n))

    "agent"
    (let [[uuid] args
          mine (filter #(= (:agent %) uuid) runs)]
      (if (seq mine)
        (do (println (str "Runs for agent " uuid ":"))
            (print-summary mine)
            (println)
            (print-recent mine 50))
        (println (str "No runs found for " uuid))))

    (do (println "usage: tern-reconcile.clj <port> [full|by-model|drift|recent [N]|agent <uuid>]")
        (System/exit 2))))
