#!/usr/bin/env bb
;; north dials — routing-analytics read projection over the @run telemetry stream.
;;
;; Answers "are we deploying the right model at the right effort?" from the fact log,
;; NOT from doctrine belief. Every @run-<agent>-<ts> subject carries an effective dial
;; (model/effort/role) — denormalized onto @run by sdk/src/telemetry.ts recordRun, with
;; a fallback join through @agent:<agent> identity facts for runs recorded before the
;; denorm landed. Groups runs by dial and reports the objective fit signals:
;;   n · Σcost · Σtokens · mean turns · mean wall-s · outcome mix · escalation rate.
;;
;; Escalation rate is the objective UNDER-provisioning signal (a run that climbed the
;; ladder was launched under-powered). Over-provisioning has no per-run trace — see the
;; loopback doc; this view surfaces cohorts, the judge/RATE step assigns fit.
;;
;; Facts, never claims: this projects asserted @run facts; it computes, it does not rate.
;; Read-only. Companion to `north health` (run health rollup) and `north trace` (failures).

(require '[clojure.edn :as edn]
         '[clojure.string :as str])

(def log-path
  (or (System/getenv "NORTH_FACTS_LOG")
      (str (System/getenv "HOME") "/.local/state/north/facts.log")))

(defn read-facts
  "Fold the append-only EDN log into subject -> {pred -> value}, honoring
   assert (last wins for single-valued preds) and retract (removes)."
  [path]
  (with-open [r (clojure.java.io/reader path)]
    (reduce
     (fn [acc line]
       (let [line (str/trim line)]
         (if (str/blank? line)
           acc
           (let [{:keys [op l p r]} (try (edn/read-string line) (catch Exception _ nil))]
             (cond
               (nil? l) acc
               (= op "assert") (assoc-in acc [l p] r)
               (= op "retract") (update acc l dissoc p)
               :else acc)))))
     {}
     (line-seq r))))

(defn runs
  "Every @run-* subject with kind=run, with its effective dial resolved:
   prefer the dial denormalized on the run; else join @agent:<agent>."
  [facts]
  (for [[subj m] facts
        :when (and (str/starts-with? (str subj) "@run-") (= (get m "kind") "run"))
        :let [agent (get m "agent")
              ident (get facts (str "@agent:" agent))
              model  (or (get m "model")  (get ident "model")  "?")
              effort (or (get m "effort") (get ident "effort") "?")
              role   (or (get m "role")   (get ident "role")   "?")]]
    {:subj subj :agent agent :model model :effort effort :role role
     :dial (str model "-" effort)
     :outcome (get m "outcome" "?")
     :tokens (parse-long (or (get m "tokens") "0"))
     :cost (Double/parseDouble (or (get m "cost_usd") "0"))
     :turns (parse-long (or (get m "num_turns") "0"))
     :dur-ms (parse-long (or (get m "duration_ms") "0"))
     :errors (parse-long (or (get m "error_count") "0"))
     :esc (parse-long (or (get m "escalation_count") "0"))
     :esc-reasons (get m "escalation_reasons")}))

(defn summarize [rs]
  (let [n (count rs)
        sum (fn [k] (reduce + 0 (map k rs)))
        mean (fn [k] (if (zero? n) 0 (/ (double (sum k)) n)))
        escalated (count (filter #(pos? (:esc %)) rs))
        outcomes (frequencies (map :outcome rs))
        ok (get outcomes "ran" 0)]
    {:n n :cost (sum :cost) :tokens (sum :tokens)
     :mean-turns (mean :turns) :mean-wall-s (/ (mean :dur-ms) 1000.0)
     :ok-rate (if (zero? n) 0 (/ (double ok) n))
     :esc-rate (if (zero? n) 0 (/ (double escalated) n))
     :outcomes outcomes}))

(defn fmt-row [label {:keys [n cost tokens mean-turns mean-wall-s ok-rate esc-rate outcomes]}]
  (format "%-22s %4d  $%8.2f  %9dk  %5.1ft  %6.0fs  ok %3.0f%%  esc %3.0f%%  %s"
          label n cost (long (/ tokens 1000)) mean-turns mean-wall-s
          (* 100 ok-rate) (* 100 esc-rate)
          (str/join " " (for [[o c] (sort-by (comp - val) outcomes) :when (not= o "ran")]
                          (str o ":" c)))))

(defn -main [& args]
  (let [group-key (case (first args)
                    "by-role" :role "by-model" :model "by-effort" :effort
                    :dial) ; default: full model-effort dial
        facts (read-facts log-path)
        rs (runs facts)
        groups (sort-by key (group-by group-key rs))]
    (println (format "north dials — %d runs over %s   (group: %s)\n"
                     (count rs) log-path (name group-key)))
    (println (format "%-22s %4s  %9s  %10s  %6s  %7s  %-6s %-6s %s"
                     (str/upper-case (name group-key)) "n" "Σcost" "Σtokens" "turns" "wall" "ok" "esc" "other-outcomes"))
    (println (apply str (repeat 110 "-")))
    (doseq [[g rs] groups]
      (println (fmt-row (str g) (summarize rs))))
    (println (apply str (repeat 110 "-")))
    (println (fmt-row "ALL" (summarize rs)))))

(apply -main *command-line-args*)
