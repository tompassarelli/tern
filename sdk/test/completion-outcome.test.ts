// Reaper false-positive fix (thread 019f6af0-ba69): a finishing lane publishes
// its process/delivery terminal on @agent:<id> synchronously. Production commits
// that projection with a digest marker; the capture fake below asserts its body.
// A committed kind=run row is only a secondary trail.
//
// Hermetic: a fake `north` on PATH + NORTH_BIN captures every tell to a temp log; the
// injected queryFn owns the whole SDK boundary, so no live coordinator / network / model.
// This is the same fake-engine pattern as spawn-boundary.test.ts.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProviderRetrySafeError } from "../src/providers";
import { RUN_BAR_EVIDENCE_VERSION } from "../src/delivery-verification";
import type { DeliveryRunContext } from "../src/delivery-evidence";

let dir: string;
let log: string;

const MANAGED_ENV = [
  "PATH", "NORTH_BIN", "NORTH_IDENTITY_TEST_REDIRECT", "NORTH_PORT", "NORTH_STREAM_DIR", "AGENT_LAWS", "AGENT_PRAXIS",
  "AGENT_ID", "NORTH_AGENT_ID", "AGENT_COORDINATOR", "AGENT_MODEL", "AGENT_ROLE", "AGENT_EFFORT",
  "AGENT_IDENTITY_ROLE", "AGENT_TARGET",
  "AGENT_TIER", "AGENT_REASONING", "AGENT_POSTURE", "AGENT_TOPOLOGY", "AGENT_TASK_GRADE",
  "AGENT_DOMAIN_REQUIREMENTS", "AGENT_COMPOSITION", "NORTH_FABLE_NOW",
  "NORTH_ROUTING_POLICY", "NORTH_ENVELOPE_ACCOUNTING",
  "NORTH_PROVIDER_OBSERVATIONS", "NORTH_ALLOCATION_MODE", "NORTH_PROVIDER_ORDER",
  "NORTH_PROVIDER_WEIGHTS", "NORTH_RESERVED_FRONTIER_PROVIDER",
  "NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE", "NORTH_OPENAI_ENTITLEMENT_PRESSURE",
] as const;
const origEnv: Record<string, string | undefined> = {};
for (const k of MANAGED_ENV) origEnv[k] = process.env[k];

const TEST_COORDINATOR = `test-coordinator-${process.pid}`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "north-completion-"));
  log = join(dir, "north.log");
  const fake = join(dir, "north");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
  chmodSync(fake, 0o755);

  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.NORTH_BIN = fake;
  process.env.NORTH_IDENTITY_TEST_REDIRECT = "1";
  process.env.NORTH_PORT = "59999"; // unused -> any stray bb write silently no-ops
  process.env.NORTH_STREAM_DIR = dir;
  process.env.AGENT_LAWS = "off";
  process.env.AGENT_PRAXIS = "off";
  process.env.NORTH_ROUTING_POLICY = join(dir, "absent-routing-policy.json");
  process.env.NORTH_PROVIDER_OBSERVATIONS = join(dir, "absent-provider-observations.json");
  delete process.env.NORTH_ALLOCATION_MODE;
  delete process.env.NORTH_PROVIDER_ORDER;
  delete process.env.NORTH_PROVIDER_WEIGHTS;
  delete process.env.NORTH_RESERVED_FRONTIER_PROVIDER;
  delete process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE;
  delete process.env.NORTH_OPENAI_ENTITLEMENT_PRESSURE;
  delete process.env.AGENT_ID;
  delete process.env.NORTH_AGENT_ID;
  delete process.env.AGENT_MODEL;
  delete process.env.AGENT_ROLE;
  delete process.env.AGENT_IDENTITY_ROLE;
  delete process.env.AGENT_EFFORT;
  delete process.env.AGENT_TIER;
  delete process.env.AGENT_REASONING;
  delete process.env.AGENT_POSTURE;
  delete process.env.AGENT_TOPOLOGY;
  delete process.env.AGENT_TASK_GRADE;
  delete process.env.AGENT_DOMAIN_REQUIREMENTS;
  delete process.env.AGENT_COMPOSITION;
  delete process.env.AGENT_TARGET;
  process.env.AGENT_COORDINATOR = TEST_COORDINATOR;
});

