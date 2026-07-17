#!/usr/bin/env bb
(require '[babashka.process :as proc]
         '[cheshire.core :as json]
         '[clojure.java.io :as io])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram (str (System/getProperty "user.home") "/code/fram"))
(def writer (str root "/cli/run-fact-internal.clj"))
(load-file (str root "/cli/coord.clj"))
(load-file (str root "/cli/terminal-projection.clj"))

(def checks (atom []))
(defn check [label ok?] (swap! checks conj [label (boolean ok?)]))
(defn free-port [] (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))
(defn port-open? [port]
  (try (with-open [socket (java.net.Socket.)]
         (.connect socket (java.net.InetSocketAddress. "127.0.0.1" (int port)) 100)
         true)
       (catch Exception _ false)))
(defn eventually [predicate]
  (loop [n 0]
    (cond (predicate) true
          (>= n 200) false
          :else (do (Thread/sleep 25) (recur (inc n))))))
(defn facts-of [port subject]
  (let [rows (:ok (north.coord/send-op
                   port {:op :query
                         :query {:find "run_publication_test"
                                 :rules [{:head {:rel "run_publication_test"
                                                 :args [{:var "p"} {:var "r"}]}
                                          :body [{:rel "triple"
                                                  :args [subject {:var "p"} {:var "r"}]}]}]}}))]
    (reduce (fn [facts [predicate value]]
              (update facts predicate (fnil conj #{}) value))
            {}
            rows)))

(let [port (free-port)
      tmp (.toFile (java.nio.file.Files/createTempDirectory
                    "north-run-publication" (make-array java.nio.file.attribute.FileAttribute 0)))
      log (io/file tmp "facts.log")
      daemon (do
               (spit log "")
               (proc/process {:dir fram :out :string :err :string}
                             "bb" "-cp" "out" "coord_daemon.clj"
                             "serve-flat" (str port) (.getPath log)))
      subject "@run-publication-probe"
      facts [["kind" "run"] ["thread" "thread-probe"] ["agent" "lane-probe"]
             ["duration_ms" "125"] ["outcome" "ran"] ["process_outcome" "ran"]
             ["delivery_outcome" "unverified"]]]
  (try
    (check "throwaway coordinator starts" (eventually #(port-open? port)))
    (let [partial-subject "@run-publication-partial"]
      (north.coord/put! port partial-subject "agent" "lane-probe")
      (north.coord/put! port partial-subject "outcome" "ran")
      (north.coord/put! port partial-subject "process_outcome" "ran")
      (check "body facts from a torn run writer remain uncommitted"
             (nil? (north.terminal-projection/committed-run-process-outcome
                    (facts-of port partial-subject)))))
    (let [result (proc/shell {:out :string :err :string :continue true}
                             "bb" writer (str port) subject (json/generate-string facts))
          stored (facts-of port subject)]
      (when-not (zero? (:exit result))
        (binding [*out* *err*]
          (println "run writer stderr:" (:err result))))
      (check "one writer acknowledges the complete run publication" (zero? (:exit result)))
      (check "kind commit marker appears with every preceding run fact"
             (and (= #{"run"} (get stored "kind"))
                  (= #{"125"} (get stored "duration_ms"))
                  (= #{"unverified"} (get stored "delivery_outcome"))))
      (check "a committed run row exposes its process terminal"
             (= "ran"
                (north.terminal-projection/committed-run-process-outcome stored))))
    (let [invalid-subject "@run-publication-rejected"
          rejected (proc/shell {:out :string :err :string :continue true}
                               "bb" writer (str port) invalid-subject
                               (json/generate-string [["kind" "run"] ["duration_ms" ""]]))]
      (check "invalid payload is rejected before the discovery marker lands"
             (and (not (zero? (:exit rejected)))
                  (nil? (get (facts-of port invalid-subject) "kind")))))
    (finally
      (proc/destroy-tree daemon)
      (try @daemon (catch Exception _ nil))
      (doseq [[label ok?] @checks]
        (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
      (let [failed (remove second @checks)]
        (println (format "\n%d/%d passed"
                         (- (count @checks) (count failed))
                         (count @checks)))
        (when (seq failed) (System/exit 1))))))
