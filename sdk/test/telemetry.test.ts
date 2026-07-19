import { expect, test } from "bun:test";
import { newRunId, runFacts } from "../src/telemetry";
import {
  assessThreadDelivery, RUN_BAR_EVIDENCE_VERSION, validRunEntity,
} from "../src/delivery-verification";
import { makeStruggleObserver, resolveStrugglePolicy } from "../src/struggle";

// Mirror of the fram coord_daemon log-split contract (coord_daemon.clj
// subject-token + default-telemetry-kinds). A subject routes to telemetry.log
// iff its stored `kind` OR — kind-less — the token before its first colon is in
// this allow-list. A run's body facts are written BEFORE its `kind run` commit
// marker, so during that window the run subject is kind-less and MUST carry a
// colon token to route correctly. A dash-form `@run-…` id has no colon → token
// undefined → its body facts misroute to coordination.log (the 2026-07-17
// regression). This guards the id format so that never recurs.
const TELEMETRY_KINDS = new Set(["run", "session", "mine", "guard_denial"]);
function subjectToken(subject: string): string | undefined {
  const s = subject.startsWith("@") ? subject : `@${subject}`;
  const colon = s.indexOf(":");
  return colon > 0 ? s.slice(1, colon) : undefined;
}

test("a minted run subject routes to telemetry.log before its kind marker lands", () => {
  for (const agent of ["lane-abc123", "sdk-spawn-mrok0z6m-165cef51", "codex-work"]) {
    const runId = newRunId(agent);
    // kind-less window: routing falls back to the first-colon token, which must
    // be an allow-listed telemetry kind or the body facts land in coordination.log.
    const token = subjectToken(runId);
    expect(token).toBe("run");
    expect(TELEMETRY_KINDS.has(token as string)).toBe(true);
    // and the id must still validate as a run entity (both `@run-`/`@run:` forms).
    expect(validRunEntity(`@${runId}`)).toBe(true);
  }
});

test("a completed run carries every mandatory terminal predicate", () => {
  // The dark-telemetry symptom (2026-07-17..20) was @run subjects reduced to a
  // lone `kind run`. A completed run MUST carry its terminal facts.
  const facts = runFacts({
    thread: "@2026-07-20-000000", agent: "lane-complete",
    tokenUsage: {
      inputTokens: 8794, outputTokens: 86323,
      cacheCreateTokens: 165477, cacheReadTokens: 10047431,
      total: 10308025, terminalCount: 1,
      terminalScope: "anthropic_result_terminal", totalStatus: "exact",
    },
    durationMs: 2171896, posture: "spawn", outcome: "ran", processOutcome: "ran",
  });
  const predicates = new Set(facts.map(([predicate]) => predicate));
  for (const mandatory of ["kind", "thread", "agent", "tokens", "duration_ms", "posture", "outcome", "at"]) {
    expect(predicates.has(mandatory)).toBe(true);
  }
  expect(facts).toContainEqual(["tokens", "10308025"]);
  expect(facts).toContainEqual(["outcome", "ran"]);
});

test("current run telemetry freezes judgment and the full effective detector policy", () => {
  const struggle = makeStruggleObserver(resolveStrugglePolicy("orchestrator", {
    STRUGGLE_ERROR_STREAK: "4",
    STRUGGLE_LOOP_REPEAT: "3",
    STRUGGLE_LOOP_WINDOW: "24",
    STRUGGLE_STALL_TURNS: "8",
    STRUGGLE_STALL_TURNS_ORCHESTRATOR: "16",
  }));
  const facts = runFacts({
    thread: "thread-grade", agent: "lane-grade", durationMs: 1,
    posture: "composite", outcome: "ran",
    judgmentGrade: { grade: "l", status: "valid", source: "thread" },
    struggleObservation: struggle.snapshot(),
  });
  for (const expected of [
    ["judgment_grade", "l"],
    ["judgment_grade_status", "valid"],
    ["judgment_grade_source", "thread"],
    ["struggle_detector_policy_version", "north:struggle-observer:v1"],
    ["struggle_topology", "orchestrator"],
    ["struggle_error_streak_threshold", "4"],
    ["struggle_loop_repeat_threshold", "3"],
    ["struggle_loop_window", "24"],
    ["struggle_no_progress_turn_threshold", "16"],
    ["error_count", "0"],
  ]) expect(facts).toContainEqual(expected);

  const adHoc = runFacts({
    thread: "(ad-hoc)", agent: "lane-ad-hoc", durationMs: 1,
    posture: "spawn", outcome: "ran",
    judgmentGrade: { status: "unavailable", source: "ad-hoc" },
    struggleObservation: makeStruggleObserver(resolveStrugglePolicy("worker", {})).snapshot(),
  });
  expect(adHoc).toContainEqual(["judgment_grade_status", "unavailable"]);
  expect(adHoc).toContainEqual(["judgment_grade_source", "ad-hoc"]);
  expect(adHoc.some(([predicate]) => predicate === "judgment_grade")).toBe(false);
});

