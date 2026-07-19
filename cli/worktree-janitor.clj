;; Reactor-owned cleanup for terminal managed-lane worktrees.
;;
;; This file is a library, not a command. Loading it only defines functions: the
;; production surface is `north-reactor.clj sweep-once`, and the long-running
;; reactor calls the exact same `sweep-worktrees!` function on its normal sweep.
(ns north.worktree-janitor
  (:require [babashka.process :as proc]
            [clojure.java.io :as io]
            [clojure.string :as str]))

(def ^:private max-agent-id-chars 512)
(def ^:private max-path-chars 4096)

(defn- query-rows! [port query]
  (let [response (north.coord/send-op port {:op :query :query query})]
    (if (and (map? response) (contains? response :ok))
      (:ok response)
      (throw (ex-info "worktree janitor coordinator query failed"
                      {:type :worktree-janitor-query-failed
                       :response response})))))

(defn- q-col [port body]
  (->> (query-rows!
        port
        {:find "e"
         :rules [{:head {:rel "e" :args [{:var "e"}]}
                  :body body}]})
       (map first)))

(defn- subject-facts [port subject]
  (let [rows (query-rows!
              port
              {:find "worktree_fact"
               :rules [{:head {:rel "worktree_fact"
                               :args [{:var "p"} {:var "r"}]}
                        :body [{:rel "triple"
                                :args [subject {:var "p"} {:var "r"}]}]}]})]
    (reduce (fn [facts [predicate value]]
              (update facts predicate (fnil conj #{}) value))
            {}
            rows)))

(defn- singleton [facts predicate]
  (let [values (get facts predicate)]
    (when (= 1 (count values)) (first values))))

(defn- safe-string? [value max-chars]
  (and (string? value)
       (not (str/blank? value))
       (<= (count value) max-chars)
       (not (re-find #"[\u0000\r\n]" value))))

(defn- agent-handle [subject]
  (when (and (safe-string? subject (+ max-agent-id-chars 7))
             (str/starts-with? subject "@agent:"))
    (let [handle (subs subject 7)]
      (when (safe-string? handle max-agent-id-chars) handle))))

(defn- expand-home [path]
  (if (str/starts-with? path "~/")
    (when-let [home (System/getenv "HOME")]
      (str (str/replace home #"/+$" "") (subs path 1)))
    path))

(defn- registered-path [value]
  (when (safe-string? value max-path-chars)
    (when-let [expanded (expand-home value)]
      (let [file (io/file expanded)]
        (when (.isAbsolute file) (.getCanonicalPath file))))))

(defn- git-bin [] (or (System/getenv "NORTH_GIT_BIN") "git"))

(defn- git [& args]
  (apply proc/shell
         {:out :string :err :string :continue true}
         (git-bin) args))

(defn- canonical-git-path [result]
  (when (zero? (:exit result))
    (let [raw (str/trim (str (:out result)))]
      (when (safe-string? raw max-path-chars)
        (.getCanonicalPath (io/file raw))))))

(defn- branch-ref [branch] (str "refs/heads/" branch))

(defn- worktree-registered? [root worktree]
  (let [result (git "-C" root "worktree" "list" "--porcelain" "-z")]
    (when (zero? (:exit result))
      (boolean
       (some #(= (str "worktree " worktree) %)
             (str/split (str (:out result)) #"\u0000" -1))))))

(defn- branch-present? [root branch]
  (let [result (git "-C" root "show-ref" "--verify" "--quiet"
                    (branch-ref branch))]
    (cond
      (zero? (:exit result)) true
      (= 1 (:exit result)) false
      :else nil)))

(defn- validate-provenance
  "Validate every destructive-action input against Git itself. Graph values are
   only registrations; they never grant deletion authority."
  [handle facts]
  (try
    (let [expected-branch (str "lane-" handle)
          graph-kind (singleton facts "kind")
          graph-branch (singleton facts "branch")
          root (registered-path (singleton facts "repo"))
          worktree (registered-path (singleton facts "worktree"))]
      (cond
        (not= "lane" graph-kind)
        {:ok? false :reason "subject is not one exact kind=lane entity"}

        (not= expected-branch graph-branch)
        {:ok? false :reason "registered branch is absent, conflicted, or not the derived lane branch"}

        (or (nil? root) (nil? worktree) (= root worktree))
        {:ok? false :reason "registered main root/worktree paths are absent, conflicted, relative, or identical"}

        (not (.isDirectory (io/file root)))
        {:ok? false :reason "registered main root is not a directory"}

        (not (.isDirectory (io/file worktree)))
        {:ok? false :reason "registered worktree is not a directory"}

        :else
        (let [ref-check (git "check-ref-format" "--branch" expected-branch)
              root-top (canonical-git-path
                        (git "-C" root "rev-parse" "--show-toplevel"))
              wt-top (canonical-git-path
                      (git "-C" worktree "rev-parse" "--show-toplevel"))
              root-common (canonical-git-path
                           (git "-C" root "rev-parse"
                                "--path-format=absolute" "--git-common-dir"))
              wt-common (canonical-git-path
                         (git "-C" worktree "rev-parse"
                              "--path-format=absolute" "--git-common-dir"))
              root-dot-git (.getCanonicalPath (io/file root ".git"))
              wt-git-dir (canonical-git-path
                          (git "-C" worktree "rev-parse" "--absolute-git-dir"))
              actual-branch-result
              (git "-C" worktree "symbolic-ref" "--quiet" "--short" "HEAD")
              actual-branch (when (zero? (:exit actual-branch-result))
                              (str/trim (str (:out actual-branch-result))))
              root-head-result (git "-C" root "rev-parse" "HEAD")
              branch-head-result (git "-C" root "rev-parse" (branch-ref expected-branch))
              wt-head-result (git "-C" worktree "rev-parse" "HEAD")
              root-head (when (zero? (:exit root-head-result))
                          (str/trim (str (:out root-head-result))))
              branch-head (when (zero? (:exit branch-head-result))
                            (str/trim (str (:out branch-head-result))))
              wt-head (when (zero? (:exit wt-head-result))
                        (str/trim (str (:out wt-head-result))))
              registered? (worktree-registered? root worktree)
              branch-present (branch-present? root expected-branch)
              linked-git-prefix (when root-common
                                  (str root-common java.io.File/separator "worktrees"
                                       java.io.File/separator))]
          (if (and (zero? (:exit ref-check))
                   (= root root-top)
                   (= worktree wt-top)
                   (= root-common wt-common root-dot-git)
                   (.isDirectory (io/file root-dot-git))
                   (string? wt-git-dir)
                   (str/starts-with? wt-git-dir linked-git-prefix)
                   (= expected-branch actual-branch)
                   (= true branch-present)
                   (= true registered?)
                   (safe-string? root-head 128)
                   (= branch-head wt-head))
            {:ok? true :root root :worktree worktree :branch expected-branch}
            {:ok? false :reason "real Git provenance does not exactly match the registered main root/worktree/derived branch"}))))
    (catch Throwable error
      {:ok? false
       :reason (str "Git provenance probe failed: "
                    (or (.getMessage error) (.getName (class error))))})))

(defn- worktree-status [worktree]
  (let [result (git "-C" worktree "status" "--porcelain=v1" "-z"
                    "--untracked-files=all")]
    (cond
      (not (zero? (:exit result))) {:kind :uncertain :reason "git status failed"}
      (empty? (str (:out result))) {:kind :clean}
      :else {:kind :dirty})))

(defn- orphan-fact [worktree branch]
  (str worktree " | branch=" branch
       " | resolved lane retains uncommitted changes; manual salvage required"))

(defn- ensure-orphan-fact! [port subject value]
  (if (contains? (set (north.coord/many port subject "worktree_orphaned")) value)
    false
    (do
      (north.coord/append! port subject "worktree_orphaned" value)
      (when-not (contains? (set (north.coord/many port subject "worktree_orphaned")) value)
        (throw (ex-info "worktree orphan fact was not visible after append"
                        {:subject subject})))
      true)))

(defn- remove-clean-worktree! [{:keys [root worktree branch]}]
  ;; Preflight the exact condition `git branch -d` enforces. This makes a partial
  ;; tree-only removal vanishingly narrow while preserving Git's own non-force
  ;; delete as the final authority.
  (let [merged (git "-C" root "merge-base" "--is-ancestor"
                    (branch-ref branch) "HEAD")]
    (if-not (zero? (:exit merged))
      {:kind :uncertain :reason "lane branch is not proven merged into the registered main checkout HEAD"}
      (let [removed (git "-C" root "worktree" "remove" "--" worktree)]
        (if-not (zero? (:exit removed))
          {:kind :uncertain :reason "non-force git worktree remove refused"}
          (let [path-gone? (not (.exists (io/file worktree)))
                registered? (worktree-registered? root worktree)]
            (if-not (and path-gone? (= false registered?))
              {:kind :uncertain :reason "worktree removal postcondition was not proven"}
              (let [deleted (git "-C" root "branch" "-d" "--" branch)
                    branch-present (branch-present? root branch)]
                (if (and (zero? (:exit deleted)) (= false branch-present))
                  {:kind :removed}
                  {:kind :uncertain :reason "non-force branch delete or its postcondition failed"})))))))))

(defn- zero-result []
  {:scanned 0
   :unresolved 0
   :dirty 0
   :uncertain 0
   :removed 0
   :would-remove 0
   :orphan-facts-written 0
   :errors 0})

(defn- bump [result key] (update result key (fnil inc 0)))

(defn- lane-resolution [lane-resolved? handle]
  (try
    {:known? true :resolved? (boolean (lane-resolved? handle))}
    (catch Throwable error
      {:known? false
       :reason (str "canonical lane-resolution probe failed: "
                    (or (.getMessage error) (.getName (class error))))})))

(defn- sweep-subject!
  [port dry? lane-resolved? repo-filter subject]
  (let [handle (agent-handle subject)
        facts (subject-facts port subject)
        graph-repo (singleton facts "repo")
        resolution (when handle (lane-resolution lane-resolved? handle))]
    (cond
      (and repo-filter (not= repo-filter graph-repo))
      {:kind :skipped}

      (nil? handle)
      (do
        (println (str "[worktrees] KEEP " subject
                      " — invalid managed-lane subject"))
        {:kind :uncertain})

      (not (:known? resolution))
      (do
        (println (str "[worktrees] KEEP " subject " — " (:reason resolution)))
        {:kind :uncertain})

      (not (:resolved? resolution))
      {:kind :unresolved}

      :else
      (let [provenance (validate-provenance handle facts)]
        (if-not (:ok? provenance)
          (do
            (println (str "[worktrees] KEEP " subject " — " (:reason provenance)))
            {:kind :uncertain})
          (let [status (worktree-status (:worktree provenance))]
            (case (:kind status)
              :uncertain
              (do
                (println (str "[worktrees] KEEP " subject " — " (:reason status)))
                {:kind :uncertain})

              :dirty
              (let [value (orphan-fact (:worktree provenance) (:branch provenance))
                    wrote? (and (not dry?)
                                (ensure-orphan-fact! port subject value))]
                (println (str "[worktrees] " (if dry? "WOULD KEEP" "KEPT")
                              " dirty " (:worktree provenance)))
                {:kind :dirty :orphan-written? wrote?})

              :clean
              (if dry?
                (do
                  (println (str "[worktrees] WOULD REMOVE clean "
                                (:worktree provenance)))
                  {:kind :would-remove})
                (let [removed (remove-clean-worktree! provenance)]
                  (if (= :removed (:kind removed))
                    (do
                      (println (str "[worktrees] removed clean "
                                    (:worktree provenance) " and "
                                    (:branch provenance)))
                      {:kind :removed})
                    (do
                      (println (str "[worktrees] KEEP/REVIEW " subject
                                    " — " (:reason removed)))
                      {:kind :uncertain})))))))))))

(defn sweep-worktrees!
  "Inspect registered lane worktrees and reclaim only a canonically terminal,
   provenance-valid, status-clean tree on its derived branch. `lane-resolved?`
   is the reactor's canonical full lane-terminal/committed-run join."
  [{:keys [port dry? lane-resolved? repo-filter]}]
  (when-not (fn? lane-resolved?)
    (throw (ex-info "worktree janitor requires the reactor's canonical lane resolver" {})))
  (let [subjects (sort
                  (distinct
                   (q-col port [{:rel "triple"
                                 :args [{:var "e"} "worktree" {:var "_w"}]}])))]
    (reduce
     (fn [result subject]
       (let [action (sweep-subject!
                     port dry? lane-resolved? repo-filter subject)
             result (bump result :scanned)
             result (if (= :skipped (:kind action))
                      result
                      (bump result (:kind action)))]
         (cond-> result
           (:orphan-written? action) (bump :orphan-facts-written))))
     (zero-result)
     subjects)))
