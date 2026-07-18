#!/usr/bin/env bb
;; Finite broadcast audience contract across msg inbox, the PostToolUse peek,
;; and the live listener. Uses a throwaway coordinator: no live North state.
(require '[babashka.process :as proc]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram (str (System/getProperty "user.home") "/code/fram"))
(def msg-cli (str root "/cli/msg-cli.clj"))
(def peek-cli (str root "/cli/inbox-peek.clj"))
(def listener-cli (str root "/cli/north-listen.clj"))
(def presence-cli (str root "/cli/presence-cli.clj"))
(def north-wrapper (str root "/bin/north"))
(def north-arm (str root "/bin/north-arm"))
(def checks (atom []))
(def children (atom []))
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
          (>= attempt 240) false
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
  (let [result (coordinator-op port {:op :assert :te subject :p predicate :r value})]
    (when (:reject result)
      (throw (ex-info "fixture fact write failed" result)))
    result))
(defn values-of [port subject predicate]
  (set (:values (coordinator-op port {:op :resolved :te subject :p predicate}))))
(defn run-cli [path port & args]
  (apply proc/shell {:continue true :out :string :err :string
                     :extra-env {"FRAM_LOG" @test-log}}
         "bb" path (str port) args))
(defn run-msg [port & args] (apply run-cli msg-cli port args))
(defn register! [port handle]
  (run-cli presence-cli port "register" handle (str "/tmp/" handle) handle))
