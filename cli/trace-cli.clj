#!/usr/bin/env bb
;; trace-cli.clj — `north trace <agent-id>`: single-agent lifecycle diagnosis.
;;
;; READ-ONLY. Walks the INVARIANT SPINE checklist (workflow-map §2) for ONE id and
;; flags the FIRST failing stage, printing the exact confirm command per stage. It is
;; LINEAGE-AWARE and TERMINALITY-AWARE — an absence that is EXPECTED for a lineage is
;; marked `·` not `✗` (native sessions have partial identity; a cleanly FINISHED lane
;; legitimately holds a lapsed lease). Managed dispatch and spawn lanes both require the
;; same committed identity projection. The verdict maps the failure to a
;; workflow-map F-mode (F1–F7) with the remedy.
;;
;;   ✓ present/healthy   · expected-absent / n-a   ✗ genuine failure
;;   usage: north trace <agent-id>
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str])
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/agent-provenance.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/terminal-projection.clj"))
(def send-op  north.coord/send-op)
(def resolved north.coord/resolved)
(def many     north.coord/many)
(def lease-of north.coord/lease-of)

(def HOME (System/getenv "HOME"))
(def NORTH (some-> (System/getProperty "babashka.file")
                   io/file .getCanonicalFile .getParentFile .getParentFile str))
(def AGENT-LOGDIR (str HOME "/.local/state/north/agents"))
(def PORT (Integer/parseInt (or (System/getenv "NORTH_PORT") "7977")))
(def NOW (System/currentTimeMillis))

(def use-color? (some? (System/console)))
(defn c [code s] (if use-color? (str "\033[" code "m" s "\033[0m") (str s)))
(defn dim [s] (c "2" s)) (defn bold [s] (c "1" s)) (defn grn [s] (c "32" s))
(defn red [s] (c "31" s)) (defn ylw [s] (c "33" s)) (defn cyn [s] (c "36" s))

(defn iso->ms [s] (try (.toEpochMilli (java.time.Instant/parse (str s))) (catch Exception _ nil)))
(defn identity-route-detail [facts]
  (str "model=" (or (get facts "model") "?")
       " effort=" (or (get facts "effort") "?")))
(defn ago [ms] (if (nil? ms) "?"
  (let [s (quot ms 1000)]
    (cond (< s 60) (str s "s") (< s 3600) (str (quot s 60) "m")
          (< s 86400) (str (quot s 3600) "h") :else (str (quot s 86400) "d")))))

;; ---- per-id reads ------------------------------------------------------------
(defn afact [id p] (resolved PORT (str "@agent:" id) p))
(defn agent-facts [id]
  (let [subject (str "@agent:" id)
        rows (:ok (send-op PORT {:op :query
                                 :query {:find "trace_identity"
                                         :rules [{:head {:rel "trace_identity"
                                                         :args [{:var "p"} {:var "r"}]}
                                                  :body [{:rel "triple"
                                                          :args [subject {:var "p"} {:var "r"}]}]}]}}))]
    (reduce (fn [facts [predicate value]]
              (north.agent-provenance/fold-fact facts predicate value))
            {} rows)))
(defn lease [id] (lease-of PORT (str "session:" id)))
(defn q [project body]
  (:ok (send-op PORT {:op :query
        :query {:find "row" :rules [{:head {:rel "row" :args (mapv (fn [v] {:var v}) project)} :body body}]}})))

(defn owned-concerns [id]
  (->> (q ["e"] [{:rel "triple" :args [{:var "e"} "kind" "concern"]}
                 {:rel "triple" :args [{:var "e"} "agent" (str "@" id)]}])
       (map first)
       (map (fn [e] {:id e :status (let [rs (set (many PORT e "reached"))]
                                     (cond (rs "landed") "landed" (rs "abandoned-stale") "abandoned-stale"
                                           (rs "likely-to-land") "likely-to-land" (rs "building") "building" :else "?"))
                     :repo (resolved PORT e "repo")}))))

