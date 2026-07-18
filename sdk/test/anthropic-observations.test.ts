import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKRateLimitEvent } from "@anthropic-ai/claude-agent-sdk";
import {
  observationFromAnthropicRateLimit,
  anthropicTargetId,
  observeAnthropicQuery,
} from "../src/providers/anthropic-observations";
import type { AgentQuery, ProviderUsageObservation } from "../src/providers/types";
import { balancedAllocationEstimates } from "../src/provider-routing";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function event(info: Partial<SDKRateLimitEvent["rate_limit_info"]>): SDKRateLimitEvent {
  return {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", ...info },
    uuid: "test-uuid",
    session_id: "test-session",
  } as SDKRateLimitEvent;
}

test("normalizes fractional Claude utilization into an expiring usage window", () => {
  expect(observationFromAnthropicRateLimit(event({
    utilization: 0.83,
    resetsAt: Date.parse("2026-07-17T00:00:00Z") / 1_000,
    rateLimitType: "five_hour",
  }), "claude-primary", new Date("2026-07-16T12:00:00Z"))).toEqual({
    targetId: "claude-primary",
    provider: "anthropic",
    source: "claude-agent-sdk:rate-limit-event",
    observedAt: "2026-07-16T12:00:00.000Z",
    windows: [{
      limitId: "five_hour", usedPercent: 83, resetsAt: "2026-07-17T00:00:00.000Z",
      measurementKind: "provider-measured",
    }],
  });
});

test("keeps terminal/warning severity categorical when Claude omits numeric utilization", () => {
  expect(observationFromAnthropicRateLimit(event({ status: "rejected", resetsAt: Date.parse("2026-07-17T00:00:00Z") / 1_000 }), "anthropic",
    new Date("2026-07-16T12:00:00Z"))).toMatchObject({
      categoricalSignals: [{ kind: "rejection", resetsAt: "2026-07-17T00:00:00.000Z" }],
  });
  expect(observationFromAnthropicRateLimit(event({ status: "allowed_warning" }), "anthropic",
    new Date("2026-07-16T12:00:00Z"))).toMatchObject({
      categoricalSignals: [{ kind: "warning" }],
    });
});

test("preserves raw utilization separately from an allowed-warning signal", () => {
  const observation = observationFromAnthropicRateLimit(event({
    status: "allowed_warning",
    utilization: 0.55,
    resetsAt: Date.parse("2026-07-23T02:00:00Z") / 1_000,
    rateLimitType: "seven_day",
  }), "anthropic", new Date("2026-07-18T11:19:33Z"));
  expect(observation).toMatchObject({
    windows: [{
      limitId: "seven_day", usedPercent: 55, resetsAt: "2026-07-23T02:00:00.000Z",
      measurementKind: "provider-measured",
    }],
    categoricalSignals: [{
      kind: "warning", limitId: "seven_day", resetsAt: "2026-07-23T02:00:00.000Z",
    }],
  });
  expect(JSON.stringify(observation)).not.toContain('"usedPercent":80');
});

test("status-only model rejection remains scoped and unknown type text stays private", () => {
  const now = new Date();
  const resetsAt = Date.now() / 1_000 + 60_000;
  const opus = observationFromAnthropicRateLimit(event({
    status: "rejected", resetsAt, rateLimitType: "seven_day_opus",
  }), "claude", now);
  const policy = {
    mode: "balanced" as const,
    targets: [{ id: "claude", provider: "anthropic" as const, authMode: "ambient" as const }],
    targetOrder: ["claude"], providerOrder: ["anthropic" as const], pressures: {},
    automatedPressureObservationSets: { claude: [opus] },
  };
  const availability = [{ targetId: "claude", provider: "anthropic" as const,
    available: true, reason: "ready" as const }];
  expect(balancedAllocationEstimates(
    availability, policy, "standard", "medium", "claude-sonnet-5",
  )[0]).toMatchObject({ pressure: "unknown", eligible: true });
  expect(balancedAllocationEstimates(
    availability, policy, "senior", "high", "claude-opus-4-8",
  )[0]).toMatchObject({ pressure: "exhausted", eligible: false });

  const opaque = observationFromAnthropicRateLimit(event({
    status: "rejected", resetsAt, rateLimitType: "secret-canary-model-bucket" as any,
  }), "claude", now);
  expect(opaque.categoricalSignals?.[0]?.limitId).toBe("claude:model:opaque-event");
  expect(JSON.stringify(opaque)).not.toContain("secret-canary");
  const opaquePolicy = { ...policy, automatedPressureObservationSets: { claude: [opaque] } };
  expect(balancedAllocationEstimates(
    availability, opaquePolicy, "standard", "medium", "claude-sonnet-5",
  )[0]).toMatchObject({ pressure: "unknown", eligible: true });
});

