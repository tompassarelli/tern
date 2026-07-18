#!/usr/bin/env bb
;; ============================================================================
;; concern-code-overlap-test.clj — thread 019f1010-2705 CLI wiring.
;; Boots a throwaway SPINE board + a throwaway warm CODE daemon (over fram's own
;; ingested corpus) and drives bin/concern's CLI end-to-end, asserting:
;;   - declare resolves a code-NODE footprint onto the CODE port; the spine carries
;;     code_port but NEVER a footprint fact (no port partition, acceptance 6);
;;   - overlap surfaces a caller-coupled peer via the daemon's blast-closure join
;;     (a footprint declared seconds ago, no render/merge — acceptance 2/3);
;;   - status appends a monotone `reached` maturity level (set-single! is gone, 4);
;;   - a repo with no code daemon DEGRADES to the path-string footprint (acceptance 7).
;; Daemon-side scope-correctness + rename-stability live in fram's
;; tests/coord_concern_overlap_test.clj; this guards the north CLI seam.
;; SKIPs cleanly if fram's compiled out/ or .fram/code.log is absent.
;;   bb cli/tests/concern-code-overlap-test.clj
;; ============================================================================
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str]
         '[babashka.process :as p])

(def fram (str (System/getProperty "user.home") "/code/fram"))
(def code-log (str fram "/.fram/code.log"))
(def lode (str (System/getProperty "user.home") "/code/north"))
(when-not (and (.exists (io/file (str fram "/out"))) (.exists (io/file code-log)))
  (println "SKIP — fram out/ or .fram/code.log absent (run fram build + an ingest first).")
  (System/exit 0))

(defn op [port log o]
  (with-open [s (java.net.Socket. "127.0.0.1" (int port))]
    (.setSoTimeout s 120000)
    (let [w (.getOutputStream s) r (io/reader (.getInputStream s))]
      (.write w
              (.getBytes
               (str (pr-str {:op :for-log
                             :expected-log (.getCanonicalPath (io/file log))
                             :request o})
                    "\n")))
      (.flush w)
      (edn/read-string (.readLine r)))))
(defn port-free? [p] (try (with-open [s (java.net.Socket.)]
                            (.connect s (java.net.InetSocketAddress. "127.0.0.1" (int p)) 250) false)
                          (catch Exception _ true)))
