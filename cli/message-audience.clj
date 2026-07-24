;; Shared human-message audience semantics.
;;
;; Direct mail is addressed by its `to` fact. A broadcast keeps `to="*"` as the
;; subscription trigger, but authority to deliver comes only from the finite
;; `broadcast_to` facts snapshotted before that trigger lands. An audience-less
;; historical wildcard is therefore inert: no future session can receive or ack
;; it, and no time cutoff is needed.
(ns north.message-audience
  (:require [cheshire.core :as json]
            [clojure.set :as set]
            [clojure.string :as str]
            [north.coord :as coord]))

(def broadcast-address "*")
(def audience-predicate "broadcast_to")
(def audience-version-predicate "broadcast_audience_version")
(def audience-version "snapshot-v1")
(def lease-session-prefix "@lease:session:")
(def delivery-claim-ttl-ms 30000)
(def rejection-predicate "delivery_rejection")
(def rejected-by-predicate "delivery_rejected_by")
(def steer-manifest-predicate "target_identity_manifest_sha256")
(def rejection-reasons
  #{"invalid_message_id" "missing_sender" "invalid_sender" "sender_too_large"
    "missing_subject" "invalid_subject" "subject_too_large"
    "missing_body" "invalid_body" "body_too_large"
    "message_frame_too_large" "steer_manifest_missing"
    "steer_type_invalid" "steer_route_invalid" "steer_route_stale"
    "steer_route_not_armed"})
(def max-rejection-recipient-bytes 512)
(def max-direct-addresses 256)
(def max-direct-address-bytes 512)
(def pending-page-limit 256)
(def manifest-sha256-bytes 64)
(defn utf8-bytes [value]
  (alength (.getBytes (str value) java.nio.charset.StandardCharsets/UTF_8)))
(def max-rejection-evidence-bytes
  ;; Exact maximum canonical JSON encoding: a max-size safe direct address, the
  ;; longest closed-set reason, and both fixed-width SHA-256 route manifests.
  ;; Safe handles and every other field are ASCII, so JSON escaping adds no
  ;; value-dependent expansion.
  (utf8-bytes
   (json/generate-string
    (sorted-map
     "expectedManifest" (apply str (repeat manifest-sha256-bytes "a"))
     "observedManifest" (apply str (repeat manifest-sha256-bytes "b"))
     "reason" (apply max-key utf8-bytes rejection-reasons)
     "recipient" (apply str (repeat max-rejection-recipient-bytes "r"))))))

