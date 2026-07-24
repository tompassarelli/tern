#!/usr/bin/env bb
;; Narrow managed writer for run-scoped done-bar evidence. The public adapter
;; supplies only bar + observation; run/thread/reporter come from the child
;; environment, and the per-run capability correlates the supported writer call
;; with the reservation committed before provider execution. This is an
;; application-integrity guard, not a same-UID security boundary: a process that
;; speaks Fram's loopback protocol directly can bypass this writer.
(ns north.delivery-evidence-internal
  (:require [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]))

(load-file (str (.getParent (io/file *file*)) "/coord.clj"))
(load-file (str (.getParent (io/file *file*)) "/terminal-projection.clj"))

(defn fail! [message data] (throw (ex-info message data)))

(defn checked! [result operation]
  (when (:reject result)
    (fail! (if (or (= :deadline (:reject result)) (:deadline result))
             "delivery evidence publication deadline exceeded"
             "coordinator rejected delivery evidence write")
           {:operation operation}))
  result)

(defn parse-request [raw]
  (let [raw (str raw)]
    (when-not
     (and (north.terminal-projection/valid-unicode-scalars? raw)
          (<= (north.terminal-projection/utf8-byte-count raw)
              north.terminal-projection/max-delivery-writer-request-utf8-bytes))
      (fail! "delivery evidence request exceeds its UTF-8 byte limit" {}))
    (try
      (let [parsed (json/parse-string raw)]
        (when-not (map? parsed)
          (fail! "delivery evidence request must be an object" {}))
        parsed)
      (catch clojure.lang.ExceptionInfo error (throw error))
      (catch Exception error
        (fail! "invalid delivery evidence JSON" {:cause (.getMessage error)})))))

(defn run-entity [raw]
  (let [value (str raw)
        canonical (if (str/starts-with? value "@") value (str "@" value))]
    (when-not (north.terminal-projection/valid-run-entity? canonical)
      (fail! "invalid delivery evidence run id" {:run raw}))
    canonical))

(defn agent-entity [raw]
  (let [value (str raw)
        canonical (if (str/starts-with? value "@") value (str "@" value))]
    (when-not (north.terminal-projection/valid-agent-entity? canonical)
      (fail! "invalid delivery evidence reporter" {:reporter raw}))
    canonical))

(defn thread-entity [raw]
  (let [value (str raw)
        canonical (if (str/starts-with? value "@") value (str "@" value))]
    (when-not (north.terminal-projection/valid-thread-entity? canonical)
      (fail! "invalid delivery evidence thread" {:thread raw}))
    canonical))

