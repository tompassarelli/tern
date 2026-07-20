import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProviderUsageObservations, automatedPressure, canonicalProviderWindowId,
  categoricalSignalExpiresAt, categoricalSignalIsActive, COLLECTION_FAILURE_TTL_MS, effectivePressure,
  loadProviderUsageObservations, loadResourcePolicy, parseProviderUsageObservations, parseResourcePolicy,
  pressureFromUsageWindows, PRESSURE_TTL_MS, RATE_LIMIT_WARNING_TTL_MS, sameProviderWindow,
} from "../src/resource-policy";
import { balancedAllocationEstimates, resourcePolicyFromEnv, selectProviderFromAvailability } from "../src/provider-routing";
import type { ProviderAvailability } from "../src/providers/types";

const savedEnv = { ...process.env };
const temporary: string[] = [];
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function policyFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "north-routing-policy-"));
  temporary.push(dir);
  const path = join(dir, "routing-policy.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const complete = {
  version: 1,
  mode: "reserved",
  targets: [
    { id: "claude-primary", provider: "anthropic", profile: "personal" },
    { id: "codex-primary", provider: "openai" },
  ],
  targetOrder: ["codex-primary", "claude-primary"],
  weights: { "claude-primary": 3, "codex-primary": 2 },
  reservedFrontierTarget: "claude-primary",
  pressures: {
    "claude-primary": { state: "plenty", observedAt: "2026-07-16T00:00:00Z" },
    "codex-primary": { state: "low", observedAt: "2026-07-01T00:00:00Z", until: "2099-01-01T00:00:00Z" },
  },
  envelopes: {
    default: { runs: 100, frontierRuns: 10, retries: 5, parallelism: 4 },
    month: { runs: 1000 }, week: { runs: 300, frontierRuns: 30 },
    projects: { north: { runs: 80, retries: 0 } },
    sessions: { interactive: { runs: 20, parallelism: 2 } },
  },
};

test("loads schema v1 and projects target policy onto today's provider boundary", () => {
  const parsed = parseResourcePolicy(complete, "test-policy", new Date("2026-07-16T12:00:00Z"));
  expect(parsed.targetOrder).toEqual(["codex-primary", "claude-primary"]);
  expect(parsed.providerOrder).toEqual(["openai", "anthropic"]);
  expect(parsed.pressures).toEqual({ openai: "low", anthropic: "plenty" });
  expect(parsed.targetPressures).toEqual({ "codex-primary": "low", "claude-primary": "plenty" });
  expect(parsed.weights).toEqual({ openai: 2, anthropic: 3 });
  expect(parsed.targets).toEqual([
    { id: "claude-primary", provider: "anthropic", authMode: "ambient", profile: "personal" },
    { id: "codex-primary", provider: "openai", authMode: "ambient" },
  ]);
  expect(parsed.reservedFrontierProvider).toBe("anthropic");
  expect(parsed.envelopes?.projects?.north).toEqual({ runs: 80, retries: 0 });
});

test("isolated target auth requires a strict portable profile slug", () => {
  const base = {
    version: 1, mode: "preferential", targetOrder: ["claude-work"],
    targets: [{ id: "claude-work", provider: "anthropic", authMode: "isolated", profile: "work_2" }],
  };
  expect(parseResourcePolicy(base).targets?.[0]).toEqual({
    id: "claude-work", provider: "anthropic", authMode: "isolated", profile: "work_2",
  });
  expect(() => parseResourcePolicy({ ...base, targets: [{ id: "claude-work", provider: "anthropic", authMode: "isolated" }] }))
    .toThrow("targets[0].profile is required when authMode is isolated");
  for (const profile of ["../work", "work/team", "work\\team", ".", "Work"]) {
    expect(() => parseResourcePolicy({ ...base, targets: [{ ...base.targets[0], profile }] }))
      .toThrow("targets[0].profile must be a portable slug");
  }
});

test("isolated targets cannot double-count the same provider profile", () => {
  expect(() => parseResourcePolicy({
    version: 1,
    mode: "balanced",
    targets: [
      { id: "claude-a", provider: "anthropic", authMode: "isolated", profile: "shared" },
      { id: "claude-b", provider: "anthropic", authMode: "isolated", profile: "shared" },
    ],
  })).toThrow("isolated targets must not reuse the same provider/profile root");
});

