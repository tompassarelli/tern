import { expect, test } from "bun:test";
import { runFacts } from "../src/telemetry";

test("run telemetry is token- and routing-based with no price-derived fields", () => {
  expect(runFacts({
    thread: "thread-1",
    agent: "lane-1",
    tokens: 321,
    durationMs: 45,
    posture: "spawn",
    outcome: "ran",
    provider: "openai",
  }, "2026-07-16T00:00:00.000Z")).toEqual([
    ["kind", "run"],
    ["thread", "thread-1"],
    ["agent", "lane-1"],
    ["tokens", "321"],
    ["duration_ms", "45"],
    ["posture", "spawn"],
    ["outcome", "ran"],
    ["at", "2026-07-16T00:00:00.000Z"],
    ["provider", "openai"],
  ]);
});

test("run telemetry preserves requested, active, and fallback account targets", () => {
  const facts = runFacts({
    thread: "thread-target", agent: "lane-target", durationMs: 2, posture: "spawn", outcome: "ran",
    provider: "openai", providerTarget: "codex-work", requestedProvider: "auto",
    requestedTarget: "claude-personal", fallbackPath: ["anthropic", "openai"],
    fallbackTargetPath: ["claude-personal", "codex-work"],
    providerReason: "mode=preferential; target=claude-personal; pressure=normal; order=claude-personal -> codex-work",
    allocationMode: "preferential", entitlementPressure: "low",
    fallbackReasons: [{ sequence: 1, reason: "provider_retry_safe_before_acceptance",
      fromTarget: "claude-personal", fromProvider: "anthropic",
      toTarget: "codex-work", toProvider: "openai" }],
  });
  expect(facts).toContainEqual(["provider_target", "codex-work"]);
  expect(facts).toContainEqual(["requested_provider", "auto"]);
  expect(facts).toContainEqual(["requested_target", "claude-personal"]);
  expect(facts).toContainEqual(["fallback_target_path", "claude-personal -> codex-work"]);
  expect(facts).toContainEqual(["provider_reason", "mode=preferential; target=claude-personal; pressure=normal; order=claude-personal -> codex-work"]);
  expect(facts).toContainEqual(["allocation_mode", "preferential"]);
  expect(facts).toContainEqual(["entitlement_pressure", "low"]);
  expect(facts.filter(([predicate]) => predicate === "fallback_reason")).toEqual([["fallback_reason", JSON.stringify({
    sequence: 1, reason: "provider_retry_safe_before_acceptance",
    fromTarget: "claude-personal", fromProvider: "anthropic",
    toTarget: "codex-work", toProvider: "openai",
  })]]);
});

test("run telemetry separates wall time, provider time, process terminal, and delivery truth", () => {
  const facts = runFacts({
    thread: "thread-terminal", agent: "lane-terminal",
    durationMs: 1250, providerDurationMs: 900,
    posture: "spawn", outcome: "ran", processOutcome: "ran",
    deliveryOutcome: "unverified",
    deliveryReason: "provider_terminal_success_without_external_verification",
  });
  expect(facts).toContainEqual(["duration_ms", "1250"]);
  expect(facts).toContainEqual(["provider_duration_ms", "900"]);
  expect(facts).toContainEqual(["process_outcome", "ran"]);
  expect(facts).toContainEqual(["delivery_outcome", "unverified"]);
  expect(facts).toContainEqual([
    "delivery_reason", "provider_terminal_success_without_external_verification",
  ]);
});

test("run telemetry preserves each exact observed token component once", () => {
  const facts = runFacts({
    thread: "thread-2",
    agent: "lane-2",
    tokens: 200,
    tokenUsage: {
      inputTokens: 101,
      outputTokens: 23,
      cacheCreateTokens: 17,
      cacheReadTokens: 59,
      total: 200,
      terminalCount: 1,
      terminalScope: "anthropic_result_terminal",
      totalStatus: "exact",
    },
    durationMs: 45,
    posture: "spawn",
    outcome: "ran",
  }, "2026-07-16T00:00:00.000Z");

  expect(facts.filter(([predicate]) => predicate === "tokens")).toEqual([["tokens", "200"]]);
  expect(facts.filter(([predicate]) => predicate.endsWith("_tokens"))).toEqual([
    ["input_tokens", "101"],
    ["output_tokens", "23"],
    ["cache_create_tokens", "17"],
    ["cache_read_tokens", "59"],
  ]);
  expect(facts).toContainEqual(["usage_terminal_count", "1"]);
  expect(facts).toContainEqual(["usage_scope", "anthropic_result_terminal"]);
  expect(facts).toContainEqual(["usage_total_status", "exact"]);
});

test("run telemetry omits terminal components that were not observed", () => {
  const facts = runFacts({
    thread: "thread-3",
    agent: "lane-3",
    tokenUsage: { inputTokens: 7, terminalCount: 1,
      terminalScope: "anthropic_result_terminal", totalStatus: "unknown_incomplete_terminal" },
    durationMs: 0,
    posture: "atomic",
    outcome: "ran",
  });

  expect(facts).toContainEqual(["input_tokens", "7"]);
  expect(facts.some(([predicate]) => predicate === "tokens")).toBe(false);
  expect(facts.some(([predicate]) => predicate === "output_tokens")).toBe(false);
  expect(facts.some(([predicate]) => predicate.startsWith("cache_") && predicate.endsWith("_tokens"))).toBe(false);
});

test("Codex subset counters are retained without changing its adapter-owned total", () => {
  const facts = runFacts({
    thread: "thread-4", agent: "lane-4", tokens: 999,
    tokenUsage: {
      inputTokens: 100, cachedInputTokens: 60,
      outputTokens: 20, reasoningOutputTokens: 7,
      total: 120, terminalCount: 1,
      terminalScope: "codex_fresh_invocation_thread_cumulative", totalStatus: "exact",
    },
    durationMs: 1, posture: "spawn", outcome: "ran",
  });
  expect(facts).toContainEqual(["tokens", "120"]);
  expect(facts).toContainEqual(["cached_input_tokens", "60"]);
  expect(facts).toContainEqual(["reasoning_output_tokens", "7"]);
  expect(facts).not.toContainEqual(["tokens", "999"]);
});

test("zero and repeated terminals remain queryable without a fabricated token total", () => {
  for (const tokenUsage of [
    { terminalCount: 0, totalStatus: "unknown_no_terminal" as const },
    { terminalCount: 2, terminalScope: "anthropic_result_terminal" as const,
      totalStatus: "unknown_repeated_terminal" as const },
  ]) {
    const facts = runFacts({ thread: "thread-u", agent: "lane-u", tokenUsage,
      tokens: 0,
      durationMs: 0, posture: "spawn", outcome: "died" });
    expect(facts.some(([predicate]) => predicate === "tokens")).toBe(false);
    expect(facts).toContainEqual(["usage_terminal_count", String(tokenUsage.terminalCount)]);
    expect(facts).toContainEqual(["usage_total_status", tokenUsage.totalStatus]);
  }
});