(defn agent-runs [id]                 ; [{:outcome :ms} ...] run records whose agent = id
  (->> (q ["e" "o" "t"]
          [{:rel "triple" :args [{:var "e"} "kind" "run"]}
           {:rel "triple" :args [{:var "e"} "agent" id]}
           {:rel "triple" :args [{:var "e"} "outcome" {:var "o"}]}
           {:rel "triple" :args [{:var "e"} "at" {:var "t"}]}])
       (map (fn [[_ o t]] {:outcome o :ms (iso->ms t)}))
       (sort-by #(or (:ms %) 0))))

(defn deaths-for [id]                 ; agent_death lines on @swarm mentioning this id
  (->> (many PORT "@swarm" "agent_death")
       (filter #(str/starts-with? (str %) (str id " ")))
       (map (fn [line] (let [[_ reason ts] (map str/trim (str/split (str line) #"\|" 3))]
                         {:reason reason :ms (iso->ms ts)})))))

(defn inbox-to [id]
  (count (q ["e"] [{:rel "triple" :args [{:var "e"} "to" id]}])))

(defn transcript [id]
  (let [f (io/file AGENT-LOGDIR (str id ".log"))]
    (when (.exists f) {:path (.getPath f) :mtime (.lastModified f) :size (.length f)})))

(defn execution-terminal-state
  "Resolve execution truth without promoting a death notification into a
  terminal. Any lane terminal evidence owns the decision: a partial/conflicting
  modern projection or conflicting legacy outcome fails closed and cannot fall
  through to a secondary run trail. A committed run remains the compatibility
  fallback only when the lane carries no terminal body at all."
  [facts last-run deaths]
  (let [lane-evidence? (or (north.terminal-projection/fact-present?
                            facts "process_outcome")
                           (north.terminal-projection/fact-present? facts "outcome"))
        lane-outcome (north.terminal-projection/terminal-process-outcome facts)
        run-outcome (when (and (not lane-evidence?) (nil? lane-outcome))
                      (:outcome last-run))
        outcome (or lane-outcome run-outcome)]
    {:outcome outcome
     :source (cond lane-outcome :agent run-outcome :run :else nil)
     :terminal? (boolean outcome)
     :kind (cond
             (= "ran" outcome) :ran
             (= "died" outcome) :died
             (= "died-unreported" outcome) :died-unreported
             outcome :stopped
             :else nil)
     :death-notifications (count deaths)}))

(defn terminal-delivery-state
  "Expose delivery only from the same committed lane terminal that established
  process truth. A compatibility run fallback has no lane delivery projection."
  [facts terminal-state]
  (when (and (:terminal? terminal-state)
             (= :agent (:source terminal-state)))
    {:outcome (or (north.terminal-projection/singleton-value
                   facts "delivery_outcome")
                  "unrecorded")
     :reason (north.terminal-projection/singleton-value
              facts "delivery_reason")}))

(defn terminal-summary [terminal-state delivery-state]
  (str "process=" (:outcome terminal-state)
       " · delivery=" (or (:outcome delivery-state) "unrecorded")
       (when-let [reason (:reason delivery-state)]
         (str " (" reason ")"))))

(defn trace-verdict
  [{:keys [id on-roster terminal-state delivery-state online lease lineage
           identity-complete deaths]}]
  (let [terminal? (:terminal? terminal-state)
        terminal-kind (:kind terminal-state)
        summary (terminal-summary terminal-state delivery-state)]
    (cond
      (not on-roster)
      (red "F4 — not on any roster: a zombie fork, a bad id, or an unmanaged actor. Confirm via git author vs `north agents`.")
      (= terminal-kind :died)
      (str (red (str "F1 — API-death mid-lane; " summary "."))
           " agent_death recorded. Remedy: re-dispatch the thread (idempotent); enable AGENT_ESCALATE=1 for chronic deaths; read the partial result first.")
      (= terminal-kind :died-unreported)
      (str (red (str "F3 — silent death; " summary "."))
           " The lease/telemetry missed the death; trust the reactor verdict.")
      (= terminal-kind :stopped)
      (str (red (str "terminal execution did not succeed; " summary "."))
           (when online " The still-live lease is stale presence, not evidence of healthy execution."))
      (and (seq deaths) (not terminal?))
      (str (red "F1/F3 — death notification received but execution remains unresolved.")
           " A notification is diagnostic only; require a committed lane terminal or committed run before treating the lane as finished.")
      (and on-roster (not terminal?) (not online))
      (str (red "F2/F3 — offline with NO completion signal.")
           (if lease " Lease lapsed but still present:" " Lease gone entirely (expired + reaped, or never leased):")
           " if the transcript moved after the lease expiry → F2 (lapsed-but-alive): trust the transcript. Else it died silently — the reactor reaps it as died-unreported within 30min (confirm: `north show @agent:"
           id "` for outcome=died-unreported).")
      (and (= lineage :sdk-lane) (not identity-complete))
      (red "F6 — SDK-lane missing identity facts: possible id-collision/aliasing, or writeAgentFacts failed. Check `north show @agent:<id>` for contradictory repos/goals.")
      (and (= terminal-kind :ran) online)
      (grn (str "healthy — " summary "; lease remains online. No failure."))
      (= terminal-kind :ran)
      (grn (str "healthy — " summary "; lease lapsed as expected. No failure."))
      online
      (grn "healthy — online and advancing (no terminal signal yet). No failure.")
      :else (dim "no failing stage detected."))))

;; ---- render one stage line ---------------------------------------------------
(defn stage [n mark label detail cmd]
  (let [g (case mark :ok (grn "✓") :na (dim "·") :fail (red "✗"))]
    (format "%s %-11s %s %-46s %s" g label (str "") (str detail) (dim cmd))))

(defn -main [args]
  (let [raw (first args)]
    (when (str/blank? raw)
      (println (red "usage:") "north trace <agent-id>") (System/exit 2))
    (let [id (str/replace raw #"^@?(agent:)?" "")
          probe (try (send-op PORT {:op :version}) (catch Exception _ ::down))]
      (when (= probe ::down)
        (println (red (str "north trace — coordinator :" PORT " unreachable"))) (System/exit 1))
      (let [facts (agent-facts id)
            kind (get facts "kind")
            l (lease id)
            online (boolean (and l (> (:exp l) NOW)))
            lapse (when (and l (not online)) (- NOW (:exp l)))
            sess-agent (resolved PORT (str "@session:" id) "agent")
            on-roster (boolean (or kind sess-agent l))
            ;; managed identity is valid only after exact readback + marker commit
            identity-defects (when (= kind "lane")
                               (north.agent-provenance/identity-defects facts))
            idfull (and (= kind "lane") (empty? identity-defects))
            ;; lineage
            lineage (cond (= kind "session") :session
                          (= kind "lane")    :sdk-lane
                          (= kind "cron")    :cron
                          (and on-roster (nil? kind)) :corrupt-managed
                          :else :unknown)
            id-expect (case lineage :sdk-lane "committed full projection"
                            :session "partial native (kind+repo)"
                            :corrupt-managed "CORRUPT (rostered without kind/manifest)"
                            :cron "partial" "unknown")
            ;; work
            concerns (owned-concerns id)
            active-concern (first (filter #(= (:status %) "building") concerns))
            tx (transcript id)
            ;; completion / death
            runs (agent-runs id)
            last-run (last runs)
            deaths (deaths-for id)
            terminal-state (execution-terminal-state facts last-run deaths)
            terminal? (:terminal? terminal-state)
            terminal-kind (:kind terminal-state)
            delivery-state (terminal-delivery-state facts terminal-state)
            inbox (inbox-to id)]
        ;; header
        (println (str (bold "north trace ") (bold id) "  ·  :" PORT))
        (println (str "lineage  " (name lineage) "   " (dim (str "(expects: " id-expect ")"))))
        (println)
        ;; 1 ROSTER
        (println (stage 1 (if on-roster :ok :fail) "1 ROSTER"
                        (if on-roster (str "on roster (" id ")")
                            (red "NOT on roster — no lease / identity / session"))
                        "north agents"))
        ;; 2 IDENTITY
        (let [mark (cond idfull :ok
                         (= lineage :sdk-lane) :fail
                         (= lineage :corrupt-managed) :fail
                         :else :na)
              provenance (north.agent-provenance/provenance-detail facts)
              detail (cond idfull (str "kind=" kind " role=" (get facts "role")
                                       " " (identity-route-detail facts)
                                       " " (:label provenance)
                                       (when-let [co (get facts "coordinator")] (str " coord=" co)))
                           (= lineage :sdk-lane) (str "CORRUPT: " (str/join ", " identity-defects))
                           (= kind "session") (str "kind=session repo=" (or (get facts "repo") "?")
                                                   " gaffer:not-selected (native — expected)")
                           (= lineage :corrupt-managed) "CORRUPT: roster evidence without managed identity kind"
                           :else "absent")]
          (println (stage 2 mark "2 IDENTITY" detail (str "north show @agent:" id)))
          (when (= lineage :sdk-lane)
            (println (str "    composition  " (:label provenance)))
            (case (:kind provenance)
              "preset" (when (seq (:overrides provenance))
                         (println (str "    override     " (str/join "," (:overrides provenance))
                                       " · why: " (:override-reason provenance))))
              "bespoke" (do
                          (println (str "    why          " (or (:why provenance) "MISSING")))
                          (when-let [nearest (:nearest-reference-only provenance)]
                            (println (str "    nearest      gaffer:" nearest " (reference only; no inherited authority)")))
                          (println (str "    promotion    " (or (:promotion-candidate provenance) "MISSING")))
                          (println (str "    contract     sha256:" (or (:contract-sha256 provenance) "MISSING"))))
              nil)))
        ;; 3 PRESENCE — lapsed is a FAILURE only if the agent is NOT terminal (still supposed to be alive)
        (let [mark (cond online :ok
                         (nil? l) (if terminal? :na :fail)
                         terminal? :na                         ; finished => lapsed is the healthy end-state
                         :else :fail)
              detail (cond online (str (grn "ONLINE") " expires " (int (/ (- (:exp l) NOW) 1000)) "s")
                           (nil? l) (if terminal? "no lease (finished/never-registered)" (red "no lease found"))
                           :else (str "lapsed " (ago lapse) " ago"
                                      (when terminal? (dim " (finished — expected)"))))]
          (println (stage 3 mark "3 PRESENCE" detail "north agents")))
        ;; 4 WORK
        (let [mark (if (or active-concern tx (seq concerns)) :ok :na)
              detail (str (if active-concern
                            (str "concern " (:status active-concern) " [" (or (:repo active-concern) "?") "]")
                            (if (seq concerns) (str (count concerns) " concern(s)") "no concern"))
                          (if tx (str " · transcript " (ago (- NOW (:mtime tx))) " old, " (:size tx) "b")
                              (dim " · no transcript")))]
          (println (stage 4 mark "4 WORK" detail
                          (if active-concern (str "concern ls " (or (:repo active-concern) "")) (str "north watch " id)))))
        ;; 5 STEER
        (println (stage 5 :na "5 STEER"
                        (if (pos? inbox) (str inbox " message(s) addressed to it") (dim "none sent"))
                        (str "bb " NORTH "/cli/msg-cli.clj " PORT " inbox " id)))
        ;; 6 COMPLETION / DEATH
        (let [death-notification (last deaths)
              mark (cond (= terminal-kind :ran) :ok
                         terminal-kind :fail
                         death-notification :fail
                         online :na
                         :else :fail)
              detail (case terminal-kind
                       :ran (str (grn (terminal-summary terminal-state delivery-state))
                                 (when last-run (str " " (ago (- NOW (:ms last-run))) " ago")))
                       :died (str (red (terminal-summary terminal-state delivery-state))
                                  (when death-notification
                                    (str " · notification: \"" (:reason death-notification) "\"")))
                       :died-unreported
                       (red (str (terminal-summary terminal-state delivery-state)
                                 " (reactor-reaped silent death)"))
                       :stopped (ylw (terminal-summary terminal-state delivery-state))
                       (cond
                         death-notification
                         (str (red "agent_death notification without committed terminal")
                              ": \"" (:reason death-notification) "\"")
                         online (dim "still running — no terminal signal yet")
                         :else (red "NO committed completion terminal (offline, unrecorded)")))]
          (println (stage 6 mark "6 COMPLETION" detail "north show @swarm")))
        ;; 7 REAPING
        (let [stale-concern (first (filter #(and (= (:status %) "building")) concerns))
              detail (str (cond online "live — not reaped"
                                terminal? (str "lease lapsed" (when (= terminal-kind :died-unreported) " · reactor reaped"))
                                (nil? l) "no lease (lapsed + reaped, or never leased) — awaiting reactor verdict"
                                :else (str "lease lapsed " (ago lapse) " — awaiting reap"))
                          (when (and stale-concern (not online))
                            (ylw (str " · concern still " (:status stale-concern) " (STALE)"))))]
          (println (stage 7 :na "7 REAPING" detail "north agents / concern ls")))
        (println)
        ;; ---- verdict (first genuine failure + F-mode) ----
        (let [verdict
              (trace-verdict
               {:id id :on-roster on-roster :terminal-state terminal-state
                :delivery-state delivery-state :online online :lease l
                :lineage lineage :identity-complete idfull :deaths deaths})]
          (println (str (bold "verdict: ") verdict)))))
    (System/exit 0)))

(when-not (= "1" (System/getProperty "north.trace.lib"))
  (try (-main (vec *command-line-args*))
       (catch Throwable t
         (binding [*out* *err*] (println (str "north trace: " (.getMessage t))))
         (System/exit 1))))
