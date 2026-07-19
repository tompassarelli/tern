import type { DeliveryAssessment, DeliveryProof } from "./delivery-verification";

export type DeliveryOutcome = "unverified" | "reported" | "verified" | "blocked";

export interface ExecutionTerminal {
  /** Did the adapter/process reach a terminal state, and which one? */
  processOutcome: string;
  /** Was the requested delivery established independently of model prose? */
  deliveryOutcome: DeliveryOutcome;
  /** Stable machine reason; never copied from provider prose. */
  deliveryReason: string;
  /** Self-contained fact snapshot; required for reported. `verified` is legacy/reserved. */
  deliveryProof?: DeliveryProof;
}

const BLOCKED_REASON: Record<string, string> = {
  blocked_preflight: "execution_preflight_blocked",
  blocked_spend_guard: "spend_guard_budget_incomplete",
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
export function classifyExecutionTerminal(
  processOutcome: string,
  delivery?: DeliveryAssessment,
): ExecutionTerminal {
  if (processOutcome === "ran") {
    if (delivery?.deliveryOutcome === "reported") {
      return {
        processOutcome,
        deliveryOutcome: delivery.deliveryOutcome,
        deliveryReason: delivery.deliveryReason,
        deliveryProof: delivery.proof,
      };
    }
    return {
      processOutcome,
      deliveryOutcome: delivery?.deliveryOutcome ?? "unverified",
      deliveryReason: delivery?.deliveryReason
        ?? "provider_terminal_success_without_external_verification",
    };
  }
  return {
    processOutcome,
    deliveryOutcome: "blocked",
    deliveryReason: BLOCKED_REASON[processOutcome] ?? "execution_did_not_reach_success_terminal",
  };
}
