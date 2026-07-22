#!/usr/bin/env bb
;; Internal, content-free physical worktree allocation writer. Registration is
;; logically atomic: immutable allocation facts are written on a fresh nonce
;; subject and `kind=worktree_allocation` is committed last against the exact
;; coordinator version. Readers only treat kind-marked subjects as allocations.
(require '[cheshire.core :as json]
         '[clojure.java.io :as io]
         '[clojure.set :as set]
         '[clojure.string :as str])

(load-file (str (.getParent (io/file *file*)) "/coord.clj"))

(def allocation-version "north:worktree-allocation:v1")
(def registration-predicates
  ["worktree_allocation_version" "worktree_repository_identity"
   "worktree_git_common_dir" "worktree_source_root" "worktree_repository_layout"
   "worktree" "worktree_durable_ref" "worktree_base_oid" "worktree_head_oid"
   "worktree_allocation_run" "worktree_allocation_agent"
   "worktree_allocation_thread" "worktree_allocation_concern"
   "worktree_allocation_nonce" "worktree_allocation_lease"
   "worktree_provider_authority_profile" "worktree_allocation_event"])
(def marker-predicate "worktree_allocation_manifest_sha256")
(def all-predicates (set (concat registration-predicates [marker-predicate "kind"])))
(def single-registration-predicates
  (set (remove #{"worktree_provider_authority_profile" "worktree_allocation_event"}
               registration-predicates)))
(def event-types
  #{"registered" "provisioned" "authority-profiled" "run-rotated"
    "provision-failed" "rolled-back" "released" "quarantined"})
