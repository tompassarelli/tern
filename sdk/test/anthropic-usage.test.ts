import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnthropicUsageUnavailableError,
  normalizeAnthropicUsage,
  readAnthropicSubscriptionUsage,
} from "../src/providers/anthropic-usage";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function usageResponse() {
  return {
    session: { total_cost_usd: 99_999 },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 40, resets_at: "2026-07-18T12:00:00Z" },
      seven_day_opus: { utilization: 81, resets_at: "2026-07-19T12:00:00Z" },
      model_scoped: [
        { display_name: "Fable", utilization: 38, resets_at: "2026-07-18T12:00:01Z" },
      ],
      limits: [
        { group: "session", is_active: false, kind: "session", percent: 0,
          resets_at: "2026-07-18T12:00:00Z", scope: null, severity: "normal" },
        { group: "weekly", is_active: true, kind: "weekly_all", percent: 40,
          resets_at: "2026-07-18T12:00:00Z", scope: null, severity: "normal" },
        { group: "weekly", is_active: false, kind: "weekly_scoped", percent: 38,
          resets_at: "2026-07-18T12:00:01Z",
          scope: { model: { id: null, display_name: "Fable" }, surface: null }, severity: "normal" },
      ],
      // These are deliberately forbidden inputs to routing/accounting.
      extra_usage: { is_enabled: true, used_credits: 1234, monthly_limit: 9999, currency: "USD" },
      spend: { canary_secret: "must-not-escape" },
      undocumented_window: { utilization: 100, resets_at: "2027-01-01T00:00:00Z" },
    },
  };
}

test("allowlists documented Claude subscription windows and ignores credit/unknown fields", () => {
  const result = normalizeAnthropicUsage(usageResponse(), "claude-gmail", new Date("2026-07-17T00:00:00Z"));
  expect(result.observation).toEqual({
    targetId: "claude-gmail",
    provider: "anthropic",
    source: "claude-agent-sdk:usage-control-experimental",
    observedAt: "2026-07-17T00:00:00.000Z",
    windows: [
      { limitId: "claude:seven_day", usedPercent: 40, resetsAt: "2026-07-18T12:00:00.000Z" },
      { limitId: "claude:seven_day_opus", usedPercent: 81, resetsAt: "2026-07-19T12:00:00.000Z" },
      { limitId: "claude:model:fable", usedPercent: 38, resetsAt: "2026-07-18T12:00:01.000Z" },
    ],
    unavailableComponents: [{ limitId: "claude:five_hour", reason: "reset_unavailable" }],
  });
  expect(result.unavailableComponents).toEqual([
    { limitId: "claude:five_hour", reason: "reset_unavailable" },
  ]);
  expect(JSON.stringify(result)).not.toContain("credits");
  expect(JSON.stringify(result)).not.toContain("canary_secret");
  expect(JSON.stringify(result)).not.toContain("undocumented_window");
  expect(JSON.stringify(result)).not.toContain("weekly_scoped");
});

test("provider-controlled model labels and reset comments never persist", () => {
  const response = usageResponse();
  response.rate_limits.model_scoped = [{
    display_name: "Bearer secret-canary-123",
    utilization: 77,
    resets_at: "Thu, 01 Jan 2099 00:00:00 GMT (reset-secret-canary)",
  }];
  const result = normalizeAnthropicUsage(response, "claude-gmail", new Date());
  const scoped = result.observation.windows?.find(({ limitId }) => limitId?.startsWith("claude:model:"));
  expect(scoped).toEqual({
    limitId: "claude:model:opaque-1", usedPercent: 77, resetsAt: "2099-01-01T00:00:00.000Z",
  });
  expect(JSON.stringify(result)).not.toContain("secret-canary");
});

test("experimental contract drift fails soft with a fixed reason", () => {
  const drifted = { subscription_type: "max", limits_available: true, limits: {} };
  try {
    normalizeAnthropicUsage(drifted, "claude-gmail");
    throw new Error("expected normalization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AnthropicUsageUnavailableError);
    expect((error as AnthropicUsageUnavailableError).reason).toBe("anthropic_usage_response_schema_changed");
    expect(String(error)).not.toContain(JSON.stringify(drifted));
  }
});

test("one transient experimental-envelope mismatch is retried within the same deadline", async () => {
  const target = { id: "claude", provider: "anthropic" as const, authMode: "ambient" as const };
  let calls = 0;
  const result = await readAnthropicSubscriptionUsage({
    target,
    start: async () => ({
      query: () => ({
        async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
          calls++;
          return calls === 1 ? { temporary: true } : usageResponse();
        },
        close() {},
      }),
      close() {},
    }),
  });
  expect(calls).toBe(2);
  expect(result.observation.windows?.map(({ limitId }) => limitId)).toEqual([
    "claude:seven_day", "claude:seven_day_opus", "claude:model:fable",
  ]);
});

