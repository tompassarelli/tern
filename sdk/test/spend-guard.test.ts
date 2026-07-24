import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessSpendBudgetFacts,
  checkSpendBudget,
  providerBilling,
  reserveSpend,
  settleSpend,
  spendBudgetEntityId,
  spendGuardEligible,
  spendGuardVerdict,
} from "../src/spend-guard";
import {
  admitSpendGuard,
  admitSpendReservation,
  ExecutionAdmissionError,
  SpendGuardError,
} from "../src/execution-admission";
import { ProviderRetrySafeError, type ProviderId, type RoutingTarget } from "../src/providers/types";
import { selectProviderFromAvailability } from "../src/provider-routing";
import { addProviderAccount } from "../src/accounts";
import type { Fact } from "../src/north-client";
import type { ProviderAvailability, ResourcePolicy } from "../src/providers/types";

const temporary: string[] = [];
const savedNorthBin = process.env.NORTH_BIN;
const savedNorthBb = process.env.NORTH_BB;
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  if (savedNorthBin === undefined) delete process.env.NORTH_BIN;
  else process.env.NORTH_BIN = savedNorthBin;
  if (savedNorthBb === undefined) delete process.env.NORTH_BB;
  else process.env.NORTH_BB = savedNorthBb;
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
/** A fake spend-cli that prints the given JSON result for any verb/args. */
const spendCliReturning = (json: string) => fakeNorth(`printf '%s' ${JSON.stringify(json)}`);
/** A fake spend-cli that fails (simulates an unreachable ledger). */
const spendCliFailing = () => fakeNorth(`exit 4`);

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
    telemetry: {
      mode: "managed",
      phase: "preaccept",
      reason: "proved_unsent_preaccept",
      replay: "proved_unsent",
    },
    unsentProof: {
      durability: "adapter_receipt",
      source: "adapter_preflight",
      requestBytesPrepared: 0,
      requestBytesSent: 0,
      observableEvents: 0,
    },
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

// --- reservation seam: shells the CAS ledger primitive, fail-closed ----------
// The reservation CORRECTNESS (the concurrent race, settlement down/stands,
// missing-schema/price, overrides) is proven against a real daemon in
// cli/tests/spend-cli-test.clj. Here we prove only the TS mapping: subscription
// is O(1) with zero ledger touch, and any refusal fails closed.

test("reserveSpend is O(1) for subscription providers and never shells the ledger", () => {
  // A failing command would throw if invoked; a subscription provider must not invoke it.
  expect(reserveSpend("anthropic", "claude-personal", undefined, { command: spendCliFailing() })).toEqual({ ok: true });
  expect(reserveSpend("openai", "codex-personal", undefined, { command: spendCliFailing() })).toEqual({ ok: true });
});

test("reserveSpend maps a committed reservation and a refusal from the clj primitive", () => {
  const ok = reserveSpend("openrouter", "glm", undefined, {
    command: spendCliReturning(JSON.stringify({ ok: true, period: "spend-period:glm:2026-07", reserved: 1500000, envelope: 1500000 })),
  });
  expect(ok.ok).toBe(true);
  expect(ok.reserved).toBe(1500000);

  const denied = reserveSpend("openrouter", "glm", undefined, {
    command: spendCliReturning(JSON.stringify({ ok: false, reason: "over-cap" })),
  });
  expect(denied).toMatchObject({ ok: false, reason: "over-cap" });
});

test("reserveSpend fails closed when the ledger primitive is unreachable", () => {
  const verdict = reserveSpend("openrouter", "glm", undefined, { command: spendCliFailing() });
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("reserve-unavailable");
});

test("admitSpendReservation throws a distinct SpendGuardError on refusal, passes on commit", () => {
  const fakeBb = spendCliReturning(JSON.stringify({ ok: false, reason: "over-cap" }));
  process.env.NORTH_BB = fakeBb;
  let error: unknown;
  try {
    admitSpendReservation("openrouter", apiTarget("glm"));
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SpendGuardError);
  expect(error).toBeInstanceOf(ProviderRetrySafeError);
  expect((error as SpendGuardError).processOutcome).toBe("blocked_spend_guard");

  process.env.NORTH_BB = spendCliReturning(JSON.stringify({ ok: true, reserved: 1500000 }));
  expect(() => admitSpendReservation("openrouter", apiTarget("glm"))).not.toThrow();

  // Subscription never shells: a failing bb must not matter.
  process.env.NORTH_BB = spendCliFailing();
  expect(() => admitSpendReservation("anthropic", { id: "claude-personal", provider: "anthropic" })).not.toThrow();
});

test("a tripped-breaker refusal surfaces breaker-distinct from headroom in the error payload", () => {
  // Step-3 breaker: spend-cli reserve refuses a tripped breaker with reason
  // "breaker-tripped" ahead of the cap check, so the SpendGuardError message is
  // distinguishable from an over-cap (headroom) refusal — queryable in run evidence.
  process.env.NORTH_BB = spendCliReturning(JSON.stringify({ ok: false, reason: "breaker-tripped", detail: "burn-rate breach" }));
  let error: unknown;
  try {
    admitSpendReservation("openrouter", apiTarget("glm"));
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SpendGuardError);
  expect((error as Error).message).toContain("breaker-tripped");
  expect((error as Error).message).not.toContain("over-cap");
});

// --- settlement seam ---------------------------------------------------------

// --- config-time fail-closed: account add for an api-billed provider ---------

test("account add refuses an api-billed provider without a complete spend budget", async () => {
  // No budget for the target => the refusal fires before any file I/O.
  process.env.NORTH_BIN = northReturning("[]");
  await expect(addProviderAccount("glm", "openrouter", {})).rejects.toThrow(/without a complete spend budget/);

  // With a complete budget the spend gate passes; the subscription-only account
  // allowlist is then the next (expected) gate until an API adapter lands.
  process.env.NORTH_BIN = northReturning(COMPLETE_JSON);
  await expect(addProviderAccount("glm", "openrouter", {})).rejects.toThrow(/anthropic or openai/);
});

test("settleSpend forwards token evidence and returns the clj settlement verdict", () => {
  const result = settleSpend(
    { target: "glm", period: "spend-period:glm:2026-07", reservedMicrousd: 1500000, status: "exact", inputTokens: 100000, outputTokens: 20000 },
    { command: spendCliReturning(JSON.stringify({ ok: true, final: 600000, evidence: "exact", released: 900000 })) },
  );
  expect(result).toMatchObject({ ok: true, final: 600000, evidence: "exact" });
});