test("ambient targets cannot double-count one physical provider account", () => {
  expect(() => parseResourcePolicy({
    version: 1,
    mode: "balanced",
    targets: [
      { id: "claude-a", provider: "anthropic", authMode: "ambient" },
      { id: "claude-b", provider: "anthropic", authMode: "ambient" },
    ],
  })).toThrow("ambient targets must not reuse the same provider account");
});

test("pressure becomes unknown after 24 hours while until overrides that TTL", () => {
  const observedAt = "2026-07-15T12:00:00Z";
  expect(effectivePressure({ state: "low", observedAt }, new Date(Date.parse(observedAt) + PRESSURE_TTL_MS))).toBe("low");
  expect(effectivePressure({ state: "low", observedAt }, new Date(Date.parse(observedAt) + PRESSURE_TTL_MS + 1))).toBe("unknown");
  expect(effectivePressure({ state: "exhausted", observedAt, until: "2026-07-20T00:00:00Z" },
    new Date("2026-07-19T00:00:00Z"))).toBe("exhausted");
  expect(effectivePressure({ state: "exhausted", observedAt, until: "2026-07-20T00:00:00Z" },
    new Date("2026-07-21T00:00:00Z"))).toBe("unknown");
});

test("a future-dated observation cannot poison current pressure", () => {
  expect(effectivePressure({ state: "exhausted", observedAt: "2099-01-01T00:00:00Z" },
    new Date("2026-07-16T12:00:00Z"))).toBe("unknown");
});

test("NORTH_ROUTING_POLICY selects a file and environment values override it", () => {
  process.env.NORTH_ROUTING_POLICY = policyFile(complete);
  process.env.NORTH_ALLOCATION_MODE = "balanced";
  process.env.NORTH_PROVIDER_ORDER = "anthropic,openai";
  process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE = "normal";
  const policy = resourcePolicyFromEnv();
  expect(policy.mode).toBe("balanced");
  expect(policy.providerOrder).toEqual(["anthropic", "openai"]);
  expect(policy.pressures.anthropic).toBe("normal");
  expect(policy.pressures.openai).toBe("low");
  expect(policy.envelopes?.month?.runs).toBe(1000);
});

test("a missing policy file defaults to balanced allocation", () => {
  process.env.NORTH_ROUTING_POLICY = join(tmpdir(), "definitely-absent-north-policy.json");
  delete process.env.NORTH_ALLOCATION_MODE;
  delete process.env.NORTH_PROVIDER_ORDER;
  delete process.env.NORTH_PROVIDER_WEIGHTS;
  delete process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE;
  delete process.env.NORTH_OPENAI_ENTITLEMENT_PRESSURE;
  expect(loadResourcePolicy()).toBeUndefined();
  const defaults = resourcePolicyFromEnv();
  expect(defaults).toMatchObject({
    mode: "balanced", providerOrder: ["anthropic", "openai"],
    pressures: {}, weights: {},
  });
  expect(defaults.targets).toEqual([
    { id: "anthropic", provider: "anthropic", authMode: "ambient" },
    { id: "openai", provider: "openai", authMode: "ambient" },
  ]);
});

test("malformed advisory observation store cannot abort policy loading or selection", () => {
  const broken = policyFile("placeholder");
  writeFileSync(broken, "{");
  process.env.NORTH_PROVIDER_OBSERVATIONS = broken;
  process.env.NORTH_ROUTING_POLICY = join(tmpdir(), "north-absent-policy.json");
  const policy = resourcePolicyFromEnv();
  const availability: ProviderAvailability[] = [
    { targetId: "anthropic", provider: "anthropic", available: true, reason: "ready" },
    { targetId: "openai", provider: "openai", available: true, reason: "ready" },
  ];
  expect(() => selectProviderFromAvailability("auto", availability, policy, "standard", "broken-store", "medium"))
    .not.toThrow();
});

