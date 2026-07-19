#!/usr/bin/env bb
;; ============================================================================
;; north-reactor.clj <port> [debounce-ms] — COORDINATOR AUTO-EXPORT.
;;
;; The threads/*.md files are a PROJECTION of the fact log, but freshness was
;; MANUAL (`north export`/`heal`) and forbidden during concurrent work — so every
;; write that didn't self-render (`fram tell`, the MCP tell tool, and the CLI
;; spokes concern/presence/msg/lease that write via the daemon socket) left the
;; file lagging the log. That lag ACCUMULATED (348 stale facts in one day) until
;; a human ran `heal`, and doctor screamed DEGRADED at every boot for the benign
;; drift. This reactor kills the class at the root: it treats the coordinator's
;; commit stream as the trigger and re-projects touched threads automatically, so
;; files NEVER lag the log and no client ever has to remember to render.
;;
;; HOW: the daemon already firehoses every commit to :subscribe subscribers
;; (coord_daemon notify-subs!). We subscribe (nil filter = firehose), coalesce
;; a burst of commits behind a short debounce, then shell the SAME `north heal` a
;; human runs — byte-identical to `north export` (both render via fram.export/
;; thread-md) and FAIL-CLOSED on genuine hand edits (a human decides those). heal
;; self-scopes: it re-renders ONLY the files that diverge from the log, so a burst
;; of edits costs one flush, and an idle stream costs nothing.
;;
;; This needs NO change to the coordinator (fram) — it rides the existing
;; :subscribe seam. It is a standalone sidecar: start it alongside the daemon.
;;   FRAM_LOG / FRAM_THREADS / FRAM_PORT select the target state (same env
;;   `north`/`fram-up` read); heal inherits them from our env.
;;
;;   bb cli/north-reactor.clj 7977            # firehose :7977, 400ms debounce
;;   bb cli/north-reactor.clj 7977 250        # tighter debounce
;;   north reactor &                          # via the bin/north wrapper (bg task)
;; ============================================================================
(require '[cheshire.core :as json]
         '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str]
         '[babashka.process :as proc])

;; shared coord substrate (write verbs + renewable-lease liveness) — the sweep judges
;; owner death by the SAME lease rule presence-cli/concern-cli use, and writes its
;; verdict through the coordinator (auditable facts, never a mutated cell).
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
;; PURE reap decisions (verdict off in-memory facts) — split out so reap_test.clj can
;; drive the join/lapse/verdict logic with no live daemon. Sibling of coord.clj.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/reap.clj"))
;; DURABLE last-sweep heartbeat — the reactor's liveness trace `north doctor` reads.
;; Shared writer/reader lib (doctor loads the same file); we stamp it at each sweep.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/reactor-heartbeat.clj"))

;; `sweep-once` verb: one-shot reap for testing. `bb cli/north-reactor.clj sweep-once
;; [--dry-run] [--repo <repo>]`. Otherwise argv = [port debounce] for the reactor loop.
(def raw-args   *command-line-args*)
(def sweep-verb? (= (first raw-args) "sweep-once"))
(def s-args     (if sweep-verb? (vec (rest raw-args)) (vec raw-args)))
(def sweep-flags (set (filter #(str/starts-with? % "--") s-args)))
(def dry-run?   (contains? sweep-flags "--dry-run"))
(def sweep-repo (when sweep-verb?
                  (let [pos (remove #(str/starts-with? % "--") s-args)
                        i (.indexOf (vec s-args) "--repo")]
                    (cond (>= i 0) (get s-args (inc i))
                          (seq pos) (first pos)
                          :else nil))))
(def port (Integer/parseInt (or (when-not sweep-verb? (first s-args))
                                 (System/getenv "FRAM_PORT") "7977")))
(def debounce-ms (Integer/parseInt (or (when-not sweep-verb? (second s-args)) "400")))

;; ---- LIVENESS-DERIVED REAPING (design 019f4418) -----------------------------
;; Two terminal verdicts the reactor writes on its cadence (or via sweep-once):
;;   1. a `building` concern whose owner has been LAPSED >24h  -> reached=abandoned-stale
;;      (likely-to-land is EXEMPT — it survives owner death as a handoff signal).
;;   2. a kind=lane agent LAPSED >30min with no COMMITTED lane/run terminal
;;      -> a committed process=died-unreported, delivery=blocked terminal; if it
;;      carries a coordinator/supervisor, ping it.
;; Every write goes through :7977 (coord/append!/put!), so the audit trail is a fact.
(def CONCERN-STALE-MS north.reap/CONCERN-STALE-MS)   ; 24h
(def LANE-STALE-MS    north.reap/LANE-STALE-MS)      ; 30min

(defn q-col [body]
  (->> (:ok (north.coord/send-op port {:op :query
              :query {:find "e" :rules [{:head {:rel "e" :args [{:var "e"}]} :body body}]}}))
       (map first)))

(defn strip-sigil [s pfx] (if (str/starts-with? s pfx) (subs s (count pfx)) s))

;; declare-time is embedded in the id: @concern-<epoch-ms>-<hex>. A stale-age LOWER
;; BOUND when the owner never held a lease at all (dead-agent concerns predate presence).
(defn concern-mint-ms [c]
  (some-> (re-find #"concern-(\d{10,})" (str c)) second parse-long))

(defn owner-lapse-ms
  "How long this concern's owner has been OFFLINE, in ms — or nil if the owner is
   ONLINE (unexpired lease) or the concern is agent-less. When the owner holds an
   expired lease the lapse is exact; when it never held a lease (a pre-presence dead
   agent) the concern's own age is the staleness lower bound."
  [c]
  (let [a (north.coord/resolved port c "agent")]
    (when (and a (seq a))
      (let [now (System/currentTimeMillis)
            l   (north.coord/lease-of port (str "session:" (strip-sigil a "@")))]
        (cond
          (and l (> (:exp l) now)) nil                          ; owner ONLINE
          l                        (- now (:exp l))             ; expired lease -> exact lapse
          :else (when-let [m (concern-mint-ms c)] (- now m))))))) ; no lease -> age lower bound

(defn building-only?
  "True iff the concern reached `building` and never progressed past it (and isn't
   already abandoned). likely-to-land/landed are EXCLUDED — a handoff must survive."
  [rs]
  (and (contains? rs "building")
       (not (rs "likely-to-land")) (not (rs "landed")) (not (rs "abandoned-stale"))))

(defn sweep-concerns! [dry?]
  (let [concerns (distinct (q-col [{:rel "triple" :args [{:var "e"} "kind" "concern"]}]))
        hits (for [c concerns
                   :let  [rs (set (north.coord/many port c "reached"))]
                   :when (building-only? rs)
                   :let  [lapse (owner-lapse-ms c)]
                   :when (and lapse (>= lapse CONCERN-STALE-MS)
                              (or (nil? sweep-repo)
                                  (= sweep-repo (north.coord/resolved port c "repo"))))]
               {:c c :lapse lapse :agent (north.coord/resolved port c "agent")})]
    (doseq [{:keys [c lapse agent]} hits]
      (when-not dry? (north.coord/append! port c "reached" "abandoned-stale"))
      (println (str "[sweep] " (if dry? "WOULD abandon" "abandoned-stale") " " c
                    "  owner " agent " lapsed " (long (/ lapse 3600000)) "h")))
    (count hits)))

(defn ping-coordinator [coord h]
  (try
    (proc/shell {:out :string :err :string :continue true}
                "bb" (str (.getParent (io/file (System/getProperty "babashka.file"))) "/msg-cli.clj")
                (str port) "send" "north-reactor" coord "URGENT"
                (str "lane " h
                     " died unreported (presence lapsed >30min, no committed terminal) — reaped by reactor"))
    (catch Throwable _ nil)))

;; ---- impure GATHER for the reap verdict (pure logic lives in north.reap) ------------
;; The synchronous lane terminal is primary. A committed kind=run row is a
;; secondary trail; body facts from a crashed run writer remain invisible until
;; its last kind=run write. @swarm agent_death is a notification receipt only:
;; a hard kill between that ping and terminal publication must remain reapable.
(defn subject-facts
  "All live facts for one subject, preserving multi-value conflicts as sets."
  [subject]
  (let [rows (:ok (north.coord/send-op
                   port {:op :query
                         :query {:find "terminal_fact"
                                 :rules [{:head {:rel "terminal_fact"
                                                 :args [{:var "p"} {:var "r"}]}
                                          :body [{:rel "triple"
                                                  :args [subject {:var "p"} {:var "r"}]}]}]}}))]
    (reduce (fn [facts [predicate value]]
              (update facts predicate (fnil conj #{}) value))
            {}
            rows)))

(defn committed-runs-tagged-agent
  "Run subjects carrying both agent=<h> and the writer's last-write kind=run marker."
  [h]
  (distinct
   (q-col [{:rel "triple" :args [{:var "e"} "agent" h]}
           {:rel "triple" :args [{:var "e"} "kind" "run"]}])))

(defn lane-resolved?* [h]
  (north.reap/lane-resolved?
    h
    (subject-facts (str "@agent:" h))
    (map subject-facts (committed-runs-tagged-agent h))))

(def agent-fact-writer
  (str (.getParent (io/file (System/getProperty "babashka.file")))
       "/agent-fact-internal.clj"))

(defn publish-reaped-terminal!
  "Use the harness's scoped terminal writer so a reaper verdict has the same
  readback and last-write digest protocol as every SDK terminal."
  [subject]
  (let [payload (json/generate-string
                 {"outcome" "died-unreported"
                  "process_outcome" "died-unreported"
                  "delivery_outcome" "blocked"
                  "delivery_reason" "presence_lapsed_without_committed_terminal"})
        result (proc/shell {:out :string :err :string :continue true}
                           "bb" agent-fact-writer (str port) "terminal" subject payload)]
    (when-not (zero? (:exit result))
      (throw (ex-info "failed to commit reaper terminal"
                      {:subject subject :stderr (:err result)})))))

(defn spawned-ms
  "@agent:<id> spawned_at (ISO) -> epoch ms, or nil (the leaseless-dead staleness axis)."
  [e]
  (when-let [ts (north.coord/resolved port e "spawned_at")]
    (try (.toEpochMilli (java.time.Instant/parse ts)) (catch Throwable _ nil))))

(defn driver-pairs []
  (:ok (north.coord/send-op port {:op :query
        :query {:find "row"
                :rules [{:head {:rel "row" :args [{:var "e"} {:var "driver"}]}
                         :body [{:rel "triple" :args [{:var "e"} "driver" {:var "driver"}]}]}]}})))

;; Crash-honesty: a reaped lane may have left a clock session open (SDK death path
;; never ran — hard kill). Close it via the SAME `north clock orphan` the SDK uses:
;; stamps end_time at detection + clock_orphaned so a silent death never leaves a
;; session running forever and skewing wall-clock. Idempotent (no-op if already
;; closed); best-effort. north-bin path computed inline (its def is later in the file).
(defn orphan-clock! [h]
  (try
    (proc/shell {:out :string :err :string :continue true}
                (-> (io/file (System/getProperty "babashka.file"))
                    .getParentFile .getParentFile (io/file "bin" "north") .getPath)
                "clock" "orphan" h)
    (catch Throwable _ nil)))

(defn release-orphaned-drivers! [h]
  ;; A hard-killed dispatch cannot run its finally/release. Once the SAME lane
  ;; crosses the 30-minute reap bar, retract only exact @<handle> driver refs.
  ;; A successor that won between query and retract has a different object and
  ;; is therefore untouched by the exact-value retraction.
  (let [driver-ref (str "@" h)
        threads (q-col [{:rel "triple" :args [{:var "e"} "driver" driver-ref]}])]
    (doseq [thread threads]
      (north.coord/retract! port thread "driver" driver-ref))))

(defn sweep-unpublished-driver-claims! [dry?]
  ;; Claim is intentionally the first dispatch side effect. A hard kill before
  ;; identity publication therefore leaves no kind=lane row for sweep-lanes!.
  ;; Current SDK IDs encode a mint timestamp; after the same 30-minute bar, an
  ;; unpublished holder is unrecoverable and its exact driver ref can be retired.
  ;; Legacy/malformed IDs have no trusted clock and are never guessed at.
  (let [now (System/currentTimeMillis)
        lanes (->> (q-col [{:rel "triple" :args [{:var "e"} "kind" "lane"]}])
                   (map #(strip-sigil % "@agent:"))
                   set)
        hits (north.reap/orphaned-unpublished-driver-pairs now lanes (driver-pairs))]
    (doseq [[thread driver-ref] hits]
      (when-not dry? (north.coord/retract! port thread "driver" driver-ref))
      (println (str "[sweep] " (if dry? "WOULD release" "released")
                    " unpublished driver " driver-ref " from " thread
                    "  age >=30min")))
    (count hits)))

(defn sweep-lanes! [dry?]
  (let [lanes (distinct (q-col [{:rel "triple" :args [{:var "e"} "kind" "lane"]}]))
        now   (System/currentTimeMillis)
        deaths (north.coord/many port "@swarm" "agent_death")
        hits (for [e lanes
                   :let  [h        (strip-sigil e "@agent:")
                          l        (north.coord/lease-of port (str "session:" h))
                          lease-exp (:exp l)
                          sp       (or (spawned-ms e) (north.reap/sdk-agent-mint-ms h))]
                   :when (north.reap/reap-lane? now (lane-resolved?* h) lease-exp sp)]
               {:e e :h h :lapse (north.reap/lane-lapse-ms now lease-exp sp)})]
    (doseq [{:keys [e h lapse]} hits]
      (when-not dry?
        (publish-reaped-terminal! e)
        (orphan-clock! h)                                                  ; close any orphan clock session the dead lane left open
        (release-orphaned-drivers! h)                                      ; unblock threads held by the hard-killed lane
        ;; Death is terminal evidence, not a mutation of identity/name caches.
        ;; Every UI derives its decoration from the committed process/delivery facts.
        (let [coord (or (north.coord/resolved port e "coordinator")
                        (north.coord/resolved port e "supervisor"))]
          (when (and coord (seq coord)
                     (not (north.reap/death-reported? h deaths)))
            (ping-coordinator coord h))))
      (println (str "[sweep] " (if dry? "WOULD reap" "reaped") " lane " e
                    "  lapsed " (long (/ lapse 60000))
                    "min -> process=died-unreported delivery=blocked")))
    (count hits)))

;; ---- DAILY CLOCK-AUDIT TICK (drift telemetry) -------------------------------
;; The clock-audit output evaporates; a drift TREND is exactly the telemetry the
;; billing failure mode needs. Piggyback the 5-min sweep with a once-per-day gate:
;; state is the LAST clock_audit_run's run_at (a fact, never a loose state file), so
;; the gate is self-describing and survives a reactor restart. --dry-run reports WOULD
;; without writing, keeping sweep-once --dry-run clean.
(def CLOCK-AUDIT-INTERVAL-MS (* 24 60 60 1000))         ; once per day
(def clock-audit-bin
  (-> (io/file (System/getProperty "babashka.file"))
      .getParentFile .getParentFile (io/file "bin" "north-clock-audit") .getPath))

(defn last-clock-audit-ms
  "Newest kind=clock_audit_run run_at as epoch-ms, or nil if none exists yet."
  []
  (let [runs (distinct (q-col [{:rel "triple" :args [{:var "e"} "kind" "clock_audit_run"]}]))
        ms   (->> runs
                  (keep #(north.coord/resolved port % "run_at"))
                  (keep (fn [ts] (try (.toEpochMilli (java.time.Instant/parse ts))
                                      (catch Throwable _ nil)))))]
    (when (seq ms) (reduce max ms))))

(defn maybe-clock-audit!
  "Run clock-audit --persist at most once per day. Returns :ran / :would / :skip.
   clock-audit exits 1 on uncovered commits — :continue true so drift never crashes
   the reactor. Best-effort: a failure is logged, not fatal."
  [dry?]
  (let [last (last-clock-audit-ms)
        due? (or (nil? last) (>= (- (System/currentTimeMillis) last) CLOCK-AUDIT-INTERVAL-MS))]
    (cond
      (not due?) :skip
      dry?       (do (println (str "[sweep] WOULD run clock-audit --persist"
                                   (when last (str " (last " (long (/ (- (System/currentTimeMillis) last) 3600000)) "h ago)"))))
                     :would)
      :else      (do (try
                       (let [r (proc/shell {:out :string :err :string :continue true}
                                           clock-audit-bin "--persist")]
                         (println (str "[sweep] clock-audit --persist exit=" (:exit r)))
                         (when (seq (str/trim (str (:err r))))
                           (println (str "[sweep] clock-audit stderr: " (str/trim (str (:err r)))))))
                       (catch Throwable t
                         (println (str "[sweep] clock-audit error: " (.getMessage t)))))
                     (flush)
                     :ran))))

;; ---- AGENT STREAM-LOG ROTATION (durable-but-untidy GC) ----------------------
;; north-data/agents/*.log are per-agent SDK stream logs — hundreds of files,
;; unbounded, off-graph. Two BOUNDED hygiene ops, piggybacked on the sweep and gated
;; exactly like the reaper — the JANITOR never declares death, it only prunes what the
;; REAPER already marked terminal:
;;   (a) DELETE a log whose agent has committed terminal evidence AND mtime >30d.
;;       Without committed evidence it is NEVER touched, regardless of age — a
;;       silent-but-alive or not-yet-reaped trail must survive for the reaper/audit.
;;   (b) CAP any single log at 5MB, keeping the TAIL (recent turns are the useful end;
;;       the stale head is dropped). Independent of outcome — a runaway log is bounded
;;       even while its agent is live.
;; The expensive terminal-outcome query is gated behind the cheap mtime filter, so a
;; set of young logs costs zero coordinator round-trips. --dry-run prints WOULD-prune/
;; WOULD-cap without writing. Dir override NORTH_AGENT_LOGS_DIR (tests only), mirroring
;; TRIPWIRE_LOG_DIR / sweep-repo.
(def AGENT-LOG-STALE-MS (* 30 24 60 60 1000))    ; 30 days terminal -> prunable
(def AGENT-LOG-CAP-BYTES (* 5 1024 1024))        ; 5 MB tail cap
(def agent-logs-dir
  (or (System/getenv "NORTH_AGENT_LOGS_DIR")
      ;; <parent-of-repo>/north-data/agents — north-data is a SIBLING of the north repo.
      (-> (io/file (System/getProperty "babashka.file"))
          .getParentFile .getParentFile .getParentFile
          (io/file "north-data" "agents") .getPath)))

(defn cap-log-tail!
  "If f exceeds AGENT-LOG-CAP-BYTES, rewrite it to its last CAP bytes, dropping the
   partial leading line. Byte-exact (no charset round-trip). Returns bytes trimmed, or 0
   if under cap / dry-run. Atomic via .tmp + rename."
  [^java.io.File f dry?]
  (let [len (.length f)]
    (if (<= len AGENT-LOG-CAP-BYTES)
      0
      (let [trim (- len AGENT-LOG-CAP-BYTES)]
        (when-not dry?
          (let [buf (byte-array AGENT-LOG-CAP-BYTES)]
            (with-open [raf (java.io.RandomAccessFile. f "r")]
              (.seek raf trim)
              (.readFully raf buf))
            (let [nl    (loop [i 0] (cond (>= i (alength buf)) -1
                                          (= (aget buf i) (byte 10)) i
                                          :else (recur (inc i))))
                  start (if (>= nl 0) (inc nl) 0)
                  tmp   (io/file (str (.getPath f) ".tmp"))]
              (with-open [os (io/output-stream tmp)]
                (.write os buf start (- (alength buf) start)))
              (.renameTo tmp f))))
        trim))))

(defn sweep-agent-logs! [dry?]
  (let [dir  (io/file agent-logs-dir)
        now  (System/currentTimeMillis)
        logs (when (.isDirectory dir)
               (filter #(and (.isFile ^java.io.File %) (str/ends-with? (.getName ^java.io.File %) ".log"))
                       (.listFiles dir)))
        deleted (atom 0) capped (atom 0)]
    (doseq [^java.io.File f logs]
      (let [age (- now (.lastModified f))]
        (if (and (>= age AGENT-LOG-STALE-MS)
                 ;; expensive terminal-outcome join — reached ONLY for >30d logs
                 (lane-resolved?* (str/replace (.getName f) #"\.log$" "")))
          (do (when-not dry? (.delete f))
              (swap! deleted inc)
              (println (str "[sweep] " (if dry? "WOULD delete" "deleted") " log " (.getName f)
                            "  age " (long (/ age 86400000)) "d (agent resolved)")))
          (let [trimmed (cap-log-tail! f dry?)]
            (when (pos? trimmed)
              (swap! capped inc)
              (println (str "[sweep] " (if dry? "WOULD cap" "capped") " log " (.getName f)
                            "  -" (long (/ trimmed 1048576)) "MB (tail kept)")))))))
    {:deleted @deleted :capped @capped}))

(defn sweep! [dry?]
  (let [nc (sweep-concerns! dry?) nl (sweep-lanes! dry?)
        nd (sweep-unpublished-driver-claims! dry?)
        al (sweep-agent-logs! dry?)
        ca (maybe-clock-audit! dry?)]
    ;; Durable last-sweep heartbeat — write ONLY on a real sweep so doctor can tell a
    ;; running reactor from a dead one. --dry-run leaves no trace (mirrors clock-audit).
    (when-not dry? (north.reactor-heartbeat/write-heartbeat! port))
    (println (str "[sweep] " (when dry? "(dry-run) ") "concerns abandoned=" nc
                  " lanes reaped=" nl " unpublished drivers released=" nd
                  " logs deleted=" (:deleted al) " capped=" (:capped al)
                  " clock-audit=" (name ca)))
    (flush)
    {:concerns nc :lanes nl :unpublished-drivers nd :agent-logs al :clock-audit ca}))

(defn sweep-loop []
  (loop []
    (Thread/sleep (* 5 60 1000))                    ; 5-min cadence, first sweep after one interval
    (try (sweep! false)
         (catch Throwable t (println (str "[sweep] error: " (.getMessage t))) (flush)))
    (recur)))

;; bin/north is a sibling of this cli/ dir: <repo>/cli/north-reactor.clj -> <repo>/bin/north
(def north-bin
  (-> (io/file (System/getProperty "babashka.file"))
      .getParentFile .getParentFile (io/file "bin" "north") .getPath))

;; Coordination-EPHEMERAL subjects: never projected to a thread .md AND written at
;; tool-call frequency (presence leases, session stamps, per-run costs, messages,
;; command envelopes, agent/role registry). Skipping them keeps heal firing only on
;; REAL thread edits instead of on every heartbeat — the reactor's whole cost budget.
(def ephemeral-prefixes ["@lease:" "@session:" "@run:" "@cmd:" "@agent:" "@role:"])
(defn ephemeral? [l]
  (and (string? l) (boolean (some #(str/starts-with? l %) ephemeral-prefixes))))

(def last-commit (atom 0))   ; wall-clock of the most recent projected-relevant commit
(def dirty       (atom false))
(def running     (atom false))
(def last-heal-out (atom nil))  ; last heal output line — dedup repeated identical output

(defn heal! []
  ;; Shell the SAME `north heal` a human runs — byte-identical projection, fail-closed
  ;; on hand edits, reads the flat log directly (no daemon dependency). FRAM_LOG/
  ;; FRAM_THREADS/FRAM_PORT are inherited from our env, pinning the target state.
  ;; NOISE FIX: a permanent hand-edit refusal re-prints "heal REFUSED …" on EVERY flush,
  ;; so a single unresolved conflict grew reactor-7977.log to 642KB of one repeated line —
  ;; burying real events. Dedup: log heal output only when it CHANGES from the last line.
  ;; A resolved conflict (output goes empty/different) prints again, so no signal is lost.
  (try
    (let [r    (proc/shell {:out :string :err :string :continue true} north-bin "heal")
          out  (str/trim (str (:out r) (when (seq (:err r)) (str "\n" (:err r)))))
          line (when (seq out) (str "[reactor] " (str/replace out #"\n+" " | ")))]
      (when (and line (not= line @last-heal-out))
        (println line) (flush))
      (reset! last-heal-out line))
    (catch Throwable t
      (println (str "[reactor] heal error: " (.getMessage t))) (flush))))

;; Flusher: once a burst goes quiet for debounce-ms, project. Coalesced — only one
;; heal in flight; commits arriving mid-heal re-arm dirty for the next quiet window.
(defn flusher []
  (loop []
    (Thread/sleep 100)
    (when (and @dirty (not @running)
               (>= (- (System/currentTimeMillis) @last-commit) debounce-ms))
      (reset! dirty false)
      (reset! running true)
      (try (heal!) (finally (reset! running false))))
    (recur)))

(defn mark! [l]
  (when-not (ephemeral? l)
    (reset! last-commit (System/currentTimeMillis))
    (reset! dirty true)))

(defn subscribe-once
  "Open one subscription and pump commit events until the socket drops. Returns on
   disconnect (daemon bounce / restart) so -main can reconnect."
  []
  (with-open [s (north.coord/connect-socket port)]
    (let [w (.getOutputStream s)
          reader (north.coord/coordinator-reader s)]
      (.write w
              (.getBytes
               (str (pr-str
                     (north.coord/log-envelope {:op :subscribe}))
                    "\n")
               java.nio.charset.StandardCharsets/UTF_8))
      (.flush w)
      (north.coord/validate-subscription!
       (north.coord/read-line-bounded! reader))
      (.setSoTimeout s 0)               ; validated long-lived stream: wait indefinitely for pushes
      (loop []
        (when-let [line
                   (north.coord/read-stream-line-bounded! reader)]
          (let [ev (try (edn/read-string line) (catch Throwable _ nil))]
            (when (and (map? ev) (= (:event ev) :commit))
              (mark! (:l ev))))
          (recur))))))

(defn -main []
  (println (str "[reactor] coordinator auto-export: subscribe :" port
                " (debounce " debounce-ms "ms) -> " north-bin " heal"
                " | liveness sweep every 5min"))
  (flush)
  ;; Stamp once at startup so a just-booted reactor reads FRESH in doctor immediately,
  ;; rather than MISSING for the first 5-min interval before sweep-loop's first pass.
  (north.reactor-heartbeat/write-heartbeat! port)
  (future (flusher))
  (future (sweep-loop))       ; liveness-derived reaping on the reactor cadence
  (loop []
    (try (subscribe-once)
         (catch Throwable t
           (println (str "[reactor] subscription lost (" (.getMessage t) ") — reconnecting")) (flush)))
    (Thread/sleep 1000)               ; brief backoff, then reconnect (survives a bounce)
    (recur)))

(if sweep-verb?
  (do (sweep! dry-run?) (System/exit 0))
  (-main))