test("an allowed event without utilization remains unknown", () => {
  expect(observationFromAnthropicRateLimit(event({ status: "allowed" }), "anthropic",
    new Date("2026-07-16T12:00:00Z"))).toMatchObject({ state: "unknown" });
});

test("observes rate-limit messages without extra turns and preserves the stream", async () => {
  const messages = [
    { type: "system", subtype: "init" },
    event({ utilization: 72, resetsAt: Date.parse("2026-07-17T00:00:00Z") / 1_000, rateLimitType: "seven_day" }),
    { type: "result", subtype: "success" },
  ];
  let interrupted = false;
  const models: string[] = [];
  const efforts: Array<string | null | undefined> = [];
  const source: AgentQuery = {
    interrupt: async () => { interrupted = true; },
    setModel: async (model) => { models.push(model); },
    applyFlagSettings: async (settings) => { efforts.push(settings.effortLevel); },
    async *[Symbol.asyncIterator]() { yield* messages; },
  };
  const written: ProviderUsageObservation[] = [];
  const observed = observeAnthropicQuery(source, {
    targetId: () => "claude-primary",
    now: () => new Date("2026-07-16T12:00:00Z"),
    write: async (value) => { written.push(value); },
  });
  const received: any[] = [];
  for await (const message of observed) received.push(message);
  await observed.interrupt?.();
  await observed.setModel?.("claude-opus-4-8");
  await observed.applyFlagSettings?.({ effortLevel: "xhigh" });

  expect(received).toEqual(messages);
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({
    targetId: "claude-primary",
    provider: "anthropic",
    windows: [{ limitId: "seven_day", usedPercent: 72 }],
  });
  expect(interrupted).toBe(true);
  expect(observed.supportsInFlightEscalation?.()).toBe(true);
  expect(models).toEqual(["claude-opus-4-8"]);
  expect(efforts).toEqual(["xhigh"]);
});

test("observation persistence failures never interrupt Claude output", async () => {
  const message = event({ status: "allowed_warning" });
  const source: AgentQuery = { async *[Symbol.asyncIterator]() { yield message; } };
  const observed = observeAnthropicQuery(source, { write: async () => { throw new Error("disk unavailable"); } });
  const received: any[] = [];
  for await (const value of observed) received.push(value);
  expect(received).toEqual([message]);
});

test("interactive statusline attribution requires one verified isolated Claude config root", () => {
  const home = mkdtempSync(join(tmpdir(), "north-anthropic-attribution-"));
  temporary.push(home);
  const policy = join(home, "routing-policy.json");
  const first = join(home, ".local/state/north/accounts/anthropic/claude-first");
  const second = join(home, ".local/state/north/accounts/anthropic/claude-second");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  writeFileSync(policy, JSON.stringify({
    version: 1, mode: "balanced",
    targets: [
      { id: "claude-first", provider: "anthropic", authMode: "isolated", profile: "claude-first" },
      { id: "claude-second", provider: "anthropic", authMode: "isolated", profile: "claude-second" },
    ],
    targetOrder: ["claude-first", "claude-second"],
  }));
  const base = { HOME: home, NORTH_ROUTING_POLICY: policy } as NodeJS.ProcessEnv;

  expect(anthropicTargetId({ ...base, CLAUDE_CONFIG_DIR: second })).toBe("claude-second");
  expect(anthropicTargetId({ ...base, CLAUDE_CONFIG_DIR: second, AGENT_TARGET: "claude-first" })).toBeUndefined();
  expect(anthropicTargetId({ ...base, CLAUDE_CONFIG_DIR: home })).toBeUndefined();
  expect(anthropicTargetId(base)).toBeUndefined();
});
