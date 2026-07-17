export type DeliveryOutcome = "unverified" | "blocked";

export interface ExecutionTerminal {
  /** Did the adapter/process reach a terminal state, and which one? */
  processOutcome: string;
  /** Was the requested delivery established independently of model prose? */
  deliveryOutcome: DeliveryOutcome;
  /** Stable machine reason; never copied from provider prose. */
  deliveryReason: string;
}

const BLOCKED_REASON: Record<string, string> = {
  blocked_preflight: "execution_preflight_blocked",
  provider_error: "provider_terminal_error",
  died: "provider_process_died",
  stalled: "provider_process_stalled",
  max_turns: "provider_turn_cap",
  capped: "provider_cap",
  resource_envelope_exceeded: "resource_envelope_exceeded",
  provider_escalation_unsupported: "provider_escalation_unsupported",
  max_tier: "escalation_ladder_exhausted",
};

/**
 * A successful provider terminal proves only that the process ran. Delivery is
 * intentionally unverified until an external bar/evidence seam proves it.
 */
export function classifyExecutionTerminal(processOutcome: string): ExecutionTerminal {
  if (processOutcome === "ran") {
    return {
      processOutcome,
      deliveryOutcome: "unverified",
      deliveryReason: "provider_terminal_success_without_external_verification",
    };
  }
  return {
    processOutcome,
    deliveryOutcome: "blocked",
    deliveryReason: BLOCKED_REASON[processOutcome] ?? "execution_did_not_reach_success_terminal",
  };
}
