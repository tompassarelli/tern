#!/usr/bin/env bb
;; The dashboard consumes the STRICT VERSIONED concern machine projection, never the
;; human render. This drives dashboard-cli's `parse-concern-projection` directly:
;;   - a Kea-shaped fixture (11 orphaned + 72 retired) proves retired rows are
;;     excluded and by-repo grouping yields kea count 11 (not 72, not 83);
;;   - malformed / wrong-version payloads FAIL CLOSED to an error, never concerns.
(require '[babashka.process :as p]
         '[clojure.string :as str]
         '[cheshire.core :as json]
         '[clojure.java.io :as io])

(def test-script (or (System/getProperty "babashka.file") *file*))

;; dashboard-cli's library guard is process-environment based (its public entrypoint
;; is also the executable). Re-enter once with the guard set, then load it as a lib.
(when-not (= "1" (System/getenv "NORTH_DASHBOARD_LIB"))
  (let [result @(p/process ["env" "NORTH_DASHBOARD_LIB=1" "bb" test-script]
                           {:out :string :err :string})]
    (print (:out result))
    (binding [*out* *err*] (print (:err result)))
    (flush)
    (System/exit (:exit result))))

(def root (-> test-script io/file .getCanonicalFile .getParentFile .getParentFile .getParent str))
(let [dashboard-script (str root "/cli/dashboard-cli.clj")]
  (System/setProperty "babashka.file" dashboard-script)
  (try
    (load-file dashboard-script)
    (finally
      (System/setProperty "babashka.file" test-script))))

(def checks (atom []))
(defn check [label ok]
  (swap! checks conj [label ok])
  (println (if ok (str "PASS " label) (str "FAIL " label))))

;; Kea-shaped fixture: 11 orphaned + 72 retired concerns, all repo "kea". A consumer
;; that scraped rendered text (or failed to exclude retired) would over-count to 83
;; or mis-count to 72; the strict projection excludes retired and by-repo grouping
;; over the retained rows yields exactly 11.
(defn row [i cls retired?]
  {:id (str "@concern-1700000000000-kea" i) :agent (str "@kea" i)
   :repo "kea" :intent "kea work"
   :maturity (if retired? "building" "likely-to-land")
   :classification cls :online false :retired retired? :touches ["kea/a.clj"]})
(def kea-fixture
  (json/generate-string
   {:version 1
    :concerns (vec (concat (for [i (range 11)]  (row i "orphaned" false))
                           (for [i (range 72)]  (row (+ 100 i) "retired" true))))}))

