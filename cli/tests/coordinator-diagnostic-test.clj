(require '[clojure.string :as str]
         '[north.main :as north])

(def failures (atom 0))
(defn check! [label passed?]
  (println (str (if passed? "PASS" "FAIL") " — " label))
  (when-not passed? (swap! failures inc)))

(def log "/tmp/north diagnostics corpus.log")
(def down (north/coordinator-failure-message -1 7977 log "capture was not recorded"))
(def mismatch (north/coordinator-failure-message -2 7977 log "still clocked in"))
(def incompatible (north/coordinator-failure-message -3 7977 log "schema seed was not recorded"))

(check! "unreachable coordinator keeps the ordinary startup remedy"
        (and (str/includes? down "UNREACHABLE")
             (str/includes? down "Run `north up`")
             (not (str/includes? down "CORPUS MISMATCH"))))
(check! "wrong corpus names the expected log and does not claim the daemon is down"
        (and (str/includes? mismatch "CORPUS MISMATCH")
             (str/includes? mismatch log)
             (str/includes? mismatch "still clocked in")
             (not (str/includes? mismatch "UNREACHABLE"))))
(check! "incompatible protocol has a matched-release remedy"
        (and (str/includes? incompatible "PROTOCOL INCOMPATIBLE")
             (str/includes? incompatible "matched release")
             (not= mismatch incompatible)))

(if (zero? @failures)
  (do (println "coordinator diagnostics: PASS") (System/exit 0))
  (do (println (str "coordinator diagnostics: " @failures " FAIL"))
      (System/exit 1)))