(defn sent-subject [result]
  (second (re-find #"sent (@msg:[^ ]+)" (:out result))))
(defn inbox-has? [port handle subject]
  (str/includes? (:out (run-msg port "inbox" handle)) subject))
(defn start-listener! [port handle log & flags]
  (let [child (apply proc/process {:out log :err log
                                   :extra-env {"FRAM_LOG" @test-log}}
                     "bb" listener-cli (str port) handle flags)]
    (swap! children conj child)
    child))
(defn log-has? [file text]
  (and (.exists (io/file file)) (str/includes? (slurp file) text)))
(defn mail-count [file]
  (count (re-seq #"(?m)^✉  MAIL " (if (.exists (io/file file)) (slurp file) ""))))
(defn stop-child! [child]
  (when child
    (try (proc/destroy-tree child) (catch Exception _ nil))
    (swap! children (fn [xs] (vec (remove #(identical? % child) xs))))))

(let [port (free-port)
      tmp (.toFile
           (java.nio.file.Files/createTempDirectory
            "north-message-audience" (make-array java.nio.file.attribute.FileAttribute 0)))
      facts (io/file tmp "facts.log")
      daemon (do
               (spit facts "")
               (proc/process
                {:dir fram :out :string :err :string
                 :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"
                             "FRAM_SINGLE_VALUED"
                             "from subject body sent_at to acked_at broadcast_audience_version agent dir session_id started_at"}}
                "bb" "-cp" "out" "coord_daemon.clj"
                "serve-flat" (str port) (.getPath facts)))]
  (reset! test-log (.getCanonicalPath facts))
  (try
    (check "throwaway Fram coordinator starts" (await-predicate #(port-open? port)))
    (check "north listen wrapper acknowledges before its one-shot exit"
           (str/includes? (slurp north-wrapper)
                          "north-listen.clj\" 7977 \"${2:?usage: north listen <agent-id>}\" --once --ack"))
    (check "north-arm acknowledges before its one-shot exit"
           (str/includes? (slurp north-arm)
                          "north-listen.clj\" 7977 \"${1:?usage: north-arm <agent-id>}\" --once --ack"))
    (doseq [handle ["sender" "alice" "bob"]]
      (check (str handle " has a live session lease")
             (zero? (:exit (register! port handle)))))

    ;; A live listener and an inbox-only recipient are both frozen into the same
    ;; send-time snapshot. The sender is explicitly excluded.
    (let [bob-log (io/file tmp "bob-once.log")
          bob-listener (start-listener! port "bob" bob-log "--once" "--ack" "--scoped")]
      (check "live listener establishes scoped subscription"
             (await-predicate #(log-has? bob-log "listening")))
      (let [result (run-msg port "send" "sender" "*" "snapshot-one" "finite audience")
            message (sent-subject result)]
        (check "broadcast send succeeds" (and (zero? (:exit result)) message))
        (check "send reports finite sender-excluding snapshot"
               (str/includes? (:out result) "2 snapshotted recipients; sender excluded"))
        (check "broadcast facts name exactly the then-live peers"
               (= #{"alice" "bob"} (values-of port message "broadcast_to")))
        (check "broadcast contract is versioned"
               (= #{"snapshot-v1"} (values-of port message "broadcast_audience_version")))
        (check "sender cannot consume its own broadcast"
               (not (inbox-has? port "sender" "snapshot-one")))
        (check "inbox consumer sees an eligible unacked broadcast"
               (inbox-has? port "alice" "snapshot-one"))
        (check "live listener receives and acks exactly once"
               (await-predicate
                #(and (log-has? bob-log "snapshot-one")
                      (= #{"bob"} (values-of port message "acked_by")))))
        (check "one trigger produces one live delivery" (= 1 (mail-count bob-log)))
        (let [bob-peek (run-cli peek-cli port "bob")]
          (check "listener acknowledgement prevents PostToolUse redelivery"
                 (and (zero? (:exit bob-peek)) (str/blank? (:out bob-peek)))))
        (let [first-peek (run-cli peek-cli port "alice")
              second-peek (run-cli peek-cli port "alice")]
          (check "PostToolUse peek prints then acks eligible broadcast"
                 (and (zero? (:exit first-peek))
                      (str/includes? (:out first-peek) "snapshot-one")
                      (str/includes? (:out first-peek) "finite audience")))
          (check "PostToolUse peek does not repeat acknowledged mail"
                 (and (zero? (:exit second-peek)) (str/blank? (:out second-peek))))
          (check "ack set is bounded by the finite audience"
                 (= #{"alice" "bob"} (values-of port message "acked_by"))))

        ;; A session first appearing after the send can neither discover nor
        ;; manually acknowledge that old broadcast.
        (check "future session registers"
               (zero? (:exit (register! port "charlie"))))
        (check "future session never discovers an old broadcast"
               (not (inbox-has? port "charlie" "snapshot-one")))
        (let [rejected (run-msg port "ack" "charlie" message)]
          (check "manual ack cannot grow the audience"
                 (and (= 2 (:exit rejected))
                      (str/includes? (:out rejected) "not addressed")
                      (= #{"alice" "bob"} (values-of port message "acked_by")))))
        (stop-child! bob-listener)))

    ;; Legacy wildcard messages have no broadcast_to facts. Even a live scoped
    ;; listener receives the transport trigger but must ignore it and remain
    ;; armed until legitimately addressed.
    (let [charlie-log (io/file tmp "charlie-legacy.log")
          charlie-listener (start-listener! port "charlie" charlie-log "--once" "--ack" "--scoped")
          legacy "@msg:legacy-wildcard"]
      (check "legacy fixture listener establishes subscription"
             (await-predicate #(log-has? charlie-log "listening")))
      (doseq [[predicate value] [["from" "legacy-sender"]
                                 ["subject" "immortal-legacy"]
                                 ["body" "must stay inert"]
                                 ["sent_at" "2026-07-16T00:00:00Z"]]]
        (assert-fact! port legacy predicate value))
      (assert-fact! port legacy "to" "*")
      (Thread/sleep 150)
      (check "audience-less legacy wildcard is not delivered or acked"
             (and (not (log-has? charlie-log "immortal-legacy"))
                  (empty? (values-of port legacy "acked_by"))
                  (not (inbox-has? port "charlie" "immortal-legacy"))))
      (let [direct (run-msg port "send" "sender" "charlie" "direct-after-legacy" "wake")]
        (check "ignored legacy event does not disarm --once listener"
               (and (zero? (:exit direct))
                    (await-predicate #(log-has? charlie-log "direct-after-legacy"))
                    (= 1 (mail-count charlie-log)))))
      (stop-child! charlie-listener))

    ;; The live listener and several PostToolUse peek processes race on the same
    ;; direct message immediately after each `to` commit. The coordinator claim
    ;; must elect one printer; acked_by alone would leave a query-then-ack hole.
    (check "racer has a live session lease"
           (zero? (:exit (register! port "racer"))))
    (let [racer-log (io/file tmp "racer-simultaneous.log")
          racer-listener (start-listener! port "racer" racer-log "--ack" "--scoped")]
      (check "simultaneous-delivery listener is armed"
             (await-predicate #(log-has? racer-log "listening")))
      (let [rounds
            (mapv
             (fn [i]
               (let [token (str "simultaneous-" i "-" (java.util.UUID/randomUUID))
                     send-result (run-msg port "send" "sender" "racer" token "simultaneous body")
                     message (sent-subject send-result)
                     peeks (mapv (fn [_]
                                   (proc/process {:out :string :err :string
                                                  :extra-env {"FRAM_LOG" @test-log}}
                                                 "bb" peek-cli (str port) "racer"))
                                 (range 4))
                     peek-results (mapv deref peeks)]
                 {:token token :message message
                  :send-result send-result :peek-results peek-results}))
             (range 24))]
        (check "simultaneous send and peek processes all exit cleanly"
               (every? (fn [{:keys [send-result message peek-results]}]
                         (and message
                              (zero? (:exit send-result))
                              (every? #(zero? (:exit %)) peek-results)))
                       rounds))
        (check "every raced message reaches one durable acknowledgement"
               (await-predicate
                #(every? (fn [{:keys [message]}]
                           (= #{"racer"} (values-of port message "acked_by")))
                         rounds)))
        (let [listener-output (slurp racer-log)]
          (check "listener-vs-PostToolUse races print every message exactly once"
                 (every?
                  (fn [{:keys [token peek-results]}]
                    (= 1
                       (+ (count (re-seq (re-pattern (java.util.regex.Pattern/quote token))
                                         listener-output))
                          (reduce +
                                  (map #(count
                                         (re-seq
                                          (re-pattern (java.util.regex.Pattern/quote token))
                                          (:out %)))
                                       peek-results)))))
                  rounds))))
      (stop-child! racer-listener))
    (check "racer lease is retired before broadcast snapshot stress"
           (zero? (:exit (run-cli presence-cli port "forget" "racer"))))

    ;; Concurrent producers publish multiple complete snapshots while three
    ;; scoped listeners are armed. Every eligible listener acks each message
    ;; once; no sender/future identity can enlarge any ack set.
    (let [handles ["alice" "bob" "charlie"]
          listener-pairs
          (mapv (fn [handle]
                  (let [log (io/file tmp (str handle "-burst.log"))]
                    [handle log (start-listener! port handle log "--ack" "--scoped")]))
                handles)]
      (doseq [[handle log _] listener-pairs]
        (check (str handle " burst listener is armed")
               (await-predicate #(log-has? log "listening"))))
      (let [producers
            (mapv (fn [i]
                    (proc/process {:out :string :err :string
                                   :extra-env {"FRAM_LOG" @test-log}}
                                  "bb" msg-cli (str port) "send" "sender" "*"
                                  (str "burst-" i) (str "body-" i)))
                  (range 8))
            results (mapv deref producers)
            messages (mapv sent-subject results)]
        (check "all concurrent producers complete with unique message ids"
               (and (every? #(zero? (:exit %)) results)
                    (every? some? messages)
                    (= 8 (count (set messages)))))
        (check "every concurrent snapshot has the same finite audience"
               (every? #(= (set handles) (values-of port % "broadcast_to")) messages))
        (check "all eligible live listeners ack every concurrent broadcast"
               (await-predicate
                #(every? (fn [message]
                           (= (set handles) (values-of port message "acked_by")))
                         messages)))
        (doseq [[handle log _] listener-pairs]
          (check (str handle " receives every burst message exactly once")
                 (= 8 (mail-count log))))
        (let [before (into {} (map (fn [message]
                                     [message (values-of port message "acked_by")])
                                   messages))]
          (doseq [handle handles]
            (run-cli peek-cli port handle))
          (check "consumer replays cannot enlarge settled broadcast ack sets"
                 (= before
                    (into {} (map (fn [message]
                                    [message (values-of port message "acked_by")])
                                  messages))))))
      (doseq [[_ _ listener] listener-pairs] (stop-child! listener)))

    (finally
      (doseq [child @children] (stop-child! child))
      (proc/destroy-tree daemon)
      (doseq [file (reverse (file-seq tmp))]
        (io/delete-file file true)))))

(let [results @checks
      passed (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\nmessage audience integration: %d / %d PASS"
                   passed (count results)))
  (System/exit (if (= passed (count results)) 0 1)))