test("loaded target order drives pure provider selection", () => {
  const parsed = parseResourcePolicy(complete, "test-policy", new Date("2026-07-16T12:00:00Z"));
  const available: ProviderAvailability[] = [
    { provider: "anthropic", available: true, reason: "ready" },
    { provider: "openai", available: true, reason: "ready" },
  ];
  expect(selectProviderFromAvailability("auto", available, { ...parsed, mode: "preferential" }).provider).toBe("openai");
});

test("malformed files fail loudly with path and actionable field", () => {
  const badJson = policyFile("not-json");
  writeFileSync(badJson, "{");
  expect(() => loadResourcePolicy(badJson)).toThrow(`invalid North routing policy at ${badJson}: could not parse JSON`);

  const badTarget = policyFile({ ...complete, targetOrder: ["missing"] });
  expect(() => loadResourcePolicy(badTarget)).toThrow(`invalid North routing policy at ${badTarget}: targetOrder references unknown target missing`);
  const badEnvelope = policyFile({ ...complete, envelopes: { month: { parallelism: 0 } } });
  expect(() => loadResourcePolicy(badEnvelope)).toThrow("envelopes.month.parallelism must be a positive integer");
});

test("fresh automated observations override manual pressure and stale automation falls back", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy(complete, "test-policy", now);
  const fresh = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic", state: "exhausted", observedAt: "2026-07-16T11:00:00Z",
  }] });
  const stale = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic", state: "exhausted", observedAt: "2026-07-10T11:00:00Z",
  }] });
  expect(applyProviderUsageObservations(manual, fresh, now).pressures.anthropic).toBe("exhausted");
  expect(applyProviderUsageObservations(manual, stale, now).pressures.anthropic).toBe("plenty");
});

test("latest fresh automated target observation wins and target/provider mismatches are ignored", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy(complete, "test-policy", now);
  const store = parseProviderUsageObservations({ version: 1, observations: [
    { targetId: "claude-primary", provider: "anthropic", state: "low", observedAt: "2026-07-16T09:00:00Z" },
    { targetId: "claude-primary", provider: "openai", state: "exhausted", observedAt: "2026-07-16T11:30:00Z" },
    { targetId: "claude-primary", provider: "anthropic", state: "normal", observedAt: "2026-07-16T11:00:00Z" },
  ] });
  const result = applyProviderUsageObservations(manual, store, now);
  expect(result.pressures.anthropic).toBe("normal");
  expect(result.automatedPressureObservations?.["claude-primary"]?.observedAt).toBe("2026-07-16T11:00:00Z");
});

test("routing combines live telemetry sources conservatively without letting unknown erase known", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy(complete, "test-policy", now);
  const knownAndUnknown = parseProviderUsageObservations({ version: 1, observations: [
    { targetId: "claude-primary", provider: "anthropic",
      source: "claude-agent-sdk:usage-control-experimental", observedAt: "2026-07-16T11:00:00Z",
      windows: [{ limitId: "claude:seven_day", usedPercent: 55, resetsAt: "2026-07-18T12:00:00Z" }] },
    { targetId: "claude-primary", provider: "anthropic",
      source: "claude-agent-sdk:rate-limit-event", observedAt: "2026-07-16T11:30:00Z", state: "unknown" },
    { targetId: "claude-primary", provider: "anthropic",
      source: "claude-code:statusline", observedAt: "2026-07-16T11:45:00Z",
      windows: [{ limitId: "seven_day", usedPercent: 20, resetsAt: "2026-07-18T12:00:00Z" }] },
  ] });
  const result = applyProviderUsageObservations(manual, knownAndUnknown, now);
  expect(result.pressures.anthropic).toBe("normal");
  expect(result.automatedPressureObservations?.["claude-primary"]?.source)
    .toBe("claude-agent-sdk:usage-control-experimental");

  const exhaustedEvent = parseProviderUsageObservations({ version: 1, observations: [
    ...knownAndUnknown.observations,
    { targetId: "claude-primary", provider: "anthropic",
      source: "claude-agent-sdk:rate-limit-event", observedAt: "2026-07-16T11:50:00Z", state: "exhausted" },
  ] });
  const exhausted = applyProviderUsageObservations(manual, exhaustedEvent, now);
  expect(exhausted.pressures.anthropic).toBe("exhausted");
  expect(exhausted.automatedPressureObservations?.["claude-primary"]?.source)
    .toBe("claude-agent-sdk:rate-limit-event");
});

