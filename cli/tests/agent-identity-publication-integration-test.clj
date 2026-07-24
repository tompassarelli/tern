#!/usr/bin/env bb
;; Exact managed-identity publication against a throwaway Fram coordinator.
(require '[babashka.process :as proc]
         '[cheshire.core :as json]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram
  (.getCanonicalPath
   (io/file (or (System/getenv "FRAM_PATH") (str root "/../fram")))))
(def writer (str root "/cli/agent-fact-internal.clj"))
(def test-terminal-publication-order
  ["process_outcome" "delivery_evidence" "delivery_evidence_sha256"
   "delivery_attestation" "delivery_attestation_sha256"
   "delivery_outcome" "delivery_reason" "outcome"])
(def test-route-generation-predicates
  #{"provider" "provider_target" "live_input" "live_input_state"
    "live_input_epoch" "model" "effort" "display_handle"})
(load-file (str root "/cli/coord.clj"))
(load-file (str root "/cli/agent-provenance.clj"))
(load-file (str root "/cli/terminal-projection.clj"))

(def checks (atom []))
(def test-log (atom nil))
(defn check [label ok?] (swap! checks conj [label (boolean ok?)]))
(defn free-port [] (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))
(defn port-open? [port]
  (try (with-open [socket (java.net.Socket.)]
         (.connect socket (java.net.InetSocketAddress. "127.0.0.1" (int port)) 100) true)
       (catch Exception _ false)))
(defn eventually [predicate]
  (loop [n 0]
    (cond (predicate) true (>= n 200) false
          :else (do (Thread/sleep 25) (recur (inc n))))))
(defn run-writer
  ([port operation subject value]
   (run-writer port operation subject value {}))
  ([port operation subject value extra-env]
   (let [result (proc/shell {:out :string :err :string :continue true
                             :extra-env (assoc extra-env
                                               "FRAM_LOG" @test-log)}
                            "bb" writer (str port) operation subject value)]
     {:exit (:exit result) :out (:out result) :err (:err result)})))
(defn run-managed-writer
  ([port operation subject value holder operation-id desired expected]
   (run-managed-writer
    port operation subject value holder operation-id desired expected ""))
  ([port operation subject value holder operation-id desired expected terminal-thread]
   (let [result
         (proc/shell
          {:out :string :err :string :continue true
           :extra-env {"FRAM_LOG" @test-log}}
          "bb" writer (str port) operation subject value holder operation-id
          (if desired (json/generate-string desired) "")
          (if expected (json/generate-string expected) "")
          terminal-thread)]
     {:exit (:exit result)
      :out (:out result)
      :err (:err result)
      :result
      (try
        (:result (json/parse-string
                  (or (last (str/split-lines (:out result))) "") true))
        (catch Throwable _ nil))})))
