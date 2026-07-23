;; msg-cli.clj — messaging-as-facts (North gate-2, primitive 3) + command-as-facts.
;; A message = @msg:<id> facts (human mail); a COMMAND = @cmd:<id> facts (op/target/args
;; each a separate fact, NEVER an opaque {:op :args} body blob). ack = a fact (acked_by);
;; inbox/done/pending = DERIVED queries. The coordinator STORES + (with scoped-subscribe)
;; NOTIFIES; it never ROUTES. Wire (daemon): :assert / :version / :query / :resolved.
(require '[cheshire.core :as json]
         '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str])

;; Reply-schema sidecar (the old rec4 JSON-Schema field + `validate` verb + schema-validate.clj)
;; is GONE (assessment §3.3): it reimplemented a JSON-Schema engine duplicating the coordinator's
;; own commit-time rule-check (closed-vocab/cardinality/dangling-ref). A reply is now just a FACT
;; — the coordinator's commit rule-check IS the validator; a rejected fact IS the invalid reply.

;; shared coord substrate: cardinality-typed write verbs + the command-as-facts
;; pending rule (move-C) live once in cli/coord.clj. append! = MULTI coexist; put! =
;; SINGLE last-writer-wins; pending-cmds = the single Datalog rule the reactor shares.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/topology-authority.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/message-audience.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/message-id.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/command-id.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/message-contract.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/agent-provenance.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/terminal-projection.clj"))
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/lifecycle-projection.clj"))
(def send-op north.coord/send-op)
(def append! north.coord/append!)
(def put!    north.coord/put!)
(def one     north.coord/resolved)
(def many    north.coord/many)

(def steer-control-pattern #"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
(def target-identity-manifest-predicate "target_identity_manifest_sha256")
(def max-steer-run-candidates 128)
(defn reject-message! [message]
  (binding [*out* *err*] (println (str "REJECTED: message " message)))
  (System/exit 2))
(defn validate-message-input! [from to subject body]
  (when-let [problem
             (north.message-contract/input-problem from to subject body)]
    (reject-message! problem))
  true)
(defn reject-steer! [message]
  (binding [*out* *err*] (println (str "REJECTED: steer " message)))
  (System/exit 2))

(defn steer-agent-facts [port control]
  (try
    (north.lifecycle-projection/folded-agent-point-facts
     (fn [subject predicate] (many port subject predicate))
     (str "@agent:" control))
    (catch Exception _
      (reject-steer! "target identity is unavailable"))))

(defn steer-run-entries [port control]
  (try
    (let [response
          (north.coord/query-page
           port
           {:find "steer_run_candidate"
            :rules
            [{:head {:rel "steer_run_candidate"
                     :args [{:var "e"}]}
              :body [{:rel "triple"
                      :args [{:var "e"} "agent" control]}]}]}
           max-steer-run-candidates nil)
          rows (:ok response)]
      (when-not
       (and (map? response) (vector? rows)
            (false? (:more response))
            (<= (count rows) max-steer-run-candidates)
            (every? #(and (vector? %) (= 1 (count %))
                          (every? string? %))
                    rows))
        (reject-steer! "target lifecycle is unavailable"))
      (->> rows
           (map first)
           (filter north.terminal-projection/valid-run-entity?)
           distinct
           sort
           (mapv
            (fn [subject]
              {:subject subject
               :facts
               (into {}
                     (keep (fn [predicate]
                             (let [values (set (many port subject predicate))]
                               (when (seq values) [predicate values]))))
                     north.terminal-projection/run-resolution-predicates)}))))
    (catch Exception _
      (reject-steer! "target lifecycle is unavailable"))))

(defn require-live-steer! [port control]
  (when-not (and (string? control)
                 (re-matches steer-control-pattern control))
    (reject-steer! "target is malformed"))
  (let [facts (steer-agent-facts port control)
        resolution
        (north.terminal-projection/lane-resolution
         control facts (steer-run-entries port control))
        provider (get facts "provider")
        live-input (get facts "live_input")
        live-input-state (get facts "live_input_state")]
    (when-not (north.agent-provenance/managed-valid? facts)
      (reject-steer! "target is not one exact committed managed lane"))
    (when (= :resolved (:status resolution))
      (reject-steer! "target is terminal"))
    (when (= :indeterminate (:status resolution))
      (reject-steer! "target lifecycle is inconsistent"))
    (let [online?
          (try (north.coord/online? port control)
               (catch Exception _ ::unavailable))]
      (when (= ::unavailable online?)
        (reject-steer! "target liveness is unavailable"))
      (when-not online?
        (reject-steer! "target is offline")))
    (when-not (= "streaming" live-input)
      (reject-steer!
       (str "target adapter does not support live input"
            (when (string? provider) (str " (provider " provider ")")))))
    (when-not (= "armed" live-input-state)
      (reject-steer!
       (str "target live input is not armed"
            (when (string? live-input-state)
              (str " (state " live-input-state ")")))))
    {:identity-manifest (get facts "identity_manifest_sha256")}))

(def fresh-id north.message-id/fresh-id)

;; --- command-as-facts --------------------------------------------------------
;; A command is NOT an opaque {:op :args} EDN blob in one `body` cell (the old cargo-cult,
;; whose parse-envelope parser was duplicated across this file + north-listen.clj "MUST
;; stay in sync"). It is FACTS on @cmd:<id>: `op` + `target` (routing handle) + one fact
;; per arg, so the graph can query/supersede/attach-provenance to each, and the reactor
;; drives off fact-patterns (a Datalog rule), never a string parse.
;;
;; Every invocation mints a fresh command id: two legitimate identical commands
;; are two executions. An optional explicit idempotency key derives a stable id
;; only for transport-level retry. `retry` reactivates the same command entity.
;;
;; known-ops = a CLOSED VOCAB held as facts (@cmd:vocab known_op …), validated at intake —
;; single-source + queryable, not a #{…} set duplicated in two files.
(def vocab-subj  "@cmd:vocab")
(def default-ops ["tell" "acquire"])
(def supported-ops (set default-ops))
(defn known-ops [port] (set (many port vocab-subj "known_op")))
(defn ensure-vocab! [port]
  ;; Converge stale live vocab facts too. Older generations advertised peer
  ;; spawn/dispatch; code-owned support must fail closed even before this cleanup.
  (let [known (known-ops port)]
    (doseq [op (remove supported-ops known)]
      (north.coord/retract! port vocab-subj "known_op" op))
    (doseq [op (remove known default-ops)] (append! port vocab-subj "known_op" op))
    supported-ops))

(def canonical-value north.command-id/canonical-value)
(def content-id north.command-id/content-id)
(def command-id north.command-id/command-id)

(defn arg-pred [k] (str/replace (name k) "-" "_"))   ; :ttl-ms -> "ttl_ms"

(defn parse-args
  "Read the <args-edn> map. The SDK's command_peer emits ref values (@id, @lease:x) RAW —
   valid north refs but not EDN (edn rejects a leading @), so quote bare @-tokens first;
   the @-string value is then stored as a fact and the engine's ref-shape makes it a link."
  [s]
  ;; Parse valid EDN first. Rewriting first corrupted already-quoted refs such as
  ;; `"@thread:x"` by consuming their closing quote and double-quoting them.
  (try
    (edn/read-string (str s))
    (catch Exception _
      (try (edn/read-string (str/replace (str s) #"@[^\s,}\]]+" #(str \" % \")))
           (catch Exception _ ::bad)))))

(defn canonical-json-value [value]
  (cond
    (map? value)
    (into
     (sorted-map-by
      #(compare (canonical-value %1) (canonical-value %2)))
     (map (fn [[key item]] [key (canonical-json-value item)]))
     value)
    (set? value)
    (mapv canonical-json-value
          (sort-by canonical-value value))
    (sequential? value)
    (mapv canonical-json-value value)
    (keyword? value) (name value)
    :else value))

(defn encoded-arg [value]
  ;; Structured staffing values cross the fact bus as canonical JSON. `(str v)`
  ;; produced EDN maps/vectors that routingMetadataFromEnv could not parse.
  (cond
    (or (map? value) (sequential? value) (set? value))
    (json/generate-string (canonical-json-value value))
    (keyword? value) (name value)
    :else (str value)))

(defn wake-command! [port command target]
  ;; Fram's scoped subscription contract routes only commits whose predicate is
  ;; `to` or `target`. A fresh wake subject preserves command history while its
  ;; target fact supplies the address-bearing activation edge.
  (let [wake (str "@cmd-wake:" (java.util.UUID/randomUUID))]
    (put! port wake "retry_command" command)
    (put! port wake "target" target)
    wake))

;; assert-batch! — ONE all-or-none publication of every fact in FACTS about TE.
;; Closes the torn-mail-subject window (thread 019f9063 / incident 019f8958):
;; the coordinator validates every fact before the first mutation and commits
;; them in a single tx (do-assert-batch, fram coord_daemon.clj:1237), so a
;; crash/disconnect between facts leaves the complete subject or nothing.
;; `to`/`target` are committed+notified LAST by the engine regardless of the
;; order FACTS is given in, so the pre-atomicity to-last delivery-candidacy
;; mitigation still holds structurally.
;;
;; COMPAT: the running coordinator generation may predate :assert-batch
;; (gen-1022; the op lands gen-1023). Such a daemon's op dispatch falls to its
;; default arm and answers {:error "unknown op"} — that specific rejection
;; falls back to the pre-atomicity sequential per-fact :assert path (loudly
;; flagged) so mail keeps flowing during the rollout window. Any OTHER
;; rejection is a genuine failure: the whole batch was refused and there is no
;; partial subject to clean up — that refusal IS the fix working.
(defn assert-batch-legacy! [port te facts]
  (binding [*out* *err*]
    (println
     (str "DEPRECATED: coordinator does not yet serve :assert-batch "
          "(pre-gen-1023) — falling back to per-fact :assert for " te
          "; upgrade the coordinator to close the torn-subject window")))
  (doseq [[p r] facts] (put! port te p r))
  {:ok :legacy-fallback})

(defn assert-batch! [port te facts]
  (let [response (send-op port
                          {:op :assert-batch :te te
                           :facts (mapv (fn [[p r]] {:p p :r (str r)}) facts)})]
    (cond
      (:ok response) response
      (= "unknown op" (:error response)) (assert-batch-legacy! port te facts)
      :else (reject-message! (str te " publication rejected: " (:reject response))))))

(let [[port verb & args] *command-line-args*
      port (Integer/parseInt port)]
  (case verb
    "send"        ; <from> <to> "<subject>" "<body>"  — human mail
    (let [[from to subj body] args
          _ (when-not (= 4 (count args))
              (reject-message! "send requires exactly from, to, subject, and body"))
          _ (validate-message-input! from to subj body)
          steer? (= "steer" (some-> subj str str/trim str/lower-case))
          steer-admission (when steer?
                            (north.topology-authority/require-coordination! "steer")
                            (require-live-steer! port to))
          e (str "@msg:" (fresh-id from))
      ;; Canonicalize the managed control type. Ordinary subjects retain their
      ;; original spelling; every producer-admitted steer is exactly "steer".
      ;; All message fields are write-once on a fresh @msg. `to`/`target` land
      ;; LAST (the listener triggers on it); assert-batch! guarantees that
      ;; ordering internally now, so no settle race, no sleep, and — for
      ;; ordinary mail — no torn subject either (thread 019f9063).
      front-facts
      (cond-> [["from" from]
               ["subject" (if steer? "steer" (or subj ""))]
               ["body" (or body "")]
               ["sent_at" (str (java.time.Instant/now))]]
        steer-admission
        (conj [target-identity-manifest-predicate
               (:identity-manifest steer-admission)]))]
      ;; `north steer` labels its control message exactly `steer`. Ordinary
      ;; worker -> coordinator completion/death mail remains legal; peer control
      ;; does not become legal merely because the producer bypassed agents-cli.
      (when steer-admission
        ;; Steer's `to` lands through its own CAS below (assert-after-read!),
        ;; not this batch — a route-change validation :assert-batch cannot
        ;; express. Publish the rest atomically first.
        (assert-batch! port e front-facts))
      ;; A broadcast's concrete recipients are durable facts, captured before
      ;; `to` lands. Sender exclusion is intentional: broadcast means peers.
      (let [broadcast-audience
            (when (= north.message-audience/broadcast-address to)
              (north.message-audience/snapshot-broadcast! port e from))]
        (if steer-admission
          ;; This is the steer acceptance linearization point. Every
          ;; load-bearing route read follows the global BASE capture, then Fram
          ;; compares BASE + lands `to` in one serialized writer turn. A freeze
          ;; between validation and this assert conflicts, retries the whole
          ;; route read, and cannot leave an accepted post-freeze message.
          (let [admitted-manifest (:identity-manifest steer-admission)
                result
                (north.coord/assert-after-read!
                 port e "to" to
                 (fn []
                   (let [current (require-live-steer! port to)
                         stored (one port e target-identity-manifest-predicate)]
                     (when-not (and (= admitted-manifest stored)
                                    (= admitted-manifest
                                       (:identity-manifest current)))
                       (reject-steer!
                        "target route changed during message admission"))
                     true)))]
            (when (:reject result)
              (reject-steer!
               "target route changed during message admission")))
          ;; Ordinary mail: from/subject/body/sent_at/to publish as ONE
          ;; all-or-none unit — the torn-mail fix. assert-batch! still lands
          ;; `to` last inside the batch (delivery-trigger-preds ordering).
          (assert-batch! port e (conj front-facts ["to" to])))
        (println (str (if steer? "queued for live injection " "sent ") e " -> " to
                      (when broadcast-audience
                        (str " (" (count broadcast-audience)
                             " snapshotted recipients; sender excluded)"))))))

    "inbox"       ; <me>  — direct-to-me OR finite broadcast audience, minus acked_by
    (let [[me] args]
      (println (format "%-28s %-10s %s" "MSG-ID" "FROM" "SUBJECT"))
      (doseq [e (sort (north.message-audience/pending-message-ids port me #{me}))]
        (println (format "%-28s %-10s %s" (subs e 5) (or (one port e "from") "?") (or (one port e "subject") "")))))

    "thread"      ; <msg-id>
    (let [[id] args, e (str "@msg:" id)]
      (doseq [p ["from" "to" "subject" "body" "sent_at"
                 north.message-audience/audience-version-predicate]]
        (println (format "%-9s %s" p (or (one port e p) "-"))))
      (println (str "broadcast_to: "
                    (str/join ", " (many port e north.message-audience/audience-predicate))))
      (println (str "acked_by: " (str/join ", " (many port e "acked_by"))))
      (println (str "delivery_rejected_by: "
                    (str/join ", " (many port e "delivery_rejected_by"))))
      (doseq [rejection (many port e "delivery_rejection")]
        (println (str "delivery_rejection: " rejection))))

    "ack"         ; <me> <msg-id-or-cmd-id>  — works for @msg and @cmd subjects
    (let [[me id] args, e (if (str/starts-with? (str id) "@") id (str "@msg:" id))]
      (when (and (str/starts-with? e "@msg:")
                 (not (north.message-audience/deliverable?
                       port e (one port e "to") me #{me})))
        (println (str "REJECTED: " e " is not addressed to " me))
        (System/exit 2))
      (append! port e "acked_by" me)                       ; multi (many ackers)
      (put!    port e "acked_at" (str (java.time.Instant/now))) ; single
      (println (str me " acked " e)))

    "send-cmd"    ; <from> <target> <op> "<args-edn>" [idempotency-key]
    (do
      ;; This is the lowest command producer. Guard before ensure-vocab!: that
      ;; helper can itself seed facts, so even its idempotent write is too late.
      (north.topology-authority/require-coordination! "send-cmd")
      (let [[from target op args-edn idempotency-key] args
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
        (let [e (str "@cmd:" (command-id op argm target idempotency-key))]
          ;; arg facts + provenance + op first; `target` (the routing key the reactor
          ;; triggers on) LAST → op/args already visible when it lands (no settle race).
          ;; All write-once (put!): a re-send re-asserts identical facts = idempotent no-op.
          (doseq [[k v] argm] (put! port e (arg-pred k) (encoded-arg v)))
          (put! port e "from" from)
          (put! port e "op" op)
          (put! port e "target" target)
          (println (str "sent cmd " e " op=" op " -> " target "  args=" (pr-str argm)))))))

    "retry"       ; <cmd-id> — explicit reactivation of a terminal failed command
    (do
      (north.topology-authority/require-coordination! "retry command")
      (let [[id] args
            e (if (str/starts-with? (str id) "@cmd:") id (str "@cmd:" id))
            failures (many port e "failed_by")
            retryable (one port e "retryable")
            target (one port e "target")
            requested (many port e "retry_requested")
            acknowledged (many port e "acked_by")]
        (cond
          (and (not (seq failures)) (seq requested) (not (seq acknowledged)) target)
          (do
            ;; Recovery for a producer that cleared failed_by and died before
            ;; publishing the addressed wake below. A repeated retry completes
            ;; the same activation rather than rejecting a now-markerless cmd.
            (wake-command! port e target)
            (println (str "retry wake replayed for " e)))
          (not (seq failures))
          (do (println (str "REJECTED: " e " is not terminal-failed")) (System/exit 2))
          (not= "true" retryable)
          (do (println (str "REJECTED: " e " is terminal non-retryable")) (System/exit 2))
          (str/blank? (str target))
          (do (println (str "REJECTED: " e " has no routing target")) (System/exit 2))
          :else
          (do
            ;; Durable retry intent first. If this process dies while failed_by
            ;; remains, the command stays terminal. If it dies after clearing
            ;; failed_by, the recovery branch above republishes the wake.
            (append! port e "retry_requested" (str (java.time.Instant/now)))
            (doseq [predicate ["execution_status" "failed_at" "retryable" "reply"]
                    value (many port e predicate)]
              (north.coord/retract! port e predicate value))
            (doseq [value failures]
              (north.coord/retract! port e "failed_by" value))
            ;; Scoped subscribers match addresses on the commit itself; a
            ;; failed_by retraction carries no address and cannot wake them.
            ;; Publish an explicit addressed activation edge LAST.
            (wake-command! port e target)
            (println (str "retry requested for " e))))))

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

    (do (println "usage: msg-cli.clj <port> {send|send-cmd|retry|cmd|cmds|inbox|thread|ack}") (System/exit 2))))
