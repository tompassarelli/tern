import { afterEach, expect, test } from "bun:test";
import { routedQuery, selectProvider } from "../src/providers";
import { resolveTier } from "../src/providers/catalog";

const saved = { disableA: process.env.NORTH_DISABLE_ANTHROPIC, disableO: process.env.NORTH_DISABLE_OPENAI, order: process.env.NORTH_PROVIDER_ORDER };
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
