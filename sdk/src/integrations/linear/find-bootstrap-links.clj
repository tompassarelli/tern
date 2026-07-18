;; Find every canonical Linear link carrying one connector + createdAt pair.
;; This is the migration/collision oracle for MCP adapters that omit immutable
;; issue UUIDs. It is read-only and returns a bounded JSON machine envelope.
(require '[cheshire.core :as json]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def here (.getParentFile (io/file (System/getProperty "babashka.file"))))
(load-file (.getCanonicalPath (io/file here "../../../.." "cli" "coord.clj")))

(defn fail! [message]
  (throw (ex-info message {:type :linear-bootstrap-lookup})))

(defn positive-long [label raw]
  (let [value (try (Long/parseLong (str raw))
                   (catch Exception _ (fail! (str label " must be a positive integer"))))]
    (when-not (pos? value) (fail! (str label " must be a positive integer")))
    value))

(defn required-bounded [label value max-bytes]
  (when (or (str/blank? value)
            (not= value (str/trim value))
            (re-find #"\s|[\u0000-\u001f\u007f]" value)
            (> (alength (.getBytes value java.nio.charset.StandardCharsets/UTF_8))
               max-bytes))
    (fail! (str label " is not canonical")))
  value)

(defn exact-keys? [value expected]
  (and (map? value) (= (set (keys value)) expected)))

(def max-query-rows 10000)
(def max-manifest-bytes (* 160 1024))
(def max-link-subject-bytes 1024)

(defn nonnegative-long? [value]
  (and (integer? value) (<= 0 value) (<= value Long/MAX_VALUE)))

(defn utf8-bytes [value]
  (alength (.getBytes value java.nio.charset.StandardCharsets/UTF_8)))

(defn valid-query-response! [response arity]
  (when-not
   (and (exact-keys? response #{:ok :version :engine})
        (nonnegative-long? (:version response))
        (#{"index" "scan"} (:engine response))
        (vector? (:ok response))
        (<= (count (:ok response)) max-query-rows)
        (every? (fn [row]
                  (and (vector? row)
                       (= arity (count row))
                       (every? string? row)))
                (:ok response)))
    (fail! "coordinator returned an invalid query response"))
  (:ok response))

(defn canonical-link-subject [subject]
  (let [bare-subject (str/replace subject #"^@" "")]
    (when-not
     (and (or (= subject bare-subject)
              (= subject (str "@" bare-subject)))
          (<= (utf8-bytes bare-subject) max-link-subject-bytes)
          (re-matches #"link:linear:[A-Za-z0-9:._!~*'()%-]+" bare-subject))
      (fail! "encountered a malformed Linear link subject"))
    bare-subject))

(defn json-string-end [text start]
  (loop [index (inc start) escaped? false]
    (when (>= index (count text))
      (fail! "encountered a malformed Linear manifest"))
    (let [character (.charAt text index)]
      (cond
        escaped? (recur (inc index) false)
        (= character \\) (recur (inc index) true)
        (= character \") index
        :else (recur (inc index) false)))))

(defn next-json-token [text start]
  (loop [index start]
    (if (and (< index (count text))
             (contains? #{\space \tab \return \newline} (.charAt text index)))
      (recur (inc index))
      index)))

(defn reject-duplicate-json-keys! [text]
  (loop [index 0 stack []]
    (when (< index (count text))
      (let [character (.charAt text index)]
        (cond
          (= character \")
          (let [end (json-string-end text index)
                next (next-json-token text (inc end))
                object? (= :object (:kind (peek stack)))]
            (if (and object?
                     (< next (count text))
                     (= \: (.charAt text next)))
              (let [key (try
                          (json/parse-string (subs text index (inc end)))
                          (catch Exception _
                            (fail! "encountered a malformed Linear manifest")))
                    keys (:keys (peek stack))]
                (when (contains? keys key)
                  (fail! "encountered a malformed Linear manifest"))
                (recur (inc end)
                       (conj (pop stack) (update (peek stack) :keys conj key))))
              (recur (inc end) stack)))

          (= character \{)
          (recur (inc index) (conj stack {:kind :object :keys #{}}))

          (= character \[)
          (recur (inc index) (conj stack {:kind :array}))

          (or (= character \}) (= character \]))
          (recur (inc index) (if (seq stack) (pop stack) stack))

          :else
          (recur (inc index) stack))))))

(defn parse-manifest! [manifest-text]
  (when (> (utf8-bytes manifest-text) max-manifest-bytes)
    (fail! "encountered an oversized Linear manifest"))
  (reject-duplicate-json-keys! manifest-text)
  (let [manifest
        (try (json/parse-string-strict manifest-text true)
             (catch Exception _
               (fail! "encountered a malformed Linear manifest")))
        evidence (:evidence manifest)]
    (when-not
     (and (map? manifest)
          (map? evidence)
          (string? (:connector evidence))
          (string? (:createdAt evidence)))
      (fail! "encountered a malformed Linear manifest"))
    manifest))

(let [[port-token connector-token created-at-token] *command-line-args*]
  (try
    (let [port (positive-long "port" port-token)
          _ (when (> port 65535) (fail! "port must be at most 65535"))
          connector (required-bounded "connector" connector-token 256)
          created-at (required-bounded "createdAt" created-at-token 64)
          manifest-response
          (north.coord/send-op
           port
           {:op :query
            :query
            {:find "linear-bootstrap-links"
             :rules
             [{:head {:rel "linear-bootstrap-links"
                      :args [{:var "link"} {:var "manifest"}]}
               :body [{:rel "triple"
                       :args [{:var "link"} "sync_manifest" {:var "manifest"}]}]}]}})
          manifest-rows (valid-query-response! manifest-response 2)
          _manifest-bounds
          (doseq [[subject _] manifest-rows]
            (canonical-link-subject subject))
          manifest-subjects
          (set (map (comp canonical-link-subject first) manifest-rows))
          matching-manifests
          (->> manifest-rows
               (keep
                (fn [[subject manifest-text]]
                  (let [bare-subject (canonical-link-subject subject)
                        manifest (parse-manifest! manifest-text)
                        evidence (:evidence manifest)]
                    (when (and (= connector (:connector evidence))
                               (= created-at (:createdAt evidence)))
                      bare-subject))))
               set)
          linked-response
          (north.coord/send-op
           port
           {:op :query
            :query
            {:find "linear-partial-links"
             :rules
             [{:head {:rel "linear-partial-links" :args [{:var "link"}]}
               :body [{:rel "triple"
                       :args [{:var "link"} "linked_thread" {:var "thread"}]}]}]}})
          linked-rows (valid-query-response! linked-response 1)
          partial-v1
          (->> linked-rows
               (map (comp canonical-link-subject first))
               (remove manifest-subjects)
               (filter
                (fn [subject]
                  (when-let
                   [[_ encoded]
                    (re-matches
                     #"link:linear:mcp-bootstrap-v1:([^:]+):[0-9a-f]{64}"
                     subject)]
                    (= connector
                       (java.net.URLDecoder/decode encoded "UTF-8")))))
               set)
          subjects (->> (into matching-manifests partial-v1) sort vec)]
      (println (json/generate-string {"ok" subjects})))
    (catch Exception _
      (println (json/generate-string
                {"reject" "Linear bootstrap evidence lookup failed"})))))
