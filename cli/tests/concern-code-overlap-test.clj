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

(defn op [port o]
  (with-open [s (java.net.Socket. "127.0.0.1" (int port))]
    (.setSoTimeout s 120000)
    (let [w (.getOutputStream s) r (io/reader (.getInputStream s))]
      (.write w (.getBytes (str (pr-str o) "\n"))) (.flush w)
      (edn/read-string (.readLine r)))))
(defn port-free? [p] (try (with-open [s (java.net.Socket.)]
                            (.connect s (java.net.InetSocketAddress. "127.0.0.1" (int p)) 250) false)
                          (catch Exception _ true)))
(def spine (some #(when (port-free? %) %) [7610 7611 7612]))
(def cport (some #(when (port-free? %) %) [37610 37611 37612]))
(def spine-log (str (System/getProperty "java.io.tmpdir") "/concern-cli-spine-" (System/nanoTime) ".log"))
(def code-cpy  (str (System/getProperty "java.io.tmpdir") "/concern-cli-code-"  (System/nanoTime) ".log"))
(io/copy (io/file code-log) (io/file code-cpy))
(spit spine-log "")

(defn spawn [port log tag]
  (p/process {:dir fram :out (io/file (System/getProperty "java.io.tmpdir") (str "concern-cli-" tag ".out"))
              :err :out}
             "bb" "-cp" "out" "coord_daemon.clj" "serve-flat" (str port) log))
(println "booting spine" spine "+ code" cport "concurrently (folding fram corpus — up to ~3 min)…")
;; spawn BOTH first so their folds overlap, then wait on both with one budget.
(def sp (spawn spine spine-log "spine"))
(def cp (spawn cport code-cpy "code"))
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
(defn cli [env & args]
  (-> (apply p/process {:dir lode :extra-env env :out :string :err :string}
             "bb" "cli/concern-cli.clj" (str spine) args)
      deref :out))

;; warm the call graph + pick a hot node and one of its callers
(def hot (->> (op cport {:op :concern-overlap :te "@nobody"}) :version some?))   ; touch the daemon
(def some-blast (op cport {:op :blast :te "@kernel#163"}))
(def node (:node some-blast))
(def caller (first (:blast some-blast)))
(println "hot node" node "->" (:count some-blast) "callers; using caller" caller)
(check "warm daemon resolves a code node with callers" (and node caller (pos? (:count some-blast))))

(def env {"NORTH_CODE_PORT" (str cport)})
(def outA (cli env "declare" "alice" "~/code/fram" "rework kernel ctor" node))
(def cidA (second (re-find #"(concern-\d+-[a-f0-9]+)" outA)))
(cli env "declare" "bob" "~/code/fram" "tweak a caller" caller)
(def ov (cli env "overlap" cidA))
(println outA)
(check "declare resolved a code-node footprint (not a path string)"
       (str/includes? outA "footprint(code)"))
(check "overlap surfaces the caller-coupled peer (@bob) via blast-closure"
       (and (str/includes? ov "@bob") (str/includes? ov "SHARES (blast-closure)")))

;; footprint lands on the CODE port ONLY — never the spine board (no port partition)
(defn footprints [port]
  (->> (op port {:op :query :query {:find "e" :rules
                  [{:head {:rel "e" :args [{:var "e"}]}
                    :body [{:rel "triple" :args [{:var "c"} "footprint" {:var "e"}]}]}]}})
       :ok (map first) set))
(check "footprint facts land on the CODE port" (contains? (footprints cport) node))
(check "footprint NEVER lands on the spine board (port partition)" (empty? (footprints spine)))

;; monotone maturity — status appends `reached`, derives the max level (set-single! gone)
(cli env "status" cidA "likely-to-land")
(def lsout (cli env "ls" "~/code/fram"))
(check "status appends a monotone `reached` level (status derived = likely-to-land)"
       (str/includes? lsout "likely-to-land"))

;; a non-flipped repo (no code daemon) degrades to path-string footprint
(def outFb (cli {} "declare" "carol" "~/code/other" "non-flipped" "src/foo.clj,src/bar.clj"))
(check "no code daemon -> path-string footprint fallback + fram-code-on nudge"
       (and (str/includes? outFb "touches {") (str/includes? outFb "fram-code-on")))

(killall)
(if (zero? @fails)
  (do (println "\nconcern-cli code-overlap: ALL PASS") (System/exit 0))
  (do (println (str "\nconcern-cli code-overlap: " @fails " FAIL")) (System/exit 1)))
