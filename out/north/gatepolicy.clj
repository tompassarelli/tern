(ns north.gatepolicy
  (:require [clojure.string :as str]
            [clojure.edn :as edn]
            [cheshire.core :as json])
  (:import [java.security MessageDigest]
           [java.io StringReader]
           [java.io PushbackReader]))

(defrecord Tenant [tid host port log])

(defn tenant-tid [r] (:tid r))

(defn tenant-host [r] (:host r))

(defn tenant-port [r] (:port r))

(defn tenant-log [r] (:log r))

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
   port (:coordinator-port cfg)
   log (:coordinator-log cfg)]
  (if (and (integer? port) (<= 1 port) (<= port 65535) (or (nil? host) (string? host)) (string? log) (not (str/blank? log)) (str/starts-with? log "/")) (->Tenant tid (if (some? host) host "127.0.0.1") port log) nil)))

(defn token->tenant [by-hash ^String token]
  (if (and (some? token) (not (= token ""))) (get by-hash (sha256-hex token)) nil))

(defn ^Bucket bucket-step [b now rate burst]
  (let [bk (if (some? b) b (->Bucket burst now true))
   elapsed (max 0.0 (/ (- now (:ts bk)) 1000000000.0))
   refilled (min burst (+ (:tokens bk) (* elapsed rate)))]
  (if (>= refilled 1.0) (->Bucket (- refilled 1.0) now true) (->Bucket refilled now false))))

(defn ^Boolean valid-op? [parsed]
  (and (map? parsed) (keyword? (:op parsed)) (not (= (:op parsed) :for-log))))

(defn fenced-request [^Tenant tenant parsed]
  (let [envelope {:op :for-log :expected-log (:log tenant) :request parsed}]
  (if (contains? parsed :fmt) (assoc envelope :fmt (:fmt parsed)) envelope)))

(defn parse-exact-edn [^String resp]
  (try
  (with-open [reader (PushbackReader. (StringReader. resp))]
  (let [value (edn/read reader)
   trailing? (loop []
  (let [ch (.read reader)]
  (cond
  (= ch -1) false
  (or (= ch 44) (Character/isWhitespace ch)) (recur)
  :else true)))]
  (if trailing? nil value)))
  (catch StackOverflowError _
    nil)
  (catch Exception _
    nil)))

(defn- ^Boolean whitespace-tail? [^String s start]
  (loop [i start]
  (if (>= i (count s)) true (if (Character/isWhitespace (int (.charAt s i))) (recur (inc i)) false))))

(defn- ^Boolean one-json-object? [^String s]
  (let [n (count s)
   start (loop [i 0]
  (if (and (< i n) (Character/isWhitespace (int (.charAt s i)))) (recur (inc i)) i))]
  (if (or (>= start n) (not= 123 (int (.charAt s start)))) false (loop [i start
   depth 0
   in-string false
   escaped false]
  (if (>= i n) false (let [ch (int (.charAt s i))]
  (cond
  in-string (cond
  escaped (recur (inc i) depth true false)
  (= ch 92) (recur (inc i) depth true true)
  (= ch 34) (recur (inc i) depth false false)
  :else (recur (inc i) depth true false))
  (= ch 34) (recur (inc i) depth true false)
  (= ch 123) (recur (inc i) (inc depth) false false)
  (= ch 125) (let [next-depth (dec depth)]
  (if (= next-depth 0) (whitespace-tail? s (inc i)) (if (neg? next-depth) false (recur (inc i) next-depth false false))))
  :else (recur (inc i) depth false false))))))))

(defn ^String protocol-status [^String resp]
  (if (nil? resp) "no-response" (let [parsed (or (parse-exact-edn resp) (if (one-json-object? resp) (do
  (try
  (json/parse-string resp)
  (catch Exception _
    nil)))))]
  (if (not (map? parsed)) "protocol-error" (let [code (or (:code parsed) (get parsed "code"))
   error (or (:error parsed) (get parsed "error"))]
  (cond
  (or (= code :log-mismatch) (= code "log-mismatch")) "log-mismatch"
  (or (= code :log-fence-required) (= code "log-fence-required") (= error "unknown op")) "protocol-error"
  :else "ok"))))))

(defn ^String coord-status [^String resp]
  (cond
  (nil? resp) "no-response"
  (str/includes? resp ":error") "error"
  (str/includes? resp ":conflict") "conflict"
  :else "ok"))
