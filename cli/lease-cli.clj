;; lease-cli.clj — agent-side North lease helper (P0 shadow).
;; Speaks the daemon lease wire verbs. EDN remains the human/legacy default;
;; --json is the exact machine envelope used by the Linear bridge.
;; This is the contract every agent session uses to take the build mutex over the socket
;; INSTEAD of dropping a per-agent BUILD-LOCK-<agent>.md lockfile.
;;
;; usage:
;;   bb lease-cli.clj <port> [--json] acquire <res> <holder> <ttl-ms>
;;   bb lease-cli.clj <port> [--json] renew  <res> <holder> <epoch> <ttl-ms>
;;   bb lease-cli.clj <port> [--json] release <res> <holder> [<epoch>]
;;   bb lease-cli.clj <port> [--json] fence   <res> <holder> <epoch>
;;   printf %s <value> | bb lease-cli.clj <port> [--json] put-fenced-stdin <res> <holder> <epoch> <subject> <predicate>
;;   bb lease-cli.clj <port> [--json] status
(require '[cheshire.core :as json]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

;; shared coord substrate (Foundation Part B): send-op lives once in cli/coord.clj.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op north.coord/send-op)

(defn fail! [message]
  (binding [*out* *err*] (println (str "lease-cli: " message)))
  (System/exit 2))

(defn positive-long [label raw]
  (let [value (try (Long/parseLong (str raw))
                   (catch Exception _ (fail! (str label " must be a positive integer"))))]
    (when-not (pos? value) (fail! (str label " must be a positive integer")))
    value))

(defn required-text [label value]
  (when (str/blank? value) (fail! (str label " must not be blank")))
  value)

;; The Fram coordinator admits one 1 MiB EDN request line. 160 KiB remains
;; above Linux's per-argument ceiling while leaving enough room for worst-case
;; EDN string escaping plus the fenced metadata envelope.
(def max-fenced-value-bytes (* 160 1024))

(defn read-fenced-value []
  (let [bytes (.readNBytes System/in (inc max-fenced-value-bytes))]
    (when (> (alength bytes) max-fenced-value-bytes)
      (fail! (str "fenced value exceeds " max-fenced-value-bytes " bytes")))
    (try
      (let [decoder
            (doto (.newDecoder java.nio.charset.StandardCharsets/UTF_8)
              (.onMalformedInput java.nio.charset.CodingErrorAction/REPORT)
              (.onUnmappableCharacter java.nio.charset.CodingErrorAction/REPORT))]
        (str (.decode decoder (java.nio.ByteBuffer/wrap bytes))))
      (catch java.nio.charset.CharacterCodingException _
        (fail! "fenced value must be valid UTF-8")))))

(let [[port-token maybe-format & tail] *command-line-args*
      json? (= maybe-format "--json")
      [verb & args] (if json? tail (cons maybe-format tail))
      port (positive-long "port" port-token)
      _ (when (> port 65535) (fail! "port must be at most 65535"))
      result
      (case verb
     "acquire"
     (send-op port {:op :acquire-lease
                    :res (required-text "resource" (nth args 0 nil))
                    :holder (required-text "holder" (nth args 1 nil))
                    :ttl-ms (positive-long "ttl-ms" (nth args 2 nil))})
     "renew"
     (send-op port {:op :renew-lease
                    :res (required-text "resource" (nth args 0 nil))
                    :holder (required-text "holder" (nth args 1 nil))
                    :epoch (positive-long "epoch" (nth args 2 nil))
                    :ttl-ms (positive-long "ttl-ms" (nth args 3 nil))})
     "release"
     (send-op port
              (cond-> {:op :release-lease
                       :res (required-text "resource" (nth args 0 nil))
                       :holder (required-text "holder" (nth args 1 nil))}
                (nth args 2 nil)
                (assoc :epoch (positive-long "epoch" (nth args 2)))))
     "fence"
     (send-op port {:op :fence-ok
                    :res (required-text "resource" (nth args 0 nil))
                    :holder (required-text "holder" (nth args 1 nil))
                    :epoch (positive-long "epoch" (nth args 2 nil))})
     "put-fenced-stdin"
     (north.coord/put-with-fence!
      port
      {:resource (required-text "resource" (nth args 0 nil))
       :holder (required-text "holder" (nth args 1 nil))
       :epoch (positive-long "epoch" (nth args 2 nil))}
      (required-text "subject" (nth args 3 nil))
      (required-text "predicate" (nth args 4 nil))
      (read-fenced-value))
     "status"
     (send-op port {:op :status})
     (fail! (str "unknown verb: " verb)))]
  (if json?
    (println (json/generate-string result))
    (prn result)))
