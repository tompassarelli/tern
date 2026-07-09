;; north-invoice — the invoice state machine over billable north threads.
;;
;; Worklogs live as clock sessions on client-owned threads (see north-timelog).
;; This tool moves those threads through invoice states by asserting facts —
;; no separate ledger, the graph IS the ledger:
;;
;;   uninvoiced  (no invoice_id)                     ← work as you go, no ceremony
;;      │  bill <invoice_id> [owner]
;;      ▼
;;   invoice-sent  (invoice_id + invoice_state)      ← stamped when you send it
;;      │  paid <invoice_id>
;;      ▼
;;   invoice-paid
;;
;; Commands:
;;   north-invoice bill <invoice_id> [owner]   stamp every UNINVOICED owner thread
;;                                            (default owner msa) onto <invoice_id>,
;;                                            state invoice-sent. Prints each.
;;   north-invoice paid <invoice_id>           flip every thread on <invoice_id>
;;                                            to invoice-paid.
;;   north-invoice unbilled [owner]            list uninvoiced billable threads.
;;
;; Writes go THROUGH the coordinator (shells `north tell`) — never the log directly.
(ns north-invoice
  (:require [fram.kernel :as k]
            [fram.fold :as fold]
            [fram.rt :as rt]
            [clojure.string :as str]
            [babashka.process :as p]))

(def ^:private args *command-line-args*)
(def ^:private CMD (first args))
(def ^:private NORTH (or (System/getenv "NORTH_HOME")
                        (str (System/getenv "HOME") "/code/north")))
(def ^:private LOG (or (System/getenv "FRAM_LOG")
                       (str (System/getenv "HOME") "/.local/state/north/facts.log")))

(defn- strip-at [s] (if (and s (str/starts-with? s "@")) (subs s 1) s))
(defn- tell! [id pred val]
  (p/shell {:dir NORTH :out :string :err :string} (str NORTH "/bin/north") "tell" id pred val))

(let [facts (:facts (fold/fold (rt/read-log LOG)))
      idx    (k/build-index facts)
      allsub (:subjects idx)
      one    (fn [s p] (k/one-i idx s p))
      thread? (fn [s] (some? (one s "title")))]
  (case CMD
    "bill"
    (let [inv   (second args)
          owner (or (nth args 2 nil) "msa")]
      (when (str/blank? inv) (println "usage: north-invoice bill <invoice_id> [owner]") (System/exit 2))
      (let [targets (filter (fn [s] (and (thread? s)
                                         (= (one s "owner") owner)
                                         (nil? (one s "invoice_id")))) allsub)]
        (if (empty? targets)
          (println (str "no uninvoiced " owner " threads — nothing to bill"))
          (do (println (str "stamping " (count targets) " thread(s) onto " inv " (invoice-sent):"))
              (doseq [t targets]
                (tell! (strip-at t) "invoice_id" inv)
                (tell! (strip-at t) "invoice_state" "invoice-sent")
                (println (str "  ✓ " (or (one t "linear") (strip-at t)) "  " (one t "title"))))))))

    "paid"
    (let [inv (second args)]
      (when (str/blank? inv) (println "usage: north-invoice paid <invoice_id>") (System/exit 2))
      (let [targets (filter (fn [s] (and (thread? s) (= (one s "invoice_id") inv))) allsub)]
        (if (empty? targets)
          (println (str "no threads on invoice " inv))
          (do (println (str "marking " (count targets) " thread(s) on " inv " invoice-paid:"))
              (doseq [t targets]
                (tell! (strip-at t) "invoice_state" "invoice-paid")
                (println (str "  ✓ " (or (one t "linear") (strip-at t)))))))))

    "unbilled"
    (let [owner (or (second args) "msa")
          ts (filter (fn [s] (and (thread? s)
                                  (= (one s "owner") owner)
                                  (nil? (one s "invoice_id")))) allsub)]
      (println (str "uninvoiced " owner " threads: " (count ts)))
      (doseq [t ts] (println (str "  " (or (one t "linear") (strip-at t)) "  " (one t "title")))))

    (do (println "usage: north-invoice <bill|paid|unbilled> ...") (System/exit 2))))
