#!/usr/bin/env bb
(require '[babashka.process :as p]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(load-file (str root "/cli/harness-state.clj"))

(def home (.toFile (java.nio.file.Files/createTempDirectory
                    "north-harness-state-"
                    (make-array java.nio.file.attribute.FileAttribute 0))))
(def home-path (.getCanonicalPath home))
(def canonical (north.harness-state/canonical-path home-path))
(def legacy (north.harness-state/legacy-path home-path))
(def lock-file (north.harness-state/lock-path home-path))
(def checks (atom []))
(defn check [label value] (swap! checks conj [label (boolean value)]))

(defn permission-string [path]
  (java.nio.file.attribute.PosixFilePermissions/toString
   (java.nio.file.Files/getPosixFilePermissions
    (.toPath (io/file path))
    (make-array java.nio.file.LinkOption 0))))

(defn file-key [path]
  (.fileKey
   (java.nio.file.Files/readAttributes
    (.toPath (io/file path))
    java.nio.file.attribute.BasicFileAttributes
    (make-array java.nio.file.LinkOption 0))))

(defn await-file-count [directory expected]
  (loop [attempt 0]
    (let [files (.listFiles (io/file directory))
          count (if files (alength files) 0)]
      (cond
        (= count expected) true
        (>= attempt 1000) false
        :else (do (Thread/sleep 10) (recur (inc attempt)))))))

(try
  (let [config-source (slurp (str root "/cli/config-cli.clj"))]
    (check "guard help limits the switch to authoring guards"
           (and (str/includes? config-source "authoring guards OFF; dispatch topology unchanged")
                (not (str/includes? config-source "ALL GUARDS OFF"))))
    (check "guard help names dispatch as the independent topology axis"
           (str/includes? config-source "`north config\n   dispatch` owns that independent axis")))
  (io/make-parents legacy)
  (spit legacy "dispatch=warn\nguards=off\n")
  (check "legacy state is a read-only fallback while canonical is absent"
         (and (= legacy (north.harness-state/source-path home-path))
              (= "warn" (north.harness-state/get-value home-path "dispatch" "north"))
              (= "off" (north.harness-state/get-value home-path "guards" "on"))))

  (north.harness-state/put-value! home-path "dispatch" "north")
  (check "first write seeds canonical state with legacy values"
         (and (= canonical (north.harness-state/source-path home-path))
              (= "north" (north.harness-state/get-value home-path "dispatch" nil))
              (= "off" (north.harness-state/get-value home-path "guards" nil))))
  (check "migration never mutates the Claude-era file"
         (= "dispatch=warn\nguards=off\n" (slurp legacy)))

  (check "canonical state, persistent lock, and state directory are owner-only"
         (and (= "rw-------" (permission-string canonical))
              (= "rw-------" (permission-string lock-file))
              (= "rwx------" (permission-string (.getParent (io/file canonical))))))

  (let [lock-key-before (file-key lock-file)
        state-key-before (file-key canonical)]
    (north.harness-state/put-value! home-path "mode-probe" "one")
    (check "atomic target replacement preserves the separate lock inode"
           (and (= lock-key-before (file-key lock-file))
                (not= state-key-before (file-key canonical)))))

  (spit legacy "dispatch=native\nguards=on\n")
  (check "legacy changes are ignored once canonical state exists"
         (and (= "north" (north.harness-state/get-value home-path "dispatch" nil))
              (= "off" (north.harness-state/get-value home-path "guards" nil))))
  (check "atomic writer leaves no temporary files"
         (empty? (filter #(str/starts-with? (.getName %) ".harness.")
                         (.listFiles (io/file home-path ".local/state/north")))))

  (let [config (p/shell {:out :string :err :string :continue true
                         :extra-env {"HOME" home-path "NORTH_HOME" root}}
                        "bb" (str root "/cli/config-cli.clj") "dispatch")]
    (check "config CLI reads the canonical state through the shared adapter"
           (and (zero? (:exit config)) (str/includes? (:out config) "dispatch = north"))))

  (let [dashboard (p/shell
                   {:out :string :err :string :continue true
                    :extra-env {"HOME" home-path "NORTH_HOME" root "NORTH_DASHBOARD_LIB" "1"}}
                   "bb" "-e"
                   (str "(load-file " (pr-str (str root "/cli/dashboard-cli.clj")) ") "
                        "(println (dispatch-mode))"))]
    (check "dashboard reads the same canonical state adapter"
           (and (zero? (:exit dashboard)) (= "north" (str/trim (:out dashboard))))))

  (let [bad-key (try (north.harness-state/put-value! home-path "bad\nkey" "x") false
                     (catch Exception _ true))
        bad-value (try (north.harness-state/put-value! home-path "guards" "off\non") false
                       (catch Exception _ true))]
    (check "state writer rejects line injection" (and bad-key bad-value)))

  (let [shared-dir (io/file home "shared-state")
        custom-state (str (io/file shared-dir "custom.conf"))
        custom-lock (str custom-state ".lock")
        _ (.mkdirs shared-dir)
        _ (java.nio.file.Files/setPosixFilePermissions
           (.toPath shared-dir)
           (java.nio.file.attribute.PosixFilePermissions/fromString "rwxr-xr-x"))
        result (p/shell
                {:out :string :err :string :continue true
                 :extra-env {"NORTH_HARNESS_STATE" custom-state
                             "NORTH_LEGACY_HARNESS_STATE" (str (io/file shared-dir "legacy.conf"))}}
                "bb" "-e"
                (str "(load-file " (pr-str (str root "/cli/harness-state.clj")) ") "
                     "(north.harness-state/put-value! " (pr-str home-path)
                     " \"custom\" \"safe\")"))]
    (check "custom state secures its files without chmodding a shared parent"
           (and (zero? (:exit result))
                (= "rwxr-xr-x" (permission-string shared-dir))
                (= "rw-------" (permission-string custom-state))
                (= "rw-------" (permission-string custom-lock)))))

  ;; A shared start gate makes every process enter the read-modify-replace path
  ;; together. Without a cross-process lock, later atomic renames erase sibling
  ;; keys even though every individual file is well formed.
  (let [worker-count 32
        ready-dir (io/file home "stress-ready")
        gate (io/file home "stress-go")
        _ (.mkdirs ready-dir)
        processes
        (mapv
         (fn [index]
           (let [key (str "stress-" index)
                 value (str "value-" index)
                 ready (str (io/file ready-dir (str index)))
                 expression
                 (str "(load-file " (pr-str (str root "/cli/harness-state.clj")) ")\n"
                      "(spit " (pr-str ready) " \"ready\")\n"
                      "(loop [attempt 0] "
                      "  (cond (.isFile (java.io.File. " (pr-str (str gate)) ")) nil "
                      "        (>= attempt 2000) (throw (ex-info \"stress gate timeout\" {})) "
                      "        :else (do (Thread/sleep 5) (recur (inc attempt)))))\n"
                      "(north.harness-state/put-value! " (pr-str home-path) " "
                      (pr-str key) " " (pr-str value) ")")]
             (p/process
              ["bb" "-e" expression]
              {:out :string :err :string
               :extra-env {"NORTH_HARNESS_STATE" canonical
                           "NORTH_LEGACY_HARNESS_STATE" legacy}})))
         (range worker-count))
        all-ready? (await-file-count ready-dir worker-count)
        _ (spit gate "go")
        results (mapv deref processes)
        workers-ok? (every? #(zero? (:exit %)) results)
        keys-preserved?
        (every? (fn [index]
                  (= (str "value-" index)
                     (north.harness-state/get-value
                      home-path (str "stress-" index) nil)))
                (range worker-count))]
    (when-not workers-ok?
      (doseq [[index result] (map-indexed vector results)
              :when (not (zero? (:exit result)))]
        (binding [*out* *err*]
          (println "stress worker" index "failed:" (str/trim (:err result))))))
    (check "multiprocess writers reach the shared start gate" all-ready?)
    (check "multiprocess writers all exit successfully" workers-ok?)
    (check "transaction lock preserves every distinct concurrent key" keys-preserved?))

  (finally
    (doseq [file (reverse (file-seq home))] (io/delete-file file true))))

(let [results @checks pass (count (filter second results))]
  (doseq [[label ok] results]
    (println (format "  [%s] %s" (if ok "PASS" "FAIL") label)))
  (println (format "\nharness state: %d / %d PASS" pass (count results)))
  (System/exit (if (= pass (count results)) 0 1)))
