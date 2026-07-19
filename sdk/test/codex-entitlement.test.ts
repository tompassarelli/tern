import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  CODEX_OBSERVATION_TTL_MS, CODEX_USAGE_PROBE_TIMEOUT_MS,
  normalizeCodexRateLimits, observeCodexEntitlement,
  readCodexEntitlementObservation, refreshCodexEntitlementIfStale,
  refreshCodexEntitlementsIfStale, shouldRefreshCodexEntitlement,
} from "../src/codex-entitlement";
import { writeProviderUsageObservations } from "../src/provider-observation-store";

const fixture = resolve(import.meta.dir, "fixtures/fake-codex-app-server.mjs");
const saved = {
  responses: process.env.FAKE_CODEX_RESPONSES,
  delay: process.env.FAKE_CODEX_DELAY_MS,
  home: process.env.HOME,
};
const temporary: string[] = [];
afterEach(() => {
  if (saved.responses === undefined) delete process.env.FAKE_CODEX_RESPONSES;
  else process.env.FAKE_CODEX_RESPONSES = saved.responses;
  if (saved.delay === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
  else process.env.FAKE_CODEX_DELAY_MS = saved.delay;
  if (saved.home === undefined) delete process.env.HOME;
  else process.env.HOME = saved.home;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function responses(account: unknown = { type: "chatgpt", email: "person@example.invalid", planType: "pro" }) {
  return {
    initialize: { userAgent: "fake" },
    "account/read": { account, requiresOpenaiAuth: true },
    "account/rateLimits/read": {
      rateLimitResetCredits: { availableCount: 0, credits: [] },
      rateLimits: {
        credits: { hasCredits: true, balance: "999", unlimited: false },
        individualLimit: null,
        limitId: "codex",
        limitName: null,
        planType: "pro",
        primary: { usedPercent: 61, resetsAt: 1_800_000_000, windowDurationMins: 10_080 },
        rateLimitReachedType: null,
        secondary: null,
      },
      rateLimitsByLimitId: {
        codex: {
          credits: { hasCredits: true, balance: "999", unlimited: false },
          individualLimit: null,
          limitId: "codex",
          limitName: null,
          planType: "pro",
          primary: { usedPercent: 61, resetsAt: 1_800_000_000, windowDurationMins: 10_080 },
          rateLimitReachedType: null,
          secondary: { usedPercent: 81, resetsAt: 1_800_086_400, windowDurationMins: 20_160 },
        },
        codex_model_x: { limitId: "codex_model_x", primary: { usedPercent: 100, resetsAt: 1_800_000_000 } },
      },
    },
  };
}

function observe(payload = responses(), timeoutMs = 1_000) {
  process.env.FAKE_CODEX_RESPONSES = JSON.stringify(payload);
  return readCodexEntitlementObservation({
    command: process.execPath,
    commandArgs: [fixture],
    timeoutMs,
    targetId: "codex-primary",
    now: new Date("2026-07-16T12:00:00Z"),
  });
}

test("reads only authenticated ChatGPT subscription windows without a model turn", async () => {
  const observation = await observe();
  expect(observation).toEqual({
    targetId: "codex-primary", provider: "openai", observedAt: "2026-07-16T12:00:00.000Z",
    source: "codex-app-server:account-rate-limits",
    windows: [
      { limitId: "codex:primary", usedPercent: 61, resetsAt: "2027-01-15T08:00:00.000Z" },
      { limitId: "codex:secondary", usedPercent: 81, resetsAt: "2027-01-16T08:00:00.000Z" },
    ],
  });
});

test("atomically updates the shared observation store", async () => {
  process.env.FAKE_CODEX_RESPONSES = JSON.stringify(responses());
  const directory = mkdtempSync(join(tmpdir(), "north-codex-observation-"));
  temporary.push(directory);
  const storePath = join(directory, "nested", "provider-usage-observations.json");
  const observation = await observeCodexEntitlement({
    command: process.execPath, commandArgs: [fixture], timeoutMs: 1_000,
    targetId: "codex-primary", now: new Date("2026-07-16T12:00:00Z"), storePath,
  });
  expect(JSON.parse(readFileSync(storePath, "utf8"))).toEqual({ version: 1, observations: [observation] });
});

test("ignores model-specific and credit fields", () => {
  const limits = responses()["account/rateLimits/read"];
  limits.rateLimitsByLimitId.codex.limitId = "canary-secret provider-controlled label";
  expect(normalizeCodexRateLimits(limits)).toEqual([
    { limitId: "codex:primary", usedPercent: 61, resetsAt: "2027-01-15T08:00:00.000Z" },
    { limitId: "codex:secondary", usedPercent: 81, resetsAt: "2027-01-16T08:00:00.000Z" },
  ]);
  expect(JSON.stringify(normalizeCodexRateLimits(limits))).not.toContain("canary-secret");
});

test("rejects API-key and missing authentication", async () => {
  await expect(observe(responses({ type: "apiKey" }))).rejects.toThrow("codex_usage_subscription_auth_required");
  await expect(observe(responses(null))).rejects.toThrow("codex_usage_subscription_auth_required");
});

test("fails within the configured timeout", async () => {
  const payload = responses();
  payload.initialize = "never" as any;
  await expect(observe(payload, 40)).rejects.toThrow("codex_usage_probe_timed_out");
});

test("the default deadline tolerates a slow authenticated app-server startup", async () => {
  expect(CODEX_USAGE_PROBE_TIMEOUT_MS).toBe(10_000);
  process.env.FAKE_CODEX_RESPONSES = JSON.stringify(responses());
  // Each of the three serialized RPC responses waits 1050ms, making this a
  // >3.15s end-to-end probe that deterministically exceeded the old 3s budget.
  process.env.FAKE_CODEX_DELAY_MS = "1050";
  const observation = await readCodexEntitlementObservation({
    command: process.execPath,
    commandArgs: [fixture],
    targetId: "codex-primary",
    now: new Date("2026-07-16T12:00:00Z"),
  });
  expect(observation.windows?.[0]?.usedPercent).toBe(61);
});

test("fails clearly when the shared Codex bucket is absent", async () => {
  const payload = responses();
  payload["account/rateLimits/read"] = { rateLimitsByLimitId: { other: {} } } as any;
  await expect(observe(payload)).rejects.toThrow("codex_usage_windows_unavailable");
});

test("provider RPC diagnostics are normalized before crossing the adapter boundary", async () => {
  const payload = responses();
  payload.initialize = {
    $error: { code: -32_000, message: "canary-secret raw provider error" },
    $stderr: "canary-secret raw stderr",
  } as any;
  try {
    await observe(payload);
    throw new Error("expected the probe to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("codex_usage_transport_failed");
    expect(String(error)).not.toContain("canary-secret");
  }
});

test("an invalidated ChatGPT token maps to the subscription-auth-required reason", async () => {
  const payload = responses();
  payload["account/rateLimits/read"] = {
    $error: {
      code: -32_603,
      message:
        'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; content-type=text/plain; body={ "error": { "message": "Your authentication token has been invalidated. Please try signing in again.", "type": "invalid_request_error", "code": "token_invalidated", "param": null }, "status": 401 }',
    },
  } as any;
  try {
    await observe(payload);
    throw new Error("expected the probe to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("codex_usage_subscription_auth_required");
    expect(String(error)).not.toContain("token_invalidated");
  }
});

test("a non-authentication RPC error stays the generic transport-failed reason", async () => {
  const payload = responses();
  payload["account/rateLimits/read"] = { $error: { code: -32_603, message: "internal error" } } as any;
  await expect(observe(payload)).rejects.toThrow("codex_usage_transport_failed");
});

test("fresh cached observation skips the app-server probe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-refresh-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date("2026-07-16T12:00:00Z");
  const cached = { targetId: "codex-primary", provider: "openai" as const,
    source: "codex-app-server:account-rate-limits" as const, observedAt: now.toISOString(),
    windows: [{ limitId: "codex:primary", usedPercent: 10, resetsAt: "2026-07-20T00:00:00Z" }] };
  await writeProviderUsageObservations(cached, storePath);
  let probes = 0;
  const result = await refreshCodexEntitlementIfStale({ storePath, targetId: "codex-primary", now,
    observe: async () => { probes++; throw new Error("must not run"); } });
  expect(result).toEqual(cached);
  expect(probes).toBe(0);
});

test("stale cached observation refreshes and persists the replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-refresh-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date("2026-07-16T12:00:00Z");
  const stale = { targetId: "codex-primary", provider: "openai" as const,
    source: "codex-app-server:account-rate-limits" as const,
    observedAt: new Date(now.getTime() - CODEX_OBSERVATION_TTL_MS - 1).toISOString(), state: "normal" as const };
  const replacement = { ...stale, observedAt: now.toISOString(), state: "low" as const };
  await writeProviderUsageObservations(stale, storePath);
  const result = await refreshCodexEntitlementIfStale({ storePath, targetId: "codex-primary", now,
    observe: async ({ storePath: destination }) => {
      await writeProviderUsageObservations(replacement, destination);
      return replacement;
    } });
  expect(result).toEqual(replacement);
  expect(JSON.parse(readFileSync(storePath, "utf8")).observations).toEqual([replacement]);
});

test("twenty parallel stale refreshes single-flight one entitlement probe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-refresh-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date("2026-07-16T12:00:00Z");
  const replacement = { targetId: "codex-primary", provider: "openai" as const,
    source: "codex-app-server:account-rate-limits" as const,
    observedAt: now.toISOString(), state: "normal" as const };
  let probes = 0;
  const observe = async ({ storePath: destination }: { storePath?: string }) => {
    probes++;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeProviderUsageObservations(replacement, destination);
    return replacement;
  };
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    refreshCodexEntitlementIfStale({ storePath, targetId: "codex-primary", now, observe })));
  expect(probes).toBe(1);
  expect(results.every((result) => result?.observedAt === replacement.observedAt)).toBe(true);
});

