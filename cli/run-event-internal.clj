#!/usr/bin/env bb
;; Append-only AgentRun event publication. Body facts are acknowledged first;
;; kind=run_event is the last commit marker, matching run header publication.
(require '[cheshire.core :as json]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def cli-dir (.getParent (io/file (or *file* (System/getProperty "babashka.file")))))
(load-file (str cli-dir "/coord.clj"))
(load-file (str cli-dir "/run-ledger.clj"))

(defn fail! [message data] (throw (ex-info message data)))
(defn checked! [result operation]
  (when (:reject result) (fail! "coordinator rejected run event publication" {:operation operation}))
  result)

(defn fact-payload [raw]
  (let [parsed (try (json/parse-string (str raw))
                    (catch Exception error
                      (fail! "invalid run event JSON" {:cause (.getMessage error)})))]
    (when-not (sequential? parsed) (fail! "run event payload must be an array" {}))
    (mapv (fn [entry]
            (when-not (and (sequential? entry) (= 2 (count entry))
                           (every? string? entry) (every? #(not (str/blank? %)) entry))
              (fail! "run event facts must be nonblank string pairs" {:entry entry}))
            (vec entry))
          parsed)))

(defn event-entry [subject-s facts]
  (let [subject (north.run-ledger/canonical-entity subject-s "event subject")
        kind-facts (filterv #(= "kind" (first %)) facts)
        body-facts (filterv #(not= "kind" (first %)) facts)
        event (north.run-ledger/validate-event-facts! subject facts)]
    (when-not (= [["kind" "run_event"]] kind-facts)
      (fail! "run event requires exactly kind=run_event" {:kind-facts kind-facts}))
    {:subject subject :facts facts :body-facts body-facts :event event}))

(defn batch-payload [raw]
  (let [parsed (try (json/parse-string (str raw))
                    (catch Exception error
                      (fail! "invalid run event batch JSON" {:cause (.getMessage error)})))]
    (when-not (and (sequential? parsed) (seq parsed))
      (fail! "run event batch must be a nonempty array" {}))
    (let [entries
          (mapv
           (fn [entry]
             (when-not (and (map? entry)
                            (= #{"subject" "facts"} (set (keys entry))))
               (fail! "run event batch entries require only subject and facts"
                      {:entry entry}))
             (event-entry (get entry "subject")
                          (fact-payload (json/generate-string (get entry "facts")))))
           parsed)
          events (mapv :event entries)
          sequences (mapv #(get % "sequence") events)
          lineage-keys ["run" "thread" "agent" "parentRun" "parentThread"
                        "coordinator" "cavemanMode" "cavemanSource"]]
      ;; Validate the complete ordered lifecycle before the first coordinator
      ;; mutation. The writer is intentionally not a generic subset appender.
      (when-not (= sequences (vec (range (count entries))))
        (fail! "run event batch requires exact zero-based order"
               {:sequences sequences}))
      (when-not (= 1 (count (set (map #(select-keys % lineage-keys) events))))
        (fail! "run event batch lineage must remain constant" {}))
      (when-not (= "terminal_cleanup" (get (last events) "type"))
        (fail! "run event batch requires terminal_cleanup last" {}))
      (when (some #(= "terminal_cleanup" (get % "type")) (butlast events))
        (fail! "run event batch cannot contain an early terminal_cleanup" {}))
      entries)))

(defn facts-of [port subject]
  (let [rows (:ok (north.coord/send-op
                   port {:op :query
                         :query {:find "run_event_writer_fact"
                                 :rules [{:head {:rel "run_event_writer_fact"
                                                 :args [{:var "p"} {:var "r"}]}
                                          :body [{:rel "triple"
                                                  :args [subject {:var "p"} {:var "r"}]}]}]}}))]
    (reduce (fn [acc [predicate value]] (update acc predicate (fnil conj #{}) value)) {} rows)))

(defn previous-subject [{:keys [subject event]}]
  (let [sequence (get event "sequence")]
    (when (pos? sequence)
      (str (subs subject 0 (- (count subject) 8))
           (format "%08d" (dec sequence))))))

(defn publish-event! [port {:keys [subject facts body-facts event] :as entry}]
  (let [sequence (get event "sequence")
      previous-subject (when (pos? sequence)
                         (previous-subject entry))
      previous (when previous-subject (facts-of port previous-subject))]
    (when (seq (facts-of port subject))
      (fail! "run event subject reuse or partial prior publication is forbidden"
             {:subject subject}))
    (when (and previous-subject (not= #{"run_event"} (get previous "kind")))
      (fail! "run event publication requires its committed predecessor"
             {:subject subject :previous previous-subject}))
    (when (= #{"terminal_cleanup"} (get previous "run_event_type"))
      (fail! "run event publication cannot append after terminal_cleanup"
             {:subject subject :previous previous-subject}))
    (doseq [[predicate value] body-facts]
      (checked! (north.coord/put! port subject predicate value)
                [:put subject predicate value]))
    (checked!
     (north.coord/assert-after-read!
      port subject "kind" "run_event"
      (fn []
        (let [stored (facts-of port subject)]
          (when (contains? stored "kind")
            (fail! "run event became committed during publication" {}))
          (doseq [[predicate value] body-facts]
            (when-not (= #{value} (get stored predicate))
              (fail! "run event readback conflicts with submitted projection"
                     {:predicate predicate})))
          (north.run-ledger/validate-event-facts! subject facts))))
     [:assert-after-read subject "kind" "run_event"])
    (when-not (= #{"run_event"} (get (facts-of port subject) "kind"))
      (fail! "run event commit marker lost singleton race" {:subject subject}))
    {:subject subject :sequence sequence}))

(defn publish-events! [port entries]
  ;; A stale or torn subject aborts the whole batch before any new body write.
  (doseq [{:keys [subject]} entries]
    (when (seq (facts-of port subject))
      (fail! "run event batch subject reuse or partial prior publication is forbidden"
             {:subject subject})))
  (mapv #(publish-event! port %) entries))

(defn -main [& args]
  (let [[port-s first-arg second-arg] args
        port (Integer/parseInt (or port-s (or (System/getenv "NORTH_PORT") "7977")))
        entries
        (case (count args)
          2 (batch-payload first-arg)
          3 [(event-entry first-arg (fact-payload second-arg))]
          (fail! "usage: run-event-internal.clj PORT BATCH_JSON or PORT SUBJECT FACTS_JSON"
                 {:argc (count args)}))
        published (publish-events! port entries)]
    (println (json/generate-string
              {:ok true
               :count (count published)
               :firstSequence (:sequence (first published))
               :lastSequence (:sequence (last published))}))))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
