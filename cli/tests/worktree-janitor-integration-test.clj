#!/usr/bin/env bb
;; Production worktree-janitor regression. A throwaway Git repository and a
;; separately fenced Fram coordinator exercise the real `north-reactor.clj
;; sweep-once` surface twice; no janitor function is called directly.
(require '[babashka.process :as proc]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram
  (.getCanonicalPath
   (io/file (or (System/getenv "FRAM_PATH") (str root "/../fram")))))
(def reactor (str root "/cli/north-reactor.clj"))
(load-file (str root "/cli/terminal-projection.clj"))

(def checks (atom []))
(def test-log (atom nil))
(defn check [label value & [detail]]
  (swap! checks conj [label (boolean value) detail]))

(defn free-port []
  (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))

(defn port-open? [port]
  (try
    (with-open [socket (java.net.Socket.)]
      (.connect socket (java.net.InetSocketAddress. "127.0.0.1" (int port)) 100)
      true)
    (catch Exception _ false)))

(defn await-up [port]
  (loop [attempt 0]
    (cond
      (port-open? port) true
      (>= attempt 100) false
      :else (do (Thread/sleep 50) (recur (inc attempt))))))

(defn coordinator-op [port request]
  (with-open [socket (java.net.Socket. "127.0.0.1" (int port))]
    (.setSoTimeout socket 5000)
    (let [writer (.getOutputStream socket)
          reader (io/reader (.getInputStream socket))]
      (.write writer
              (.getBytes
               (str (pr-str {:op :for-log
                             :expected-log @test-log
                             :request request})
                    "\n")))
      (.flush writer)
      (edn/read-string (.readLine reader)))))

(defn assert-fact! [port subject predicate value]
  (let [result (coordinator-op port {:op :assert :te subject :p predicate :r value})]
    (when-not (or (:ok result) (:version result))
      (throw (ex-info "fixture fact assertion failed" result)))))

(defn many [port subject predicate]
  (:values (coordinator-op port {:op :resolved :te subject :p predicate})))

(defn run-git [& args]
  (apply proc/shell {:out :string :err :string :continue true} "git" args))

(defn git! [& args]
  (let [result (apply run-git args)]
    (when-not (zero? (:exit result))
      (throw (ex-info "fixture git command failed"
                      {:args args :exit (:exit result) :err (:err result)})))
    (str/trim (str (:out result)))))

(defn branch-present? [repo branch]
  (zero? (:exit (run-git "-C" repo "show-ref" "--verify" "--quiet"
                         (str "refs/heads/" branch)))))

(defn sha256-file [^java.io.File file]
  (let [digest (java.security.MessageDigest/getInstance "SHA-256")]
    (.update digest (java.nio.file.Files/readAllBytes (.toPath file)))
    (format "%064x" (java.math.BigInteger. 1 (.digest digest)))))

(defn tree-snapshot [path]
  (let [root-file (io/file path)
        root-path (.toPath root-file)]
    (into (sorted-map)
          (for [^java.io.File file (file-seq root-file)
                :when (.isFile file)]
            [(str (.relativize root-path (.toPath file))) (sha256-file file)]))))

(defn create-worktree! [repo parent handle]
  (let [branch (str "lane-" handle)
        path (.getCanonicalPath (io/file parent (str handle " tree")))]
    (git! "-C" repo "worktree" "add" "-q" "-b" branch path "HEAD")
    {:handle handle :branch branch :path path :subject (str "@agent:" handle)}))

(defn register-lane! [port repo {:keys [subject branch path]} graph-branch]
  (doseq [[predicate value]
          [["kind" "lane"] ["repo" repo] ["worktree" path]
           ["branch" (or graph-branch branch)]]]
    (assert-fact! port subject predicate value)))

(defn commit-run! [port handle]
  (let [run (str "@run:" handle)]
    (assert-fact! port run "agent" handle)
    (assert-fact! port run "outcome" "ran")
    ;; Last-write commit marker: without this exact fact the run is invisible.
    (assert-fact! port run "kind" "run")))

