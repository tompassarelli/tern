;; schema_test.clj — the vocabulary census (`north schema`): the kind classifier
;; and the census roll-up.
;;   (1) kind-of: explicit `kind` fact > `title`=>thread > subject-prefix
;;       heuristic > schema-as-facts predicate > other. Handles @-prefixed and
;;       bare subjects, and folds run/session/lane telemetry into one bucket.
;;   (2) census: per-kind subject + fact counts, sorted by fact count desc.
;;   (3) predicate metadata (cardinality/value_kind) is surfaced from the graph.
;;   bb -cp out:../fram/out schema_test.clj      (run from the repo root)
(require '[fram.kernel :as k] '[north.main :as m])

;; one subject per kind: some kind-tagged, some inferred from prefix/title only.
(def facts
  [(k/->Fact "@t1" "kind" "thread")   (k/->Fact "@t1" "title" "Kinded thread")
   (k/->Fact "@2026-05-01-000000" "title" "Legacy thread (no kind)")
   (k/->Fact "concern-a" "kind" "concern")  (k/->Fact "concern-a" "title" "Kinded concern")
   (k/->Fact "@concern-b" "title" "Prefix concern (no kind)")
   (k/->Fact "@agent:x" "display_name" "Agent X")
   (k/->Fact "@msg:m1" "body" "hello")
   (k/->Fact "@topic-perf" "note" "a topic")
   (k/->Fact "@mine:1" "kind" "mine")   (k/->Fact "@mine:1" "note" "personal")
   (k/->Fact "@run-9" "kind" "run")     (k/->Fact "@run-9" "started_at" "t")
   (k/->Fact "@session:s1" "started_at" "t")   (k/->Fact "@session:s1" "agent" "cc")
   (k/->Fact "@depends_on" "cardinality" "single")  (k/->Fact "@depends_on" "acyclic" "true")
   (k/->Fact "@rate" "value_kind" "literal")
   (k/->Fact "@weird" "foo" "bar")
   ;; a synthetic `gadget` kind for the per-kind field spec (required vs optional):
   ;; `name` on 3/3 subjects (100% => REQUIRED), `color` on 1/3 (33% => OPTIONAL),
   ;; `tag` asserted twice on ONE subject (coverage must dedup to 1 subject, not 2).
   (k/->Fact "@g1" "kind" "gadget")  (k/->Fact "@g1" "name" "a")
   (k/->Fact "@g1" "color" "red")    (k/->Fact "@g1" "tag" "x")  (k/->Fact "@g1" "tag" "y")
   (k/->Fact "@g2" "kind" "gadget")  (k/->Fact "@g2" "name" "b")
   (k/->Fact "@g3" "kind" "gadget")  (k/->Fact "@g3" "name" "c")])
(def idx (k/build-index facts))
(defn kof [te] (#'m/kind-of idx te))

(def stats (#'m/census idx facts))
(defn stat-for [kd] (first (filter #(= (:kind %) kd) stats)))

;; per-kind field spec (required/optional + coverage %) — the schema-fields fold.
(defn fields-for [kd] (#'m/schema-fields idx facts kd))
(defn field [kd p] (first (filter #(= (:pred %) p) (fields-for kd))))
(defn subj-of [kd] (let [s (stat-for kd)] (if s (:subjects s) 0)))

;; census sorted by fact count descending?
(def facts-desc?
  (apply >= (cons Long/MAX_VALUE (mapv :facts stats))))

;; predicate-metadata subjects the schema view surfaces (cardinality|value_kind)
(def pred-subs
  (filter (fn [s] (or (some? (k/one-i idx s "cardinality")) (some? (k/one-i idx s "value_kind"))))
          (:subjects idx)))

(def checks
  [["kind fact wins: @t1 => thread"                (= "thread" (kof "@t1"))]
   ["title (no kind) => thread"                    (= "thread" (kof "@2026-05-01-000000"))]
   ["kind fact: concern-a => concern"              (= "concern" (kof "concern-a"))]
   ["prefix (bare/@): @concern-b => concern"       (= "concern" (kof "@concern-b"))]
   ["prefix agent:  => agent"                      (= "agent" (kof "@agent:x"))]
   ["prefix msg:    => msg"                         (= "msg" (kof "@msg:m1"))]
   ["prefix topic-  => topic"                       (= "topic" (kof "@topic-perf"))]
   ["kind mine      => mine"                        (= "mine" (kof "@mine:1"))]
   ["kind run folds => session-telemetry"           (= "session-telemetry" (kof "@run-9"))]
   ["prefix session: => session-telemetry"          (= "session-telemetry" (kof "@session:s1"))]
   ["schema-as-facts subject => predicate"          (= "predicate" (kof "@depends_on"))]
   ["unclassifiable => other"                       (= "other" (kof "@weird"))]
   ["census: 2 thread subjects"                     (= 2 (subj-of "thread"))]
   ["census: 2 concern subjects"                    (= 2 (subj-of "concern"))]
   ["census: 2 session-telemetry subjects"          (= 2 (subj-of "session-telemetry"))]
   ["census: 1 other subject"                       (= 1 (subj-of "other"))]
   ["census sorted by fact count desc"              facts-desc?]
   ["predicate metadata surfaces depends_on"        (some #{"@depends_on"} pred-subs)]
   ["predicate metadata surfaces rate"              (some #{"@rate"} pred-subs)]
   ;; per-kind field spec: required (>=98%) vs optional, coverage %, dedup
   ["field spec: gadget/name is REQUIRED (100%)"    (:required (field "gadget" "name"))]
   ["field spec: gadget/name pct = 100"             (= 100 (:pct (field "gadget" "name")))]
   ["field spec: gadget/color is OPTIONAL"          (not (:required (field "gadget" "color")))]
   ["field spec: gadget/color pct = 33"             (= 33 (:pct (field "gadget" "color")))]
   ["coverage dedups multi-valued: tag subs = 1"    (= 1 (:subs (field "gadget" "tag")))]
   ["field spec: required sorts before optional"    (:required (first (fields-for "gadget")))]
   ["writers map: thread => capture-facts"          (.contains (#'m/kind-writer "thread") "capture-facts")]
   ["writers map: uncurated kind => not curated"    (.contains (#'m/kind-writer "zzz") "not curated")]])

(let [fails (remove second checks)]
  (doseq [[nm ok] checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
  (if (empty? fails)
    (println "\nschema:" (count checks) "/" (count checks) "PASS")
    (do (println "\nschema:" (count fails) "FAILED") (System/exit 1))))
