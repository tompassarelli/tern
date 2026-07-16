import { afterEach, beforeEach, expect, test } from "bun:test";
import { ProviderRetrySafeError, routedQuery, selectProvider, selectProviderFromAvailability } from "../src/providers";
import type { AgentProvider, ProviderAvailability, ProviderId, ResourcePolicy } from "../src/providers/types";
import { resolveTier } from "../src/providers/catalog";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MANAGED_ENV = [
  "NORTH_DISABLE_ANTHROPIC", "NORTH_DISABLE_OPENAI", "NORTH_PROVIDER_ORDER",
  "NORTH_ROUTING_POLICY", "NORTH_PROVIDER_OBSERVATIONS", "NORTH_ALLOCATION_MODE",
  "NORTH_PROVIDER_WEIGHTS", "NORTH_RESERVED_FRONTIER_PROVIDER",
  "NORTH_FABLE_NOW",
  "NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE", "NORTH_OPENAI_ENTITLEMENT_PRESSURE",
] as const;
const saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]])) as Record<typeof MANAGED_ENV[number], string | undefined>;
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
beforeEach(() => {
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env.NORTH_ROUTING_POLICY = join(tmpdir(), `north-test-absent-policy-${process.pid}.json`);
  process.env.NORTH_PROVIDER_OBSERVATIONS = join(tmpdir(), `north-test-absent-observations-${process.pid}.json`);
});
afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
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
  expect(resolveTier("openai", "frontier")).toEqual({ tier: "frontier", model: "gpt-5.6-sol", effort: "xhigh" });
});

test("temporary Fable promotion is Anthropic-only at the semantic frontier", () => {
  process.env.NORTH_FABLE_NOW = "2026-07-19T00:00:00Z";
  expect(resolveTier("anthropic", "frontier")).toEqual({ tier: "frontier", model: "fable", effort: "high" });
  expect(resolveTier("anthropic", "frontier", undefined, "xhigh")).toEqual({ tier: "frontier", model: "fable", effort: "high" });
  expect(resolveTier("anthropic", "frontier", "opus", "xhigh")).toEqual({ tier: "frontier", model: "opus", effort: "xhigh" });
  expect(resolveTier("openai", "frontier")).toEqual({ tier: "frontier", model: "gpt-5.6-sol", effort: "xhigh" });
  process.env.NORTH_FABLE_NOW = "2026-07-20T07:00:00Z";
  expect(resolveTier("anthropic", "frontier")).toEqual({ tier: "frontier", model: "opus", effort: "xhigh" });
});

function fakeProvider(id: ProviderId, query: AgentProvider["query"]): AgentProvider {
  return { id, probe: () => ({ provider: id, available: true, reason: "ready" }), query };
}

async function eventsOf(query: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of query) events.push(event);
  return events;
}

test("automatic fallback routes Anthropic to OpenAI and re-resolves the same tier", async () => {
  const decision = selectProviderFromAvailability("auto", available, policy(), "frontier");
  const calls: Array<{ provider: ProviderId; args: any }> = [];
  const prompt = "preserve this prompt";
  const registry = {
    anthropic: fakeProvider("anthropic", (args) => ({ async *[Symbol.asyncIterator]() {
      calls.push({ provider: "anthropic", args });
      throw new ProviderRetrySafeError("subscription usage limit reached before acceptance");
    }})),
    openai: fakeProvider("openai", (args) => ({ async *[Symbol.asyncIterator]() {
      calls.push({ provider: "openai", args });
      yield { type: "result", result: "ok" };
    }})),
  };

  expect(await eventsOf(routedQuery(decision, {
    prompt, options: { model: "fable", effort: "high", systemPrompt: "keep system" } as any,
  }, "frontier", registry))).toEqual([{ type: "result", result: "ok" }]);
  expect(calls.map((call) => call.provider)).toEqual(["anthropic", "openai"]);
  expect(calls[1].args.prompt).toBe(prompt);
  expect(calls[1].args.options.systemPrompt).toBe("keep system");
  expect(calls[1].args.options.model).toBe("gpt-5.6-sol");
  expect(calls[1].args.options.effort).toBe("xhigh");
  expect(decision.provider).toBe("openai");
  expect(decision.fallbackCount).toBe(1);
  expect(decision.fallbackPath).toEqual(["anthropic", "openai"]);
  expect(decision.reason).toContain("anthropic -> openai");
  expect(decision.resolvedModel).toBe(calls[1].args.options.model);
  expect(decision.resolvedEffort).toBe(calls[1].args.options.effort);
});

test("automatic fallback routes OpenAI to Anthropic and removes OpenAI dials", async () => {
  const decision = selectProviderFromAvailability("auto", available,
    policy({ providerOrder: ["openai", "anthropic"] }), "senior");
  let fallbackArgs: any;
  const registry = {
    openai: fakeProvider("openai", () => ({ async *[Symbol.asyncIterator]() {
      throw new ProviderRetrySafeError("authentication required before acceptance");
    }})),
    anthropic: fakeProvider("anthropic", (args) => ({ async *[Symbol.asyncIterator]() {
      fallbackArgs = args;
      yield { type: "result", result: "ok" };
    }})),
  };

  await eventsOf(routedQuery(decision, {
    prompt: "x", options: { model: "gpt-5.6-sol", effort: "xhigh", systemPrompt: "system" } as any,
  }, "senior", registry));
  expect(fallbackArgs.options.model).toBe("opus");
  expect(fallbackArgs.options.effort).toBe("high");
  expect(fallbackArgs.options.systemPrompt).toBe("system");
  expect(decision.fallbackPath).toEqual(["openai", "anthropic"]);
});

