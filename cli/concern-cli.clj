;; concern-cli.clj — CONCERN-level coordination for parallel agents. NOT locks.
;;
;; An agent declares a CONCERN: a feature it is building + the footprint it touches.
;; Concerns COEXIST — declaring never blocks anyone. Overlap is DERIVED and surfaced, so
;; agents shape around each other and against what is LIKELY TO LAND (before it is in
;; main). N agents, one repo, fine.
;;
;; FOOTPRINT = CODE-GRAPH BLAST JOINS over node IDENTITY (thread 019f1010-2705). On a
;; FLIPPED Beagle repo (a warm fram code daemon is up), a concern's footprint is
;; `footprint` bridge claims FROM @concern:<id> TO @mod#n code NODES, asserted into the
;; repo's warm CODE store; "who else is in my footprint" is then a recursive reaches
;; :query (the daemon's :concern-overlap) — scope-correct (same-named fns in different
;; modules never false-overlap), rename-stable (keyed on node identity), and it SEES a
;; peer's committed-but-unrendered footprint claim with no render and no merge. The spine
;; (title/intent/agent/driver/repo/code_port + monotone `reached` maturity) lives on the
;; :7977 board; the high-frequency footprint claims shard onto the per-repo code daemon —
;; the shared @concern:<id> string bridges the two jurisdictions, no distributed tx.
;; A NON-flipped repo (no code daemon) DEGRADES to the path-string footprint + intersection.
;;
;; PORTS: argv[0] = the :7977 board (spine). $TERN_CODE_PORT (set by bin/concern when
;; it finds a warm code daemon) = the per-repo CODE store (footprint). No code port ->
;; path-string fallback.
;;
;; usage (port = tern board, 7977):
;;   declare <agent> <repo> "<intent>" <foot,foot,...>    mint a concern (+ shows overlaps)
;;       footprint entries: a code NODE (@mod#n or module/name) on a flipped repo, else a path.
;;   overlap <concern-id>     who else is in my footprint (code-graph blast join, or path)
;;   shape   <concern-id>     likely-to-land work in my footprint — build against it
;;   ls [<repo>]              active concerns
;;   status  <concern-id> <exploring|building|likely-to-land|landed>   append a maturity level
;;   done    <concern-id>     reach `landed`
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str]
         '[clojure.set :as set])

;; shared coord substrate: the cardinality-typed write verbs (move-C) live once in
;; cli/coord.clj. append! = MULTI coexist; put! = SINGLE last-writer-wins.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op  tern.coord/send-op)
(def append!  tern.coord/append!)
(def put!     tern.coord/put!)
(def many     tern.coord/many)
(def resolved tern.coord/resolved)
(def online?  tern.coord/online?)   ; renewable-lease liveness — same rule as the presence roster

;; port coercion: coord/send-op does (int port), so every port must be a NUMBER, never a
;; string (env vars + the stored code_port claim arrive as strings).
(defn ->port [p] (cond (nil? p) nil (number? p) p :else (Integer/parseInt (str p))))
;; the per-repo CODE daemon port (bin/concern discovers + exports it); nil => path fallback.
(def code-port (let [p (System/getenv "TERN_CODE_PORT")] (when (and p (seq p)) (->port p))))

;; one-column datalog query: bind ?e in `body`, return the column
(defn q-col [port body]
  (->> (:ok (send-op port {:op :query
                           :query {:find "e"
                                   :rules [{:head {:rel "e" :args [{:var "e"}]} :body body}]}}))
       (map first)))

;; ---- monotone maturity (decision 8: status is DERIVED, never SET) -----------
;; `reached` is an append-only, multi-valued ladder claim; status = the MAX level reached.
;; Double-report is idempotent; full history is retained; no set-single! retract-then-put.
(def maturity ["exploring" "building" "likely-to-land" "landed"])
(def maturity-idx (into {} (map-indexed (fn [i m] [m i]) maturity)))
(defn status-of [port c]
  (let [reached (many port c "reached")]
    (if (seq reached)
      (->> reached (sort-by #(get maturity-idx % -1)) last)
      "building")))

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
   :code-port (resolved port c "code_port")
   :touches (touches-of port c)})

(defn fmt [m]
  (format "  %-12s %-14s %-10s {%s}\n     ↳ %s  (%s)"
          (or (:agent m) "?") (or (:status m) "?") (or (:repo m) "?")
          (str/join " " (sort (:touches m))) (or (:intent m) "") (:id m)))

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
      (doseq [m hits]
        (println (fmt m))
        (println (str "       SHARES (blast-closure): " (str/join " " (sort (:shared m)))))))))

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
      (doseq [m hits]
        (println (fmt m))
        (println (str "       SHARES: " (str/join " " (sort (set/intersection mine (:touches m))))))))))

