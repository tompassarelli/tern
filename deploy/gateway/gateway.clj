#!/usr/bin/env bb
;; Lodestar auth gateway — the network-safe edge in front of per-tenant
;; coordinators. This is the ONE component the loopback coordinator was missing
;; to go from single-machine to remote/multi-tenant (see ../../docs/hosting.md).
;;
;; What it does: terminates HTTP, authenticates a bearer token, maps the token to
;; a tenant, and forwards the request to THAT tenant's coordinator over the local
;; loopback socket (the coordinator's existing line-delimited EDN protocol). One
;; coordinator + one claims.log per tenant — the instance-per-tenant model.
;;
;;   GET  /healthz          -> 200 "ok"
;;   POST /v1/rpc           -> Authorization: Bearer <token>, body is one EDN map
;;                             (e.g. {:op :version} / {:op :assert :te "@id" ...});
;;                             forwarded to the tenant's coordinator, reply relayed.
;;
;; Config (env):
;;   GATEWAY_PORT      listen port (default 8088). Put TLS in front of this
;;                     (Caddy/nginx) — the gateway speaks plain HTTP by design.
;;   GATEWAY_TENANTS   path to the tenant registry (EDN), default ./tenants.edn:
;;                       {"acme" {:tokens #{"<sha256-hex>" ...} :coordinator-port 7801}}
;;                     Tokens are stored HASHED (sha-256 hex), never in plaintext.
;;                     `:tokens` is a SET so rotation keeps old + new valid during a
;;                     grace window (revoke = drop a hash). The legacy single-token
;;                     `:token-sha256 "<hex>"` form is still accepted. The file is
;;                     re-read on mtime change, so provision.sh rotate/revoke takes
;;                     effect with no gateway restart.
;;   GATEWAY_AUDIT_LOG path to append structured audit lines (default: stderr).
;;   GATEWAY_RATE      per-tenant sustained req/s (default 20).
;;   GATEWAY_BURST     per-tenant burst bucket (default 40).
;;   GATEWAY_MAX_BODY  max request body bytes (default 65536 -> 413 over it).
;;
;; Scope (honest): the first hardened slice of the auth layer. It assumes the
;; gateway runs on the same host / shared netns as the coordinators (loopback
;; forwarding; set :coordinator-host for a private network). TLS lives in a
;; reverse proxy ahead of it. See the checklist in ./README.md.
(require '[org.httpkit.server :as http]
         '[clojure.edn :as edn]
         '[clojure.string :as str]
         '[clojure.java.io :as io]
         '[lodestar.gatepolicy :as gp])   ; the security DECISIONS, real-typed in Beagle (not Any)
(import '[java.net Socket InetSocketAddress]
        '[java.io BufferedReader BufferedWriter InputStreamReader OutputStreamWriter InputStream])

(def listen-port (Integer/parseInt (or (System/getenv "GATEWAY_PORT") "8088")))
(def tenants-path (or (System/getenv "GATEWAY_TENANTS") "tenants.edn"))
(def audit-path   (System/getenv "GATEWAY_AUDIT_LOG"))            ; nil => stderr
(def rate-per-s   (Double/parseDouble (or (System/getenv "GATEWAY_RATE")  "20")))
(def burst        (Double/parseDouble (or (System/getenv "GATEWAY_BURST") "40")))
(def max-body     (Integer/parseInt   (or (System/getenv "GATEWAY_MAX_BODY") "65536")))

;; Token hashing, tenant resolution, rate-limit accounting, and request validation
;; are the gateway's security DECISIONS — they live in lodestar.gatepolicy with REAL
;; types (Tenant/Bucket records, Map String Tenant, Float). This file is the effects
;; shell: HTTP, sockets, the registry file, the buckets atom, the audit log.

;; --- audit log: one EDN line per request; never logs the object VALUE (:r) -----
(def audit-lock (Object.))
(defn audit! [m]
  (let [line (pr-str (assoc m :ts (str (java.time.Instant/now))))]
    (locking audit-lock
      (if audit-path
        (spit audit-path (str line "\n") :append true)
        (binding [*out* *err*] (println line))))))

;; --- tenant registry: reload on mtime change, index every active token-hash ----
(def registry (atom {:mtime -1 :by-token {} :tenants 0}))

(defn- active-hashes [t]
  (into (set (:tokens t)) (when-let [h (:token-sha256 t)] [h])))   ; :tokens set + legacy single

(defn load-registry! []
  (let [f (io/file tenants-path)]
    (when (.exists f)
      (let [mt (.lastModified f)]
        (when (not= mt (:mtime @registry))
          (let [tenants (edn/read-string (slurp f))
                ;; raw EDN entry -> validated, typed gp/Tenant (the by-hash index)
                by-token (into {} (for [[tid t] tenants
                                        h (active-hashes t)]
                                    [h (gp/parse-tenant tid t)]))]
            (reset! registry {:mtime mt :by-token by-token :tenants (count tenants)})))))
    @registry))

(defn tenant-for-token [token]
  (gp/token->tenant (:by-token (load-registry!)) token))   ; hashes + looks up; nil on miss/empty

(defn bearer [req]
  (gp/bearer-token (get-in req [:headers "authorization"])))

;; --- per-tenant token-bucket rate limit ---------------------------------------
(def buckets (atom {}))
(defn allow? [tenant]
  ;; the pure token-bucket STEP (state in -> new state + verdict) is gp/bucket-step;
  ;; the atom + clock are the effects we keep here.
  (:ok (get (swap! buckets update tenant
              (fn [b] (gp/bucket-step b (double (System/nanoTime)) rate-per-s burst)))
            tenant)))

;; --- bounded body read: caps bytes regardless of a lying Content-Length -------
(defn read-body [^InputStream is limit]
  (if (nil? is) ""
    (let [buf (byte-array (inc limit))
          n (loop [off 0]
              (if (>= off (inc limit)) off
                (let [r (.read is buf off (- (inc limit) off))]
                  (if (neg? r) off (recur (+ off r))))))]
      (if (> n limit) ::too-big (String. buf 0 (int n) "UTF-8")))))

;; --- forward one EDN line to the tenant's coordinator -------------------------
;; host defaults to loopback (gateway co-located with the coordinator); set
;; :coordinator-host in the registry to reach a coordinator on a private network
;; (e.g. a per-tenant container — see deploy/docker-compose.example.yml).
(defn coord-rpc [host port req-map]
  (with-open [s (Socket.)]
    (.connect s (InetSocketAddress. ^String host (int port)) 2000)
    (let [w (BufferedWriter. (OutputStreamWriter. (.getOutputStream s) "UTF-8"))
          r (BufferedReader. (InputStreamReader. (.getInputStream s) "UTF-8"))]
      (.write w (pr-str req-map)) (.newLine w) (.flush w)   ; pr-str => guaranteed single line
      (.readLine r))))

(defn- coord-result [resp]                                  ; coarse status for the audit line
  (cond (nil? resp) :no-response
        (str/includes? resp ":error")    :error
        (str/includes? resp ":conflict") :conflict
        :else :ok))

(defn edn-resp [status body] {:status status :headers {"content-type" "application/edn"} :body (str body "\n")})
(defn txt-resp [status body] {:status status :headers {"content-type" "text/plain"}     :body (str body "\n")})

(defn handle-rpc [req]
  (let [remote (:remote-addr req)
        t (tenant-for-token (bearer req))]
    (cond
      (nil? t)
      (do (audit! {:event :rpc :tenant nil :status :unauthorized :remote remote})
          (txt-resp 401 "unauthorized"))

      (not (allow? (:tid t)))
      (do (audit! {:event :rpc :tenant (:tid t) :status :rate-limited :remote remote})
          (txt-resp 429 "rate limited"))

      :else
      (let [raw (read-body (:body req) max-body)]
        (cond
          (= raw ::too-big)
          (do (audit! {:event :rpc :tenant (:tid t) :status :too-large :remote remote})
              (txt-resp 413 (str "request body exceeds " max-body " bytes")))

          :else
          (let [parsed (try (edn/read-string raw) (catch Exception _ ::bad))]
            (cond
              (not (gp/valid-op? parsed))   ; map with a keyword :op; ::bad fails (not a map)
              (do (audit! {:event :rpc :tenant (:tid t) :status :bad-request :remote remote})
                  (txt-resp 400 "bad request — body must be an EDN map with a keyword :op"))

              :else
              (try
                (let [resp (coord-rpc (:host t) (:port t) parsed)]
                  ;; audit op + subject + predicate + coarse result — NEVER the object value
                  (audit! {:event :rpc :tenant (:tid t) :op (:op parsed)
                           :te (:te parsed) :p (:p parsed)
                           :status (coord-result resp) :remote remote})
                  (edn-resp 200 resp))
                (catch java.net.ConnectException _
                  (audit! {:event :rpc :tenant (:tid t) :op (:op parsed) :status :coordinator-down :remote remote})
                  (txt-resp 502 (str "coordinator down for tenant " (:tid t))))
                (catch Exception e
                  (audit! {:event :rpc :tenant (:tid t) :status :gateway-error :remote remote})
                  (txt-resp 500 (str "gateway error: " (.getMessage e))))))))))))

(defn handler [req]
  (case [(:request-method req) (:uri req)]
    [:get  "/healthz"] (txt-resp 200 "ok")
    [:post "/v1/rpc"]  (handle-rpc req)
    (txt-resp 404 "not found")))

(load-registry!)
(http/run-server handler {:port listen-port :ip "0.0.0.0"})
(println (str "lodestar gateway listening on :" listen-port
              "  tenants=" (:tenants @registry) " (" tenants-path ")"
              "  rate=" rate-per-s "/s burst=" burst " max-body=" max-body
              "  audit=" (or audit-path "stderr")))
@(promise)   ; block forever
