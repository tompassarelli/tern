#!/usr/bin/env bb
(require '[babashka.process :as proc]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(System/setProperty "north.agents.lib" "1")
(load-file (str root "/cli/agents-cli.clj"))

(def checks (atom []))
(defn check [label value] (swap! checks conj [label (boolean value)]))

(check "top-level sessions without a declared topology retain coordination authority"
       (nil? (binding [north.topology-authority/*topology* nil]
               (north.topology-authority/authority-problem "spawn"))))
(check "an explicit orchestrator retains coordination authority"
       (nil? (binding [north.topology-authority/*topology* "orchestrator"]
               (north.topology-authority/authority-problem "spawn"))))
(let [binding (with-redefs [managed-thread-binding
                            (fn [] {:kind :complete :thread "parent-thread"})]
                (resolve-recursive-child-thread! "recursive child" true))]
  (check "an orchestrator child receives a fresh dry-run thread linked to its immediate parent"
         (and (= "recursive-child-on-execution" (:id binding))
              (= "parent-thread" (:parent binding))
              (= "@parent-thread"
                 (:value (first (filter #(= "part_of" (:predicate %))
                                        (:facts binding))))))))

(let [parsed (parse-scope-escalation-args
              ["--summary" "scope grew" "--checkpoint" "probe A passed"
               "--seam" "new database seam" "--seam" "new auth seam"
               "--propose" "database worker" "--propose" "auth worker"
               "--budget-signal" "75 percent" "--no-progress" "three turns"])]
  (check "scope-overrun canary preserves structured checkpoint, seams, decomposition, and signals"
         (= {:seams ["new database seam" "new auth seam"]
             :decomposition ["database worker" "auth worker"]
             :summary "scope grew" :checkpoint "probe A passed"
             :budgetSignal "75 percent" :noProgress "three turns"}
            parsed)))
(check "scope-overrun routing uses the immediate live parent"
       (= "parent" (supervisor-route "parent" #{"parent"} (constantly nil))))
(check "scope-overrun routing skips a dead parent only along the declared supervisor chain"
       (= "grandparent"
          (supervisor-route "parent" #{"grandparent"}
                            {"parent" "grandparent" "grandparent" nil})))
(check "scope-overrun routing fails safe on an absent/cyclic supervisor chain"
       (nil? (supervisor-route "parent" (constantly false)
                               {"parent" "grandparent" "grandparent" "parent"})))
(check "an unknown explicit topology fails closed"
       (str/includes?
        (binding [north.topology-authority/*topology* "unexpected"]
          (north.topology-authority/authority-problem "spawn"))
        "current topology is unexpected"))

(def side-effects (atom []))
(defn denied-before-side-effect? [operation thunk]
  (reset! side-effects [])
  (let [error (try
                (binding [north.topology-authority/*topology* "worker"] (thunk))
                nil
                (catch clojure.lang.ExceptionInfo error error))]
    (and (north.topology-authority/denial? error)
         (= operation (:operation (ex-data error)))
         (true? (:pre-side-effect (ex-data error)))
         (str/includes? (.getMessage error) (str operation " requires orchestrator topology"))
         (empty? @side-effects))))

(with-redefs [run (fn [& _] (swap! side-effects conj :process) {:ok true})
              north.spawn-process/launch-detached!
              (fn [& _] (swap! side-effects conj :spawn) nil)]
  (check "raw CLI spawn denies a worker before parsing or launching"
         (denied-before-side-effect?
          "spawn" #(cmd-spawn ["director" "probe" "--topology" "orchestrator" "--dry-run"])))
  (check "raw CLI delegate denies a worker before composing or spawning"
         (denied-before-side-effect? "delegate" #(cmd-delegate ["probe" "--dry-run"])))
  (check "raw CLI steer denies a worker before sending a message"
         (denied-before-side-effect? "steer" #(cmd-tell-agent ["lane-probe" "message"])))
  (check "raw CLI retask denies a worker before either fact write"
         (denied-before-side-effect? "retask" #(cmd-retask ["lane-probe" "new goal"]))))

;; Exercise the real CLI exception boundary without risking any mutation: these
;; operations all have dry-run modes, and the authority error must win before
;; even their diagnostic command is rendered.
(doseq [[operation args] [["spawn" ["director" "probe" "--topology" "orchestrator" "--dry-run"]]
                          ["delegate" ["probe" "--dry-run"]]
                          ["steer" ["lane-probe" "message" "--dry-run"]]]]
  (let [result (apply proc/shell
                      {:out :string :err :string :continue true
                       :extra-env {"AGENT_TOPOLOGY" "worker" "NO_COLOR" "1"
                                   "NORTH_AGENTS_LIB" "0"}}
                      "bb" (str root "/cli/agents-cli.clj") operation args)]
    (check (str "CLI " operation " exits nonzero with a clean authority denial")
           (and (not (zero? (:exit result)))
                (str/includes? (:err result)
                               (str operation " requires orchestrator topology"))
                (not (str/includes? (:out result) "» "))))))

(doseq [[surface argv expected]
        [["listener reactor"
          ["bb" (str root "/cli/north-listen.clj") "59999" "probe" "--react"]
          "listen --react requires orchestrator topology"]
         ["fan-out map"
          ["bb" (str root "/cli/north-map.clj") "59999" "map" "verifier" "1" "probe"]
          "map requires orchestrator topology"]
         ["raw command producer"
          ["bb" (str root "/cli/msg-cli.clj") "59999" "send-cmd"
           "worker-probe" "director-probe" "spawn" "{:role verifier :prompt probe}"]
          "send-cmd requires orchestrator topology"]
         ["raw steer producer"
          ["bb" (str root "/cli/msg-cli.clj") "59999" "send"
           "worker-probe" "peer-probe" "steer" "change direction"]
          "steer requires orchestrator topology"]]]
  (let [result (apply proc/shell
                      {:out :string :err :string :continue true
                       :extra-env {"AGENT_TOPOLOGY" "worker" "NO_COLOR" "1"}}
                      argv)]
    (check (str surface " denies before subscription or batch writes")
           (and (not (zero? (:exit result)))
                (str/includes? (str (:out result) (:err result)) expected)))))

(doseq [[verb predicate] [["tell" "goal"] ["tell" "display_name"]
                          ["tell" "role"] ["tell" "holds"]
                          ["tell" "provider_target"] ["tell" "composition_contract_sha256"]
                          ["tell" "future_identity_axis"] ["tell" "supervisor"] ["tell" "lifecycle"]
                          ["retract" "composition_id"] ["untell" "outcome"]]]
  (let [result (proc/shell {:out :string :err :string :continue true
                            :extra-env {"AGENT_TOPOLOGY" "worker"
                                        "AGENT_ID" "worker-self"
                                        "FRAM_HOME" "/definitely/absent"}}
                           (str root "/bin/north") verb "agent:peer-agent" predicate "probe")]
    (check (str "generic " verb " denies peer agent authority predicate " predicate)
           (and (not (zero? (:exit result)))
                (str/includes? (:err result) "worker topology cannot mutate agent identity")
                (not (str/includes? (:err result) "subject resolver"))))))

(let [result (proc/shell {:out :string :err :string :continue true
                          :extra-env {"AGENT_TOPOLOGY" "worker"
                                      "AGENT_ID" "worker-self"
                                      "FRAM_HOME" "/definitely/absent"}}
                         (str root "/bin/north") "tell" "agent:worker-self" "provider" "self-publish")]
  (check "generic self identity mutation is denied before graph access"
         (and (not (zero? (:exit result)))
              (str/includes? (:err result) "worker topology cannot mutate agent identity")
              (not (str/includes? (:err result) "subject resolver")))))

(doseq [topology ["worker" "orchestrator"]]
  (let [result (proc/shell {:out :string :err :string :continue true
                            :extra-env {"AGENT_TOPOLOGY" topology
                                        "AGENT_ID" (str topology "-self")
                                        "FRAM_HOME" "/definitely/absent"}}
                           (str root "/bin/north") "tell"
                           "run-other-lane" "run_bar_evidence" "{}")]
    (check (str "generic run mutation is denied for managed " topology " topology")
           (and (not (zero? (:exit result)))
                (str/includes?
                 (:err result)
                 "generic fact verbs cannot mutate harness-owned run facts")
                (not (str/includes? (:err result) "subject resolver"))))))

(let [result (proc/shell {:out :string :err :string :continue true}
                         "env" "-u" "AGENT_TOPOLOGY" "-u" "AGENT_ID"
                         (str root "/bin/north") "tell"
                         "run-unset-env-bypass" "run_bar_evidence" "{}")]
  (check "unsetting managed identity cannot bypass harness-owned run facts"
         (and (not (zero? (:exit result)))
              (str/includes?
               (:err result)
               "generic fact verbs cannot mutate harness-owned run facts")
              (not (str/includes? (:err result) "subject resolver")))))

(let [scrubbed
      (north.managed-child-env/scrub
       {"AGENT_ID" "parent"
        "NORTH_RUN_ID" "run-parent"
        "NORTH_THREAD_ID" "thread-parent"
        "NORTH_RUN_CAPABILITY" "parent-secret"
        "AGENT_ROUTING_ASSESSMENT" "parent-assessment"
        "NORTH_ROUTING_PIN_EVIDENCE" "parent-pin"
        "UNRELATED" "preserved"})]
  (check "managed child scrub removes every inherited delivery capability binding"
         (and (= "preserved" (get scrubbed "UNRELATED"))
              (not-any? #(contains? scrubbed %)
                        ["NORTH_RUN_ID" "NORTH_THREAD_ID"
                         "NORTH_RUN_CAPABILITY" "AGENT_ROUTING_ASSESSMENT"
                         "NORTH_ROUTING_PIN_EVIDENCE"]))))

(let [result (proc/shell {:out :string :err :string :continue true
                          :extra-env {"AGENT_TOPOLOGY" "worker"
                                      "AGENT_ID" "worker-self"
                                      "NORTH_TRUSTED_HARNESS_WRITE" "1"
                                      "FRAM_HOME" "/definitely/absent"}}
                         (str root "/bin/north") "tell" "agent:worker-self" "provider" "trusted")]
  (check "legacy trusted-write environment cannot bypass the generic worker guard"
         (and (str/includes? (:err result) "worker topology cannot mutate agent identity")
              (not (str/includes? (:err result) "subject resolver unavailable")))))

(let [result (proc/shell {:out :string :err :string :continue true
                          :extra-env {"AGENT_TOPOLOGY" "worker"
                                      "AGENT_ID" "worker-self"
                                      "FRAM_HOME" "/definitely/absent"}}
                         (str root "/bin/north") "tell" "thread-probe" "goal" "ordinary-fact")]
  (check "ordinary thread fact writes pass the topology boundary"
         (and (not (str/includes? (:err result) "worker topology cannot mutate"))
              (str/includes? (:err result) "subject resolver unavailable"))))

(doseq [[verb args] [["identify" ["peer-agent" "opus" "high"]]
                     ["assign" ["peer-agent" "director"]]
                     ["unassign" ["peer-agent" "director"]]
                     ["watch" ["peer-agent" "@thread-probe"]]
                     ["unwatch" ["peer-agent" "@thread-probe"]]]]
  (let [result (apply proc/shell
                      {:out :string :err :string :continue true
                       :extra-env {"AGENT_TOPOLOGY" "worker" "AGENT_ID" "worker-self"}}
                      "bb" (str root "/cli/presence-cli.clj") "59999" verb args)]
    (check (str "presence " verb " denies peer assignment/control before graph access")
           (and (not (zero? (:exit result)))
                (str/includes? (str (:out result) (:err result))
                               "requires orchestrator topology")))))

(let [results @checks
      passed (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\ntopology authority: %d / %d PASS" passed (count results)))
  (System/exit (if (= passed (count results)) 0 1)))
