(ns north.audit
  (:require [fram.kernel :as k]
            [clojure.string :as str]))

(defrecord DriftGroup [norm forms])

(defn driftgroup-norm [r] (:norm r))

(defn driftgroup-forms [r] (:forms r))

(defn tally [idx ^String pred]
  (reduce (fn [m te] (reduce (fn [mm v] (assoc mm v (+ 1 (get mm v 0)))) m (k/many-i idx te pred))) {} (k/thread-ids-i idx)))

(defn- ^String norm-repo [^String v]
  (let [low (str/lower-case v)]
  (if (str/starts-with? low "~/code/") (subs low 7) low)))

(defn- collisions [forms grouped]
  (filterv (fn [g] (> (count (:forms g)) 1)) (mapv (fn [kk] (->DriftGroup kk (get grouped kk []))) (vec (keys grouped)))))

(defn repo-drift [idx]
  (let [forms (vec (keys (tally idx "repo")))
   grouped (reduce (fn [m t] (let [kk (norm-repo t)]
  (assoc m kk (conj (get m kk []) t)))) {} forms)]
  (collisions forms grouped)))
