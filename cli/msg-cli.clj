;; msg-cli.clj — messaging-as-facts (North gate-2, primitive 3) + command-as-facts.
;; A message = @msg:<id> facts (human mail); a COMMAND = @cmd:<id> facts (op/target/args
;; each a separate fact, NEVER an opaque {:op :args} body blob). ack = a fact (acked_by);
;; inbox/done/pending = DERIVED queries. The coordinator STORES + (with scoped-subscribe)
;; NOTIFIES; it never ROUTES. Wire (daemon): :assert / :version / :query / :resolved.
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str])

;; Reply-schema sidecar (the old rec4 JSON-Schema field + `validate` verb + schema-validate.clj)
;; is GONE (assessment §3.3): it reimplemented a JSON-Schema engine duplicating the coordinator's
;; own commit-time rule-check (closed-vocab/cardinality/dangling-ref). A reply is now just a FACT
;; — the coordinator's commit rule-check IS the validator; a rejected fact IS the invalid reply.

;; shared coord substrate: cardinality-typed write verbs + the command-as-facts
;; pending rule (move-C) live once in cli/coord.clj. append! = MULTI coexist; put! =
;; SINGLE last-writer-wins; pending-cmds = the single Datalog rule the reactor shares.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op north.coord/send-op)
(def append! north.coord/append!)
(def put!    north.coord/put!)
(def one     north.coord/resolved)
(def many    north.coord/many)

(defn messages [port]      ; -> [[@msg-entity to-handle] ...]  (every entity carrying a `to`)
  (:ok (send-op port {:op :query
                      :query {:find "m"
                              :rules [{:head {:rel "m" :args [{:var "e"} {:var "to"}]}
                                       :body [{:rel "triple" :args [{:var "e"} "to" {:var "to"}]}]}]}})))

(defn for-me? [to me] (or (= to me) (= to "*")))   ; group ("beagle-*") expansion = a later demand-driven add

(defn fresh-id [from]   ; yyyyMMdd-HHmmss-<from>-<4hex>: ts prefix sorts, hex suffix dodges same-second aliasing
  (str (.format (java.time.LocalDateTime/now)
                (java.time.format.DateTimeFormatter/ofPattern "yyyyMMdd-HHmmss"))
       "-" from "-" (format "%04x" (rand-int 0x10000))))

