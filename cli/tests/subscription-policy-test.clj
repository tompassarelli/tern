#!/usr/bin/env bb
;; Regression for the subscription-entitlement cutover. Harness decisions and reports
;; use observed work facts; historical dollar facts may remain in a corpus but are inert.
(require '[babashka.process :as proc]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[clojure.string :as str])

(def root (.getCanonicalPath (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram (str (System/getProperty "user.home") "/code/fram"))
(def checks (atom []))
(defn check [label ok?] (swap! checks conj [label (boolean ok?)]))
(defn read-source [path] (slurp (io/file root path)))

(let [listener (read-source "cli/north-listen.clj")
      predicates (read-source "cli/pred-cli.clj")
      presence (read-source "cli/presence-cli.clj")
      reconcile (read-source "cli/north-reconcile.clj")
      retired [(str "budget" "_total") (str "cost" "_usd") "NORTH_BUDGET" "BUDGET SPENT"]]
  (check "listener has no retired dollar gate and fails closed peer child operations"
         (and (not-any? #(str/includes? listener %) retired)
              (str/includes? listener "peer spawn is unsupported")
              (str/includes? listener "peer dispatch is unsupported")))
  (check "predicate registry omits retired policy facts"
         (and (not-any? #(str/includes? predicates %) retired)
              (str/includes? predicates "[\"tokens\"")))
  (check "presence has no standalone cost command and stamps run kind"
         (and (nil? (re-find #"(?m)^\s*\"cost\"" presence))
              (str/includes? presence "(put! port re \"kind\" \"run\")")))
  (check "reconciliation is usage-only and keeps exact operational columns"
         (and (not-any? #(str/includes? reconcile %) retired)
              (every? #(str/includes? reconcile %)
                      ["\"tokens\"" "\"duration_ms\"" "\"num_turns\"" "\"fallback_count\""
                       "\"usage_terminal_count\"" "\"usage_scope\"" "\"usage_total_status\""
                       "\"cached_input_tokens\"" "\"reasoning_output_tokens\""]))))

;; Exercise the report against a throwaway coordinator when Fram's compiled daemon is
;; available. The static checks above still run in source-only environments.
(when (.exists (io/file fram "out"))
  (defn port-free? [port]
    (try (with-open [s (java.net.Socket.)]
           (.connect s (java.net.InetSocketAddress. "127.0.0.1" (int port)) 100)
           false)
         (catch Exception _ true)))
  (def port (or (some #(when (port-free? %) %) (range 7630 7650))
                (throw (ex-info "no free test port" {}))))
  (def tmp (.toFile (java.nio.file.Files/createTempDirectory
                      "north-subscription-policy" (make-array java.nio.file.attribute.FileAttribute 0))))
  (def log (io/file tmp "facts.log"))
  (def canonical-log (.getCanonicalPath log))
  (spit log "")
  (def daemon (proc/process {:dir fram :out :string :err :string
                             :extra-env {"FRAM_REQUIRE_LOG_FENCE" "1"}}
                            "bb" "-cp" "out" "coord_daemon.clj" "serve-flat" (str port) (.getPath log)))
  (defn await-up []
    (loop [n 0]
      (cond (not (port-free? port)) true
            (>= n 100) false
            :else (do (Thread/sleep 50) (recur (inc n))))))
  (defn op [request]
    (with-open [s (java.net.Socket. "127.0.0.1" (int port))]
      (.setSoTimeout s 5000)
      (let [w (.getOutputStream s) r (io/reader (.getInputStream s))]
        (.write w
                (.getBytes
                 (str (pr-str {:op :for-log
                               :expected-log canonical-log
                               :request request})
                      "\n")))
        (.flush w)
        (edn/read-string (.readLine r)))))
  (defn fact! [l p r]
    (loop [attempt 0]
      (let [base (:version (op {:op :version}))
            result (op {:op :assert :te l :p p :r r :base base})]
        (if (or (:ok result) (:version result))
          result
          (if (< attempt 5) (recur (inc attempt)) (throw (ex-info "fact write failed" result)))))))
  (try
    (check "throwaway telemetry coordinator starts" (await-up))
    (doseq [[p r] [["kind" "run"] ["agent" "worker-a"] ["tokens" "350"]
                   ["duration_ms" "1250"] ["num_turns" "3"] ["fallback_count" "1"]
                   ["fallback_path" "anthropic -> openai"]
                   ["provider" "openai"] ["model" "terra"] ["effort" "medium"]
                   ["at" "2026-07-16T00:00:00Z"]]]
      (fact! "@run-current" p r))
    (doseq [[p r] [["kind" "run"] ["agent" "worker-unknown"]
                   ["usage_terminal_count" "0"] ["usage_scope" "anthropic_result_terminal"]
                   ["usage_total_status" "unknown_no_terminal"]
                   ["provider" "anthropic"] ["model" "opus"] ["effort" "high"]
                   ["at" "2026-07-16T00:01:00Z"]]]
      (fact! "@run-unknown" p r))
    ;; A historical dollar-only row remains readable in the graph but is not a run
    ;; identity and therefore cannot enter the report or influence a decision.
    (fact! "@run-historical" (str "cost" "_usd") "99.99")
    (let [full (proc/shell {:out :string :err :string :continue true
                            :extra-env {"FRAM_LOG" canonical-log}}
                           "bb" (str root "/cli/north-reconcile.clj") (str port) "full")
          recent (proc/shell {:out :string :err :string :continue true
                              :extra-env {"FRAM_LOG" canonical-log}}
                             "bb" (str root "/cli/north-reconcile.clj") (str port) "recent" "10")]
      (check "usage reconciliation exits successfully" (and (zero? (:exit full)) (zero? (:exit recent))))
      (check "summary reports exact tokens, duration, turns, and fallbacks"
             (every? #(re-find % (:out full))
                     [#"total tokens\s+350\b" #"total duration ms\s+1250\b"
                      #"total turns\s+3\b" #"provider fallbacks\s+1\b"]))
      (check "unknown usage remains unreported rather than becoming a zero-token run"
             (and (re-find #"1/2 runs reported" (:out full))
                  (str/includes? (:out recent) "@run-unknown")))
      (check "recent report exposes provider/model/effort and ignores historical dollar row"
             (and (str/includes? (:out recent) "openai/terra/medium")
                  (str/includes? (:out recent) "1:anthropic -> openai")
                  (str/includes? (:out recent) "@run-current")
                  (not (str/includes? (:out recent) "@run-historical"))
                  (not (str/includes? (:out recent) "$")))))
    (finally
      (proc/destroy-tree daemon)
      (doseq [file (reverse (file-seq tmp))] (io/delete-file file true)))))

(let [results @checks pass (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\nsubscription policy: %d / %d PASS" pass (count results)))
  (System/exit (if (= pass (count results)) 0 1)))
