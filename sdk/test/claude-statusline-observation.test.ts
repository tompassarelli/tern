import { expect, test } from "bun:test";
import {
  ingestClaudeStatusline,
  observationFromClaudeStatusline,
} from "../src/claude-statusline-observation";
import type { ProviderUsageObservation } from "../src/providers/types";

test("normalizes Claude subscriber statusline windows", () => {
  expect(observationFromClaudeStatusline({
    cwd: "/private/path-that-must-not-be-stored",
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1_738_425_600 },
      seven_day: { used_percentage: 41.2, resets_at: 1_738_857_600 },
    },
  }, "claude-primary", new Date("2026-07-16T12:00:00Z"))).toEqual({
    targetId: "claude-primary",
    provider: "anthropic",
    observedAt: "2026-07-16T12:00:00.000Z",
    windows: [
      { limitId: "five_hour", usedPercent: 23.5, resetsAt: "2025-02-01T16:00:00.000Z" },
      { limitId: "seven_day", usedPercent: 41.2, resetsAt: "2025-02-06T16:00:00.000Z" },
    ],
  });
});

test("missing or malformed statusline limits are ignored", () => {
  expect(observationFromClaudeStatusline({ rate_limits: null }, "claude")).toBeUndefined();
  expect(observationFromClaudeStatusline({ rate_limits: {
    five_hour: { used_percentage: "23", resets_at: 1_738_425_600 },
  } }, "claude")).toBeUndefined();
});

test("ingestion is fail-open and writes only the normalized observation", async () => {
  const written: ProviderUsageObservation[] = [];
  expect(await ingestClaudeStatusline({ rate_limits: {
    five_hour: { used_percentage: 80, resets_at: 1_738_425_600 },
  } }, {
    targetId: "claude-primary",
    now: new Date("2026-07-16T12:00:00Z"),
    write: async (observation) => { written.push(observation); },
  })).toBe(true);
  expect(written).toHaveLength(1);
  expect(JSON.stringify(written[0])).not.toContain("cwd");
  expect(await ingestClaudeStatusline({ rate_limits: {
    five_hour: { used_percentage: 80, resets_at: 1_738_425_600 },
  } }, { targetId: "claude", write: async () => { throw new Error("disk unavailable"); } })).toBe(false);
});
