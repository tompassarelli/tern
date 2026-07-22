(ns north.clock
  (:require [fram.kernel :as k]
            [north.projections :as proj]
            [clojure.string :as str]))

(defn ^String clocked-by [idx ^String sess]
  (let [a (k/one-i idx sess "clocked_by")]
  (if (some? a) a "user")))

(defn ^Boolean client-session? [idx ^String sess]
  (and (= (k/one-i idx sess "kind") "client_session") (and (= (clocked-by idx sess) "user") (and (some? (k/one-i idx sess "owner")) (some? (k/one-i idx sess "start_time"))))))

(defn ^Boolean legacy-human-session? [idx ^String sess]
  (and (= (clocked-by idx sess) "user") (and (some? (k/one-i idx sess "session_of")) (some? (k/one-i idx sess "start_time")))))

(defn ^Boolean human-billing-session? [idx ^String sess]
  (or (client-session? idx sess) (legacy-human-session? idx sess)))

(defn ^Boolean human-open? [idx ^String sess]
  (and (human-billing-session? idx sess) (nil? (k/one-i idx sess "end_time"))))

(defn open-human-sessions [idx]
  (filterv (fn [s] (human-open? idx s)) (:subjects idx)))

(defn running-human-session [idx]
  (let [sessions (open-human-sessions idx)]
  (if (= (count sessions) 1) (first sessions) nil)))

(defn session-owner [idx ^String sess]
  (if (client-session? idx sess) (k/one-i idx sess "owner") (let [te (k/one-i idx sess "session_of")]
  (if (some? te) (k/one-i idx te "owner") nil))))

(def ^String CLIENT-RATE-KIND "client_rate_config")

(defn ^String client-rate-subject [^String owner]
  (str "@client-rate:" owner))