afterAll(() => {
  for (const k of MANAGED_ENV) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test("a clean-finishing lane records outcome=ran ON the lane entity (@agent:<id>)", async () => {
  const { spawn } = await import("../src/spawn");
  let interrupts = 0;

  // Fake SDK query: one assistant turn, then a terminal `result` (subtype success) — the
  // clean-finish shape. spawn finalizes outcome=ran and must stamp it on @agent:<id>.
  const cleanQuery: any = () => ({
    interrupt: async () => { interrupts++; },
    async *[Symbol.asyncIterator]() {
      yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working" }] } };
      yield { type: "result", subtype: "success", result: "task done", duration_ms: 1, num_turns: 1 };
    },
  });

  const result = await spawn({
    prompt: "do a bounded task", agentId: "test-done-ok", role: "integrator", queryFn: cleanQuery,
  });
  expect(result).toBe("task done");
  expect(interrupts).toBe(1);

  expect(existsSync(log)).toBe(true);
  const logged = readFileSync(log, "utf8");
  // The terminal body lands on the lane via the NORTH_BIN-honoring sync write.
  // Coordinator integration separately proves the production digest marker.
  expect(logged).toContain("tell agent:test-done-ok outcome ran");
  expect(logged).toContain("tell agent:test-done-ok process_outcome ran");
  expect(logged).toContain("tell agent:test-done-ok delivery_outcome unverified");
  expect(logged).toContain(
    "tell agent:test-done-ok delivery_reason provider_terminal_success_without_external_verification",
  );
});

test("a lane that dies mid-stream records outcome=died ON the lane entity (reported, not silent)", async () => {
  const { spawn } = await import("../src/spawn");

  // The SDK subprocess dies mid-turn (real exitError shape). The finally path runs, so this
  // is a REPORTED death: outcome=died on @agent:<id> alongside the agent_death fact. The
  // reactor then skips its committed terminal — died-unreported is reserved for
  // a hard-kill (or torn publication) with no committed terminal evidence.
  const dyingQuery: any = () =>
    (async function* () {
      yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "starting" }] } };
      throw new Error("Claude Code process terminated by signal 9");
    })();

  await spawn({ prompt: "dies", agentId: "test-done-died", role: "integrator", queryFn: dyingQuery });

  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("tell agent:test-done-died outcome died");
  expect(logged).toContain("tell agent:test-done-died process_outcome died");
  expect(logged).toContain("tell agent:test-done-died delivery_outcome blocked");
  expect(logged).toContain("tell @swarm agent_death"); // death path still fires
});

test("a synchronous provider-construction failure closes lifecycle state and the billable clock", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");

  const result = await spawn({
    prompt: "fail while constructing the provider query",
    agentId: "test-sync-construction-failure",
    role: "integrator",
    thread: "thread-sync-construction",
    queryFn: () => { throw new Error("synchronous adapter construction failure"); },
  });

  expect(result).toBe("");
  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("clock start thread-sync-construction");
  expect(logged).toContain("tell @swarm agent_death");
  expect(logged).toContain("tell agent:test-sync-construction-failure outcome died");
  expect(logged).toContain("clock orphan test-sync-construction-failure");
});

test("an Anthropic error terminal still records its authoritative usage", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  const queryFn: any = () => (async function* () {
    yield {
      type: "result", subtype: "error_during_execution", is_error: true,
      duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 11, output_tokens: 3,
        cache_creation_input_tokens: 2, cache_read_input_tokens: 5 },
    };
  })();

  await spawn({ prompt: "terminal error usage", agentId: "test-terminal-error",
    role: "integrator", provider: "anthropic", queryFn });
  await waitForLog("tell run:test-terminal-error-");
  await waitForLog("usage_total_status exact");
  const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.includes("run:test-terminal-error-"));
  expect(lines.some((line) => line.endsWith(" tokens 21"))).toBe(true);
  expect(lines.some((line) => line.endsWith(" usage_terminal_count 1"))).toBe(true);
});

test("repeated Anthropic terminals record ambiguity without a selected or summed usage", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  const queryFn: any = () => (async function* () {
    yield { type: "system", subtype: "task_started", task_id: "bg-1" };
    yield { type: "result", subtype: "success", result: "first", duration_ms: 1, num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    yield { type: "system", subtype: "task_notification", task_id: "bg-1", status: "completed" };
    yield { type: "result", subtype: "success", result: "second", duration_ms: 2, num_turns: 2,
      usage: { input_tokens: 20, output_tokens: 4,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  })();

  await spawn({ prompt: "two terminal scopes", agentId: "test-repeated-terminals",
    role: "integrator", provider: "anthropic", queryFn });
  await waitForLog("usage_total_status unknown_repeated_terminal");
  const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.includes("run:test-repeated-terminals-"));
  expect(lines.some((line) => line.endsWith(" usage_terminal_count 2"))).toBe(true);
  expect(lines.some((line) => / (tokens|input_tokens|output_tokens) /.test(line))).toBe(false);
});

test("an empty spawn provider stream is a blocked provider error, never ran", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");

  const result = await spawn({
    prompt: "provider stream closes without a terminal", agentId: "test-empty-spawn",
    role: "integrator",
    queryFn: () => (async function* () {})(),
  });

  expect(result).toBe("");
  const lines = await settledRunLines("test-empty-spawn");
  expect(lines.some((line) => line.endsWith(" process_outcome provider_error"))).toBe(true);
  expect(lines.some((line) => line.endsWith(" delivery_outcome blocked"))).toBe(true);
});

