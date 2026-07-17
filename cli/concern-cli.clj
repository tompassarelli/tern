;; concern-cli.clj — CONCERN-level coordination for parallel agents. NOT locks.
;;
;; An agent declares a CONCERN: a feature it is building + the footprint it touches.
;; Concerns COEXIST — declaring never blocks anyone. Overlap is DERIVED and surfaced, so
;; agents shape around each other and against what is LIKELY TO LAND (before it is in
;; main). N agents, one repo, fine.
;;
;; FOOTPRINT = CODE-GRAPH BLAST JOINS over node IDENTITY (thread 019f1010-2705). On a
;; FLIPPED Beagle repo (a warm fram code daemon is up), a concern's footprint is
;; `footprint` bridge facts FROM @concern:<id> TO @mod#n code NODES, asserted into the
;; repo's warm CODE store; "who else is in my footprint" is then a recursive reaches
;; :query (the daemon's :concern-overlap) — scope-correct (same-named fns in different
;; modules never false-overlap), rename-stable (keyed on node identity), and it SEES a
;; peer's committed-but-unrendered footprint fact with no render and no merge. The spine
;; (title/intent/agent/driver/repo/code_port + monotone `reached` maturity) lives on the
;; :7977 board; the high-frequency footprint facts shard onto the per-repo code daemon —
;; the shared @concern:<id> string bridges the two jurisdictions, no distributed tx.
;; A NON-flipped repo (no code daemon) DEGRADES to the path-string footprint + intersection.
;;
;; PORTS: argv[0] = the :7977 board (spine). $NORTH_CODE_PORT (set by bin/concern when
;; it finds a warm code daemon) = the per-repo CODE store (footprint). No code port ->
;; path-string fallback.
;;
;; usage (port = north board, 7977):
;;   declare <agent> <repo> "<intent>" <foot,foot,...>    mint a concern (+ shows overlaps)
;;       footprint entries: a code NODE (@mod#n or module/name) on a flipped repo, else a path.
;;   overlap <concern-id> [--landing]   who else is in my footprint, any status (code-graph
;;       blast join, or path); likely-to-land entries are MARKED — build against them.
;;       --landing filters to likely-to-land only. (`shape <id>` = hidden alias for that.)
;;   ls [<repo>]              active concerns
;;   status  <concern-id> <exploring|building|likely-to-land|landed>   append a maturity level
;;   done    <concern-id>     reach `landed`
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str]
         '[clojure.set :as set])

;; shared coord substrate: the cardinality-typed write verbs (move-C) live once in
;; cli/coord.clj. append! = MULTI coexist; put! = SINGLE last-writer-wins.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op  north.coord/send-op)
(def append!  north.coord/append!)
(def put!     north.coord/put!)
(def many     north.coord/many)
(def resolved north.coord/resolved)
(def online?  north.coord/online?)   ; renewable-lease liveness — same rule as the presence roster
(def lease-of north.coord/lease-of)  ; raw lease {:holder :exp :epoch} — needed for lapse-age

;; ---- liveness-derived concern DECAY (design 019f4418) -----------------------
;; A concern's owner is judged live by the SAME renewable-lease rule the presence
;; roster uses. When the owner's presence has LAPSED we don't hide or delete — we
;; DECAY the render at read time (pure projection, no write): a building concern
;; goes STALE (dim + "owner lapsed <ago>"); a likely-to-land concern instead
;; renders as a HANDOFF (prominent) — it SURVIVES owner death because it is a
;; signal to the next agent, not stranded WIP. Terminal reactor verdict
;; `reached=abandoned-stale` (owner dead >24h) renders abandoned + hides by default.
(def ^:private use-color? (some? (System/console)))   ; ANSI only on a real TTY; piped/captured stays plain
(defn- dim  [] (if use-color? "\033[2m" ""))
(defn- bold [] (if use-color? "\033[1m" ""))
(defn- rst  [] (if use-color? "\033[0m" ""))

(defn ago
  "Humanize a lapse duration in ms -> \"<n>{s,m,h,d}\"; nil (no lease ever) -> \"?\"."
  [ms]
  (if (nil? ms) "?"
      (let [s (quot ms 1000)]
        (cond (< s 60)    (str s "s")
              (< s 3600)  (str (quot s 60) "m")
              (< s 86400) (str (quot s 3600) "h")
              :else       (str (quot s 86400) "d")))))

