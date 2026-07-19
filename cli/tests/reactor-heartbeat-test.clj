#!/usr/bin/env bb
;; reactor-heartbeat-test.clj — the reactor's DURABLE last-sweep heartbeat and the
;; `north doctor` verdict it drives. Daemon-free: NORTH_REACTOR_HEARTBEAT points every
;; probe at a temp file, so no live reactor/coordinator is needed. Covers the write/read
;; roundtrip, durability across process exit (the read-after-exit property the sweep-once
;; bar exercises against the live daemon), atomic write hygiene, the fresh/stale/missing
;; verdict table, and the LOUD doctor render for each state.
;;   bb cli/tests/reactor-heartbeat-test.clj
(require '[babashka.process :as p]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def lib (str root "/cli/reactor-heartbeat.clj"))
(def dashboard (str root "/cli/dashboard-cli.clj"))

(def home (.toFile (java.nio.file.Files/createTempDirectory
                    "north-reactor-heartbeat-"
                    (make-array java.nio.file.attribute.FileAttribute 0))))
(def hb-file (io/file home "reactor-heartbeat-7977"))
(def hb-path (.getCanonicalPath hb-file))

(def checks (atom []))
(defn check
  ([label value] (check label value nil))
  ([label value detail] (swap! checks conj [label (boolean value) detail])))

(defn run-bb
  "Run a bb -e expression with NORTH_REACTOR_HEARTBEAT pinned at hb-path (plus any
   extra env). Returns {:exit :out :err}."
  [expr & {:keys [extra-env]}]
  (let [r (p/shell {:out :string :err :string :continue true
                    :extra-env (merge {"NORTH_REACTOR_HEARTBEAT" hb-path
                                       "HOME" (.getCanonicalPath home)}
                                      extra-env)}
                   "bb" "-e" expr)]
    {:exit (:exit r) :out (str/trim (:out r)) :err (str/trim (:err r))}))

(defn lib-expr [& body]
  (str "(load-file " (pr-str lib) ") " (apply str body)))

(defn stamp-file! [instant-str] (spit hb-file instant-str))
(defn iso-ago [ms] (str (.minusMillis (java.time.Instant/now) ms)))

(try
  ;; 1. write then read roundtrips to :fresh, and the file lands.
  (.delete hb-file)
  (let [r (run-bb (lib-expr "(north.reactor-heartbeat/write-heartbeat! \"7977\") "
                            "(println (name (:state (north.reactor-heartbeat/heartbeat-status \"7977\"))))"))]
    (check "write-heartbeat! then heartbeat-status reads :fresh"
           (and (zero? (:exit r)) (= "fresh" (:out r)) (.isFile hb-file))
           (pr-str r)))

  ;; 2. durability across process exit: the writer subprocess is long gone, yet the
  ;;    parent reads a parseable, recent instant from disk (the sweep-once bar property).
  (.delete hb-file)
  (let [w (run-bb (lib-expr "(north.reactor-heartbeat/write-heartbeat! \"7977\")"))
        raw (when (.isFile hb-file) (str/trim (slurp hb-file)))
        parsed (try (java.time.Instant/parse raw) (catch Throwable _ nil))
        age (when parsed (.between java.time.temporal.ChronoUnit/MILLIS parsed (java.time.Instant/now)))]
    (check "heartbeat survives process exit — durable, parseable, recent instant on disk"
           (and (zero? (:exit w)) parsed age (>= age 0) (< age 60000))
           (str "raw=" (pr-str raw))))

  ;; 3. atomic write leaves no .tmp sibling behind.
  (check "atomic write leaves no .tmp sibling"
         (not (.exists (io/file (str hb-path ".tmp")))))

  ;; 4. stale: a heartbeat older than the 15m threshold classifies :stale.
  (stamp-file! (iso-ago (* 20 60 1000)))
  (let [r (run-bb (lib-expr "(println (name (:state (north.reactor-heartbeat/heartbeat-status \"7977\"))))"))]
    (check "heartbeat 20m old classifies :stale" (= "stale" (:out r)) (pr-str r)))

  ;; 5. missing: no file at all classifies :missing (a stopped reactor is NOT healthy).
  (.delete hb-file)
  (let [r (run-bb (lib-expr "(println (name (:state (north.reactor-heartbeat/heartbeat-status \"7977\"))))"))]
    (check "absent heartbeat classifies :missing" (= "missing" (:out r)) (pr-str r)))

  ;; ---- doctor render: the LOUD line for each state (the operator-facing truth) --------
  (let [render-env {"NORTH_DASHBOARD_LIB" "1" "NORTH_NO_COLOR" "1" "NORTH_HOME" root}
        render (fn []
                 (run-bb (str "(load-file " (pr-str dashboard) ") "
                              "(println (reactor-doctor-line PORT))")
                         :extra-env render-env))]
    ;; fresh -> [ok] last sweep
    (run-bb (lib-expr "(north.reactor-heartbeat/write-heartbeat! \"7977\")"))
    (let [r (render)]
      (check "doctor renders [ok] last sweep when fresh"
             (and (str/includes? (:out r) "[ok]") (str/includes? (:out r) "last sweep"))
             (pr-str r)))
    ;; stale -> loud [ERR] STALE
    (stamp-file! (iso-ago (* 20 60 1000)))
    (let [r (render)]
      (check "doctor renders loud [ERR] STALE when heartbeat is old"
             (and (str/includes? (:out r) "[ERR]") (str/includes? (:out r) "STALE"))
             (pr-str r)))
    ;; missing -> loud [ERR] MISSING (a stopped reactor cannot read healthy)
    (.delete hb-file)
    (let [r (render)]
      (check "doctor renders loud [ERR] MISSING when heartbeat is absent"
             (and (str/includes? (:out r) "[ERR]") (str/includes? (:out r) "MISSING"))
             (pr-str r))))

  (finally
    (doseq [f (reverse (file-seq home))] (io/delete-file f true))))

(let [results @checks pass (count (filter second results))]
  (doseq [[label ok detail] results]
    (println (format "  [%s] %s" (if ok "PASS" "FAIL") label))
    (when (and (not ok) detail) (println (str "        " detail))))
  (println (format "\nreactor heartbeat: %d / %d PASS" pass (count results)))
  (System/exit (if (= pass (count results)) 0 1)))
