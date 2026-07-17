#!/usr/bin/env bb
;; Harness-owned run telemetry publication. A fresh @run subject is invisible to
;; every run consumer until `kind=run` lands LAST. All preceding fact writes are
;; acknowledged durable coordinator operations in one writer process; a crash or
;; rejection leaves an undiscoverable partial subject instead of a false run row.
(require '[cheshire.core :as json]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))

(def safe-run-id #"^@?run-[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$")

(defn fail! [message data] (throw (ex-info message data)))

(defn checked! [result operation]
  (when (:reject result)
    (fail! "coordinator rejected run telemetry publication" {:operation operation}))
  result)

(defn entity [subject]
  (let [raw (str subject)]
    (when-not (re-matches safe-run-id raw)
      (fail! "invalid run telemetry subject" {:subject subject}))
    (if (str/starts-with? raw "@") raw (str "@" raw))))

(defn payload [raw]
  (let [parsed (try (json/parse-string (str raw))
                    (catch Exception error
                      (fail! "invalid run telemetry JSON" {:cause (.getMessage error)})))]
    (when-not (sequential? parsed)
      (fail! "run telemetry payload must be an array" {}))
    (mapv (fn [entry]
            (when-not (and (sequential? entry) (= 2 (count entry))
                           (every? string? entry)
                           (every? #(not (str/blank? %)) entry))
              (fail! "run telemetry facts must be nonblank string pairs" {:entry entry}))
            (vec entry))
          parsed)))

(let [[port-s subject-s raw] *command-line-args*
      port (Integer/parseInt (or port-s (or (System/getenv "NORTH_PORT") "7977")))
      subject (entity subject-s)
      facts (payload raw)
      kind-facts (filterv #(= "kind" (first %)) facts)
      body-facts (filterv #(not= "kind" (first %)) facts)]
  (when-not (= [["kind" "run"]] kind-facts)
    (fail! "run telemetry requires exactly kind=run" {:kind-facts kind-facts}))
  (doseq [[predicate value] body-facts]
    (checked! (north.coord/put! port subject predicate value)
              [:put subject predicate value]))
  ;; `kind` is the publication/commit marker. Existing consumers already begin
  ;; from this predicate, so no reader migration or torn-subject compatibility
  ;; branch is needed.
  (checked! (north.coord/put! port subject "kind" "run")
            [:put subject "kind" "run"])
  (println (json/generate-string {:ok true :subject subject :facts (count facts)})))
