;; pred-cli.clj — the @pred:* PREDICATE REGISTRY (Foundation thread 019f100f
;; Part C / roadmap decision 10). Predicates become first-class @pred:<name>
;; entities carrying cardinality / value_kind / doc / minted_by / minted_at as
;; facts, with same_as ALIAS edges so a content-addressed rename never orphans
;; history. The registry is the substrate the cardinality keystone (thread B)
;; reads from: it is grounded in the SAME single|multi / literal|ref vocabulary
;; the engine schema uses (fram.schema setup! / def-predicate!).
;;
;; SCOPE NOTE: the registry lives as @pred:* FACTS over the canonical :7977 wire
;; (the north analogue of s/setup!), NOT as an edit to the engine. Engine
;; fram/schema.bclj is @graph-upstream (text edits forbidden) and folding the
;; registry into the daemon's bootstrap is thread B's step — explicitly gated on
;; B owning what 'single' means. This thread builds the registry + the lint guard;
;; it does NOT touch engine code.
;;
;; usage:
;;   bb pred-cli.clj <port> seed                                  register the whole vocabulary ONCE
;;   bb pred-cli.clj <port> define <name> <single|multi> <literal|ref> ["doc"] [minted_by]
;;   bb pred-cli.clj <port> alias  <old-name> <new-name>          @pred:<old> same_as @pred:<new>
;;   bb pred-cli.clj <port> ls                                    every registered predicate
;;   bb pred-cli.clj <port> show   <name>                         one predicate (alias-resolved)
;;   bb pred-cli.clj <port> lint   [--strict]                     flag cli/*.clj predicate literals with no registry entry
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str] '[clojure.walk :as walk])

;; shared coord substrate (Foundation Part B): the wire helpers live once in cli/coord.clj.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op  north.coord/send-op)
(def append!  north.coord/append!)
(def put!     north.coord/put!)
(def retract! north.coord/retract!)
(def resolved north.coord/resolved)
(def many     north.coord/many)

(def PRED-NS "@pred:")
(defn pred-ent  [nm]  (str PRED-NS nm))
(defn pred-name [ent] (let [s (str ent)] (if (str/starts-with? s PRED-NS) (subs s (count PRED-NS)) s)))

;; single-valued registry field = clear current values, then put! (LWW). The
;; pred_cardinality / pred_value_kind / doc / minted_* fields aren't in the engine's
;; single set, so a bare write would ACCUMULATE — supersede EXPLICITLY (retract loop),
;; uniform regardless of engine cardinality. same_as is multi (plain append!).
(defn set-1! [port te p v]
  (doseq [old (many port te p)] (retract! port te p old))
  (put! port te p (str v)))

;; ============================================================================
;; VOCAB — the authoritative registry definition, seeded ONCE. [name card kind doc]
;; Drawn from the structural inventory of every predicate the *-cli.clj scripts mint
;; (55), plus the registry's own meta-predicates (6) and the @run telemetry set.
;; ref = the object is an @-ref to another entity; literal = an interned value.
;; ============================================================================
(def VOCAB
  [;; --- registry meta-predicates (the registry describes itself) ---
   ;; NOTE: stored under pred_cardinality / pred_value_kind, NOT the bare
   ;; cardinality / value_kind. The engine RESERVES those four names
   ;; (#{name cardinality value_kind store-supersedes}) and FILTERS any domain
   ;; fact using them out of the flat-log replay (coord_daemon L1468/L1474),
   ;; so an @pred:X cardinality fact is silently dropped on the next reload. The
   ;; grounding is the VALUE vocabulary (single|multi, literal|ref), unchanged.
   ["pred_cardinality" "single" "literal" "single|multi — is this predicate single-valued?"]
   ["pred_value_kind"  "single" "literal" "literal|ref — interned value vs @-ref object"]
   ["doc"         "single" "literal" "human description of a predicate"]
   ["minted_by"   "single" "literal" "who registered this predicate"]
   ["minted_at"   "single" "literal" "instant the predicate was registered"]
   ["same_as"     "multi"  "ref"     "alias edge: this @pred:* is the same predicate as the target (content-addressed rename)"]
   ;; --- agent / session / role (presence-cli, dispatch-guard) ---
   ["agent"          "single" "literal" "handle this session/run belongs to"]
   ["dir"            "single" "literal" "working directory of a session"]
   ["session_id"     "single" "literal" "session id of a presence registration"]
   ["started_at"     "single" "literal" "instant a session started"]
   ["task"           "single" "literal" "current task description"]
   ["model"          "single" "literal" "model id an agent runs"]
   ["effort"         "single" "literal" "reasoning-effort knob"]
   ["context_tokens" "single" "literal" "agent context window size"]
   ["lifecycle"      "single" "literal" "agent lifecycle (standing|ephemeral|…)"]
   ["supervisor"     "single" "literal" "supervising agent handle"]
   ["generation"     "single" "literal" "agent context generation counter"]
   ["last_run_at"    "single" "literal" "instant of the agent's last run"]
   ["spawned_at"     "single" "literal" "instant an agent was spawned"]
   ["prev_input_tokens"      "single" "literal" "input tokens of the previous run"]
   ["playbook_count_at_boot" "single" "literal" "playbook size at boot (drift baseline)"]
   ["needs_rotation" "single" "literal" "flag: agent context should be compacted"]
   ["pinned"         "single" "literal" "flag: agent surfaces first in the roster"]
   ["pin_reason"     "single" "literal" "why an agent is pinned"]
   ["current_thread" "single" "literal" "the agent's current thread focus"]
   ["active_workflow" "single" "literal" "the agent's current workflow focus"]
   ["exclusivity"    "single" "literal" "exclusive|inclusive role occupancy"]
   ["holds"          "multi"  "ref"     "roles (@role:*) an agent holds"]
   ["watches"        "multi"  "ref"     "threads (@…) an agent subscribes to"]
   ["learning"       "multi"  "literal" "playbook learnings accumulated on a thread"]
   ;; --- messaging (msg-cli, inbox-peek, north-listen) ---
   ["from"     "single" "literal" "sender handle of a message"]
   ["to"       "single" "literal" "recipient handle/role/wildcard of a message"]
   ["subject"  "single" "literal" "message subject line"]
   ["body"     "single" "literal" "message body (text or command envelope)"]
   ["sent_at"  "single" "literal" "instant a message was sent"]
   ["schema"   "single" "literal" "JSON schema a message's reply must satisfy"]
   ["acked_at" "single" "literal" "instant a message was acked"]
   ["acked_by" "multi"  "literal" "handles that have acked this message"]
   ;; --- concerns (concern-cli) ---
   ["title"   "single" "literal" "human-readable title (presence ⇒ a thread)"]
   ["kind"    "single" "literal" "structural kind tag (e.g. concern)"]
   ["intent"  "single" "literal" "what a concern is building"]
   ["repo"    "single" "literal" "repo a concern touches"]
   ["status"  "single" "literal" "DERIVED concern status (max `reached` level); legacy single-write retained for lint only"]
   ["reached" "multi"  "literal" "monotone maturity level a concern has reached (exploring|building|likely-to-land|landed); status = max level (decision 8: status is derived, never set)"]
   ["driver"  "single" "ref"     "the @handle currently driving a thread/concern (presence ⇒ active)"]
   ["touches" "multi"  "literal" "file paths a concern touches (display label + the path-string footprint fallback for non-flipped repos)"]
   ["footprint" "multi" "ref"    "code NODE (@mod#n) in a concern's footprint — the cross-frame bridge (thread 019f1010-2705); asserted on the repo's warm CODE port, joined via the daemon's calls_defn blast closure (calls_defn itself is a fram daemon-internal derived edge, not a :7977 fact)"]
   ["code_port" "single" "literal" "port of the repo's warm code daemon, so a reader finds where a concern's footprint code store lives"]
   ;; --- fan-out / barrier (north-map) ---
   ["batch_kind"     "single" "literal" "kind of fan-out batch"]
   ["expected_count" "single" "literal" "N workers expected in a fan-out batch"]
   ["barrier_k"      "single" "literal" "K threshold for the K-of-N barrier"]
   ["barrier_status" "single" "literal" "derived barrier state of a batch"]
   ["role_template"  "single" "literal" "role-slug template for a fan-out batch"]
   ["created_at"     "single" "literal" "creation instant"]
   ["done_schema"    "single" "literal" "JSON schema a batch's DONE payloads must satisfy"]
   ["done_batch"     "single" "ref"     "the @batch this DONE belongs to"]
   ["done_worker"    "single" "literal" "handle of the worker that reported DONE"]
   ["done_payload"   "single" "literal" "a worker's DONE payload"]
   ["done_at"        "single" "literal" "instant a worker reported DONE"]
   ["worker"         "multi"  "literal" "worker handles spawned under a batch"]
   ;; --- swarm budget (north-listen) ---
   ["budget_total" "single" "literal" "the swarm token/cost budget ceiling"]
   ;; (budget_spent removed — budget is now derived: Σ(@run cost_usd), no mutated cell)
   ;; --- run telemetry (presence-cli runmeta / north-reconcile) ---
   ["cost_usd"       "single" "literal" "real USD cost of a run"]
   ["ended_at"       "single" "literal" "instant a run ended"]
   ["input_tokens"   "single" "literal" "run input tokens"]
   ["output_tokens"  "single" "literal" "run output tokens"]
   ["cache_read_tokens"   "single" "literal" "run cache-read tokens"]
   ["cache_create_tokens" "single" "literal" "run cache-create tokens"]
   ["duration_ms"    "single" "literal" "run wall duration (ms)"]
   ["num_turns"      "single" "literal" "agent turns in a run"]
   ["stop_reason"    "single" "literal" "why a run stopped"]
   ["wall_s"         "single" "literal" "run wall duration (s)"]
   ["estimate_output_tokens" "single" "literal" "predicted output tokens"]
   ["confidence"     "single" "literal" "agent self-reported confidence"]
   ["caveman"        "single" "literal" "caveman-mode flag for a run"]
   ["timed_out"      "single" "literal" "flag: a run hit its time budget"]])

(def VOCAB-CARD (into {} (map (fn [[n c k d]] [n {:card c :kind k :doc d}]) VOCAB)))

;; ---- registry reads ----
(defn register! [port nm card kind doc minter]
  (let [e (pred-ent nm)]
    (set-1! port e "pred_cardinality" card)   ; NOT "cardinality" — engine-reserved, see VOCAB note
    (set-1! port e "pred_value_kind"  kind)
    (when (seq (str doc)) (set-1! port e "doc" doc))
    (set-1! port e "minted_by" (or minter "pred-cli"))
    (set-1! port e "minted_at" (str (java.time.Instant/now)))
    e))

;; follow same_as transitively to the canonical entry (seen-set bounded, so an
;; accidental alias cycle terminates rather than spins).
(defn canonical [port nm]
  (loop [cur nm seen #{}]
    (if (contains? seen cur)
      cur
      (if-let [al (first (many port (pred-ent cur) "same_as"))]
        (recur (pred-name al) (conj seen cur))
        cur))))

;; every @pred:<name> that has a cardinality fact in the live graph.
(defn graph-pred-names [port]
  (->> (:ok (send-op port {:op :query
                           :query {:find "e"
                                   :rules [{:head {:rel "e" :args [{:var "e"}]}
                                            :body [{:rel "triple" :args [{:var "e"} "pred_cardinality" {:var "_"}]}]}]}}))
       (map first)
       (filter #(str/starts-with? (str %) PRED-NS))
       (map pred-name)
       set))

;; registry membership for lint = the in-code VOCAB ∪ whatever is live in the graph.
;; VOCAB alone makes lint work offline (CI without a seeded daemon); the graph union
;; reflects predicates registered at runtime via `define`.
(defn registry-set [port]
  (into (set (keys VOCAB-CARD))
        (try (graph-pred-names port) (catch Exception _ #{}))))

;; ============================================================================
;; structural predicate extraction — the lint engine. Read each cli/*.clj with the
;; babashka reader (no regex fragility) and walk for predicate-POSITION string
;; literals: the 3rd arg of a wire helper, a :p map key, and the middle of a
;; datalog `triple` arg-vector. Returns {predicate -> #{files}}.
;; ============================================================================
(def pred-fns '#{append! put! swap! assert! retract! resolved one many rf rmany set-single! set-1!})

(defn read-forms [path]
  (with-open [rdr (java.io.PushbackReader. (io/reader path))]
    (let [eof (Object.)]
      (loop [acc []]
        (let [f (read {:eof eof :read-cond :allow} rdr)]
          (if (= f eof) acc (recur (conj acc f))))))))

(def pred-fn-names (set (map name pred-fns)))   ; match on simple name so a fully-qualified
                                                ; north.coord/append! is caught like a bare append!
(defn preds-in-form [form]
  (let [found (atom #{})]
    (walk/postwalk
     (fn [x]
       (when (and (seq? x) (symbol? (first x)) (contains? pred-fn-names (name (first x))))
         (let [p (nth (vec x) 3 nil)] (when (string? p) (swap! found conj p))))
       (when (map? x)
         (when (string? (:p x)) (swap! found conj (:p x)))
         (when (and (= "triple" (:rel x)) (vector? (:args x)) (= 3 (count (:args x))))
           (let [p (nth (:args x) 1)] (when (string? p) (swap! found conj p)))))
       x)
     form)
    @found))

(defn lint-files []
  (->> (file-seq (io/file (str (.getParent (io/file (System/getProperty "babashka.file"))))))
       (filter #(str/ends-with? (.getName %) ".clj"))
       ;; the wire substrate + the pure validator carry no domain predicates.
       (remove #(#{"coord.clj" "schema-validate.clj"} (.getName %)))
       (sort-by #(.getName %))))

(defn scan-preds []
  (let [acc (atom {})]
    (doseq [f (lint-files)]
      (doseq [p (reduce into #{} (map preds-in-form (read-forms (str f))))]
        (swap! acc update p (fnil conj #{}) (.getName f))))
    @acc))

;; ============================================================================
(let [[ps verb & args] *command-line-args*
      port (Integer/parseInt (or ps "7977"))]
  (case verb
    "seed"
    (do (doseq [[n c k d] VOCAB] (register! port n c k d "seed"))
        (println (str "✓ seeded " (count VOCAB) " predicates into the @pred:* registry on :" port)))

    "define"
    (let [[nm card kind doc minter] args]
      (when-not (and nm (#{"single" "multi"} card) (#{"literal" "ref"} kind))
        (println "usage: pred-cli.clj <port> define <name> <single|multi> <literal|ref> [\"doc\"] [minted_by]")
        (System/exit 2))
      (let [e (register! port nm card kind doc minter)]
        (println (str "✓ " e "  cardinality=" card " value_kind=" kind (when (seq (str doc)) (str " doc=" (pr-str doc)))))))

    "alias"
    (let [[old new] args]
      (when-not (and old new)
        (println "usage: pred-cli.clj <port> alias <old-name> <new-name>") (System/exit 2))
      (append! port (pred-ent old) "same_as" (pred-ent new))   ; multi (alias edges accumulate)
      (println (str "✓ " (pred-ent old) " same_as " (pred-ent new) "  (reads of '" old "' now resolve to '" new "')")))

    "ls"
    (let [names (sort (registry-set port))]
      (println (format "@pred:* REGISTRY — %d predicates on :%d" (count names) port))
      (println (format "  %-24s %-7s %-8s %s" "NAME" "CARD" "KIND" "DOC"))
      (doseq [nm names]
        (let [c (pred-ent (canonical port nm)), v (VOCAB-CARD nm)
              card (or (resolved port c "pred_cardinality") (:card v) "?")
              kind (or (resolved port c "pred_value_kind")  (:kind v) "?")
              doc  (or (resolved port c "doc")              (:doc  v) "")]
          (println (format "  %-24s %-7s %-8s %s" nm card kind doc)))))

    "show"
    (let [[nm] args
          canon (canonical port nm)
          c (pred-ent canon)]
      (when-not nm (println "usage: pred-cli.clj <port> show <name>") (System/exit 2))
      (println (str (pred-ent nm) (when (not= canon nm) (str "  ──same_as──▶  " (pred-ent canon)))))
      (let [labels {"pred_cardinality" :card "pred_value_kind" :kind "doc" :doc}, v (VOCAB-CARD canon)]
        (doseq [p ["pred_cardinality" "pred_value_kind" "doc" "minted_by" "minted_at"]]
          (println (format "  %-17s %s" p (or (resolved port c p) (some-> (labels p) v) "-")))))
      (let [fwd (many port (pred-ent nm) "same_as")
            rev (->> (:ok (send-op port {:op :query
                          :query {:find "e" :rules [{:head {:rel "e" :args [{:var "e"}]}
                                   :body [{:rel "triple" :args [{:var "e"} "same_as" (pred-ent nm)]}]}]}}))
                     (map first))]
        (when (seq fwd) (println (str "  aliases  →  " (str/join ", " fwd))))
        (when (seq rev) (println (str "  aliased ← by  " (str/join ", " rev))))))

    "lint"
    (let [strict (some #{"--strict"} args)
          reg (registry-set port)
          used (scan-preds)
          misses (->> used (remove (fn [[p _]] (contains? reg p))) (sort-by first))]
      (println (format "pred lint — %d predicate literals across %d files, registry has %d entries"
                       (count used) (count (lint-files)) (count reg)))
      (if (empty? misses)
        (println "  ✓ clean — every predicate-position literal has a @pred:* registry entry")
        (do (println (str "  ✗ " (count misses) " predicate literal(s) with NO registry entry:"))
            (doseq [[p fs] misses] (println (format "    %-24s used in %s" p (str/join "," (sort fs)))))
            (println "  -> add each with `pred-cli.clj <port> define <name> <card> <kind>` (or seed)")
            (when strict (System/exit 1)))))

    (do (println "usage: pred-cli.clj <port> {seed | define <n> <card> <kind> [doc] | alias <old> <new> | ls | show <n> | lint [--strict]}")
        (System/exit 2))))
