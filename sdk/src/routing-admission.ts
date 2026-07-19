import { applyGafferStaffing } from "./gaffer-staffing";
import {
  ROUTING_REQUEST_FIELDS, parseCompleteRoutingRequest, routingMetadataFromEnv,
  type RoutingDraft, type RoutingRequest,
} from "./routing-metadata";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Strict managed-wire admission: prove both the complete structural request
 * and Gaffer's stock/bespoke catalog semantics without allowing this boundary
 * to hydrate or rewrite any caller-owned axis.
 */
export function admitRoutingRequest(
  value: RoutingDraft,
  surface = "managed North agent",
): RoutingRequest {
  const request = parseCompleteRoutingRequest(value, surface);
  const admitted = applyGafferStaffing(request);
  const changed = ROUTING_REQUEST_FIELDS.filter((field) =>
    JSON.stringify(admitted[field]) !== JSON.stringify(request[field]));
  if (changed.length) {
    throw new Error(
      `${surface} must carry a canonical complete Gaffer request; composer changed: `
      + changed.join(", "),
    );
  }
  return deepFreeze(JSON.parse(JSON.stringify(admitted)) as RoutingRequest);
}

export function routingRequestFromEnv(surface = "managed North environment"): RoutingRequest {
  const draft = routingMetadataFromEnv();
  const compatibilityEffort = process.env.AGENT_EFFORT;
  if (compatibilityEffort !== undefined
      && draft.reasoning !== undefined
      && compatibilityEffort !== draft.reasoning) {
    throw new Error(
      `${surface} AGENT_EFFORT compatibility alias must equal AGENT_REASONING `
      + `(${JSON.stringify(compatibilityEffort)} != ${JSON.stringify(draft.reasoning)})`,
    );
  }
  return admitRoutingRequest(draft, surface);
}
