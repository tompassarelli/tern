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
import { presetRequest } from "./routing-fixtures";
import { applyGafferStaffing } from "../src/gaffer-staffing";

let dir: string;
let log: string;

const MANAGED_ENV = [
  "PATH", "NORTH_BIN", "NORTH_PEER_BB", "NORTH_IDENTITY_TEST_REDIRECT", "NORTH_PORT", "NORTH_STREAM_DIR", "AGENT_LAWS", "AGENT_PRAXIS",
  "AGENT_ID", "NORTH_AGENT_ID", "AGENT_COORDINATOR", "AGENT_MODEL", "AGENT_ROLE", "AGENT_EFFORT",
  "AGENT_IDENTITY_ROLE", "AGENT_TARGET",
  "AGENT_TIER", "AGENT_REASONING", "AGENT_POSTURE", "AGENT_TOPOLOGY", "AGENT_TASK_GRADE",
  "AGENT_DOMAIN_REQUIREMENTS", "AGENT_COMPOSITION", "NORTH_FABLE_NOW",
  "NORTH_ROUTING_POLICY", "NORTH_ENVELOPE_ACCOUNTING",
  "NORTH_BG_MAX_CONTINUATIONS", "NORTH_STALL_MS", "NORTH_TERMINAL_PUBLICATION_BUDGET_MS",
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
  writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  *test-terminal-aux-budget*agent_death*) sleep 5 ;;
  "clock start thread-sync-construction")
    : > "${dir}/sync-clock-open"
    printf 'clocked in on thread-sync-construction at now  (session s1, agent %s)\\n' "$NORTH_AGENT_ID" ;;
  "clock status")
    if [ "$NORTH_AGENT_ID" = "test-sync-construction-failure" ]; then
      if [ -e "${dir}/sync-clock-open" ]; then
        printf 'clocked in on thread-sync-construction  Sync construction  (agent %s)\\n' "$NORTH_AGENT_ID"
      else
        printf 'not clocked in (agent %s)\\n' "$NORTH_AGENT_ID"
      fi
    fi ;;
  "clock orphan test-sync-construction-failure") rm -f "${dir}/sync-clock-open" ;;
esac
exit 0
`);
  chmodSync(fake, 0o755);
  const fakeBb = join(dir, "bb");
  writeFileSync(fakeBb, `#!/usr/bin/env bash
printf 'bb %s\\n' "$*" >> "${log}"
case "$*" in
  *test-dispatch-notify-failure*) exit 1 ;;
