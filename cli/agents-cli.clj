#!/usr/bin/env bb
;; agents-cli.clj — north's agent verbs: spawn · delegate · agents · watch · tell · retask.
;; Agents are a NORTH concern (spawns run on the north substrate, register presence,
;; write facts); this file is their CLI home. bin/north routes the verbs here.
;; Ported from the convoy cockpit 2026-07-09 when the ownership rule moved the
;; verbs to their owner; convoy remains the cross-stack dashboard (my-agents).
;; Vocabulary law: facts (never claims), lanes/agents (never fleet).

(require '[babashka.process :as p]
         '[clojure.string :as str]
         '[clojure.java.io :as io]
         '[cheshire.core :as json])

(def HOME (System/getenv "HOME"))
(def NORTH (or (System/getenv "NORTH_HOME")
               (some-> *file* io/file .getCanonicalFile .getParentFile .getParentFile str)))
(def GAFFER (or (System/getenv "GAFFER_HOME") (str HOME "/code/gaffer")))
(def AGENT-LOGDIR (str HOME "/.local/state/north/agents"))
(def GAFFER-STAFFING (or (System/getenv "GAFFER_STAFFING_CATALOG")
                         (str GAFFER "/staffing/catalog.json")))
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

;; ---- gaffer staffing catalog (canonical; generated markdown is adapter-only) -
(defn gaffer-catalog []
  (let [f (io/file GAFFER-STAFFING)]
    (when (.isFile f) (json/parse-string (slurp f) true))))

(defn gaffer-routing []
  (when-let [{:keys [recipes aliases defaults]} (gaffer-catalog)]
      (let [
            preset (fn [r]
                     (let [name (:name r)]
                       [name (-> (merge defaults r)
                                 (assoc :role name :gaffer-preset true
                                        :composition {:kind "preset" :id name}))]))
            roles (into {} (map preset recipes))]
        (reduce (fn [acc {:keys [name target]}]
                  (if-let [r (get roles target)]
                    (assoc acc name (assoc r :role target))
                    acc))
                roles aliases))))

;; ---- Fable window — mechanical, owner-ordered, auto-expiring (routing-overhaul PART 3)
;; Promotion ends 2026-07-19T23:59:59 PDT (UTC-7); clean exclusive cutoff is
;; 2026-07-20T07:00:00Z (= 2026-07-20 15:00 Asia/Taipei). The Clojure
;; twin of sdk/src/fable-window.ts; NORTH_FABLE_NOW (ISO-8601 instant) overrides "now" so
;; the gate is testable without touching the system clock. After the cutoff this flips
;; with zero code change: orchestrator dials fall back to opus/xhigh.
(def FABLE-WINDOW-END (java.time.Instant/parse "2026-07-20T07:00:00Z"))
(defn fable-window-open?
  ([] (fable-window-open?
       (or (some-> (System/getenv "NORTH_FABLE_NOW") java.time.Instant/parse)
           (java.time.Instant/now))))
  ([now] (.isBefore now FABLE-WINDOW-END)))

;; Two-tier synthetic roles are semantic orchestration shapes, never provider
;; model aliases. Provider adapters resolve these tiers independently.
;;   orchestrator — the decompose-and-fan-out fork: frontier/orchestrator.
;;     No north-role/posture: its contract rides in the delegate brief, not a worker block
;;     (a worker posture block would inject the interned "don't sub-delegate" clause and
;;     contradict the orchestrator's mandate to fan out).
;;   worker — the interned default when a fan-out subtask has no sharper shape. Senior
;;     implementation floor. Carries the deliver posture (hence the
;;     interned clause). Sharper shapes still route to the gaffer squad roles as usual.
(defn synthetic-roles []
  {"orchestrator" {:tier "frontier" :topology "orchestrator" :semantic true :posture nil}
   "worker"       {:tier "senior" :reasoning "high" :topology "worker"
                   :role "integrator" :semantic true :posture "deliver"}})

;; ---- agent identity facts (one log scan; single-valued predicates) ----------
(defn agent-facts []
  (let [r (run [(str NORTH "/bin/north") "json" "agents"] :timeout 10000)]
    (if-not (:ok r) {}
      (try
        (reduce (fn [acc {:keys [id predicate value]}]
                  (assoc-in acc [id predicate] value))
                {} (json/parse-string (:out r) true))
        (catch Exception _ {})))))

(defn current-repo []
  (let [r (run ["git" "remote" "get-url" "origin"] :timeout 1500)]
    (if (:ok r)
      (some-> (:out r) str/trim (str/split #"[/:]") last (str/replace #"\.git$" ""))
      (some-> (System/getProperty "user.dir") (str/split #"/") last))))

(defn render-display-name [id {:strs [role kind repo tier model effort goal]}]
  (let [r (or role kind "agent")
        at (if repo (str "@" repo) "")
        dial (if tier (str "tier:" tier) (str (or model "?") "-" (or effort "?")))
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

(def spawn-flags
  {"--notify" :notify "--provider" :provider "--taskGrade" :taskGrade "--task-grade" :taskGrade
   "--domain" :domain "--topology" :topology "--tier" :tier "--reasoning" :reasoning
   "--deliberation" :reasoning "--posture" :posture "--composition" :composition
   "--rationale" :rationale "--nearest" :nearest})

(defn- parse-spawn-args [args]
  (loop [xs args positionals [] opts {:domains []}]
    (if-let [x (first xs)]
      (cond
        (= x "--dry-run") (recur (rest xs) positionals (assoc opts :dry? true))
        (= x "--nominate") (recur (rest xs) positionals (assoc opts :nominate? true))
        (spawn-flags x) (let [v (second xs)]
                          (when (or (nil? v) (str/starts-with? v "--"))
                            (println (red (str x " requires a value"))) (System/exit 1))
                          (recur (nnext xs) positionals
                                 (if (= :domain (spawn-flags x))
                                   (update opts :domains into (remove str/blank? (map str/trim (str/split v #","))))
                                   (assoc opts (spawn-flags x) v))))
        (str/starts-with? x "--") (do (println (red (str "unknown spawn option: " x))) (System/exit 1))
        :else (recur (rest xs) (conj positionals x) opts))
      (assoc opts :positionals positionals))))

(defn cmd-spawn [args]
  (let [{:keys [dry? nominate? notify provider taskGrade domains topology tier reasoning posture composition rationale nearest positionals]}
        (parse-spawn-args args)
        [invoked-role prompt & extra] positionals
        ;; Gaffer presets from staffing/catalog.json + date-gated two-tier synthetic
        ;; roles (orchestrator/worker); synthetics win a name clash (there are none).
        catalog (gaffer-catalog)
        dt (merge (or (gaffer-routing) {}) (synthetic-roles))
        supplied-composition (when composition
                               (try (json/parse-string composition true)
                                    (catch Exception _
                                      (println (red "--composition must be valid JSON")) (System/exit 1))))
        canonical (get dt invoked-role)
        bespoke-reason (or rationale (:bespokeReason supplied-composition))
        nearest-role (or nearest (:nearestPreset supplied-composition))
        nearest-template (get dt nearest-role)
        bespoke? (and invoked-role (nil? canonical))
        base (or canonical nearest-template (:defaults catalog))]
    (cond
      (or (nil? invoked-role) (nil? prompt) (seq extra))
      (do (println (red "usage:") "north spawn <role> \"<prompt>\" [--taskGrade G] [--domain D] [--topology T] [--tier T] [--reasoning R] [--posture P] [--composition JSON] [--rationale WHY] [--provider P] [--notify PEER] [--dry-run]")
          (println "roles:" (str/join " " (sort (keys dt)))))
      (and bespoke? (str/blank? bespoke-reason))
      (do (println (red (str "bespoke role " invoked-role " requires --rationale or composition.bespokeReason")))
          (println "roles:" (str/join " " (sort (keys dt)))))
      (and nearest (nil? nearest-template))
      (println (red (str "unknown nearest preset: " nearest)))
      :else
      (let [{preset-grade :taskGrade preset-tier :tier model :model synthetic-effort :effort synthetic-reasoning :reasoning
             preset-role :role preset-posture :posture preset-topology :topology preset-composition :composition
             preset-deliberation :deliberation gaffer-preset :gaffer-preset semantic :semantic} base
            taskGrade (or taskGrade preset-grade)
            tier (or tier preset-tier)
            topology (or topology preset-topology)
            role (cond bespoke? invoked-role gaffer-preset (or preset-role invoked-role) :else preset-role)
            posture (or posture preset-posture (when (or gaffer-preset bespoke?) (:posture (:defaults catalog))))
            reasoning (or reasoning preset-deliberation synthetic-reasoning synthetic-effort)
            composition (or supplied-composition preset-composition
                            (when bespoke?
                              (cond-> {:kind "bespoke" :id invoked-role
                                       :bespokeReason bespoke-reason :promotionCandidate (boolean nominate?)}
                                nearest-role (assoc :nearestPreset nearest-role))))
            aid (str "lane-" (subs (str (java.util.UUID/randomUUID)) 0 8))
            env (cond-> {"AGENT_ID" aid}
                  taskGrade  (assoc "AGENT_TASK_GRADE" taskGrade)
                  (seq domains) (assoc "AGENT_DOMAIN_REQUIREMENTS" (json/generate-string (vec (distinct domains))))
                  topology   (assoc "AGENT_TOPOLOGY" topology)
                  tier       (assoc "AGENT_TIER" tier)
                  role       (assoc "AGENT_ROLE" role)
                  posture    (assoc "AGENT_POSTURE" posture)
                  composition (assoc "AGENT_COMPOSITION" (json/generate-string composition))
                  (and (not semantic) (not gaffer-preset) model)  (assoc "AGENT_MODEL" model)
                  reasoning (assoc "AGENT_REASONING" reasoning "AGENT_EFFORT" reasoning)
                  provider   (assoc "AGENT_PROVIDER" provider)
                  notify    (assoc "AGENT_COORDINATOR" notify))
            spawn-ts (str NORTH "/sdk/src/spawn.ts")
            envs (str/join " " (map (fn [[k v]] (str k "=" v)) (sort env)))]
        (println (dim "# gaffer dials for role") (bold invoked-role) (dim "->")
                 (str "grade=" taskGrade " tier=" tier " reasoning=" reasoning
                      (when (and (not semantic) (not gaffer-preset)) (str " model=" model))
                      (when role (str " role=" role))
                      (when posture (str " posture=" posture))
                      (when topology (str " topology=" topology))
                      (when (seq domains) (str " domains=" (str/join "," domains)))))
        (echo-cmd envs "bun run" spawn-ts (str "\"" prompt "\""))
        (if dry?
          (let [dn (render-display-name aid
                                        (cond-> {"role" (or role invoked-role)
                                                 "repo" (or (current-repo) "?")
                                                 "goal" (str/trim prompt)}
                                          (or gaffer-preset semantic) (assoc "tier" tier)
                                          (and (not semantic) (not gaffer-preset)) (assoc "model" model "effort" reasoning)))]
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
(when-not (= (System/getenv "NORTH_AGENTS_LIB") "1")
  (let [[cmd & args] *command-line-args*]
    (case cmd
      "agents"  (cmd-agents args)
      "spawn"   (cmd-spawn args)
      "delegate" (cmd-delegate args)
      ;; delegation unified to ONE verb; request/fork/req teach, don't alias.
      "request" (do (println "renamed: north delegate") (System/exit 1))
      "fork"    (do (println "renamed: north delegate") (System/exit 1))
      "req"     (do (println "renamed: north delegate") (System/exit 1))
      "watch"   (cmd-watch args)
      "steer"   (cmd-tell-agent args)
      "retask"  (cmd-retask args)
      (do (println "usage: north {agents|spawn|delegate|watch|steer|retask} ...")
          (System/exit 1)))))
