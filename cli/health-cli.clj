#!/usr/bin/env bb
;; health-cli.clj — `north health`: the aggregate coordination rollup.
;;
;; READ-ONLY. ONE bounded LIVE-STATE snapshot assembled from fourteen indexed
;; predicate reads. It surfaces the four durable failure families the
;; coordination-v2 work already lands on :7977, so failures show even when the
;; spawning session is long gone:
;;   1. lane outcomes      run-<agent>-<ts>  kind=run  outcome=ran|died|resource_envelope_exceeded|error
;;   2. reported deaths     @swarm            agent_death "<id> | <reason> | <ts>"  (death.notifyDeath)
;;   3. silent hard-kills   @agent:<id>       outcome=died-unreported               (reactor.sweep-lanes!)
;;   4. stale/handoff concerns  (the same renewable-lease liveness DECAY as `concern ls`)
;; plus ping-loss (a lane carried a `coordinator` fact but landed no COMPLETE/DEATH
;; ping) and a zombie-fork scan (F4: an agent-handle git author absent from the roster).
;;
;; NO new predicates: this is a VIEW over facts that already exist. Degrades to a
;; single line if :7977 is unreachable — never hangs, never throws out.
;;   usage: north health [--forks-since <hours>]   (default fork scan window 24h)
(require '[clojure.java.io :as io] '[clojure.string :as str]
         '[babashka.process :as p])
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/terminal-projection.clj"))
(def send-op  north.coord/send-op)

(def HOME (System/getenv "HOME"))
(def PORT (Integer/parseInt (or (System/getenv "NORTH_PORT") "7977")))

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

;; ---- bounded live-state snapshot -------------------------------------------
;; Health is a whole-corpus view. Asking the coordinator for each subject made
;; runtime grow with roster history (688 run rows took >30s). A raw log fold is
;; also subtly wrong: declared-single supersession is an engine rule and need
;; not append an explicit retract. Fetch each required predicate in one indexed,
;; single-clause query instead (a fixed 12 reads, independent of roster size).
;; The returned rows are LIVE engine state; sets preserve genuine conflicts so
;; lifecycle projection still fails closed.
(def health-predicates
  ["kind" "agent" "at" "outcome" "process_outcome" "delivery_outcome"
   "delivery_reason" "delivery_evidence" "delivery_evidence_sha256"
   "delivery_attestation" "delivery_attestation_sha256"
   "terminal_manifest_sha256" "coordinator" "from" "subject"
   "agent_death" "reached" "lease"])

(defn add-predicate-rows [facts predicate rows]
  (reduce (fn [current [entity value]]
            (update-in current [entity predicate] (fnil conj #{}) value))
          facts rows))

(defn live-health-facts [port]
  (reduce
   (fn [facts predicate]
     (add-predicate-rows
      facts predicate
      (north.coord/agg-rows
       port ["e" "r"]
       [{:rel "triple" :args [{:var "e"} predicate {:var "r"}]}])))
   {}
   health-predicates))

(defn run-row-from-facts [entity facts]
  (let [outcome (north.terminal-projection/committed-run-process-outcome facts)
        agent (north.terminal-projection/singleton-value facts "agent")
        at (north.terminal-projection/singleton-value facts "at")]
    (when (and outcome agent) [entity agent outcome at])))

(defn lane-outcome-from-facts [entity facts]
  (when (= "lane" (north.terminal-projection/singleton-value facts "kind"))
    (when-let [outcome (north.terminal-projection/terminal-process-outcome facts)]
      [entity outcome])))

(defn run-rows [facts]                ; [[run-id agent outcome at] ...] — every committed run
  (->> facts
       (keep (fn [[entity subject-facts]]
               (run-row-from-facts entity subject-facts)))
       vec))

(defn lane-outcome-rows [facts]       ; [[@agent:id outcome] ...] — committed lane terminals
  (->> facts
       (keep (fn [[entity subject-facts]]
               (lane-outcome-from-facts entity subject-facts)))))

(defn coord-lane-rows [facts]         ; [[@agent:id coordinator] ...] — lanes carrying a coordinator
  (->> facts
       (keep (fn [[entity subject-facts]]
               (when (and (= "lane" (north.terminal-projection/singleton-value subject-facts "kind"))
                          (north.terminal-projection/singleton-value subject-facts "coordinator"))
                 [entity (north.terminal-projection/singleton-value subject-facts "coordinator")])))))

(defn signal-senders [facts]          ; set of agent ids that landed a COMPLETE/DEATH ping
  (->> facts
       vals
       (keep (fn [subject-facts]
               (let [from (north.terminal-projection/singleton-value subject-facts "from")
                     subject (north.terminal-projection/singleton-value subject-facts "subject")]
                 (when (and from subject (str/starts-with? subject "AGENT ")) from))))
       set))

(defn agent-ids [facts]               ; every id known to the roster/@agent facts
  (->> facts
       (keep (fn [[entity subject-facts]]
               (when (north.terminal-projection/singleton-value subject-facts "kind") entity)))
       (map str)
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

;; ---- concerns: same liveness DECAY contract as `concern ls` ----------------
(def concern-maturity ["exploring" "building" "likely-to-land" "landed"])
(def concern-maturity-index
  (into {} (map-indexed (fn [index status] [status index]) concern-maturity)))

(defn concern-status-from-facts [subject-facts]
  (let [reached (get subject-facts "reached" #{})]
    (if (seq reached)
      (last (sort-by #(get concern-maturity-index % -1) reached))
      "building")))

(defn concern-owner-online? [facts subject-facts now]
  (let [agent (north.terminal-projection/singleton-value subject-facts "agent")]
    (if (str/blank? agent)
      true
      (let [handle (if (str/starts-with? agent "@") (subs agent 1) agent)
            lease-value (north.terminal-projection/singleton-value
                         (get facts (str "@lease:session:" handle) {}) "lease")
            lease (north.coord/decode-lease lease-value)]
        (boolean (and lease (> (:exp lease) now)))))))

(defn concern-counts [facts now]
  (let [rows (->> facts
                  (keep (fn [[_ subject-facts]]
                          (when (= "concern"
                                   (north.terminal-projection/singleton-value
                                    subject-facts "kind"))
                            (let [status (concern-status-from-facts subject-facts)]
                              (when-not (= status "landed")
                                {:status status
                                 :abandoned (contains? (get subject-facts "reached" #{})
                                                       "abandoned-stale")
                                 :online (concern-owner-online? facts subject-facts now)}))))))
        active (remove :abandoned rows)]
    {:active (count active)
     :stale (count (filter #(and (not (:online %))
                                 (not= (:status %) "likely-to-land"))
                           active))
     :handoff (count (filter #(and (not (:online %))
                                   (= (:status %) "likely-to-land"))
                             active))
     :retired (- (count rows) (count active))}))

(defn concern-line [facts now]
  (let [{:keys [active stale handoff retired]} (concern-counts facts now)]
    (str active " active · " (ylw (str stale " STALE")) " (owner lapsed) · "
         handoff " HANDOFF (likely-to-land) · "
         retired " abandoned-stale retired")))

;; ---- zombie forks (F4): agent-handle git authors absent from the roster --------
(def known-repos ["north" "convoy" "fram" "gaffer" "nixos-config" "beagle"])
(def handle-shape #"^(lane-|sdk-|session-|cc-|dispatch-|agent-)")
(defn zombie-forks [facts since-h]
  (let [known (agent-ids facts)]
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
        (println (red (str "north health — coordinator :" PORT " unreachable (is `north up` running?)")))
        (System/exit 0)))
    (println (str (bold "north health") "  ·  :" PORT "  ·  " (str (java.time.Instant/now))))
    (println)
    ;; One fixed live-state snapshot gives every section conflict-aware rows.
    (let [facts (live-health-facts PORT)
          rr  (run-rows facts)
          lor (lane-outcome-rows facts)]
    ;; 1. lane outcomes, windowed
    (println (format "%-10s 24h  %s        7d  %s"
                     "lanes" (fmt-runs (bucket-runs rr now DAY)) (fmt-runs (bucket-runs rr now WEEK))))
    ;; 2/3. deaths — reported (agent_death, with reason, 7d) + silent (died-unreported, durable total)
    (let [deaths (->> (get-in facts ["@swarm" "agent_death"] #{})
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
    (println (format "%-10s %s" "concerns" (concern-line facts now)))
    ;; 5. ping-loss
    (let [coord-lanes (coord-lane-rows facts)
          ids (map (fn [[e _]] (subs (str e) (count "@agent:"))) coord-lanes)
          senders (signal-senders facts)
          ended? (let [ran-agents (set (keep (fn [[_ agent outcome _]]
                                                (when outcome agent))
                                              rr))
                       du (set (map (fn [[e _]] (subs (str e) (count "@agent:")))
                                    (filter (fn [[_ o]] (= o "died-unreported")) lor)))]
                   (fn [id] (or (contains? ran-agents id) (contains? du id))))
          signalled (count (filter senders ids))
          lost (count (filter #(and (ended? %) (not (senders %))) ids))]
      (println (format "%-10s %d lanes carried a coordinator · %d signalled · %s%s"
                       "pings" (count ids) signalled (if (pos? lost) (ylw (str lost " lost")) "0 lost")
                       (if (zero? (count ids)) (dim "  [coordinator persisted from 2026-07-09 — pre-existing lanes carry none]") ""))))
    ;; 6. zombie forks
    (let [z (zombie-forks facts since-h)]
      (println (format "%-10s %s" "forks"
                       (if (empty? z)
                         (str "0 zombie (no agent-handle git author absent from roster, last " since-h "h)")
                         (red (str (count z) " zombie: " (str/join " " (sort z))
                                   " — agent-handle git author(s) absent from roster (F4)")))))))) ; +1 closes rr/lor let
  (System/exit 0))

(when-not (= "1" (System/getProperty "north.health.lib"))
  (try (-main (vec *command-line-args*))
       (catch Throwable t
         (binding [*out* *err*] (println (str "north health: " (.getMessage t))))
         (System/exit 1))))
