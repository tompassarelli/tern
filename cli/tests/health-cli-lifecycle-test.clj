#!/usr/bin/env bb
(require '[clojure.java.io :as io])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def health-cli (str root "/cli/health-cli.clj"))
(let [caller-file (System/getProperty "babashka.file")]
  (try
    (System/setProperty "north.health.lib" "1")
    (System/setProperty "babashka.file" health-cli)
    (load-file health-cli)
    (finally
      (System/clearProperty "north.health.lib")
      (if caller-file
        (System/setProperty "babashka.file" caller-file)
        (System/clearProperty "babashka.file")))))

(def terminal
  {"outcome" #{"ran"}
   "process_outcome" #{"ran"}
   "delivery_outcome" #{"unverified"}
   "delivery_reason" #{"provider_terminal_success_without_external_verification"}})
(def modern-terminal
  (assoc terminal "terminal_manifest_sha256"
         #{(north.terminal-projection/terminal-manifest-sha256 terminal)}))
(def committed-run
  {"kind" #{"run"} "agent" #{"sdk-health"} "outcome" #{"ran"} "at" #{"2026-07-17T00:00:00Z"}})
(def concern-now 2000000)
(def concern-facts
  {"@concern-stale"
   {"kind" #{"concern"} "agent" #{"@stale"} "reached" #{"building"}}
   "@concern-handoff"
   {"kind" #{"concern"} "agent" #{"@handoff"} "reached" #{"likely-to-land"}}
   "@concern-retired"
   {"kind" #{"concern"} "agent" #{"@retired"}
    "reached" #{"building" "abandoned-stale"}}
   "@concern-landed"
   {"kind" #{"concern"} "agent" #{"@landed"} "reached" #{"building" "landed"}}
   "@concern-online"
   {"kind" #{"concern"} "agent" #{"@online"} "reached" #{"building"}}
   "@concern-agentless"
   {"kind" #{"concern"} "reached" #{"building"}}
   "@lease:session:online"
   {"lease" #{(str "online|" (inc concern-now) "|1")}}})

(def checks
  [["committed legacy run remains visible"
    (= ["@run-legacy" "sdk-health" "ran" "2026-07-17T00:00:00Z"]
       (run-row-from-facts "@run-legacy" committed-run))]
   ["run without kind=run commit marker is invisible"
    (nil? (run-row-from-facts "@run-partial" (dissoc committed-run "kind")))]
   ["conflicting run outcomes fail closed"
    (nil? (run-row-from-facts
           "@run-conflict" (assoc committed-run "outcome" #{"ran" "died"})))]
   ["valid modern lane terminal remains visible"
    (= ["@agent:sdk-health" "ran"]
       (lane-outcome-from-facts
        "@agent:sdk-health" (assoc modern-terminal "kind" #{"lane"})))]
   ["torn modern lane terminal is invisible"
    (nil? (lane-outcome-from-facts
           "@agent:sdk-health" (assoc terminal "kind" #{"lane"})))]
   ["conflicting modern lane terminal is invisible"
    (nil? (lane-outcome-from-facts
           "@agent:sdk-health"
           (-> modern-terminal
               (assoc "kind" #{"lane"})
               (assoc "process_outcome" #{"ran" "died"}))))]
   ["true legacy singleton lane outcome remains visible"
    (= ["@agent:legacy" "died-unreported"]
       (lane-outcome-from-facts
        "@agent:legacy" {"kind" #{"lane"} "outcome" #{"died-unreported"}}))]
   ["predicate batches preserve genuine live conflicts"
    (= {"@agent:conflict" {"outcome" #{"ran" "died"}}}
       (add-predicate-rows
        {} "outcome"
        [["@agent:conflict" "ran"] ["@agent:conflict" "died"]
         ["@agent:conflict" "ran"]]))]
   ["concern summary preserves stale, handoff, retired, landed, and live semantics"
    (= {:active 4 :stale 1 :handoff 1 :retired 1}
       (concern-counts concern-facts concern-now))]])

(doseq [[label passed?] checks]
  (println (format "  [%s] %s" (if passed? "PASS" "FAIL") label)))
(let [passed (count (filter second checks))]
  (println (format "\nhealth lifecycle: %d / %d PASS" passed (count checks)))
  (System/exit (if (= passed (count checks)) 0 1)))