;; --- command-as-facts --------------------------------------------------------
;; A command is NOT an opaque {:op :args} EDN blob in one `body` cell (the old cargo-cult,
;; whose parse-envelope parser was duplicated across this file + north-listen.clj "MUST
;; stay in sync"). It is FACTS on @cmd:<id>: `op` + `target` (routing handle) + one fact
;; per arg, so the graph can query/supersede/attach-provenance to each, and the reactor
;; drives off fact-patterns (a Datalog rule), never a string parse.
;;
;; CONTENT-ADDRESSED id = SHA-256(op, args, target) → a re-send is the SAME @cmd:<id>, so
;; re-asserting identical facts is an engine no-op (commit! idempotency): exactly-once
;; intake with zero dedup bookkeeping.
;;
;; known-ops = a CLOSED VOCAB held as facts (@cmd:vocab known_op …), validated at intake —
;; single-source + queryable, not a #{…} set duplicated in two files.
(def vocab-subj  "@cmd:vocab")
(def default-ops ["dispatch" "spawn" "tell" "acquire"])
(defn known-ops [port] (set (many port vocab-subj "known_op")))
(defn ensure-vocab! [port]   ; idempotent seed: append! is a no-op once the vocab fact exists
  (when-not (seq (known-ops port))
    (doseq [op default-ops] (append! port vocab-subj "known_op" op)))
  (known-ops port))

(defn content-id
  "Stable @cmd id = first 16 hex of SHA-256(op | canonical-args | target). A re-send of the
   same (op,args,target) hashes identically → idempotent exactly-once intake."
  [op args target]
  (let [canon (str op " " (pr-str (into (sorted-map) args)) " " target)
        bs    (.digest (java.security.MessageDigest/getInstance "SHA-256") (.getBytes canon "UTF-8"))]
    (apply str (map #(format "%02x" %) (take 8 bs)))))

(defn arg-pred [k] (str/replace (name k) "-" "_"))   ; :ttl-ms -> "ttl_ms"

(defn parse-args
  "Read the <args-edn> map. The SDK's command_peer emits ref values (@id, @lease:x) RAW —
   valid north refs but not EDN (edn rejects a leading @), so quote bare @-tokens first;
   the @-string value is then stored as a fact and the engine's ref-shape makes it a link."
  [s]
  (try (edn/read-string (str/replace (str s) #"@[^\s,}\]]+" #(str \" % \")))
       (catch Exception _ ::bad)))

(let [[port verb & args] *command-line-args*
      port (Integer/parseInt port)]
  (case verb
    "send"        ; <from> <to> "<subject>" "<body>"  — human mail
    (let [[from to subj body] args
          e (str "@msg:" (fresh-id from))]
      ;; write content facts first, `to` LAST: the listener triggers on `to`, so landing it
      ;; last means from/subject/body are already visible — no settle race, no sleep.
      (put! port e "from" from)              ; single — all message fields are write-once on a fresh @msg
      (put! port e "subject" (or subj ""))
      (put! port e "body" (or body ""))
      (put! port e "sent_at" (str (java.time.Instant/now)))
      (put! port e "to" to)
      (println (str "sent " e " -> " to)))

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
      (println (str "acked_by: " (str/join ", " (many port e "acked_by")))))

    "ack"         ; <me> <msg-id-or-cmd-id>  — works for @msg and @cmd subjects
    (let [[me id] args, e (if (str/starts-with? (str id) "@") id (str "@msg:" id))]
      (append! port e "acked_by" me)                       ; multi (many ackers)
      (put!    port e "acked_at" (str (java.time.Instant/now))) ; single
      (println (str me " acked " e)))

    "send-cmd"    ; <from> <target> <op> "<args-edn>"  — assert a command as FACTS on @cmd:<id>
    (let [[from target op args-edn] args
          ops  (ensure-vocab! port)
          argm (parse-args (or args-edn "{}"))]
      (cond
        (not (contains? ops op))
        (do (println (str "REJECTED: unknown op " (pr-str op) " (known: " (str/join " " (sort ops)) ")")) (System/exit 2))
        (= argm ::bad)
        (do (println "REJECTED: <args-edn> is not valid EDN") (System/exit 2))
        (not (map? argm))
        (do (println "REJECTED: <args-edn> must be an EDN map") (System/exit 2))
        :else
        (let [e (str "@cmd:" (content-id op argm target))]
          ;; arg facts + provenance + op first; `target` (the routing key the reactor
          ;; triggers on) LAST → op/args already visible when it lands (no settle race).
          ;; All write-once (put!): a re-send re-asserts identical facts = idempotent no-op.
          (doseq [[k v] argm] (put! port e (arg-pred k) (str v)))
          (put! port e "from" from)
          (put! port e "op" op)
          (put! port e "target" target)
          (println (str "sent cmd " e " op=" op " -> " target "  args=" (pr-str argm))))))

    "cmd"         ; <cmd-id>  — show ALL facts on a command (it is a queryable subject now)
    (let [[id] args, e (str "@cmd:" id)
          rows (:ok (send-op port {:op :query
                                   :query {:find "pv"
                                           :rules [{:head {:rel "pv" :args [{:var "p"} {:var "o"}]}
                                                    :body [{:rel "triple" :args [e {:var "p"} {:var "o"}]}]}]}}))]
      (if (seq rows)
        (doseq [[p o] (sort rows)] (println (format "%-12s %s" p o)))
        (println (str "no facts on " e))))

    "cmds"        ; [target]  — list PENDING commands (no acked_by), optionally scoped to a target
    (let [rows (sort (or (north.coord/pending-cmds port) []))
          [tgt] args]
      (println (format "%-24s %-10s %s" "CMD" "OP" "TARGET"))
      (doseq [[c op t] rows]
        (when (or (nil? tgt) (= t tgt))
          (println (format "%-24s %-10s %s" c op t)))))

    (do (println "usage: msg-cli.clj <port> {send|send-cmd|cmd|cmds|inbox|thread|ack}") (System/exit 2))))