test("different Codex targets refresh concurrently with disjoint state and observations", async () => {
  const home = mkdtempSync(join(tmpdir(), "north-codex-target-refresh-"));
  temporary.push(home);
  process.env.HOME = home;
  process.env.FAKE_CODEX_RESPONSES = JSON.stringify(responses());
  process.env.FAKE_CODEX_DELAY_MS = "60";
  const storePath = join(home, "observations.json");
  const policy = {
    mode: "preferential" as const,
    providerOrder: ["openai" as const],
    pressures: {},
    targets: [
      { id: "codex-one", provider: "openai" as const, authMode: "isolated" as const, profile: "one" },
      { id: "codex-two", provider: "openai" as const, authMode: "isolated" as const, profile: "two" },
    ],
    targetOrder: ["codex-one", "codex-two"],
  };
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  let active = 0;
  let maxActive = 0;
  const spawnProcess = ((command: string, args: readonly string[], options: any) => {
    calls.push({ args, env: options.env });
    active++;
    maxActive = Math.max(maxActive, active);
    const child = spawn(command, args, options);
    child.once("exit", () => { active--; });
    return child;
  }) as typeof spawn;
  const observed = await refreshCodexEntitlementsIfStale({
    policy,
    storePath,
    command: process.execPath,
    commandArgs: [fixture],
    timeoutMs: 1_000,
    now: new Date("2026-07-16T12:00:00Z"),
    spawnProcess,
  });
  expect(maxActive).toBe(2);
  expect(observed.map((entry) => entry?.targetId).sort()).toEqual(["codex-one", "codex-two"]);
  expect(JSON.parse(readFileSync(storePath, "utf8")).observations
    .map((entry: { targetId: string }) => entry.targetId).sort()).toEqual(["codex-one", "codex-two"]);
  expect(calls).toHaveLength(2);
  const homes = calls.map((call) => call.env.CODEX_HOME).sort();
  expect(homes).toEqual([
    join(home, ".local/state/north/accounts/openai/one"),
    join(home, ".local/state/north/accounts/openai/two"),
  ]);
  for (const call of calls) {
    expect(call.env.CODEX_SQLITE_HOME).toBe(join(call.env.CODEX_HOME!, "sqlite"));
    expect(call.args).toContain('cli_auth_credentials_store="file"');
    expect(call.args).toContain('forced_login_method="chatgpt"');
  }
});

