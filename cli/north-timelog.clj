;; north-timelog — invoice-ready worklog export from north billing facts.
;;
;; Reads the fram log, folds to current facts (retractions honored), and emits
;; one billable line per client-owned thread: date, Linear ticket, description,
;; hours (summed from that thread's clock sessions), rate, amount, and invoice
;; state. Grouped-by-invoice totals go to stderr so `> out.csv` stays clean.
;;
;; Billing model (facts on a thread):
;;   owner <client>        — makes the thread billable to that client (e.g. msa)
;;   linear <MSA-123>      — the ticket, becomes the invoice line ref
;;   rate <n>              — $/hour for this thread's time
;;   invoice_id <id>       — the invoice this work is on ("—" = not yet invoiced)
;;   invoice_state <s>     — uninvoiced | invoice-sent | invoice-paid
;; Hours come from clock sessions (session_of/start_time/end_time), never stored.
;;
;; Usage:  north-timelog [owner] [invoice_id]
;;   owner       default "msa"
;;   invoice_id  optional filter — only lines on that invoice (e.g. YU8UYGOO-0001)
(ns north-timelog
  (:require [fram.kernel :as k]
            [fram.fold :as fold]
            [fram.rt :as rt]
            [clojure.string :as str])
  (:import [java.time Instant]))

(def ^:private args *command-line-args*)
(def ^:private OWNER (or (first args) "msa"))
(def ^:private INV-FILTER (second args))                 ; nil = all invoices
(def ^:private LOG (or (System/getenv "FRAM_LOG")
                       (str (System/getenv "HOME") "/.local/state/north/facts.log")))

(defn- strip-at [s] (if (and s (str/starts-with? s "@")) (subs s 1) s))
(defn- iso->sec [s] (.getEpochSecond (Instant/parse s)))
(defn- to-int [s] (try (Integer/parseInt (str/trim (str s))) (catch Exception _ 0)))
(defn- csv-cell [s] (str "\"" (str/replace (str s) "\"" "\"\"") "\""))

(let [facts  (:facts (fold/fold (rt/read-log LOG)))
      idx     (k/build-index facts)
      allsub  (:subjects idx)
      one     (fn [s p] (k/one-i idx s p))
      ;; billable threads for this owner (must carry a title = a real thread)
      threads (filter (fn [s] (and (= (one s "owner") OWNER)
                                   (some? (one s "title")))) allsub)
      tset    (set (map strip-at threads))
      ;; roll clock sessions up to their thread: total seconds + earliest date
      per     (reduce
                (fn [m s]
                  (let [thr (strip-at (one s "session_of"))
                        st  (one s "start_time")
                        en  (one s "end_time")]
                    (if (and (contains? tset thr) (some? st) (some? en))
                      (let [secs (- (iso->sec en) (iso->sec st))
                            day  (subs st 0 10)]
                        (-> m
                            (update-in [thr :secs] (fnil + 0) secs)
                            (update-in [thr :date]
                                       (fn [d] (if (or (nil? d) (neg? (compare day d))) day d)))))
                      m)))
                {}
                (filter (fn [s] (some? (one s "session_of"))) allsub))
      rows    (->> threads
                   (keep (fn [t]
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
                                  :state   (or (one t "invoice_state") "uninvoiced")})))))
                   (sort-by (juxt :invoice :date :linear)))]

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
      (println (format "  %-18s %3d line(s)  %6.2fh  $%9.2f" "TOTAL" (count rows) (double H) (double A))))))
