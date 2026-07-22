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
(def proc-read-limit (* 16 1024 1024))
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

(defn- source-version! [root expected-revision expected-tree]
  (if (.isDirectory (io/file root ".git"))
    (let [revision (git-value! root "HEAD" :fram-revision-unavailable)
          tree (git-value! root "HEAD^{tree}" :fram-tree-unavailable)]
      (when-not (and (= expected-revision revision) (= expected-tree tree))
        (fail! "launcher runtime revision/tree does not match its selected source"
               :runtime-source-version-mismatch
               {:expected {:revision expected-revision :tree expected-tree}
                :actual {:revision revision :tree tree} :root root}))
      {:revision revision :tree tree :provenance "git"})
    (let [store? (boolean (re-matches #"/nix/store/[a-z0-9]{32}-.+" root))]
      (when-not (and store? (not (str/blank? expected-revision))
                     (= expected-tree (str "immutable:" expected-revision)))
        (fail! "selected Fram runtime is neither a Git source nor an immutable store object"
               :runtime-source-version-unavailable
               {:root root :revision expected-revision :tree expected-tree}))
      {:revision expected-revision :tree expected-tree :provenance "nix-store"})))

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
                   (let [path (.getCanonicalPath (io/file canonical relative))]
                     [relative
                      {:bytes (.length (io/file path))
                       :sha256 (sha256-file path)
                       :modified-millis
                       (.toMillis
                        (java.nio.file.Files/getLastModifiedTime
                         (.toPath (io/file path))
                         (make-array java.nio.file.LinkOption 0)))}]))
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
       :artifact-sha256
       (sha256-bytes
        (.getBytes (pr-str content) java.nio.charset.StandardCharsets/UTF_8))
       :artifact-count (count rows)
       :latest-artifact-mtime-millis
       (reduce max 0 (map :modified-millis (vals rows)))})))

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
        (dissoc artifact :latest-artifact-mtime-millis)
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
  (let [record-path (get-in attestation [:authority :identity-record :path])
        identity (:identity attestation)
        current
        (try
          (attest-runtime! {:port (:port identity)
                            :served-log (:served-log identity)
                            :record-path record-path})
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
