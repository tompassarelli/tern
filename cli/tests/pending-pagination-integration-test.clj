#!/usr/bin/env bb
;; Real Fram + production replay-loop proof that a pending backlog larger than
;; the retired 4096 hard ceiling drains through bounded first pages.
(require '[babashka.process :as proc]
         '[clojure.java.io :as io]
         '[clojure.set :as set]
         '[clojure.string :as str])

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file")))
            "../..")))
(def fram
  (or (System/getenv "FRAM_TEST_CHECKOUT")
      (str (System/getProperty "user.home") "/code/fram")))
(def inbox-peek (str root "/cli/inbox-peek.clj"))
(System/setProperty "north.live-feed.lib" "1")
(let [test-file (System/getProperty "babashka.file")
      live-feed-file (str root "/cli/north-live-feed.clj")]
  (System/setProperty "babashka.file" live-feed-file)
  (try
    (load-file live-feed-file)
    (finally
      (System/setProperty "babashka.file" test-file))))
(System/setProperty "north.inbox-peek.lib" "1")
(let [test-file (System/getProperty "babashka.file")]
  (System/setProperty "babashka.file" inbox-peek)
  (try
    (load-file inbox-peek)
    (finally
      (System/setProperty "babashka.file" test-file))))

(def checks (atom []))
(defn check! [label value]
  (swap! checks conj [label (boolean value)]))
(defn throws-type? [expected f]
  (try
    (f)
    false
    (catch clojure.lang.ExceptionInfo error
      (= expected (:type (ex-data error))))))

(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)]
    (.getLocalPort socket)))

(defn port-open? [port]
  (try
    (with-open [socket (java.net.Socket.)]
      (.connect socket
                (java.net.InetSocketAddress. "127.0.0.1" (int port))
                100)
      true)
    (catch Exception _ false)))

(defn eventually [f]
  (loop [remaining 300]
    (cond
      (try (f) (catch Throwable _ false)) true
      (zero? remaining) false
      :else (do (Thread/sleep 20) (recur (dec remaining))))))

(defn stop-process! [process]
  (try (proc/destroy-tree process) (catch Throwable _ nil))
  (let [java-process ^Process (:proc process)]
    (when-not (.waitFor java-process 5 java.util.concurrent.TimeUnit/SECONDS)
      (.destroyForcibly java-process)
      (.waitFor java-process 5 java.util.concurrent.TimeUnit/SECONDS))))

(defn start-one-shot-server [response]
  (let [server (java.net.ServerSocket. 0)
        worker
        (future
          (try
            (with-open [socket (.accept server)
                        reader (io/reader (.getInputStream socket))
                        writer (io/writer (.getOutputStream socket))]
              (.readLine ^java.io.BufferedReader reader)
              (.write writer response)
              (.write writer "\n")
              (.flush writer))
            (finally
              (.close server))))]
    {:port (.getLocalPort server) :worker worker}))

(def backlog-size 4097)
(def recipient "page-recipient")
(defn message-id [index]
  (format "@msg:page-%05d" index))
(defn fact-line [tx subject predicate object]
  (pr-str {:tx tx :op "assert"
           :l subject :p predicate :r object :frame "fixture"}))
