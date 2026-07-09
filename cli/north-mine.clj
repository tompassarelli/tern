;; north-mine.clj <port> [--dry-run] [--full] [--root DIR] [--report FILE] [--limit N] [--verbose]
;;
;; Cognitive telemetry miner (thread 019f2036-3ca4): the stack learns from its own
;; operating record. Streams Claude Code session transcripts (~/.claude/projects/**/*.jsonl)
;; and extracts per-session STRUGGLE SIGNALS, then appends them AS FACTS through the
;; coordinator — the mining dual of sdk/src/telemetry.ts (which records run tuples) and
;; sdk/src/struggle.ts (which scores a LIVE run; same fingerprint scheme, applied post-hoc).
;;
;; The key reframe (program thread 019f200f-46f6): an agent's WRONG GUESSES are
;; VOCABULARY VOTES — when it calls a tool that doesn't exist, the name it reached for
;; is empirical evidence of the right surface. Signals mined per transcript unit:
;;   verb votes    — "No such tool available: X" tool_result errors -> attempted name
;;   input errors  — InputValidationError per tool (deferred-tool + param friction)
;;   retry loops   — same tool+input fingerprint failing >=3 times w/o a success
;;   guard denials — graph-upstream / racket-build / firn guard + hook blocks
;;   engine rejects— coordinator "reject:<reason>" replies (e.g. reserved predicate)
;;   doc re-reads  — the same .md Read from the top >=3 times in one session
;;
;; Facts land on a titleless "@mine:<transcript-stem>" subject (the @run:* pattern —
;; queryable via fram, invisible to the work views). Predicate vocabulary is kept SMALL,
;; reusing kind/session_id/repo/at/error_count/note; the one minted predicate is
;; `verb_vote` (multi, one fact per attempted name per session — a session votes once).
;;
;; IDEMPOTENT by construction: subjects are deterministic, objects are deterministic
;; (counts inside notes are BUCKETED so a still-growing session doesn't mint rivals),
;; and append! collapses identical (te,p,r) — re-running never duplicates. Incremental
;; state (path -> mtime/size) lives in ~/.local/state/north/north-mine/state.edn so the
;; steady-state run only touches changed files; --full rescans everything.
;;
;; PRIVACY: signals, not surveillance — only short verb/tool/doc names and truncated
;; error reasons are recorded, never message content.
;;
;; All writes go through the coordinator socket (cli/coord.clj append!/put!) — never
;; the facts.log directly. Streaming line-reader; snapshot lines and >8MB lines are
;; skipped unparsed; per-file line cap keeps a pathological transcript bounded.
(require '[clojure.java.io :as io]
         '[clojure.string :as str]
         '[clojure.edn :as edn]
         '[cheshire.core :as json])

;; shared coord substrate (Foundation Part B): send-op/append!/put! live once in cli/coord.clj.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))

(def ^:const MAX-LINE-BYTES (* 8 1024 1024))
(def ^:const MAX-LINES-PER-FILE 400000)
(def ^:const MAX-VOTES-PER-UNIT 12)
(def ^:const MAX-NOTES-PER-UNIT 30)
(def ^:const RETRY-THRESHOLD 3)
(def ^:const REREAD-THRESHOLD 3)

(def home (System/getProperty "user.home"))
(defn tilde [p] (if (and p (str/starts-with? p home)) (str "~" (subs p (count home))) p))

