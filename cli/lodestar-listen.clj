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

(defn send-op [port op]
  (with-open [s (java.net.Socket. "127.0.0.1" (int port))]
    (let [w (.getOutputStream s) r (io/reader (.getInputStream s))]
      (.write w (.getBytes (str (pr-str op) "\n"))) (.flush w)
      (edn/read-string (.readLine r)))))

(defn rf    [port te p] (:value  (send-op port {:op :resolved :te te :p p})))
(defn rmany [port te p] (:values (send-op port {:op :resolved :te te :p p})))
(defn role-slug [r] (when (and (string? r) (>= (count r) 6) (= "@role:" (subs r 0 6))) (subs r 6)))

(defn ack! [port me id]
  (let [v (:version (send-op port {:op :version}))]
    (send-op port {:op :assert :te id :p "acked_by" :r me :base v})))

;; --- Phase 1: the reactor ---------------------------------------------------
;; Parse a mail body as the Phase-0 command envelope (must stay in sync with
;; cli/msg-cli.clj parse-envelope — same contract). Plain bodies -> nil.
(def known-ops #{:dispatch :spawn :tell :claim})
(defn parse-envelope [body]
  (when (and body (str/starts-with? (str/triml (str body)) "{"))
    (let [m (try (edn/read-string body) (catch Exception _ ::bad))]
      (cond (= m ::bad)               {:error "not valid EDN"}
            (not (map? m))            {:error "not an EDN map"}
            (not (known-ops (:op m))) {:error (str "unknown :op " (pr-str (:op m)))}
            (not (map? (:args m)))    {:error ":args not a map"}
            :else                     {:op (:op m) :args (:args m)}))))

(def sdk (or (System/getenv "LODESTAR_SDK") (str (System/getenv "HOME") "/code/lodestar/sdk")))
;; EXECUTE a command envelope: REUSE dispatch.ts/spawn.ts as the executor. Phase 1 wires
;; :spawn + :dispatch (the keystone); :tell/:claim are Phase 2/3.
(defn react! [op args]
  (case op
    :spawn    (do (println (str "   ⚙ spawn: " (pr-str (:prompt args))))
                  (proc/shell {:dir sdk :continue true :extra-env (cond-> {} (:model args) (assoc "AGENT_MODEL" (str (:model args))))}
                              "bun" "src/spawn.ts" (str (:prompt args))))
    :dispatch (do (println (str "   ⚙ dispatch thread " (:thread args)))
                  (proc/shell {:dir sdk :continue true} "bun" "src/dispatch.ts" (str (:thread args))))
    (println (str "   ⚠ op " op " not yet wired in the reactor (Phase 2/3)"))))

(let [[ps uuid & flags] *command-line-args*
      port    (Integer/parseInt ps)
      node    (str "@agent:" uuid)
      once?   (boolean (some #{"--once"} flags))
      ack?    (boolean (some #{"--ack"} flags))
      react?  (boolean (some #{"--react"} flags))   ; Phase 1: execute command-envelope mail (spawn/dispatch) + ack
      addrs   (atom (into #{uuid "*"} (keep role-slug (rmany port node "holds"))))  ; uuid ∪ held roles
      watched (atom (set (rmany port node "watches")))]
  (with-open [s (java.net.Socket. "127.0.0.1" (int port))]
    (let [w (.getOutputStream s) r (io/reader (.getInputStream s))]
      (.write w (.getBytes (str (pr-str {:op :subscribe}) "\n"))) (.flush w)
      (.readLine r)                                              ; consume {:subscribed N}
      (println (format "● @agent:%s listening — addrs %s + %d watched thread(s)%s"
                       uuid (pr-str (sort @addrs)) (count @watched) (if once? "  [--once]" "")))
      (flush)
      (loop []
        (when-let [line (.readLine r)]
          (let [ev (try (edn/read-string line) (catch Exception _ nil))]
            (when (and (map? ev) (= :commit (:event ev)))
              (let [{:keys [op l p r]} ev]
                (cond
                  ;; (a) role (un)assigned to me -> my address set changes live
                  (and (= l node) (= p "holds"))
                  (do (when-let [sl (role-slug r)]
                        (swap! addrs (if (= op "assert") conj disj) sl)
                        (println (format "  ↳ addrs: %s %s (now %s)"
                                         (if (= op "assert") "+role" "-role") sl (pr-str (sort @addrs)))) (flush)))

                  ;; (b) thread watch/unwatch
                  (and (= l node) (= p "watches"))
                  (do (swap! watched (if (= op "assert") conj disj) r)
                      (println (format "  ↳ scope: %s %s (now %d watched)"
                                       (if (= op "assert") "watch" "unwatch") r (count @watched))) (flush))

                  ;; (c) self-channel: a message to my uuid OR a role I hold
                  (and (= op "assert") (= p "to") (contains? @addrs r))
                  (do (Thread/sleep 150)   ; let from/subject/body settle — routing-key "to" lands first
                      (let [body (rf port l "body"), env (parse-envelope body)]
                        (if (and react? env (:op env))
                          ;; REACTOR (--react): a command envelope -> EXECUTE + ack. The closed loop.
                          (do (println (format "⚙  REACT %s  op=%s args=%s  (from %s)"
                                               l (:op env) (pr-str (:args env)) (rf port l "from"))) (flush)
                              (react! (:op env) (:args env))
                              (ack! port uuid l)
                              (println (str "   ↳ executed + acked_by " uuid)) (flush))
                          ;; LISTENER: print (flag a malformed command body if present)
                          (do (when (:error env) (println (str "   ⚠ command body malformed: " (:error env))))
                              (println (format "✉  MAIL %s  (to %s)\n   from:    %s\n   subject: %s\n   body:    %s"
                                               l r (rf port l "from") (rf port l "subject") body))
                              (when ack? (ack! port uuid l) (println (str "   ↳ acked_by " uuid)))
                              (flush))))
                      (when once? (System/exit 0)))

                  ;; (d) watched-thread activity
                  (and (= op "assert") (contains? @watched l))
                  (do (println (format "◆  THREAD %s  %s = %s" l p r)) (flush)
                      (when once? (System/exit 0)))))))
          (recur))))))