(defn output-indices [output]
  (mapv (comp parse-long second)
        (re-seq #"page-subject-([0-9]{5})" output)))
(defn message-index [message]
  (some->> message
           (re-matches #"@msg:page-([0-9]{5})")
           second
           parse-long))

(defn permissions [file]
  (java.nio.file.attribute.PosixFilePermissions/toString
   (java.nio.file.Files/getPosixFilePermissions
    (.toPath (io/file file))
    (make-array java.nio.file.LinkOption 0))))

(check! "direct addresses are canonical, deduplicated, and recipient-inclusive"
        (= ["page-recipient" "reviewer"]
           (north.message-audience/bounded-direct-addresses
            "page-recipient" ["reviewer" "reviewer"])))
(check! "malformed and oversized direct addresses fail before query construction"
        (and
         (throws-type?
          :invalid-direct-address
          #(north.message-audience/bounded-direct-addresses
            "page-recipient" ["bad/address"]))
         (throws-type?
          :invalid-direct-address
          #(north.message-audience/bounded-direct-addresses
            "page-recipient"
            [(apply str
                    (repeat
                     (inc north.message-audience/max-direct-address-bytes)
                     "x"))]))))
(check! "duplicate-heavy direct input is bounded by scanned elements"
        (throws-type?
         :direct-address-limit-exceeded
         #(north.message-audience/bounded-direct-addresses
           "page-recipient"
           (repeat
            (inc north.message-audience/max-direct-addresses)
            "reviewer"))))
(check! "query-page cursor validation is exact and byte-bounded"
        (and
         (north.coord/valid-query-page-cursor? "fram-query-page-v1.YQ")
         ;; Java's decoder accepts aliases whose unused tail bits are nonzero;
         ;; exact re-encoding must reject that noncanonical spelling.
         (not (north.coord/valid-query-page-cursor? "fram-query-page-v1.YR"))
         (not (north.coord/valid-query-page-cursor? "fram-query-page-v1._w"))
         (not (north.coord/valid-query-page-cursor? "fram-query-page-v1."))
         (not (north.coord/valid-query-page-cursor? "fram-query-page-v1/YQ"))
         (not (north.coord/valid-query-page-cursor?
               (str "fram-query-page-v1."
                    (apply str
                           (repeat north.coord/query-page-cursor-byte-limit
                                   "a")))))))

(with-redefs [north.coord/send-op
              (fn [_port _request]
                {:ok [] :error ["corrupt"] :version 1 :engine "index"})]
  (check! "indexed query rejects a contradictory success/error envelope"
          (throws-type?
           :malformed-indexed-query-response
           #(north.coord/indexed-query
             7977
             {:find "row"
              :rules [{:head {:rel "row" :args [{:var "e"}]}
                       :body [{:rel "triple"
                               :args [{:var "e"} "kind" "run"]}]}]}
             129))))

