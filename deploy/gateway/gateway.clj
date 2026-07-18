#!/usr/bin/env bb
;; North auth gateway — the network-safe edge in front of per-tenant
;; coordinators. This is the ONE component the loopback coordinator was missing
;; to go from single-machine to remote/multi-tenant (see ../../docs/hosting.md).
;;
;; What it does: terminates HTTP, authenticates a bearer token, maps the token to
;; a tenant, injects THAT tenant's corpus identity, and forwards the fenced
;; request to its coordinator over the line-delimited EDN protocol. One
;; coordinator + one facts.log per tenant — the instance-per-tenant model.
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
;;                       {"acme" {:tokens #{"<sha256-hex>" ...}
;;                                :coordinator-port 7801
;;                                :coordinator-log "/srv/north/tenants/acme/facts.log"}}
;;                     Tokens are stored HASHED (sha-256 hex), never in plaintext.
;;                     `:tokens` is a SET so rotation keeps old + new valid during a
;;                     grace window (revoke = drop a hash). The legacy single-token
;;                     `:token-sha256 "<hex>"` form is still accepted. A bounded
;;                     content digest detects every rewrite, including same-mtime /
;;                     same-size rotation, with no gateway restart.
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
         '[north.gatepolicy :as gp])   ; the security DECISIONS, real-typed in Beagle (not Any)
