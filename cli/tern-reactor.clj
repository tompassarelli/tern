#!/usr/bin/env bb
;; ============================================================================
;; tern-reactor.clj <port> [debounce-ms] — COORDINATOR AUTO-EXPORT.
;;
;; The threads/*.md files are a PROJECTION of the fact log, but freshness was
;; MANUAL (`tern export`/`heal`) and forbidden during concurrent work — so every
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
;; a burst of commits behind a short debounce, then shell the SAME `tern heal` a
;; human runs — byte-identical to `tern export` (both render via fram.export/
;; thread-md) and FAIL-CLOSED on genuine hand edits (a human decides those). heal
;; self-scopes: it re-renders ONLY the files that diverge from the log, so a burst
;; of edits costs one flush, and an idle stream costs nothing.
;;
;; This needs NO change to the coordinator (fram) — it rides the existing
;; :subscribe seam. It is a standalone sidecar: start it alongside the daemon.
;;   FRAM_LOG / FRAM_THREADS / FRAM_PORT select the target state (same env
;;   `tern`/`fram-up` read); heal inherits them from our env.
;;
;;   bb cli/tern-reactor.clj 7977            # firehose :7977, 400ms debounce
;;   bb cli/tern-reactor.clj 7977 250        # tighter debounce
;;   tern reactor &                          # via the bin/tern wrapper (bg task)
;; ============================================================================
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str]
         '[babashka.process :as proc])

;; shared coord substrate (write verbs + renewable-lease liveness) — the sweep judges
;; owner death by the SAME lease rule presence-cli/concern-cli use, and writes its
;; verdict through the coordinator (auditable facts, never a mutated cell).
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))

;; `sweep-once` verb: one-shot reap for testing. `bb cli/tern-reactor.clj sweep-once
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
;;   2. a kind=lane agent LAPSED >30min with NO outcome fact   -> outcome=died-unreported,
;;      display_name prefixed "✝ ", and if it carries a coordinator/supervisor, ping it.
;; Every write goes through :7977 (coord/append!/put!), so the audit trail is a fact.
(def CONCERN-STALE-MS (* 24 60 60 1000))   ; 24h
(def LANE-STALE-MS    (* 30 60 1000))      ; 30min

(defn q-col [body]
  (->> (:ok (tern.coord/send-op port {:op :query
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
  (let [a (tern.coord/resolved port c "agent")]
    (when (and a (seq a))
      (let [now (System/currentTimeMillis)
            l   (tern.coord/lease-of port (str "session:" (strip-sigil a "@")))]
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
                   :let  [rs (set (tern.coord/many port c "reached"))]
                   :when (building-only? rs)
                   :let  [lapse (owner-lapse-ms c)]
                   :when (and lapse (>= lapse CONCERN-STALE-MS)
                              (or (nil? sweep-repo)
                                  (= sweep-repo (tern.coord/resolved port c "repo"))))]
               {:c c :lapse lapse :agent (tern.coord/resolved port c "agent")})]
    (doseq [{:keys [c lapse agent]} hits]
      (when-not dry? (tern.coord/append! port c "reached" "abandoned-stale"))
      (println (str "[sweep] " (if dry? "WOULD abandon" "abandoned-stale") " " c
                    "  owner " agent " lapsed " (long (/ lapse 3600000)) "h")))
    (count hits)))

(defn ping-coordinator [coord h]
  (try
    (proc/shell {:out :string :err :string :continue true}
                "bb" (str (.getParent (io/file (System/getProperty "babashka.file"))) "/msg-cli.clj")
                (str port) "send" "tern-reactor" coord "URGENT"
                (str "lane " h " died unreported (presence lapsed >30min, no outcome) — reaped by reactor"))
    (catch Throwable _ nil)))

(defn sweep-lanes! [dry?]
  (let [lanes (distinct (q-col [{:rel "triple" :args [{:var "e"} "kind" "lane"]}]))
        now   (System/currentTimeMillis)
        hits (for [e lanes
                   :let  [h (strip-sigil e "@agent:")
                          l (tern.coord/lease-of port (str "session:" h))
                          outcome (tern.coord/many port e "outcome")]
                   :when (and (empty? outcome) l (<= (:exp l) now)
                              (>= (- now (:exp l)) LANE-STALE-MS))]
               {:e e :h h :lapse (- now (:exp l))})]
    (doseq [{:keys [e h lapse]} hits]
      (when-not dry?
        (tern.coord/put! port e "outcome" "died-unreported")
        (let [dn (tern.coord/resolved port e "display_name")]
          (when (and dn (not (str/starts-with? dn "✝ ")))
            (tern.coord/put! port e "display_name" (str "✝ " dn))))       ; recompute the projected name
        (let [coord (or (tern.coord/resolved port e "coordinator")
                        (tern.coord/resolved port e "supervisor"))]
          (when (and coord (seq coord)) (ping-coordinator coord h))))
      (println (str "[sweep] " (if dry? "WOULD reap" "reaped") " lane " e
                    "  lapsed " (long (/ lapse 60000)) "min -> outcome=died-unreported")))
    (count hits)))

(defn sweep! [dry?]
  (let [nc (sweep-concerns! dry?) nl (sweep-lanes! dry?)]
    (println (str "[sweep] " (when dry? "(dry-run) ") "concerns abandoned=" nc " lanes reaped=" nl))
    (flush)
    {:concerns nc :lanes nl}))

(defn sweep-loop []
  (loop []
    (Thread/sleep (* 5 60 1000))                    ; 5-min cadence, first sweep after one interval
    (try (sweep! false)
         (catch Throwable t (println (str "[sweep] error: " (.getMessage t))) (flush)))
    (recur)))

;; bin/tern is a sibling of this cli/ dir: <repo>/cli/tern-reactor.clj -> <repo>/bin/tern
(def tern-bin
  (-> (io/file (System/getProperty "babashka.file"))
      .getParentFile .getParentFile (io/file "bin" "tern") .getPath))

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

(defn heal! []
  ;; Shell the SAME `tern heal` a human runs — byte-identical projection, fail-closed
  ;; on hand edits, reads the flat log directly (no daemon dependency). FRAM_LOG/
  ;; FRAM_THREADS/FRAM_PORT are inherited from our env, pinning the target state.
  (try
    (let [r   (proc/shell {:out :string :err :string :continue true} tern-bin "heal")
          out (str/trim (str (:out r) (when (seq (:err r)) (str "\n" (:err r)))))]
      (when (seq out)
        (println (str "[reactor] " (str/replace out #"\n+" " | ")))
        (flush)))
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
  (with-open [s (java.net.Socket. "127.0.0.1" (int port))]
    (.setSoTimeout s 0)                 ; long-lived: block on pushes, no read timeout
    (let [w (.getOutputStream s)
          r (io/reader (.getInputStream s))]
      (.write w (.getBytes "{:op :subscribe}\n")) (.flush w)
      (.readLine r)                     ; consume the {:subscribed <seq>} handshake
      (loop []
        (when-let [line (.readLine r)]
          (let [ev (try (edn/read-string line) (catch Throwable _ nil))]
            (when (and (map? ev) (= (:event ev) :commit))
              (mark! (:l ev))))
          (recur))))))

(defn -main []
  (println (str "[reactor] coordinator auto-export: subscribe :" port
                " (debounce " debounce-ms "ms) -> " tern-bin " heal"
                " | liveness sweep every 5min"))
  (flush)
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