test("an empty dispatch provider stream is a blocked provider error, never ran", async () => {
  const { dispatch } = await import("../src/dispatch");
  writeFileSync(log, "");
  const boundaryIds: string[] = [];

  const result = await dispatch("@test-empty-dispatch", {
    agentId: "test-empty-dispatch-agent",
    routingMetadata: { role: "integrator" },
    claimDriver: ((threadId: string) => {
      boundaryIds.push(`driver:${threadId}`);
      return { release() {} };
    }) as any,
    queryFn: () => (async function* () {})() as any,
    loadThreadFacts: (threadId: string) => {
      boundaryIds.push(`facts:${threadId}`);
      return [
        { predicate: "title", value: "Empty provider dispatch" },
        { predicate: "planned", value: "true" },
        { predicate: "atomic", value: "true" },
      ];
    },
    loadChildren: (threadId: string) => {
      boundaryIds.push(`children:${threadId}`);
      return [];
    },
  });

  expect(result.result).toBe("");
  expect(result.threadId).toBe("test-empty-dispatch");
  expect(boundaryIds).toEqual([
    "facts:test-empty-dispatch",
    "children:test-empty-dispatch",
    "driver:test-empty-dispatch",
  ]);
  const lines = await settledRunLines(
    "test-empty-dispatch-agent", "applied_domain_requirement_count 0",
  );
  expect(lines.some((line) => line.endsWith(" process_outcome provider_error"))).toBe(true);
  expect(lines.some((line) => line.endsWith(" delivery_outcome blocked"))).toBe(true);
  expect(lines.some((line) => line.includes("@@test-empty-dispatch"))).toBe(false);
});

test("dispatch warns a committed thread that lacks BOTH done_when and judgment_grade", async () => {
  const { dispatch } = await import("../src/dispatch");
  writeFileSync(log, "");
  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => { captured.push(args.join(" ")); };
  try {
    await dispatch("@test-warn-thread", {
      agentId: "test-warn-thread-agent",
      routingMetadata: { role: "integrator" },
      claimDriver: (() => ({ release() { return true; } })) as any,
      queryFn: () => (async function* () {})() as any,
      loadThreadFacts: () => [
        { predicate: "title", value: "Bar-less grade-less thread" },
        { predicate: "committed", value: "2026-07-20" },
        { predicate: "planned", value: "true" },
        { predicate: "atomic", value: "true" },
      ],
      loadChildren: () => [],
    });
  } finally {
    console.log = originalLog;
  }
  const doneWhenWarn = captured.find((l) => l.includes("has NO done_when"));
  const gradeWarn = captured.find((l) => l.includes("has NO judgment_grade"));
  expect(doneWhenWarn).toBeDefined();
  expect(gradeWarn).toBeDefined();
  originalLog(`[bar-evidence] ${doneWhenWarn}`);
  originalLog(`[bar-evidence] ${gradeWarn}`);
});

test("an MCP-preclaimed terminal thread verifies and safely releases before returning", async () => {
  const { dispatch } = await import("../src/dispatch");
  const events: string[] = [];
  const dependencies = {
    agentId: "test-preclaimed-terminal-agent",
    driverOptions: { preclaimed: true },
    loadThreadFacts: (threadId: string) => {
      events.push(`facts:${threadId}`);
      return [
        { predicate: "title", value: "Already terminal" },
        { predicate: "outcome", value: "done" },
      ];
    },
    loadChildren: (threadId: string) => {
      events.push(`children:${threadId}`);
      return [];
    },
    claimDriver: ((threadId: string, agentId: string) => {
      events.push(`verify:${threadId}:${agentId}`);
      return {
        release() {
          events.push(`release:${threadId}:${agentId}`);
          return true;
        },
      };
    }) as any,
  };
  const result = await dispatch("@test-preclaimed-terminal", dependencies);
  expect(result).toEqual({
    threadId: "test-preclaimed-terminal",
    posture: "atomic",
    result: "already done",
  });
  expect(events).toEqual([
    "facts:test-preclaimed-terminal",
    "children:test-preclaimed-terminal",
    "verify:test-preclaimed-terminal:test-preclaimed-terminal-agent",
    "release:test-preclaimed-terminal:test-preclaimed-terminal-agent",
  ]);

  let directClaims = 0;
  await dispatch("test-direct-terminal", {
    loadThreadFacts: () => [
      { predicate: "title", value: "Direct terminal" },
      { predicate: "outcome", value: "done" },
    ],
    loadChildren: () => [],
    claimDriver: (() => {
      directClaims++;
      return { release: () => true };
    }) as any,
  });
  expect(directClaims).toBe(0);

  await expect(dispatch("test-preclaimed-release-failure", {
    agentId: "test-preclaimed-release-failure-agent",
    driverOptions: { preclaimed: true },
    loadThreadFacts: () => [
      { predicate: "title", value: "Terminal with unavailable release" },
      { predicate: "outcome", value: "done" },
    ],
    loadChildren: () => [],
    claimDriver: (() => ({ release: () => false })) as any,
  })).rejects.toMatchObject({
    name: "DispatchDriverReleaseError",
    threadId: "test-preclaimed-release-failure",
    preSideEffect: false,
    retrySafe: false,
  });
});

