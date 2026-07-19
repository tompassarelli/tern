import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_USAGE_TTL_MS, accountUsageLeaseOptions, refreshAccountUsages,
} from "../src/account-usage";
import type { ProviderAccount } from "../src/accounts";
import { AnthropicUsageUnavailableError } from "../src/providers/anthropic-usage";
import { writeProviderUsageObservations } from "../src/provider-observation-store";
import { refreshCodexEntitlementIfStale } from "../src/codex-entitlement";
import { automatedPressure, loadProviderUsageObservations } from "../src/resource-policy";
import { ProviderRefreshCancelledError } from "../src/provider-cancellation";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function accounts(root: string): ProviderAccount[] {
  return [
    { id: "claude-proton", provider: "anthropic", authMode: "isolated", profile: "proton", root: join(root, "proton") },
    { id: "claude-gmail", provider: "anthropic", authMode: "isolated", profile: "gmail", root: join(root, "gmail") },
    { id: "codex-proton", provider: "openai", authMode: "isolated", profile: "proton", root: join(root, "codex") },
  ];
}

test("refreshes every isolated account concurrently with disjoint authoritative windows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date();
  const reset = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  let active = 0;
  let maxActive = 0;
  const enter = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
  };
  const reports = await refreshAccountUsages({
    accounts: accounts(directory), storePath, now,
    readAnthropic: async ({ target }) => {
      await enter();
      const unavailableComponents = target.id.includes("gmail")
        ? [{ limitId: "claude:five_hour" as const, reason: "reset_unavailable" as const }]
        : [];
      return {
        source: "claude-agent-sdk:usage-control-experimental",
        observation: {
          targetId: target.id, provider: "anthropic",
          source: "claude-agent-sdk:usage-control-experimental", observedAt: now.toISOString(),
          windows: [{ limitId: "claude:seven_day", usedPercent: target.id.includes("gmail") ? 40 : 10,
            resetsAt: reset }],
          ...(unavailableComponents.length ? { unavailableComponents } : {}),
        },
        unavailableComponents,
      };
    },
    readCodex: async ({ target }) => {
      await enter();
      return {
        targetId: target!.id, provider: "openai",
        source: "codex-app-server:account-rate-limits", observedAt: now.toISOString(),
        windows: [{ limitId: "codex:primary", usedPercent: 55, resetsAt: reset }],
      };
    },
  });

  expect(maxActive).toBe(3);
  expect(reports.map(({ accountId, status }) => [accountId, status])).toEqual([
    ["claude-proton", "observed"], ["claude-gmail", "observed"], ["codex-proton", "observed"],
  ]);
  expect(reports.find(({ accountId }) => accountId === "claude-gmail")?.unavailableComponents).toEqual([
    { limitId: "claude:five_hour", reason: "reset_unavailable" },
  ]);
  const persisted = JSON.parse(readFileSync(storePath, "utf8"));
  expect(persisted.observations.map(({ targetId }: { targetId: string }) => targetId).sort()).toEqual([
    "claude-gmail", "claude-proton", "codex-proton",
  ]);
  expect(persisted.observations.find(({ targetId }: { targetId: string }) => targetId === "claude-gmail")
    .unavailableComponents).toEqual([{ limitId: "claude:five_hour", reason: "reset_unavailable" }]);
});

test("host abort is control flow and never persists a synthetic usage failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-abort-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const controller = new AbortController();
  await expect(refreshAccountUsages({
    accounts: [accounts(directory)[0]], storePath, force: true,
    signal: controller.signal,
    readAnthropic: async () => {
      controller.abort(new Error("host shutdown"));
      throw new AnthropicUsageUnavailableError("anthropic_usage_probe_failed");
    },
  })).rejects.toBeInstanceOf(ProviderRefreshCancelledError);
  expect(loadProviderUsageObservations(storePath)).toBeUndefined();
});

