#!/usr/bin/env bb
;; ============================================================================
;; clock-audit-test.clj — hermetic coverage-matching test for bin/north-clock-audit.
;;
;; Builds a throwaway git repo under a path shaped like a billable client repo
;; (…/code/client/fakeclient/repo), forges three commits at fixed author dates,
;; and points the audit at a fixture FRAM_LOG with matching session facts. Asserts
;; the coverage rule end-to-end:
;;   - a commit INSIDE a fakeclient session window        -> covered
;;   - a commit within the ±15min GRACE of a session end  -> covered
;;   - a commit OUTSIDE every fakeclient session          -> uncovered
;;   - a same-time session owned by ANOTHER client        -> never covers it
;;   - any uncovered commit                               -> exit 1
;; then a fully-covered fixture -> exit 0.
;;
;; CONFIDENTIALITY: uses only the FAKE client name "fakeclient" — no real client
;; name or path appears. The scratch path lives under java.io.tmpdir; the inner
;; git runs in a subprocess, so the PreToolUse clock-guard never sees it.
;;   bb cli/tests/clock-audit-test.clj
;; ============================================================================
(require '[babashka.process :as p]
         '[babashka.fs :as fs]
         '[clojure.string :as str])

(def north (str (fs/parent (fs/parent (fs/parent (fs/absolutize *file*))))))
(def audit (str north "/bin/north-clock-audit"))
(def root  (str (System/getProperty "java.io.tmpdir") "/clockaudit-test-" (System/nanoTime)))
(def repo  (str root "/code/client/fakeclient/repo"))

(def fails (atom 0))
(defn check [label ok?]
  (println (format "  %s %s" (if ok? "✓" "✗ FAIL —") label))
  (when-not ok? (swap! fails inc)))

;; ---- build the throwaway client repo + three dated commits -----------------
(fs/create-dirs repo)
(defn git [env & args]
  (apply p/shell {:dir repo :out :string :err :string
                  :extra-env (merge {"GIT_CONFIG_GLOBAL" "/dev/null" "GIT_CONFIG_SYSTEM" "/dev/null"} env)}
         "git" args))
(git {} "init" "-q" "-b" "main")
(git {} "config" "user.email" "t@example.invalid")
(git {} "config" "user.name" "Fixture")
(defn commit [msg date]
  (git {"GIT_AUTHOR_DATE" date "GIT_COMMITTER_DATE" date}
       "commit" "--allow-empty" "-q" "-m" msg))

;; fakeclient session S1 covers 10:00–11:00; other-client S2 covers 13:45–14:15.
(commit "inside"  "2026-06-10T10:30:00")   ; inside S1               -> covered
(commit "grace"   "2026-06-10T11:10:00")   ; 10m after S1 end (<15m) -> covered
(commit "outside" "2026-06-10T14:00:00")   ; only S2(other) covers   -> UNCOVERED

;; sha lookup by subject
(def shas
  (->> (:out (git {} "log" "--all" "--pretty=format:%h%x1f%s"))
       str/split-lines
       (map #(str/split % #"\x1f" 2))
       (map (fn [[h s]] [s (subs h 0 7)]))
       (into {})))

(defn fixture [extra]
  (let [base ["{:tx 1, :op \"assert\", :l \"@T1\", :p \"title\", :r \"fake one\", :ts \"2026-06-10T00:00:00Z\"}"
              "{:tx 2, :op \"assert\", :l \"@T1\", :p \"owner\", :r \"fakeclient\", :ts \"2026-06-10T00:00:00Z\"}"
              "{:tx 3, :op \"assert\", :l \"@T2\", :p \"title\", :r \"fake two\", :ts \"2026-06-10T00:00:00Z\"}"
              "{:tx 4, :op \"assert\", :l \"@T2\", :p \"owner\", :r \"other\", :ts \"2026-06-10T00:00:00Z\"}"
              ;; S1 — fakeclient, 10:00-11:00
              "{:tx 5, :op \"assert\", :l \"@S1\", :p \"session_of\", :r \"@T1\", :ts \"2026-06-10T00:00:00Z\"}"
              "{:tx 6, :op \"assert\", :l \"@S1\", :p \"start_time\", :r \"2026-06-10T10:00:00\", :ts \"2026-06-10T00:00:00Z\"}"
              "{:tx 7, :op \"assert\", :l \"@S1\", :p \"end_time\", :r \"2026-06-10T11:00:00\", :ts \"2026-06-10T00:00:00Z\"}"
              ;; S2 — OTHER client, 13:45-14:15 (covers 'outside' in time, wrong owner)
              "{:tx 8, :op \"assert\", :l \"@S2\", :p \"session_of\", :r \"@T2\", :ts \"2026-06-10T00:00:00Z\"}"
              "{:tx 9, :op \"assert\", :l \"@S2\", :p \"start_time\", :r \"2026-06-10T13:45:00\", :ts \"2026-06-10T00:00:00Z\"}"
              "{:tx 10, :op \"assert\", :l \"@S2\", :p \"end_time\", :r \"2026-06-10T14:15:00\", :ts \"2026-06-10T00:00:00Z\"}"]]
    (str/join "\n" (concat base extra))))

(def log1 (str root "/fixture1.log"))
(def log2 (str root "/fixture2.log"))
(spit log1 (fixture []))
;; fixture2 adds S3 — a fakeclient session covering the 'outside' commit -> full coverage
(spit log2 (fixture ["{:tx 11, :op \"assert\", :l \"@S3\", :p \"session_of\", :r \"@T1\", :ts \"2026-06-10T00:00:00Z\"}"
                      "{:tx 12, :op \"assert\", :l \"@S3\", :p \"start_time\", :r \"2026-06-10T13:50:00\", :ts \"2026-06-10T00:00:00Z\"}"
                      "{:tx 13, :op \"assert\", :l \"@S3\", :p \"end_time\", :r \"2026-06-10T14:10:00\", :ts \"2026-06-10T00:00:00Z\"}"]))

(defn run [log]
  (let [r (p/shell {:out :string :err :string :continue true
                    :extra-env {"FRAM_LOG" log}}
                   audit "--repo" repo "--since" "2026-06-10" "--until" "2026-06-10")]
    {:out (:out r) :exit (:exit r)}))

;; ---- assertions ------------------------------------------------------------
(println "clock-audit hermetic test")
(let [{:keys [out exit]} (run log1)]
  (check "exit 1 when an uncovered commit exists" (= 1 exit))
  (check "'outside' commit listed as uncovered"    (str/includes? out (shas "outside")))
  (check "'inside' commit NOT listed (covered)"    (not (str/includes? out (shas "inside"))))
  (check "'grace' commit NOT listed (covered)"     (not (str/includes? out (shas "grace"))))
  (check "reports 2 covered"                       (str/includes? out "covered  2"))
  (check "reports 1 uncovered"                     (str/includes? out "uncovered  1"))
  (when (pos? @fails) (println "--- run1 output ---") (println out)))

(let [{:keys [out exit]} (run log2)]
  (check "exit 0 when all commits covered"         (= 0 exit))
  (check "reports 0 uncovered"                     (str/includes? out "uncovered  0"))
  (when (pos? @fails) (println "--- run2 output ---") (println out)))

;; cleanup
(fs/delete-tree root)

(if (pos? @fails)
  (do (println (format "\nFAILED — %d check(s)" @fails)) (System/exit 1))
  (do (println "\nPASS — coverage matching sound (inside+grace covered, outside+other-owner uncovered)") (System/exit 0)))