test("dispatch rejects malformed and injection-shaped ids before every read boundary", async () => {
  const { dispatch } = await import("../src/dispatch");
  for (const invalid of [
    "", "@", "@@test-thread", " test-thread", "test-thread;touch-owned",
    "test-thread$(touch-owned)", "test-thread\nother",
  ]) {
    let reads = 0;
    await expect(dispatch(invalid, {
      loadThreadFacts: () => {
        reads++;
        return [{ predicate: "title", value: "must not be read" }];
      },
      loadChildren: () => {
        reads++;
        return [];
      },
    })).rejects.toMatchObject({
      code: "NORTH_INVALID_ENTITY_ID",
      preSideEffect: true,
    });
    expect(reads).toBe(0);
  }
});

test("dispatch publishes newly observed done-bar evidence as reported, never self-verified", async () => {
  const { dispatch } = await import("../src/dispatch");
  writeFileSync(log, "");
  const baseline = [
    { predicate: "title", value: "Proof-carrying delivery" },
    { predicate: "planned", value: "true" },
    { predicate: "atomic", value: "true" },
    { predicate: "done_when", value: "focused tests pass" },
  ];
  let reads = 0;
  let reserved: DeliveryRunContext | undefined;
  await dispatch("test-reported-delivery", {
    agentId: "test-reported-delivery-agent",
    routingMetadata: { role: "integrator" },
    claimDriver: (() => ({ release() {} })) as any,
    loadChildren: () => [],
    loadThreadFacts: () => reads++ === 0
      ? baseline
      : [
          ...baseline,
          { predicate: "bar_evidence", value: "focused tests pass → 10/10" },
          { predicate: "outcome", value: "worker also closed the thread" },
        ],
    deliveryRuntime: {
      reserve(context) {
        reserved = context;
        return {
          contractOrigin: "accepted",
          baselineDoneWhen: ["focused tests pass"],
        };
      },
      load(runId) {
        if (!reserved || runId !== reserved.runId) {
          return { reservationValid: false, evidence: [] };
        }
        return { reservationValid: true, evidence: [{
          version: RUN_BAR_EVIDENCE_VERSION,
          run: `@${runId}`,
          thread: "@test-reported-delivery",
          reporter: "@agent:test-reported-delivery-agent",
          bar: "focused tests pass",
          observed: "10/10",
          recordedAt: "2026-07-18T10:00:00Z",
        }] };
      },
    },
    queryFn: () => {
      expect(reserved?.runId.startsWith("run:test-reported-delivery-agent-")).toBe(true);
      return (async function* () {
      yield {
        type: "result", subtype: "success", result: "done",
        duration_ms: 1, num_turns: 1,
      };
      })();
    },
  });
  const logged = readFileSync(log, "utf8");
  expect(logged).toContain(
    "tell agent:test-reported-delivery-agent delivery_outcome reported",
  );
  expect(logged).toContain(
    "tell agent:test-reported-delivery-agent delivery_reason complete_run_scoped_done_bar_evidence_self_reported",
  );
  expect(logged).not.toContain(
    "tell agent:test-reported-delivery-agent delivery_outcome verified",
  );
  const lines = await settledRunLines(
    "test-reported-delivery-agent",
    "applied_domain_requirement_count 0",
  );
  expect(lines.some((line) => line.endsWith(" delivery_outcome reported"))).toBe(true);
  expect(lines.some((line) => line.includes(" delivery_evidence "))).toBe(true);
});