test("persistent experimental-envelope drift remains a fixed bounded failure", async () => {
  const target = { id: "claude", provider: "anthropic" as const, authMode: "ambient" as const };
  let calls = 0;
  await expect(readAnthropicSubscriptionUsage({
    target,
    start: async () => ({
      query: () => ({
        async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
          calls++;
          return { temporary: true };
        },
        close() {},
      }),
      close() {},
    }),
  })).rejects.toThrow("anthropic_usage_response_schema_changed");
  expect(calls).toBe(2);
});

test("cancellation prevents startup and suppresses the schema retry", async () => {
  const target = { id: "claude", provider: "anthropic" as const, authMode: "ambient" as const };
  const before = new AbortController();
  before.abort(new Error("PRIVATE PRE-ABORT"));
  let startups = 0;
  await expect(readAnthropicSubscriptionUsage({
    target,
    signal: before.signal,
    start: async () => {
      startups++;
      return await new Promise<never>(() => {});
    },
  })).rejects.toThrow("anthropic_usage_probe_aborted");
  expect(startups).toBe(0);

  const during = new AbortController();
  let calls = 0;
  await expect(readAnthropicSubscriptionUsage({
    target,
    signal: during.signal,
    start: async () => ({
      query: () => ({
        async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
          calls++;
          during.abort(new Error("PRIVATE MID-PROBE ABORT"));
          return { schema: "would normally retry" };
        },
        close() {},
      }),
      close() {},
    }),
  })).rejects.toThrow("anthropic_usage_probe_aborted");
  expect(calls).toBe(1);
});

test("an unavailable plan endpoint and unusable windows never infer headroom", () => {
  expect(() => normalizeAnthropicUsage({
    subscription_type: "max", rate_limits_available: false, rate_limits: null,
  }, "claude-gmail")).toThrow("anthropic_usage_rate_limits_unavailable");
  expect(() => normalizeAnthropicUsage({
    subscription_type: "max", rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 2, resets_at: null } },
  }, "claude-gmail")).toThrow("anthropic_usage_windows_unavailable");
});

test("isolated Claude usage uses a control session with no model prompt", async () => {
  const home = mkdtempSync(join(tmpdir(), "north-anthropic-usage-"));
  temporary.push(home);
  let promptCompletion: Promise<IteratorResult<unknown>> | undefined;
  let closed = false;
  let seenOptions: any;
  const result = await readAnthropicSubscriptionUsage({
    target: { id: "claude-gmail", provider: "anthropic", authMode: "isolated", profile: "gmail" },
    env: { HOME: home, PATH: process.env.PATH, ANTHROPIC_API_KEY: "canary" },
    now: new Date("2026-07-17T00:00:00Z"),
    start: async ({ options }) => {
      seenOptions = options;
      return {
        query(prompt) {
          promptCompletion = prompt[Symbol.asyncIterator]().next();
          return {
            async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { return usageResponse(); },
            close() { closed = true; },
          };
        },
        close() { closed = true; },
      };
    },
  });

  expect(result.observation.targetId).toBe("claude-gmail");
  expect(seenOptions.env.CLAUDE_CONFIG_DIR).toBe(join(home, ".local/state/north/accounts/anthropic/gmail"));
  expect(seenOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(seenOptions.persistSession).toBe(false);
  expect(seenOptions.settingSources).toEqual([]);
  expect(seenOptions.tools).toEqual([]);
  expect(closed).toBe(true);
  expect(await promptCompletion).toEqual({ value: undefined, done: true });
});

test("missing optional usage capability and timeout return fixed reasons", async () => {
  const target = { id: "claude", provider: "anthropic" as const, authMode: "ambient" as const };
  await expect(readAnthropicSubscriptionUsage({
    target,
    start: async () => ({ query: () => ({ close() {} }), close() {} }),
  })).rejects.toThrow("anthropic_usage_capability_unavailable");
  await expect(readAnthropicSubscriptionUsage({
    target,
    timeoutMs: 5,
    start: async () => new Promise(() => {}),
  })).rejects.toThrow("anthropic_usage_probe_timed_out");
});
