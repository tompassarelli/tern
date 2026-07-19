#!/usr/bin/env bb
;; north dashboard / doctor — the cockpit over the agentic stack (fram · north ·
;; gaffer · beagle/firn). Ported from convoy/bin/my-agents (2026-07-10): convoy
;; folded into north — dashboard answers "what is happening", doctor answers "is
;; everything healthy". Both WRAP primitives and PRINT the one they run: teach
;; the tool, don't hide it. Never re-derives doctrine, never owns state beyond
;; ~/.cache/north.
;;
;; Vocabulary law: facts (never claims), lanes/agents throughout.
;;
;;   north dashboard   → cmd-dashboard   (agents, concerns, board, daemons, health, profile)
;;   north doctor      → cmd-doctor      (coordinator handshake, daemons, health, rev skew, env, guard hooks)

(require '[babashka.process :as p]
         '[clojure.string :as str]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io])

(def HOME (System/getenv "HOME"))
;; this file lives in north/cli — NORTH is its repo root.
(def SCRIPT (or (System/getProperty "babashka.file") *file*))
(def NORTH (some-> SCRIPT io/file .getCanonicalFile .getParentFile .getParentFile str))
(def FRAM (or (System/getenv "FRAM_HOME") (str HOME "/code/fram")))
(def FRAM-BIN (or (System/getenv "FRAM_BIN") (str FRAM "/bin")))
(def NIXCFG (or (System/getenv "NIXOS_CONFIG_HOME") (str HOME "/code/nixos-config")))
(def AGENT-LOGDIR (str HOME "/.local/state/north/agents"))
(load-file (str NORTH "/cli/harness-state.clj"))
;; Shared reader for the reactor's durable last-sweep heartbeat (reactor writes it).
(load-file (str NORTH "/cli/reactor-heartbeat.clj"))
(def CACHE-DIR (str HOME "/.cache/north"))
(def PORT (or (System/getenv "NORTH_PORT") "7977"))
(def CACHE-SCOPE (str (hash (str (or (System/getenv "FRAM_LOG") "default") "|"
                                (or (System/getenv "FRAM_TELEMETRY_LOG") "") "|" PORT))))

;; A full coordinator doctor reads every active log byte and parses every projected
;; thread file. Its deadline therefore scales with that work instead of being a
;; fixed number that eventually loses to corpus growth. The contract grants 5s of
;; process/daemon overhead, then assumes at least 2 MiB/s of aggregate scan/fold
;; throughput and 2ms per projected file, bounded at two minutes. On the 2026-07-18
;; corpus (about 17 MiB + 1,528 files, measured 5.2s) this yields about 17s: enough
;; headroom for contention without turning a hung diagnostic into an unbounded wait.
(def MIB (* 1024 1024))
(def COORD-DOCTOR-BASE-MS 5000)
(def COORD-DOCTOR-PER-MIB-MS 500)
(def COORD-DOCTOR-PER-FILE-MS 2)
(def COORD-DOCTOR-MAX-MS 120000)

(defn- ceil-div [n d]
  (quot (+ n (dec d)) d))

(defn- log-workload [path]
  (let [f (when (seq path) (io/file path))]
    (if (and f (.isFile f))
      (.length f)
      0)))

(defn- thread-workload [path]
  (let [dir (when (seq path) (io/file path))]
    (if (and dir (.isDirectory dir))
      ;; Match fram.rt/list-md exactly: only direct *.md children participate
      ;; in the corpus fold, and CLAUDE.md is an instruction file rather than a
      ;; projected thread.
      (->> (or (seq (.listFiles dir)) [])
           (filter #(and (.isFile %)
                         (str/ends-with? (.getName %) ".md")
                         (not= (.getName %) "CLAUDE.md")))
           (reduce (fn [{:keys [bytes files]} f]
                     {:bytes (+ bytes (.length f))
                      :files (inc files)})
                   {:bytes 0 :files 0}))
      {:bytes 0 :files 0})))