test("default refresh observes every routing target and preserves ambient authentication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-routing-targets-"));
  temporary.push(directory);
  const policyPath = join(directory, "routing-policy.json");
  const storePath = join(directory, "observations.json");
  writeFileSync(policyPath, JSON.stringify({
    version: 1,
    mode: "balanced",
    targets: [
      { id: "claude-ambient", provider: "anthropic", authMode: "ambient" },
      { id: "codex-isolated", provider: "openai", authMode: "isolated", profile: "codex-isolated" },
    ],
    targetOrder: ["claude-ambient", "codex-isolated"],
  }));
  const now = new Date();
  const reset = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const observedTargets: Array<{ id: string; authMode: string | undefined; profile?: string }> = [];
  const reports = await refreshAccountUsages({
    context: { routingPolicyPath: policyPath }, storePath, now, force: true,
    readAnthropic: async ({ target }) => {
      observedTargets.push({ id: target.id, authMode: target.authMode, profile: target.profile });
      return {
        source: "claude-agent-sdk:usage-control-experimental",
        observation: {
          targetId: target.id, provider: "anthropic",
          source: "claude-agent-sdk:usage-control-experimental", observedAt: now.toISOString(),
          windows: [{ usedPercent: 10, resetsAt: reset }],
        },
        unavailableComponents: [],
      };
    },
    readCodex: async ({ target }) => {
      observedTargets.push({ id: target!.id, authMode: target!.authMode, profile: target!.profile });
      return {
        targetId: target!.id, provider: "openai",
        source: "codex-app-server:account-rate-limits", observedAt: now.toISOString(),
        windows: [{ usedPercent: 20, resetsAt: reset }],
      };
    },
  });

  expect(observedTargets.sort((left, right) => left.id.localeCompare(right.id))).toEqual([
    { id: "claude-ambient", authMode: "ambient", profile: undefined },
    { id: "codex-isolated", authMode: "isolated", profile: "codex-isolated" },
  ]);
  expect(reports.map(({ accountId, status }) => [accountId, status])).toEqual([
    ["claude-ambient", "observed"], ["codex-isolated", "observed"],
  ]);
});

test("account observation identity is validated before persistence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-identity-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date();
  const [report] = await refreshAccountUsages({
    accounts: [accounts(directory)[2]], storePath, now,
    readCodex: async () => ({
      targetId: "claude-gmail", provider: "anthropic" as const,
      source: "claude-agent-sdk:usage-control-experimental" as const,
      observedAt: now.toISOString(), state: "plenty" as const,
    }),
  });
  expect(report).toMatchObject({
    accountId: "codex-proton", provider: "openai", status: "unavailable",
    reason: "codex_usage_probe_failed",
    observation: { targetId: "codex-proton", provider: "openai", state: "unknown" },
  });
  const stored = loadProviderUsageObservations(storePath)?.observations ?? [];
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ targetId: "codex-proton", provider: "openai" });
  expect(JSON.stringify(stored)).not.toContain("claude-gmail");
});

test("account lease wait budget exceeds the provider probe deadline", () => {
  for (const timeout of [1, 3_000, 30_000, 60_000]) {
    const lease = accountUsageLeaseOptions(timeout);
    expect(lease.attempts * lease.waitMs).toBeGreaterThanOrEqual(timeout + 1_000);
  }
});

test("fresh authoritative observations skip provider probes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-cache-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date();
  const reset = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  await writeProviderUsageObservations({
    targetId: "claude-gmail", provider: "anthropic",
    source: "claude-agent-sdk:usage-control-experimental", observedAt: now.toISOString(),
    windows: [{ limitId: "claude:seven_day", usedPercent: 40, resetsAt: reset }],
  }, storePath);
  let probes = 0;
  const [report] = await refreshAccountUsages({
    accounts: [accounts(directory)[1]], storePath, now,
    readAnthropic: async () => { probes++; throw new Error("must not run"); },
  });
  expect(probes).toBe(0);
  expect(report.cached).toBe(true);
  expect(report.status).toBe("observed");
});

test("probe failures replace stale plenty with explicit unknown and fixed evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-failure-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date();
  const reset = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  await writeProviderUsageObservations({
    targetId: "claude-gmail", provider: "anthropic",
    observedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    windows: [{ limitId: "claude:seven_day", usedPercent: 1, resetsAt: reset }],
  }, storePath);
  const [report] = await refreshAccountUsages({
    accounts: [accounts(directory)[1]], storePath, now,
    readAnthropic: async () => {
      throw new AnthropicUsageUnavailableError("anthropic_usage_response_schema_changed");
    },
  });
  expect(report).toMatchObject({
    accountId: "claude-gmail", status: "unavailable", cached: false,
    reason: "anthropic_usage_response_schema_changed",
    observation: {
      state: "unknown", observedAt: now.toISOString(),
      collectionFailure: {
        observedAt: now.toISOString(), reason: "anthropic_usage_response_schema_changed",
      },
    },
  });
  const serialized = readFileSync(storePath, "utf8");
  expect(serialized).not.toContain("plenty");
  expect(JSON.parse(serialized).observations).toContainEqual(report.observation);
  expect(JSON.parse(serialized).observations).toHaveLength(2);
});

test("raw provider diagnostics and secrets never enter reports or the observation store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-redaction-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const [report] = await refreshAccountUsages({
    accounts: [accounts(directory)[2]], storePath,
    now: new Date(),
    readCodex: async () => { throw new Error("canary-secret raw app-server failure"); },
  });
  expect(report.reason).toBe("codex_usage_probe_failed");
  expect(JSON.stringify(report)).not.toContain("canary-secret");
  expect(readFileSync(storePath, "utf8")).not.toContain("canary-secret");
  expect(JSON.parse(readFileSync(storePath, "utf8")).observations[0].state).toBe("unknown");
});