(defn commit-modern-terminal! [port subject]
  (let [facts {"outcome" #{"ran"}
               "process_outcome" #{"ran"}
               "delivery_outcome" #{"unverified"}
               "delivery_reason" #{"fixture_terminal_without_delivery_proof"}}
        marker (north.terminal-projection/terminal-manifest-sha256 facts)]
    (doseq [[predicate values] facts
            value values]
      (assert-fact! port subject predicate value))
    ;; Digest is the lane terminal's last-write commit marker.
    (assert-fact! port subject "terminal_manifest_sha256" marker)))

(defn run-reactor [port environment]
  (proc/shell {:out :string :err :string :continue true
               :extra-env (merge environment
                                 {"FRAM_PORT" (str port)
                                  "FRAM_LOG" @test-log})}
              "bb" reactor "sweep-once"))

(let [port (free-port)
      tmp (.toFile
           (java.nio.file.Files/createTempDirectory
            "north worktree janitor "
            (make-array java.nio.file.attribute.FileAttribute 0)))
      home (doto (io/file tmp "home") .mkdirs)
      repo (.getCanonicalPath (io/file tmp "main repo"))
      worktrees (doto (io/file tmp "managed worktrees") .mkdirs)
      log (io/file tmp "facts.log")
      heartbeat (io/file tmp "reactor-heartbeat")
      agent-logs (doto (io/file tmp "agent logs") .mkdirs)
      git-log (io/file tmp "git-calls.log")
      git-wrapper (io/file tmp "git-wrapper")
      daemon-env {"FRAM_REQUIRE_LOG_FENCE" "1"
                  "FRAM_SINGLE_VALUED"
                  (str/join " " ["kind" "repo" "worktree" "branch" "agent"
                                     "outcome" "process_outcome" "delivery_outcome"
                                     "delivery_reason" "terminal_manifest_sha256" "run_at"])}
      daemon (do
               (spit log "")
               (proc/process {:dir fram :out :string :err :string
                              :extra-env daemon-env}
                             "bb" "-cp" "out" "coord_daemon.clj"
                             "serve-flat" (str port) (.getPath log)))]
  (reset! test-log (.getCanonicalPath log))
  (try
    (when-not (await-up port)
      (throw (ex-info "throwaway Fram coordinator did not start"
                      {:stdout (deref (:out daemon))
                       :stderr (deref (:err daemon))})))

    (git! "init" "-q" "-b" "main" repo)
    (git! "-C" repo "config" "user.email" "janitor@example.invalid")
    (git! "-C" repo "config" "user.name" "Janitor Test")
    (spit (io/file repo "tracked.txt") "canonical bytes\n")
    (git! "-C" repo "add" "tracked.txt")
    (git! "-C" repo "commit" "-qm" "fixture")

    (let [clean (create-worktree! repo worktrees "resolved-clean")
          dirty (create-worktree! repo worktrees "resolved-dirty")
          live (create-worktree! repo worktrees "live-clean")
          torn (create-worktree! repo worktrees "torn-terminal")
          hostile (create-worktree! repo worktrees "hostile-branch")
          status-fail (create-worktree! repo worktrees "status-failure")
          provenance-fail (create-worktree! repo worktrees "provenance-failure")
          lanes [clean dirty live torn hostile status-fail provenance-fail]]
      (doseq [lane lanes] (register-lane! port repo lane nil))
      ;; Graph data may never choose the branch passed to Git. Make one exact
      ;; registration hostile while its real worktree remains perfectly valid.
      (assert-fact! port (:subject hostile) "branch" "main")

      (commit-modern-terminal! port (:subject clean))
      (doseq [lane [dirty hostile status-fail provenance-fail]]
        (commit-run! port (:handle lane)))
      ;; Torn modern lane terminal + uncommitted run: neither is terminal proof.
      (assert-fact! port (:subject torn) "process_outcome" "ran")
      (assert-fact! port (:subject torn) "outcome" "ran")
      (let [run (str "@run:" (:handle torn))]
        (assert-fact! port run "agent" (:handle torn))
        (assert-fact! port run "outcome" "ran"))

      ;; Keep unrelated daily clock telemetry mechanically idle across both runs.
      (assert-fact! port "@clock-audit-fixture" "kind" "clock_audit_run")
      (assert-fact! port "@clock-audit-fixture" "run_at"
                    (str (java.time.Instant/now)))

      (let [dirty-file (io/file (:path dirty) "uncommitted sentinel.txt")]
        (spit dirty-file "dirty bytes must survive\n"))

      ;; Test-only Git transport: every non-fault command execs the system Git.
      ;; Two exact paths inject status/provenance uncertainty without corrupting
      ;; either repository, and every argv is recorded for the non-force audit.
      (spit git-wrapper
            (str "#!/usr/bin/env bash\n"
                 "set -euo pipefail\n"
                 "printf '%q ' \"$@\" >> \"${GIT_CALL_LOG:?}\"\n"
                 "printf '\\n' >> \"${GIT_CALL_LOG:?}\"\n"
                 "if [[ ${1:-} == -C && ${2:-} == \"${STATUS_FAIL_PATH:?}\" && ${3:-} == status ]]; then exit 91; fi\n"
                 "if [[ ${1:-} == -C && ${2:-} == \"${PROVENANCE_FAIL_PATH:?}\" && ${3:-} == rev-parse ]]; then exit 92; fi\n"
                 "exec \"${REAL_GIT:?}\" \"$@\"\n"))
      (.setExecutable git-wrapper true)
      (spit git-log "")

      (let [watched [live torn hostile status-fail provenance-fail]
            before (into {} (map (juxt :handle #(tree-snapshot (:path %))) watched))
            dirty-before (tree-snapshot (:path dirty))
            environment {"HOME" (.getCanonicalPath home)
                         "NORTH_REACTOR_HEARTBEAT" (.getCanonicalPath heartbeat)
                         "NORTH_AGENT_LOGS_DIR" (.getCanonicalPath agent-logs)
                         "NORTH_GIT_BIN" (.getCanonicalPath git-wrapper)
                         "REAL_GIT" (str/trim (:out (proc/shell {:out :string} "which" "git")))
                         "GIT_CALL_LOG" (.getCanonicalPath git-log)
                         "STATUS_FAIL_PATH" (:path status-fail)
                         "PROVENANCE_FAIL_PATH" (:path provenance-fail)}
            first-run (run-reactor port environment)
            after-first-log (slurp log)
            orphan-values (many port (:subject dirty) "worktree_orphaned")]
        (check "production sweep-once exits zero"
               (zero? (:exit first-run)) (str (:out first-run) (:err first-run)))
        (check "reactor summary exposes janitor result"
               (and (str/includes? (:out first-run) "worktrees removed=1")
                    (str/includes? (:out first-run) "dirty-kept=1")
                    (str/includes? (:out first-run) "orphan-facts=1"))
               (:out first-run))
        (check "resolved-clean expected worktree disappears"
               (not (.exists (io/file (:path clean)))))
        (check "resolved-clean expected branch disappears"
               (not (branch-present? repo (:branch clean))))
        (check "every non-removable worktree remains present"
               (every? #(.isDirectory (io/file (:path %)))
                       [dirty live torn hostile status-fail provenance-fail]))
        (check "every non-removable branch remains present"
               (every? #(branch-present? repo (:branch %))
                       [dirty live torn hostile status-fail provenance-fail]))
        (check "dirty worktree bytes survive exactly"
               (= dirty-before (tree-snapshot (:path dirty))))
        (doseq [lane watched]
          (check (str (:handle lane) " remains byte-identical")
                 (= (get before (:handle lane)) (tree-snapshot (:path lane)))))
        (check "dirty resolved lane gets exactly one deterministic orphan fact"
               (and (= 1 (count orphan-values))
                    (str/includes? (first orphan-values)
                                   "resolved lane retains uncommitted changes"))
               (pr-str orphan-values))
        (let [calls (slurp git-log)]
          (check "janitor issued no force deletion"
                 (not (str/includes? calls "--force")) calls)
          (check "janitor used non-force worktree remove and branch -d"
                 (and (str/includes? calls "worktree remove --")
                      (str/includes? calls "branch -d --")) calls)
          (check "hostile graph branch never reaches a Git delete argv"
                 (not (str/includes? calls "branch -d -- main")) calls))

        ;; A second production pass is the idempotency bar: no tree/branch is
        ;; removed, the dirty fact is not rewritten, and the coordinator log is
        ;; byte-identical to the post-first-pass log.
        (let [second-run (run-reactor port environment)
              after-second-log (slurp log)
              orphan-values-2 (many port (:subject dirty) "worktree_orphaned")]
          (check "repeat sweep-once exits zero" (zero? (:exit second-run))
                 (str (:out second-run) (:err second-run)))
          (check "repeat removes zero worktrees and writes zero orphan facts"
                 (and (str/includes? (:out second-run) "worktrees removed=0")
                      (str/includes? (:out second-run) "orphan-facts=0"))
                 (:out second-run))
          (check "repeat performs zero coordinator writes"
                 (= after-first-log after-second-log))
          (check "repeat leaves exactly the same single orphan fact"
                 (= orphan-values orphan-values-2))
          (check "heartbeat carries the latest worktree-janitor result"
                 (and (.isFile heartbeat)
                      (str/includes? (slurp heartbeat) ":worktrees")
                      (str/includes? (slurp heartbeat) ":removed 0"))
                 (when (.isFile heartbeat) (slurp heartbeat))))))

    (finally
      (try (proc/destroy-tree daemon) (catch Throwable _ nil))
      (doseq [file (reverse (file-seq tmp))]
        (try (io/delete-file file true) (catch Throwable _ nil)))))

  (let [results @checks pass (count (filter second results))]
    (doseq [[label ok detail] results]
      (println (format "  [%s] %s" (if ok "PASS" "FAIL") label))
      (when (and (not ok) detail) (println (str "        " detail))))
    (println (format "\nworktree janitor integration: %d / %d PASS"
                     pass (count results)))
    (System/exit (if (= pass (count results)) 0 1))))
