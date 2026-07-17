(ns north.spawn-process
  "Shared managed-process boundary for North's shell and MCP spawn surfaces.

  A successful OS fork is not a successful North spawn.  The caller may only
  acknowledge a live lane after the child has published its structured identity
  and acquired an online presence lease.  Fast terminal outcomes are reported as
  completed; early exits and acknowledgement timeouts are explicit failures."
  (:require [babashka.process :as p]
            [clojure.java.io :as io]
            [clojure.string :as str]))

(load-file (str (.getParent (io/file *file*)) "/agent-provenance.clj"))
(load-file (str (.getParent (io/file *file*)) "/terminal-projection.clj"))

(def default-startup-timeout-ms 45000)
(def default-startup-poll-ms 100)
(def default-exit-grace-ms 300)

(defn create-agent-id
  "Mint an opaque process identity with sortable time plus the complete UUID.
  `now` and `uuid` are injectable only for deterministic tests."
  ([prefix]
   (create-agent-id prefix (System/currentTimeMillis) (java.util.UUID/randomUUID)))
  ([prefix now uuid]
   (str prefix "-" (Long/toString (long now) 36) "-" uuid)))

(defn identity-defects
  "Return the load-bearing identity proofs that are absent or contradictory.
  Managed lanes are always Gaffer-selected: `none` is valid only for native
  provider sessions and can never cross this startup acknowledgement gate."
  [facts]
  (north.agent-provenance/identity-defects facts))

(defn identity-ready?
  [facts]
  (empty? (identity-defects facts)))

(defn env-ms
  [name fallback]
  (let [raw (System/getenv name)]
    (try
      (let [parsed (when raw (Long/parseLong raw))]
        (if (and parsed (pos? parsed)) parsed fallback))
      (catch Exception _ fallback))))

(defn launch-detached!
  "Start command in a new session while retaining a waitable wrapper during the
  startup handshake. `setsid --fork --wait` protects the actual lane from the
  invoking terminal and preserves its real exit status for early-failure proof."
  [command extra-env log-file]
  (let [log (io/file log-file)]
    (.mkdirs (.getParentFile log))
    (let [process (p/process (into ["setsid" "--fork" "--wait"] command)
                             ;; Exact environment, not a merge. Managed callers
                             ;; pass a parent copy with every staffing/routing key
                             ;; scrubbed; :extra-env would silently reintroduce the
                             ;; invoking director's omitted axes.
                             {:env extra-env
                              :out :write :out-file log
                              :err :out})]
      ;; The SDK entrypoints never consume their own stdin. Closing the pipe
      ;; prevents a detached lane from retaining the invoking CLI's input edge.
      (when-let [input (:in process)]
        (try (.close input) (catch Exception _ nil)))
      process)))

(defn process-exit
  "Return nil while alive, otherwise the observed exit code."
  [process]
  (try
    (when-not (p/alive? process)
      (:exit @process))
    (catch Exception _ :unknown)))

(defn stop-process!
  [process]
  (try (p/destroy-tree process) (catch Exception _ nil))
  (try (deref process 2000 nil) (catch Exception _ nil))
  nil)

(defn- final-terminal-facts
  "Close the exit/read race: outcome is synchronously written before a managed
  SDK process exits, but the first graph read may have started just before that
  write. Re-read for a short bounded grace and merge with already observed
  identity so a fast clean completion cannot be mislabeled as construction
  failure."
  [agent-id initial-facts probe-identity grace-ms poll-ms]
  (let [deadline (+ (System/currentTimeMillis) grace-ms)]
    (loop [facts initial-facts]
      (let [observed (try (or (probe-identity agent-id) {}) (catch Exception _ {}))
            merged (merge facts observed)
            outcome (north.terminal-projection/terminal-process-outcome merged)]
        (if (or (and (identity-ready? merged) outcome)
                (>= (System/currentTimeMillis) deadline))
          merged
          (do (Thread/sleep poll-ms) (recur merged)))))))

(defn await-startup
  "Wait for the two durable startup proofs: complete structured lane identity
  and an online presence lease. `probe-identity` returns the current predicate
  map; `probe-online` returns whether this exact id owns an unexpired lease."
  [process agent-id log-file probe-identity probe-online
   & {:keys [timeout-ms poll-ms exit-grace-ms]
      :or {timeout-ms (env-ms "NORTH_SPAWN_STARTUP_TIMEOUT_MS" default-startup-timeout-ms)
           poll-ms (env-ms "NORTH_SPAWN_STARTUP_POLL_MS" default-startup-poll-ms)
           exit-grace-ms (env-ms "NORTH_SPAWN_EXIT_GRACE_MS" default-exit-grace-ms)}}]
  (let [deadline (+ (System/currentTimeMillis) timeout-ms)]
    (loop [last-facts {}]
      (let [facts (try (or (probe-identity agent-id) {})
                       (catch Exception _ last-facts))
            identity? (identity-ready? facts)
            outcome (north.terminal-projection/terminal-process-outcome facts)
            first-exit (process-exit process)
            online? (and identity? (nil? first-exit)
                         (try (boolean (probe-online agent-id)) (catch Exception _ false)))
            exit (or first-exit (process-exit process))]
        (cond
          ;; A lane can finish between fork and acknowledgement. Its structured
          ;; identity plus terminal outcome is stronger evidence than presence.
          (and identity? outcome)
          {:status :completed :agent-id agent-id :handle (get facts "display_handle")
           :outcome outcome :facts facts :log (str log-file)}

          (and identity? online? (nil? exit))
          {:status :ready :agent-id agent-id :handle (get facts "display_handle")
           :facts facts :log (str log-file)}

          (some? exit)
          (let [final-facts (final-terminal-facts
                             agent-id facts probe-identity exit-grace-ms poll-ms)
                final-outcome (north.terminal-projection/terminal-process-outcome final-facts)]
            (if (and (identity-ready? final-facts) final-outcome)
              {:status :completed :agent-id agent-id
               :handle (get final-facts "display_handle")
               :outcome final-outcome :facts final-facts :log (str log-file)}
              {:status :failed :agent-id agent-id :exit exit :facts final-facts
               :missing (identity-defects final-facts)
               :log (str log-file)}))

          (>= (System/currentTimeMillis) deadline)
          (do
            (stop-process! process)
            {:status :timeout :agent-id agent-id :facts facts
             :missing (identity-defects facts)
             :log (str log-file) :timeout-ms timeout-ms})

          :else
          (do (Thread/sleep poll-ms) (recur facts)))))))

(defn log-tail
  ([log-file] (log-tail log-file 2048))
  ([log-file max-bytes]
   (try
     (let [file (io/file log-file)]
       (if-not (.isFile file)
         ""
         (with-open [raf (java.io.RandomAccessFile. file "r")]
           (let [size (.length raf)
                 start (max 0 (- size max-bytes))
                 bytes (byte-array (int (- size start)))]
             (.seek raf start)
             (.readFully raf bytes)
             (str/trim (String. bytes java.nio.charset.StandardCharsets/UTF_8))))))
     (catch Exception _ ""))))

(defn failure-message
  [{:keys [status agent-id exit missing log timeout-ms]}]
  (let [why (case status
              :timeout (str "startup acknowledgement timed out after " timeout-ms "ms")
              :failed (str "child exited before startup acknowledgement"
                           (when (some? exit) (str " (exit " exit ")")))
              "startup failed")
        missing-note (when (seq missing)
                       (str "; missing identity: " (str/join "," missing)))
        tail (log-tail log)]
    (str "agent " agent-id " " why missing-note
         "; durable log: " log
         (when (seq tail) (str "\nlast log output:\n" tail)))))