test("dispatch abandons a failed reservation subject and publishes unverified telemetry on a fresh run", async () => {
  const { dispatch } = await import("../src/dispatch");
  writeFileSync(log, "");
  let abandonedRunId: string | undefined;
  let loadCalled = false;
  await dispatch("test-dispatch-reservation-rotation", {
    agentId: "test-dispatch-reservation-rotation-agent",
    routingMetadata: { role: "integrator" },
    claimDriver: (() => ({ release() {} })) as any,
    loadChildren: () => [],
    loadThreadFacts: () => [
      { predicate: "title", value: "Reservation recovery" },
      { predicate: "planned", value: "true" },
      { predicate: "atomic", value: "true" },
      { predicate: "done_when", value: "tests pass" },
    ],
    deliveryRuntime: {
      reserve(context) {
        abandonedRunId = context.runId;
        throw new Error("simulated partial reservation");
      },
      load() {
        loadCalled = true;
        return { reservationValid: false, evidence: [] };
      },
    },
    queryFn: () => (async function* () {
      yield {
        type: "result", subtype: "success", result: "done",
        duration_ms: 1, num_turns: 1,
      };
    })(),
  });
  const lines = await settledRunLines(
    "test-dispatch-reservation-rotation-agent",
    "applied_domain_requirement_count 0",
  );
  const subjects = new Set(lines.map((line) => line.split(/\s+/)[1]));
  expect(abandonedRunId).toBeDefined();
  expect(lines.some((line) => line.startsWith(`tell ${abandonedRunId} `))).toBe(false);
  expect(subjects.size).toBe(1);
  expect(subjects.has(abandonedRunId!)).toBe(false);
  expect(lines.some((line) => line.endsWith(" delivery_outcome unverified"))).toBe(true);
  expect(loadCalled).toBe(false);
});

test("spawn abandons a failed reservation subject and publishes unverified telemetry on a fresh run", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  let abandonedRunId: string | undefined;
  let loadCalled = false;
  await spawn({
    prompt: "recover from a partial reservation",
    agentId: "test-spawn-reservation-rotation",
    role: "integrator",
    thread: "thread-spawn-reservation-rotation",
    deliveryRuntime: {
      reserve(context) {
        abandonedRunId = context.runId;
        throw new Error("simulated partial reservation");
      },
      load() {
        loadCalled = true;
        return { reservationValid: false, evidence: [] };
      },
    },
    queryFn: () => (async function* () {
      yield {
        type: "result", subtype: "success", result: "done",
        duration_ms: 1, num_turns: 1,
      };
    })(),
  });
  const lines = await settledRunLines("test-spawn-reservation-rotation");
  const subjects = new Set(lines.map((line) => line.split(/\s+/)[1]));
  expect(abandonedRunId).toBeDefined();
  expect(lines.some((line) => line.startsWith(`tell ${abandonedRunId} `))).toBe(false);
  expect(subjects.size).toBe(1);
  expect(subjects.has(abandonedRunId!)).toBe(false);
  expect(lines.some((line) => line.endsWith(" delivery_outcome unverified"))).toBe(true);
  expect(loadCalled).toBe(false);
});

test("dispatch rotates away from a reservation that is invalid at finalization", async () => {
  const { dispatch } = await import("../src/dispatch");
  writeFileSync(log, "");
  let reservedRunId: string | undefined;
  await dispatch("test-dispatch-finalize-rotation", {
    agentId: "test-dispatch-finalize-rotation-agent",
    routingMetadata: { role: "integrator" },
    claimDriver: (() => ({ release() {} })) as any,
    loadChildren: () => [],
    loadThreadFacts: () => [
      { predicate: "title", value: "Finalize reservation recovery" },
      { predicate: "planned", value: "true" },
      { predicate: "atomic", value: "true" },
      { predicate: "done_when", value: "tests pass" },
    ],
    deliveryRuntime: {
      reserve(context) {
        reservedRunId = context.runId;
        return { contractOrigin: "accepted", baselineDoneWhen: ["tests pass"] };
      },
      load() {
        return { reservationValid: false, evidence: [] };
      },
    },
    queryFn: () => (async function* () {
      yield {
        type: "result", subtype: "success", result: "done",
        duration_ms: 1, num_turns: 1,
      };
    })(),
  });
  const lines = await settledRunLines(
    "test-dispatch-finalize-rotation-agent",
    "applied_domain_requirement_count 0",
  );
  const subjects = new Set(lines.map((line) => line.split(/\s+/)[1]));
  expect(reservedRunId).toBeDefined();
  expect(lines.some((line) => line.startsWith(`tell ${reservedRunId} `))).toBe(false);
  expect(subjects.size).toBe(1);
  expect(subjects.has(reservedRunId!)).toBe(false);
  expect(lines.some((line) =>
    line.endsWith(" delivery_reason delivery_reservation_unavailable_at_finalize"),
  )).toBe(true);
});