(defn bare-handle [handle]
  (-> (str handle)
      (str/replace-first #"^@agent:" "")
      (str/replace-first #"^@session:" "")))

(defn online-handles
  "Finite session audience at one coordinator observation. Liveness uses the
   same unexpired renewable-lease rule as the presence roster."
  [port now]
  (let [rows (:ok (coord/send-op
                   port
                   {:op :query
                    :query {:find "lease"
                            :rules [{:head {:rel "lease"
                                            :args [{:var "e"} {:var "v"}]}
                                     :body [{:rel "triple"
                                             :args [{:var "e"} "lease" {:var "v"}]}]}]}}))]
    (into (sorted-set)
          (keep (fn [[entity value]]
                  (let [entity (str entity)
                        lease (coord/decode-lease value)]
                    (when (and (str/starts-with? entity lease-session-prefix)
                               lease
                               (> (:exp lease) now))
                      (subs entity (count lease-session-prefix))))))
          (or rows []))))

(defn snapshot-broadcast!
  "Persist a finite audience before the wildcard `to` fact, excluding the sender. The caller
   must publish `to` last so subscribers cannot observe a partial snapshot."
  [port message from]
  (let [sender (bare-handle from)
        recipients (disj (online-handles port (System/currentTimeMillis)) sender)]
    ;; Literal predicate names keep the executable writer visible to North's
    ;; static predicate-registry parity audit.
    (when (:reject (coord/append! port message "broadcast_audience_version" audience-version))
      (throw (ex-info "broadcast audience version write rejected"
                      {:type :broadcast-audience-write-rejected :message message})))
    (doseq [recipient recipients]
      (when (:reject (coord/append! port message "broadcast_to" recipient))
        (throw (ex-info "broadcast audience member write rejected"
                        {:type :broadcast-audience-write-rejected
                         :message message :recipient recipient}))))
    ;; Read-back is the commit barrier before the caller publishes `to="*"`.
    ;; A crash or rejection before this point leaves an inert, unaddressed draft.
    (let [observed-version (coord/resolved port message audience-version-predicate)
          observed-recipients (set (coord/many port message audience-predicate))]
      (when-not (and (= audience-version observed-version)
                     (= (set recipients) observed-recipients))
        (throw (ex-info "broadcast audience read-back mismatch"
                        {:type :broadcast-audience-readback-mismatch
                         :message message
                         :expected-version audience-version
                         :observed-version observed-version
                         :expected-recipients (set recipients)
                         :observed-recipients observed-recipients}))))
    recipients))

(defn audience [port message]
  (set (coord/many port message audience-predicate)))

(defn- sha256 [value]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        (.getBytes (str value) "UTF-8"))]
    (apply str (map #(format "%02x" (bit-and (int %) 0xff)) digest))))

(defn delivery-claim-resource [message recipient]
  (str "message-delivery:"
       (sha256 (str message "\u0000" (bare-handle recipient)))))

(defn acknowledged? [port message recipient]
  (contains? (set (coord/many port message "acked_by"))
             (bare-handle recipient)))

(defn rejected? [port message recipient]
  (contains? (set (coord/many port message rejected-by-predicate))
             (bare-handle recipient)))

(defn release-delivery-claim! [port {:keys [resource holder epoch]}]
  ;; Ack is already durable when normal completion releases. A transient release
  ;; failure must not turn a successful PostToolUse delivery into a hook failure;
  ;; the lease expires and can then be reclaimed.
  (try
    (coord/send-op port {:op :release-lease
                         :res resource :holder holder :epoch epoch})
    (catch Exception _ nil)))

(defn claim-delivery!
  "Atomically elect one live consumer for MESSAGE/RECIPIENT. A short coordinator
   lease closes the listener-vs-hook query/ack race. It is released after ack;
   if the winner dies first, expiry restores at-least-once delivery. Therefore
   concurrent healthy consumers print once, while a crash after print but before
   ack may still replay—the honest non-transactional-output boundary."
  ([port message recipient]
   (claim-delivery! port message recipient delivery-claim-ttl-ms))
  ([port message recipient ttl-ms]
   (when-not (and (integer? ttl-ms)
                  (pos? ttl-ms)
                  (<= ttl-ms delivery-claim-ttl-ms))
     (throw (ex-info "delivery claim TTL is outside the supported bound"
                     {:type :invalid-delivery-claim-ttl
                      :ttl-ms ttl-ms
                      :max-ttl-ms delivery-claim-ttl-ms})))
   (let [recipient (bare-handle recipient)]
     (when-not (or (acknowledged? port message recipient)
                   (rejected? port message recipient))
       (let [resource (delivery-claim-resource message recipient)
             holder (str "message-consumer:" recipient ":" (java.util.UUID/randomUUID))
             result (coord/send-op
                     port
                     {:op :acquire-lease :res resource :holder holder
                      :ttl-ms ttl-ms})]
         (when (:ok result)
           (let [claim {:resource resource :holder holder :epoch (:epoch result)}]
             ;; A manual ack may have landed between the initial read and acquire.
             (if (or (acknowledged? port message recipient)
                     (rejected? port message recipient))
               (do (release-delivery-claim! port claim) nil)
               claim))))))))

(defn complete-delivery!
  "Commit the durable ack after output has been flushed, then release CLAIM."
  [port message recipient claim]
  (try
    (let [recipient (bare-handle recipient)
          result (coord/append! port message "acked_by" recipient)]
      (when (:reject result)
        (throw (ex-info "message acknowledgement rejected"
                        {:type :message-ack-rejected
                         :message message :recipient recipient})))
      ;; Timestamp is diagnostic; acked_by is the durable delivery marker.
      (try (coord/put! port message "acked_at" (str (java.time.Instant/now)))
           (catch Exception _ nil))
      (when-not (acknowledged? port message recipient)
        (throw (ex-info "message acknowledgement read-back mismatch"
                        {:type :message-ack-readback-mismatch
                         :message message :recipient recipient})))
      true)
    (finally
      (release-delivery-claim! port claim))))

(defn reject-delivery!
  "Terminally settle one permanently impossible recipient delivery without
   claiming successful output. Evidence lands first; delivery_rejected_by is
   the durable settlement marker that removes it from pending replay."
  [port message recipient claim
   {:keys [reason expected-manifest observed-manifest]}]
  (try
    (let [recipient (bare-handle recipient)]
      (when-not (and (<= (utf8-bytes recipient)
                         max-rejection-recipient-bytes)
                     (boolean
                      (re-matches #"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
                                  recipient)))
        (throw (ex-info "message rejection recipient is malformed"
                        {:type :invalid-message-rejection})))
      (when-not (contains? rejection-reasons reason)
        (throw (ex-info "unsupported message rejection reason"
                        {:type :invalid-message-rejection :reason reason})))
      (doseq [[label value] [["expected manifest" expected-manifest]
                             ["observed manifest" observed-manifest]]
              :when value]
        (when-not (and (string? value)
                       (re-matches #"^[0-9a-f]{64}$" value))
          (throw (ex-info (str label " is malformed")
                          {:type :invalid-message-rejection
                           :field label}))))
      (let [evidence
            (json/generate-string
             (cond-> (sorted-map
                      "reason" reason
                      "recipient" recipient)
               expected-manifest
               (assoc "expectedManifest" expected-manifest)
               observed-manifest
               (assoc "observedManifest" observed-manifest)))]
        (when (> (utf8-bytes evidence) max-rejection-evidence-bytes)
          (throw (ex-info "message rejection evidence exceeds its byte bound"
                          {:type :invalid-message-rejection})))
        (let [evidence-result
              (coord/append! port message rejection-predicate evidence)]
          (when (:reject evidence-result)
            (throw (ex-info "message rejection evidence was rejected"
                            {:type :message-rejection-write-rejected
                             :message message :recipient recipient}))))
        (let [settlement-result
              (coord/append! port message rejected-by-predicate recipient)]
          (when (:reject settlement-result)
            (throw (ex-info "message rejection settlement was rejected"
                            {:type :message-rejection-write-rejected
                             :message message :recipient recipient}))))
        (when-not (and (rejected? port message recipient)
                       (contains? (set (coord/many port message
                                                  rejection-predicate))
                                  evidence))
          (throw (ex-info "message rejection read-back mismatch"
                          {:type :message-rejection-readback-mismatch
                           :message message :recipient recipient})))
        true))
    (finally
      (release-delivery-claim! port claim))))

(defn- safe-direct-address? [address]
  (and (string? address)
       (<= (utf8-bytes address) max-direct-address-bytes)
       (boolean
        (re-matches #"^[A-Za-z0-9][A-Za-z0-9._:-]*$" address))))

(defn bounded-direct-addresses
  "Validate and deduplicate the finite direct audience without first
   materializing an attacker-sized role collection."
  [recipient direct-addresses]
  (let [recipient (bare-handle recipient)]
    (when-not (safe-direct-address? recipient)
      (throw (ex-info "message recipient is malformed"
                      {:type :invalid-message-recipient})))
    (loop [remaining (seq direct-addresses)
           addresses #{recipient}
           scanned 0]
      (if (nil? remaining)
        (vec (sort addresses))
        (let [address (first remaining)]
          (when (>= scanned max-direct-addresses)
            (throw (ex-info "direct message address input exceeds its bound"
                            {:type :direct-address-limit-exceeded
                             :max max-direct-addresses})))
          (when-not (safe-direct-address? address)
            (throw (ex-info "direct message address is malformed"
                            {:type :invalid-direct-address
                             :address address})))
          (let [next-addresses (conj addresses address)]
            (when (> (count next-addresses) max-direct-addresses)
              (throw (ex-info "direct message address set exceeds its bound"
                              {:type :direct-address-limit-exceeded
                               :max max-direct-addresses})))
            (recur (next remaining) next-addresses (inc scanned))))))))

(defn pending-query
  "One stratified program for direct + broadcast candidates minus durable ack
   and rejection settlement. Dynamic direct-address rules are strictly bounded
   before this data structure exists."
  [recipient direct-addresses]
  (let [recipient (bare-handle recipient)
        addresses (bounded-direct-addresses recipient direct-addresses)
        direct-rules
        (mapv
         (fn [address]
           {:head {:rel "message_candidate" :args [{:var "e"}]}
            :body [{:rel "fact"
                    :args [{:var "e"} "to" address]}]})
         addresses)
        base-rules
        (into
         direct-rules
         [{:head {:rel "message_candidate" :args [{:var "e"}]}
           :body [{:rel "fact"
                   :args [{:var "e"} "broadcast_to" recipient]}
                  {:rel "fact"
                   :args [{:var "e"} "to" broadcast-address]}]}
          {:head {:rel "message_acknowledged" :args [{:var "e"}]}
           :body [{:rel "fact"
                   :args [{:var "e"} "acked_by" recipient]}]}
          {:head {:rel "message_rejected" :args [{:var "e"}]}
           :body [{:rel "fact"
                   :args [{:var "e"} rejected-by-predicate recipient]}]}])]
    {:find "pending_message"
     :strata
     [base-rules
      [{:head {:rel "pending_message" :args [{:var "e"}]}
        :body [{:rel "message_candidate" :args [{:var "e"}]}
               {:rel "message_acknowledged"
                :args [{:var "e"}] :neg true}
               {:rel "message_rejected"
                :args [{:var "e"}] :neg true}]}]]}))

(defn pending-steer-query
  "The pending relation restricted to messages admitted by the managed steer
   producer. The immutable route-manifest fact is the producer's durable type
   marker; filtering on it avoids terminal teardown being blocked by ordinary
   inbox mail."
  [recipient direct-addresses]
  (update-in
   (pending-query recipient direct-addresses)
   [:strata 1 0 :body]
   conj
   {:rel "fact"
    :args [{:var "e"} steer-manifest-predicate {:var "manifest"}]}))

(defn pending-message-page
  "Read one bounded deterministic pending page. AFTER is a Fram cursor for
   stable read-only consumers; delivery replay intentionally restarts at nil
   after settling each page."
  ([port recipient direct-addresses]
   (pending-message-page
    port recipient direct-addresses pending-page-limit nil))
  ([port recipient direct-addresses limit after]
   (let [response
         (coord/query-page
          port (pending-query recipient direct-addresses) limit after)]
     (when (:error response)
       (throw (ex-info "pending message page query failed"
                       {:type :pending-message-page-failed
                        :error (:error response)})))
     (when-not (and (<= (count (:ok response)) limit)
                    (every? #(and (vector? %)
                                  (= 1 (count %))
                                  (string? (first %)))
                            (:ok response)))
       (throw (ex-info "pending message page has malformed rows"
                       {:type :malformed-pending-message-page})))
     (assoc response :messages (mapv first (:ok response))))))

(defn pending-steer-page
  "Read one bounded deterministic page of unsettled managed steer messages."
  ([port recipient direct-addresses]
   (pending-steer-page
    port recipient direct-addresses pending-page-limit nil))
  ([port recipient direct-addresses limit after]
   (let [response
         (coord/query-page
          port (pending-steer-query recipient direct-addresses) limit after)]
     (when (:error response)
       (throw (ex-info "pending steer page query failed"
                       {:type :pending-steer-page-failed
                        :error (:error response)})))
     (when-not (and (<= (count (:ok response)) limit)
                    (every? #(and (vector? %)
                                  (= 1 (count %))
                                  (string? (first %)))
                            (:ok response)))
       (throw (ex-info "pending steer page has malformed rows"
                       {:type :malformed-pending-steer-page})))
     (assoc response :messages (mapv first (:ok response))))))

(defn- recipient-keyed-ids
  "Message ids from ONE positive-triple rule, evaluated by the coordinator's warm
   INCREMENTAL index engine (:op :query, the `simple-query?` fast path) rather than
   the per-version scan projection. The index buckets recipient-keyed literals
   (by-pr [pred obj]) directly, so cost is O(matching messages) and — unlike the
   scan projection, which the coordinator rebuilds O(corpus) on every version bump —
   it survives swarm write-churn. A single stratified/negated program would fall
   back to that scan projection and time out at corpus scale, so the pending set is
   assembled from these simple lookups and one client-side set difference instead."
  [port body]
  (let [response
        (coord/indexed-query
         port
         {:find "pending_candidate"
          :rules [{:head {:rel "pending_candidate" :args [{:var "e"}]}
                   :body body}]}
         coord/query-page-row-limit)]
    (into #{} (map first) (:ok response))))

(defn pending-message-ids
  "All pending ids for human/read-only callers (the `msg inbox` view). Same set as
   `pending-query`: direct + broadcast-audience candidates, minus durable ack and
   rejection settlement — but computed from recipient-keyed index lookups so it
   returns in O(recipient's mail), never the whole-corpus scan that stratified
   negation forces. Live replay uses pending-message-page directly, not this vector."
  [port recipient direct-addresses]
  (let [recipient (bare-handle recipient)
        addresses (bounded-direct-addresses recipient direct-addresses)
        direct (reduce
                (fn [acc address]
                  (into acc (recipient-keyed-ids
                             port [{:rel "triple" :args [{:var "e"} "to" address]}])))
                #{} addresses)
        broadcast (recipient-keyed-ids
                   port [{:rel "triple" :args [{:var "e"} audience-predicate recipient]}
                         {:rel "triple" :args [{:var "e"} "to" broadcast-address]}])
        acknowledged (recipient-keyed-ids
                      port [{:rel "triple" :args [{:var "e"} "acked_by" recipient]}])
        rejected (recipient-keyed-ids
                  port [{:rel "triple" :args [{:var "e"} rejected-by-predicate recipient]}])]
    (vec (sort (set/difference (set/union direct broadcast)
                               (set/union acknowledged rejected))))))

(defn deliverable?
  "Whether RECIPIENT may consume MESSAGE addressed TO. DIRECT-ADDRESSES contains
   the recipient's own handle plus any roles it currently holds. Broadcasts
   deliberately consult only the snapshotted concrete recipient handle."
  [port message to recipient direct-addresses]
  (if (= broadcast-address to)
    (contains? (audience port message) (bare-handle recipient))
    (contains? (set direct-addresses) to)))
