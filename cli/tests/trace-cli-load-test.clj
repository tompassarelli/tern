#!/usr/bin/env bb
(require '[babashka.process :as proc]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def trace-cli (str root "/cli/trace-cli.clj"))
(let [caller-file (System/getProperty "babashka.file")]
  (try
    (System/setProperty "north.trace.lib" "1")
    ;; trace-cli resolves its sibling sources from babashka.file when executed.
    ;; Preserve that execution context while loading its pure lifecycle helper.
    (System/setProperty "babashka.file" trace-cli)
    (load-file trace-cli)
    (finally
      (System/clearProperty "north.trace.lib")
      (if caller-file
        (System/setProperty "babashka.file" caller-file)
        (System/clearProperty "babashka.file")))))

(def checks (atom []))
(defn check [label ok?] (swap! checks conj [label (boolean ok?)]))

(def result
  (proc/shell {:out :string :err :string :continue true
               :extra-env {"NORTH_PORT" "59999"}}
              "bb" trace-cli "load-probe"))
(def output (str (:out result) (:err result)))
(def ok? (and (not (str/includes? output "Unable to resolve symbol"))
              (not (str/includes? output "EOF while reading"))
              (str/includes? output "coordinator :59999 unreachable")))

(check "trace CLI loads before its unavailable-coordinator boundary" ok?)
(when-not ok?
  (println output))
(check "identity rendering keeps model and effort as separate exact fields"
       (= "model=gpt-5.6-luna effort=low"
          (identity-route-detail {"model" "gpt-5.6-luna" "effort" "low"})))

(let [terminal {"outcome" "ran"
                "process_outcome" "ran"
                "delivery_outcome" "unverified"
                "delivery_reason" "provider_terminal_success_without_external_verification"}
      modern (assoc terminal "terminal_manifest_sha256"
                    (north.terminal-projection/terminal-manifest-sha256 terminal))
      partial (dissoc modern "terminal_manifest_sha256")
      folded (reduce-kv north.agent-provenance/fold-fact {} modern)
      conflict (north.agent-provenance/fold-fact folded "process_outcome" "died")
      corrupt-marker (north.agent-provenance/fold-fact
                      folded "terminal_manifest_sha256" "corrupt")
      blocked-terminal {"outcome" "blocked_preflight"
                        "process_outcome" "blocked_preflight"
                        "delivery_outcome" "blocked"
                        "delivery_reason" "execution_preflight_blocked"}
      blocked-modern
      (assoc blocked-terminal "terminal_manifest_sha256"
             (north.terminal-projection/terminal-manifest-sha256
              blocked-terminal))
      blocked-folded
      (reduce-kv north.agent-provenance/fold-fact {} blocked-modern)
      blocked-state (execution-terminal-state blocked-folded nil [])
      blocked-delivery (terminal-delivery-state blocked-folded blocked-state)
      blocked-verdict
      (trace-verdict
       {:id "blocked-agent" :on-roster true
        :terminal-state blocked-state :delivery-state blocked-delivery
        :online true :lease {:exp (+ NOW 60000)}
        :lineage :sdk-lane :identity-complete true :deaths []})
      run {:outcome "ran" :ms 0}
      death [{:reason "transport exited" :ms 0}]]
  (check "true legacy singleton outcome remains terminal"
         (= {:outcome "ran" :source :agent :terminal? true :kind :ran
             :death-notifications 0}
            (execution-terminal-state {"outcome" "ran"} nil [])))
  (check "valid modern terminal resolves from folded multi-cardinality rows"
         (= :ran (:kind (execution-terminal-state folded nil []))))
  (check "partial modern terminal blocks secondary run fallback"
         (not (:terminal? (execution-terminal-state partial run []))))
  (check "conflicting process values fail closed"
         (not (:terminal? (execution-terminal-state conflict run []))))
  (check "conflicting terminal markers fail closed"
         (not (:terminal? (execution-terminal-state corrupt-marker run []))))
  (check "committed run remains fallback only when the lane has no terminal body"
         (= {:outcome "ran" :source :run :terminal? true :kind :ran
             :death-notifications 0}
            (execution-terminal-state {} run [])))
  (check "blocked_preflight is a stopped terminal even with a live lease"
         (= {:outcome "blocked_preflight" :source :agent :terminal? true
             :kind :stopped :death-notifications 0}
            blocked-state))
  (check "completion rendering separates process from delivery"
         (= (str "process=blocked_preflight · delivery=blocked "
                 "(execution_preflight_blocked)")
            (terminal-summary blocked-state blocked-delivery)))
  (check "terminal blocked_preflight dominates live presence in the verdict"
         (and (str/includes? blocked-verdict
                             "terminal execution did not succeed")
              (str/includes? blocked-verdict "process=blocked_preflight")
              (str/includes? blocked-verdict "delivery=blocked")
              (not (str/includes? blocked-verdict "healthy —"))))
  (check "death notification alone is diagnostic and never terminal"
         (= {:outcome nil :source nil :terminal? false :kind nil
             :death-notifications 1}
            (execution-terminal-state {} nil death))))

(doseq [[label passed?] @checks]
  (println (format "  [%s] %s" (if passed? "PASS" "FAIL") label)))
(let [passed (count (filter second @checks))]
  (println (format "\ntrace CLI lifecycle: %d / %d PASS" passed (count @checks)))
  (System/exit (if (= passed (count @checks)) 0 1)))