;; declare-time embedded in the id (@concern-<epoch-ms>-<hex>): the lapse lower bound
;; when a dead owner never held a lease (pre-presence agents). Matches the reactor's rule.
(defn concern-mint-ms [c]
  (some-> (re-find #"concern-(\d{10,})" (str c)) second parse-long))

(defn owner-liveness
  "-> {:online bool :lapsed-ago-ms nil-or-ms} for a concern meta. An agent-less
   concern can't lapse (nothing to renew) so it renders live. When an offline owner
   never held a lease, the concern's own age is the staleness lower bound (so STALE
   shows a real duration, not \"?\")."
  [port m]
  (let [a (:agent m)]
    (if (str/blank? a)
      {:online true :lapsed-ago-ms nil}
      (let [h (if (str/starts-with? a "@") (subs a 1) a)
            l (lease-of port (str "session:" h))
            now (System/currentTimeMillis)]
        (cond
          (and l (> (:exp l) now)) {:online true  :lapsed-ago-ms nil}
          l                        {:online false :lapsed-ago-ms (- now (:exp l))}
          :else {:online false :lapsed-ago-ms (when-let [mm (concern-mint-ms (:id m))] (- now mm))})))))

(defn with-liveness [port m] (merge m (owner-liveness port m)))

;; port coercion: coord/send-op does (int port), so every port must be a NUMBER, never a
;; string (env vars + the stored code_port fact arrive as strings).
(defn ->port [p] (cond (nil? p) nil (number? p) p :else (Integer/parseInt (str p))))
;; the per-repo CODE daemon port (bin/concern discovers + exports it); nil => path fallback.
(def code-port (let [p (System/getenv "NORTH_CODE_PORT")] (when (and p (seq p)) (->port p))))

;; concern-id args arrive from humans/agents in either form; every fact subject in
;; the log carries the @ sigil, so a bare id here writes to a PHANTOM bare node —
;; the split-brain that stranded `reached landed` facts invisibly (2026-07-02).
(defn norm-cid [c] (if (or (nil? c) (str/starts-with? c "@")) c (str "@" c)))

;; one-column datalog query: bind ?e in `body`, return the column
(defn q-col [port body]
  (->> (:ok (send-op port {:op :query
                           :query {:find "e"
                                   :rules [{:head {:rel "e" :args [{:var "e"}]} :body body}]}}))
       (map first)))

;; ---- monotone maturity (decision 8: status is DERIVED, never SET) -----------
;; `reached` is an append-only, multi-valued ladder fact; status = the MAX level reached.
;; Double-report is idempotent; full history is retained; no set-single! retract-then-put.
(def maturity ["exploring" "building" "likely-to-land" "landed"])
(def maturity-idx (into {} (map-indexed (fn [i m] [m i]) maturity)))
(def usage
  "usage: concern-cli.clj <port> {declare <agent> <repo> \"<intent>\" <foot,> | overlap <id> [--landing] | ls [repo] | status <id> <exploring|building|likely-to-land|landed> | done <id>}")
(defn usage-error! [message]
  (binding [*out* *err*]
    (println (str "concern: " message))
    (println usage))
  (System/exit 2))
(defn existing-concern! [port raw]
  (when (str/blank? raw)
    (usage-error! "a concern id is required"))
  (let [c (norm-cid raw)]
    (when-not (= "concern" (resolved port c "kind"))
      (usage-error! (str c " is not an existing concern")))
    c))
(defn status-of [port c]
  (let [reached (many port c "reached")]
    (if (seq reached)
      (->> reached (sort-by #(get maturity-idx % -1)) last)
      "building")))

;; Terminal reactor verdict: owner dead >24h while still building. Off the maturity
;; ladder (orthogonal to progress), so it flags the concern without shadowing status.
(defn abandoned? [port c] (contains? (set (many port c "reached")) "abandoned-stale"))

;; ---- the @concern:<id> bridge subject (shared across both jurisdictions) ----
(defn concern-subj [id] (str "@concern:" id))                       ; spine-id -> code-store subject
(defn subj->id [subj] (if (str/starts-with? subj "@concern:") (subs subj 9) subj))

;; resolve a footprint ARG to a code NODE id on the code port. "@mod#n" passes through;
;; "module/name" resolves via the daemon's binding tables (the SAME resolution rename/
;; who-calls use, so concern and code agree on which node a name denotes). Returns the
;; node's @mod#int identity, or nil (unresolvable — caller keeps it as a path-string).
(defn resolve-node [cport arg]
  (let [req (cond (str/starts-with? arg "@") {:op :blast :te arg}
                  (str/includes? arg "/")    (let [[m n] (str/split arg #"/" 2)]
                                               {:op :blast :module m :name n})
                  :else                       nil)
        resp (when req (send-op cport req))]
    (when (and resp (not (:error resp))) (:node resp))))

;; ---- spine reads (:7977 board) ----------------------------------------------
(defn all-concerns [port]
  (distinct (q-col port [{:rel "triple" :args [{:var "e"} "kind" "concern"]}])))

(defn touches-of [port c]
  (set (q-col port [{:rel "triple" :args [c "touches" {:var "e"}]}])))

(defn meta-of [port c]
  {:id c
   :agent (resolved port c "agent")
   :repo (resolved port c "repo")
   :intent (resolved port c "intent")
   :status (status-of port c)
   :abandoned (abandoned? port c)
   :code-port (resolved port c "code_port")
   :touches (touches-of port c)})

;; `ls` is a whole-corpus view. Reading seven fields per concern made its runtime
;; grow linearly with historical concern count (>8s in the live corpus). Fetch
;; each required predicate once from LIVE coordinator state instead. This keeps
;; declared-single supersession exact and preserves all live multi values.
(def concern-list-predicates
  ["kind" "agent" "repo" "intent" "reached" "code_port" "touches" "lease"])

(defn add-live-rows [facts predicate rows]
  (reduce (fn [current [entity value]]
            (update-in current [entity predicate] (fnil conj #{}) value))
          facts rows))

(defn concern-list-facts [port]
  (reduce
   (fn [facts predicate]
     (add-live-rows
      facts predicate
      (north.coord/agg-rows
       port ["e" "r"]
       [{:rel "triple" :args [{:var "e"} predicate {:var "r"}]}])))
   {}
   concern-list-predicates))

(defn singleton-live [facts subject predicate]
  (let [values (get-in facts [subject predicate] #{})]
    (when (= 1 (count values)) (first values))))

(defn status-from-live [facts concern]
  (let [reached (get-in facts [concern "reached"] #{})]
    (if (seq reached)
      (last (sort-by #(get maturity-idx % -1) reached))
      "building")))

(defn liveness-from-live [facts concern agent now]
  (if (str/blank? agent)
    {:online true :lapsed-ago-ms nil}
    (let [handle (if (str/starts-with? agent "@") (subs agent 1) agent)
          lease (north.coord/decode-lease
                 (singleton-live facts (str "@lease:session:" handle) "lease"))]
      (cond
        (and lease (> (:exp lease) now)) {:online true :lapsed-ago-ms nil}
        lease {:online false :lapsed-ago-ms (- now (:exp lease))}
        :else {:online false
               :lapsed-ago-ms (when-let [minted (concern-mint-ms concern)]
                                (- now minted))}))))

(defn meta-from-live [facts concern now]
  (let [agent (singleton-live facts concern "agent")
        reached (get-in facts [concern "reached"] #{})]
    (merge
     {:id concern
      :agent agent
      :repo (singleton-live facts concern "repo")
      :intent (singleton-live facts concern "intent")
      :status (status-from-live facts concern)
      :abandoned (contains? reached "abandoned-stale")
      :code-port (singleton-live facts concern "code_port")
      :touches (get-in facts [concern "touches"] #{})}
     (liveness-from-live facts concern agent now))))

(defn concerns-from-live [facts]
  (->> facts
       (keep (fn [[entity predicates]]
               (when (= #{"concern"} (get predicates "kind")) entity)))
       distinct))

(defn fmt [m]
  (format "  %-12s %-14s %-10s {%s}\n     ↳ %s  (%s)"
          (or (:agent m) "?") (or (:status m) "?") (or (:repo m) "?")
          (str/join " " (sort (:touches m))) (or (:intent m) "") (:id m)))

;; Render one concern with liveness DECAY applied. m must carry :online/:lapsed-ago-ms
;; (via with-liveness) + :abandoned. Live -> plain; lapsed building -> STALE (dim);
;; lapsed likely-to-land -> HANDOFF (prominent); abandoned-stale -> retired (dim).
(defn decorate [m]
  (let [base (fmt m)]
    (cond
      (:abandoned m)
        (str (dim) base "\n       (ABANDONED-STALE: owner dead >24h — auto-retired by reactor)" (rst))
      (:online m) base
      (= (:status m) "likely-to-land")
        (str (bold) "» HANDOFF  " base
             "\n       ⇒ owner lapsed " (ago (:lapsed-ago-ms m))
             " — likely-to-land survives owner death; ADOPT this" (rst))
      :else
        (str (dim) base
             "\n       (STALE: owner lapsed " (ago (:lapsed-ago-ms m)) ")" (rst)))))

;; ---- overlap surfaces -------------------------------------------------------
;; CODE-GRAPH path: ask the code daemon which peer concerns' blast CLOSURE intersects
;; mine (recursive reaches over calls_defn), then map each peer's @concern:<id> back to
;; its :7977 spine for display. The path-string intersection is GONE on this path.
(defn surface-code [spine cport c statuses none-msg]
  (let [resp (send-op cport {:op :concern-overlap :te (concern-subj c)})
        hits (->> (:overlaps resp)
                  (keep (fn [o]
                          (let [sid (subj->id (:concern o))
                                m (meta-of spine sid)]
                            (when (and (not= (:status m) "landed")
                                       (or (nil? statuses) (statuses (:status m))))
                              (assoc m :shared (:shared o))))))
                  vec)]
    (if (empty? hits)
      (println (str "  (none) — " none-msg " [code-graph blast join over " (count (:footprint resp)) " footprint node(s)]"))
      (doseq [m0 hits]
        (let [m (with-liveness spine m0)]
          (println (decorate m))
          (when (and (:online m) (= (:status m) "likely-to-land"))
            (println "       [likely-to-land] — build against this"))
          (println (str "       SHARES (blast-closure): " (str/join " " (sort (:shared m))))))))))

;; FALLBACK path (non-flipped repo): the path-string touches intersection.
(defn surface-path [port c statuses none-msg]
  (let [mine (:touches (meta-of port c))
        hits (->> (all-concerns port)
                  (remove #(= % c))
                  (map #(meta-of port %))
                  (remove #(= (:status %) "landed"))
                  (filter #(seq (set/intersection mine (:touches %))))
                  (filter #(or (nil? statuses) (statuses (:status %)))))]
    (if (empty? hits)
      (println (str "  (none) — " none-msg " {" (str/join " " (sort mine)) "}"))
      (doseq [m0 hits]
        (let [m (with-liveness port m0)]
          (println (decorate m))
          (when (and (:online m) (= (:status m) "likely-to-land"))
            (println "       [likely-to-land] — build against this"))
          (println (str "       SHARES: " (str/join " " (sort (set/intersection mine (:touches m)))))))))))

;; the effective code port for THIS concern: its own stored code_port (set at declare,
;; so overlap/shape work from any cwd), else the ambient $NORTH_CODE_PORT. nil => path.
(defn surface [spine c statuses none-msg]
  (let [cport (or (->port (resolved spine c "code_port")) code-port)]
    (if cport (surface-code spine cport c statuses none-msg)
              (surface-path spine c statuses none-msg))))

;; one concept, one word (vocabulary pass, thread 019f2032): `overlap` is THE footprint
;; view — any status, likely-to-land marked per line. --landing filters to those only
;; (the old `shape`, kept as a hidden alias).
(defn overlap! [port c landing?]
  (if landing?
    (do (println "LIKELY-TO-LAND work in your footprint — build against these:")
        (surface port c #{"likely-to-land"} "no likely-to-land work is in your footprint yet"))
    (do (println (str "Concerns in the footprint of " c " (any status; likely-to-land marked):"))
        (surface port c nil "nothing else is in your footprint"))))

(let [[ps verb & args] *command-line-args*
      port (Integer/parseInt ps)]
  (case verb
    "declare"
    (let [[agent repo intent files] args
          fs (->> (str/split (or files "") #",") (map str/trim) (remove str/blank?))
          ;; @ sigil: every thread id in the facts log carries it; a bare id here made
          ;; fram's export strip the wrong char. Old bare-id concerns are tolerated, not rewritten.
          id (str "@concern-" (System/currentTimeMillis) "-" (subs (str (java.util.UUID/randomUUID)) 0 4))]
      ;; spine on the :7977 board (low-frequency declare/maturity); footprint NEVER lands here.
      ;; Mint a missing person label, but never overwrite a managed lane's
      ;; publisher-owned identity cache. Roster names are derived from axes.
      (let [agent-e (str "@" agent)]
        (when (and (nil? (resolved port agent-e "identity_manifest_sha256"))
                   (nil? (resolved port agent-e "display_name")))
          (put! port agent-e "display_name" agent)))
      (put! port id "title"  (str "[" repo "] " intent))   ; single
      (put! port id "kind"   "concern")                    ; single
      (put! port id "agent"  (str "@" agent))              ; single
      (put! port id "driver" (str "@" agent))              ; single (engine) — board visibility: active work
      (put! port id "repo"   repo)                         ; single
      (put! port id "intent" intent)                       ; single
      (when code-port (put! port id "code_port" (str code-port)))   ; so a reader finds the code store
      (doseq [f fs] (append! port id "touches" f))         ; display labels (+ the fallback footprint)
      (append! port id "reached" "building")               ; monotone maturity — NOT set-single!
      ;; footprint = code-node bridge facts, on the CODE port (flipped repos only).
      (if code-port
        (let [resolved-pairs (map (fn [f] [f (resolve-node code-port f)]) fs)
              hits (filter second resolved-pairs)
              misses (->> resolved-pairs (remove second) (map first))]
          (doseq [[_ node] hits] (append! code-port (concern-subj id) "footprint" node))
          (println (str "✓ concern " id))
          (println (str "  @" agent "  building  [" repo "]  footprint(code) {"
                        (str/join " " (map second hits)) "}"))
          (when (seq misses)
            (println (str "  (unresolved -> path-string footprint: " (str/join " " misses)
                          " — use @mod#n or module/name for code-node overlap)"))))
        (do
          (println (str "✓ concern " id))
          (println (str "  @" agent "  building  [" repo "]  touches {" (str/join " " fs) "}"))
          (println "  (no warm code daemon for this repo — footprint is path-string; `fram-code-on <repo>` enables code-node overlap)")))
      (println "\nOverlapping concerns — coordinate, you are NOT blocked:")
      (surface port id nil "no other concern is in your footprint")
      (println (str "\n  next: `concern overlap " id "` — who's in your footprint, likely-to-land"
                    " marked (build against those);  `concern status " id " likely-to-land` as you near merge.")))

    "overlap"
    (let [[c & flags] args]
      (overlap! port (norm-cid c) (boolean (some #(= % "--landing") flags))))

    "shape"                                              ; hidden alias: overlap --landing
    (let [[c] args]
      (overlap! port (norm-cid c) true))

    ;; Liveness-derived DECAY (design 019f4418): a lapsed owner's concern is NOT hidden
    ;; — hiding is what made 17 dead-agent concerns invisibly linger AND let a stale one
    ;; misroute a live lane. It is RENDERED, decayed at read time: building -> STALE (dim),
    ;; likely-to-land -> HANDOFF (prominent, survives owner death as a signal). The reactor's
    ;; terminal verdict `abandoned-stale` (owner dead >24h) retires the concern — hidden by
    ;; default, shown with --all. Agent-less concerns can't lapse, so render live.
    "ls"
    (let [flags   (set (filter #(str/starts-with? % "--") args))
          show-all (boolean (or (flags "--all") (flags "--stale")))
          repo    (first (remove #(str/starts-with? % "--") args))
          facts   (concern-list-facts port)
          now     (System/currentTimeMillis)
          all-ms  (->> (concerns-from-live facts)
                       (map #(meta-from-live facts % now))
                       (remove #(= (:status %) "landed"))
                       (filter #(or (nil? repo) (= (:repo %) repo)))
                       (sort-by (juxt :repo #(str (:agent %)))))
          active  (remove :abandoned all-ms)             ; abandoned-stale retired: hidden unless --all
          shown   (if show-all all-ms active)
          stale-ct   (count (filter #(and (not (:online %)) (not (:abandoned %))
                                          (not= (:status %) "likely-to-land")) active))
          handoff-ct (count (filter #(and (not (:online %)) (= (:status %) "likely-to-land")) active))
          retired-ct (- (count all-ms) (count active))]
      (println (str "ACTIVE CONCERNS" (when repo (str " in " repo)) " — " (count shown)
                    (when (pos? stale-ct)   (str "  [" stale-ct " STALE: owner lapsed]"))
                    (when (pos? handoff-ct) (str "  [" handoff-ct " HANDOFF: owner gone, likely-to-land]"))
                    (when (and (pos? retired-ct) (not show-all))
                      (str "  [" retired-ct " abandoned-stale retired — `concern ls --all` to show]"))))
      (doseq [m shown]
        (println (decorate m))))

    "status"
    (let [[raw st] args]
      (when-not (= 2 (count args))
        (usage-error! "status requires exactly <concern-id> <maturity>"))
      (when-not (contains? maturity-idx st)
        (usage-error! (str "invalid maturity " (pr-str st) "; expected one of "
                           (str/join ", " maturity))))
      (let [c (existing-concern! port raw)]
        (append! port c "reached" st)                      ; monotone ladder — append, never set
        (println (str "✓ " c " reached=" st " (status=" (status-of port c) ")"))))

    "done"
    (let [[raw] args]
      (when-not (= 1 (count args))
        (usage-error! "done requires exactly <concern-id>"))
      (let [c (existing-concern! port raw)]
        (append! port c "reached" "landed")
        (println (str "✓ " c " landed"))))

    (do (println usage)
        (System/exit 2))))
