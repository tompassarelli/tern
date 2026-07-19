import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessSpendBudgetFacts,
  checkSpendBudget,
  providerBilling,
  spendBudgetEntityId,
  spendGuardEligible,
  spendGuardVerdict,
} from "../src/spend-guard";
import {
  admitSpendGuard,
  ExecutionAdmissionError,
  SpendGuardError,
} from "../src/execution-admission";
import { ProviderRetrySafeError, type ProviderId, type RoutingTarget } from "../src/providers/types";
import { selectProviderFromAvailability } from "../src/provider-routing";
import type { Fact } from "../src/north-client";
import type { ProviderAvailability, ResourcePolicy } from "../src/providers/types";

const temporary: string[] = [];
const savedNorthBin = process.env.NORTH_BIN;
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  if (savedNorthBin === undefined) delete process.env.NORTH_BIN;
  else process.env.NORTH_BIN = savedNorthBin;
});

function fakeNorth(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "spend-guard-"));
  temporary.push(directory);
  const command = join(directory, "north");
  writeFileSync(command, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(command, 0o755);
  return command;
}

/** A fake `north` whose `json show` prints the given facts JSON for any subject. */
const northReturning = (json: string) => fakeNorth(`printf '%s' ${JSON.stringify(json)}`);
/** A fake `north` that fails every invocation (simulates a ledger read failure). */
const northFailing = () => fakeNorth(`exit 3`);

const COMPLETE_BUDGET: Fact[] = [
  { predicate: "kind", value: "spend-budget" },
  { predicate: "billing", value: "api" },
  { predicate: "budget_cap_microusd", value: "60000000" },
  { predicate: "budget_period", value: "month" },
  { predicate: "lane_envelope_default_microusd", value: "1500000" },
  { predicate: "lane_envelope_max_microusd", value: "8000000" },
  { predicate: "burn_limit_microusd_per_hour", value: "10000000" },
  { predicate: "layer1_confirmed", value: "prepaid, auto-topup off, 2026-07-19" },
];
const COMPLETE_JSON = JSON.stringify(COMPLETE_BUDGET);

const REQUIRED_PREDICATES = [
  "budget_cap_microusd",
  "budget_period",
  "lane_envelope_default_microusd",
  "lane_envelope_max_microusd",
  "burn_limit_microusd_per_hour",
  "layer1_confirmed",
];

// --- classification (fail-closed by construction) ---------------------------

test("subscription providers classify subscription; every other id is api-billed", () => {
  expect(providerBilling("anthropic")).toBe("subscription");
  expect(providerBilling("openai")).toBe("subscription");
  for (const id of ["openrouter", "google", "deepseek", "", "ANTHROPIC", "anthropic-proxy", "openai "])
    expect(providerBilling(id)).toBe("api-billed");
});

// --- budget-entity completeness (pure) --------------------------------------

test("a complete budget entity passes; any missing required predicate refuses", () => {
  expect(assessSpendBudgetFacts("glm", COMPLETE_BUDGET)).toEqual({ ok: true });
  for (const drop of REQUIRED_PREDICATES) {
    const verdict = assessSpendBudgetFacts("glm", COMPLETE_BUDGET.filter((fact) => fact.predicate !== drop));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain(drop);
  }
});

test("malformed micro-USD values and ambiguous predicates refuse", () => {
  const withCap = (value: string): Fact[] =>
    COMPLETE_BUDGET.map((fact) => (fact.predicate === "budget_cap_microusd" ? { ...fact, value } : fact));
  for (const bad of ["0", "-5", "1.5", "1e6", "abc", "", " 100", "100 "])
    expect(assessSpendBudgetFacts("glm", withCap(bad)).ok).toBe(false);
  // Two conflicting values for a single-valued config predicate is ambiguous.
  const ambiguous = [...COMPLETE_BUDGET, { predicate: "budget_cap_microusd", value: "999" }];
  expect(assessSpendBudgetFacts("glm", ambiguous).ok).toBe(false);
  // An empty required-present value refuses.
  const emptyLayer1 = COMPLETE_BUDGET.map((fact) =>
    fact.predicate === "layer1_confirmed" ? { ...fact, value: "  " } : fact);
  expect(assessSpendBudgetFacts("glm", emptyLayer1).ok).toBe(false);
});

// --- ledger read path (idiomatic north fact read) ---------------------------

