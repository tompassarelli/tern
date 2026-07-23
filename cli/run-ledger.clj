(ns north.run-ledger
  (:require [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.set :as set]
            [clojure.string :as str]))

(def ^:private repo-root
  (some-> (or *file* (System/getProperty "babashka.file")) io/file .getCanonicalFile
          .getParentFile .getParentFile str))
(def contract
  (json/parse-string
   (slurp (str repo-root "/contracts/agent-run-ledger-v1.json"))))
(def version (get contract "version"))
(def event-types (vec (keys (get contract "eventTypes"))))
(def event-type-set (set event-types))
(def coverage-values (set (get contract "coverage")))

(def event-predicates
  #{"kind" "agent_run_ledger_version" "run" "thread" "agent"
    "parent_run" "parent_thread" "run_coordinator" "run_event_sequence"
    "run_event_type" "run_event_observed_at" "run_event_source"
    "run_event_coverage" "run_event_data" "run_event_sha256"
    "caveman_mode" "caveman_source"})

(defn fail! [message data] (throw (ex-info message data)))

(defn- canonical-value [value]
  (cond
    (map? value) (into (sorted-map) (map (fn [[k v]] [k (canonical-value v)])) value)
    (sequential? value) (mapv canonical-value value)
    :else value))

(defn canonical-json [value]
  (json/generate-string (canonical-value value)))