test("canonical window identity tolerates only source prefixes and reset jitter", () => {
  expect(canonicalProviderWindowId("anthropic", "claude:seven_day")).toBe("seven_day");
  expect(sameProviderWindow("anthropic",
    { limitId: "claude:seven_day", resetsAt: "2026-07-23T01:59:59.671Z" },
    { kind: "warning", limitId: "seven_day", resetsAt: "2026-07-23T02:00:00.000Z" },
  )).toBe(true);
  expect(sameProviderWindow("anthropic",
    { limitId: "claude:seven_day", resetsAt: "2026-07-23T01:59:58.999Z" },
    { kind: "warning", limitId: "seven_day", resetsAt: "2026-07-23T02:00:00.000Z" },
  )).toBe(false);
  expect(sameProviderWindow("anthropic",
    { limitId: "claude:five_hour", resetsAt: "2026-07-23T02:00:00.000Z" },
    { kind: "warning", limitId: "seven_day", resetsAt: "2026-07-23T02:00:00.000Z" },
  )).toBe(false);
});

test("warning evidence has an explicit short TTL while rejection survives through reset", () => {
  const observation = { observedAt: "2026-07-18T11:00:00.000Z" };
  const warning = { kind: "warning" as const, limitId: "seven_day", resetsAt: "2026-07-23T02:00:00.000Z" };
  expect(categoricalSignalExpiresAt(observation, warning))
    .toBe(new Date(Date.parse(observation.observedAt) + RATE_LIMIT_WARNING_TTL_MS).toISOString());
  expect(categoricalSignalIsActive(observation, warning,
    new Date(Date.parse(observation.observedAt) + RATE_LIMIT_WARNING_TTL_MS))).toBe(true);
  expect(categoricalSignalIsActive(observation, warning,
    new Date(Date.parse(observation.observedAt) + RATE_LIMIT_WARNING_TTL_MS + 1))).toBe(false);

  const rejection = { kind: "rejection" as const, limitId: "seven_day", resetsAt: "2026-07-23T02:00:00.000Z" };
  expect(categoricalSignalExpiresAt(observation, rejection)).toBe(rejection.resetsAt);
  expect(categoricalSignalIsActive(observation, rejection, new Date("2026-07-22T00:00:00Z"))).toBe(true);
  expect(categoricalSignalIsActive(observation, rejection, new Date("2026-07-23T02:00:00.001Z"))).toBe(false);
});

test("legacy rate-event floors migrate away from numeric measurement claims", () => {
  const parsed = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic",
    source: "claude-agent-sdk:rate-limit-event", observedAt: "2026-07-18T11:00:00Z",
    windows: [
      { limitId: "seven_day", usedPercent: 80, resetsAt: "2026-07-23T02:00:00Z" },
      { limitId: "five_hour", usedPercent: 72, resetsAt: "2026-07-18T16:00:00Z" },
    ],
  }] }).observations[0];
  expect(parsed.windows).toEqual([
    { limitId: "five_hour", usedPercent: 72, resetsAt: "2026-07-18T16:00:00Z" },
  ]);
  expect(parsed.categoricalSignals).toEqual([
    { kind: "warning", limitId: "seven_day", resetsAt: "2026-07-23T02:00:00Z" },
  ]);
});

test("categorical usage signal schema rejects provider-controlled kinds", () => {
  expect(() => parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic",
    source: "claude-agent-sdk:rate-limit-event", observedAt: "2026-07-18T11:00:00Z",
    categoricalSignals: [{ kind: "provider-secret-warning-text" }],
  }] })).toThrow("categoricalSignals[0].kind must be warning or rejection");
});

test("usage observation source is optional for legacy v1 stores but unknown provenance is rejected", () => {
  expect(parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic", observedAt: "2026-07-16T11:00:00Z", state: "normal",
  }] }).observations[0].source).toBeUndefined();
  expect(() => parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic", source: "provider:raw-diagnostic",
    observedAt: "2026-07-16T11:00:00Z", state: "normal",
  }] })).toThrow("source is not a recognized provider usage source");
});

