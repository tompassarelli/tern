(ns north.schema-candidate
  "Owned mutable workspaces and immutable finalized objects for schema builds.

  A workspace is an exact, distinct clone of a verified snapshot object. It is
  never itself an installable artifact. Only a converged build can publish a
  content-addressed finalized candidate, and every verification re-establishes
  the source snapshot from its immutable store. A manifest pathname is the
  last publication marker, but only a successful `verify-finalized!` grants
  consumable authority; filename presence alone never does."
  (:require [babashka.process :as proc]
            [cheshire.core :as json]
            [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.set :as set]
            [clojure.string :as str]
            [fram.fold :as fold]
            [north.corpus-transaction :as ct]
            [north.runtime-attestation :as runtime-attestation]
            [north.snapshot :as snapshot]))

(def workspace-format "north-schema-workspace/v1")
(def built-seal-format "north-schema-built-seal/v1")
(def finalized-format "north-schema-finalized-candidate/v1")
(def owned-stage-format "north-schema-owned-stage/v1")
(def workspace-id-pattern
  #"schema-workspace-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
(def finalized-id-pattern #"schema-candidate-[0-9a-f]{64}")
(def finalized-manifest-name-pattern
  #"schema-candidate-[0-9a-f]{64}\.edn")
(def finalized-payload-name-pattern
  #"schema-payload-(coordination|telemetry)-[0-9a-f]{64}\.log")
(def built-seal-name-pattern #"built-[0-9a-f]{64}\.edn")
(def owned-stage-name-pattern
  #"^\.schema-(workspace|candidate)-stage-v1\.([1-9][0-9]*)\.proc-([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$")
(def object-names {:coordination "coordination.log"
                   :telemetry "telemetry.log"})
(def workspace-runtime-entry-names
  #{".fram.rewrite.lock" "runtime.identity"})
(def sealed-payload-fields
  [:bytes :sha256 :permissions :append-boundary :max-tx :ending])
(def finalized-file-permissions
  ["GROUP_READ" "OTHERS_READ" "OWNER_READ"])
(def ^:private finalized-file-mode 292)
(def ^:private regular-file-kind 32768)
(def ^:private permission-bits
  [[256 "OWNER_READ"] [128 "OWNER_WRITE"] [64 "OWNER_EXECUTE"]
   [32 "GROUP_READ"] [16 "GROUP_WRITE"] [8 "GROUP_EXECUTE"]
   [4 "OTHERS_READ"] [2 "OTHERS_WRITE"] [1 "OTHERS_EXECUTE"]])
(def no-follow
  (into-array java.nio.file.LinkOption
              [java.nio.file.LinkOption/NOFOLLOW_LINKS]))
(def schema-candidate-source
  (.getCanonicalPath
   (io/file (or *file* (System/getProperty "babashka.file")))))

(defn- mode-permissions [mode]
  (->> permission-bits
       (keep (fn [[bit label]]
               (when-not (zero? (bit-and (long mode) bit)) label)))
       sort
       vec))

(defn- fail! [message data]
  (throw (ex-info message data)))

(defn- configured-path? [path]
  (and (string? path) (not (str/blank? path))))

(defn- required! [value option]
  (when-not (configured-path? value)
    (fail! (str option " is required")
           {:type :schema-option-required :option option}))
  value)

(defn canonical-edn-bytes [value]
  (snapshot/canonical-edn-bytes value))

(defn- sha256-bytes [^bytes payload]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        payload)]
    (apply str (map #(format "%02x" %) digest))))

(defn- canonical-edn-sha256 [value]
  (sha256-bytes (canonical-edn-bytes value)))

(defn- set-permissions! [path permissions]
  (java.nio.file.Files/setPosixFilePermissions
   (.toPath (io/file path))
   (java.util.HashSet.
    ^java.util.Collection
    (mapv java.nio.file.attribute.PosixFilePermission/valueOf permissions)))
  path)

(defn- nio-path [path]
  (if (instance? java.nio.file.Path path)
    path
    (.toPath (io/file path))))

(defn- permissions [path]
  (->> (java.nio.file.Files/getPosixFilePermissions
        (nio-path path) no-follow)
       (map str)
       sort
       vec))

(defn- owner [path]
  (java.nio.file.Files/getOwner (nio-path path) no-follow))

(defn- attributes [path]
  (java.nio.file.Files/readAttributes
   (nio-path path)
   java.nio.file.attribute.BasicFileAttributes no-follow))

(defn- fd-identity [path]
  (let [values (java.nio.file.Files/readAttributes
                (nio-path path) "unix:dev,ino,uid,mode" no-follow)
        mode (long (get values "mode"))]
    {:dev (long (get values "dev"))
     :ino (long (get values "ino"))
     :uid (long (get values "uid"))
     :mode (bit-and mode 4095)
     :kind (bit-and mode 61440)}))

(defn file-fd-identity! [path]
  (fd-identity path))

(defn- link-count [path]
  (long (java.nio.file.Files/getAttribute
         (nio-path path) "unix:nlink" no-follow)))

(defn- force-directory! [directory]
  (ct/fsync-dir! directory)
  directory)

(defn- force-readable-file! [path]
  (with-open [channel
              (java.nio.channels.FileChannel/open
               (nio-path path)
               (into-array java.nio.file.OpenOption
                           [java.nio.file.StandardOpenOption/READ]))]
    (.force channel true))
  path)

(defn- safe-directory! [label path create?]
  (required! path (str label " path"))
  (let [file (io/file path)
        nio (.toPath file)]
    (when (and (java.nio.file.Files/exists nio no-follow)
               (java.nio.file.Files/isSymbolicLink nio))
      (fail! (str label " must not be a symbolic link")
             {:type :schema-directory-invalid :path path}))
    (when (and create? (not (.exists file)) (not (.mkdirs file)))
      (fail! (str "cannot create " label)
             {:type :schema-directory-unavailable :path path}))
    (when-not (.isDirectory file)
      (fail! (str label " is not a directory")
             {:type :schema-directory-invalid :path path}))
    (.getCanonicalPath file)))

(defn- entry-names [directory]
  (set (map #(.getName ^java.io.File %)
            (or (.listFiles (io/file directory))
                (make-array java.io.File 0)))))

(declare channel-bytes!)

(defn- read-canonical-edn! [label path]
  (let [raw (.normalize (.toAbsolutePath (nio-path path)))
        canonical (.toPath (.getCanonicalFile (.toFile raw)))
        before (attributes raw)
        before-permissions (permissions raw)
        before-links (link-count raw)]
    (when-not (and (= raw canonical)
                   (not (java.nio.file.Files/isSymbolicLink raw))
                   (.isRegularFile before) (.fileKey before)
                   (= 1 before-links))
      (fail! (str label " is not an unaliased regular file")
             {:type :schema-manifest-invalid :path (str raw)
              :links before-links}))
    (with-open [channel
                (java.nio.channels.FileChannel/open
                 raw
                 (into-array java.nio.file.OpenOption
                             [java.nio.file.StandardOpenOption/READ
                              java.nio.file.LinkOption/NOFOLLOW_LINKS]))]
      (let [first-read (channel-bytes! channel (.size before))
            second-read (channel-bytes! channel (.size before))
            after (attributes raw)]
        (when-not (and (java.util.Arrays/equals first-read second-read)
                       (= (str (.fileKey before)) (str (.fileKey after)))
                       (= (.size before) (.size after) (.size channel))
                       (= (.lastModifiedTime before) (.lastModifiedTime after))
                       (= before-permissions (permissions raw))
                       (= before-links (link-count raw) 1))
          (fail! (str label " changed during its pinned read")
                 {:type :schema-manifest-raced :path (str raw)}))
        (let [value (try
                      (edn/read-string
                       (String. first-read
                                java.nio.charset.StandardCharsets/UTF_8))
                      (catch Throwable error
                        (fail! (str label " contains invalid EDN")
                               {:type :schema-manifest-invalid
                                :path (str raw)
                                :cause (.getMessage error)})))]
          (when-not (java.util.Arrays/equals
                     ^bytes first-read ^bytes (canonical-edn-bytes value))
            (fail! (str label " is not canonical sealed EDN")
                   {:type :schema-manifest-noncanonical :path (str raw)}))
          {:path (str raw) :value value :sha256 (sha256-bytes first-read)
           :file-key (str (.fileKey after)) :owner (str (owner raw))
           :permissions before-permissions :links before-links})))))

(defn process-owner-state [{:keys [pid pid-birth]}]
  (try
    (let [optional (java.lang.ProcessHandle/of (long pid))]
      (if-not (.isPresent optional)
        :dead
        (let [handle (.get optional)]
          (if-not (.isAlive handle)
            :dead
            (let [actual (runtime-attestation/process-birth-token pid)]
              (cond
                (nil? actual) :ambiguous
                (= pid-birth actual) :live
                :else :dead))))))
    (catch Throwable _ :ambiguous)))

(defn current-process-owner! []
  (let [pid (.pid (java.lang.ProcessHandle/current))
        birth (runtime-attestation/process-birth-token pid)]
    (when-not (and (pos-int? pid)
                   (string? birth)
                   (re-matches #"proc:[1-9][0-9]*" birth))
      (fail! "cannot establish schema-stage process ownership"
             {:type :schema-stage-owner-unavailable
              :pid pid :pid-birth birth}))
    {:pid pid :pid-birth birth}))

(defn- stage-name-parts [file]
  (when-let [[_ kind pid ticks nonce]
             (re-matches owned-stage-name-pattern (.getName (io/file file)))]
    {:kind kind :pid (parse-long pid) :pid-birth (str "proc:" ticks)
     :nonce nonce}))

(defn- stage-marker [stage]
  {:format owned-stage-format
   :kind (:kind stage)
   :owner "north.schema-candidate"
   :pid (:pid stage)
   :pid-birth (:pid-birth stage)
   :nonce (:nonce stage)})

(defn- marker-path [stage]
  (str (:path stage) "/.north-schema-stage.edn"))

(defn- assert-stage-shell! [parent candidate kind]
  (let [parent (.getCanonicalPath (io/file parent))
        file (io/file candidate)
        path (.toPath file)
        parts (stage-name-parts file)
        attrs (try (attributes path)
                   (catch Throwable _ nil))]
    (when-not (and parts
                   (= kind (:kind parts))
                   (= parent (.getCanonicalPath (.getParentFile file)))
                   attrs (.isDirectory attrs)
                   (not (java.nio.file.Files/isSymbolicLink path))
                   (= ["OWNER_EXECUTE" "OWNER_READ" "OWNER_WRITE"]
                      (permissions path))
                   (= (owner parent) (owner path))
                   (.fileKey attrs))
      (fail! "matching schema stage lacks exact ownership shell"
             {:type :schema-stage-ownership-invalid
              :path (.getAbsolutePath file) :expected-kind kind}))
    (assoc parts :parent parent :path (.getCanonicalPath file)
           :file-key (str (.fileKey attrs))
           :owner (str (owner path))
           :permissions (permissions path)
           :fd-identity (fd-identity path))))

(defn- assert-owned-stage! [parent candidate kind]
  (let [stage (assert-stage-shell! parent candidate kind)
        marker (read-canonical-edn! "schema stage ownership marker"
                                    (marker-path stage))]
    (when-not (and (= (stage-marker stage) (:value marker))
                   (= ["OWNER_READ" "OWNER_WRITE"] (:permissions marker))
                   (= (:owner stage) (:owner marker))
                   (= 1 (link-count (:path marker))))
      (fail! "schema stage ownership marker is invalid"
             {:type :schema-stage-ownership-invalid :path (:path stage)}))
    (assoc stage :marker-file-key (:file-key marker)
           :marker-fd-identity (fd-identity (:path marker)))))

(defn- same-stage! [expected]
  (let [actual (assert-owned-stage! (:parent expected) (:path expected)
                                    (:kind expected))]
    (when-not (= (select-keys expected
                             [:kind :pid :pid-birth :nonce :file-key
                              :marker-file-key :owner :permissions
                              :fd-identity :marker-fd-identity])
                 (select-keys actual
                             [:kind :pid :pid-birth :nonce :file-key
                              :marker-file-key :owner :permissions
                              :fd-identity :marker-fd-identity]))
      (fail! "schema stage identity changed before retained inspection"
             {:type :schema-stage-ownership-invalid
              :expected expected :actual actual}))
    actual))

(defn- stage-io-interpreter! []
  (let [path (System/getenv "NORTH_SCHEMA_STAGE_PYTHON")
        selected (when path (io/file path))
        file (when (and selected (.isAbsolute selected))
               (.getCanonicalFile selected))]
    (when-not (and (configured-path? path)
                   selected (.isAbsolute selected)
                   file (.isFile file) (.canExecute file)
                   (str/starts-with? (.getPath file) "/nix/store/")
                   (not (java.nio.file.Files/isSymbolicLink (.toPath file))))
      (fail! "schema-stage FD operations require an exact packaged Python runtime"
             {:type :schema-stage-io-runtime-unavailable
              :selector path}))
    (.getCanonicalPath file)))

(defn- stage-io-helper! []
  (let [helper (io/file (.getParentFile (io/file schema-candidate-source))
                        "schema-stage-io.py")]
    (when-not (and (.isFile helper) (.canRead helper)
                   (not (java.nio.file.Files/isSymbolicLink (.toPath helper))))
      (fail! "schema-stage FD helper is missing"
             {:type :schema-stage-io-runtime-unavailable
              :path (.getAbsolutePath helper)}))
    (.getCanonicalPath helper)))

(defn run-stage-io-helper!
  ([arguments] (run-stage-io-helper! arguments nil))
  ([arguments input]
  (let [command (into [(stage-io-interpreter!) (stage-io-helper!)] arguments)
        process-options (cond-> {:out :string :err :string}
                          (some? input) (assoc :in input))
        process (apply proc/process process-options command)
        result @process]
    (when-not (zero? (:exit result))
      (fail! "race-safe schema owned-file helper refused the operation"
             {:type :schema-owned-file-helper-refused
              :exit (:exit result) :error (str/trim (:err result))}))
    (let [response (try (json/parse-string (:out result) true)
                        (catch Throwable _ nil))]
      (when-not (= true (:ok response))
        (fail! "schema owned-file helper returned invalid evidence"
               {:type :schema-owned-file-helper-refused
                :response response}))
      response))))

(defn- byte-index [^bytes payload value]
  (loop [index 0]
    (cond
      (= index (alength payload)) nil
      (= value (aget payload index)) index
      :else (recur (inc index)))))

(defn run-stage-io-reader! [arguments]
  (let [command (into [(stage-io-interpreter!) (stage-io-helper!)] arguments)
        process (apply proc/process {:out :bytes :err :string} command)
        result @process]
    (when-not (zero? (:exit result))
      (fail! "race-safe schema object reader refused the operation"
             {:type :schema-owned-file-helper-refused
              :exit (:exit result) :error (str/trim (:err result))}))
    (let [raw ^bytes (:out result)
          separator (byte-index raw 10)]
      (when-not separator
        (fail! "schema object reader returned no evidence envelope"
               {:type :schema-owned-file-helper-refused}))
      (let [header
            (try
              (json/parse-string
               (String. raw 0 separator
                        java.nio.charset.StandardCharsets/UTF_8)
               true)
              (catch Throwable _ nil))
            payload (java.util.Arrays/copyOfRange
                     raw (inc separator) (alength raw))]
        (when-not (and (= true (:ok header))
                       (= (alength payload) (:bytes header))
                       (= (sha256-bytes payload) (:sha256 header)))
          (fail! "schema object reader returned invalid byte evidence"
                 {:type :schema-owned-file-helper-refused
                  :header header}))
        (assoc header :payload payload)))))

(defn- retain-stage! [expected]
  (let [stage (same-stage! expected)
        response
        (run-stage-io-helper!
         ["inspect-retained-stage" (:parent stage)
          (.getName (io/file (:path stage))) (:kind stage)
          (json/generate-string (:fd-identity stage))
          (json/generate-string (:marker-fd-identity stage))])]
    (when-not (and (= (.getName (io/file (:path stage)))
                      (:retained response))
                   (.exists (io/file (:path stage))))
      (fail! "schema-stage retention helper returned invalid evidence"
             {:type :schema-stage-retention-refused
              :stage (:path stage) :response response}))
    nil))
(defn inspect-retained-owned-stages! [parent kind]
  (let [parent (safe-directory! (str "schema " kind " staging parent")
                                parent true)
        prefix (str ".schema-" kind "-stage-v1.")
        candidates (->> (or (.listFiles (io/file parent))
                            (make-array java.io.File 0))
                        (filter #(str/starts-with? (.getName ^java.io.File %)
                                                  prefix))
                        (sort-by #(.getName ^java.io.File %)))]
    (reduce
     (fn [inspected candidate]
       (let [stage (assert-owned-stage! parent candidate kind)]
         (case (process-owner-state stage)
           :live inspected
           :ambiguous
           (fail! "schema stage owner process identity is ambiguous"
                  {:type :schema-stage-owner-ambiguous
                   :path (:path stage) :pid (:pid stage)
                   :pid-birth (:pid-birth stage)})
           :dead
           (do (retain-stage! stage) (inc inspected)))))
     0 candidates)))

(defn- create-stage! [parent kind]
  (let [parent (safe-directory! (str "schema " kind " staging parent")
                                parent true)
        {:keys [pid pid-birth]} (current-process-owner!)
        nonce (str (java.util.UUID/randomUUID))
        draft-path (str parent "/.schema-stage-bootstrap." nonce ".tmp")
        stage-path (str parent "/.schema-" kind "-stage-v1."
                        pid ".proc-" (subs pid-birth 5) "." nonce ".tmp")
        stage {:parent parent :path draft-path :kind kind :pid pid
               :pid-birth pid-birth :nonce nonce}
        mode (java.nio.file.attribute.PosixFilePermissions/asFileAttribute
              (java.util.HashSet.
               ^java.util.Collection
               [java.nio.file.attribute.PosixFilePermission/OWNER_READ
                java.nio.file.attribute.PosixFilePermission/OWNER_WRITE
                java.nio.file.attribute.PosixFilePermission/OWNER_EXECUTE]))]
    ;; The retained-stage inspector recognizes only the final name. Publish it
    ;; after the exact ownership marker is durable, so no partial shell can be
    ;; mistaken for a dead stage owned by North.
    (java.nio.file.Files/createDirectory
     (.toPath (io/file draft-path))
     (into-array java.nio.file.attribute.FileAttribute [mode]))
    (try
      (ct/write-bytes-durable! (marker-path stage)
                               (canonical-edn-bytes (stage-marker stage)))
      (set-permissions! (marker-path stage) ["OWNER_READ" "OWNER_WRITE"])
      (ct/fsync-file! (marker-path stage))
      (force-directory! draft-path)
      (java.nio.file.Files/move
       (.toPath (io/file draft-path)) (.toPath (io/file stage-path))
       (make-array java.nio.file.CopyOption 0))
      (force-directory! parent)
      (assert-owned-stage! parent stage-path kind)
      (catch Throwable error
        ;; An unpublished bootstrap name is deliberately outside inspector
        ;; authority. Leaving it is safer than guessing ownership after a
        ;; partial marker failure; it never blocks recognized-stage work.
        (throw error)))))

(defn- discard-stage! [stage]
  (when (.exists (io/file (:path stage)))
    (retain-stage! stage))
  nil)

(defn- portable-payload [role record]
  (assoc (select-keys record sealed-payload-fields)
         :object_name (get object-names role)))

(defn finalized-payload-name [role sha256]
  (str "schema-payload-" (name role) "-" sha256 ".log"))

(defn- finalized-portable-payload [role record]
  (assoc (select-keys record
                      [:bytes :sha256 :append-boundary :max-tx :ending])
         :permissions finalized-file-permissions
         :object_name (finalized-payload-name role (:sha256 record))))

(defn snapshot-provenance [verified]
  (let [manifest (:manifest verified)]
    {:snapshot_id (:snapshot-id verified)
     :format (:format manifest)
     :manifest_sha256 (canonical-edn-sha256 manifest)
     :payloads
     (into {}
           (map (fn [role]
                  [role (portable-payload role (get-in verified [:records role]))])
                ct/roles))
     :schema (:schema manifest)
     :corpus_max_tx (:corpus-max-tx manifest)
     :creation (:creation manifest)
     :capture_runtime (:runtime manifest)
     :capture_controller (:controller manifest)}))

(defn verify-source! [store selector]
  (let [verified (snapshot/verify-snapshot-object!
                  (required! store "--snapshot-store")
                  (required! selector "--source-snapshot"))]
    (assoc verified :provenance (snapshot-provenance verified))))

(defn reverify-source! [store selector expected]
  (let [actual (verify-source! store selector)]
    (when-not (= (:provenance expected) (:provenance actual))
      (fail! "source snapshot identity changed during schema candidate construction"
             {:type :schema-source-snapshot-drift
              :expected (:provenance expected)
              :actual (:provenance actual)}))
    actual))

(defn- channel-bytes! [^java.nio.channels.FileChannel channel size]
  (when (> size Integer/MAX_VALUE)
    (fail! "schema candidate payload exceeds the pinned reader limit"
           {:type :schema-candidate-payload-too-large :bytes size}))
  (.position channel 0)
  (let [payload (byte-array (int size))
        buffer (java.nio.ByteBuffer/wrap payload)]
    (loop []
      (when (.hasRemaining buffer)
        (let [read (.read channel buffer)]
          (when (neg? read)
            (fail! "schema candidate payload shortened during pinned read"
                   {:type :schema-candidate-payload-raced}))
          (recur))))
    payload))

(defn- parse-payload-ops! [role path ^bytes payload]
  (let [length (alength payload)]
    (when (and (pos? length) (not= 10 (aget payload (dec length))))
      (fail! "schema candidate payload lacks its append boundary"
             {:type :schema-candidate-payload-invalid :role role :path path}))
    (try
      (->> (str/split (String. payload java.nio.charset.StandardCharsets/UTF_8)
                      #"\n")
           (remove str/blank?)
           (mapv (fn [line]
                   (let [row (edn/read-string line)]
                     (when-not (map? row)
                       (fail! "schema candidate payload contains a non-map row"
                              {:type :schema-candidate-payload-invalid
                               :role role :path path}))
                     (fold/->FactOp (:tx row) (:op row) (:l row) (:p row) (:r row)
                                    (or (:frame row) (:by row) "legacy"))))))
      (catch clojure.lang.ExceptionInfo error (throw error))
      (catch Throwable error
        (fail! "schema candidate payload contains invalid EDN"
               {:type :schema-candidate-payload-invalid
                :role role :path path :cause (.getMessage error)})))))

(defn- pinned-object-bytes! [parent-path name expected-parent]
  (let [expected-argument
        (if expected-parent (json/generate-string expected-parent) "-")
        result (run-stage-io-reader!
                ["read-object" parent-path name expected-argument])
        state (:file_state result)
        parent (:parent_identity result)]
    (when-not (and (= name (:target result))
                   (= regular-file-kind (get-in result [:identity :kind]))
                   (= 1 (:nlink state))
                   (= (:uid parent) (get-in result [:identity :uid]))
                   (or (nil? expected-parent) (= expected-parent parent)))
      (fail! "schema object lacks exact pinned representation"
             {:type :schema-owned-object-invalid
              :target name :evidence (dissoc result :payload)}))
    result))

(defn- pinned-finalized-bytes! [store name expected-parent]
  (let [result (pinned-object-bytes! store name expected-parent)]
    (when-not (= finalized-file-mode (get-in result [:identity :mode]))
      (fail! "finalized schema object is not read-only"
             {:type :final-schema-candidate-invalid
              :target name :evidence (dissoc result :payload)}))
    result))

(defn- read-pinned-canonical-edn!
  [label parent-path name expected-parent finalized?]
  (let [record ((if finalized?
                  pinned-finalized-bytes!
                  pinned-object-bytes!)
                parent-path name expected-parent)
        payload ^bytes (:payload record)
        path (str parent-path "/" name)
        value
        (try
          (edn/read-string
           (String. payload java.nio.charset.StandardCharsets/UTF_8))
          (catch Throwable error
            (fail! (str label " contains invalid EDN")
                   {:type :schema-manifest-invalid :path path
                    :cause (.getMessage error)})))]
    (when-not (java.util.Arrays/equals
               payload ^bytes (canonical-edn-bytes value))
      (fail! (str label " is not canonical sealed EDN")
             {:type :schema-manifest-noncanonical :path path}))
    {:path path :value value :sha256 (:sha256 record)
     :file-key (str (get-in record [:identity :dev]) ":"
                    (get-in record [:identity :ino]))
     :fd-identity (:identity record)
     :parent-identity (:parent_identity record)
     :uid (get-in record [:identity :uid])
     :permissions (mode-permissions (get-in record [:identity :mode]))
     :links 1}))

(defn- read-finalized-canonical-edn! [store name expected-parent]
  (read-pinned-canonical-edn!
   "finalized schema candidate manifest"
   store name expected-parent true))

(defn- pinned-payload-record!
  [parent-path role name expected-parent finalized?]
  (let [record ((if finalized?
                  pinned-finalized-bytes!
                  pinned-object-bytes!)
                parent-path name expected-parent)
        payload ^bytes (:payload record)
        path (str parent-path "/" name)
        ops (parse-payload-ops! role path payload)]
    {:path path
     :bytes (alength payload)
     :sha256 (:sha256 record)
     :permissions (mode-permissions (get-in record [:identity :mode]))
     :append-boundary ct/append-boundary
     :max-tx (fold/max-tx ops)
     :ending (if (zero? (alength payload)) "zero-byte" "terminal-lf")
     :file_key (str (get-in record [:identity :dev]) ":"
                    (get-in record [:identity :ino]))
     :fd-identity (:identity record)
     :parent-identity (:parent_identity record)
     :uid (get-in record [:identity :uid])
     :links 1
     :ops ops}))

(defn- finalized-payload-record! [store role name expected-parent]
  (pinned-payload-record! store role name expected-parent true))

(defn- records!
  ([directory] (records! directory nil))
  ([directory expected-parent]
   (reduce
    (fn [records role]
      (let [parent (or expected-parent
                       (get-in records [:coordination :parent-identity]))
            record (pinned-payload-record!
                    directory role (get object-names role) parent false)]
        (assoc records role record)))
    {} ct/roles)))

(defn- same-file? [left right]
  (try
    (java.nio.file.Files/isSameFile (.toPath (io/file left))
                                    (.toPath (io/file right)))
    (catch Throwable _ false)))

(defn- copy-payload! [source target permissions]
  (java.nio.file.Files/copy
   (.toPath (io/file source)) (.toPath (io/file target))
   (into-array java.nio.file.CopyOption
               [java.nio.file.StandardCopyOption/COPY_ATTRIBUTES]))
  ;; COPY_ATTRIBUTES can preserve a read-only source mode. Make the private
  ;; copy writable only long enough to durably flush its bytes, then apply and
  ;; flush the requested terminal mode.
  (set-permissions! target
                    (vec (sort (conj (set permissions) "OWNER_WRITE"))))
  (ct/fsync-file! target)
  (set-permissions! target permissions)
  (force-readable-file! target)
  target)

(defn- resolve-owned-object! [root selector pattern label]
  (let [root (safe-directory! (str label " root") root false)
        selected (required! selector (str "--" label))
        raw (io/file (if (re-matches pattern selected)
                       (str root "/" selected)
                       selected))
        nio (.toPath raw)]
    (when (java.nio.file.Files/isSymbolicLink nio)
      (fail! (str label " must not be a symbolic link")
             {:type :schema-owned-object-invalid
              :label label :path (.getAbsolutePath raw)}))
    (when-not (and (.isDirectory raw)
                   (= root (.getCanonicalPath (.getParentFile raw)))
                   (re-matches pattern (.getName raw)))
      (fail! (str label " is not an immediate owned object")
             {:type :schema-owned-object-invalid
              :label label :root root :path (.getAbsolutePath raw)}))
    (.getCanonicalPath raw)))

(defn- workspace-path! [root selector]
  (resolve-owned-object! root selector workspace-id-pattern "workspace"))

(defn- assert-object-shell! [root directory expected-permissions label]
  (let [root (safe-directory! (str label " root") root false)
        raw (.normalize (.toAbsolutePath (.toPath (io/file directory))))
        canonical (.toPath (.getCanonicalFile (.toFile raw)))
        attrs (attributes raw)
        fd-identity (fd-identity raw)
        shell {:file-key (str (.fileKey attrs))
               :owner (str (owner raw))
               :uid (:uid fd-identity)
               :fd-identity fd-identity
               :permissions (permissions raw)}]
    (when-not (and (= raw canonical)
                   (.isDirectory attrs) (.fileKey attrs)
                   (not (java.nio.file.Files/isSymbolicLink raw))
                   (= expected-permissions (:permissions shell))
                   (= (str (owner root)) (:owner shell)))
      (fail! (str label " ownership or mode is invalid")
             {:type :schema-owned-object-invalid :label label
              :directory directory :actual shell}))
    shell))

(defn- exact-keys? [value expected]
  (and (map? value) (= expected (set (keys value)))))

(defn- verify-workspace-from-source!
  [{:keys [workspace-root workspace source repair-manifest-sha256]}]
  (when-not (and (map? source) (:provenance source))
    (fail! "verified source snapshot is required"
           {:type :schema-source-snapshot-required}))
  (when-not (re-matches #"[0-9a-f]{64}" (str repair-manifest-sha256))
    (fail! "repair manifest seal is invalid"
           {:type :schema-repair-manifest-seal-invalid}))
  (let [directory (workspace-path! workspace-root workspace)
        shell (assert-object-shell!
               workspace-root directory
               ["OWNER_EXECUTE" "OWNER_READ" "OWNER_WRITE"] "workspace")
        required #{"workspace.edn" "coordination.log" "telemetry.log"}
        entries (entry-names directory)
        built-entries (set (filter #(re-matches built-seal-name-pattern %)
                                   entries))
        runtime-entries (set/intersection entries
                                          workspace-runtime-entry-names)]
    (when-not (and (set/subset? required entries)
                   (= entries (set/union required built-entries
                                         runtime-entries))
                   (<= (count built-entries) 1))
      (fail! "schema workspace contains missing or unowned entries"
             {:type :schema-workspace-invalid :directory directory
              :entries entries}))
    ;; These are the only runtime-created files admitted beside the sealed
    ;; workspace payloads. They never enter the finalized candidate. Keep the
    ;; admission exact so a daemon cannot turn the mutable workspace into a
    ;; general-purpose staging directory.
    (doseq [name runtime-entries]
      (let [path (str directory "/" name)
            attrs (attributes path)
            actual-permissions (permissions path)]
        (when-not (and (.isRegularFile attrs)
                       (.fileKey attrs)
                       (not (java.nio.file.Files/isSymbolicLink
                             (nio-path path)))
                       (= 1 (link-count path))
                       (= (:owner shell) (str (owner path)))
                       (contains?
                        #{["GROUP_READ" "OTHERS_READ" "OWNER_READ"
                           "OWNER_WRITE"]
                          ["OWNER_READ" "OWNER_WRITE"]}
                        actual-permissions))
          (fail! "schema workspace runtime artifact is not an owned regular file"
                 {:type :schema-workspace-runtime-artifact-invalid
                  :path path :permissions actual-permissions}))))
    (let [manifest-record
          (read-pinned-canonical-edn!
           "schema workspace manifest" directory "workspace.edn"
           (:fd-identity shell) false)
          manifest (:value manifest-record)
          id (.getName (io/file directory))
          workspace-records (records! directory (:fd-identity shell))
          source-records (:records source)]
      (when-not (and (exact-keys?
                      manifest
                      #{:format :workspace_id :state :source_snapshot
                        :repair_manifest_sha256 :created_by :files})
                     (exact-keys? (:created_by manifest)
                                  #{:pid :pid_birth :nonce})
                     (integer? (get-in manifest [:created_by :pid]))
                     (string? (get-in manifest [:created_by :pid_birth]))
                     (string? (get-in manifest [:created_by :nonce]))
                     (= ["OWNER_READ"] (:permissions manifest-record))
                     (= 1 (:links manifest-record))
                     (= (:uid shell) (:uid manifest-record))
                     (= workspace-format (:format manifest))
                     (= id (:workspace_id manifest))
                     (= "prepared" (:state manifest))
                     (= (:provenance source) (:source_snapshot manifest))
                     (= repair-manifest-sha256
                        (:repair_manifest_sha256 manifest))
                     (= (into {}
                              (map (fn [role]
                                     [role (portable-payload
                                            role (get source-records role))])
                                   ct/roles))
                        (:files manifest)))
        (fail! "schema workspace manifest does not bind this exact source"
               {:type :schema-workspace-manifest-mismatch :workspace id}))
      (doseq [role ct/roles]
        (let [workspace-record (get workspace-records role)
              source-record (get source-records role)]
          (when (or (not= (:uid shell) (:uid workspace-record))
                    (same-file? (:path workspace-record) (:path source-record)))
            (fail! "schema workspace does not own a distinct payload"
                   {:type :schema-workspace-source-mismatch :role role
                    :workspace (select-keys workspace-record
                                            (conj sealed-payload-fields :path))
                    :snapshot (select-keys source-record
                                           (conj sealed-payload-fields :path))}))))
      {:workspace_id id :directory directory
       :manifest_path (:path manifest-record)
       :manifest_sha256 (:sha256 manifest-record)
       :manifest manifest :records workspace-records
       :parent_identity (:fd-identity shell)
       :origin_files (:files manifest)
       :built_seal_path (when-let [name (first built-entries)]
                          (str directory "/" name))
       :paths (mapv #(get-in workspace-records [% :path]) ct/roles)})))

(defn verify-origin!
  [{:keys [snapshot-store source-snapshot] :as options}]
  (let [source (verify-source! snapshot-store source-snapshot)]
    (assoc (verify-workspace-from-source! (assoc options :source source))
           :source source)))

(defn current-matches-origin? [workspace]
  (= (:origin_files workspace)
     (into {}
           (map (fn [role]
                  [role (portable-payload role (get-in workspace
                                                       [:records role]))])
                ct/roles))))

(defn verify-workspace! [options]
  (let [workspace (verify-origin! options)]
    (when-not (current-matches-origin? workspace)
      (fail! "schema workspace no longer matches its prepared origin"
             {:type :schema-workspace-not-prepared
              :workspace (:workspace_id workspace)}))
    workspace))

(defn built-seal-value [workspace proof]
  {:format built-seal-format
   :workspace_id (:workspace_id workspace)
   :workspace_manifest_sha256 (:manifest_sha256 workspace)
   :source_snapshot (get-in workspace [:manifest :source_snapshot])
   :repair_manifest_sha256
   (get-in workspace [:manifest :repair_manifest_sha256])
   :files (into {}
                (map (fn [role]
                       [role (portable-payload
                              role (get-in workspace [:records role]))])
                     ct/roles))
   :corpus_max_tx
   (apply max 0 (map #(get-in workspace [:records % :max-tx]) ct/roles))
   :proof proof})

(defn verify-built-seal! [workspace]
  (let [path (:built_seal_path workspace)]
    (when-not path
      (fail! "schema workspace has no built-state seal"
             {:type :schema-workspace-not-built
              :workspace (:workspace_id workspace)}))
    (let [name (.getName (io/file path))
          record (read-pinned-canonical-edn!
                  "schema built-state seal" (:directory workspace) name
                  (:parent_identity workspace) false)
          value (:value record)
          expected-name (str "built-" (canonical-edn-sha256 value) ".edn")]
      (when-not (and (= expected-name name)
                     (exact-keys?
                      value
                      #{:format :workspace_id :workspace_manifest_sha256
                        :source_snapshot :repair_manifest_sha256 :files
                        :corpus_max_tx :proof})
                     (= built-seal-format (:format value))
                     (= (:workspace_id workspace) (:workspace_id value))
                     (= (:manifest_sha256 workspace)
                        (:workspace_manifest_sha256 value))
                     (= (get-in workspace [:manifest :source_snapshot])
                        (:source_snapshot value))
                     (= (get-in workspace [:manifest :repair_manifest_sha256])
                        (:repair_manifest_sha256 value))
                     (= (into {}
                              (map (fn [role]
                                     [role (portable-payload
                                            role (get-in workspace
                                                         [:records role]))])
                                   ct/roles))
                        (:files value))
                     (= (apply max 0
                               (map #(get-in workspace [:records % :max-tx])
                                    ct/roles))
                        (:corpus_max_tx value))
                     (map? (:proof value)) (seq (:proof value))
                     (= ["OWNER_READ"] (:permissions record))
                     (= 1 (:links record))
                     (= (get-in workspace [:parent_identity :uid])
                        (:uid record)))
        (fail! "schema built-state seal is invalid or stale"
               {:type :schema-workspace-built-seal-invalid :path path}))
      (assoc record :seal value))))

(defn seal-built! [workspace proof]
  (when-not (and (map? proof) (seq proof))
    (fail! "schema built-state proof is required"
           {:type :schema-workspace-built-proof-invalid}))
  (let [value (built-seal-value workspace proof)
        expected-name (str "built-" (canonical-edn-sha256 value) ".edn")]
    (when (and (:built_seal_path workspace)
               (not= expected-name
                     (.getName (io/file (:built_seal_path workspace)))))
      (fail! "workspace already carries a different built-state seal"
             {:type :schema-workspace-built-seal-collision
              :existing (:built_seal_path workspace)
              :expected expected-name}))
    (let [artifact (ct/write-content-addressed-edn!
                    (:directory workspace) "built" value)]
      (set-permissions! (:path artifact) ["OWNER_READ"])
      (force-directory! (:directory workspace))
      artifact)))

(defn prepare-workspace!
  [{:keys [workspace-root snapshot-store source-snapshot
           repair-manifest-sha256 execute?]}]
  (when-not (re-matches #"[0-9a-f]{64}" (str repair-manifest-sha256))
    (fail! "repair manifest seal is invalid"
           {:type :schema-repair-manifest-seal-invalid}))
  (let [source (verify-source! snapshot-store source-snapshot)
        id (str "schema-workspace-" (java.util.UUID/randomUUID))]
    (if-not execute?
      {:ok true :dry_run true :workspace_id id
       :source_snapshot (:provenance source)
       :would_write (str (io/file (.getCanonicalPath (io/file workspace-root))
                                  id))}
      (let [root (safe-directory! "schema workspace root" workspace-root true)
            _ (inspect-retained-owned-stages! root "workspace")
            stage (create-stage! root "workspace")
            object (str (:path stage) "/object")
            target (str root "/" id)]
        (try
          (when-not (.mkdir (io/file object))
            (fail! "cannot create schema workspace object"
                   {:type :schema-workspace-create-failed :path object}))
          (set-permissions! object ["OWNER_READ" "OWNER_WRITE" "OWNER_EXECUTE"])
          (doseq [role ct/roles]
            (let [source-record (get-in source [:records role])]
              (copy-payload! (:path source-record)
                             (str object "/" (get object-names role))
                             (:permissions source-record))))
          (let [workspace-records (records! object)
                manifest
                {:format workspace-format :workspace_id id :state "prepared"
                 :source_snapshot (:provenance source)
                 :repair_manifest_sha256 repair-manifest-sha256
                 :created_by {:pid (:pid stage) :pid_birth (:pid-birth stage)
                              :nonce (:nonce stage)}
                 :files (into {}
                              (map (fn [role]
                                     [role (portable-payload
                                            role (get workspace-records role))])
                                   ct/roles))}
                manifest-path (str object "/workspace.edn")]
            (doseq [role ct/roles]
              (when-not (= (select-keys (get workspace-records role)
                                        sealed-payload-fields)
                           (select-keys (get-in source [:records role])
                                        sealed-payload-fields))
                (fail! "workspace copy changed the snapshot payload"
                       {:type :schema-workspace-copy-mismatch :role role})))
            (ct/write-bytes-durable! manifest-path (canonical-edn-bytes manifest))
            (set-permissions! manifest-path ["OWNER_READ"])
            (force-directory! object)
            (reverify-source! snapshot-store source-snapshot source)
            (let [current-records (records! object)]
              (when-not (= (into {}
                                  (map (fn [role]
                                         [role (portable-payload
                                                role (get current-records role))])
                                       ct/roles))
                           (:files manifest))
                (fail! "workspace stage changed before publication"
                       {:type :schema-workspace-copy-mismatch})))
            (java.nio.file.Files/move
             (.toPath (io/file object)) (.toPath (io/file target))
             (make-array java.nio.file.CopyOption 0))
            (force-directory! root)
            (let [current-source
                  (reverify-source! snapshot-store source-snapshot source)]
              (merge
               {:ok true :dry_run false :source current-source}
               (verify-workspace-from-source!
                {:workspace-root root :workspace id :source current-source
                 :repair-manifest-sha256 repair-manifest-sha256}))))
          (finally
            (discard-stage! stage)))))))

(defn workspace-identity [workspace]
  {:workspace_id (:workspace_id workspace)
   :directory (:directory workspace)
   :manifest_sha256 (:manifest_sha256 workspace)
   :manifest (:manifest workspace)
   :records
   (into {}
         (map (fn [role]
                [role (select-keys (get-in workspace [:records role])
                                   (conj sealed-payload-fields
                                         :path :file_key :links))])
              ct/roles))})

(def retained-stage-policy
  {:mode "retain-private-owned-stages"
   :reason "linux-has-no-identity-conditional-unlink"})

(defn- finalized-manifest-path! [store selector]
  (let [store (safe-directory! "finalized schema candidate store" store false)
        selected (required! selector "--candidate")]
    (when-not (re-matches finalized-id-pattern selected)
      (fail! "finalized candidate selector must be its exact content ID"
             {:type :schema-owned-object-invalid
              :label "finalized-candidate" :selector selected}))
    {:store store :id selected :path (str store "/" selected ".edn")}))

(defn reserve-publication! [candidate-store]
  (let [store (safe-directory! "finalized schema candidate store"
                               candidate-store true)]
    (inspect-retained-owned-stages! store "candidate")
    (let [parent-identity (fd-identity store)
          stage (create-stage! store "candidate")
          current-parent (fd-identity store)]
      (when-not (= parent-identity current-parent)
        (fail! "candidate store changed while publication was reserved"
               {:type :final-schema-candidate-publication-unreserved
                :store store :expected-parent parent-identity
                :actual-parent current-parent}))
      {:store store :parent-identity parent-identity
       :stage stage :retention retained-stage-policy})))

(defn release-publication! [_publication]
  ;; Publication reservations are deliberately retained. Linux exposes no
  ;; unlink-by-FD, so a post-check followed by pathname deletion would be a
  ;; false identity-safety claim.
  nil)

(defn- finalized-records! [store files expected-parent]
  (let [store-uid (:uid expected-parent)]
    (into {}
          (map
           (fn [role]
             (let [sealed (get files role)
                   object-name (:object_name sealed)
                   expected-name (finalized-payload-name role (:sha256 sealed))]
               (when-not (and (exact-keys?
                               sealed
                               #{:bytes :sha256 :permissions :append-boundary
                                 :max-tx :ending :object_name})
                              (= object-name expected-name)
                              (re-matches finalized-payload-name-pattern
                                          object-name))
                 (fail! "finalized candidate references a malformed payload object"
                        {:type :final-schema-candidate-invalid
                         :role role :payload sealed}))
               (let [record (finalized-payload-record!
                             store role object-name expected-parent)]
                 (when-not (and (= sealed
                                     (finalized-portable-payload role record))
                                (= finalized-file-permissions
                                   (:permissions record))
                                (= store-uid (:uid record))
                                (= 1 (:links record)))
                   (fail! "finalized candidate payload object is not exact and immutable"
                          {:type :final-schema-candidate-invalid
                           :role role :expected sealed
                           :actual (select-keys record
                                                (conj sealed-payload-fields
                                                      :uid :links))}))
                 [role record])))
           ct/roles))))

(def ^:private finalized-representation-fields
  [:path :bytes :sha256 :permissions :append-boundary :max-tx :ending
   :file_key :fd-identity :parent-identity :uid :links])

(defn- finalized-record-evidence [records]
  (into {}
        (map (fn [role]
               [role (select-keys (get records role)
                                  finalized-representation-fields)]))
        ct/roles))

(defn- reverify-finalized-representation!
  [store id expected-manifest expected-records expected-parent]
  (let [manifest-record
        (read-finalized-canonical-edn!
         store (str id ".edn") expected-parent)
        records (finalized-records!
                 store (:files (:value manifest-record)) expected-parent)]
    (when-not (and (= (:value expected-manifest) (:value manifest-record))
                   (= (select-keys expected-manifest
                                   [:sha256 :file-key :fd-identity
                                    :parent-identity :uid :permissions :links])
                      (select-keys manifest-record
                                   [:sha256 :file-key :fd-identity
                                    :parent-identity :uid :permissions :links]))
                   (= (finalized-record-evidence expected-records)
                      (finalized-record-evidence records)))
      (fail! "finalized schema candidate representation changed during verification"
             {:type :final-schema-candidate-raced :candidate id}))
    {:manifest-record manifest-record :records records}))

(defn verify-finalized!
  [{:keys [candidate-store candidate snapshot-store validate!]}]
  (when-not (fn? validate!)
    (fail! "finalized schema candidates require an independent domain validator"
           {:type :final-schema-candidate-validator-required}))
  (let [{:keys [store id]}
        (finalized-manifest-path! candidate-store candidate)
        manifest-record
        (read-finalized-canonical-edn! store (str id ".edn") nil)
          manifest (:value manifest-record)
          parent-identity (:parent-identity manifest-record)
          expected-id (str "schema-candidate-"
                           (canonical-edn-sha256
                            (dissoc manifest :candidate_id)))
          finalized-records (finalized-records!
                             store (:files manifest) parent-identity)
          source-row (:source_snapshot manifest)
          source (verify-source! snapshot-store (:snapshot_id source-row))
          store-uid (:uid parent-identity)]
      (when-not (and (exact-keys?
                      manifest
                      #{:format :result :source_snapshot :source_workspace
                        :repair_manifest_sha256 :files :corpus_max_tx :build
                        :publication :candidate_id})
                     (exact-keys? (:source_workspace manifest)
                                  #{:workspace_id :manifest_sha256})
                     (map? (:build manifest))
                     (seq (:build manifest))
                     (= {:authority "manifest-last"
                         :payload_publication "anonymous-fd-create-new"
                         :reference_binding "pinned-fd-pre-and-post-link"
                         :cooperative_serialization "exclusive-parent-fd-lock"
                         :staging retained-stage-policy}
                        (:publication manifest))
                     (= finalized-file-permissions
                        (:permissions manifest-record))
                     (= 1 (:links manifest-record))
                     (= store-uid (:uid manifest-record))
                     (= finalized-format (:format manifest))
                     (= "converged" (:result manifest))
                     (= id (:candidate_id manifest) expected-id)
                     (= source-row (snapshot-provenance source))
                     (= (into {}
                              (map (fn [role]
                                     [role (finalized-portable-payload
                                            role (get finalized-records role))])
                                   ct/roles))
                        (:files manifest))
                     (= (:corpus_max_tx manifest)
                        (apply max 0
                               (map #(get-in finalized-records [% :max-tx])
                                    ct/roles))))
        (fail! "finalized schema candidate seal or provenance is invalid"
               {:type :final-schema-candidate-invalid :candidate id}))
      (let [candidate-result
            {:ok true :candidate_id id :store store
             :manifest_path (:path manifest-record)
             :manifest_sha256 (:sha256 manifest-record)
             :manifest manifest :records finalized-records}
            domain (validate! candidate-result)]
        (when-not (and (map? domain) (= true (:ok domain)))
          (fail! "finalized schema candidate fails independent domain validation"
                 {:type :final-schema-candidate-domain-invalid
                  :candidate id :domain domain}))
        (let [{stable-manifest :manifest-record stable-records :records}
              (reverify-finalized-representation!
               store id manifest-record finalized-records parent-identity)]
          (assoc candidate-result :domain domain
                 :manifest_path (:path stable-manifest)
                 :manifest_sha256 (:sha256 stable-manifest)
                 :records stable-records)))))

(defn- refresh-built-workspace! [workspace source]
  (let [refreshed
        (verify-workspace-from-source!
         {:workspace-root (.getCanonicalPath
                           (.getParentFile (io/file (:directory workspace))))
          :workspace (:workspace_id workspace)
          :source source
          :repair-manifest-sha256
          (get-in workspace [:manifest :repair_manifest_sha256])})]
    (verify-built-seal! refreshed)
    refreshed))

(defn- reserved-parent-identity!
  [publication store]
  (let [stage (same-stage! (:stage publication))
        expected (:parent-identity publication)
        actual (fd-identity store)]
    (when-not (and (= store (:store publication) (:parent stage))
                   (= #{:dev :ino :uid :mode :kind} (set (keys expected)))
                   (= expected actual))
      (fail! "candidate publication reservation no longer names its exact store"
             {:type :final-schema-candidate-publication-unreserved
              :store store :stage-parent (:parent stage)
              :expected-parent expected :actual-parent actual}))
    expected))

(defn- publish-payload-object!
  [store role source-record expected expected-parent]
  (let [target (:object_name expected)
        response
        (run-stage-io-helper!
         ["publish-file-object" store (:path source-record) target
          (json/generate-string (file-fd-identity! (:path source-record)))
          (:sha256 source-record)
          (json/generate-string expected-parent)])]
    (when-not (and (= target (:target response))
                   (= (:sha256 expected) (:sha256 response))
                   (= (:bytes expected) (:bytes response))
                   (= expected-parent (:parent_identity response)))
      (fail! "candidate payload publisher returned mismatched evidence"
             {:type :final-schema-candidate-publication-invalid
              :role role :response response}))
    (let [record (finalized-payload-record!
                  store role target expected-parent)]
      (when-not (= expected (finalized-portable-payload role record))
        (fail! "published candidate payload differs from its sealed workspace"
               {:type :final-schema-candidate-copy-mismatch
                :role role :expected expected
                :actual (finalized-portable-payload role record)}))
      record)))

(defn- publish-manifest-last! [store id manifest files expected-parent]
  (let [payload (canonical-edn-bytes manifest)
        sha256 (sha256-bytes payload)
        target (str id ".edn")
        references
        (mapv (fn [role]
                (assoc (select-keys (get files role)
                                    [:object_name :sha256 :bytes])
                       :role (name role)))
              ct/roles)
        response
        (run-stage-io-helper!
         ["publish-manifest-object" store target sha256
          (json/generate-string expected-parent)
          (json/generate-string references)]
         (String. payload java.nio.charset.StandardCharsets/UTF_8))]
    (when-not (and (= target (:target response))
                   (= sha256 (:sha256 response))
                   (= (alength payload) (:bytes response))
                   (= expected-parent (:parent_identity response))
                   (= "exclusive-parent-fd" (:cooperative_lock response))
                   (= (set references)
                      (set (map #(select-keys %
                                             [:role :object_name :sha256 :bytes])
                                (:references response)))))
      (fail! "candidate manifest publisher returned mismatched evidence"
             {:type :final-schema-candidate-publication-invalid
              :response response}))
    response))

(defn publish-finalized!
  [{:keys [snapshot-store workspace validate! publication]}]
  (when-not (and (map? publication) (:store publication)
                 (:stage publication) (:parent-identity publication))
    (fail! "finalized publication requires a pre-wire reserved stage"
           {:type :final-schema-candidate-publication-unreserved}))
  (let [store (safe-directory! "finalized schema candidate store"
                               (:store publication) false)
        expected-parent (reserved-parent-identity! publication store)
        source-id (get-in workspace [:manifest :source_snapshot :snapshot_id])
        expected-source (verify-source! snapshot-store source-id)
        fresh (refresh-built-workspace! workspace expected-source)
        built (verify-built-seal! fresh)
        files (into {}
                    (map (fn [role]
                           [role (finalized-portable-payload
                                  role (get-in fresh [:records role]))])
                         ct/roles))
        core {:format finalized-format :result "converged"
                  :source_snapshot (get-in workspace
                                           [:manifest :source_snapshot])
                  :source_workspace
                  {:workspace_id (:workspace_id workspace)
                   :manifest_sha256 (:manifest_sha256 workspace)}
                  :repair_manifest_sha256
                  (get-in workspace [:manifest :repair_manifest_sha256])
                  :files files
                  :corpus_max_tx
                  (apply max 0
                         (map #(get-in fresh [:records % :max-tx]) ct/roles))
                  :build (:seal built)
                  :publication
                  {:authority "manifest-last"
                   :payload_publication "anonymous-fd-create-new"
                   :reference_binding "pinned-fd-pre-and-post-link"
                   :cooperative_serialization "exclusive-parent-fd-lock"
                   :staging retained-stage-policy}}
        id (str "schema-candidate-" (canonical-edn-sha256 core))
        manifest (assoc core :candidate_id id)
        finalized-records
        (into {}
              (map (fn [role]
                     [role (publish-payload-object!
                            store role (get-in fresh [:records role])
                            (get files role) expected-parent)])
                   ct/roles))
        draft {:ok true :candidate_id id :store store
               :manifest_path nil
               :manifest_sha256 (sha256-bytes (canonical-edn-bytes manifest))
               :manifest manifest :records finalized-records}
        domain (validate! draft)]
    (when-not (and (map? domain) (= true (:ok domain)))
      (fail! "candidate payload objects fail independent domain validation"
             {:type :final-schema-candidate-domain-invalid
              :candidate id :domain domain}))
    ;; The source and built workspace must still be exact immediately before
    ;; the sole commit point. Payload objects without this manifest are inert.
    (let [current-source
          (reverify-source! snapshot-store source-id expected-source)
          current-workspace (refresh-built-workspace! fresh current-source)
          current-built (verify-built-seal! current-workspace)
          current-finalized
          (finalized-records! store files expected-parent)]
      (when-not (= (:seal built) (:seal current-built))
        (fail! "built workspace changed before candidate manifest publication"
               {:type :schema-workspace-post-drift
                :workspace (:workspace_id fresh)}))
      (when-not (= (finalized-record-evidence finalized-records)
                   (finalized-record-evidence current-finalized))
        (fail! "candidate payload representation changed before manifest publication"
               {:type :final-schema-candidate-publication-raced
                :candidate id})))
    (reserved-parent-identity! publication store)
    ;; Linking the manifest is the publication marker, not a trust shortcut.
    ;; Same-UID mutation can race any userspace syscall sequence, so consumers
    ;; grant authority only after verify-finalized! pins and revalidates the
    ;; manifest, both payloads, their common parent, and source provenance.
    (publish-manifest-last! store id manifest files expected-parent)
    (reverify-source! snapshot-store source-id expected-source)
    (verify-finalized! {:candidate-store store :candidate id
                        :snapshot-store snapshot-store
                        :validate! validate!})))