(defn sha256 [value]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        (.getBytes (str value) java.nio.charset.StandardCharsets/UTF_8))]
    (apply str (map #(format "%02x" (bit-and 0xff %)) digest))))

(def ^:private identifier-pattern #"^[A-Za-z0-9][A-Za-z0-9_.:/-]*$")
(def ^:private digest-pattern #"^[a-f0-9]{64}$")
(def ^:private entity-pattern #"^@?(?:run:[A-Za-z0-9_.:-]+|[A-Za-z0-9][A-Za-z0-9_.:-]*)$")

(defn canonical-entity [value label]
  (when-not (and (string? value) (re-matches entity-pattern value))
    (fail! (str "invalid run ledger " label) {:value value}))
  (if (str/starts-with? value "@") value (str "@" value)))

(defn validate-payload! [event-type payload]
  (let [spec (get-in contract ["eventTypes" event-type])
        allowed (set (get spec "allowed"))
        required (set (get spec "required"))
        fields (set (keys payload))
        max-length (get-in contract ["privacy" "maxIdentifierLength"])
        forbidden (get-in contract ["privacy" "forbiddenKeyFragments"])]
    (when-not spec (fail! "unsupported run ledger event type" {:type event-type}))
    (when-not (map? payload) (fail! "run ledger event payload must be an object" {}))
    (when-let [missing (seq (set/difference required fields))]
      (fail! "run ledger event payload is missing required fields" {:missing missing}))
    (when-let [extra (seq (set/difference fields allowed))]
      (fail! "run ledger event payload has unexpected fields" {:extra extra}))
    (doseq [[field value] payload
            :let [normalized (str/lower-case field)
                  kind (get-in contract ["fieldKinds" field])]]
      (when (some #(str/includes? normalized %) forbidden)
        (fail! "privacy-forbidden run ledger field" {:field field}))
      (case kind
        "count" (when-not (and (integer? value) (<= 0 value) (<= value 9007199254740991))
                  (fail! "invalid run ledger count" {:field field :value value}))
        "digest" (when-not (and (string? value) (re-matches digest-pattern value))
                   (fail! "invalid run ledger digest" {:field field}))
        "entity" (canonical-entity value field)
        "identifier" (when-not (and (string? value)
                                     (<= (count value) max-length)
                                     (re-matches identifier-pattern value))
                       (fail! "invalid run ledger identifier" {:field field}))
        (fail! "run ledger contract has an unknown field kind" {:field field :kind kind})))
    payload))

(defn- singleton-map [facts]
  (let [grouped (group-by first facts)]
    (doseq [[predicate entries] grouped]
      (when (> (count entries) 1)
        (fail! "run event predicates must be singleton"
               {:predicate predicate :values (mapv second entries)})))
    (into {} (map (fn [[predicate entries]] [predicate (second (first entries))])) grouped)))

(defn validate-event-facts! [subject facts]
  (let [unknown (seq (remove event-predicates (map first facts)))
        scalar (singleton-map facts)
        event-type (get scalar "run_event_type")
        sequence (parse-long (or (get scalar "run_event_sequence") ""))
        payload (try (json/parse-string (or (get scalar "run_event_data") ""))
                     (catch Exception error
                       (fail! "invalid run event data JSON" {:cause (.getMessage error)})))
        run (canonical-entity (get scalar "run") "run")
        thread (if (= "(ad-hoc)" (get scalar "thread"))
                 "(ad-hoc)"
                 (canonical-entity (get scalar "thread") "thread"))
        agent (get scalar "agent")
        source (get scalar "run_event_source")
        observed-at (get scalar "run_event_observed_at")
        coverage (get scalar "run_event_coverage")]
    (when unknown (fail! "run event contains unknown predicates" {:predicates unknown}))
    (when-not (= "run_event" (get scalar "kind"))
      (fail! "run event requires kind=run_event" {}))
    (when-not (= version (get scalar "agent_run_ledger_version"))
      (fail! "unsupported run ledger version" {:version (get scalar "agent_run_ledger_version")}))
    (when-not (and sequence (<= 0 sequence)) (fail! "invalid run event sequence" {}))
    (when-not (and (string? agent) (re-matches identifier-pattern agent))
      (fail! "invalid run event agent" {}))
    (when-not (and (string? source) (re-matches identifier-pattern source))
      (fail! "invalid run event source" {}))
    (when-not (coverage-values coverage) (fail! "invalid run event coverage" {}))
    (try (java.time.Instant/parse observed-at)
         (catch Exception _ (fail! "invalid run event observed_at" {})))
    (validate-payload! event-type payload)
    (let [unsigned (cond-> {"version" version
                            "run" run "thread" thread "agent" agent
                            "sequence" sequence "type" event-type
                            "observedAt" observed-at "source" source
                            "coverage" coverage "payload" payload}
                     (get scalar "caveman_mode")
                     (assoc "cavemanMode" (get scalar "caveman_mode"))
                     (get scalar "caveman_source")
                     (assoc "cavemanSource" (get scalar "caveman_source"))
                     (get scalar "parent_run")
                     (assoc "parentRun" (canonical-entity (get scalar "parent_run") "parent_run"))
                     (get scalar "parent_thread")
                     (assoc "parentThread" (canonical-entity (get scalar "parent_thread") "parent_thread"))
                     (get scalar "run_coordinator")
                     (assoc "coordinator" (get scalar "run_coordinator")))
          digest (sha256 (canonical-json unsigned))
          run-tail (str/replace run #"^@run:" "")
          expected-subject (format "@run:%s:event:%08d" run-tail sequence)]
      (when-not (= digest (get scalar "run_event_sha256"))
        (fail! "run event digest mismatch" {:expected digest}))
      (when-not (= expected-subject (canonical-entity subject "event subject"))
        (fail! "run event subject does not match its identity and digest"
               {:expected expected-subject :actual subject}))
      (assoc unsigned "subject" expected-subject "digest" digest))))

(defn timeline [run-id header events]
  (let [canonical-run (canonical-entity run-id "run")
        ordered (vec (sort-by #(get % "sequence") events))
        sequences (mapv #(get % "sequence") ordered)
        expected (vec (range (count ordered)))
        event-by-type (group-by #(get % "type") ordered)
        observations
        (mapv (fn [event-type]
                (if-let [observed (seq (get event-by-type event-type))]
                  {:type event-type :status :observed
                   :coverage (get (last observed) "coverage")
                   :source (get (last observed) "source")
                   :events (vec observed)}
                  {:type event-type :status :unknown
                   :coverage "unknown" :source "unavailable" :events []}))
              event-types)
        header-count (some-> (get header "run_event_count") parse-long)
        header-digest (get header "run_event_ledger_sha256")
        actual-digest (when (seq ordered)
                        (sha256 (canonical-json (mapv #(get % "digest") ordered))))]
    {:run canonical-run
     :thread (get header "thread")
     :agent (get header "agent")
     :parent-run (get header "parent_run")
     :parent-thread (get header "parent_thread")
     :coordinator (get header "run_coordinator")
     :events ordered
     :observations observations
     :valid-order? (= expected sequences)
     :finalized? (and (= "terminal_cleanup" (get (last ordered) "type"))
                      (= (dec (count ordered))
                         (some-> (get header "run_event_terminal_sequence") parse-long)))
     :header-count-valid? (or (nil? header-count) (= header-count (count ordered)))
     :header-digest-valid? (or (nil? header-digest) (= header-digest actual-digest))}))
