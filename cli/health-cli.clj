#!/usr/bin/env bb
;; health-cli.clj — `tern health`: the aggregate coordination rollup.
;;
;; READ-ONLY. ONE fold over the DURABLE append-only log — coord.clj's doctrine
;; ("everything countable is a fold over an append-only log, never a mutated cell").
;; It surfaces the four durable failure families the coordination-v2 work already
;; lands on :7977, so failures show even when the spawning session is long gone:
;;   1. lane outcomes      run-<agent>-<ts>  kind=run  outcome=ran|died|budget_*   (telemetry.recordRun)
;;   2. reported deaths     @swarm            agent_death "<id> | <reason> | <ts>"  (death.notifyDeath)
;;   3. silent hard-kills   @agent:<id>       outcome=died-unreported               (reactor.sweep-lanes!)
;;   4. stale/handoff concerns  (composed over `concern ls` — its own liveness DECAY, not re-derived)
;; plus ping-loss (a lane carried a `coordinator` fact but landed no COMPLETE/DEATH
;; ping) and a zombie-fork scan (F4: an agent-handle git author absent from the roster).
;;
;; NO new predicates: this is a VIEW over facts that already exist. Degrades to a
;; single line if :7977 is unreachable — never hangs, never throws out.
;;   usage: tern health [--forks-since <hours>]   (default fork scan window 24h)
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str]
         '[babashka.process :as p])
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op  tern.coord/send-op)
(def resolved tern.coord/resolved)
(def many     tern.coord/many)

(def HOME (System/getenv "HOME"))
(def TERN (str HOME "/code/tern"))
(def PORT (Integer/parseInt (or (System/getenv "TERN_PORT") "7977")))

;; ANSI only on a real TTY; piped/captured (the convoy pane parses this) stays plain.
(def use-color? (some? (System/console)))
(defn c [code s] (if use-color? (str "\033[" code "m" s "\033[0m") (str s)))
(defn dim [s] (c "2" s)) (defn bold [s] (c "1" s)) (defn ylw [s] (c "33" s)) (defn red [s] (c "31" s))

(defn iso->ms [s] (try (.toEpochMilli (java.time.Instant/parse (str s))) (catch Exception _ nil)))
(defn ago [ms]
  (if (nil? ms) "?"
    (let [s (quot ms 1000)]
      (cond (< s 60) (str s "s") (< s 3600) (str (quot s 60) "m")
            (< s 86400) (str (quot s 3600) "h") :else (str (quot s 86400) "d")))))

;; ---- durable folds (Datalog bodies over the log; project multi-column rows) ----
(defn rows [port project body]
  (:ok (send-op port {:op :query
        :query {:find "row"
                :rules [{:head {:rel "row" :args (mapv (fn [v] {:var v}) project)} :body body}]}})))

;; A LITERAL-anchored 1-clause fetch + per-entity `resolved` beats a multi-clause
;; join here by ~30x: on the coordinator's planner each extra join clause is a full
;; predicate scan (~1.4s/clause on a 155k-fact log), whereas `resolved` is
;; entity-indexed (~0.6ms). run-rows went 4.4s -> 0.15s; the kind=lane pair is
;; only 20 entities. This is what kept `tern health` inside the my-agents pane budget.
(defn ids-with [port pred val]        ; entity ids where pred=val (literal object, cheap)
  (map first (rows port ["e"] [{:rel "triple" :args [{:var "e"} pred val]}])))

(defn run-rows [port]                 ; [[run-id agent outcome at] ...] — every kind=run record
  (->> (ids-with port "kind" "run")
       (mapv (fn [e] [e (resolved port e "agent") (resolved port e "outcome") (resolved port e "at")]))))

(defn lane-outcome-rows [port]        ; [[@agent:id outcome] ...] — kind=lane carrying an outcome
  (->> (ids-with port "kind" "lane")
       (keep (fn [e] (when-let [o (resolved port e "outcome")] [e o])))))

