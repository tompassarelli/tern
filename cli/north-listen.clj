;; north-listen.clj <uuid> [--once] [--ack] — dormant-until-pinged listener.
;;
;; Fact-native pub/sub, client-side. An agent is @agent:<uuid> (an opaque address). Its SCOPE is:
;;   self-channel : a direct commit to {uuid} ∪ {roles it HOLDS}, or a broadcast
;;                  whose finite send-time audience contains uuid
;;   watched thread: a commit whose SUBJECT is a thread it watches                  — that thread moved
;; You ADDRESS a role (e.g. `to fram-engine`) and it routes to the current holder — agents are
;; fungible, roles are the stable address. holds/watches are facts (@agent:<uuid> holds @role:…
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
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/topology-authority.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/message-audience.clj"))
(def send-op north.coord/send-op)
(def append! north.coord/append!)
(def rf      north.coord/resolved)
(def rmany   north.coord/many)
(defn role-slug [r] (when (and (string? r) (>= (count r) 6) (= "@role:" (subs r 0 6))) (subs r 6)))

(defn ack! [port me id] (append! port id "acked_by" me))   ; acked_by is multi — append (coexist)

;; --- Phase 1: the reactor — a forward-chaining rule over fact-patterns ------
;; The reactor NO LONGER string-parses a command envelope (the parse-envelope copy that
;; "MUST stay in sync" with msg-cli is DELETED). A command is FACTS on @cmd:<id>; the
;; reactor matches PENDING ones (op+target, NOT acked_by) via the shared Datalog rule
;; (coord/pending-cmds) and reads each arg as a fact with rf — no parsing, no settle sleep.
(def acquire-cli
  (str (.getParent (io/file (System/getProperty "babashka.file"))) "/acquire-cli.clj"))

;; Execute only operations whose effect is safely repeatable across listener
;; crash/replay and rival subscribers. Peer spawn/dispatch require an atomic
;; claim + child reconciliation protocol and are fail-closed this release; the
;; canonical MCP/CLI spawn surfaces remain available.
(defn react! [port self op cmd]
  (north.topology-authority/require-coordination! "listen --react")
  (case op
    "spawn"    {:ok false :retryable false
                 :message "peer spawn is unsupported until atomic command claim + child reconciliation land; use North MCP/CLI spawn"}
    "dispatch" {:ok false :retryable false
                 :message "peer dispatch is unsupported until atomic command claim + child reconciliation land; use North MCP/CLI dispatch"}
    ;; tell — the most fact-native op: assert a single fact (id pred value). No executor.
    "tell"     (let [id (rf port cmd "id") pred (rf port cmd "pred") value (rf port cmd "value")]
                 (cond
                   (some #(str/blank? (str %)) [id pred value])
                   {:ok false :retryable false :message "tell requires id, pred, and value"}
                   (str/starts-with? (str/replace-first (str id) #"^@" "") "agent:")
                   {:ok false :retryable false :message "peer tell cannot mutate harness-owned @agent identity"}
                   :else
                   (let [result (append! port id pred value)]
                     (if (:reject result)
                       {:ok false :retryable true :message (str "coordinator rejected tell " id " " pred)}
                       {:ok true :retryable false :message (str "told " id " " pred)}))))
    ;; acquire — route every automatic pickup through the same OCC driver command
    ;; as SDK dispatch. A no-base put! would be LWW and could silently steal a
    ;; live dispatch's thread; acquire-cli denies a different holder instead.
    "acquire"  (let [res (rf port cmd "resource") holder (or (rf port cmd "holder") (rf port cmd "from") self)
                     subj (if (str/starts-with? (str res) "@") res (str "@" res))
                     bare-holder (str/replace-first (str holder) #"^@" "")
                     result (proc/sh {:out :string :err :string :continue true}
                                     "bb" acquire-cli (str port) "acquire" subj bare-holder)]
                 (if (zero? (:exit result))
                   {:ok true :retryable false :message (str "acquired " subj " driver=@" bare-holder)}
                   {:ok false :retryable true :message (str "acquire denied for " subj " — already driven")}))
    {:ok false :retryable false :message (str "op " op " not wired in the reactor")}))

;; The forward-chaining loop: every PENDING command targeting one of my addrs -> execute,
;; ack (acked_by removes it from the pending set — exactly-once), and reply with a FACT
;; (validated by the coordinator's existing commit rule-check, not a JSON-Schema sidecar).
(defn react-pending! [port self addrs]
  (doseq [[cmd op tgt] (sort (or (north.coord/pending-cmds port) []))]
    (when (contains? addrs tgt)
      (println (format "⚙  REACT %s  op=%s  (target %s, from %s)"
                       cmd op tgt (or (rf port cmd "from") "?")))
      (flush)
      (let [result (try (react! port self op cmd)
                        (catch Exception error
                          {:ok false :retryable false :message (.getMessage error)}))]
        (if (:ok result)
          (do
            (append! port cmd "execution_status" "succeeded")
            (append! port cmd "reply" (str op " succeeded by " self ": " (:message result)))
            ;; Terminal success marker LAST.
            (ack! port self cmd)
            (println (str "   ↳ succeeded + acked_by " self)))
          (do
            (append! port cmd "execution_status" "failed")
            (doseq [prior (rmany port cmd "retryable")]
              (north.coord/retract! port cmd "retryable" prior))
            (append! port cmd "retryable" (str (boolean (:retryable result))))
            (append! port cmd "failed_at" (str (java.time.Instant/now)))
            (append! port cmd "reply" (str op " failed by " self
                                           " retryable=" (boolean (:retryable result))
                                           ": " (:message result)))
            ;; Terminal failure marker LAST.
            (append! port cmd "failed_by" self)
            (println (str "   ↳ FAILED (not acknowledged) by " self
                          " · retryable=" (boolean (:retryable result))))))
        (flush)))))

(let [[ps uuid & flags] *command-line-args*
      port    (Integer/parseInt ps)
      node    (str "@agent:" uuid)
      once?   (boolean (some #{"--once"} flags))
      ack?    (boolean (some #{"--ack"} flags))
      react?  (boolean (some #{"--react"} flags))   ; execute repeat-safe tell/acquire commands + terminal marker
      _       (when-let [problem (and react? (north.topology-authority/authority-problem "listen --react"))]
                (binding [*out* *err*] (println problem))
                (System/exit 1))
      scoped? (boolean (some #{"--scoped"} flags))  ; P5: server-side scoped subscribe (daemon pushes only my commits)
      addrs   (atom (into #{uuid} (keep role-slug (rmany port node "holds"))))  ; uuid ∪ held roles
      watched (atom (set (rmany port node "watches")))]
  ;; outer loop: with --scoped, RECONNECT when my addr/watch set changes so the daemon re-scopes
  ;; the push filter (the daemon's subscribe loop ignores mid-stream re-subscribe, so a fresh
  ;; connection is how we re-scope). Without --scoped, reconnect? never fires -> one pass, identical
  ;; to the firehose listener (full backward-compat).
  (loop []
    (let [reconnect? (atom false)]
      (with-open [s (north.coord/connect-socket port)]
        (let [w (.getOutputStream s)
              reader (north.coord/coordinator-reader s)
              ;; The daemon still needs "*" in its transport filter to forward
              ;; broadcast trigger commits. Client-side snapshot membership is
              ;; the delivery authority; "*" is never a command/direct address.
              sub (cond-> {:op :subscribe}
                    scoped? (assoc :filter {:addrs (conj @addrs north.message-audience/broadcast-address)
                                            :watch @watched :node node}))]
          (.write w
                  (.getBytes
                   (str (pr-str (north.coord/log-envelope sub)) "\n")
                   java.nio.charset.StandardCharsets/UTF_8))
          (.flush w)
          (north.coord/validate-subscription!
           (north.coord/read-line-bounded! reader))
          (.setSoTimeout s 0)            ; validated long-lived stream: wait indefinitely for pushes
          (println (format "● @agent:%s listening%s — addrs %s + %d watched thread(s)%s"
                           uuid (if scoped? " [scoped]" "") (pr-str (sort @addrs)) (count @watched) (if once? "  [--once]" "")))
          (flush)
          ;; Replay any repeat-safe command whose effect/diagnostics landed
          ;; before its terminal marker when a prior listener crashed.
          (when react? (react-pending! port uuid @addrs))
          (loop []
            (when-let [line
                       (north.coord/read-stream-line-bounded! reader)]
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
                      (and (= op "assert") (= p "to")
                           (north.message-audience/deliverable?
                            port l r uuid @addrs))
                      (let [claim (when ack?
                                    (north.message-audience/claim-delivery! port l uuid))]
                        ;; Raw listeners without --ack remain an explicit
                        ;; monitoring surface. Canonical one-shot listeners use
                        ;; --ack and must win the coordinator claim before print.
                        (when (or (not ack?) claim)
                          (println (format "✉  MAIL %s  (to %s)\n   from:    %s\n   subject: %s\n   body:    %s"
                                           l r (rf port l "from") (rf port l "subject") (rf port l "body")))
                          (flush)
                          (when ack?
                            (north.message-audience/complete-delivery! port l uuid claim)
                            (println (str "   ↳ acked_by " uuid))
                            (flush))
                          (when once? (System/exit 0))))

                      ;; (c2) command landing: a @cmd:<id> whose routing `target` is one of my addrs.
                      ;; `target` is asserted LAST, so op+args are present. Drive the forward-chaining
                      ;; rule (coord/pending-cmds) — no string parse, no settle sleep.
                      (and (= op "assert") (= p "target") (contains? @addrs r))
                      (do (if react?
                            (react-pending! port uuid @addrs)   ; --react: execute + ack + reply
                            (println (format "⌘  COMMAND %s  op=%s  (target %s)" l (rf port l "op") r))) (flush)
                          (when once? (System/exit 0)))

                      ;; Backward-compatible recovery for unscoped listeners and
                      ;; historical producers that used failed_by retraction as
                      ;; their activation edge.
                      (and (= op "retract") (= p "failed_by")
                           (str/starts-with? (str l) "@cmd:")
                           (contains? @addrs (rf port l "target")))
                      (do (when react? (react-pending! port uuid @addrs)) (flush))

                      ;; (d) watched-thread activity
                      (and (= op "assert") (contains? @watched l))
                      (do (println (format "◆  THREAD %s  %s = %s" l p r)) (flush)
                          (when once? (System/exit 0)))))))
              ;; --scoped re-scope: break the inner read-loop so the outer reconnects with the new filter
              (if @reconnect?
                (do (println "  ↳ re-scoping subscription (addr/watch changed)…") (flush))
                (recur))))))
      (when @reconnect? (recur)))))
