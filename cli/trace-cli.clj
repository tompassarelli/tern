#!/usr/bin/env bb
;; trace-cli.clj — `north trace <agent-id>`: single-agent lifecycle diagnosis.
;;
;; READ-ONLY. Walks the INVARIANT SPINE checklist (workflow-map §2) for ONE id and
;; flags the FIRST failing stage, printing the exact confirm command per stage. It is
;; LINEAGE-AWARE and TERMINALITY-AWARE — an absence that is EXPECTED for a lineage is
;; marked `·` not `✗` (dispatch lanes legitimately have no identity facts; a cleanly
;; FINISHED lane legitimately holds a lapsed lease). The verdict maps the failure to a
;; workflow-map F-mode (F1–F7) with the remedy.
;;
;;   ✓ present/healthy   · expected-absent / n-a   ✗ genuine failure
;;   usage: north trace <agent-id>
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str])
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op  north.coord/send-op)
(def resolved north.coord/resolved)
(def many     north.coord/many)
(def lease-of north.coord/lease-of)

(def HOME (System/getenv "HOME"))
(def NORTH (str HOME "/code/north"))
(def AGENT-LOGDIR (str HOME "/.local/state/north/agents"))
(def PORT (Integer/parseInt (or (System/getenv "NORTH_PORT") "7977")))
(def NOW (System/currentTimeMillis))

(def use-color? (some? (System/console)))
(defn c [code s] (if use-color? (str "\033[" code "m" s "\033[0m") (str s)))
(defn dim [s] (c "2" s)) (defn bold [s] (c "1" s)) (defn grn [s] (c "32" s))
(defn red [s] (c "31" s)) (defn ylw [s] (c "33" s)) (defn cyn [s] (c "36" s))

(defn iso->ms [s] (try (.toEpochMilli (java.time.Instant/parse (str s))) (catch Exception _ nil)))
(defn ago [ms] (if (nil? ms) "?"
  (let [s (quot ms 1000)]
    (cond (< s 60) (str s "s") (< s 3600) (str (quot s 60) "m")
          (< s 86400) (str (quot s 3600) "h") :else (str (quot s 86400) "d")))))

;; ---- per-id reads ------------------------------------------------------------
(defn afact [id p] (resolved PORT (str "@agent:" id) p))
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
      (let [kind (afact id "kind")
            l (lease id)
            online (boolean (and l (> (:exp l) NOW)))
            lapse (when (and l (not online)) (- NOW (:exp l)))
            sess-agent (resolved PORT (str "@session:" id) "agent")
            on-roster (boolean (or kind sess-agent l))
            ;; identity fullness
            idfull (and (afact id "role") (afact id "model"))
            ;; lineage
            lineage (cond (= kind "session") :session
                          (= kind "lane")    :sdk-lane
                          (= kind "cron")    :cron
                          (and on-roster (nil? kind)) :dispatch
                          :else :unknown)
            id-expect (case lineage :sdk-lane "full" :session "partial (kind+repo)"
                            :dispatch "none (dispatch writes no identity — expected)"
                            :cron "partial" "unknown")
            ;; work
            concerns (owned-concerns id)
            active-concern (first (filter #(= (:status %) "building") concerns))
            tx (transcript id)
            ;; completion / death
            runs (agent-runs id)
            last-run (last runs)
            deaths (deaths-for id)
            du (= "died-unreported" (afact id "outcome"))
            terminal? (boolean (or last-run (seq deaths) du))
            terminal-kind (cond du :died-unreported
                                (seq deaths) :died
                                (and last-run (= "ran" (:outcome last-run))) :ran
                                (and last-run (not= "ran" (:outcome last-run))) :stopped
                                :else nil)
            inbox (inbox-to id)]
        ;; header
        (println (str (bold "north trace ") (bold id) "  ·  :" PORT))
        (println (str "lineage  " (name lineage) "   " (dim (str "(identity: " id-expect ")"))))
        (println)
        ;; 1 ROSTER
        (println (stage 1 (if on-roster :ok :fail) "1 ROSTER"
                        (if on-roster (str "on roster (" id ")")
                            (red "NOT on roster — no lease / identity / session"))
                        "north agents"))
        ;; 2 IDENTITY
        (let [mark (cond idfull :ok
                         (= lineage :sdk-lane) :fail          ; a lane MUST have full identity
                         :else :na)
              detail (cond idfull (str "kind=" kind " role=" (afact id "role") " model=" (afact id "model")
                                       "-" (or (afact id "effort") "?")
                                       (when-let [co (afact id "coordinator")] (str " coord=" co)))
                           (= kind "session") (str "kind=session repo=" (or (afact id "repo") "?") " (partial — expected)")
                           (= lineage :dispatch) "none — dispatch lineage writes no @agent facts (expected)"
                           :else "absent")]
          (println (stage 2 mark "2 IDENTITY" detail (str "north show @agent:" id))))
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
        (let [mark (cond (= terminal-kind :ran) :ok
                         (nil? terminal-kind) (if online :na :fail)   ; not terminal + offline = missing signal
                         :else :fail)
              detail (case terminal-kind
                       :ran (str (grn "outcome=ran") (when last-run (str " " (ago (- NOW (:ms last-run))) " ago")))
                       :died (str (red "agent_death") ": \"" (:reason (last deaths)) "\"")
                       :died-unreported (red "outcome=died-unreported (reactor-reaped silent death)")
                       :stopped (str (ylw (str "outcome=" (:outcome last-run))))
                       (if online (dim "still running — no terminal signal yet")
                           (red "NO completion/death signal (offline, unrecorded)")))]
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
              (cond
                (not on-roster)
                (red "F4 — not on any roster: a zombie fork, a bad id, or an unmanaged actor. Confirm via git author vs `north agents`.")
                (= terminal-kind :died)
                (str (red "F1 — API-death mid-lane.") " agent_death recorded. Remedy: re-dispatch the thread (idempotent); enable AGENT_ESCALATE=1 for chronic deaths; read the partial result first.")
                (= terminal-kind :died-unreported)
                (str (red "F3 — died with no self-reported signal; reactor reaped it (outcome=died-unreported).") " The lease/telemetry missed the death; trust the reactor verdict.")
                (and on-roster (not terminal?) (not online))
                (str (red "F2/F3 — offline with NO completion signal.")
                     (if l " Lease lapsed but still present:" " Lease gone entirely (expired + reaped, or never leased):")
                     " if the transcript moved after the lease expiry → F2 (lapsed-but-alive): trust the transcript. Else it died silently — the reactor reaps it as died-unreported within 30min (confirm: `north show @agent:" id "` for outcome=died-unreported).")
                (and (= lineage :sdk-lane) (not idfull))
                (red "F6 — SDK-lane missing identity facts: possible id-collision/aliasing, or writeAgentFacts failed. Check `north show @agent:<id>` for contradictory repos/goals.")
                (and (= terminal-kind :ran) online)
                (grn "healthy — online; a completed run is recorded (outcome=ran). No failure.")
                (= terminal-kind :ran)
                (grn "healthy — completed cleanly (outcome=ran), lease lapsed as expected. No failure.")
                online
                (grn "healthy — online and advancing (no terminal signal yet). No failure.")
                :else (dim "no failing stage detected."))]
          (println (str (bold "verdict: ") verdict)))))
    (System/exit 0)))

(try (-main (vec *command-line-args*))
     (catch Throwable t (binding [*out* *err*] (println (str "north trace: " (.getMessage t)))) (System/exit 1)))
