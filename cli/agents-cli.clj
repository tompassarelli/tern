#!/usr/bin/env bb
;; agents-cli.clj — north's agent verbs: spawn · delegate · agents · watch · tell · retask.
;; Agents are a NORTH concern (spawns run on the north substrate, register presence,
;; write facts); this file is their CLI home. bin/north routes the verbs here.
;; Ported from the convoy cockpit 2026-07-09 when the ownership rule moved the
;; verbs to their owner; convoy remains the cross-stack dashboard (my-agents).
;; Vocabulary law: facts (never claims), lanes/agents throughout.

(require '[babashka.process :as p]
         '[clojure.string :as str]
         '[clojure.java.io :as io]
         '[clojure.walk :as walk]
         '[cheshire.core :as json])

(def HOME (System/getenv "HOME"))
(def NORTH (or (System/getenv "NORTH_HOME")
               (some-> *file* io/file .getCanonicalFile .getParentFile .getParentFile str)))
(def NORTH-CLI (or (System/getenv "NORTH_BIN") (str NORTH "/bin/north")))
(def GAFFER (or (System/getenv "GAFFER_HOME") (str HOME "/code/gaffer")))
(def AGENT-LOGDIR (str HOME "/.local/state/north/agents"))
(def GAFFER-STAFFING (or (System/getenv "GAFFER_STAFFING_CATALOG")
                         (str GAFFER "/staffing/catalog.json")))
(def PORT (or (System/getenv "NORTH_PORT") "7977"))

(load-file (str NORTH "/cli/spawn-process.clj"))
(load-file (str NORTH "/cli/topology-authority.clj"))
(load-file (str NORTH "/cli/managed-child-env.clj"))
(load-file (str NORTH "/cli/gaffer-staffing.clj"))

(def color? (and (nil? (System/getenv "NO_COLOR"))
                 (some? (System/console))))
(defn- c [code s] (if color? (str "[" code "m" s "[0m") (str s)))
(defn dim [s]  (c "2" s))
(defn bold [s] (c "1" s))
(defn grn [s]  (c "32" s))
(defn red [s]  (c "31" s))
(defn ylw [s]  (c "33" s))
(defn cyn [s]  (c "36" s))

(defn run [argv & {:keys [timeout in env] :or {timeout 4000}}]
  (try
    (let [proc (p/process argv (cond-> {:out :string :err :string}
                                in (assoc :in in)
                                env (assoc :env env)))
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
    (when (.isFile f)
      (walk/keywordize-keys (north.gaffer-staffing/load-catalog (.getPath f))))))

(defn gaffer-routing []
  (when-let [{:keys [presets aliases defaults]} (gaffer-catalog)]
      (let [
            route (fn [r]
                     (let [name (:name r)]
                       [name (-> (merge defaults r)
                                 (assoc :role name :gaffer-preset true
                                        :composition {:kind "preset" :id name :overrides []}))]))
            roles (into {} (map route presets))]
        (reduce (fn [acc {:keys [name target]}]
                  (if-let [r (get roles target)]
                    (assoc acc name (assoc r :role target))
                    acc))
                roles aliases))))

(defn gaffer-templates []
  (when-let [{:keys [presets defaults]} (gaffer-catalog)]
    (mapv #(merge defaults %) presets)))

(defn cmd-templates [args]
  (when (some #{"--help" "-h" "help"} args)
    (println "north templates — inspect Gaffer's reusable stock templates")
    (println)
    (println "Usage:")
    (println "  north templates             compact template catalog")
    (println "  north templates --verbose   include each template's selection boundary")
    (System/exit 0))
  (when-let [unknown (first (remove #{"--verbose"} args))]
    (binding [*out* *err*]
      (println (red (str "unknown templates option: " unknown)))
      (println "usage: north templates [--verbose]"))
    (System/exit 2))
  (let [verbose? (some #{"--verbose"} args)
        templates (gaffer-templates)]
    (if-not (seq templates)
      (do
        (binding [*out* *err*]
          (println (red (str "Gaffer staffing catalog unavailable: " GAFFER-STAFFING))))
        (System/exit 1))
      (do
        (println (bold "GAFFER STOCK TEMPLATES — reusable starting points, not limits"))
        (println (dim "Selection ladder: exact template → justified axis override → bespoke composition."))
        (println (dim "Machine payloads retain composition.kind=preset; this view uses the human word template."))
        (doseq [{:keys [name tagline taskGrade tier deliberation topology posture
                        capabilities description]} templates]
          (println)
          (println (bold name) "—" tagline)
          (println (dim (str "  grade " taskGrade " · " tier "/" deliberation
                             " · " topology " · " posture)))
          (println (dim (str "  capabilities " (str/join " " capabilities))))
          (when verbose? (println (str "  " description))))))))

(declare fable-window-open?)

(defn dry-resolved-route [provider tier explicit-model reasoning]
  (when (and provider (not= provider "auto"))
    (try
      (let [entry (get-in (json/parse-string
                           (slurp (io/file GAFFER "providers" (str provider ".json"))) true)
                          [:tiers (keyword tier)])
            temporary-fable (and (= provider "anthropic") (= tier "frontier")
                                 (nil? explicit-model) (not= reasoning "max")
                                 (fable-window-open?))]
        {:provider provider
         :model (cond temporary-fable "fable" explicit-model explicit-model :else (:model entry))
         :effort (if temporary-fable (or reasoning "xhigh")
                   (or reasoning (:defaultEffort entry) (:defaultReasoning entry)))})
      (catch Exception _ {:provider provider :model explicit-model :effort reasoning}))))

;; ---- Fable window — mechanical, owner-ordered, auto-expiring (routing-overhaul PART 3)
;; Promotion runs through Sunday 2026-07-19 23:59:59 US Eastern (EDT, UTC-4);
;; the clean exclusive cutoff is 2026-07-20T04:00:00Z
;; (= 2026-07-20 12:00 Asia/Taipei). The Clojure
;; twin of sdk/src/fable-window.ts; NORTH_FABLE_NOW (ISO-8601 instant) overrides "now" so
;; the gate is testable without touching the system clock. After the cutoff this flips
;; with zero code change: orchestrator dials fall back to opus/xhigh.
(def FABLE-WINDOW-END (java.time.Instant/parse "2026-07-20T04:00:00Z"))
(defn fable-window-open?
  ([] (fable-window-open?
       (or (some-> (System/getenv "NORTH_FABLE_NOW") java.time.Instant/parse)
           (java.time.Instant/now))))
  ([now] (.isBefore now FABLE-WINDOW-END)))

;; ---- agent identity facts (one log scan; single-valued predicates) ----------
(defn- bulk-agent-facts []
  (let [r (run [(str NORTH "/bin/north") "json" "agents"] :timeout 10000)]
    (if-not (:ok r) {}
      (try
        (reduce (fn [acc {:keys [id predicate value]}]
                  (update acc id #(north.agent-provenance/fold-fact
                                   (or % {}) predicate value)))
                {} (json/parse-string (:out r) true))
        (catch Exception _ {})))))

(declare known semantic-handle)

(defn- agent-facts-one [id]
  (let [r (run [(str NORTH "/bin/north") "json" "show" (str "agent:" id)] :timeout 3000)]
    (when (:ok r)
      (try
        (reduce (fn [acc {:keys [predicate value]}]
                  (north.agent-provenance/fold-fact acc predicate value))
                {} (json/parse-string (:out r) true))
        (catch Exception _ nil)))))

(defn agent-facts
  ;; Zero arity is the existing library contract used by routing consumers.
  ;; The live-ID arity adds narrow recovery without changing that bulk view.
  ([] (bulk-agent-facts))
  ([ids]
   ;; If bulk fails, or one legacy/malformed record is absent from that
   ;; projection, recover each missing LIVE row from the structured per-agent
   ;; endpoint. Never reverse-parse display text.
   (reduce (fn [facts id]
             (if (contains? facts id)
               facts
               (if-let [one (agent-facts-one id)]
                 (assoc facts id one)
                 facts)))
           (bulk-agent-facts)
           ids)))

(defn current-repo []
  (let [r (run ["git" "remote" "get-url" "origin"] :timeout 1500)]
    (if (:ok r)
      (some-> (:out r) str/trim (str/split #"[/:]") last (str/replace #"\.git$" ""))
      (some-> (System/getProperty "user.dir") (str/split #"/") last))))

(defn- known [value]
  (let [s (some-> value str str/trim)] (when (seq s) s)))

(defn- slug [value]
  (or (some-> (known value) str/lower-case
              (str/replace #"[^a-z0-9]+" "-")
              (str/replace #"(^-|-$)" "")
              known)
      "unknown"))

(defn- model-display [model]
  (let [m (slug model)
        parts (set (str/split m #"-"))]
    (or (some #(when (parts %) %) ["opus" "sonnet" "haiku" "fable" "sol" "terra" "luna"])
        m)))

(defn- meaningful-task [value]
  (let [task (known value)]
    (when-not (#{"CONTEXT BRIEF:" "DELEGATE TASK:" "TASK:"} task) task)))

(defn- composition-overrides [facts]
  (north.agent-provenance/composition-overrides facts))

(defn- gaffer-provenance [facts]
  (north.agent-provenance/gaffer-provenance facts))

(defn- provider-target-label [facts]
  (let [provider (or (known (get facts "provider")) (known (get facts "vendor")) "unknown")
        target (known (get facts "provider_target"))]
    (if target
      (str provider ":" (if (or (= target provider) (= target "ambient")) "ambient" target))
      provider)))

(defn semantic-handle [id facts]
  (let [provider-axis (provider-target-label facts)
        composition (gaffer-provenance facts)
        suffix (last (str/split (str id) #"-"))]
    ;; `display_handle` is a write-time projection and can lag live route facts.
    ;; The roster derives its visible identity from the canonical axes every read.
    (str/join "-" [(slug provider-axis) (model-display (get facts "model"))
                    (slug (get facts "effort")) (slug composition) (slug suffix)])))

(defn render-display-name [id facts]
  (let [goal (known (get facts "goal"))
        g (when goal (str " — " (if (> (count goal) 40) (str (subs goal 0 37) "…") goal)))]
    (str (semantic-handle id facts) g)))

(defn agent-primary-line [presence facts]
  (let [native? (= "session" (get facts "kind"))
        provider-value (or (known (get facts "provider")) (known (get facts "vendor")))
        provider-axis (cond
                        (and native? (nil? provider-value)) "provider:historical-unrecorded"
                        (= provider-value "unobserved") "provider:unobserved"
                        :else (provider-target-label facts))
        model-value (known (get facts "model"))
        model-axis (cond
                     (and native? (nil? model-value)) "model:historical-unrecorded"
                     (= model-value "unobserved") "model:unobserved"
                     :else (model-display (or model-value "unknown")))
        effort-value (known (get facts "effort"))
        effort-axis (cond
                      (and native? (nil? effort-value)) "effort:historical-unrecorded"
                      (= effort-value "unobserved") "effort:unobserved"
                      :else (slug (or effort-value "unknown")))
        task (or (meaningful-task (get facts "current_thread"))
                 (meaningful-task (get facts "active_workflow"))
                 (meaningful-task (get facts "task"))
                 (meaningful-task (get facts "goal"))
                 (meaningful-task (:focus presence))
                 (when (and native? (known (get facts "repo")))
                   (str "native session in " (get facts "repo")))
                 "unknown")
        process-outcome (north.terminal-projection/terminal-process-outcome facts)
        delivery-outcome (north.terminal-projection/terminal-delivery-outcome facts)
        delivery-attestation
        (when (= "verified" delivery-outcome)
          (try
            (json/parse-string
             (north.terminal-projection/singleton-value facts "delivery_attestation"))
            (catch Exception _ nil)))
        delivery-label
        (if-let [actor (get delivery-attestation "actor")]
          (str delivery-outcome " by:" actor
               (when-let [role (get delivery-attestation "role")]
                 (str "/" role)))
          (or delivery-outcome "unrecorded"))
        state (cond
                process-outcome (str "finished(process:" process-outcome
                                     ", delivery:" delivery-label ")")
                (known (get facts "stalled")) "stalled"
                (:online presence) "working"
                :else "offline")
        gaffer (gaffer-provenance facts)
        role-axis (when (and (known (get facts "role"))
                             (not (#{"preset" "bespoke"} (get facts "composition_kind"))))
                    (str " · role:" (slug (get facts "role"))))]
    (str provider-axis " · " model-axis " · " effort-axis " · "
         gaffer role-axis " · " state ": " task)))

(defn roster-category [facts]
  (cond
    (north.terminal-projection/terminal-process-outcome facts) :recently-finished
    (= "lane" (get facts "kind")) :active-agent
    (= "session" (get facts "kind")) :native-session
    :else :unclassified))

;; ---- presence ---------------------------------------------------------------
(defn presence-rows []
  (let [r (run ["bb" (str NORTH "/cli/presence-cli.clj") PORT "presence-online"] :timeout 6000)]
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

(defn agent-online? [id]
  (let [presence (presence-rows)]
    (boolean (some #(and (= id (:id %)) (:online %)) (:agents presence)))))

;; ---- verbs -------------------------------------------------------------------
(defn cmd-agents [args]
  ;; The implementation probe is useful when diagnosing the roster, but it is
  ;; not part of the user-facing report. Keep it available without making every
  ;; ordinary `north agents` invocation explain its internals.
  (when (some #{"--verbose" "--debug"} args)
    (echo-cmd "bb" (str NORTH "/cli/presence-cli.clj") PORT "presence-online"))
  (let [pr (presence-rows)]
    (if (:err pr)
      (println (ylw (:err pr)))
      (let [rows (vec (filter :online (:agents pr)))
            af (agent-facts (mapv :id rows))
            categorized (group-by (fn [a] (roster-category (get af (:id a) {}))) rows)
            active-agents (vec (get categorized :active-agent []))
            native-sessions (vec (get categorized :native-session []))
            unclassified (vec (get categorized :unclassified []))
            finished (vec (get categorized :recently-finished []))
            active (+ (count active-agents) (count native-sessions) (count unclassified))
            render-section
            (fn [title note section]
              (when (seq section)
                (println)
                (if note
                  (println (bold (str title " (" (count section) ")")) (dim note))
                  (println (bold (str title " (" (count section) ")"))))
                (doseq [a section]
                  (let [facts (get af (:id a) {})
                        handle (semantic-handle (:id a) facts)]
                    (println (str "  " (grn "●") " " (agent-primary-line a facts)))
                    (println (dim (str "    " handle " · control " (:id a) " · ttl " (:expires a))))))))]
        (println (bold (str (count rows) " roster entries"))
                 (dim (str "· " active " active · " (count finished) " recently finished")))
        (render-section "active agents" nil active-agents)
        (render-section "native sessions" "(active provider CLI sessions)" native-sessions)
        (render-section "unclassified presence" "(legacy or missing identity facts)" unclassified)
        (render-section "recently finished"
                        "(process is terminal; delivery evidence is shown separately; presence lease has not lapsed)"
                        finished)))))

(def spawn-flags
  {"--notify" :notify "--provider" :provider "--target" :target "--taskGrade" :taskGrade "--task-grade" :taskGrade
   "--domain" :domain "--topology" :topology "--tier" :tier "--reasoning" :reasoning
   "--deliberation" :reasoning "--posture" :posture "--composition" :composition
   "--rationale" :rationale "--nearest" :nearest "--contract" :contract
   "--override-reason" :overrideReason})

(defn cmd-spawn-help []
  (let [roles (sort (keys (or (gaffer-routing) {})))]
    (println "north spawn — start one managed lane with an explicit Gaffer composition")
    (println)
    (println "Usage:")
    (println "  north spawn <template-role> \"<prompt>\" [routing options] [--dry-run]")
    (println "  north spawn <new-role> \"<prompt>\" --rationale WHY --contract JSON|@file [bespoke options]")
    (println)
    (println "Stock template:")
    (println "  The role hydrates Gaffer's task grade, tier, reasoning, topology, posture, and capabilities.")
    (println "  Override an axis with --task-grade, --domain, --topology, --tier, --reasoning, or --posture;")
    (println "  any changed template axis requires --override-reason WHY. Exact templates carry no override reason.")
    (println "  Available templates:" (if (seq roles) (str/join " " roles) "(catalog unavailable)"))
    (println "  Inspect their full routing defaults with: north templates")
    (println)
    (println "Bespoke role:")
    (println "  An unknown lowercase kebab-case role is valid only with --rationale and --contract.")
    (println "  Contract JSON contains exactly: responsibility, deliverable, capabilities, mayDecide,")
    (println "  mustEscalate, doneWhen, report. Text fields are nonblank; list fields are nonempty.")
    (println "  Canonical capabilities: filesystem.read filesystem.search filesystem.write shell")
    (println "                          shell.readonly web coordination")
    (println "  --nearest TEMPLATE is optional reference provenance, not inheritance.")
    (println "  --promotion-candidate nominates recurrence for human review; default is false.")
    (println "  --composition JSON|@file is the advanced full payload form (machine kinds: preset|bespoke).")
    (println)
    (println "Routing and control:")
    (println "  --provider auto|anthropic|openai   provider preference (default auto)")
    (println "  --target ACCOUNT                  exact account pin; unavailable means no fallback")
    (println "  --domain D[,D...]                 repeatable domain requirement")
    (println "  --reasoning low|medium|high|xhigh|max  (--deliberation is an alias)")
    (println "  --notify PEER                     completion/stall notifications")
    (println "  --dry-run                         validate and show resolved identity without execution")))

(defn- parse-spawn-args [args]
  (loop [xs args positionals [] opts {:domains [] :seen #{}}]
    (if-let [x (first xs)]
      (cond
        (= x "--dry-run") (recur (rest xs) positionals (assoc opts :dry? true))
        (#{"--promotion-candidate" "--nominate" "--no-promotion-candidate"} x)
        (if (:promotion-specified? opts)
          (do (println (red "choose exactly one promotion decision")) (System/exit 1))
          (recur (rest xs) positionals
                 (assoc opts :promotion-specified? true
                            :promotionCandidate (not= x "--no-promotion-candidate"))))
        (spawn-flags x) (let [v (second xs)
                              field (spawn-flags x)]
                          (when (or (nil? v) (str/starts-with? v "--"))
                            (println (red (str x " requires a value"))) (System/exit 1))
                          (when (and (not= field :domain) (contains? (:seen opts) field))
                            (println (red (str "duplicate spawn option for " (name field) ": " x)))
                            (System/exit 1))
                          (recur (nnext xs) positionals
                                 (if (= :domain field)
                                   (update opts :domains into (remove str/blank? (map str/trim (str/split v #","))))
                                   (-> opts (assoc field v) (update :seen conj field)))))
        (str/starts-with? x "--") (do (println (red (str "unknown spawn option: " x))) (System/exit 1))
        :else (recur (rest xs) (conj positionals x) opts))
      (assoc (dissoc opts :seen) :positionals positionals))))

(defn- parse-json-input [label input]
  (when input
    (try
      (let [source (if (str/starts-with? input "@")
                     (slurp (subs input 1))
                     input)]
        (json/parse-string source true))
      (catch Exception e
        (println (red (str label " must be valid JSON or @file: " (.getMessage e))))
        (System/exit 1)))))

(def canonical-gaffer-capabilities
  ;; This order is part of the cross-language fingerprint contract. Gaffer's
  ;; catalog must agree exactly; silently accepting a reordered vocabulary
  ;; would split one semantic contract into two identities.
  ["filesystem.read" "filesystem.search" "filesystem.write" "shell"
   "shell.readonly" "web" "coordination"])
(def bespoke-fingerprint-version "v1")
(def bespoke-fingerprint-domain "north:bespoke-contract:v1")
(def edge-ascii-whitespace #"^[\u0009-\u000d\u0020]+|[\u0009-\u000d\u0020]+$")

(defn- canonical-contract-text [value]
  (-> value
      (str/replace #"\r\n?" "\n")
      (java.text.Normalizer/normalize java.text.Normalizer$Form/NFC)
      (str/replace edge-ascii-whitespace "")))

(defn- canonical-contract-list [values]
  (->> values (map canonical-contract-text) distinct sort vec))

(defn- canonical-bespoke-contract [contract]
  ;; Field order and normalization are the cross-language contract shared with
  ;; sdk/src/bespoke-contract.ts.
  (let [requested-capabilities (set (map canonical-contract-text (:capabilities contract)))]
    (array-map
     :responsibility (canonical-contract-text (:responsibility contract))
     :deliverable (canonical-contract-text (:deliverable contract))
     :capabilities (vec (filter requested-capabilities canonical-gaffer-capabilities))
     :mayDecide (canonical-contract-list (:mayDecide contract))
     :mustEscalate (canonical-contract-list (:mustEscalate contract))
     :doneWhen (canonical-contract-list (:doneWhen contract))
     :report (canonical-contract-text (:report contract)))))

(defn- utf8-frame [value]
  (str (alength (.getBytes value java.nio.charset.StandardCharsets/UTF_8)) ":" value))

(defn- utf8-list-frame [values]
  (str (count values) ":" (apply str (map utf8-frame values))))

(defn- canonical-bespoke-contract-payload [canonical]
  (str bespoke-fingerprint-domain "\n"
       "responsibility=" (utf8-frame (:responsibility canonical)) "\n"
       "deliverable=" (utf8-frame (:deliverable canonical)) "\n"
       "capabilities=" (utf8-list-frame (:capabilities canonical)) "\n"
       "mayDecide=" (utf8-list-frame (:mayDecide canonical)) "\n"
       "mustEscalate=" (utf8-list-frame (:mustEscalate canonical)) "\n"
       "doneWhen=" (utf8-list-frame (:doneWhen canonical)) "\n"
       "report=" (utf8-frame (:report canonical))))

(defn- bespoke-contract-sha256 [contract]
  (let [canonical (canonical-bespoke-contract contract)
        bytes (.digest (doto (java.security.MessageDigest/getInstance "SHA-256")
                         (.update (.getBytes (canonical-bespoke-contract-payload canonical)
                                            java.nio.charset.StandardCharsets/UTF_8))))]
    (apply str (map #(format "%02x" (bit-and (int %) 0xff)) bytes))))

(def routing-override-fields
  [:taskGrade :domainRequirements :topology :tier :reasoning :posture])
(def bespoke-contract-fields
  #{:responsibility :deliverable :capabilities :mayDecide :mustEscalate :doneWhen :report})
(def role-id-pattern #"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")

(defn- valid-string-list? [value require-items?]
  (and (sequential? value)
       (or (not require-items?) (seq value))
       (every? string? value)
       (let [normalized (mapv canonical-contract-text value)]
         (and (every? seq normalized)
              (= (count normalized) (count (set normalized)))))))

(defn- valid-contract-string-list? [value]
  (and (sequential? value) (seq value) (every? string? value)
       (every? seq (map canonical-contract-text value))))

(defn- valid-contract-text? [value]
  (and (string? value) (seq (canonical-contract-text value))))

(defn- non-empty-string? [value]
  (and (string? value) (not (str/blank? value))))

(defn- topology-capability-problem [topology capabilities]
  (let [caps (set capabilities)]
    (cond
      (and (caps "shell") (caps "shell.readonly"))
      "shell and shell.readonly are mutually exclusive"
      (and (= topology "orchestrator") (not (caps "coordination")))
      "orchestrator topology requires coordination capability"
      (and (= topology "orchestrator") (caps "filesystem.write"))
      "orchestrator topology forbids filesystem.write capability"
      (and (= topology "orchestrator") (caps "shell"))
      "orchestrator topology forbids unrestricted shell capability"
      (and (= topology "worker") (caps "coordination"))
      "worker topology forbids coordination capability"
      :else nil)))

(def ^:dynamic *delegate-request* nil)
(declare resolve-delegate-thread! delegate-brief)

(defn cmd-spawn [args]
  (north.topology-authority/require-coordination! "spawn")
  (let [{:keys [dry? notify provider target taskGrade domains topology tier reasoning posture composition
                rationale nearest contract overrideReason promotion-specified? promotionCandidate positionals]}
        (parse-spawn-args args)
        [invoked-role prompt & extra] positionals
        catalog (gaffer-catalog)
        dt (or (gaffer-routing) {})
        supplied-composition (parse-json-input "--composition" composition)
        supplied-contract (parse-json-input "--contract" contract)
        canonical (get dt invoked-role)
        bespoke? (and invoked-role (nil? canonical))
        bespoke-reason (or rationale (:bespokeReason supplied-composition))
        nearest-role (or nearest (:nearestPreset supplied-composition))
        nearest-template (get dt nearest-role)
        contract-value (or supplied-contract (:contract supplied-composition))
        catalog-capability-order (vec (get-in catalog [:vocabulary :capabilities]))
        capability-values (set canonical-gaffer-capabilities)
        promotion-value (if promotion-specified? promotionCandidate
                            (if (and (map? supplied-composition)
                                     (contains? supplied-composition :promotionCandidate))
                              (:promotionCandidate supplied-composition)
                              false))
        base (or canonical nearest-template (:defaults catalog))
        preset-grade (:taskGrade base) preset-tier (:tier base)
        preset-role (:role base) preset-posture (:posture base) preset-topology (:topology base)
        preset-deliberation (:deliberation base)
        selected-grade (or taskGrade preset-grade)
        selected-tier (or tier preset-tier)
        selected-topology (or topology preset-topology)
        depth-problem
        (north.topology-authority/managed-child-topology-problem
         "spawn" selected-topology)
        selected-role (if bespoke? invoked-role (or preset-role invoked-role))
        selected-posture (or posture preset-posture (:posture (:defaults catalog)))
        selected-reasoning (or reasoning preset-deliberation)
        selected-domains (vec (distinct domains))
        actual-overrides (when canonical
                           (vec (keep (fn [[field selected preset]] (when (not= selected preset) field))
                                      [[:taskGrade selected-grade (:taskGrade canonical)]
                                       [:domainRequirements selected-domains []]
                                       [:topology selected-topology (:topology canonical)]
                                       [:tier selected-tier (:tier canonical)]
                                       [:reasoning selected-reasoning (:deliberation canonical)]
                                       [:posture selected-posture (:posture canonical)]])))
        generated-composition (if bespoke?
                                (cond-> {:kind "bespoke" :id invoked-role
                                         :bespokeReason bespoke-reason :promotionCandidate promotion-value
                                         :contract contract-value}
                                  nearest-role (assoc :nearestPreset nearest-role))
                                (cond-> {:kind "preset" :id selected-role
                                         :overrides (mapv name actual-overrides)}
                                  (seq actual-overrides) (assoc :overrideReason overrideReason)))
        selected-composition (or supplied-composition generated-composition)
        selected-capabilities (if canonical (:capabilities canonical)
                                (:capabilities contract-value))
        normalized-selected-capabilities
        (when (and (sequential? selected-capabilities) (every? string? selected-capabilities))
          (mapv canonical-contract-text selected-capabilities))
        capability-problem (when normalized-selected-capabilities
                             (topology-capability-problem selected-topology normalized-selected-capabilities))
        composition-kind (when (map? selected-composition) (:kind selected-composition))
        allowed-composition-fields (case composition-kind
                                     "preset" #{:kind :id :overrides :overrideReason}
                                     "bespoke" #{:kind :id :nearestPreset :bespokeReason :promotionCandidate :contract}
                                     #{})
        unknown-composition-fields (when (map? selected-composition)
                                     (seq (remove allowed-composition-fields (keys selected-composition))))
        declared-overrides (when (map? selected-composition) (:overrides selected-composition))
        contract-fields (when (map? (:contract selected-composition)) (set (keys (:contract selected-composition))))]
    (cond
      (or (nil? invoked-role) (nil? prompt) (seq extra))
      (do (println (red "usage:") "north spawn <role> \"<prompt>\" [--task-grade G] [--domain D] [--topology T] [--tier T] [--reasoning R] [--posture P] [--override-reason WHY] [--composition JSON|@file] [--rationale WHY] [--nearest PRESET] [--contract JSON|@file] [--promotion-candidate|--no-promotion-candidate] [--provider P] [--target ACCOUNT] [--notify PEER] [--dry-run]")
          (println "unknown roles are first-class bespoke compositions: rationale and structured contract are required; --nearest is optional and promotion defaults false")
          (println "roles:" (str/join " " (sort (keys dt)))))
      (#{"orchestrator" "worker"} invoked-role)
      (do (println (red (str invoked-role " is a topology, not a role")))
          (println (if (= invoked-role "orchestrator")
                     "use director for decomposition/reconciliation, or choose a worker function for atomic work"
                     "choose the worker function that names the deliverable, such as executor, implementer, integrator, or verifier"))
          (System/exit 1))
      (= invoked-role "researcher")
      (do (println (red "researcher is retired because it was ambiguous"))
          (println "use scout for source gathering, analyst for deep mechanism research, or research-scientist for cutting-edge inquiry")
          (System/exit 1))
      (and invoked-role (not (re-matches role-id-pattern invoked-role)))
      (do (println (red "role must be a lowercase kebab-case Gaffer role id")) (System/exit 1))
      (nil? catalog) (do (println (red (str "Gaffer staffing catalog unavailable: " GAFFER-STAFFING))) (System/exit 1))
      (not= canonical-gaffer-capabilities catalog-capability-order)
      (do (println (red "Gaffer capability vocabulary order disagrees with North's canonical fingerprint vocabulary"))
          (System/exit 1))
      (and canonical (or rationale nearest contract promotion-specified?))
      (do (println (red "--nearest, --rationale, --contract, and promotion decisions apply only to bespoke roles")) (System/exit 1))
      (and bespoke? overrideReason)
      (do (println (red "--override-reason applies only to preset axis overrides")) (System/exit 1))
      (and bespoke? nearest-role (nil? nearest-template))
      (do (println (red (str "unknown nearest preset: " nearest-role))) (System/exit 1))
      (and bespoke? (not (non-empty-string? bespoke-reason)))
      (do (println (red (str "bespoke role " invoked-role " requires --rationale or composition.bespokeReason"))) (System/exit 1))
      (and bespoke? (nil? contract-value))
      (do (println (red (str "bespoke role " invoked-role " requires --contract JSON|@file or composition.contract"))) (System/exit 1))
      (and supplied-composition rationale (not= rationale (:bespokeReason supplied-composition)))
      (do (println (red "--rationale conflicts with composition.bespokeReason")) (System/exit 1))
      (and supplied-composition nearest (not= nearest (:nearestPreset supplied-composition)))
      (do (println (red "--nearest conflicts with composition.nearestPreset")) (System/exit 1))
      (and supplied-composition supplied-contract (not= supplied-contract (:contract supplied-composition)))
      (do (println (red "--contract conflicts with composition.contract")) (System/exit 1))
      (and supplied-composition promotion-specified? (not= promotionCandidate (:promotionCandidate supplied-composition)))
      (do (println (red "promotion flag conflicts with composition.promotionCandidate")) (System/exit 1))
      (and target (str/blank? target))
      (do (println (red "--target requires a non-empty account target")) (System/exit 1))
      (not (some #{selected-grade} (get-in catalog [:vocabulary :taskGrades])))
      (do (println (red (str "invalid taskGrade: " selected-grade))) (System/exit 1))
      (not (some #{selected-topology} (get-in catalog [:vocabulary :topologies])))
      (do (println (red (str "invalid topology: " selected-topology))) (System/exit 1))
      depth-problem
      (do (println (red depth-problem)) (System/exit 1))
      (and (= selected-role "director") (= selected-topology "worker"))
      (do (println (red "director cannot use worker topology; choose a worker role for atomic work")) (System/exit 1))
      (not (some #{selected-tier} (get-in catalog [:vocabulary :semanticTiers])))
      (do (println (red (str "invalid tier: " selected-tier))) (System/exit 1))
      (not (some #{selected-reasoning} (get-in catalog [:vocabulary :deliberations])))
      (do (println (red (str "invalid reasoning: " selected-reasoning))) (System/exit 1))
      (not (some #{selected-posture} (get-in catalog [:vocabulary :postures])))
      (do (println (red (str "invalid posture: " selected-posture))) (System/exit 1))
      (not (map? selected-composition))
      (do (println (red "composition must be a JSON object")) (System/exit 1))
      unknown-composition-fields
      (do (println (red (str "composition contains unknown fields: " (str/join ", " (map name unknown-composition-fields))))) (System/exit 1))
      (and canonical (or (not= "preset" composition-kind) (not= selected-role (:id selected-composition))))
      (do (println (red (str "known role " invoked-role " requires preset composition id " selected-role))) (System/exit 1))
      (and canonical (not (valid-string-list? declared-overrides false)))
      (do (println (red "preset composition.overrides must be an array of unique routing-axis names")) (System/exit 1))
      (and canonical (not= (set (map name actual-overrides)) (set declared-overrides)))
      (do (println (red (str "composition.overrides must exactly record changed preset axes: "
                            (if (seq actual-overrides) (str/join ", " (map name actual-overrides)) "none"))))
          (System/exit 1))
      (and canonical (seq actual-overrides) (not (non-empty-string? (:overrideReason selected-composition))))
      (do (println (red (str "preset axis override requires --override-reason (changed: "
                            (str/join ", " (map name actual-overrides)) ")"))) (System/exit 1))
      (and canonical (empty? actual-overrides) (contains? selected-composition :overrideReason))
      (do (println (red "unchanged preset must not carry --override-reason")) (System/exit 1))
      (and bespoke? (or (not= "bespoke" composition-kind) (not= invoked-role (:id selected-composition))))
      (do (println (red (str "bespoke role " invoked-role " requires bespoke composition id " invoked-role))) (System/exit 1))
      (and bespoke? (not (boolean? (:promotionCandidate selected-composition))))
      (do (println (red "bespoke composition.promotionCandidate must be explicit boolean")) (System/exit 1))
      (and bespoke? (not= bespoke-contract-fields contract-fields))
      (do (println (red "bespoke composition.contract must contain exactly responsibility, deliverable, capabilities, mayDecide, mustEscalate, doneWhen, and report")) (System/exit 1))
      (and bespoke? (some #(not (valid-contract-text? (get-in selected-composition [:contract %])))
                           [:responsibility :deliverable :report]))
      (do (println (red "bespoke composition.contract requires non-empty responsibility, deliverable, and report")) (System/exit 1))
      (and bespoke? (some #(not (valid-contract-string-list? (get-in selected-composition [:contract %])))
                          [:mayDecide :mustEscalate :doneWhen]))
      (do (println (red "bespoke composition.contract requires non-empty mayDecide, mustEscalate, and doneWhen lists")) (System/exit 1))
      (and bespoke?
           (or (not (valid-contract-string-list? selected-capabilities))
               (some #(not (capability-values %)) normalized-selected-capabilities)))
      (do (println (red "bespoke composition.contract capabilities must be non-empty and canonical")) (System/exit 1))
      capability-problem
      (do (println (red capability-problem)) (System/exit 1))
      :else
      (let [model (:model base) synthetic-effort (:effort base) synthetic-reasoning (:reasoning base)
            gaffer-preset (:gaffer-preset base) semantic (:semantic base)
            delegate-binding (when *delegate-request*
                               (resolve-delegate-thread! *delegate-request* dry?))
            effective-prompt (if delegate-binding
                               (delegate-brief *delegate-request* delegate-binding)
                               prompt)
            canonical-contract (when bespoke?
                                 (canonical-bespoke-contract (:contract selected-composition)))
            contract-sha256 (when canonical-contract
                              (bespoke-contract-sha256 (:contract selected-composition)))
            spawn-composition (if bespoke?
                                (assoc selected-composition :contract canonical-contract)
                                selected-composition)
            aid (north.spawn-process/create-agent-id "lane")
            env (cond-> {"AGENT_ID" aid}
                  selected-role (assoc "AGENT_IDENTITY_ROLE" selected-role)
                  selected-grade (assoc "AGENT_TASK_GRADE" selected-grade)
                  (or canonical bespoke?) (assoc "AGENT_DOMAIN_REQUIREMENTS" (json/generate-string selected-domains))
                  selected-topology (assoc "AGENT_TOPOLOGY" selected-topology)
                  selected-tier (assoc "AGENT_TIER" selected-tier)
                  selected-role (assoc "AGENT_ROLE" selected-role)
                  selected-posture (assoc "AGENT_POSTURE" selected-posture)
                  spawn-composition (assoc "AGENT_COMPOSITION" (json/generate-string spawn-composition))
                  (and (not semantic) (not gaffer-preset) model) (assoc "AGENT_MODEL" model)
                  selected-reasoning (assoc "AGENT_REASONING" selected-reasoning "AGENT_EFFORT" selected-reasoning)
                  provider (assoc "AGENT_PROVIDER" provider)
                  target (assoc "AGENT_TARGET" target)
                  notify (assoc "AGENT_COORDINATOR" notify)
                  delegate-binding (assoc "NORTH_DELEGATE_THREAD_ID" (:id delegate-binding)))
            immediate-coordinator (or notify (System/getenv "AGENT_ID")
                                      (System/getenv "NORTH_AGENT_ID"))
            child-env (north.managed-child-env/child
                       (into {} (System/getenv)) immediate-coordinator env)
            spawn-ts (str NORTH "/sdk/src/spawn.ts")
            display-env (cond-> env
                          bespoke? (assoc "AGENT_COMPOSITION" "REDACTED_BESPOKE_CONTRACT"))
            envs (str/join " " (map (fn [[k v]] (str k "=" v)) (sort display-env)))
            dry-route (dry-resolved-route provider selected-tier
                                          (when (and (not semantic) (not gaffer-preset)) model)
                                          selected-reasoning)
            fallback-base (into {} (remove (comp nil? val)
                                           {"kind" "lane" "role" selected-role
                                            "provider" (or (:provider dry-route) provider "auto")
                                            "provider_target" (or target (:provider dry-route) provider "auto")
                                            "model" (or (:model dry-route) (when selected-tier (str "tier:" selected-tier)) "unresolved")
                                            "effort" (or (:effort dry-route) selected-reasoning)
                                            "composition_kind" (:kind spawn-composition)
                                            "composition_id" (:id spawn-composition)
                                            "composition_overrides" (when (= "preset" (:kind spawn-composition))
                                                                      (json/generate-string (:overrides spawn-composition)))
                                            "composition_override_reason" (when (= "preset" (:kind spawn-composition))
                                                                            (:overrideReason spawn-composition))
                                            "bespoke_reason" (when (= "bespoke" (:kind spawn-composition))
                                                               (:bespokeReason spawn-composition))
                                            "nearest_preset" (when (= "bespoke" (:kind spawn-composition))
                                                               (:nearestPreset spawn-composition))
                                            "promotion_candidate" (when (= "bespoke" (:kind spawn-composition))
                                                                    (str (:promotionCandidate spawn-composition)))
                                            "composition_contract_sha256" contract-sha256
                                            "composition_contract_fingerprint_version" (when contract-sha256 bespoke-fingerprint-version)
                                            "composition_contract_fingerprint_domain" (when contract-sha256 bespoke-fingerprint-domain)
                                            ;; A dry run has no coordinator publication, but its visible
                                            ;; identity must pass the same exact validator. These values are
                                            ;; explicit synthetic evidence, never persisted.
                                            "repo" (current-repo) "goal" effective-prompt
                                            "spawned_at" (str (java.time.Instant/now))
                                            "display_handle" "dry-run" "display_name" "dry-run"}))
            fallback-facts (assoc fallback-base "identity_manifest_sha256"
                                  (north.agent-provenance/manifest-sha256 fallback-base))]
        (println (dim "# gaffer dials for role") (bold invoked-role) (dim "->")
                 (str "grade=" selected-grade " tier=" selected-tier " reasoning=" selected-reasoning
                      (when (and (not semantic) (not gaffer-preset) model) (str " model=" model))
                      (when selected-role (str " role=" selected-role))
                      (when selected-composition
                        (str " selection=" (gaffer-provenance fallback-facts)))
                      (when target (str " target=" target))
                      (when selected-posture (str " posture=" selected-posture))
                      (when selected-topology (str " topology=" selected-topology))
                      (when (seq selected-domains) (str " domains=" (str/join "," selected-domains)))))
        (when bespoke?
          (println (dim "# bespoke evidence ->")
                   (str "version=" bespoke-fingerprint-version
                        " domain=" bespoke-fingerprint-domain
                        " sha256=" contract-sha256
                        " capabilities=" (str/join "," (:capabilities canonical-contract))
                        " reason=recorded")))
        (echo-cmd envs "bun run" spawn-ts (str "\"" effective-prompt "\""))
        (if dry?
          (do
            (println (ylw "[dry-run]") "not executed. semantic handle would be"
                     (bold (semantic-handle aid fallback-facts)))
            (println "control:" (dim aid))
            (when (and selected-tier (nil? dry-route))
              (println "selected semantic tier:" (bold selected-tier) (dim "(provider:auto resolves at spawn)"))))
          (let [log (io/file AGENT-LOGDIR (str aid ".log"))]
            (.mkdirs (.getParentFile log))
            (let [process (north.spawn-process/launch-detached!
                           ["bun" "run" spawn-ts effective-prompt] child-env log)
                  startup (north.spawn-process/await-startup
                           process aid log agent-facts-one agent-online?)]
              (case (:status startup)
                :ready
                (do
                  (println (grn "spawned") (bold (:handle startup)))
                  (println "control:" (dim aid))
                  (println "watch:" (cyn (str "north watch " aid))))

                :completed
                (do
                  (println (grn "completed") (bold (:handle startup))
                           (dim (str "outcome=" (:outcome startup))))
                  (println "control:" (dim aid))
                  (println "log:" (dim (str log))))

                (do
                  (binding [*out* *err*]
                    (println (red (north.spawn-process/failure-message startup))))
                  (System/exit 1))))))))))

;; delegate = the ONE handoff verb. The intelligent intake boundary must classify
;; dependency shape explicitly: one terminal Gaffer role for atomic work, or a
;; director for genuinely composite work. North does not guess from task prose and
;; never charges a director+worker pair for an atomic handoff. All ordinary spawn
;; axes and bespoke-composition flags pass through to cmd-spawn unchanged.
(def delegate-usage
  "north delegate \"<task>\" (--role <worker-role> | --composite) [--thread <id>] [--context <file>] [spawn options]")

(defn- delegate-die [message]
  (println (red message))
  (println (red "usage:") delegate-usage)
  (System/exit 1))

(def delegate-thread-id-pattern #"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
(def delegate-thread-title-max-utf8-bytes 160)
(def capture-receipt-keys
  #{:id :thread :title :path :expected :committed :complete :reason})

(defn- canonical-delegate-thread [raw]
  (let [value (some-> raw str)
        bare (when value (str/replace-first value #"^@" ""))]
    (when (and value
               (= value (str/trim value))
               (not (str/starts-with? bare "@"))
               (<= (count bare) 512)
               (re-matches delegate-thread-id-pattern bare))
      bare)))

(defn- normalize-delegate-thread [raw]
  (or (canonical-delegate-thread raw)
      (delegate-die "--thread must be a bare or single-@ ASCII North thread id")))

(defn- parse-structured-facts [raw]
  (try
    (let [facts (json/parse-string (str/trim raw) true)]
      (when (and (sequential? facts)
                 (every? #(and (map? %)
                               (= #{:predicate :value} (set (keys %)))
                               (string? (:predicate %))
                               (string? (:value %)))
                         facts))
        facts))
    (catch Exception _ nil)))

(defn- parse-structured-facts! [label raw]
  (or (parse-structured-facts raw)
      (delegate-die (str label " returned an invalid structured fact projection"))))

(defn- parse-thread-facts! [id raw]
  (let [facts (parse-structured-facts! (str "thread @" id) raw)]
    (let [titles (mapv :value (filter #(= "title" (:predicate %)) facts))]
      (when-not (and (= 1 (count titles)) (not (str/blank? (first titles))))
        (delegate-die (str "thread @" id " is not a title-bearing North thread")))
      {:id id
       :title (first titles)
       :facts facts
       :committed? (boolean (some #(= "committed" (:predicate %)) facts))
       :done-when (mapv :value (filter #(= "done_when" (:predicate %)) facts))})))

(defn- read-delegate-thread! [raw]
  (let [id (normalize-delegate-thread raw)
        result (run [NORTH-CLI "json" "show" id] :timeout 10000)]
    (when-not (:ok result)
      (delegate-die (str "cannot prove delegate thread @" id " through North's structured read boundary")))
    (parse-thread-facts! id (:out result))))

(defn- fact-set [facts]
  (reduce (fn [acc {:keys [predicate value]}]
            (update acc predicate (fnil conj #{}) value))
          {}
          facts))

(defn- utf8-byte-count [value]
  (alength (.getBytes (str value) java.nio.charset.StandardCharsets/UTF_8)))

(defn- utf8-prefix [value max-bytes]
  (loop [end 0]
    (if (>= end (.length value))
      value
      (let [next (+ end (Character/charCount (.codePointAt value end)))]
        (if (> (utf8-byte-count (subs value 0 next)) max-bytes)
          (subs value 0 end)
          (recur next))))))

(defn delegate-thread-title [task]
  ;; A durable title is a label, not the worker payload. Keep the full task in
  ;; the delegate brief while projecting one deterministic line that satisfies
  ;; canonical capture's stricter single-line boundary.
  (let [lines (str/split (str task) #"\R" -1)
        line (or (first (remove str/blank? (map str/trim lines))) "Delegated task")
        collapsed (-> line
                      (str/replace #"[\p{javaWhitespace}\p{Z}]+" " ")
                      str/trim)]
    (utf8-prefix collapsed delegate-thread-title-max-utf8-bytes)))

(defn- managed-thread-binding []
  (let [ambient-run (System/getenv "NORTH_RUN_ID")
        thread (System/getenv "NORTH_THREAD_ID")
        capability (System/getenv "NORTH_RUN_CAPABILITY")
        agent (System/getenv "AGENT_ID")
        values [ambient-run thread capability agent]
        present (mapv #(boolean (known %)) values)]
    (if-not (every? true? present)
      {:kind :none :residue? (some true? present)}
      (try
        (let [run-id (canonical-delegate-thread ambient-run)
              thread-id (canonical-delegate-thread thread)
              result (when (and run-id thread-id)
                       (run [NORTH-CLI "json" "show" run-id] :timeout 10000))
              facts (when (:ok result)
                      (fact-set
                       (parse-structured-facts (:out result))))
              reporter (str "@agent:" (str/replace-first agent #"^@?agent:" ""))]
          (if (and run-id
                   thread-id
                   facts
                   (north.terminal-projection/run-reservation-valid? facts)
                   (= #{(str "@" thread-id)}
                      (get facts "run_reservation_thread"))
                   (= #{reporter}
                      (get facts "run_reservation_agent"))
                   (= #{(north.terminal-projection/sha256 capability)}
                      (get facts "run_capability_sha256")))
            {:kind :complete :thread thread-id}
            {:kind :none :residue? true}))
        (catch Exception _
          {:kind :none :residue? true})))))

(defn- capture-delegate-thread! [task]
  (let [title (delegate-thread-title task)
        capture-env (assoc (into {} (System/getenv))
                           "NORTH_CAPTURE_STRUCTURED" "1")
        result (run [NORTH-CLI "capture" title] :timeout 15000 :env capture-env)]
    (when-not (:ok result)
      (delegate-die "North could not capture a durable delegate thread"))
    (let [receipt (try (json/parse-string (str/trim (:out result)) true)
                       (catch Exception _
                         (delegate-die "North capture did not return its exact structured receipt")))]
      (when-not (and (map? receipt)
                     (= capture-receipt-keys (set (keys receipt)))
                     (string? (:id receipt))
                     (string? (:thread receipt))
                     (string? (:title receipt))
                     (string? (:path receipt))
                     (integer? (:expected receipt))
                     (integer? (:committed receipt))
                     (boolean? (:complete receipt))
                     (string? (:reason receipt)))
        (delegate-die "North capture returned a malformed structured receipt"))
      (let [id (normalize-delegate-thread (:id receipt))]
        (when-not (and (:complete receipt)
                       (= "captured" (:reason receipt))
                       (= (str "@" id) (:thread receipt))
                       (= title (:title receipt))
                       (pos? (:expected receipt))
                       (= (:expected receipt) (:committed receipt)))
          (delegate-die "North capture was partial; delegate spawn refused before provider execution"))
        (let [thread (read-delegate-thread! id)]
          (when-not (and (= title (:title thread)) (:committed? thread))
            (delegate-die "captured delegate thread failed exact title/commit readback"))
          (assoc thread :source :captured))))))

(defn resolve-delegate-thread!
  [{:keys [task explicit-thread]} dry?]
  (cond
    explicit-thread
    (assoc (read-delegate-thread! explicit-thread) :source :explicit)

    :else
    (let [{:keys [kind thread residue?]} (managed-thread-binding)]
      (case kind
        :complete (assoc (read-delegate-thread! thread) :source :inherited)
        :none (do
                (when residue?
                  (binding [*out* *err*]
                    (println
                     (ylw "ignoring unverified ambient North run/thread residue; a fresh delegate thread is required"))))
                (if dry?
                  {:id "capture-on-execution"
                   :title task
                   :facts [{:predicate "title" :value task}
                           {:predicate "committed" :value "dry-run"}]
                   :committed? true
                   :done-when []
                   :source :dry-capture}
                  (capture-delegate-thread! task)))))))

(defn- parse-delegate-args [args]
  (let [task (first args)]
    (when (or (nil? task) (str/starts-with? task "--"))
      (delegate-die "delegate requires one quoted task before its classification"))
    (loop [xs (rest args) parsed {:task task :forward []}]
      (if-let [x (first xs)]
        (case x
          "--role"
          (let [role (second xs)]
            (when (or (nil? role) (str/starts-with? role "--"))
              (delegate-die "--role requires a Gaffer worker role"))
            (when (:mode parsed)
              (delegate-die "choose exactly one delegation mode: --role or --composite"))
            (recur (nnext xs) (assoc parsed :mode :atomic :role role)))

          "--composite"
          (do
            (when (:mode parsed)
              (delegate-die "choose exactly one delegation mode: --role or --composite"))
            (recur (rest xs) (assoc parsed :mode :composite)))

          "--context"
          (let [path (second xs)]
            (when (or (nil? path) (str/starts-with? path "--"))
              (delegate-die "--context requires a brief file"))
            (recur (nnext xs) (assoc parsed :context path)))

          "--thread"
          (let [thread (second xs)]
            (when (or (nil? thread) (str/starts-with? thread "--"))
              (delegate-die "--thread requires a North thread id"))
            (when (:thread parsed)
              (delegate-die "delegate accepts exactly one --thread"))
            (recur (nnext xs) (assoc parsed :thread thread)))

          (recur (rest xs) (update parsed :forward conj x)))
        parsed))))

(defn delegate-brief
  [{:keys [task mode context]} {:keys [id committed? done-when]}]
  (let [context-block (when context (str "CONTEXT BRIEF:\n" context "\n\n"))
        proof-block
        (cond
          (seq done-when)
          (str "North has prebound this lane and its immutable starting done_when set to @"
               id ". Run each exact bar, then record its observation with "
               "`north evidence record \"<exact bar>\" \"<observed result>\"`; "
               "provider success without those records is not delivery evidence.")

          committed?
          (str "North has prebound this accepted, currently barless thread to @" id
               ". FIRST ACT: define exact probe + expected-result criteria with "
               "`north tell " id " done_when \"<probe + expected result>\"`. "
               "After each probe, use `north evidence record \"<exact bar>\" "
               "\"<observed result>\"`; provider success alone is not delivery evidence.")

          :else
          (str "North has prebound this title-bearing thread to @" id
               ". Record exact done_when criteria before claiming completion, then use "
               "`north evidence record \"<exact bar>\" \"<observed result>\"` after each probe."))]
    (str context-block
         "DELEGATE TASK: " task "\n\n"
         "NORTH DELIVERY CONTRACT: " proof-block "\n\n"
         (if (= mode :composite)
           (str "COMPOSITE INTAKE: @" id
                " is the aggregate reduction/checkpoint thread. Create a distinct "
                "title-bearing child thread linked `part_of @" id
                "` for every terminal piece, and bind each child run to its own thread; "
                "never make workers prove the aggregate bar set. Keep the North listener/"
                "continuation live, checkpoint each result as it arrives, and reconcile "
                "every child before publishing the aggregate outcome.")
           (str "ATOMIC INTAKE: use @" id
                " as the single durable work/evidence thread and return one evidence-backed result.")))))

(defn cmd-delegate [args]
  (north.topology-authority/require-coordination! "delegate")
  (let [{:keys [task mode role context thread forward]} (parse-delegate-args args)
        _ (when-not mode
            (delegate-die "delegate needs an explicit intake decision: --role for atomic work or --composite"))
        canonical (when role (get (gaffer-routing) role))
        parsed-spawn (parse-spawn-args
                      (into [(if (= mode :composite) "director" role) task] forward))
        requested-topology (:topology parsed-spawn)
        _ (when (and (= mode :atomic)
                     (or (= "orchestrator" (:topology canonical))
                         (= "orchestrator" requested-topology)))
            (delegate-die "--role is an atomic terminal-worker handoff; use --composite for orchestrator work"))
        ctx-file context
        ctx (when ctx-file
              (let [f (io/file ctx-file)]
                (when-not (.exists f)
                  (delegate-die (str "context file not found: " ctx-file)))
                (str/trim (slurp f))))
        spawn-role (if (= mode :composite) "director" role)
        inherited-notify (and (not (some #{"--notify"} forward))
                              (System/getenv "NORTH_NOTIFY"))]
    (binding [*delegate-request* {:task task :mode mode :context ctx
                                  :explicit-thread thread}]
      (cmd-spawn (cond-> (into [spawn-role task] forward)
                   inherited-notify (into ["--notify" inherited-notify]))))))

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
  (north.topology-authority/require-coordination! "steer")
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

;; retask: typed managed-identity update. The private publisher replaces the
;; multi-cardinality goal/cache values, reads them back, and recommits the
;; manifest; generic fact writes would leave the lane corrupt.
(defn cmd-retask [[id goal & _]]
  (north.topology-authority/require-coordination! "retask")
  (if (or (nil? id) (nil? goal))
    (println (red "usage:") "north retask <agent-id> \"<new-goal>\"")
    (let [subj (str "agent:" (str/replace-first id #"^@?(agent:)?" ""))
          bare (subs subj (count "agent:"))
          facts (assoc (or (agent-facts-one bare) {}) "goal" goal)
          dn (render-display-name bare facts)
          update (json/generate-string {"goal" goal "display_name" dn})
          result (run ["bb" (str NORTH "/cli/agent-fact-internal.clj")
                       PORT "retask" subj update] :timeout 10000)]
      (if (:ok result)
        (do (println (grn "retasked") (bold bare))
            (println "  " dn))
        (do (println (red "retask failed"))
            (println (str/trim (str (:out result) (:err result)))))))))

;; ---- dispatch ------------------------------------------------------------------
(when-not (or (= (System/getenv "NORTH_AGENTS_LIB") "1")
              (= (System/getProperty "north.agents.lib") "1"))
  (let [[cmd & args] *command-line-args*]
    (try
      (case cmd
        "agents"  (cmd-agents args)
        "templates" (cmd-templates args)
        "spawn"   (if (and (= 1 (count args)) (contains? #{"--help" "-h" "help"} (first args)))
                    (cmd-spawn-help)
                    (cmd-spawn args))
        "delegate" (cmd-delegate args)
        ;; delegation unified to ONE verb; request/fork/req teach, don't alias.
        "request" (do (println "renamed: north delegate") (System/exit 1))
        "fork"    (do (println "renamed: north delegate") (System/exit 1))
        "req"     (do (println "renamed: north delegate") (System/exit 1))
        "watch"   (cmd-watch args)
        "steer"   (cmd-tell-agent args)
        "retask"  (cmd-retask args)
        (do (println "usage: north {agents|templates|spawn|delegate|watch|steer|retask} ...")
            (System/exit 1)))
      (catch clojure.lang.ExceptionInfo error
        (if (north.topology-authority/denial? error)
          (do (binding [*out* *err*] (println (red (.getMessage error))))
              (System/exit 1))
          (throw error))))))
