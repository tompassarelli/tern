import { getThreadFacts, type Fact, type NorthReadOptions } from "./north-client";

/**
 * Spend guard — build-order step 1: the classification tripwire.
 *
 * From this module on, any NON-SUBSCRIPTION (API-billed) provider target is
 * structurally inert unless a complete `@spend-budget:<target>` entity exists
 * for it. The guard ships BEFORE any API-billed provider exists, inverting the
 * risk order: an unguarded API target cannot route or admit by construction.
 *
 * Ledger reservation, settlement, the breaker, reconciliation, and the `north
 * spend` CLI are later build-order steps and deliberately NOT here. This file
 * only classifies billing and verifies that a budget entity is present and
 * well-formed; it never writes.
 */

/**
 * Providers billed through a subscription entitlement pool, never per-token API
 * credit. This is the authoritative allowlist — the ONLY inputs that classify as
 * `subscription`. Everything else is API-billed by construction.
 */
export const SUBSCRIPTION_PROVIDERS = ["anthropic", "openai"] as const;

export type ProviderBilling = "subscription" | "api-billed";

/**
 * Authoritative billing classification. Fail-closed by construction: a provider
 * is `subscription` only if it is on the explicit allowlist; ANY other id —
 * known, unknown, or malformed — is `api-billed` and therefore guarded. Unknown
 * means guarded, never unguarded.
 */
export function providerBilling(providerId: string): ProviderBilling {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(providerId)
    ? "subscription"
    : "api-billed";
}

/** Micro-USD integer predicates that must each be a single positive integer. */
const REQUIRED_MICROUSD_INT = [
  "budget_cap_microusd",
  "lane_envelope_default_microusd",
  "lane_envelope_max_microusd",
  "burn_limit_microusd_per_hour",
] as const;

/** Predicates that must be present with a non-empty value. */
const REQUIRED_PRESENT = [
  "budget_period",
  "layer1_confirmed",
] as const;

export interface SpendBudgetVerdict {
  ok: boolean;
  /** Machine-readable refusal reason; never provider prose. Absent when ok. */
  reason?: string;
}

/** Coordination-log entity id carrying a target's spend budget. */
export function spendBudgetEntityId(target: string): string {
  return `spend-budget:${target}`;
}

/**
 * A required config predicate must be single-valued. Missing OR ambiguous
 * (multiple conflicting values) both fail closed: a mission-critical budget
 * cannot be read from a contradictory ledger.
 */
function singleValue(facts: Fact[], predicate: string): string | undefined {
  const values = facts.filter((fact) => fact.predicate === predicate).map((fact) => fact.value);
  return values.length === 1 ? values[0] : undefined;
}

function positiveMicrousd(value: string | undefined): boolean {
  if (value === undefined || !/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

/**
 * Completeness check over an already-read fact set. Missing predicate, ambiguous
 * predicate, or malformed value ⇒ refuse. Pure and synchronous for direct unit
 * testing of the seam.
 */
export function assessSpendBudgetFacts(target: string, facts: Fact[]): SpendBudgetVerdict {
  const entity = spendBudgetEntityId(target);
  for (const predicate of REQUIRED_MICROUSD_INT) {
    const value = singleValue(facts, predicate);
    if (value === undefined)
      return { ok: false, reason: `${entity} missing or ambiguous ${predicate}` };
    if (!positiveMicrousd(value))
      return { ok: false, reason: `${entity} ${predicate} is not a positive micro-USD integer` };
  }
  for (const predicate of REQUIRED_PRESENT) {
    const value = singleValue(facts, predicate);
    if (value === undefined || !value.trim())
      return { ok: false, reason: `${entity} missing or ambiguous ${predicate}` };
  }
  return { ok: true };
}

/**
 * Read the budget entity through the idiomatic North fact-read path and assess
 * completeness. A ledger read failure (coordinator down, malformed response,
 * invalid entity id) refuses — an unreadable ledger is never headroom.
 */
export function checkSpendBudget(target: string, options: NorthReadOptions = {}): SpendBudgetVerdict {
  let facts: Fact[];
  try {
    facts = getThreadFacts(spendBudgetEntityId(target), options);
  } catch (error) {
    return {
      ok: false,
      reason: `${spendBudgetEntityId(target)} ledger read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return assessSpendBudgetFacts(target, facts);
}

/**
 * The seam verdict used by both enforcement points. Subscription targets are an
 * O(1) branch that NEVER touches the ledger — the hard never-slow-subscription
 * requirement. Only an API-billed target reads and verifies its budget entity.
 */
export function spendGuardVerdict(
  providerId: string,
  target: string,
  options: NorthReadOptions = {},
): SpendBudgetVerdict {
  if (providerBilling(providerId) === "subscription") return { ok: true };
  return checkSpendBudget(target, options);
}

/**
 * Routing-eligibility form of the guard: an API-billed target without a complete
 * budget is ineligible exactly like an exhausted target, so auto-route flows to
 * subscription siblings. Subscription targets are always eligible, O(1).
 */
export function spendGuardEligible(
  providerId: string,
  target: string,
  options: NorthReadOptions = {},
): boolean {
  return spendGuardVerdict(providerId, target, options).ok;
}
