;; orchestration-contract-cli.clj — publishes @contract:dispatch, the dispatch
;; wire contract as a QUERYABLE subject (thread 019f8f5c, design §3.3). This
;; dissolves the 019f8ebe trap classes by making the child-dispatch payload a
;; `north show @contract:dispatch` away instead of tribal knowledge:
;;   - one `payload_field` fact per field  (canonical JSON {name,required,doc})
;;   - one `example_payload` fact          (canonical JSON of a valid payload)
;;   - one `error_code` fact per rejection class (canonical JSON {code,doc})
;; kind = wire_contract (a registered entity-kind; the payload_field/example_
;; payload/error_code predicates were registered in Phase 0). Publication is
;; ADDITIVE + reversible (the `retract` verb), matching the Phase 0/1 vocabulary-
;; seed precedent; it is NOT a shape-subject edit and NOT destructive.
;;
;; usage:
;;   bb orchestration-contract-cli.clj <port> seed      publish/refresh @contract:dispatch
;;   bb orchestration-contract-cli.clj <port> show      print what is on the graph
;;   bb orchestration-contract-cli.clj <port> retract   remove it (rollback)
(require '[clojure.java.io :as io]
         '[cheshire.core :as json])

(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op  north.coord/send-op)
(def append!  north.coord/append!)
(def put!     north.coord/put!)
(def retract! north.coord/retract!)

(def SUBJECT "@contract:dispatch")

;; The child-dispatch payload. `required` fields must be present in every child
;; payload; the eight-field routing axes compose server-side from @template:<role>
;; for the preset fast path (R7: fast path only at the derived minimum, elevation
;; stays long-form + coded exception). `thread` is required in EVERY payload so a
;; child's obligations never prebind (the 019f8ebe stray-binding lesson).
(def PAYLOAD-FIELDS
  [{"name" "thread"    "required" true  "doc" "explicit child thread id; obligations never prebind to the parent (019f8ebe)"}
   {"name" "role"      "required" true  "doc" "canonical stock-template name (@template:<role>) or a bespoke role id"}
   {"name" "prompt"    "required" true  "doc" "the task text handed to the child lane"}
   {"name" "taskGrade" "required" true  "doc" "scope/autonomy/novelty prior; composed from the template for an unmodified preset"}
   {"name" "topology"  "required" true  "doc" "worker | orchestrator; fixed by a stock template — change it only via a bespoke composition"}
   {"name" "tier"      "required" true  "doc" "semantic model-capability floor; = derived minimum on the preset fast path"}
   {"name" "reasoning" "required" true  "doc" "deliberation budget; = derived minimum on the preset fast path"}
   {"name" "posture"   "required" true  "doc" "explore | evaluate | deliver | preserve — what yields when values collide"}
   {"name" "domainRequirements" "required" true "doc" "provider-neutral capability requirements (array; [] when none)"}
   {"name" "composition" "required" true "doc" "{kind:preset|bespoke, id, ...}; preset overrides must record exactly the changed axes"}
   {"name" "signals"   "required" false "doc" "optional 7-signal routing assessment; required only to select ABOVE the derived minimum"}])

;; Rejection classes — the real admission failures a caller recovers from by
;; reading this contract (routing-metadata.ts / routing-admission.ts / gaffer-
;; staffing.ts). Dispatch rejection messages cite @contract:dispatch.
(def ERROR-CODES
  [{"code" "unknown-field"          "doc" "payload carries a field outside this contract"}
   {"code" "incomplete-request"     "doc" "the complete eight-field Gaffer request is missing one or more axes"}
   {"code" "role-unknown"           "doc" "role is not a stock template and lacks a complete bespoke composition"}
   {"code" "override-undeclared"    "doc" "a preset axis changed without composition.overrides + overrideReason"}
   {"code" "topology-fixed"         "doc" "attempt to change a stock template's fixed topology through a preset"}
   {"code" "above-minimum-uncoded"  "doc" "selected exceeds the derived minimum without a coded exception (R7)"}
   {"code" "missing-thread"         "doc" "no explicit child thread id in the payload"}])

(def EXAMPLE-PAYLOAD
  {"thread" "2026-07-24-120000"
   "role" "verifier"
   "prompt" "Verify claim X against artifact Y; one adversarial verdict."
   "taskGrade" "senior"
   "topology" "worker"
   "tier" "senior"
   "reasoning" "high"
   "posture" "evaluate"
   "domainRequirements" []
   "composition" {"kind" "preset" "id" "verifier" "overrides" []}})

;; canonical JSON (sorted keys) so a field/example/code fact is byte-stable.
(defn- canon [x]
  (cond
    (map? x)        (into (sorted-map) (map (fn [[k v]] [k (canon v)]) x))
    (sequential? x) (mapv canon x)
    :else           x))
(defn- cjson [x] (json/generate-string (canon x)))

(defn exact-values [port subject predicate]
  (->> (:ok (send-op port {:op :query
                           :query {:find "v" :rules [{:head {:rel "v" :args [{:var "v"}]}
                                                      :body [{:rel "triple" :args [subject predicate {:var "v"}]}]}]}}))
       (map first)))

(defn exact-facts [port subject]
  (->> (:ok (send-op port {:op :query
                           :query {:find "p,v" :rules [{:head {:rel "p,v" :args [{:var "p"} {:var "v"}]}
                                                        :body [{:rel "triple" :args [subject {:var "p"} {:var "v"}]}]}]}}))
       (map (fn [row] [(nth row 0) (nth row 1)]))
       (sort-by (juxt first second))))

(defn set-multi! [port subject predicate values]
  (let [current (set (exact-values port subject predicate))
        wanted  (set values)]
    (doseq [v (clojure.set/difference current wanted)] (retract! port subject predicate v))
    (doseq [v (clojure.set/difference wanted current)] (append! port subject predicate v))))

(defn seed! [port]
  (put! port SUBJECT "kind" "wire_contract")
  (put! port SUBJECT "doc" "the child-dispatch payload contract; north show @contract:dispatch to recover a valid shape")
  (set-multi! port SUBJECT "payload_field" (map cjson PAYLOAD-FIELDS))
  (set-multi! port SUBJECT "error_code"    (map cjson ERROR-CODES))
  (put! port SUBJECT "example_payload" (cjson EXAMPLE-PAYLOAD))
  (println (format "✓ published %s on :%d (%d payload_field, %d error_code, 1 example_payload)"
                   SUBJECT port (count PAYLOAD-FIELDS) (count ERROR-CODES))))

(defn retract-all! [port]
  (doseq [p ["kind" "doc" "payload_field" "error_code" "example_payload"]]
    (doseq [v (exact-values port SUBJECT p)] (retract! port SUBJECT p v)))
  (println (format "✓ retracted %s on :%d" SUBJECT port)))

(let [[ps verb] *command-line-args*
      port (Integer/parseInt (or ps "7977"))]
  (case verb
    "seed"    (seed! port)
    "retract" (retract-all! port)
    "show"    (doseq [[p v] (exact-facts port SUBJECT)] (println (format "  %-16s %s" p v)))
    (do (println "usage: orchestration-contract-cli.clj <port> {seed | show | retract}")
        (System/exit 2))))
