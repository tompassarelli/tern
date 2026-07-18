#!/usr/bin/env bb
;; Integration regression for the canonical dispatch-driver claim protocol. Every
;; assertion runs against an isolated Fram coordinator rather than a mocked command.
(require '[babashka.process :as proc]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram (str (System/getProperty "user.home") "/code/fram"))
(def acquire-cli (str root "/cli/acquire-cli.clj"))
(def checks (atom []))
(def test-log (atom nil))

(defn check [label ok?]
  (swap! checks conj [label (boolean ok?)]))

(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)]
    (.getLocalPort socket)))

(defn port-open? [port]
  (try
    (with-open [socket (java.net.Socket.)]
      (.connect socket (java.net.InetSocketAddress. "127.0.0.1" (int port)) 100)
      true)
    (catch Exception _ false)))

(defn await-up [port]
  (loop [attempt 0]
    (cond
      (port-open? port) true
      (>= attempt 100) false
      :else (do (Thread/sleep 50) (recur (inc attempt))))))

(defn coordinator-op [port request]
  (with-open [socket (java.net.Socket. "127.0.0.1" (int port))]
    (.setSoTimeout socket 5000)
    (let [writer (.getOutputStream socket)
          reader (io/reader (.getInputStream socket))]
      (.write writer
              (.getBytes
               (str (pr-str {:op :for-log
                             :expected-log @test-log
                             :request request})
                    "\n")))
      (.flush writer)
      (edn/read-string (.readLine reader)))))

(defn assert-fact! [port subject predicate value]
  (loop [attempt 0]
    (let [base (:version (coordinator-op port {:op :version}))
          result (coordinator-op port {:op :assert
                                       :te subject
                                       :p predicate
                                       :r value
                                       :base base})]
      (cond
        (or (:ok result) (:version result)) result
        (< attempt 5) (recur (inc attempt))
        :else (throw (ex-info "fixture fact write failed" result))))))

(defn resolved [port subject predicate]
  (:value (coordinator-op port {:op :resolved :te subject :p predicate})))

(defn acquire [port verb thread holder]
  (proc/shell {:continue true :out :string :err :string
               :extra-env {"FRAM_LOG" @test-log}}
              "bb" acquire-cli (str port) verb thread holder))

(defn scripted-coordinator [responses]
  (let [server (java.net.ServerSocket. 0)
        requests (atom [])
        worker
        (future
          (try
            (doseq [response responses]
              (with-open [socket (.accept server)
                          reader (io/reader (.getInputStream socket))
                          writer (io/writer (.getOutputStream socket))]
                (swap! requests conj (edn/read-string (.readLine reader)))
                (.write writer (str (pr-str response) "\n"))
                (.flush writer)))
            :done
            (finally (.close server))))]
    {:port (.getLocalPort server)
     :requests requests
     :worker worker
     :server server}))

