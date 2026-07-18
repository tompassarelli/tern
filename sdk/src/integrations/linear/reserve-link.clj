;; Atomically reserve one canonical Linear identity for one North thread.
;;
;; The identity and thread leases exclude well-behaved bridge callers while the
;; durable linked_thread assertion makes crash recovery unambiguous.  The
;; global-version CAS is the actual cross-endpoint invariant: every reverse
;; claimant (including a partial link with no kind fact) and the thread's
;; canonical pointer are validated against the same graph version committed by
;; the reservation assertion.
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
  (when (str/blank? value) (fail! (str label " must not be blank")))
  value)

(defn nonnegative-long? [value]
  (and (integer? value) (<= 0 value) (<= value Long/MAX_VALUE)))

(defn exact-keys? [value expected]
  (and (map? value) (= (set (keys value)) expected)))

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
          (= (:ambiguous? response) (> (:members response) 1))
          (or (nil? (:value response)) (string? (:value response)))
          (if (zero? (:members response))
            (nil? (:value response))
            (some #{(:value response)} (:values response))))
      (fail! "Linear binding reservation received an invalid resolved response"))
    (set (:values response))))

(defn reverse-claimants [port thread-ref]
  (let [response
        (north.coord/send-op
         port
         {:op :query
          :query
          {:find "link"
           :rules
           [{:head {:rel "link" :args [{:var "link"}]}
             :body [{:rel "triple"
                     :args [{:var "link"} "linked_thread" thread-ref]}]}]}})]
    (when-not
     (and (exact-keys? response #{:ok :version :engine})
          (nonnegative-long? (:version response))
          (#{"index" "scan"} (:engine response))
          (vector? (:ok response))
          (every? (fn [row]
                    (and (vector? row) (= 1 (count row)) (string? (first row))))
                  (:ok response)))
      (fail! "Linear binding reservation received an invalid reverse-query response"))
    (set (map first (:ok response)))))

(defn compatible-singleton! [port subject predicate expected]
  (let [values (values-of port subject predicate)]
    (when (or (> (count values) 1)
              (and (seq values) (not= values #{expected})))
      (fail! (str "partial Linear link conflicts on " predicate)))))

(def uuid-identity
  #"linear:uuid:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})")

(def bootstrap-identity
  #"linear:(mcp-bootstrap-v[12]):([^:]+):([0-9a-f]{64})")

(let [[port-token resource holder epoch-token bare-link bare-thread remote-server
       bootstrap-initial-key-token]
      *command-line-args*]
  (try
    (let [port (positive-long "port" port-token)
          _ (when (> port 65535) (fail! "port must be at most 65535"))
          resource (required-text "resource" resource)
          holder (required-text "holder" holder)
          epoch (positive-long "epoch" epoch-token)
          bare-link (str/replace (required-text "link subject" bare-link) #"^@" "")
          bare-thread (str/replace (required-text "thread" bare-thread) #"^@" "")
          remote-server (required-text "remote server" remote-server)
          bootstrap-initial-key
          (when-not (= "-" bootstrap-initial-key-token)
            (required-text "bootstrap initial key" bootstrap-initial-key-token))
          _link-shape
          (when-not (re-matches #"link:linear:[A-Za-z0-9:._!~*'()%-]+" bare-link)
            (fail! "link subject is not a canonical Linear link id"))
          _thread-shape
          (when-not (re-matches #"[A-Za-z0-9][A-Za-z0-9._:-]*" bare-thread)
            (fail! "thread is not a canonical North thread id"))
          identity-key (subs bare-link (count "link:"))
          identity
          (if-let [[_ workspace issue] (re-matches uuid-identity identity-key)]
            {:kind "linear-uuid" :workspace workspace :issue issue}
            (if-let [[_ bootstrap-kind encoded-connector fingerprint]
                     (re-matches bootstrap-identity identity-key)]
              (do
                (when-not
                 (= encoded-connector (encode-uri-component remote-server))
                  (fail! "bootstrap identity connector does not match the remote server"))
                {:kind bootstrap-kind :fingerprint fingerprint})
              (fail! "link subject does not contain a canonical Linear identity")))
          expected-resource
          (str "linear-sync:identity:" (encode-uri-component identity-key))
          _resource-match
          (when-not (= resource expected-resource)
            (fail! "identity lease resource does not match the canonical Linear link identity"))
          link (str "@" bare-link)
          thread (str "@" bare-thread)
          validate!
          (fn []
            (let [linked (values-of port link "linked_thread")
                  claimants (reverse-claimants port thread)
                  thread-links (values-of port thread "linear_link")]
              (compatible-singleton!
               port link "kind" "integration_link")
              (compatible-singleton!
               port link "identity_kind" (:kind identity))
              (compatible-singleton!
               port link "remote_server" remote-server)
              (compatible-singleton!
               port link "sync_policy" "north-primary")
              (compatible-singleton!
               port link "sync_schema" "linear-sync-v1")
              (if (= "linear-uuid" (:kind identity))
                (do
                  (compatible-singleton!
                   port link "remote_workspace" (:workspace identity))
                  (compatible-singleton!
                   port link "remote_uuid" (:issue identity)))
                (compatible-singleton!
                 port link "remote_fingerprint" (:fingerprint identity)))
              (when (= "mcp-bootstrap-v2" (:kind identity))
                (when-not bootstrap-initial-key
                  (fail! "bootstrap-v2 reservation requires an initial key"))
                (compatible-singleton!
                 port link "bootstrap_initial_key" bootstrap-initial-key))
              (when (or (> (count linked) 1)
                        (and (seq linked) (not= linked #{thread})))
                (fail! (str "canonical Linear identity is already reserved for "
                            (str/join ", " (sort linked)))))
              (when (seq (disj claimants link))
                (fail! (str "requested North thread is already reserved by "
                            (str/join ", " (sort (disj claimants link))))))
              (when (or (> (count thread-links) 1)
                        (and (seq thread-links) (not= thread-links #{link})))
                (fail! (str "requested North thread already has a different canonical Linear link")))))
          bootstrap-result
          (when (= "mcp-bootstrap-v2" (:kind identity))
            (north.coord/assert-after-read-with-fence!
             port {:resource resource :holder holder :epoch epoch}
             link "bootstrap_initial_key" bootstrap-initial-key validate!))
          bootstrap-ok?
          (or (not= "mcp-bootstrap-v2" (:kind identity))
              (and (:ok bootstrap-result) (not (:reject bootstrap-result))))
          result
          (when bootstrap-ok?
          (north.coord/assert-after-read-with-fence!
           port {:resource resource :holder holder :epoch epoch}
           link "linked_thread" thread validate!))]
      (if (and bootstrap-ok? (:ok result) (not (:reject result)))
        (println (json/generate-string {"ok" (:ok result)}))
        (println (json/generate-string
                  {"reject" (if (= :conflict (:reject (or result bootstrap-result)))
                              "Linear binding reservation raced with another graph write"
                              "Linear binding reservation lost its identity fence")}))))
    (catch Exception error
      (println (json/generate-string {"reject" (.getMessage error)})))))
