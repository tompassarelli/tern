;; coord.clj — the ONE shared coordination substrate for the north *-cli.clj
;; scripts (Foundation thread 019f100f Part B). Every CLI spoke the :7977 daemon
;; wire (:assert / :version / :retract / :resolved / :query) through a VERBATIM
;; copy of these helpers — 10 copies of send-op, 5 of assert!, 2 of retract!, and
;; ~11 single/multi resolved variants. One drift in any copy and the swarm's
;; coordination silently diverges. This is the single definition they all load.
;;
;; WRITE VERBS — cardinality-typed (move-C). The one global-version CAS ritual that
;; every assert! cargo-culted (read GLOBAL :version, pass it as the per-fact base,
;; retry) is GONE. It is replaced by three verbs whose choice is the predicate's
;; cardinality, NOT a base dance:
;;   append!  MULTI            one op, NO base, NO retry  — rival/disjoint writes
;;                             coexist (engine appends; identical is idempotent).
;;   put!     SINGLE  LWW      one op, NO base            — engine supersedes a
;;                             declared-single pred (last writer wins).
;;   swap!    SINGLE  CAS      base + retry  — the ONLY base+retry verb; opt-IN
;;                             conflict-detection for a genuine read-modify-write.
;; append!/put! pass NO :base, so the (now base-OPTIONAL) engine never staleness-
;; rejects them; only swap! threads a base. assert! survives as a thin alias to swap!
;; (byte-for-byte the old CAS behavior) for any un-migrated straggler.
;;
;; DUAL MODE (the schema-validate.clj precedent): load-file'd by a sibling CLI as a
;; library, OR run directly as a connectivity smoke. The main-guard keeps the CLI
;; dormant when another script loads us:
;;   bb cli/coord.clj <port>            -> prints the daemon's :version (a ping)
;; Load it sibling-relative so cwd never matters:
;;   (load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
;; then call north.coord/send-op (or rebind the local names you use).
(ns north.coord
  (:require [clojure.edn :as edn] [clojure.java.io :as io] [clojure.string :as str]))

;; The canonical coordinator port. The CLIs take <port> as argv[0]; PORT is the
;; default/canonical reference (Part C's pred-cli + future callers read it).
(def PORT (or (System/getenv "NORTH_PORT") "7977"))

(defn- timeout-ms [name default]
  (let [raw (or (System/getenv name) (str default))]
    (when-not (re-matches #"[1-9][0-9]{0,5}" raw)
      (throw (ex-info (str name " must be an integer from 1 through 999999 milliseconds")
                      {:type :invalid-coordinator-timeout :name name :value raw})))
    (Integer/parseInt raw)))

(defn- response-byte-limit []
  (let [raw (or (System/getenv "NORTH_COORD_MAX_RESPONSE_BYTES")
                "8388608")
        value (when (re-matches #"[1-9][0-9]{0,7}" raw)
                (parse-long raw))]
    (when-not (and value (<= value 67108864))
      (throw
       (ex-info
        "NORTH_COORD_MAX_RESPONSE_BYTES must be an integer from 1 through 67108864"
        {:type :invalid-coordinator-response-limit :value raw})))
    (int value)))

(defn connect-socket [port]
  (let [s (java.net.Socket.)]
    (try
      (.connect s
                (java.net.InetSocketAddress. "127.0.0.1" (int port))
                (timeout-ms "NORTH_COORD_CONNECT_TIMEOUT_MS" 1000))
      (.setSoTimeout s (timeout-ms "NORTH_COORD_READ_TIMEOUT_MS" 30000))
      s
      (catch Throwable t
        (.close s)
        (throw t)))))

(defn- decode-utf8! [bytes]
  (try
    (let [decoder
          (doto (.newDecoder java.nio.charset.StandardCharsets/UTF_8)
            (.onMalformedInput java.nio.charset.CodingErrorAction/REPORT)
            (.onUnmappableCharacter java.nio.charset.CodingErrorAction/REPORT))]
      (str (.decode decoder (java.nio.ByteBuffer/wrap bytes))))
    (catch java.nio.charset.CharacterCodingException error
      (throw
       (ex-info "coordinator response line is not valid UTF-8"
                {:type :malformed-coordinator-utf8}
                error)))))

(defn- response-timeout! [timeout cause]
  (throw
   (ex-info "coordinator response deadline exceeded"
            {:type :coordinator-response-timeout
             :timeout-ms timeout}
            cause)))

;; North keeps this small stdlib-only client instead of loading fram.rt: hooks
;; and sibling CLIs load coord.clj directly, without Fram's kernel/fold/Cheshire
;; classpath. The wire invariants still match Fram's client: bounded UTF-8,
;; absolute deadlines, exactly one parsed form, and exactly one terminal frame.
(defrecord CoordinatorReader [socket input buffer bounds])

(defn coordinator-reader [socket]
  (->CoordinatorReader
   socket
   (.getInputStream socket)
   (byte-array 65536)
   (int-array 2)))

(defn- as-reader [source]
  (if (instance? CoordinatorReader source)
    source
    (coordinator-reader source)))

(defn- finish-line! [output]
  (let [line (decode-utf8! (.toByteArray output))]
    (if (str/ends-with? line "\r")
      (subs line 0 (dec (count line)))
      line)))

(defn- arm-deadline! [socket deadline timeout]
  (let [remaining-ns (- deadline (System/nanoTime))]
    (when-not (pos? remaining-ns)
      (response-timeout! timeout nil))
    (.setSoTimeout
     socket
     (int (max 1 (quot (+ remaining-ns 999999) 1000000))))))

(defn- read-line-limited! [source deadline timeout eof-ok?]
  (let [{:keys [socket input buffer bounds]} (as-reader source)
        buffer-size (alength buffer)
        latin1 java.nio.charset.StandardCharsets/ISO_8859_1
        newline "\n"
        limit (response-byte-limit)
        output (java.io.ByteArrayOutputStream.)]
    (loop []
      (when (and deadline (not (pos? (- deadline (System/nanoTime)))))
        (response-timeout! timeout nil))
      (let [start (aget bounds 0)
            end (aget bounds 1)]
        (if (< start end)
          (let [available (- end start)
                segment (String. buffer start available latin1)
                newline-offset (.indexOf segment newline)
                take-bytes (if (neg? newline-offset)
                             available
                             newline-offset)
                total (+ (.size output) take-bytes)]
            (when (> total limit)
              (throw
               (ex-info
                (str "coordinator response line exceeds " limit " bytes")
                {:type :coordinator-response-too-large
                 :max-bytes limit})))
            (.write output buffer start take-bytes)
            (if (neg? newline-offset)
              (do
                (aset-int bounds 0 end)
                (recur))
              (do
                (aset-int bounds 0 (+ start newline-offset 1))
                (finish-line! output))))
          (do
            (when deadline
              (arm-deadline! socket deadline timeout))
            (let [read-count
                  (try
                    (.read input buffer 0 buffer-size)
                    (catch java.net.SocketTimeoutException error
                      (response-timeout! timeout error)))]
              (cond
                (= -1 read-count)
                (if (and eof-ok? (zero? (.size output)))
                  nil
                  (throw
                   (ex-info
                    (if (zero? (.size output))
                      "coordinator closed before sending a response line"
                      "coordinator closed during a response line")
                    {:type (if (zero? (.size output))
                             :coordinator-response-closed
                             :coordinator-response-truncated)
                     :bytes (.size output)})))

                (zero? read-count)
                (recur)

                :else
                (do
                  (aset-int bounds 0 0)
                  (aset-int bounds 1 read-count)
                  (recur))))))))))

(defn read-line-bounded!
  "Read exactly one UTF-8 line through a persistent chunked reader.
   The deadline is absolute, so a peer cannot stay alive by dripping bytes just
   under SO_TIMEOUT. The byte cap excludes the line terminator."
  [source]
  (let [timeout (timeout-ms "NORTH_COORD_READ_TIMEOUT_MS" 30000)]
    (read-line-limited!
     source
     (+ (System/nanoTime) (* 1000000 (long timeout)))
     timeout
     false)))

(defn read-stream-line-bounded!
  "Read one event-stream line with no idle deadline but the same byte and UTF-8
   bounds as request responses. The persistent reader retains bytes following
   the newline for the next event. Clean EOF returns nil; partial EOF is invalid."
  [source]
  (let [reader (as-reader source)]
    (.setSoTimeout (:socket reader) 0)
    (read-line-limited! reader nil nil true)))

(defn- ensure-terminal-eof! [reader deadline timeout]
  (let [{:keys [socket input buffer bounds]} reader]
    (loop []
      (let [start (aget bounds 0)
            end (aget bounds 1)]
        (when (< start end)
          (throw
           (ex-info "coordinator sent more than one terminal response frame"
                    {:type :multiple-coordinator-response-frames
                     :surplus-bytes (- end start)})))
        (arm-deadline! socket deadline timeout)
        (let [read-count
              (try
                (.read input buffer 0 (alength buffer))
                (catch java.net.SocketTimeoutException error
                  (response-timeout! timeout error)))]
          (cond
            (= -1 read-count) nil
            (zero? read-count) (recur)
            :else
            (throw
             (ex-info "coordinator sent more than one terminal response frame"
                      {:type :multiple-coordinator-response-frames
                       :surplus-bytes read-count}))))))))

(defn- read-terminal-line! [reader]
  (let [timeout (timeout-ms "NORTH_COORD_READ_TIMEOUT_MS" 30000)
        deadline (+ (System/nanoTime) (* 1000000 (long timeout)))
        line (read-line-limited! reader deadline timeout false)]
    (ensure-terminal-eof! reader deadline timeout)
    line))

(defn- malformed-edn! [line error]
  (throw
   (ex-info "coordinator response line is not exactly one valid EDN form"
            {:type :malformed-coordinator-response
             :line-bytes (count (.getBytes
                                 (str line)
                                 java.nio.charset.StandardCharsets/UTF_8))}
            error)))

(defn parse-edn-line! [line]
  (try
    (with-open [reader
                (java.io.PushbackReader. (java.io.StringReader. line))]
      (let [eof (Object.)
            value (edn/read {:eof eof} reader)
            trailing (edn/read {:eof eof} reader)]
        (when (or (identical? eof value)
                  (not (identical? eof trailing)))
          (throw (ex-info "not exactly one EDN form" {})))
        value))
    ;; Hostile bounded input can still overflow a recursive parser. Normalize
    ;; that one Error, but let VM-fatal Errors propagate.
    (catch StackOverflowError error
      (malformed-edn! line error))
    (catch Exception error
      (malformed-edn! line error))))

(defn read-edn-response! [reader]
  (parse-edn-line! (read-terminal-line! reader)))

;; Every North request carries the exact corpus identity. The distinct :for-log
;; envelope is a protocol boundary, not optional metadata: a pre-fence daemon
;; rejects the unknown op, so a new North client can never silently fall back to
;; an unfenced read or write.
(defn canonical-log-path [log]
  (when-not (and (string? log) (not (str/blank? log)))
    (throw (ex-info "coordinator log identity must be a nonblank path"
                    {:type :invalid-log-identity :log log})))
  (.getCanonicalPath (io/file log)))

(defn expected-log []
  (let [explicit (System/getenv "FRAM_LOG")
        home (or (System/getenv "HOME") (System/getProperty "user.home"))
        requested (io/file
                   (or explicit
                       (str home "/.local/state/north/facts.log")))
        split (io/file (.getParentFile requested) "coordination.log")
        selected (if (and (nil? explicit)
                          (nil? (System/getenv "FRAM_TELEMETRY_LOG"))
                          (.isFile split))
                   split
                   requested)]
    (.getCanonicalPath selected)))

(defn log-envelope-for [log op]
  (when (= :for-log (:op op))
    (throw (ex-info "nested coordinator log fences are not supported"
                    {:type :invalid-log-fence})))
  (cond-> {:op :for-log
           :expected-log (canonical-log-path log)
           :request op}
    (contains? op :fmt) (assoc :fmt (:fmt op))))

(defn log-envelope [op]
  (log-envelope-for (expected-log) op))

(defn validate-subscription! [line]
  (let [reply (when (string? line) (parse-edn-line! line))
        served (:log reply)
        valid-log? (and (string? served)
                        (= (expected-log)
                           (.getCanonicalPath (io/file served))))]
    (when-not (and (map? reply) (integer? (:subscribed reply)) valid-log?)
      (throw (ex-info
              (str "coordinator refused the fenced subscription: "
                   (if (nil? line) "connection closed before handshake" (pr-str reply)))
              {:type :invalid-subscription-handshake
               :expected-log (expected-log)
               :reply reply})))
    reply))

;; one fenced request/response over the daemon socket: write one EDN op +
;; newline, read one EDN reply line. The atom every other helper is built from.
(def ^:private max-request-line-bytes (* 1024 1024))

(defn- send-envelope [port envelope]
  (with-open [s (connect-socket port)]
    (let [payload (pr-str envelope)
          payload-bytes (.getBytes payload java.nio.charset.StandardCharsets/UTF_8)
          _ (when (> (alength payload-bytes) max-request-line-bytes)
              (throw
               (ex-info
                (str "coordinator request line exceeds "
                     max-request-line-bytes " bytes")
                {:type :coordinator-request-too-large
                 :max-bytes max-request-line-bytes})))
          ;; One write preserves the line-frame boundary for peers that answer
          ;; and close as soon as the complete request arrives.
          wire (.getBytes (str payload "\n")
                          java.nio.charset.StandardCharsets/UTF_8)
          w (.getOutputStream s)
          reader (coordinator-reader s)]
      (.write w wire)
      (.flush w)
      (read-edn-response! reader))))

(defn send-op [port op]
  (send-envelope port (log-envelope op)))

(defn send-op-for-log [port log op]
  (send-envelope port (log-envelope-for log op)))

(defn send-raw-op
  "Low-level compatibility/policy probe. Managed North operations must use
   send-op/send-op-for-log; this exists only to prove that a daemon rejects an
   unfenced request before north-coord-up declares it strict-ready."
  [port op]
  (send-envelope port op))

(defn strict-coordinator-status [port log]
  (let [expected (canonical-log-path log)]
    (try
      (let [fenced (send-op-for-log port expected {:op :version})
            raw (send-raw-op port {:op :version})
            served (:served-log raw)
            served-canonical
            (when (and (string? served) (not (str/blank? served)))
              (canonical-log-path served))]
        (cond
          (not (integer? (:version fenced)))
          {:ready false :reason :fenced-version-invalid}

          (not= :log-fence-required (:code raw))
          {:ready false :reason :raw-request-not-rejected}

          (not= expected served-canonical)
          {:ready false :reason :strict-probe-served-wrong-log
           :expected-log expected :served-log served-canonical}

          :else
          {:ready true :version (:version fenced) :log expected}))
      ;; read-edn-response! already normalizes parser StackOverflowError into an
      ;; Exception. Preserve ordinary probe diagnostics without swallowing
      ;; unrelated VM-fatal Errors.
      (catch Exception error
        {:ready false
         :reason :probe-failed
         :error (.getMessage error)}))))

;; the daemon's current global version (only swap!/retract! read it now — the base).
(defn cur-ver [port] (:version (send-op port {:op :version})))

;; A Fact is a string subject/predicate/object triple. Blank literal objects are
;; intentional in a few contracts (empty message bodies and DONE payloads), so
;; preserve explicit ""; nil is different — `(str nil)` used to turn an omitted
;; CLI argument into a blank fact. Reject malformed shapes before any socket write.
(defn- write-value! [te p r]
  (when-not (and (string? te) (not (str/blank? te)))
    (throw (ex-info "coord write requires a nonblank string subject"
                    {:type :invalid-write :field :subject})))
  (when-not (and (string? p) (not (str/blank? p)))
    (throw (ex-info "coord write requires a nonblank string predicate"
                    {:type :invalid-write :field :predicate})))
  (when (nil? r)
    (throw (ex-info "coord write requires a non-nil object; pass \"\" explicitly when blank is intended"
                    {:type :invalid-write :field :object})))
  (str r))

;; append! — MULTI cardinality: one wire op, NO base, NO retry. The engine appends
;; (rival/disjoint values coexist; an identical (te,p,r) is idempotent). The safe
;; coexist default. (str r) coerces defensively (callers already pass strings).
(defn append! [port te p r]
  (send-op port {:op :assert :te te :p p :r (write-value! te p r)}))

;; put! — SINGLE last-writer-wins: one wire op, NO base. For a pred the engine has
;; declared single this SUPERSEDES the prior live value (LWW). Wire-identical to
;; append!; the cardinality FACT (engine-side) — not this verb — decides append-vs-
;; supersede, so the verb names the call site's INTENT. A no-base write is never
;; staleness-rejected (base-optional engine), which IS the LWW contract.
(defn put! [port te p r]
  (send-op port {:op :assert :te te :p p :r (write-value! te p r)}))

;; Lease-fenced variants — the coordinator validates RES/HOLDER/EPOCH and
;; performs the fact mutation under its one writer lock. A separate `fence-ok`
;; preflight is not an authority boundary: expiry/takeover could land between
;; two socket turns. These verbs close that window.
(defn put-with-fence! [port {:keys [resource holder epoch]} te p r]
  (send-op port {:op :assert-with-fence
                 :res resource :holder holder :epoch epoch
                 :te te :p p :r (write-value! te p r)}))

(defn retract-with-fence! [port {:keys [resource holder epoch]} te p r]
  (send-op port {:op :retract-with-fence
                 :res resource :holder holder :epoch epoch
                 :te te :p p :r (write-value! te p r)}))

;; swap! — SINGLE compare-and-swap: the ONLY base+retry verb. Reads the base, writes
;; under it, retries on :reject (a concurrent write moved the base). Reserve for a
;; genuine read-modify-write race; near-zero production callers after move-C. 4 tries.
(defn swap! [port te p r]
  (let [rv (write-value! te p r)]
    (loop [tries 4]
      (let [res (send-op port {:op :assert :te te :p p :r rv :base (cur-ver port)})]
        (if (and (:reject res) (pos? tries)) (recur (dec tries)) res)))))

;; assert-after-read! — commit one marker against the exact GLOBAL graph version
;; a caller validated. The callback MUST perform every load-bearing read after
;; BASE is captured. :assert-at-version performs its comparison + assert in one
;; serialized Fram coordinator turn; ordinary :assert's :base is only
;; cardinality-local OCC and MUST NOT be substituted here. A concurrent graph
;; write makes the marker assert reject; retry therefore re-runs the callback
;; over a fresh graph instead of blessing a stale read. This is intentionally
;; global-version conservative: unrelated traffic may cause a retry, but can
;; never create a false successful commit.
(defn assert-after-read!
  ([port te p r validate!] (assert-after-read! port te p r validate! 16))
  ([port te p r validate! attempts]
   (when-not (pos? attempts)
     (throw (ex-info "assert-after-read! requires at least one attempt"
                     {:attempts attempts})))
   (let [rv (write-value! te p r)]
     (loop [remaining attempts]
       (let [base (cur-ver port)
             _ (validate!)
             result
             (send-op port {:op :assert-at-version
                            :te te :p p :r rv :base base})]
         (if (and (= :conflict (:reject result)) (> remaining 1))
           (recur (dec remaining))
           result))))))

(defn assert-after-read-with-fence!
  "Global read-set CAS plus an atomic lease fence. Every load-bearing read in
  VALIDATE! follows BASE capture; the daemon checks both BASE and the current
  lease epoch in the same writer turn as the marker assertion."
  ([port lease te p r validate!]
   (assert-after-read-with-fence! port lease te p r validate! 16))
  ([port {:keys [resource holder epoch]} te p r validate! attempts]
   (when-not (pos? attempts)
     (throw
      (ex-info "assert-after-read-with-fence! requires at least one attempt"
               {:attempts attempts})))
   (let [rv (write-value! te p r)]
     (loop [remaining attempts]
       (let [base (cur-ver port)
             _ (validate!)
             result
             (send-op port {:op :assert-at-version-with-fence
                            :res resource :holder holder :epoch epoch
                            :te te :p p :r rv :base base})]
         (if (and (= :conflict (:reject result)) (> remaining 1))
           (recur (dec remaining))
           result))))))

;; thin migration alias — old assert! WAS the swap! CAS ritual; keep it pointing
;; there so any un-migrated caller is byte-for-byte unchanged.
(def assert! swap!)

(defn retract! [port te p r]
  (let [rv (write-value! te p r)]
    (loop [tries 4]
      (let [res (send-op port {:op :retract :te te :p p :r rv :base (cur-ver port)})]
        (if (and (:reject res) (pos? tries)) (recur (dec tries)) res)))))

;; single live value of (te,p)  (the resolved/one/rf variants collapse here).
(defn resolved [port te p] (:value (send-op port {:op :resolved :te te :p p})))
;; all live values of (te,p) — multi-valued  (the many/rmany variants).
(defn many     [port te p] (:values (send-op port {:op :resolved :te te :p p})))

;; --- presence liveness: the renewable-LEASE rule (presence-cli #30 is the origin) ---
;; A session's liveness is a lease fact @lease:session:<h> = "holder|exp|epoch"; the
;; agent is ONLINE iff that lease's exp is still in the FUTURE by the coordinator's clock
;; (never a self-stamped heartbeat — a crashed agent's lease simply lapses). Factored here
;; so the presence roster (presence-cli) and any consumer that must judge liveness — e.g.
;; concern-cli hiding a lapsed agent's stale concerns — share ONE definition and cannot
;; drift on what "online" means. That single-definition guarantee is this file's whole job.
(defn decode-lease [v]
  (when (string? v)
    (let [[h e ep] (str/split v #"\|")]
      (when (and h e) {:holder h :exp (parse-long e) :epoch (parse-long (or ep "0"))}))))

(defn lease-of [port res] (decode-lease (resolved port (str "@lease:" res) "lease")))

(defn online?
  "True iff session <handle> holds an unexpired lease. `now` defaults to the system clock
   (agent runs on the coordinator's machine, so agent-now ~ coord-now)."
  ([port handle] (online? port handle (System/currentTimeMillis)))
  ([port handle now]
   (let [l (lease-of port (str "session:" handle))]
     (boolean (and l (> (:exp l) now))))))

;; ============================================================================
;; INCREMENTAL AGGREGATE — the completion DUAL of mutual exclusion.
;;
;; Roadmap tier F, decision 6: "EVERYTHING COUNTABLE IS A
;; FOLD OVER AN APPEND-ONLY LOG, NEVER A MUTATED CELL." Where mutual exclusion
;; REJECTS the second writer, completion ACCEPTS every writer and DERIVES the
;; answer by folding the log at READ time — so the completion half of
;; coordination needs no write-time convergence at all.
;;
;; ONE primitive, two reducers for common aggregation shapes:
;;   quorum = count-distinct(worker) >= K   — north-map's K-of-N barrier
;;   usage  = Σ(measurement)               — telemetry and experiment totals
;; Both fold a reducer over the rows a Datalog BODY binds against the
;; scan engine. Both are commutative and idempotent (set semantics collapse a
;; double-reported worker; Σ rides write-once @charge/@run subjects), so retry,
;; double-report, and racing writers all converge with ZERO coordination. Each
;; fold is a pure, recomputable function of the log prefix — never a cached cell
;; that can silently diverge from its own source. The total order earliest-cid
;; that makes other derivations agree is not even needed here: + and set-union
;; are order-independent.

;; A REDUCER is {:init :step :final}: fold :step from :init over the rows, finalize.
;; The two production reducers — the only two coordination has ever needed:
(def distinct-reducer
  "Quorum reducer: union each row's first binding into a SET (a key seen twice
   counts once). Returns the set itself — callers count it or diff it for the
   missing members."
  {:init #{} :step (fn [s row] (conj s (first row))) :final identity})

(def sum-reducer
  "Sum reducer: Σ the numeric SECOND projection of each row (non-numeric -> 0).
   Rows MUST carry a distinct key in the FIRST position (the @run/@charge subject):
   the engine's derived head is a SET of tuples, so a value-only projection would
   collapse two equal-valued addends and UNDER-count. The key
   keeps equal values distinct — the exact dual of count-distinct, which WANTS the
   collapse. This asymmetry is why Σ projects [key val] and count-distinct [key]."
  {:init 0 :step (fn [n row] (+ n (or (parse-double (str (second row))) 0))) :final identity})

;; The rows a Datalog BODY binds, projected onto PROJECT (the head vars). One
;; scan-engine query; a 1- or 2-literal body routes to the join engine (q/run).
(defn agg-rows [port project body]
  (:ok (send-op port {:op :query
                      :query {:find "agg"
                              :rules [{:head {:rel "agg" :args (mapv (fn [v] {:var v}) project)}
                                       :body body}]}})))

;; Apply a REDUCER to a row-seq you already hold. The seam for callers that must
;; scope rows with a predicate the scan body can't express (e.g. an entity-id
;; PREFIX like "@run:") — they fold the pre-filtered rows through the SAME reducer,
;; so every caller uses the same numeric reducer.
(defn reduce-rows [{:keys [init step final]} rows] (final (reduce step init rows)))
(defn sum-rows      [rows] (reduce-rows sum-reducer rows))       ; Σ the [key val] rows
(defn distinct-rows [rows] (reduce-rows distinct-reducer rows))  ; SET of the [key] rows

;; THE primitive. Pure read; recomputable from the log.
(defn aggregate [port project body reducer]
  (reduce-rows reducer (agg-rows port project body)))

;; --- named folds (each reducer, applied) ------------------------------------
(defn distinct-of
  "The SET of distinct PROJECT values BODY binds (count-distinct, set form)."
  [port project body] (aggregate port project body distinct-reducer))
(defn count-distinct
  "K-of-N quorum's left side: how many DISTINCT keys BODY binds."
  [port project body] (count (distinct-of port project body)))
(defn sum-of
  "Σ of a numeric projection over BODY. PROJECT must be [key-var val-var]: the key
   (the @run/@charge subject) keeps equal values distinct so they are not deduped
   away; the val is summed."
  [port project body] (aggregate port project body sum-reducer))

;; --- gates (a gate is just a threshold predicate over a fold) ---------------
(defn quorum-met?
  "True once ≥ K distinct keys have appeared — the barrier has FIRED. Monotone:
   never un-fires while completion predicates are irretractable (see roadmap F↔H)."
  [port k project body] (>= (count-distinct port project body) k))

;; ============================================================================
;; COMMAND-AS-FACTS — the pending-command rule (single source).
;;
;; Roadmap tier I: a command is NOT an opaque {:op :args} body blob with a
;; parse-envelope parser duplicated across msg-cli + north-listen. It is FACTS
;; on @cmd:<id> — `op` + `target` (the routing handle) + one fact per arg. PENDING
;; = has op+target, NO acked_by and NO failed_by. Success and failure are distinct
;; terminal states; an explicit `msg-cli retry` retracts failure and emits a
;; retry_requested edge rather than pretending a failed execution was acknowledged.
;; match BOTH the sender's `cmds` listing and the reactor drive off; it lives ONCE
;; here so the duplication this redesign deletes can never reappear as a copied query.
(defn pending-cmds
  "[[cmd op target] …] for every command carrying op+target and no terminal result.
   Stratum 0 binds `settled` from either success ack or failed_by; stratum 1 selects
   op+target where the command is NOT settled (the negated var is bound by the positive op literal — the engine's stratified-
   negation safety rule)."
  [port]
  (:ok (send-op port {:op :query
                      :query {:find "pending"
                              :strata [[{:head {:rel "settled" :args [{:var "c"}]}
                                         :body [{:rel "triple" :args [{:var "c"} "acked_by" {:var "a"}]}]}
                                        {:head {:rel "settled" :args [{:var "c"}]}
                                         :body [{:rel "triple" :args [{:var "c"} "failed_by" {:var "a"}]}]}]
                                       [{:head {:rel "pending" :args [{:var "c"} {:var "op"} {:var "t"}]}
                                         :body [{:rel "triple" :args [{:var "c"} "op" {:var "op"}]}
                                                {:rel "triple" :args [{:var "c"} "target" {:var "t"}]}
                                                {:rel "settled" :args [{:var "c"}] :neg true}]}]]}})))

(defn -main [& args]
  (if (= "strict-probe" (first args))
    (let [port (Integer/parseInt (or (second args) PORT))
          log (nth args 2 nil)
          status (strict-coordinator-status port log)]
      (prn status)
      (when-not (:ready status) (System/exit 1)))
    (let [port (Integer/parseInt (or (first args) PORT))]
      (prn (send-op port {:op :version})))))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
