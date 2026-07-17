#!/usr/bin/env bb
;; Exact managed-identity publication against a throwaway Fram coordinator.
(require '[babashka.process :as proc]
         '[cheshire.core :as json]
         '[clojure.edn :as edn]
         '[clojure.java.io :as io])

(def root (.getCanonicalPath
           (io/file (.getParent (io/file (System/getProperty "babashka.file"))) "../..")))
(def fram (str (System/getProperty "user.home") "/code/fram"))
(def writer (str root "/cli/agent-fact-internal.clj"))
(load-file (str root "/cli/coord.clj"))
(load-file (str root "/cli/agent-provenance.clj"))
(load-file (str root "/cli/terminal-projection.clj"))

(def checks (atom []))
(defn check [label ok?] (swap! checks conj [label (boolean ok?)]))
(defn free-port [] (with-open [socket (java.net.ServerSocket. 0)] (.getLocalPort socket)))
(defn port-open? [port]
  (try (with-open [socket (java.net.Socket.)]
         (.connect socket (java.net.InetSocketAddress. "127.0.0.1" (int port)) 100) true)
       (catch Exception _ false)))
(defn eventually [predicate]
  (loop [n 0]
    (cond (predicate) true (>= n 200) false
          :else (do (Thread/sleep 25) (recur (inc n))))))
(defn run-writer [port operation subject value]
  (let [result (proc/shell {:out :string :err :string :continue true}
                           "bb" writer (str port) operation subject value)]
    {:exit (:exit result) :out (:out result) :err (:err result)}))
(defn entity-facts [port subject]
  (let [rows (:ok (north.coord/send-op
                   port {:op :query
                         :query {:find "identity_test"
                                 :rules [{:head {:rel "identity_test"
                                                 :args [{:var "p"} {:var "r"}]}
                                          :body [{:rel "triple"
                                                  :args [subject {:var "p"} {:var "r"}]}]}]}}))]
    (reduce (fn [acc [predicate value]] (update acc predicate (fnil conj #{}) value)) {} rows)))
(defn scalar-facts [facts]
  (into {} (keep (fn [[predicate values]]
                   (when (= 1 (count values)) [predicate (first values)]))) facts))
(defn log-ops [file]
  (with-open [reader (io/reader file)]
    (mapv edn/read-string (line-seq reader))))

(let [port (free-port)
      tmp (.toFile (java.nio.file.Files/createTempDirectory
                    "north-identity-publication" (make-array java.nio.file.attribute.FileAttribute 0)))
      log (io/file tmp "facts.log")
      daemon (do
               (spit log "")
               (proc/process {:dir fram :out :string :err :string}
                             "bb" "-cp" "out" "coord_daemon.clj"
                             "serve-flat" (str port) (.getPath log)))
      subject "@agent:identity-publication-probe"
      preset {"kind" "lane" "role" "integrator" "model" "claude-opus-4-8"
              "provider" "anthropic" "provider_target" "claude-a" "effort" "high"
              "composition_kind" "preset" "composition_id" "integrator"
              "composition_overrides" "[\"tier\"]"
              "composition_override_reason" "critical seam" "repo" "north"
              "goal" "prove atomic publication" "spawned_at" "2026-07-17T01:00:00Z"
              "display_handle" "anthropic-a-opus-high-gaffer-integrator-probe"
              "display_name" "anthropic:claude-a · opus · high · gaffer:integrator"}
      bespoke {"kind" "lane" "role" "migration-forensics" "model" "gpt-5.6-sol"
               "provider" "openai" "provider_target" "codex-b" "effort" "xhigh"
               "composition_kind" "bespoke" "composition_id" "migration-forensics"
               "nearest_preset" "analyst" "bespoke_reason" "cross-schema archaeology"
               "promotion_candidate" "false"
               "composition_contract_sha256" (apply str (repeat 64 "a"))
               "composition_contract_fingerprint_version" "v1"
               "composition_contract_fingerprint_domain" "north:bespoke-contract:v1"
               "repo" "north" "goal" "prove clean sequential reuse"
               "spawned_at" "2026-07-17T01:01:00Z"
               "display_handle" "openai-b-sol-xhigh-gaffer-bespoke-probe"
               "display_name" "openai:codex-b · sol · xhigh · gaffer:bespoke:migration-forensics"}]
  (try
    (check "throwaway coordinator starts" (eventually #(port-open? port)))
    (let [first-result (run-writer port "publish" subject (json/generate-string preset))
          stored (scalar-facts (entity-facts port subject))]
      (check "preset publication returns a synchronous acknowledgement" (zero? (:exit first-result)))
      (check "commit marker matches the exact current canonical projection"
             (= (north.agent-provenance/manifest-sha256 stored)
                (get stored "identity_manifest_sha256"))))

    (let [terminal {"outcome" "ran" "process_outcome" "ran"
                    "delivery_outcome" "unverified"
                    "delivery_reason" "provider_terminal_success_without_external_verification"}
          terminal-result (run-writer port "terminal" subject (json/generate-string terminal))
          stored (scalar-facts (entity-facts port subject))]
      (check "terminal process and delivery axes publish together"
             (and (zero? (:exit terminal-result))
                  (= "ran" (get stored "process_outcome"))
                  (= "unverified" (get stored "delivery_outcome"))
                  (= "ran"
                     (north.terminal-projection/terminal-process-outcome stored)))))
    (let [before-op-count (count (log-ops log))
          second-result (run-writer port "publish" subject (json/generate-string bespoke))
          generation-ops (->> (log-ops log)
                              (drop before-op-count)
                              (filter #(= subject (:l %)))
                              vec)
          raw-stored (entity-facts port subject)
          stored (scalar-facts raw-stored)]
      (check "sequential reuse publishes the second shape" (zero? (:exit second-result)))
      (check "identity reuse withdraws identity and terminal markers before any body mutation"
             (= [["retract" "identity_manifest_sha256"]
                 ["retract" "terminal_manifest_sha256"]]
                (mapv (juxt :op :p) (take 2 generation-ops))))
      (check "identity reuse withdraws the legacy outcome before process_outcome"
             (= [["retract" "outcome"] ["retract" "process_outcome"]]
                (mapv (juxt :op :p) (take 2 (drop 2 generation-ops)))))
      (check "sequential reuse removes every stale optional preset field and outcome"
             (and (nil? (get raw-stored "composition_overrides"))
                  (nil? (get raw-stored "composition_override_reason"))
                  (nil? (get raw-stored "outcome"))
                  (nil? (get raw-stored "process_outcome"))
                  (nil? (get raw-stored "delivery_outcome"))
                  (nil? (get raw-stored "terminal_manifest_sha256"))
                  (= #{"analyst"} (get raw-stored "nearest_preset"))))
      (check "every managed identity predicate has exactly one live value"
             (every? #(= 1 (count %))
                     (vals (select-keys raw-stored north.agent-provenance/identity-predicates))))
      (check "bespoke generation is committed and canonical"
             (and (north.agent-provenance/managed-valid? stored)
                  (= (north.agent-provenance/manifest-sha256 stored)
                     (get stored "identity_manifest_sha256")))))

    (let [route {"provider" "anthropic" "provider_target" "claude-c"
                 "model" "claude-opus-4-8" "effort" "high"
                 "display_handle" "anthropic-c-opus-high-gaffer-bespoke-probe"
                 "display_name" "anthropic:claude-c · opus · high · gaffer:bespoke:migration-forensics"}
          route-result (run-writer port "route" subject (json/generate-string route))
          raw-stored (entity-facts port subject)
          stored (scalar-facts raw-stored)]
      (check "fallback route update is acknowledged" (zero? (:exit route-result)))
      (check "route update retracts every previous multi-cardinality route value"
             (and (= #{"anthropic"} (get raw-stored "provider"))
                  (= #{"claude-c"} (get raw-stored "provider_target"))
                  (= #{"claude-opus-4-8"} (get raw-stored "model"))))
      (check "route update recommits the full current projection"
             (= (north.agent-provenance/manifest-sha256 stored)
                (get stored "identity_manifest_sha256"))))

    (let [retask {"goal" "new durable goal"
                  "display_name" "anthropic:claude-c · opus · high · gaffer:bespoke:migration-forensics · new durable goal"}
          retask-result (run-writer port "retask" subject (json/generate-string retask))
          raw-stored (entity-facts port subject)
          stored (scalar-facts raw-stored)]
      (check "typed retask is acknowledged" (zero? (:exit retask-result)))
      (check "typed retask leaves exactly one goal and one display cache"
             (and (= #{"new durable goal"} (get raw-stored "goal"))
                  (= #{(get retask "display_name")} (get raw-stored "display_name"))))
      (check "typed retask recommits a startup-valid identity"
             (and (north.agent-provenance/managed-valid? stored)
                  (= (north.agent-provenance/manifest-sha256 stored)
                     (get stored "identity_manifest_sha256")))))

    (let [before (entity-facts port subject)
          invalid (assoc bespoke "composition_contract_sha256" "not-a-hash")
          rejected (run-writer port "publish" subject (json/generate-string invalid))]
      (check "invalid identity is rejected before mutating the committed generation"
             (and (not (zero? (:exit rejected)))
                  (= before (entity-facts port subject)))))
    (finally
      (proc/destroy-tree daemon)
      (try @daemon (catch Exception _ nil))
      (doseq [[label ok?] @checks]
        (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
      (let [failed (remove second @checks)]
        (println (format "\n%d/%d passed" (- (count @checks) (count failed)) (count @checks)))
        (when (seq failed) (System/exit 1))))))
