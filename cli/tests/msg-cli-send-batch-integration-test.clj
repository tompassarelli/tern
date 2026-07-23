#!/usr/bin/env bb
;; Proves msg-cli.clj's `send` verb publishes its message facts as ONE atomic
;; :assert-batch request (thread 019f9063 / incident 019f8958 -- torn mail
;; subjects), AND that it falls back cleanly to the pre-atomicity sequential
;; per-fact :assert path when the coordinator itself rejects :assert-batch as
;; unknown (the running gen-1022 daemon, before gen-1023 promotes the op).
;;
;; Two coordinators are exercised: a REAL Fram daemon (proves the batch path
;; against the actual :assert-batch wire contract) and a minimal mock socket
;; server that always answers :assert-batch with {:error "unknown op"} (proves
;; the fallback path deterministically, without depending on an old Fram
;; checkout being available).
(require '[babashka.process :as proc]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram
  (or (System/getenv "FRAM_TEST_CHECKOUT")
      (str (System/getProperty "user.home") "/code/fram")))
(def msg-cli (str root "/cli/msg-cli.clj"))
(def checks (atom []))
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

;; Real Fram daemon boot has been observed to take 20s+ under host contention
;; (thread 019f9063 progress notes cite a 5.4s+ cold port-open under load);
;; give the real-daemon-only startup check a much longer budget than the
;; ordinary in-test await-predicate above.
(defn await-daemon-boot [predicate]
  (loop [attempt 0]
    (cond (predicate) true
          (>= attempt 300) false
          :else (do (Thread/sleep 250) (recur (inc attempt))))))

(defn run-msg [port log & args]
  (apply proc/shell
         {:continue true :out :string :err :string
          :extra-env {"AGENT_TOPOLOGY" "orchestrator" "FRAM_LOG" log}}
         "bb" msg-cli (str port) args))

(defn coordinator-op [port log request]
  (with-open [socket (java.net.Socket. "127.0.0.1" (int port))]
    (.setSoTimeout socket 5000)
    (let [writer (.getOutputStream socket)
          reader (io/reader (.getInputStream socket))]
      (.write writer
              (.getBytes
               (str (pr-str {:op :for-log :expected-log log :request request}) "\n")))
      (.flush writer)
      (edn/read-string (.readLine reader)))))

(defn values-of [port log subject predicate]
  (set (:values (coordinator-op port log {:op :resolved :te subject :p predicate}))))
(defn value-of [port log subject predicate]
  (:value (coordinator-op port log {:op :resolved :te subject :p predicate})))

;; ---------------------------------------------------------------------------
;; PATH 1: real Fram daemon (gen-1023+) -- ONE :assert-batch commits the whole
;; message, including `to`, in a single all-or-none unit.
;; ---------------------------------------------------------------------------
(when-not (.isFile (io/file fram "coord_daemon.clj"))
  (throw
   (ex-info "Fram checkout not found; set FRAM_TEST_CHECKOUT or clone it beside North"
            {:fram fram})))
(let [port (free-port)
      tmp (.toFile
           (java.nio.file.Files/createTempDirectory
            "north-msg-batch" (make-array java.nio.file.attribute.FileAttribute 0)))
      facts (io/file tmp "facts.log")
      _ (spit facts "")
      log (.getCanonicalPath facts)
      daemon (proc/process
              {:dir fram :out :string :err :string
               :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"}}
              "bb" "-cp" "out" "coord_daemon.clj" "serve-flat" (str port) log)]
  (try
    (check "real Fram daemon (assert-batch-capable) starts"
           (await-daemon-boot #(port-open? port)))
    (let [result (run-msg port log "send" "producer" "recipient" "hello" "world")]
      (check "ordinary send exits clean against an assert-batch-capable daemon"
             (zero? (:exit result)))
      (check "send never emits the compat deprecation warning against a capable daemon"
             (not (str/includes? (:err result) "DEPRECATED")))
      (check "from/subject/body/sent_at/to all landed"
             (await-predicate
              #(let [e (second (re-find #"sent (@msg:\S+) ->" (:out result)))]
                 (and e
                      (= "producer" (value-of port log e "from"))
                      (= "hello" (value-of port log e "subject"))
                      (= "world" (value-of port log e "body"))
                      (seq (values-of port log e "sent_at"))
                      (= "recipient" (value-of port log e "to")))))))
    (finally
      (proc/destroy-tree daemon)
      (try @daemon (catch Exception _ nil))
      (doseq [f (reverse (file-seq tmp))] (.delete f)))))

;; ---------------------------------------------------------------------------
;; PATH 2: a mock coordinator that always rejects :assert-batch as an unknown
;; op (the exact shape a pre-gen-1023 daemon's case-dispatch default arm
;; returns) -- msg-cli must fall back to sequential per-fact :assert and still
;; complete the send, with a loud deprecation note on stderr.
;; ---------------------------------------------------------------------------
(defn mock-legacy-coordinator!
  "A minimal :for-log-fenced coordinator: :assert-batch is always unknown;
   every other op (:assert/:resolved/:version) is served from an in-memory
   single-valued fact store, matching just enough of the real wire contract
   for msg-cli's legacy fallback path to run to completion."
  [port]
  (let [server (java.net.ServerSocket. (int port))
        store (atom {})
        running? (atom true)]
    (future
      (while @running?
        (try
          (with-open [socket (.accept server)]
            (let [reader (io/reader (.getInputStream socket))
                  writer (.getOutputStream socket)
                  line (.readLine reader)
                  envelope (edn/read-string line)
                  request (:request envelope)
                  reply
                  (case (:op request)
                    :assert-batch {:error "unknown op"}
                    :version {:version (count @store)}
                    :assert (do (swap! store assoc [(:te request) (:p request)] (:r request))
                                {:ok (count @store)})
                    :resolved
                    (let [r (get @store [(:te request) (:p request)])]
                      {:value r :members (if r 1 0) :ambiguous? false
                       :values (if r [r] []) :version (count @store)})
                    {:error "unknown op"})]
              (.write writer (.getBytes (str (pr-str reply) "\n")))
              (.flush writer)))
          (catch Exception _ nil))))
    {:server server :running? running?}))

(defn stop-mock! [{:keys [server running?]}]
  (reset! running? false)
  (try (.close server) (catch Exception _ nil)))

(let [port (free-port)
      log "/tmp/north-msg-batch-mock.log"
      mock (mock-legacy-coordinator! port)]
  (try
    (check "mock legacy coordinator (pre-gen-1023) starts"
           (await-predicate #(port-open? port)))
    (let [result (run-msg port log "send" "producer" "recipient" "hello" "world")]
      (check "send against a pre-assert-batch coordinator still exits clean (legacy fallback)"
             (zero? (:exit result)))
      (check "legacy fallback logs a loud deprecation note"
             (str/includes? (:err result) "DEPRECATED"))
      (check "legacy fallback names the unsupported op and the rollout remedy"
             (and (str/includes? (:err result) "assert-batch")
                  (str/includes? (:err result) "gen-1023")))
      (check "legacy per-fact writes still land every message field"
             (let [e (second (re-find #"sent (@msg:\S+) ->" (:out result)))]
               (and e
                    (= "producer" (value-of port log e "from"))
                    (= "hello" (value-of port log e "subject"))
                    (= "world" (value-of port log e "body"))
                    (= "recipient" (value-of port log e "to"))))))
    (finally (stop-mock! mock))))

(let [results @checks
      passed (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\nmsg-cli send-batch: %d / %d PASS" passed (count results)))
  (System/exit (if (= passed (count results)) 0 1)))
