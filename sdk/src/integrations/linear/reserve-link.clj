;; Reserve one canonical Linear endpoint. For bootstrap identities, the
;; connector+createdAt+initialKey+canonicalLink+linkedThread election is the
;; durable binding authority committed under one coordinator global-version
;; CAS. Query projections and the identity edge only heal that authority. v1
;; and v2 therefore share one authority even though their historical identity
;; fingerprints differ.
(require '[cheshire.core :as json]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def here (.getParentFile (io/file (System/getProperty "babashka.file"))))
(load-file (.getCanonicalPath (io/file here "../../../.." "cli" "coord.clj")))

(defn fail! [message]
  (throw (ex-info message {:type :linear-binding-conflict})))

(defn positive-long [label raw]
  (let [value (try (Long/parseLong (str raw))
                   (catch Exception _ (fail! (str label " must be a positive integer"))))]
    (when-not (pos? value) (fail! (str label " must be a positive integer")))
    value))

(defn required-text [label value]
  (when (or (not (string? value)) (str/blank? value) (not= value (str/trim value)))
    (fail! (str label " must be canonical nonblank text")))
  value)

(defn utf8-bytes [value]
  (alength (.getBytes (str value) java.nio.charset.StandardCharsets/UTF_8)))

(defn authority-token [label value max-bytes]
  (let [exact (required-text label value)]
    (when (or (> (utf8-bytes exact) max-bytes)
              (some
               (fn [character]
                 (let [codepoint (int character)]
                   (or (Character/isWhitespace codepoint)
                       (Character/isSpaceChar codepoint)
                       (Character/isISOControl codepoint))))
               exact))
      (fail! (str label " is not a bounded canonical authority token")))
    exact))

(def canonical-instant-formatter
  (.withZone
   (java.time.format.DateTimeFormatter/ofPattern
    "uuuu-MM-dd'T'HH:mm:ss.SSS'Z'")
   java.time.ZoneOffset/UTC))

(defn canonical-instant [label value]
  (let [exact (required-text label value)]
    (when-not
     (and
      (re-matches
       #"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z"
       exact)
      (try
        (= exact
           (.format
            canonical-instant-formatter
            (java.time.Instant/parse exact)))
        (catch Exception _ false)))
      (fail! (str label " must be a canonical millisecond UTC instant")))
    exact))

(defn nonnegative-long? [value]
  (and (integer? value) (<= 0 value) (<= value Long/MAX_VALUE)))

(defn exact-keys? [value expected]
  (and (map? value) (= (set (keys value)) expected)))

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

(defn values-of [port subject predicate]
  (let [response (north.coord/send-op
                  port {:op :resolved :te subject :p predicate})]
    (when-not
     (and (exact-keys? response #{:value :members :ambiguous? :values :version})
          (nonnegative-long? (:version response))
          (nonnegative-long? (:members response))
          (boolean? (:ambiguous? response))
          (vector? (:values response))
          (every? string? (:values response))
          (= (:members response) (count (:values response)))
          (= (:members response) (count (set (:values response))))
          (= (:ambiguous? response) (> (:members response) 1))
          (or (nil? (:value response)) (string? (:value response)))
          (if (zero? (:members response))
            (nil? (:value response))
            (some #{(:value response)} (:values response))))
      (fail! "Linear reservation received an invalid resolved response"))
    (set (:values response))))

(def max-bootstrap-authorities 10000)
(def max-bootstrap-authority-bytes (* 160 1024))
(def max-bootstrap-election-bytes 4096)

(defn authority-row-string? [value]
  (and (string? value)
       (<= (alength (.getBytes value java.nio.charset.StandardCharsets/UTF_8))
           max-bootstrap-authority-bytes)))

(defn query-pairs [port relation predicate]
  (let [response
        (north.coord/send-op
         port
         {:op :query
          :query
          {:find relation
           :rules
           [{:head {:rel relation
                    :args [{:var "subject"} {:var "value"}]}
             :body [{:rel "triple"
                     :args [{:var "subject"} predicate {:var "value"}]}]}]}})]
    (when-not
     (and (exact-keys? response #{:ok :version :engine})
          (nonnegative-long? (:version response))
          (#{"index" "scan"} (:engine response))
          (vector? (:ok response))
          (<= (count (:ok response)) max-bootstrap-authorities)
          (every? (fn [row]
                    (and (vector? row)
                         (= 2 (count row))
                         (every? authority-row-string? row)))
                  (:ok response)))
      (fail! "Linear reservation received an invalid authority-query response"))
    (:ok response)))

(def bootstrap-election-keys
  #{"canonicalLink" "connector" "createdAt" "initialKey" "linkedThread"})

(defn parse-bootstrap-election! [subject raw]
  (try
    (let [_bound
          (when (> (utf8-bytes raw) max-bootstrap-election-bytes)
            (fail! "Linear reservation found an oversized bootstrap election"))
          record (json/parse-string raw)
          canonical
          (when (map? record)
            (json/generate-string (into (sorted-map) record)))
          canonical-link (get record "canonicalLink")
          connector (get record "connector")
          created-at (get record "createdAt")
          initial-key (get record "initialKey")
          linked-thread (get record "linkedThread")]
      (when-not
       (and (re-matches #"@linear-bootstrap:[0-9a-f]{64}" subject)
            (= (set (keys record)) bootstrap-election-keys)
            (= raw canonical)
            (authority-row-string? canonical-link)
            (<= (utf8-bytes canonical-link) 1024)
            (re-matches #"@link:linear:[A-Za-z0-9:._!~*'()%-]+" canonical-link)
            (= connector (authority-token "bootstrap connector" connector 256))
            (= created-at
               (canonical-instant "bootstrap createdAt" created-at))
            (= initial-key
               (authority-token "bootstrap initial key" initial-key 512))
            (authority-row-string? linked-thread)
            (<= (utf8-bytes linked-thread) 513)
            (re-matches #"@[A-Za-z0-9][A-Za-z0-9._:-]*" linked-thread)
            (= subject
               (str "@linear-bootstrap:"
                    (canonical-hash {"connector" connector
                                     "createdAt" created-at}))))
        (fail! "Linear reservation found a malformed bootstrap election"))
      {:canonical-link canonical-link
       :linked-thread linked-thread})
    (catch clojure.lang.ExceptionInfo error (throw error))
    (catch Exception _
      (fail! "Linear reservation found a malformed bootstrap election"))))

(defn values-by-subject [rows subject-pattern]
  (reduce
   (fn [by-subject [subject value]]
     (if (re-matches subject-pattern subject)
       (update by-subject subject (fnil conj #{}) value)
       by-subject))
   {}
   rows))

(defn bootstrap-authority-claimants [port thread-ref]
  (let [election-values
        (values-by-subject
         (query-pairs port "bootstrap_election_authority" "bootstrap_election")
         #"@linear-bootstrap:[0-9a-f]{64}")
        projected-links
        (values-by-subject
         (query-pairs port "bootstrap_link_authority" "canonical_link")
         #"@linear-bootstrap:[0-9a-f]{64}")
        projected-threads
        (values-by-subject
         (query-pairs port "bootstrap_thread_authority" "linked_thread")
         #"@linear-bootstrap:[0-9a-f]{64}")
        elections
        (into
         {}
         (map
          (fn [[subject values]]
            (when-not (= 1 (count values))
              (fail! "Linear reservation found an ambiguous bootstrap election"))
            [subject (parse-bootstrap-election! subject (first values))])
          election-values))
        subjects
        (set (concat (keys elections)
                     (keys projected-links)
                     (keys projected-threads)))]
    (set
     (keep
      (fn [subject]
        (if-let [election (get elections subject)]
          (let [links (get projected-links subject #{})
                threads (get projected-threads subject #{})]
            ;; The election is authoritative; any redundant projection that
            ;; already exists must agree with it exactly.
            (when (or (> (count links) 1)
                      (and (seq links)
                           (not= links #{(:canonical-link election)}))
                      (> (count threads) 1)
                      (and (seq threads)
                           (not= threads #{(:linked-thread election)})))
              (fail! "Linear reservation found conflicting bootstrap projections"))
            (when (= thread-ref (:linked-thread election))
              (:canonical-link election)))
          (let [links (get projected-links subject #{})
                threads (get projected-threads subject #{})]
            ;; Historical releases wrote projections without the atomic
            ;; election. A projected thread is still a claim, but only an
            ;; exact singleton link/thread pair is safe to interpret.
            (when (seq threads)
              (when-not
               (and (= 1 (count links))
                    (= 1 (count threads))
                    (re-matches
                     #"@link:linear:[A-Za-z0-9:._!~*'()%-]+"
                     (first links))
                    (re-matches
                     #"@[A-Za-z0-9][A-Za-z0-9._:-]*"
                     (first threads)))
                (fail! "Linear reservation found partial legacy bootstrap authority"))
              (when (= thread-ref (first threads))
                (first links))))))
      subjects))))

(defn reverse-claimants [port thread-ref]
  (let [link-rows (query-pairs port "link_authority" "linked_thread")
        links
        (set
         (keep
          (fn [[subject claimed-thread]]
            (when (and (= thread-ref claimed-thread)
                       (str/starts-with? subject "@link:linear:"))
              subject))
          link-rows))]
    (into links (bootstrap-authority-claimants port thread-ref))))

(defn compatible-singleton! [port subject predicate expected]
  (let [values (values-of port subject predicate)]
    (when (or (> (count values) 1)
              (and (seq values) (not= values #{expected})))
      (fail! (str "Linear reservation conflicts on " predicate)))))

(defn exact-success? [result]
  (and (exact-keys? result #{:ok})
       (nonnegative-long? (:ok result))))

(defn exact-reject? [result]
  (and (exact-keys? result #{:reject :version})
       (keyword? (:reject result))
       (nonnegative-long? (:version result))))

(defn successful! [result message]
  (cond
    (exact-success? result) result
    (exact-reject? result) (fail! message)
    :else (fail! "Linear reservation received an invalid mutation response")))

(defn assert-compatible-with-fence!
  [port lease subject predicate value validate!]
  (successful!
   (north.coord/assert-after-read-with-fence!
    port lease subject predicate value validate!)
   (str "Linear reservation raced or lost its fence while healing " predicate)))

(def uuid-identity
  #"linear:uuid:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})")

(def bootstrap-identity
  #"linear:(mcp-bootstrap-v[12]):([^:]+):([0-9a-f]{64})")

(let [[port-token identity-resource identity-holder identity-epoch-token
       bare-link-token bare-thread-token remote-server-token identity-kind-token
       & evidence-args]
      *command-line-args*]
  (try
    (let [port (positive-long "port" port-token)
          _ (when (> port 65535) (fail! "port must be at most 65535"))
          identity-lease
          {:resource (required-text "identity resource" identity-resource)
           :holder (required-text "identity holder" identity-holder)
           :epoch (positive-long "identity epoch" identity-epoch-token)}
          bare-link (str/replace (required-text "link subject" bare-link-token) #"^@" "")
          bare-thread (str/replace (required-text "thread" bare-thread-token) #"^@" "")
          remote-server (required-text "remote server" remote-server-token)
          identity-kind (required-text "identity kind" identity-kind-token)
          bootstrap? (#{"mcp-bootstrap-v1" "mcp-bootstrap-v2"} identity-kind)
          _arity
          (when-not (if bootstrap? (= 7 (count evidence-args)) (empty? evidence-args))
            (fail! "reservation arguments do not match the selected identity kind"))
          [evidence-resource evidence-holder evidence-epoch-token
           evidence-connector evidence-created-at evidence-initial-key
           evidence-subject-token]
          (when bootstrap? evidence-args)
          evidence-lease
          (when bootstrap?
            {:resource (required-text "bootstrap evidence resource" evidence-resource)
             :holder (required-text "bootstrap evidence holder" evidence-holder)
             :epoch (positive-long "bootstrap evidence epoch" evidence-epoch-token)})
          evidence-connector (when bootstrap?
                               (authority-token
                                "bootstrap connector" evidence-connector 256))
          evidence-created-at (when bootstrap?
                                (canonical-instant
                                 "bootstrap createdAt" evidence-created-at))
          evidence-initial-key (when bootstrap?
                                (authority-token
                                 "bootstrap initial key" evidence-initial-key 512))
          evidence-hash
          (when bootstrap?
            (canonical-hash {"connector" evidence-connector
                             "createdAt" evidence-created-at}))
          evidence-subject
          (when bootstrap?
            (str "@" (str/replace
                       (required-text "bootstrap evidence subject" evidence-subject-token)
                       #"^@" "")))
          _evidence-shape
          (when bootstrap?
            (when-not (= evidence-subject (str "@linear-bootstrap:" evidence-hash))
              (fail! "bootstrap evidence subject does not match connector+createdAt"))
            (when-not (= (:resource evidence-lease)
                         (str "linear-sync:bootstrap:" evidence-hash))
              (fail! "bootstrap evidence lease does not match connector+createdAt")))
          _link-shape
          (when-not (and
                     (<= (utf8-bytes bare-link) 1023)
                     (re-matches
                      #"link:linear:[A-Za-z0-9:._!~*'()%-]+"
                      bare-link))
            (fail! "link subject is not a canonical Linear link id"))
          _thread-shape
          (when-not (and
                     (<= (utf8-bytes bare-thread) 512)
                     (re-matches #"[A-Za-z0-9][A-Za-z0-9._:-]*" bare-thread))
            (fail! "thread is not a canonical North thread id"))
          identity-key (subs bare-link (count "link:"))
          identity
          (if-let [[_ workspace issue] (re-matches uuid-identity identity-key)]
            {:kind "linear-uuid" :workspace workspace :issue issue}
            (if-let [[_ bootstrap-kind encoded-connector fingerprint]
                     (re-matches bootstrap-identity identity-key)]
              (do
                (when-not (= encoded-connector (encode-uri-component remote-server))
                  (fail! "bootstrap identity connector does not match remote server"))
                {:kind bootstrap-kind :fingerprint fingerprint})
              (fail! "link subject does not contain a canonical Linear identity")))
          _kind-match
          (when-not (= identity-kind (:kind identity))
            (fail! "reservation kind does not match its canonical link identity"))
          _fingerprint
          (when bootstrap?
            (let [expected
                  (canonical-hash
                   (cond-> {"connector" evidence-connector
                            "createdAt" evidence-created-at}
                     (= identity-kind "mcp-bootstrap-v1")
                     (assoc "initialKey" evidence-initial-key)))]
              (when-not (= expected (:fingerprint identity))
                (fail! "bootstrap identity fingerprint does not match its evidence"))))
          expected-resource
          (str "linear-sync:identity:" (encode-uri-component identity-key))
          _resource-match
          (when-not (= (:resource identity-lease) expected-resource)
            (fail! "identity lease resource does not match the canonical identity"))
          link (str "@" bare-link)
          thread (str "@" bare-thread)
          bootstrap-election
          (when bootstrap?
            (json/generate-string
             (into
              (sorted-map)
              {"canonicalLink" link
               "connector" evidence-connector
               "createdAt" evidence-created-at
               "initialKey" evidence-initial-key
               "linkedThread" thread})))
          evidence-projections
          (when bootstrap?
            [["kind" "linear_bootstrap_reservation"]
             ["bootstrap_connector" evidence-connector]
             ["bootstrap_created_at" evidence-created-at]
             ["bootstrap_initial_key" evidence-initial-key]
             ["canonical_link" link]
             ["linked_thread" thread]])
          validate-link!
          (fn []
            (let [linked (values-of port link "linked_thread")
                  claimants (reverse-claimants port thread)
                  thread-links (values-of port thread "linear_link")]
              (compatible-singleton! port link "kind" "integration_link")
              (compatible-singleton! port link "identity_kind" (:kind identity))
              (compatible-singleton! port link "remote_server" remote-server)
              (compatible-singleton! port link "sync_policy" "north-primary")
              (compatible-singleton! port link "sync_schema" "linear-sync-v1")
              (if (= "linear-uuid" (:kind identity))
                (do
                  (compatible-singleton! port link "remote_workspace" (:workspace identity))
                  (compatible-singleton! port link "remote_uuid" (:issue identity)))
                (do
                  (compatible-singleton! port link "remote_fingerprint" (:fingerprint identity))
                  (compatible-singleton!
                   port link "bootstrap_initial_key" evidence-initial-key)))
              (when (or (> (count linked) 1)
                        (and (seq linked) (not= linked #{thread})))
                (fail! "canonical Linear identity is already reserved for another thread"))
              (when (seq (disj claimants link))
                (fail! "requested North thread is already reserved by another link"))
              (when (or (> (count thread-links) 1)
                        (and (seq thread-links) (not= thread-links #{link})))
                (fail! "requested North thread has another canonical Linear link"))))
          validate-evidence!
          (fn []
            (when bootstrap?
              (let [elections
                    (values-of port evidence-subject "bootstrap_election")
                    projection-values
                    (mapv
                     (fn [[predicate expected]]
                       [predicate expected
                        (values-of port evidence-subject predicate)])
                     evidence-projections)
                    legacy-present?
                    (some (fn [[_ _ values]] (seq values)) projection-values)]
                (when (or (> (count elections) 1)
                          (and (seq elections)
                               (not= elections #{bootstrap-election})))
                  (fail! "Linear reservation conflicts on bootstrap_election"))
                ;; Old releases wrote the projection facts directly. Adopt
                ;; those only when the whole legacy envelope is already exact;
                ;; a prefix cannot be completed by a different key or thread.
                (when (and (empty? elections) legacy-present?
                           (not-every?
                            (fn [[_ expected values]]
                              (= values #{expected}))
                            projection-values))
                  (fail!
                   "legacy Linear bootstrap evidence is partial or conflicting"))
                (doseq [[predicate expected _] projection-values]
                  (compatible-singleton!
                   port evidence-subject predicate expected)))))]
      (when bootstrap?
        ;; One literal binds every authority field in the cross-version
        ;; election, including the link <-> thread edge. Its validation reads
        ;; both endpoints and every prior bootstrap election under one global
        ;; graph version. Everything after it is a redundant, query-friendly
        ;; projection that only the exact same intent may heal.
        (successful!
         (north.coord/assert-after-read-with-fence!
          port evidence-lease evidence-subject
          "bootstrap_election" bootstrap-election
          (fn []
            (validate-evidence!)
            (validate-link!)))
         "Linear bootstrap evidence raced with another canonical winner")
        (doseq [[predicate value] evidence-projections]
          (assert-compatible-with-fence!
           port evidence-lease evidence-subject predicate value
           validate-evidence!))
        (validate-evidence!))
      (when bootstrap?
        (assert-compatible-with-fence!
         port identity-lease link "bootstrap_initial_key" evidence-initial-key
         validate-link!))
      (let [result
            (north.coord/assert-after-read-with-fence!
             port identity-lease link "linked_thread" thread validate-link!)]
        (if (exact-success? result)
          (println (json/generate-string {"ok" (:ok result)}))
          (if (exact-reject? result)
            (println (json/generate-string
                      {"reject" (if (= :conflict (:reject result))
                                  "Linear binding reservation raced with another graph write"
                                  "Linear binding reservation lost its identity fence")}))
            (fail! "Linear reservation received an invalid mutation response")))))
    (catch Exception error
      (println (json/generate-string {"reject" (.getMessage error)})))))
