#!/usr/bin/env bb
;; north config — every personal-stack posture setting, one entry point.
;;
;;   caveman  : output compression     session level + worker default
;;   dispatch : who runs agents        north SDK  vs  native Agent/Workflow
;;   coord    : coordination protocol  north / linear / both
;;   beagle   : code representation    text      vs  fact-native (per-file)
;;   guards   : authoring-guard hooks  + the kill-switch
;;
;; Ported from dotfiles/bin/my-agent-config (bash) 2026-07-10: north is the
;; top-level settings surface. Output contract is byte-faithful to the bash tool
;; (self-references now read `north config`); the slash command renders it verbatim.
;;
;; Provider-neutral posture state lives at ~/.local/state/north/harness.conf.
;; ~/.claude/my-config.state is a read-only migration fallback until the first
;; canonical write. The kill-switch precedence below is a faithful inline copy
;; of hooks/lib/authoring-killswitch.sh so report and enforcement agree.

(require '[clojure.string :as str]
         '[clojure.java.io :as io]
         '[cheshire.core :as json])

(def home (System/getenv "HOME"))
(load-file (str (or (System/getenv "NORTH_HOME")
                    (some-> *file* io/file .getCanonicalFile .getParentFile .getParentFile str))
                "/cli/harness-state.clj"))
(def STATE           (north.harness-state/canonical-path home))
(def LEGACY-STATE    (north.harness-state/legacy-path home))
(def CAVEMAN-STATE   (str home "/.claude/.caveman-active"))
(def CAVEMAN-DEFAULT (str home "/code/nixos-config/dotfiles/caveman/config.json"))
(def REGISTRY        (or (System/getenv "GRAPH_UPSTREAM_REGISTRY")
                         (str home "/.config/fram/graph-upstream-files")))
(def SETTINGS        (str home "/code/nixos-config/dotfiles/claude/settings.json"))
(def ROUTING-POLICY  (or (System/getenv "NORTH_ROUTING_POLICY")
                         (str home "/.config/north/routing-policy.json")))

(defn- slurp' [f] (try (slurp f) (catch Exception _ nil)))
(defn- eprintln [& xs] (binding [*out* *err*] (apply println xs)))
(defn- die [& xs] (apply eprintln xs) (System/exit 1))

;; --- state accessors (key=value lines; last wins) --------------------------
(defn get' [k default]
  (north.harness-state/get-value home k default))

(defn put' [k v]
  (north.harness-state/put-value! home k v))

(defn mark [a b] (if (= a b) "●" "○")) ; ● / ○

;; --- environment probes ---------------------------------------------------
(defn north-daemon []
  (try (with-open [s (java.net.Socket.)]
         (.connect s (java.net.InetSocketAddress. "127.0.0.1" 7977) 300))
       "reachable (corpus health is checked by `north doctor`)"
       (catch Exception _ "DOWN")))

(defn linear-mcp []
  (let [c (slurp' (str home "/.claude.json"))]
    (if (and c (str/includes? c "linear")) "configured" "absent")))

(defn wired [x]
  (let [c (slurp' SETTINGS)]
    (if (and c (str/includes? c x)) "✓" "✗"))) ; ✓ / ✗

(defn registry-raw []
  (if-let [c (slurp' REGISTRY)]
    (if (str/blank? c) [] (str/split-lines c))
    []))

(defn registry-lines []
  (->> (registry-raw)
       (remove #(re-matches #"\s*(#.*)?" %)))) ; drop blank + comment lines

(defn adopted-n [] (count (registry-lines)))

(defn caveman-lvl []
  (let [c (slurp' CAVEMAN-STATE)]
    (if (and c (not (str/blank? c))) (str/trim c) "off")))

(defn caveman-default []
  (or (some-> (slurp' CAVEMAN-DEFAULT)
              (->> (re-find #"\"defaultMode\"\s*:\s*\"([^\"]*)\""))
              second)
      "full"))

;; Kill-switch effective state — precedence identical to authoring-killswitch.sh:
;;   env 0|false  → force-live (state ignored this session)
;;   env non-empty (other) → engaged this session
;;   unset/empty  → state file `guards=off` decides
(defn effective-ks []
  (let [env (System/getenv "CLAUDE_NO_AUTHORING_HOOKS")]
    (cond
      (#{"0" "false"} env) "env force-live — guards LIVE (state ignored this session)"
      (and env (not (str/blank? env))) "ENGAGED via env (this session) — authoring guards OFF; dispatch topology unchanged"
      :else (if (= "off" (get' "guards" ""))
              "ENGAGED via state — authoring guards OFF; dispatch topology unchanged (north config guards on restores)"
              "off — guards LIVE"))))

(defn today []
  (.format (java.time.LocalDate/now)
           (java.time.format.DateTimeFormatter/ofPattern "yyyy-MM-dd")))

;; --- provider routing policy ---------------------------------------------
;; This file is deliberately separate from the legacy key=value posture state:
;; it is structured, provider-neutral input consumed by the SDK router. Named
;; targets make account profiles representable without pretending the current
;; adapters can select between profiles yet.
(def default-routing-policy
  {:schemaVersion 1
   :mode "balanced"
   :targets {"anthropic" {:provider "anthropic" :authMode "ambient"}
             "openai" {:provider "openai" :authMode "ambient"}}
   :order ["anthropic" "openai"]
   :weights {"anthropic" 1 "openai" 1}
   :reserve nil
   :pressure {}
   :envelopes {}})

(defn- portable-profile-slug? [value]
  (boolean (re-matches #"[a-z0-9][a-z0-9_-]{0,63}" (or value ""))))

(defn- validate-routing [p]
  (let [ids (set (keys (:targets p)))
        refs (concat (:order p) (keys (:weights p)) (keys (:pressure p))
                     (when-let [r (:reserve p)] [r]))
        isolated-roots (for [[_ {:keys [provider authMode profile]}] (:targets p)
                             :when (= "isolated" authMode)]
                         [provider profile])
        ambient-providers (for [[_ {:keys [provider authMode]}] (:targets p)
                                :when (not= "isolated" authMode)]
                            provider)
        dangling (seq (remove ids refs))]
    (when-not (= 1 (:schemaVersion p))
      (throw (ex-info (str "unsupported schemaVersion " (:schemaVersion p)) {})))
    (when-not (contains? #{"preferential" "balanced" "reserved"} (:mode p))
      (throw (ex-info (str "invalid mode " (:mode p)) {})))
    (when-let [[id target] (first (remove #(contains? #{"anthropic" "openai"} (:provider (val %))) (:targets p)))]
      (throw (ex-info (str "target " id " has invalid provider " (:provider target)) {})))
    (when-let [[id target] (first (remove #(contains? #{nil "ambient" "isolated"} (:authMode (val %))) (:targets p)))]
      (throw (ex-info (str "target " id " has invalid authMode " (:authMode target)) {})))
    (when-let [[id target] (first (filter #(and (= "isolated" (:authMode (val %)))
                                                (not (portable-profile-slug? (:profile (val %)))))
                                          (:targets p)))]
      (throw (ex-info (str "target " id " requires a portable profile slug when authMode is isolated") {})))
    (when (some #(> (val %) 1) (frequencies isolated-roots))
      (throw (ex-info "isolated targets must not reuse the same provider/profile root" {})))
    (when (some #(> (val %) 1) (frequencies ambient-providers))
      (throw (ex-info "ambient targets must not reuse the same provider account" {})))
    (when dangling
      (throw (ex-info (str "dangling target reference(s): " (str/join ", " dangling)) {})))
    p))

(defn- flatten-envelopes [value]
  (let [limits (fn [m] (into {} (map (fn [[k v]] [(keyword k) v])) (or m {})))
        direct (into {} (keep (fn [scope]
                                (when-let [v (get value scope)] [scope (limits v)])))
                     ["default" "month" "week"])
        named (fn [kind]
                (into {} (map (fn [[id v]] [(str kind ":" id) (limits v)]))
                      (get value (str kind "s") {})))]
    (merge direct (named "project") (named "session"))))

(defn- nest-envelopes [value]
  (let [direct (into {} (keep (fn [scope] (when-let [v (get value scope)] [(keyword scope) v])))
                     ["default" "month" "week"])
        named (fn [kind]
                (into {} (keep (fn [[scope limits]]
                                 (when (str/starts-with? scope (str kind ":"))
                                   [(subs scope (inc (count kind))) limits]))) value))]
    (cond-> direct
      (seq (named "project")) (assoc :projects (named "project"))
      (seq (named "session")) (assoc :sessions (named "session")))))

(defn- routing-read []
  (if-let [raw (slurp' ROUTING-POLICY)]
    (try
      (let [j (json/parse-string raw false)]
        (validate-routing
          (merge default-routing-policy
               {:schemaVersion (get j "version" 1)
                :mode (get j "mode" "balanced")
                :targets (into {} (map (fn [v]
                                         [(get v "id") (cond-> {:provider (get v "provider")}
                                                         (get v "authMode") (assoc :authMode (get v "authMode"))
                                                         (get v "profile") (assoc :profile (get v "profile")))]))
                               (get j "targets" []))
                :order (vec (get j "targetOrder" (map #(get % "id") (get j "targets" []))))
                :weights (get j "weights" {})
                :reserve (get j "reservedFrontierTarget")
                :pressure (into {} (map (fn [[id v]] [id (cond-> {:level (get v "level")
                                                                   :observedAt (get v "observedAt")}
                                                            (get v "until") (assoc :until (get v "until")))]))
                                (into {} (map (fn [[id v]] [id (assoc v "level" (get v "state"))]))
                                      (get j "pressures" {})))
                :envelopes (flatten-envelopes (get j "envelopes" {}))})))
      (catch Exception e
        (die (str "invalid routing policy " ROUTING-POLICY ": " (.getMessage e)))))
    default-routing-policy))

(defn- routing-write! [policy]
  (io/make-parents ROUTING-POLICY)
  (let [dest (.toPath (io/file ROUTING-POLICY))
        dir  (.getParent dest)
        tmp  (java.nio.file.Files/createTempFile dir ".routing-policy." ".tmp"
                                                  (make-array java.nio.file.attribute.FileAttribute 0))]
    (try
      (let [document (cond-> {:version 1
                              :mode (:mode policy)
                              :targets (mapv (fn [[id target]] (assoc target :id id))
                                             (sort-by key (:targets policy)))
                              :targetOrder (:order policy)
                              :weights (:weights policy)
                              :pressures (into {} (map (fn [[id observation]]
                                                        [id (-> observation
                                                                (assoc :state (:level observation))
                                                                (dissoc :level))]))
                                               (:pressure policy))
                              :envelopes (nest-envelopes (:envelopes policy))}
                       (:reserve policy) (assoc :reservedFrontierTarget (:reserve policy)))]
        (spit (.toFile tmp) (str (json/generate-string document {:pretty true}) "\n")))
      (java.nio.file.Files/move tmp dest
        (into-array java.nio.file.CopyOption
                    [java.nio.file.StandardCopyOption/ATOMIC_MOVE
                     java.nio.file.StandardCopyOption/REPLACE_EXISTING]))
      (finally (java.nio.file.Files/deleteIfExists tmp)))))

(defn- target? [p id] (contains? (:targets p) id))
(defn- require-target! [p id]
  (when-not (target? p id) (die (str "unknown routing target: " id " (add it with `north config routing target add …`)"))))
(defn- positive-int [s label]
  (try
    (let [n (Long/parseLong (or s ""))]
      (if (pos? n) n (throw (Exception.))))
    (catch Exception _ (die (str label " must be a positive integer")))))
(defn- now-iso [] (.toString (java.time.Instant/now)))
(defn- require-iso! [s]
  (try (java.time.OffsetDateTime/parse s)
       (catch Exception _ (die "--until must be an ISO-8601 timestamp, for example 2026-08-01T00:00:00Z"))))

(defn- routing-summary [p]
  (let [reserve (or (:reserve p) "off")]
    (str "mode " (:mode p)
         " · reserve " reserve
         " · targets " (count (:targets p)))))

(defn- print-target-selection [p]
  (let [targets (:order p)]
    (case (:mode p)
      "balanced"
      (do
        (println (str "  configured candidate target set (unordered): " (str/join " · " targets)))
        (println "  eligibility: live authentication/headroom is evaluated by `north providers`")
        (println "  allocation: usage/headroom-weighted stable distribution; `north providers` shows current approximate shares"))

      "preferential"
      (do
        (println (str "  target priority: " (str/join " → " targets)))
        (println "  allocation: first eligible target, then retries in priority order"))

      "reserved"
      (do
        (println (str "  non-reserve target order: " (str/join " → " targets)))
        (println "  allocation: preserve the configured reserve outside eligible frontier work"))

      (println (str "  configured targets: " (str/join " · " targets))))))

(defn- pressure-label [observation]
  (if-not observation
    "automatic"
    (str "manual " (:level observation) " (observed " (:observedAt observation)
         (if-let [until (:until observation)] (str "; until " until) "; 24h TTL") ")")))

(defn- print-routing [p]
  (println (str "routing: " (routing-summary p)))
  (println (str "  policy: " ROUTING-POLICY))
  (print-target-selection p)
  (doseq [[id {:keys [provider authMode profile]}] (sort-by key (:targets p))]
    (println (str "  target " id " → " provider " · auth " (or authMode "ambient")
                  (when profile (str " (profile " profile ")"))
                  " · weight " (get (:weights p) id 1)
                  " · pressure " (pressure-label (get-in p [:pressure id])))))
  (when (seq (:envelopes p))
    (println "  envelopes:")
    (doseq [[scope limits] (sort-by key (:envelopes p))]
      (println (str "    " scope " " (str/join " · " (map (fn [[k v]] (str (name k) "=" v)) (sort-by key limits)))))))
  (println "  live pressure: `north providers` for categorized routing status · `north account usage` for per-account windows and resets.")
  (println "  policy pressure: automatic unless a temporary manual override is shown (24h unless --until is set).")
  (println "  adapter status: provider selection and exact named-account execution are live; an explicit target is pinned with no fallback."))

(def routing-usage
  "usage: north config routing [show|mode preferential|balanced|reserved|order <target...>|weight <target> <positive>|reserve <target|off>|pressure <target> <plenty|normal|low|exhausted|unknown> [--until ISO]|target add <id> <anthropic|openai> [profile] [--auth-mode ambient|isolated]|target remove <id>|envelope set <month|week|default|project:<id>|session:<id>> <runs|frontierRuns|retries|parallelism> <positive>|envelope clear <scope> [limit]]")

(defn cmd-routing [args]
  (let [p (routing-read)
        [verb & xs] args
        save! (fn [next]
                (let [validated (validate-routing next)]
                  (routing-write! validated)
                  (print-routing validated)))]
    (case (or verb "show")
      "show" (print-routing p)
      "mode" (let [[mode & extra] xs]
               (if (and (contains? #{"preferential" "balanced" "reserved"} mode) (empty? extra))
                 (save! (assoc p :mode mode))
                 (die routing-usage)))
      "order" (do (when (empty? xs) (die routing-usage))
                    (doseq [id xs] (require-target! p id))
                    (when-not (= (count xs) (count (distinct xs))) (die "routing order contains duplicate targets"))
                    (save! (assoc p :order (vec xs))))
      "weight" (let [[id n & extra] xs]
                 (when (or (nil? id) (nil? n) (seq extra)) (die routing-usage))
                 (require-target! p id)
                 (save! (assoc-in p [:weights id] (positive-int n "weight"))))
      "reserve" (let [[id & extra] xs]
                  (when (or (nil? id) (seq extra)) (die routing-usage))
                  (when-not (= id "off") (require-target! p id))
                  (save! (assoc p :reserve (when-not (= id "off") id))))
      "pressure" (let [[id level flag until & extra] xs]
                   (when (or (nil? id) (nil? level) (seq extra)
                             (and flag (not= flag "--until"))
                             (and (= flag "--until") (nil? until))) (die routing-usage))
                   (require-target! p id)
                   (when-not (contains? #{"plenty" "normal" "low" "exhausted" "unknown"} level)
                     (die routing-usage))
                   (when until (require-iso! until))
                   (save! (assoc-in p [:pressure id]
                                    (cond-> {:level level :observedAt (now-iso)}
                                      until (assoc :until until)))))
      "target" (let [[op id provider & target-args] xs]
                 (case op
                   "add" (let [[profile auth-mode]
                               (cond
                                 (empty? target-args) [nil nil]
                                 (= 1 (count target-args)) [(first target-args) nil]
                                 (and (= 2 (count target-args)) (= "--auth-mode" (first target-args)))
                                 [nil (second target-args)]
                                 (and (= 3 (count target-args)) (= "--auth-mode" (second target-args)))
                                 [(first target-args) (nth target-args 2)]
                                 :else (die routing-usage))]
                           (when (or (nil? id) (nil? provider)
                                     (not (contains? #{"anthropic" "openai"} provider))) (die routing-usage))
                           (when (and auth-mode (not (contains? #{"ambient" "isolated"} auth-mode))) (die routing-usage))
                           (when (and (= auth-mode "isolated") (not (portable-profile-slug? profile)))
                             (die "isolated routing targets require a portable profile slug (lowercase letters, digits, _ or -; max 64 characters)"))
                           (when (target? p id) (die (str "routing target already exists: " id)))
                           (save! (-> p
                                      (assoc-in [:targets id] (cond-> {:provider provider}
                                                               auth-mode (assoc :authMode auth-mode)
                                                               profile (assoc :profile profile)))
                                      (assoc-in [:weights id] 1)
                                      (update :order conj id))))
                   "remove" (do (when (or (nil? id) provider (seq target-args)) (die routing-usage))
                                 (require-target! p id)
                                 (when (= 1 (count (:targets p))) (die "cannot remove the final routing target"))
                                 (save! (-> p
                                            (update :targets dissoc id)
                                            (update :weights dissoc id)
                                            (update :pressure dissoc id)
                                            (update :order #(vec (remove #{id} %)))
                                            (update :reserve #(when-not (= % id) %)))))
                   (die routing-usage)))
      "envelope" (let [[op scope limit value & extra] xs
                       valid-scope? #(or (contains? #{"month" "week" "default"} %)
                                         (boolean (re-matches #"(project|session):.+" (or % ""))))
                       valid-limit? #(contains? #{"runs" "frontierRuns" "retries" "parallelism"} %)]
                   (case op
                     "set" (do (when (or (seq extra) (not (valid-scope? scope)) (not (valid-limit? limit)) (nil? value)) (die routing-usage))
                               (save! (assoc-in p [:envelopes scope (keyword limit)] (positive-int value "envelope limit"))))
                     "clear" (do (when (or value (seq extra) (not (valid-scope? scope)) (and limit (not (valid-limit? limit)))) (die routing-usage))
                                 (save! (if limit
                                          (let [next (update-in p [:envelopes scope] dissoc (keyword limit))]
                                            (if (empty? (get-in next [:envelopes scope])) (update next :envelopes dissoc scope) next))
                                          (update p :envelopes dissoc scope))))
                     (die routing-usage)))
      (die routing-usage))))

;; --- the report -----------------------------------------------------------
(defn banner []
  (let [rule  (apply str (repeat 66 "─"))
        label "  NORTH CONFIG — every setting, one report"
        d     (today)
        gap   (max 1 (- 66 (count label) (count d) 7))]
    (str "╭" rule "╮\n"
         "│" label (apply str (repeat gap " ")) d "       │\n"
         "╰" rule "╯")))

(defn files-block []
  (let [ls (registry-lines)]
    (if (seq ls)
      (str/join "\n"
                (map #(str "       "
                           (if (str/starts-with? % home)
                             (str "~" (subs % (count home)))
                             %))
                     ls))
      "       (none)")))

(defn status []
  (let [d  (get' "dispatch" "north")
        c  (get' "coord" "north")
        cv (caveman-lvl)
        cd (caveman-default)
        ac (or (System/getenv "AGENT_CAVEMAN") "full (SDK default)")]
    (println (banner))
    (println (str "
 1  CAVEMAN    output compression
    session: " cv " (lite|full|ultra + wenyan-*)      workers: " ac " (inherited at spawn)
    default: " cd " (persists — new sessions start here)
    [live]   session → north config caveman lite|full|ultra   (or /caveman)
    [live]   default → north config caveman default off|lite|full|ultra|wenyan-*
    [spawn]  one worker → spawn {caveman: off|lite|full}   (mcp__north__spawn param)
    [launch] all workers from a session → AGENT_CAVEMAN=off|lite|full claude

 2  DISPATCH   who runs agents                 [guard: " (wired "agent-spawn-guard") "]
    " (mark d "north") " north    SDK workers — persistent, steerable, fact trail;
               model, effort, caveman all have per-spawn opts on mcp__north__spawn;
               model/effort resolve from the requested Gaffer composition and
               provider catalog; caveman alone inherits ambient AGENT_CAVEMAN
               when omitted ([spawn] — frozen for the worker lifetime)
    " (mark d "warn") " warn     native Agent/Workflow allowed, nudged toward north
    " (mark d "native") " native   raw Claude Code spawns, no interference
    flip → north config dispatch north|warn|native

 3  COORD      coordination protocol           [north: " (north-daemon) " · linear MCP: " (linear-mcp) "]
    " (mark c "north") " north    facts on :7977 + concerns + msg-cli chat
    " (mark c "linear") " linear   Linear as the work queue (MCP)
    " (mark c "both") " both     Linear as consolidation layer over north
    note: declarative — agents read this posture; no hard enforcement yet
    flip → north config coord north|linear|both

 4  BEAGLE     code as text vs facts          [guard: " (wired "code-upstream-guard") "]
    fact-native adopted (text edits denied → fram graph tools): " (adopted-n) " file(s)
" (files-block) "
    default-flip: PARKED — pending M1.5-vs-M2 bake-off verdict
    flip → north config beagle adopt|unadopt <absolute-path> · north config beagle list

 5  GUARDS     authoring-guard hooks           kill-switch: " (effective-ks) "
    " (wired "agent-spawn-guard") " agent-spawn-guard   " (wired "code-upstream-guard") " upstream:graph   " (wired "firn-guard") " firn
    " (wired "tripwire-guard") " tripwire            " (wired "racket-build-guard") " racket-build      " (wired "beagle-session-start") " beagle-session
    [live]   flip authoring guards → north config guards on|off   (persists, all sessions; dispatch remains independent)
    [launch] one session → CLAUDE_NO_AUTHORING_HOOKS=1 claude   (launch ONLY — mid-session flip impossible; per-command prefix does nothing; 0/false forces guards live)

 6  ROUTING    provider targets + entitlement envelopes
    " (routing-summary (routing-read)) "
    pressure: automatic usage sensing; manual command is a temporary override/fallback
    configure → north config routing
    policy: " ROUTING-POLICY "

 elsewhere: system/nix settings → firn tag status · session effort → /effort
 dials: [live] north config flip, effective now · [launch] env at claude launch, frozen for session · [spawn] request-owned routing; caveman may inherit ambient env
 state: ~/.local/state/north/harness.conf · legacy read fallback: ~/.claude/my-config.state · descriptions + advice: north config help"))))

(defn help []
  (println "north config — every personal-stack posture setting, one entry point.

 1 CAVEMAN — output compression (token economy).
   Three binding classes:
   [live]   session — north config caveman lite|full|ultra (or /caveman);
            reads ~/.claude/.caveman-active; effective immediately.
   [live]   default — north config caveman default off|lite|full|ultra|wenyan-*;
            new sessions start here; persists across sessions.
   [spawn]  one worker — pass {caveman: off|lite|full} on mcp__north__spawn;
            frozen for that worker's lifetime.
   [launch] all workers from a session — AGENT_CAVEMAN=off|lite|full claude;
            inherited at spawn by workers without a per-spawn override;
            frozen for the session; mid-session flip impossible.
   lite/full/ultra + wenyan variants. Code/commits/quoted errors/security
   are never compressed at any level.
   Global default (new sessions start here) resolution order:
     CAVEMAN_DEFAULT_MODE env > repo-local .caveman.json
       > ~/.config/caveman/config.json (\"defaultMode\" field) > \"full\"
   ~/.config/caveman/config.json is a home-manager out-of-store symlink
   into ~/code/nixos-config/dotfiles/caveman/config.json — edit via
   `north config caveman default <mode>`, then commit in nixos-config.
   One-time: `firn rebuild` wires the symlink if not already present.
   flip default → north config caveman default off|lite|full|ultra|wenyan-*
   Advice: full for coordination, lite for high-stakes design review,
   never ultra/wenyan for substantive work (lossy — PLAYBOOK 2026-06-22).

 2 DISPATCH — who executes agent work.
   north   (default) native Agent/Task/Workflow calls are DENIED by a
           PreToolUse hook and redirected to the north SDK: mcp__north__spawn
           (ad-hoc) / mcp__north__dispatch (thread-driven). SDK workers are
           persistent, dormant-until-pinged, observable through North CLI/MCP,
           steerable (msg-cli :7977). Model, effort, and caveman all have
           per-spawn opts on mcp__north__spawn. Managed children scrub ambient
           routing/staffing variables: model and effort come from the request's
           Gaffer composition and provider catalog unless explicitly pinned.
           Caveman alone may inherit ambient AGENT_CAVEMAN when omitted and is
           frozen for each worker's lifetime.
   warn    native spawns allowed; the hook injects a reminder instead.
   native  no interference. For A/B baselines against stock Claude Code.
   Advice: stay on north. Drop to warn only when the daemon is down.

 3 COORD — source of truth for work coordination.
   north / linear / both (Linear as consolidation layer over north).
   Declarative for now: agents read this posture; nothing mechanically
   blocks the other system yet. Flipping the option does not build the sync.
   Advice: north.

 4 BEAGLE — how Beagle source is authored, per file.
   text          ordinary Edit/Write; the beagle-authoring repair loop.
   fact-native  file is a regenerable view of the fram fact graph; text
                 edits DENIED (code-upstream-guard); author via
                 mcp__fram__* graph tools. Adoption is PER-FILE: the
                 registry (~/.config/fram/graph-upstream-files) or a
                 first-line `;; @upstream:graph` sentinel. The cascade
                 (skill, guard, repair loop vs recompile gate) keys off
                 adoption automatically.
   Advice: don't flip the default until the M1.5-vs-M2 bake-off verdict.

 5 GUARDS — the PreToolUse/SessionStart authoring guards.
   Individually wired in ~/code/nixos-config/dotfiles/claude/settings.json.
   Kill-switch is VALUE-AWARE and has two surfaces:

   [live] state flip (primary — effective immediately across ALL sessions,
   no relaunch; hooks re-read state on every call):
     north config guards off   → writes guards=off to ~/.local/state/north/harness.conf
     north config guards on    → removes that line (or writes guards=on)

   [launch] env override — single session, launch ONLY; mid-session flip
   impossible; per-command env prefix does nothing (claude reads it at
   start, then frozen for the session):
     CLAUDE_NO_AUTHORING_HOOKS=1 claude     authoring guards OFF this session; dispatch unchanged
     CLAUDE_NO_AUTHORING_HOOKS=0 claude     force-live (state ignored)
   Any non-empty value other than 0/false kills guards; 0 or false forces
   them live. This never changes native-vs-North agent topology; `north config
   dispatch` owns that independent axis. Env beats state. Semantics live in the shared lib sourced by
   every guard hook AND by this verb:
     ~/.claude/hooks/lib/authoring-killswitch.sh

 6 ROUTING — durable provider selection and subscription-entitlement policy.
   Show everything with `north config routing`. Balanced allocation is the
   default; preferential and reserved remain explicit choices. Configure
   provider/profile targets and
   month/week/project/session run envelopes. Provider adapters automatically
   sense available subscription usage during normal operation. `routing
   pressure` records a temporary manual override/fallback when sensing cannot
   represent what you know; it expires after 24 hours unless --until is given.
   The canonical atomic JSON file is ~/.config/north/routing-policy.json
   (NORTH_ROUTING_POLICY overrides it for isolated tests/tools).
   Named profiles are executable account targets with isolated subscription
   sessions. No API keys, credit balances, prices, or dollars live
   in this policy.

 Elsewhere (owned by other CLIs, not duplicated here):
   system/nix composition → firn tag status · firn enable <tag>
   session effort/ultracode → /effort (harness-level, not script-readable)"))

;; --- verb dispatch --------------------------------------------------------
(def caveman-modes #{"lite" "full" "ultra" "wenyan-lite" "wenyan-full" "wenyan-ultra"})
(def caveman-default-modes (conj caveman-modes "off"))

(defn cmd-caveman [[sub arg]]
  (cond
    (= sub "default")
    (cond
      (caveman-default-modes arg)
      (do (io/make-parents CAVEMAN-DEFAULT)
          (spit CAVEMAN-DEFAULT (str "{\"defaultMode\":\"" arg "\"}\n"))
          (println (str "caveman default → " arg " (written to ~/code/nixos-config/dotfiles/caveman/config.json)"))
          (let [link (str home "/.config/caveman/config.json")
                canon (try (.getCanonicalPath (io/file link)) (catch Exception _ nil))]
            (when (not= canon CAVEMAN-DEFAULT)
              (eprintln "  ⚠  ~/.config/caveman/config.json not yet linked — run: firn rebuild")))
          (println "  note: change lives in nixos-config — commit it there"))
      (nil? arg)
      (println (str "caveman default = " (caveman-default) "   (north config caveman default <mode>)"))
      :else
      (die "usage: north config caveman default [off|lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra]"))

    (caveman-modes sub)
    (do (spit CAVEMAN-STATE sub)
        (println (str "caveman session level → " sub " (plugin reads ~/.claude/.caveman-active)")))

    (nil? sub)
    (println (str "caveman = " (caveman-lvl) "   default = " (caveman-default)
                  "   (north config caveman lite|full|ultra|default <mode>; off → say 'stop caveman' / use /caveman)"))

    (= sub "off")
    (die "turn off via the plugin: say 'stop caveman' or /caveman — plugin owns the off-path")

    :else
    (die "usage: north config caveman [default <mode>|lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra]")))

(defn cmd-dispatch [[sub]]
  (cond
    (#{"north" "warn" "native"} sub)
    (do
      (put' "dispatch" sub)
      (println (str "dispatch → " sub " "
                    (cond (= sub "north") "(native Agent/Workflow now DENIED → north SDK)"
                          (= sub "warn")  "(native allowed, nudged)"
                          :else           "(native allowed, silent)"))))
    (nil? sub)
    (let [d (get' "dispatch" "north")]
      (println (str "dispatch = " d "   (north config dispatch north|warn|native)")))
    :else
    (die "usage: north config dispatch [north|warn|native]")))

(defn cmd-coord [[sub]]
  (cond
    (#{"north" "linear" "both"} sub)
    (do
      (put' "coord" sub)
      (println (str "coord → " sub " (declarative; agents read it from the north config report)")))
    (nil? sub)
    (let [c (get' "coord" "north")]
      (println (str "coord = " c "   (north config coord north|linear|both)")))
    :else
    (die "usage: north config coord [north|linear|both]")))

(defn cmd-beagle [[sub path]]
  (case (or sub "list")
    "list"
    (do (println (str "fact-native adopted files (" (adopted-n) "):"))
        (let [ls (registry-lines)]
          (if (seq ls) (doseq [l ls] (println l)) (println "  (none)"))))
    "adopt"
    (cond
      (nil? path) (die "usage: north config beagle adopt </absolute/path>")
      (not (.isFile (io/file path))) (die (str "no such file: " path))
      :else
      (do (io/make-parents REGISTRY)
          (when-not (some #{path} (registry-raw))
            (spit REGISTRY (str path "\n") :append true))
          (println (str "adopted fact-native: " path " (text edits now denied; use mcp__fram__* graph tools)"))))
    "unadopt"
    (if (nil? path)
      (die "usage: north config beagle unadopt </absolute/path>")
      (let [kept (remove #{path} (registry-raw))]
        (spit REGISTRY (if (seq kept) (str (str/join "\n" kept) "\n") ""))
        (println (str "un-adopted (text mode again): " path))))
    (die "usage: north config beagle [list|adopt <path>|unadopt <path>]")))

(defn cmd-guards [[sub]]
  (cond
    (= sub "off") (do (put' "guards" "off")
                      (println "guards → OFF in all sessions (hooks re-read state per call, no relaunch needed); north config guards on restores"))
    (= sub "on")  (do (put' "guards" "on")
                      (println "guards → LIVE in all sessions (takes effect immediately)"))
    (nil? sub)
    (do (println (str "kill-switch: " (effective-ks)))
        (doseq [g ["agent-spawn-guard" "code-upstream-guard" "firn-guard"
                   "tripwire-guard" "racket-build-guard" "beagle-session-start"]]
          (println (str "  " (wired g) " " g))))
    :else (die "usage: north config guards [on|off]")))

(defn -main [& args]
  (let [[verb & rest] args]
    (case (or verb "status")
      ("status") (status)
      "caveman"  (cmd-caveman rest)
      "dispatch" (cmd-dispatch rest)
      "coord"    (cmd-coord rest)
      "beagle"   (cmd-beagle rest)
      "guards"   (cmd-guards rest)
      "routing"  (cmd-routing rest)
      ("help" "-h" "--help") (help)
      (die "usage: north config [status|caveman|dispatch|coord|beagle|guards|routing|help]"))))

(apply -main *command-line-args*)