(def spine (some #(when (port-free? %) %) [7610 7611 7612]))
(def cport (some #(when (port-free? %) %) [37610 37611 37612]))
(def spine-log (str (System/getProperty "java.io.tmpdir") "/concern-cli-spine-" (System/nanoTime) ".log"))
(def code-cpy  (str (System/getProperty "java.io.tmpdir") "/concern-cli-code-"  (System/nanoTime) ".log"))
(def hot-file  (str (System/getProperty "java.io.tmpdir") "/concern-cli-hot-"   (System/nanoTime) ".edn"))
(io/copy (io/file code-log) (io/file code-cpy))
(spit spine-log "")

(defn spawn [port log tag]
  (p/process {:dir fram :out (io/file (System/getProperty "java.io.tmpdir") (str "concern-cli-" tag ".out"))
              :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"
                          "FRAM_SINGLE_VALUED" "code_port code_log"}
              :err :out}
             "bb" "-cp" "out" "coord_daemon.clj" "serve-flat" (str port) log))
(def code-daemon-expr
  (str "(do "
       "(binding [*command-line-args* []] (load-file \"coord_daemon.clj\")) "
       "(boot-flat! (System/getenv \"NORTH_TEST_CODE_LOG\")) "
       "(let [{:keys [blast]} (ensure-calls!) "
       "      [node callers] (first (sort-by (comp count val) > blast))] "
       "  (spit (System/getenv \"NORTH_TEST_HOT_FILE\") "
       "        (pr-str {:node node :blast (vec callers) :count (count callers)}))) "
       "(serve (Integer/parseInt (System/getenv \"NORTH_TEST_CODE_PORT\"))))"))
(defn spawn-code [port log]
  (p/process {:dir fram
              :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"
                          "NORTH_TEST_CODE_LOG" log
                          "NORTH_TEST_HOT_FILE" hot-file
                          "NORTH_TEST_CODE_PORT" (str port)}
              :out (io/file (System/getProperty "java.io.tmpdir") "concern-cli-code.out")
              :err :out}
             "bb" "-cp" "out" "-e" code-daemon-expr))
(println "booting spine" spine "+ code" cport "concurrently (folding fram corpus — up to ~3 min)…")
;; spawn BOTH first so their folds overlap, then wait on both with one budget.
(def sp (spawn spine spine-log "spine"))
(def cp (spawn-code cport code-cpy))
(def procs [sp cp])
(defn killall [] (doseq [pr procs] (try (p/destroy-tree pr) (catch Throwable _ nil))))
(.addShutdownHook (Runtime/getRuntime) (Thread. killall))
(defn await-up [port] (loop [i 0] (cond (not (port-free? port)) true
                                        (>= i 360) false
                                        :else (do (Thread/sleep 500) (recur (inc i))))))
(when-not (and (await-up spine) (await-up cport))
  (println "ABORT — a daemon did not come up within budget")
  (println "  spine.out:" (slurp (io/file (System/getProperty "java.io.tmpdir") "concern-cli-spine.out")))
  (println "  code.out:"  (slurp (io/file (System/getProperty "java.io.tmpdir") "concern-cli-code.out")))
  (killall) (System/exit 1))

(def fails (atom 0))
(defn check [label ok?] (println (str "  " (if ok? "PASS" "FAIL") " — " label)) (when-not ok? (swap! fails inc)))
(defn cli-result [env & args]
  @(apply p/process {:dir lode :extra-env env :out :string :err :string}
          "bb" "cli/concern-cli.clj" (str spine) args))
(defn cli [env & args]
  (:out (apply cli-result env args)))

;; The code-daemon wrapper discovers the hottest node from the same warm cache
;; it serves. Ingestion-local node integers never become fixtures.
(def some-blast (edn/read-string (slurp hot-file)))
(def node (:node some-blast))
(def caller (first (:blast some-blast)))
(println "hot node" node "->" (:count some-blast) "callers; using caller" caller)
(check "warm daemon resolves a code node with callers" (and node caller (pos? (:count some-blast 0))))

(def canonical-spine-log (.getCanonicalPath (io/file spine-log)))
(def canonical-code-log (.getCanonicalPath (io/file code-cpy)))
(def env {"FRAM_LOG" canonical-spine-log
          "NORTH_CODE_LOG" canonical-code-log
          "NORTH_CODE_PORT" (str cport)})
(defn concern-subjects []
  (->> (op spine spine-log
           {:op :query
            :query {:find "c"
                    :rules [{:head {:rel "c" :args [{:var "c"}]}
                             :body [{:rel "triple"
                                     :args [{:var "c"} "kind" "concern"]}]}]}})
       :ok
       (map first)
       set))

;; Fail before any spine mutation when either half of the code-store identity
;; is absent or points at a different strict corpus.
(def missing-log
  (cli-result {"FRAM_LOG" canonical-spine-log
               "NORTH_CODE_PORT" (str cport)}
              "declare" "missing-log" "~/code/fram" "must not land" node))
(def relative-log
  (cli-result {"FRAM_LOG" canonical-spine-log
               "NORTH_CODE_LOG" "relative/code.log"
               "NORTH_CODE_PORT" (str cport)}
              "declare" "relative-log" "~/code/fram" "must not land" node))
(def malformed-port
  (cli-result {"FRAM_LOG" canonical-spine-log
               "NORTH_CODE_LOG" canonical-code-log
               "NORTH_CODE_PORT" "not-a-port"}
              "declare" "malformed-port" "~/code/fram" "must not land" node))
(def out-of-range-port
  (cli-result {"FRAM_LOG" canonical-spine-log
               "NORTH_CODE_LOG" canonical-code-log
               "NORTH_CODE_PORT" "65536"}
              "declare" "range-port" "~/code/fram" "must not land" node))
(def wrong-log-file
  (io/file (System/getProperty "java.io.tmpdir")
           (str "concern-cli-wrong-code-" (System/nanoTime) ".log")))
(spit wrong-log-file "")
(def wrong-log
  (cli-result {"FRAM_LOG" canonical-spine-log
               "NORTH_CODE_LOG" (.getCanonicalPath wrong-log-file)
               "NORTH_CODE_PORT" (str cport)}
              "declare" "wrong-log" "~/code/fram" "must not land" node))
(check "code port without code log fails configuration before mutation"
       (and (= 2 (:exit missing-log))
            (str/includes? (:err missing-log)
                           "NORTH_CODE_PORT and NORTH_CODE_LOG must be supplied together")
            (empty? (concern-subjects))))
(check "relative code log is rejected before cwd can affect identity"
       (and (= 2 (:exit relative-log))
            (str/includes? (:err relative-log)
                           "NORTH_CODE_LOG must be an absolute path")
            (empty? (concern-subjects))))
(check "malformed and out-of-range code ports fail cleanly before mutation"
       (and (= 2 (:exit malformed-port))
            (= 2 (:exit out-of-range-port))
            (str/includes? (:err malformed-port)
                           "integer from 1 through 65535")
            (str/includes? (:err out-of-range-port)
                           "integer from 1 through 65535")
            (empty? (concern-subjects))))
(check "wrong code corpus fails its exact handshake before mutation"
       (and (= 3 (:exit wrong-log))
            (str/includes? (:err wrong-log) ":log-mismatch")
            (empty? (concern-subjects))))

(def lww-subject "@concern-code-store-lww")
(doseq [[predicate first-value second-value]
        [["code_port" "37610" "37611"]
         ["code_log" "/tmp/first-code.log" "/tmp/second-code.log"]]]
  (op spine spine-log
      {:op :assert :te lww-subject :p predicate :r first-value})
  (op spine spine-log
      {:op :assert :te lww-subject :p predicate :r second-value}))
(check "code-store identity predicates are LWW and never conflict"
       (and (= #{"37611"}
               (set (:values
                     (op spine spine-log
                         {:op :resolved :te lww-subject :p "code_port"}))))
            (= #{"/tmp/second-code.log"}
               (set (:values
                     (op spine spine-log
                         {:op :resolved :te lww-subject :p "code_log"}))))))

(def outA (cli env "declare" "alice" "~/code/fram" "rework kernel ctor" node))
(def cidA (second (re-find #"(concern-\d+-[a-f0-9]+)" outA)))
(cli env "declare" "bob" "~/code/fram" "tweak a caller" caller)
(def ov (cli {"FRAM_LOG" canonical-spine-log} "overlap" cidA))
(println outA)
(check "declare resolved a code-node footprint (not a path string)"
       (str/includes? outA "footprint(code)"))
(check "overlap surfaces the caller-coupled peer (@bob) via blast-closure"
       (and (str/includes? ov "@bob") (str/includes? ov "SHARES (blast-closure)")))
(check "concern persists the exact code corpus for cwd-independent overlap"
       (= canonical-code-log
          (:value
           (op spine spine-log
               {:op :resolved :te (str "@" cidA) :p "code_log"}))))

;; footprint lands on the CODE port ONLY — never the spine board (no port partition)
(defn footprints [port log]
  (->> (op port log {:op :query :query {:find "e" :rules
                  [{:head {:rel "e" :args [{:var "e"}]}
                    :body [{:rel "triple" :args [{:var "c"} "footprint" {:var "e"}]}]}]}})
       :ok (map first) set))
(check "footprint facts land on the CODE port"
       (contains? (footprints cport code-cpy) node))
(check "footprint NEVER lands on the spine board (port partition)"
       (empty? (footprints spine spine-log)))

;; monotone maturity — status appends `reached`, derives the max level (set-single! gone)
(cli env "status" cidA "likely-to-land")
(def lsout (cli env "ls" "~/code/fram"))
(check "status appends a monotone `reached` level (status derived = likely-to-land)"
       (str/includes? lsout "likely-to-land"))

;; a non-flipped repo (no code daemon) degrades to path-string footprint
(def outFb (cli {"FRAM_LOG" (.getCanonicalPath (io/file spine-log))}
                "declare" "carol" "~/code/other" "non-flipped" "src/foo.clj,src/bar.clj"))
(check "no code daemon -> path-string footprint fallback + fram-code-on nudge"
       (and (str/includes? outFb "touches {") (str/includes? outFb "fram-code-on")))

(killall)
(.delete wrong-log-file)
(if (zero? @fails)
  (do (println "\nconcern-cli code-overlap: ALL PASS") (System/exit 0))
  (do (println (str "\nconcern-cli code-overlap: " @fails " FAIL")) (System/exit 1)))
