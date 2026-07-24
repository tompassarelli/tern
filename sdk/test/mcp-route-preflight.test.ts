import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshAccountUsages } from "../src/account-usage";
import { selectProviderForExecution } from "../src/provider-routing";
import type { ResourcePolicy, RoutingDecision } from "../src/providers/types";
import {
  preflightMcpRoutePin, refreshMcpRoutePinUsage, validateConfiguredRoutePin,
} from "../src/mcp-route-preflight";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const policy: ResourcePolicy = {
  version: 1,
  mode: "balanced",
  targets: [
    { id: "claude-proton", provider: "anthropic", authMode: "isolated", profile: "claude-proton" },
    { id: "claude-gmail", provider: "anthropic", authMode: "isolated", profile: "claude-gmail" },
    { id: "codex-proton", provider: "openai", authMode: "isolated", profile: "codex-proton" },
  ],
  targetOrder: ["claude-proton", "claude-gmail", "codex-proton"],
  providerOrder: ["anthropic", "openai"],
  pressures: {},
};

test("MCP exact pins must name a configured target owned by the requested provider", () => {
  expect(validateConfiguredRoutePin({ target: "claude-gmail" }, policy)).toEqual({
    target: "claude-gmail", provider: "anthropic",
  });
  expect(() => validateConfiguredRoutePin({ target: "missing" }, policy)).toThrow("not configured");
  expect(() => validateConfiguredRoutePin({ target: "claude-gmail", provider: "openai" }, policy))
    .toThrow("belongs to anthropic");
});

test("MCP exact pin preflight refuses any selector that changes target or retains sibling fallback", async () => {
  const decision = {
    target: "claude-gmail", provider: "anthropic", fallbackTargets: [],
    selectionReason: "exact target=claude-gmail",
  } as RoutingDecision;
  expect(await preflightMcpRoutePin({ target: "claude-gmail" }, {
    policy, select: () => decision,
  })).toBe(decision);

  await expect(preflightMcpRoutePin({ target: "claude-gmail" }, {
    policy,
    select: () => ({ ...decision, fallbackTargets: ["claude-proton"] }),
  })).rejects.toThrow("violated pin contract");
});

test("MCP exact pin preflight carries the explicit model into canonical selection", async () => {
  const decision = {
    target: "claude-gmail", provider: "anthropic", fallbackTargets: [],
    selectionReason: "exact model-aware target",
  } as RoutingDecision;
  let context: any;
  await preflightMcpRoutePin({
    target: "claude-gmail", provider: "anthropic", tier: "senior", reasoning: "high",
    model: "claude-sonnet-5",
  }, {
    policy,
    select: ((_request, _policy, value) => { context = value; return decision; }) as any,
  });
  expect(context).toMatchObject({
    tier: "senior", reasoning: "high", model: "claude-sonnet-5",
  });
});

test("MCP exact pin refreshes only the selected account and telemetry failure is soft", async () => {
  const refreshed: string[][] = [];
  const observedModels: boolean[] = [];
  let codexRefreshes = 0;
  const accounts = () => [
    { id: "claude-proton", provider: "anthropic" as const, profile: "claude-proton", authMode: "isolated" as const, root: "/tmp/proton" },
    { id: "claude-gmail", provider: "anthropic" as const, profile: "claude-gmail", authMode: "isolated" as const, root: "/tmp/gmail" },
    { id: "codex-proton", provider: "openai" as const, profile: "codex-proton", authMode: "isolated" as const, root: "/tmp/codex" },
  ];
  await refreshMcpRoutePinUsage({ target: "claude-gmail", model: "fable" }, {
    policy, accounts,
    refreshAccounts: (async ({ accounts, observeAnthropicModels }) => {
      refreshed.push(accounts!.map(({ id }) => id));
      observedModels.push(Boolean(observeAnthropicModels));
      return [];
    }) as any,
    refreshCodex: (async () => { codexRefreshes++; return undefined; }) as any,
  });
  expect(refreshed).toEqual([["claude-gmail"]]);
  expect(observedModels).toEqual([true]);
  expect(codexRefreshes).toBe(0);

  await expect(refreshMcpRoutePinUsage({ target: "claude-gmail" }, {
    policy, accounts,
    refreshAccounts: (async () => { throw new Error("usage surface unavailable"); }) as any,
  })).resolves.toBeUndefined();
});

test("cold exact-model MCP preflight and execution share one Anthropic control Query", async () => {
  const root = await mkdtemp(join(tmpdir(), "north-mcp-one-model-query-"));
  roots.push(root);
  const usagePath = join(root, "usage.json");
  const modelPath = join(root, "models.json");
  const savedModelPath = process.env.NORTH_PROVIDER_MODEL_OBSERVATIONS;
  process.env.NORTH_PROVIDER_MODEL_OBSERVATIONS = modelPath;
  const counters = { startups: 0, queries: 0, usage: 0, models: 0, prompts: 0 };
  const now = new Date();
  const request = {
    target: "claude-gmail", provider: "anthropic" as const,
    tier: "frontier" as const, reasoning: "xhigh" as const, model: "fable",
  };
  const refresh = (options: Parameters<typeof refreshAccountUsages>[0]) => refreshAccountUsages({
    ...options,
    now,
    storePath: usagePath,
    modelStorePath: modelPath,
    env: { ...process.env, HOME: root },
    startAnthropicControl: async () => {
      counters.startups++;
      return {
        query(prompt) {
          counters.queries++;
          void (async () => {
            for await (const _message of prompt) counters.prompts++;
          })();
          return {
            async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
              counters.usage++;
              return {
                subscription_type: "max", rate_limits_available: true,
                rate_limits: {
                  five_hour: { utilization: 12, resets_at: "2099-01-01T00:00:00Z" },
                },
              };
            },
            async supportedModels() {
              counters.models++;
              return [{ value: "fable" }];
            },
            close() {},
          };
        },
        close() {},
      };
    },
  });
  const selector = (requested: Parameters<typeof selectProviderForExecution>[0],
    selectedPolicy: Parameters<typeof selectProviderForExecution>[1],
    context: Parameters<typeof selectProviderForExecution>[2]) => selectProviderForExecution(
    requested, selectedPolicy, context,
    {
      probeAnthropic: () => ({
        targetId: "claude-gmail", provider: "anthropic", available: true, reason: "ready",
      }),
      refreshAccountUsages: refresh,
    },
  );
  try {
    const admitted = await preflightMcpRoutePin(request, { policy, select: selector });
    const executed = await selector(
      { provider: request.provider, target: request.target }, policy,
      { tier: request.tier, reasoning: request.reasoning, model: request.model,
        stableKey: "mcp-worker" },
    );
    expect(admitted.modelAvailabilityReceipts?.[request.target]?.model).toBe("claude-fable-5");
    expect(executed.modelAvailabilityReceipts?.[request.target]?.model).toBe("claude-fable-5");
    expect(counters).toEqual({ startups: 1, queries: 1, usage: 1, models: 1, prompts: 0 });
  } finally {
    if (savedModelPath === undefined) delete process.env.NORTH_PROVIDER_MODEL_OBSERVATIONS;
    else process.env.NORTH_PROVIDER_MODEL_OBSERVATIONS = savedModelPath;
  }
});
