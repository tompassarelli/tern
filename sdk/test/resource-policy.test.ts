import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProviderUsageObservations, effectivePressure, loadProviderUsageObservations, loadResourcePolicy,
  parseProviderUsageObservations, parseResourcePolicy, pressureFromUsageWindows, PRESSURE_TTL_MS,
} from "../src/resource-policy";
import { resourcePolicyFromEnv, selectProviderFromAvailability } from "../src/provider-routing";
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
    "codex-primary": { state: "low", observedAt: "2026-07-01T00:00:00Z", until: "2026-07-20T00:00:00Z" },
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
  expect(parsed.weights).toEqual({ openai: 2, anthropic: 3 });
  expect(parsed.reservedFrontierProvider).toBe("anthropic");
  expect(parsed.envelopes?.projects?.north).toEqual({ runs: 80, retries: 0 });
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

test("a missing policy file retains historical defaults", () => {
  process.env.NORTH_ROUTING_POLICY = join(tmpdir(), "definitely-absent-north-policy.json");
  delete process.env.NORTH_ALLOCATION_MODE;
  delete process.env.NORTH_PROVIDER_ORDER;
  delete process.env.NORTH_PROVIDER_WEIGHTS;
  delete process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE;
  delete process.env.NORTH_OPENAI_ENTITLEMENT_PRESSURE;
  expect(loadResourcePolicy()).toBeUndefined();
  expect(resourcePolicyFromEnv()).toMatchObject({
    mode: "preferential", providerOrder: ["anthropic", "openai"],
    pressures: {}, weights: {},
  });
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

test("a fresh automated unknown is an observation and overrides a manual state", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy(complete, "test-policy", now);
  const store = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic", state: "unknown", observedAt: "2026-07-16T11:00:00Z",
  }] });
  expect(applyProviderUsageObservations(manual, store, now).pressures.anthropic).toBe("unknown");
});

test("explicit environment pressure overrides fresh automated and manual observations", () => {
  const now = new Date("2026-07-16T12:00:00Z");
  const manual = parseResourcePolicy(complete, "test-policy", now);
  const store = parseProviderUsageObservations({ version: 1, observations: [{
    targetId: "claude-primary", provider: "anthropic", state: "exhausted", observedAt: "2026-07-16T11:00:00Z",
  }] });
  process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE = "low";
  expect(resourcePolicyFromEnv(manual, store).pressures.anthropic).toBe("low");
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
