(ns north.managed-child-env
  "One process-boundary rule for every managed North child: routing and staffing
  come from the child request, never from ambient parent AGENT_* state.")

(def routing-keys
  ["AGENT_ID" "NORTH_AGENT_ID" "AGENT_IDENTITY_ROLE" "AGENT_ROLE" "AGENT_TASK_GRADE"
   "AGENT_DOMAIN_REQUIREMENTS" "AGENT_TOPOLOGY" "AGENT_TIER"
   "AGENT_REASONING" "AGENT_EFFORT" "AGENT_POSTURE" "AGENT_COMPOSITION"
   "AGENT_ROUTING_ASSESSMENT" "NORTH_ROUTING_PIN_EVIDENCE"
   "AGENT_MODEL" "AGENT_TARGET" "AGENT_PROVIDER" "AGENT_COORDINATOR"
   "NORTH_DISPATCH_DRIVER_PRECLAIMED"
   ;; One-shot adapter/runtime parity witness; every child gets its own value.
   "NORTH_STRUGGLE_POLICY_EXPECTED"
   ;; Adapter-only bootstrap input. The CLI re-adds it explicitly for a
   ;; proof-bearing delegate; ambient parent state must never bind a raw spawn.
   "NORTH_DELEGATE_THREAD_ID"
   ;; Per-run proof authority belongs only to the exact child for which the
   ;; harness committed a reservation. A nested spawn receives a fresh explicit
   ;; context or none; it must never inherit its parent's capability.
   "NORTH_RUN_ID" "NORTH_THREAD_ID" "NORTH_RUN_CAPABILITY"])

(defn scrub
  ([] (scrub (into {} (System/getenv))))
  ([parent-env] (apply dissoc parent-env routing-keys)))

(defn child
  "Build a clean child environment, preserving coordinator attribution only
  through the explicit argument and applying request-owned overrides last."
  [parent-env coordinator overrides]
  (merge (scrub parent-env)
         (when coordinator {"AGENT_COORDINATOR" coordinator})
         overrides))
