(ns tern.staleness
  (:require [fram.kernel :as k]
            [tern.projections :as proj]
            [fram.fold :as f]))

(defrecord Review [te pred detail])

(defn review-te [r] (:te r))

(defn review-pred [r] (:pred r))

(defn review-detail [r] (:detail r))

(def scope-preds ["depends_on" "part_of" "body"])

(def edge-preds ["relates_to" "clarifies" "amends"])

(defn- ^Boolean real-edit-frame? [^String fr]
  (or (= fr "coord") (or (= fr "agent") (= fr "cli"))))

(defn time-stale [idx ^String today before?]
  (reduce (fn [acc te] (let [vu (k/one-i idx te "valid_until")]
  (if (and (not (proj/terminal-i? idx te)) (and (some? vu) (before? vu today))) (conj acc (->Review te "valid_until" (str vu " is past " today " — re-validate or drop"))) acc))) [] (k/thread-ids-i idx)))

(defn edge-stale [idx]
  (reduce (fn [acc te] (if (proj/terminal-i? idx te) acc (reduce (fn [a p] (reduce (fn [b tgt] (if (some? (k/one-i idx tgt "abandoned")) (conj b (->Review te p (str "→ " tgt " was abandoned — relationship may be stale"))) b)) a (k/many-i idx te p))) acc edge-preds))) [] (k/thread-ids-i idx)))

(defn- later-edit-scope-tx [latest ^String l]
  (reduce (fn [m v] (if (and (= (:l v) l) (and (k/vec-contains? scope-preds (:p v)) (and (real-edit-frame? (:frame v)) (> (:tx v) m)))) (:tx v) m)) 0 latest))

(defn estimate-stale [idx latest]
  (reduce (fn [acc v] (if (and (= (:p v) "estimate_hours") (and (not (proj/terminal-i? idx (:l v))) (> (later-edit-scope-tx latest (:l v)) (:tx v)))) (conj acc (->Review (:l v) "estimate_hours" (str (:r v) "h estimated before a later scope edit — re-estimate"))) acc)) [] latest))

(defn needs-review [idx latest ^String today before?]
  (vec (concat (time-stale idx today before?) (vec (concat (edge-stale idx) (estimate-stale idx latest))))))

(defn- ^Boolean has-structure? [idx ^String te]
  (or (some? (k/one-i idx te "driver")) (or (some? (k/one-i idx te "estimate_hours")) (or (some? (k/one-i idx te "part_of")) (or (not (empty? (k/many-i idx te "depends_on"))) (not (empty? (k/many-i idx te "relates_to"))))))))

(defn promotable [idx]
  (filterv (fn [te] (and (nil? (k/one-i idx te "committed")) (and (not (proj/terminal-i? idx te)) (has-structure? idx te)))) (k/thread-ids-i idx)))