(defn coord-lane-rows [port]          ; [[@agent:id coordinator] ...] — lanes that carried a coordinator
  (->> (ids-with port "kind" "lane")
       (keep (fn [e] (when-let [co (resolved port e "coordinator")] [e co])))))

(defn signal-senders [port]           ; set of agent ids that landed a COMPLETE/DEATH ping (@msg from-field)
  (->> (rows port ["from" "subj"]
             [{:rel "triple" :args [{:var "e"} "from" {:var "from"}]}
              {:rel "triple" :args [{:var "e"} "subject" {:var "subj"}]}])
       (filter (fn [[_ subj]] (str/starts-with? (str subj) "AGENT ")))
       (map first) set))

(defn agent-ids [port]                ; every id known to the roster/@agent facts (fork-scan allow-list)
  (->> (rows port ["e"] [{:rel "triple" :args [{:var "e"} "kind" {:var "k"}]}])
       (map first) (map str)
       (filter #(str/starts-with? % "@agent:"))
       (map #(subs % (count "@agent:"))) set))

;; ---- window buckets ----------------------------------------------------------
(defn bucket-runs [run-rows now win-ms]
  (reduce (fn [m [_ _ o t]]
            (let [ms (iso->ms t)]
              (if (and ms (>= ms (- now win-ms)))
                (update m (cond (= o "ran") :ran (= o "died") :died :else :stopped) (fnil inc 0))
                m)))
          {:ran 0 :died 0 :stopped 0} run-rows))

(defn fmt-runs [{:keys [ran died stopped]}]
  (str ran " ran · " died " died" (when (pos? stopped) (str " · " stopped " stopped"))))

;; ---- concerns: COMPOSE over `concern ls` (its own liveness DECAY, not re-derived) ----
(defn concern-line []
  (let [r (try (deref (p/process [(str TERN "/bin/concern") "ls"] {:out :string :err :string})
                      4000 nil)
               (catch Exception _ nil))
        header (some-> r :out str/split-lines first)]
    (if (and header (str/includes? header "ACTIVE CONCERNS"))
      ;; header form: "ACTIVE CONCERNS — N  [s STALE: ...]  [h HANDOFF: ...]  [r abandoned-stale retired ...]"
      (let [num  (fn [re] (some-> (re-find re header) second))
            act  (num #"—\s*(\d+)")
            stale (or (num #"\[(\d+) STALE") "0")
            hand  (or (num #"\[(\d+) HANDOFF") "0")
            retd  (or (num #"\[(\d+) abandoned-stale") "0")]
        (str (or act "?") " active · " (ylw (str stale " STALE")) " (owner lapsed) · "
             hand " HANDOFF (likely-to-land) · " retd " abandoned-stale retired"))
      (dim "concern ls unavailable"))))

;; ---- zombie forks (F4): agent-handle git authors absent from the roster --------
(def known-repos ["tern" "convoy" "fram" "gaffer" "nixos-config" "beagle"])
(def handle-shape #"^(lane-|sdk-|session-|cc-|dispatch-|agent-)")
(defn zombie-forks [port since-h]
  (let [known (agent-ids port)]
    (->> known-repos
         (mapcat (fn [repo]
           (let [dir (str HOME "/code/" repo)]
             (when (.exists (io/file dir ".git"))
               (let [r (try (deref (p/process ["git" "-C" dir "log" (str "--since=" since-h ".hours")
                                               "--format=%an|%ae"] {:out :string :err :string})
                                   3000 nil) (catch Exception _ nil))]
                 (some->> r :out str/split-lines (remove str/blank?)
                          (mapcat #(str/split % #"\|")) ))))))
         (map str/trim) distinct
         (filter #(re-find handle-shape %))
         (remove known)                 ; on the roster / has @agent facts => not a zombie
         set)))

;; ---- the rollup --------------------------------------------------------------
(defn -main [args]
  (let [flags (set args)
        since-h (or (some->> args (drop-while #(not= % "--forks-since")) second parse-long) 24)
        now (System/currentTimeMillis)
        DAY 86400000, WEEK (* 7 DAY)]
    ;; connectivity probe: one cheap read. Down => single honest line, exit 0.
    (let [probe (try (send-op PORT {:op :version}) (catch Exception e ::down))]
      (when (= probe ::down)
        (println (red (str "tern health — coordinator :" PORT " unreachable (is `tern up` running?)")))
        (System/exit 0)))
    (println (str (bold "tern health") "  ·  :" PORT "  ·  " (str (java.time.Instant/now))))
    (println)
    ;; Fold the two expensive joins over the 155k-fact log ONCE, then reuse. run-rows
    ;; (4-way join) and lane-outcome-rows each fed multiple sections before — recomputing
    ;; them per-section made `tern health` a ~12s command that always timed out the
    ;; my-agents 4s pane. One fold each keeps it inside the pane budget.
    (let [rr  (run-rows PORT)
          lor (lane-outcome-rows PORT)]
    ;; 1. lane outcomes, windowed
    (println (format "%-10s 24h  %s        7d  %s"
                     "lanes" (fmt-runs (bucket-runs rr now DAY)) (fmt-runs (bucket-runs rr now WEEK))))
    ;; 2/3. deaths — reported (agent_death, with reason, 7d) + silent (died-unreported, durable total)
    (let [deaths (->> (many PORT "@swarm" "agent_death")
                      (keep (fn [line] (let [[id reason ts] (map str/trim (str/split (str line) #"\|" 3))]
                                         (when id {:id id :reason reason :ms (iso->ms ts)}))))
                      (sort-by #(or (:ms %) 0)))
          d7 (filter #(and (:ms %) (>= (:ms %) (- now WEEK))) deaths)
          silent (->> lor (filter (fn [[_ o]] (= o "died-unreported"))) count)
          last-d (last deaths)]
      (println (format "%-10s 7d  %d reported (agent_death, with reason) · %s"
                       "deaths" (count d7)
                       (str (if (pos? silent) (ylw (str silent)) "0") " silent (died-unreported, reactor-reaped)")))
      (when last-d
        (println (format "%-10s last death  %s — \"%s\" — %s ago" ""
                         (:id last-d) (:reason last-d) (ago (when (:ms last-d) (- now (:ms last-d))))))))
    ;; 4. concerns (composed)
    (println (format "%-10s %s" "concerns" (concern-line)))
    ;; 5. ping-loss
    (let [coord-lanes (coord-lane-rows PORT)
          ids (map (fn [[e _]] (subs (str e) (count "@agent:"))) coord-lanes)
          senders (signal-senders PORT)
          ended? (let [ran-agents (set (map second rr))
                       du (set (map (fn [[e _]] (subs (str e) (count "@agent:")))
                                    (filter (fn [[_ o]] (= o "died-unreported")) lor)))]
                   (fn [id] (or (contains? ran-agents id) (contains? du id))))
          signalled (count (filter senders ids))
          lost (count (filter #(and (ended? %) (not (senders %))) ids))]
      (println (format "%-10s %d lanes carried a coordinator · %d signalled · %s%s"
                       "pings" (count ids) signalled (if (pos? lost) (ylw (str lost " lost")) "0 lost")
                       (if (zero? (count ids)) (dim "  [coordinator persisted from 2026-07-09 — pre-existing lanes carry none]") ""))))
    ;; 6. zombie forks
    (let [z (zombie-forks PORT since-h)]
      (println (format "%-10s %s" "forks"
                       (if (empty? z)
                         (str "0 zombie (no agent-handle git author absent from roster, last " since-h "h)")
                         (red (str (count z) " zombie: " (str/join " " (sort z))
                                   " — agent-handle git author(s) absent from roster (F4)")))))))) ; +1 closes rr/lor let
  (System/exit 0))

(try (-main (vec *command-line-args*))
     (catch Throwable t
       (binding [*out* *err*] (println (str "tern health: " (.getMessage t))))
       (System/exit 1)))