test("fresh collection failure preserves only a still-live proven exhaustion", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const failure = { observedAt: "2026-07-16T11:59:00Z", reason: "anthropic_usage_probe_failed" as const };
  const exhausted = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic", source: "claude-agent-sdk:usage-control-experimental",
    observedAt: "2026-07-10T00:00:00Z",
    windows: [{ usedPercent: 100, resetsAt: "2026-07-17T00:00:00Z" }],
    collectionFailure: failure,
  }] }).observations[0];
  expect(automatedPressure(exhausted, now)).toBe("exhausted");

  const normal = { ...exhausted, windows: [{ usedPercent: 60, resetsAt: "2026-07-17T00:00:00Z" }] };
  expect(automatedPressure(normal, now)).toBe("unknown");
  expect(automatedPressure(normal, new Date(now.getTime() + COLLECTION_FAILURE_TTL_MS + 1))).toBeUndefined();
});

test("collection failure schema is fixed and rejects provider-controlled reasons", () => {
  const parsed = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "codex-primary", provider: "openai", observedAt: "2026-07-16T11:00:00Z", state: "unknown",
    collectionFailure: { observedAt: "2026-07-16T11:30:00Z", reason: "codex_usage_probe_timed_out" },
  }] });
  expect(parsed.observations[0].collectionFailure?.reason).toBe("codex_usage_probe_timed_out");
  expect(() => parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "codex-primary", provider: "openai", observedAt: "2026-07-16T11:00:00Z", state: "unknown",
    collectionFailure: { observedAt: "2026-07-16T11:30:00Z", reason: "provider says secret stuff" },
  }] })).toThrow("collectionFailure.reason is not recognized");
});

test("same-provider targets retain independent manual and automated pressures", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy({
    version: 1,
    mode: "preferential",
    targets: [
      { id: "claude-personal", provider: "anthropic" },
      { id: "claude-work", provider: "anthropic", authMode: "isolated", profile: "work" },
    ],
    targetOrder: ["claude-personal", "claude-work"],
    pressures: {
      "claude-personal": { state: "normal", observedAt: "2026-07-16T11:00:00Z" },
      "claude-work": { state: "low", observedAt: "2026-07-16T11:00:00Z" },
    },
  }, "test-policy", now);
  expect(manual.targetPressures).toEqual({ "claude-personal": "normal", "claude-work": "low" });
  expect(manual.pressures.anthropic).toBe("normal");

  const store = parseProviderUsageObservations({ version: 1, observations: [
    { targetId: "claude-personal", provider: "anthropic", state: "low", observedAt: "2026-07-16T11:30:00Z" },
    { targetId: "claude-work", provider: "anthropic", state: "exhausted", observedAt: "2026-07-16T11:30:00Z" },
  ] });
  const observed = applyProviderUsageObservations(manual, store, now);
  expect(observed.targetPressures).toEqual({ "claude-personal": "low", "claude-work": "exhausted" });
  expect(observed.pressures.anthropic).toBe("low");
  expect(Object.keys(observed.automatedPressureObservations ?? {}).sort())
    .toEqual(["claude-personal", "claude-work"]);
});

test("numeric usage windows derive pressure from the worst live provider window", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  expect(pressureFromUsageWindows([
    { limitId: "short", usedPercent: 35, resetsAt: "2026-07-16T16:00:00Z" },
    { limitId: "weekly", usedPercent: 84, resetsAt: "2026-07-20T00:00:00Z" },
    { limitId: "expired", usedPercent: 100, resetsAt: "2026-07-16T11:00:00Z" },
  ], now)).toBe("low");
  expect(pressureFromUsageWindows([
    { usedPercent: 100, resetsAt: "2026-07-16T16:00:00Z" },
  ], now)).toBe("exhausted");
  expect(pressureFromUsageWindows([
    { usedPercent: 49.9, resetsAt: "2026-07-16T16:00:00Z" },
  ], now)).toBe("plenty");
});

