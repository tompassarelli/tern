;; north-timelog — invoice-ready worklog export from north billing facts.
;;
;; Reads the fram log, folds to current facts (retractions honored), and emits
;; one billable line per human client session (plus one aggregate line per
;; legacy human thread): date, reference, description, hours, rate, amount, and
;; invoice state. Managed-agent task clocks are telemetry/audit data and never
;; enter invoice totals. Grouped-by-invoice totals go to stderr so `> out.csv`
;; stays clean.
;;
;; Billing model (facts on a thread):
;;   owner <client>        — makes the thread billable to that client (e.g. msa)
;;   linear <MSA-123>      — the ticket, becomes the invoice line ref
;;   rate <n>              — $/hour for this thread's time
;;   invoice_id <id>       — the invoice this work is on ("—" = not yet invoiced)
;;   invoice_state <s>     — uninvoiced | invoice-sent | invoice-paid
;; New sessions are owner-scoped entities:
;;   kind client_session · owner <client> · clocked_by user · rate <snapshot>
;;   start_time/end_time
;; Legacy session_of rows remain billable only when clocked_by is absent/user.
;;
;; Usage:  north-timelog [owner] [invoice_id]
;;   owner       default "msa"
;;   invoice_id  optional filter — only lines on that invoice (e.g. YU8UYGOO-0001)
;;   --audit-agent-sessions  list legacy managed rows excluded from this owner
(ns north-timelog
  (:require [fram.kernel :as k]
            [fram.fold :as fold]
            [fram.rt :as rt]
            [north.clock :as clk]
            [clojure.string :as str]))