(defn coord-doctor-workload
  "Bytes + projected-file count read by `north coord-doctor` in this environment."
  []
  (let [logs (->> [(or (System/getenv "FRAM_LOG")
                        (str HOME "/.local/state/north/facts.log"))
                   (System/getenv "FRAM_TELEMETRY_LOG")]
                  (remove str/blank?)
                  distinct)
        threads (or (System/getenv "FRAM_THREADS")
                    (str HOME "/.local/state/north/threads"))
        projected (thread-workload threads)]
    {:bytes (+ (:bytes projected) (reduce + 0 (map log-workload logs)))
     :files (:files projected)}))

(defn coord-doctor-timeout-ms
  "Bounded deadline for a full coordinator doctor workload."
  [{:keys [bytes files]}]
  (min COORD-DOCTOR-MAX-MS
       (+ COORD-DOCTOR-BASE-MS
          (* COORD-DOCTOR-PER-MIB-MS (ceil-div (max 0 (or bytes 0)) MIB))
          (* COORD-DOCTOR-PER-FILE-MS (max 0 (or files 0))))))

;; ---- ANSI (respect NO_COLOR / non-tty) --------------------------------------
(def color? (and (nil? (System/getenv "NO_COLOR"))
                 (not (System/getenv "NORTH_NO_COLOR"))))
(defn c [code s] (if color? (str "\033[" code "m" s "\033[0m") s))
(defn dim [s]  (c "2" s))
(defn bold [s] (c "1" s))
(defn grn [s]  (c "32" s))
(defn red [s]  (c "31" s))
(defn ylw [s]  (c "33" s))
(defn cyn [s]  (c "36" s))
(defn ok-x [b] (if b (grn "up") (red "down")))

;; ---- process helper: never hang; short timeout; degrade -----------------------
(defn run
  "Run argv, bounded by :timeout ms. Returns {:out :err :exit :ok} or
   {:timeout true :ok false} / {:error msg :ok false}. Never throws."
  [argv & {:keys [timeout in] :or {timeout 3000}}]
  (try
    (let [proc (p/process argv (cond-> {:out :string :err :string} in (assoc :in in)))
          res  (deref proc timeout ::timeout)]
      (if (= res ::timeout)
        (do (p/destroy-tree proc) {:timeout true :ok false})
        {:out (or (:out res) "") :err (or (:err res) "") :exit (:exit res)
         :ok (zero? (:exit res))}))
    (catch Exception e {:error (.getMessage e) :ok false})))

(defn coord-doctor-probe []
  (let [workload (coord-doctor-workload)
        timeout-ms (coord-doctor-timeout-ms workload)]
    (assoc (run [(str NORTH "/bin/north") "coord-doctor"] :timeout timeout-ms)
           :timeout-ms timeout-ms
           :workload workload)))

(defn echo-cmd
  "Print the underlying primitive being wrapped (teaching surface)."
  [& parts] (println (dim (str "» " (str/join " " parts)))))

;; ---- honest cache: slow-moving aggregates only, short TTL ---------------------
;; The single-threaded coordinator serializes every probe, so fan-out is capped
;; by the daemon, not by cores. The one dashboard-side lever is to keep the slowest
;; probe off that queue. `north health` is both the tallest pole (~2.3s) and the
;; slowest-moving data (24h lane aggregates + STALE concern count) -> cache it.
;; Never caches an error/timeout; the dashboard is a point-in-time snapshot so a
;; ~60s-stale 24h window is invisible. Doctor uses the uncached path (live check).
(defn cache-get
  "Cached value from CACHE-DIR/name if written within ttl-ms, else nil. Never throws."
  [name ttl-ms]
  (try
    (let [f (io/file CACHE-DIR (str CACHE-SCOPE "-" name))]
      (when (.exists f)
        (let [{:keys [ts val]} (edn/read-string (slurp f))]
          (let [age (- (System/currentTimeMillis) (or ts 0))]
            (when (and ts (>= age 0) (< age ttl-ms)) val)))))
    (catch Exception _ nil)))

