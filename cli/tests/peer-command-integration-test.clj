#!/usr/bin/env bb
;; Command-as-facts integration contract. Peer execution is deliberately
;; limited to repeat-safe tell/acquire; managed spawn/dispatch fail closed.
(require '[babashka.process :as proc]
         '[cheshire.core :as json]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram (str (System/getProperty "user.home") "/code/fram"))
(def listener-cli (str root "/cli/north-listen.clj"))
(def msg-cli (str root "/cli/msg-cli.clj"))
(def checks (atom []))
(def test-log (atom nil))

(defn check [label ok?] (swap! checks conj [label (boolean ok?)]))
(defn free-port [] (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))
(defn port-open? [port]
  (try
    (with-open [socket (java.net.Socket.)]
      (.connect socket (java.net.InetSocketAddress. "127.0.0.1" (int port)) 100)
      true)
    (catch Exception _ false)))
(defn await-predicate [predicate]
  (loop [attempt 0]
    (cond (predicate) true
          (>= attempt 200) false
          :else (do (Thread/sleep 25) (recur (inc attempt))))))

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
          result (coordinator-op port {:op :assert :te subject :p predicate :r value :base base})]
      (cond (or (:ok result) (:version result)) result
            (< attempt 10) (recur (inc attempt))
            :else (throw (ex-info "fixture fact write failed" result))))))

(defn retract-fact! [port subject predicate value]
  (loop [attempt 0]
    (let [base (:version (coordinator-op port {:op :version}))
          result (coordinator-op port {:op :retract :te subject :p predicate :r value :base base})]
      (cond (or (:ok result) (:version result)) result
            (< attempt 10) (recur (inc attempt))
            :else (throw (ex-info "fixture fact retract failed" result))))))

(defn values-of [port subject predicate]
  (set (:values (coordinator-op port {:op :resolved :te subject :p predicate}))))
(defn value-of [port subject predicate]
  (:value (coordinator-op port {:op :resolved :te subject :p predicate})))
(defn command-subjects [port]
  (set (map first
            (:ok (coordinator-op
                  port {:op :query
                        :query {:find "commands"
                                :rules [{:head {:rel "commands" :args [{:var "c"}]}
                                         :body [{:rel "triple" :args [{:var "c"} "op" {:var "o"}]}]}]}})))))

(defn command! [port id op arguments target]
  (let [subject (str "@cmd:" id)]
    (doseq [[predicate value] arguments] (assert-fact! port subject predicate value))
    (assert-fact! port subject "from" "test-producer")
    (assert-fact! port subject "op" op)
    (assert-fact! port subject "target" target)
    subject))

(defn run-msg [port & args]
  (apply proc/shell
         {:continue true :out :string :err :string
          :extra-env {"AGENT_TOPOLOGY" "orchestrator"
                      "FRAM_LOG" @test-log}}
         "bb" msg-cli (str port) args))
