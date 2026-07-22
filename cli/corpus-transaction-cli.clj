#!/usr/bin/env bb
(ns north.corpus-transaction-cli
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [fram.fold :as fold]
            [fram.rt :as rt]))

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "..")))
(load-file (str root "/cli/coord.clj"))
(load-file (str root "/cli/corpus-transaction.clj"))
(require '[north.coord :as coord]
         '[north.corpus-transaction :as ct])

(def maintenance-resource "north-corpus-maintenance")
(def maintenance-ttl-ms (* 60 60 1000))

(defn die! [message]
  (binding [*out* *err*] (println (str "north corpus-transaction: " message)))
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
  (when-let [path (env-value "FRAM_TELEMETRY_LOG")]
    (.getCanonicalPath (io/file path))))

(defn require-split-corpus! []
  (when-not telemetry-log
    (ct/fail! "split-corpus maintenance requires FRAM_TELEMETRY_LOG"))
  (when (= coordination-log telemetry-log)
    (ct/fail! "coordination and telemetry logs must be distinct"))
  {:coordination coordination-log :telemetry telemetry-log})

(defn check-one-boundary! [label path]
  (let [file (io/file path)]
    ;; A never-created log is the empty corpus at first boot. Existing paths
    ;; must be real regular files and obey the flat-log terminal-LF invariant.
    (when (.exists file)
      (ct/canonical-regular-file! label path)
      (ct/verify-append-boundary! label path))))

(defn check-live-boundaries! []
  (let [live (require-split-corpus!)]
    (doseq [role ct/roles]
      (check-one-boundary! (str "live " (name role) " corpus") (get live role)))
    {:ok true :live live}))

(defn run-command [command]
  (let [builder (doto (ProcessBuilder. ^java.util.List (mapv str command))
                  (.redirectErrorStream true))
        environment (.environment builder)
        _ (.put environment "FRAM_PORT" (str port))
        _ (.put environment "FRAM_LOG" coordination-log)
        _ (when telemetry-log
            (.put environment "FRAM_TELEMETRY_LOG" telemetry-log))
        process (.start builder)
        output (slurp (.getInputStream process))
        exit (.waitFor process)]
    {:command (mapv str command) :exit exit :output output}))

(defn run-command! [label command]
  (let [result (run-command command)]
    (when-not (zero? (:exit result))
      (ct/fail! (str label " failed (exit " (:exit result) "): "
                     (str/trim (:output result)))
                {:command (:command result) :exit (:exit result)}))
    result))

(defn parse-properties [output]
  (into {}
        (keep (fn [line]
                (when-let [index (str/index-of line "=")]
                  [(subs line 0 index) (subs line (inc index))])))
        (str/split-lines output)))

(def systemd-properties
  ["Id" "LoadState" "FragmentPath" "ExecCondition" "ExecStartPre"
   "ExecStart" "ExecStartPost" "User" "Restart" "ControlGroup" "MainPID"
   "ActiveState" "SubState"])

(defn systemctl-show [unit]
  (let [arguments (into ["systemctl" "show" unit "--no-pager"]
                        (mapcat (fn [property] ["--property" property])
                                systemd-properties))]
    (parse-properties (:output (run-command! "systemd unit inspection" arguments)))))

(defn systemd-static-identity! [unit]
  (let [properties (systemctl-show unit)
        fragment (get properties "FragmentPath")]
    (when-not (= "loaded" (get properties "LoadState"))
      (ct/fail! (str "systemd controller is not loaded: " unit)))
    (when (str/blank? fragment)
      (ct/fail! (str "systemd controller has no fragment path: " unit)))
    (let [resolved (.getCanonicalPath (io/file fragment))]
      {:kind "systemd"
       :unit (get properties "Id")
       :fragment-path fragment
       :fragment (ct/artifact-record resolved)
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
    {:kind "direct"
     :launcher (ct/artifact-record launcher)}))

(defn controller-mode []
  (let [configured (or (env-value "NORTH_CORPUS_CONTROLLER") "auto")
        unit (or (env-value "NORTH_COORD_SYSTEMD_UNIT") "north-coord.service")]
    (case configured
      "systemd" {:mode :systemd :unit unit}
      "direct" {:mode :direct}
      "auto"
      (let [probe (run-command ["systemctl" "show" unit "--property" "LoadState"
                                "--value" "--no-pager"])]
        (if (and (zero? (:exit probe)) (= "loaded" (str/trim (:output probe))))
          {:mode :systemd :unit unit}
          {:mode :direct}))
      (ct/fail! (str "NORTH_CORPUS_CONTROLLER must be auto, systemd, or direct: "
                     configured)))))

(defn capture-controller! []
  (let [{:keys [mode unit]} (controller-mode)]
    (case mode
      :systemd (systemd-static-identity! unit)
      :direct (direct-static-identity!))))

(defn assert-controller! [expected]
  (let [actual (case (:kind expected)
                 "systemd" (systemd-static-identity! (:unit expected))
                 "direct" (direct-static-identity!)
                 (ct/fail! (str "unknown journal controller: " (:kind expected))))]
    (when-not (= expected actual)
      (ct/fail! "coordinator controller identity changed during corpus maintenance"
                {:expected expected :actual actual}))
    actual))

(defn port-open? []
  (try
    (with-open [socket (java.net.Socket.)]
      (.connect socket (java.net.InetSocketAddress. "127.0.0.1" port) 250)
      true)
    (catch java.io.IOException _ false)))

(defn assert-offline! []
  (when (port-open?)
    (ct/fail! (str "coordinator port remains occupied: " port)))
  ;; A second observation rejects the edge where a Restart=always unit reclaims
  ;; the port immediately after the first empty observation.
  (Thread/sleep 100)
  (when (port-open?)
    (ct/fail! (str "coordinator port was reclaimed during offline proof: " port)))
  {:ok true})

(defn sudo-systemctl! [& arguments]
  (run-command! "systemd controller operation"
                (into ["sudo" "-n" "systemctl"] arguments)))

(defn stop-controller! [controller]
  (assert-controller! controller)
  (case (:kind controller)
    "systemd"
    (do (sudo-systemctl! "stop" (:unit controller))
        (let [properties (systemctl-show (:unit controller))]
          (when-not (#{"inactive" "failed"} (get properties "ActiveState"))
            (ct/fail! (str "systemd controller did not stop: "
                           (get properties "ActiveState") "/"
                           (get properties "SubState"))))))
    "direct"
    (run-command! "direct coordinator stop"
                  [(get-in controller [:launcher :path]) "--stop"]))
  (assert-offline!))

(defn start-controller! [controller]
  (assert-controller! controller)
  (case (:kind controller)
    "systemd"
    ;; Do not wait for the full unit: ExecStartPost waits on the transaction
    ;; lock while this owner process verifies and settles the same journal.
    (sudo-systemctl! "start" "--no-block" (:unit controller))
    "direct"
    (run-command! "direct coordinator start"
                  [(get-in controller [:launcher :path])]))
  {:ok true})

(defn wait-for-restart! [journal]
  (let [controller (get-in journal [:runtime :controller])
        checkpoint-version (long (get-in journal [:checkpoint :version] 0))
        minimum (if (= "committed" (:data-result journal))
                  (max checkpoint-version
                       (long (get-in journal [:target :corpus-max-tx] 0)))
                  checkpoint-version)
        deadline (+ (System/currentTimeMillis) 30000)]
    (loop [last-status nil]
      (assert-controller! controller)
      (let [strict (coord/strict-coordinator-status port coordination-log)
            status (when (:ready strict)
                     (coord/send-op port {:op :status}))]
        (if (and (:ready strict)
                 (string? (:log status))
                 (= coordination-log
                    (.getCanonicalPath (io/file (:log status))))
                 (integer? (:version status))
                 (>= (:version status) minimum))
          {:ok true
           :controller controller
           :coordination-log coordination-log
           :telemetry-log telemetry-log
           :version (:version status)
           :minimum-version minimum
           :strict strict
           :status status}
          (if (< (System/currentTimeMillis) deadline)
            (do (Thread/sleep 250) (recur (or status strict)))
            (ct/fail! (str "coordinator restart did not verify within 30s: "
                           (pr-str last-status)))))))))

(defn read-suffix-bytes! [path offset]
  (let [file (io/file path)
        remaining (- (.length file) (long offset))]
    (when (or (neg? remaining) (> remaining (* 1024 1024)))
      (ct/fail! (str "post-plan coordination suffix is outside the 1 MiB bound: "
                     remaining)))
    (let [payload (byte-array (int remaining))]
      (with-open [raf (java.io.RandomAccessFile. file "r")]
        (.seek raf (long offset))
        (.readFully raf payload))
      payload)))

(defn prove-lease-only-suffix! [original current lease]
  (when-not (ct/record-prefix-matches? original (:path current))
    (ct/fail! "coordination corpus changed outside its sealed pre-lease prefix"))
  (let [payload (read-suffix-bytes! (:path current) (:bytes original))
        text (String. payload java.nio.charset.StandardCharsets/UTF_8)
        lines (remove str/blank? (str/split-lines text))
        records (mapv (fn [line]
                        (try (edn/read-string line)
                             (catch Exception _
                               (ct/fail! "post-plan coordination suffix is not EDN"))))
                      lines)
        lease-value (str (:holder lease) "|" (:exp lease) "|" (:epoch lease))
        lease-subject (str "@lease:" (:resource lease))]
    (when-not (and (pos? (alength payload))
                   (= 10 (aget payload (dec (alength payload))))
                   (seq records)
                   (every? #(= (:epoch lease) (:tx %)) records)
                   (some #(and (= "assert" (:op %))
                               (= lease-subject (:l %))
                               (= "lease" (:p %))
                               (= lease-value (:r %)))
                         records))
      (ct/fail! "post-plan coordination suffix is not exactly the acquired lease transaction"))
    {:records (count records) :bytes (alength payload)}))

(defn candidate-max-tx! [candidate]
  (into {}
        (map (fn [role]
               [role (fold/fold-version
                      (fold/fold (rt/read-log (get-in candidate [role :path]))))])
             ct/roles)))

(defn acquire-lease! []
  (let [holder (str "north-corpus-transaction/" (java.util.UUID/randomUUID))
        response (coord/send-op
                  port {:op :acquire-lease :res maintenance-resource
                        :holder holder :ttl-ms maintenance-ttl-ms})]
    (if (:ok response)
      {:ok true
       :resource maintenance-resource
       :holder holder
       :epoch (:epoch response)
       :exp (:exp response)}
      response)))

(defn release-exact-lease! [lease]
  (let [response (coord/send-op
                  port {:op :release-lease
                        :res (:resource lease)
                        :holder (:holder lease)
                        :epoch (:epoch lease)})]
    (if (:ok response)
      {:ok true :response response}
      response)))

(defn settle-exact-lease! [lease _journal]
  (let [before (coord/lease-of port (:resource lease))
        response (coord/send-op
                  port {:op :release-lease
                        :res (:resource lease)
                        :holder (:holder lease)
                        :epoch (:epoch lease)})
        after (coord/lease-of port (:resource lease))
        successor? (and before
                        (not= [(:holder lease) (:epoch lease)]
                              [(:holder before) (:epoch before)]))]
    (when (and successor? (not= before after))
      (ct/fail! "exact stale-epoch settlement disturbed a successor lease"
                {:before before :after after :response response}))
    (if (:ok response)
      {:ok true
       :state (cond successor? :successor-preserved
                    (:noop response) :absent-noop
                    :else :released)
       :response response
       :before before
       :after after}
      response)))

(defn checkpoint-source! [verified lease]
  (let [live {:coordination
              (ct/corpus-file-record "post-lease coordination" coordination-log)
              :telemetry
              (ct/corpus-file-record "post-lease telemetry" telemetry-log)}
        version (coord/cur-ver port)
        observed (coord/lease-of port maintenance-resource)
        candidate
        (into {}
              (map (fn [role]
                     [role (ct/corpus-file-record
                            (str "final candidate " (name role))
                            (get-in verified [:candidate role :path]))])
                   ct/roles))
        maxima (candidate-max-tx! candidate)]
    (when-not (= (:epoch lease) version)
      (ct/fail! (str "concurrent graph write crossed lease acquisition: lease epoch "
                     (:epoch lease) ", checkpoint version " version)))
    (when-not (= [(:holder lease) (:epoch lease)]
                 [(:holder observed) (:epoch observed)])
      (ct/fail! "acquired maintenance lease is not the live exact epoch"))
    (when-not (ct/record-content= (get-in verified [:live :telemetry])
                                  (:telemetry live))
      (ct/fail! "telemetry corpus changed during coordination lease acquisition"))
    (prove-lease-only-suffix! (get-in verified [:live :coordination])
                              (:coordination live) lease)
    {:version version
     :lease-transition :exact-only
     :candidate-max-tx maxima
     :live live
     :candidate candidate
     :target {:corpus-max-tx (apply max 0 (vals maxima))
              :coordination-max-tx (:coordination maxima)
              :telemetry-max-tx (:telemetry maxima)}
     :runtime {:controller (capture-controller!)}}))

(defn callbacks [controller*]
  {:expected-live (require-split-corpus!)
   :acquire-lease! acquire-lease!
   :release-lease! release-exact-lease!
   :checkpoint-source!
   (fn [verified lease]
     (let [checkpoint (checkpoint-source! verified lease)]
       (reset! controller* (get-in checkpoint [:runtime :controller]))
       checkpoint))
   :stop! #(stop-controller! @controller*)
   :start! #(start-controller! @controller*)
   :assert-offline! assert-offline!
   :verify-restart! wait-for-restart!
   :settle-lease! settle-exact-lease!})

(defn read-plan! [path]
  (ct/read-edn-file! "corpus transaction plan" path))

(defn journal-if-present []
  (when (.isFile (io/file (ct/journal-path)))
    (ct/validate-journal!
     (ct/read-edn-file! "active corpus transaction journal" (ct/journal-path)))))

(defn assert-journal-controller! [journal]
  (when-not (get-in journal [:runtime :controller])
    (ct/fail! "active journal lacks a sealed coordinator controller identity"))
  (assert-controller! (get-in journal [:runtime :controller])))

(defn recover-for-launcher! []
  (check-live-boundaries!)
  (if-let [journal (journal-if-present)]
    (do
      (assert-journal-controller! journal)
      (if (ct/settled-data-phases (:phase journal))
        (do
          (ct/verify-preimage! journal)
          (when-not (ct/live-matches-resolution? journal)
            (ct/fail! "resolved journal no longer matches its live corpus prefix"))
          {:result "data-already-resolved" :phase (:phase journal)})
        (ct/recover-active! {:expected-live (require-split-corpus!)
                             :assert-offline! assert-offline!})))
    {:result "clean"}))

(defn settle-for-launcher! [wait?]
  (check-live-boundaries!)
  (when-let [journal (journal-if-present)] (assert-journal-controller! journal))
  (ct/settle-active!
   {:wait? wait?
    :expected-live (require-split-corpus!)
    :verify-restart! wait-for-restart!
    :settle-lease! settle-exact-lease!}))

(defn apply-command! [arguments]
  (when-not (and (= 3 (count arguments))
                 (= "--confirm-plan" (second arguments)))
    (die! "usage: north corpus-transaction apply PLAN --confirm-plan PLAN_ID"))
  (check-live-boundaries!)
  (let [[path _ confirmation] arguments
        plan (read-plan! path)]
    (when-not (= (:plan-id plan) confirmation)
      (ct/fail! (str "confirmation does not match sealed plan id " (:plan-id plan))))
    (let [controller* (atom nil)
          result (ct/apply-plan! plan (callbacks controller*))]
      (prn result)
      (when-not (:ok result) (System/exit 1)))))

(defn usage! []
  (die! (str "usage: north corpus-transaction "
             "{apply PLAN --confirm-plan PLAN_ID|recover --launcher|"
             "settle [--wait] --launcher|check-boundaries}")))

(try
  (case (first args)
    "apply" (apply-command! (subvec args 1))
    "recover"
    (if (= ["--launcher"] (subvec args 1))
      (prn (recover-for-launcher!))
      (usage!))
    "settle"
    (case (subvec args 1)
      ["--launcher"] (prn (settle-for-launcher! false))
      ["--wait" "--launcher"] (prn (settle-for-launcher! true))
      (usage!))
    "check-boundaries"
    (if (= 1 (count args))
      (prn (check-live-boundaries!))
      (usage!))
    (usage!))
  (catch clojure.lang.ExceptionInfo error
    (binding [*out* *err*]
      (println (str "north corpus-transaction: REFUSED — " (.getMessage error))))
    (System/exit 1)))
