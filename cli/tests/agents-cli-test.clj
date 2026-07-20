#!/usr/bin/env bb
(require '[babashka.process :as proc]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root (.getCanonicalPath (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(System/setProperty "north.agents.lib" "1")
(load-file (str root "/cli/agents-cli.clj"))

(def checks (atom []))
(defn check [label ok?] (swap! checks conj [label (boolean ok?)]))

(let [scratch (.toFile (java.nio.file.Files/createTempDirectory
                        "north-watch-test-"
                        (make-array java.nio.file.attribute.FileAttribute 0)))
      stream-dir (io/file scratch "streams")
      control-dir (io/file scratch "control")
      id "lane-watch-probe-1234"
      stream-file (io/file stream-dir (str "agent-" id ".stream.jsonl"))
      control-file (io/file control-dir (str id ".log"))]
  (.mkdirs stream-dir)
  (.mkdirs control-dir)
  (spit stream-file "{\"type\":\"assistant\",\"message\":\"working\"}\n")
  ;; The production failure this guards against had a healthy canonical stream
  ;; while its process/control log was effectively silent.
  (spit control-file "")
  (let [plan (watch-plan [id] (str stream-dir) (str control-dir))
        rendered (str/join "\n" (watch-status-lines plan))]
    (check "watch defaults to the active canonical stream when the control log is silent"
           (and (= :stream (:mode plan))
                (= (str stream-file) (get-in plan [:stream :path]))
                (pos? (get-in plan [:stream :bytes]))
                (zero? (get-in plan [:control :bytes]))
                (str/includes? rendered "watch target: canonical SDK event stream")
                (str/includes? rendered "event data present")
                (str/includes? rendered "present but empty")
                (str/includes? rendered "silence is not evidence that a worker stalled or died"))))
  (let [plan (watch-plan [id "--control"] (str stream-dir) (str control-dir))]
    (check "control-log following requires explicit opt-in and retains both paths"
           (and (= :control (:mode plan))
                (= (str stream-file) (get-in plan [:stream :path]))
                (= (str control-file) (get-in plan [:control :path])))))
  (check "watch rejects path traversal and extra arguments before resolving files"
         (and (:error (watch-plan ["../lane"] (str stream-dir) (str control-dir)))
              (:error (watch-plan [id "--control" "extra"]
                                  (str stream-dir) (str control-dir))))))

(defn managed [facts]
  (let [base (merge {"kind" "lane" "goal" "fixture" "repo" "~/code/north"
                     "spawned_at" "2026-07-17T00:00:00Z"
                     "display_handle" "fixture" "display_name" "fixture"
                     "provider_target" (get facts "provider")
                     "live_input" (if (= "anthropic" (get facts "provider"))
                                    "streaming"
                                    "unsupported")
                     "live_input_state" (if (= "anthropic" (get facts "provider"))
                                          "armed"
                                          "frozen")
                     "live_input_epoch" "00000000-0000-4000-8000-000000000010"}
                    facts)]
    (assoc base "identity_manifest_sha256"
           (north.agent-provenance/manifest-sha256 base))))
(defn marked-terminal
  ([facts] (marked-terminal facts "ran" "unverified"))
  ([facts process delivery]
   (let [terminal {"outcome" process
                   "process_outcome" process
                   "delivery_outcome" delivery
                   "delivery_reason" (if (= delivery "unverified")
                                       "provider_terminal_success_without_external_verification"
                                       "execution_did_not_reach_success_terminal")}]
     (merge facts terminal
            {"terminal_manifest_sha256"
             (north.terminal-projection/terminal-manifest-sha256 terminal)}))))
(defn fold-observed [facts]
  (reduce-kv north.agent-provenance/fold-fact {} facts))

(let [fixtures (json/parse-string
                (slurp (io/file root "sdk/test/fixtures/agent-roster-contract.json")))]
  (check
   "shared roster fixtures preserve semantic identity in the CLI projection"
   (every?
    true?
    (for [{:strs [name id facts expected]} fixtures
          :let [line (agent-primary-line {:online true} facts)
                axes (str (get expected "providerLabel")
                          " · " (get expected "modelDisplay")
                          " · " (get expected "effortDisplay")
                          " · " (get expected "gafferProvenance"))]]
      (and (= (get expected "gafferProvenance") (gaffer-provenance facts))
           (= (get expected "semanticHandle") (semantic-handle id facts))
           (= (get expected "primaryLine") line)
           (str/starts-with? line axes)
           (not= line (get facts "display_name"))
           ;; Display text is output only. It cannot repair missing structured axes.
           (or (not= name "missing-managed-axes")
               (and (str/includes? line "gaffer:legacy-debt")
                    (not (str/includes? line "designer")))))))))

(let [native (first (json/parse-string
                     (slurp (io/file root "sdk/test/fixtures/agent-roster-contract.json"))))
      cases (get native "observationCases")]
  (check
   "native observation conflicts are deterministic and match the shared roster golden"
   (every?
    true?
    (for [{:strs [observations expected]} cases
          :let [facts (reduce (fn [acc [predicate value]]
                                (north.agent-provenance/fold-fact acc predicate value))
                              {} observations)
                line (agent-primary-line {:online true} facts)]]
      (and (= (get expected "providerLabel") (provider-target-label facts))
           (= (get expected "gafferProvenance") (gaffer-provenance facts))
           (= (get expected "semanticHandle")
              (semantic-handle "session-native-7841e6b2" facts))
           (= (get expected "primaryLine") line))))))

(check "session current task outranks stale lane goal and stored presentation receipts"
       (= "anthropic:ambient · opus · xhigh · gaffer:designer · working: Current session task"
          (agent-primary-line
           {:online true}
           (managed
            {"kind" "lane" "provider" "anthropic" "model" "opus" "effort" "xhigh"
             "composition_kind" "preset" "role" "designer" "composition_id" "designer"
             "composition_overrides" "[]" "goal" "Stale lane goal"
             "display_name" "STALE presentation receipt"})
           {"current_thread" "Current session task"})))

(check "preset roster line uses canonical structured axes"
       (= "anthropic:ambient · opus · xhigh · gaffer:designer · working: build the roster"
          (agent-primary-line {:online true}
                              (managed
                               {"kind" "lane" "provider" "anthropic" "model" "claude-opus-4-8"
                                "effort" "xhigh" "composition_kind" "preset"
                                "role" "designer" "composition_id" "designer"
                                "composition_overrides" "[]" "goal" "build the roster"}))))

(check "bespoke provenance is explicit"
       (str/includes?
        (agent-primary-line {:online true}
                            (managed
                             {"kind" "lane" "provider" "openai" "model" "gpt-5.6-sol"
                              "effort" "high" "composition_kind" "bespoke"
                              "role" "migration-forensics" "composition_id" "migration-forensics"
                              "bespoke_reason" "one-off provenance analysis"
                              "promotion_candidate" "false"
                              "composition_contract_sha256" (apply str (repeat 64 "a"))
                              "composition_contract_fingerprint_version" "v1"
                              "composition_contract_fingerprint_domain" "north:bespoke-contract:v1"
                              "goal" "trace schema"}))
        "gaffer:bespoke:migration-forensics"))

(check "account target and Gaffer template are first-class in the roster"
       (= "openai:codex-work · sol · high · gaffer:designer · working: trace schema"
          (agent-primary-line {:online true}
                              (managed
                               {"kind" "lane" "provider" "openai" "provider_target" "codex-work"
                                "model" "gpt-5.6-sol" "effort" "high" "composition_kind" "preset"
                                "role" "designer" "composition_id" "designer"
                                "composition_overrides" "[]" "goal" "trace schema"}))))

(check "preset overrides are a compact projection of structured facts"
       (= "openai:ambient · sol · xhigh · gaffer:integrator+override(tier,reasoning) · working: cross-seam repair"
          (agent-primary-line {:online true}
                              (managed
                               {"kind" "lane" "provider" "openai" "model" "gpt-5.6-sol"
                                "effort" "xhigh" "composition_kind" "preset"
                                "role" "integrator" "composition_id" "integrator"
                                "composition_overrides" "[\"tier\",\"reasoning\"]"
                                "composition_override_reason" "high leverage seam"
                                "goal" "cross-seam repair"}))))

(check "malformed managed override provenance is explicit legacy debt"
       (str/includes?
        (agent-primary-line {:online true}
                            (managed
                             {"kind" "lane" "provider" "openai" "model" "gpt-5.6-sol"
                              "effort" "xhigh" "composition_kind" "preset"
                              "role" "integrator" "composition_id" "integrator"
                              "composition_overrides" "[\"tier\"]"}))
        "gaffer:legacy-debt"))

(check "default managed target is displayed as ambient"
       (str/starts-with?
        (agent-primary-line {:online true}
                            (managed
                             {"kind" "lane" "provider" "anthropic" "provider_target" "anthropic"
                              "model" "opus" "effort" "high" "composition_kind" "preset"
                              "role" "integrator" "composition_id" "integrator"
                              "composition_overrides" "[]"}))
        "anthropic:ambient · opus · high · gaffer:integrator"))

(check "historical native gaps are explicit provenance labels, never model names"
       (= "provider:historical-unrecorded · model:historical-unrecorded · effort:historical-unrecorded · gaffer:not-selected · working: unknown"
          (agent-primary-line {:online true :focus "CONTEXT BRIEF:"} {"kind" "session"})))

(check "native session with a repo has an honest useful activity fallback"
       (str/ends-with?
        (agent-primary-line {:online true} {"kind" "session" "provider" "openai"
                                            "model" "gpt-5.6-sol" "effort" "unobserved"
                                            "repo" "north"})
        "working: native session in north"))

(check "new native missing effort is an observation boundary, not a preset failure"
       (str/includes?
        (agent-primary-line {:online true} {"kind" "session" "provider" "openai"
                                            "model" "gpt-5.6-sol" "effort" "unobserved"})
        "openai · sol · effort:unobserved · gaffer:not-selected"))

(check "roster lifecycle categories do not call terminal TTL rows active"
       (and (= :active-agent (roster-category {"kind" "lane"}))
            (= :native-session (roster-category {"kind" "session"}))
            (= :recently-finished (roster-category {"kind" "lane" "outcome" "ran"}))
            (= :inconsistent
               (roster-category {"kind" "lane" "process_outcome" "ran" "outcome" "ran"}))
            (= :recently-finished
               (roster-category (marked-terminal {"kind" "lane"})))
            (= :unclassified (roster-category {}))))

(let [control "lane-run-terminal"
      terminal (dissoc (marked-terminal {}) "terminal_manifest_sha256")
      committed-run
      {:subject "@run:lane-run-terminal"
       :facts (merge terminal
                     {"kind" "run" "agent" control
                      "at" "2026-07-20T09:00:00Z"})}
      no-run
      (attach-lane-resolutions
       [control] {control {"kind" "lane"}}
       {:ok true :by-agent {control []}})
      resolved
      (attach-lane-resolutions
       [control] {control {"kind" "lane"}}
       {:ok true :by-agent {control [committed-run]}})
      malformed
      (attach-lane-resolutions
       [control] {control {"kind" "lane"}}
       {:ok true
        :by-agent
        {control [(update committed-run :facts dissoc "kind")]}})]
  (check "canonical run resolution controls roster active, finished, and inconsistent categories"
         (and (= :active-agent (roster-category (get no-run control)))
              (= :recently-finished (roster-category (get resolved control)))
              (= :inconsistent (roster-category (get malformed control)))
              (= "finished"
                 (get (roster-json-row {:id control :online true :expires-s 10}
                                       (get resolved control) {})
                      "state"))
              (= "inconsistent"
                 (get (roster-json-row {:id control :online true :expires-s 10}
                                       (get malformed control) {})
                      "lifecycle")))))

(check "terminal roster state separates process exit from delivery truth"
       (and (str/includes?
             (agent-primary-line
              {:online true}
              (marked-terminal {"kind" "lane" "goal" "attempt delivery"}))
             "finished(process:ran, delivery:unverified)")
            (str/includes?
             (agent-primary-line {:online true}
                                 {"kind" "lane" "outcome" "ran" "goal" "legacy"})
             "finished(process:ran, delivery:unrecorded)")))

(check "legacy same-UID verified projection is lifecycle-inconsistent, never finished or active"
       (let [evidence (json/generate-string
                       {"version" "north:done-bars:v1"
                        "run" "@run-worker"
                        "thread" "@thread"
                        "reporter" "@agent:worker"
                        "capturedAt" "2026-07-18T10:00:00Z"
                        "baselineEvidenceSha256"
                        (north.terminal-projection/sha256 "[]")
                        "doneWhen" ["tests pass"]
                        "matches" [{"bar" "tests pass"
                                    "evidence" ["tests pass → exit 0"]}]})
             evidence-hash (north.terminal-projection/sha256 evidence)
             attestation (json/generate-string
                          {"version" "north:delivery-attestation:v1"
                           "target" "@agent:worker"
                           "run" "@run-worker"
                           "thread" "@thread"
                           "evidenceSha256" evidence-hash
                           "actor" "@agent:verifier"
                           "role" "verifier"
                           "authority" "managed-independent-verifier"
                           "attestedAt" "2026-07-18T10:01:00Z"})
             terminal {"outcome" "ran" "process_outcome" "ran"
                       "delivery_outcome" "verified"
                       "delivery_reason" "independent_managed_verifier_attested"
                       "delivery_evidence" evidence
                       "delivery_evidence_sha256" evidence-hash
                       "delivery_attestation" attestation
                       "delivery_attestation_sha256"
                       (north.terminal-projection/sha256 attestation)}
             facts (merge {"kind" "lane" "goal" "verified delivery"}
                          terminal
                          {"terminal_manifest_sha256"
                           (north.terminal-projection/terminal-manifest-sha256 terminal)})]
         (let [line (agent-primary-line {:online true} facts)]
           (and (not (str/includes? line "delivery:verified"))
                (str/includes? line "inconsistent(lifecycle:invalid-lane-terminal)")))))

(check "folded terminal conflicts stay visible and cannot manufacture a finished lane"
       (let [committed (fold-observed
                        (marked-terminal {"kind" "lane" "goal" "conflict probe"}))
             process-conflict (north.agent-provenance/fold-fact
                               committed "process_outcome" "died")
             marker-conflict (north.agent-provenance/fold-fact
                              committed "terminal_manifest_sha256" "corrupt")]
         (and (= #{"ran"} (get committed "process_outcome"))
              (= :recently-finished (roster-category committed))
              (str/includes? (agent-primary-line {:online true} committed)
                             "finished(process:ran, delivery:unverified)")
              (= #{"ran" "died"} (get process-conflict "process_outcome"))
              (= :inconsistent (roster-category process-conflict))
              (str/includes? (agent-primary-line {:online true} process-conflict)
                             " · inconsistent(lifecycle:invalid-lane-terminal): conflict probe")
              (= :inconsistent (roster-category marker-conflict)))))

(check "uncomposed role remains visible without inventing Gaffer provenance"
       (let [facts {"kind" "lane" "provider" "anthropic" "model" "opus"
                    "effort" "xhigh"
                    "role" "orchestrator" "goal" "coordinate work"}]
         (and (str/includes? (agent-primary-line {:online true} facts)
                             "gaffer:legacy-debt · role:orchestrator")
              (= "anthropic-opus-xhigh-gaffer-legacy-debt-legacy"
                 (semantic-handle "lane-legacy" facts)))))

(check "only provider-native sessions receive the native handle segment"
       (= "openai-sol-unobserved-gaffer-not-selected-native"
          (semantic-handle "session-native"
                           {"kind" "session" "provider" "openai" "model" "gpt-5.6-sol"
                            "effort" "unobserved"})))

(check "composition_kind=none never manufactures native provenance"
       (and (str/includes?
             (agent-primary-line {:online true}
                                 {"kind" "lane" "composition_kind" "none"})
             "gaffer:legacy-debt")
            (str/includes?
             (agent-primary-line {:online true}
                                 {"kind" "session" "composition_kind" "none"})
             "gaffer:not-selected")))

(check "display labels are never reverse-parsed into missing structured facts"
       (let [facts {"kind" "lane" "display_name" "anthropic opus xhigh designer"}]
         (and (str/starts-with? (agent-primary-line {:online true} facts)
                                "unknown · unknown · unknown · gaffer:legacy-debt")
              (str/starts-with? (semantic-handle "sdk-a205e9ce" facts)
                                "unknown-unknown-unknown-gaffer-legacy-debt-"))))

(check "current structured effort overrides a stale stored handle"
       (= "openai-ambient-sol-xhigh-gaffer-designer-a205e9ce"
          (semantic-handle "sdk-a205e9ce"
                           (managed
                            {"kind" "lane" "provider" "openai" "model" "gpt-5.6-sol"
                             "effort" "xhigh" "composition_kind" "preset"
                             "role" "designer" "composition_id" "designer"
                             "composition_overrides" "[]"
                             "display_handle" "openai-sol-high-designer-a205e9ce"}))))

(check "dry-run route: Anthropic frontier resolves to the Gaffer config model, no Fable window swap"
       (let [route (dry-resolved-route "anthropic" "frontier" nil nil)]
         (and (= "anthropic" (:provider route))
              (not= "fable" (:model route)))))

(let [bulk [(str root "/bin/north") "json" "agents"]
      show [(str root "/bin/north") "json" "show" "agent:sdk-recovered"]
      calls (atom [])
      facts (with-redefs [run (fn [argv & _]
                                (swap! calls conj argv)
                                (cond
                                  (= argv bulk) {:ok false :exit 1 :err "malformed warm row"}
                                  (= argv show) {:ok true :exit 0
                                                 :out "[{\"predicate\":\"provider\",\"value\":\"openai\"},{\"predicate\":\"model\",\"value\":\"gpt-5.6-sol\"}]"}
                                  :else {:ok true :exit 0 :out "[]"}))]
              (agent-facts ["sdk-recovered" "legacy-session"]))]
  (check "a failed bulk projection recovers structured identity per live agent"
         (= {"provider" "openai" "model" "gpt-5.6-sol"}
            (select-keys (get facts "sdk-recovered") ["provider" "model"])))
  (check "a fact-less legacy row stays honestly unknown"
         (and (= {} (get facts "legacy-session"))
              (str/starts-with? (agent-primary-line {:online true} (get facts "legacy-session" {}))
                                "unknown · unknown · unknown · gaffer:legacy-debt")))
  (check "fallback is structured and scoped only to missing live ids"
         (and (= bulk (first @calls))
              (= 3 (count @calls)))))

(let [bulk [(str root "/bin/north") "json" "show-many"
            "agent:lane-a,session:lane-a"]
      calls (atom [])
      failed
      (with-redefs [run (fn [argv & _]
                          (swap! calls conj argv)
                          {:ok false :exit 1})]
        (roster-facts
         (mapv #(str "lane-" %) (range max-live-controls))))
      valid-empty
      (with-redefs [run (fn [& _] {:ok true :exit 0 :out "[]"})]
        (roster-facts ["lane-a"]))
      malformed
      (with-redefs [run (fn [& _]
                          {:ok true :exit 0
                           :out "[{\"subject\":\"agent:lane-a\",\"predicate\":\"task\"}]"})]
        (roster-facts ["lane-a"]))]
  (check "bulk roster failure performs one bounded call, never a 2N fallback"
         (and (= 1 (count @calls))
              (= "agent subject projection unavailable" (:err failed))))
  (check "a successful empty bulk projection remains distinguishable from failure"
         (= {:agents {} :sessions {}} valid-empty))
  (check "malformed bulk subject rows fail closed"
         (= "agent subject projection was malformed" (:err malformed))))

(let [out (with-redefs [presence-rows (fn [] {:agents [{:id "lane-active" :online true :expires "10s" :expires-s 10}
                                                        {:id "session-active" :online true :expires "20s" :expires-s 20}
                                                        {:id "lane-done" :online true :expires "30s" :expires-s 30}]})
                        roster-facts
                        (fn [_]
                          {:agents
                           {"lane-active" {"kind" "lane" "provider" "openai"
                                           "model" "gpt-5.6-sol" "effort" "high"
                                           "role" "integrator" "composition_kind" "preset"
                                           "composition_id" "integrator" "composition_overrides" "[]"}
                            "session-active" {"kind" "session" "provider" "anthropic"
                                              "model" "claude-opus-4-8" "effort" "xhigh"}
                            "lane-done" {"kind" "lane" "provider" "openai"
                                         "model" "gpt-5.6-sol" "effort" "high"
                                         "role" "designer" "composition_kind" "preset"
                                         "composition_id" "designer" "composition_overrides" "[]"
                                         "outcome" "ran" "process_outcome" "ran"
                                         "delivery_outcome" "unverified"
                                         "delivery_reason" "provider_terminal_success_without_external_verification"
                                         "terminal_manifest_sha256"
                                         (north.terminal-projection/terminal-manifest-sha256
                                          {"outcome" "ran"
                                           "process_outcome" "ran"
                                           "delivery_outcome" "unverified"
                                           "delivery_reason" "provider_terminal_success_without_external_verification"})}}
                           :sessions {}})
                        roster-run-entries
                        (fn [ids]
                          {:ok true
                           :by-agent (into {} (map #(vector % []) ids))})]
            (with-out-str (cmd-agents [])))]
  (check "roster summary separates active and recently finished counts"
         (and (str/includes? out "3 roster entries · 2 active · 0 inconsistent · 1 recently finished")
              (str/includes? out "active agents (1)")
              (str/includes? out "native sessions (1)")
              (str/includes? out "recently finished (1)")
              (str/includes? out "finished(process:ran, delivery:unverified)")
              (not (str/includes? out "live agents"))))
  (check "ordinary roster output hides the internal presence probe"
         (not (str/includes? out "presence-cli.clj"))))

(let [out (with-redefs [presence-rows (fn [] {:agents []})
                        roster-facts (fn [_] {:agents {} :sessions {}})]
            (with-out-str (cmd-agents ["--verbose"])))]
  (check "verbose roster output retains the internal presence probe"
         (str/includes? out "presence-cli.clj")))

(let [valid (with-redefs [run (fn [& _]
                                {:ok true
                                 :out "{\"version\":\"north:presence-online:v1\",\"sessions\":[{\"control_id\":\"lane-a\",\"online\":true,\"expires_s\":7}]}"})]
              (presence-rows))
      prose (with-redefs [run (fn [& _]
                                {:ok true :out "AGENT ONLINE EXPIRES\nlane-a yes 7s\n"})]
              (presence-rows))]
  (check "roster intake consumes the strict presence JSON contract"
         (= [{:id "lane-a" :online true :expires-s 7 :expires "7s"}]
            (:agents valid)))
  (check "roster intake rejects prose instead of scraping human columns"
         (= "presence projection was malformed" (:err prose))))

(let [help (proc/shell {:out :string :err :string :continue true
                        :extra-env {"NO_COLOR" "1"}}
                       (str root "/bin/north") "agents" "--help")
      unknown (proc/shell {:out :string :err :string :continue true
                           :extra-env {"NO_COLOR" "1"}}
                          (str root "/bin/north") "agents" "--bogus")]
  (check "agents help documents the versioned JSON mode"
         (and (zero? (:exit help))
              (str/includes? (:out help) "north:agent-roster:v1")))
  (check "agents rejects unknown options without probing presence"
         (and (= 1 (:exit unknown))
              (str/includes? (:err unknown) "unknown option --bogus")
              (not (str/includes? (str (:out unknown) (:err unknown))
                                  "presence-cli.clj")))))

(let [steer (proc/shell {:out :string :err :string :continue true
                         :extra-env {"NORTH_AGENTS_LIB" "" "NO_COLOR" "1"}}
                        "bb" (str root "/cli/agents-cli.clj") "steer"
                        "probe-agent" "probe-message" "--dry-run")]
  (check "steer remains parseable and keeps the internal control key"
         (and (zero? (:exit steer))
              (str/includes? (:out steer) "send north-cli probe-agent steer probe-message")
              (str/includes? (:out steer)
                             "[dry-run] not sent; target capability and liveness were not checked."))))

(let [help (proc/shell {:out :string :err :string :continue true
                        :extra-env {"NO_COLOR" "1"}}
                       (str root "/bin/north") "spawn" "--help")]
  (check "top-level spawn help explains template overrides and the bespoke contract"
         (and (zero? (:exit help))
              (str/includes? (:out help) "Stock template:")
              (str/includes? (:out help) "any changed template axis requires --override-reason WHY")
              (str/includes? (:out help) "north templates")
              (str/includes? (:out help) "Bespoke role:")
              (str/includes? (:out help) "--rationale WHY --contract JSON|@file")
              (str/includes? (:out help) "responsibility, deliverable, capabilities, mayDecide")
              (str/includes? (:out help) "--target ACCOUNT")
              (str/includes? (:out help) "validate pinned-provider capability authority")
              (not (str/includes? (str (:out help) (:err help)) "unknown spawn option")))))

(let [templates (proc/shell {:out :string :err :string :continue true
                             :extra-env {"NO_COLOR" "1"}}
                            (str root "/bin/north") "templates")]
  (check "north templates is a routed human view over the Gaffer catalog"
         (and (zero? (:exit templates))
              (str/includes? (:out templates) "GAFFER STOCK TEMPLATES")
              (str/includes? (:out templates)
                             "exact template → justified axis override → bespoke composition")
              (str/includes? (:out templates) "integrator")
              (str/includes? (:out templates) "grade senior · senior/high · worker · deliver")
              (str/includes? (:out templates) "composition.kind=preset"))))

(let [card (proc/shell {:out :string :err :string :continue true}
                       (str root "/bin/north") "help")]
  (check "the top-level card advertises the templates view"
         (and (zero? (:exit card))
              (str/includes? (:out card) "north templates")
              (str/includes? (:out card) "stock templates"))))

(let [dry (proc/shell {:out :string :err :string :continue true
                       :extra-env {"NORTH_AGENTS_LIB" "" "NO_COLOR" "1"}}
                      "bb" (str root "/cli/agents-cli.clj") "spawn" "designer" "probe"
                      "--provider" "openai" "--dry-run")]
  (check "spawn dry-run leads with semantic identity and retains control key separately"
         (and (zero? (:exit dry))
              (re-find #"openai-ambient-sol-xhigh-gaffer-designer-[0-9a-f]{12}" (:out dry))
              (re-find #"control: lane-[0-9a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" (:out dry))
              (not (str/includes? (:out dry) "agent-id would be")))))

(let [closed (proc/shell {:out :string :err :string :continue true
                          :extra-env {"NORTH_AGENTS_LIB" "" "NO_COLOR" "1"}}
                         "bb" (str root "/cli/agents-cli.clj") "spawn" "designer" "probe"
                         "--provider" "anthropic" "--dry-run")]
  (check "CLI dry route resolves anthropic frontier to the static Gaffer opus/xhigh route"
         (and (zero? (:exit closed))
              (re-find #"anthropic-ambient-opus-xhigh-gaffer-designer-[a-z0-9]+" (:out closed))
              (not (str/includes? (:out closed) "anthropic-fable")))))

(let [dry (proc/shell {:out :string :err :string :continue true
                       :extra-env {"NORTH_AGENTS_LIB" "" "NO_COLOR" "1"}}
                      "bb" (str root "/cli/agents-cli.clj") "spawn" "designer" "probe"
                      "--provider" "openai" "--target" "codex-work" "--dry-run")]
  (check "spawn target becomes AGENT_TARGET and appears in the fallback identity"
         (and (zero? (:exit dry))
              (str/includes? (:out dry) "AGENT_TARGET=codex-work")
              (re-find #"openai-codex-work-sol-xhigh-gaffer-designer-[a-z0-9]+" (:out dry)))))

(let [results @checks pass (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\nagents CLI: %d / %d PASS" pass (count results)))
  (System/exit (if (= pass (count results)) 0 1)))
