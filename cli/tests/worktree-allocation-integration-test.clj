#!/usr/bin/env bb
(require '[babashka.fs :as fs]
         '[babashka.process :as proc]
         '[cheshire.core :as json]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def test-root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram-root (str (System/getProperty "user.home") "/code/fram"))
(def writer-path (str test-root "/cli/worktree-allocation-internal.clj"))

;; Load the writer's validators/publication functions without treating its CLI
;; usage error as a test failure. The executable path is still exercised below.
(try
  (binding [*command-line-args* []] (load-file writer-path))
  (catch clojure.lang.ExceptionInfo error
    (when-not (str/starts-with? (.getMessage error) "usage:") (throw error))))

(def checks (atom []))
(defn check [label result] (swap! checks conj [label (boolean result)]))
(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))
(defn port-open? [port]
  (try
    (with-open [socket (java.net.Socket.)]
      (.connect socket (java.net.InetSocketAddress. "127.0.0.1" (int port)) 100)
      true)
    (catch Exception _ false)))
(defn eventually [predicate]
  (loop [attempt 0]
    (cond
      (predicate) true
      (>= attempt 200) false
      :else (do (Thread/sleep 25) (recur (inc attempt))))))

(defn registration [nonce suffix]
  (let [subject (str "@worktree-allocation:" nonce)
        run (str "@run:allocation-test-" suffix)
        observed "2026-07-22T00:00:00.000Z"]
    {"version" allocation-version
     "subject" subject
     "repositoryIdentity" (str "north:git-common-dir-sha256:v1:" (apply str (repeat 64 suffix)))
     "gitCommonDir" (str "/tmp/north-allocation-" suffix "/.git")
     "sourceRoot" (str "/tmp/north-allocation-" suffix)
     "repositoryLayout" "standalone"
     "worktree" (str "/tmp/north-allocation-" suffix "-lane")
     "durableRef" (str "refs/heads/lane-allocation-" suffix)
     "baseOid" (apply str (repeat 40 suffix))
     "headOid" (apply str (repeat 40 suffix))
     "run" run
     "agent" (str "@agent:allocation-" suffix)
     "thread" "@019f8a82-3dce-7418-b2c0-fc6184fc79c6"
     "concern" "@concern-1784735694797-a27c"
     "allocationNonce" nonce
     "lease" {"version" 1
              "holder" (str "@agent:allocation-" suffix)
              "issuedAt" observed
              "expiresAt" "2026-07-22T00:30:00.000Z"
              "enforcement" "phase-1-record-only"}
     "providerAuthorityProfile" {"version" 1 "phase" "requested"
                                 "provider" "auto" "target" "unresolved"
                                 "authMode" "unresolved" "profile" "unresolved"}
     "event" {"version" 1
              "id" (str "00000000-0000-4000-8000-00000000000" suffix)
              "type" "registered" "observedAt" observed
              "resourceState" "planned" "headOid" (apply str (repeat 40 suffix))
              "run" run}}))

(defn shell [log & args]
  (apply proc/shell {:out :string :err :string :continue true
                     :extra-env {"FRAM_LOG" (.getCanonicalPath (io/file log))}}
         args))