(defn facts-of [port subject]
  (let [rows (:ok (north.coord/send-op
                   port {:op :query
                         :query {:find "delivery_evidence_fact"
                                 :rules [{:head {:rel "delivery_evidence_fact"
                                                 :args [{:var "p"} {:var "r"}]}
                                          :body [{:rel "triple"
                                                  :args [subject {:var "p"} {:var "r"}]}]}]}}))]
    (reduce (fn [acc [predicate value]]
              (update acc predicate (fnil conj #{}) value))
            {}
            rows)))

(defn exact-request! [request expected-keys]
  (when-not (= expected-keys (set (keys request)))
    (fail! "delivery evidence request has an invalid shape"
           {:expected expected-keys :actual (set (keys request))})))

(defn title-bearing-thread? [facts]
  (let [titles (get facts "title" #{})]
    (and (= 1 (count titles))
         (string? (first titles))
         (not (str/blank? (first titles))))))

(defn reserve! [port request]
  (exact-request! request #{"run" "thread" "reporter" "capabilitySha256"})
  (let [run (run-entity (get request "run"))
        thread (thread-entity (get request "thread"))
        reporter (agent-entity (get request "reporter"))
        capability-digest (get request "capabilitySha256")
        thread-facts (facts-of port thread)
        baseline (north.terminal-projection/canonical-done-when thread-facts)
        contract-origin (if (seq baseline) "accepted" "worker-defined")]
    (when-not (and (string? capability-digest)
                   (re-matches #"^[0-9a-f]{64}$" capability-digest))
      (fail! "invalid run capability digest" {}))
    (when-not (title-bearing-thread? thread-facts)
      (fail! "cannot reserve delivery evidence for a non-thread subject"
             {:thread thread :titles (get thread-facts "title" #{})}))
    (when-not (vector? baseline)
      (fail! "thread done_when contract contains invalid proof text"
             {:thread thread}))
    (when-not (north.terminal-projection/bounded-done-bars? baseline true)
      (fail! "thread done_when contract exceeds delivery evidence limits"
             {:thread thread :bars (count baseline)}))
    (when (seq (facts-of port run))
      (fail! "run subject is not fresh" {:run run}))
    (let [projection
          (sorted-map
           "run_capability_sha256" capability-digest
           "run_reservation_agent" reporter
           "run_reservation_contract_origin" contract-origin
           "run_reservation_done_when" (json/generate-string baseline)
           "run_reservation_thread" thread
           "run_reservation_version"
           north.terminal-projection/run-reservation-version
           "run_reserved_at" (str (java.time.Instant/now)))
          marker
          (north.terminal-projection/run-reservation-manifest-sha256 projection)
          deadline-ns (north.coord/retry-deadline-ns)]
      (doseq [[predicate value] projection]
        (checked!
         (north.coord/retry-conflicts-until!
          deadline-ns
          #(north.coord/append! port run predicate value))
         [:append run predicate value]))
      (checked!
       (north.coord/assert-after-read!
        port run "run_reservation_manifest_sha256" marker
        (fn []
          (let [current-thread (facts-of port thread)]
            (when-not (title-bearing-thread? current-thread)
              (fail! "thread identity changed while reserving delivery evidence"
                     {:run run :thread thread}))
            (when-not (= baseline
                         (north.terminal-projection/canonical-done-when
                          current-thread))
              (fail! "thread contract changed while reserving delivery evidence"
                     {:run run :thread thread}))
            (when-not
             (north.terminal-projection/bounded-done-bars?
              (north.terminal-projection/canonical-done-when current-thread)
              true)
              (fail! "thread done_when contract exceeds delivery evidence limits"
                     {:run run :thread thread})))
          (let [stored (facts-of port run)]
            (when-not (= (into {} (map (fn [[predicate value]]
                                        [predicate #{value}])
                                      projection))
                         stored)
              (fail! "run reservation projection changed before commit"
                     {:run run :stored stored}))))
        Integer/MAX_VALUE deadline-ns)
       [:append-after-read run "run_reservation_manifest_sha256" marker])
      (let [stored (facts-of port run)]
        (when-not (and (north.terminal-projection/run-reservation-valid? stored)
                       (= (set (keys stored))
                          (conj (set (keys projection))
                                "run_reservation_manifest_sha256")))
          (fail! "run reservation lost singleton/freshness race"
                 {:run run :stored stored})))
      (println (json/generate-string
                (sorted-map "baselineDoneWhen" baseline
                            "contractOrigin" contract-origin
                            "ok" true "reporter" reporter
                            "run" run "thread" thread))))))

(defn validate-record-context!
  [port run thread reporter capability bar observed]
  (let [reservation (facts-of port run)
        evidence-state
        (north.terminal-projection/run-evidence-state
         reservation run thread reporter)]
    (when-not (north.terminal-projection/run-reservation-valid? reservation)
      (fail! "run has no valid committed reservation" {:run run}))
    (when-not (= #{reporter} (get reservation "run_reservation_agent"))
      (fail! "run reservation reporter mismatch" {:run run :reporter reporter}))
    (when-not (= #{thread} (get reservation "run_reservation_thread"))
      (fail! "run reservation thread mismatch" {:run run :thread thread}))
    (when-not (= #{(north.terminal-projection/sha256 capability)}
                 (get reservation "run_capability_sha256"))
      (fail! "run evidence capability mismatch" {:run run}))
    (when-not (:valid? evidence-state)
      (fail! "run contains malformed, cross-scoped, duplicate, or excessive evidence"
             {:run run}))
    (let [stored (:entries evidence-state)
          existing (first (filter #(= bar (get (second %) "bar")) stored))]
      ;; Exact replay remains authorized after terminal publication so the
      ;; non-authoritative human projection can be healed without mutating the
      ;; writer-scoped run evidence set.
      (if existing
        (if (= observed (get (second existing) "observed"))
          {:existing (first existing) :stored stored}
          (fail! "done-bar already has a different observation on this run"
                 {:run run :bar bar}))
        (let [active-bars
              (north.terminal-projection/canonical-done-when
               (facts-of port thread))
              baseline
              (north.terminal-projection/run-reservation-done-when reservation)
              origin
              (north.terminal-projection/singleton-value
               reservation "run_reservation_contract_origin")]
          (when (contains? reservation "kind")
            (fail! "run evidence is closed after terminal publication" {:run run}))
          (when-not
           (north.terminal-projection/bounded-done-bars? active-bars true)
            (fail! "active done_when contract exceeds delivery evidence limits"
                   {:run run :thread thread
                    :bars (if (vector? active-bars) (count active-bars) :invalid)}))
          (when (and (= "accepted" origin) (not= baseline active-bars))
            (fail! "accepted done_when contract changed during the run"
                   {:run run :thread thread}))
          (when-not (contains? (set active-bars) bar)
            (fail! "evidence bar is not an active done_when on the reserved thread"
                   {:run run :thread thread :bar bar}))
          (when (>= (count stored) north.terminal-projection/max-delivery-bars)
            (fail! "run evidence record cap reached" {:run run}))
          {:stored stored})))))

(defn commit-record-once!
  [port run thread reporter capability bar observed raw]
  (loop [remaining 16]
    (let [base (north.coord/cur-ver port)
          context
          (validate-record-context!
           port run thread reporter capability bar observed)]
      (if-let [existing (:existing context)]
        existing
        (let [result
              (north.coord/send-op
               port {:op :assert-at-version
                     :te run :p "run_bar_evidence" :r raw :base base})]
          (if (and (= :conflict (:reject result)) (> remaining 1))
            (recur (dec remaining))
            (do
              (checked! result [:append-after-read run "run_bar_evidence" raw])
              raw)))))))

(defn best-effort-thread-projection!
  [port thread bar observed]
  ;; Human review convenience only. The writer-scoped run record is the
  ;; canonical acknowledgement; a thread projection outage must not turn that
  ;; irreversible success into a false CLI failure. Its literal is
  ;; idempotent, so a safe retry may heal it.
  (try
    (north.coord/append! port thread "bar_evidence"
                         (str bar " → " observed))
    (catch Exception _ nil))
  nil)

(defn record! [port request]
  (exact-request! request
                  #{"run" "thread" "reporter" "capability" "bar" "observed"})
  (let [run (run-entity (get request "run"))
        thread (thread-entity (get request "thread"))
        reporter (agent-entity (get request "reporter"))
        capability (get request "capability")
        raw-bar (get request "bar")
        raw-observed (get request "observed")
        bar (north.terminal-projection/canonical-evidence-text raw-bar)
        observed (north.terminal-projection/canonical-evidence-text raw-observed)]
    (when-not (and (string? capability) (not (str/blank? capability)))
      (fail! "run evidence capability is missing" {}))
    (when-not
     (north.terminal-projection/bounded-nonblank-text?
      bar north.terminal-projection/max-delivery-bar-utf8-bytes)
      (fail! "done-bar must be nonblank and within its UTF-8 byte limit" {}))
    (when-not
     (north.terminal-projection/bounded-nonblank-text?
      observed north.terminal-projection/max-delivery-observed-utf8-bytes)
      (fail! "observed result must be nonblank and within its UTF-8 byte limit"
             {}))
    (let [record
          (sorted-map
           "bar" bar
           "observed" observed
           "recordedAt" (str (java.time.Instant/now))
           "reporter" reporter
           "run" run
           "thread" thread
           "version" north.terminal-projection/run-bar-evidence-version)
          raw (json/generate-string record)]
      (when-not (north.terminal-projection/run-bar-evidence-valid? record)
        (fail! "internal run evidence record failed validation" {:record record}))
      ;; One record per run/bar makes retries idempotent. The scoped writer,
      ;; active contract, open terminal, and cap checks are read under the exact
      ;; coordinator base used by the append.
      (let [committed
            (commit-record-once!
             port run thread reporter capability bar observed raw)]
      (when-not (contains? (get (facts-of port run) "run_bar_evidence" #{})
                           committed)
        (fail! "run evidence was not acknowledged" {:run run}))
      (best-effort-thread-projection! port thread bar observed)
      (println committed)))))

(defn -main []
  (let [[port-s operation raw] *command-line-args*
        port (Integer/parseInt
              (or port-s (or (System/getenv "NORTH_PORT") "7977")))
        request (parse-request (if (some? raw) raw (slurp *in*)))]
    (case operation
      "reserve" (reserve! port request)
      "record" (record! port request)
      (fail! "unsupported delivery evidence operation"
             {:operation operation}))))

(when (= *file* (System/getProperty "babashka.file"))
  (-main))
