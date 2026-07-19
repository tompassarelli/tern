;; reactor-heartbeat.clj — the reactor's DURABLE last-sweep liveness marker,
;; shared by north-reactor.clj (writer) and dashboard-cli.clj doctor (reader).
;;
;; The reactor sweeps every 5 min (sweep-concerns!/sweep-lanes!/…) but left NO
;; durable trace, so `north doctor` could not tell a running reactor from a dead
;; one — a stopped reactor read as healthy. This lib is that trace: an atomic-rename
;; write of a strict ISO-8601 instant to a port-keyed file under ~/.cache/north (the
;; cockpit-sanctioned state home per operating-manual — no new daemons, no new state
;; homes). The reactor stamps it on every sweep pass, on sweep-once, and once at
;; -main startup; doctor reads it and classifies :fresh / :stale / :missing.
;;
;; PATH: NORTH_REACTOR_HEARTBEAT (a full file path) overrides everything — tests
;; point it at a temp file so no live reactor or daemon is needed. Otherwise
;; $HOME/.cache/north/reactor-heartbeat-<port>. Port-keyed so two coordinators on
;; different ports never clobber each other's heartbeat.
;;
;; PORT DERIVATION IS DUPLICATED AT THE CALL SITE, DELIBERATELY: the reactor derives
;; its port from FRAM_PORT, doctor from NORTH_PORT — two env names, BOTH defaulting to
;; 7977, so a stock single-coordinator box always agrees. Centralizing that one line
;; here would force this lib to pick one of the two names and silently disagree with
;; the other caller. The sweep-once read-after-exit integration test is the drift guard.
;;
;; Loaded (not required) the same way north-reactor.clj loads coord.clj / reap.clj.
(ns north.reactor-heartbeat
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str])
  (:import [java.time Instant]
           [java.time.temporal ChronoUnit]
           [java.nio.file Files StandardCopyOption]
           [java.nio.file.attribute FileAttribute]))

;; STALE at 3x the 5-min sweep cadence: one missed sweep is jitter, three is dead.
(def STALE-MS (* 15 60 1000))

(defn heartbeat-file
  "The durable heartbeat file for `port` as a java.io.File. NORTH_REACTOR_HEARTBEAT
   (a full path) wins for tests; otherwise $HOME/.cache/north/reactor-heartbeat-<port>."
  [port]
  (if-let [override (System/getenv "NORTH_REACTOR_HEARTBEAT")]
    (io/file override)
    (io/file (System/getenv "HOME") ".cache" "north"
             (str "reactor-heartbeat-" port))))

(defn- write-heartbeat-record!
  [port details? details]
  (let [f   (heartbeat-file port)
        dir (.getParentFile f)]
    (when dir (.mkdirs dir))
    (let [now (Instant/now)
          tmp (io/file (str (.getPath f) ".tmp"))
          payload (if details?
                    (pr-str {:at (str now) :details details})
                    (str now))]
      (spit tmp payload)
      (Files/move (.toPath tmp) (.toPath f)
                  (into-array StandardCopyOption
                              [StandardCopyOption/ATOMIC_MOVE
                               StandardCopyOption/REPLACE_EXISTING]))
      now)))

(defn write-heartbeat!
  "Stamp the current instant (strict ISO-8601) into the heartbeat file for `port`.
   Crash-safe: writes a sibling .tmp then ATOMIC_MOVE over the target, so a reader
   never sees a torn write. Best-effort — a filesystem failure is logged, never fatal
   to the sweep. The two-argument form atomically carries bounded sweep details
   with the timestamp; the legacy one-argument timestamp stays readable. Returns
   the Instant written, or nil on failure."
  ([port]
   (try
     (write-heartbeat-record! port false nil)
     (catch Throwable t
       (println (str "[reactor] heartbeat write failed: " (.getMessage t)))
       nil)))
  ([port details]
   (try
     (write-heartbeat-record! port true details)
     (catch Throwable t
       (println (str "[reactor] heartbeat write failed: " (.getMessage t)))
       nil))))

(defn read-heartbeat-record
  "Read either the legacy ISO instant or the current EDN heartbeat envelope."
  [port]
  (try
    (let [f (heartbeat-file port)]
      (when (.isFile f)
        (let [raw (str/trim (slurp f))]
          (try
            {:ts (Instant/parse raw) :details nil}
            (catch Throwable _
              (let [record (edn/read-string raw)
                    at (:at record)
                    details (:details record)]
                (when (and (map? record) (string? at)
                           (or (nil? details) (map? details)))
                  {:ts (Instant/parse at) :details details})))))))
    (catch Throwable _ nil)))

(defn read-heartbeat
  "The Instant last stamped for `port`, or nil if the file is absent/unreadable/torn."
  [port]
  (:ts (read-heartbeat-record port)))

(defn heartbeat-status
  "Classify reactor liveness from the durable heartbeat for `port`:
     {:state :fresh|:stale|:missing, :ts <Instant|nil>, :age-ms <long|nil>}
   :missing  — no readable heartbeat (never ran, or file gone): reactor cannot be
               assumed alive, so this is NOT healthy.
   :stale    — heartbeat older than STALE-MS (>= 3 missed sweeps): reactor is hung
               or dead, NOT healthy.
   :fresh    — stamped within STALE-MS: a sweep landed recently, healthy."
  [port]
  (if-let [{:keys [ts details]} (read-heartbeat-record port)]
    (let [age (.between ChronoUnit/MILLIS ts (Instant/now))]
      {:state (if (>= age STALE-MS) :stale :fresh)
       :ts ts :age-ms age :details details})
    {:state :missing :ts nil :age-ms nil :details nil}))

(defn humanize-age
  "A compact human age for an age in ms (e.g. '42s', '7m', '3h', '2d')."
  [age-ms]
  (let [s (quot age-ms 1000)]
    (cond
      (< s 60)    (str s "s")
      (< s 3600)  (str (quot s 60) "m")
      (< s 86400) (str (quot s 3600) "h")
      :else       (str (quot s 86400) "d"))))
