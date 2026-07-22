#!/usr/bin/env bb
;; Disposable owner proof for immutable dual-log snapshots and restore plans.
(require '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str]
         '[fram.fold :as fold]
         '[fram.rt :as rt])

(def root (.getCanonicalPath (io/file (.getParent (io/file *file*)) "../..")))
(load-file (str root "/cli/corpus-transaction.clj"))
(load-file (str root "/cli/snapshot.clj"))
(require '[north.corpus-transaction :as ct]
         '[north.snapshot :as snapshot])

(def failures (atom []))
(defn check! [label predicate]
  (if predicate
    (println (str "  ✓ " label))
    (do (println (str "  ✗ " label)) (swap! failures conj label))))

(defn capture [f]
  (try {:value (f)} (catch Throwable error {:error error})))
(defn throws? [f] (some? (:error (capture f))))

(defn delete-tree! [path]
  (let [root-file (io/file path)]
    (when (.exists root-file)
      (doseq [file (reverse (file-seq root-file))]
        (java.nio.file.Files/deleteIfExists (.toPath ^java.io.File file))))))

(defn op [tx operation subject predicate value]
  {:tx tx :op operation :l subject :p predicate :r value :frame "snapshot-test"})

(defn write-ops! [path ops]
  (spit path (apply str (map #(str (pr-str %) "\n") ops))))

(defn append-op! [path operation]
  (with-open [output (java.io.FileOutputStream. (str path) true)]
    (.write output (.getBytes (str (pr-str operation) "\n")
                              java.nio.charset.StandardCharsets/UTF_8))
    (.flush output)
    (.force (.getChannel output) true)))

(defn raw-records [path]
  (with-open [reader (io/reader path)]
    (->> (line-seq reader)
         (remove str/blank?)
         (mapv edn/read-string))))

(defn permissions [path]
  (->> (java.nio.file.Files/getPosixFilePermissions
        (.toPath (io/file path)) (make-array java.nio.file.LinkOption 0))
       (map str) set))

(defn set-permissions! [path values]
  (java.nio.file.Files/setPosixFilePermissions
   (.toPath (io/file path))
   (java.util.HashSet.
    ^java.util.Collection
    (mapv java.nio.file.attribute.PosixFilePermission/valueOf values))))

(defn children [path]
  (vec (or (.listFiles (io/file path)) (make-array java.io.File 0))))

(defn matching-child-names [path pattern]
  (->> (children path)
       (map #(.getName ^java.io.File %))
       (filter #(re-matches pattern %))
       sort
       vec))

(defn create-owned-orphan-stage! [parent kind]
  (.mkdirs (io/file parent))
  (let [stage-id (str (java.util.UUID/randomUUID))
        stage (str parent "/." kind "-stage-v1." stage-id ".tmp")
        marker {:format snapshot/owned-stage-format :kind kind
                :owner "north snapshot" :stage-id stage-id}]
    (.mkdir (io/file stage))
    (set-permissions! stage ["OWNER_READ" "OWNER_WRITE" "OWNER_EXECUTE"])
    (spit (str stage "/.north-stage.edn")
          (String. ^bytes (snapshot/canonical-edn-bytes marker)
                   java.nio.charset.StandardCharsets/UTF_8))
    (set-permissions! (str stage "/.north-stage.edn")
                      ["OWNER_READ" "OWNER_WRITE"])
    (spit (str stage "/partial") "interrupted before publish")
    stage))

(def runtime-a {:source "test-fram" :revision "runtime-a" :tree "tree-a"})
(def controller-a {:kind "test" :launcher "controller-a"})
(def provenance {:actor "snapshot-test" :host "fixture" :tool "owner-test"})

(defn fixture [options f]
  (let [directory (.getCanonicalPath
                   (.toFile
                    (java.nio.file.Files/createTempDirectory
                     "north-snapshot-test-"
                     (make-array java.nio.file.attribute.FileAttribute 0))))
        live (str directory "/live")
        coordination (str live "/coordination.log")
        telemetry (str live "/telemetry.log")
        store (str directory "/snapshots")
        transaction-state (str directory "/transactions")]
    (.mkdirs (io/file live))
    (write-ops! coordination
                (or (:coordination options)
                    [(op 1 "assert" "@thread" "title" "captured")
                     (op 2 "assert" "@title" "cardinality" "single")]))
    (write-ops! telemetry
                (or (:telemetry options)
                    [(op 3 "assert" "@run" "kind" "run")]))
    (set-permissions! coordination ["OWNER_READ" "OWNER_WRITE"])
    (set-permissions! telemetry
                      ["OWNER_READ" "OWNER_WRITE" "GROUP_READ" "GROUP_WRITE"])
    (try
      (with-redefs [ct/state-root (constantly transaction-state)]
        (f {:directory directory
            :coordination coordination :telemetry telemetry :store store
            :base {:store store
                   :live {:coordination coordination :telemetry telemetry}
                   :runtime! (constantly runtime-a)
                   :controller! (constantly controller-a)
                   :provenance provenance}}))
      (finally (delete-tree! directory)))))

;; The concurrency proof must cross a process boundary. Java correctly rejects
;; overlapping locks held by two threads in one JVM instead of blocking them,
;; whereas Fram appenders and snapshot CLI invocations are separate processes.
(when (= "--writer" (first *command-line-args*))
  (let [[_ coordination telemetry ready release] *command-line-args*
        lock (rt/acquire-rewrite-lock! coordination true true)]
    (try
      (append-op! coordination
                  (op 50 "assert" "@concurrent" "side" "coord"))
      (spit ready "ready\n")
      (loop [remaining 500]
        (cond
          (.exists (io/file release)) nil
          (zero? remaining) (throw (ex-info "writer release timed out" {}))
          :else (do (Thread/sleep 10) (recur (dec remaining)))))
      (append-op! telemetry
                  (op 50 "assert" "@concurrent" "side" "telemetry"))
      (finally (rt/close-rewrite-lock! lock)))
    (System/exit 0)))

(println "## consistent dual-log capture behind the shared Fram fence")
(fixture
 {}
 (fn [{:keys [directory coordination telemetry base]}]
   (let [ready (str directory "/writer.ready")
         release (str directory "/writer.release")
         output (str directory "/writer.out")
         fram-out (or (System/getenv "FRAM_OUT") (str root "/../fram/out"))
         process (-> (ProcessBuilder.
                      ^java.util.List
                      ["bb" "-cp" fram-out *file* "--writer"
                       coordination telemetry ready release])
                     (.redirectErrorStream true)
                     (.redirectOutput (io/file output))
                     .start)]
     (try
       (loop [remaining 500]
         (cond
           (.exists (io/file ready)) nil
           (not (.isAlive process))
           (throw (ex-info (str "writer exited early: " (slurp output)) {}))
           (zero? remaining) (throw (ex-info "writer readiness timed out" {}))
           :else (do (Thread/sleep 10) (recur (dec remaining)))))
       (let [capture-future
             (future (snapshot/create-snapshot! (assoc base :execute? true)))
             blocked (deref capture-future 100 :still-blocked)]
         (check! "snapshot waits for an in-flight admissible writer"
                 (= :still-blocked blocked))
         (spit release "release\n")
         (when-not (.waitFor process 5 java.util.concurrent.TimeUnit/SECONDS)
           (.destroyForcibly process)
           (throw (ex-info "writer process did not stop" {})))
         (when-not (zero? (.exitValue process))
           (throw (ex-info (str "writer failed: " (slurp output)) {})))
         (let [created @capture-future
           verified (snapshot/verify-snapshot!
                     (assoc base :selector (:snapshot-id created)))
           coord-copy (slurp (get-in verified [:records :coordination :path]))
           telem-copy (slurp (get-in verified [:records :telemetry :path]))]
       (check! "capture contains the complete coordination side"
               (str/includes? coord-copy "@concurrent"))
       (check! "capture contains the matching telemetry side"
               (str/includes? telem-copy "@concurrent"))
       (check! "both captured log maxima are the same committed tx"
               (= #{50} (set (map #(get-in verified [:records % :max-tx])
                                  ct/roles))))))
       (finally
         (when (.isAlive process)
           (spit release "release\n")
           (.destroyForcibly process)))))))

(println "## zero-byte telemetry, modes, and repeat idempotence")
(fixture
 {:telemetry []}
 (fn [{:keys [coordination telemetry base store]}]
   (let [first-create (snapshot/create-snapshot! (assoc base :execute? true))
         second-create (snapshot/create-snapshot! (assoc base :execute? true))
         verified (snapshot/verify-snapshot!
                   (assoc base :selector (:snapshot-id first-create)))
         object-directories
         (filter #(.isDirectory ^java.io.File %)
                 (or (seq (.listFiles (io/file store))) []))]
     (check! "zero-byte telemetry is captured explicitly"
             (and (zero? (get-in verified [:records :telemetry :bytes]))
                  (= "zero-byte" (get-in verified [:manifest :files :telemetry :ending]))))
     (check! "coordination mode is preserved"
             (= (permissions coordination)
                (permissions (get-in verified [:records :coordination :path]))))
     (check! "telemetry mode is preserved"
             (= (permissions telemetry)
                (permissions (get-in verified [:records :telemetry :path]))))
     (check! "same source and provenance produce the same snapshot id"
             (= (:snapshot-id first-create) (:snapshot-id second-create)))
     (check! "repeated create reuses rather than overwrites the object"
             (and (:idempotent second-create) (= 1 (count object-directories)))))))

(println "## append boundary and physical-alias refusals")
(doseq [role [:coordination :telemetry]]
  (fixture
   {}
   (fn [{:keys [coordination telemetry base]}]
     (let [path (if (= role :coordination) coordination telemetry)]
       (spit path "unterminated")
       (check! (str (name role) " without terminal LF is refused")
               (throws? #(snapshot/create-snapshot! (assoc base :execute? false))))))))
(fixture
 {}
 (fn [{:keys [coordination telemetry base]}]
   (java.nio.file.Files/delete (.toPath (io/file telemetry)))
   (java.nio.file.Files/createLink (.toPath (io/file telemetry))
                                   (.toPath (io/file coordination)))
   (check! "hard-linked live log aliases are refused"
           (throws? #(snapshot/create-snapshot! (assoc base :execute? false))))))
(fixture
 {}
 (fn [{:keys [coordination base]}]
   (let [intent (rt/rewrite-intent-path coordination)
         bytes (str (pr-str {:v 1 :phase :ambiguous-test}) "\n")]
     (spit intent bytes)
     (check! "an unresolved rewrite intent is refused without invented recovery"
             (throws? #(snapshot/create-snapshot! (assoc base :execute? false))))
     (check! "snapshot refusal preserves the exact recovery evidence"
             (= bytes (slurp intent))))))

(println "## immutable collision and tamper detection")
(fixture
 {}
 (fn [{:keys [base store]}]
   (let [preview (snapshot/create-snapshot! (assoc base :execute? false))
         target (io/file store (:snapshot-id preview))]
     (.mkdirs target)
     (spit (io/file target "garbage") "collision")
     (check! "an occupied mismatching content address is never overwritten"
             (throws? #(snapshot/create-snapshot! (assoc base :execute? true)))))))
(fixture
 {}
 (fn [{:keys [base]}]
   (let [created (snapshot/create-snapshot! (assoc base :execute? true))
         verified (snapshot/verify-snapshot!
                   (assoc base :selector (:snapshot-id created)))
         payload (get-in verified [:records :coordination :path])]
     (spit payload (str (slurp payload) "tamper\n"))
     (check! "payload tampering is detected"
             (throws? #(snapshot/verify-snapshot!
                        (assoc base :selector (:snapshot-id created))))))))
(fixture
 {}
 (fn [{:keys [base]}]
   (let [created (snapshot/create-snapshot! (assoc base :execute? true))
         verified (snapshot/verify-snapshot!
                   (assoc base :selector (:snapshot-id created)))
         coordination (get-in verified [:records :coordination :path])
         telemetry (get-in verified [:records :telemetry :path])]
     (java.nio.file.Files/delete (.toPath (io/file telemetry)))
     (java.nio.file.Files/createLink (.toPath (io/file telemetry))
                                     (.toPath (io/file coordination)))
     (check! "payload hard-link aliasing is detected"
             (throws? #(snapshot/verify-snapshot!
                        (assoc base :selector (:snapshot-id created))))))))
(fixture
 {}
 (fn [{:keys [base store]}]
   (let [created (snapshot/create-snapshot! (assoc base :execute? true))
         manifest (str store "/" (:snapshot-id created) "/manifest.edn")]
     (spit manifest (str (slurp manifest) "\n"))
     (check! "manifest tampering breaks the directory content address"
             (throws? #(snapshot/verify-snapshot!
                        (assoc base :selector (:snapshot-id created))))))))

(println "## instance binding: runtime, log selectors, and controller")
(fixture
 {}
 (fn [{:keys [directory base]}]
   (let [created (snapshot/create-snapshot! (assoc base :execute? true))
         selector (:snapshot-id created)
         other-coord (str directory "/live/other-coordination.log")
         other-telem (str directory "/live/other-telemetry.log")]
     (write-ops! other-coord [(op 1 "assert" "@other" "title" "other")])
     (write-ops! other-telem [])
     (check! "wrong runtime identity is refused"
             (throws? #(snapshot/verify-snapshot!
                        (assoc base :selector selector
                               :runtime! (constantly (assoc runtime-a :revision "wrong"))))))
     (check! "wrong controller identity is refused"
             (throws? #(snapshot/verify-snapshot!
                        (assoc base :selector selector
                               :controller! (constantly {:kind "wrong"})))))
     (check! "wrong selected log pair is refused"
             (throws? #(snapshot/verify-snapshot!
                        (assoc base :selector selector
                               :live {:coordination other-coord
                                      :telemetry other-telem})))))))

(println "## monotonic older-snapshot restore candidate and source drift")
(fixture
 {}
 (fn [{:keys [coordination telemetry base]}]
   (let [created (snapshot/create-snapshot! (assoc base :execute? true))
         _ (spit coordination
                 (str (slurp coordination)
                      (pr-str (op 100 "assert" "@newer" "title" "live")) "\n"))
         live-before {:coordination (slurp coordination)
                      :telemetry (slurp telemetry)}
         result (snapshot/restore-plan!
                 (assoc base :selector (:snapshot-id created) :execute? true))
         plan (ct/read-edn-file! "restore plan" (:plan-path result))
         candidate-coord (get-in plan [:candidate :coordination :path])
         candidate-telem (get-in plan [:candidate :telemetry :path])
         candidate-ops (vec (rt/read-log candidate-coord))
         marker-ops (take-last 2 (raw-records candidate-coord))
         candidate-live (:facts (fold/fold candidate-ops))]
     (check! "restore planning mutates neither selected live log"
             (= live-before {:coordination (slurp coordination)
                             :telemetry (slurp telemetry)}))
     (check! "older snapshot candidate watermark is strictly above live checkpoint"
             (= 101 (:watermark-tx result)
                    (get-in plan [:target :corpus-max-tx])
                    (fold/max-tx candidate-ops)))
     (check! "candidate telemetry remains the exact older snapshot payload"
             (= 3 (fold/max-tx (rt/read-log candidate-telem))))
     (check! "raw history carries a paired explicit restoration transaction"
             (and (= ["assert" "retract"] (mapv :op marker-ops))
                  (= #{101} (set (map :tx marker-ops)))
                  (every? map? (map :restoration marker-ops))))
     (check! "restoration watermark leaves no live marker/schema residue"
             (not-any? #(= "north_restore_checkpoint" (:p %)) candidate-live))
     (check! "emitted artifact is a valid corpus-transaction plan"
             (= (:plan-id plan)
                (:plan-id (ct/verify-plan!
                           plan {:coordination coordination
                                 :telemetry telemetry}))))
     (spit coordination
           (str (slurp coordination)
                (pr-str (op 102 "assert" "@drift" "title" "after-plan")) "\n"))
     (check! "post-plan source drift invalidates the sealed transaction plan"
             (throws? #(ct/verify-plan!
                        plan {:coordination coordination :telemetry telemetry}))))))

(println "## pre-publication authority loss leaves no visible artifact")
(fixture
 {}
 (fn [{:keys [base store]}]
   (let [observed-stage? (atom false)
         denied
         (capture
          #(snapshot/create-snapshot!
            (assoc base :execute? true
                   :runtime-current!
                   (fn [_]
                     (reset! observed-stage?
                             (seq (matching-child-names
                                   store #"^\.snapshot-stage-v1\..+\.tmp$")))
                     false))))]
     (check! "create stages the complete object before authority revalidation"
             @observed-stage?)
     (check! "create refuses a non-positive authority verdict"
             (some? (:error denied)))
     (check! "create authority loss publishes no snapshot object"
             (and (empty? (matching-child-names store snapshot/snapshot-id-pattern))
                  (empty? (matching-child-names
                           store #"^\.snapshot-stage-v1\..+\.tmp$")))))))

(fixture
 {}
 (fn [{:keys [base store coordination]}]
   (let [created (snapshot/create-snapshot! (assoc base :execute? true))
         _ (append-op! coordination (op 50 "assert" "@new" "title" "new"))
         observed-stages? (atom false)
         denied
         (capture
          #(snapshot/restore-plan!
            (assoc base :selector (:snapshot-id created) :execute? true
                   :runtime-current!
                   (fn [_]
                     (reset! observed-stages?
                             (and (seq (matching-child-names
                                        (str store "/candidates")
                                        #"^\.candidate-stage-v1\..+\.tmp$"))
                                  (seq (matching-child-names
                                        (str store "/plans")
                                        #"^\.plan-stage-v1\..+\.tmp$"))))
                     (throw (ex-info "injected runtime authority loss" {}))))))]
     (check! "restore stages candidate and plan before authority revalidation"
             @observed-stages?)
     (check! "restore refuses the injected authority loss"
             (some? (:error denied)))
     (check! "restore authority loss publishes neither candidate nor plan"
             (and (empty? (matching-child-names
                           (str store "/candidates") snapshot/candidate-id-pattern))
                  (empty? (matching-child-names
                           (str store "/plans") #"^plan-[0-9a-f]{64}\.edn$"))
                  (empty? (matching-child-names
                           (str store "/candidates")
                           #"^\.candidate-stage-v1\..+\.tmp$"))
                  (empty? (matching-child-names
                           (str store "/plans")
                           #"^\.plan-stage-v1\..+\.tmp$")))))))

(println "## retry scavenges only structurally owned interrupted stages")
(fixture
 {}
 (fn [{:keys [base store]}]
   (let [owned (create-owned-orphan-stage! store "snapshot")
         unrelated (str store "/.human-notes.tmp")]
     (spit unrelated "not North-owned")
     (snapshot/create-snapshot! (assoc base :execute? true))
     (check! "create retry removes its validated interrupted snapshot stage"
             (not (.exists (io/file owned))))
     (check! "create retry preserves unrelated hidden tmp content"
             (.isFile (io/file unrelated))))))

(fixture
 {}
 (fn [{:keys [base store coordination]}]
   (let [created (snapshot/create-snapshot! (assoc base :execute? true))
         _ (append-op! coordination (op 50 "assert" "@new" "title" "new"))
         candidate (create-owned-orphan-stage!
                    (str store "/candidates") "candidate")
         plan (create-owned-orphan-stage! (str store "/plans") "plan")]
     (snapshot/restore-plan!
      (assoc base :selector (:snapshot-id created) :execute? true))
     (check! "restore retry removes validated candidate and plan stages"
             (and (not (.exists (io/file candidate)))
                  (not (.exists (io/file plan))))))))

(fixture
 {}
 (fn [{:keys [base store]}]
   (.mkdirs (io/file store))
   (let [invalid (str store "/.snapshot-stage-v1."
                      (java.util.UUID/randomUUID) ".tmp")]
     (.mkdir (io/file invalid))
     (set-permissions! invalid ["OWNER_READ" "OWNER_WRITE" "OWNER_EXECUTE"])
     (check! "matching but unowned stage names fail closed"
             (throws? #(snapshot/create-snapshot! (assoc base :execute? true))))
     (check! "failed ownership validation never deletes the unknown directory"
             (.isDirectory (io/file invalid))))))

(if (seq @failures)
  (do
    (println (str "snapshot owner test failures: " (str/join ", " @failures)))
    (System/exit 1))
  (println "snapshot owner tests: PASS"))
