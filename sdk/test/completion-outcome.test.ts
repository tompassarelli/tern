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
