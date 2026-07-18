#!/usr/bin/env bb
(require '[babashka.process :as proc]
         '[cheshire.core :as json]
         '[clojure.java.io :as io])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram (str (System/getProperty "user.home") "/code/fram"))
(def run-writer (str root "/cli/run-fact-internal.clj"))
(def evidence-writer (str root "/cli/delivery-evidence-internal.clj"))
(def conformance
  (json/parse-string
   (slurp (str root "/sdk/test/fixtures/delivery-conformance.json"))))
(load-file (str root "/cli/coord.clj"))
(load-file (str root "/cli/terminal-projection.clj"))
(load-file evidence-writer)

(def checks (atom []))
(def test-log (atom nil))
(defn check [label ok?] (swap! checks conj [label (boolean ok?)]))
(defn free-port [] (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))
(defn port-open? [port]
  (try (with-open [socket (java.net.Socket.)]
         (.connect socket (java.net.InetSocketAddress. "127.0.0.1" (int port)) 100)
         true)
       (catch Exception _ false)))
(defn eventually [predicate]
  (loop [n 0]
    (cond (predicate) true
          (>= n 200) false
          :else (do (Thread/sleep 25) (recur (inc n))))))
(defn facts-of [port subject]
  (let [rows (:ok (north.coord/send-op
                   port {:op :query
                         :query {:find "run_publication_test"
                                 :rules [{:head {:rel "run_publication_test"
                                                 :args [{:var "p"} {:var "r"}]}
                                          :body [{:rel "triple"
                                                  :args [subject {:var "p"} {:var "r"}]}]}]}}))]
    (reduce (fn [facts [predicate value]]
              (update facts predicate (fnil conj #{}) value))
            {}
            rows)))
(defn shell [& args]
  (apply proc/shell {:out :string :err :string :continue true
                     :extra-env {"FRAM_LOG" @test-log}}
         args))
(defn reserve-request [run thread reporter capability]
  {"run" run "thread" thread "reporter" reporter
   "capabilitySha256" (north.terminal-projection/sha256 capability)})
(defn record-request [run thread reporter capability bar observed]
  {"run" run "thread" thread "reporter" reporter
   "capability" capability "bar" bar "observed" observed})
(defn v2-snapshot [run thread reporter evidence]
  (json/generate-string
   (array-map
    "version" north.terminal-projection/delivery-evidence-version
    "run" run
    "thread" thread
    "reporter" reporter
    "contractOrigin" "accepted"
    "baselineDoneWhen" ["tests pass"]
    "doneWhen" ["tests pass"]
    "matches" [{"bar" "tests pass" "evidence" [evidence]}])))
(defn worker-defined-v2-snapshot
  [run thread reporter bar evidence]
  (json/generate-string
   (array-map
    "version" north.terminal-projection/delivery-evidence-version
    "run" run
    "thread" thread
    "reporter" reporter
    "contractOrigin" "worker-defined"
    "baselineDoneWhen" []
    "doneWhen" [bar]
    "matches" [{"bar" bar "evidence" [evidence]}])))
(defn run-payload [thread agent evidence]
  [["kind" "run"] ["thread" thread] ["agent" agent]
   ["duration_ms" "125"] ["outcome" "ran"] ["process_outcome" "ran"]
   ["delivery_outcome" "reported"]
   ["delivery_reason" "complete_run_scoped_done_bar_evidence_self_reported"]
   ["delivery_evidence" evidence]
   ["delivery_evidence_sha256" (north.terminal-projection/sha256 evidence)]])
(defn unverified-run-payload [thread agent]
  [["kind" "run"] ["thread" thread] ["agent" agent]
   ["duration_ms" "125"] ["outcome" "ran"] ["process_outcome" "ran"]
   ["delivery_outcome" "unverified"]
   ["delivery_reason" "delivery_bar_evidence_incomplete"]])

(let [bars (atom ["tests pass"])
      bases (atom [])
      validations (atom 0)
      accepted (atom false)
      error
      (try
        (with-redefs
         [north.coord/cur-ver (fn [_] (if (empty? @bases) 41 42))
          north.coord/send-op
          (fn [_ operation]
            (swap! bases conj (:base operation))
            (if (= 41 (:base operation))
              (do
                ;; Deterministic adversary: mutate the contract in the exact
                ;; read→marker window and have the coordinator reject that base.
                (reset! bars ["weaker replacement"])
                {:reject :conflict})
              (do (reset! accepted true) {:ok true})))]
          (north.coord/assert-after-read!
           7977 "@agent:probe" "terminal_manifest_sha256" "digest"
           (fn []
             (swap! validations inc)
             (when-not (= ["tests pass"] @bars)
               (throw (ex-info "stale done-bar snapshot" {}))))))
        nil
        (catch clojure.lang.ExceptionInfo caught caught))]
  (check "version-bound marker revalidates a deterministic done_when race"
         (and error
              (= "stale done-bar snapshot" (.getMessage error))
              (= [41] @bases)
              (= 2 @validations)
              (false? @accepted))))

(let [attempts (atom 0)
      result
      (with-redefs
       [north.coord/append!
        (fn [& _]
          (swap! attempts inc)
          (throw (ex-info "simulated thread projection outage" {})))]
        (north.delivery-evidence-internal/best-effort-thread-projection!
         7977 "@thread-probe" "tests pass" "exit 0"))]
  (check "human thread evidence outage cannot reverse canonical run success"
         (and (nil? result) (= 1 @attempts))))

(let [error
      (try
        (north.delivery-evidence-internal/parse-request
         (apply str
                (repeat
                 (inc north.terminal-projection/max-delivery-writer-request-utf8-bytes)
                 " ")))
        nil
        (catch clojure.lang.ExceptionInfo caught caught))]
  (check "writer request byte cap rejects before JSON parsing"
         (= "delivery evidence request exceeds its UTF-8 byte limit"
            (some-> error .getMessage))))

(let [port (free-port)
      tmp (.toFile (java.nio.file.Files/createTempDirectory
                    "north-run-publication" (make-array java.nio.file.attribute.FileAttribute 0)))
      log (io/file tmp "facts.log")
      daemon (do
               (spit log "")
               (proc/process {:dir fram :out :string :err :string
                              :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"}}
                             "bb" "-cp" "out" "coord_daemon.clj"
                             "serve-flat" (str port) (.getPath log)))
      run "@run-publication-v2"
      thread "@thread-publication-v2"
      reporter "@agent:lane-probe"
      capability (apply str (repeat 64 "a"))]
  (reset! test-log (.getCanonicalPath log))
  (alter-var-root #'north.coord/expected-log
                  (constantly (fn [] @test-log)))
  (try
    (check "throwaway coordinator starts" (eventually #(port-open? port)))
    (let [partial-run "@run-failed-reservation-partial"
          fresh-run "@run-failed-reservation-recovery"]
      (north.coord/append! port partial-run "run_reservation_agent" reporter)
      (let [poisoned
            (shell "bb" run-writer (str port) partial-run
                   (json/generate-string
                    (unverified-run-payload (subs thread 1)
                                            (subs reporter (count "@agent:")))))
            recovered
            (shell "bb" run-writer (str port) fresh-run
                   (json/generate-string
                    (unverified-run-payload (subs thread 1)
                                            (subs reporter (count "@agent:")))))]
        (check "partial failed reservation cannot masquerade as telemetry"
               (and (not (zero? (:exit poisoned)))
                    (nil? (get (facts-of port partial-run) "kind"))))
        (check "fresh telemetry-only run commits after reservation failure"
               (and (zero? (:exit recovered))
                    (= "ran"
                       (north.terminal-projection/committed-run-process-outcome
                        (facts-of port fresh-run)))))))
    (let [non-thread "@factful-non-thread"
          rejected-run "@run-non-thread-reservation"]
      (north.coord/append! port non-thread "done_when" "looks thread-like")
      (let [rejected
            (shell "bb" evidence-writer (str port) "reserve"
                   (json/generate-string
                    (reserve-request rejected-run non-thread reporter capability)))]
        (check "reservation requires a title-bearing North thread"
               (and (not (zero? (:exit rejected)))
                    (empty? (facts-of port rejected-run))))))
    (let [oversized-run "@run-oversized-contract"
          oversized-thread "@thread-oversized-contract"]
      (north.coord/append! port oversized-thread "title" "Oversized contract")
      (doseq [index (range (inc north.terminal-projection/max-delivery-bars))]
        (north.coord/append! port oversized-thread "done_when"
                             (format "probe %02d" index)))
      (let [rejected
            (shell "bb" evidence-writer (str port) "reserve"
                   (json/generate-string
                    (reserve-request oversized-run oversized-thread
                                     reporter capability)))]
        (check "oversized done_when contract is rejected before partial reservation"
               (and (not (zero? (:exit rejected)))
                    (empty? (facts-of port oversized-run))))))
    (let [oversized-run "@run-oversized-bar"
          oversized-thread "@thread-oversized-bar"]
      (north.coord/append! port oversized-thread "title" "Oversized bar")
      (north.coord/append!
       port oversized-thread "done_when"
       (apply str
              (repeat (inc north.terminal-projection/max-delivery-bar-utf8-bytes)
                      "a")))
      (let [rejected
            (shell "bb" evidence-writer (str port) "reserve"
                   (json/generate-string
                    (reserve-request oversized-run oversized-thread
                                     reporter capability)))]
        (check "513-byte done_when is rejected before partial reservation"
               (and (not (zero? (:exit rejected)))
                    (empty? (facts-of port oversized-run))))))
    (let [bounded-run "@run-multibyte-boundary"
          bounded-thread "@thread-multibyte-boundary"
          bounded-capability (apply str (repeat 64 "8"))
          exact-bar (apply str (repeat 128 "🧪"))
          exact-observed
          (apply str
                 (repeat
                  north.terminal-projection/max-delivery-observed-utf8-bytes
                  "o"))]
      (north.coord/append! port bounded-thread "title" "Multibyte boundary")
      (north.coord/append! port bounded-thread "done_when" exact-bar)
      (let [reserved
            (shell "bb" evidence-writer (str port) "reserve"
                   (json/generate-string
                    (reserve-request bounded-run bounded-thread reporter
                                     bounded-capability)))
            exact
            (shell "bb" evidence-writer (str port) "record"
                   (json/generate-string
                    (record-request bounded-run bounded-thread reporter
                                    bounded-capability exact-bar exact-observed)))
            over
            (shell "bb" evidence-writer (str port) "record"
                   (json/generate-string
                    (record-request bounded-run bounded-thread reporter
                                    bounded-capability
                                    (str exact-bar "🧪") exact-observed)))
            observed-over
            (shell "bb" evidence-writer (str port) "record"
                   (json/generate-string
                    (record-request
                     bounded-run bounded-thread reporter bounded-capability
                     exact-bar (str exact-observed "o"))))]
        (check "exact multibyte bar/observation byte boundaries are accepted"
               (and (zero? (:exit reserved)) (zero? (:exit exact))
                    (= 1 (count (get (facts-of port bounded-run)
                                     "run_bar_evidence" #{})))))
        (check "one multibyte scalar over the bar limit is rejected without a record"
               (and (not (zero? (:exit over)))
                    (= 1 (count (get (facts-of port bounded-run)
                                     "run_bar_evidence" #{})))))
        (check "2049-byte observation is rejected without a record"
               (and (not (zero? (:exit observed-over)))
                    (= 1 (count (get (facts-of port bounded-run)
                                     "run_bar_evidence" #{})))))))
    (north.coord/append! port thread "title" "Publication test")
    (north.coord/append! port thread "done_when" "tests pass")
    (let [result (shell "bb" evidence-writer (str port) "reserve"
                        (json/generate-string
                         (reserve-request run thread reporter capability)))]
      (when-not (zero? (:exit result)) (binding [*out* *err*] (println (:err result))))
      (check "fresh run reservation commits before execution" (zero? (:exit result)))
      (check "reservation is singleton and digest-valid"
             (north.terminal-projection/run-reservation-valid? (facts-of port run))))
    (let [duplicate (shell "bb" evidence-writer (str port) "reserve"
                           (json/generate-string
                            (reserve-request run thread reporter capability)))]
      (check "run subject cannot be reserved twice" (not (zero? (:exit duplicate)))))
    (let [wrong-cap (shell "bb" evidence-writer (str port) "record"
                           (json/generate-string
                            (record-request run thread reporter
                                            (apply str (repeat 64 "b"))
                                            "tests pass" "24/24")))]
      (check "wrong run capability cannot author evidence" (not (zero? (:exit wrong-cap)))))
    (let [normalized-run "@run-normalized-bar"
          normalized-thread "@thread-normalized-bar"
          normalized-capability (apply str (repeat 64 "e"))]
      (north.coord/append! port normalized-thread "done_when" "  padded probe  ")
      (north.coord/append! port normalized-thread "title" "Normalized bar")
      (let [reserved
            (shell "bb" evidence-writer (str port) "reserve"
                   (json/generate-string
                    (reserve-request normalized-run normalized-thread reporter
                                     normalized-capability)))
            normalized
            (shell "bb" evidence-writer (str port) "record"
                   (json/generate-string
                    (record-request normalized-run normalized-thread reporter
                                    normalized-capability
                                    "padded probe" "normalized, exit 0")))]
        (check "normalized done-bar reservation commits" (zero? (:exit reserved)))
        (check "done-bar matching uses the same ASCII-space normalization as proof snapshots"
               (zero? (:exit normalized)))))
    (let [recorded (shell "bb" evidence-writer (str port) "record"
                          (json/generate-string
                           (record-request run thread reporter capability
                                           "tests pass" "24/24, exit 0")))
          record (json/parse-string (:out recorded))
          retried (shell "bb" evidence-writer (str port) "record"
                         (json/generate-string
                          (record-request run thread reporter capability
                                          "tests pass" "24/24, exit 0")))
          conflicting (shell "bb" evidence-writer (str port) "record"
                             (json/generate-string
                              (record-request run thread reporter capability
                                              "tests pass" "different result")))
          snapshot (v2-snapshot run thread reporter record)]
      (when-not (zero? (:exit recorded)) (binding [*out* *err*] (println (:err recorded))))
      (check "same run/bar observation retry returns the one committed record"
             (and (zero? (:exit retried))
                  (= (:out recorded) (:out retried))
                  (= 1 (count (get (facts-of port run)
                                   "run_bar_evidence" #{})))))
      (check "one-record-per-run-bar rejects a conflicting observation"
             (not (zero? (:exit conflicting))))
      (doseq [[label injected]
              [["uncited valid"
                (json/generate-string
                 (into (sorted-map)
                       (assoc record
                              "bar" "uncited extra bar"
                              "observed" "not in snapshot"
                              "recordedAt" "2026-07-18T10:00:01Z")))]
               ["malformed" "{"]
               ["duplicate bar"
                (json/generate-string
                 (into (sorted-map)
                       (assoc record
                              "observed" "second stored observation"
                              "recordedAt" "2026-07-18T10:00:02Z")))]]]
        (north.coord/append! port run "run_bar_evidence" injected)
        (let [rejected
              (shell "bb" run-writer (str port) run
                     (json/generate-string
                      (run-payload (subs thread 1)
                                   (subs reporter (count "@agent:"))
                                   snapshot)))]
          (check (str "run marker rejects " label " stored evidence")
                 (and (not (zero? (:exit rejected)))
                      (nil? (get (facts-of port run) "kind")))))
        (north.coord/retract! port run "run_bar_evidence" injected))
      (let [relabelled-map
            (-> (json/parse-string snapshot)
                (assoc "contractOrigin" "worker-defined")
                (assoc "baselineDoneWhen" []))
            relabelled (json/generate-string relabelled-map)
            rejected
            (shell "bb" run-writer (str port) run
                   (json/generate-string
                    (run-payload (subs thread 1)
                                 (subs reporter (count "@agent:"))
                                 relabelled)))]
        (check "run snapshot cannot relabel an accepted reservation as worker-defined"
               (and (not (zero? (:exit rejected)))
                    (nil? (get (facts-of port run) "kind")))))
      (north.coord/append! port thread "done_when" "late weaker bar")
      (let [changed
            (shell "bb" run-writer (str port) run
                   (json/generate-string
                    (run-payload (subs thread 1)
                                 (subs reporter (count "@agent:"))
                                 snapshot)))]
        (check "run publication rejects a changed current done-bar set"
               (and (not (zero? (:exit changed)))
                    (nil? (get (facts-of port run) "kind")))))
      (north.coord/retract! port thread "done_when" "late weaker bar")
      (let [published
            (shell "bb" run-writer (str port) run
                   (json/generate-string
                    (run-payload (subs thread 1)
                                 (subs reporter (count "@agent:"))
                                 snapshot)))
            stored (facts-of port run)]
      (when-not (zero? (:exit published)) (binding [*out* *err*] (println (:err published))))
      (check "writer-scoped run evidence records" (zero? (:exit recorded)))
      (check "v2 reported run commits with exact stored evidence" (zero? (:exit published)))
      (check "kind is the final discoverability marker"
             (= "ran"
                (north.terminal-projection/committed-run-process-outcome stored)))
      (let [reused (shell "bb" run-writer (str port) run
                          (json/generate-string
                           (run-payload (subs thread 1)
                                        (subs reporter (count "@agent:"))
                                        snapshot)))]
        (check "committed run subject reuse is rejected" (not (zero? (:exit reused)))))
      (north.coord/retract! port thread "bar_evidence"
                            "tests pass → 24/24, exit 0")
      (let [replayed
            (shell "bb" evidence-writer (str port) "record"
                   (json/generate-string
                    (record-request run thread reporter capability
                                    "tests pass" "24/24, exit 0")))]
        (check "exact post-terminal replay heals only the human projection"
               (and (zero? (:exit replayed))
                    (= (:out recorded) (:out replayed))
                    (= 1 (count (get (facts-of port run)
                                     "run_bar_evidence" #{})))
                    (= #{"tests pass → 24/24, exit 0"}
                       (get (facts-of port thread) "bar_evidence")))))
      (let [late-evidence
            (shell "bb" evidence-writer (str port) "record"
                   (json/generate-string
                    (record-request run thread reporter capability
                                    "tests pass" "late replacement")))]
        (check "terminal publication closes new writer-scoped evidence"
               (not (zero? (:exit late-evidence)))))
      (let [forged-map (assoc (json/parse-string snapshot)
                              "threadOutcome" "fabricated narrative")
            forged (json/generate-string forged-map)]
        (check "unbound narrative fields fail pure Clojure proof validation"
               (not
                (north.terminal-projection/delivery-projection-valid?
                 {"outcome" "ran" "process_outcome" "ran"
                  "delivery_outcome" "reported"
                  "delivery_reason" "complete_run_scoped_done_bar_evidence_self_reported"
                  "delivery_evidence" forged
                  "delivery_evidence_sha256"
                  (north.terminal-projection/sha256 forged)})))))
      )
    (check "shared TS/Clojure valid instant fixtures agree"
           (every? north.terminal-projection/instant?
                   (get conformance "validInstants")))
    (check "shared TS/Clojure invalid instant fixtures agree"
           (not-any? north.terminal-projection/instant?
                     (get conformance "invalidInstants")))
    (let [reservation-body (into (sorted-map) (get conformance "reservationBody"))
          reservation-facts
          (assoc (into {} (map (fn [[predicate value]]
                                 [predicate #{value}])
                               reservation-body))
                 "run_reservation_manifest_sha256"
                 #{(get conformance "reservationManifestSha256")})]
    (check "shared TS/Clojure reservation manifest digest agrees"
             (and (= (get conformance "reservationManifestSha256")
                     (north.terminal-projection/run-reservation-manifest-sha256
                      reservation-body))
                  (north.terminal-projection/run-reservation-valid?
                   reservation-facts))))
    (let [limits (get conformance "limits")]
      (check "shared TS/Clojure evidence byte and count limits agree"
             (= limits
                {"maxBars" north.terminal-projection/max-delivery-bars
                 "maxBarUtf8Bytes"
                 north.terminal-projection/max-delivery-bar-utf8-bytes
                 "maxObservedUtf8Bytes"
                 north.terminal-projection/max-delivery-observed-utf8-bytes
                 "maxEnvelopeUtf8Bytes"
                 north.terminal-projection/max-delivery-envelope-utf8-bytes
                 "maxRecordUtf8Bytes"
                 north.terminal-projection/max-run-bar-evidence-record-utf8-bytes
                 "maxReservationBaselineUtf8Bytes"
                 north.terminal-projection/max-run-reservation-baseline-utf8-bytes
                 "maxWriterRequestUtf8Bytes"
                 north.terminal-projection/max-delivery-writer-request-utf8-bytes
                 "maxThreadIdUtf8Bytes"
                 north.terminal-projection/max-delivery-thread-id-utf8-bytes
                 "maxRunIdUtf8Bytes"
                 north.terminal-projection/max-delivery-run-id-utf8-bytes
                 "maxAgentIdUtf8Bytes"
                 north.terminal-projection/max-delivery-agent-id-utf8-bytes
                 "maxAttestationUtf8Bytes"
                 north.terminal-projection/max-delivery-attestation-utf8-bytes}))
      (check "Clojure evidence bounds count multibyte UTF-8 bytes"
             (and
              (north.terminal-projection/bounded-nonblank-text?
               (apply str (repeat 128 "🧪"))
               north.terminal-projection/max-delivery-bar-utf8-bytes)
              (not
               (north.terminal-projection/bounded-nonblank-text?
                (apply str (repeat 129 "🧪"))
                north.terminal-projection/max-delivery-bar-utf8-bytes))))
      (check "shared proof text canonicalization fixtures agree"
             (every?
              (fn [case]
                (= (get case "canonical")
                   (north.terminal-projection/canonical-evidence-text
                    (get case "raw"))))
              (get conformance "textCases")))
      (check "shared thread entity grammar fixtures agree"
             (and
              (every? north.terminal-projection/valid-thread-entity?
                      (get conformance "validThreadEntities"))
              (not-any? north.terminal-projection/valid-thread-entity?
                        (get conformance "invalidThreadEntities"))))
      (check "raw done_when floods cannot collapse under the 32-bar cap"
             (nil?
              (north.terminal-projection/canonical-done-when
               {"done_when"
                (set
                 (map (fn [index]
                        (str (apply str (repeat (inc index) " "))
                             "tests pass"))
                      (range
                       (inc
                        north.terminal-projection/max-delivery-bars))))}))))
    (let [flood-run "@run-record-flood"
          flood-thread "@thread-record-flood"
          flood-capability (apply str (repeat 64 "9"))
          flood-bar "one bounded observation"]
      (north.coord/append! port flood-thread "title" "Evidence flood")
      (north.coord/append! port flood-thread "done_when" flood-bar)
      (let [reserved
            (shell "bb" evidence-writer (str port) "reserve"
                   (json/generate-string
                    (reserve-request flood-run flood-thread reporter
                                     flood-capability)))
            attempts
            (doall
             (repeatedly
              16
              #(future
                 (shell "bb" evidence-writer (str port) "record"
                        (json/generate-string
                         (record-request flood-run flood-thread reporter
                                         flood-capability flood-bar
                                         "same observed result"))))))
            results (mapv deref attempts)
            stored (get (facts-of port flood-run) "run_bar_evidence" #{})]
        (check "same-bar append flood converges to one idempotent record"
               (and (zero? (:exit reserved))
                    (every? #(zero? (:exit %)) results)
                    (= 1 (count (set (map :out results))))
                    (= 1 (count stored))))))
    (let [race-run "@run-record-conflict-race"
          race-thread "@thread-record-conflict-race"
          race-capability (apply str (repeat 64 "7"))
          race-bar "one winner only"]
      (north.coord/append! port race-thread "title" "Evidence conflict race")
      (north.coord/append! port race-thread "done_when" race-bar)
      (let [reserved
            (shell "bb" evidence-writer (str port) "reserve"
                   (json/generate-string
                    (reserve-request race-run race-thread reporter
                                     race-capability)))
            left
            (future
              (shell "bb" evidence-writer (str port) "record"
                     (json/generate-string
                      (record-request race-run race-thread reporter
                                      race-capability race-bar "left result"))))
            right
            (future
              (shell "bb" evidence-writer (str port) "record"
                     (json/generate-string
                      (record-request race-run race-thread reporter
                                      race-capability race-bar "right result"))))
            results [@left @right]
            successes (filterv #(zero? (:exit %)) results)
            stored (get (facts-of port race-run) "run_bar_evidence" #{})]
        (check "concurrent differing observations admit exactly one winner"
               (and (zero? (:exit reserved))
                    (= 1 (count successes))
                    (= 1 (count stored))
                    (= (json/parse-string (:out (first successes)))
                       (json/parse-string (first stored)))))))
    (let [worker-run "@run-worker-defined-contract"
          worker-thread "@thread-worker-defined-contract"
          worker-capability (apply str (repeat 64 "f"))
          worker-bar "worker-defined probe"]
      (north.coord/append! port worker-thread "title" "Worker-defined contract")
      (let [reserved
            (shell "bb" evidence-writer (str port) "reserve"
                   (json/generate-string
                    (reserve-request worker-run worker-thread reporter
                                     worker-capability)))]
        (check "empty starting contract reserves explicitly as worker-defined"
               (and (zero? (:exit reserved))
                    (= #{"worker-defined"}
                       (get (facts-of port worker-run)
                            "run_reservation_contract_origin")))))
      (north.coord/append! port worker-thread "done_when" worker-bar)
      (let [recorded
            (shell "bb" evidence-writer (str port) "record"
                   (json/generate-string
                    (record-request worker-run worker-thread reporter
                                    worker-capability worker-bar "exit 0")))
            record (json/parse-string (:out recorded))
            snapshot
            (worker-defined-v2-snapshot
             worker-run worker-thread reporter worker-bar record)
            published
            (shell "bb" run-writer (str port) worker-run
                   (json/generate-string
                    (run-payload (subs worker-thread 1)
                                 (subs reporter (count "@agent:"))
                                 snapshot)))]
        (check "worker-defined contract remains explicit through run commit"
               (and (zero? (:exit recorded)) (zero? (:exit published))
                    (= "ran"
                       (north.terminal-projection/committed-run-process-outcome
                        (facts-of port worker-run)))))))
    ;; Two competing publishers cannot create a valid mixed reservation. Depending
    ;; on scheduling, one wins cleanly or both observe the conflict and fail.
    (let [race-run "@run-reservation-race"
          left (future
                 (shell "bb" evidence-writer (str port) "reserve"
                        (json/generate-string
                         (reserve-request race-run thread reporter
                                          (apply str (repeat 64 "c"))))))
          right (future
                  (shell "bb" evidence-writer (str port) "reserve"
                         (json/generate-string
                          (reserve-request race-run thread "@agent:other-lane"
                                           (apply str (repeat 64 "d"))))))
          results [@left @right]
          successes (count (filter #(zero? (:exit %)) results))
          stored (facts-of port race-run)]
      (check "competing reservation publishers cannot both succeed" (<= successes 1))
      (check "a winning competing reservation is exact; a collision is invalid"
             (if (= successes 1)
               (north.terminal-projection/run-reservation-valid? stored)
               (not (north.terminal-projection/run-reservation-valid? stored)))))
    (finally
      (proc/destroy-tree daemon)
      (try @daemon (catch Exception _ nil))
      (doseq [[label ok?] @checks]
        (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
      (let [failed (remove second @checks)]
        (println (format "\n%d/%d passed"
                         (- (count @checks) (count failed))
                         (count @checks)))
        (when (seq failed) (System/exit 1))))))