;; the effective code port for THIS concern: its own stored code_port (set at declare,
;; so overlap/shape work from any cwd), else the ambient $TERN_CODE_PORT. nil => path.
(defn surface [spine c statuses none-msg]
  (let [cport (or (->port (resolved spine c "code_port")) code-port)]
    (if cport (surface-code spine cport c statuses none-msg)
              (surface-path spine c statuses none-msg))))

(let [[ps verb & args] *command-line-args*
      port (Integer/parseInt ps)]
  (case verb
    "declare"
    (let [[agent repo intent files] args
          fs (->> (str/split (or files "") #",") (map str/trim) (remove str/blank?))
          ;; @ sigil: every thread id in the claims log carries it; a bare id here made
          ;; fram's export strip the wrong char. Old bare-id concerns are tolerated, not rewritten.
          id (str "@concern-" (System/currentTimeMillis) "-" (subs (str (java.util.UUID/randomUUID)) 0 4))]
      ;; spine on the :7977 board (low-frequency declare/maturity); footprint NEVER lands here.
      (put! port id "title"  (str "[" repo "] " intent))   ; single
      (put! port id "kind"   "concern")                    ; single
      (put! port id "agent"  (str "@" agent))              ; single
      (put! port id "driver" (str "@" agent))              ; single (engine) — board visibility: active work
      (put! port id "repo"   repo)                         ; single
      (put! port id "intent" intent)                       ; single
      (when code-port (put! port id "code_port" (str code-port)))   ; so a reader finds the code store
      (doseq [f fs] (append! port id "touches" f))         ; display labels (+ the fallback footprint)
      (append! port id "reached" "building")               ; monotone maturity — NOT set-single!
      ;; footprint = code-node bridge claims, on the CODE port (flipped repos only).
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
      (println (str "\n  next: `concern shape " id "` to build against likely-to-land work;"
                    "  `concern status " id " likely-to-land` as you near merge.")))

    "overlap"
    (let [[c] args]
      (println (str "Concerns in the footprint of " c " (any status):"))
      (surface port c nil "nothing else is in your footprint"))

    "shape"
    (let [[c] args]
      (println "LIKELY-TO-LAND work in your footprint — shape your feature against these:")
      (surface port c #{"likely-to-land"} "no likely-to-land work is in your footprint yet"))

    ;; A concern is LIVE only while its owning agent is ONLINE in the presence roster
    ;; (renewable-lease liveness — coord/online?). A crashed agent's concerns never got
    ;; a `done`, so without this they linger forever; presence lapses on its own, so we
    ;; gate on it. Nothing is deleted — `--all`/`--stale` shows them, marked STALE. An
    ;; agent-less concern can't lapse, so it stays visible.
    "ls"
    (let [flags   (set (filter #(str/starts-with? % "--") args))
          show-all (boolean (or (flags "--all") (flags "--stale")))
          repo    (first (remove #(str/starts-with? % "--") args))
          agent-online? (fn [m] (let [a (:agent m)]
                                  (if (str/blank? a) true
                                    (online? port (if (str/starts-with? a "@") (subs a 1) a)))))
          all-ms  (->> (all-concerns port) (map #(meta-of port %))
                       (remove #(= (:status %) "landed"))
                       (filter #(or (nil? repo) (= (:repo %) repo)))
                       (map #(assoc % :online (agent-online? %)))
                       (sort-by :repo))
          live-ms (filter :online all-ms)
          shown   (if show-all all-ms live-ms)
          hidden  (- (count all-ms) (count live-ms))]
      (println (str "ACTIVE CONCERNS" (when repo (str " in " repo))
                    (when show-all " (incl. stale)") " — " (count shown)
                    (when (and (not show-all) (pos? hidden))
                      (str "  [" hidden " hidden: owning agent offline — `concern ls --all` to show]"))))
      (doseq [m shown]
        (println (fmt m))
        (when (and show-all (not (:online m)))
          (println "       (STALE: owning agent presence lapsed)"))))

    "status"
    (let [[c st] args]
      (append! port c "reached" st)                        ; monotone ladder — append, never set
      (println (str "✓ " c " reached=" st " (status=" (status-of port c) ")")))

    "done"
    (let [[c] args]
      (append! port c "reached" "landed")
      (println (str "✓ " c " landed")))

    (do (println "usage: concern-cli.clj <port> {declare <agent> <repo> \"<intent>\" <foot,> | overlap <id> | shape <id> | ls [repo] | status <id> <st> | done <id>}")
        (System/exit 2))))