test("fallback replays a streaming prompt consumed by the failed provider", async () => {
  const decision = selectProviderFromAvailability("auto", available, policy(), "standard");
  const received: Record<string, string[]> = { anthropic: [], openai: [] };
  const consumeOne = async (provider: ProviderId, prompt: string | AsyncIterable<any>) => {
    if (typeof prompt === "string") return prompt;
    const item = await prompt[Symbol.asyncIterator]().next();
    received[provider].push(item.value.message.content);
  };
  const registry = {
    anthropic: fakeProvider("anthropic", (args) => ({ async *[Symbol.asyncIterator]() {
      await consumeOne("anthropic", args.prompt);
      throw new ProviderRetrySafeError("capacity unavailable before acceptance");
    }})),
    openai: fakeProvider("openai", (args) => ({ async *[Symbol.asyncIterator]() {
      await consumeOne("openai", args.prompt);
      yield { type: "result", result: "ok" };
    }})),
  };
  const prompt = { async *[Symbol.asyncIterator]() {
    yield { type: "user", message: { content: "same payload" } };
  }};

  await eventsOf(routedQuery(decision, { prompt, options: {} as any }, "standard", registry));
  expect(received).toEqual({ anthropic: ["same payload"], openai: ["same payload"] });
});

test("automatic routing never retries after the first emitted event", async () => {
  const decision = selectProviderFromAvailability("auto", available, policy(), "standard");
  let fallbackCalls = 0;
  const registry = {
    anthropic: fakeProvider("anthropic", () => ({ async *[Symbol.asyncIterator]() {
      yield { type: "assistant", text: "observable" };
      throw new Error("capacity exhausted");
    }})),
    openai: fakeProvider("openai", () => { fallbackCalls++; return { async *[Symbol.asyncIterator]() {} }; }),
  };

  const seen: any[] = [];
  await expect(async () => {
    for await (const event of routedQuery(decision, { prompt: "x", options: {} as any }, "standard", registry)) seen.push(event);
  }).toThrow("capacity exhausted");
  expect(seen).toHaveLength(1);
  expect(fallbackCalls).toBe(0);
  expect(decision.fallbackCount).toBe(0);
  expect(decision.fallbackPath).toEqual(["anthropic"]);
});

test("automatic routing never infers retry safety from matching error prose", async () => {
  const decision = selectProviderFromAvailability("auto", available, policy(), "standard");
  let fallbackCalls = 0;
  const registry = {
    anthropic: fakeProvider("anthropic", () => ({ async *[Symbol.asyncIterator]() {
      throw new Error("authentication required: capacity unavailable");
    }})),
    openai: fakeProvider("openai", () => { fallbackCalls++; return { async *[Symbol.asyncIterator]() {} }; }),
  };
  await expect(eventsOf(routedQuery(decision, { prompt: "x", options: {} as any }, "standard", registry)))
    .rejects.toThrow("authentication required");
  expect(fallbackCalls).toBe(0);
  expect(decision.fallbackCount).toBe(0);
});

test("an explicit provider never receives a fallback route", async () => {
  const decision = selectProviderFromAvailability("anthropic", available, policy(), "standard");
  let fallbackCalls = 0;
  const registry = {
    anthropic: fakeProvider("anthropic", () => ({ async *[Symbol.asyncIterator]() {
      throw new Error("rate limit reached");
    }})),
    openai: fakeProvider("openai", () => { fallbackCalls++; return { async *[Symbol.asyncIterator]() {} }; }),
  };

  expect(decision.fallbackProviders).toEqual([]);
  await expect(eventsOf(routedQuery(decision, { prompt: "x", options: {} as any }, "standard", registry)))
    .rejects.toThrow("rate limit reached");
  expect(fallbackCalls).toBe(0);
  expect(decision.fallbackCount).toBe(0);
  expect(decision.fallbackPath).toEqual(["anthropic"]);
});

test("fallback admission runs before the fallback provider has side effects", async () => {
  const decision = selectProviderFromAvailability("auto", available, policy(), "standard");
  let fallbackCalls = 0;
  const registry = {
    anthropic: fakeProvider("anthropic", () => ({ async *[Symbol.asyncIterator]() {
      throw new ProviderRetrySafeError("capacity unavailable before acceptance");
    }})),
    openai: fakeProvider("openai", () => { fallbackCalls++; return { async *[Symbol.asyncIterator]() {} }; }),
  };
  await expect(eventsOf(routedQuery(
    decision, { prompt: "x", options: {} as any }, "standard", registry,
    async () => { throw new Error("resource envelope month:2026-07 exhausted: retries 1/1"); },
  ))).rejects.toThrow("retries 1/1");
  expect(fallbackCalls).toBe(0);
  expect(decision.fallbackCount).toBe(0);
  expect(decision.fallbackPath).toEqual(["anthropic"]);
});