test("telemetry rejects internally inconsistent observation snapshots", () => {
  const base = {
    thread: "thread", agent: "lane", durationMs: 1, posture: "atomic", outcome: "ran",
    struggleObservation: makeStruggleObserver(resolveStrugglePolicy("worker", {})).snapshot(),
  };
  expect(() => runFacts({
    ...base,
    judgmentGrade: { grade: "s", status: "unavailable", source: "thread" } as any,
  })).toThrow("invalid run-local judgment_grade snapshot");
  expect(() => runFacts({
    ...base,
    judgmentGrade: { status: "unavailable", source: "ad-hoc" },
    struggleObservation: { ...base.struggleObservation, loopWindow: 2, loopRepeatThreshold: 3 },
  })).toThrow("exceeds loop window");
});

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

test("run telemetry persists structured exact-model availability evidence", () => {
  const facts = runFacts({
    thread: "thread-model", agent: "lane-model", durationMs: 2,
    posture: "spawn", outcome: "ran", provider: "anthropic",
    providerTarget: "claude-personal", model: "claude-fable-5",
    modelAvailability: {
      provider: "anthropic", targetId: "claude-personal", authMode: "ambient",
      model: "claude-fable-5", observedAt: "2026-07-20T10:00:00.000Z",
      source: "claude-agent-sdk:Query.supportedModels",
      observationDigest: "a".repeat(64),
    },
  });
  expect(facts).toContainEqual(["provider_target", "claude-personal"]);
  expect(facts).toContainEqual(["model", "claude-fable-5"]);
  expect(facts).toContainEqual(["model_availability_target", "claude-personal"]);
  expect(facts).toContainEqual(["model_availability_source", "claude-agent-sdk:Query.supportedModels"]);
  expect(facts).toContainEqual(["model_availability_observed_at", "2026-07-20T10:00:00.000Z"]);
  expect(facts).toContainEqual(["model_availability_model", "claude-fable-5"]);
  expect(facts).toContainEqual(["model_availability_digest", "a".repeat(64)]);
  expect(() => runFacts({
    thread: "thread-model", agent: "lane-model", durationMs: 2,
    posture: "spawn", outcome: "ran", provider: "anthropic",
    providerTarget: "claude-personal", model: "claude-opus-4-8",
    modelAvailability: {
      provider: "anthropic", targetId: "claude-personal", authMode: "ambient",
      model: "claude-fable-5", observedAt: "2026-07-20T10:00:00.000Z",
      source: "claude-agent-sdk:Query.supportedModels",
      observationDigest: "a".repeat(64),
    },
  })).toThrow("does not match the final provider route");
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

test("reported run telemetry carries the exact evidence snapshot and digest", () => {
  const assessment = assessThreadDelivery("thread", "agent", [
    { predicate: "done_when", value: "tests pass" },
  ], [
    { predicate: "done_when", value: "tests pass" },
  ], "run-agent", [{
    version: RUN_BAR_EVIDENCE_VERSION,
    run: "@run-agent",
    thread: "@thread",
    reporter: "@agent:agent",
    bar: "tests pass",
    observed: "exit 0",
    recordedAt: "2026-07-18T10:00:00.000Z",
  }]);
  if (assessment.deliveryOutcome !== "reported") throw new Error("expected reported");
  const facts = runFacts({
    thread: "thread", agent: "agent", durationMs: 1, posture: "atomic",
    outcome: "ran", processOutcome: "ran",
    deliveryOutcome: assessment.deliveryOutcome,
    deliveryReason: assessment.deliveryReason,
    deliveryProof: assessment.proof,
  }, "2026-07-18T10:00:01.000Z");
  expect(facts).toContainEqual(["delivery_outcome", "reported"]);
  expect(facts).toContainEqual(["delivery_evidence", assessment.proof.deliveryEvidence]);
  expect(facts).toContainEqual([
    "delivery_evidence_sha256",
    assessment.proof.deliveryEvidenceSha256,
  ]);
  expect(facts.some(([predicate]) => predicate === "delivery_attestation")).toBe(false);
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
