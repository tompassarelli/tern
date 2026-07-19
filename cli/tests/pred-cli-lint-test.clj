#!/usr/bin/env bb
;; pred-cli lint --strict enforcement: a planted unregistered predicate in
;; predicate position must fail the strict lint (exit 1, naming the predicate),
;; and the same tree without the plant must pass (exit 0). We copy only the lint
;; engine (pred-cli.clj) + its wire substrate (coord.clj) into a throwaway dir so
;; the fold scans a controlled file set, and point it at an unreachable port so
;; registry membership collapses to the in-code VOCAB (no live daemon needed).
(require '[clojure.java.io :as io]
         '[clojure.java.shell :as shell]
         '[clojure.string :as str])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(defn src [rel] (io/file root rel))

(def checks (atom []))
(defn check [label ok detail]
  (swap! checks conj {:label label :ok (boolean ok) :detail detail}))

(def UNREACHABLE-PORT "59991")   ;; no coordinator here ⇒ VOCAB-only registry
(def PLANTED "totally_unregistered_planted_pred")

(defn tmp-lint-dir []
  (let [d (java.nio.file.Files/createTempDirectory
           "pred-lint-" (into-array java.nio.file.attribute.FileAttribute []))
        dir (.toFile d)]
    (doseq [f ["cli/pred-cli.clj" "cli/coord.clj"]]
      (io/copy (src f) (io/file dir (.getName (io/file f)))))
    dir))

(defn run-lint [dir]
  (shell/sh "bb" (str (io/file dir "pred-cli.clj")) UNREACHABLE-PORT "lint" "--strict"))

(defn rm-rf [^java.io.File f]
  (when (.isDirectory f) (doseq [c (.listFiles f)] (rm-rf c)))
  (.delete f))

(let [dir (tmp-lint-dir)]
  (try
    ;; 1) clean tree — every predicate literal registered ⇒ strict lint passes.
    (let [{:keys [exit out]} (run-lint dir)]
      (check "clean tree passes strict lint (exit 0)"
             (and (zero? exit) (str/includes? out "clean"))
             (str "exit=" exit)))
    ;; 2) plant one unregistered predicate in predicate position ⇒ strict fails.
    (spit (io/file dir "planted.clj")
          (str ";; planted fixture\n"
               "(defn plant! [port]\n"
               "  (append! port \"@thing:1\" \"" PLANTED "\" \"x\"))\n"))
    (let [{:keys [exit out]} (run-lint dir)]
      (check "planted unregistered predicate fails strict lint (exit 1)"
             (= 1 exit)
             (str "exit=" exit))
      (check "strict-lint failure names the offending predicate"
             (str/includes? out PLANTED)
             (str "out=" (pr-str out))))
    (finally (rm-rf dir))))

(let [results @checks
      failures (remove :ok results)
      pass (- (count results) (count failures))]
  (doseq [{:keys [label ok detail]} results]
    (println (format "  [%s] %s" (if ok "PASS" "FAIL") label))
    (when (and (not ok) detail) (println (str "         " detail))))
  (println (format "\npred-cli strict-lint enforcement: %d / %d PASS" pass (count results)))
  (System/exit (if (empty? failures) 0 1)))