(defn entity-facts [port subject]
  (let [rows (:ok (north.coord/send-op
                   port {:op :query
                         :query {:find "identity_test"
                                 :rules [{:head {:rel "identity_test"
                                                 :args [{:var "p"} {:var "r"}]}
                                          :body [{:rel "triple"
                                                  :args [subject {:var "p"} {:var "r"}]}]}]}}))]
    (reduce (fn [acc [predicate value]] (update acc predicate (fnil conj #{}) value)) {} rows)))
(defn scalar-facts [facts]
  (into {} (keep (fn [[predicate values]]
                   (when (= 1 (count values)) [predicate (first values)]))) facts))
(defn reserve-run!
  [port run reporter thread capability-digest & [baseline]]
  (let [baseline (or baseline ["tests pass"])
        projection
        (sorted-map
         "run_capability_sha256" capability-digest
         "run_reservation_agent" reporter
         "run_reservation_contract_origin"
         (if (seq baseline) "accepted" "worker-defined")
         "run_reservation_done_when" (json/generate-string baseline)
         "run_reservation_thread" thread
         "run_reservation_version" north.terminal-projection/run-reservation-version
         "run_reserved_at" "2026-07-18T09:59:00Z")
        marker
        (north.terminal-projection/run-reservation-manifest-sha256 projection)]
    (doseq [[predicate value] projection]
      (north.coord/append! port run predicate value))
    (north.coord/append! port run "run_reservation_manifest_sha256" marker)))
(defn log-ops [file]
  (with-open [reader (io/reader file)]
    (mapv edn/read-string (line-seq reader))))

(defn identity-write-resource [subject]
  (str "managed-agent-write:"
       (north.terminal-projection/sha256 subject)))

(defn release-lease! [port {:keys [resource holder epoch]}]
  (north.coord/send-op port {:op :release-lease
                             :res resource :holder holder :epoch epoch}))

(defn fault-proxy
  "A test-local EDN proxy. Exactly one matching request is rejected without
  reaching the coordinator; every later request, including rollback, is
  forwarded under the writer's still-current fence."
  ([target-port inject?]
   (fault-proxy target-port inject? (constantly {:reject :test-injected}) {}))
  ([target-port inject? injected-response]
   (fault-proxy target-port inject? injected-response {}))
  ([target-port inject? injected-response
    {:keys [drop-fence-after-injection? max-injections]
     :or {max-injections 1}}]
   (let [server (java.net.ServerSocket.
                 0 50 (java.net.InetAddress/getByName "127.0.0.1"))
         requests (atom [])
         envelopes (atom [])
         injected? (atom false)
         injections (atom 0)
         closed? (atom false)
         worker
         (future
           (try
             (while (not @closed?)
               (with-open [client (.accept server)
                           reader (io/reader (.getInputStream client))
                           writer (io/writer (.getOutputStream client))]
                 (let [envelope (edn/read-string (.readLine reader))
                       request (:request envelope)
                       _ (swap! envelopes conj envelope)
                       _ (swap! requests conj request)
                       valid-envelope?
                       (= {:op :for-log
                           :expected-log @test-log}
                          (select-keys envelope [:op :expected-log]))
                       inject-now?
                       (and valid-envelope?
                            (inject? request)
                            (< @injections max-injections)
                            (do (swap! injections inc)
                                (reset! injected? true)
                                true))
                       drop-response?
                       (and drop-fence-after-injection?
                            @injected?
                            (= :fence-ok (:op request)))
                       response
                       (when-not drop-response?
                         (if-not valid-envelope?
                           {:reject :invalid-test-log-fence}
                           (if inject-now?
                           (injected-response request)
                           (north.coord/send-op target-port request))))]
                   (when-not drop-response?
                     (.write writer (str (pr-str response) "\n"))
                     (.flush writer)))))
             (catch java.net.SocketException error
               (when-not @closed? (throw error)))))]
     {:port (.getLocalPort server)
     :requests requests
      :envelopes envelopes
      :injected? injected?
      :injections injections
      :close!
      (fn []
        (reset! closed? true)
        (.close server)
        (try (deref worker 2000 nil) (catch Throwable _ nil)))})))

(def fenced-ops
  #{:assert-with-fence :retract-with-fence
    :assert-at-version-with-fence})

(defn require-write-ok! [result operation]
  (when (:reject result)
    (throw (ex-info "test fenced write rejected"
                    {:operation operation :result result})))
  result)

(defn replace-under-fence! [port lease subject identity]
  (doseq [[predicate values] (entity-facts port subject)
          value values]
    (require-write-ok!
     (north.coord/retract-with-fence!
      port lease subject predicate value)
     [:retract predicate value]))
  (doseq [[predicate value] identity]
    (require-write-ok!
     (north.coord/put-with-fence!
      port lease subject predicate value)
     [:put predicate value]))
  (let [marker (north.agent-provenance/manifest-sha256 identity)]
    (require-write-ok!
     (north.coord/put-with-fence!
      port lease subject "identity_manifest_sha256" marker)
     [:put "identity_manifest_sha256" marker])))

(defn seed-identity! [port subject identity]
  (doseq [[predicate value] identity]
    (north.coord/append! port subject predicate value))
  (north.coord/append!
   port subject "identity_manifest_sha256"
   (north.agent-provenance/manifest-sha256 identity)))

(defn apply-prefix! [port subject operations count]
  (doseq [[operation predicate value] (take count operations)]
    (case operation
      :put (north.coord/append! port subject predicate value)
      :retract (north.coord/retract! port subject predicate value))))

(defn apply-terminal-lifecycle-prefix!
  [port subject thread terminal operations prefix-count]
  (let [agent-id (subs subject (count "@agent:"))
        driver (str "@" agent-id)]
    (doseq [[operation predicate value] (take prefix-count operations)]
      (case operation
        :put (north.coord/append! port subject predicate value)
        :release-presence
        (north.coord/send-op
         port {:op :release-lease :res (str "session:" agent-id)
               :holder agent-id})
        :release-driver
        (north.coord/retract! port thread "driver" driver)
        :marker
        (north.coord/append!
         port subject "terminal_manifest_sha256"
         (north.terminal-projection/terminal-manifest-sha256 terminal))))))

(let [port (free-port)
      tmp (.toFile (java.nio.file.Files/createTempDirectory
                    "north-identity-publication" (make-array java.nio.file.attribute.FileAttribute 0)))
      log (io/file tmp "facts.log")
      daemon (do
               (spit log "")
               (proc/process {:dir fram :out :string :err :string
                              :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"}}
                             "bb" "-cp" "out" "coord_daemon.clj"
                             "serve-flat" (str port) (.getPath log)))
      subject "@agent:identity-publication-probe"
      preset {"kind" "lane" "role" "integrator" "model" "claude-opus-4-8"
              "provider" "anthropic" "provider_target" "claude-a" "effort" "high"
              "live_input" "streaming" "live_input_state" "armed"
              "live_input_epoch" "00000000-0000-4000-8000-000000000101"
              "composition_kind" "preset" "composition_id" "integrator"
              "composition_overrides" "[\"tier\"]"
              "composition_override_reason" "critical seam" "repo" "north"
              "goal" "prove atomic publication" "spawned_at" "2026-07-17T01:00:00Z"
              "display_handle" "anthropic-a-opus-high-gaffer-integrator-probe"
              "display_name" "anthropic:claude-a · opus · high · gaffer:integrator"}
      bespoke {"kind" "lane" "role" "migration-forensics" "model" "gpt-5.6-sol"
               "provider" "openai" "provider_target" "codex-b" "effort" "xhigh"
               "live_input" "unsupported" "live_input_state" "frozen"
               "live_input_epoch" "00000000-0000-4000-8000-000000000102"
               "composition_kind" "bespoke" "composition_id" "migration-forensics"
               "nearest_preset" "analyst" "bespoke_reason" "cross-schema archaeology"
               "promotion_candidate" "false"
               "composition_contract_sha256" (apply str (repeat 64 "a"))
               "composition_contract_fingerprint_version" "v1"
               "composition_contract_fingerprint_domain" "north:bespoke-contract:v1"
               "repo" "north" "goal" "prove clean sequential reuse"
               "spawned_at" "2026-07-17T01:01:00Z"
               "display_handle" "openai-b-sol-xhigh-gaffer-bespoke-probe"
               "display_name" "openai:codex-b · sol · xhigh · gaffer:bespoke:migration-forensics"}]
  (reset! test-log (.getCanonicalPath log))
  (alter-var-root #'north.coord/expected-log
                  (constantly (fn [] @test-log)))
  (try
    (check "throwaway coordinator starts" (eventually #(port-open? port)))
    (let [first-result (run-writer port "publish" subject (json/generate-string preset))
          stored (scalar-facts (entity-facts port subject))]
      (check "preset publication returns a synchronous acknowledgement" (zero? (:exit first-result)))
      (check "commit marker matches the exact current canonical projection"
             (= (north.agent-provenance/manifest-sha256 stored)
                (get stored "identity_manifest_sha256"))))

    ;; Writable lanes provision an isolated worktree and publish its abspath +
    ;; branch alongside the base identity. Regression: validate-publish! once
    ;; rejected both with "unsupported managed identity predicate", so no
    ;; worktree-allocated lane could reach startup acknowledgement.
    (let [writable-subject "@agent:identity-publication-writable"
          writable (assoc preset
                          "worktree" "/home/tom/code/worktrees/north/lane-probe"
                          "branch" "agent/lane-probe")
          result (run-writer port "publish" writable-subject
                             (json/generate-string writable))
          raw-stored (entity-facts port writable-subject)
          stored (scalar-facts raw-stored)]
      (check "writable identity carrying worktree+branch publishes"
             (zero? (:exit result)))
      (check "writable identity stores exactly one worktree and one branch value"
             (and (= #{"/home/tom/code/worktrees/north/lane-probe"}
                     (get raw-stored "worktree"))
                  (= #{"agent/lane-probe"} (get raw-stored "branch"))))
      (check "identity marker binds worktree+branch across writer and reader"
             (and (= "/home/tom/code/worktrees/north/lane-probe"
                     (get stored "worktree"))
                  (= "agent/lane-probe" (get stored "branch"))
                  (= (north.agent-provenance/manifest-sha256 stored)
                     (get stored "identity_manifest_sha256")))))

    ;; Bounded auto-retry: a fresh identity carrying retry_of_agent (bare prior
    ;; agent id) must publish exactly like any other optional identity fact
    ;; (worktree/branch above). Regression: identity-predicates once omitted
    ;; retry_of_agent, so validate-publish! rejected the SDK's own emitted
    ;; retry_of_agent as an unsupported managed identity predicate.
    (let [retry-subject "@agent:identity-publication-retry-lane"
          retry-identity (assoc preset "retry_of_agent" "identity-publication-dead-lane")
          result (run-writer port "publish" retry-subject
                             (json/generate-string retry-identity))
          raw-stored (entity-facts port retry-subject)
          stored (scalar-facts raw-stored)]
      (check "retry lane carrying retry_of_agent publishes"
             (zero? (:exit result)))
      (check "retry lane stores exactly one retry_of_agent value"
             (= #{"identity-publication-dead-lane"} (get raw-stored "retry_of_agent")))
      (check "identity marker binds retry_of_agent across writer and reader"
             (and (= "identity-publication-dead-lane" (get stored "retry_of_agent"))
                  (north.agent-provenance/managed-valid? stored)
                  (= (north.agent-provenance/manifest-sha256 stored)
                     (get stored "identity_manifest_sha256")))))

    ;; A normal first attempt (no retry_of_agent at all) remains valid: the
    ;; predicate stays optional, never required-identity-predicates.
    (let [first-attempt-subject "@agent:identity-publication-first-attempt"
          result (run-writer port "publish" first-attempt-subject
                             (json/generate-string preset))
          raw-stored (entity-facts port first-attempt-subject)
          stored (scalar-facts raw-stored)]
      (check "first-attempt identity without retry_of_agent publishes"
             (zero? (:exit result)))
      (check "first-attempt identity carries no retry_of_agent and stays valid"
             (and (nil? (get raw-stored "retry_of_agent"))
                  (north.agent-provenance/managed-valid? stored)
                  (= (north.agent-provenance/manifest-sha256 stored)
                     (get stored "identity_manifest_sha256")))))

    ;; Fail-closed is preserved: only the registered vocabulary is accepted.
    (let [bogus-subject "@agent:identity-publication-bogus-predicate"
          bogus (assoc preset "totally_unregistered_pred" "x")
          rejected (run-writer port "publish" bogus-subject
                               (json/generate-string bogus))]
      (check "unregistered identity predicate is still rejected before mutation"
             (and (not (zero? (:exit rejected)))
                  (str/includes? (:err rejected)
                                 "unsupported managed identity predicate")
                  (empty? (entity-facts port bogus-subject)))))

    (let [terminal {"outcome" "ran" "process_outcome" "ran"
                    "delivery_outcome" "unverified"
                    "delivery_reason" "provider_terminal_success_without_external_verification"}
          terminal-result (run-writer port "terminal" subject (json/generate-string terminal))
          stored (scalar-facts (entity-facts port subject))]
      (check "terminal process and delivery axes publish together"
             (and (zero? (:exit terminal-result))
                  (= "ran" (get stored "process_outcome"))
                  (= "unverified" (get stored "delivery_outcome"))
                  (= "ran"
                     (north.terminal-projection/terminal-process-outcome stored)))))

    (let [recovery-subject "@agent:identity-publication-crash-retry"]
      (doseq [[predicate value] preset]
        (north.coord/append! port recovery-subject predicate value))
      (let [before (entity-facts port recovery-subject)
            recovered
            (run-writer port "publish" recovery-subject
                        (json/generate-string preset))
            after (entity-facts port recovery-subject)
            stored (scalar-facts after)]
        (check "byte-identical markerless publication retries by committing its marker"
               (and (nil? (get before "identity_manifest_sha256"))
                    (zero? (:exit recovered))
                    (= (dissoc before "identity_manifest_sha256")
                       (dissoc after "identity_manifest_sha256"))
                    (= (get stored "identity_manifest_sha256")
                       (north.agent-provenance/manifest-sha256 stored))))))

    (let [mismatch-subject "@agent:identity-publication-mismatched-retry"
          mismatched (assoc preset "goal" "different crashed body")]
      (doseq [[predicate value] mismatched]
        (north.coord/append! port mismatch-subject predicate value))
      (let [before (entity-facts port mismatch-subject)
            rejected
            (run-writer port "publish" mismatch-subject
                        (json/generate-string preset))]
        (check "mismatched markerless body is rejected without mutation"
               (and (not (zero? (:exit rejected)))
                    (= before (entity-facts port mismatch-subject))
                    (nil? (get before "identity_manifest_sha256"))))))

    (let [before-op-count (count (log-ops log))
          second-result (run-writer port "publish" subject (json/generate-string bespoke))
          generation-ops (->> (log-ops log)
                              (drop before-op-count)
                              (filter #(= subject (:l %)))
                              vec)
          raw-stored (entity-facts port subject)
          stored (scalar-facts raw-stored)]
      (check "sequential reuse publishes the second shape" (zero? (:exit second-result)))
      (check "identity reuse withdraws identity and terminal markers before any body mutation"
             (= [["retract" "identity_manifest_sha256"]
                 ["retract" "terminal_manifest_sha256"]]
                (mapv (juxt :op :p) (take 2 generation-ops))))
      (check "identity reuse withdraws the legacy outcome before process_outcome"
             (= [["retract" "outcome"] ["retract" "process_outcome"]]
                (mapv (juxt :op :p) (take 2 (drop 2 generation-ops)))))
      (check "sequential reuse removes every stale optional preset field and outcome"
             (and (nil? (get raw-stored "composition_overrides"))
                  (nil? (get raw-stored "composition_override_reason"))
                  (nil? (get raw-stored "outcome"))
                  (nil? (get raw-stored "process_outcome"))
                  (nil? (get raw-stored "delivery_outcome"))
                  (nil? (get raw-stored "terminal_manifest_sha256"))
                  (= #{"analyst"} (get raw-stored "nearest_preset"))))
      (check "every managed identity predicate has exactly one live value"
             (every? #(= 1 (count %))
                     (vals (select-keys raw-stored north.agent-provenance/identity-predicates))))
      (check "bespoke generation is committed and canonical"
             (and (north.agent-provenance/managed-valid? stored)
                  (= (north.agent-provenance/manifest-sha256 stored)
                     (get stored "identity_manifest_sha256")))))

    (let [route {"provider" "anthropic" "provider_target" "claude-c"
                 "live_input" "streaming" "live_input_state" "armed"
                 "live_input_epoch" "00000000-0000-4000-8000-000000000103"
                 "model" "claude-opus-4-8" "effort" "high"
                 "display_handle" "anthropic-c-opus-high-gaffer-bespoke-probe"
                 "display_name" "anthropic:claude-c · opus · high · gaffer:bespoke:migration-forensics"}
          route-result (run-writer port "route" subject (json/generate-string route))
          raw-stored (entity-facts port subject)
          stored (scalar-facts raw-stored)]
      (check "fallback route update is acknowledged" (zero? (:exit route-result)))
      (check "route update retracts every previous multi-cardinality route value"
             (and (= #{"anthropic"} (get raw-stored "provider"))
                  (= #{"claude-c"} (get raw-stored "provider_target"))
                  (= #{"claude-opus-4-8"} (get raw-stored "model"))))
      (check "route update recommits the full current projection"
             (= (north.agent-provenance/manifest-sha256 stored)
                (get stored "identity_manifest_sha256"))))

    (let [retask {"goal" "new durable goal"
                  "display_name" "anthropic:claude-c · opus · high · gaffer:bespoke:migration-forensics · new durable goal"}
          retask-result (run-writer port "retask" subject (json/generate-string retask))
          raw-stored (entity-facts port subject)
          stored (scalar-facts raw-stored)]
      (check "typed retask is acknowledged" (zero? (:exit retask-result)))
      (check "typed retask leaves exactly one goal and one display cache"
             (and (= #{"new durable goal"} (get raw-stored "goal"))
                  (= #{(get retask "display_name")} (get raw-stored "display_name"))))
      (check "typed retask recommits a startup-valid identity"
             (and (north.agent-provenance/managed-valid? stored)
                  (= (north.agent-provenance/manifest-sha256 stored)
                     (get stored "identity_manifest_sha256")))))

    (let [before (entity-facts port subject)
          invalid (assoc bespoke "composition_contract_sha256" "not-a-hash")
          rejected (run-writer port "publish" subject (json/generate-string invalid))]
      (check "invalid identity is rejected before mutating the committed generation"
             (and (not (zero? (:exit rejected)))
                  (= before (entity-facts port subject)))))

    (let [before (entity-facts port subject)
          ambiguous (assoc bespoke "goal" " boundary whitespace ")
          rejected (run-writer port "publish"
                               subject (json/generate-string ambiguous))]
      (check "writer rejects reader-normalized boundary whitespace before mutation"
             (and (not (zero? (:exit rejected)))
                  (= before (entity-facts port subject)))))

    (let [policy-subject "@agent:identity-invalid-lease-policy"
          rejected
          (run-writer
           port "publish" policy-subject (json/generate-string preset)
           {"NORTH_IDENTITY_WRITER_TIMEOUT_MS" "10000"
            "NORTH_IDENTITY_WRITE_LEASE_TTL_MS" "10000"})]
      (check "write lease must outlive the process timeout before mutation"
             (and (not (zero? (:exit rejected)))
                  (empty? (entity-facts port policy-subject)))))

    (let [held-subject "@agent:identity-held-publish"
          winner (assoc preset
                        "goal" "winner remains authoritative"
                        "display_name" "winner remains authoritative")
          loser (assoc preset
                       "goal" "stale loser must not publish"
                       "display_name" "stale loser must not publish")
          seeded (run-writer port "publish" held-subject
                             (json/generate-string winner))
          before (entity-facts port held-subject)
          resource (identity-write-resource held-subject)
          holder "identity-publication-test-holder"
          lease (north.coord/send-op
                 port {:op :acquire-lease :res resource :holder holder
                       :ttl-ms 60000})
          rejected (run-writer port "publish" held-subject
                               (json/generate-string loser))
          after (entity-facts port held-subject)
          _ (north.coord/send-op
             port {:op :release-lease :res resource :holder holder
                   :epoch (:epoch lease)})]
      (check "winner identity seeds before the rival publication probe"
             (and (zero? (:exit seeded)) (:ok lease)))
      (check "same-subject rival is rejected before mutation"
             (and (not (zero? (:exit rejected))) (= before after)))
      (check "rejected rival preserves the winner marker and exact body"
             (let [stored (scalar-facts after)]
               (and (north.agent-provenance/managed-valid? stored)
                    (= (get stored "identity_manifest_sha256")
                       (north.agent-provenance/manifest-sha256 stored))))))

    (doseq [{:keys [operation payload verify]}
            [{:operation "route"
              :payload {"provider" "openai" "provider_target" "codex-held"
                        "live_input" "unsupported" "live_input_state" "frozen"
                        "live_input_epoch" "00000000-0000-4000-8000-000000000104"
                        "model" "gpt-5.6-sol" "effort" "high"
                        "display_handle" "openai-held-sol-high-integrator"
                        "display_name" "openai:codex-held · sol · high · gaffer:integrator"}
              :verify #(= #{"gpt-5.6-sol"} (get % "model"))}
             {:operation "retask"
              :payload {"goal" "held retask committed"
                        "display_name" "held retask committed"}
              :verify #(= #{"held retask committed"} (get % "goal"))}
             {:operation "terminal"
              :payload {"outcome" "ran" "process_outcome" "ran"
                        "delivery_outcome" "unverified"
                        "delivery_reason"
                        "provider_terminal_success_without_external_verification"}
              :verify #(some? (get % "terminal_manifest_sha256"))}]]
      (let [held-subject (str "@agent:identity-held-" operation)
            seeded (run-writer
                    port "publish" held-subject
                    (json/generate-string
                     (assoc preset
                            "goal" (str "held " operation)
                            "display_handle" (str "held-" operation)
                            "display_name" (str "held " operation))))
            resource (identity-write-resource held-subject)
            holder (str "held-lifecycle-" operation)
            acquired
            (north.coord/send-op
             port {:op :acquire-lease :res resource :holder holder
                   :ttl-ms 60000})
            lease {:resource resource :holder holder :epoch (:epoch acquired)}
            pending
            (future
              (run-writer port operation held-subject
                          (json/generate-string payload)))
            _ (Thread/sleep 150)
            waited? (not (realized? pending))
            still-held?
            (:fence-ok
             (north.coord/send-op
              port {:op :fence-ok :res resource :holder holder
                    :epoch (:epoch acquired)}))
            released (release-lease! port lease)
            result (deref pending 8000 {:exit -99 :err "writer did not return"})
            after (entity-facts port held-subject)
            stored (scalar-facts after)]
        (check (str operation " waits while the subject lease is held")
               (and (zero? (:exit seeded)) (:ok acquired)
                    waited? still-held? (:ok released) (not (:noop released))))
        (check (str operation " succeeds after the prior writer releases")
               (and (zero? (:exit result))
                    (verify after)
                    (north.agent-provenance/managed-valid? stored)
                    (= (get stored "identity_manifest_sha256")
                       (north.agent-provenance/manifest-sha256 stored))))
        (when (= "terminal" operation)
          (check "held terminal release commits an exact terminal projection"
                 (= (get stored "terminal_manifest_sha256")
                    (north.terminal-projection/terminal-manifest-sha256 stored))))))

    (let [held-subject "@agent:identity-held-past-budget"
          seeded (run-writer port "publish" held-subject
                             (json/generate-string preset))
          before (entity-facts port held-subject)
          resource (identity-write-resource held-subject)
          holder "held-past-acquisition-budget"
          acquired
          (north.coord/send-op
           port {:op :acquire-lease :res resource :holder holder
                 :ttl-ms 60000})
          started (System/nanoTime)
          rejected
          (run-writer
           port "retask" held-subject
           (json/generate-string
            {"goal" "must not land" "display_name" "must not land"})
           {"NORTH_IDENTITY_WRITER_TIMEOUT_MS" "1200"
            "NORTH_IDENTITY_WRITE_LEASE_TTL_MS" "5000"})
          elapsed-ms (/ (- (System/nanoTime) started) 1000000.0)
          _ (release-lease!
             port {:resource resource :holder holder :epoch (:epoch acquired)})]
      (check "held lifecycle lease exhausts its in-process budget without parent kill"
             (and (zero? (:exit seeded))
                  (:ok acquired)
                  (not (zero? (:exit rejected)))
                  (<= 500 elapsed-ms 3000)))
      (check "acquisition timeout occurs before any managed mutation"
             (= before (entity-facts port held-subject))))

    (let [stop-churn? (atom false)
          churn
          (future
            (loop [index 0]
              (when-not @stop-churn?
                (north.coord/append!
                 port "@identity-publication-global-churn" "sample" (str index))
                (recur (inc index)))))
          gate (java.util.concurrent.CountDownLatch. 1)
          publications
          (mapv
           (fn [index]
             (let [parallel-subject
                   (str "@agent:identity-parallel-" index)
                   identity
                   (assoc preset
                          "goal" (str "parallel identity " index)
                          "display_handle" (str "parallel-identity-" index)
                          "display_name" (str "parallel identity " index))]
               {:subject parallel-subject
                :result
                (future
                  (.await gate)
                  (run-writer port "publish" parallel-subject
                              (json/generate-string identity)))}))
           (range 8))
          _ (.countDown gate)
          results
          (mapv (fn [{:keys [subject result]}]
                  {:subject subject :result @result})
                publications)
          _ (reset! stop-churn? true)
          _ @churn]
      (check "eight distinct identities publish during unrelated global churn"
             (every? #(zero? (get-in % [:result :exit])) results))
      (check "every parallel publication has an exact committed identity"
             (every?
              (fn [{:keys [subject]}]
                (let [raw (entity-facts port subject)
                      stored (scalar-facts raw)]
                  (and (every? #(= 1 (count %))
                               (vals
                                (select-keys
                                 raw north.agent-provenance/identity-predicates)))
                       (north.agent-provenance/managed-valid? stored)
                       (= (get stored "identity_manifest_sha256")
                          (north.agent-provenance/manifest-sha256 stored)))))
              results)))

    (let [race-subject "@agent:identity-publish-race"
          attempts
          (mapv
           (fn [index]
             (future
               (run-writer
                port "publish" race-subject
                (json/generate-string
                 (assoc preset
                        "goal" (str "racing generation " index)
                        "display_name" (str "racing generation " index))))))
           (range 8))
          results (mapv deref attempts)
          raw-stored (entity-facts port race-subject)
          stored (scalar-facts raw-stored)
          markers (get raw-stored "identity_manifest_sha256" #{})]
      (check "at least one same-subject publication wins"
             (some #(zero? (:exit %)) results))
      (check "concurrent identity publication ends at one exact committed body"
             (and (= 1 (count markers))
                  (north.agent-provenance/managed-valid? stored)
                  (= (first markers)
                     (north.agent-provenance/manifest-sha256 stored)))))

    (let [race-subject "@agent:identity-route-retask-race"
          seeded
          (run-writer port "publish" race-subject
                      (json/generate-string preset))
          route
          {"provider" "openai" "provider_target" "codex-race"
           "live_input" "unsupported" "live_input_state" "frozen"
           "live_input_epoch" "00000000-0000-4000-8000-000000000105"
           "model" "gpt-5.6-sol" "effort" "high"
           "display_handle" "openai-race-sol-high-integrator"
           "display_name" "openai:codex-race · sol · high · gaffer:integrator"}
          operations
          (mapv
           (fn [index]
             (future
               (if (even? index)
                 (run-writer port "route" race-subject
                             (json/generate-string route))
                 (run-writer
                  port "retask" race-subject
                  (json/generate-string
                   {"goal" (str "racing retask " index)
                    "display_name" (str "racing retask " index)})))))
           (range 16))
          results (mapv deref operations)
          raw-stored (entity-facts port race-subject)
          stored (scalar-facts raw-stored)
          markers (get raw-stored "identity_manifest_sha256" #{})]
      (check "at least one concurrent route or retask wins"
             (some #(zero? (:exit %)) results))
      (check "route/retask share the subject-local identity marker seam"
             (and (zero? (:exit seeded))
                  (= 1 (count markers))
                  (north.agent-provenance/managed-valid? stored)
                  (= (first markers)
                     (north.agent-provenance/manifest-sha256 stored)))))

    (doseq [{:keys [operation payload inject-predicate]}
            [{:operation "publish"
              :payload (assoc bespoke
                              "goal" "replacement must roll back"
                              "display_handle" "replacement-must-roll-back"
                              "display_name" "replacement must roll back")
              :inject-predicate "model"}
             {:operation "route"
              :payload {"provider" "openai"
                        "provider_target" "codex-rollback"
                        "live_input" "unsupported"
                        "live_input_state" "frozen"
                        "live_input_epoch" "00000000-0000-4000-8000-000000000106"
                        "model" "gpt-5.6-sol"
                        "effort" "high"
                        "display_handle" "rollback-route"
                        "display_name" "rollback route"}
              :inject-predicate "model"}
             {:operation "retask"
              :payload {"goal" "rollback retask"
                        "display_name" "rollback retask"}
              :inject-predicate "goal"}
             {:operation "terminal"
              :payload {"outcome" "died" "process_outcome" "died"
                        "delivery_outcome" "blocked"
                        "delivery_reason" "provider_process_died"}
              :inject-predicate "delivery_outcome"}]]
      (let [rollback-subject (str "@agent:identity-rollback-" operation)
            identity
            (assoc preset
                   "goal" (str "prior " operation " generation")
                   "display_handle" (str "prior-" operation "-generation")
                   "display_name" (str "prior " operation " generation"))
            prior-terminal
            {"outcome" "ran" "process_outcome" "ran"
             "delivery_outcome" "unverified"
             "delivery_reason"
             "provider_terminal_success_without_external_verification"}
            identity-result
            (run-writer port "publish" rollback-subject
                        (json/generate-string identity))
            terminal-result
            (run-writer port "terminal" rollback-subject
                        (json/generate-string prior-terminal))
            before (entity-facts port rollback-subject)
            proxy
            (fault-proxy
             port
             #(and (= :assert-with-fence (:op %))
                   (= rollback-subject (:te %))
                   (= inject-predicate (:p %))))]
        (try
          (let [result
                (run-writer (:port proxy) operation rollback-subject
                            (json/generate-string payload))
                requests @(:requests proxy)
                after (entity-facts port rollback-subject)
                stored (scalar-facts after)
                injected-index
                (first
                 (keep-indexed
                  (fn [index request]
                    (when (and (= :assert-with-fence (:op request))
                               (= rollback-subject (:te request))
                               (= inject-predicate (:p request)))
                      index))
                  requests))
                prior-subject-mutations
                (when injected-index
                  (filter
                   #(and (= rollback-subject (:te %))
                         (fenced-ops (:op %)))
                   (take injected-index requests)))
                fenced-requests
                (filter
                 #(and (= rollback-subject (:te %))
                       (fenced-ops (:op %)))
                 requests)
                fence-tuples
                (set (map (juxt :res :holder :epoch) fenced-requests))
                releases (filter #(= :release-lease (:op %)) requests)
                release-request (first releases)
                fence-epoch (nth (first fence-tuples) 2 nil)]
            (check (str operation " fault probe reaches a partial fenced mutation")
                   (and (zero? (:exit identity-result))
                        (zero? (:exit terminal-result))
                        @(:injected? proxy)
                        (some? injected-index)
                        (seq prior-subject-mutations)
                        (not (zero? (:exit result)))))
            (check (str operation " mid-mutation failure restores the exact prior projection")
                   (and (= before after)
                        (north.agent-provenance/managed-valid? stored)
                        (= (get stored "identity_manifest_sha256")
                           (north.agent-provenance/manifest-sha256 stored))
                        (= (get stored "terminal_manifest_sha256")
                           (north.terminal-projection/terminal-manifest-sha256 stored))))
            (check (str operation " rollback remains under one exact write fence")
                   (and (= 1 (count fence-tuples))
                        (= 1 (count (filter #(= :acquire-lease (:op %))
                                            requests)))
                        (= 1 (count releases))
                        (= fence-epoch (:epoch release-request)))))
          (finally
            ((:close! proxy))))))

    ;; The atomic fenced publish owns the fresh path, and its rejection falls
    ;; back to the sequential fenced publish — so proving the ORIGINAL rollback
    ;; semantics needs two staged faults: one rejecting the atomic op, one
    ;; failing the fallback's fenced body mid-mutation.
    (let [fresh-subject "@agent:identity-rollback-fresh-publish"
          proxy
          (fault-proxy
           port
           #(or (and (= :managed-agent-publish (:op %))
                     (= fresh-subject (:te %)))
                (and (= :assert-with-fence (:op %))
                     (= fresh-subject (:te %))
                     (= "model" (:p %))))
           (constantly {:reject :test-injected})
           {:max-injections 2})]
      (try
        (let [result
              (run-writer (:port proxy) "publish" fresh-subject
                          (json/generate-string preset))]
          (check "fresh publish failure reaches a partial fenced body"
                 (and (= 2 @(:injections proxy))
                      (not (zero? (:exit result)))))
          (check "fresh publish failure withdraws its entire managed projection"
                 (empty? (entity-facts port fresh-subject))))
        (finally
          ((:close! proxy)))))

    ;; Atomic-op rejection alone is NOT a publish failure: the sequential
    ;; fallback must complete the identical projection under its own fence.
    (let [fallback-subject "@agent:identity-atomic-fallback-fresh-publish"
          proxy
          (fault-proxy
           port
           #(and (= :managed-agent-publish (:op %))
                 (= fallback-subject (:te %))))]
      (try
        (let [result
              (run-writer (:port proxy) "publish" fallback-subject
                          (json/generate-string
                           (assoc preset
                                  "goal" "atomic fallback fresh publish"
                                  "display_handle" "atomic-fallback-fresh-publish"
                                  "display_name" "atomic fallback fresh publish")))
              stored (scalar-facts (entity-facts port fallback-subject))]
          (check "atomic publish rejection falls back to the sequential fenced path"
                 (and @(:injected? proxy)
                      (zero? (:exit result))
                      (north.agent-provenance/managed-valid? stored)
                      (= (get stored "identity_manifest_sha256")
                         (north.agent-provenance/manifest-sha256 stored)))))
        (finally
          ((:close! proxy)))))

    (let [drop-subject "@agent:identity-rollback-preflight-drop"
          seeded
          (run-writer port "publish" drop-subject
                      (json/generate-string
                       (assoc preset
                              "goal" "preflight transport drop"
                              "display_handle" "preflight-transport-drop"
                              "display_name" "preflight transport drop")))
          proxy
          (fault-proxy
           port
           #(and (= :assert-with-fence (:op %))
                 (= drop-subject (:te %))
                 (= "model" (:p %)))
           (constantly {:reject :test-injected})
           {:drop-fence-after-injection? true})]
      (try
        (let [route
              {"provider" "openai"
               "provider_target" "codex-preflight-drop"
               "live_input" "unsupported"
               "live_input_state" "frozen"
               "live_input_epoch" "00000000-0000-4000-8000-000000000107"
               "model" "gpt-5.6-sol"
               "effort" "high"
               "display_handle" "preflight-drop-route"
               "display_name" "preflight drop route"}
              result
              (run-writer (:port proxy) "route" drop-subject
                          (json/generate-string route))
              after (entity-facts port drop-subject)
              stored (scalar-facts after)
              requests @(:requests proxy)]
          (check "rollback preflight transport drop preserves the original write error"
                 (and (zero? (:exit seeded))
                      @(:injected? proxy)
                      (not (zero? (:exit result)))
                      (str/includes?
                       (:err result)
                       "coordinator rejected harness identity write")
                      (some #(= :fence-ok (:op %)) requests)))
          (check "failed cleanup preflight leaves a markerless fail-closed projection"
                 (and (seq after)
                      (nil? (get after "identity_manifest_sha256"))
                      (not (north.agent-provenance/managed-valid? stored)))))
        (finally
          ((:close! proxy)))))

    (let [takeover-subject "@agent:identity-rollback-fence-takeover"
          initial
          (assoc preset
                 "goal" "generation before stale writer"
                 "display_handle" "generation-before-stale-writer"
                 "display_name" "generation before stale writer")
          stale-route
          {"provider" "openai"
           "provider_target" "codex-stale"
           "live_input" "unsupported"
           "live_input_state" "frozen"
           "live_input_epoch" "00000000-0000-4000-8000-000000000108"
           "model" "gpt-5.6-sol"
           "effort" "high"
           "display_handle" "stale-route"
           "display_name" "stale route"}
          successor
          (assoc preset
                 "provider" "openai"
                 "provider_target" "codex-successor"
                 "live_input" "unsupported"
                 "live_input_state" "frozen"
                 "live_input_epoch" "00000000-0000-4000-8000-000000000109"
                 "model" "gpt-5.6-sol"
                 "effort" "xhigh"
                 "goal" "successor generation"
                 "display_handle" "successor-generation"
                 "display_name" "successor generation")
          seeded
          (run-writer port "publish" takeover-subject
                      (json/generate-string initial))
          injection-reached (promise)
          resume-stale (promise)
          proxy
          (fault-proxy
           port
           #(and (= :assert-with-fence (:op %))
                 (= takeover-subject (:te %))
                 (= "model" (:p %)))
           (fn [_]
             (deliver injection-reached true)
             @resume-stale
             {:reject :fence-lost}))
          successor-lease (atom nil)]
      (try
        (let [stale
              (future
                (run-writer
                 (:port proxy) "route" takeover-subject
                 (json/generate-string stale-route)
                 {"NORTH_IDENTITY_WRITER_TIMEOUT_MS" "200"
                  "NORTH_IDENTITY_WRITE_LEASE_TTL_MS" "350"}))
              reached? (deref injection-reached 3000 false)
              _ (Thread/sleep 500)
              resource (identity-write-resource takeover-subject)
              holder "identity-successor-after-expiry"
              acquired
              (north.coord/send-op
               port {:op :acquire-lease :res resource :holder holder
                     :ttl-ms 60000})
              lease {:resource resource :holder holder :epoch (:epoch acquired)}
              _ (when (:ok acquired)
                  (reset! successor-lease lease)
                  (replace-under-fence!
                   port lease takeover-subject successor))
              _ (deliver resume-stale true)
              stale-result
              (deref stale 5000 {:exit -99 :err "stale writer did not return"})
              after (entity-facts port takeover-subject)
              stored (scalar-facts after)
              requests @(:requests proxy)
              injected-index
              (first
               (keep-indexed
                (fn [index request]
                  (when (and (= :assert-with-fence (:op request))
                             (= takeover-subject (:te request))
                             (= "model" (:p request)))
                    index))
                requests))
              post-injection (if injected-index
                               (drop (inc injected-index) requests)
                               [])
              successor-current?
              (and (:ok acquired)
                   (:fence-ok
                    (north.coord/send-op
                     port {:op :fence-ok :res resource :holder holder
                           :epoch (:epoch acquired)})))]
          (check "expired stale writer loses its fence to a successor"
                 (and (zero? (:exit seeded))
                      reached?
                      (:ok acquired)
                      (not (zero? (:exit stale-result)))
                      successor-current?))
          (check "stale writer observes fence loss and performs no rollback writes"
                 (and
                  (some #(= :fence-ok (:op %)) post-injection)
                  (not-any?
                   #(and (= takeover-subject (:te %))
                         (fenced-ops (:op %)))
                   post-injection)))
          (check "stale failure cannot erase the successor generation"
                 (and (= #{"codex-successor"} (get after "provider_target"))
                      (= #{"gpt-5.6-sol"} (get after "model"))
                      (north.agent-provenance/managed-valid? stored)
                      (= (get stored "identity_manifest_sha256")
                         (north.agent-provenance/manifest-sha256 stored)))))
        (finally
          (deliver resume-stale true)
          (when-let [lease @successor-lease]
            (release-lease! port lease))
          ((:close! proxy)))))

    ;; Caller-owned recovery protocol. Route transitions carry both complete
    ;; endpoints, so every killed durable prefix can be classified and rebuilt.
    (let [route-delta
          {"provider" "openai"
           "provider_target" "codex-recovery"
           "live_input" "streaming"
           "live_input_state" "armed"
           "live_input_epoch" "00000000-0000-4000-8000-000000000121"
           "model" "gpt-5.6-sol"
           "effort" "xhigh"
           "display_handle" "openai-recovery-sol-xhigh-integrator"
           "display_name" "openai:codex-recovery · sol · xhigh · gaffer:integrator"}
          desired (merge preset route-delta)
          old-marker (north.agent-provenance/manifest-sha256 preset)
          new-marker (north.agent-provenance/manifest-sha256 desired)
          transition
          (vec
           (concat
            [[:retract "identity_manifest_sha256" old-marker]]
            (for [predicate (sort (conj test-route-generation-predicates
                                       "display_name"))]
              [:retract predicate (get preset predicate)])
            (for [predicate (sort (conj test-route-generation-predicates
                                       "display_name"))]
              [:put predicate (get desired predicate)])
            [[:put "identity_manifest_sha256" new-marker]]))
          holder "managed-agent-writer:00000000-0000-4000-8000-000000000120"
          results
          (mapv
           (fn [prefix]
             (let [subject (str "@agent:managed-killed-prefix-" prefix)]
               (seed-identity! port subject preset)
               (apply-prefix! port subject transition prefix)
               (let [result
                     (run-managed-writer
                      port "route" subject (json/generate-string route-delta)
                      holder (str (java.util.UUID/randomUUID)) desired preset)
                     stored (scalar-facts (entity-facts port subject))]
                 {:result result
                  :exact (and (north.agent-provenance/managed-valid? stored)
                              (= desired
                                 (select-keys stored (keys desired)))
                              (= new-marker
                                 (get stored "identity_manifest_sha256")))})))
           (range (inc (count transition))))]
      (check "every durable route prefix recovers the exact desired generation"
             (every?
              #(and (zero? (get-in % [:result :exit]))
                    (= "committed" (get-in % [:result :result :status]))
                    (:exact %))
              results)))

    ;; Exact state after commit with the old epoch still leased is the real
    ;; commit-unknown incident. Same-holder replay must rotate/fence immediately;
    ;; the delayed old finally may not erase the successor epoch.
    (let [subject "@agent:managed-lost-ack"
          route-delta
          {"provider" "openai" "provider_target" "codex-lost-ack"
           "live_input" "streaming" "live_input_state" "armed"
           "live_input_epoch" "00000000-0000-4000-8000-000000000122"
           "model" "gpt-5.6-sol" "effort" "xhigh"
           "display_handle" "openai-lost-ack-sol-xhigh-integrator"
           "display_name" "openai:codex-lost-ack · sol · xhigh · gaffer:integrator"}
          desired (merge preset route-delta)
          holder "managed-agent-writer:00000000-0000-4000-8000-000000000122"
          resource (identity-write-resource subject)
          old-lease (north.coord/send-op
                     port {:op :acquire-lease :res resource :holder holder
                           :ttl-ms 60000})
          _ (seed-identity! port subject desired)
          recovered (run-managed-writer
                     port "route" subject (json/generate-string route-delta)
                     holder (str (java.util.UUID/randomUUID)) desired preset)
          stale-write (north.coord/put-with-fence!
                       port {:resource resource :holder holder
                             :epoch (:epoch old-lease)}
                       subject "goal" "stale prior operation")
          stale-release (north.coord/send-op
                         port {:op :release-lease :res resource :holder holder
                               :epoch (:epoch old-lease)})
          stored (scalar-facts (entity-facts port subject))]
      (check "lost acknowledgement replays as committed through the retained same-holder fence"
             (and (:ok old-lease)
                  (zero? (:exit recovered))
                  (= "committed" (get-in recovered [:result :status]))
                  (= "exact_replay" (get-in recovered [:result :reason]))
                  (= desired (select-keys stored (keys desired)))))
      (check "stale same-holder release cannot erase the recovered epoch"
             (and (= :fence-lost (:reject stale-write))
                  (:noop stale-release)
                  (= (north.agent-provenance/manifest-sha256 stored)
                     (get stored "identity_manifest_sha256")))))

    (let [subject "@agent:managed-conflicting-successor"
          route-delta
          {"provider" "openai" "provider_target" "codex-intended"
           "live_input" "streaming" "live_input_state" "armed"
           "live_input_epoch" "00000000-0000-4000-8000-000000000123"
           "model" "gpt-5.6-sol" "effort" "xhigh"
           "display_handle" "openai-intended-sol-xhigh-integrator"
           "display_name" "openai:codex-intended · sol · xhigh · gaffer:integrator"}
          desired (merge preset route-delta)
          successor (assoc desired
                           "provider_target" "codex-successor"
                           "live_input_epoch" "00000000-0000-4000-8000-000000000124"
                           "display_handle" "openai-successor-sol-xhigh-integrator"
                           "display_name" "openai:codex-successor · sol · xhigh · gaffer:integrator")
          _ (seed-identity! port subject successor)
          before (entity-facts port subject)
          result (run-managed-writer
                  port "route" subject (json/generate-string route-delta)
                  "managed-agent-writer:00000000-0000-4000-8000-000000000123"
                  (str (java.util.UUID/randomUUID)) desired preset)]
      (check "recovery returns typed not_committed without overwriting a successor"
             (and (zero? (:exit result))
                  (= "not_committed" (get-in result [:result :status]))
                  (= "conflicting_generation" (get-in result [:result :reason]))
                  (= before (entity-facts port subject)))))

    (let [subject "@agent:managed-retask-before-route"
          retasked (assoc preset
                          "goal" "new retasked goal"
                          "display_name" "retasked display cache")
          route-delta
          {"provider" "openai" "provider_target" "codex-retasked"
           "live_input" "streaming" "live_input_state" "armed"
           "live_input_epoch" "00000000-0000-4000-8000-000000000131"
           "model" "gpt-5.6-sol" "effort" "xhigh"
           "display_handle" "openai-retasked-sol-xhigh-integrator"
           "display_name" "stale pre-retask route display"}
          stale-desired (merge preset route-delta)
          effective (merge retasked
                           (select-keys route-delta
                                        test-route-generation-predicates))
          _seed (seed-identity! port subject preset)
          retask-result
          (run-writer port "retask" subject
                      (json/generate-string
                       (select-keys retasked ["goal" "display_name"])))
          route-result
          (run-managed-writer
           port "route" subject (json/generate-string route-delta)
           "managed-agent-writer:00000000-0000-4000-8000-000000000131"
           (str (java.util.UUID/randomUUID)) stale-desired preset)
          stored (scalar-facts (entity-facts port subject))]
      (check "retask before route rebases route axes without restoring stale goal/cache"
             (and (zero? (:exit retask-result))
                  (= "committed" (get-in route-result [:result :status]))
                  (= "rebased_retask_overlay" (get-in route-result [:result :reason]))
                  (= effective (select-keys stored (keys effective)))
                  (= (north.agent-provenance/manifest-sha256 stored)
                     (get stored "identity_manifest_sha256")))))

    (let [subject "@agent:managed-retask-before-freeze"
          retasked (assoc preset
                          "goal" "retasked before freeze"
                          "display_name" "retasked freeze display")
          freeze-delta
          (assoc (select-keys preset
                             ["provider" "provider_target" "live_input"
                              "model" "effort" "display_handle" "display_name"])
                 "live_input_state" "frozen"
                 "live_input_epoch" "00000000-0000-4000-8000-000000000132"
                 "display_name" "stale freeze display")
          stale-desired (merge preset freeze-delta)
          _seed (seed-identity! port subject preset)
          _retask (run-writer port "retask" subject
                              (json/generate-string
                               (select-keys retasked ["goal" "display_name"])))
          freeze-result
          (run-managed-writer
           port "route" subject (json/generate-string freeze-delta)
           "managed-agent-writer:00000000-0000-4000-8000-000000000132"
           (str (java.util.UUID/randomUUID)) stale-desired preset)
          stored (scalar-facts (entity-facts port subject))]
      (check "mandatory freeze after retask commits frozen while preserving the retask overlay"
             (and (= "committed" (get-in freeze-result [:result :status]))
                  (= "frozen" (get stored "live_input_state"))
                  (= (get retasked "goal") (get stored "goal"))
                  (= (get retasked "display_name") (get stored "display_name"))
                  (north.agent-provenance/managed-valid? stored))))

    (let [subject "@agent:managed-retask-before-terminal"
          terminal
          {"outcome" "died" "process_outcome" "died"
           "delivery_outcome" "blocked"
           "delivery_reason" "provider_process_died"}
          _seed (seed-identity! port subject preset)
          _retask (run-writer port "retask" subject
                              (json/generate-string
                               {"goal" "retasked before terminal"
                                "display_name" "retasked terminal display"}))
          terminal-result
          (run-managed-writer
           port "terminal" subject (json/generate-string terminal)
           "managed-agent-writer:00000000-0000-4000-8000-000000000133"
           (str (java.util.UUID/randomUUID)) nil preset)
          stored (scalar-facts (entity-facts port subject))]
      (check "terminal accepts a valid retask successor without weakening route generation checks"
             (and (= "committed" (get-in terminal-result [:result :status]))
                  (= "retasked before terminal" (get stored "goal"))
                  (= (north.terminal-projection/terminal-manifest-sha256 terminal)
                     (get stored "terminal_manifest_sha256")))))

    ;; Exact production incident: provider preflight rejects after identity and
    ;; presence publication. Terminal commit must make the lane disappear now,
    ;; release only its own driver, and permit immediate thread reuse.
    (let [agent-id "managed-blocked-preflight-cleanup"
          subject (str "@agent:" agent-id)
          thread "@managed-blocked-preflight-thread"
          successor "managed-blocked-preflight-successor"
          terminal
          {"outcome" "blocked_preflight"
           "process_outcome" "blocked_preflight"
           "delivery_outcome" "blocked"
           "delivery_reason" "execution_preflight_blocked"}
          holder "managed-agent-writer:00000000-0000-4000-8000-000000000140"
          operation-id "00000000-0000-4000-8000-000000000140"
          _identity (seed-identity! port subject preset)
          _title (north.coord/append! port thread "title" "blocked preflight cleanup")
          initial-claim
          (proc/shell {:out :string :err :string :continue true
                       :extra-env {"FRAM_LOG" @test-log}}
                      "bb" (str root "/cli/acquire-cli.clj") (str port)
                      "claim" thread agent-id)
          presence (north.coord/send-op
                    port {:op :acquire-lease :res (str "session:" agent-id)
                          :holder agent-id :ttl-ms 1800000})
          proxy (fault-proxy port (constantly false))
          terminal-result
          (run-managed-writer
           (:port proxy) "terminal" subject (json/generate-string terminal)
           holder operation-id nil preset thread)
          after (scalar-facts (entity-facts port subject))
          ;; This harness invokes only the managed terminal writer: there is no
          ;; dispatch outer-finally release available to make the assertion pass.
          driver-after-terminal (north.coord/resolved port thread "driver")
          claim
          (proc/shell {:out :string :err :string :continue true
                       :extra-env {"FRAM_LOG" @test-log}}
                      "bb" (str root "/cli/acquire-cli.clj") (str port)
                      "claim" thread successor)
          replay
          (run-managed-writer
           (:port proxy) "terminal" subject (json/generate-string terminal)
           holder operation-id nil preset thread)
          requests @(:requests proxy)
          presence-index
          (first (keep-indexed
                  (fn [index request]
                    (when (and (= :release-lease (:op request))
                               (= (str "session:" agent-id) (:res request)))
                      index))
                  requests))
          driver-index
          (first (keep-indexed
                  (fn [index request]
                    (when (and (= :retract-with-fence (:op request))
                               (= thread (:te request))
                               (= "driver" (:p request))
                               (= (str "@" agent-id) (:r request)))
                      index))
                  requests))
          marker-index
          (first (keep-indexed
                  (fn [index request]
                    (when (and (= :assert-at-version-with-fence (:op request))
                               (= subject (:te request))
                               (= "terminal_manifest_sha256" (:p request)))
                      index))
                  requests))]
      (check "terminal commit without an outer finally closes presence and releases the production driver before acknowledgement"
             (and (:ok presence)
                  (zero? (:exit initial-claim))
                  (= "committed" (get-in terminal-result [:result :status]))
                  (= (north.terminal-projection/terminal-manifest-sha256 terminal)
                     (get after "terminal_manifest_sha256"))
                  (nil? (north.coord/lease-of port (str "session:" agent-id)))
                  (nil? driver-after-terminal)
                  (zero? (:exit claim))))
      (check "terminal marker is the final lifecycle publication after presence and driver cleanup"
             (and (integer? presence-index)
                  (integer? driver-index)
                  (integer? marker-index)
                  (< presence-index marker-index)
                  (< driver-index marker-index)))
      (check "lost-ack replay preserves the immediate successor driver"
             (and (= "committed" (get-in replay [:result :status]))
                  (= "exact_replay" (get-in replay [:result :reason]))
                  (= (str "@" successor)
                     (north.coord/resolved port thread "driver"))))
      ((:close! proxy)))

    ;; Enumerate every durable prefix of terminal body -> presence close ->
    ;; exact driver release -> commit marker. The same logical operation must
    ;; reconstruct the exact terminal and cleanup state from each one.
    (let [terminal
          {"outcome" "blocked_preflight"
           "process_outcome" "blocked_preflight"
           "delivery_outcome" "blocked"
           "delivery_reason" "execution_preflight_blocked"}
          operations
          (vec
           (concat
            (for [predicate test-terminal-publication-order
                  :let [value (get terminal predicate)]
                  :when value]
              [:put predicate value])
            [[:release-presence nil nil]
             [:release-driver nil nil]
             [:marker nil nil]]))
          results
          (mapv
           (fn [prefix]
             (let [agent-id (str "managed-terminal-cleanup-prefix-" prefix)
                   subject (str "@agent:" agent-id)
                   thread (str "@managed-terminal-cleanup-thread-" prefix)
                   _identity (seed-identity! port subject preset)
                   _title (north.coord/append! port thread "title" "cleanup prefix")
                   initial-claim
                   (proc/shell {:out :string :err :string :continue true
                                :extra-env {"FRAM_LOG" @test-log}}
                               "bb" (str root "/cli/acquire-cli.clj") (str port)
                               "claim" thread agent-id)
                   _presence
                   (north.coord/send-op
                    port {:op :acquire-lease :res (str "session:" agent-id)
                          :holder agent-id :ttl-ms 1800000})
                   _prefix
                   (apply-terminal-lifecycle-prefix!
                    port subject thread terminal operations prefix)
                   recovered
                   (run-managed-writer
                    port "terminal" subject (json/generate-string terminal)
                    "managed-agent-writer:00000000-0000-4000-8000-000000000141"
                    (str (java.util.UUID/randomUUID)) nil preset thread)
                   stored (scalar-facts (entity-facts port subject))]
               {:recovered recovered
                :initial-claim (:exit initial-claim)
                :exact (= (north.terminal-projection/terminal-manifest-sha256 terminal)
                          (get stored "terminal_manifest_sha256"))
                :presence (north.coord/lease-of port (str "session:" agent-id))
                :driver (north.coord/resolved port thread "driver")}))
           (range (inc (count operations))))]
      (check "every killed terminal-cleanup durable prefix recovers terminal, presence, and driver exactly"
             (every?
              #(and (zero? (get-in % [:recovered :exit]))
                    (zero? (:initial-claim %))
                    (= "committed" (get-in % [:recovered :result :status]))
                    (:exact %)
                    (nil? (:presence %))
                    (nil? (:driver %)))
              results)))

    (let [subject "@agent:managed-retask-during-recovery"
          holder "managed-agent-writer:00000000-0000-4000-8000-000000000134"
          route-delta
          {"provider" "openai" "provider_target" "codex-retask-race"
           "live_input" "streaming" "live_input_state" "armed"
           "live_input_epoch" "00000000-0000-4000-8000-000000000134"
           "model" "gpt-5.6-sol" "effort" "xhigh"
           "display_handle" "openai-retask-race-sol-xhigh-integrator"
           "display_name" "pre-retask race display"}
          desired (merge preset route-delta)
          terminal
          {"outcome" "died" "process_outcome" "died"
           "delivery_outcome" "blocked"
           "delivery_reason" "provider_process_died"}
          resource (identity-write-resource subject)
          _seed (seed-identity! port subject desired)
          old-lease (north.coord/send-op
                     port {:op :acquire-lease :res resource :holder holder
                           :ttl-ms 60000})
          waiting-retask
          (future
            (run-writer port "retask" subject
                        (json/generate-string
                         {"goal" "retasked during recovery"
                          "display_name" "retasked recovery display"})))
          _wait (Thread/sleep 100)
          recovery-result
          (run-managed-writer
           port "route" subject (json/generate-string route-delta)
           holder (str (java.util.UUID/randomUUID)) desired preset)
          retask-result (deref waiting-retask 10000 {:exit -1})
          terminal-result
          (run-managed-writer
           port "terminal" subject (json/generate-string terminal)
           holder (str (java.util.UUID/randomUUID)) nil desired)
          stale-release (north.coord/send-op
                         port {:op :release-lease :res resource :holder holder
                               :epoch (:epoch old-lease)})
          stored (scalar-facts (entity-facts port subject))]
      (check "same-holder lost-ack recovery fences first, then a waiting retask and terminal both commit"
             (and (:ok old-lease)
                  (= "committed" (get-in recovery-result [:result :status]))
                  (= "exact_replay" (get-in recovery-result [:result :reason]))
                  (zero? (:exit retask-result))
                  (= "committed" (get-in terminal-result [:result :status]))
                  (:noop stale-release)
                  (= "retasked during recovery" (get stored "goal"))
                  (= (north.terminal-projection/terminal-manifest-sha256 terminal)
                     (get stored "terminal_manifest_sha256")))))

    (let [retasked
          (assoc preset
                 "goal" "retask survives every route prefix"
                 "display_name" "durable retask overlay")
          route-delta
          {"provider" "openai" "provider_target" "codex-retask-prefix"
           "live_input" "streaming" "live_input_state" "frozen"
           "live_input_epoch" "00000000-0000-4000-8000-000000000135"
           "model" "gpt-5.6-sol" "effort" "xhigh"
           "display_handle" "openai-retask-prefix-sol-xhigh-integrator"
           "display_name" "stale caller cache"}
          stale-desired (merge preset route-delta)
          effective (merge retasked
                           (select-keys route-delta
                                        test-route-generation-predicates))
          old-marker (north.agent-provenance/manifest-sha256 retasked)
          new-marker (north.agent-provenance/manifest-sha256 effective)
          transition
          (vec
           (concat
            [[:retract "identity_manifest_sha256" old-marker]]
            (for [predicate (sort test-route-generation-predicates)]
              [:retract predicate (get retasked predicate)])
            (for [predicate (sort test-route-generation-predicates)]
              [:put predicate (get effective predicate)])
            [[:put "identity_manifest_sha256" new-marker]]))
          holder "managed-agent-writer:00000000-0000-4000-8000-000000000135"
          results
          (mapv
           (fn [prefix]
             (let [subject (str "@agent:managed-retask-prefix-" prefix)]
               (seed-identity! port subject retasked)
               (apply-prefix! port subject transition prefix)
               (let [result
                     (run-managed-writer
                      port "route" subject (json/generate-string route-delta)
                      holder (str (java.util.UUID/randomUUID))
                      stale-desired preset)
                     stored (scalar-facts (entity-facts port subject))]
                 {:result result
                  :exact (and (= effective
                                 (select-keys stored (keys effective)))
                              (= new-marker
                                 (get stored "identity_manifest_sha256")))})))
           (range (inc (count transition))))]
      (check "every killed route prefix preserves and recovers a committed retask overlay"
             (every?
              #(and (zero? (get-in % [:result :exit]))
                    (= "committed" (get-in % [:result :result :status]))
                    (:exact %))
              results)))

    (let [terminal
          {"outcome" "died" "process_outcome" "died"
           "delivery_outcome" "blocked"
           "delivery_reason" "provider_process_died"}
          operation-order
          (vec
           (concat
            (for [predicate test-terminal-publication-order
                  :let [value (get terminal predicate)]
                  :when value]
              [:put predicate value])
            [[:put "terminal_manifest_sha256"
              (north.terminal-projection/terminal-manifest-sha256 terminal)]]))
          results
          (mapv
           (fn [prefix]
             (let [subject (str "@agent:managed-terminal-prefix-" prefix)
                   holder (str "managed-agent-writer:"
                               (java.util.UUID/randomUUID))]
               (seed-identity! port subject preset)
               (apply-prefix! port subject operation-order prefix)
               (let [result
                     (run-managed-writer
                      port "terminal" subject (json/generate-string terminal)
                      holder (str (java.util.UUID/randomUUID)) nil preset)
                     stored (scalar-facts (entity-facts port subject))]
                 {:result result
                  :exact (= (north.terminal-projection/terminal-manifest-sha256 terminal)
                            (get stored "terminal_manifest_sha256"))})))
           (range (inc (count operation-order))))]
      (check "every durable terminal prefix recovers one exact terminal projection"
             (every?
              #(and (zero? (get-in % [:result :exit]))
                    (= "committed" (get-in % [:result :result :status]))
                    (:exact %))
              results)))

    (let [subject "@agent:managed-terminal-dominates-route"
          holder "managed-agent-writer:00000000-0000-4000-8000-000000000125"
          terminal
          {"outcome" "died" "process_outcome" "died"
           "delivery_outcome" "blocked"
           "delivery_reason" "provider_process_died"}
          route-delta
          {"provider" "openai" "provider_target" "codex-after-terminal"
           "live_input" "streaming" "live_input_state" "frozen"
           "live_input_epoch" "00000000-0000-4000-8000-000000000125"
           "model" "gpt-5.6-sol" "effort" "xhigh"
           "display_handle" "openai-after-terminal-sol-xhigh-integrator"
           "display_name" "openai:codex-after-terminal · sol · xhigh · gaffer:integrator"}
          desired (merge preset route-delta)
          _ (seed-identity! port subject preset)
          terminal-result
          (run-managed-writer
           port "terminal" subject (json/generate-string terminal)
           holder (str (java.util.UUID/randomUUID)) nil preset)
          before (entity-facts port subject)
          route-result
          (run-managed-writer
           port "route" subject (json/generate-string route-delta)
           holder (str (java.util.UUID/randomUUID)) desired preset)]
      (check "committed terminal is irreversible and rejects later route mutation"
             (and (= "committed" (get-in terminal-result [:result :status]))
                  (= "not_committed" (get-in route-result [:result :status]))
                  (= "terminal_committed" (get-in route-result [:result :reason]))
                  (= before (entity-facts port subject)))))

    (let [worker-subject "@agent:delivery-worker"
          verifier-subject "@agent:delivery-verifier"
          worker (assoc preset
                        "role" "integrator" "composition_id" "integrator"
                        "goal" "deliver a proof-carrying change"
                        "display_handle" "anthropic-a-opus-high-integrator-worker"
                        "display_name" "anthropic:claude-a · opus · high · gaffer:integrator")
          verifier (assoc preset
                          "role" "verifier" "composition_id" "verifier"
                          "goal" "independently attest delivery"
                          "display_handle" "anthropic-a-opus-high-verifier-proof"
                          "display_name" "anthropic:claude-a · opus · high · gaffer:verifier")
          run-evidence (array-map
                        "bar" "tests pass"
                        "observed" "24/24"
                        "recordedAt" "2026-07-18T09:59:59Z"
                        "reporter" worker-subject
                        "run" "@run-delivery-worker-proof"
                        "thread" "@thread-proof"
                        "version" "north:run-bar-evidence:v1")
          evidence (json/generate-string
                    (array-map
                     "version" "north:done-bars:v2"
                     "run" "@run-delivery-worker-proof"
                     "thread" "@thread-proof"
                     "reporter" worker-subject
                     "contractOrigin" "accepted"
                     "baselineDoneWhen" ["tests pass"]
                     "doneWhen" ["tests pass"]
                     "matches" [{"bar" "tests pass"
                                 "evidence" [run-evidence]}]))
          reported {"outcome" "ran" "process_outcome" "ran"
                    "delivery_outcome" "reported"
                    "delivery_reason" "complete_run_scoped_done_bar_evidence_self_reported"
                    "delivery_evidence" evidence
                    "delivery_evidence_sha256"
                    (north.terminal-projection/sha256 evidence)}]
      (check "delivery worker identity publishes"
             (zero? (:exit (run-writer port "publish" worker-subject
                                       (json/generate-string worker)))))
      (check "independent verifier identity publishes"
             (zero? (:exit (run-writer port "publish" verifier-subject
                                       (json/generate-string verifier)))))
      (north.coord/append! port "@thread-proof" "done_when" "tests pass")
      (let [missing-run-result
            (run-writer port "terminal" worker-subject
                        (json/generate-string reported))]
        (check "reported terminal rejects a missing reserved run"
               (and (not (zero? (:exit missing-run-result)))
                    (nil? (get (entity-facts port worker-subject)
                               "terminal_manifest_sha256")))))
      (reserve-run! port "@run-delivery-worker-proof" worker-subject
                    "@thread-proof" (apply str (repeat 64 "a")))
      (north.coord/append!
       port "@run-delivery-worker-proof" "run_bar_evidence"
       (json/generate-string (into (sorted-map) run-evidence)))
      (check "complete self-reported proof commits as reported"
             (zero? (:exit (run-writer port "terminal" worker-subject
                                       (json/generate-string reported)))))
      (doseq [[label injected]
              [["uncited valid"
                (json/generate-string
                 (into (sorted-map)
                       (assoc run-evidence
                              "bar" "uncited extra bar"
                              "observed" "not in snapshot"
                              "recordedAt" "2026-07-18T10:00:01Z")))]
               ["malformed" "{"]
               ["duplicate bar"
                (json/generate-string
                 (into (sorted-map)
                       (assoc run-evidence
                              "observed" "second stored observation"
                              "recordedAt" "2026-07-18T10:00:02Z")))]]]
        (north.coord/append! port "@run-delivery-worker-proof"
                             "run_bar_evidence" injected)
        (let [before (entity-facts port worker-subject)
              rejected
              (run-writer port "terminal" worker-subject
                          (json/generate-string reported))]
          (check (str "lane marker rejects " label " stored evidence")
                 (and (not (zero? (:exit rejected)))
                      (= before (entity-facts port worker-subject)))))
        (north.coord/retract! port "@run-delivery-worker-proof"
                              "run_bar_evidence" injected))
      (let [relabelled-evidence
            (json/generate-string
             (-> (json/parse-string evidence)
                 (assoc "contractOrigin" "worker-defined")
                 (assoc "baselineDoneWhen" [])))
            relabelled
            (assoc reported
                   "delivery_evidence" relabelled-evidence
                   "delivery_evidence_sha256"
                   (north.terminal-projection/sha256 relabelled-evidence))
            before (entity-facts port worker-subject)]
        (check "snapshot cannot relabel an accepted reservation as worker-defined"
               (and (not (zero? (:exit
                                 (run-writer port "terminal" worker-subject
                                             (json/generate-string relabelled)))))
                    (= before (entity-facts port worker-subject)))))
      (north.coord/append! port "@thread-proof" "done_when" "late weaker bar")
      (let [before (entity-facts port worker-subject)
            changed
            (run-writer port "terminal" worker-subject
                        (json/generate-string reported))]
        (check "reported terminal rejects a changed current done-bar set"
               (and (not (zero? (:exit changed)))
                    (= before (entity-facts port worker-subject)))))
      (north.coord/retract! port "@thread-proof" "done_when" "late weaker bar")
      (let [fabricated-record (assoc run-evidence "observed" "not stored")
            fabricated-evidence
            (json/generate-string
             (assoc-in (json/parse-string evidence)
                       ["matches" 0 "evidence"] [fabricated-record]))
            fabricated
            (assoc reported
                   "delivery_evidence" fabricated-evidence
                   "delivery_evidence_sha256"
                   (north.terminal-projection/sha256 fabricated-evidence))
            before (entity-facts port worker-subject)]
        (check "reported terminal rejects a fabricated unstored run record"
               (and (not (zero? (:exit
                                 (run-writer port "terminal" worker-subject
                                             (json/generate-string fabricated)))))
                    (= before (entity-facts port worker-subject)))))
      (let [cross-run "@run-delivery-cross-proof"
            cross-record (assoc run-evidence "run" cross-run)
            cross-evidence
            (json/generate-string
             (-> (json/parse-string evidence)
                 (assoc "run" cross-run)
                 (assoc-in ["matches" 0 "evidence"] [cross-record])))
            cross-reported
            (assoc reported
                   "delivery_evidence" cross-evidence
                   "delivery_evidence_sha256"
                   (north.terminal-projection/sha256 cross-evidence))
            before (entity-facts port worker-subject)]
        (reserve-run! port cross-run verifier-subject "@thread-proof"
                      (apply str (repeat 64 "b")))
        (north.coord/append! port cross-run "run_bar_evidence"
                            (json/generate-string (into (sorted-map) cross-record)))
        (check "reported terminal rejects a cross-agent run reservation"
               (and (not (zero? (:exit
                                 (run-writer port "terminal" worker-subject
                                             (json/generate-string cross-reported)))))
                    (= before (entity-facts port worker-subject)))))
      (let [cross-run "@run-delivery-cross-thread-proof"
            cross-record (assoc run-evidence "run" cross-run)
            cross-evidence
            (json/generate-string
             (-> (json/parse-string evidence)
                 (assoc "run" cross-run)
                 (assoc-in ["matches" 0 "evidence"] [cross-record])))
            cross-reported
            (assoc reported
                   "delivery_evidence" cross-evidence
                   "delivery_evidence_sha256"
                   (north.terminal-projection/sha256 cross-evidence))
            before (entity-facts port worker-subject)]
        (reserve-run! port cross-run worker-subject "@different-thread"
                      (apply str (repeat 64 "c")))
        (north.coord/append! port cross-run "run_bar_evidence"
                            (json/generate-string (into (sorted-map) cross-record)))
        (check "reported terminal rejects a cross-thread run reservation"
               (and (not (zero? (:exit
                                 (run-writer port "terminal" worker-subject
                                             (json/generate-string cross-reported)))))
                    (= before (entity-facts port worker-subject)))))
      (let [contradictory (assoc reported
                                 "outcome" "died"
                                 "process_outcome" "died")
            before (entity-facts port worker-subject)]
        (check "non-ran process cannot carry reported delivery proof"
               (and (not (zero? (:exit
                                 (run-writer port "terminal" worker-subject
                                             (json/generate-string contradictory)))))
                    (= before (entity-facts port worker-subject)))))
      (let [forged-evidence (str/replace evidence worker-subject verifier-subject)
            forged (assoc reported
                          "delivery_evidence" forged-evidence
                          "delivery_evidence_sha256"
                          (north.terminal-projection/sha256 forged-evidence))
            before (entity-facts port worker-subject)]
        (check "caller-supplied reporter cannot forge managed terminal authority"
               (and (not (zero? (:exit
                                 (run-writer port "terminal" worker-subject
                                             (json/generate-string forged)))))
                    (= before (entity-facts port worker-subject)))))
      (let [self-result (run-writer port "attest" worker-subject
                                    (json/generate-string {"actor" worker-subject}))]
        (check "delivery worker cannot self-attest" (not (zero? (:exit self-result)))))
      (let [attested-result
            (proc/shell {:out :string :err :string :continue true
                         :extra-env {"AGENT_ID" "delivery-verifier"
                                     "NORTH_PORT" (str port)
                                     "FRAM_LOG" @test-log}}
                        (str root "/bin/north") "delivery" "attest"
                        "delivery-worker")
            stored (scalar-facts (entity-facts port worker-subject))]
        (check "public north delivery attest fails closed under shared-UID lanes"
               (and (not (zero? (:exit attested-result)))
                    (= "reported"
                       (north.terminal-projection/terminal-delivery-outcome stored))
                    (nil? (get stored "delivery_attestation"))))
        (check "failed attestation leaves the reported terminal manifest intact"
               (= (get stored "terminal_manifest_sha256")
                  (north.terminal-projection/terminal-manifest-sha256 stored)))))
    (finally
      (proc/destroy-tree daemon)
      (try @daemon (catch Exception _ nil))
      (doseq [[label ok?] @checks]
        (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
      (let [failed (remove second @checks)]
        (println (format "\n%d/%d passed" (- (count @checks) (count failed)) (count @checks)))
        (when (seq failed) (System/exit 1))))))