test("an unavailable observation substrate degrades to unknown without probing or throwing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-store-unavailable-"));
  temporary.push(directory);
  const blocker = join(directory, "not-a-directory");
  writeFileSync(blocker, "blocked");
  let probes = 0;
  const [report] = await refreshAccountUsages({
    accounts: [accounts(directory)[1]],
    storePath: join(blocker, "observations.json"),
    readAnthropic: async () => {
      probes++;
      throw new Error("provider probe must not run without an observation lease");
    },
  });
  expect(probes).toBe(0);
  expect(report).toMatchObject({
    accountId: "claude-gmail",
    status: "unavailable",
    cached: false,
    reason: "usage_observation_store_unavailable",
    observation: { state: "unknown" },
  });
});

test("route-scoped refresh probes only the exact target or requested provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-scope-"));
  temporary.push(directory);
  const now = new Date();
  const reset = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const probed: string[] = [];
  const common = {
    accounts: accounts(directory), now, force: true,
    readAnthropic: async ({ target }: any) => {
      probed.push(target.id);
      return {
        source: "claude-agent-sdk:usage-control-experimental" as const,
        observation: {
          targetId: target.id, provider: "anthropic" as const,
          source: "claude-agent-sdk:usage-control-experimental" as const,
          observedAt: now.toISOString(), windows: [{ usedPercent: 10, resetsAt: reset }],
        },
        unavailableComponents: [],
      };
    },
    readCodex: async ({ target }: any) => {
      probed.push(target.id);
      return {
        targetId: target.id, provider: "openai" as const,
        source: "codex-app-server:account-rate-limits" as const,
        observedAt: now.toISOString(), windows: [{ usedPercent: 10, resetsAt: reset }],
      };
    },
  };

  await refreshAccountUsages({
    ...common, storePath: join(directory, "exact.json"),
    requested: { target: "claude-gmail" },
  });
  expect(probed).toEqual(["claude-gmail"]);
  probed.length = 0;
  await refreshAccountUsages({
    ...common, storePath: join(directory, "provider.json"), requested: "openai",
  });
  expect(probed).toEqual(["codex-proton"]);
});

test("failed probes are negatively cached across concurrent callers through the exact TTL boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-negative-cache-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  // Start just over one TTL behind wall-clock time so the recovery observation
  // at the +1ms boundary is not rejected as future-skewed by the real store.
  const now = new Date(Date.now() - ACCOUNT_USAGE_TTL_MS - 1_000);
  let probes = 0;
  const failure = () => refreshAccountUsages({
    accounts: [accounts(directory)[1]], storePath, now,
    readAnthropic: async () => {
      probes++;
      throw new AnthropicUsageUnavailableError("anthropic_usage_probe_failed");
    },
  });
  const concurrent = await Promise.all(Array.from({ length: 20 }, failure));
  expect(probes).toBe(1);
  expect(concurrent.flat().filter(({ cached }) => !cached)).toHaveLength(1);
  expect(concurrent.flat().every(({ status }) => status === "unavailable")).toBe(true);

  const atBoundary = new Date(now.getTime() + ACCOUNT_USAGE_TTL_MS);
  await refreshAccountUsages({
    accounts: [accounts(directory)[1]], storePath, now: atBoundary,
    readAnthropic: async () => { probes++; throw new Error("must remain cached at the boundary"); },
  });
  expect(probes).toBe(1);

  const afterBoundary = new Date(atBoundary.getTime() + 1);
  const reset = new Date(afterBoundary.getTime() + 60_000).toISOString();
  const [recovered] = await refreshAccountUsages({
    accounts: [accounts(directory)[1]], storePath, now: afterBoundary,
    readAnthropic: async ({ target }) => {
      probes++;
      return {
        source: "claude-agent-sdk:usage-control-experimental",
        observation: {
          targetId: target.id, provider: "anthropic",
          source: "claude-agent-sdk:usage-control-experimental", observedAt: afterBoundary.toISOString(),
          windows: [{ usedPercent: 10, resetsAt: reset }],
        },
        unavailableComponents: [],
      };
    },
  });
  expect(probes).toBe(2);
  expect(recovered).toMatchObject({ status: "observed", cached: false });
  expect(recovered.observation.collectionFailure).toBeUndefined();
});

