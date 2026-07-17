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
  await waitForLog("tell run-test-terminal-error-");
  await waitForLog("usage_total_status exact");
  const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.includes("run-test-terminal-error-"));
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
  const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.includes("run-test-repeated-terminals-"));
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

  const result = await dispatch("test-empty-dispatch", {
    agentId: "test-empty-dispatch-agent",
    routingMetadata: { role: "integrator" },
    claimDriver: (() => ({ release() {} })) as any,
    queryFn: () => (async function* () {})() as any,
    loadThreadFacts: () => [
      { predicate: "title", value: "Empty provider dispatch" },
      { predicate: "planned", value: "true" },
      { predicate: "atomic", value: "true" },
    ],
    loadChildren: () => [],
  });

  expect(result.result).toBe("");
  const lines = await settledRunLines(
    "test-empty-dispatch-agent", "applied_domain_requirement_count 0",
  );
  expect(lines.some((line) => line.endsWith(" process_outcome provider_error"))).toBe(true);
  expect(lines.some((line) => line.endsWith(" delivery_outcome blocked"))).toBe(true);
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
  const marker = `tell run-${agent}-`;
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

test("in-flight escalation refreshes model, effort, and semantic handle without resetting identity", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  const models: string[] = [];
  const queryFn: any = () => ({
    setModel: async (model: string) => { models.push(model); },
    applyFlagSettings: async () => {},
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 3; i++) {
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { i } }] } };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: true }] } };
      }
      yield { type: "result", subtype: "success", result: "recovered", duration_ms: 1, num_turns: 4 };
    },
  });

  await spawn({ prompt: "recover from errors", agentId: "test-escalated-integrator",
    role: "integrator", provider: "anthropic", escalate: true, queryFn });

  expect(models.length).toBeGreaterThan(0);
  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("tell agent:test-escalated-integrator effort xhigh");
  expect(logged).toContain("tell agent:test-escalated-integrator display_handle anthropic-ambient-opus-xhigh-gaffer-integrator-integrator");
  expect(logged.match(/tell agent:test-escalated-integrator spawned_at/g)?.length).toBe(1);
});

test("unsupported in-flight escalation is explicit and does not fabricate a higher route", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  let interrupts = 0;
  const queryFn: any = () => ({
    interrupt: async () => { interrupts++; },
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 3; i++) {
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: `u${i}`, name: "Bash", input: { i } }] } };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `u${i}`, is_error: true }] } };
      }
      yield { type: "result", subtype: "success", result: "must not reach", duration_ms: 1, num_turns: 4 };
    },
  });

  await spawn({ prompt: "unsupported escalation", agentId: "test-escalation-unsupported",
    role: "integrator", provider: "openai", escalate: true, queryFn });

  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("tell agent:test-escalation-unsupported outcome provider_escalation_unsupported");
  expect(logged).toContain("tell agent:test-escalation-unsupported model gpt-5.6-sol");
  expect(logged).toContain("tell agent:test-escalation-unsupported effort high");
  expect(logged).not.toContain("tell agent:test-escalation-unsupported model sonnet");
  expect(logged).not.toContain("tell agent:test-escalation-unsupported effort medium");
  expect(logged).not.toContain("tell agent:test-escalation-unsupported effort xhigh");
  expect(logged).not.toContain("tell @swarm agent_death");
  expect(interrupts).toBe(1);
});

test("a failed effort escalation records the applied model and interrupts before death", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  const effortFailure = new Error("effort control rejected");
  let interrupts = 0;
  const queryFn: any = () => ({
    setModel: async () => {},
    applyFlagSettings: async () => { throw effortFailure; },
    interrupt: async () => { interrupts++; },
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 3; i++) {
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: `p${i}`, name: "Bash", input: { i } }] } };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `p${i}`, is_error: true }] } };
      }
      yield { type: "result", subtype: "success", result: "must not reach", duration_ms: 1, num_turns: 4 };
    },
  });

  await spawn({ prompt: "partial escalation", agentId: "test-escalation-partial",
    role: "integrator", provider: "anthropic", escalate: true, queryFn });

  const logged = readFileSync(log, "utf8");
  expect(interrupts).toBe(1);
  expect(logged).toContain("tell agent:test-escalation-partial model claude-opus-4-8");
  expect(logged).toContain("tell agent:test-escalation-partial effort high");
  expect(logged).not.toContain("tell agent:test-escalation-partial effort xhigh");
  expect(logged).toContain("tell agent:test-escalation-partial outcome died");
  expect(logged).toContain("effort control rejected");
});

test("the escalation ceiling interrupts the active child before reporting completion", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  process.env.NORTH_FABLE_NOW = "2026-07-20T04:00:00Z";
  let interrupts = 0;
  const models: string[] = [];
  const queryFn: any = () => ({
    setModel: async (model: string) => { models.push(model); },
    applyFlagSettings: async () => {},
    interrupt: async () => { interrupts++; },
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 6; i++) {
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: `c${i}`, name: "Bash", input: { i } }] } };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `c${i}`, is_error: true }] } };
      }
      yield { type: "result", subtype: "success", result: "must not reach", duration_ms: 1, num_turns: 7 };
    },
  });

  await spawn({ prompt: "reach escalation ceiling", agentId: "test-escalation-ceiling",
    role: "integrator", provider: "anthropic", escalate: true, queryFn });

  const logged = readFileSync(log, "utf8");
  expect(models).toEqual(["claude-opus-4-8"]);
  expect(interrupts).toBe(1);
  expect(logged).toContain("tell agent:test-escalation-ceiling effort xhigh");
  expect(logged).toContain("tell agent:test-escalation-ceiling outcome struggle_ceiling");
  expect(logged).not.toContain("tell @swarm agent_death");
});

test("preset-hydrated Anthropic frontier promotes to Fable without losing requested reasoning", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  process.env.NORTH_FABLE_NOW = "2026-07-19T00:00:00Z";
  let queryOptions: any;
  const queryFn: any = (args: any) => {
    queryOptions = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "frontier", duration_ms: 1, num_turns: 1 };
    })();
  };

  await spawn({
    prompt: "frontier preset", agentId: "test-fable-designer",
    role: "designer", provider: "anthropic", queryFn,
  });

  expect(queryOptions.model).toBe("claude-fable-5");
  expect(queryOptions.effort).toBe("xhigh");
  const logged = await waitForLog("requested_reasoning xhigh");
  expect(logged).toContain("requested_role designer");
  expect(logged).toContain("routing_tier frontier");
  expect(logged).toContain("effort xhigh");
});
