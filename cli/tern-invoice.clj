;; tern-invoice — the invoice state machine over billable tern threads.
;;
;; Worklogs live as clock sessions on client-owned threads (see tern-timelog).
;; This tool moves those threads through invoice states by asserting claims —
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
;;   tern-invoice bill <invoice_id> [owner]   stamp every UNINVOICED owner thread
;;                                            (default owner msa) onto <invoice_id>,
;;                                            state invoice-sent. Prints each.
;;   tern-invoice paid <invoice_id>           flip every thread on <invoice_id>
;;                                            to invoice-paid.
;;   tern-invoice unbilled [owner]            list uninvoiced billable threads.
;;
;; Writes go THROUGH the coordinator (shells `tern tell`) — never the log directly.
(ns tern-invoice
  (:require [fram.kernel :as k]
            [fram.fold :as fold]
            [fram.rt :as rt]
            [clojure.string :as str]
            [babashka.process :as p]))

(def ^:private args *command-line-args*)
(def ^:private CMD (first args))
(def ^:private TERN (or (System/getenv "TERN_HOME")
                        (str (System/getenv "HOME") "/code/tern")))
(def ^:private LOG (or (System/getenv "FRAM_LOG")
                       (str (System/getenv "HOME") "/.local/state/tern/claims.log")))

(defn- strip-at [s] (if (and s (str/starts-with? s "@")) (subs s 1) s))
(defn- tell! [id pred val]
  (p/shell {:dir TERN :out :string :err :string} (str TERN "/bin/tern") "tell" id pred val))

(let [claims (:claims (fold/fold (rt/read-log LOG)))
      idx    (k/build-index claims)
      allsub (:subjects idx)
      one    (fn [s p] (k/one-i idx s p))
      thread? (fn [s] (some? (one s "title")))]
  (case CMD
    "bill"
    (let [inv   (second args)
          owner (or (nth args 2 nil) "msa")]
      (when (str/blank? inv) (println "usage: tern-invoice bill <invoice_id> [owner]") (System/exit 2))
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
      (when (str/blank? inv) (println "usage: tern-invoice paid <invoice_id>") (System/exit 2))
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

    (do (println "usage: tern-invoice <bill|paid|unbilled> ...") (System/exit 2))))