test("expired automated windows do not mask a fresh manual policy observation", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy(complete, "test-policy", now);
  const store = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic", observedAt: "2026-07-16T11:00:00Z",
    windows: [{ limitId: "five-hour", usedPercent: 100, resetsAt: "2026-07-16T11:30:00Z" }],
  }] });
  expect(applyProviderUsageObservations(manual, store, now).pressures.anthropic).toBe("plenty");
});

test("a fresh automated unknown cannot erase a known manual pressure", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy(complete, "test-policy", now);
  const store = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic", state: "unknown", observedAt: "2026-07-16T11:00:00Z",
  }] });
  expect(applyProviderUsageObservations(manual, store, now).pressures.anthropic).toBe("plenty");
});

test("manual exhaustion remains in force when automated telemetry is unknown", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy({
    version: 1,
    mode: "balanced",
    targets: [{ id: "claude-primary", provider: "anthropic" }],
    pressures: {
      "claude-primary": { state: "exhausted", observedAt: "2026-07-16T11:00:00Z" },
    },
  }, "test-policy", now);
  const store = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic",
    source: "claude-agent-sdk:rate-limit-event", state: "unknown",
    observedAt: "2026-07-16T11:30:00Z",
  }] });
  const observed = applyProviderUsageObservations(manual, store, now);
  expect(observed.targetPressures?.["claude-primary"]).toBe("exhausted");
  expect(observed.pressures.anthropic).toBe("exhausted");
});

test("explicit-source telemetry suppresses duplicate source-less migration observations", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy(complete, "test-policy", now);
  const store = parseProviderUsageObservations({ version: 1, observations: [
    { targetId: "claude-primary", provider: "anthropic", state: "exhausted",
      observedAt: "2026-07-16T11:45:00Z" },
    { targetId: "claude-primary", provider: "anthropic",
      source: "claude-agent-sdk:usage-control-experimental", state: "plenty",
      observedAt: "2026-07-16T11:30:00Z" },
  ] });
  const observed = applyProviderUsageObservations(manual, store, now);
  expect(observed.targetPressures?.["claude-primary"]).toBe("plenty");
  expect(observed.automatedPressureObservations?.["claude-primary"]?.source)
    .toBe("claude-agent-sdk:usage-control-experimental");
});

test("explicit unknown telemetry cannot suppress a live legacy exhaustion", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy(complete, "test-policy", now);
  const store = parseProviderUsageObservations({ version: 1, observations: [
    { targetId: "claude-primary", provider: "anthropic", state: "exhausted",
      observedAt: "2026-07-16T11:00:00Z" },
    { targetId: "claude-primary", provider: "anthropic",
      source: "claude-agent-sdk:rate-limit-event", state: "unknown",
      observedAt: "2026-07-16T11:30:00Z" },
  ] });
  const observed = applyProviderUsageObservations(manual, store, now);
  expect(observed.targetPressures?.["claude-primary"]).toBe("exhausted");
});

test("provider usage provenance rejects cross-provider sources and failure reasons", () => {
  expect(() => parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude", provider: "anthropic", source: "codex-app-server:account-rate-limits",
    observedAt: "2026-07-16T11:00:00Z", state: "normal",
  }] })).toThrow("source does not belong to provider anthropic");
  expect(() => parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "codex", provider: "openai", source: "codex-app-server:account-rate-limits",
    observedAt: "2026-07-16T11:00:00Z", state: "unknown",
    collectionFailure: { observedAt: "2026-07-16T11:00:00Z", reason: "anthropic_usage_probe_failed" },
  }] })).toThrow("reason does not belong to provider openai");
});

test("proven exhaustion survives observation TTL until its provider reset", () => {
  const observedAt = "2026-07-10T00:00:00Z";
  const reset = "2026-07-20T00:00:00Z";
  const observation = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude", provider: "anthropic",
    source: "claude-agent-sdk:usage-control-experimental", observedAt,
    windows: [{ limitId: "claude:seven_day", usedPercent: 100, resetsAt: reset }],
  }] }).observations[0];
  expect(automatedPressure(observation, new Date("2026-07-16T12:00:00Z"))).toBe("exhausted");
  expect(automatedPressure(observation, new Date("2026-07-21T00:00:00Z"))).toBeUndefined();
});