(def ^:private args *command-line-args*)
;; `--wall` / `--wallclock` adds the per-day union-merged wall-clock view; strip
;; flags so the positional owner/invoice args keep working exactly as before.
(def ^:private flags (set (filter #(str/starts-with? % "--") args)))
(def ^:private pos (vec (remove #(str/starts-with? % "--") args)))
(def ^:private OWNER (or (first pos) "msa"))
(def ^:private INV-FILTER (second pos))                  ; nil = all invoices
(def ^:private WALL? (boolean (or (flags "--wall") (flags "--wallclock"))))
(def ^:private AUDIT-AGENTS? (boolean (flags "--audit-agent-sessions")))
(defn- strip-at [s] (if (and s (str/starts-with? s "@")) (subs s 1) s))
;; Tolerant parse (fram.rt/iso-to-seconds): session timestamps are ZONE-LESS
;; local ISO (fram.rt/now-iso), so the old (Instant/parse s) threw on every
;; auto-clocked session. Delegate to the engine's parser, which honors a Z/offset
;; when present and interprets zone-less stamps in the system zone.
(defn- iso->sec [s] (rt/iso-to-seconds s))
(defn- to-int [s] (try (Integer/parseInt (str/trim (str s))) (catch Exception _ 0)))
(defn- csv-cell [s] (str "\"" (str/replace (str s) "\"" "\"\"") "\""))

(let [facts  (:facts (fold/fold (rt/read-configured-logs)))
      idx     (k/build-index facts)
      allsub  (:subjects idx)
      one     (fn [s p] (k/one-i idx s p))
      human?  (fn [s] (let [a (one s "clocked_by")] (or (nil? a) (= a "user"))))
      closed? (fn [s] (and (some? (one s "start_time"))
                           (some? (one s "end_time"))))
      client-session? (fn [s] (and (= (one s "kind") "client_session")
                                   (= (one s "owner") OWNER)
                                   (human? s)
                                   (closed? s)))
      ;; billable threads for this owner (must carry a title = a real thread)
      threads (filter (fn [s] (and (= (one s "owner") OWNER)
                                   (some? (one s "title")))) allsub)
      tset    (set (map strip-at threads))
      ;; Roll only legacy HUMAN clock sessions up to their thread. Explicit
      ;; managed actors are task telemetry and are intentionally excluded.
      per     (reduce
                (fn [m s]
                  (let [thr (strip-at (one s "session_of"))
                        st  (one s "start_time")
                        en  (one s "end_time")]
                    (if (and (contains? tset thr) (and (human? s) (closed? s)))
                      (let [secs (- (iso->sec en) (iso->sec st))
                            day  (subs st 0 10)]
                        (-> m
                            (update-in [thr :secs] (fnil + 0) secs)
                            (update-in [thr :date]
                                       (fn [d] (if (or (nil? d) (neg? (compare day d))) day d)))))
                      m)))
                {}
                (filter (fn [s] (some? (one s "session_of"))) allsub))
      legacy-rows (keep (fn [t]
                          (let [id   (strip-at t)
                                p    (get per id)
                                secs (long (get p :secs 0))
                                inv  (or (one t "invoice_id") "—")]
                            (when (and (pos? secs)
                                       (or (nil? INV-FILTER) (= inv INV-FILTER)))
                              (let [hours (/ secs 3600.0)
                                    rate  (to-int (one t "rate"))]
                                {:linear  (or (one t "linear") id)
                                 :title   (one t "title")
                                 :date    (get p :date "")
                                 :hours   hours
                                 :rate    rate
                                 :amount  (* hours rate)
                                 :invoice inv
                                 :state   (or (one t "invoice_state") "uninvoiced")}))))
                        threads)
      session-rows (keep (fn [s]
                           (let [st (one s "start_time")
                                 en (one s "end_time")
                                 inv (or (one s "invoice_id") "—")]
                             (when (and (client-session? s)
                                        (or (nil? INV-FILTER) (= inv INV-FILTER)))
                               (let [hours (/ (- (iso->sec en) (iso->sec st)) 3600.0)
                                     rate (to-int (one s "rate"))]
                                 {:linear (strip-at s)
                                  :title (str OWNER " client session")
                                  :date (subs st 0 10)
                                  :hours hours
                                  :rate rate
                                  :amount (* hours rate)
                                  :invoice inv
                                  :state (or (one s "invoice_state") "uninvoiced")}))))
                         allsub)
      rows    (sort-by (juxt :invoice :date :linear)
                       (concat legacy-rows session-rows))
      excluded-agents (filter (fn [s]
                                (let [so (one s "session_of")]
                                  (and (closed? s)
                                       (and (some? so)
                                            (and (= (one so "owner") OWNER)
                                                 (not (human? s)))))))
                              allsub)]

  (println "date,ticket,description,hours,rate,amount,invoice_id,invoice_state")
  (doseq [r rows]
    (println (str/join ","
                       [(:date r) (:linear r) (csv-cell (:title r))
                        (format "%.2f" (:hours r)) (:rate r)
                        (format "%.2f" (double (:amount r)))
                        (:invoice r) (:state r)])))

  (binding [*out* *err*]
    (println)
    (println (format "== timelog: owner=%s%s ==" OWNER
                     (if INV-FILTER (str " invoice=" INV-FILTER) "")))
    (doseq [[inv rs] (sort-by key (group-by :invoice rows))]
      (let [h (reduce + (map :hours rs))
            a (reduce + (map :amount rs))]
        (println (format "  %-18s %3d line(s)  %6.2fh  $%9.2f  [%s]"
                         inv (count rs) (double h) (double a) (:state (first rs))))))
    (let [H (reduce + (map :hours rows))
          A (reduce + (map :amount rows))]
      (println (format "  %-18s %3d line(s)  %6.2fh  $%9.2f" "TOTAL" (count rows) (double H) (double A))))
    (when (seq excluded-agents)
      (println (format "  excluded %d managed-agent session(s) from billing totals%s"
                       (count excluded-agents)
                       (if AUDIT-AGENTS? ":" " (use --audit-agent-sessions for IDs)")))
      (when AUDIT-AGENTS?
        (doseq [s excluded-agents]
          (println (str "    " (strip-at s) "  actor=" (one s "clocked_by")
                        "  thread=" (strip-at (one s "session_of")))))))
    ;; Wall-clock view (--wall): parallel agents clock overlapping sessions on
    ;; different threads, so the ATTRIBUTION total above double-counts real time.
    ;; Union-merge each day's intervals to bill an elapsed hour once. Two labeled
    ;; numbers; which one invoices is the owner's policy call, not this report's.
    (when WALL?
      (let [days       (clk/owner-wall-by-day idx OWNER iso->sec)
            wall-total (clk/owner-wall-total idx OWNER iso->sec)
            attr-h     (reduce + (map :hours rows))]
        (println)
        (println "  WALL-CLOCK (per-day union-merged; overlapping parallel sessions counted ONCE):")
        (doseq [d days]
          (println (format "    %-12s %7.2fh" (:day d) (/ (:secs d) 3600.0))))
        (println (format "    %-12s %7.2fh" "WALL TOTAL" (/ wall-total 3600.0)))
        (println (format "    (attribution %.2fh vs wall-clock %.2fh — attribution counts every"
                         (double attr-h) (/ wall-total 3600.0)))
        (println "     session; wall-clock counts real elapsed time. Which one bills is your policy.)")))))
