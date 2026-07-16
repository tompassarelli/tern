// Reaper false-positive fix (thread 019f6af0-ba69): a lane that finishes must record its
// terminal outcome ON the lane entity (@agent:<id>), SYNCHRONOUSLY, before the process
// exits. Without it the reactor's presence-lapse sweep (cli/reap.clj reap-lane?) sees an
// EMPTY @agent outcome + a lapsed lease and reaps a COMPLETED lane as died-unreported —
// observed on ~400/410 lanes. recordRun's @run write is async fire-and-forget and cannot
// carry liveness (it races exit and needs a join the sweep must not depend on).
//
// Hermetic: a fake `north` on PATH + NORTH_BIN captures every tell to a temp log; the
// injected queryFn owns the whole SDK boundary, so no live coordinator / network / model.
// This is the same fake-engine pattern as spawn-boundary.test.ts.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
let log: string;

const MANAGED_ENV = [
  "PATH", "NORTH_BIN", "NORTH_PORT", "NORTH_STREAM_DIR", "AGENT_LAWS", "AGENT_PRAXIS",
  "AGENT_ID", "NORTH_AGENT_ID", "AGENT_COORDINATOR", "AGENT_MODEL", "AGENT_ROLE", "AGENT_EFFORT",
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
  delete process.env.AGENT_EFFORT;
  delete process.env.AGENT_TIER;
  delete process.env.AGENT_REASONING;
  delete process.env.AGENT_POSTURE;
  delete process.env.AGENT_TOPOLOGY;
  delete process.env.AGENT_TASK_GRADE;
  delete process.env.AGENT_DOMAIN_REQUIREMENTS;
  delete process.env.AGENT_COMPOSITION;
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

  // Fake SDK query: one assistant turn, then a terminal `result` (subtype success) — the
  // clean-finish shape. spawn finalizes outcome=ran and must stamp it on @agent:<id>.
  const cleanQuery: any = () =>
    (async function* () {
      yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "working" }] } };
      yield { type: "result", subtype: "success", result: "task done", duration_ms: 1, num_turns: 1 };
    })();

  const result = await spawn({ prompt: "do a bounded task", agentId: "test-done-ok", queryFn: cleanQuery });
  expect(result).toBe("task done");

  expect(existsSync(log)).toBe(true);
  const logged = readFileSync(log, "utf8");
  // The load-bearing assertion: the terminal outcome landed on the LANE entity itself, via
  // the NORTH_BIN-honoring sync write. This is exactly what reap-lane?'s empty-outcome
  // guard reads to keep a completed lane out of the died-unreported sweep.
  expect(logged).toContain("tell agent:test-done-ok outcome ran");
});

test("a lane that dies mid-stream records outcome=died ON the lane entity (reported, not silent)", async () => {
  const { spawn } = await import("../src/spawn");

  // The SDK subprocess dies mid-turn (real exitError shape). The finally path runs, so this
  // is a REPORTED death: outcome=died on @agent:<id> alongside the agent_death fact. The
  // reactor then skips it — died-unreported is reserved for a hard-kill where the finally
  // never runs and NO outcome lands anywhere.
  const dyingQuery: any = () =>
    (async function* () {
      yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "starting" }] } };
      throw new Error("Claude Code process terminated by signal 9");
    })();

  await spawn({ prompt: "dies", agentId: "test-done-died", queryFn: dyingQuery });

  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("tell agent:test-done-died outcome died");
  expect(logged).toContain("tell @swarm agent_death"); // death path still fires
});

async function waitForLog(needle: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const value = existsSync(log) ? readFileSync(log, "utf8") : "";
    if (value.includes(needle)) return value;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for telemetry fact: ${needle}`);
}

test("public spawn composes explicit axes before Gaffer hydration", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  process.env.NORTH_FABLE_NOW = "2026-07-20T07:00:00Z";
  let queryOptions: any;
  const queryFn: any = (args: any) => {
    queryOptions = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "composed", duration_ms: 1, num_turns: 1 };
    })();
  };

  await spawn({
    prompt: "exercise the real composition boundary", agentId: "test-composed-integrator",
    role: "integrator", tier: "economy", effort: "low", posture: "preserve",
    routingMetadata: { topology: "orchestrator" }, provider: "anthropic", queryFn,
  });

  expect(queryOptions.model).toBe("claude-sonnet-4-6");
  expect(queryOptions.effort).toBe("low");
  const logged = await waitForLog("topology orchestrator");
  for (const fact of [
    "requested_role integrator", "task_grade senior", "topology orchestrator",
    "routing_tier economy", "requested_reasoning low", "routing_posture preserve",
  ]) expect(logged).toContain(fact);
});

test("public role-only integrator spawn hydrates the complete Gaffer recipe", async () => {
  const { spawn } = await import("../src/spawn");
  writeFileSync(log, "");
  process.env.NORTH_FABLE_NOW = "2026-07-20T07:00:00Z";
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
});

test("recipe-hydrated Anthropic frontier promotes to Fable without losing requested reasoning", async () => {
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
    prompt: "frontier recipe", agentId: "test-fable-designer",
    role: "designer", provider: "anthropic", queryFn,
  });

  expect(queryOptions.model).toBe("claude-fable-5");
  expect(queryOptions.effort).toBe("high");
  const logged = await waitForLog("requested_reasoning xhigh");
  expect(logged).toContain("requested_role designer");
  expect(logged).toContain("routing_tier frontier");
  expect(logged).toContain("effort high");
});
