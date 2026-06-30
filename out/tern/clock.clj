(ns tern.clock
  (:require [fram.kernel :as k]
            [tern.projections :as proj]
            [clojure.string :as str]))

(defn running-session [idx]
  (reduce (fn [found s] (if (some? found) found (if (and (some? (k/one-i idx s "session_of")) (and (some? (k/one-i idx s "start_time")) (nil? (k/one-i idx s "end_time")))) s found))) nil (:subjects idx)))

(defn actual-seconds [idx ^String te iso->sec]
  (reduce (fn [acc s] (let [so (k/one-i idx s "session_of")
   st (k/one-i idx s "start_time")
   en (k/one-i idx s "end_time")]
  (if (and (= so te) (and (some? st) (some? en))) (+ acc (- (iso->sec en) (iso->sec st))) acc))) 0 (:subjects idx)))

(defrecord Row [te est-h act-sec term])

(defn row-te [r] (:te r))

(defn row-est-h [r] (:est-h r))

(defn row-act-sec [r] (:act-sec r))

(defn row-term [r] (:term r))

(defn rows [idx iso->sec str->int]
  (reduce (fn [acc te] (let [est-s (k/one-i idx te "estimate_hours")
   est (if (some? est-s) (str->int est-s) 0)
   act (actual-seconds idx te iso->sec)]
  (if (or (> est 0) (> act 0)) (conj acc (->Row te est act (proj/terminal-i? idx te))) acc))) [] (k/thread-ids-i idx)))

(defrecord Calib [pct sample est-sec act-sec])

(defn calib-pct [r] (:pct r))

(defn calib-sample [r] (:sample r))

(defn calib-est-sec [r] (:est-sec r))

(defn calib-act-sec [r] (:act-sec r))

(defn ^Calib calibration [rs]
  (let [done (filterv (fn [r] (and (:term r) (and (> (:est-h r) 0) (> (:act-sec r) 0)))) rs)
   est-sec (reduce (fn [m r] (+ m (* (:est-h r) 3600))) 0 done)
   act-sec (reduce (fn [m r] (+ m (:act-sec r))) 0 done)
   pct (if (> est-sec 0) (quot (* act-sec 100) est-sec) 0)]
  (->Calib pct (count done) est-sec act-sec)))

(defn syncable-sessions [idx]
  (filterv (fn [s] (and (some? (k/one-i idx s "session_of")) (and (some? (k/one-i idx s "end_time")) (nil? (k/one-i idx s "clockify_id"))))) (:subjects idx)))

(defn- ^Boolean starts-with-any? [^String s prefixes]
  (loop [ps prefixes]
  (if (empty? ps) false (if (str/starts-with? s (first ps)) true (recur (vec (rest ps)))))))

(defn- actual-seconds-in [idx ^String te prefixes iso->sec]
  (reduce (fn [acc s] (let [so (k/one-i idx s "session_of")
   st (k/one-i idx s "start_time")
   en (k/one-i idx s "end_time")]
  (if (and (= so te) (and (some? st) (and (some? en) (starts-with-any? st prefixes)))) (+ acc (- (iso->sec en) (iso->sec st))) acc))) 0 (:subjects idx)))

(defn logged-rows [idx prefixes iso->sec]
  (filterv (fn [r] (> (:act-sec r) 0)) (mapv (fn [te] (->Row te 0 (actual-seconds-in idx te prefixes iso->sec) (proj/terminal-i? idx te))) (k/thread-ids-i idx))))
