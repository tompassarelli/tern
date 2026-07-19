#!/usr/bin/env bb
;; Real coordinator proof for the Linear cross-version bootstrap election and
;; schema compare-and-set helpers.
(require '[babashka.process :as proc]
         '[cheshire.core :as json]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file *file*)) "../..")))
(def fram (.getCanonicalPath
           (io/file (or (System/getenv "FRAM_PATH")
                        (str root "/../fram")))))
(when-not (.isFile (io/file fram "coord_daemon.clj"))
  (throw (ex-info "Fram checkout not found" {:fram fram})))
(load-file (str root "/cli/coord.clj"))

(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)]
    (.getLocalPort socket)))

(defn port-open? [port]
  (try
    (with-open [_ (java.net.Socket. "127.0.0.1" (int port))] true)
    (catch Exception _ false)))

(defn eventually [f]
  (loop [remaining 200]
    (cond
      (try (f) (catch Exception _ false)) true
      (zero? remaining) false
      :else (do (Thread/sleep 25) (recur (dec remaining))))))

(defn sha256 [value]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        (.getBytes (str value) java.nio.charset.StandardCharsets/UTF_8))]
    (apply str (map #(format "%02x" (bit-and (int %) 0xff)) digest))))

(defn canonical-hash [entries]
  (sha256 (json/generate-string (into (sorted-map) entries))))

(defn encode-uri-component [value]
  (let [unescaped?
        (fn [byte]
          (or (<= (int \A) byte (int \Z))
              (<= (int \a) byte (int \z))
              (<= (int \0) byte (int \9))
              (contains? #{(int \-) (int \_) (int \.) (int \!)
                           (int \~) (int \*) (int \') (int \() (int \))}
                         byte)))]
    (apply str
           (map (fn [raw]
                  (let [byte (bit-and (int raw) 0xff)]
                    (if (unescaped? byte)
                      (str (char byte))
                      (format "%%%02X" byte))))
                (.getBytes (str value) java.nio.charset.StandardCharsets/UTF_8)))))

(defn acquire! [port resource holder]
  (let [result (north.coord/send-op
                port {:op :acquire-lease
                      :res resource :holder holder :ttl-ms 300000})]
    (when-not (and (:ok result) (:epoch result))
      (throw (ex-info "lease acquisition failed" {:resource resource :result result})))
    (:epoch result)))

(defn release! [port resource holder epoch]
  (north.coord/send-op
   port {:op :release-lease :res resource :holder holder :epoch epoch}))

(defn helper! [log & args]
  (let [result
        (apply proc/shell
               {:out :string :err :string :continue true
                :extra-env {"FRAM_LOG" log}}
               "bb" args)]
    (when-not (zero? (:exit result))
      (throw (ex-info "Linear helper process failed" {:result result :args args})))
    (json/parse-string (str/trim (:out result)))))

(defn assert-fact! [port subject predicate value]
  (let [result (north.coord/append! port subject predicate value)]
    (when-not (and (= #{:ok} (set (keys result)))
                   (integer? (:ok result)))
      (throw (ex-info "fixture fact write failed"
                      {:subject subject :predicate predicate :result result})))
    result))

(defn retract-fact! [port subject predicate value]
  (let [result (north.coord/retract! port subject predicate value)]
    (when-not (and (= #{:ok} (set (keys result)))
                   (integer? (:ok result)))
      (throw (ex-info "fixture fact retraction failed"
                      {:subject subject :predicate predicate :result result})))
    result))

(defn reserve-once!
  [log reserve port evidence-resource identity-resource link thread connector
   created-at initial-key evidence-subject suffix]
  (let [e-holder (str "evidence-" suffix)
        e-epoch (acquire! port evidence-resource e-holder)]
    (try
      (let [i-holder (str "identity-" suffix)
            i-epoch (acquire! port identity-resource i-holder)]
        (try
          (helper!
           log reserve (str port)
           identity-resource i-holder (str i-epoch)
           link thread connector "mcp-bootstrap-v2"
           evidence-resource e-holder (str e-epoch)
           connector created-at initial-key evidence-subject)
          (finally
            (release! port identity-resource i-holder i-epoch))))
      (finally
        (release! port evidence-resource e-holder e-epoch)))))

(let [port (free-port)
      dir (.toFile
           (java.nio.file.Files/createTempDirectory
            "north-linear-reservation"
            (make-array java.nio.file.attribute.FileAttribute 0)))
      log (.getCanonicalPath (io/file dir "facts.log"))
      _ (spit log "")
      daemon
      (proc/process
       {:dir fram :out :string :err :string
        :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"}}
       "bb" "-cp" "out" "coord_daemon.clj" "serve-flat" (str port) log)
      reserve (str root "/sdk/src/integrations/linear/reserve-link.clj")
      schema (str root "/sdk/src/integrations/linear/reserve-schema-fact.clj")
      connector "linear-test"
      created-at "2026-07-16T14:08:20.639Z"
      initial-key "MSA-236"
      evidence-hash (canonical-hash {"connector" connector "createdAt" created-at})
      evidence-subject (str "linear-bootstrap:" evidence-hash)
      evidence-resource (str "linear-sync:bootstrap:" evidence-hash)
      v1-hash (canonical-hash
               {"connector" connector "createdAt" created-at "initialKey" initial-key})
      v2-hash evidence-hash
      v1-key (str "linear:mcp-bootstrap-v1:" connector ":" v1-hash)
      v2-key (str "linear:mcp-bootstrap-v2:" connector ":" v2-hash)
      v1-link (str "link:" v1-key)
      v2-link (str "link:" v2-key)
      v1-resource (str "linear-sync:identity:" (encode-uri-component v1-key))
      v2-resource (str "linear-sync:identity:" (encode-uri-component v2-key))
      checks (atom [])
      check! (fn [label value] (swap! checks conj [label (boolean value)]))]
  (alter-var-root #'north.coord/expected-log (constantly (fn [] log)))
  (try
    (check! "real Fram coordinator starts" (eventually #(port-open? port)))
    (let [e-holder "evidence-v1"
          i-holder "identity-v1"
          e-epoch (acquire! port evidence-resource e-holder)
          i-epoch (acquire! port v1-resource i-holder)
          result
          (helper!
           log reserve (str port)
           v1-resource i-holder (str i-epoch)
           v1-link "thread-v1" connector "mcp-bootstrap-v1"
           evidence-resource e-holder (str e-epoch)
           connector created-at initial-key evidence-subject)]
      (check! "v1 elects the durable evidence winner" (integer? (get result "ok")))
      (release! port v1-resource i-holder i-epoch)
      (release! port evidence-resource e-holder e-epoch))

    (let [e-holder "evidence-v2"
          i-holder "identity-v2"
          e-epoch (acquire! port evidence-resource e-holder)
          i-epoch (acquire! port v2-resource i-holder)
          result
          (helper!
           log reserve (str port)
           v2-resource i-holder (str i-epoch)
           v2-link "thread-v2" connector "mcp-bootstrap-v2"
           evidence-resource e-holder (str e-epoch)
           connector created-at initial-key evidence-subject)]
      (check! "v2 cannot fork the v1 evidence winner"
              (str/includes? (get result "reject" "") "bootstrap_election"))
      (release! port v2-resource i-holder i-epoch)
      (release! port evidence-resource e-holder e-epoch))

    (let [e-holder "evidence-v1-retry"
          i-holder "identity-v1-retry"
          e-epoch (acquire! port evidence-resource e-holder)
          i-epoch (acquire! port v1-resource i-holder)
          result
          (helper!
           log reserve (str port)
           v1-resource i-holder (str i-epoch)
           v1-link "thread-v1" connector "mcp-bootstrap-v1"
           evidence-resource e-holder (str e-epoch)
           connector created-at initial-key evidence-subject)]
      (check! "same winner restart heals idempotently" (integer? (get result "ok")))
      (check! "evidence retains exactly one canonical link"
              (= #{(str "@" v1-link)}
                 (set (north.coord/many
                       port (str "@" evidence-subject) "canonical_link"))))
      (release! port v1-resource i-holder i-epoch)
      (release! port evidence-resource e-holder e-epoch))

    (let [poison-connector "linear-poison-regression"
          poison-created-at "2026-07-16T14:10:00.639Z"
          poison-key "MSA-400"
          poison-hash
          (canonical-hash
           {"connector" poison-connector "createdAt" poison-created-at})
          poison-subject (str "linear-bootstrap:" poison-hash)
          poison-evidence-resource (str "linear-sync:bootstrap:" poison-hash)
          poison-identity-key
          (str "linear:mcp-bootstrap-v2:" poison-connector ":" poison-hash)
          poison-link (str "link:" poison-identity-key)
          poison-identity-resource
          (str "linear-sync:identity:"
               (encode-uri-component poison-identity-key))
          wrong-thread "thread-poisoned-by-other-link"
          correct-thread "thread-corrected-retry"
          preexisting-link
          "@link:linear:uuid:11111111-1111-8111-8111-111111111111:22222222-2222-8222-8222-222222222222"
          _ (assert-fact! port preexisting-link "linked_thread"
                          (str "@" wrong-thread))
          rejected
          (reserve-once!
           log reserve port poison-evidence-resource
           poison-identity-resource poison-link wrong-thread
           poison-connector poison-created-at poison-key poison-subject
           "poison-rejected")
          no-election?
          (empty?
           (north.coord/many
            port (str "@" poison-subject) "bootstrap_election"))
          corrected
          (reserve-once!
           log reserve port poison-evidence-resource
           poison-identity-resource poison-link correct-thread
           poison-connector poison-created-at poison-key poison-subject
           "poison-corrected")]
      (check!
       "a preclaimed wrong thread rejects before bootstrap election"
       (and
        (str/includes?
         (get rejected "reject" "")
         "requested North thread is already reserved")
        no-election?))
      (check!
       "a corrected retry succeeds after the rejected wrong-thread attempt"
       (integer? (get corrected "ok"))))

    (let [winner-connector "linear-crash-winner"
          winner-created-at "2026-07-16T14:11:00.639Z"
          winner-key "MSA-410"
          winner-hash
          (canonical-hash
           {"connector" winner-connector "createdAt" winner-created-at})
          winner-subject (str "linear-bootstrap:" winner-hash)
          winner-evidence-resource (str "linear-sync:bootstrap:" winner-hash)
          winner-identity-key
          (str "linear:mcp-bootstrap-v2:" winner-connector ":" winner-hash)
          winner-link (str "link:" winner-identity-key)
          winner-identity-resource
          (str "linear-sync:identity:"
               (encode-uri-component winner-identity-key))
          shared-thread "thread-owned-at-election"
          winner-election
          (json/generate-string
           (into
            (sorted-map)
            {"canonicalLink" (str "@" winner-link)
             "connector" winner-connector
             "createdAt" winner-created-at
             "initialKey" winner-key
             "linkedThread" (str "@" shared-thread)}))
          _ (assert-fact!
             port (str "@" winner-subject)
             "bootstrap_election" winner-election)
          contender-connector "linear-crash-contender"
          contender-created-at "2026-07-16T14:12:00.639Z"
          contender-key "MSA-411"
          contender-hash
          (canonical-hash
           {"connector" contender-connector
            "createdAt" contender-created-at})
          contender-subject (str "linear-bootstrap:" contender-hash)
          contender-evidence-resource
          (str "linear-sync:bootstrap:" contender-hash)
          contender-identity-key
          (str "linear:mcp-bootstrap-v2:"
               contender-connector ":" contender-hash)
          contender-link (str "link:" contender-identity-key)
          contender-identity-resource
          (str "linear-sync:identity:"
               (encode-uri-component contender-identity-key))
          contender-result
          (reserve-once!
           log reserve port contender-evidence-resource
           contender-identity-resource contender-link shared-thread
           contender-connector contender-created-at contender-key
           contender-subject "crash-contender")
          contender-unelected?
          (empty?
           (north.coord/many
            port (str "@" contender-subject) "bootstrap_election"))
          healed-winner
          (reserve-once!
           log reserve port winner-evidence-resource
           winner-identity-resource winner-link shared-thread
           winner-connector winner-created-at winner-key
           winner-subject "crash-winner-heal")]
      (check!
       "an election-only crash prefix blocks a different evidence winner for the same thread"
       (and
        (str/includes?
         (get contender-result "reject" "")
         "requested North thread is already reserved")
        contender-unelected?))
      (check!
       "the election-only winner heals after blocking the contender"
       (integer? (get healed-winner "ok"))))

    (let [prefix-results
          (doall
           (for [prefix (range 7)]
             (let [prefix-connector (str "linear-prefix-" prefix)
                   prefix-created-at
                   (format "2026-07-16T14:09:%02d.639Z" prefix)
                   prefix-key (str "MSA-" (+ 300 prefix))
                   prefix-thread (str "thread-prefix-" prefix)
                   prefix-evidence-hash
                   (canonical-hash
                    {"connector" prefix-connector
                     "createdAt" prefix-created-at})
                   prefix-subject
                   (str "linear-bootstrap:" prefix-evidence-hash)
                   prefix-resource
                   (str "linear-sync:bootstrap:" prefix-evidence-hash)
                   prefix-identity-key
                   (str "linear:mcp-bootstrap-v2:"
                        prefix-connector ":" prefix-evidence-hash)
                   prefix-link (str "link:" prefix-identity-key)
                   prefix-identity-resource
                   (str "linear-sync:identity:"
                        (encode-uri-component prefix-identity-key))
                   election
                   (json/generate-string
                    (into
                     (sorted-map)
                     {"canonicalLink" (str "@" prefix-link)
                      "connector" prefix-connector
                      "createdAt" prefix-created-at
                      "initialKey" prefix-key
                      "linkedThread" (str "@" prefix-thread)}))
                   projections
                   [["kind" "linear_bootstrap_reservation"]
                    ["bootstrap_connector" prefix-connector]
                    ["bootstrap_created_at" prefix-created-at]
                    ["bootstrap_initial_key" prefix-key]
                    ["canonical_link" (str "@" prefix-link)]
                    ["linked_thread" (str "@" prefix-thread)]]]
               ;; This is every durable prefix after the atomic election:
               ;; election alone, then one additional query projection at a
               ;; time, through a fully projected envelope.
               (assert-fact!
                port (str "@" prefix-subject)
                "bootstrap_election" election)
               (doseq [[predicate value] (take prefix projections)]
                 (assert-fact!
                  port (str "@" prefix-subject) predicate value))
               (let [wrong-key
                     (reserve-once!
                      log reserve port prefix-resource
                      prefix-identity-resource prefix-link prefix-thread
                      prefix-connector prefix-created-at
                      (str prefix-key "-OTHER") prefix-subject
                      (str "prefix-" prefix "-wrong-key"))
                     wrong-thread
                     (reserve-once!
                      log reserve port prefix-resource
                      prefix-identity-resource prefix-link
                      (str prefix-thread "-other")
                      prefix-connector prefix-created-at prefix-key
                      prefix-subject
                      (str "prefix-" prefix "-wrong-thread"))
                     unchanged?
                     (and
                      (= #{election}
                         (set
                          (north.coord/many
                           port (str "@" prefix-subject)
                           "bootstrap_election")))
                      (empty?
                       (north.coord/many
                        port (str "@" prefix-link) "linked_thread")))
                     healed
                     (reserve-once!
                      log reserve port prefix-resource
                      prefix-identity-resource prefix-link prefix-thread
                      prefix-connector prefix-created-at prefix-key
                      prefix-subject
                      (str "prefix-" prefix "-original"))
                     healed?
                     (and
                      (integer? (get healed "ok"))
                      (every?
                       (fn [[predicate expected]]
                         (= #{expected}
                            (set
                             (north.coord/many
                              port (str "@" prefix-subject)
                              predicate))))
                       projections))]
                 (and
                  (str/includes?
                   (get wrong-key "reject" "") "bootstrap_election")
                  (str/includes?
                   (get wrong-thread "reject" "") "bootstrap_election")
                  unchanged?
                  healed?)))))]
      (check!
       "every atomic-election crash prefix rejects key/thread theft and lets only the original heal"
       (every? true? prefix-results)))

    (let [first-result
          (helper! log schema (str port)
                   "exact" "linear_test_schema" "value_kind" "literal")]
      (check! "schema CAS installs an absent exact fact"
              (integer? (get first-result "ok"))))
    (let [conflict
          (helper! log schema (str port)
                   "exact" "linear_test_schema" "value_kind" "ref")]
      (check! "schema CAS refuses an incompatible current value"
              (str/includes? (get conflict "reject" "") "conflicts"))
      (check! "schema conflict is not overwritten"
              (= [["literal"]]
                 (:ok
                  (north.coord/send-op
                   port
                   {:op :query
                    :query
                    {:find "value"
                     :rules
                     [{:head {:rel "value" :args [{:var "value"}]}
                       :body [{:rel "triple"
                               :args ["@linear_test_schema"
                                      "value_kind"
                                     {:var "value"}]}]}]}})))))

    (let [duplicate-connector "linear-duplicate-election"
          duplicate-created-at "2026-07-16T14:13:00.639Z"
          duplicate-link
          "@link:linear:mcp-bootstrap-v2:linear-duplicate-election:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          duplicate-subject
          (str
           "@linear-bootstrap:"
           (canonical-hash
            {"connector" duplicate-connector
             "createdAt" duplicate-created-at}))
          duplicate-election
          (str
           "{\"canonicalLink\":\"" duplicate-link
           "\",\"canonicalLink\":\"" duplicate-link
           "\",\"connector\":\"" duplicate-connector
           "\",\"createdAt\":\"" duplicate-created-at
           "\",\"initialKey\":\"MSA-420\","
           "\"linkedThread\":\"@thread-duplicate-election\"}")
          bad-time-connector "linear-bad-time"
          bad-time "2026-07-16 14:14:00"
          bad-time-subject
          (str
           "@linear-bootstrap:"
           (canonical-hash
            {"connector" bad-time-connector "createdAt" bad-time}))
          bad-time-election
          (json/generate-string
           (into
            (sorted-map)
            {"canonicalLink"
             "@link:linear:mcp-bootstrap-v2:linear-bad-time:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
             "connector" bad-time-connector
             "createdAt" bad-time
             "initialKey" "MSA-421"
             "linkedThread" "@thread-bad-time"}))
          control-connector "linear-control\nconnector"
          control-created-at "2026-07-16T14:15:00.639Z"
          control-subject
          (str
           "@linear-bootstrap:"
           (canonical-hash
            {"connector" control-connector
             "createdAt" control-created-at}))
          control-election
          (json/generate-string
           (into
            (sorted-map)
            {"canonicalLink"
             "@link:linear:mcp-bootstrap-v2:linear-control:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
             "connector" control-connector
             "createdAt" control-created-at
             "initialKey" "MSA-422"
             "linkedThread" "@thread-control"}))
          oversize-connector "linear-oversize-election"
          oversize-created-at "2026-07-16T14:16:00.639Z"
          oversize-subject
          (str
           "@linear-bootstrap:"
           (canonical-hash
            {"connector" oversize-connector
             "createdAt" oversize-created-at}))
          oversize-election
          (json/generate-string
           (into
            (sorted-map)
            {"canonicalLink"
             "@link:linear:mcp-bootstrap-v2:linear-oversize-election:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
             "connector" oversize-connector
             "createdAt" oversize-created-at
             "initialKey" (apply str (repeat 5000 "x"))
             "linkedThread" "@thread-oversize"}))
          corruptions
          [["malformed JSON" "@linear-bootstrap:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" "{"]
           ["duplicate authority key" duplicate-subject duplicate-election]
           ["noncanonical timestamp" bad-time-subject bad-time-election]
           ["control-bearing connector" control-subject control-election]
           ["oversized envelope" oversize-subject oversize-election]]
          rejected?
          (doall
           (map-indexed
            (fn [index [_ subject election]]
              (assert-fact! port subject "bootstrap_election" election)
              (try
                (let [result
                      (reserve-once!
                       log reserve port evidence-resource v1-resource
                       v1-link "thread-v1" connector created-at initial-key
                       evidence-subject
                       (str "corrupt-election-" index))]
                  (and
                   (string? (get result "reject"))
                   (not (str/blank? (get result "reject")))))
                (finally
                  (retract-fact!
                   port subject "bootstrap_election" election))))
            corruptions))]
      (doseq [[[label _ _] rejected] (map vector corruptions rejected?)]
        (check!
         (str "stored bootstrap election rejects " label)
         rejected)))

    (let [failed (remove second @checks)]
      (doseq [[label ok?] @checks]
        (println (str (if ok? "PASS " "FAIL ") label)))
      (if (seq failed)
        (System/exit 1)
        (println "linear reservation integration: PASS")))
    (finally
      (proc/destroy-tree daemon)
      (deref daemon 5000 nil)
      (doseq [file (reverse (file-seq dir))]
        (io/delete-file file true)))))