(let [parsed  (parse-concern-projection kea-fixture)
      by-repo (->> (:concerns parsed) (group-by :repo)
                   (map (fn [[r cs]] [r (count cs)])) (into {}))]
  (check "Kea projection parses without error" (nil? (:err parsed)))
  (check "retired rows are excluded from the active projection"
         (= 11 (count (:concerns parsed))))
  (check "11 orphaned + 72 retired yields kea by-repo count 11"
         (= 11 (get by-repo "kea")))
  (check "every retained row is orphaned (orphaned counted, retired dropped)"
         (every? #(= "orphaned" (:classification %)) (:concerns parsed))))

;; Fail closed: a wrong-version or malformed payload must NOT render as concerns.
(check "wrong-version payload fails closed"
       (boolean (:err (parse-concern-projection
                       (json/generate-string {:version 2 :concerns []})))))
(check "non-JSON payload fails closed"
       (boolean (:err (parse-concern-projection "  @kea building kea {a b}  "))))
(check "non-object JSON payload fails closed"
       (boolean (:err (parse-concern-projection "[1,2,3]"))))
(check "concerns-not-a-list payload fails closed"
       (boolean (:err (parse-concern-projection
                       (json/generate-string {:version 1 :concerns {}})))))
(check "non-map projection row fails closed"
       (boolean (:err (parse-concern-projection
                       (json/generate-string {:version 1 :concerns ["nope"]})))))
(check "well-formed empty projection is not an error"
       (= [] (:concerns (parse-concern-projection
                         (json/generate-string {:version 1 :concerns []})))))

;; ---- adversarial ENVELOPE validation: the top-level object must have EXACTLY
;; :version and :concerns — no missing, no extra — same fail-closed discipline
;; as row validation.
(check "extra top-level envelope field fails closed"
       (boolean (:err (parse-concern-projection
                       (json/generate-string {:version 1 :concerns [] :unexpected true})))))
(check "missing :version envelope field fails closed"
       (boolean (:err (parse-concern-projection
                       (json/generate-string {:concerns []})))))
(check "missing :concerns envelope field fails closed"
       (boolean (:err (parse-concern-projection
                       (json/generate-string {:version 1})))))

;; ---- adversarial ROW validation: a consumer that accepts a row it did not fully
;; validate is a silent-corruption vector. Every rejected category below must FAIL
;; CLOSED to {:err ...} — no row is silently dropped, coerced, or passed through.
;; Base is a single fully-valid live row; each case mutates exactly one thing.
(def valid-row
  {:id "@concern-1700000000000-a" :agent "@a" :repo "north" :intent "work"
   :maturity "building" :classification "stale" :online false :retired false
   :touches ["north/x.clj"]})
(defn one-row [r] (json/generate-string {:version 1 :concerns [r]}))
(defn rejects? [label r]
  (check label (boolean (:err (parse-concern-projection (one-row r))))))
(defn accepts? [label r]
  (check label (nil? (:err (parse-concern-projection (one-row r))))))

;; sanity: the base row is accepted, so every rejection below isolates its mutation
(accepts? "baseline valid row is accepted" valid-row)

;; missing keys — one per required field (agent is nullable, tested separately)
(doseq [k [:id :repo :intent :maturity :classification :online :retired :touches]]
  (rejects? (str "missing key " k " fails closed") (dissoc valid-row k)))
(rejects? "missing key :agent fails closed" (dissoc valid-row :agent))

;; extra key
(rejects? "extra/unknown key fails closed" (assoc valid-row :EVIL "injected"))

;; wrong types
(rejects? "non-string :id (null) fails closed"       (assoc valid-row :id nil))
(rejects? "empty-string :id fails closed"            (assoc valid-row :id ""))
(rejects? "numeric :id fails closed"                 (assoc valid-row :id 42))
(rejects? "non-string :repo fails closed"            (assoc valid-row :repo 7))
(rejects? "non-string :intent fails closed"          (assoc valid-row :intent 7))
(rejects? "string :online (\"yes\") fails closed"    (assoc valid-row :online "yes"))
(rejects? "string :retired (\"false\") fails closed" (assoc valid-row :retired "false"))
(rejects? "non-vector :touches fails closed"         (assoc valid-row :touches "north/x.clj"))
(rejects? "non-string-element :touches fails closed" (assoc valid-row :touches [1 2]))

;; nullable :agent is the ONLY field allowed to be null (agent-less concerns)
(accepts? "null :agent is accepted (agent-less concern)" (assoc valid-row :agent nil))

;; unknown enum values
(rejects? "unknown :maturity fails closed"       (assoc valid-row :maturity "banana"))
(rejects? "unknown :classification fails closed" (assoc valid-row :classification "banana"
                                                        ;; keep it type-valid so classification is what's rejected
                                                        ))

;; contradictory rows: classification must equal expected(retired,online,maturity)
(rejects? "retired:true but classification:live is contradictory"
          (assoc valid-row :retired true :classification "live"))
(rejects? "online:true but classification:orphaned is contradictory"
          (assoc valid-row :online true :classification "orphaned"))
(rejects? "online:true but classification:stale is contradictory"
          (assoc valid-row :online true :classification "stale"))
(rejects? "lapsed likely-to-land labeled stale is contradictory"
          (assoc valid-row :maturity "likely-to-land" :classification "stale"))
(rejects? "lapsed building labeled orphaned is contradictory"
          (assoc valid-row :maturity "building" :classification "orphaned"))
(rejects? "retired:false but classification:retired is contradictory"
          (assoc valid-row :retired false :classification "retired"))

;; consistent variants of every classification are accepted (the invariant is exact,
;; not merely restrictive)
(accepts? "consistent live row (online:true) accepted"
          (assoc valid-row :online true :classification "live"))
(accepts? "consistent orphaned row (lapsed likely-to-land) accepted"
          (assoc valid-row :maturity "likely-to-land" :classification "orphaned"))
(accepts? "consistent retired row accepted"
          (assoc valid-row :retired true :classification "retired"))

;; a corrupt RETIRED row still fails the whole payload — validation precedes the
;; retired-row drop, so a bad retired row cannot slip through by being excluded
(rejects? "corrupt retired row fails closed before it is dropped"
          (assoc valid-row :retired true :classification "retired" :online "nope"))

(let [failed (remove second @checks)]
  (println (str "dashboard concern projection: " (- (count @checks) (count failed))
                " / " (count @checks) " PASS"))
  (System/exit (if (empty? failed) 0 1)))