test("spawn rotates away from a reservation that is invalid at finalization", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  let reservedRunId: string | undefined;
  await spawn({
    prompt: "recover at finalization",
    agentId: "test-spawn-finalize-rotation",
    role: "integrator",
    thread: "thread-spawn-finalize-rotation",
    deliveryRuntime: {
      reserve(context) {
        reservedRunId = context.runId;
        return { contractOrigin: "accepted", baselineDoneWhen: ["tests pass"] };
      },
      load() {
        return { reservationValid: false, evidence: [] };
      },
    },
    queryFn: () => (async function* () {
      yield {
        type: "result", subtype: "success", result: "done",
        duration_ms: 1, num_turns: 1,
      };
    })(),
  });
  const lines = await settledRunLines("test-spawn-finalize-rotation");
  const subjects = new Set(lines.map((line) => line.split(/\s+/)[1]));
  expect(reservedRunId).toBeDefined();
  expect(lines.some((line) => line.startsWith(`tell ${reservedRunId} `))).toBe(false);
  expect(subjects.size).toBe(1);
  expect(subjects.has(reservedRunId!)).toBe(false);
  expect(lines.some((line) =>
    line.endsWith(" delivery_reason delivery_reservation_unavailable_at_finalize"),
  )).toBe(true);
});

test("spawn keeps omitted, reported-zero, and preflight-zero turn evidence distinct", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");

  const terminal = (numTurns?: number) => () => (async function* () {
    yield {
      type: "result", subtype: "success", result: "done", duration_ms: 1,
      ...(numTurns === undefined ? {} : { num_turns: numTurns }),
    };
  })();

  await spawn({
    prompt: "provider omits turn count", agentId: "test-turns-omitted",
    role: "integrator", queryFn: terminal(),
  });
  const omitted = await settledRunLines("test-turns-omitted");
  expect(omitted.some((line) => line.includes(" num_turns "))).toBe(false);

  await spawn({
    prompt: "provider reports zero turns", agentId: "test-turns-reported-zero",
    role: "integrator", queryFn: terminal(0),
  });
  const reportedZero = await settledRunLines("test-turns-reported-zero");
  expect(reportedZero.some((line) => line.endsWith(" num_turns 0"))).toBe(true);

  await spawn({
    prompt: "preflight blocks before provider acceptance", agentId: "test-turns-preflight-zero",
    role: "integrator",
    queryFn: () => { throw new ProviderRetrySafeError("test_retry_safe_preflight"); },
  });
  const preflightZero = await settledRunLines("test-turns-preflight-zero");
  expect(preflightZero.some((line) => line.endsWith(" process_outcome blocked_preflight"))).toBe(true);
  expect(preflightZero.some((line) => line.endsWith(" num_turns 0"))).toBe(true);
});

test("dispatch keeps omitted, reported-zero, and preflight-zero turn evidence distinct", async () => {
  const { dispatch } = await import("../src/dispatch");
  writeFileSync(log, "");

  const terminal = (numTurns?: number) => () => (async function* () {
    yield {
      type: "result", subtype: "success", result: "done", duration_ms: 1,
      ...(numTurns === undefined ? {} : { num_turns: numTurns }),
    };
  })();
  const dependencies = (agentId: string, queryFn: any) => ({
    agentId,
    routingMetadata: { role: "integrator" },
    claimDriver: (() => ({ release() {} })) as any,
    queryFn,
    loadThreadFacts: () => [
      { predicate: "title", value: `Turn evidence for ${agentId}` },
      { predicate: "planned", value: "true" },
      { predicate: "atomic", value: "true" },
    ],
    loadChildren: () => [],
  });

  await dispatch(
    "test-dispatch-turns-omitted",
    dependencies("test-dispatch-turns-omitted-agent", terminal()),
  );
  const omitted = await settledRunLines(
    "test-dispatch-turns-omitted-agent", "applied_domain_requirement_count 0",
  );
  expect(omitted.some((line) => line.includes(" num_turns "))).toBe(false);

  await dispatch(
    "test-dispatch-turns-reported-zero",
    dependencies("test-dispatch-turns-reported-zero-agent", terminal(0)),
  );
  const reportedZero = await settledRunLines(
    "test-dispatch-turns-reported-zero-agent", "num_turns 0",
  );
  expect(reportedZero.some((line) => line.endsWith(" num_turns 0"))).toBe(true);

  await dispatch(
    "test-dispatch-turns-preflight-zero",
    dependencies(
      "test-dispatch-turns-preflight-zero-agent",
      () => { throw new ProviderRetrySafeError("test_retry_safe_preflight"); },
    ),
  );
  const preflightZero = await settledRunLines(
    "test-dispatch-turns-preflight-zero-agent", "num_turns 0",
  );
  expect(preflightZero.some((line) => line.endsWith(" process_outcome blocked_preflight"))).toBe(true);
  expect(preflightZero.some((line) => line.endsWith(" num_turns 0"))).toBe(true);
});

