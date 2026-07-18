#!/usr/bin/env bb
;; North cannot portably compact a live provider-owned context in place. Prove
;; that legacy rotation signals fail closed into fresh-lane replacement guidance
;; and that the retired command never reaches for a nonexistent helper.
(require '[babashka.process :as proc]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root
  (.getCanonicalPath
   (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def tmp (.toFile (java.nio.file.Files/createTempDirectory
                   "north-context-replacement-"
                   (make-array java.nio.file.attribute.FileAttribute 0))))
(def log (io/file tmp "facts log.edn"))
(spit log "")

(def checks (atom []))
(defn check! [label ok?] (swap! checks conj [label (boolean ok?)]))

(try
  (with-open [server (java.net.ServerSocket. 0)]
    (let [seen (atom [])
          worker
          (future
            (dotimes [_ 6]
              (with-open [socket (.accept server)
                          reader (io/reader (.getInputStream socket))
                          writer (io/writer (.getOutputStream socket))]
                (let [request (edn/read-string (.readLine reader))
                      inner (:request request)
                      response
                      (case (:p inner)
                        "needs_rotation" {:value "true"}
                        "learning" {:values []}
                        {:value nil})]
                  (swap! seen conj request)
                  (.write writer (str (pr-str response) "\n"))
                  (.flush writer)))))
          result
          (proc/shell
           {:continue true
            :out :string
            :err :string
            :extra-env {"FRAM_LOG" (.getCanonicalPath log)}}
           "bb" (str root "/cli/dispatch-guard.clj")
           (str (.getLocalPort server)) "aaaaaaaaaaaa")]
      (deref worker 3000 nil)
      (check! "legacy rotation flag requests provider-neutral replacement"
              (and (= 2 (:exit result))
                   (str/includes? (:out result) "-> REPLACE:")
                   (str/includes? (:out result) "fresh managed lane")
                   (str/includes? (:out result) "provider-neutral")))
      (check! "replacement guidance advertises no fictional execution path"
              (not-any? #(str/includes? (:out result) %)
                        ["compact.sh" "MIGRATE_FROM" "-> COMPACT:"]))
      (check! "dispatch guard uses the selected coordinator for every read"
              (= 6 (count @seen)))
      (check! "dispatch guard fences every replacement-decision read"
              (every? #(and (= :for-log (:op %))
                            (= (.getCanonicalPath log) (:expected-log %)))
                      @seen))))

  (let [retired
        (proc/shell
         {:continue true :out :string :err :string}
         "bb" (str root "/cli/presence-cli.clj") "59999"
         "compact" "aaaaaaaaaaaa")
        output (str (:out retired) (:err retired))]
    (check! "presence compact is retired instead of pretending to mutate a provider context"
            (and (= 2 (:exit retired))
                 (str/includes? output "usage: presence-cli.clj")
                 (not (str/includes? output "|compact")))))

  (check! "runtime sources contain no nonexistent compact helper reference"
          (not-any?
           #(str/includes? (slurp (io/file root %)) "compact.sh")
           ["cli/presence-cli.clj" "cli/dispatch-guard.clj"]))

  (finally
    (doseq [file (reverse (file-seq tmp))] (.delete file))))

(let [results @checks
      passed (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\ncontext replacement: %d / %d PASS" passed (count results)))
  (System/exit (if (= passed (count results)) 0 1)))