(let [port (free-port)
      tmp (.toFile
           (java.nio.file.Files/createTempDirectory
            "north-acquire-claim" (make-array java.nio.file.attribute.FileAttribute 0)))
      log (io/file tmp "facts.log")
      thread-id "019f75a8-032c-741a-b65d-e4af097e3837"
      thread (str "@" thread-id)
      unknown-id "019f75a8-032c-741a-b65d-e4af097e3838"
      unknown (str "@" unknown-id)
      first-holder "agent:first"
      second-holder "agent:second"
      daemon-env {"FRAM_REQUIRE_LOG_FENCE" "1"
                  "FRAM_SINGLE_VALUED" "title driver"}
      daemon (do
               (spit log "")
               (proc/process {:dir fram
                              :out :string
                              :err :string
                              :extra-env daemon-env}
                             "bb" "-cp" "out" "coord_daemon.clj"
                             "serve-flat" (str port) (.getPath log)))]
  (reset! test-log (.getCanonicalPath log))
  (try
    (let [started? (await-up port)]
      (check "throwaway Fram coordinator starts" started?)
      (when-not started?
        (throw (ex-info "throwaway Fram coordinator did not start"
                        {:stdout (deref (:out daemon))
                         :stderr (deref (:err daemon))})))

      (let [missing (acquire port "claim" unknown-id first-holder)]
        (check "claiming an unknown thread exits 4"
               (and (= 4 (:exit missing))
                    (str/includes? (:out missing) "thread does not exist")))
        (check "unknown-thread claim creates no driver"
               (nil? (resolved port unknown "driver"))))

      (assert-fact! port thread "title" "Claim integration fixture")
      (let [first-claim (acquire port "claim" thread-id first-holder)]
        (check "a bare UUID claim resolves the canonical @UUID subject"
               (and (zero? (:exit first-claim))
                    (str/includes? (:out first-claim) "CLAIMED")
                    (str/includes? (:out first-claim) thread)
                    (= (str "@" first-holder) (resolved port thread "driver")))))

      (let [duplicate (acquire port "claim" thread first-holder)]
        (check "an @UUID duplicate reaches the same subject and exits 3"
               (and (= 3 (:exit duplicate))
                    (str/includes? (:out duplicate) "already driven")
                    (= (str "@" first-holder) (resolved port thread "driver")))))

      (let [exact (acquire port "verify" thread-id first-holder)
            wrong (acquire port "verify" thread second-holder)]
        (check "verify succeeds only for the exact holder"
               (and (zero? (:exit exact))
                    (str/includes? (:out exact) "VERIFIED")
                    (= 3 (:exit wrong))
                    (str/includes? (:out wrong) "handoff mismatch")
                    (= (str "@" first-holder) (resolved port thread "driver")))))

      (let [first-release (acquire port "release" thread first-holder)
            second-release (acquire port "release" thread-id first-holder)]
        (check "release is idempotent and leaves no driver"
               (and (zero? (:exit first-release))
                    (str/includes? (:out first-release) "released")
                    (zero? (:exit second-release))
                    (str/includes? (:out second-release) "noop")
                    (nil? (resolved port thread "driver")))))

      (let [reclaim (acquire port "claim" thread-id second-holder)]
        (check "a second holder can claim after release"
               (and (zero? (:exit reclaim))
                    (str/includes? (:out reclaim) "CLAIMED")
                    (= (str "@" second-holder) (resolved port thread "driver")))))

      (let [malformed (acquire port "claim" (str "@" thread) first-holder)]
        (check "double-@ input is rejected before any graph mutation"
               (and (= 2 (:exit malformed))
                    (str/includes? (:err malformed) "invalid thread id")
                    (= (str "@" second-holder) (resolved port thread "driver"))))))
    (finally
      (proc/destroy-tree daemon)
      (doseq [file (reverse (file-seq tmp))]
        (io/delete-file file true)))))

(let [thread-id "019f75a8-032c-741a-b65d-e4af097e3837"
      first-holder "agent:first"
      second-holder "agent:second"
      scripted (scripted-coordinator
                [{:version 10}
                 {:value (str "@" first-holder)}
                 {:reject :conflict}
                 {:version 11}
                 {:value (str "@" second-holder)}])
      release (acquire (:port scripted) "release" thread-id first-holder)
      completed (deref (:worker scripted) 5000 :timeout)
      envelopes @(:requests scripted)
      requests (mapv :request envelopes)
      retracts (filter #(= :retract (:op %)) requests)]
  (when (= :timeout completed)
    (.close (:server scripted)))
  (check "release retries a snapshot conflict and preserves the successor"
         (and (= :done completed)
              (zero? (:exit release))
              (str/includes? (:out release) "noop")
              (str/includes? (:out release) (str "driver=@" second-holder))
              (every? #(= {:op :for-log
                           :expected-log @test-log}
                          (select-keys % [:op :expected-log]))
                      envelopes)
              (= 1 (count retracts))
              (= {:op :retract
                  :te (str "@" thread-id)
                  :p "driver"
                  :r (str "@" first-holder)
                  :base 10}
                 (first retracts)))))

(let [port (free-port)
      unavailable (acquire port "release"
                           "019f75a8-032c-741a-b65d-e4af097e3837"
                           "agent:first")]
  (check "release exits nonzero when safe ownership verification is unavailable"
         (and (= 5 (:exit unavailable))
              (str/includes? (:err unavailable) "safe release unavailable"))))

(let [results @checks
      passed (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\nacquire claim integration: %d / %d PASS" passed (count results)))
  (System/exit (if (= passed (count results)) 0 1)))
