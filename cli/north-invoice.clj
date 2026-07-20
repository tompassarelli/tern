;; north-invoice — the invoice state machine over billable human work.
;;
;; New worklogs are owner-scoped kind=client_session entities. Historical
;; human session_of rows remain on client-owned threads. This tool moves those
;; exact billable entities through invoice states by asserting facts — no
;; separate ledger, the graph IS the ledger. Managed-agent sessions never enter
;; a NEW invoice. A legacy parent thread already carrying invoice_id remains
;; payable and its frozen historical total remains visible in north-timelog.
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
;;   north-invoice bill <invoice_id> [owner]   stamp every UNINVOICED human item
;;                                            (default owner msa) onto <invoice_id>,
;;                                            state invoice-sent. Prints each.
;;   north-invoice paid <invoice_id>           flip every item on <invoice_id>
;;                                            to invoice-paid.
;;   north-invoice unbilled [owner]            list uninvoiced human work.
;;
;; Writes go THROUGH the coordinator (shells `north tell`) — never the log directly.
(ns north-invoice
  (:require [fram.kernel :as k]
            [fram.fold :as fold]
            [fram.rt :as rt]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [babashka.process :as p]))

(def ^:private args *command-line-args*)
(def ^:private CMD (first args))
(def ^:private NORTH (or (System/getenv "NORTH_HOME")
                        (some-> (System/getProperty "babashka.file")
                                io/file .getCanonicalFile
                                .getParentFile .getParentFile str)))
(defn- strip-at [s] (if (and s (str/starts-with? s "@")) (subs s 1) s))
(defn- tell! [id pred val]
  (p/shell {:dir NORTH :out :string :err :string} (str NORTH "/bin/north") "tell" id pred val))

(let [facts (:facts (fold/fold (rt/read-configured-logs)))
      idx    (k/build-index facts)
      allsub (:subjects idx)
      one    (fn [s p] (k/one-i idx s p))
      thread? (fn [s] (some? (one s "title")))
      human? (fn [s] (let [a (one s "clocked_by")] (or (nil? a) (= a "user"))))
      closed? (fn [s] (and (some? (one s "start_time"))
                           (some? (one s "end_time"))))
      client-session? (fn [s] (and (= (one s "kind") "client_session")
                                   (human? s)
                                   (closed? s)))
      legacy-human-time? (fn [thread]
                           (boolean
                            (some (fn [s]
                                    (and (= (one s "session_of") thread)
                                         (human? s)
                                         (closed? s)))
                                  allsub)))
      invoiceable? (fn [s]
                     (or (client-session? s)
                         (and (thread? s) (legacy-human-time? s))))
      label (fn [s]
              (if (= (one s "kind") "client_session")
                (str (strip-at s) "  " (one s "owner") " client session")
                (str (or (one s "linear") (strip-at s)) "  " (one s "title"))))]
  (case CMD
    "bill"
    (let [inv   (second args)
          owner (or (nth args 2 nil) "msa")]
      (when (str/blank? inv) (println "usage: north-invoice bill <invoice_id> [owner]") (System/exit 2))
      (let [targets (filter (fn [s] (and (invoiceable? s)
                                         (= (one s "owner") owner)
                                         (nil? (one s "invoice_id")))) allsub)]
        (if (empty? targets)
          (println (str "no uninvoiced " owner " human work — nothing to bill"))
          (do (println (str "stamping " (count targets) " item(s) onto " inv " (invoice-sent):"))
              (doseq [t targets]
                (tell! (strip-at t) "invoice_id" inv)
                (tell! (strip-at t) "invoice_state" "invoice-sent")
                (println (str "  ✓ " (label t))))))))

    "paid"
    (let [inv (second args)]
      (when (str/blank? inv) (println "usage: north-invoice paid <invoice_id>") (System/exit 2))
      ;; invoice_id is already durable billing-state evidence. Do not re-derive
      ;; historical eligibility: older invoices remain payable without migration.
      (let [targets (filter (fn [s] (= (one s "invoice_id") inv)) allsub)]
        (if (empty? targets)
          (println (str "no billable items on invoice " inv))
          (do (println (str "marking " (count targets) " item(s) on " inv " invoice-paid:"))
              (doseq [t targets]
                (tell! (strip-at t) "invoice_state" "invoice-paid")
                (println (str "  ✓ " (label t))))))))

    "unbilled"
    (let [owner (or (second args) "msa")
          ts (filter (fn [s] (and (invoiceable? s)
                                  (= (one s "owner") owner)
                                  (nil? (one s "invoice_id")))) allsub)]
      (println (str "uninvoiced " owner " human items: " (count ts)))
      (doseq [t ts] (println (str "  " (label t)))))

    (do (println "usage: north-invoice <bill|paid|unbilled> ...") (System/exit 2))))
