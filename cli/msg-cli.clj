;; msg-cli.clj — messaging-as-claims (Lodestar gate-2, primitive 3). Sibling to presence-cli/lease-cli.
;; A message = @msg:<id> claims; ack = a claim (acked_by); inbox/done = DERIVED queries. The coordinator
;; STORES + (with scoped-subscribe) NOTIFIES; it never ROUTES. Replaces mbox/ + ack-by-move-to-done/.
;; Wire (daemon): :assert / :version / :query / :resolved. `watch` needs §2 scoped-subscribe (poll until then).
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str])

;; Schema validation (rec4) — load the sibling validator so `send` can attach a JSON schema and the
;; new `validate` verb can check a payload against the schema a message carries. Sibling-relative so it
;; resolves no matter the cwd; the validator's own CLI stays dormant when load-file'd (main-guard).
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/schema-validate.clj"))

(defn send-op [port op]
  (with-open [s (java.net.Socket. "127.0.0.1" (int port))]
    (let [w (.getOutputStream s) r (io/reader (.getInputStream s))]
      (.write w (.getBytes (str (pr-str op) "\n"))) (.flush w)
      (edn/read-string (.readLine r)))))

(defn assert! [port te p r]                 ; OCC at current :version; retry on reject
  (loop [tries 4]
    (let [v (:version (send-op port {:op :version}))
          res (send-op port {:op :assert :te te :p p :r (str r) :base v})]
      (if (and (:reject res) (pos? tries)) (recur (dec tries)) res))))

(defn one  [port te p] (:value  (send-op port {:op :resolved :te te :p p})))
(defn many [port te p] (:values (send-op port {:op :resolved :te te :p p})))  ; all values (multi-valued)

(defn messages [port]      ; -> [[@msg-entity to-handle] ...]  (every entity carrying a `to`)
  (:ok (send-op port {:op :query
                      :query {:find "m"
                              :rules [{:head {:rel "m" :args [{:var "e"} {:var "to"}]}
                                       :body [{:rel "triple" :args [{:var "e"} "to" {:var "to"}]}]}]}})))

(defn for-me? [to me] (or (= to me) (= to "*")))   ; group ("beagle-*") expansion = a later demand-driven add

(let [[port verb & args] *command-line-args*
      port (Integer/parseInt port)]
  (case verb
    "send"        ; <from> <to> "<subject>" "<body>" ["<json-schema>"]
    (let [[from to subj body schema] args
          ;; id = yyyyMMdd-HHmmss-<from>-<4hex>: timestamp prefix sorts; the random suffix makes it
          ;; collision-resistant (two sends in the same second from the same sender no longer alias to one
          ;; entity — that aliasing silently MERGES messages, i.e. data loss; the suffix is load-bearing).
          id (str (.format (java.time.LocalDateTime/now)
                           (java.time.format.DateTimeFormatter/ofPattern "yyyyMMdd-HHmmss")) "-" from
                  "-" (format "%04x" (rand-int 0x10000)))
          e (str "@msg:" id)]
      (assert! port e "from" from)
      (assert! port e "to" to)
      (assert! port e "subject" (or subj ""))
      (assert! port e "body" (or body ""))
      (assert! port e "sent_at" (str (java.time.Instant/now)))
      ;; rec4: optional JSON schema the recipient's structured reply must satisfy. Absent => no claim,
      ;; identical to pre-rec4 behavior.
      (let [has-schema (and schema (seq (str/trim schema)))]
        (when has-schema (assert! port e "schema" schema))
        (println (str "sent " e " -> " to (when has-schema "  [+schema]")))))

    "inbox"       ; <me>  — DERIVED: to∈{me,"*"} AND not acked_by me
    (let [[me] args]
      (println (format "%-28s %-10s %s" "MSG-ID" "FROM" "SUBJECT"))
      (doseq [[e to] (sort (or (messages port) []))]
        (when (and (for-me? to me) (not (contains? (set (many port e "acked_by")) me)))
          (println (format "%-28s %-10s %s" (subs e 5) (or (one port e "from") "?") (or (one port e "subject") ""))))))

    "thread"      ; <msg-id>
    (let [[id] args, e (str "@msg:" id)]
      (doseq [p ["from" "to" "subject" "body" "sent_at"]]
        (println (format "%-9s %s" p (or (one port e p) "-"))))
      (when-let [s (one port e "schema")] (println (format "%-9s %s" "schema" s)))
      (println (str "acked_by: " (str/join ", " (many port e "acked_by")))))

    "validate"    ; <msg-id> <payload-json>  — rec4 receiving-side gate: check a structured reply
                  ; against the schema this message carries. No schema => accepts (no-constraint).
    (let [[id payload] args, e (str "@msg:" id)
          schema (one port e "schema")
          {:keys [valid errors no-schema]} (lodestar.schema-validate/validate-json payload schema)]
      (if valid
        (println (str "VALID" (when no-schema " (message carries no schema)") " — payload accepted"))
        (do (println (str "INVALID — payload rejected for " e ", retry with a conforming reply:"))
            (doseq [er errors] (println (str "  - " er)))))
      (System/exit (if valid 0 1)))

    "ack"         ; <me> <msg-id>  — replaces mv mbox/<msg> mbox/done/
    (let [[me id] args, e (str "@msg:" id)]
      (assert! port e "acked_by" me)
      (assert! port e "acked_at" (str (java.time.Instant/now)))
      (println (str me " acked " e)))

    (do (println "usage: msg-cli.clj <port> {send|inbox|thread|ack|validate}") (System/exit 2))))
