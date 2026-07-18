#!/usr/bin/env bb
;; Daemon-free contract tests for the concern/code-store response boundary.
(require '[clojure.string :as str])

(def root (-> (java.io.File. (System/getProperty "babashka.file"))
              .getParentFile .getParentFile .getParentFile .getCanonicalPath))
(def source-path (str root "/cli/concern-cli.clj"))
(def source-text (slurp source-path))
(def main-offset (str/last-index-of source-text "\n(let [[ps verb"))
(when-not main-offset
  (throw (ex-info "concern CLI main form marker not found" {})))

;; Load the implementation without running its argv dispatcher. concern-cli
;; resolves coord.clj relative to babashka.file, so present its real source path
;; while evaluating the definitions.
(System/setProperty "babashka.file" source-path)
(load-string (subs source-text 0 main-offset))

(def failures (atom 0))
(defn check! [label passed?]
  (println (str (if passed? "PASS" "FAIL") " — " label))
  (when-not passed? (swap! failures inc)))

(check! "version and assert accept only their exact success envelopes"
        (and (valid-code-response? {:op :version} {:version 7})
             (not (valid-code-response? {:op :version} {:version 7 :extra true}))
             (valid-code-response? {:op :assert} {:ok 8})
             (not (valid-code-response? {:op :assert} {:ok "8"}))))

(def blast-request {:op :blast :module "north.main" :name "capture"})
(check! "blast success validates node, callers, count, and version"
        (and (valid-code-response?
              blast-request
              {:node "@north.main#7" :blast ["@north.main#8"] :count 1 :version 9})
             (not (valid-code-response?
                   blast-request
                   {:node "@north.main#7" :blast ["@north.main#8"] :count 0 :version 9}))))
(check! "blast preserves only the documented identity-matched resolvability miss"
        (and (valid-code-response?
              blast-request
              {:error "no such binding" :te nil :module "north.main" :name "capture" :version 9})
             (not (valid-code-response?
                   blast-request
                   {:error "query failed" :te nil :module "north.main" :name "capture" :version 9}))
             (not (valid-code-response?
                   blast-request
                   {:error "no such binding" :te nil :module "other" :name "capture" :version 9}))))

(def overlap-request {:op :concern-overlap :te "@concern:test"})
(check! "concern-overlap validates the complete nested response shape"
        (and
         (valid-code-response?
          overlap-request
          {:concern "@concern:test"
           :footprint ["@north.main#7"]
           :overlaps [{:concern "@concern:peer"
                       :shared ["@north.main#7"]
                       :footprint ["@north.main#8"]}]
           :version 9})
         (not (valid-code-response? overlap-request {:error "query failed"}))
         (not (valid-code-response?
               overlap-request
               {:concern "@concern:test" :footprint [] :overlaps [{}] :version 9}))))

(let [message
      (with-redefs [send-op-for-log (fn [_ _ _] {:error "query failed"})
                    code-store-error! (fn [text] (throw (ex-info text {})))]
        (try
          (code-op 7977 "/tmp/code.log" overlap-request)
          nil
          (catch Exception error (.getMessage error))))]
  (check! "a malformed overlap response fails instead of becoming no-overlap"
          (and message (str/includes? message "invalid concern-overlap response"))))

(let [fatal (with-redefs [send-op-for-log (fn [_ _ _] (throw (Error. "fatal")))]
              (try
                (code-op 7977 "/tmp/code.log" {:op :version})
                false
                (catch Error _ true)))]
  (check! "code operations do not swallow VM-fatal Errors" fatal))

(if (zero? @failures)
  (do (println "concern code response tests: PASS") (System/exit 0))
  (do (println (str "concern code response tests: " @failures " FAIL"))
      (System/exit 1)))