test("refresh failure replaces stale pressure with explicit unknown and a fixed diagnostic", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-refresh-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date("2026-07-16T12:00:00Z");
  const stale = { targetId: "codex-primary", provider: "openai" as const,
    source: "codex-app-server:account-rate-limits" as const,
    observedAt: "2026-07-15T00:00:00Z", state: "low" as const };
  await writeProviderUsageObservations(stale, storePath);
  const diagnostics: string[] = [];
  const failed = { storePath, targetId: "codex-primary", now,
    observe: async () => { throw new Error("probe failed"); }, onDiagnostic: (message: string) => diagnostics.push(message) };
  const unknown = { targetId: "codex-primary", provider: "openai" as const,
    source: "codex-app-server:account-rate-limits" as const,
    observedAt: now.toISOString(), state: "unknown" as const,
    collectionFailure: { observedAt: now.toISOString(), reason: "codex_usage_probe_failed" as const } };
  expect(await refreshCodexEntitlementIfStale(failed)).toEqual(unknown);
  expect(JSON.parse(readFileSync(storePath, "utf8")).observations).toEqual([unknown]);
  rmSync(storePath);
  expect(await refreshCodexEntitlementIfStale(failed)).toEqual(unknown);
  expect(diagnostics.join("\n")).toContain("pressure is unknown");
  expect(diagnostics.join("\n")).toContain("codex_usage_probe_failed");
  expect(diagnostics.join("\n")).not.toContain("probe failed");
});

test("only auto and explicit OpenAI routing refresh Codex headroom", () => {
  expect(shouldRefreshCodexEntitlement(undefined)).toBe(true);
  expect(shouldRefreshCodexEntitlement("auto")).toBe(true);
  expect(shouldRefreshCodexEntitlement("openai")).toBe(true);
  expect(shouldRefreshCodexEntitlement("anthropic")).toBe(false);
});
