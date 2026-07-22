#!/usr/bin/env bb
;; Adversarial owner proof for manifest-last finalized schema candidates.
(require '[clojure.java.io :as io])

(def root (.getCanonicalPath (io/file (.getParent (io/file *file*)) "../..")))
(load-file (str root "/cli/schema-migrate.clj"))
(require '[north.corpus-transaction :as ct]
         '[north.schema-candidate :as candidate]
         '[north.snapshot :as snapshot])

(def checks (atom []))

(defn check! [label ok]
  (swap! checks conj {:label label :ok (boolean ok)}))

(defn capture [f]
  (try
    {:value (f)}
    (catch Throwable error
      {:error error :data (ex-data error)})))

(defn refused? [result]
  (some? (:error result)))

(defn delete-tree! [file]
  (when (.isDirectory ^java.io.File file)
    (doseq [child (or (.listFiles ^java.io.File file)
                      (make-array java.io.File 0))]
      (delete-tree! child)))
  (java.nio.file.Files/deleteIfExists (.toPath ^java.io.File file)))

(defn permissions [path]
  (->> (java.nio.file.Files/getPosixFilePermissions
        (.toPath (io/file path))
        (into-array java.nio.file.LinkOption
                    [java.nio.file.LinkOption/NOFOLLOW_LINKS]))
       (map str)
       sort
       vec))

(defn set-permissions! [path values]
  (java.nio.file.Files/setPosixFilePermissions
   (.toPath (io/file path))
   (java.util.HashSet.
    ^java.util.Collection
    (mapv java.nio.file.attribute.PosixFilePermission/valueOf values)))
  path)

(defn sha256-bytes [^bytes payload]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        payload)]
    (apply str (map #(format "%02x" %) digest))))

(defn read-bytes [path]
  (java.nio.file.Files/readAllBytes (.toPath (io/file path))))

(defn write-bytes-exact! [path ^bytes payload terminal-permissions]
  (set-permissions! path ["OWNER_READ" "OWNER_WRITE"])
  (java.nio.file.Files/write
   (.toPath (io/file path)) payload
   (into-array java.nio.file.OpenOption
               [java.nio.file.StandardOpenOption/WRITE
                java.nio.file.StandardOpenOption/TRUNCATE_EXISTING]))
  (ct/fsync-file! path)
  (set-permissions! path terminal-permissions)
  (with-open [channel
              (java.nio.channels.FileChannel/open
               (.toPath (io/file path))
               (into-array java.nio.file.OpenOption
                           [java.nio.file.StandardOpenOption/READ]))]
    (.force channel true))
  path)

(defn file-seal [path]
  (let [nio (.toPath (io/file path))
        attrs (java.nio.file.Files/readAttributes
               nio java.nio.file.attribute.BasicFileAttributes
               (into-array java.nio.file.LinkOption
                           [java.nio.file.LinkOption/NOFOLLOW_LINKS]))]
    {:bytes (.size attrs)
     :sha256 (ct/sha256-file path)
     :file-key (str (.fileKey attrs))
     :permissions (permissions path)
     :links (long (java.nio.file.Files/getAttribute
                   nio "unix:nlink"
                   (into-array java.nio.file.LinkOption
                               [java.nio.file.LinkOption/NOFOLLOW_LINKS])))}))

(defn manifest-names [store]
  (->> (or (.listFiles (io/file store)) (make-array java.io.File 0))
       (map #(.getName ^java.io.File %))
       (filter #(re-matches candidate/finalized-manifest-name-pattern %))
       sort
       vec))

(defn retained-stage-names [store]
  (->> (or (.listFiles (io/file store)) (make-array java.io.File 0))
       (map #(.getName ^java.io.File %))
       (filter #(re-matches candidate/owned-stage-name-pattern %))
       sort
       vec))

(defn capture-snapshot! [store coordination telemetry]
  (let [identity {:fixture "schema-candidate-test/v1"}]
    (snapshot/create-snapshot!
     {:store store
      :live {:coordination coordination :telemetry telemetry}
      :runtime! (constantly identity)
      :controller! (constantly identity)
      :runtime-current! (constantly true)
      :controller-current! (constantly true)
      :provenance {:fixture "schema-candidate-test/v1"}
      :execute? true})))

(def validator
  (fn [sealed]
    {:ok (= #{:coordination :telemetry} (set (keys (:records sealed))))
     :validator "schema-candidate-test/v1"}))

(defn verify! [store id snapshot-store]
  (candidate/verify-finalized!
   {:candidate-store store :candidate id
    :snapshot-store snapshot-store :validate! validator}))

(defn publish! [store snapshot-store workspace]
  (let [publication (candidate/reserve-publication! store)]
    (try
      (candidate/publish-finalized!
       {:snapshot-store snapshot-store :workspace workspace
        :validate! validator :publication publication})
      (finally
        (candidate/release-publication! publication)))))

(let [temp (.toFile
            (java.nio.file.Files/createTempDirectory
             "north-schema-candidate-test-"
             (make-array java.nio.file.attribute.FileAttribute 0)))
      coordination (.getCanonicalPath (io/file temp "coordination.log"))
      telemetry (.getCanonicalPath (io/file temp "telemetry.log"))
      snapshot-store (.getCanonicalPath (io/file temp "snapshots"))
      workspace-root (.getCanonicalPath (io/file temp "workspaces"))
      candidate-store (.getCanonicalPath (io/file temp "candidates"))
      collision-store (.getCanonicalPath (io/file temp "collisions"))
      manifest-collision-store
      (.getCanonicalPath (io/file temp "manifest-collisions"))
      precommit-drift-store
      (.getCanonicalPath (io/file temp "precommit-drift"))
      foreign-store (.getCanonicalPath (io/file temp "foreign-store"))
      reserved-store (.getCanonicalPath (io/file temp "reserved-store"))
      rebound-store (.getCanonicalPath (io/file temp "rebound-store"))
      displaced-store (.getCanonicalPath (io/file temp "displaced-store"))
      repair-sha (apply str (repeat 64 "a"))]
  (try
    (spit coordination
          (str (pr-str {:tx 1 :op "assert" :l "@fixture"
                        :p "title" :r "manifest-last"
                        :frame "schema-candidate-test"})
               "\n"))
    (spit telemetry "")
    (let [created (capture-snapshot! snapshot-store coordination telemetry)
          snapshot-id (:snapshot-id created)
          prepared
          (candidate/prepare-workspace!
           {:workspace-root workspace-root :snapshot-store snapshot-store
            :source-snapshot snapshot-id
            :repair-manifest-sha256 repair-sha :execute? true})
          origin-options
          {:workspace-root workspace-root :workspace (:workspace_id prepared)
           :snapshot-store snapshot-store :source-snapshot snapshot-id
           :repair-manifest-sha256 repair-sha}
          original-workspace (candidate/verify-origin! origin-options)
          _ (candidate/seal-built!
             original-workspace
             {:format "schema-candidate-test-proof/v1" :converged true})
          workspace (candidate/verify-origin! origin-options)
          snapshot-object (snapshot/verify-snapshot-object!
                           snapshot-store snapshot-id)
          snapshot-coordination (get-in snapshot-object
                                        [:records :coordination :path])
          snapshot-bytes (read-bytes snapshot-coordination)
          snapshot-permissions (permissions snapshot-coordination)]

      ;; A reservation is authority for one exact parent inode, not a portable
      ;; token that can be paired with another candidate store.
      (.mkdirs (io/file foreign-store))
      (let [publication (candidate/reserve-publication! reserved-store)
            attempt
            (capture
             #(candidate/publish-finalized!
               {:snapshot-store snapshot-store :workspace workspace
                :validate! validator
                :publication (assoc publication :store foreign-store)}))]
        (check! "publication reservation cannot be rebound to another store"
                (refused? attempt))
        (check! "foreign store receives no candidate authority or payload"
                (empty? (or (.listFiles (io/file foreign-store))
                            (make-array java.io.File 0))))
        (candidate/release-publication! publication))

      ;; The named parent must still be the inode captured at reservation.
      (let [publication (candidate/reserve-publication! rebound-store)]
        (java.nio.file.Files/move
         (.toPath (io/file rebound-store)) (.toPath (io/file displaced-store))
         (make-array java.nio.file.CopyOption 0))
        (.mkdir (io/file rebound-store))
        (let [attempt
              (capture
               #(candidate/publish-finalized!
                 {:snapshot-store snapshot-store :workspace workspace
                  :validate! validator :publication publication}))]
          (check! "publication refuses a rebound reserved parent path"
                  (refused? attempt))
          (check! "rebound decoy store receives no candidate object"
                  (empty? (or (.listFiles (io/file rebound-store))
                              (make-array java.io.File 0)))))
        (candidate/release-publication! publication))

      ;; A snapshot that drifts after the workspace was built cannot publish
      ;; even inert payload objects, much less the authoritative manifest.
      (.mkdirs (io/file candidate-store))
      (write-bytes-exact!
       snapshot-coordination (.getBytes "tampered\n") snapshot-permissions)
      (let [attempt (capture #(publish! candidate-store snapshot-store workspace))]
        (check! "source drift before publication is refused" (refused? attempt))
        (check! "source drift publishes no candidate authority"
                (empty? (manifest-names candidate-store))))
      (write-bytes-exact! snapshot-coordination snapshot-bytes
                          snapshot-permissions)

      ;; Workspace representation is independently re-established immediately
      ;; before payload publication and again before the manifest commit point.
      (let [workspace-coordinate (get-in workspace [:records :coordination :path])
            expected-mode (permissions workspace-coordinate)]
        (set-permissions! workspace-coordinate
                          ["OWNER_READ" "OWNER_WRITE" "GROUP_READ"])
        (let [attempt (capture #(publish! candidate-store snapshot-store workspace))]
          (check! "workspace mode drift before publication is refused"
                  (refused? attempt))
          (check! "workspace drift publishes no candidate authority"
                  (empty? (manifest-names candidate-store))))
        (set-permissions! workspace-coordinate expected-mode))

      ;; The independent validator runs before the manifest commit. If its
      ;; work (or any concurrent actor) changes a just-published payload, the
      ;; mandatory precommit reread refuses and leaves no selected manifest.
      (let [publication (candidate/reserve-publication! precommit-drift-store)
            attempt
            (capture
             #(candidate/publish-finalized!
               {:snapshot-store snapshot-store :workspace workspace
                :publication publication
                :validate!
                (fn [draft]
                  (let [target
                        (str precommit-drift-store "/"
                             (get-in draft
                                     [:manifest :files :coordination
                                      :object_name]))]
                    (write-bytes-exact!
                     target (.getBytes "validator-drift\n")
                     candidate/finalized-file-permissions)
                    {:ok true}))}))]
        (check! "payload drift during precommit validation is refused"
                (refused? attempt))
        (check! "precommit payload drift leaves no manifest authority"
                (empty? (manifest-names precommit-drift-store)))
        (candidate/release-publication! publication))

      (let [published (publish! candidate-store snapshot-store workspace)
            id (:candidate_id published)
            manifest (:manifest published)
            manifest-path (:manifest_path published)
            payload-path
            (str candidate-store "/"
                 (get-in manifest [:files :coordination :object_name]))
            telemetry-path
            (str candidate-store "/"
                 (get-in manifest [:files :telemetry :object_name]))
            authority-before
            (into (sorted-map)
                  (map (fn [path]
                         [(.getName (io/file path)) (file-seal path)]))
                  [manifest-path payload-path telemetry-path])]
        (check! "manifest is the sole selected authority"
                (= [(.getName (io/file manifest-path))]
                   (manifest-names candidate-store)))
        (check! "manifest records manifest-last anonymous-FD publication"
                (= {:authority "manifest-last"
                    :payload_publication "anonymous-fd-create-new"
                    :reference_binding "pinned-fd-pre-and-post-link"
                    :cooperative_serialization "exclusive-parent-fd-lock"
                    :staging candidate/retained-stage-policy}
                   (:publication manifest)))
        (check! "finalized manifest and payloads are read-only and unaliased"
                (every? #(= {:permissions candidate/finalized-file-permissions
                              :links 1}
                            (select-keys (file-seal %)
                                         [:permissions :links]))
                        [manifest-path payload-path telemetry-path]))
        (check! "payload role, name, and digest are exactly bound"
                (every?
                 (fn [role]
                   (let [row (get-in manifest [:files role])]
                     (= (:object_name row)
                        (candidate/finalized-payload-name role (:sha256 row)))))
                 ct/roles))
        (check! "pinned payload inode keys use canonical numeric dev:ino"
                (every?
                 #(re-matches #"[0-9]+:[0-9]+"
                              (get-in published [:records % :file_key]))
                 ct/roles))

        ;; Exact EEXIST is a read-only resume: no file identity, byte, mode, or
        ;; link count changes, and no second authority appears.
        (let [retried (publish! candidate-store snapshot-store workspace)
              authority-after
              (into (sorted-map)
                    (map (fn [path]
                           [(.getName (io/file path)) (file-seal path)]))
                    [manifest-path payload-path telemetry-path])]
          (check! "exact EEXIST retry resolves the same candidate"
                  (= id (:candidate_id retried)))
          (check! "exact EEXIST retry is representation-zero-write"
                  (= authority-before authority-after))
          (check! "publication reservations remain private retained evidence"
                  (<= 2 (count (retained-stage-names candidate-store)))))

        ;; Unreferenced objects and retained stages are inert because readers
        ;; resolve one exact content ID and only that manifest's object names.
        (let [garbage-name
              (str "schema-payload-coordination-"
                   (apply str (repeat 64 "0")) ".log")
              garbage (str candidate-store "/" garbage-name)]
          (spit garbage "unreferenced\n")
          (set-permissions! garbage candidate/finalized-file-permissions)
          (check! "unreferenced payload-shaped garbage is non-authoritative"
                  (= id (:candidate_id (verify! candidate-store id
                                                snapshot-store)))))

        (let [payload-bytes (read-bytes payload-path)
              payload-mode (permissions payload-path)
              attempt
              (capture
               #(candidate/verify-finalized!
                 {:candidate-store candidate-store :candidate id
                  :snapshot-store snapshot-store
                  :validate!
                  (fn [_]
                    (write-bytes-exact!
                     payload-path (.getBytes "post-domain-drift\n")
                     payload-mode)
                    {:ok true})}))]
          (check! "reader refuses payload drift during domain validation"
                  (refused? attempt))
          (write-bytes-exact! payload-path payload-bytes payload-mode)
          (check! "reader verifies after post-domain drift restoration"
                  (= id (:candidate_id (verify! candidate-store id
                                                snapshot-store)))))

        ;; The reader re-pins and re-hashes every representation on every call.
        (let [original-mode (permissions payload-path)]
          (set-permissions! payload-path
                            ["OWNER_READ" "OWNER_WRITE" "GROUP_READ"])
          (check! "reader refuses writable payload mode"
                  (refused? (capture #(verify! candidate-store id
                                                snapshot-store))))
          (set-permissions! payload-path original-mode))

        (let [payload-bytes (read-bytes payload-path)
              payload-mode (permissions payload-path)]
          (write-bytes-exact! payload-path (.getBytes "tampered\n")
                              payload-mode)
          (check! "reader refuses payload byte drift after publication"
                  (refused? (capture #(verify! candidate-store id
                                                snapshot-store))))
          (write-bytes-exact! payload-path payload-bytes payload-mode)
          (check! "restored exact payload verifies again"
                  (= id (:candidate_id (verify! candidate-store id
                                                snapshot-store)))))

        (let [alias (str candidate-store "/payload-hardlink-alias")]
          (java.nio.file.Files/createLink (.toPath (io/file alias))
                                          (.toPath (io/file payload-path)))
          (check! "reader refuses a hard-linked payload"
                  (refused? (capture #(verify! candidate-store id
                                                snapshot-store))))
          (java.nio.file.Files/deleteIfExists (.toPath (io/file alias)))
          (check! "payload verifies after link count returns to one"
                  (= id (:candidate_id (verify! candidate-store id
                                                snapshot-store)))))

        (let [backup (str candidate-store "/payload-symlink-original")]
          (java.nio.file.Files/move
           (.toPath (io/file payload-path)) (.toPath (io/file backup))
           (make-array java.nio.file.CopyOption 0))
          (java.nio.file.Files/createSymbolicLink
           (.toPath (io/file payload-path)) (.toPath (io/file backup))
           (make-array java.nio.file.attribute.FileAttribute 0))
          (check! "reader refuses a symlink at the referenced payload name"
                  (refused? (capture #(verify! candidate-store id
                                                snapshot-store))))
          (java.nio.file.Files/deleteIfExists (.toPath (io/file payload-path)))
          (java.nio.file.Files/move
           (.toPath (io/file backup)) (.toPath (io/file payload-path))
           (make-array java.nio.file.CopyOption 0)))

        (let [manifest-bytes (read-bytes manifest-path)
              manifest-mode (permissions manifest-path)]
          (write-bytes-exact! manifest-path (.getBytes "{:tampered true}\n")
                              manifest-mode)
          (check! "reader refuses manifest representation drift"
                  (refused? (capture #(verify! candidate-store id
                                                snapshot-store))))
          (write-bytes-exact! manifest-path manifest-bytes manifest-mode)
          (check! "restored exact manifest verifies again"
                  (= id (:candidate_id (verify! candidate-store id
                                                snapshot-store)))))

        (let [alias (str candidate-store "/manifest-hardlink-alias")]
          (java.nio.file.Files/createLink (.toPath (io/file alias))
                                          (.toPath (io/file manifest-path)))
          (check! "reader refuses a hard-linked manifest"
                  (refused? (capture #(verify! candidate-store id
                                                snapshot-store))))
          (java.nio.file.Files/deleteIfExists (.toPath (io/file alias))))

        ;; Candidate verification also re-establishes its source object and
        ;; never treats a past successful read as durable authority.
        (write-bytes-exact!
         snapshot-coordination (.getBytes "post-publication-tamper\n")
         snapshot-permissions)
        (check! "reader refuses source snapshot drift after publication"
                (refused? (capture #(verify! candidate-store id
                                              snapshot-store))))
        (write-bytes-exact! snapshot-coordination snapshot-bytes
                            snapshot-permissions)
        (check! "candidate verifies after exact source restoration"
                (= id (:candidate_id (verify! candidate-store id
                                              snapshot-store))))
        (check! "independent domain validator remains mandatory"
                (refused?
                 (capture
                  #(candidate/verify-finalized!
                    {:candidate-store candidate-store :candidate id
                     :snapshot-store snapshot-store
                     :validate! (constantly {:ok false})}))))

        ;; A content-addressed but structurally forged manifest does not gain
        ;; authority: role and digest determine the only admissible object name.
        (let [forged-core
              (assoc-in (dissoc manifest :candidate_id)
                        [:files :coordination :object_name]
                        (get-in manifest [:files :telemetry :object_name]))
              forged-id
              (str "schema-candidate-"
                   (sha256-bytes (candidate/canonical-edn-bytes forged-core)))
              forged-manifest (assoc forged-core :candidate_id forged-id)
              forged-path (str candidate-store "/" forged-id ".edn")]
          (ct/write-bytes-durable!
           forged-path (candidate/canonical-edn-bytes forged-manifest))
          (set-permissions! forged-path candidate/finalized-file-permissions)
          (check! "role-to-object substitution is refused"
                  (refused? (capture #(verify! candidate-store forged-id
                                                snapshot-store))))
          (check! "unselected forged manifest cannot perturb selected authority"
                  (= id (:candidate_id (verify! candidate-store id
                                                snapshot-store)))))

        ;; Manifest EEXIST follows the same create-new rule as payloads. Exact
        ;; payload objects may be inertly present, but a wrong manifest inode is
        ;; never overwritten or accepted as the selected authority.
        (.mkdirs (io/file manifest-collision-store))
        (let [wrong-manifest
              (str manifest-collision-store "/" id ".edn")]
          (spit wrong-manifest "{:wrong \"manifest\"}\n")
          (set-permissions! wrong-manifest
                            candidate/finalized-file-permissions)
          (let [before (file-seal wrong-manifest)
                attempt
                (capture #(publish! manifest-collision-store snapshot-store
                                    workspace))
                after (file-seal wrong-manifest)]
            (check! "wrong pre-existing manifest is refused"
                    (refused? attempt))
            (check! "wrong pre-existing manifest remains byte-and-inode exact"
                    (= before after))
            (check! "wrong manifest cannot validate as candidate authority"
                    (refused?
                     (capture #(verify! manifest-collision-store id
                                        snapshot-store))))))

        ;; An existing wrong object at the expected content name is neither
        ;; overwritten nor accepted, and manifest-last leaves no authority.
        (.mkdirs (io/file collision-store))
        (let [expected-name
              (get-in manifest [:files :coordination :object_name])
              wrong-path (str collision-store "/" expected-name)]
          (spit wrong-path "wrong-existing-object\n")
          (set-permissions! wrong-path candidate/finalized-file-permissions)
          (let [before (file-seal wrong-path)
                attempt (capture #(publish! collision-store snapshot-store
                                            workspace))
                after (file-seal wrong-path)]
            (check! "wrong pre-existing payload object is refused"
                    (refused? attempt))
            (check! "wrong pre-existing object remains byte-and-inode exact"
                    (= before after))
            (check! "wrong EEXIST publishes no candidate manifest"
                    (empty? (manifest-names collision-store)))))))
    (finally
      (delete-tree! temp))))

(let [results @checks
      failures (remove :ok results)
      passed (- (count results) (count failures))]
  (doseq [{:keys [label ok]} results]
    (println (format "  [%s] %s" (if ok "PASS" "FAIL") label)))
  (println (format "\nschema candidate: %d / %d PASS" passed (count results)))
  (System/exit (if (empty? failures) 0 1)))