(let [port (free-port)
      tmp (.toFile
           (java.nio.file.Files/createTempDirectory
            "north-pending-pages"
            (make-array java.nio.file.attribute.FileAttribute 0)))
      log (io/file tmp "facts.log")
      _ (spit log
              (str
               (str/join
                "\n"
                (mapcat
                 (fn [index]
                   (let [base (* index 4)
                         message (message-id index)]
                     [(fact-line (+ base 1) message "from" "page-sender")
                      (fact-line (+ base 2) message "subject"
                                 (format "page-subject-%05d" index))
                      (fact-line (+ base 3) message "body"
                                 (format "page-body-%05d" index))
                      ;; Address last, matching the production publication edge.
                      (fact-line (+ base 4) message "to" recipient)]))
                 (range backlog-size)))
               "\n"))
      canonical-log (.getCanonicalPath log)
      daemon
      (proc/process
       {:dir fram
        :out :string
        :err :string
        :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"}}
       "bb" "-cp" "out" "coord_daemon.clj"
       "serve-flat" (str port) canonical-log)
      page-sizes (atom [])
      original-page north.message-audience/pending-message-page]
  (try
    (check! "throwaway paged coordinator starts"
            (eventually #(port-open? port)))
    ;; The PostToolUse path must not scan/materialize the whole relation before
    ;; its first byte. Run the real helper twice under the exact 2s outer
    ;; hook deadline. Distinct subjects prove the persisted deletion-safe cursor
    ;; and acknowledgements make forward progress across turns.
    (with-redefs [north.coord/expected-log (constantly canonical-log)]
      (let [_warm-page
            ;; Fram's first relational query builds its local index. Production
            ;; coordinators are long-lived; warm that engine boundary outside
            ;; the hook deadline so this bar measures North's bounded replay
            ;; path rather than one-time daemon index construction.
            (north.message-audience/pending-message-page
             port recipient #{recipient} 1 nil)
            runtime (io/file tmp "hook-runtime")
          _ (.mkdirs runtime)
          invoke
          (fn []
            (let [started (System/nanoTime)
                  result
                  (proc/shell
                   {:continue true
                    :out :string
                    :err :string
                    :extra-env {"FRAM_LOG" canonical-log
                                "XDG_RUNTIME_DIR" (.getCanonicalPath runtime)}}
                   "timeout" "--signal=TERM" "--kill-after=0.1s" "2s"
                   "bb" inbox-peek (str port) recipient)]
              (assoc result
                     :elapsed-ms
                     (/ (- (System/nanoTime) started) 1000000.0))))
          first-turn (invoke)
          second-turn (invoke)
          first-ids (output-indices (:out first-turn))
          second-ids (output-indices (:out second-turn))
          actor-key (managed-actor-key recipient)
          log-key (sha256 "north-inbox-spool-log-v1" canonical-log)
          state-root (io/file runtime "north-inbox-peek")
          state-file (io/file state-root actor-key)
          lock-file (io/file state-root (str actor-key ".lock"))
          state (when (.isFile state-file)
                  (edn/read-string (slurp state-file)))]
      (when (or (empty? first-ids) (empty? second-ids) (nil? state))
        (binding [*out* *err*]
          (println "pending hook diagnostics"
                   (pr-str
                    {:first (select-keys first-turn [:exit :elapsed-ms :out :err])
                     :second (select-keys second-turn [:exit :elapsed-ms :out :err])
                     :state-files (mapv #(.getName ^java.io.File %)
                                        (or (seq (.listFiles state-root)) []))
                     :state-summary (when state
                                      {:ids (count (:ids state))
                                       :first-id (first (:ids state))
                                       :next (:next state)})}))))
      (when (nil? state)
        (throw (ex-info "bounded hook did not persist its continuation spool"
                        {:type :missing-inbox-spool})))
      (check! ">4096 backlog emits nonempty hook context inside the first deadline"
              (and (zero? (:exit first-turn))
                   ;; GNU timeout is the child deadline. Allow a small parent-side
                   ;; process launch/reap allowance so scheduler noise cannot turn
                   ;; a correctly killed child into a flaky elapsed-time verdict.
                   (< (:elapsed-ms first-turn) 2250.0)
                   (seq first-ids)
                   (= 0 (first first-ids))))
      (check! "a second bounded hook turn advances instead of rescanning the prefix"
              (and (zero? (:exit second-turn))
                   (< (:elapsed-ms second-turn) 2250.0)
                   (seq first-ids)
                   (seq second-ids)
                   (> (first second-ids) (last first-ids))
                   (= (count second-ids) (count (distinct second-ids)))
                   (empty? (set/intersection (set first-ids)
                                             (set second-ids)))))
      (check! "each hook turn honors the 3-message and 24KiB output bounds"
              (and (<= (count first-ids) delivery-limit)
                   (<= (count second-ids) delivery-limit)
                   (<= (utf8-bytes (:out first-turn)) output-byte-limit)
                   (<= (utf8-bytes (:out second-turn)) output-byte-limit)))
      (check! "hook state uses the canonical managed actor key with no temp residue"
              (and (.isFile state-file)
                   (.isFile lock-file)
                   (empty?
                    (filter #(str/ends-with? (.getName ^java.io.File %) ".tmp")
                            (or (seq (.listFiles state-root)) [])))))
      (check! "hook directory, spool, and lock permissions are private"
              (and (.isDirectory state-root)
                   (.isFile state-file)
                   (.isFile lock-file)
                   (= "rwx------" (permissions state-root))
                   (= "rw-------" (permissions state-file))
                   (= "rw-------" (permissions lock-file))))
      (check! "spool is a strict bounded engine page, not a synthesized cursor"
              (and (= state-keys (set (keys state)))
                   (= spool-schema (:schema state))
                   (= actor-key (:actor-key state))
                   (= log-key (:log-key state))
                   (integer? (:snapshot-version state))
                   (<= (:snapshot-version state)
                       (north.coord/cur-ver port))
                   (<= (count (:ids state)) spool-page-limit)
                   (every? valid-message-id? (:ids state))
                   (= (message-id (inc (last second-ids)))
                      (first (:ids state)))
                   (valid-cursor? (:next state))))

      ;; A crash after the graph ack but before the spool rewrite leaves a stale
      ;; settled prefix. Reintroduce one exact settled ID: the next turn must
      ;; consult the graph, skip it without duplicate output, and keep advancing.
      (let [settled (message-id (first first-ids))
            crash-state
            (assoc state
                   :snapshot-version (north.coord/cur-ver port)
                   :created-at-ms (System/currentTimeMillis)
                   :ids (into [settled] (:ids state)))
            _ (atomic-write! (.toPath state-file) crash-state)
            crash-turn (invoke)
            crash-ids (output-indices (:out crash-turn))]
        (check! "settled crash residue is re-read from the graph and never re-emitted"
                (and (zero? (:exit crash-turn))
                     (seq crash-ids)
                     (not (some #{(first first-ids)} crash-ids))
                     (> (first crash-ids) (last second-ids)))))

      ;; A foreign live consumer owns the graph claim, not this cache. The hook
      ;; drops only its hint; after release, the same exact ID remains deliverable.
      (let [current (edn/read-string (slurp state-file))
            foreign-id (first (:ids current))
            single (assoc current
                          :snapshot-version (north.coord/cur-ver port)
                          :created-at-ms (System/currentTimeMillis)
                          :ids [foreign-id]
                          :next nil)
            claim (north.message-audience/claim-delivery!
                   port foreign-id recipient)
            _ (atomic-write! (.toPath state-file) single)
            blocked-turn (invoke)
            blocked-ack
            (set (north.coord/many port foreign-id "acked_by"))]
        (check! "foreign graph claim prevents cached output and acknowledgement"
                (and claim
                     (zero? (:exit blocked-turn))
                     (str/blank? (:out blocked-turn))
                     (not (contains? blocked-ack recipient))))
        (north.message-audience/release-delivery-claim! port claim)
        (atomic-write! (.toPath state-file)
                       (assoc single
                              :snapshot-version (north.coord/cur-ver port)
                              :created-at-ms (System/currentTimeMillis)))
        (let [released-turn (invoke)]
          (check! "released foreign claim leaves graph mail available to the next turn"
                  (and (zero? (:exit released-turn))
                       (str/includes?
                        (:out released-turn)
                        (format "page-subject-%05d"
                                (message-index foreign-id)))
                       (= #{recipient}
                          (set (north.coord/many port foreign-id "acked_by")))))))

      ;; Corrupt, stale, and cross-corpus files are discarded rather than used as
      ;; cursor or delivery authority. State deletion is itself directory-fsynced.
      (let [base {:schema spool-schema
                  :actor-key actor-key
                  :log-key log-key
                  :snapshot-version (north.coord/cur-ver port)
                  :created-at-ms (System/currentTimeMillis)
                  :ids [(message-id 4000)]
                  :next nil}]
        (atomic-write! (.toPath state-file)
                       (assoc base :created-at-ms
                              (- (System/currentTimeMillis)
                                 spool-max-age-ms 1)))
        (check! "stale spool is discarded without becoming graph authority"
                (and (nil? (read-spool port (.toPath state-file)
                                       actor-key log-key
                                       (System/currentTimeMillis)))
                     (not (.exists state-file))))
        (spit state-file "{")
        (check! "corrupt spool is discarded without a cursor guess"
                (and (nil? (read-spool port (.toPath state-file)
                                       actor-key log-key
                                       (System/currentTimeMillis)))
                     (not (.exists state-file))))
        (java.nio.file.Files/write
         (.toPath state-file)
         (byte-array [(byte -1)])
         (into-array java.nio.file.OpenOption
                     [java.nio.file.StandardOpenOption/CREATE_NEW
                      java.nio.file.StandardOpenOption/WRITE]))
        (check! "non-UTF-8 spool bytes are rejected rather than replacement-decoded"
                (and (nil? (read-spool port (.toPath state-file)
                                       actor-key log-key
                                       (System/currentTimeMillis)))
                     (not (.exists state-file))))
        (atomic-write! (.toPath state-file)
                       (assoc base :log-key (apply str (repeat 64 "f"))))
        (check! "foreign-corpus spool is discarded before any cached ID is read"
                (and (nil? (read-spool port (.toPath state-file)
                                       actor-key log-key
                                       (System/currentTimeMillis)))
                     (not (.exists state-file)))))

      ;; A second hook never waits out the foreground deadline behind a live
      ;; sibling. The kernel releases the lock when the holder channel closes.
      (let [entered (promise)
            release (promise)
            holder
            (future
              (with-state-lock
                (.toPath lock-file)
                (+ (System/nanoTime) 1000000000)
                #(do (deliver entered true) @release)))
            _ @entered
            ran (atom false)
            started (System/nanoTime)
            result
            (with-state-lock
              (.toPath lock-file)
              (+ (System/nanoTime) 30000000)
              #(reset! ran true))
            elapsed-ms (/ (- (System/nanoTime) started) 1000000.0)]
        (deliver release true)
        @holder
        (check! "concurrent spool lock contention is bounded and side-effect free"
                (and (nil? result) (not @ran) (< elapsed-ms 150.0))))))
    (with-redefs
      [north.coord/expected-log (constantly canonical-log)
       north.message-audience/pending-message-page
       (fn
         ([p r addresses]
          (let [page (original-page p r addresses)]
            (swap! page-sizes conj (count (:messages page)))
            page))
         ([p r addresses limit after]
          (let [page (original-page p r addresses limit after)]
            (swap! page-sizes conj (count (:messages page)))
            page)))
       deliver-message!
       (fn [p r message _control _claim-ttl _ack-timeout]
         (let [result (north.coord/append! p message "acked_by" r)]
           (when (:reject result)
             (throw (ex-info "fixture acknowledgement rejected" result)))
           :acked))]
      (let [initial
            (north.message-audience/pending-message-page
             port recipient #{recipient})]
        (check! "first real pending page is bounded"
                (and (= north.message-audience/pending-page-limit
                        (count (:messages initial)))
                     (:more initial))))
      (replay-pending!
       port recipient #{recipient}
       (java.util.concurrent.LinkedBlockingQueue.)
       30000 10000)
      (let [remaining
            (north.message-audience/pending-message-page
             port recipient #{recipient})
            acked
            (:ok
             (north.coord/send-op
              port
              {:op :query
               :query
               {:find "acked"
                :rules
                [{:head {:rel "acked" :args [{:var "e"}]}
                  :body [{:rel "fact"
                          :args [{:var "e"} "acked_by" recipient]}]}]}}))]
        (check! "production replay settles all 4097 pending messages"
                (and (empty? (:messages remaining))
                     (= backlog-size (count acked))))
        (check! "every replay query stays within the fixed page size"
                (and (> (count @page-sizes) 16)
                     (every?
                      #(<= % north.message-audience/pending-page-limit)
                      @page-sizes)))
        (check! "replay reaches a final empty first page"
                (zero? (last @page-sizes)))))
    (finally
      (stop-process! daemon))))

;; North independently enforces the page protocol at its own client boundary.
(let [{:keys [port worker]}
      (start-one-shot-server
       (apply str
              (repeat
               (inc north.coord/query-page-response-byte-limit)
               "x")))]
  (check! "North query-page client rejects one byte over the Fram page bound"
          (with-redefs [north.coord/expected-log
                        (constantly "/tmp/query-page-wire.log")]
            (throws-type?
             :coordinator-response-too-large
             #(north.coord/query-page
               port {:find "x" :rules []} 1 nil))))
  @worker)

(let [{:keys [port worker]}
      (start-one-shot-server (pr-str {:error "unknown op"}))]
  (check! "North query-page fails closed against an older coordinator"
          (with-redefs [north.coord/expected-log
                        (constantly "/tmp/query-page-wire.log")]
            (throws-type?
             :query-page-unsupported
             #(north.coord/query-page
               port {:find "x" :rules []} 1 nil))))
  @worker)

(let [response {:ok [] :more false :next nil :version 2 :engine "scan"}
      {:keys [port worker]} (start-one-shot-server (pr-str response))]
  (check! "North treats version as Fram's integer snapshot, not a protocol constant"
          (= response
             (with-redefs [north.coord/expected-log
                           (constantly "/tmp/query-page-wire.log")]
               (north.coord/query-page
                port {:find "x" :rules []} 1 nil))))
  @worker)

(doseq [[label response]
        [["non-integer snapshot version"
          {:ok [] :more false :next nil :version "2" :engine "scan"}]
         ["non-scan engine"
          {:ok [] :more false :next nil :version 2 :engine "index"}]
         ["noncanonical continuation cursor"
          {:ok [["@message"]] :more true
           :next "fram-query-page-v1.YR" :version 2 :engine "scan"}]]]
  (let [{:keys [port worker]} (start-one-shot-server (pr-str response))]
    (check! (str "North query-page rejects " label)
            (with-redefs [north.coord/expected-log
                          (constantly "/tmp/query-page-wire.log")]
              (throws-type?
               :malformed-query-page-response
               #(north.coord/query-page
                 port {:find "x" :rules []} 1 nil))))
    @worker))

(let [failures (remove second @checks)]
  (doseq [[label ok] @checks]
    (println (if ok "  [PASS] " "  [FAIL] ") label))
  (if (seq failures)
    (do
      (println "\npending pagination:" (count failures) "FAILED")
      (System/exit 1))
    (println "\npending pagination:"
             (count @checks) "/" (count @checks) "PASS")))