esac
exit 0
`);
  chmodSync(fakeBb, 0o755);

  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.NORTH_BIN = fake;
  process.env.NORTH_PEER_BB = fakeBb;
  process.env.NORTH_IDENTITY_TEST_REDIRECT = "1";
  process.env.NORTH_PORT = "59999"; // unused -> any stray bb write silently no-ops
  process.env.NORTH_STREAM_DIR = dir;
  process.env.AGENT_LAWS = "off";
  process.env.AGENT_PRAXIS = "off";
  process.env.NORTH_ROUTING_POLICY = join(dir, "absent-routing-policy.json");
  process.env.NORTH_PROVIDER_OBSERVATIONS = join(dir, "absent-provider-observations.json");
  delete process.env.NORTH_ALLOCATION_MODE;
  delete process.env.NORTH_BG_MAX_CONTINUATIONS;
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
  const { spawn } = await import("./support/spawn");
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
    prompt: "do a bounded task", agentId: "test-done-ok", role: "integrator", routingMetadata: presetRequest("integrator"), queryFn: cleanQuery,
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
  const runLines = await settledRunLines("test-done-ok");
  expect(runLines.some((line) => line.endsWith(" thread (ad-hoc)"))).toBe(true);
});

test("a lane that dies mid-stream records outcome=died ON the lane entity (reported, not silent)", async () => {
  const { spawn } = await import("./support/spawn");

  // The SDK subprocess dies mid-turn (real exitError shape). The finally path runs, so this
  // is a REPORTED death: outcome=died on @agent:<id> alongside the agent_death fact. The
  // reactor then skips its committed terminal — died-unreported is reserved for
  // a hard-kill (or torn publication) with no committed terminal evidence.
  const dyingQuery: any = () =>
    (async function* () {
      yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "starting" }] } };
      throw new Error("Claude Code process terminated by signal 9");
    })();

  await spawn({ prompt: "dies", agentId: "test-done-died", role: "integrator", routingMetadata: presetRequest("integrator"), queryFn: dyingQuery });

  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("tell agent:test-done-died outcome died");
  expect(logged).toContain("tell agent:test-done-died process_outcome died");
  expect(logged).toContain("tell agent:test-done-died delivery_outcome blocked");
  expect(logged).toContain("tell @swarm agent_death"); // death path still fires
});

test("a synchronous provider-construction failure closes lifecycle state and the billable clock", async () => {
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");

  const result = await spawn({
    prompt: "fail while constructing the provider query",
    agentId: "test-sync-construction-failure",
    role: "integrator", routingMetadata: presetRequest("integrator"),
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
  const { spawn } = await import("./support/spawn");
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
    role: "integrator", routingMetadata: presetRequest("integrator"), provider: "anthropic", queryFn });
  await waitForLog("tell run:test-terminal-error-");
  await waitForLog("usage_total_status exact");
  const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.includes("run:test-terminal-error-"));
  expect(lines.some((line) => line.endsWith(" tokens 21"))).toBe(true);
  expect(lines.some((line) => line.endsWith(" usage_terminal_count 1"))).toBe(true);
});

test("repeated Anthropic terminals record ambiguity without a selected or summed usage", async () => {
  const { spawn } = await import("./support/spawn");
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
    role: "integrator", routingMetadata: presetRequest("integrator"), provider: "anthropic", queryFn });
  await waitForLog("usage_total_status unknown_repeated_terminal");
  const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.includes("run:test-repeated-terminals-"));
  expect(lines.some((line) => line.endsWith(" usage_terminal_count 2"))).toBe(true);
  expect(lines.some((line) => / (tokens|input_tokens|output_tokens) /.test(line))).toBe(false);
});

test("an empty spawn provider stream is a blocked provider error, never ran", async () => {
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");

  const result = await spawn({
    prompt: "provider stream closes without a terminal", agentId: "test-empty-spawn",
    role: "integrator", routingMetadata: presetRequest("integrator"),
    queryFn: () => (async function* () {})(),
  });

  expect(result).toBe("");
  const lines = await settledRunLines("test-empty-spawn");
  expect(lines.some((line) => line.endsWith(" process_outcome provider_error"))).toBe(true);
  expect(lines.some((line) => line.endsWith(" delivery_outcome blocked"))).toBe(true);
});

test("an empty dispatch provider stream is a blocked provider error, never ran", async () => {
  const { dispatch } = await import("./support/dispatch");
  writeFileSync(log, "");
  const boundaryIds: string[] = [];

  const result = await dispatch("@test-empty-dispatch", {
    agentId: "test-empty-dispatch-agent",
    routingMetadata: presetRequest("integrator"),
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

test("dispatch wakes its coordinator once, after every terminal publication settles", async () => {
  const { dispatch } = await import("./support/dispatch");
  const scenarios = [
    {
      label: "ran",
      queryFn: () => (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          duration_ms: 1,
          num_turns: 1,
        };
      })(),
      processOutcome: "ran",
      deliveryOutcome: "unverified",
      runTail: "num_turns 1",
      subject: "AGENT COMPLETE",
    },
    {
      label: "blocked-preflight",
      queryFn: () => {
        throw new ProviderRetrySafeError("north_coordination_log_missing");
      },
      processOutcome: "blocked_preflight",
      deliveryOutcome: "blocked",
      runTail: "num_turns 0",
      subject: "AGENT BLOCKED",
    },
    {
      label: "died",
      queryFn: () => (async function* () {
        throw new Error("provider subprocess died for ordering probe");
      })(),
      processOutcome: "died",
      deliveryOutcome: "blocked",
      runTail: "process_outcome died",
      subject: "AGENT DEATH",
    },
    {
      label: "turn-cap",
      queryFn: () => (async function* () {
        yield {
          type: "result",
          subtype: "error_max_turns",
          result: "partial",
          duration_ms: 1,
          num_turns: 2,
        };
      })(),
      processOutcome: "max_turns",
      deliveryOutcome: "blocked",
      runTail: "num_turns 2",
      subject: "TURN CAP",
    },
    {
      label: "stalled",
      queryFn: () => ({
        interrupt: async () => {},
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise(() => {}),
          };
        },
      }),
      processOutcome: "stalled",
      deliveryOutcome: "blocked",
      runTail: "process_outcome stalled",
      subject: "AGENT DEATH",
      stallMs: "10",
    },
  ];

  for (const scenario of scenarios) {
    writeFileSync(log, "");
    const agentId = `test-dispatch-notify-${scenario.label}`;
    if ("stallMs" in scenario) process.env.NORTH_STALL_MS = scenario.stallMs;
    try {
      await dispatch(`thread-${agentId}`, {
        agentId,
        routingMetadata: presetRequest("integrator"),
        claimDriver: (() => ({ release() {} })) as any,
        queryFn: scenario.queryFn as any,
        loadThreadFacts: () => [
          { predicate: "title", value: "Prove coordinator terminal notification" },
          { predicate: "planned", value: "true" },
          { predicate: "atomic", value: "true" },
        ],
        loadChildren: () => [],
      });
    } finally {
      delete process.env.NORTH_STALL_MS;
    }

    const output = await waitForLog(
      `${scenario.subject} ${scenario.processOutcome === "died"
        ? "provider subprocess died for ordering probe — "
        : scenario.processOutcome === "max_turns"
          ? "error_max_turns — partial: partial — "
          : scenario.processOutcome === "stalled"
            ? "stalled — no SDK output for 2min — "
          : ""}process=${scenario.processOutcome}`,
    );
    const lines = output.split("\n").filter(Boolean);
    const pings = lines.filter((line) =>
      line.includes(`send ${agentId} ${TEST_COORDINATOR} ${scenario.subject}`)
    );
    expect(pings).toHaveLength(1);
    expect(pings[0]).toEndWith(
      `process=${scenario.processOutcome} — delivery=${scenario.deliveryOutcome} — terminal=recorded — run=recorded`,
    );
    expect(lines.some((line) =>
      line.includes(`send ${agentId} ${TEST_COORDINATOR} AGENT COMPLETE`)
      && scenario.subject !== "AGENT COMPLETE"
    )).toBe(false);
    const terminalIndex = lines.findIndex((line) =>
      line === `tell agent:${agentId} process_outcome ${scenario.processOutcome}`
    );
    const runIndex = lines.findIndex((line) =>
      line.includes(`tell run:${agentId}-`) && line.endsWith(` ${scenario.runTail}`)
    );
    const pingIndex = lines.indexOf(pings[0]!);
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeLessThan(pingIndex);
    expect(runIndex).toBeLessThan(pingIndex);
    if (scenario.processOutcome === "stalled") {
      const diagnosticPings = lines.filter((line) =>
        line.includes(`send ${agentId} ${TEST_COORDINATOR} AGENT STALLED`)
      );
      expect(diagnosticPings).toHaveLength(1);
      expect(lines.indexOf(diagnosticPings[0]!)).toBeLessThan(terminalIndex);
    }
  }
}, 15_000);

test("a failed dispatch completion wake-up never replaces the execution outcome", async () => {
  const { dispatch } = await import("./support/dispatch");
  writeFileSync(log, "");
  const agentId = "test-dispatch-notify-failure";
  const result = await dispatch(`thread-${agentId}`, {
    agentId,
    routingMetadata: presetRequest("integrator"),
    claimDriver: (() => ({ release() {} })) as any,
    queryFn: () => (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "done despite notification failure",
        duration_ms: 1,
        num_turns: 1,
      };
    })(),
    loadThreadFacts: () => [
      { predicate: "title", value: "Keep notification failure non-fatal" },
      { predicate: "planned", value: "true" },
      { predicate: "atomic", value: "true" },
    ],
    loadChildren: () => [],
  });
  expect(result.result).toBe("done despite notification failure");
  const output = await waitForLog(
    `send ${agentId} ${TEST_COORDINATOR} AGENT COMPLETE`,
  );
  expect(output.match(new RegExp(
    `send ${agentId} ${TEST_COORDINATOR} AGENT COMPLETE`,
    "g",
  ))).toHaveLength(1);
  const lines = await settledRunLines(agentId, "num_turns 1");
  expect(lines.some((line) => line.endsWith(" process_outcome ran"))).toBe(true);
});

test("a blocked auxiliary terminal writer cannot stack beyond the shared publication budget", async () => {
  const { dispatch } = await import("./support/dispatch");
  process.env.NORTH_TERMINAL_PUBLICATION_BUDGET_MS = "100";
  const runProbe = async (agentId: string) => {
    writeFileSync(log, "");
    const startedAt = performance.now();
    await dispatch(`thread-${agentId}`, {
      agentId,
      routingMetadata: presetRequest("integrator"),
      claimDriver: (() => ({ release() {} })) as any,
      queryFn: () => (async function* () {
        throw new Error("terminal auxiliary budget probe");
      })(),
      loadThreadFacts: () => [
        { predicate: "title", value: "Bound every terminal publication stage" },
        { predicate: "planned", value: "true" },
        { predicate: "atomic", value: "true" },
      ],
      loadChildren: () => [],
    });
    return {
      elapsedMs: performance.now() - startedAt,
      output: readFileSync(log, "utf8"),
    };
  };
  try {
    const control = await runProbe("test-terminal-aux-control");
    const blocked = await runProbe("test-terminal-aux-budget");
    expect(blocked.elapsedMs).toBeLessThan(1_500);
    expect(blocked.elapsedMs - control.elapsedMs).toBeLessThan(350);
    expect(blocked.output).toContain(
      "tell @swarm agent_death test-terminal-aux-budget | terminal auxiliary budget probe",
    );
  } finally {
    delete process.env.NORTH_TERMINAL_PUBLICATION_BUDGET_MS;
  }
});


test("dispatch warns a committed thread that lacks BOTH done_when and judgment_grade", async () => {
  const { dispatch } = await import("./support/dispatch");
  writeFileSync(log, "");
  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => { captured.push(args.join(" ")); };
  try {
    await dispatch("@test-warn-thread", {
      agentId: "test-warn-thread-agent",
      routingMetadata: presetRequest("integrator"),
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
  const { dispatch } = await import("./support/dispatch");
  const events: string[] = [];
  const dependencies = {
    agentId: "test-preclaimed-terminal-agent",
    routingMetadata: presetRequest("integrator"),
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
    routingMetadata: presetRequest("integrator"),
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
    routingMetadata: presetRequest("integrator"),
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
  const { dispatch } = await import("./support/dispatch");
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
  const { dispatch } = await import("./support/dispatch");
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
    routingMetadata: presetRequest("integrator"),
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

test("spawn reserves before provider execution and binds evidence plus telemetry to its exact thread", async () => {
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");
  const events: string[] = [];
  let reserved: DeliveryRunContext | undefined;
  const result = await spawn({
    prompt: "prove the bound task",
    agentId: "test-proof-bound-spawn",
    role: "integrator", routingMetadata: presetRequest("integrator"),
    thread: "test-proof-bound-thread",
    loadThreadFacts: () => {
      events.push("thread-read");
      return [
        { predicate: "title", value: "Proof-bound task" },
        { predicate: "done_when", value: "focused tests pass" },
      ];
    },
    deliveryRuntime: {
      reserve(context) {
        events.push("reserve");
        reserved = context;
        return {
          contractOrigin: "accepted",
          baselineDoneWhen: ["focused tests pass"],
        };
      },
      load(runId) {
        events.push("evidence-load");
        if (!reserved || runId !== reserved.runId) {
          return { reservationValid: false, evidence: [] };
        }
        return {
          reservationValid: true,
          evidence: [{
            version: RUN_BAR_EVIDENCE_VERSION,
            run: `@${runId}`,
            thread: "@test-proof-bound-thread",
            reporter: "@agent:test-proof-bound-spawn",
            bar: "focused tests pass",
            observed: "28/28 pass",
            recordedAt: "2026-07-19T01:00:00Z",
          }],
        };
      },
    },
    queryFn: () => {
      events.push("provider");
      expect(reserved?.threadId).toBe("test-proof-bound-thread");
      return (async function* () {
        yield {
          type: "result", subtype: "success", result: "evidence recorded",
          duration_ms: 1, num_turns: 1,
        };
      })();
    },
  });
  expect(result).toBe("evidence recorded");
  expect(events.slice(0, 2)).toEqual(["reserve", "provider"]);
  const logged = await waitForLog(
    "tell agent:test-proof-bound-spawn delivery_outcome reported",
  );
  expect(logged).toContain(
    "tell agent:test-proof-bound-spawn delivery_reason complete_run_scoped_done_bar_evidence_self_reported",
  );
  const lines = await settledRunLines("test-proof-bound-spawn");
  expect(lines.some((line) => line.endsWith(" thread test-proof-bound-thread"))).toBe(true);
  expect(lines.some((line) => line.endsWith(" thread (ad-hoc)"))).toBe(false);
  expect(lines.some((line) => line.endsWith(" delivery_outcome reported"))).toBe(true);
});

test("a spawn orchestrator gets a provider reduction turn after child settlement", async () => {
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");
  const settlements = [
    { kind: "live", children: ["@agent:child-a"], live: ["@agent:child-a"] },
    { kind: "settled", children: ["@agent:child-a"] },
    { kind: "settled", children: ["@agent:child-a"] },
    { kind: "settled", children: ["@agent:child-a"] },
  ] as const;
  let settlementIndex = 0;
  const seenInputs: string[] = [];
  const queryFn: any = ({ prompt }: any) => ({
    async *[Symbol.asyncIterator]() {
      const input = prompt[Symbol.asyncIterator]();
      const initial = await input.next();
      seenInputs.push(initial.value.message.content);
      yield {
        type: "result", subtype: "success", result: "premature",
        duration_ms: 1, num_turns: 1,
      };
      const continuation = await input.next();
      seenInputs.push(continuation.value.message.content);
      yield {
        type: "result", subtype: "success", result: "child terminal observed",
        duration_ms: 2, num_turns: 2,
      };
      const reduction = await input.next();
      seenInputs.push(reduction.value.message.content);
      yield {
        type: "result", subtype: "success", result: "reduced",
        duration_ms: 3, num_turns: 3,
      };
    },
  });

  const result = await spawn({
    prompt: "coordinate the child",
    agentId: "test-spawn-child-resolves",
    role: "director",
          routingMetadata: presetRequest("director"),
    queryFn,
    childSettlementReader: () =>
      settlements[Math.min(settlementIndex++, settlements.length - 1)]!,
  });
  expect(result).toBe("reduced");
  expect(seenInputs[1]).toContain("North refuses orchestrator turn-end");
  expect(seenInputs[2]).toContain("post-settlement reduction turn");
  expect(seenInputs[2]).toContain("@agent:child-a");
  expect(settlementIndex).toBe(4);
  const lines = await settledRunLines("test-spawn-child-resolves");
  expect(lines.some((line) => line.endsWith(" process_outcome ran"))).toBe(true);
});

test("a spawn orchestrator hits a bounded no-progress cap as incomplete, never ran", async () => {
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");
  const previousCap = process.env.NORTH_BG_MAX_CONTINUATIONS;
  process.env.NORTH_BG_MAX_CONTINUATIONS = "1";
  try {
    const queryFn: any = ({ prompt }: any) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]();
        await input.next();
        yield {
          type: "result", subtype: "success", result: "first early exit",
          duration_ms: 1, num_turns: 1,
        };
        await input.next();
        yield {
          type: "result", subtype: "success", result: "second early exit",
          duration_ms: 2, num_turns: 2,
        };
      },
    });
    await spawn({
      prompt: "coordinate a stuck child",
      agentId: "test-spawn-child-cap",
      role: "director",
          routingMetadata: presetRequest("director"),
      coordinator: TEST_COORDINATOR,
      queryFn,
      childSettlementReader: () => ({
        kind: "live", children: ["@agent:stuck-child"], live: ["@agent:stuck-child"],
      }),
    });
    const lines = await settledRunLines("test-spawn-child-cap");
    expect(lines.some((line) =>
      line.endsWith(" process_outcome orchestrator_children_incomplete"),
    )).toBe(true);
    expect(lines.some((line) => line.endsWith(" process_outcome ran"))).toBe(false);
    const logged = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const pings = logged.filter((line) =>
      line.includes(
        `send test-spawn-child-cap ${TEST_COORDINATOR} EARLY EXIT WITH LIVE CHILDREN`,
      )
    );
    expect(pings).toHaveLength(1);
    expect(logged.some((line) =>
      line.includes(`send test-spawn-child-cap ${TEST_COORDINATOR} AGENT COMPLETE`)
    )).toBe(false);
    const terminalIndex = logged.indexOf(
      "tell agent:test-spawn-child-cap process_outcome orchestrator_children_incomplete",
    );
    const runIndex = logged.findIndex((line) =>
      line.includes("tell run:test-spawn-child-cap-")
      && line.endsWith(" process_outcome orchestrator_children_incomplete")
    );
    const pingIndex = logged.indexOf(pings[0]!);
    expect(terminalIndex).toBeLessThan(pingIndex);
    expect(runIndex).toBeLessThan(pingIndex);
  } finally {
    if (previousCap === undefined) delete process.env.NORTH_BG_MAX_CONTINUATIONS;
    else process.env.NORTH_BG_MAX_CONTINUATIONS = previousCap;
  }
});

test("spawn and dispatch require reduction for first-seen and changed settled child sets", async () => {
  const { spawn } = await import("./support/spawn");
  const { dispatch } = await import("./support/dispatch");
  const scenarios = [
    {
      label: "already-settled",
      settlements: [
        { kind: "settled" as const, children: ["@agent:child-a"] },
        { kind: "settled" as const, children: ["@agent:child-a"] },
        { kind: "settled" as const, children: ["@agent:child-a"] },
      ],
      providerResults: 2,
      reductionTurns: 1,
    },
    {
      label: "settled-set-changed",
      settlements: [
        { kind: "settled" as const, children: ["@agent:child-a"] },
        { kind: "settled" as const, children: ["@agent:child-a", "@agent:child-b"] },
        { kind: "settled" as const, children: ["@agent:child-a", "@agent:child-b"] },
        { kind: "settled" as const, children: ["@agent:child-a", "@agent:child-b"] },
      ],
      providerResults: 3,
      reductionTurns: 2,
    },
  ];

  for (const surface of ["spawn", "dispatch"] as const) {
    for (const scenario of scenarios) {
      writeFileSync(log, "");
      const agentId = `test-${surface}-${scenario.label}`;
      let reads = 0;
      const seenInputs: string[] = [];
      const queryFn: any = ({ prompt }: any) => ({
        async *[Symbol.asyncIterator]() {
          const input = prompt[Symbol.asyncIterator]();
          for (let i = 0; i < scenario.providerResults; i++) {
            const next = await input.next();
            seenInputs.push(next.value.message.content);
            yield {
              type: "result", subtype: "success", result: `provider-result-${i + 1}`,
              duration_ms: i + 1, num_turns: i + 1,
            };
          }
        },
      });
      const childSettlementReader = () =>
        scenario.settlements[Math.min(reads++, scenario.settlements.length - 1)]!;

      if (surface === "spawn") {
        await spawn({
          prompt: "reduce settled child results",
          agentId,
          role: "director",
          routingMetadata: presetRequest("director"),
          queryFn,
          childSettlementReader,
        });
      } else {
        await dispatch(`thread-${agentId}`, {
          agentId,
          routingMetadata: presetRequest("director"),
          claimDriver: (() => ({ release() {} })) as any,
          queryFn,
          loadThreadFacts: () => [
            { predicate: "title", value: "Reduce settled child results" },
            { predicate: "planned", value: "true" },
            { predicate: "atomic", value: "true" },
          ],
          loadChildren: () => [],
          childSettlementReader,
        });
      }

      expect(reads).toBe(scenario.settlements.length);
      const reductionInputs = seenInputs.filter((input) =>
        input.includes("post-settlement reduction turn")
      );
      expect(reductionInputs).toHaveLength(scenario.reductionTurns);
      expect(reductionInputs[0]).toContain("@agent:child-a");
      if (scenario.label === "settled-set-changed") {
        expect(reductionInputs[1]).toContain("@agent:child-b");
      }
      const lines = await settledRunLines(
        agentId,
        surface === "dispatch" ? "applied_domain_requirement_count 0" : "error_count 0",
      );
      expect(lines.some((line) => line.endsWith(" process_outcome ran"))).toBe(true);
    }
  }
}, 15_000);

test("spawn and dispatch block a previously live child disappearing from the graph", async () => {
  const { spawn } = await import("./support/spawn");
  const { dispatch } = await import("./support/dispatch");

  for (const surface of ["spawn", "dispatch"] as const) {
    writeFileSync(log, "");
    const agentId = `test-${surface}-child-set-shrink`;
    const settlements = [
      {
        kind: "live" as const,
        children: ["@agent:child-a"],
        live: ["@agent:child-a"],
      },
      { kind: "settled" as const, children: [] },
      { kind: "settled" as const, children: [] },
    ];
    let reads = 0;
    const queryFn: any = ({ prompt }: any) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]();
        for (let i = 0; i < 2; i++) {
          await input.next();
          yield {
            type: "result",
            subtype: "success",
            result: `provider-result-${i + 1}`,
            duration_ms: i + 1,
            num_turns: i + 1,
          };
        }
      },
    });
    const childSettlementReader = () =>
      settlements[Math.min(reads++, settlements.length - 1)]!;

    if (surface === "spawn") {
      await spawn({
        prompt: "observe a live child before its graph edge disappears",
        agentId,
        role: "director",
          routingMetadata: presetRequest("director"),
        queryFn,
        childSettlementReader,
      });
    } else {
      await dispatch(`thread-${agentId}`, {
        agentId,
        routingMetadata: presetRequest("director"),
        claimDriver: (() => ({ release() {} })) as any,
        queryFn,
        loadThreadFacts: () => [
          { predicate: "title", value: "Observe a disappearing child" },
          { predicate: "planned", value: "true" },
          { predicate: "atomic", value: "true" },
        ],
        loadChildren: () => [],
        childSettlementReader,
      });
    }

    expect(reads).toBe(3);
    const lines = await settledRunLines(
      agentId,
      surface === "dispatch" ? "applied_domain_requirement_count 0" : "error_count 0",
    );
    expect(lines.some((line) =>
      line.endsWith(" process_outcome orchestrator_child_set_inconsistent"),
    )).toBe(true);
    expect(lines.some((line) =>
      line.endsWith(" delivery_reason orchestrator_child_relation_regressed"),
    )).toBe(true);
    expect(lines.some((line) => line.endsWith(" process_outcome ran"))).toBe(false);
  }
});

test("spawn and dispatch final gates reject a child disappearing after reduction", async () => {
  const { spawn } = await import("./support/spawn");
  const { dispatch } = await import("./support/dispatch");

  for (const surface of ["spawn", "dispatch"] as const) {
    writeFileSync(log, "");
    const agentId = `test-${surface}-child-set-final-race`;
    const settlements = [
      { kind: "settled" as const, children: ["@agent:child-a"] },
      { kind: "settled" as const, children: ["@agent:child-a"] },
      { kind: "settled" as const, children: [] },
    ];
    let reads = 0;
    const seenInputs: string[] = [];
    const queryFn: any = ({ prompt }: any) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]();
        for (let i = 0; i < 2; i++) {
          const next = await input.next();
          seenInputs.push(next.value.message.content);
          yield {
            type: "result",
            subtype: "success",
            result: `provider-result-${i + 1}`,
            duration_ms: i + 1,
            num_turns: i + 1,
          };
        }
      },
    });
    const childSettlementReader = () =>
      settlements[Math.min(reads++, settlements.length - 1)]!;

    if (surface === "spawn") {
      await spawn({
        prompt: "reduce a child before its graph edge disappears",
        agentId,
        role: "director",
          routingMetadata: presetRequest("director"),
        queryFn,
        childSettlementReader,
      });
    } else {
      await dispatch(`thread-${agentId}`, {
        agentId,
        routingMetadata: presetRequest("director"),
        claimDriver: (() => ({ release() {} })) as any,
        queryFn,
        loadThreadFacts: () => [
          { predicate: "title", value: "Exercise the post-reduction final race" },
          { predicate: "planned", value: "true" },
          { predicate: "atomic", value: "true" },
        ],
        loadChildren: () => [],
        childSettlementReader,
      });
    }

    expect(reads).toBe(3);
    expect(seenInputs[1]).toContain("post-settlement reduction turn");
    const lines = await settledRunLines(
      agentId,
      surface === "dispatch" ? "applied_domain_requirement_count 0" : "error_count 0",
    );
    expect(lines.some((line) =>
      line.endsWith(" process_outcome orchestrator_child_set_inconsistent"),
    )).toBe(true);
    expect(lines.some((line) =>
      line.endsWith(" delivery_reason orchestrator_child_relation_regressed"),
    )).toBe(true);
    expect(lines.some((line) => line.endsWith(" process_outcome ran"))).toBe(false);
  }
});

test("spawn and dispatch final gates reject late live, unavailable, or unreduced settled state", async () => {
  const { spawn } = await import("./support/spawn");
  const { dispatch } = await import("./support/dispatch");
  const terminalStates = [
    {
      label: "live",
      state: {
        kind: "live" as const,
        children: ["@agent:late-child"],
        live: ["@agent:late-child"],
      },
      outcome: "orchestrator_children_incomplete",
    },
    {
      label: "unavailable",
      state: {
        kind: "unavailable" as const,
        reason: "injected graph outage",
      },
      outcome: "child_reconciliation_unavailable",
    },
    {
      label: "settled",
      state: {
        kind: "settled" as const,
        children: ["@agent:late-terminal-child"],
      },
      outcome: "orchestrator_reduction_incomplete",
    },
  ];
  const oneTerminalQuery: any = ({ prompt }: any) => ({
    async *[Symbol.asyncIterator]() {
      const input = prompt[Symbol.asyncIterator]();
      await input.next();
      yield {
        type: "result", subtype: "success", result: "provider said done",
        duration_ms: 1, num_turns: 1,
      };
    },
  });

  for (const surface of ["spawn", "dispatch"] as const) {
    for (const terminalState of terminalStates) {
      writeFileSync(log, "");
      const agentId = `test-${surface}-late-${terminalState.label}`;
      let calls = 0;
      const childSettlementReader = () => {
        calls++;
        return calls === 1
          ? { kind: "settled" as const, children: [] }
          : terminalState.state;
      };
      if (surface === "spawn") {
        await spawn({
          prompt: "exercise the final child gate",
          agentId,
          role: "director",
          routingMetadata: presetRequest("director"),
          queryFn: oneTerminalQuery,
          childSettlementReader,
        });
      } else {
        await dispatch(`thread-${agentId}`, {
          agentId,
          routingMetadata: presetRequest("director"),
          claimDriver: (() => ({ release() {} })) as any,
          queryFn: oneTerminalQuery,
          loadThreadFacts: () => [
            { predicate: "title", value: "Exercise dispatch child gate" },
            { predicate: "planned", value: "true" },
            { predicate: "atomic", value: "true" },
          ],
          loadChildren: () => [],
          childSettlementReader,
        });
      }
      expect(calls).toBe(2);
      const lines = await settledRunLines(
        agentId,
        surface === "dispatch" ? "applied_domain_requirement_count 0" : "error_count 0",
      );
      expect(lines.some((line) =>
        line.endsWith(` process_outcome ${terminalState.outcome}`),
      )).toBe(true);
      expect(lines.some((line) => line.endsWith(" process_outcome ran"))).toBe(false);
      const logged = readFileSync(log, "utf8");
      expect(logged).toContain(
        `tell agent:${agentId} delivery_outcome blocked`,
      );
      if (terminalState.label === "live") {
        expect(logged).toContain(`tell agent:${agentId} early_exit_children`);
      }
    }
  }
}, 15_000);

test("dispatch abandons a failed reservation subject and publishes unverified telemetry on a fresh run", async () => {
  const { dispatch } = await import("./support/dispatch");
  writeFileSync(log, "");
  let abandonedRunId: string | undefined;
  let loadCalled = false;
  await dispatch("test-dispatch-reservation-rotation", {
    agentId: "test-dispatch-reservation-rotation-agent",
    routingMetadata: presetRequest("integrator"),
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
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");
  let abandonedRunId: string | undefined;
  let loadCalled = false;
  await spawn({
    prompt: "recover from a partial reservation",
    agentId: "test-spawn-reservation-rotation",
    role: "integrator", routingMetadata: presetRequest("integrator"),
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
  const { dispatch } = await import("./support/dispatch");
  writeFileSync(log, "");
  let reservedRunId: string | undefined;
  await dispatch("test-dispatch-finalize-rotation", {
    agentId: "test-dispatch-finalize-rotation-agent",
    routingMetadata: presetRequest("integrator"),
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
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");
  let reservedRunId: string | undefined;
  await spawn({
    prompt: "recover at finalization",
    agentId: "test-spawn-finalize-rotation",
    role: "integrator", routingMetadata: presetRequest("integrator"),
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
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");

  const terminal = (numTurns?: number) => () => (async function* () {
    yield {
      type: "result", subtype: "success", result: "done", duration_ms: 1,
      ...(numTurns === undefined ? {} : { num_turns: numTurns }),
    };
  })();

  await spawn({
    prompt: "provider omits turn count", agentId: "test-turns-omitted",
    role: "integrator", routingMetadata: presetRequest("integrator"), queryFn: terminal(),
  });
  const omitted = await settledRunLines("test-turns-omitted");
  expect(omitted.some((line) => line.includes(" num_turns "))).toBe(false);

  await spawn({
    prompt: "provider reports zero turns", agentId: "test-turns-reported-zero",
    role: "integrator", routingMetadata: presetRequest("integrator"), queryFn: terminal(0),
  });
  const reportedZero = await settledRunLines("test-turns-reported-zero");
  expect(reportedZero.some((line) => line.endsWith(" num_turns 0"))).toBe(true);

  await spawn({
    prompt: "preflight blocks before provider acceptance", agentId: "test-turns-preflight-zero",
    role: "integrator", routingMetadata: presetRequest("integrator"),
    queryFn: () => { throw new ProviderRetrySafeError("test_retry_safe_preflight"); },
  });
  const preflightZero = await settledRunLines("test-turns-preflight-zero");
  expect(preflightZero.some((line) => line.endsWith(" process_outcome blocked_preflight"))).toBe(true);
  expect(preflightZero.some((line) => line.endsWith(" num_turns 0"))).toBe(true);
});

test("dispatch keeps omitted, reported-zero, and preflight-zero turn evidence distinct", async () => {
  const { dispatch } = await import("./support/dispatch");
  writeFileSync(log, "");

  const terminal = (numTurns?: number) => () => (async function* () {
    yield {
      type: "result", subtype: "success", result: "done", duration_ms: 1,
      ...(numTurns === undefined ? {} : { num_turns: numTurns }),
    };
  })();
  const dependencies = (agentId: string, queryFn: any) => ({
    agentId,
    routingMetadata: presetRequest("integrator"),
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
  const { spawn } = await import("./support/spawn");
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
    routingMetadata: applyGafferStaffing({
      role: "director", tier: "economy", reasoning: "low", posture: "preserve",
      composition: { kind: "preset", id: "director",
        overrides: ["tier", "reasoning", "posture"],
        overrideReason: "exercise the explicit public-dial composition boundary" },
    }), provider: "anthropic", queryFn,
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
  const { spawn } = await import("./support/spawn");
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
    role: "integrator", routingMetadata: presetRequest("integrator"), provider: "anthropic", queryFn,
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
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");
  let queryOptions: any;
  const queryFn: any = (args: any) => {
    queryOptions = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "routed", duration_ms: 1, num_turns: 1 };
    })();
  };

  await spawn({ prompt: "route with OpenAI", agentId: "test-openai-designer",
    role: "designer", routingMetadata: presetRequest("designer"), provider: "openai", queryFn });

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
  const { spawn } = await import("./support/spawn");
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
      role: "designer", routingMetadata: presetRequest("designer"), provider: "anthropic", target: "claude-work",
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
  const { spawn } = await import("./support/spawn");
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
    role: "integrator", routingMetadata: presetRequest("integrator"), provider: "anthropic", queryFn });

  const logged = await waitForLog("struggle consecutive_errors");
  expect(logged).toContain("struggle consecutive_errors");
  console.log(`[bar-evidence] ${logged.split("\n").find((l) => l.includes("struggle consecutive_errors"))}`);
  // The run still finished normally at its original route — no ladder climb.
  expect(modelChanged).toBe(false);
  expect(logged).toContain("tell agent:test-struggle-lane model claude-opus-4-8");
  expect(logged).not.toContain("outcome provider_escalation_unsupported");
});
