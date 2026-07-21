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

/**
 * A provider "success" terminal whose result text is empty (0b) is a DEGENERATE
 * completion, not a delivery. Opus-high extended-thinking turns that exhaust the
 * output-token ceiling truncate before committing any final text (the final
 * assistant block is an unanswered tool_use or a terminal thinking block), yet
 * the SDK still yields subtype=success/result="". Recording that as process=ran
 * makes a zero-deliverable lane read as a clean completion (thread 019f8300).
 * This distinct outcome makes the empty terminal LOUD and non-clean.
 */
export const EMPTY_RESULT_OUTCOME = "ran_empty";

/** True when a provider success terminal carried no committed deliverable text. */
export function isEmptyResultTerminal(outcome: string, result: string): boolean {
  return outcome === "ran" && result.trim() === "";
}

const BLOCKED_REASON: Record<string, string> = {
  blocked_preflight: "execution_preflight_blocked",
  blocked_spend_guard: "spend_guard_budget_incomplete",
  ran_empty: "provider_terminal_empty_result",
  provider_error: "provider_terminal_error",
  died: "provider_process_died",
  stalled: "provider_process_stalled",
  max_turns: "provider_turn_cap",
  capped: "provider_cap",
  resource_envelope_exceeded: "resource_envelope_exceeded",
  provider_escalation_unsupported: "provider_escalation_unsupported",
  max_tier: "escalation_ladder_exhausted",
  orchestrator_children_incomplete: "orchestrator_children_live_at_terminal",
  child_reconciliation_unavailable: "orchestrator_child_reconciliation_unavailable",
  orchestrator_reduction_incomplete: "orchestrator_child_results_unreconciled",
  orchestrator_child_set_inconsistent: "orchestrator_child_relation_regressed",
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
