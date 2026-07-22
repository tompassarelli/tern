(ns north.runtime-attestation
  "Local process attestation for the Fram coordinator selected by North.

  Protocol readiness proves behavior, not provenance.  This module binds the
  selected port to one local process, then binds that process to the
  launcher-owned PID/birth/token record and the exact Fram source artifacts it
  executes.  Callers retain the returned authority and re-attest immediately
  before publishing any artifact derived from the observed corpus."
  (:require [babashka.process :as proc]
            [clojure.java.io :as io]
            [clojure.string :as str]))

(def attestation-format "north-fram-runtime-attestation/v1")
(def active-attestation-format "north-fram-active-runtime-attestation/v1")
(def active-runtime-record-format "north-fram-active-runtime/v1")
(def static-runtime-identity-format "north-fram-runtime-v1")
(def active-runtime-record-name "active.runtime")
(def active-runtime-record-order
  ["FORMAT" "GENERATION" "GENERATION_IDENTITY"
   "GENERATION_IDENTITY_SHA256" "NORTH_FRAM_RUNTIME"
   "FRAM_RUNTIME_SOURCE" "FRAM_RUNTIME_REV" "FRAM_RUNTIME_TREE"
   "FRAM_RUNTIME_ORIGIN" "FRAM_RUNTIME_DAEMON" "FRAM_PORT"
   "FRAM_LOG" "FRAM_TELEMETRY_LOG" "PID" "PID_BIRTH"
   "OWNER_TOKEN" "CONTROLLER_UNIT" "CONTROLLER_MAIN_PID"])
(def active-runtime-record-keys
  (set active-runtime-record-order))
(def proc-read-limit (* 16 1024 1024))
(def identity-read-limit (* 1024 1024))
(def required-runtime-artifacts
  ["bin/fram-daemon"
   "coord_daemon.clj"
   "coord.clj"
   "out/fram/fold.clj"
   "out/fram/kernel.clj"
   "out/fram/schema.clj"
   "out/fram/store.clj"
   "out/fram/rt.clj"
   "chartroom/src/resolve.clj"])

(defn- fail!
  ([message type] (fail! message type {}))
  ([message type data]
   (throw (ex-info message (merge {:type type} data)))))