;; ---------------------------------------------------------------------------
;; content flattening — tool_result content is a string OR [{:type "text" :text ..}]
(defn content-text [c]
  (cond (string? c) c
        (sequential? c) (str/join "\n" (keep #(when (map? %) (:text %)) c))
        :else ""))

;; ---------------------------------------------------------------------------
;; signal matchers (structural: applied only to tool_result / hook-error fields,
;; never raw transcript lines — a grep dump QUOTING these strings can't false-positive
;; because quoted dumps ride non-error results and fail the shape guards below)
(defn unknown-tool [s]
  (when-let [[_ n] (re-find #"No such tool available: ([A-Za-z0-9_.:-]+)" s)]
    (str/replace n #"\.+$" "")))

(defn engine-reject [s]
  ;; a real coordinator reject reply is SHORT; long contents are code/doc reads.
  (let [t (str/trim s)]
    (when (and (<= (count t) 500) (str/includes? t "reject:"))
      (some-> (re-find #"reject:([^\n\"]{1,60})" t) second str/trim))))

(defn guard-label [s]
  (let [t (str/triml s)]
    (cond
      (str/includes? t "This file is GRAPH-OWNED")               "graph-upstream-guard"
      (str/includes? t "Racket version mismatch")                 "racket-build-guard"
      (str/includes? t "Stale bytecode")                          "racket-build-guard"
      (str/starts-with? t "BLOCKED:")                             "firn-guard"
      (str/includes? t "operation blocked by hook")               "hook-block"
      (str/starts-with? t "Permission for this action was denied by the Claude Code auto mode classifier")
      "auto-classifier"
      :else nil)))

;; same shape as struggle.ts fingerprint(): name + head of the canonical input
(defn fingerprint [nm input]
  (str nm "|" (let [s (try (json/generate-string input) (catch Exception _ (str input)))]
                (subs s 0 (min 200 (count s))))))

;; short human label for a retry-loop episode — verb + hint, no content
(defn tool-hint [nm input]
  (case nm
    "Bash" (let [c (str (:command input))]
             (subs c 0 (min 60 (count (first (str/split-lines c))))))
    ("Read" "Edit" "Write") (some-> (:file_path input) io/file .getName)
    (some->> (vals (select-keys input [:skill :query :pattern :prompt]))
             (remove nil?) first str (#(subs % 0 (min 40 (count %)))))))

(defn bucket [n] (cond (>= n 20) "20+" (>= n 10) "10+" (>= n 5) "5+" :else (str n)))

;; ---------------------------------------------------------------------------
;; per-file scan — one pass, bounded, pure (returns the unit's findings map)
(defn scan-file [^java.io.File f verbose?]
  (let [stem (str/replace (.getName f) #"\.jsonl$" "")
        st (volatile! {:stem stem :session-id nil :cwd nil :last-ts nil
                       :error-count 0 :lines 0
                       :pending {}          ; tool_use_id -> {:name :input}
                       :streak {}           ; fingerprint -> consecutive failures
                       :retries {}          ; fingerprint -> {:label :max}
                       :votes {}            ; attempted name -> count
                       :input-val {}        ; tool name -> count
                       :rejects {}          ; reason -> count
                       :guards {}           ; "label tool" -> count
                       :rereads {}})]       ; ~path -> top-read count
    (with-open [rdr (io/reader f)]
      (loop [lines (line-seq rdr) n 0]
        (when (and (seq lines) (< n MAX-LINES-PER-FILE))
          (let [^String l (first lines)]
            (when-not (or (> (.length l) MAX-LINE-BYTES)
                          (str/starts-with? l "{\"type\":\"file-history-snapshot\"")
                          (not (or (str/includes? l "tool_use")
                                   (str/includes? l "tool_result")
                                   (str/includes? l "\"attachment\""))))
              ;; a malformed/odd-shaped line skips itself, never the file
              (when-let [o (try (json/parse-string l true) (catch Exception _ nil))]
                (try
                  (vswap! st #(cond-> %
                              (:sessionId o) (assoc :session-id (:sessionId o))
                              (and (:cwd o) (nil? (:cwd %))) (assoc :cwd (:cwd o))
                              (:timestamp o) (assoc :last-ts (:timestamp o))))
                (case (:type o)
                  "assistant"
                  (doseq [b (get-in o [:message :content])
                          :when (= "tool_use" (:type b))]
                    (vswap! st assoc-in [:pending (:id b)] {:name (:name b) :input (:input b)})
                    ;; doc re-read: a Read of a .md STARTED FROM THE TOP (offset-paging
                    ;; a big file is one logical read, not a re-read)
                    (when (and (= "Read" (:name b))
                               (some-> (get-in b [:input :file_path]) (str/ends-with? ".md"))
                               ;; offset is usually an int but appears as other shapes in the
                               ;; wild (e.g. a [from to] vector) — only a top-read counts
                               (let [off (get-in b [:input :offset])]
                                 (or (nil? off) (and (number? off) (<= off 1)))))
                      (vswap! st update-in [:rereads (tilde (get-in b [:input :file_path]))] (fnil inc 0))))

                  "user"
                  (doseq [b (get-in o [:message :content])
                          :when (= "tool_result" (:type b))]
                    (let [{nm :name input :input} (get (:pending @st) (:tool_use_id b))
                          _  (vswap! st update :pending dissoc (:tool_use_id b))
                          s  (content-text (:content b))
                          fp (when nm (fingerprint nm input))]
                      (if (:is_error b)
                        (do
                          (vswap! st update :error-count inc)
                          (when-let [v (unknown-tool s)] (vswap! st update-in [:votes v] (fnil inc 0)))
                          (when (and nm (str/includes? s "InputValidationError"))
                            (vswap! st update-in [:input-val nm] (fnil inc 0)))
                          (when-let [g (guard-label s)]
                            (vswap! st update-in [:guards (str g " [" (or nm "?") "]")] (fnil inc 0)))
                          (when fp
                            (let [k (inc (get-in @st [:streak fp] 0))]
                              (vswap! st assoc-in [:streak fp] k)
                              (when (>= k RETRY-THRESHOLD)
                                (vswap! st update-in [:retries fp]
                                        (fn [r] {:label (or (:label r)
                                                            (str nm (when-let [h (tool-hint nm input)] (str "(" h ")"))))
                                                 :max (max k (:max r 0))}))))))
                        ;; success of the same fingerprint ends its failure run
                        (when fp (vswap! st update :streak dissoc fp)))
                      ;; a coordinator reject is a REPLY, error-flag or not
                      (when-let [rej (engine-reject s)]
                        (vswap! st update-in [:rejects rej] (fnil inc 0)))))

                  "attachment"
                  (let [a (:attachment o)]
                    (when (contains? #{"hook_blocking_error" "hook_non_blocking_error"} (:type a))
                      (when-let [g (guard-label (str (content-text (:content a)) "\n" (:stderr a)))]
                        (vswap! st update-in [:guards (str g " [" (or (:hookName a) "hook") "]")] (fnil inc 0)))))
                  nil)
                  (catch Exception _ nil))))
            (vswap! st update :lines inc)
            (recur (rest lines) (inc n))))))
    (let [{:keys [rereads] :as u} @st
          u (assoc u :rereads (into {} (filter #(>= (val %) REREAD-THRESHOLD) rereads)))]
      (when verbose? (binding [*out* *err*] (println "  scanned" (tilde (.getPath f)) (:lines u) "lines")))
      (dissoc u :pending :streak :lines))))

(defn findings? [{:keys [votes input-val rejects retries guards rereads]}]
  (boolean (seq (concat votes input-val rejects retries guards rereads))))

;; ---------------------------------------------------------------------------
;; fact emission — @mine:<stem>, existing predicates + the one minted `verb_vote`
(defn emit-facts! [port {:keys [stem session-id cwd last-ts error-count
                                 votes input-val rejects retries guards rereads]}]
  (let [te (str "@mine:" stem)
        note! (fn [s] (north.coord/append! port te "note" s))]
    (north.coord/put! port te "kind" "mine")
    (north.coord/put! port te "session_id" (or session-id stem))
    (when cwd (north.coord/put! port te "repo" (tilde cwd)))
    (when last-ts (north.coord/put! port te "at" last-ts))
    (when (pos? error-count) (north.coord/put! port te "error_count" (str error-count)))
    (doseq [v (take MAX-VOTES-PER-UNIT (keys votes))]
      (north.coord/append! port te "verb_vote" v))
    (doseq [s (take MAX-NOTES-PER-UNIT
                    (concat (for [[nm c] input-val] (str "input_validation: " nm " x" (bucket c)))
                            (for [[_ {:keys [label max]}] retries] (str "retry_loop: " label " x" (bucket max)))
                            (for [[doc c] rereads] (str "doc_reread: " doc " x" (bucket c)))
                            (for [[g c] guards] (str "guard_denial: " g " x" (bucket c)))
                            (for [[r c] rejects] (str "engine_reject: " r " x" (bucket c)))))]
      (note! s))))

;; ---------------------------------------------------------------------------
;; incremental state
(def state-file (io/file home ".local/state/north/north-mine/state.edn"))
(defn load-state [] (try (edn/read-string (slurp state-file)) (catch Exception _ {})))
(defn save-state! [m]
  (io/make-parents state-file)
  (spit state-file (pr-str m)))

;; ---------------------------------------------------------------------------
;; report
(defn- rank [m n] (take n (sort-by (comp - val) m)))

(defn report-md [units meta]
  (let [agg (fn [k] (apply merge-with + (map k units)))          ; name -> total hits
        sess (fn [k] (frequencies (mapcat (comp keys k) units))) ; name -> #sessions
        votes (agg :votes) vsess (sess :votes)
        ivals (agg :input-val)
        rejects (agg :rejects)
        guards (agg :guards)
        rereads (agg :rereads) rsess (sess :rereads)
        retries (->> units (mapcat (comp vals :retries)) (map (juxt :label :max))
                     (reduce (fn [m [l x]] (update m l (fnil max 0) x)) {}))
        retry-n (->> units (mapcat (comp vals :retries)) (map :label) frequencies)
        errors (reduce + 0 (map :error-count units))
        sec (fn [title rows fmt]
              (str "\n## " title "\n\n"
                   (if (seq rows) (str/join "\n" (map fmt rows)) "(none found)") "\n"))]
    (str "# Telemetry baseline — " (:date meta) "\n\n"
         "Mined by `north-mine` over " (:files meta) " transcript files ("
         (:units-with-findings meta) " with findings) under `~/.claude/projects/`. "
         "Signals only — no message content.\n\n"
         "Total tool_result errors seen: " errors "\n"
         (sec "Verb votes — hallucinated tool names (the vocabulary signal)"
              (rank votes 25)
              (fn [[v c]] (str "- `" v "` — " c " call(s) across " (get vsess v 1) " session(s)")))
         (sec "InputValidationError by tool (deferred-tool + param friction)"
              (rank ivals 20)
              (fn [[t c]] (str "- `" t "` — " c)))
         (sec "Retry loops (same tool+input failing >=3x without a success)"
              (sort-by (comp - val) retry-n)
              (fn [[l c]] (str "- `" l "` — " c " episode(s), worst streak x" (get retries l))))
         (sec "Doc re-reads (same .md read from the top >=3x in one session)"
              (rank rereads 25)
              (fn [[d c]] (str "- `" d "` — " c " top-reads across " (get rsess d 1) " session(s)")))
         (sec "Guard denials" (rank guards 20) (fn [[g c]] (str "- " g " — " c)))
         (sec "Engine rejections (coordinator reject:*)"
              (rank rejects 20) (fn [[r c]] (str "- `reject:" r "` — " c))))))

;; ---------------------------------------------------------------------------
(defn -main [& args]
  (let [port (Integer/parseInt (or (first args) north.coord/PORT))
        opts (set (rest args))
        opt-val (fn [flag] (second (drop-while #(not= % flag) (rest args))))
        root (io/file (or (opt-val "--root") (str home "/.claude/projects")))
        dry? (contains? opts "--dry-run")
        full? (contains? opts "--full")
        verbose? (contains? opts "--verbose")
        limit (some-> (opt-val "--limit") Integer/parseInt)
        report-file (opt-val "--report")
        state (if full? {} (load-state))
        all (->> (file-seq root)
                 (filter #(and (.isFile ^java.io.File %) (str/ends-with? (.getName ^java.io.File %) ".jsonl")
                               (pos? (.length ^java.io.File %)))))
        todo (->> all
                  (remove (fn [^java.io.File f]
                            (when-let [{:keys [mtime size]} (get state (.getPath f))]
                              (and (= mtime (.lastModified f)) (= size (.length f))))))
                  (sort-by #(.lastModified ^java.io.File %))
                  (#(if limit (take limit %) %)))
        _ (binding [*out* *err*]
            (println (format "north-mine: %d transcript files, %d to scan%s"
                             (count all) (count todo) (if dry? " (dry-run)" ""))))
        units (volatile! [])
        state' (volatile! state)]
    (doseq [^java.io.File f todo]
      (let [u (try (scan-file f verbose?)
                   (catch Exception e
                     (binding [*out* *err*] (println "  ERROR" (.getPath f) (ex-message e)))
                     nil))]
        (when u
          (vswap! units conj u)
          (when (and (findings? u) (not dry?))
            (emit-facts! port u))
          (vswap! state' assoc (.getPath f) {:mtime (.lastModified f) :size (.length f)}))))
    (when-not dry? (save-state! @state'))
    (let [us @units
          with-findings (filter findings? us)]
      (binding [*out* *err*]
        (println (format "north-mine: scanned %d, findings in %d, facts %s"
                         (count us) (count with-findings)
                         (if dry? "SKIPPED (dry-run)" "written via coordinator"))))
      (when report-file
        (io/make-parents (io/file report-file))
        (spit report-file
              (report-md us {:date (str (java.time.LocalDate/now))
                             :files (count us)
                             :units-with-findings (count with-findings)}))
        (binding [*out* *err*] (println "report ->" (tilde report-file)))))))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
