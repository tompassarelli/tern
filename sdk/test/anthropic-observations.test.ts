import { expect, test } from "bun:test";
import type { SDKRateLimitEvent } from "@anthropic-ai/claude-agent-sdk";
import {
  observationFromAnthropicRateLimit,
  observeAnthropicQuery,
} from "../src/providers/anthropic-observations";
import type { AgentQuery, ProviderUsageObservation } from "../src/providers/types";

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
    observedAt: "2026-07-16T12:00:00.000Z",
    windows: [{ limitId: "five_hour", usedPercent: 83, resetsAt: "2026-07-17T00:00:00.000Z" }],
  });
});

test("normalizes terminal/warning status when Claude omits numeric utilization", () => {
  expect(observationFromAnthropicRateLimit(event({ status: "rejected", resetsAt: Date.parse("2026-07-17T00:00:00Z") / 1_000 }), "anthropic",
    new Date("2026-07-16T12:00:00Z"))).toMatchObject({ state: "exhausted", until: "2026-07-17T00:00:00.000Z" });
  expect(observationFromAnthropicRateLimit(event({ status: "allowed_warning" }), "anthropic",
    new Date("2026-07-16T12:00:00Z"))).toMatchObject({ state: "low" });
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
  const source: AgentQuery = {
    interrupt: async () => { interrupted = true; },
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

  expect(received).toEqual(messages);
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({
    targetId: "claude-primary",
    provider: "anthropic",
    windows: [{ limitId: "seven_day", usedPercent: 72 }],
  });
  expect(interrupted).toBe(true);
});

test("observation persistence failures never interrupt Claude output", async () => {
  const message = event({ status: "allowed_warning" });
  const source: AgentQuery = { async *[Symbol.asyncIterator]() { yield message; } };
  const observed = observeAnthropicQuery(source, { write: async () => { throw new Error("disk unavailable"); } });
  const received: any[] = [];
  for await (const value of observed) received.push(value);
  expect(received).toEqual([message]);
});
