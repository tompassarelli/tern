;; lodestar-listen.clj <uuid> [--once] [--ack] — dormant-until-pinged listener.
;;
;; Claim-native pub/sub, client-side. An agent is @agent:<uuid> (an opaque address). Its SCOPE is:
;;   self-channel : a commit (to ∈ {uuid} ∪ {roles it HOLDS} ∪ {"*"})  — a message to it
;;   watched thread: a commit whose SUBJECT is a thread it watches                  — that thread moved
;; You ADDRESS a role (e.g. `to fram-engine`) and it routes to the current holder — agents are
;; fungible, roles are the stable address. holds/watches are claims (@agent:<uuid> holds @role:…
;; / watches @thread), so an assign/unassign/watch/unwatch LIVE-updates the scope with NO reconnect.
;; The daemon's :subscribe firehoses every commit (it ignores :filter); ALL matching is here. Dormant on
;; the socket between pushes: zero poll, zero tokens until something is actually addressed.
;;
;; --once : exit after the first ping — the interactive bridge (run as a bg task; completion == "you have mail").
;; --ack  : auto-assert acked_by <uuid> on each delivered message.
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str]
         '[babashka.process :as proc])

;; shared coord substrate (Foundation Part B): wire helpers live once in cli/coord.clj
;; (rf/rmany = the single/multi resolved variants — semantics unchanged).
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op lodestar.coord/send-op)
(def append! lodestar.coord/append!)
(def put!    lodestar.coord/put!)
(def rf      lodestar.coord/resolved)
(def rmany   lodestar.coord/many)
;; shared incremental-aggregate (coord.clj): budget Σ and the driver ceiling are
;; the SAME fold quorum rides — two reducers, one substrate (roadmap F+G).
(def agg-rows       lodestar.coord/agg-rows)
(def sum-rows       lodestar.coord/sum-rows)
(def count-distinct lodestar.coord/count-distinct)
(defn role-slug [r] (when (and (string? r) (>= (count r) 6) (= "@role:" (subs r 0 6))) (subs r 6)))

(defn ack! [port me id] (append! port id "acked_by" me))   ; acked_by is multi — append (coexist)

