#!/usr/bin/env bb
(ns north.snapshot-cli
  (:require [clojure.java.io :as io]
            [clojure.string :as str]))

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "..")))
(load-file (str root "/cli/coord.clj"))
(load-file (str root "/cli/corpus-transaction.clj"))
(load-file (str root "/cli/runtime-attestation.clj"))
(load-file (str root "/cli/snapshot.clj"))
(require '[north.coord :as coord]
         '[north.corpus-transaction :as ct]
         '[north.runtime-attestation :as runtime-attestation]
         '[north.snapshot :as snapshot])

(defn die! [message]
  (binding [*out* *err*] (println (str "north snapshot: " message)))
  (System/exit 2))

(defn env-value [name]
  (let [value (System/getenv name)]
    (when-not (str/blank? value) value)))

(defn parse-port! [value]
  (let [port (parse-long (str value))]
    (when-not (and port (<= 1 port 65535))
      (die! (str "port must be an integer from 1 through 65535: " value)))
    (int port)))

(def port (parse-port! (first *command-line-args*)))
(def args (vec (rest *command-line-args*)))
(def coordination-log
  (.getCanonicalPath
   (io/file (or (env-value "FRAM_LOG")
                (str (System/getProperty "user.home")
                     "/.local/state/north/coordination.log")))))
(def telemetry-log
  (some-> (env-value "FRAM_TELEMETRY_LOG") io/file .getCanonicalPath))

(defn state-home []
  (or (env-value "XDG_STATE_HOME")
      (str (System/getProperty "user.home") "/.local/state")))

(defn default-store [] (str (state-home) "/north/snapshots"))
(defn runtime-file []
  (or (env-value "NORTH_COORD_RUNTIME_FILE")
      (str (state-home) "/north/fram-daemon-" port ".runtime")))

(defn require-split-live! []
  (when-not telemetry-log
    (ct/fail! "snapshot requires the explicit split corpus selector FRAM_TELEMETRY_LOG"))
  (snapshot/live-pair! {:coordination coordination-log
                        :telemetry telemetry-log})
  {:coordination coordination-log :telemetry telemetry-log})

(defn capture-runtime! []
  (let [strict (coord/strict-coordinator-status port coordination-log)]
    (when-not (:ready strict)
      (ct/fail! "coordinator is not strict-ready on the selected coordination log"
                {:status strict}))
    (let [status (coord/send-op port {:op :status})
          served (some-> (:log status) io/file .getCanonicalPath)
          record-path (.getCanonicalPath (io/file (runtime-file)))]
      (when-not (= coordination-log served)
        (ct/fail! "coordinator status reports the wrong served log"
                  {:expected coordination-log :served served}))
      {:selector (or (env-value "NORTH_FRAM_RUNTIME") "auto")
       :attestation
       (runtime-attestation/attest-runtime!
        {:port port :served-log served :record-path record-path})
       :protocol {:rollback-floor (:rollback_floor status)}})))

(defn assert-runtime-current! [runtime]
  (runtime-attestation/assert-current! (:attestation runtime)))

(defn run-command [command]
  (let [builder (doto (ProcessBuilder. ^java.util.List (mapv str command))
                  (.redirectErrorStream true))
        process (.start builder)
        output (slurp (.getInputStream process))
        exit (.waitFor process)]
    {:exit exit :output output}))

(def systemd-properties
  ["Id" "LoadState" "FragmentPath" "ExecCondition" "ExecStartPre"
   "ExecStart" "ExecStartPost" "User" "Restart"])

(defn parse-properties [output]
  (into {}
        (keep (fn [line]
                (when-let [index (str/index-of line "=")]
                  [(subs line 0 index) (subs line (inc index))])))
        (str/split-lines output)))

(defn systemd-static-identity! [unit]
  (let [arguments (into ["systemctl" "show" unit "--no-pager"]
                        (mapcat (fn [property] ["--property" property])
                                systemd-properties))
        result (run-command arguments)]
    (when-not (zero? (:exit result))
      (ct/fail! (str "systemd controller inspection failed: "
                     (str/trim (:output result)))))
    (let [properties (parse-properties (:output result))
          fragment (get properties "FragmentPath")]
      (when-not (= "loaded" (get properties "LoadState"))
        (ct/fail! (str "systemd controller is not loaded: " unit)))
      (when (str/blank? fragment)
        (ct/fail! (str "systemd controller has no fragment path: " unit)))
      {:kind "systemd"
       :unit (get properties "Id")
       :fragment-path fragment
       :fragment (ct/artifact-record (.getCanonicalPath (io/file fragment)))
       :exec-condition (get properties "ExecCondition")
       :exec-start-pre (get properties "ExecStartPre")
       :exec-start (get properties "ExecStart")
       :exec-start-post (get properties "ExecStartPost")
       :user (get properties "User")
       :restart (get properties "Restart")})))

(defn direct-static-identity! []
  (let [launcher (.getCanonicalPath
                  (io/file (or (env-value "NORTH_COORD_LAUNCHER")
                               (str root "/bin/north-coord-up"))))]
    {:kind "direct" :launcher (ct/artifact-record launcher)}))

(defn capture-controller! []
  (let [configured (or (env-value "NORTH_CORPUS_CONTROLLER") "auto")
        unit (or (env-value "NORTH_COORD_SYSTEMD_UNIT") "north-coord.service")]
    (case configured
      "systemd" (systemd-static-identity! unit)
      "direct" (direct-static-identity!)
      "auto" (let [probe (run-command
                          ["systemctl" "show" unit "--property" "LoadState"
                           "--value" "--no-pager"])]
               (if (and (zero? (:exit probe))
                        (= "loaded" (str/trim (:output probe))))
                 (systemd-static-identity! unit)
                 (direct-static-identity!)))
      (ct/fail! (str "NORTH_CORPUS_CONTROLLER must be auto, systemd, or direct: "
                     configured)))))

(defn assert-controller-current! [expected]
  (let [actual (capture-controller!)]
    (when-not (= expected actual)
      (ct/fail! "coordinator controller identity changed during snapshot work"
                {:expected expected :actual actual}))
    true))

(defn hostname []
  (or (env-value "HOSTNAME")
      (try (.getHostName (java.net.InetAddress/getLocalHost))
           (catch Throwable _ "unknown-host"))))

(defn creation-provenance []
  {:actor (or (env-value "NORTH_AUTHOR")
              (System/getProperty "user.name") "unknown")
   :host (hostname)
   :tool "north snapshot"
   :implementation (ct/artifact-record (str root "/cli/snapshot.clj"))})

(defn parse-options! [arguments]
  (loop [remaining (vec arguments)
         result {:execute? false :mode nil :store (default-store)
                 :positionals []}]
    (if (empty? remaining)
      (dissoc result :mode)
      (let [argument (first remaining)]
        (case argument
          "--execute"
          (do
            (when (:mode result) (die! "choose exactly one of --execute or --dry-run"))
            (recur (subvec remaining 1)
                   (assoc result :execute? true :mode :execute)))

          "--dry-run"
          (do
            (when (:mode result) (die! "choose exactly one of --execute or --dry-run"))
            (recur (subvec remaining 1)
                   (assoc result :execute? false :mode :dry-run)))

          "--store"
          (do
            (when (< (count remaining) 2)
              (die! "--store requires a directory"))
            (recur (subvec remaining 2)
                   (assoc result :store (second remaining))))

          (if (str/starts-with? argument "--")
            (die! (str "unknown option: " argument))
            (recur (subvec remaining 1)
                   (update result :positionals conj argument))))))))

(defn options-base [parsed]
  {:store (:store parsed)
   :live (require-split-live!)
   :runtime! capture-runtime!
   :runtime-current! assert-runtime-current!
   :controller! capture-controller!
   :controller-current! assert-controller-current!
   :provenance (creation-provenance)
   :execute? (:execute? parsed)})

(defn create-command! [arguments]
  (let [parsed (parse-options! arguments)]
    (when (seq (:positionals parsed))
      (die! "usage: north snapshot create [--store DIR] [--dry-run|--execute]"))
    (snapshot/create-snapshot! (options-base parsed))))

(defn verify-command! [arguments]
  (let [parsed (parse-options! arguments)]
    (when (:execute? parsed)
      (die! "snapshot verify is read-only and does not accept --execute"))
    (when-not (= 1 (count (:positionals parsed)))
      (die! "usage: north snapshot verify SNAPSHOT [--store DIR] [--dry-run]"))
    (-> (options-base parsed)
        (assoc :selector (first (:positionals parsed)))
        snapshot/verify-snapshot!
        (select-keys [:ok :snapshot-id :directory :manifest-path]))))

(defn restore-plan-command! [arguments]
  (let [parsed (parse-options! arguments)]
    (when-not (= 1 (count (:positionals parsed)))
      (die! (str "usage: north snapshot restore-plan SNAPSHOT "
                 "[--store DIR] [--dry-run|--execute]")))
    (snapshot/restore-plan!
     (assoc (options-base parsed) :selector (first (:positionals parsed))))))

(defn usage! []
  (die! (str "usage: north snapshot "
             "{create [--store DIR] [--dry-run|--execute]|"
             "verify SNAPSHOT [--store DIR] [--dry-run]|"
             "restore-plan SNAPSHOT [--store DIR] [--dry-run|--execute]}")))

(try
  (let [result
        (case (first args)
          "create" (create-command! (subvec args 1))
          "verify" (verify-command! (subvec args 1))
          "restore-plan" (restore-plan-command! (subvec args 1))
          (usage!))]
    (prn result))
  (catch clojure.lang.ExceptionInfo error
    (binding [*out* *err*]
      (println (str "north snapshot: REFUSED — " (.getMessage error))))
    (System/exit 1)))