(def resource-states #{"planned" "active" "absent" "quarantined"})
(def recovery-actions #{"none" "inspect-and-salvage" "remove-if-clean"})
(def safe-token #"^@?[A-Za-z0-9][A-Za-z0-9._:@/()=-]{0,1023}$")
(def authority-token #"^[A-Za-z0-9][A-Za-z0-9._:/=-]{0,127}$")
(def oid-pattern #"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
(def nonce-pattern #"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
(def repository-identity-pattern #"^north:git-common-dir-sha256:v1:[0-9a-f]{64}$")
(def durable-ref-pattern #"^refs/heads/[A-Za-z0-9][A-Za-z0-9._:/=-]{0,511}$")

(defn fail! [message data]
  (throw (ex-info message data)))

(defn checked! [result operation]
  (when (:reject result)
    (fail! "coordinator rejected worktree allocation write"
           {:operation operation :reject (:reject result) :version (:version result)}))
  result)

(defn canonicalize [value]
  (cond
    (map? value) (into (sorted-map) (map (fn [[k v]] [(str k) (canonicalize v)])) value)
    (vector? value) (mapv canonicalize value)
    (sequential? value) (mapv canonicalize value)
    :else value))

(defn canonical-json [value]
  (json/generate-string (canonicalize value)))

(defn sha256 [value]
  (let [digest (.digest (java.security.MessageDigest/getInstance "SHA-256")
                        (.getBytes (str value) java.nio.charset.StandardCharsets/UTF_8))]
    (format "%064x" (java.math.BigInteger. 1 digest))))

(defn keys-only! [value allowed label]
  (when-not (map? value) (fail! (str label " must be an object") {}))
  (let [unknown (set/difference (set (keys value)) (set allowed))]
    (when (seq unknown)
      (fail! (str label " carries unsupported fields") {:fields (sort unknown)}))))

(defn nonblank! [value label]
  (when-not (and (string? value) (= value (str/trim value))
                 (not (str/blank? value)) (<= (count value) 4096)
                 (not (str/includes? value "\u0000")))
    (fail! (str label " must be a bounded nonblank string") {}))
  value)

(defn absolute-path! [value label]
  (nonblank! value label)
  (when-not (.isAbsolute (io/file value))
    (fail! (str label " must be absolute") {:value value}))
  value)

(defn timestamp! [value label]
  (nonblank! value label)
  (try (java.time.Instant/parse value)
       (catch Exception _ (fail! (str label " must be a strict UTC instant") {})))
  value)

(defn oid! [value label]
  (when-not (and (string? value) (re-matches oid-pattern value))
    (fail! (str label " must be a full lowercase Git object id") {}))
  value)

(defn entity! [value prefix label]
  (nonblank! value label)
  (when-not (and (str/starts-with? value prefix) (re-matches safe-token value))
    (fail! (str label " is not a safe exact entity") {:value value}))
  value)

(defn ownership! [value prefix fallback label]
  (nonblank! value label)
  (when-not (or (= fallback value)
                (and (str/starts-with? value prefix) (re-matches safe-token value)))
    (fail! (str label " is neither exact nor explicitly unattributed") {:value value}))
  value)

(defn provider-profile! [profile]
  (keys-only! profile
              ["version" "phase" "provider" "target" "authMode" "profile"]
              "provider authority profile")
  (when-not (= 1 (get profile "version"))
    (fail! "provider authority profile version is unsupported" {}))
  (when-not (#{"requested" "resolved"} (get profile "phase"))
    (fail! "provider authority profile phase is invalid" {}))
  (doseq [field ["provider" "target" "authMode" "profile"]]
    (nonblank! (get profile field) (str "provider authority profile " field)))
  (doseq [field ["target" "profile"]]
    (when-not (re-matches authority-token (get profile field))
      (fail! "provider authority profile identifiers must be content-free tokens"
             {:field field})))
  (when-not (#{"auto" "anthropic" "openai"} (get profile "provider"))
    (fail! "provider authority profile provider is invalid" {}))
  (when-not (#{"unresolved" "ambient" "isolated"} (get profile "authMode"))
    (fail! "provider authority profile authMode is invalid" {}))
  profile)

(defn lease! [lease]
  (keys-only! lease ["version" "holder" "issuedAt" "expiresAt" "enforcement"]
              "allocation lease")
  (when-not (= 1 (get lease "version")) (fail! "allocation lease version is unsupported" {}))
  (entity! (get lease "holder") "@agent:" "allocation lease holder")
  (let [issued (timestamp! (get lease "issuedAt") "allocation lease issuedAt")
        expires (timestamp! (get lease "expiresAt") "allocation lease expiresAt")]
    (when-not (.isAfter (java.time.Instant/parse expires) (java.time.Instant/parse issued))
      (fail! "allocation lease must expire after issuance" {})))
  (when-not (= "phase-1-record-only" (get lease "enforcement"))
    (fail! "allocation lease enforcement must disclose phase-1 record-only semantics" {}))
  lease)

(defn error! [error]
  (keys-only! error ["code" "phase"] "allocation error")
  (doseq [field ["code" "phase"]]
    (let [value (get error field)]
      (when-not (and (string? value) (re-matches #"^[a-z][a-z0-9_]{0,63}$" value))
        (fail! "allocation error fields must be stable machine codes" {:field field}))))
  error)

(defn recovery! [recovery]
  (keys-only! recovery ["action" "resource" "durableRef"] "allocation recovery")
  (when-not (recovery-actions (get recovery "action"))
    (fail! "allocation recovery action is invalid" {}))
  (absolute-path! (get recovery "resource") "allocation recovery resource")
  (nonblank! (get recovery "durableRef") "allocation recovery durableRef")
  recovery)

(defn event! [event]
  (keys-only! event
              ["version" "id" "type" "observedAt" "resourceState" "headOid"
               "run" "providerAuthorityProfile" "error" "recovery"]
              "allocation event")
  (when-not (= 1 (get event "version")) (fail! "allocation event version is unsupported" {}))
  (when-not (and (string? (get event "id")) (re-matches nonce-pattern (get event "id")))
    (fail! "allocation event id must be UUIDv4" {}))
  (when-not (event-types (get event "type")) (fail! "allocation event type is invalid" {}))
  (timestamp! (get event "observedAt") "allocation event observedAt")
  (when-not (resource-states (get event "resourceState"))
    (fail! "allocation event resourceState is invalid" {}))
  (when-let [head (get event "headOid")] (oid! head "allocation event headOid"))
  (when-let [run (get event "run")] (entity! run "@run:" "allocation event run"))
  (when-let [profile (get event "providerAuthorityProfile")] (provider-profile! profile))
  (when-let [error (get event "error")] (error! error))
  (when-let [recovery (get event "recovery")] (recovery! recovery))
  (when (= "quarantined" (get event "resourceState"))
    (when-not (and (get event "error") (get event "recovery"))
      (fail! "quarantine event requires exact error and recovery records" {})))
  (when (#{"provision-failed" "quarantined"} (get event "type"))
    (when-not (and (get event "error") (get event "recovery"))
      (fail! "failure lifecycle events require exact error and recovery records" {})))
  (when (and (= "quarantined" (get event "type"))
             (not= "quarantined" (get event "resourceState")))
    (fail! "quarantine lifecycle event must publish quarantined resource state" {}))
  event)

(defn allocation-subject! [subject nonce]
  (let [canonical (str "@worktree-allocation:" nonce)]
    (when-not (= canonical subject)
      (fail! "allocation subject must be derived from its nonce"
             {:expected canonical :actual subject})))
  subject)

(defn parse-registration [raw]
  (let [value (try (json/parse-string raw)
                   (catch Exception error
                     (fail! "invalid worktree allocation JSON" {:cause (.getMessage error)})))]
    (keys-only! value
                ["version" "subject" "repositoryIdentity" "gitCommonDir" "sourceRoot"
                 "repositoryLayout" "worktree" "durableRef" "baseOid" "headOid"
                 "run" "agent" "thread" "concern" "allocationNonce" "lease"
                 "providerAuthorityProfile" "event"]
                "worktree allocation registration")
    (when-not (= allocation-version (get value "version"))
      (fail! "worktree allocation version is unsupported" {}))
    (let [nonce (get value "allocationNonce")]
      (when-not (and (string? nonce) (re-matches nonce-pattern nonce))
        (fail! "allocation nonce must be UUIDv4" {}))
      (allocation-subject! (get value "subject") nonce))
    (when-not (and (string? (get value "repositoryIdentity"))
                   (re-matches repository-identity-pattern
                               (get value "repositoryIdentity")))
      (fail! "repository identity must be an exact content-free git common-dir digest" {}))
    (when-not (and (string? (get value "durableRef"))
                   (re-matches durable-ref-pattern (get value "durableRef")))
      (fail! "durable ref must be an exact local refs/heads name" {}))
    (doseq [[field label] [["gitCommonDir" "git common-dir"]
                           ["sourceRoot" "source root"] ["worktree" "worktree"]]]
      (absolute-path! (get value field) label))
    (when-not (#{"standalone" "linked"} (get value "repositoryLayout"))
      (fail! "repository layout must be standalone or linked" {}))
    (oid! (get value "baseOid") "base OID")
    (oid! (get value "headOid") "head OID")
    (entity! (get value "run") "@run:" "allocation run")
    (entity! (get value "agent") "@agent:" "allocation agent")
    (ownership! (get value "thread") "@" "@thread:ad-hoc" "allocation thread")
    (ownership! (get value "concern") "@concern-" "@concern:unattributed" "allocation concern")
    (lease! (get value "lease"))
    (provider-profile! (get value "providerAuthorityProfile"))
    (let [event (event! (get value "event"))]
      (when-not (and (= "registered" (get event "type"))
                     (= "planned" (get event "resourceState")))
        (fail! "registration must begin with a planned registered event" {})))
    value))

(defn registration-facts [registration]
  (sorted-map
   "worktree_allocation_version" (get registration "version")
   "worktree_repository_identity" (get registration "repositoryIdentity")
   "worktree_git_common_dir" (get registration "gitCommonDir")
   "worktree_source_root" (get registration "sourceRoot")
   "worktree_repository_layout" (get registration "repositoryLayout")
   "worktree" (get registration "worktree")
   "worktree_durable_ref" (get registration "durableRef")
   "worktree_base_oid" (get registration "baseOid")
   "worktree_head_oid" (get registration "headOid")
   "worktree_allocation_run" (get registration "run")
   "worktree_allocation_agent" (get registration "agent")
   "worktree_allocation_thread" (get registration "thread")
   "worktree_allocation_concern" (get registration "concern")
   "worktree_allocation_nonce" (get registration "allocationNonce")
   "worktree_allocation_lease" (canonical-json (get registration "lease"))
   "worktree_provider_authority_profile"
   (canonical-json (get registration "providerAuthorityProfile"))
   "worktree_allocation_event" (canonical-json (get registration "event"))))

(defn reservation-subject [registration]
  (str "@worktree-reservation:"
       (sha256 (str allocation-version "\u0000"
                    (get registration "repositoryIdentity") "\u0000"
                    (get registration "worktree") "\u0000"
                    (get registration "durableRef")))))

(defn reservation-facts [registration]
  (sorted-map
   "kind" "worktree_reservation"
   "worktree_repository_identity" (get registration "repositoryIdentity")
   "worktree" (get registration "worktree")
   "worktree_durable_ref" (get registration "durableRef")
   "worktree_allocation_nonce" (get registration "allocationNonce")
   ;; The canonical lease contains the exact holder and remains content-free.
   "worktree_allocation_lease" (canonical-json (get registration "lease"))))

(defn facts-of [port subject]
  (into {} (map (fn [predicate] [predicate (set (north.coord/many port subject predicate))]))
        all-predicates))

(defn committed-registration? [snapshot desired marker]
  (and (= #{"worktree_allocation"} (get snapshot "kind"))
       (= #{marker} (get snapshot marker-predicate))
       (every? (fn [[predicate value]]
                 (if (single-registration-predicates predicate)
                   (= #{value} (get snapshot predicate))
                   (contains? (get snapshot predicate) value)))
               desired)))

(defn clear-desired! [port subject desired marker]
  (doseq [[predicate value] (concat desired [[marker-predicate marker]
                                              ["kind" "worktree_allocation"]])]
    (checked! (north.coord/retract! port subject predicate value)
              [:rollback subject predicate value])))

(defn clear-reservation! [port subject desired]
  ;; A losing concurrent claimant must never retract the winner's shared path/
  ;; ref facts. Only the nonce owner may clear its exact reservation prefix.
  (when (= #{(get desired "worktree_allocation_nonce")}
           (get (facts-of port subject) "worktree_allocation_nonce"))
    (doseq [[predicate value] desired]
      (checked! (north.coord/retract! port subject predicate value)
                [:reservation-rollback subject predicate value]))))

(defn acquire-reservation! [port registration]
  (let [subject (reservation-subject registration)
        desired (reservation-facts registration)
        nonce (get desired "worktree_allocation_nonce")
        before (facts-of port subject)]
    (cond
      (= desired (into (sorted-map)
                       (map (fn [[predicate values]] [predicate (first values)]))
                       (filter (fn [[predicate values]]
                                 (and (contains? (set (keys desired)) predicate)
                                      (= 1 (count values)))) before)))
      subject

      (some seq (vals before))
      (fail! "physical worktree identity is already reserved"
             {:reservation subject
              :owner (first (get before "worktree_allocation_nonce"))})

      :else
      (try
        (checked!
         (north.coord/assert-after-read!
          port subject "worktree_allocation_nonce" nonce
          (fn []
            (when (some seq (vals (facts-of port subject)))
              (fail! "physical worktree identity became reserved" {:reservation subject}))))
         [:reserve subject])
        (doseq [[predicate value] (dissoc desired "worktree_allocation_nonce")]
          (checked! (north.coord/append! port subject predicate value)
                    [:reserve subject predicate]))
        (when-not (every? (fn [[predicate value]]
                            (= #{value} (get (facts-of port subject) predicate)))
                          desired)
          (fail! "physical worktree reservation readback differs" {:reservation subject}))
        subject
        (catch Exception error
          (clear-reservation! port subject desired)
          (throw error))))))

(defn register! [port registration]
  (let [subject (get registration "subject")
        desired (registration-facts registration)
        marker (sha256 (apply str (map (fn [[p v]] (str p "\u0000" v "\n")) desired)))
        before (facts-of port subject)
        reservation (acquire-reservation! port registration)]
    (cond
      (committed-registration? before desired marker)
      {:ok true :subject subject :manifest marker :result "exact-replay"}

      (some seq (vals before))
      (fail! "allocation subject already carries a different or partial generation"
             {:subject subject})

      :else
      (try
        (doseq [[predicate value] desired]
          (checked! (north.coord/append! port subject predicate value)
                    [:register subject predicate]))
        (checked! (north.coord/append! port subject marker-predicate marker)
                  [:register subject marker-predicate])
        (checked!
         (north.coord/assert-after-read!
          port subject "kind" "worktree_allocation"
          (fn []
            (let [snapshot (facts-of port subject)]
              (when-not (and (= #{marker} (get snapshot marker-predicate))
                             (every? (fn [[predicate value]]
                                       (contains? (get snapshot predicate) value))
                                     desired))
                (fail! "allocation registration readback differs before commit" {})))))
         [:commit subject])
        (when-not (committed-registration? (facts-of port subject) desired marker)
          (fail! "allocation registration commit marker was not acknowledged" {}))
        {:ok true :subject subject :manifest marker :result "committed"}
        (catch Exception error
          (try
            (clear-desired! port subject desired marker)
            (when (some seq (vals (facts-of port subject)))
              (fail! "allocation registration rollback left a visible prefix" {}))
            (clear-reservation! port reservation (reservation-facts registration))
            (catch Exception rollback
              (throw (ex-info "allocation registration failed and rollback is indeterminate"
                              {:subject subject} rollback))))
          (throw error))))))

(defn committed-subject! [port subject]
  (when-not (and (string? subject)
                 (re-matches #"^@worktree-allocation:[0-9a-f-]{36}$" subject))
    (fail! "invalid worktree allocation subject" {:subject subject}))
  (let [snapshot (facts-of port subject)]
    (when-not (and (= #{"worktree_allocation"} (get snapshot "kind"))
                   (= 1 (count (get snapshot marker-predicate))))
      (fail! "allocation lifecycle event requires a committed registration"
             {:subject subject}))
    snapshot))

(defn append-event! [port subject event]
  (let [snapshot (committed-subject! port subject)
        validated (event! event)
        recovery (get validated "recovery")
        encoded (canonical-json validated)]
    (when (and recovery
               (not= #{(get recovery "resource")} (get snapshot "worktree")))
      (fail! "allocation recovery resource does not match the committed worktree" {}))
    (when (and recovery
               (not= #{(get recovery "durableRef")}
                     (get snapshot "worktree_durable_ref")))
      (fail! "allocation recovery ref does not match the committed durable ref" {}))
    (when-let [profile (get event "providerAuthorityProfile")]
      (checked! (north.coord/append! port subject "worktree_provider_authority_profile"
                                    (canonical-json profile))
                [:event-profile subject]))
    (checked! (north.coord/append! port subject "worktree_allocation_event" encoded)
              [:event subject])
    (when-not (contains? (set (north.coord/many port subject "worktree_allocation_event"))
                         encoded)
      (fail! "allocation lifecycle event was not acknowledged" {:subject subject}))
    {:ok true :subject subject :event (get event "id") :result "committed"}))

(let [[port-text operation subject raw] *command-line-args*
      port (try (parse-long (or port-text ""))
                (catch Exception _ (fail! "invalid coordinator port" {})))
      _ (when (and (#{"register" "event"} operation)
                   (not (and (integer? port) (<= 1 port 65535))))
          (fail! "invalid coordinator port" {}))
      result
      (case operation
        "register" (let [registration (parse-registration (or subject ""))]
                     (register! port registration))
        "event" (append-event! port subject
                               (try (json/parse-string (or raw ""))
                                    (catch Exception error
                                      (fail! "invalid allocation event JSON"
                                             {:cause (.getMessage error)}))))
        (fail! "usage: worktree-allocation-internal.clj <port> register <json> | <port> event <subject> <json>"
               {}))]
  (println (canonical-json result)))