(defn sent-command [result]
  (second (re-find #"sent cmd (@cmd:[^ ]+)" (:out result))))

(let [port (free-port)
      self "listener-integration"
      tmp (.toFile
           (java.nio.file.Files/createTempDirectory
            "north-peer-command" (make-array java.nio.file.attribute.FileAttribute 0)))
      facts (io/file tmp "facts.log")
      listener-log (io/file tmp "listener.log")
      daemon (do
               (spit facts "")
               (proc/process {:dir fram :out :string :err :string
                              :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"
                                          "FRAM_SINGLE_VALUED"
                                          "op target from id pred value resource holder title driver retryable"}}
                             "bb" "-cp" "out" "coord_daemon.clj"
                             "serve-flat" (str port) (.getPath facts)))]
  (reset! test-log (.getCanonicalPath facts))
  (try
    (check "throwaway Fram coordinator starts" (await-predicate #(port-open? port)))
    ;; A stale generation may still have advertised unsafe operations. The next
    ;; producer call must converge vocabulary before validating the request.
    (assert-fact! port "@cmd:vocab" "known_op" "spawn")
    (let [listener (proc/process {:out listener-log :err listener-log
                                  :extra-env {"AGENT_TOPOLOGY" "orchestrator"
                                              "FRAM_LOG" @test-log}}
                                 "bb" listener-cli (str port) self "--react" "--scoped")]
      (try
        (check "listener establishes its scoped subscription"
               (await-predicate #(and (.exists listener-log)
                                      (str/includes? (slurp listener-log) "listening"))))

        (let [args {:id "@thread:peer-tell" :pred "note" :value "hello"
                    :composition {:kind "preset" :id "verifier" :overrides []}}
              first-result (run-msg port "send-cmd" "producer" self "tell" (pr-str args))
              first-command (sent-command first-result)]
          (check "tell producer accepts a repeat-safe operation" (and (zero? (:exit first-result)) first-command))
          (check "stale unsafe operation vocabulary is retracted"
                 (and (not (contains? (values-of port "@cmd:vocab" "known_op") "spawn"))
                      (= #{"tell" "acquire"} (values-of port "@cmd:vocab" "known_op"))))
          (check "tell effect and diagnostics precede terminal success"
                 (await-predicate
                  #(and (= #{"hello"} (values-of port "@thread:peer-tell" "note"))
                        (contains? (values-of port first-command "execution_status") "succeeded")
                        (seq (values-of port first-command "reply"))
                        (contains? (values-of port first-command "acked_by") self))))
          (check "structured command arguments are canonical JSON facts"
                 (= {:kind "preset" :id "verifier" :overrides []}
                    (json/parse-string (value-of port first-command "composition") true)))

          (let [second-result (run-msg port "send-cmd" "producer" self "tell" (pr-str args))
                second-command (sent-command second-result)]
            (check "two intentional identical commands receive distinct identities"
                   (and second-command (not= first-command second-command)
                        (await-predicate #(contains? (values-of port second-command "acked_by") self)))))

          (let [retry-a (run-msg port "send-cmd" "producer" self "tell" (pr-str args) "transport-retry")
                retry-b (run-msg port "send-cmd" "producer" self "tell" (pr-str args) "transport-retry")]
            (check "an explicit idempotency key gives transport retries one identity"
                   (= (sent-command retry-a) (sent-command retry-b)))))

        (let [before (command-subjects port)
              rejected (run-msg port "send-cmd" "producer" self "spawn" "{:prompt \"must-not-run\"}")]
          (check "peer spawn is rejected synchronously before command publication"
                 (and (= 2 (:exit rejected))
                      (str/includes? (:out rejected) "unknown op")
                      (= before (command-subjects port)))))

        (let [legacy (command! port "legacy-spawn" "spawn" [["prompt" "must-not-run"]] self)]
          (check "raw legacy peer spawn reaches durable non-retryable failure only"
                 (await-predicate
                  #(and (contains? (values-of port legacy "failed_by") self)
                        (= "false" (value-of port legacy "retryable"))
                        (empty? (values-of port legacy "acked_by"))
                        (some (fn [reply] (str/includes? reply "unsupported"))
                              (values-of port legacy "reply"))))))

        ;; Acquire denial is retryable. Merely writing retry intent cannot make
        ;; the command pending while failed_by remains; retry activates only by
        ;; retracting that terminal marker last.
        (assert-fact! port "@thread:peer-acquire" "title" "Peer acquire fixture")
        (assert-fact! port "@thread:peer-acquire" "driver" "@other-holder")
        (let [acquire-result (run-msg port "send-cmd" "producer" self "acquire"
                                      (pr-str {:resource "@thread:peer-acquire" :holder "retry-holder"}))
              acquire-command (sent-command acquire-result)]
          (check "contended acquire records a retryable terminal failure"
                 (await-predicate
                  #(and (contains? (values-of port acquire-command "failed_by") self)
                        (= "true" (value-of port acquire-command "retryable"))
                        (empty? (values-of port acquire-command "acked_by")))))
          (assert-fact! port acquire-command "retry_requested" "crash-seam-intent")
          (Thread/sleep 100)
          (check "retry intent alone cannot reactivate a terminal failed command"
                 (and (contains? (values-of port acquire-command "failed_by") self)
                      (= "@other-holder" (value-of port "@thread:peer-acquire" "driver"))))
          (retract-fact! port "@thread:peer-acquire" "driver" "@other-holder")
          (let [retry-result (run-msg port "retry" acquire-command)]
            (let [ok? (and (zero? (:exit retry-result))
                           (await-predicate
                            #(and (= "@retry-holder" (value-of port "@thread:peer-acquire" "driver"))
                                  (contains? (values-of port acquire-command "acked_by") self)
                                  (contains? (values-of port acquire-command "execution_status") "succeeded")
                                  (empty? (values-of port acquire-command "failed_by")))))]
              (check "explicit retry activates on the final addressed wake" ok?))))
        (finally (proc/destroy-tree listener))))
    (finally
      (proc/destroy-tree daemon)
      (doseq [file (reverse (file-seq tmp))] (io/delete-file file true)))))

(let [results @checks passed (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\npeer command integration: %d / %d PASS" passed (count results)))
  (System/exit (if (= passed (count results)) 0 1)))
