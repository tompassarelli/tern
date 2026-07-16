#!/usr/bin/env bb
;; agents-cli.clj — north's agent verbs: spawn · delegate · agents · watch · tell · retask.
;; Agents are a NORTH concern (spawns run on the north substrate, register presence,
;; write facts); this file is their CLI home. bin/north routes the verbs here.
;; Ported from the convoy cockpit 2026-07-09 when the ownership rule moved the
;; verbs to their owner; convoy remains the cross-stack dashboard (my-agents).
;; Vocabulary law: facts (never claims), lanes/agents (never fleet).

(require '[babashka.process :as p]
         '[clojure.string :as str]
         '[clojure.java.io :as io])

(def HOME (System/getenv "HOME"))
(def NORTH (str HOME "/code/north"))
(def GAFFER (str HOME "/code/gaffer"))
(def AGENT-LOGDIR (str HOME "/.local/state/north/agents"))
(def DIAL-TABLE (str GAFFER "/docs/adapters/north.md"))
(def PORT (or (System/getenv "NORTH_PORT") "7977"))

(def color? (and (nil? (System/getenv "NO_COLOR"))
                 (some? (System/console))))
(defn- c [code s] (if color? (str "[" code "m" s "[0m") (str s)))
(defn dim [s]  (c "2" s))
(defn bold [s] (c "1" s))
(defn grn [s]  (c "32" s))
(defn red [s]  (c "31" s))
(defn ylw [s]  (c "33" s))
(defn cyn [s]  (c "36" s))

(defn run [argv & {:keys [timeout in] :or {timeout 4000}}]
  (try
    (let [proc (p/process argv (cond-> {:out :string :err :string} in (assoc :in in)))
          res  (deref proc timeout ::timeout)]
      (if (= res ::timeout)
        (do (p/destroy-tree proc) {:timeout true :ok false})
        {:out (or (:out res) "") :err (or (:err res) "") :exit (:exit res)
         :ok (zero? (:exit res))}))
    (catch Exception e {:error (.getMessage e) :ok false})))

(defn echo-cmd [& parts] (println (dim (str "» " (str/join " " parts)))))

;; ---- gaffer dial table (parse the canonical block; never fork doctrine) -----
;; `fable` joins the model alternation for the owner-ordered window (routing-overhaul
;; PART 3) so a Fable row parses if one ever lands; the live Fable routing is the
;; date-gated synthetic-roles override below, NOT a doctrine dial-table row.
(defn dial-table []
  (when (.exists (io/file DIAL-TABLE))
    (->> (slurp DIAL-TABLE) str/split-lines
         (keep (fn [ln]
                 (when-let [[_ role tier model effort trole posture]
                            (re-matches
                             #"\s+([a-z]+)\s+(economy|standard|senior|frontier)\s+(sonnet|opus|haiku|fable)/(low|medium|high|xhigh|max)\s+(\S+)\s+(\S+)\s*"
                             ln)]
                   [role {:tier tier :model model :effort effort
                          :north-role (when-not (#{"—" "-"} trole) trole)
                          :posture posture}])))
         (into {}))))

;; ---- Fable window — mechanical, owner-ordered, auto-expiring (routing-overhaul PART 3)
;; Cutoff 2026-07-13T00:00 Asia/Shanghai (system tz) = 2026-07-12T16:00:00Z. The Clojure
;; twin of sdk/src/fable-window.ts; NORTH_FABLE_NOW (ISO-8601 instant) overrides "now" so
;; the gate is testable without touching the system clock. After the cutoff this flips
;; with zero code change: orchestrator dials fall back to opus/xhigh.
(def FABLE-WINDOW-END (java.time.Instant/parse "2026-07-12T16:00:00Z"))
(defn fable-window-open?
  ([] (fable-window-open?
       (or (some-> (System/getenv "NORTH_FABLE_NOW") java.time.Instant/parse)
           (java.time.Instant/now))))
  ([now] (.isBefore now FABLE-WINDOW-END)))

;; Two-tier synthetic roles (routing-overhaul PART 2/3) — NOT gaffer squad roles, so
;; not in the dial table: they resolve the TIER, date-gated.
;;   orchestrator — the decompose-and-fan-out fork. Window: fable/high; after: opus/xhigh.
;;     No north-role/posture: its contract rides in the delegate brief, not a worker block
;;     (a worker posture block would inject the interned "don't sub-delegate" clause and
;;     contradict the orchestrator's mandate to fan out).
;;   worker — the interned default when a fan-out subtask has no sharper shape. Window
;;     floor rises to opus/xhigh; after: opus/high. Carries the deliver posture (hence the
;;     interned clause). Sharper shapes still route to the gaffer squad roles as usual.
(defn synthetic-roles []
  (let [open? (fable-window-open?)]
    {"orchestrator" {:model (if open? "fable" "opus")
                     :effort (if open? "high" "xhigh")
                     :north-role nil :posture nil}
     "worker"       {:model "opus"
                     :effort (if open? "xhigh" "high")
                     :north-role "integrator" :posture "deliver"}}))

;; ---- agent identity facts (one log scan; single-valued predicates) ----------
(defn agent-facts []
  (let [log-path (str HOME "/.local/state/north/facts.log")]
    (when (.exists (io/file log-path))
      (try
        (->> (str/split-lines (slurp log-path))
             (filter #(str/includes? % "\"@agent:"))
             (keep (fn [ln]
                     (when-let [[_ subj] (re-find #":l\s+\"(@agent:[^\"]+)\"" ln)]
                       (let [id   (subs subj (count "@agent:"))
                             op   (some-> (re-find #":op\s+\"([^\"]+)\"" ln) second)
                             pred (some-> (re-find #":p\s+\"([^\"]+)\"" ln) second)
                             val  (some-> (re-find #":r\s+\"((?:[^\"\\\\]|\\\\.)*)\"" ln) second)]
                         (when (and op pred) {:id id :op op :pred pred :val (or val "")})))))
             (reduce (fn [acc {:keys [id op pred val]}]
                       (if (= op "assert") (assoc-in acc [id pred] val)
                           (update acc id dissoc pred)))
                     {}))
        (catch Exception _ {})))))

(defn current-repo []
  (let [r (run ["git" "remote" "get-url" "origin"] :timeout 1500)]
    (if (:ok r)
      (some-> (:out r) str/trim (str/split #"[/:]") last (str/replace #"\.git$" ""))
      (some-> (System/getProperty "user.dir") (str/split #"/") last))))

(defn render-display-name [id {:strs [role kind repo model effort goal]}]
  (let [r (or role kind "agent")
        at (if repo (str "@" repo) "")
        dial (str (or model "?") "-" (or effort "?"))
        g (when (seq goal) (str " — " (if (> (count goal) 40) (str (subs goal 0 37) "…") goal)))]
    (str r at " " dial g " (" id ")")))

;; ---- presence ---------------------------------------------------------------
(defn presence-rows []
  (let [r (run ["bb" (str NORTH "/cli/presence-cli.clj") PORT "presence"] :timeout 6000)]
    (cond
      (:timeout r) {:err "presence probe timed out"}
      (not (:ok r)) {:err "presence unavailable"}
      :else
      {:agents
       (for [ln (->> (str/split-lines (:out r)) (drop 1) (remove str/blank?))
             :let [toks (str/split (str/trim ln) #"\s+")
                   agent (first toks)
                   online (some #{"yes" "no"} toks)
                   expires (some #(when (re-matches #"\d+s|lapsed" %) %) toks)
                   focus (last toks)]
             :when (and agent (seq agent))]
         {:id agent :online (= online "yes") :expires (or expires "?")
          :focus (when-not (#{"-" online expires} focus) focus)})})))

;; ---- verbs -------------------------------------------------------------------
(defn cmd-agents [_]
  (echo-cmd "bb" (str NORTH "/cli/presence-cli.clj") PORT "presence")
  (let [pr (presence-rows)
        af (or (agent-facts) {})]
    (if (:err pr)
      (println (ylw (:err pr)))
      (let [live (filter :online (:agents pr))]
        (println (bold (str (count live) " live agents")))
        (doseq [a live]
          (let [dn (get-in af [(:id a) "display_name"])
                ;; display_name already ends with "(id)" — only append when absent
                label (if dn (str (format "%-40s" dn)
                                  (when-not (str/includes? dn (:id a)) (dim (str " (" (:id a) ")"))))
                          (format "%-22s" (:id a)))]
            (println (str "  " (grn "●") " " label
                          (dim (str "  ttl " (:expires a)))
                          (when (:focus a) (str "  " (:focus a)))))))))))

(defn cmd-spawn [args]
  (let [dry? (some #{"--dry-run"} args)
        notify (second (drop-while #(not= "--notify" %) args))
        provider (second (drop-while #(not= "--provider" %) args))
        [role prompt] (remove #(or (#{"--dry-run" "--notify" "--provider"} %) (= % notify) (= % provider)) args)
        ;; gaffer squad roles from the canonical table + the date-gated two-tier synthetic
        ;; roles (orchestrator/worker); synthetics win a name clash (there are none).
        dt (merge (or (dial-table) {}) (synthetic-roles))]
    (cond
      (or (nil? role) (nil? prompt))
      (do (println (red "usage:") "north spawn <role> \"<prompt>\" [--provider auto|anthropic|openai] [--notify <peer>] [--dry-run]")
          (println "roles:" (str/join " " (sort (keys dt)))))
      (not (dt role))
      (do (println (red (str "unknown role: " role)))
          (println "roles:" (str/join " " (sort (keys dt)))))
      :else
      (let [{:keys [tier model effort north-role posture]} (dt role)
            aid (str "lane-" (subs (str (java.util.UUID/randomUUID)) 0 8))
            env (cond-> {"AGENT_ID" aid "AGENT_TIER" tier "AGENT_MODEL" model "AGENT_EFFORT" effort}
                  provider   (assoc "AGENT_PROVIDER" provider)
                  north-role (assoc "AGENT_ROLE" north-role)
                  posture   (assoc "AGENT_POSTURE" posture)
                  notify    (assoc "AGENT_COORDINATOR" notify))
            spawn-ts (str NORTH "/sdk/src/spawn.ts")
            envs (str/join " " (map (fn [[k v]] (str k "=" v)) (sort env)))]
        (println (dim "# gaffer dials for role") (bold role) (dim "->")
                 (str "model=" model " effort=" effort
                      (when north-role (str " role=" north-role))
                      (when posture (str " posture=" posture))))
        (echo-cmd envs "bun run" spawn-ts (str "\"" prompt "\""))
        (if dry?
          (let [dn (render-display-name aid {"role" role "repo" (or (current-repo) "?")
                                             "model" model "effort" effort "goal" (str/trim prompt)})]
            (println (ylw "[dry-run]") "not executed. agent-id would be" (bold aid))
            (println (str "  display_name: " (bold dn))))
          (let [log (io/file AGENT-LOGDIR (str aid ".log"))]
            (.mkdirs (.getParentFile log))
            (p/process (into [] ["bun" "run" spawn-ts prompt])
                       {:extra-env env :out :write :err :write :out-file log :err-file log})
            (println (grn "spawned") (bold aid))
            (println "watch:" (cyn (str "north watch " aid)))))))))

;; delegate = the ONE delegation verb; whether to carry context is BINARY (y/n),
;; not a separate verb. `--context <file>` attaches a brief so the lane
;; inherits where the coordinator left off (files, decisions, constraints);
;; without it, a fresh right-sized lane takes the task with no baggage. (ASYMMETRY:
;; the chat /delegate carries the session BY DEFAULT (mechanical fork) — a shell can
;; carry ITSELF forward; the shell has no session to fork, so it attaches a
;; pre-composed file instead.) Spawns the ORCHESTRATOR tier (two-tier law:
;; date-gated fable/opus dials, no worker role/posture — its contract rides in
;; the brief), full lifecycle (id mint + identity facts + presence +
;; completion/death ping). Merges the retired request + fork verbs (2026-07-10).
(defn cmd-delegate [args]
  (let [notify (or (second (drop-while #(not= "--notify" %) args))
                   (System/getenv "NORTH_NOTIFY"))
        ctx-file (second (drop-while #(not= "--context" %) args))
        skip (set (remove nil? [notify ctx-file]))
        text (str/join " " (remove #(or (#{"--notify" "--context" "--dry-run"} %)
                                        (skip %)) args))
        dry? (some #{"--dry-run"} args)
        ctx (when ctx-file
              (let [f (io/file ctx-file)]
                (when-not (.exists f)
                  (println (red "context file not found:") ctx-file)
                  (System/exit 1))
                (str/trim (slurp f))))
        contract (str (if ctx "You carry the coordinator's context (above) — continue the work; "
                              "You are a fresh managed lane — take the task forward. ")
                      (when ctx "do not re-discover what the brief already states. ")
                      "Decide your TIER by the task's shape — there is no third tier below you. "
                      "DECOMPOSES (>=2 independent subtasks) => you are the ORCHESTRATOR: fan out "
                      "one sub-spawn per subtask, in parallel, THIS turn, at the right gaffer dials; "
                      "do NOT execute subtasks yourself (read/analyze, spawn, steer, verify, "
                      "integrate); own the seams and verify workers' load-bearing claims. "
                      "CHECKPOINT DISCIPLINE (a silent reduce phase is how orchestrators wedge): "
                      "your FIRST act is a report skeleton in docs/private/ + the fan-out, both "
                      "within your first 3 turns; keep turns SHORT thereafter, appending each "
                      "worker's result to the skeleton AS it returns — so partial state is always "
                      "on disk and a stall is caught early, never lost to silence. "
                      "Decompose by the STOP-RULE: split only while further subdivision buys "
                      "independence, certainty, or verifiability more than it costs integration; "
                      "a subtask is TERMINAL (stop) when it has clear objective, bounded scope, "
                      "known inputs/outputs, and a verification path — give each sub-spawn that "
                      "LOCAL contract. YOU own the REDUCTION: child outputs return to and "
                      "reconcile in you, never flat fan-in; over-parallelize exploration, "
                      "converge execution; width and sequential waves are open, depth stays two. "
                      "ATOMIC => you are the INTERNED WORKER: own it end-to-end and do NOT "
                      "sub-delegate, except spawning ONE verifier for your own deliverable "
                      "(no worker spawns workers); your deliverable returns UP to your "
                      "orchestrator. Escalation is wired (struggling workers climb "
                      "the ladder). Strictly synchronous — and STAY ALIVE: ending a turn = "
                      "process EXIT; NEVER end a turn while your workers still run or to "
                      "'await pings' (a real orchestrator died this way) — hold the turn, "
                      "poll with short sleeps, reconcile every child before moving on. "
                      "Commit checkpoints; never push unless asked; report to docs/private/.")
        brief (str (when ctx (str "CONTEXT BRIEF:\n" ctx "\n\n"))
                   "DELEGATE TASK: " text
                   "\n\nOPERATING CONTRACT: " contract)]
    (if (str/blank? text)
      (println (red "usage:") "north delegate \"<task>\" [--context <file>] [--notify <peer>]")
      (cmd-spawn (cond-> ["orchestrator" brief]
                   dry?   (conj "--dry-run")
                   notify (into ["--notify" notify]))))))

(defn cmd-watch [[id & _]]
  (if (nil? id)
    (println (red "usage:") "north watch <agent-id>")
    (let [log (io/file AGENT-LOGDIR (str id ".log"))]
      (if (.exists log)
        (do (echo-cmd "tail -n 40 -f" (str log))
            (p/exec "tail" "-n" "40" "-f" (str log)))
        (do (println (ylw "no transcript log at") (str log))
            (println "fallback:" (cyn "open http://127.0.0.1:8088") (dim "(north web)")))))))

(defn cmd-tell-agent [args]
  (let [rest0 (vec (remove #{"--dry-run"} args))
        dry? (some #{"--dry-run"} args)
        from-idx (.indexOf rest0 "--from")
        from (if (>= from-idx 0) (nth rest0 (inc from-idx) nil)
                 (or (System/getenv "NORTH_AGENT_ID") "north-cli"))
        pos (if (>= from-idx 0)
              (keep-indexed #(when-not (#{from-idx (inc from-idx)} %1) %2) rest0)
              rest0)
        [id msg] pos]
    (if (or (nil? id) (nil? msg))
      (println (red "usage:") "north steer <agent-id> \"<msg>\" [--from <me>]")
      (let [argv ["bb" (str NORTH "/cli/msg-cli.clj") PORT "send" from id "steer" msg]]
        (echo-cmd (str/join " " argv))
        (if dry?
          (println (ylw "[dry-run]") "not sent.")
          (let [r (run argv :timeout 4000)]
            (println (if (:ok r) (grn "sent") (red "send failed")))))))))

;; retask: goal fact replaced + display_name recomputed — the steer that survives
;; context loss (facts, not chat).
(defn cmd-retask [[id goal & _]]
  (if (or (nil? id) (nil? goal))
    (println (red "usage:") "north retask <agent-id> \"<new-goal>\"")
    (let [subj (str "agent:" (str/replace-first id #"^@?(agent:)?" ""))
          bare (subs subj (count "agent:"))
          north-bin (str NORTH "/bin/north")
          t1 (run [north-bin "tell" subj "goal" goal] :timeout 6000)
          af (or (agent-facts) {})
          facts (assoc (get af bare {}) "goal" goal)
          dn (render-display-name bare facts)
          t2 (run [north-bin "tell" subj "display_name" dn] :timeout 6000)]
      (if (and (:ok t1) (:ok t2))
        (do (println (grn "retasked") (bold bare))
            (println "  " dn))
        (do (println (red "retask failed"))
            (doseq [r [t1 t2] :when (not (:ok r))]
              (println (str/trim (str (:out r) (:err r))))))))))

;; ---- dispatch ------------------------------------------------------------------
(let [[cmd & args] *command-line-args*]
  (case cmd
    "agents"  (cmd-agents args)
    "spawn"   (cmd-spawn args)
    "delegate" (cmd-delegate args)
    ;; delegation unified to ONE verb 2026-07-10 (context is a parameter, not a
    ;; separate verb) — request/fork/req teach, don't alias (slash-command precedent).
    "request" (do (println "renamed: north delegate") (System/exit 1))
    "fork"    (do (println "renamed: north delegate") (System/exit 1))
    "req"     (do (println "renamed: north delegate") (System/exit 1))
    "watch"   (cmd-watch args)
    "steer"   (cmd-tell-agent args)
    "retask"  (cmd-retask args)
    (do (println "usage: north {agents|spawn|delegate|watch|steer|retask} ...")
        (System/exit 1))))