(defn ^Boolean positive-rate? [^String rate]
  (let [parsed (parse-double rate)]
  (and (some? (re-matches #"[0-9]+(?:\.[0-9]+)?" rate)) (and (some? parsed) (> parsed 0.0)))))

(defn client-rate-configs [idx ^String owner]
  (filterv (fn [subject] (and (= (k/one-i idx subject "kind") CLIENT-RATE-KIND) (= (k/one-i idx subject "owner") owner))) (:subjects idx)))

(defrecord ClientRateAuthority [status subject rate configs])

(defn clientrateauthority-status [r] (:status r))

(defn clientrateauthority-subject [r] (:subject r))

(defn clientrateauthority-rate [r] (:rate r))

(defn clientrateauthority-configs [r] (:configs r))

(defn ^ClientRateAuthority client-rate-authority [idx ^String owner]
  (let [expected (client-rate-subject owner)
   configs (client-rate-configs idx owner)
   n (count configs)]
  (cond
  (= n 0) (->ClientRateAuthority "missing" expected "" 0)
  (> n 1) (->ClientRateAuthority "duplicate" expected "" n)
  :else (let [subject (first configs)
   rates (vec (sort (distinct (k/many-i idx subject "rate"))))]
  (cond
  (not= subject expected) (->ClientRateAuthority "noncanonical" subject "" 1)
  (empty? rates) (->ClientRateAuthority "missing-rate" subject "" 1)
  (> (count rates) 1) (->ClientRateAuthority "ambiguous-rate" subject (str/join ", " rates) 1)
  (not (positive-rate? (first rates))) (->ClientRateAuthority "invalid-rate" subject (first rates) 1)
  :else (->ClientRateAuthority "ok" subject (first rates) 1))))))

(defn ^Boolean open? [idx ^String s]
  (and (some? (k/one-i idx s "session_of")) (and (some? (k/one-i idx s "start_time")) (nil? (k/one-i idx s "end_time")))))

(defn open-sessions [idx]
  (filterv (fn [s] (open? idx s)) (:subjects idx)))

(defn running-session-for [idx ^String agent]
  (reduce (fn [found s] (if (some? found) found (if (and (open? idx s) (= (clocked-by idx s) agent)) s found))) nil (:subjects idx)))

(defn actual-seconds [idx ^String te iso->sec]
  (reduce (fn [acc s] (let [so (k/one-i idx s "session_of")
   st (k/one-i idx s "start_time")
   en (k/one-i idx s "end_time")]
  (if (and (= so te) (and (= (clocked-by idx s) "user") (and (some? st) (some? en)))) (+ acc (- (iso->sec en) (iso->sec st))) acc))) 0 (:subjects idx)))

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
  (filterv (fn [s] (and (human-billing-session? idx s) (and (some? (k/one-i idx s "end_time")) (nil? (k/one-i idx s "clockify_id"))))) (:subjects idx)))

(defn- ^Boolean starts-with-any? [^String s prefixes]
  (loop [ps prefixes]
  (if (empty? ps) false (if (str/starts-with? s (first ps)) true (recur (vec (rest ps)))))))

(defn- actual-seconds-in [idx ^String te prefixes iso->sec]
  (reduce (fn [acc s] (let [so (k/one-i idx s "session_of")
   st (k/one-i idx s "start_time")
   en (k/one-i idx s "end_time")]
  (if (and (= so te) (and (= (clocked-by idx s) "user") (and (some? st) (and (some? en) (starts-with-any? st prefixes))))) (+ acc (- (iso->sec en) (iso->sec st))) acc))) 0 (:subjects idx)))

(defn logged-rows [idx prefixes iso->sec]
  (filterv (fn [r] (> (:act-sec r) 0)) (mapv (fn [te] (->Row te 0 (actual-seconds-in idx te prefixes iso->sec) (proj/terminal-i? idx te))) (k/thread-ids-i idx))))

(defrecord Iv [day start end])

(defn iv-day [r] (:day r))

(defn iv-start [r] (:start r))

(defn iv-end [r] (:end r))

(defn owner-intervals [idx ^String owner iso->sec]
  (reduce (fn [acc s] (let [st (k/one-i idx s "start_time")
   en (k/one-i idx s "end_time")]
  (if (and (human-billing-session? idx s) (and (some? st) (some? en))) (let [o (session-owner idx s)]
  (if (= o owner) (conj acc (->Iv (subs st 0 10) (iso->sec st) (iso->sec en))) acc)) acc))) [] (:subjects idx)))

(defrecord Merge [open cs ce total])

(defn merge-open [r] (:open r))

(defn merge-cs [r] (:cs r))

(defn merge-ce [r] (:ce r))

(defn merge-total [r] (:total r))

(defn union-seconds [ivs]
  (let [sorted (vec (sort-by (fn [iv] (:start iv)) ivs))
   m (reduce (fn [st iv] (if (:open st) (if (<= (:start iv) (:ce st)) (->Merge true (:cs st) (if (> (:end iv) (:ce st)) (:end iv) (:ce st)) (:total st)) (->Merge true (:start iv) (:end iv) (+ (:total st) (- (:ce st) (:cs st))))) (->Merge true (:start iv) (:end iv) (:total st)))) (->Merge false 0 0 0) sorted)]
  (if (:open m) (+ (:total m) (- (:ce m) (:cs m))) (:total m))))

(defrecord DayWall [day secs])

(defn daywall-day [r] (:day r))

(defn daywall-secs [r] (:secs r))

(defn owner-wall-by-day [idx ^String owner iso->sec]
  (let [ivs (owner-intervals idx owner iso->sec)
   days (vec (sort (distinct (mapv (fn [iv] (:day iv)) ivs))))]
  (mapv (fn [d] (->DayWall d (union-seconds (filterv (fn [iv] (= (:day iv) d)) ivs)))) days)))

(defn owner-wall-total [idx ^String owner iso->sec]
  (union-seconds (owner-intervals idx owner iso->sec)))