(defn- sha256-bytes [^bytes payload]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        payload)]
    (apply str (map #(format "%02x" %) digest))))

(defn- sha256-file [path]
  (let [digest (java.security.MessageDigest/getInstance "SHA-256")
        buffer (byte-array 65536)]
    (with-open [input (java.io.FileInputStream. (str path))]
      (loop []
        (let [n (.read input buffer)]
          (when (pos? n)
            (.update digest buffer 0 n)
            (recur)))))
    (apply str (map #(format "%02x" %) (.digest digest)))))

(defn- no-follow-options []
  (into-array java.nio.file.LinkOption
              [java.nio.file.LinkOption/NOFOLLOW_LINKS]))

(defn- file-time-millis [value]
  (.toMillis ^java.nio.file.attribute.FileTime value))

(defn- file-time-instant [value]
  (let [instant (.toInstant ^java.nio.file.attribute.FileTime value)]
    [(.getEpochSecond instant) (.getNano instant)]))

(defn- latest-file-time [values]
  (reduce (fn [latest candidate]
            (if (pos? (compare candidate latest)) candidate latest))
          [0 0]
          values))

(defn- file-time<=? [candidate barrier]
  (not (pos? (compare candidate barrier))))

(defn- unix-file-state! [label path]
  (let [nio (.toPath (io/file (str path)))
        options (no-follow-options)]
    (when (java.nio.file.Files/isSymbolicLink nio)
      (fail! (str label " must not be a symbolic link: " path)
             :active-runtime-path-invalid {:label label :path (str path)}))
    (when-not (java.nio.file.Files/isRegularFile nio options)
      (fail! (str label " is missing or not a regular file: " path)
             :active-runtime-path-invalid {:label label :path (str path)}))
    (let [attrs (java.nio.file.Files/readAttributes
                 nio "unix:dev,ino,uid,mode,nlink,size,lastModifiedTime,ctime"
                 options)
          mtime (get attrs "lastModifiedTime")
          ctime (get attrs "ctime")]
      {:dev (long (get attrs "dev"))
       :ino (long (get attrs "ino"))
       :uid (long (get attrs "uid"))
       :mode (bit-and (long (get attrs "mode")) 511)
       :nlink (long (get attrs "nlink"))
       :size (long (get attrs "size"))
       :mtime (str mtime)
       :mtime-millis (file-time-millis mtime)
       :mtime-instant (file-time-instant mtime)
       :ctime (str ctime)
       :ctime-millis (file-time-millis ctime)
       :ctime-instant (file-time-instant ctime)})))

(defn- unix-directory-state! [label path]
  (let [file (io/file (str path))
        nio (.toPath file)
        options (no-follow-options)]
    (when (or (java.nio.file.Files/isSymbolicLink nio)
              (not (java.nio.file.Files/isDirectory nio options)))
      (fail! (str label " is missing or not a real directory: " path)
             :active-runtime-path-invalid {:label label :path (str path)}))
    (let [attrs (java.nio.file.Files/readAttributes
                 nio "unix:dev,ino,uid,mode,nlink,lastModifiedTime,ctime"
                 options)
          mtime (get attrs "lastModifiedTime")
          ctime (get attrs "ctime")]
      {:dev (long (get attrs "dev"))
       :ino (long (get attrs "ino"))
       :uid (long (get attrs "uid"))
       :mode (bit-and (long (get attrs "mode")) 511)
       :nlink (long (get attrs "nlink"))
       :mtime (str mtime)
       :mtime-millis (file-time-millis mtime)
       :mtime-instant (file-time-instant mtime)
       :ctime (str ctime)
       :ctime-millis (file-time-millis ctime)
       :ctime-instant (file-time-instant ctime)})))

(defn- channel-bytes! [label ^java.nio.channels.FileChannel channel size]
  (when (> size identity-read-limit)
    (fail! (str label " exceeds the sealed identity read bound")
           :active-runtime-record-invalid
           {:label label :bytes size :limit identity-read-limit}))
  (.position channel 0)
  (let [payload (byte-array (int size))
        buffer (java.nio.ByteBuffer/wrap payload)]
    (loop []
      (when (.hasRemaining buffer)
        (let [read (.read channel buffer)]
          (when (neg? read)
            (fail! (str label " shortened during its pinned read")
                   :active-runtime-record-raced {:label label}))
          (recur))))
    payload))

(defn- read-sealed-file! [label path]
  (let [canonical (.getCanonicalPath (io/file (str path)))
        before (unix-file-state! label path)]
    (when-not (= canonical (.getAbsolutePath (io/file canonical)))
      (fail! (str label " path is not absolute: " path)
             :active-runtime-path-invalid {:label label :path (str path)}))
    (with-open [channel
                (java.nio.channels.FileChannel/open
                 (.toPath (io/file canonical))
                 (into-array java.nio.file.OpenOption
                             [java.nio.file.StandardOpenOption/READ
                              java.nio.file.LinkOption/NOFOLLOW_LINKS]))]
      (let [first-read (channel-bytes! label channel (:size before))
            second-read (channel-bytes! label channel (:size before))
            after (unix-file-state! label canonical)]
        (when-not (and (= before after)
                       (= (:size before) (.size channel))
                       (java.util.Arrays/equals first-read second-read))
          (fail! (str label " changed while it was being read")
                 :active-runtime-record-raced
                 {:label label :path canonical
                  :before before :after after}))
        {:path canonical
         :bytes first-read
         :sha256 (sha256-bytes first-read)
         :state after}))))

(defn- exact-key-value-record! [sealed]
  (let [^bytes payload (:bytes sealed)
        _ (when (or (zero? (alength payload))
                    (not= 10 (aget payload (dec (alength payload))))
                    (some #(= 13 %) payload))
            (fail! "active runtime identity must be LF-terminated canonical text"
                   :active-runtime-record-invalid))
        lines (str/split-lines
               (String. ^bytes (:bytes sealed)
                        java.nio.charset.StandardCharsets/UTF_8))
        pairs
        (mapv
         (fn [line]
           (let [index (str/index-of line "=")]
             (when-not (and index (pos? index))
               (fail! (str "malformed active runtime identity line: " line)
                      :active-runtime-record-invalid))
             [(subs line 0 index) (subs line (inc index))]))
         lines)
        values
        (reduce
         (fn [result [key value]]
           (when (or (str/blank? key) (str/blank? value)
                     (contains? result key))
             (fail! "active runtime identity has a blank or duplicate field"
                    :active-runtime-record-invalid {:key key}))
           (assoc result key value))
         {} pairs)]
    (when-not (and (= active-runtime-record-keys (set (keys values)))
                   (= active-runtime-record-order (mapv first pairs)))
      (fail! "active runtime identity has the wrong exact ordered field set"
             :active-runtime-record-invalid
             {:expected active-runtime-record-order
              :actual (mapv first pairs)}))
    (when-not (= active-runtime-record-format (get values "FORMAT"))
      (fail! "active runtime identity has an unsupported format"
             :active-runtime-record-invalid
             {:expected active-runtime-record-format
              :actual (get values "FORMAT")}))
    values))

(defn- parse-static-runtime-identity! [sealed]
  (let [^bytes payload (:bytes sealed)
        _ (when (or (zero? (alength payload))
                    (not= 10 (aget payload (dec (alength payload))))
                    (some #(= 13 %) payload))
            (fail! "selected runtime generation identity must be LF-terminated canonical text"
                   :active-runtime-generation-invalid
                   {:path (:path sealed)}))
        lines (str/split-lines
               (String. ^bytes (:bytes sealed)
                        java.nio.charset.StandardCharsets/UTF_8))]
    (when-not (and (= 7 (count lines))
                   (= static-runtime-identity-format (first lines))
                   (every? #(not (str/blank? %)) lines))
      (fail! "selected runtime generation identity is malformed"
             :active-runtime-generation-invalid
             {:path (:path sealed)}))
    (zipmap [:format :mode :source :revision :tree :origin :daemon] lines)))

(defn- canonical-regular-file! [label path]
  (let [file (io/file (str path))
        nio (.toPath file)]
    (when (or (str/blank? (str path))
              (java.nio.file.Files/isSymbolicLink nio)
              (not (.isFile file))
              (not (.canRead file)))
      (fail! (str label " is missing or unsafe: " path)
             :runtime-artifact-invalid {:label label :path path}))
    (.getCanonicalPath file)))

(defn artifact-record [label path]
  (let [canonical (canonical-regular-file! label path)
        file (io/file canonical)]
    {:path canonical :bytes (.length file) :sha256 (sha256-file canonical)}))

(defn read-runtime-record!
  "Read the launcher-owned identity record without accepting duplicate or
  malformed keys.  The record is evidence only after attest-runtime! binds it
  to the actual listener process."
  [path]
  (let [canonical (canonical-regular-file! "coordinator runtime identity" path)]
    {:path canonical
     :artifact (artifact-record "coordinator runtime identity" canonical)
     :values
     (reduce
      (fn [result line]
        (let [index (str/index-of line "=")]
          (when-not (and index (pos? index))
            (fail! (str "malformed coordinator runtime identity line: " line)
                   :runtime-record-invalid))
          (let [key (subs line 0 index) value (subs line (inc index))]
            (when (contains? result key)
              (fail! (str "duplicate coordinator runtime identity key: " key)
                     :runtime-record-invalid {:key key}))
            (assoc result key value))))
      {}
      (str/split-lines (slurp canonical)))}))

(defn- required-record-value! [record key]
  (let [value (get record key)]
    (when (str/blank? value)
      (fail! (str "coordinator runtime identity lacks " key)
             :runtime-record-invalid {:key key}))
    value))

(defn- read-proc-bytes [path]
  (with-open [input (java.io.FileInputStream. (str path))
              output (java.io.ByteArrayOutputStream.)]
    (let [buffer (byte-array 65536)]
      (loop [total 0]
        (let [n (.read input buffer)]
          (cond
            (= -1 n) (.toByteArray output)
            (zero? n) (recur total)
            (> (+ total n) proc-read-limit)
            (fail! "local process evidence exceeds the attestation bound"
                   :listener-process-inspection-failed
                   {:path (str path) :max-bytes proc-read-limit})
            :else (do (.write output buffer 0 n)
                      (recur (+ total n)))))))))

(defn- read-proc-text [path]
  (String. ^bytes (read-proc-bytes path)
           java.nio.charset.StandardCharsets/UTF_8))

(defn tcp-listener-inodes [port]
  (->> ["/proc/net/tcp" "/proc/net/tcp6"]
       (mapcat
        (fn [path]
          (if-not (.isFile (io/file path))
            []
            (keep
             (fn [line]
               (let [fields (str/split (str/trim line) #"\s+")]
                 (when (>= (count fields) 10)
                   (let [local (nth fields 1)
                         state (nth fields 3)
                         colon (.lastIndexOf ^String local ":")
                         local-port (when (pos? colon)
                                      (try
                                        (Integer/parseInt
                                         (subs local (inc colon)) 16)
                                        (catch Exception _ nil)))]
                     (when (and (= port local-port) (= "0A" state))
                       (nth fields 9))))))
             (str/split-lines (read-proc-text path))))))
       set))

(defn listener-pids [port]
  (let [targets (set (map #(str "socket:[" % "]")
                          (tcp-listener-inodes port)))
        proc-root (io/file "/proc")]
    (->> (or (.listFiles proc-root) (make-array java.io.File 0))
         (keep
          (fn [pid-directory]
            (when (re-matches #"[0-9]+" (.getName pid-directory))
              (let [fds (io/file pid-directory "fd")
                    owns? (some
                           (fn [fd]
                             (try
                               (contains?
                                targets
                                (str (java.nio.file.Files/readSymbolicLink
                                      (.toPath fd))))
                               (catch Exception _ false)))
                           (or (.listFiles fds)
                               (make-array java.io.File 0)))]
                (when owns? (parse-long (.getName pid-directory)))))))
         sort
         vec)))

(defn process-path [pid leaf]
  (try
    (.getCanonicalPath
     (io/file (.toString
               (java.nio.file.Files/readSymbolicLink
                (.toPath (io/file "/proc" (str pid) leaf))))))
    (catch Exception _ nil)))

(defn process-start-millis [pid]
  (let [optional (java.lang.ProcessHandle/of (long pid))]
    (when (.isPresent optional)
      (let [start (.startInstant (.info (.get optional)))]
        (when (.isPresent start) (.toEpochMilli (.get start)))))))

(defn process-birth-token [pid]
  (try
    (let [line (read-proc-text (str "/proc/" pid "/stat"))
          close (.lastIndexOf ^String line ") ")
          fields (when (pos? close)
                   (str/split (subs line (+ close 2)) #"\s+"))
          start-ticks (nth fields 19 nil)]
      (when (and start-ticks (re-matches #"[0-9]+" start-ticks))
        (str "proc:" start-ticks)))
    (catch Exception _ nil)))

(defn process-cmdline [pid]
  (let [text (String. ^bytes (read-proc-bytes (str "/proc/" pid "/cmdline"))
                      java.nio.charset.StandardCharsets/UTF_8)]
    (vec (remove str/blank? (str/split text #"\u0000")))))

(defn process-environment [pid]
  (let [text (String. ^bytes (read-proc-bytes (str "/proc/" pid "/environ"))
                      java.nio.charset.StandardCharsets/UTF_8)]
    (reduce
     (fn [result entry]
       (let [index (str/index-of entry "=")]
         (if-not (and index (pos? index))
           result
           (let [key (subs entry 0 index) value (subs entry (inc index))]
             (when (contains? result key)
               (fail! (str "duplicate process environment key: " key)
                      :listener-process-inspection-failed {:pid pid :key key}))
             (assoc result key value)))))
     {}
     (remove str/blank? (str/split text #"\u0000")))))

(defn- resolve-process-argument [cwd argument]
  (try
    (.getCanonicalPath
     (if (.isAbsolute (io/file (str argument)))
       (io/file (str argument))
       (io/file cwd (str argument))))
    (catch Exception _ nil)))

(defn- process-classpath-entries [cwd arguments]
  (->> (range (dec (count arguments)))
       (mapcat
        (fn [index]
          (when (contains? #{"-cp" "-classpath"} (nth arguments index))
            (->> (str/split
                  (nth arguments (inc index))
                  (re-pattern
                   (java.util.regex.Pattern/quote java.io.File/pathSeparator)))
                 (map #(resolve-process-argument cwd %))))))
       (remove nil?)
       vec))

(defn- git-value! [root expression type]
  (let [result (proc/shell {:out :string :err :string :continue true}
                           "git" "-C" root "rev-parse" "--verify" expression)
        value (str/trim (:out result))]
    (when-not (and (zero? (:exit result))
                   (boolean (re-matches #"[0-9a-f]{40,64}" value)))
      (fail! (str "selected Fram runtime has no attested Git " (name type))
             type {:root root :exit (:exit result)
                   :error (str/trim (:err result))}))
    value))

(defn- git-clean-checkout! [root revision tree]
  (let [options {:out :string :err :string :continue true}
        worktree
        (proc/shell options "git" "-C" root "diff" "--no-ext-diff"
                    "--quiet" "--ignore-submodules=none" "--")
        index
        (proc/shell options "git" "-C" root "diff" "--cached"
                    "--no-ext-diff" "--quiet" "--ignore-submodules=none" "--")
        untracked
        (proc/shell options "git" "-C" root "ls-files" "--others"
                    "--exclude-standard" "-z" "--")]
    (when-not (and (zero? (:exit worktree))
                   (zero? (:exit index))
                   (zero? (:exit untracked))
                   (empty? (:out untracked)))
      (fail! "selected Fram Git checkout is not exactly clean"
             :runtime-source-checkout-dirty
             {:root root
              :revision revision
              :tree tree
              :worktree-exit (:exit worktree)
              :worktree-error (str/trim (:err worktree))
              :index-exit (:exit index)
              :index-error (str/trim (:err index))
              :untracked-exit (:exit untracked)
              :untracked-sha256
              (sha256-bytes
               (.getBytes ^String (:out untracked)
                          java.nio.charset.StandardCharsets/UTF_8))}))
    {:head revision
     :tree tree
     :worktree-diff "clean"
     :index-diff "clean"
     :untracked-status "clean"}))

(defn- source-version! [root expected-revision expected-tree]
  (let [marker (.toPath (io/file root ".git"))
        options (no-follow-options)
        git-backed?
        (and (not (java.nio.file.Files/isSymbolicLink marker))
             (or (java.nio.file.Files/isDirectory marker options)
                 (java.nio.file.Files/isRegularFile marker options)))]
    (if git-backed?
      (let [revision (git-value! root "HEAD" :fram-revision-unavailable)
            tree (git-value! root "HEAD^{tree}" :fram-tree-unavailable)]
        (when-not (and (= expected-revision revision) (= expected-tree tree))
          (fail! "launcher runtime revision/tree does not match its selected source"
                 :runtime-source-version-mismatch
                 {:expected {:revision expected-revision :tree expected-tree}
                  :actual {:revision revision :tree tree} :root root}))
        {:revision revision
         :tree tree
         :provenance "git"
         :proof (git-clean-checkout! root revision tree)})
      (let [store? (boolean (re-matches #"/nix/store/[a-z0-9]{32}-.+" root))]
        (when-not (and store? (not (str/blank? expected-revision))
                       (= expected-tree (str "immutable:" expected-revision)))
          (fail! "selected Fram runtime is neither a Git source nor an immutable store object"
                 :runtime-source-version-unavailable
                 {:root root :revision expected-revision :tree expected-tree}))
        {:revision expected-revision
         :tree expected-tree
         :provenance "nix-store"
         :proof {:immutable-store root}}))))

(defn- runtime-artifact-paths [root]
  (let [root-file (io/file root)
        root-clj (filter #(and (.isFile ^java.io.File %)
                              (str/ends-with? (.getName ^java.io.File %) ".clj"))
                         (or (.listFiles root-file)
                             (make-array java.io.File 0)))
        trees [(io/file root "out") (io/file root "chartroom/src")]
        runtime-clj (mapcat
                     (fn [directory]
                       (if-not (.isDirectory directory)
                         []
                         (filter #(and (.isFile ^java.io.File %)
                                       (str/ends-with?
                                        (.getName ^java.io.File %) ".clj"))
                                 (file-seq directory))))
                     trees)
        root-path (.toPath root-file)]
    (->> (concat (map #(io/file root %) required-runtime-artifacts)
                 root-clj runtime-clj)
         (map #(canonical-regular-file! "Fram runtime artifact" %))
         (map #(str/replace
                (.toString (.relativize root-path (.toPath (io/file %))))
                "\\" "/"))
         distinct
         sort
         vec)))

(defn fram-artifact-identity!
  [root expected-revision expected-tree]
  (let [canonical (.getCanonicalPath (io/file root))]
    (when-not (.isDirectory (io/file canonical))
      (fail! (str "Fram runtime source is not a directory: " canonical)
             :runtime-source-invalid {:root canonical}))
    (let [version (source-version! canonical expected-revision expected-tree)
          paths (runtime-artifact-paths canonical)
          rows (into
                (sorted-map)
                (map
                 (fn [relative]
                   (let [path (.getCanonicalPath (io/file canonical relative))
                         state (unix-file-state! "Fram runtime artifact" path)]
                     [relative
                      {:bytes (:size state)
                       :sha256 (sha256-file path)
                       :modified-millis (:mtime-millis state)
                       :modified-instant (:mtime-instant state)
                       :changed-millis (:ctime-millis state)
                       :changed-instant (:ctime-instant state)}]))
                paths))
          content (into
                   (sorted-map)
                   (map (fn [[relative row]]
                          [relative (select-keys row [:bytes :sha256])]))
                   rows)]
      {:source canonical
       :revision (:revision version)
       :tree (:tree version)
       :version-provenance (:provenance version)
       :source-proof (:proof version)
       :artifact-sha256
       (sha256-bytes
        (.getBytes (pr-str content) java.nio.charset.StandardCharsets/UTF_8))
       :artifact-count (count rows)
       :latest-artifact-mtime-millis
       (reduce max 0 (map :modified-millis (vals rows)))
       :latest-artifact-mtime-instant
       (latest-file-time (map :modified-instant (vals rows)))
       :latest-artifact-ctime-millis
       (reduce max 0 (map :changed-millis (vals rows)))
       :latest-artifact-ctime-instant
       (latest-file-time (map :changed-instant (vals rows)))})))

(defn- process-shape!
  [pid source daemon port served-log]
  (let [cwd (process-path pid "cwd")
        executable (process-path pid "exe")
        arguments (process-cmdline pid)
        selected-script (.getCanonicalPath (io/file source "coord_daemon.clj"))
        indexes (->> arguments
                     (keep-indexed
                      (fn [index argument]
                        (when (= selected-script
                                 (resolve-process-argument cwd argument))
                          index)))
                     vec)
        index (first indexes)
        suffix (when index (subvec arguments (inc index)))
        classpath (process-classpath-entries cwd arguments)
        selected-out (.getCanonicalPath (io/file source "out"))]
    (when-not
     (and (= source cwd)
          executable
          (= [selected-script] (mapv #(resolve-process-argument cwd (nth arguments %))
                                     indexes))
          (= 1 (count indexes))
          (= ["serve-flat" (str port) served-log]
             [(nth suffix 0 nil)
              (nth suffix 1 nil)
              (resolve-process-argument cwd (nth suffix 2 nil))])
          (= 3 (count suffix))
          (some #(= selected-out %) classpath))
      (fail! "protocol-ready socket is not the selected Fram runtime process"
             :runtime-process-attestation-failed
             {:reason :selected-artifact-mismatch :port port :pid pid
              :cwd cwd :executable executable :daemon daemon
              :selected-script selected-script :script-indexes indexes
              :suffix suffix :classpath classpath}))
    {:cwd cwd
     :executable (artifact-record "coordinator executable" executable)
     :script (artifact-record "Fram coordinator script" selected-script)
     :arguments-sha256
     (sha256-bytes
      (.getBytes (pr-str arguments) java.nio.charset.StandardCharsets/UTF_8))}))

(defn- exact-symlink-target! [label path expected-pattern]
  (let [nio (.toPath (io/file path))]
    (when-not (java.nio.file.Files/isSymbolicLink nio)
      (fail! (str label " is not a symbolic link: " path)
             :active-runtime-selector-invalid {:label label :path path}))
    (let [target (str (java.nio.file.Files/readSymbolicLink nio))]
      (when-not (re-matches expected-pattern target)
        (fail! (str label " has an invalid target: " target)
               :active-runtime-selector-invalid
               {:label label :path path :target target}))
      target)))

(defn- resolve-active-selection! [state-root]
  (when (str/blank? (str state-root))
    (fail! "active runtime state root is required"
           :active-runtime-selector-invalid))
  (let [root (.getCanonicalPath (io/file (str state-root)))
        root-state (unix-directory-state! "active runtime state root" root)
        current-link (str root "/current")
        active-link (str root "/active")
        current-target
        (exact-symlink-target! "stable runtime selector" current-link
                               #"active/current")
        active-target
        (exact-symlink-target! "active runtime generation selector" active-link
                               #"generations/[A-Za-z0-9._-]+")
        generation (.getCanonicalPath (io/file root active-target))
        generation-state
        (unix-directory-state! "active runtime generation" generation)
        member-link (str generation "/current")
        _ (when-not (java.nio.file.Files/isSymbolicLink
                     (.toPath (io/file member-link)))
            (fail! "active runtime generation has no current member"
                   :active-runtime-generation-invalid
                   {:path member-link}))
        source (.getCanonicalPath (io/file member-link))
        identity-path (str generation "/current.identity")
        identity (read-sealed-file! "runtime generation identity" identity-path)
        static (parse-static-runtime-identity! identity)]
    (when-not (and (= source (.getCanonicalPath (io/file (:source static))))
                   (= generation
                      (.getCanonicalPath (.getParentFile
                                          (io/file (:path identity)))))
                   (= (:uid root-state) (:uid generation-state)
                      (get-in identity [:state :uid]))
                   (= 1 (get-in identity [:state :nlink]))
                   (zero? (bit-and (get-in identity [:state :mode]) 18)))
      (fail! "active runtime generation identity does not bind its selected member"
             :active-runtime-generation-invalid
             {:generation generation :source source :static static
              :identity-state (:state identity)}))
    {:state-root root
     :state-root-state root-state
     :current-link {:path current-link :target current-target}
     :active-link {:path active-link :target active-target}
     :generation generation
     :generation-state generation-state
     :member-link member-link
     :source source
     :identity identity
     :static static
     :record-path (str generation "/" active-runtime-record-name)}))

(defn- canonical-existing-path! [label value]
  (when (str/blank? (str value))
    (fail! (str label " is blank") :active-runtime-record-invalid))
  (let [file (io/file (str value))]
    (when-not (.exists file)
      (fail! (str label " does not exist: " value)
             :active-runtime-record-invalid {:label label :path value}))
    (.getCanonicalPath file)))

(defn- parse-positive-long! [label value]
  (let [parsed (parse-long (str value))]
    (when-not (and parsed (pos? parsed))
      (fail! (str label " is not a positive integer: " value)
             :active-runtime-record-invalid {:label label :value value}))
    parsed))

(defn- valid-owner-token? [value]
  (try
    (= value (str (java.util.UUID/fromString value)))
    (catch Throwable _ false)))

(defn- parse-active-record!
  [selection explicit-record port served-log telemetry-log]
  (let [expected-path (:record-path selection)
        selected-path (or explicit-record expected-path)
        selected-canonical (.getCanonicalPath (io/file (str selected-path)))
        _ (when-not (= expected-path selected-canonical)
            (fail! "active runtime record is not scoped to the selected generation"
                   :active-runtime-record-invalid
                   {:expected expected-path :actual selected-canonical}))
        sealed (read-sealed-file! "active runtime identity" selected-canonical)
        record (exact-key-value-record! sealed)
        static (:static selection)
        generation
        (canonical-existing-path! "active runtime generation"
                                  (get record "GENERATION"))
        identity
        (canonical-existing-path! "active runtime generation identity"
                                  (get record "GENERATION_IDENTITY"))
        source (canonical-existing-path! "active Fram source"
                                         (get record "FRAM_RUNTIME_SOURCE"))
        daemon (canonical-existing-path! "active Fram daemon"
                                         (get record "FRAM_RUNTIME_DAEMON"))
        record-log (canonical-existing-path! "active coordination log"
                                             (get record "FRAM_LOG"))
        record-telemetry
        (canonical-existing-path! "active telemetry log"
                                  (get record "FRAM_TELEMETRY_LOG"))
        pid (parse-positive-long! "active runtime PID" (get record "PID"))
        main-pid (parse-positive-long! "active controller MainPID"
                                       (get record "CONTROLLER_MAIN_PID"))
        record-port (parse-positive-long! "active Fram port"
                                          (get record "FRAM_PORT"))]
    (when-not (and (= 384 (get-in sealed [:state :mode]))
                   (= 1 (get-in sealed [:state :nlink]))
                   (= (get-in selection [:generation-state :uid])
                      (get-in sealed [:state :uid]))
                   (= (:generation selection) (get record "GENERATION"))
                   (= (:generation selection) generation)
                   (= (get-in selection [:identity :path])
                      (get record "GENERATION_IDENTITY"))
                   (= (get-in selection [:identity :path]) identity)
                   (= (get-in selection [:identity :sha256])
                      (get record "GENERATION_IDENTITY_SHA256"))
                   (= (:source selection) source)
                   (= (:mode static) (get record "NORTH_FRAM_RUNTIME"))
                   (= (:source static) (get record "FRAM_RUNTIME_SOURCE"))
                   (= (:revision static) (get record "FRAM_RUNTIME_REV"))
                   (= (:tree static) (get record "FRAM_RUNTIME_TREE"))
                   (= (:origin static) (get record "FRAM_RUNTIME_ORIGIN"))
                   (= (:daemon static) (get record "FRAM_RUNTIME_DAEMON"))
                   (= source (.getCanonicalPath (.getParentFile
                                                 (.getParentFile
                                                  (io/file daemon)))))
                   (= record-port (long port))
                   (= pid main-pid)
                   (= record-log (.getCanonicalPath (io/file served-log)))
                   (= record-telemetry
                      (.getCanonicalPath (io/file telemetry-log)))
                   (not= record-log record-telemetry)
                   (re-matches #"proc:[1-9][0-9]*"
                               (get record "PID_BIRTH"))
                   (valid-owner-token? (get record "OWNER_TOKEN")))
      (fail! "active runtime identity does not exactly bind its generation, process, and split corpus"
             :active-runtime-record-invalid
             {:selection (select-keys selection [:generation :source])
              :record-path (:path sealed)}))
    {:sealed sealed :values record :pid pid :port record-port
     :coordination-log record-log :telemetry-log record-telemetry
     :source source :daemon daemon}))

(defn- parse-systemd-properties [output]
  (into {}
        (keep (fn [line]
                (when-let [index (str/index-of line "=")]
                  [(subs line 0 index) (subs line (inc index))])))
        (str/split-lines output)))

(defn systemd-main-pid! [unit]
  (when-not (re-matches #"[A-Za-z0-9@_.:-]+" (str unit))
    (fail! "active runtime controller unit name is unsafe"
           :active-runtime-controller-invalid {:unit unit}))
  (let [result
        (proc/shell {:out :string :err :string :continue true}
                    "systemctl" "show" unit "--no-pager"
                    "--property" "Id" "--property" "LoadState"
                    "--property" "ActiveState" "--property" "SubState"
                    "--property" "MainPID")
        properties (parse-systemd-properties (:out result))
        main-pid (parse-long (get properties "MainPID"))]
    (when-not (and (zero? (:exit result))
                   (= unit (get properties "Id"))
                   (= "loaded" (get properties "LoadState"))
                   (= "active" (get properties "ActiveState"))
                   (= "running" (get properties "SubState"))
                   main-pid (pos? main-pid))
      (fail! "active runtime controller is not one loaded, running systemd unit"
             :active-runtime-controller-invalid
             {:unit unit :properties properties
              :error (str/trim (:err result))}))
    {:kind "systemd" :unit unit :main-pid main-pid
     :load-state "loaded" :active-state "active" :sub-state "running"}))

(defn- controller-proof! [controller-mode controller-unit record pid]
  (let [record-unit (get record "CONTROLLER_UNIT")
        record-main (parse-positive-long! "active controller MainPID"
                                          (get record "CONTROLLER_MAIN_PID"))]
    (case (str controller-mode)
      "direct"
      (do
        (when-not (and (= "direct" record-unit) (= pid record-main))
          (fail! "direct runtime fixture has inconsistent controller identity"
                 :active-runtime-controller-invalid))
        {:kind "direct" :unit "direct" :main-pid pid})

      "systemd"
      (let [unit (or controller-unit "north-coord.service")
            proof (systemd-main-pid! unit)]
        (when-not (and (= unit record-unit)
                       (= pid record-main (:main-pid proof)))
          (fail! "active runtime PID is not the selected systemd MainPID"
                 :active-runtime-controller-invalid
                 {:record-unit record-unit :record-main record-main
                  :controller proof :pid pid}))
        proof)

      "auto"
      (let [unit (or controller-unit "north-coord.service")
            proof (systemd-main-pid! unit)]
        (when-not (and (= unit record-unit)
                       (= pid record-main (:main-pid proof)))
          (fail! "active runtime PID is not the selected systemd MainPID"
                 :active-runtime-controller-invalid
                 {:record-unit record-unit :record-main record-main
                  :controller proof :pid pid}))
        proof)

      (fail! "runtime controller mode must be systemd, auto, or explicit fixture-only direct"
             :active-runtime-controller-invalid
             {:mode controller-mode}))))

(defn- canonical-env-path [environment key]
  (when-let [value (get environment key)]
    (try (.getCanonicalPath (io/file value))
         (catch Throwable _ nil))))

(defn attest-active-runtime!
  "Attest the generation-scoped active runtime selected by state-root/active.

  The selector and static identity choose source bytes; active.runtime binds
  that generation to one minted-token process. Production additionally binds
  it to systemd MainPID. The explicit direct mode exists only for disposable
  owner/integration fixtures. Same-UID hostile code remains outside this local
  evidence boundary; all supported selector/launcher transitions are detected."
  [{:keys [port served-log telemetry-log state-root record-path
           controller-mode controller-unit]}]
  (let [selection (resolve-active-selection! state-root)
        parsed (parse-active-record! selection record-path port served-log
                                     telemetry-log)
        selection-after (resolve-active-selection! state-root)
        stable-selection (fn [value]
                           (update value :identity dissoc :bytes))]
    (when-not (= (stable-selection selection)
                 (stable-selection selection-after))
      (fail! "active runtime selector changed during attestation"
             :active-runtime-selector-raced
             {:before selection :after selection-after}))
    (let [record (:values parsed)
          pid (:pid parsed)
          pids (listener-pids port)
          actual-birth (process-birth-token pid)
          process-start (process-start-millis pid)
          environment (process-environment pid)
          controller (controller-proof!
                      (or controller-mode "auto") controller-unit record pid)
          artifact (fram-artifact-identity!
                    (:source parsed) (get record "FRAM_RUNTIME_REV")
                    (get record "FRAM_RUNTIME_TREE"))
          record-state (get-in parsed [:sealed :state])
          daemon (artifact-record "Fram daemon launcher" (:daemon parsed))
          shape (process-shape! pid (:source parsed) (:daemon parsed)
                                port (:coordination-log parsed))
          exact-environment
          {"NORTH_FRAM_RUNTIME" (get record "NORTH_FRAM_RUNTIME")
           "NORTH_COORD_SYSTEMD_UNIT" (get record "CONTROLLER_UNIT")
           "FRAM_RUNTIME_SOURCE" (get record "FRAM_RUNTIME_SOURCE")
           "FRAM_RUNTIME_REV" (get record "FRAM_RUNTIME_REV")
           "FRAM_RUNTIME_TREE" (get record "FRAM_RUNTIME_TREE")
           "FRAM_RUNTIME_ORIGIN" (get record "FRAM_RUNTIME_ORIGIN")
           "FRAM_RUNTIME_DAEMON" (get record "FRAM_RUNTIME_DAEMON")
           "FRAM_RUNTIME_OWNER_TOKEN" (get record "OWNER_TOKEN")
           "FRAM_PORT" (get record "FRAM_PORT")
           "FRAM_REQUIRE_LOG_FENCE" "1"}
          exact-path-environment
          {"NORTH_COORD_RUNTIME_STATE" (:state-root selection)
           "NORTH_COORD_RUNTIME_GENERATION" (:generation selection)
           "NORTH_COORD_RUNTIME_IDENTITY" (get-in selection [:identity :path])
           "NORTH_COORD_RUNTIME_FILE" (get-in parsed [:sealed :path])
           "FRAM_LOG" (:coordination-log parsed)
           "FRAM_TELEMETRY_LOG" (:telemetry-log parsed)}]
      (when-not
       (and (= [pid] pids)
            (= (get record "PID_BIRTH") actual-birth)
            (integer? process-start)
            (file-time<=? (:latest-artifact-mtime-instant artifact)
                          (:mtime-instant record-state))
            (file-time<=? (:latest-artifact-ctime-instant artifact)
                          (:ctime-instant record-state))
            (= exact-environment (select-keys environment
                                               (keys exact-environment)))
            (every? (fn [[key expected]]
                      (= expected (canonical-env-path environment key)))
                    exact-path-environment))
        (fail! "active runtime record, listener, process environment, and source artifacts disagree"
               :active-runtime-process-attestation-failed
               {:port port :pid pid :listener-pids pids
                :expected-birth (get record "PID_BIRTH")
                :actual-birth actual-birth
                :process-start-millis process-start
                :latest-artifact-mtime-millis
                (:latest-artifact-mtime-millis artifact)
                :latest-artifact-ctime-millis
                (:latest-artifact-ctime-millis artifact)
                :latest-artifact-mtime-instant
                (:latest-artifact-mtime-instant artifact)
                :latest-artifact-ctime-instant
                (:latest-artifact-ctime-instant artifact)
                :record-publication-mtime-millis (:mtime-millis record-state)
                :record-publication-ctime-millis (:ctime-millis record-state)
                :record-publication-mtime-instant (:mtime-instant record-state)
                :record-publication-ctime-instant (:ctime-instant record-state)
                :environment-keys (sort (concat (keys exact-environment)
                                                (keys exact-path-environment)))}))
      {:format active-attestation-format
       :request {:port (long port)
                 :served-log (.getCanonicalPath (io/file served-log))
                 :telemetry-log (.getCanonicalPath (io/file telemetry-log))
                 :state-root (:state-root selection)
                 :record-path (get-in parsed [:sealed :path])
                 :controller-mode (or controller-mode "auto")
                 :controller-unit controller-unit}
       :identity
       (merge
        (dissoc artifact :latest-artifact-mtime-millis
                :latest-artifact-mtime-instant
                :latest-artifact-ctime-millis
                :latest-artifact-ctime-instant)
        {:runtime-mode (get record "NORTH_FRAM_RUNTIME")
         :generation (:generation selection)
         :generation-identity
         {:path (get-in selection [:identity :path])
          :bytes (alength ^bytes (get-in selection [:identity :bytes]))
          :sha256 (get-in selection [:identity :sha256])}
         :daemon daemon
         :executable (:executable shape)
         :script (:script shape)
         :arguments-sha256 (:arguments-sha256 shape)
         :port (long port)
         :served-log (:coordination-log parsed)
         :telemetry-log (:telemetry-log parsed)
         :controller-unit (:unit controller)})
       :authority
       {:pid pid
        :pid-birth actual-birth
        :process-start-millis process-start
        :publication-freshness
        {:latest-artifact-mtime-millis
         (:latest-artifact-mtime-millis artifact)
         :latest-artifact-mtime-instant
         (:latest-artifact-mtime-instant artifact)
         :latest-artifact-ctime-millis
         (:latest-artifact-ctime-millis artifact)
         :latest-artifact-ctime-instant
         (:latest-artifact-ctime-instant artifact)
         :record-mtime-millis (:mtime-millis record-state)
         :record-mtime-instant (:mtime-instant record-state)
         :record-ctime-millis (:ctime-millis record-state)
         :record-ctime-instant (:ctime-instant record-state)}
        :owner-token-sha256
        (sha256-bytes
         (.getBytes (get record "OWNER_TOKEN")
                    java.nio.charset.StandardCharsets/UTF_8))
        :selector (select-keys selection
                               [:state-root :state-root-state :current-link
                                :active-link :generation :generation-state
                                :member-link :source])
        :active-record
        {:path (get-in parsed [:sealed :path])
         :bytes (alength ^bytes (get-in parsed [:sealed :bytes]))
         :sha256 (get-in parsed [:sealed :sha256])
         :state (get-in parsed [:sealed :state])}
        :controller controller}})))

(defn attest-runtime!
  "Attest the one process listening on port against a launcher-owned runtime
  identity record and the exact selected Fram artifacts.  No coordinator wire
  call occurs here, so this is safe while the corpus rewrite fence is held."
  [{:keys [port served-log record-path]}]
  (let [record-result (read-runtime-record! record-path)
        record (:values record-result)
        selected-source (.getCanonicalPath
                         (io/file (required-record-value!
                                   record "FRAM_RUNTIME_SOURCE")))
        selected-daemon (.getCanonicalPath
                         (io/file (required-record-value!
                                   record "FRAM_RUNTIME_DAEMON")))
        expected-revision (required-record-value! record "FRAM_RUNTIME_REV")
        expected-tree (required-record-value! record "FRAM_RUNTIME_TREE")
        expected-pid (parse-long (required-record-value! record "PID"))
        expected-birth (required-record-value! record "PID_BIRTH")
        owner-token (required-record-value! record "OWNER_TOKEN")
        pids (listener-pids port)]
    (when-not (and expected-pid (= [expected-pid] pids))
      (fail! "coordinator listener does not match its launcher-owned PID"
             :runtime-process-attestation-failed
             {:reason :listener-owner-count :port port
              :recorded-pid expected-pid :pids pids}))
    (let [pid expected-pid
          actual-birth (process-birth-token pid)
          process-start (process-start-millis pid)
          environment (process-environment pid)
          artifact (fram-artifact-identity!
                    selected-source expected-revision expected-tree)
          daemon (artifact-record "Fram daemon launcher" selected-daemon)
          shape (process-shape! pid selected-source selected-daemon port served-log)
          expected-environment
          {"FRAM_RUNTIME_SOURCE" selected-source
           "FRAM_RUNTIME_REV" expected-revision
           "FRAM_RUNTIME_TREE" expected-tree
           "FRAM_RUNTIME_DAEMON" selected-daemon
           "FRAM_RUNTIME_OWNER_TOKEN" owner-token}
          actual-environment (select-keys environment (keys expected-environment))]
      (when-not (and (= expected-birth actual-birth)
                     (integer? process-start)
                     (<= (:latest-artifact-mtime-millis artifact) process-start)
                     (= expected-environment actual-environment))
        (fail! "coordinator listener is not owned by the selected runtime record"
               :runtime-process-attestation-failed
               {:reason :launcher-ownership-mismatch :port port :pid pid
                :expected-birth expected-birth :actual-birth actual-birth
                :process-start-millis process-start
                :latest-artifact-mtime-millis
                (:latest-artifact-mtime-millis artifact)
                :environment-keys (sort (keys expected-environment))
                :owner-token-matches
                (= (get expected-environment "FRAM_RUNTIME_OWNER_TOKEN")
                   (get actual-environment "FRAM_RUNTIME_OWNER_TOKEN"))}))
      {:format attestation-format
       :identity
       (merge
        (dissoc artifact :latest-artifact-mtime-millis
                :latest-artifact-mtime-instant
                :latest-artifact-ctime-millis
                :latest-artifact-ctime-instant)
        {:daemon daemon
         :executable (:executable shape)
         :script (:script shape)
         :arguments-sha256 (:arguments-sha256 shape)
         :port port
         :served-log (.getCanonicalPath (io/file served-log))})
       :authority
       {:pid pid
        :pid-birth actual-birth
        :process-start-millis process-start
        :owner-token-sha256
        (sha256-bytes
         (.getBytes owner-token java.nio.charset.StandardCharsets/UTF_8))
        :identity-record (:artifact record-result)}})))

(defn assert-current!
  "Re-attest without a coordinator wire call and require the exact same process
  authority and stable runtime identity."
  [attestation]
  (let [active? (= active-attestation-format (:format attestation))
        record-path (get-in attestation [:authority :identity-record :path])
        identity (:identity attestation)
        current
        (try
          (if active?
            (attest-active-runtime! (:request attestation))
            (attest-runtime! {:port (:port identity)
                              :served-log (:served-log identity)
                              :record-path record-path}))
          (catch Throwable error
            (fail! "selected Fram runtime authority changed"
                   :runtime-authority-lost
                   {:expected attestation
                    :cause (.getMessage error)
                    :cause-data (ex-data error)})))]
    (when-not (= attestation current)
      (fail! "selected Fram runtime authority changed"
             :runtime-authority-lost
             {:expected attestation :actual current}))
    true))