async function waitForLog(needle: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const value = existsSync(log) ? readFileSync(log, "utf8") : "";
    if (value.includes(needle)) return value;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for telemetry fact: ${needle}`);
}

async function settledRunLines(agent: string, requiredSuffix = "error_count 0"): Promise<string[]> {
  const marker = `tell run:${agent}-`;
  for (let i = 0, stable = 0, previous = ""; i < 100; i++) {
    const lines = (existsSync(log) ? readFileSync(log, "utf8") : "")
      .split("\n")
      .filter((line) => line.includes(marker));
    const snapshot = lines.slice().sort().join("\n");
    const hasTailEvidence = lines.some((line) => line.endsWith(` ${requiredSuffix}`));
    if (hasTailEvidence && snapshot === previous) stable++;
    else stable = 0;
    if (stable >= 5) return lines;
    previous = snapshot;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for settled run telemetry: ${agent}`);
}

test("public spawn composes justified explicit axes before Gaffer hydration", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  process.env.NORTH_FABLE_NOW = "2026-07-20T04:00:00Z";
  let queryOptions: any;
  const queryFn: any = (args: any) => {
    queryOptions = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "composed", duration_ms: 1, num_turns: 1 };
    })();
  };

  await spawn({
    prompt: "exercise the real composition boundary", agentId: "test-composed-director",
    role: "director", tier: "economy", effort: "low", posture: "preserve",
    routingMetadata: {
      role: "director", topology: "orchestrator",
      composition: { kind: "preset", id: "director",
        overrides: ["tier", "reasoning", "posture"],
        overrideReason: "exercise the explicit public-dial composition boundary" },
    }, provider: "anthropic", queryFn,
  });

  expect(queryOptions.model).toBe("claude-sonnet-5");
  expect(queryOptions.effort).toBe("low");
  const logged = await waitForLog("topology orchestrator");
  for (const fact of [
    "requested_role director", "task_grade staff", "topology orchestrator",
    "routing_tier economy", "requested_reasoning low", "routing_posture preserve",
  ]) expect(logged).toContain(fact);
});

test("public role-only integrator spawn hydrates the complete Gaffer preset", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  process.env.NORTH_FABLE_NOW = "2026-07-20T04:00:00Z";
  let queryOptions: any;
  const queryFn: any = (args: any) => {
    queryOptions = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "integrated", duration_ms: 1, num_turns: 1 };
    })();
  };

  await spawn({
    prompt: "hydrate a role-only request", agentId: "test-role-only-integrator",
    role: "integrator", provider: "anthropic", queryFn,
  });

  expect(queryOptions.model).toBe("claude-opus-4-8");
  expect(queryOptions.effort).toBe("high");
  const logged = await waitForLog("requested_role integrator");
  for (const fact of [
    "task_grade senior", "topology worker", "routing_tier senior",
    "requested_reasoning high", "routing_posture deliver",
  ]) expect(logged).toContain(fact);
  for (const fact of [
    "tell agent:test-role-only-integrator provider anthropic",
    "tell agent:test-role-only-integrator provider_target anthropic",
    "tell agent:test-role-only-integrator model claude-opus-4-8",
    "tell agent:test-role-only-integrator effort high",
    "tell agent:test-role-only-integrator composition_kind preset",
    "tell agent:test-role-only-integrator composition_id integrator",
    "tell agent:test-role-only-integrator display_handle anthropic-ambient-opus-high-gaffer-integrator-integrator",
  ]) expect(logged).toContain(fact);
});

test("tier-routed OpenAI identity records the resolved Sol route, not requested blanks", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  let queryOptions: any;
  const queryFn: any = (args: any) => {
    queryOptions = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "routed", duration_ms: 1, num_turns: 1 };
    })();
  };

  await spawn({ prompt: "route with OpenAI", agentId: "test-openai-designer",
    role: "designer", provider: "openai", queryFn });

  expect(queryOptions.model).toBe("gpt-5.6-sol");
  expect(queryOptions.effort).toBe("xhigh");
  const logged = readFileSync(log, "utf8");
  for (const fact of [
    "tell agent:test-openai-designer provider openai",
    "tell agent:test-openai-designer provider_target openai",
    "tell agent:test-openai-designer model gpt-5.6-sol",
    "tell agent:test-openai-designer effort xhigh",
    "tell agent:test-openai-designer display_handle openai-ambient-sol-xhigh-gaffer-designer-designer",
  ]) expect(logged).toContain(fact);
});

