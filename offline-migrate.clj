;; offline-migrate.clj — realize the-model on the personal log by APPENDING the
;; exact retract/assert records the daemon itself would write, but offline (daemon
;; down, no socket load). Run AFTER restoring the clean 4190 snapshot + stopping
;; the daemon. Subjects keep their literal `@` (we write :l exactly as the log has
;; it — no CLI @-prepend involved). Persons use `display_name` (`name` reserved).
(require '[clojure.edn :as edn] '[clojure.string :as str])
(def path "/home/tom/code/tern-data/facts.log")
(def recs (with-open [r (clojure.java.io/reader path)] (mapv edn/read-string (line-seq r))))
(def maxtx (apply max (map :tx recs)))
(def tx (inc maxtx))
(def ts (str (java.time.Instant/now)))
;; live triples = last op wins per [l p r]
(def lo (reduce (fn [m rc] (assoc m [(:l rc) (:p rc) (:r rc)] (:op rc))) {} recs))
(def live (->> lo (filter (fn [[k op]] (= op "assert"))) (map key) vec))
(defn by-pred [p] (filter #(= (second %) p) live))

(def drops
  (distinct
    (concat
      (by-pred "created_by")
      (filter #(= (nth % 2) "migrated") (by-pred "source"))
      (filter #(= (nth % 2) "personal") (by-pred "owner"))
      (by-pred "coordination")
      ;; swarm-junk driver cells (titleless zzz/probe lease nodes)
      (filter #(or (str/includes? (first %) "zzz") (str/includes? (first %) "probe")) (by-pred "driver"))
      ;; stale drivers on terminal (done/abandoned) threads
      (let [term (set (concat (map first (by-pred "outcome")) (map first (by-pred "abandoned"))))]
        (filter #(term (first %)) (by-pred "driver")))
      ;; dangling depends_on (target has no title)
      (let [titled (set (map first (by-pred "title")))]
        (filter #(not (titled (nth % 2))) (by-pred "depends_on"))))))

(def asserts
  [{:tx tx :op "assert" :l "@tom_passarelli" :p "display_name" :r "Tom Passarelli" :ts ts :by "coord"}
   {:tx tx :op "assert" :l "@claude-code"    :p "display_name" :r "claude-code"    :ts ts :by "coord"}
   {:tx tx :op "assert" :l "@claude"         :p "display_name" :r "claude"         :ts ts :by "coord"}])
(def retracts (map (fn [[l p r]] {:tx tx :op "retract" :l l :p p :r r :ts ts :by "coord"}) drops))
(def newrecs (concat asserts retracts))

(spit path (str (str/join "\n" (map pr-str newrecs)) "\n") :append true)
(println "appended" (count newrecs) "records =" (count asserts) "asserts +" (count retracts) "retracts")
(println "drop breakdown:" (into (sorted-map) (frequencies (map second drops))))
(println "log lines now:" (count (with-open [r (clojure.java.io/reader path)] (vec (line-seq r)))))