test("checkSpendBudget reads the entity via north and refuses missing entity or read failure", () => {
  expect(spendBudgetEntityId("glm")).toBe("spend-budget:glm");
  expect(checkSpendBudget("glm", { command: northReturning(COMPLETE_JSON) })).toEqual({ ok: true });
  // A missing entity is an empty fact array => refuse.
  expect(checkSpendBudget("glm", { command: northReturning("[]") }).ok).toBe(false);
  // A ledger read failure => refuse, never headroom.
  const failed = checkSpendBudget("glm", { command: northFailing() });
  expect(failed.ok).toBe(false);
  expect(failed.reason).toContain("ledger read failed");
});

// --- seam verdict: subscription is O(1), never reads the ledger -------------

test("subscription targets pass the guard without touching the ledger", () => {
  // northFailing would make any read refuse; a subscription target must still pass.
  const command = northFailing();
  expect(spendGuardEligible("anthropic", "claude-personal", { command })).toBe(true);
  expect(spendGuardEligible("openai", "codex-personal", { command })).toBe(true);
  expect(spendGuardVerdict("anthropic", "claude-personal", { command })).toEqual({ ok: true });
});

test("api-billed targets are eligible only with a complete budget entity", () => {
  expect(spendGuardEligible("openrouter", "glm", { command: northReturning("[]") })).toBe(false);
  expect(spendGuardEligible("openrouter", "glm", { command: northReturning(COMPLETE_JSON) })).toBe(true);
});

// --- admission seam: distinct blocked_spend_guard outcome -------------------

const apiTarget = (id: string): RoutingTarget => ({ id, provider: "openrouter" as unknown as ProviderId });

test("admitSpendGuard refuses an api-billed target with a distinct, retry-safe outcome", () => {
  process.env.NORTH_BIN = northReturning("[]");
  let error: unknown;
  try {
    admitSpendGuard("openrouter", apiTarget("glm"));
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SpendGuardError);
  expect(error).toBeInstanceOf(ExecutionAdmissionError);
  expect(error).toBeInstanceOf(ProviderRetrySafeError);
  expect(error).toMatchObject({
    code: "blocked_spend_guard",
    processOutcome: "blocked_spend_guard",
    retrySafeBeforeAcceptance: true,
  });
});

test("admitSpendGuard passes a complete api-billed budget and never reads for subscription", () => {
  process.env.NORTH_BIN = northReturning(COMPLETE_JSON);
  expect(() => admitSpendGuard("openrouter", apiTarget("glm"))).not.toThrow();
  // Subscription must pass even when the ledger read would fail.
  process.env.NORTH_BIN = northFailing();
  expect(() => admitSpendGuard("anthropic", { id: "claude-personal", provider: "anthropic" })).not.toThrow();
  expect(() => admitSpendGuard("anthropic")).not.toThrow();
});

// --- routing eligibility seam (end-to-end through selectProviderFromAvailability) ---

function policyOf(targets: RoutingTarget[]): ResourcePolicy {
  return {
    version: 1,
    mode: "preferential",
    targets,
    targetOrder: targets.map((target) => target.id),
    providerOrder: [...new Set(targets.map((target) => target.provider))],
    pressures: {},
    weights: {},
    targetPressures: Object.fromEntries(targets.map((target) => [target.id, "unknown" as const])),
  } as ResourcePolicy;
}

const ready = (target: RoutingTarget): ProviderAvailability => ({
  targetId: target.id,
  provider: target.provider,
  installed: true,
  authenticated: true,
  available: true,
  reason: "ready",
});

test("auto-route flows past an unbudgeted api-billed target to a subscription sibling", () => {
  process.env.NORTH_BIN = northReturning("[]"); // no budget for the api-billed target
  const subscription = { id: "claude-personal", provider: "anthropic" as ProviderId, authMode: "ambient" as const };
  const apiBilled = apiTarget("glm");
  const policy = policyOf([subscription, apiBilled]);
  const decision = selectProviderFromAvailability("auto", [ready(subscription), ready(apiBilled)], policy);
  expect(decision.target).toBe("claude-personal");
  expect(decision.provider).toBe("anthropic");
});

test("the sole api-billed target is ineligible without a budget, eligible with one", () => {
  const apiBilled = apiTarget("glm");
  const policy = policyOf([apiBilled]);
  const availability = [ready(apiBilled)];

  process.env.NORTH_BIN = northReturning("[]");
  expect(() => selectProviderFromAvailability("auto", availability, policy)).toThrow();

  process.env.NORTH_BIN = northReturning(COMPLETE_JSON);
  const decision = selectProviderFromAvailability("auto", availability, policy);
  expect(decision.target).toBe("glm");
});
