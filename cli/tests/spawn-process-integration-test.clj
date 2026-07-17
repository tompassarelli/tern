#!/usr/bin/env bb
(require '[babashka.process :as p]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(load-file (str root "/cli/spawn-process.clj"))

(def checks (atom []))
(defn check [label ok?] (swap! checks conj [label (boolean ok?)]))
(defn eventually [pred timeout-ms]
  (let [deadline (+ (System/currentTimeMillis) timeout-ms)]
    (loop []
      (cond (pred) true
            (>= (System/currentTimeMillis) deadline) false
            :else (do (Thread/sleep 20) (recur))))))

(def temp-dir (.toFile (java.nio.file.Files/createTempDirectory "north-spawn-process-" (make-array java.nio.file.attribute.FileAttribute 0))))
(defn temp-file [name] (io/file temp-dir name))
(def base-env (into {} (System/getenv)))

(def ready-base
  {"kind" "lane"
   "role" "verifier"
   "goal" "verify startup identity"
   "provider" "openai"
   "provider_target" "codex-personal"
   "model" "gpt-5.6-sol"
   "effort" "high"
   "composition_kind" "preset"
   "composition_id" "verifier"
   "composition_overrides" "[]"
   "repo" "north"
   "spawned_at" "2026-07-17T00:00:00Z"
   "display_handle" "openai-sol-high-verifier-probe"
   "display_name" "openai:codex-personal · sol · high · gaffer:verifier · verify startup identity"})
(defn committed [facts]
  (assoc facts "identity_manifest_sha256"
         (north.agent-provenance/manifest-sha256 facts)))
(defn fold-observed [facts]
  (reduce-kv north.agent-provenance/fold-fact {} facts))
(def ready-facts (committed ready-base))

(try
  (let [uuid (java.util.UUID/fromString "123e4567-e89b-42d3-a456-426614174000")
        id (north.spawn-process/create-agent-id "lane" 1720000000000 uuid)
        ids (repeatedly 200 #(north.spawn-process/create-agent-id "lane"))]
    (check "managed lane id carries base36 time and the complete RFC 4122 UUID"
           (re-matches #"^lane-[0-9a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" id))
    (check "managed lane ids do not truncate their collision domain"
           (= (count ids) (count (set ids)))))

  (check "startup identity requires every route and lifecycle axis"
         (and (north.spawn-process/identity-ready? ready-facts)
              (not (north.spawn-process/identity-ready? (dissoc ready-facts "provider_target")))
              (not (north.spawn-process/identity-ready? (assoc ready-facts "kind" "session")))
              (not (north.spawn-process/identity-ready? (dissoc ready-facts "role")))
              (not (north.spawn-process/identity-ready? (dissoc ready-facts "goal")))
              (not (north.spawn-process/identity-ready? (dissoc ready-facts "composition_id")))
              (not (north.spawn-process/identity-ready? (assoc ready-facts "composition_kind" "invalid")))
              (not (north.spawn-process/identity-ready? (assoc ready-facts "composition_id" "designer")))))

  (check "managed startup defects name invalid Gaffer provenance"
         (= ["composition_kind(preset|bespoke)"]
            (north.spawn-process/identity-defects
             (committed (assoc ready-base "composition_kind" "invalid")))))

  (let [log (temp-file "ready.log")
        process (north.spawn-process/launch-detached! ["sleep" "10"] base-env log)
        startup (north.spawn-process/await-startup
                 process "lane-ready" log (constantly ready-facts) (constantly true)
                 :timeout-ms 1000 :poll-ms 10)]
    (check "live acknowledgement requires structured identity plus online presence"
           (and (= :ready (:status startup))
                (= "openai-sol-high-verifier-probe" (:handle startup))
                (p/alive? process)))
    (north.spawn-process/stop-process! process))

  (let [log (temp-file "completed.log")
        process (north.spawn-process/launch-detached! ["bash" "-c" "exit 0"] base-env log)
        startup (north.spawn-process/await-startup
                 process "lane-completed" log
                 (constantly (assoc ready-facts "outcome" "ran")) (constantly false)
                 :timeout-ms 1000 :poll-ms 10)]
    (check "fast terminal outcome is reported as completed, never falsely running"
           (and (= :completed (:status startup)) (= "ran" (:outcome startup)))))

  (let [log (temp-file "exit-race.log")
        process (north.spawn-process/launch-detached! ["bash" "-c" "exit 0"] base-env log)
        _ @process
        probes (atom 0)
        startup (north.spawn-process/await-startup
                 process "lane-exit-race" log
                 (fn [_]
                   (if (= 1 (swap! probes inc))
                     ready-facts
                     (assoc ready-facts "outcome" "ran")))
                 (constantly false)
                 :timeout-ms 1000 :poll-ms 10 :exit-grace-ms 100)]
    (check "final fact read closes the synchronous-outcome versus process-exit race"
           (and (= :completed (:status startup))
                (= "ran" (:outcome startup))
                (>= @probes 2))))

  (let [log (temp-file "terminal-publication-race.log")
        process (north.spawn-process/launch-detached! ["sleep" "10"] base-env log)
        probes (atom 0)
        partial (assoc ready-facts
                       "process_outcome" "ran"
                       "delivery_outcome" "unverified"
                       "delivery_reason" "provider_terminal_success_without_external_verification"
                       "outcome" "ran")
        complete (assoc partial "terminal_manifest_sha256"
                        (north.terminal-projection/terminal-manifest-sha256 partial))
        startup (north.spawn-process/await-startup
                 process "lane-terminal-publication-race" log
                 (fn [_] (if (< (swap! probes inc) 4) partial complete))
                 (constantly false)
                 :timeout-ms 1000 :poll-ms 10)]
    (check "partial new terminal publication cannot win the startup race"
           (and (= :completed (:status startup))
                (= "ran" (:outcome startup))
                (>= @probes 4)))
    (north.spawn-process/stop-process! process))

  (let [log (temp-file "partial-terminal-exit.log")
        process (north.spawn-process/launch-detached! ["bash" "-c" "exit 0"] base-env log)
        _ @process
        partial (assoc ready-facts "process_outcome" "ran" "outcome" "ran")
        startup (north.spawn-process/await-startup
                 process "lane-partial-terminal-exit" log
                 (constantly partial) (constantly false)
                 :timeout-ms 1000 :poll-ms 10 :exit-grace-ms 50)]
    (check "process_outcome plus legacy alias without terminal marker stays partial"
           (= :failed (:status startup))))

  (let [log (temp-file "conflicting-terminal-exit.log")
        terminal {"outcome" "ran"
                  "process_outcome" "ran"
                  "delivery_outcome" "unverified"
                  "delivery_reason" "provider_terminal_success_without_external_verification"}
        complete (merge ready-facts terminal
                        {"terminal_manifest_sha256"
                         (north.terminal-projection/terminal-manifest-sha256 terminal)})
        conflicted (north.agent-provenance/fold-fact
                    (fold-observed complete) "process_outcome" "died")
        process (north.spawn-process/launch-detached! ["bash" "-c" "exit 0"] base-env log)
        _ @process
        startup (north.spawn-process/await-startup
                 process "lane-conflicting-terminal-exit" log
                 (constantly conflicted) (constantly false)
                 :timeout-ms 1000 :poll-ms 10 :exit-grace-ms 50)]
    (check "conflicting multi-valued terminal cannot acknowledge a completed startup"
           (= :failed (:status startup))))

  (let [log (temp-file "failed.log")
        process (north.spawn-process/launch-detached!
                 ["bash" "-c" "printf 'provider construction failed\\n' >&2; exit 23"] base-env log)
        startup (north.spawn-process/await-startup
                 process "lane-failed" log (constantly {}) (constantly false)
                 :timeout-ms 2000 :poll-ms 10)
        message (north.spawn-process/failure-message startup)]
    (check "pre-identity child exit is synchronous and preserves its real status"
           (and (= :failed (:status startup)) (= 23 (:exit startup))))
    (check "failed startup never fabricates a semantic handle"
           (and (nil? (:handle startup))
                (str/includes? message "missing identity")
                (not (str/includes? message "unknown-unknown"))))
    (check "early failure points to durable evidence and includes bounded log context"
           (and (str/includes? message (str log))
                (str/includes? message "provider construction failed"))))

  (let [log (temp-file "timeout.log")
        process (north.spawn-process/launch-detached! ["sleep" "10"] base-env log)
        startup (north.spawn-process/await-startup
                 process "lane-timeout" log (constantly {}) (constantly false)
                 :timeout-ms 100 :poll-ms 10)]
    (check "missing acknowledgement times out and tears down the detached process tree"
           (and (= :timeout (:status startup))
                (eventually #(not (p/alive? process)) 2000))))

  ;; True lifetime boundary: a short-lived launcher starts a detached child and
  ;; exits. The child must still run to completion after its Babashka parent is
  ;; gone; this is the exact failure shape of `north spawn` returning to a shell.
  (let [marker (temp-file "survived")
        log (temp-file "survival.log")
        child-expr "(Thread/sleep 250) (spit (System/getenv \"NORTH_DETACH_MARKER\") \"survived\")"
        launcher-expr
        (str "(load-file " (pr-str (str root "/cli/spawn-process.clj")) ") "
             "(north.spawn-process/launch-detached! "
             (pr-str ["bb" "-e" child-expr]) " "
             (pr-str {"NORTH_DETACH_MARKER" (str marker)}) " "
             (pr-str (str log)) ")")
        launcher (p/shell {:out :string :err :string :continue true} "bb" "-e" launcher-expr)]
    (check "launcher itself exits cleanly without waiting for the managed child"
           (zero? (:exit launcher)))
    (check "detached lane survives invoking CLI process exit"
           (and (eventually #(.isFile marker) 3000)
                (= "survived" (slurp marker)))))

  (finally
    (north.spawn-process/stop-process!
     ;; stop-process! is intentionally tolerant; exercise the no-op boundary.
     nil)
    (doseq [file (reverse (file-seq temp-dir))] (io/delete-file file true))))

(let [results @checks pass (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\nspawn process integration: %d / %d PASS" pass (count results)))
  (System/exit (if (= pass (count results)) 0 1)))
