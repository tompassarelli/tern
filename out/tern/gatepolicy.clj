(ns tern.gatepolicy
  (:require [clojure.string :as str])
  (:import [java.security MessageDigest]))

(defrecord Tenant [tid host port])

(defn tenant-tid [r] (:tid r))

(defn tenant-host [r] (:host r))

(defn tenant-port [r] (:port r))

(defrecord Bucket [tokens ts ok])

(defn bucket-tokens [r] (:tokens r))

(defn bucket-ts [r] (:ts r))

(defn bucket-ok [r] (:ok r))

(defn- ^String hex-byte [b]
  (let [v (bit-and b 255)
   h "0123456789abcdef"]
  (str (subs h (quot v 16) (+ (quot v 16) 1)) (subs h (rem v 16) (+ (rem v 16) 1)))))

(defn ^String sha256-hex [^String s]
  (let [md (MessageDigest/getInstance "SHA-256")
   bs (.digest md (.getBytes s "UTF-8"))]
  (reduce (fn [acc b] (str acc (hex-byte b))) "" (vec bs))))

(defn ^String bearer-token [^String auth]
  (if (and (some? auth) (str/starts-with? auth "Bearer ")) (subs auth 7) ""))

(defn parse-tenant [^String tid cfg]
  (let [host (:coordinator-host cfg)
   port (:coordinator-port cfg)]
  (if (and (some? port)) (->Tenant tid (if (some? host) host "127.0.0.1") port) nil)))

(defn token->tenant [by-hash ^String token]
  (if (and (some? token) (not (= token ""))) (get by-hash (sha256-hex token)) nil))

(defn ^Bucket bucket-step [b now rate burst]
  (let [bk (if (some? b) b (->Bucket burst now true))
   elapsed (max 0.0 (/ (- now (:ts bk)) 1000000000.0))
   refilled (min burst (+ (:tokens bk) (* elapsed rate)))]
  (if (>= refilled 1.0) (->Bucket (- refilled 1.0) now true) (->Bucket refilled now false))))

(defn ^Boolean valid-op? [parsed]
  (and (map? parsed) (keyword? (:op parsed))))

(defn ^String coord-status [^String resp]
  (cond
  (nil? resp) "no-response"
  (str/includes? resp ":error") "error"
  (str/includes? resp ":conflict") "conflict"
  :else "ok"))