(let [port (free-port)
      temp (.toFile (java.nio.file.Files/createTempDirectory
                    "north-worktree-allocation-ledger"
                    (make-array java.nio.file.attribute.FileAttribute 0)))
      log (io/file temp "coord.log")
      daemon (do
               (spit log "")
               (proc/process {:dir fram-root :out :string :err :string
                              :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"}}
                             "bb" "-cp" "out" "coord_daemon.clj"
                             "serve-flat" (str port) (.getCanonicalPath log)))
      first-registration (registration "11111111-1111-4111-8111-111111111111" "1")
      second-registration (registration "22222222-2222-4222-8222-222222222222" "2")
      third-registration (registration "33333333-3333-4333-8333-333333333333" "3")]
  (alter-var-root #'north.coord/expected-log
                  (constantly (fn [] (.getCanonicalPath log))))
  (try
    (check "throwaway coordinator starts" (eventually #(port-open? port)))

    (let [encoded (json/generate-string first-registration)
          committed (shell log "bb" writer-path (str port) "register" encoded)
          replayed (shell log "bb" writer-path (str port) "register" encoded)
          snapshot (facts-of port (get first-registration "subject"))
          allowed (set (concat registration-predicates
                               [marker-predicate "kind"]))]
      (check "marker-last registration commits through the executable writer"
             (and (zero? (:exit committed))
                  (= #{"worktree_allocation"} (get snapshot "kind"))
                  (= 1 (count (get snapshot marker-predicate)))
                  (= allowed (set (keys snapshot)))))
      (check "exact replay is idempotent"
             (and (zero? (:exit replayed))
                  (str/includes? (:out replayed) "exact-replay")
                  (= 1 (count (get snapshot "worktree_allocation_event")))))
      (check "registration is content-free and owns every required physical axis"
             (let [flat (pr-str snapshot)]
               (and (= #{(get first-registration "gitCommonDir")}
                       (get snapshot "worktree_git_common_dir"))
                    (= #{(get first-registration "durableRef")}
                       (get snapshot "worktree_durable_ref"))
                    (= #{(get first-registration "run")}
                       (get snapshot "worktree_allocation_run"))
                    (= #{(get first-registration "concern")}
                       (get snapshot "worktree_allocation_concern"))
                    (not (re-find #"(?i)prompt|message|transcript|content" flat))))))

    (let [subject (get first-registration "subject")
          event {"version" 1
                 "id" "44444444-4444-4444-8444-444444444444"
                 "type" "quarantined"
                 "observedAt" "2026-07-22T00:01:00.000Z"
                 "resourceState" "quarantined"
                 "headOid" (apply str (repeat 40 "1"))
                 "run" "@run:allocation-test-1"
                 "error" {"code" "worktree_dirty" "phase" "admission_rollback"}
                 "recovery" {"action" "inspect-and-salvage"
                             "resource" "/tmp/north-allocation-1-lane"
                             "durableRef" "refs/heads/lane-allocation-1"}}
          result (shell log "bb" writer-path (str port) "event" subject
                        (json/generate-string event))
          snapshot (facts-of port subject)]
      (check "queryable quarantine carries exact structured error and recovery"
             (and (zero? (:exit result))
                  (contains? (get snapshot "worktree_allocation_event")
                             (canonical-json event)))))

    (let [left (proc/process {:out :string :err :string
                              :extra-env {"FRAM_LOG" (.getCanonicalPath log)}}
                             "bb" writer-path (str port) "register"
                             (json/generate-string second-registration))
          right (proc/process {:out :string :err :string
                               :extra-env {"FRAM_LOG" (.getCanonicalPath log)}}
                              "bb" writer-path (str port) "register"
                              (json/generate-string third-registration))
          left-result @left
          right-result @right]
      (check "concurrent allocation registrations both commit without lost facts"
             (and (zero? (:exit left-result)) (zero? (:exit right-result))
                  (= #{"worktree_allocation"}
                     (get (facts-of port (get second-registration "subject")) "kind"))
                  (= #{"worktree_allocation"}
                     (get (facts-of port (get third-registration "subject")) "kind")))))

    (let [same-left (registration "66666666-6666-4666-8666-666666666666" "6")
          same-right (registration "77777777-7777-4777-8777-777777777777" "6")
          left (proc/process {:out :string :err :string
                              :extra-env {"FRAM_LOG" (.getCanonicalPath log)}}
                             "bb" writer-path (str port) "register"
                             (json/generate-string same-left))
          right (proc/process {:out :string :err :string
                               :extra-env {"FRAM_LOG" (.getCanonicalPath log)}}
                              "bb" writer-path (str port) "register"
                              (json/generate-string same-right))
          results [@left @right]
          winner (if (zero? (:exit (first results))) same-left same-right)
          loser (if (= winner same-left) same-right same-left)
          reservation-snapshot (facts-of port (reservation-subject winner))]
      (check "same-identity concurrent registration admits one nonce before Git"
             (and (= [0 1] (sort (map :exit results)))
                  (= #{(get winner "allocationNonce")}
                     (get reservation-snapshot "worktree_allocation_nonce"))
                  (= #{"worktree_allocation"}
                     (get (facts-of port (get winner "subject")) "kind"))
                  (every? empty? (vals (facts-of port (get loser "subject")))))))

    (let [failed-registration
          (registration "55555555-5555-4555-8555-555555555555" "5")
          subject (get failed-registration "subject")
          original-append north.coord/append!
          rejected
          (try
            (with-redefs [north.coord/append!
                          (fn [p s predicate value]
                            (if (= marker-predicate predicate)
                              {:reject :injected_marker_refusal}
                              (original-append p s predicate value)))]
              (register! port failed-registration))
            nil
            (catch clojure.lang.ExceptionInfo error error))]
      (check "injected commit-marker refusal rolls back every unqueryable prefix"
             (and rejected
                  (every? empty? (vals (facts-of port subject))))))
    (finally
      (proc/destroy-tree daemon)
      (try @daemon (catch Exception _ nil))
      (fs/delete-tree temp)))

  (doseq [[label passed?] @checks]
    (println (str (if passed? "✓ " "✗ ") label)))
  (when-let [failed (seq (remove second @checks))]
    (binding [*out* *err*]
      (println (str "FAILED: " (str/join ", " (map first failed)))))
    (System/exit 1)))