test("explicit environment pressure and weights dominate automated/file policy at selection", () => {
  const now = new Date();
  const base: any = {
    version: 1, mode: "balanced",
    targets: [
      { id: "claude", provider: "anthropic", authMode: "ambient" },
      { id: "codex", provider: "openai", authMode: "ambient" },
    ],
    targetOrder: ["claude", "codex"], providerOrder: ["anthropic", "openai"],
    pressures: {}, weights: { anthropic: 3, openai: 2 },
    targetWeights: { claude: 3, codex: 2 },
    targetPressures: { claude: "plenty", codex: "plenty" },
    automatedPressureObservationSets: {
      claude: [{ targetId: "claude", provider: "anthropic",
        source: "claude-agent-sdk:usage-control-experimental", observedAt: now.toISOString(),
        windows: [{ usedPercent: 10, resetsAt: "2099-01-01T00:00:00Z" }] }],
    },
  };
  const availability: ProviderAvailability[] = [
    { targetId: "claude", provider: "anthropic", available: true, reason: "ready" },
    { targetId: "codex", provider: "openai", available: true, reason: "ready" },
  ];
  process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE = "exhausted";
  const emptyStore = { version: 1 as const, observations: [] };
  const pressureOverride = resourcePolicyFromEnv(base, emptyStore);
  expect(selectProviderFromAvailability(
    "auto", availability, pressureOverride, "standard", "operator-pressure", "medium",
  ).target).toBe("codex");

  delete process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE;
  process.env.NORTH_PROVIDER_WEIGHTS = "anthropic=100,openai=1";
  const weightOverride = resourcePolicyFromEnv(base, emptyStore);
  const estimates = balancedAllocationEstimates(availability, weightOverride, "standard", "medium");
  expect(weightOverride.targetWeights).toEqual({ claude: 100, codex: 1 });
  const claude = estimates.find(({ target }) => target === "claude")!;
  const codex = estimates.find(({ target }) => target === "codex")!;
  expect(claude.effectiveWeight / codex.effectiveWeight).toBe(100);
  expect(claude.approximateShare).toBeCloseTo(100 / 101, 6);
});

test("explicit environment pressure overrides fresh automated and manual observations", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy(complete, "test-policy", now);
  const store = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic", state: "exhausted", observedAt: "2026-07-16T11:00:00Z",
  }] });
  process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE = "low";
  const policy = resourcePolicyFromEnv(manual, store);
  expect(policy.pressures.anthropic).toBe("low");
  expect(policy.targetPressures?.["claude-primary"]).toBe("low");
});

test("automated observations drive default routing even before a manual policy file exists", () => {
  process.env.NORTH_ROUTING_POLICY = join(tmpdir(), "absent-policy-for-observations.json");
  delete process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE;
  const store = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "anthropic", provider: "anthropic", state: "exhausted", observedAt: new Date().toISOString(),
  }] });
  const policy = resourcePolicyFromEnv(undefined, store);
  expect(policy.pressures.anthropic).toBe("exhausted");
  expect(policy.providerOrder).toEqual(["anthropic", "openai"]);
});

test("loads normalized provider usage observations from the configured store", () => {
  const path = policyFile({ version: 1, observations: [{
    targetId: "codex-primary", provider: "openai", state: "low", observedAt: "2026-07-16T11:00:00Z",
  }] });
  process.env.NORTH_PROVIDER_OBSERVATIONS = path;
  expect(loadProviderUsageObservations()?.observations).toHaveLength(1);
  expect(loadProviderUsageObservations()?.observations[0]).toMatchObject({ targetId: "codex-primary", provider: "openai" });
});

test("malformed automated observation stores fail loudly with their path", () => {
  const path = policyFile({ version: 1, observations: [{
    targetId: "codex-primary", provider: "openai", state: "low", observedAt: "yesterday",
  }] });
  expect(() => loadProviderUsageObservations(path)).toThrow(
    `invalid North provider usage observations at ${path}: observations[0].observedAt must be an ISO-8601 timestamp`,
  );
});