test("telemetry failure preserves live exhaustion, then degrades to unknown after reset and recovers on success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-exhausted-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date();
  const reset = new Date(now.getTime() + 60_000).toISOString();
  await writeProviderUsageObservations({
    targetId: "claude-gmail", provider: "anthropic",
    source: "claude-agent-sdk:usage-control-experimental",
    observedAt: new Date(now.getTime() - ACCOUNT_USAGE_TTL_MS - 1).toISOString(),
    windows: [{ limitId: "claude:seven_day", usedPercent: 100, resetsAt: reset }],
  }, storePath);

  const [failed] = await refreshAccountUsages({
    accounts: [accounts(directory)[1]], storePath, now,
    readAnthropic: async () => {
      throw new AnthropicUsageUnavailableError("anthropic_usage_probe_timed_out");
    },
  });
  expect(failed.observation.windows?.[0].usedPercent).toBe(100);
  expect(failed.observation.collectionFailure).toEqual({
    observedAt: now.toISOString(), reason: "anthropic_usage_probe_timed_out",
  });
  expect(failed.observedAt).toBe(failed.observation.observedAt);
  expect(failed.lastSuccessfulObservedAt).toBe(failed.observation.observedAt);
  expect(failed.collectionAttemptedAt).toBe(now.toISOString());
  expect(automatedPressure(failed.observation, now)).toBe("exhausted");
  expect(automatedPressure(failed.observation, new Date(now.getTime() + 2 * 60_000))).toBe("unknown");

  const recoveredAt = new Date(now.getTime() + 2 * 60_000);
  const recoveredReset = new Date(recoveredAt.getTime() + 60 * 60_000).toISOString();
  const [recovered] = await refreshAccountUsages({
    accounts: [accounts(directory)[1]], storePath, now: recoveredAt, force: true,
    readAnthropic: async ({ target }) => ({
      source: "claude-agent-sdk:usage-control-experimental",
      observation: {
        targetId: target.id, provider: "anthropic",
        source: "claude-agent-sdk:usage-control-experimental", observedAt: recoveredAt.toISOString(),
        windows: [{ limitId: "claude:seven_day", usedPercent: 20, resetsAt: recoveredReset }],
      },
      unavailableComponents: [],
    }),
  });
  expect(recovered.status).toBe("observed");
  expect(recovered.observation.collectionFailure).toBeUndefined();
  const stored = loadProviderUsageObservations(storePath)?.observations.find(({ targetId }) => targetId === "claude-gmail");
  expect(stored?.collectionFailure).toBeUndefined();
  expect(automatedPressure(stored, recoveredAt)).toBe("plenty");
});

test("failed refresh never rewards constrained live usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-constrained-failure-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date();
  const reset = new Date(now.getTime() + 60_000).toISOString();
  await writeProviderUsageObservations({
    targetId: "claude-gmail", provider: "anthropic",
    source: "claude-agent-sdk:usage-control-experimental",
    observedAt: new Date(now.getTime() - ACCOUNT_USAGE_TTL_MS - 1).toISOString(),
    windows: [{ limitId: "claude:seven_day", usedPercent: 90, resetsAt: reset }],
  }, storePath);
  const [failed] = await refreshAccountUsages({
    accounts: [accounts(directory)[1]], storePath, now,
    readAnthropic: async () => {
      throw new AnthropicUsageUnavailableError("anthropic_usage_probe_timed_out");
    },
  });
  expect(failed.observation.windows?.[0].usedPercent).toBe(90);
  expect(automatedPressure(failed.observation, now)).toBe("unknown");
  expect(failed.collectionAttemptedAt).toBe(now.toISOString());
});

test("legacy Codex refresh cannot erase exhaustion preserved by the account collector", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-account-usage-codex-double-refresh-"));
  temporary.push(directory);
  const storePath = join(directory, "observations.json");
  const now = new Date();
  const reset = new Date(now.getTime() + 60_000).toISOString();
  await writeProviderUsageObservations({
    targetId: "codex-proton", provider: "openai",
    source: "codex-app-server:account-rate-limits",
    observedAt: new Date(now.getTime() - ACCOUNT_USAGE_TTL_MS - 1).toISOString(),
    windows: [{ limitId: "codex:primary", usedPercent: 100, resetsAt: reset }],
  }, storePath);
  const [failed] = await refreshAccountUsages({
    accounts: [accounts(directory)[2]], storePath, now,
    readCodex: async () => { throw new Error("probe failed"); },
  });
  expect(automatedPressure(failed.observation, now)).toBe("exhausted");
  let duplicateProbes = 0;
  const legacy = await refreshCodexEntitlementIfStale({
    storePath, targetId: "codex-proton", now,
    observe: async () => { duplicateProbes++; throw new Error("must remain negatively cached"); },
    onDiagnostic: () => {},
  });
  expect(duplicateProbes).toBe(0);
  expect(automatedPressure(legacy, now)).toBe("exhausted");
  expect(legacy?.collectionFailure?.observedAt).toBe(now.toISOString());
});