(import '[java.net Socket InetSocketAddress InetAddress SocketTimeoutException]
        '[java.io BufferedWriter ByteArrayOutputStream OutputStreamWriter InputStream]
        '[java.nio ByteBuffer]
        '[java.nio.charset StandardCharsets CodingErrorAction])

(def listen-port (Integer/parseInt (or (System/getenv "GATEWAY_PORT") "8088")))
(def tenants-path (or (System/getenv "GATEWAY_TENANTS") "tenants.edn"))
(def audit-path   (System/getenv "GATEWAY_AUDIT_LOG"))            ; nil => stderr
(def rate-per-s   (Double/parseDouble (or (System/getenv "GATEWAY_RATE")  "20")))
(def burst        (Double/parseDouble (or (System/getenv "GATEWAY_BURST") "40")))
(def max-body     (Integer/parseInt   (or (System/getenv "GATEWAY_MAX_BODY") "65536")))
(def coord-response-max
  (Integer/parseInt (or (System/getenv "GATEWAY_COORD_MAX_RESPONSE") "16777216")))
(def coord-deadline-ms
  (Long/parseLong (or (System/getenv "GATEWAY_COORD_DEADLINE_MS") "30000")))
(when (or (< coord-response-max 1024) (> coord-response-max 67108864))
  (throw (ex-info "GATEWAY_COORD_MAX_RESPONSE must be 1024..67108864" {})))
(when (or (< coord-deadline-ms 1) (> coord-deadline-ms 120000))
  (throw (ex-info "GATEWAY_COORD_DEADLINE_MS must be 1..120000" {})))
;; Optional allowlist of coordinator hosts the gateway may forward to (comma-sep).
;; Defense-in-depth against a registry row pointing :coordinator-host at an internal
;; service (SSRF). If unset, any host EXCEPT link-local/any-local/multicast is allowed.
(def coord-allowlist
  (when-let [s (System/getenv "GATEWAY_ALLOWED_COORD_HOSTS")]
    (set (remove str/blank? (map str/trim (str/split s #","))))))

;; Token hashing, tenant resolution, rate-limit accounting, and request validation
;; are the gateway's security DECISIONS — they live in north.gatepolicy with REAL
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

;; --- bounded body/file read: caps bytes regardless of metadata claims ----------
(defn decode-utf8 [bytes offset length]
  (let [decoder (doto (.newDecoder StandardCharsets/UTF_8)
                  (.onMalformedInput CodingErrorAction/REPORT)
                  (.onUnmappableCharacter CodingErrorAction/REPORT))]
    (str (.decode decoder (ByteBuffer/wrap bytes (int offset) (int length))))))

(defn read-body [^InputStream is limit]
  (if (nil? is) ""
    (let [buf (byte-array (inc limit))
          n (loop [off 0]
              (if (>= off (inc limit)) off
                (let [r (.read is buf off (- (inc limit) off))]
                  (if (neg? r) off (recur (+ off r))))))]
      (if (> n limit)
        ::too-big
        (try
          (decode-utf8 buf 0 n)
          (catch java.nio.charset.CharacterCodingException _ ::bad-utf8))))))

;; --- tenant registry: bounded content snapshot + content-hash invalidation -----
;; mtime/size are not identity: a same-size same-tick rewrite can rotate a token
;; or route. Hash the exact bounded byte snapshot that is parsed.
(def registry (atom {:sig nil :by-token {} :tenants 0}))
(def registry-max-bytes 1048576)
(def token-hash-pattern #"[0-9a-f]{64}")

(defn- active-hashes [t]
  (let [tokens-present? (contains? t :tokens)
        legacy-present? (contains? t :token-sha256)
        tokens (:tokens t)
        legacy (:token-sha256 t)]
    (when (and (or tokens-present? legacy-present?)
               (or (nil? tokens) (set? tokens))
               (or (nil? legacy) (string? legacy))
               (every? #(and (string? %) (re-matches token-hash-pattern %))
                       (or tokens #{}))
               (or (nil? legacy) (re-matches token-hash-pattern legacy)))
      (into (or tokens #{}) (when legacy [legacy])))))

(defn- validate-registry [tenants]
  (when-not (map? tenants)
    (throw (ex-info "registry root must be a map" {:kind :invalid-registry})))
  (doseq [[tid cfg] tenants]
    (when-not (and (string? tid)
                   (not (str/blank? tid))
                   (map? cfg)
                   (some? (gp/parse-tenant tid cfg))
                   (some? (active-hashes cfg)))
      (throw (ex-info "invalid tenant registry entry"
                      {:kind :invalid-registry :tenant (str tid)}))))
  tenants)

;; Build the hash->Tenant index, FAILING CLOSED on a token hash shared across two
;; different tenants: a collision would otherwise route one party's token to an
;; arbitrary tenant (map-order dependent). The colliding hash authenticates to NOBODY.
(defn- index-by-token [tenants]
  (let [routes (into {} (map (fn [[tid cfg]] [tid (gp/parse-tenant tid cfg)]) tenants))
        owners (reduce (fn [acc [hash tid]]
                         (update acc hash (fnil conj #{}) tid))
                       {}
                       (for [[tid cfg] tenants hash (active-hashes cfg)] [hash tid]))
        dups (keep (fn [[hash tids]] (when (> (count tids) 1) hash)) owners)]
    (when (seq dups)
      (audit! {:event :registry :status :duplicate-token-hash :count (count dups)})
      (binding [*out* *err*]
        (println (str "WARNING: " (count dups) " token hash(es) shared across tenants — rejecting them (fail-closed)"))))
    (into {}
          (keep (fn [[hash tids]]
                  (when (= 1 (count tids))
                    [hash (get routes (first tids))])))
          owners)))

(defn load-registry! []
  (let [f (io/file tenants-path)]
    (if-not (.exists f)
      (reset! registry {:sig :missing :by-token {} :tenants 0})
      (with-open [input (io/input-stream f)]
        (let [raw (read-body input registry-max-bytes)]
          (cond
            (= raw ::too-big)
            (when (not= :too-big (:sig @registry))
              (audit! {:event :registry :status :too-large})
              (reset! registry {:sig :too-big :by-token {} :tenants 0}))

            (= raw ::bad-utf8)
            (when (not= :bad-utf8 (:sig @registry))
              (audit! {:event :registry :status :invalid-utf8})
              (reset! registry {:sig :bad-utf8 :by-token {} :tenants 0}))

            :else
            (let [sig (gp/sha256-hex raw)]
              (when (not= sig (:sig @registry))
                (try
                  (let [tenants (validate-registry (gp/parse-exact-edn raw))]
                    (reset! registry {:sig sig
                                      :by-token (index-by-token tenants)
                                      :tenants (count tenants)}))
                  (catch Exception e
                    ;; Never retain a previously authorized index after a
                    ;; malformed rewrite: revocation must fail closed.
                    (audit! {:event :registry :status :invalid
                             :error (.getSimpleName (class e))})
                    (reset! registry {:sig sig :by-token {} :tenants 0})))))))))
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

;; --- forward one bounded EDN/JSON line to the tenant's coordinator ------------
;; host defaults to loopback (gateway co-located with the coordinator); set
;; :coordinator-host in the registry to reach a coordinator on a private network
;; (e.g. a per-tenant container — see deploy/docker-compose.example.yml).
(defn- newline-index [buf n]
  (loop [i 0]
    (cond
      (>= i n) -1
      (= 10 (bit-and 255 (aget buf i))) i
      :else (recur (inc i)))))

(defn read-bounded-line
  "Read exactly one newline-terminated UTF-8 response under both a byte cap and
   an absolute wall-clock deadline. Short SO_TIMEOUT ticks cannot be evaded by
   drip-feeding bytes. The newline is terminal: EOF must follow within the same
   deadline, with no surplus byte or second frame."
  [^Socket socket ^InputStream input limit deadline-ms]
  (let [deadline (+ (System/nanoTime) (* 1000000 deadline-ms))
        buf (byte-array 8192)
        out (ByteArrayOutputStream.)]
    (loop [line-complete? false]
      (let [remaining (- deadline (System/nanoTime))]
        (when (<= remaining 0)
          (throw (SocketTimeoutException. "coordinator response deadline exceeded")))
        (.setSoTimeout socket
                       (int (max 1 (min 1000
                                        (long (Math/ceil (/ remaining 1000000.0)))))))
        (let [n (try (.read input buf)
                     (catch SocketTimeoutException _ ::tick))]
          (cond
            (= n ::tick) (recur line-complete?)
            (neg? n)
            (cond
              line-complete?
              (let [bytes (.toByteArray out)]
                (decode-utf8 bytes 0 (alength bytes)))

              (zero? (.size out))
              nil

              :else
              (throw (ex-info "coordinator closed before newline"
                              {:kind :coord-response-truncated})))

            line-complete?
            (throw (ex-info "coordinator sent bytes after terminal response frame"
                            {:kind :coord-response-surplus}))

            :else
            (let [newline (newline-index buf n)
                  take (if (neg? newline) n newline)
                  total (+ (.size out) take)]
              (when (> total limit)
                (throw (ex-info "coordinator response exceeds byte cap"
                                {:kind :coord-response-too-large
                                 :limit limit})))
              (.write out buf 0 take)
              (if (neg? newline)
                (recur false)
                (if (< (inc newline) n)
                  (throw (ex-info "coordinator sent bytes after terminal response frame"
                                  {:kind :coord-response-surplus}))
                  (recur true))))))))))

(defn coord-rpc
  ([address port req-map]
   (coord-rpc address port req-map coord-response-max coord-deadline-ms))
  ([address port req-map response-limit deadline-ms]
   (with-open [s (Socket.)]
     ;; `address` is already resolved and policy-checked; never resolve the
     ;; registry hostname a second time at connect (DNS rebinding/TOCTOU).
     (.connect s (InetSocketAddress. ^InetAddress address (int port)) 2000)
     (let [w (BufferedWriter. (OutputStreamWriter. (.getOutputStream s) "UTF-8"))]
       (.write w (pr-str req-map)) (.newLine w) (.flush w)
       (read-bounded-line s (.getInputStream s) response-limit deadline-ms)))))

;; SSRF guard: the coordinator host comes from the registry. RESOLVE it to an IP
;; (so a hostname pointing at the metadata endpoint is caught too) and refuse
;; link-local (incl. 169.254.169.254 cloud metadata), any-local (0.0.0.0), and
;; multicast; honor an explicit allowlist if configured. Loopback/private are fine
;; (the normal co-located / per-tenant-container topologies). Babashka cannot
;; reflectively invoke InetAddress's boolean classifiers, so classify the
;; resolved address bytes directly rather than relying on partial text prefixes.
(defn- unsigned-byte [bytes index]
  (bit-and 255 (aget bytes index)))

(defn- blocked-ipv4-bytes? [bytes offset]
  (let [a (unsigned-byte bytes offset)
        b (unsigned-byte bytes (inc offset))
        c (unsigned-byte bytes (+ offset 2))
        d (unsigned-byte bytes (+ offset 3))]
    (or
     (and (= a 0) (= b 0) (= c 0) (= d 0))
     (and (= a 169) (= b 254))
     (<= 224 a 239))))

(defn- ipv4-mapped? [bytes]
  (and (= 16 (alength bytes))
       (every? #(zero? (unsigned-byte bytes %)) (range 10))
       (= 255 (unsigned-byte bytes 10))
       (= 255 (unsigned-byte bytes 11))))

(defn- ip-blocked? [^InetAddress address]
  (let [bytes (.getAddress address)
        n (alength bytes)]
    (cond
      (= n 4)
      (blocked-ipv4-bytes? bytes 0)

      (= n 16)
      (let [a (unsigned-byte bytes 0)
            b (unsigned-byte bytes 1)]
        (or
         ;; IPv6 unspecified.
         (every? #(zero? (unsigned-byte bytes %)) (range 16))
         ;; fe80::/10 is fe80:: through febf::, not merely the text prefix fe80.
         (and (= a 254) (= 128 (bit-and b 192)))
         ;; ff00::/8 multicast.
         (= a 255)
         ;; Mapped IPv4 metadata/link-local/multicast stays blocked.
         (and (ipv4-mapped? bytes) (blocked-ipv4-bytes? bytes 12))))

      :else true)))

(defn resolve-coord-address [host]
  (try
    (when (or (nil? coord-allowlist) (contains? coord-allowlist host))
      (let [address (InetAddress/getByName host)]
        (when-not (ip-blocked? address) address)))
    (catch Exception _ nil)))                                ; unresolvable => refuse

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

          (= raw ::bad-utf8)
          (do (audit! {:event :rpc :tenant (:tid t) :status :bad-utf8 :remote remote})
              (txt-resp 400 "bad request — body must be valid UTF-8"))

          :else
          (let [parsed (or (gp/parse-exact-edn raw) ::bad)
                address (when (gp/valid-op? parsed)
                          (resolve-coord-address (:host t)))]
            (cond
              (not (gp/valid-op? parsed))   ; unfenced map with keyword :op; ::bad/nested fence fail
              (do (audit! {:event :rpc :tenant (:tid t) :status :bad-request :remote remote})
                  (txt-resp 400 "bad request — body must be an unfenced EDN map with a keyword :op"))

              (nil? address)   ; SSRF guard resolved once; this exact address is connected below
              (do (audit! {:event :rpc :tenant (:tid t) :status :forbidden-coord-host :host (:host t) :remote remote})
                  (txt-resp 502 "coordinator host not permitted"))

              :else
              (try
                (let [resp (coord-rpc address (:port t) (gp/fenced-request t parsed))
                      protocol-status (gp/protocol-status resp)]
                  ;; audit op + subject + predicate + coarse result — NEVER the object value
                  (cond
                    (= protocol-status "no-response")
                    (do
                      (audit! {:event :rpc :tenant (:tid t) :op (:op parsed)
                               :status :coordinator-no-response :remote remote})
                      (txt-resp 502 "coordinator returned no response"))

                    (= protocol-status "log-mismatch")
                    (do
                      (audit! {:event :rpc :tenant (:tid t) :op (:op parsed)
                               :status :coordinator-corpus-mismatch :remote remote})
                      (txt-resp 502 "coordinator corpus mismatch"))

                    (= protocol-status "protocol-error")
                    (do
                      (audit! {:event :rpc :tenant (:tid t) :op (:op parsed)
                               :status :coordinator-protocol-mismatch :remote remote})
                      (txt-resp 502 "coordinator does not honor the corpus-fence protocol"))

                    :else
                    (do
                      (audit! {:event :rpc :tenant (:tid t) :op (:op parsed)
                               :te (:te parsed) :p (:p parsed)
                               :status (coord-result resp) :remote remote})
                      (edn-resp 200 resp))))
                (catch java.net.ConnectException _
                  (audit! {:event :rpc :tenant (:tid t) :op (:op parsed) :status :coordinator-down :remote remote})
                  (txt-resp 502 (str "coordinator down for tenant " (:tid t))))
                (catch SocketTimeoutException _
                  (audit! {:event :rpc :tenant (:tid t) :op (:op parsed) :status :coordinator-timeout :remote remote})
                  (txt-resp 504 (str "coordinator timed out for tenant " (:tid t))))
                (catch clojure.lang.ExceptionInfo e
                  (let [kind (:kind (ex-data e))]
                    (if (contains? #{:coord-response-too-large
                                     :coord-response-truncated
                                     :coord-response-surplus} kind)
                      (do
                        (audit! {:event :rpc :tenant (:tid t) :op (:op parsed)
                                 :status kind :remote remote})
                        (txt-resp 502 "invalid coordinator response framing"))
                      (do
                        (audit! {:event :rpc :tenant (:tid t) :status :gateway-error
                                 :err (.getMessage e) :remote remote})
                        (txt-resp 500 "gateway error")))))
                (catch java.nio.charset.CharacterCodingException _
                  (audit! {:event :rpc :tenant (:tid t) :op (:op parsed)
                           :status :coord-response-invalid-utf8 :remote remote})
                  (txt-resp 502 "invalid coordinator response framing"))
                (catch Exception e
                  ;; audit captures the class/message internally; never echo it to the client
                  (audit! {:event :rpc :tenant (:tid t) :status :gateway-error :err (.getMessage e) :remote remote})
                  (txt-resp 500 "gateway error"))))))))))

(defn handler [req]
  (case [(:request-method req) (:uri req)]
    [:get  "/healthz"] (txt-resp 200 "ok")
    [:post "/v1/rpc"]  (handle-rpc req)
    (txt-resp 404 "not found")))

(when-not (= "1" (System/getenv "GATEWAY_LIB_ONLY"))
  (load-registry!)
  (http/run-server handler {:port listen-port :ip "0.0.0.0"})
  (println (str "north gateway listening on :" listen-port
                "  tenants=" (:tenants @registry) " (" tenants-path ")"
                "  rate=" rate-per-s "/s burst=" burst " max-body=" max-body
                "  audit=" (or audit-path "stderr")))
  @(promise))   ; block forever