test("public SpawnOptions target and Gaffer role land on exact account identity", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  const policyPath = process.env.NORTH_ROUTING_POLICY!;
  writeFileSync(policyPath, JSON.stringify({
    version: 1,
    mode: "preferential",
    targets: [
      { id: "claude-work", provider: "anthropic", authMode: "ambient" },
      { id: "openai", provider: "openai", authMode: "ambient" },
    ],
    targetOrder: ["claude-work", "openai"],
  }));
  try {
    await spawn({
      prompt: "design on the work account", agentId: "test-target-designer",
      role: "designer", provider: "anthropic", target: "claude-work",
      queryFn: () => (async function* () {
        yield { type: "result", subtype: "success", result: "designed", duration_ms: 1, num_turns: 1 };
      })(),
    });
    const logged = await waitForLog("requested_target claude-work");
    expect(logged).toContain("tell agent:test-target-designer provider_target claude-work");
    expect(logged).toContain("tell agent:test-target-designer composition_id designer");
    expect(logged).toContain("tell agent:test-target-designer display_name anthropic:claude-work");
    expect(logged).toContain("provider_target claude-work");
    expect(logged).toContain("requested_target claude-work");
  } finally {
    rmSync(policyPath, { force: true });
  }
});

test("a struggle sensor firing records a struggle run fact without any in-flight route change", async () => {
  // In-flight escalation is retired (escalation-arch D5). The struggle sensors now run on
  // EVERY spawn as harness-observed execution-axis evidence: a fired sensor writes a
  // `struggle <reason>` run fact at terminal and never changes model/effort. Three
  // consecutive tool errors trip the consecutive_errors sensor (STRUGGLE_ERROR_STREAK=3).
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  let modelChanged = false;
  const queryFn: any = () => ({
    // Present the in-flight controls; the retired machinery must never call them now.
    setModel: async () => { modelChanged = true; },
    applyFlagSettings: async () => { modelChanged = true; },
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 3; i++) {
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: `s${i}`, name: "Bash", input: { i } }] } };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `s${i}`, is_error: true }] } };
      }
      yield { type: "result", subtype: "success", result: "done anyway", duration_ms: 1, num_turns: 4 };
    },
  });

  await spawn({ prompt: "hit repeated errors", agentId: "test-struggle-lane",
    role: "integrator", provider: "anthropic", queryFn });

  const logged = await waitForLog("struggle consecutive_errors");
  expect(logged).toContain("struggle consecutive_errors");
  console.log(`[bar-evidence] ${logged.split("\n").find((l) => l.includes("struggle consecutive_errors"))}`);
  // The run still finished normally at its original route — no ladder climb.
  expect(modelChanged).toBe(false);
  expect(logged).toContain("tell agent:test-struggle-lane model claude-opus-4-8");
  expect(logged).not.toContain("outcome provider_escalation_unsupported");
});

test("no_progress threshold is topology-bound: worker fires at 6, orchestrator waits until 12", async () => {
  // Bounded topology-aware no_progress threshold fix (thread 019f7b9d-8bad): a director/
  // orchestrator lane legitimately spends more turns coordinating fan-out before its own
  // tool calls look like progress, so it gets a wider no_progress window than a worker.
  // Unknown/unset topology must fall back to the conservative worker default — never
  // silently inherit the wider orchestrator bound.
  const { makeStruggleState, updateStruggle, checkStruggle } = await import("../src/struggle");

  // Advance one assistant turn with a successful, non-progress, non-error, distinct
  // tool call so neither consecutive_errors nor tool_loop trips — isolates no_progress.
  const advance = (st: ReturnType<typeof makeStruggleState>, i: number) => {
    updateStruggle({ type: "assistant", message: { content: [
      { type: "tool_use", id: `t${i}`, name: "Bash", input: { i } },
    ] } }, st);
    updateStruggle({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: `t${i}`, is_error: false },
    ] } }, st);
  };

  // Worker (explicit) stalls at the original threshold: null through turn 5, fires at 6.
  const worker = makeStruggleState("worker");
  for (let i = 1; i <= 5; i++) { advance(worker, i); expect(checkStruggle(worker)).toBeNull(); }
  advance(worker, 6);
  expect(checkStruggle(worker)).toBe("no_progress");

  // Orchestrator gets the wider bound: still null at 8 and 11, fires at 12.
  const orchestrator = makeStruggleState("orchestrator");
  for (let i = 1; i <= 8; i++) advance(orchestrator, i);
  expect(checkStruggle(orchestrator)).toBeNull();
  for (let i = 9; i <= 11; i++) advance(orchestrator, i);
  expect(checkStruggle(orchestrator)).toBeNull();
  advance(orchestrator, 12);
  expect(checkStruggle(orchestrator)).toBe("no_progress");

  // Unknown/unset topology is NOT the wider bound — it stays the worker default.
  const unknown = makeStruggleState(undefined);
  for (let i = 1; i <= 5; i++) { advance(unknown, i); expect(checkStruggle(unknown)).toBeNull(); }
  advance(unknown, 6);
  expect(checkStruggle(unknown)).toBe("no_progress");

  // Trigger vocabulary is unchanged by this fix.
  expect(checkStruggle(worker)).toBe("no_progress");
});
