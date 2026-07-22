(ns north.snapshot
  "Content-addressed, dual-log preservation and restore planning for North.

  Snapshot capture is a read-side maintenance operation: it holds North's
  maintenance singleton and Fram's exclusive corpus rewrite fence while it
  seals and copies both logs. Restore planning never replaces live bytes. It
  derives an immutable candidate and delegates any later replacement to the
  existing north.corpus-transaction state machine."
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [fram.fold :as fold]
            [fram.rt :as rt]
            [north.corpus-transaction :as ct]))

(def snapshot-format "north-snapshot/v1")
(def candidate-format "north-snapshot-restore-candidate/v1")
(def owned-stage-format "north-snapshot-owned-stage/v1")
(def snapshot-id-pattern #"snapshot-[0-9a-f]{64}")
(def candidate-id-pattern #"candidate-[0-9a-f]{64}")
(def owned-stage-name-pattern
  #"^\.(snapshot|candidate|plan)-stage-v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$")
(def schema-meta-predicates
  #{"cardinality" "value_kind" "acyclic" "doc" "entity_kind"
    "entity_kind_name"})
(def object-names {:coordination "coordination.log"
                   :telemetry "telemetry.log"})

(defn- sha256-bytes [^bytes payload]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        payload)]
    (apply str (map #(format "%02x" %) digest))))

(defn canonical-edn-bytes [value]
  (.getBytes (str (pr-str (ct/canonical-form value)) "\n")
             java.nio.charset.StandardCharsets/UTF_8))

(defn- canonical-edn-sha256 [value]
  (sha256-bytes (canonical-edn-bytes value)))

(defn- set-posix-permissions! [path permissions]
  (when (seq permissions)
    (java.nio.file.Files/setPosixFilePermissions
     (.toPath (io/file path))
     (java.util.HashSet.
      ^java.util.Collection
      (mapv java.nio.file.attribute.PosixFilePermission/valueOf permissions))))
  path)

(defn- canonical-directory! [label path create?]
  (when (str/blank? (str path))
    (ct/fail! (str label " path is blank")))
  (let [file (io/file (str path))]
    (when (and (.exists file)
               (java.nio.file.Files/isSymbolicLink (.toPath file)))
      (ct/fail! (str label " must not be a symbolic link: " path)))
    (when (and create? (not (.exists file)) (not (.mkdirs file)))
      (ct/fail! (str "cannot create " label ": " path)))
    (when-not (.isDirectory file)
      (ct/fail! (str label " is not a directory: " path)))
    (.getCanonicalPath file)))

(defn store-root!
  ([path] (store-root! path false))
  ([path create?] (canonical-directory! "snapshot store" path create?)))

(defn- same-file? [left right]
  (try
    (java.nio.file.Files/isSameFile (.toPath (io/file left))
                                    (.toPath (io/file right)))
    (catch java.io.IOException _ false)))

(defn live-pair! [live]
  (let [pair (ct/live-pair!
              (into {}
                    (map (fn [role]
                           [role {:path (get live role)}])
                         ct/roles)))]
    (when (same-file? (:coordination pair) (:telemetry pair))
      (ct/fail! "coordination and telemetry logs alias the same physical file"))
    pair))

(defn- ending-of [record]
  (if (zero? (:bytes record)) "zero-byte" "terminal-lf"))

(defn- read-ops! [label path]
  (try
    (vec (rt/read-log path))
    (catch Throwable error
      (ct/fail! (str label " is not a valid Fram flat log: " path)
                {:cause (.getMessage error)}))))

(defn- read-raw-records! [label path]
  (try
    (with-open [reader (io/reader path)]
      (->> (line-seq reader)
           (remove str/blank?)
           (mapv (fn [line]
                   (let [record (edn/read-string line)]
                     (when-not (map? record)
                       (ct/fail! (str label " contains a non-map record")))
                     record)))))
    (catch clojure.lang.ExceptionInfo error (throw error))
    (catch Throwable error
      (ct/fail! (str label " contains invalid raw EDN evidence")
                {:cause (.getMessage error)}))))

(defn sealed-log-record! [role path]
  (let [record (ct/corpus-file-record (str (name role) " corpus") path)
        ops (read-ops! (str (name role) " corpus") (:path record))]
    (assoc record
           :max-tx (fold/max-tx ops)
           :ending (ending-of record))))

(defn- descriptor [role record]
  (-> record
      (dissoc :path)
      (assoc :source-path (:path record)
             :object-name (get object-names role))))

(defn- payload-descriptor [role record]
  (-> record
      (dissoc :path)
      (assoc :object-name (get object-names role))))

(defn- schema-identity-from-paths! [paths]
  (let [ops (vec (mapcat #(read-ops! "schema identity corpus" %) paths))
        facts (:facts (fold/fold ops))
        triples (->> facts
                     (keep (fn [fact]
                             (let [l (:l fact) p (:p fact) r (:r fact)]
                               (when (and (string? l) (str/starts-with? l "@")
                                          (contains? schema-meta-predicates p))
                                 [l p r]))))
                     sort
                     vec)]
    {:algorithm "fram-fold-live-schema-meta/v1"
     :facts (count triples)
     :sha256 (canonical-edn-sha256 triples)}))

(defn- exact-record= [left right]
  (= (select-keys left [:path :bytes :sha256 :permissions :append-boundary
                        :max-tx :ending])
     (select-keys right [:path :bytes :sha256 :permissions :append-boundary
                         :max-tx :ending])))

(defn- assert-no-rewrite-intent! [coordination]
  (when-let [intent (rt/read-rewrite-intent coordination)]
    (ct/fail! "an unresolved Fram rewrite intent makes snapshot capture ambiguous"
              {:rewrite-intent intent
               :path (rt/rewrite-intent-path coordination)})))

(defn- assert-complete-identity! [label identity]
  (when-not (and (map? identity) (seq identity))
    (ct/fail! (str label " identity is missing or empty")))
  identity)

(defn- capture-identities! [{:keys [runtime! controller!]}]
  {:runtime (assert-complete-identity! "Fram runtime" (runtime!))
   :controller (assert-complete-identity! "coordinator controller"
                                          (controller!))})

(defn- runtime-binding [runtime]
  (if-let [identity (get-in runtime [:attestation :identity])]
    {:selector (:selector runtime) :identity identity}
    runtime))

(defn- assert-identities-current!
  [identities {:keys [runtime! runtime-current! controller!
                      controller-current!]}]
  (if runtime-current!
    (when-not (true? (runtime-current! (:runtime identities)))
      (ct/fail! "Fram runtime authority did not positively re-attest"))
    (when-not (= (:runtime identities) (runtime!))
      (ct/fail! "Fram runtime authority changed during snapshot work")))
  (if controller-current!
    (when-not (true? (controller-current! (:controller identities)))
      (ct/fail! "coordinator controller did not positively re-attest"))
    (when-not (= (:controller identities) (controller!))
      (ct/fail! "coordinator controller identity changed during snapshot work")))
  true)

(defn snapshot-manifest
  [{:keys [records schema runtime controller provenance]}]
  {:format snapshot-format
   :files (into {}
                (map (fn [role] [role (descriptor role (get records role))])
                     ct/roles))
   :corpus-max-tx (apply max 0 (map #(get-in records [% :max-tx]) ct/roles))
   :schema schema
   :runtime runtime
   :controller controller
   :creation provenance})

(defn snapshot-id [manifest]
  (str "snapshot-" (sha256-bytes (canonical-edn-bytes manifest))))

(defn- object-path [directory role]
  (str directory "/" (get object-names role)))

(defn- expected-object-entries []
  (conj (set (vals object-names)) "manifest.edn"))

(defn- directory-entry-names [directory]
  (set (map #(.getName ^java.io.File %)
            (or (seq (.listFiles (io/file directory))) []))))

(defn- resolve-object-directory! [store selector pattern label]
  (let [store (store-root! store false)
        selected (str selector)
        path (if (re-matches pattern selected)
               (str store "/" selected)
               selected)
        raw (io/file path)]
    (when (java.nio.file.Files/isSymbolicLink (.toPath raw))
      (ct/fail! (str label " directory must not be a symbolic link: " path)))
    (when-not (.isDirectory raw)
      (ct/fail! (str label " directory is missing: " path)))
    (let [canonical (.getCanonicalPath raw)
          parent (.getCanonicalPath (.getParentFile (io/file canonical)))]
      (when-not (= store parent)
        (ct/fail! (str label " must be an immediate immutable object in " store)))
      (when-not (re-matches pattern (.getName (io/file canonical)))
        (ct/fail! (str label " directory name is not content-addressed: " canonical)))
      canonical)))

(defn- read-manifest-exact! [directory]
  (let [path (str directory "/manifest.edn")
        file (io/file path)]
    (when (java.nio.file.Files/isSymbolicLink (.toPath file))
      (ct/fail! (str "snapshot manifest must not be a symbolic link: " path)))
    (let [canonical (ct/canonical-regular-file! "snapshot manifest" path)
          value (ct/read-edn-file! "snapshot manifest" path)
          payload (java.nio.file.Files/readAllBytes (.toPath file))]
      (when-not (java.util.Arrays/equals payload (canonical-edn-bytes value))
        (ct/fail! "snapshot manifest bytes are not the exact canonical sealed form"))
      {:path canonical :value value})))

(defn- validate-file-row! [role row]
  (when-not (and (map? row)
                 (= (get object-names role) (:object-name row))
                 (string? (:sha256 row))
                 (re-matches #"[0-9a-f]{64}" (:sha256 row))
                 (integer? (:bytes row)) (not (neg? (:bytes row)))
                 (integer? (:max-tx row)) (not (neg? (:max-tx row)))
                 (= ct/append-boundary (:append-boundary row))
                 (= (if (zero? (:bytes row)) "zero-byte" "terminal-lf")
                    (:ending row)))
    (ct/fail! (str "snapshot manifest has an invalid " (name role)
                   " file row")))
  row)

(defn- assert-manifest-identities! [manifest]
  (doseq [[label key] [["schema" :schema] ["runtime" :runtime]
                       ["controller" :controller] ["creation" :creation]]]
    (when-not (and (map? (get manifest key)) (seq (get manifest key)))
      (ct/fail! (str "snapshot manifest has no sealed " label " identity"))))
  manifest)

(defn- verify-payload! [directory role row]
  (validate-file-row! role row)
  (let [path (object-path directory role)
        actual (sealed-log-record! role path)]
    (when-not (= (select-keys row [:bytes :sha256 :permissions :append-boundary
                                   :max-tx :ending])
                 (select-keys actual [:bytes :sha256 :permissions :append-boundary
                                      :max-tx :ending]))
      (ct/fail! (str "snapshot " (name role) " payload does not match manifest")
                {:expected row :actual actual}))
    actual))

(defn verify-snapshot-object!
  "Verify immutable object integrity without comparing it to the selected live
  instance. Call verify-snapshot! for the normal instance-bound CLI contract."
  [store selector]
  (let [directory (resolve-object-directory! store selector snapshot-id-pattern
                                              "snapshot")
        id (.getName (io/file directory))
        {:keys [path value]} (read-manifest-exact! directory)]
    (when-not (= (expected-object-entries) (directory-entry-names directory))
      (ct/fail! "snapshot object contains missing or unsealed extra entries"
                {:entries (directory-entry-names directory)}))
    (when-not (= snapshot-format (:format value))
      (ct/fail! (str "unsupported snapshot manifest format: " (:format value))))
    (assert-manifest-identities! value)
    (when-not (= id (snapshot-id value))
      (ct/fail! "snapshot manifest digest does not match its immutable object id"
                {:expected id :actual (snapshot-id value)}))
    (doseq [role ct/roles]
      (let [source (get-in value [:files role :source-path])]
        (when-not (and (string? source)
                       (.isAbsolute (io/file source))
                       (= source (.getCanonicalPath (io/file source))))
          (ct/fail! (str "snapshot " (name role)
                         " source path is not exact and canonical")))))
    (let [records (into {}
                        (map (fn [role]
                               [role (verify-payload!
                                      directory role (get-in value [:files role]))])
                             ct/roles))]
      (when (same-file? (get-in records [:coordination :path])
                        (get-in records [:telemetry :path]))
        (ct/fail! "snapshot coordination and telemetry payloads alias one file"))
      (let [schema (schema-identity-from-paths!
                    (mapv #(get-in records [% :path]) ct/roles))
            max-tx (apply max 0 (map #(get-in records [% :max-tx]) ct/roles))]
        (when-not (= schema (:schema value))
          (ct/fail! "snapshot schema identity does not match its payload"
                    {:expected (:schema value) :actual schema}))
        (when-not (= max-tx (:corpus-max-tx value))
          (ct/fail! "snapshot corpus transaction watermark does not match payload"))
        {:ok true :snapshot-id id :directory directory :manifest-path path
         :manifest value :records records}))))

(defn- assert-instance-binding!
  [verified {:keys [live runtime! controller!]}]
  (let [pair (live-pair! live)
        manifest (:manifest verified)
        identities (capture-identities! {:runtime! runtime!
                                         :controller! controller!})]
    (doseq [role ct/roles]
      (when-not (= (get pair role) (get-in manifest [:files role :source-path]))
        (ct/fail! (str "snapshot " (name role)
                       " source path does not match this North instance")
                  {:snapshot (get-in manifest [:files role :source-path])
                   :selected (get pair role)})))
    (when-not (= (runtime-binding (:runtime manifest))
                 (runtime-binding (:runtime identities)))
      (ct/fail! "snapshot Fram runtime identity does not match this instance"
                {:snapshot (:runtime manifest) :selected (:runtime identities)}))
    (when-not (= (:controller manifest) (:controller identities))
      (ct/fail! "snapshot controller identity does not match this instance"
                {:snapshot (:controller manifest)
                 :selected (:controller identities)}))
    (assoc verified :live-pair pair :identities identities)))

(defn verify-snapshot!
  [{:keys [store selector] :as options}]
  (assert-instance-binding! (verify-snapshot-object! store selector) options))

(defn- posix-permissions [path]
  (try
    (->> (java.nio.file.Files/getPosixFilePermissions
          (.toPath (io/file path))
          (make-array java.nio.file.LinkOption 0))
         (map str)
         sort
         vec)
    (catch UnsupportedOperationException _ nil)))

(defn- stage-marker-path [stage] (str stage "/.north-stage.edn"))

(defn- stage-name-parts [stage]
  (when-let [[_ kind id]
             (re-matches owned-stage-name-pattern (.getName (io/file stage)))]
    {:kind kind :stage-id id}))

(defn- assert-owned-stage!
  [parent stage expected-kind]
  (let [parent (.getCanonicalPath (io/file parent))
        stage-file (io/file stage)
        canonical (.getCanonicalPath stage-file)
        parts (stage-name-parts stage-file)]
    (when-not (and (= parent (.getCanonicalPath (.getParentFile stage-file)))
                   parts
                   (= expected-kind (:kind parts))
                   (.isDirectory stage-file)
                   (not (java.nio.file.Files/isSymbolicLink (.toPath stage-file))))
      (ct/fail! (str "refusing unowned snapshot staging path: " canonical)))
    (let [marker-path (stage-marker-path canonical)
          marker-file (io/file marker-path)]
      (when-not (and (.isFile marker-file)
                     (not (java.nio.file.Files/isSymbolicLink
                           (.toPath marker-file))))
        (ct/fail! (str "snapshot staging ownership marker is missing: " canonical)))
      (let [marker (ct/read-edn-file! "snapshot staging ownership marker"
                                      marker-path)]
        (when-not (and (java.util.Arrays/equals
                        ^bytes (canonical-edn-bytes marker)
                        ^bytes (java.nio.file.Files/readAllBytes
                                (.toPath marker-file)))
                       (= {:format owned-stage-format
                           :kind expected-kind
                           :owner "north snapshot"
                           :stage-id (:stage-id parts)}
                          marker)
                       (= ["OWNER_EXECUTE" "OWNER_READ" "OWNER_WRITE"]
                          (posix-permissions canonical))
                       (= ["OWNER_READ" "OWNER_WRITE"]
                          (posix-permissions marker-path))
                       (= (java.nio.file.Files/getOwner (.toPath (io/file parent))
                                                       (make-array java.nio.file.LinkOption 0))
                          (java.nio.file.Files/getOwner (.toPath stage-file)
                                                       (make-array java.nio.file.LinkOption 0)))
                       (= (java.nio.file.Files/getOwner (.toPath stage-file)
                                                       (make-array java.nio.file.LinkOption 0))
                          (java.nio.file.Files/getOwner (.toPath marker-file)
                                                       (make-array java.nio.file.LinkOption 0))))
          (ct/fail! (str "snapshot staging ownership evidence is invalid: " canonical)))))
    canonical))

(defn- delete-stage-tree! [parent stage expected-kind]
  (let [parent (.getCanonicalPath (io/file parent))
        canonical (assert-owned-stage! parent stage expected-kind)]
    (doseq [file (reverse (file-seq (io/file canonical)))]
      (when (java.nio.file.Files/isSymbolicLink (.toPath ^java.io.File file))
        (ct/fail! (str "refusing cleanup through symbolic link: " (.getPath file))))
      (java.nio.file.Files/deleteIfExists (.toPath ^java.io.File file)))
    (ct/fsync-dir! parent)
    nil))

(defn- create-owned-stage! [parent kind]
  (let [parent (canonical-directory! "snapshot staging parent" parent true)
        stage-id (str (java.util.UUID/randomUUID))
        stage (str parent "/." kind "-stage-v1." stage-id ".tmp")
        marker {:format owned-stage-format :kind kind
                :owner "north snapshot" :stage-id stage-id}]
    (when-not (.mkdir (io/file stage))
      (ct/fail! (str "cannot create snapshot staging directory: " stage)))
    (set-posix-permissions! stage ["OWNER_READ" "OWNER_WRITE" "OWNER_EXECUTE"])
    (try
      (ct/write-bytes-durable! (stage-marker-path stage)
                               (canonical-edn-bytes marker))
      (set-posix-permissions! (stage-marker-path stage)
                              ["OWNER_READ" "OWNER_WRITE"])
      (ct/fsync-file! (stage-marker-path stage))
      (ct/fsync-dir! stage)
      {:parent parent :stage stage :kind kind :stage-id stage-id}
      (catch Throwable error
        ;; The exact UUID path was created by this invocation and has not been
        ;; published.  If its marker was sealed, use the ordinary ownership
        ;; validator; otherwise delete only the empty/marker-only path.
        (if (.isFile (io/file (stage-marker-path stage)))
          (delete-stage-tree! parent stage kind)
          (java.nio.file.Files/deleteIfExists (.toPath (io/file stage))))
        (throw error)))))

(defn- discard-owned-stage! [{:keys [parent stage kind]}]
  (when (.exists (io/file stage))
    (delete-stage-tree! parent stage kind))
  nil)

(defn- scavenge-owned-stages! [parent kind]
  (let [parent (canonical-directory! "snapshot staging parent" parent true)
        candidates (->> (or (.listFiles (io/file parent))
                            (make-array java.io.File 0))
                        (filter #(when-let [parts (stage-name-parts %)]
                                   (= kind (:kind parts))))
                        (sort-by #(.getName ^java.io.File %)))]
    (doseq [candidate candidates]
      (delete-stage-tree! parent (.getPath ^java.io.File candidate) kind))
    (count candidates)))

(defn- write-manifest! [directory manifest]
  (let [path (str directory "/manifest.edn")]
    (ct/write-bytes-durable! path (canonical-edn-bytes manifest))
    (set-posix-permissions!
     path ["OWNER_READ" "OWNER_WRITE"])
    (ct/fsync-file! path)
    path))

(defn- move-new! [source target]
  ;; The default provider move refuses an existing target. Do not use
  ;; REPLACE_EXISTING (obvious) or ATOMIC_MOVE here: the Java contract permits
  ;; provider-specific replacement semantics for an atomic move when the
  ;; target already exists. Both paths are in the same object-store directory,
  ;; so the underlying rename publishes the complete staged directory at once.
  (java.nio.file.Files/move
   (.toPath (io/file source)) (.toPath (io/file target))
   (make-array java.nio.file.CopyOption 0))
  (ct/fsync-dir! (.getCanonicalPath (.getParentFile (io/file target))))
  target)

(defn- copy-pair-to-stage! [stage records source-paths]
  (doseq [role ct/roles]
    (let [source-record (get records role)
          source (get source-paths role (:path source-record))
          target (object-path stage role)]
      (ct/copy-durable! source target
                        (assoc source-record :path source)
                        (:permissions source-record))))
  stage)

(defn- prepare-snapshot-stage! [store id manifest records]
  (let [store (store-root! store true)
        target (str store "/" id)]
    (if (.exists (io/file target))
      {:store store :target target :manifest manifest :existing? true}
      (let [owned (create-owned-stage! store "snapshot")
            object (str (:stage owned) "/object")]
        (try
          (when-not (.mkdir (io/file object))
            (ct/fail! (str "cannot create snapshot object stage: " object)))
          (set-posix-permissions! object
                                  ["OWNER_READ" "OWNER_WRITE" "OWNER_EXECUTE"])
          (copy-pair-to-stage! object records {})
          (write-manifest! object manifest)
          (ct/fsync-dir! object)
          (assoc owned :store store :target target :object object
                 :manifest manifest :existing? false)
          (catch Throwable error
            (discard-owned-stage! owned)
            (throw error)))))))

(defn- publish-snapshot-stage! [prepared]
  (let [{:keys [store target object manifest existing?]} prepared
        created? (atom false)]
    (try
      (when-not existing?
        (try
          (move-new! object target)
          (reset! created? true)
          (catch java.nio.file.FileAlreadyExistsException _ nil)))
      (let [published (verify-snapshot-object!
                       store (.getName (io/file target)))]
        (when-not (= manifest (:manifest published))
          (ct/fail! (str "immutable snapshot id collision: " target)))
        (assoc published :created @created? :idempotent (not @created?)))
      (finally
        (when (:stage prepared) (discard-owned-stage! prepared))))))

(defn create-snapshot!
  [{:keys [store live runtime! controller! provenance execute?] :as options}]
  (ct/with-maintenance-lock
    (let [pair (live-pair! live)
          before-identities (capture-identities!
                             {:runtime! runtime! :controller! controller!})]
      (assert-no-rewrite-intent! (:coordination pair))
      (ct/with-offline-fences pair
        (assert-no-rewrite-intent! (:coordination pair))
        (let [store-root (when execute? (store-root! store true))
              _ (when execute?
                  (scavenge-owned-stages! store-root "snapshot"))
              records (into {}
                            (map (fn [role]
                                   [role (sealed-log-record!
                                          role (get pair role))])
                                 ct/roles))
              schema (schema-identity-from-paths!
                      (mapv #(get pair %) ct/roles))
              manifest (snapshot-manifest
                        {:records records :schema schema
                         :runtime (:runtime before-identities)
                         :controller (:controller before-identities)
                         :provenance provenance})
              id (snapshot-id manifest)
              prepared (when execute?
                         (prepare-snapshot-stage!
                          store-root id manifest records))]
          (try
            (let [after-records
                  (into {}
                        (map (fn [role]
                               [role (sealed-log-record! role (get pair role))])
                             ct/roles))]
              (when-not (every? #(exact-record= (get records %)
                                                (get after-records %))
                                ct/roles)
                (ct/fail! "live corpus changed while the snapshot fence was held"))
              (assert-no-rewrite-intent! (:coordination pair))
              ;; This callback never talks to the coordinator.  The corpus and
              ;; maintenance authorities remain held while it proves that the
              ;; exact serving process observed before capture still owns the
              ;; selected socket and runtime artifacts.
              (assert-identities-current! before-identities options)
              (if execute?
                (merge {:ok true :dry-run false :snapshot-id id}
                       (select-keys
                        (publish-snapshot-stage! prepared)
                        [:directory :manifest-path :created :idempotent]))
                {:ok true :dry-run true :snapshot-id id :manifest manifest
                 :would-write (str (io/file (.getCanonicalPath (io/file store))
                                            id))}))
            (finally
              (when (and (:stage prepared)
                         (.exists (io/file (:stage prepared))))
                (discard-owned-stage! prepared)))))))))

(defn- append-records-durable! [path records]
  (with-open [output (java.io.FileOutputStream. (str path) true)]
    (doseq [record records]
      (.write output (canonical-edn-bytes record)))
    (.flush output)
    (.force (.getChannel output) true))
  path)

(defn- restoration-records [snapshot-id watermark preimage-seal]
  (let [subject (str "@snapshot-restore:" (subs snapshot-id 9 25))
        value (str snapshot-id "|" preimage-seal)
        evidence {:snapshot snapshot-id
                  :current-preimage preimage-seal
                  :watermark-tx watermark}
        common {:tx watermark :l subject :p "north_restore_checkpoint" :r value
                :frame (str "north:snapshot-restore:" snapshot-id)
                :by "north:snapshot-restore-plan"
                :restoration evidence}]
    [(assoc common :op "assert")
     ;; The paired retract leaves no live schema/domain fact. The raw canonical
     ;; history still carries an explicit, sealed restoration transaction.
     (assoc common :op "retract")]))

(defn- preimage-descriptors [records]
  (into {}
        (map (fn [role] [role (descriptor role (get records role))]) ct/roles)))

(defn- candidate-manifest
  [{:keys [snapshot-id records current watermark preimage-seal schema runtime
           controller provenance restoration-sha256]}]
  {:format candidate-format
   :source-snapshot snapshot-id
   :files (into {}
                (map (fn [role]
                       [role (payload-descriptor role (get records role))])
                     ct/roles))
   :current-preimage (preimage-descriptors current)
   :restoration {:watermark-tx watermark
                 :preimage-seal preimage-seal
                 :transaction-sha256 restoration-sha256}
   :corpus-max-tx (apply max 0 (map #(get-in records [% :max-tx]) ct/roles))
   :schema schema
   :runtime runtime
   :controller controller
   :creation provenance})

(defn candidate-id [manifest]
  (str "candidate-" (sha256-bytes (canonical-edn-bytes manifest))))

(defn- verify-candidate-object! [store selector]
  (let [directory (resolve-object-directory! (str (store-root! store false)
                                                   "/candidates")
                                              selector candidate-id-pattern
                                              "restore candidate")
        id (.getName (io/file directory))
        {:keys [value]} (read-manifest-exact! directory)]
    (when-not (= (expected-object-entries) (directory-entry-names directory))
      (ct/fail! "restore candidate contains missing or unsealed extra entries"))
    (when-not (= candidate-format (:format value))
      (ct/fail! (str "unsupported restore candidate format: " (:format value))))
    (assert-manifest-identities! value)
    (when-not (re-matches snapshot-id-pattern (str (:source-snapshot value)))
      (ct/fail! "restore candidate lacks an exact source snapshot id"))
    (when-not (= id (candidate-id value))
      (ct/fail! "restore candidate manifest digest does not match its object id"))
    (let [source-snapshot (verify-snapshot-object!
                           store (:source-snapshot value))
          records (into {}
                        (map (fn [role]
                               [role (verify-payload!
                                      directory role (get-in value [:files role]))])
                             ct/roles))]
      (when (same-file? (get-in records [:coordination :path])
                        (get-in records [:telemetry :path]))
        (ct/fail! "restore candidate payloads alias one file"))
      (let [schema (schema-identity-from-paths!
                    (mapv #(get-in records [% :path]) ct/roles))
            max-tx (apply max 0 (map #(get-in records [% :max-tx]) ct/roles))
            watermark (get-in value [:restoration :watermark-tx])
            preimage-seal (get-in value [:restoration :preimage-seal])
            sealed-preimage (canonical-edn-sha256 (:current-preimage value))
            current-max (apply max 0
                               (map #(get-in value [:current-preimage % :max-tx])
                                    ct/roles))
            snapshot-max (get-in source-snapshot [:manifest :corpus-max-tx])
            coord-path (get-in records [:coordination :path])
            marker-ops (vec (take-last 2
                                       (read-raw-records!
                                        "restore candidate coordination corpus"
                                        coord-path)))
            marker-bytes (apply str
                                (map #(String. (canonical-edn-bytes %)
                                               java.nio.charset.StandardCharsets/UTF_8)
                                     marker-ops))]
        (when-not (= schema (:schema value))
          (ct/fail! "restore candidate schema identity does not match payload"))
        (when-not (= max-tx (:corpus-max-tx value) watermark)
          (ct/fail! "restore candidate watermark does not match payload maximum"))
        (doseq [role ct/roles]
          (validate-file-row! role (get-in value [:current-preimage role])))
        (when-not (and (integer? watermark)
                       (> watermark current-max snapshot-max)
                       (string? preimage-seal)
                       (re-matches #"[0-9a-f]{64}" preimage-seal)
                       (= preimage-seal sealed-preimage)
                       (= ["assert" "retract"] (mapv :op marker-ops))
                       (= #{watermark} (set (map :tx marker-ops)))
                       (every? #(= (:source-snapshot value)
                                   (get-in % [:restoration :snapshot]))
                               marker-ops)
                       (every? #(= preimage-seal
                                   (get-in % [:restoration :current-preimage]))
                               marker-ops)
                       (= (sha256-bytes
                           (.getBytes marker-bytes
                                      java.nio.charset.StandardCharsets/UTF_8))
                          (get-in value [:restoration :transaction-sha256])))
          (ct/fail! "restore candidate restoration transaction seal is invalid")))
      (when-not (and
                 (ct/record-prefix-matches?
                  (get-in source-snapshot [:records :coordination])
                  (get-in records [:coordination :path]))
                 (= (select-keys (get-in source-snapshot [:records :telemetry])
                                 [:bytes :sha256 :permissions :append-boundary
                                  :max-tx :ending])
                    (select-keys (get records :telemetry)
                                 [:bytes :sha256 :permissions :append-boundary
                                  :max-tx :ending])))
        (ct/fail! "restore candidate is not an exact snapshot derivative"))
      {:ok true :candidate-id id :directory directory
       :manifest value :records records})))

(defn- build-candidate-stage!
  [{:keys [parent snapshot current runtime controller provenance execute?]}]
  (let [stage-parent (if execute?
                       (canonical-directory! "restore candidate store" parent true)
                       (.getCanonicalPath
                        (.toFile (java.nio.file.Files/createTempDirectory
                                  "north-snapshot-dry-run-"
                                  (make-array java.nio.file.attribute.FileAttribute 0)))))
        owns-parent? (not execute?)
        owned (create-owned-stage! stage-parent "candidate")
        stage (str (:stage owned) "/object")]
    (try
      (when-not (.mkdir (io/file stage))
        (ct/fail! (str "cannot create restore candidate object stage: " stage)))
      (set-posix-permissions! stage ["OWNER_READ" "OWNER_WRITE" "OWNER_EXECUTE"])
      (copy-pair-to-stage! stage (:records snapshot)
                           (into {}
                                 (map (fn [role]
                                        [role (get-in snapshot [:records role :path])])
                                      ct/roles)))
      (let [snapshot-max (get-in snapshot [:manifest :corpus-max-tx])
            current-max (apply max 0 (map #(get-in current [% :max-tx]) ct/roles))
            watermark (inc (max snapshot-max current-max))
            preimage-seal (canonical-edn-sha256 (preimage-descriptors current))
            restoration (restoration-records (:snapshot-id snapshot)
                                             watermark preimage-seal)
            restoration-sha (sha256-bytes
                             (.getBytes
                              (apply str (map #(String. (canonical-edn-bytes %)
                                                        java.nio.charset.StandardCharsets/UTF_8)
                                              restoration))
                              java.nio.charset.StandardCharsets/UTF_8))]
        (append-records-durable! (object-path stage :coordination) restoration)
        (set-posix-permissions! (object-path stage :coordination)
                                (get-in snapshot [:records :coordination :permissions]))
        (ct/fsync-file! (object-path stage :coordination))
        (let [records (into {}
                            (map (fn [role]
                                   [role (sealed-log-record!
                                          role (object-path stage role))])
                                 ct/roles))
              schema (schema-identity-from-paths!
                      (mapv #(get-in records [% :path]) ct/roles))
              manifest (candidate-manifest
                        {:snapshot-id (:snapshot-id snapshot)
                         :records records :current current :watermark watermark
                         :preimage-seal preimage-seal :schema schema
                         :runtime runtime :controller controller
                         :provenance provenance
                         :restoration-sha256 restoration-sha})
              id (candidate-id manifest)]
          (write-manifest! stage manifest)
          (ct/fsync-dir! stage)
          {:id id :stage stage :stage-parent stage-parent :owned owned
           :owns-parent? owns-parent? :manifest manifest :records records
           :watermark watermark :preimage-seal preimage-seal
           :target (str stage-parent "/" id)
           :store (.getCanonicalPath (.getParentFile (io/file stage-parent)))}))
      (catch Throwable error
        (discard-owned-stage! owned)
        (when (and owns-parent? (.exists (io/file stage-parent)))
          (java.nio.file.Files/deleteIfExists (.toPath (io/file stage-parent))))
        (throw error)))))

(defn- discard-candidate-stage! [{:keys [stage-parent owns-parent? owned]}]
  (when (and owned (.exists (io/file (:stage owned))))
    (discard-owned-stage! owned))
  (when (and owns-parent? (.exists (io/file stage-parent)))
    (java.nio.file.Files/deleteIfExists (.toPath (io/file stage-parent))))
  nil)

(defn- publish-candidate! [candidate]
  (let [{:keys [id stage store target manifest]} candidate
        created? (atom false)]
    (if (.exists (io/file target))
      (do
        (discard-candidate-stage! candidate)
        (let [existing (verify-candidate-object! store id)]
          (when-not (= manifest (:manifest existing))
            (ct/fail! (str "immutable restore candidate id collision: " target)))
          (assoc existing :created false :idempotent true)))
      (do
        (try
          (move-new! stage target)
          (reset! created? true)
          (catch java.nio.file.FileAlreadyExistsException _
            (discard-candidate-stage! candidate)))
        (discard-candidate-stage! candidate)
        (let [existing (verify-candidate-object! store id)]
          (when-not (= manifest (:manifest existing))
            (ct/fail! (str "immutable restore candidate race mismatch: " target)))
          (assoc existing :created @created? :idempotent (not @created?)))))))

(defn- make-restore-plan [pair current candidate identities snapshot-id]
  (ct/seal-plan
   {:purpose "restore-from-north-snapshot"
    :created-at (ct/now-iso)
    :live (into {}
                (map (fn [role]
                       [role (assoc (get current role)
                                    :path (get pair role))])
                     ct/roles))
    :candidate
    (into {}
          (map (fn [role]
                 [role (assoc (get-in candidate [:records role])
                              :path (object-path (:target candidate) role))])
               ct/roles))
    :target {:corpus-max-tx (:watermark candidate)
             :coordination-max-tx
             (get-in candidate [:records :coordination :max-tx])
             :telemetry-max-tx
             (get-in candidate [:records :telemetry :max-tx])}
    :runtime {:controller (:controller identities)
              :fram (:runtime identities)}
    :metadata {:snapshot-id snapshot-id
               :candidate-id (:id candidate)
               :current-preimage (:preimage-seal candidate)}}))

(defn- prepare-plan-stage! [store plan]
  (let [parent (canonical-directory! "snapshot plan store"
                                     (str (store-root! store true) "/plans") true)
        payload (canonical-edn-bytes plan)
        target (str parent "/plan-" (sha256-bytes payload) ".edn")]
    (if (.exists (io/file target))
      (do
        (when-not (= (sha256-bytes payload) (ct/sha256-file target))
          (ct/fail! (str "content-addressed plan digest collision: " target)))
        {:parent parent :target target :plan plan :existing? true})
      (let [owned (create-owned-stage! parent "plan")
            staged (str (:stage owned) "/plan.edn")]
        (try
          (ct/write-bytes-durable! staged payload)
          (set-posix-permissions! staged ["OWNER_READ" "OWNER_WRITE"])
          (ct/fsync-file! staged)
          (ct/fsync-dir! (:stage owned))
          (assoc owned :target target :staged staged :plan plan :existing? false)
          (catch Throwable error
            (discard-owned-stage! owned)
            (throw error)))))))

(defn- publish-plan-stage! [prepared]
  (let [{:keys [target staged plan existing?]} prepared
        expected (sha256-bytes (canonical-edn-bytes plan))]
    (try
      (when-not existing?
        (try
          (move-new! staged target)
          (catch java.nio.file.FileAlreadyExistsException _ nil)))
      (when-not (= expected (ct/sha256-file target))
        (ct/fail! (str "content-addressed plan race mismatch: " target)))
      (ct/artifact-record target)
      (finally
        (when (:stage prepared)
          (discard-owned-stage! prepared))))))

(defn- restore-plan-under-fence!
  [{:keys [store provenance execute?] :as options} snapshot pair identities]
  (assert-no-rewrite-intent! (:coordination pair))
  (let [store-root (when execute? (store-root! store true))
        candidate-parent (if execute?
                           (canonical-directory! "restore candidate store"
                                                 (str store-root "/candidates") true)
                           (str (io/file (.getCanonicalPath (io/file store))
                                         "candidates")))
        _ (when execute?
            (scavenge-owned-stages! candidate-parent "candidate")
            (scavenge-owned-stages!
             (canonical-directory! "snapshot plan store"
                                   (str store-root "/plans") true)
             "plan"))
        current (into {}
                      (map (fn [role]
                             [role (sealed-log-record! role (get pair role))])
                           ct/roles))
        candidate (build-candidate-stage!
                   {:parent candidate-parent
                    :snapshot snapshot :current current
                    :runtime (:runtime identities)
                    :controller (:controller identities)
                    :provenance provenance :execute? execute?})
        plan (make-restore-plan pair current candidate identities
                                (:snapshot-id snapshot))
        prepared-plan (when execute? (prepare-plan-stage! store-root plan))
        after-current (into {}
                            (map (fn [role]
                                   [role (sealed-log-record! role (get pair role))])
                                 ct/roles))]
    (try
      (when-not (every? #(exact-record= (get current %) (get after-current %))
                        ct/roles)
        (ct/fail! "live corpus changed during restore planning"))
      (assert-no-rewrite-intent! (:coordination pair))
      ;; Candidate and plan bytes are both complete but still hidden here.
      ;; Losing the serving-process or controller authority therefore publishes
      ;; neither object.
      (assert-identities-current! identities options)
      (if-not execute?
        {:ok true :dry-run true :snapshot-id (:snapshot-id snapshot)
         :candidate-id (:id candidate)
         :watermark-tx (:watermark candidate)
         :current-preimage (:preimage-seal candidate)
         :plan-preview plan}
        (let [published (publish-candidate! candidate)
              plan-artifact (publish-plan-stage! prepared-plan)
              verified-plan (ct/verify-plan!
                             plan {:coordination (:coordination pair)
                                   :telemetry (:telemetry pair)})]
          {:ok true :dry-run false
           :snapshot-id (:snapshot-id snapshot)
           :candidate-id (:candidate-id published)
           :candidate-directory (:directory published)
           :watermark-tx (:watermark candidate)
           :current-preimage (:preimage-seal candidate)
           :plan-id (:plan-id verified-plan)
           :plan-path (:path plan-artifact)}))
      (finally
        (when (and (:owned candidate)
                   (.exists (io/file (get-in candidate [:owned :stage]))))
          (discard-candidate-stage! candidate))
        (when (and prepared-plan (:stage prepared-plan)
                   (.exists (io/file (:stage prepared-plan))))
          (discard-owned-stage! prepared-plan))))))

(defn restore-plan!
  [{:keys [live] :as options}]
  (ct/with-maintenance-lock
    (let [snapshot (verify-snapshot! options)
          pair (live-pair! live)
          identities (:identities snapshot)]
      (assert-no-rewrite-intent! (:coordination pair))
      (ct/with-offline-fences pair
        (restore-plan-under-fence! options snapshot pair identities)))))
