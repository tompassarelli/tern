#!/usr/bin/env bb
;; Real Fram socket gate for north.coord/assert-after-read!.
;;
;; A mocked :reject cannot prove the global read→commit seam: ordinary Fram
;; :assert uses :base only as local OCC on declared-single predicates. This test
;; starts the real daemon containing :assert-at-version and proves that a write
;; to an unrelated fact invalidates the callback's snapshot, while an
;; uncontested retry commits a MULTI marker.
(require '[babashka.process :as proc]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file *file*)) "../..")))
(def fram
  (.getCanonicalPath
   (io/file (or (System/getenv "FRAM_PATH")
                (str root "/../fram")))))
(when-not (.isFile (io/file fram "coord_daemon.clj"))
  (throw
   (ex-info
    "Fram checkout not found; set FRAM_PATH or clone it beside North"
    {:fram fram})))
(load-file (str root "/cli/coord.clj"))

(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)]
    (.getLocalPort socket)))

(defn port-open? [port]
  (try
    (with-open [socket (java.net.Socket. "127.0.0.1" (int port))]
      true)
    (catch Exception _ false)))

(defn eventually [f]
  (loop [remaining 200]
    (cond
      (try (f) (catch Exception _ false)) true
      (zero? remaining) false
      :else (do (Thread/sleep 25) (recur (dec remaining))))))

(let [port (free-port)
      dir (.toFile
           (java.nio.file.Files/createTempDirectory
            "north-assert-after-read"
            (make-array java.nio.file.attribute.FileAttribute 0)))
      log (io/file dir "facts.log")
      _ (spit log "")
      split-log (io/file dir "coordination.log")
      _ (spit split-log "")
      explicit-log-probe
      (proc/shell
       {:out :string :err :string :continue true
        :extra-env {"FRAM_LOG" (.getCanonicalPath log)}}
       "bb" "-e"
      (str "(load-file " (pr-str (str root "/cli/coord.clj")) ")"
            "(print (north.coord/expected-log))"))
      _ (io/delete-file split-log true)
      daemon
      (proc/process
       {:dir fram :out :string :err :string
        :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"}}
       "bb" "-cp" "out" "coord_daemon.clj" "serve-flat"
       (str port) (.getPath log))
      checks (atom [])
      check! (fn [label value]
               (swap! checks conj [label (boolean value)]))]
  (alter-var-root #'north.coord/expected-log
                  (constantly (fn [] (.getCanonicalPath log))))
  (try
    (check! "explicit FRAM_LOG wins over a sibling coordination.log"
            (and (zero? (:exit explicit-log-probe))
                 (= (.getCanonicalPath log)
                    (str/trim (:out explicit-log-probe)))))
    (check! "real Fram daemon starts"
            (eventually #(port-open? port)))

    (let [validations (atom 0)
          result
          (north.coord/assert-after-read!
           port "@run-revalidated" "run_bar_evidence" "record"
           (fn []
             ;; The first callback mutates an unrelated group after BASE was
             ;; captured. The real global assertion must reject that snapshot;
             ;; the second callback performs no write and may commit.
             (when (= 1 (swap! validations inc))
               (north.coord/append!
                port "@unrelated" "unrelated_predicate" "moved"))))]
      (check! "unrelated write forces real callback revalidation"
              (= 2 @validations))
      (check! "fresh uncontested retry commits a MULTI marker"
              (and (:ok result)
                   (= #{"record"}
                      (set (north.coord/many
                            port "@run-revalidated"
                            "run_bar_evidence"))))))

    (let [running? (atom true)
          churn-writes (atom 0)
          validations (atom 0)
          writer
          (future
            (while @running?
              (north.coord/append!
               port "@unrelated-churn" "noise"
               (str (swap! churn-writes inc)))
              (Thread/sleep 10)))
          started (System/nanoTime)
          results
          (try
            (Thread/sleep 50)
            (mapv
             (fn [index]
               (north.coord/assert-after-read!
                port (str "@run-churn-" index) "run_bar_evidence" "record"
                #(swap! validations inc)))
             (range 500))
            (finally
              (reset! running? false)
              @writer))
          elapsed-seconds (/ (- (System/nanoTime) started) 1e9)
          observed-rate (/ @churn-writes elapsed-seconds)]
      (println
       (format "  [METRIC] unrelated churn %.1f writes/s · %d writes · %d marker attempts · %d validations"
               observed-rate @churn-writes (count results) @validations))
      (check! "16 retries sustain measured unrelated-writer churn"
              (and (>= @churn-writes 10)
                   (every? :ok results))))

    (let [validations (atom 0)
          result
          (north.coord/assert-after-read!
           port "@reserved-rejection" "name" "forbidden"
           #(swap! validations inc))]
      (check! "fixed rule/schema rejection is not retried"
              (and (= 1 @validations)
                   (vector? (:reject result)))))

    (let [validations (atom 0)
          result
          (north.coord/assert-after-read!
           port "@run-starved" "run_bar_evidence" "must-not-land"
           (fn []
             ;; Move a distinct unrelated fact on every bounded attempt.
             (let [attempt (swap! validations inc)]
               (north.coord/append!
                port "@continuous-writer" "noise" (str attempt)))))]
      (check! "continuous graph movement exhausts the bounded retry budget"
              (and (= 16 @validations)
                   (= :conflict (:reject result))))
      (check! "a rejected stale marker never lands"
              (empty?
               (set (north.coord/many
                     port "@run-starved" "run_bar_evidence")))))

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
