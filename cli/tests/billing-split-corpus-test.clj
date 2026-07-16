#!/usr/bin/env bb
;; End-to-end billing readers over North's canonical coordination/telemetry pair.
(require '[babashka.process :as p]
         '[babashka.fs :as fs]
         '[clojure.string :as str])

(def north (str (fs/parent (fs/parent (fs/parent (fs/absolutize *file*))))))
(def root (str (System/getProperty "java.io.tmpdir") "/north-billing-split-" (System/nanoTime)))
(def coordination (str root "/coordination.log"))
(def telemetry (str root "/telemetry.log"))
(def timelog (str north "/bin/north-timelog"))
(def invoice (str north "/bin/north-invoice"))
(def fails (atom 0))

(defn check [label ok?]
  (println (format "  %s %s" (if ok? "✓" "✗ FAIL —") label))
  (when-not ok? (swap! fails inc)))

(defn line [tx l pred r]
  (pr-str {:tx tx :op "assert" :l l :p pred :r r :frame "fixture"}))

(fs/create-dirs root)
(spit coordination
      (str/join "\n" [(line 1 "@work" "title" "Split corpus work")
                       (line 2 "@work" "owner" "fakeclient")
                       (line 3 "@work" "linear" "FAKE-7")
                       (line 4 "@work" "rate" "120")]))
(spit telemetry
      (str/join "\n" [(line 5 "@session" "session_of" "@work")
                       (line 6 "@session" "start_time" "2026-07-10T10:00:00Z")
                       (line 7 "@session" "end_time" "2026-07-10T11:30:00Z")]))

(defn run [bin & args]
  (apply p/shell {:out :string :err :string :continue true
                  :extra-env {"FRAM_LOG" coordination}}
         bin args))

(println "billing split-corpus test")
(let [r (run timelog "fakeclient")]
  (check "timelog exits successfully" (zero? (:exit r)))
  (check "timelog joins session to thread" (str/includes? (:out r) "FAKE-7"))
  (check "timelog totals 1.50 hours" (str/includes? (:err r) "1.50h"))
  (check "timelog computes amount from coordination rate" (str/includes? (:out r) "180.00")))

(let [r (run invoice "unbilled" "fakeclient")]
  (check "invoice selection exits successfully" (zero? (:exit r)))
  (check "invoice selects canonical coordination thread" (str/includes? (:out r) "FAKE-7  Split corpus work")))

;; A differently named explicit corpus must not infer a neighboring telemetry.log.
(let [isolated (str root "/unrelated.log")]
  (fs/copy coordination isolated)
  (let [r (p/shell {:out :string :err :string :continue true
                    :extra-env {"FRAM_LOG" isolated}}
                   timelog "fakeclient")]
    (check "unrelated explicit corpus remains isolated" (not (str/includes? (:out r) "FAKE-7")))))

(fs/delete-tree root)
(if (pos? @fails)
  (do (println (format "\nFAILED — %d check(s)" @fails)) (System/exit 1))
  (do (println "\nPASS — billing readers join only the configured canonical split corpus")
      (System/exit 0)))
