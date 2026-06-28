;; msg-cli.clj — messaging-as-claims (Lodestar gate-2, primitive 3). Sibling to presence-cli/lease-cli.
;; A message = @msg:<id> claims; ack = a claim (acked_by); inbox/done = DERIVED queries. The coordinator
;; STORES + (with scoped-subscribe) NOTIFIES; it never ROUTES. Replaces mbox/ + ack-by-move-to-done/.
;; Wire (daemon): :assert / :version / :query / :resolved. `watch` needs §2 scoped-subscribe (poll until then).
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str])

;; Schema validation (rec4) — load the sibling validator so `send` can attach a JSON schema and the
;; new `validate` verb can check a payload against the schema a message carries. Sibling-relative so it
;; resolves no matter the cwd; the validator's own CLI stays dormant when load-file'd (main-guard).
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/schema-validate.clj"))

;; shared coord substrate: cardinality-typed write verbs (move-C) live once in
;; cli/coord.clj. append! = MULTI coexist; put! = SINGLE last-writer-wins.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op lodestar.coord/send-op)
(def append! lodestar.coord/append!)
(def put!    lodestar.coord/put!)
(def one     lodestar.coord/resolved)
(def many    lodestar.coord/many)

(defn messages [port]      ; -> [[@msg-entity to-handle] ...]  (every entity carrying a `to`)
  (:ok (send-op port {:op :query
                      :query {:find "m"
                              :rules [{:head {:rel "m" :args [{:var "e"} {:var "to"}]}
                                       :body [{:rel "triple" :args [{:var "e"} "to" {:var "to"}]}]}]}})))

(defn for-me? [to me] (or (= to me) (= to "*")))   ; group ("beagle-*") expansion = a later demand-driven add

;; --- Phase 0: structured command envelope ----------------------------------
;; A message body MAY be an EDN command the reactor (Phase 1) dispatches on:
;;   {:op :dispatch|:spawn|:tell|:claim  :args {...}}
;; Plain-string bodies stay valid (human mail) — only EDN maps starting `{` with a
;; known :op are commands. This is the one machine-dispatchable contract both sides agree on.
(def known-ops #{:dispatch :spawn :tell :claim})
(defn parse-envelope
  "Parse a message body as a command envelope. -> {:op kw :args map} on a valid
   command, {:error msg} on a malformed command, nil for a plain (non-command) body."
  [body]
  (when (and body (str/starts-with? (str/triml (str body)) "{"))
    (let [m (try (edn/read-string body) (catch Exception _ ::bad))]
      (cond
        (= m ::bad)               {:error "body looks like a command but is not valid EDN"}
        (not (map? m))            {:error "command envelope must be an EDN map"}
        (not (known-ops (:op m))) {:error (str "unknown :op " (pr-str (:op m)) " (known: " (str/join " " (sort (map name known-ops))) ")")}
        (not (map? (:args m)))    {:error ":args must be a map"}
        :else                     {:op (:op m) :args (:args m)}))))

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
      (put! port e "from" from)              ; single — all message fields are write-once on a fresh @msg
      (put! port e "to" to)
      (put! port e "subject" (or subj ""))
      (put! port e "body" (or body ""))
      (put! port e "sent_at" (str (java.time.Instant/now)))
      ;; rec4: optional JSON schema the recipient's structured reply must satisfy. Absent => no claim,
      ;; identical to pre-rec4 behavior.
      (let [has-schema (and schema (seq (str/trim schema)))]
        (when has-schema (put! port e "schema" schema))
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
      (append! port e "acked_by" me)                       ; multi (many ackers)
      (put!    port e "acked_at" (str (java.time.Instant/now))) ; single
      (println (str me " acked " e)))

    "send-cmd"    ; <from> <to> <op> "<args-edn>" — send a structured command envelope as the body
    (let [[from to op args-edn] args
          env {:op (keyword op) :args (try (edn/read-string (or args-edn "{}")) (catch Exception _ ::bad))}
          chk (parse-envelope (pr-str env))]
      (if (:error chk)
        (do (println (str "REJECTED: " (:error chk))) (System/exit 2))
        (let [id (str (.format (java.time.LocalDateTime/now)
                               (java.time.format.DateTimeFormatter/ofPattern "yyyyMMdd-HHmmss")) "-" from
                      "-" (format "%04x" (rand-int 0x10000)))
              e (str "@msg:" id)]
          (put! port e "from" from)              ; single — write-once on a fresh @msg
          (put! port e "to" to)
          (put! port e "subject" (str "cmd:" op))
          (put! port e "body" (pr-str env))
          (put! port e "sent_at" (str (java.time.Instant/now)))
          (println (str "sent cmd " e " -> " to "  " (pr-str env))))))

    "parse"       ; "<body>" — show how the reactor (Phase 1) would parse this body (dogfood/validate)
    (let [[body] args, r (parse-envelope body)]
      (println (cond (nil? r)   "PLAIN (not a command — handled as human mail)"
                     (:error r) (str "MALFORMED: " (:error r))
                     :else      (str "COMMAND op=" (:op r) " args=" (pr-str (:args r)))))
      (System/exit (if (:error r) 1 0)))

    (do (println "usage: msg-cli.clj <port> {send|send-cmd|parse|inbox|thread|ack|validate}") (System/exit 2))))
