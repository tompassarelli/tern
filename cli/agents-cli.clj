#!/usr/bin/env bb
;; agents-cli.clj — tern's agent verbs: spawn · req · agents · watch · tell · retask.
;; Agents are a TERN concern (spawns run on the tern substrate, register presence,
;; write facts); this file is their CLI home. bin/tern routes the verbs here.
;; Ported from the convoy cockpit 2026-07-09 when the ownership rule moved the
;; verbs to their owner; convoy remains the cross-stack dashboard (my-agents).
;; Vocabulary law: facts (never claims), lanes/agents (never fleet).

(require '[babashka.process :as p]
         '[clojure.string :as str]
         '[clojure.java.io :as io])

(def HOME (System/getenv "HOME"))
(def TERN (str HOME "/code/tern"))
(def GAFFER (str HOME "/code/gaffer"))
(def AGENT-LOGDIR (str HOME "/.local/state/tern/agents"))
(def DIAL-TABLE (str GAFFER "/docs/adapters/tern.md"))
(def PORT (or (System/getenv "TERN_PORT") "7977"))

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
(defn dial-table []
  (when (.exists (io/file DIAL-TABLE))
    (->> (slurp DIAL-TABLE) str/split-lines
         (keep (fn [ln]
                 (when-let [[_ role model effort trole posture]
                            (re-matches
                             #"\s+([a-z]+)\s+(sonnet|opus|haiku)\s+(low|medium|high|xhigh|max)\s+(\S+)\s+(\S+)\s*"
                             ln)]
                   [role {:model model :effort effort
                          :tern-role (when-not (#{"—" "-"} trole) trole)
                          :posture posture}])))
         (into {}))))

;; ---- agent identity facts (one log scan; single-valued predicates) ----------
(defn agent-facts []
  (let [log-path (str HOME "/.local/state/tern/facts.log")]
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
  (let [r (run ["bb" (str TERN "/cli/presence-cli.clj") PORT "presence"] :timeout 6000)]
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
  (echo-cmd "bb" (str TERN "/cli/presence-cli.clj") PORT "presence")
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
        [role prompt] (remove #(or (#{"--dry-run" "--notify"} %) (= % notify)) args)
        dt (dial-table)]
    (cond
      (nil? dt) (println (red "gaffer dial table not found:") DIAL-TABLE)
      (or (nil? role) (nil? prompt))
      (do (println (red "usage:") "tern spawn <role> \"<prompt>\" [--notify <peer>] [--dry-run]")
          (println "roles:" (str/join " " (sort (keys dt)))))
      (not (dt role))
      (do (println (red (str "unknown role: " role)))
          (println "roles:" (str/join " " (sort (keys dt)))))
      :else
      (let [{:keys [model effort tern-role posture]} (dt role)
            aid (str "lane-" (subs (str (java.util.UUID/randomUUID)) 0 8))
            env (cond-> {"AGENT_ID" aid "AGENT_MODEL" model "AGENT_EFFORT" effort}
                  tern-role (assoc "AGENT_ROLE" tern-role)
                  posture   (assoc "AGENT_POSTURE" posture)
                  notify    (assoc "AGENT_COORDINATOR" notify))
            spawn-ts (str TERN "/sdk/src/spawn.ts")
            envs (str/join " " (map (fn [[k v]] (str k "=" v)) (sort env)))]
        (println (dim "# gaffer dials for role") (bold role) (dim "->")
                 (str "model=" model " effort=" effort
                      (when tern-role (str " role=" tern-role))
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
            (println "watch:" (cyn (str "tern watch " aid)))))))))

;; req = fork-everything intake: self-triaging opus-high handler + ping-back.
(defn cmd-req [args]
  (let [notify (or (second (drop-while #(not= "--notify" %) args))
                   (System/getenv "TERN_NOTIFY"))
        text (str/join " " (remove #(or (#{"--notify" "--dry-run"} %)
                                        (= % notify)) args))
        dry? (some #{"--dry-run"} args)
        contract (str "Your first act is triage. If this request is execute/implement-shaped "
                      "and beneath your tier, sub-spawn it at the right gaffer dials and "
                      "supervise; if it is your shape, do it yourself; if it decomposes, fan "
                      "out sub-spawns in parallel (escalation is wired — prefer routing down). "
                      "Strictly synchronous; commit checkpoints; never push unless asked; "
                      "report to docs/private/.")]
    (if (str/blank? text)
      (println (red "usage:") "tern req \"<request>\" [--notify <peer>]")
      (cmd-spawn (cond-> ["integrator" (str "REQUEST: " text "\n\nOPERATING CONTRACT: " contract)]
                   dry?   (conj "--dry-run")
                   notify (into ["--notify" notify]))))))

(defn cmd-watch [[id & _]]
  (if (nil? id)
    (println (red "usage:") "tern watch <agent-id>")
    (let [log (io/file AGENT-LOGDIR (str id ".log"))]
      (if (.exists log)
        (do (echo-cmd "tail -n 40 -f" (str log))
            (p/exec "tail" "-n" "40" "-f" (str log)))
        (do (println (ylw "no transcript log at") (str log))
            (println "fallback:" (cyn "open http://127.0.0.1:8088") (dim "(tern web)")))))))

(defn cmd-tell-agent [args]
  (let [rest0 (vec (remove #{"--dry-run"} args))
        dry? (some #{"--dry-run"} args)
        from-idx (.indexOf rest0 "--from")
        from (if (>= from-idx 0) (nth rest0 (inc from-idx) nil)
                 (or (System/getenv "TERN_AGENT_ID") "tern-cli"))
        pos (if (>= from-idx 0)
              (keep-indexed #(when-not (#{from-idx (inc from-idx)} %1) %2) rest0)
              rest0)
        [id msg] pos]
    (if (or (nil? id) (nil? msg))
      (println (red "usage:") "tern steer <agent-id> \"<msg>\" [--from <me>]")
      (let [argv ["bb" (str TERN "/cli/msg-cli.clj") PORT "send" from id "steer" msg]]
        (echo-cmd (str/join " " argv))
        (if dry?
          (println (ylw "[dry-run]") "not sent.")
          (let [r (run argv :timeout 4000)]
            (println (if (:ok r) (grn "sent") (red "send failed")))))))))

;; retask: goal fact replaced + display_name recomputed — the steer that survives
;; context loss (facts, not chat).
(defn cmd-retask [[id goal & _]]
  (if (or (nil? id) (nil? goal))
    (println (red "usage:") "tern retask <agent-id> \"<new-goal>\"")
    (let [subj (str "agent:" (str/replace-first id #"^@?(agent:)?" ""))
          bare (subs subj (count "agent:"))
          tern-bin (str TERN "/bin/tern")
          t1 (run [tern-bin "tell" subj "goal" goal] :timeout 6000)
          af (or (agent-facts) {})
          facts (assoc (get af bare {}) "goal" goal)
          dn (render-display-name bare facts)
          t2 (run [tern-bin "tell" subj "display_name" dn] :timeout 6000)]
      (if (and (:ok t1) (:ok t2))
        (do (println (grn "retasked") (bold bare))
            (println "  " dn))
        (do (println (red "retask failed"))
            (doseq [r [t1 t2] :when (not (:ok r))]
              (println (str/trim (str (:out r) (:err r))))))))))

;; ---- dispatch ------------------------------------------------------------------
(let [[cmd & args] *command-line-args*]
  (case cmd
    "agents" (cmd-agents args)
    "spawn"  (cmd-spawn args)
    "req"    (cmd-req args)
    "watch"  (cmd-watch args)
    "steer"  (cmd-tell-agent args)
    "retask" (cmd-retask args)
    (do (println "usage: tern {agents|spawn|req|watch|steer|retask} ...")
        (System/exit 1))))
