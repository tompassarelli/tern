import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import {
  CODEX_OBSERVATION_TTL_MS, normalizeCodexRateLimits, observeCodexEntitlement,
  readCodexEntitlementObservation, refreshCodexEntitlementIfStale, shouldRefreshCodexEntitlement,
} from "../src/codex-entitlement";
import { writeProviderUsageObservations } from "../src/provider-observation-store";

const fixture = resolve(import.meta.dir, "fixtures/fake-codex-app-server.mjs");
const saved = { responses: process.env.FAKE_CODEX_RESPONSES, delay: process.env.FAKE_CODEX_DELAY_MS };
const temporary: string[] = [];
afterEach(() => {
  if (saved.responses === undefined) delete process.env.FAKE_CODEX_RESPONSES;
  else process.env.FAKE_CODEX_RESPONSES = saved.responses;
  if (saved.delay === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
  else process.env.FAKE_CODEX_DELAY_MS = saved.delay;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function responses(account: unknown = { type: "chatgpt", email: "person@example.invalid", planType: "pro" }) {
  return {
    initialize: { userAgent: "fake" },
    "account/read": { account, requiresOpenaiAuth: true },
    "account/rateLimits/read": {
      rateLimits: { limitId: "codex", primary: { usedPercent: 61, resetsAt: 1_800_000_000 } },
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: { usedPercent: 61, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 81, resetsAt: 1_800_086_400 } },
        codex_model_x: { limitId: "codex_model_x", primary: { usedPercent: 100, resetsAt: 1_800_000_000 } },
      },
      credits: { hasCredits: true, balance: "999" },
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
  expect(normalizeCodexRateLimits(responses()["account/rateLimits/read"])).toEqual([
    { limitId: "codex:primary", usedPercent: 61, resetsAt: "2027-01-15T08:00:00.000Z" },
    { limitId: "codex:secondary", usedPercent: 81, resetsAt: "2027-01-16T08:00:00.000Z" },
  ]);
});

test("rejects API-key and missing authentication", async () => {
  await expect(observe(responses({ type: "apiKey" }))).rejects.toThrow("not authenticated through a ChatGPT subscription");
  await expect(observe(responses(null))).rejects.toThrow("not authenticated through a ChatGPT subscription");
});

test("fails within the configured timeout", async () => {
  const payload = responses();
  payload.initialize = "never" as any;
  await expect(observe(payload, 40)).rejects.toThrow("timed out after 40ms");
});

test("fails clearly when the shared Codex bucket is absent", async () => {
  const payload = responses();
  payload["account/rateLimits/read"] = { rateLimitsByLimitId: { other: {} } } as any;
  await expect(observe(payload)).rejects.toThrow("no shared codex rate-limit bucket");
});

test("fresh cached observation skips the app-server probe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-refresh-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date("2026-07-16T12:00:00Z");
  const cached = { targetId: "codex-primary", provider: "openai" as const, observedAt: now.toISOString(),
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

test("refresh failure falls back to cached or unknown with a diagnostic", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-refresh-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date("2026-07-16T12:00:00Z");
  const stale = { targetId: "codex-primary", provider: "openai" as const,
    observedAt: "2026-07-15T00:00:00Z", state: "low" as const };
  await writeProviderUsageObservations(stale, storePath);
  const diagnostics: string[] = [];
  const failed = { storePath, targetId: "codex-primary", now,
    observe: async () => { throw new Error("probe failed"); }, onDiagnostic: (message: string) => diagnostics.push(message) };
  expect(await refreshCodexEntitlementIfStale(failed)).toEqual(stale);
  rmSync(storePath);
  expect(await refreshCodexEntitlementIfStale(failed)).toBeUndefined();
  expect(diagnostics.join("\n")).toContain("cached observation");
  expect(diagnostics.join("\n")).toContain("unknown pressure");
});

test("only auto and explicit OpenAI routing refresh Codex headroom", () => {
  expect(shouldRefreshCodexEntitlement(undefined)).toBe(true);
  expect(shouldRefreshCodexEntitlement("auto")).toBe(true);
  expect(shouldRefreshCodexEntitlement("openai")).toBe(true);
  expect(shouldRefreshCodexEntitlement("anthropic")).toBe(false);
});