(defn cache-put!
  "Persist val under CACHE-DIR/name with a timestamp; returns val. Never throws."
  [name val]
  (try
    (let [dir (io/file CACHE-DIR)
          f (io/file dir (str CACHE-SCOPE "-" name))]
      (.mkdirs dir)
      (.setReadable dir false false) (.setWritable dir false false) (.setExecutable dir false false)
      (.setReadable dir true true) (.setWritable dir true true) (.setExecutable dir true true)
      (spit f (pr-str {:ts (System/currentTimeMillis) :val val}))
      (.setReadable f false false) (.setWritable f false false) (.setExecutable f false false)
      (.setReadable f true true) (.setWritable f true true))
    (catch Exception _ nil))
  val)

;; ---- portable listener discovery: ss on Linux, lsof on Darwin ---------------
(defn listening-ports []
  (let [ss (run ["ss" "-tlnH"] :timeout 1500)]
    (if (:ok ss)
      (set (map second (re-seq #":(\d+)\s" (:out ss))))
      (let [lsof (run ["lsof" "-nP" "-iTCP" "-sTCP:LISTEN" "-Fn"] :timeout 1500)]
        (if (:ok lsof)
          (->> (str/split-lines (:out lsof))
               (keep #(some-> (re-find #":(\d+)$" %) second))
               set)
          #{})))))

(defn daemon-health []
  ;; Two daemons is the whole surface (2026-07-09): the fact coordinator and
  ;; the web cockpit. :7978/:7980 retired — modules deleted in nixos-config.
  (let [ports (listening-ports)]
    {:north (contains? ports PORT)     ; fact coordinator (the canonical log)
     :web  (contains? ports "8088")   ; bjs/Bun cockpit
     :ports ports}))

;; ---- presence: live agents --------------------------------------------------
;; CACHED 20s. `presence-online` starts from the bounded set of unexpired lease
;; facts and enriches only those rows; it never walks the lifetime registry of
;; lapsed sessions. The cache still insulates back-to-back dashboard renders and
;; brief contention on the shared coordinator. Only successful reads are cached.
(defn presence-rows []
  (or (cache-get "presence.edn" 20000)
      (let [r (run ["bb" (str NORTH "/cli/presence-cli.clj") PORT "presence-online"] :timeout 6000)]
        (cond
          (:timeout r) {:err "presence probe timed out"}
          (not (:ok r)) {:err "presence unavailable"}
          :else
          (let [lines (->> (str/split-lines (:out r))
                           (drop 1)                       ; header
                           (remove str/blank?))]
            (cache-put! "presence.edn"
              {:agents
               ;; PIN column is blank in data rows, so parse by semantics not position:
               ;; online = the yes|no token, expires = the <n>s|lapsed token.
               (doall
                (for [ln lines
                      :let [toks (str/split (str/trim ln) #"\s+")
                            agent (first toks)
                            online (some #{"yes" "no"} toks)
                            expires (some #(when (re-matches #"\d+s|lapsed" %) %) toks)
                            focus (last toks)]
                      :when (and agent (seq agent))]
                  {:id agent :online (= online "yes") :expires (or expires "?")
                   :focus (when-not (#{"-" online expires} focus) focus)}))}))))))

;; ---- concerns: active, grouped by repo --------------------------------------
(defn concern-rows
  "Active concerns grouped by repo. CACHED 90s. `concern ls --all` runs a decay
   projection over owner leases ON the coordinator — measured 12-24s on the current
   large log (NOT the ~2s an older comment assumed; log GROWTH pushed it past the
   old 8s timeout, so it timed out every render). Active concerns move slowly, so a
   point-in-time dashboard tolerates ~90s staleness. Cache miss runs with a 30s
   budget — it MUST exceed real cost or the probe can never seed. Only successful
   reads are cached; a timeout/error returns fresh and retries next run."
  []
  (or (cache-get "concerns.edn" 90000)
      (let [r (run [(str NORTH "/bin/concern") "ls" "--all"] :timeout 30000)]
        (if (or (:timeout r) (not (:ok r)))
          {:err "concern probe unavailable"}
          (cache-put! "concerns.edn"
            {:concerns
             (doall
              (for [ln (str/split-lines (:out r))
                    :let [m (re-matches #"\s+@(\S+)\s+(\S+)\s+(\S+)\s+\{.*" ln)]
                    :when m]
                (let [[_ id status repo] m] {:id id :status status :repo repo})))})))))

;; ---- board / ready counts ---------------------------------------------------
(defn board-counts []
  ;; The curated `north threads` header carries all counts on one line
  ;; ("THREADS — N open threads · N active · N ready · N blocked · N concerns"),
  ;; so one shell-out covers what used to need board+ready.
  (let [b (run [(str NORTH "/bin/north") "threads"] :timeout 4000)
        grab (fn [re] (when (:out b) (some-> (re-find re (:out b)) second)))]
    {:open   (grab #"THREADS\s+—\s+(\d+)\s+open")
     :active (grab #"(\d+)\s+active")
     :ready  (grab #"(\d+)\s+ready")
     :err    (when-not (:ok b) "board unavailable")}))

;; ---- agent facts: read @agent:<id> subjects from facts log -----------------
;; One file scan, not N shell-outs.  All agent predicates are single-valued.
;; Returns {id {pred val}} for every @agent:<id> subject seen.
(defn agent-facts-from-log []
  ;; Honor FRAM_LOG (the log split renames the coordination log to coordination.log) and,
  ;; when log-split routing is on, FOLD THE UNION of both logs — @agent:session-*
  ;; carry kind=session and route to telemetry.log, so a coordination-only read
  ;; would under-count agents. Safe to concat then fold: every @agent subject lives
  ;; entirely in ONE log, so no id's assert/retract sequence crosses logs.
  (let [paths (->> [(or (System/getenv "FRAM_LOG")
                        (str HOME "/.local/state/north/facts.log"))
                    (System/getenv "FRAM_TELEMETRY_LOG")]
                   (remove nil?)
                   (filter #(.exists (io/file %))))]
    (when (seq paths)
      (try
        (->> (mapcat #(str/split-lines (slurp %)) paths)
             (filter #(str/includes? % "\"@agent:"))   ; cheap pre-filter
             (keep (fn [ln]
                     (when-let [[_ subj] (re-find #":l\s+\"(@agent:[^\"]+)\"" ln)]
                       (let [id      (subs subj (count "@agent:"))
                             op      (some-> (re-find #":op\s+\"([^\"]+)\"" ln) second)
                             pred    (some-> (re-find #":p\s+\"([^\"]+)\"" ln) second)
                             ;; :r value — capture up to first unescaped quote boundary
                             val     (some-> (re-find #":r\s+\"((?:[^\"\\\\]|\\\\.)*)\"" ln) second)]
                         (when (and op pred)
                           {:id id :op op :pred pred :val (or val "")})))))
             (reduce (fn [acc {:keys [id op pred val]}]
                       (if (= op "assert")
                         (assoc-in acc [id pred] val)
                         (update acc id dissoc pred)))
                     {}))
        (catch Exception _ {})))))

(defn lookup-display
  "Return display_name from agfacts for agent id, or nil when no facts exist."
  [agfacts id]
  (get-in agfacts [id "display_name"]))

;; ---- north health probe -------------------------------------------------------
(defn north-health
  ;; Runs `north health`; never throws.
  ;; Returns {:raw "..."} on success or {:err "..."} on timeout/error/absent.
  ;; The dashboard's cache-miss path passes a generous budget: under a probe
  ;; burst the single-threaded coordinator serializes clients and health lands
  ;; last, so a tight budget times out and seeds nothing. Doctor runs it alone
  ;; and keeps the default.
  ([] (north-health 4000))
  ([timeout-ms]
   (let [r (run [(str NORTH "/bin/north") "health"] :timeout timeout-ms)]
     (cond
       (:ok r)      {:raw (:out r)}
       (:timeout r) {:err "timed out"}
       :else        {:err "unavailable"}))))

(defn parse-health
  "Extract key signals from north-health output: lanes ran/died (24h) + STALE concern count.
   Matches on leading label word so spacing/counts can vary freely."
  [{:keys [raw err]}]
  (if err
    {:err err}
    (let [lines   (str/split-lines (or raw ""))
          find-ln (fn [label]
                    (some #(when (re-find (re-pattern (str "(?i)^\\s*" label "\\b")) %) %) lines))
          lanes-ln    (find-ln "lanes")
          concerns-ln (find-ln "concerns")]
      {:lanes-ran-24h   (some-> (re-find #"24h\s+(\d+)\s+ran" (or lanes-ln "")) second parse-long)
       :lanes-died-24h  (some-> (re-find #"24h\s+\d+\s+ran\s+·\s+(\d+)\s+died" (or lanes-ln "")) second parse-long)
       :concerns-active (some-> (re-find #"(\d+)\s+active" (or concerns-ln "")) second parse-long)
       :concerns-stale  (some-> (re-find #"(\d+)\s+STALE" (or concerns-ln "")) second parse-long)})))

(defn dashboard-health
  "Health for the dashboard hot path: cached 300s (slow-moving 24h aggregates +
   STALE concern count). Cache miss runs with a 30s budget — `north health` folds
   the whole log with multi-clause Datalog and measures 21-24s on the current large
   log, so the old 8s budget ALWAYS timed out and NEVER seeded (every render lied
   'timed out'). The budget must EXCEED real cost or the cache can never warm; one
   slow seed reseeds for 5 min and every other pane speeds up too. Only successful
   reads are cached; a timeout/error returns fresh and retries next run. Doctor keeps
   the uncached, default-budget `(north-health)` path."
  []
  (or (cache-get "health.edn" 300000)
      (let [h (parse-health (north-health 30000))]
        (if (:err h) h (cache-put! "health.edn" h)))))

;; ---- profile: rung per layer ------------------------------------------------
(defn dispatch-mode []
  (north.harness-state/get-value HOME "dispatch" nil))

(defn code-status
  "fram-code-status for cwd -> parsed key=val map (level, canonical, coord...)."
  []
  (let [r (run [(str FRAM-BIN "/fram-code-status")] :timeout 3000)]
    (when (:ok r)
      (into {} (for [[_ k v] (re-seq #"(\w+)=(\S+)" (:out r))] [k v])))))

(defn graph-upstream-count []
  (let [f (io/file HOME ".config/fram/graph-upstream-files")]
    (if (.exists f)
      (count (remove str/blank? (str/split-lines (slurp f))))
      0)))

(defn profile-status []
  (let [mode  (or (dispatch-mode) "unknown")
        dh    (daemon-health)
        cs    (code-status)
        level (some-> (get cs "level") parse-long)
        canon (some-> (get cs "canonical") parse-long)
        owned (graph-upstream-count)
        ;; coordination layer (P1): north dispatch mode + coordinator up.
        p1?   (and (#{"north" "warn"} mode) (:north dh))
        ;; code-as-facts layer (P2): code-as-facts flipped for cwd repo
        p2?   (and level (>= level 3) (or (and canon (pos? canon)) (pos? owned)))
        rung  (cond p2? "P2" p1? "P1" :else "P0")]
    {:mode mode :daemons dh :level level :canonical canon :owned owned
     :p1 p1? :p2 p2? :rung rung :code-status cs}))

(defn source-revision
  "Packaged runtimes identify their immutable inputs; source runs use checkout HEAD."
  [name repo]
  (let [git-result (run ["git" "-C" repo "rev-parse" "--short" "HEAD"] :timeout 2000)
        git-rev (when (:ok git-result) (not-empty (str/trim (:out git-result))))
        package-rev (case name
                      "north" (System/getenv "NORTH_PACKAGE_REV")
                      "fram" (System/getenv "FRAM_PACKAGE_REV")
                      nil)]
    (cond
      (not-empty package-rev) {:revision package-rev :origin "package rev"}
      git-rev {:revision git-rev :origin "tree HEAD"}
      :else {:revision "?" :origin "source rev"})))

;; ============================================================================
;; COMMANDS
;; ============================================================================

(defn cmd-dashboard [_]
  ;; Two probe classes, sized to where the work actually happens:
  ;;   NON-coordinator probes parallelize freely — listener health, a log-file
  ;;   read (agent-facts), fram-code-status (profile). None touches :7977, so futures
  ;;   genuinely run at once.
  ;;   COORDINATOR-bound probes (board, presence, concern, health) all hit the SINGLE-
  ;;   THREADED daemon, which serializes them regardless. Firing them as concurrent
  ;;   futures therefore parallelizes NOTHING — it only randomizes queue order and
  ;;   inflates the tail (measured 2026-07-16: presence 3s alone -> 32s when fanned
  ;;   out behind concern+health). Run them ONE AT A TIME: identical wall-time under
  ;;   serialization, but each runs alone so its latency is bounded and fits a tight
  ;;   timeout instead of timing out. concern (90s) and health (300s) are cached, so
  ;;   steady-state this group is just board+presence (~4s); only a cold cache pays
  ;;   the one-time seed cost, and the seed no longer strangles presence.
  (let [f-daemon  (future (daemon-health))
        f-profile (future (profile-status))
        f-agfacts (future (agent-facts-from-log))
        bc     (board-counts)     ; ~1s, cheap coordinator header fetch
        pr     (presence-rows)    ; cached 20s; cold seed runs alone, no inflation
        cr     (concern-rows)     ; cached 90s; cold seed alone, not behind presence
        health (dashboard-health) ; cached 300s; cold seed alone
        dh @f-daemon, pf @f-profile
        agfacts (or @f-agfacts {})]
    (println (bold "north dashboard") (dim "— the cockpit over fram · north · gaffer"))
    (println)
    ;; agents (lead with active work)
    (let [live (filter :online (:agents pr))]
      (println (bold "agents") (dim (str "(" (count live) " live)")))
      (if (:err pr)
        (println "  " (ylw (:err pr)))
        (doseq [a (take 8 live)]
          (let [dn    (lookup-display agfacts (:id a))
                label (or dn (:id a))]
            (println (str "  " (grn "●") " " label
                          ;; display_name already ends with "(id)" — only append when absent
                          (when (and dn (not (str/includes? dn (:id a)))) (dim (str " (" (:id a) ")")))
                          (dim (str "  ttl " (:expires a)))
                          (when (:focus a) (str "  " (:focus a)))))))))
    (println)
    ;; concerns by repo
    (println (bold "concerns") (dim "(active, by repo)"))
    (if (:err cr)
      (println "  " (ylw (:err cr)))
      (let [by-repo (->> (:concerns cr) (group-by :repo)
                         (map (fn [[r cs]] [r (count cs)])) (sort-by (comp - second)))]
        (if (empty? by-repo)
          (println "  " (dim "none"))
          (doseq [[repo n] (take 8 by-repo)]
            (println (str "  " (cyn (format "%-10s" repo)) " " n))))))
    (println)
    ;; board summary
    (println (bold "board") (dim "» north threads"))
    (if (:err bc)
      (println "  " (ylw (:err bc)))
      (println (str "  " (or (:open bc) "?") " open"
                    "   " (or (:active bc) "?") " active"
                    "   " (or (:ready bc) "?") " ready")))
    (println)
    ;; daemons
    (println (bold "daemons"))
    (println (str "  " PORT " facts " (ok-x (:north dh))
                  "   8088 web " (ok-x (:web dh))))
    (println)
    ;; health — north health condensed (lanes ran/died + STALE concerns)
    (println (bold "health") (dim "» north health"))
    (if (:err health)
      (println (str "  " (dim (str "north health " (if (= (:err health) "timed out") "(timed out)" "(unavailable)")))))
      (let [{:keys [lanes-ran-24h lanes-died-24h concerns-active concerns-stale]} health
            died-part (when lanes-died-24h (str " · " (if (pos? lanes-died-24h) (ylw (str lanes-died-24h " died")) (str lanes-died-24h " died"))))
            stale-part (when (and concerns-stale (pos? concerns-stale)) (str " · " (ylw (str concerns-stale " STALE"))))]
        (println (str "  lanes   24h  " (or lanes-ran-24h "?") " ran" died-part
                      "     concerns  " (or concerns-active "?") " active" stale-part))))
    (println)
    ;; profile — how much of the stack is active in this directory
    (println (bold "profile"))
    (let [pad #(format "%-15s" %)
          on1 (:p1 pf)
          on2 (:p2 pf)]
      (println (str "  " (pad "coordination")
                    (if on1 (grn "on ") (dim "off"))
                    (dim (str "  " (if on1 "agents coordinate through facts"
                                          "stock harness, agents run solo")
                              "  (dispatch=" (:mode pf) ")"))))
      (println (str "  " (pad "code-as-facts")
                    (if on2 (grn "on ") (dim "off"))
                    (dim (str "  " (if on2 "code authored as graph facts"
                                          "code edited as text"))))))
    (println (dim "  north doctor  ·  north  (the card)"))))

(defn reactor-doctor-line
  "One-line reactor-sweep verdict from the durable last-sweep heartbeat for `port`.
   A running-vs-dead reactor is otherwise invisible in doctor: the :7977 daemon can
   be up while the reactor sidecar is stopped, so a fresh heartbeat is the ONLY proof
   sweeps are landing. STALE (>15min) and MISSING are LOUD [ERR]; a stopped reactor
   can never read healthy. `port` is NORTH_PORT-derived here — see reactor-heartbeat.clj
   on why the reactor's FRAM_PORT derivation is duplicated rather than shared (both 7977)."
  [port]
  (let [{:keys [state age-ms ts]} (north.reactor-heartbeat/heartbeat-status port)]
    (case state
      :fresh   (str (grn "[ok]  ") " last sweep "
                    (north.reactor-heartbeat/humanize-age age-ms) " ago (" ts ")")
      :stale   (str (red "[ERR] ") " reactor STALE — last sweep "
                    (north.reactor-heartbeat/humanize-age age-ms)
                    " ago (threshold 15m); reactor hung or stopped — `north reactor &`")
      :missing (str (red "[ERR] ") " reactor heartbeat MISSING — reactor has not swept "
                    "(never started or stopped); start it: `north reactor &`"))))

(defn cmd-doctor [_]
  (println (bold "north doctor"))
  ;; coordinator handshake — the engine-level safety verdict (tell/untell safe,
  ;; daemon state matches on-disk log). Ported north kept this as the session-start
  ;; handshake; doctor now leads with it. `north coord-doctor` is the raw primitive.
  (println (bold "  coordinator"))
  (echo-cmd (str NORTH "/bin/north") "coord-doctor")
  (let [{:keys [timeout timeout-ms workload ok out err error]} (coord-doctor-probe)]
    (cond
      timeout
      (println (str "    " (red "[ERR] ") " coord-doctor exceeded its "
                    timeout-ms "ms full-corpus budget ("
                    (ceil-div (:bytes workload) MIB) " MiB, " (:files workload)
                    " files) — probe incomplete; coordinator state was not inferred"))

      (not ok)
      (println (str "    " (red "[ERR] ") " coord-doctor failed"
                    (when (seq (str/trim (or error err "")))
                      (str ": " (str/trim (or error err ""))))))

      :else
      (doseq [ln (remove str/blank? (str/split-lines (str (or out "") (or err ""))))]
        (println (str "    " ln)))))
  ;; daemons
  (let [dh (daemon-health)]
    (println (bold "  daemons"))
    (doseq [[label k crit] [[(str PORT " facts (the coordinator — everything reads/writes here)") :north true]
                            ["8088 web (bjs/Bun cockpit)" :web false]]]
      (let [up (get dh k)]
        (println (str "    " (if up (grn "[ok]  ") (if crit (red "[ERR] ") (ylw "[warn]")))
                      " " label " " (ok-x up))))))
  ;; reactor sweep liveness — see reactor-doctor-line.
  (println (bold "  reactor sweep"))
  (println (str "    " (reactor-doctor-line PORT)))
  ;; health — lane activity + stale concerns from north health. LIVE (uncached, unlike
  ;; the dashboard's cached hot path) but with a budget that matches reality: `north
  ;; health` folds the whole log and takes ~21-24s, so the old 4s default always warned
  ;; "timed out". Doctor is a deliberate, occasional live check — eating one honest 30s
  ;; fold beats reporting a false timeout on a healthy coordinator.
  (println (bold "  health"))
  (echo-cmd (str NORTH "/bin/north") "health")
  (let [h (parse-health (north-health 30000))]
    (if (:err h)
      (println (str "    " (ylw "[warn] ") " north health " (:err h)))
      (let [{:keys [lanes-ran-24h lanes-died-24h concerns-active concerns-stale]} h
            died-part  (when lanes-died-24h (str " · " lanes-died-24h " died"))
            stale-part (when (and concerns-stale (pos? concerns-stale))
                         (str " · " concerns-stale " STALE concerns"))]
        (println (str "    " (grn "[ok]  ") " "
                      (or lanes-ran-24h "?") " ran" died-part " (24h)"
                      "   concerns  " (or concerns-active "?") " active" stale-part)))))
  ;; Runtime source identity (north + fram). A package revision identifies the
  ;; installed closure; a checkout HEAD is only source context, not proof that a
  ;; separately installed store path contains that tree.
  (println (bold "  runtime source identity"))
  (doseq [[name repo] [["north" NORTH] ["fram" FRAM]]]
    (let [{:keys [revision origin]} (source-revision name repo)
          command-result (run ["bash" "-c" "command -v \"$1\"" "north-doctor" name] :timeout 1500)
          which (when (:ok command-result)
                  (some-> (:out command-result) str/trim not-empty
                          io/file .getCanonicalPath))
          store (some->> which (re-find #"/nix/store/[^/]+"))]
      (println (str "    " (cyn name) "  " origin " " revision
                    "  installed " (or store which "?")))
      (when (and store (not (str/includes? (or which "") repo)))
        (println
         (dim
          (if (= origin "package rev")
            "         (installed via nix store; embedded package revision shown above)"
            "         (installed via nix store; tree HEAD is checkout context, not the store closure identity)"))))))
  ;; stale FRAM_LOG env pointing at a claims-named path
  (println (bold "  env hygiene"))
  (let [fl (System/getenv "FRAM_LOG")]
    (cond
      (nil? fl) (println (str "    " (grn "[ok]  ") " FRAM_LOG unset (north sets facts.log)"))
      (re-find #"(?i)claim" fl) (println (str "    " (red "[ERR] ") " FRAM_LOG points at claims-named path: " fl
                                              " — rename to facts.log"))
      :else (println (str "    " (grn "[ok]  ") " FRAM_LOG=" fl))))
  ;; guard hooks present
  (println (bold "  guard hooks"))
  (let [hookdir (str NIXCFG "/dotfiles/claude/hooks")
        settings (str HOME "/.claude/settings.json")
        stxt (when (.exists (io/file settings)) (slurp settings))]
    (doseq [h ["agent-spawn-guard.sh" "tripwire-guard.sh" "north-clock-guard.sh"]]
      (let [present (or (.exists (io/file hookdir h))
                        (some #(.exists (io/file hookdir %)) [(str h ".sh") h]))
            wired (and stxt (str/includes? stxt (str/replace h #"\.sh$" "")))]
        (println (str "    " (if present (grn "[ok]  ") (ylw "[warn]"))
                      " " (format "%-22s" h)
                      (if present "file present" "not found")
                      (when wired (dim "  · wired in settings.json"))))))))

;; ---- dispatch ---------------------------------------------------------------
(when-not (= (System/getenv "NORTH_DASHBOARD_LIB") "1")
  (let [[cmd & args] *command-line-args*]
    (case cmd
      (nil "dashboard") (cmd-dashboard args)
      "doctor"          (cmd-doctor args)
      (do (binding [*out* *err*] (println (red (str "dashboard-cli: unknown command: " cmd))))
          (System/exit 2)))))
