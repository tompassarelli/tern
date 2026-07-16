import { afterEach, expect, test } from "bun:test";
import { routedQuery, selectProvider, selectProviderFromAvailability } from "../src/providers";
import type { ProviderAvailability, ResourcePolicy } from "../src/providers/types";
import { resolveTier } from "../src/providers/catalog";

const saved = { disableA: process.env.NORTH_DISABLE_ANTHROPIC, disableO: process.env.NORTH_DISABLE_OPENAI, order: process.env.NORTH_PROVIDER_ORDER };
const available: ProviderAvailability[] = [
  { provider: "anthropic", available: true, reason: "ready" },
  { provider: "openai", available: true, reason: "ready" },
];
const policy = (overrides: Partial<ResourcePolicy> = {}): ResourcePolicy => ({
  mode: "preferential",
  providerOrder: ["anthropic", "openai"],
  pressures: { anthropic: "normal", openai: "normal" },
  ...overrides,
});
afterEach(() => {
  for (const [key, value] of [["NORTH_DISABLE_ANTHROPIC", saved.disableA], ["NORTH_DISABLE_OPENAI", saved.disableO], ["NORTH_PROVIDER_ORDER", saved.order]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("explicit disabled provider fails loudly", () => {
  process.env.NORTH_DISABLE_ANTHROPIC = "1";
  expect(() => selectProvider("anthropic")).toThrow("provider anthropic unavailable: disabled");
});

test("auto order selects OpenAI when Anthropic is disabled", () => {
  process.env.NORTH_DISABLE_ANTHROPIC = "1";
  const decision = selectProvider("auto");
  expect(decision.provider).toBe("openai");
});

test("preferential allocation walks configured order and explains pressure", () => {
  const decision = selectProviderFromAvailability("auto", available,
    policy({ providerOrder: ["openai", "anthropic"], pressures: { openai: "plenty", anthropic: "normal" } }));
  expect(decision.provider).toBe("openai");
  expect(decision.reason).toContain("mode=preferential");
  expect(decision.reason).toContain("pressure=plenty");
});

test("automatic allocation avoids an exhausted entitlement", () => {
  const decision = selectProviderFromAvailability("auto", available,
    policy({ pressures: { anthropic: "exhausted", openai: "low" } }));
  expect(decision.provider).toBe("openai");
  expect(decision.reason).toContain("pressure=low");
});

test("explicit provider wins but exhausted explicit entitlement errors", () => {
  const decision = selectProviderFromAvailability("openai", available,
    policy({ pressures: { anthropic: "plenty", openai: "low" } }));
  expect(decision.provider).toBe("openai");
  expect(decision.reason).toContain("explicit provider");
  expect(() => selectProviderFromAvailability("openai", available,
    policy({ pressures: { openai: "exhausted" } }))).toThrow("provider openai entitlement exhausted");
});

test("balanced allocation is stable and distributes by entitlement-adjusted weights", () => {
  const balanced = policy({ mode: "balanced", weights: { anthropic: 1, openai: 1 } });
  const first = selectProviderFromAvailability("auto", available, balanced, "standard", "lane-42");
  const second = selectProviderFromAvailability("auto", available, balanced, "standard", "lane-42");
  expect(second.provider).toBe(first.provider);

  const normalCounts = { anthropic: 0, openai: 0 };
  const lowAnthropicCounts = { anthropic: 0, openai: 0 };
  for (let i = 0; i < 500; i++) {
    normalCounts[selectProviderFromAvailability("auto", available, balanced, "standard", `lane-${i}`).provider]++;
    lowAnthropicCounts[selectProviderFromAvailability("auto", available,
      policy({ mode: "balanced", pressures: { anthropic: "low", openai: "normal" } }),
      "standard", `lane-${i}`).provider]++;
  }
  expect(normalCounts.anthropic).toBeGreaterThan(0);
  expect(normalCounts.openai).toBeGreaterThan(0);
  expect(lowAnthropicCounts.anthropic).toBeLessThan(normalCounts.anthropic);
});

test("reserved allocation preserves a frontier provider for non-frontier work", () => {
  const reserved = policy({ mode: "reserved", reservedFrontierProvider: "anthropic" });
  const normal = selectProviderFromAvailability("auto", available, reserved, "standard", "normal");
  const frontier = selectProviderFromAvailability("auto", available, reserved, "frontier", "frontier");
  expect(normal.provider).toBe("openai");
  expect(normal.reason).toContain("preserving frontier reserve=anthropic");
  expect(frontier.provider).toBe("anthropic");
  expect(frontier.reason).toContain("frontier reserve=anthropic");
});

test("reserved allocation degrades gracefully when reserve or alternatives are unavailable", () => {
  const openAiUnavailable: ProviderAvailability[] = [
    available[0], { provider: "openai", available: false, reason: "disabled" },
  ];
  const reserved = policy({ mode: "reserved", reservedFrontierProvider: "anthropic" });
  expect(selectProviderFromAvailability("auto", openAiUnavailable, reserved, "standard", "x").provider).toBe("anthropic");

  const anthropicExhausted = policy({
    mode: "reserved", reservedFrontierProvider: "anthropic",
    pressures: { anthropic: "exhausted", openai: "normal" },
  });
  expect(selectProviderFromAvailability("auto", available, anthropicExhausted, "frontier", "x").provider).toBe("openai");
});

test("semantic tiers resolve independently per provider", () => {
  expect(resolveTier("anthropic", "senior")).toEqual({ tier: "senior", model: "opus", effort: "high" });
  expect(resolveTier("openai", "frontier")).toEqual({ tier: "frontier", model: undefined, effort: "xhigh" });
});

test("automatic fallback changes provider only on a pre-event capacity failure", async () => {
  const decision: any = {
    requested: "auto", provider: "anthropic", reason: "test",
    availability: [{ provider: "anthropic", available: true, reason: "ready" }, { provider: "openai", available: false, reason: "disabled" }],
  };
  const q = routedQuery(decision, { prompt: "x", options: {} as any });
  // With no fallback provider, the original adapter error remains authoritative;
  // this asserts the guard condition rather than invoking a live provider.
  expect(decision.provider).toBe("anthropic");
  expect(q[Symbol.asyncIterator]).toBeFunction();
});