;; --- swarm cost budget + derived concurrency ceiling -----------------------
;; The REAL resource is spend, not concurrency: N agents looping forever still burn
;; infinite credits. The binding limit is a declarative COST BUDGET: @swarm
;; budget_total (a USD ceiling) set once. Spend is a DERIVED SUM — Σ(@run:* cost_usd),
;; folded from the immutable per-run cost claims presence-cli already writes — never a
;; mutated budget_spent cell or a :bump op (that counter duplicated derivable state and
;; had to stay in sync with budget.ts). The reactor GATES on remaining()>0 before it
;; shells a real agent. No budget_total set => unbounded.
;; The fork-bomb backstop is likewise DERIVED, not a @swarm-slot counting semaphore:
;; any concurrency ceiling = count(live drivers) vs LODESTAR_SWARM_MAX.
(def driver-max (Integer/parseInt (or (System/getenv "LODESTAR_SWARM_MAX") "64")))
;; MUST match sdk/src/budget.ts SUBJECT (same env var + default) so the gate reads the
;; same budget the executors' costs roll up to.
(def budget-subj (or (System/getenv "LODESTAR_BUDGET") "@swarm"))
(defn spent-sum
  "Σ(@run:* cost_usd) — live spend folded from immutable per-run cost claims via the
   shared SUM reducer (coord/sum-rows). cost_usd subjects are scoped to @run: with a
   client-side prefix the scan body can't express, then folded as [run cost] rows so
   equal-cost runs stay distinct (a value-only fold would dedup + under-count)."
  [port]
  (->> (agg-rows port ["e" "v"] [{:rel "triple" :args [{:var "e"} "cost_usd" {:var "v"}]}])
       (filter #(str/starts-with? (str (first %)) "@run:"))
       sum-rows))
(defn budget-remaining
  "budget_total − Σ(@run cost_usd), or nil if no budget_total set (= unbounded)."
  [port]
  (when-let [total (parse-double (str (or (rf port budget-subj "budget_total") "")))]
    (- total (spent-sum port))))
(defn live-drivers
  "count-distinct subjects carrying a live `driver` claim — the derived concurrency
   ceiling, replacing the @swarm-slot semaphore. The SAME count-distinct QUORUM
   (coord.clj) lodestar-map's K-of-N barrier folds: the ceiling is a quorum over drivers."
  [port]
  (count-distinct port ["s"] [{:rel "triple" :args [{:var "s"} "driver" {:var "a"}]}]))
(defn with-guard
  "Gate a blocking agent shell: skip if the cost budget is spent OR live drivers are at
   the derived ceiling; else run. No slots, no semaphore — both limits are read-time folds."
  [port self label thunk]
  (let [rem  (budget-remaining port)
        live (live-drivers port)]
    (cond
      (and rem (<= rem 0))
      (println (str "   ⏸ BUDGET SPENT (remaining $" rem ") — backing off, not spawning " label))
      (>= live driver-max)
      (println (str "   ⏸ driver ceiling (" live "/" driver-max " live) — backing off " label))
      :else
      (do (println (str "   ⚙ run " label (when rem (str ", budget ~$" rem " left")) " (" live " live drivers)")) (flush)
          (thunk)))))

;; --- Phase 1: the reactor — a forward-chaining rule over claim-patterns ------
;; The reactor NO LONGER string-parses a command envelope (the parse-envelope copy that
;; "MUST stay in sync" with msg-cli is DELETED). A command is CLAIMS on @cmd:<id>; the
;; reactor matches PENDING ones (op+target, NOT acked_by) via the shared Datalog rule
;; (coord/pending-cmds) and reads each arg as a claim with rf — no parsing, no settle sleep.
(def sdk (or (System/getenv "LODESTAR_SDK") (str (System/getenv "HOME") "/code/lodestar/sdk")))

;; EXECUTE one command (cmd = @cmd:<id>): REUSE dispatch.ts/spawn.ts as the executor. Args are
;; read off the command's claims, not an envelope map. `self` = the reactor's handle (its uuid),
;; passed as AGENT_ID so any command_peer a spawned/dispatched agent emits is attributed to the
;; real handle (not a generated sdk-* id) — required for multi-hop routing/acks.
(defn react! [port self op cmd]
  (case op
    "spawn"    (with-guard port self "spawn"
                 (fn [] (let [prompt (rf port cmd "prompt") model (rf port cmd "model")]
                          (println (str "   ⚙ spawn: " (pr-str prompt)))
                          (proc/shell {:dir sdk :continue true
                                       :extra-env (cond-> {"AGENT_ID" self} model (assoc "AGENT_MODEL" (str model)))}
                                      "bun" "src/spawn.ts" (str prompt)))))
    "dispatch" (with-guard port self "dispatch"
                 (fn [] (let [thread (rf port cmd "thread")]
                          (println (str "   ⚙ dispatch thread " thread))
                          (proc/shell {:dir sdk :continue true :extra-env {"AGENT_ID" self}}
                                      "bun" "src/dispatch.ts" (str thread)))))
    ;; tell — the most claim-native op: assert a single claim (id pred value). No executor.
    "tell"     (let [id (rf port cmd "id") pred (rf port cmd "pred") value (rf port cmd "value")]
                 (append! port id pred value)
                 (println (str "   ✓ told " id " " pred " " value)))
    ;; claim — work-claim WITHOUT a reactor lease (the @lease:<thread> acquire-lease is DELETED,
    ;; roadmap tier I + §3.5). A `driver` claim on the resource IS the lock (declared-single,
    ;; last-writer-wins): graph-internal mutual exclusion collapses onto a claim, no parallel lease.
    "claim"    (let [res (rf port cmd "resource") holder (or (rf port cmd "holder") (rf port cmd "from") self)
                     subj (if (str/starts-with? (str res) "@") res (str "@" res))]
                 (put! port subj "driver" holder)
                 (println (str "   ✓ claimed " subj " driver=" holder)))
    (println (str "   ⚠ op " op " not wired in the reactor"))))

;; The forward-chaining loop: every PENDING command targeting one of my addrs -> execute,
;; ack (acked_by removes it from the pending set — exactly-once), and reply with a CLAIM
;; (validated by the coordinator's existing commit rule-check, not a JSON-Schema sidecar).
(defn react-pending! [port self addrs]
  (doseq [[cmd op tgt] (sort (or (lodestar.coord/pending-cmds port) []))]
    (when (contains? addrs tgt)
      (println (format "⚙  REACT %s  op=%s  (target %s, from %s)" cmd op tgt (or (rf port cmd "from") "?"))) (flush)
      (react! port self op cmd)
      (ack! port self cmd)
      (append! port cmd "reply" (str op " executed by " self))   ; reply = a claim
      (println (str "   ↳ executed + acked_by " self)) (flush))))

(let [[ps uuid & flags] *command-line-args*
      port    (Integer/parseInt ps)
      node    (str "@agent:" uuid)
      once?   (boolean (some #{"--once"} flags))
      ack?    (boolean (some #{"--ack"} flags))
      react?  (boolean (some #{"--react"} flags))   ; Phase 1: execute command-envelope mail (spawn/dispatch) + ack
      scoped? (boolean (some #{"--scoped"} flags))  ; P5: server-side scoped subscribe (daemon pushes only my commits)
      addrs   (atom (into #{uuid "*"} (keep role-slug (rmany port node "holds"))))  ; uuid ∪ held roles
      watched (atom (set (rmany port node "watches")))]
  ;; outer loop: with --scoped, RECONNECT when my addr/watch set changes so the daemon re-scopes
  ;; the push filter (the daemon's subscribe loop ignores mid-stream re-subscribe, so a fresh
  ;; connection is how we re-scope). Without --scoped, reconnect? never fires -> one pass, identical
  ;; to the firehose listener (full backward-compat).
  (loop []
    (let [reconnect? (atom false)]
      (with-open [s (java.net.Socket. "127.0.0.1" (int port))]
        (let [w (.getOutputStream s) r (io/reader (.getInputStream s))
              sub (cond-> {:op :subscribe}
                    scoped? (assoc :filter {:addrs @addrs :watch @watched :node node}))]
          (.write w (.getBytes (str (pr-str sub) "\n"))) (.flush w)
          (.readLine r)                                              ; consume {:subscribed N}
          (println (format "● @agent:%s listening%s — addrs %s + %d watched thread(s)%s"
                           uuid (if scoped? " [scoped]" "") (pr-str (sort @addrs)) (count @watched) (if once? "  [--once]" "")))
          (flush)
          (loop []
            (when-let [line (.readLine r)]
              (let [ev (try (edn/read-string line) (catch Exception _ nil))]
                (when (and (map? ev) (= :commit (:event ev)))
                  (let [{:keys [op l p r]} ev]
                    (cond
                      ;; (a) role (un)assigned to me -> address set changes; re-scope if --scoped
                      (and (= l node) (= p "holds"))
                      (do (when-let [sl (role-slug r)]
                            (swap! addrs (if (= op "assert") conj disj) sl)
                            (println (format "  ↳ addrs: %s %s (now %s)"
                                             (if (= op "assert") "+role" "-role") sl (pr-str (sort @addrs)))) (flush)
                            (when scoped? (reset! reconnect? true))))

                      ;; (b) thread watch/unwatch -> re-scope if --scoped
                      (and (= l node) (= p "watches"))
                      (do (swap! watched (if (= op "assert") conj disj) r)
                          (println (format "  ↳ scope: %s %s (now %d watched)"
                                           (if (= op "assert") "watch" "unwatch") r (count @watched))) (flush)
                          (when scoped? (reset! reconnect? true)))

                      ;; (c) self-channel: a human message to my uuid OR a role I hold. `to` lands
                      ;; LAST now (msg-cli send writes it after the body), so from/subject/body are
                      ;; already visible — no settle sleep, and no envelope parsing (commands are
                      ;; @cmd: subjects handled in (c2), not mail bodies).
                      (and (= op "assert") (= p "to") (contains? @addrs r))
                      (do (println (format "✉  MAIL %s  (to %s)\n   from:    %s\n   subject: %s\n   body:    %s"
                                           l r (rf port l "from") (rf port l "subject") (rf port l "body"))) (flush)
                          (when ack? (ack! port uuid l) (println (str "   ↳ acked_by " uuid)) (flush))
                          (when once? (System/exit 0)))

                      ;; (c2) command landing: a @cmd:<id> whose routing `target` is one of my addrs.
                      ;; `target` is asserted LAST, so op+args are present. Drive the forward-chaining
                      ;; rule (coord/pending-cmds) — no string parse, no settle sleep.
                      (and (= op "assert") (= p "target") (contains? @addrs r))
                      (do (if react?
                            (react-pending! port uuid @addrs)   ; --react: execute + ack + reply
                            (println (format "⌘  COMMAND %s  op=%s  (target %s)" l (rf port l "op") r))) (flush)
                          (when once? (System/exit 0)))

                      ;; (d) watched-thread activity
                      (and (= op "assert") (contains? @watched l))
                      (do (println (format "◆  THREAD %s  %s = %s" l p r)) (flush)
                          (when once? (System/exit 0)))))))
              ;; --scoped re-scope: break the inner read-loop so the outer reconnects with the new filter
              (if @reconnect?
                (do (println "  ↳ re-scoping subscription (addr/watch changed)…") (flush))
                (recur))))))
      (when @reconnect? (recur)))))
