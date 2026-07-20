#!/usr/bin/env bb
;; End-to-end billing readers over North's canonical coordination/telemetry pair.
(require '[babashka.process :as p]
         '[babashka.fs :as fs]
         '[clojure.string :as str])

(def north (str (fs/parent (fs/parent (fs/parent (fs/absolutize *file*))))))
(def root (str (System/getProperty "java.io.tmpdir") "/north-billing-split-" (System/nanoTime)))
(def coordination (str root "/coordination.log"))
(def telemetry (str root "/telemetry.log"))
(def timelog (str north "/bin/north-timelog"))
(def invoice (str north "/bin/north-invoice"))
(def invoice-src (str north "/cli/north-invoice.clj"))
(def fram-out (str (or (System/getenv "FRAM_HOME")
                       (str (System/getProperty "user.home") "/code/fram"))
                   "/out"))
(def stub-home (str root "/stub-north"))
(def paid-log (str root "/paid-writes.log"))
(def fails (atom 0))

(defn check [label ok?]
  (println (format "  %s %s" (if ok? "✓" "✗ FAIL —") label))
  (when-not ok? (swap! fails inc)))

(defn line [tx l pred r]
  (pr-str {:tx tx :op "assert" :l l :p pred :r r :frame "fixture"}))

(fs/create-dirs root)
(spit coordination
      (str/join "\n" [(line 1 "@work" "title" "Split corpus work")
                       (line 2 "@work" "owner" "fakeclient")
                       (line 3 "@work" "linear" "FAKE-7")
                       (line 4 "@work" "rate" "120")
                       ;; This invoice predates the human/agent clock split. Its
                       ;; durable sent total included every legacy session on
                       ;; @work and must not shrink after the model change.
                       (line 5 "@work" "invoice_id" "HIST-1")
                       (line 6 "@work" "invoice_state" "invoice-sent")
                       ;; New explicit agent time on an uninvoiced thread remains
                       ;; nonbillable task telemetry.
                       (line 7 "@new-work" "title" "New agent-only work")
                       (line 8 "@new-work" "owner" "fakeclient")
                       (line 9 "@new-work" "rate" "120")]))
(spit telemetry
      (str/join "\n" [(line 10 "@session" "session_of" "@work")
                       (line 11 "@session" "start_time" "2026-07-10T10:00:00Z")
                       (line 12 "@session" "end_time" "2026-07-10T11:30:00Z")
                       ;; Owner-scoped human session: its rate is snapshotted at
                       ;; clock-in and it invoices independently of any ticket.
                       (line 13 "@client-session" "owner" "fakeclient")
                       (line 14 "@client-session" "clocked_by" "user")
                       (line 15 "@client-session" "rate" "130")
                       (line 16 "@client-session" "start_time" "2026-07-10T12:00:00Z")
                       (line 17 "@client-session" "end_time" "2026-07-10T13:00:00Z")
                       (line 18 "@client-session" "kind" "client_session")
                       ;; Legacy managed-agent session on the same client thread:
                       ;; it remains frozen into the already-sent HIST-1 total.
                       (line 19 "@agent-session" "session_of" "@work")
                       (line 20 "@agent-session" "clocked_by" "lane-123")
                       (line 21 "@agent-session" "start_time" "2026-07-10T13:00:00Z")
                       (line 22 "@agent-session" "end_time" "2026-07-10T15:00:00Z")
                       ;; Same shape, but no invoice evidence: excluded.
                       (line 23 "@new-agent-session" "session_of" "@new-work")
                       (line 24 "@new-agent-session" "clocked_by" "lane-456")
                       (line 25 "@new-agent-session" "start_time" "2026-07-10T15:00:00Z")
                       (line 26 "@new-agent-session" "end_time" "2026-07-10T17:00:00Z")]))

(defn run [bin & args]
  (apply p/shell {:out :string :err :string :continue true
                  :extra-env {"FRAM_LOG" coordination}}
         bin args))

(println "billing split-corpus test")
(let [r (run timelog "fakeclient")]
  (check "timelog exits successfully" (zero? (:exit r)))
  (check "timelog preserves legacy human thread time" (str/includes? (:out r) "FAKE-7"))
  (check "timelog emits owner-scoped client session" (str/includes? (:out r) "client-session"))
  (check "sent historical invoice does not shrink" (str/includes? (:out r) "3.50,120,420.00,HIST-1,invoice-sent"))
  (check "timelog totals historical invoice plus current human session" (str/includes? (:err r) "4.50h"))
  (check "timelog uses snapshotted client-session rate" (str/includes? (:out r) "130.00"))
  (check "timelog excludes only the new uninvoiced managed-agent session"
         (str/includes? (:err r) "excluded 1 managed-agent session")))

(let [r (run timelog "fakeclient" "HIST-1")]
  (check "sent invoice filter exits successfully" (zero? (:exit r)))
  (check "sent invoice filter preserves 3.50 historical hours" (str/includes? (:err r) "3.50h"))
  (check "sent invoice filter preserves $420 historical amount" (str/includes? (:err r) "$   420.00"))
  (check "sent invoice filter excludes later uninvoiced human work" (not (str/includes? (:out r) "client-session"))))

(let [r (run invoice "unbilled" "fakeclient")]
  (check "invoice selection exits successfully" (zero? (:exit r)))
  (check "invoice selects owner-scoped client session" (str/includes? (:out r) "client-session  fakeclient client session"))
  (check "invoice count excludes sent history and new agent timing" (str/includes? (:out r) "human items: 1")))

;; `paid` intentionally trusts durable invoice_id rather than re-deriving today's
;; eligibility. Stub only the writer boundary so this stays hermetic while proving
;; the historical thread remains a reachable invoice-paid target.
(fs/create-dirs (str stub-home "/bin"))
(spit (str stub-home "/bin/north")
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$NORTH_TEST_PAID_LOG\"\n")
(p/shell "chmod" "+x" (str stub-home "/bin/north"))
(let [r (p/shell {:out :string :err :string :continue true
                  :extra-env {"FRAM_LOG" coordination
                              "NORTH_HOME" stub-home
                              "NORTH_TEST_PAID_LOG" paid-log}}
                 "bb" "-cp" (str north "/out:" fram-out)
                 invoice-src "paid" "HIST-1")
      writes (if (fs/exists? paid-log) (slurp paid-log) "")]
  (check "historical sent invoice remains payable" (zero? (:exit r)))
  (check "paid reaches the durable legacy invoice target" (str/includes? writes "tell work invoice_state invoice-paid")))

;; A differently named explicit corpus must not infer a neighboring telemetry.log.
(let [isolated (str root "/unrelated.log")]
  (fs/copy coordination isolated)
  (let [r (p/shell {:out :string :err :string :continue true
                    :extra-env {"FRAM_LOG" isolated}}
                   timelog "fakeclient")]
    (check "unrelated explicit corpus remains isolated" (not (str/includes? (:out r) "FAKE-7")))))

(fs/delete-tree root)
(if (pos? @fails)
  (do (println (format "\nFAILED — %d check(s)" @fails)) (System/exit 1))
  (do (println "\nPASS — billing readers join only the configured canonical split corpus")
      (System/exit 0)))
