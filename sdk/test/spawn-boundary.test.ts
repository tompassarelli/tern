// End-to-end error-boundary test, hermetic (no live coordinator, no network).
// Injects a queryFn whose async generator THROWS mid-stream — exactly what the real SDK
// does when its subprocess dies (readMessages() rethrows exitError) — and asserts spawn():
//   1. does NOT reject (returns a partial string) — supervision, not fail-fast;
//   2. emits the death notification (agent_death fact on @swarm) via the fix's finally path.
// All coordinator writes are redirected to a fake `north` on PATH + NORTH_BIN, logged to a
// temp file; NORTH_PORT points at an unused port so any stray bb write no-ops.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
let log: string;

// Every env key this test mutates — snapshot for exact restore (set-or-delete) in afterAll,
// so a scrub here never leaks into sibling suites. Includes the INHERITED IDENTITY keys:
// a real north session runs with AGENT_ID / NORTH_AGENT_ID / AGENT_COORDINATOR (+ model/
// role/effort) exported, and a naive spawn INHERITS them — so scripted test deaths would
// stamp the REAL coordinator onto @agent:test-dead-W3 and ping a live session every reactor
// sweep (~50s). We scrub identity and pin a SYNTHETIC coordinator so any fact/ping the
// harness emits routes nowhere real, even if a future edit lets a write escape the fake.
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

// Synthetic coordinator handle: names a session that does not exist, so a death/stall ping
// lands in a graveyard inbox instead of a live coordinator. pid keeps it unique per run.
const TEST_COORDINATOR = `test-coordinator-${process.pid}`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "north-death-"));
  log = join(dir, "death.log");
  // Fake `north`: append every invocation's args to the log, succeed. Stands in for the
  // death fact (tell @swarm ...), the identity tells (writeAgentFacts), and the telemetry
  // recordRun tells — none of which may hit the real graph. Requires every SDK module to
  // resolve the engine via NORTH_BIN (identity.ts was the lone bare-`north` holdout).
  const fake = join(dir, "north");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
  chmodSync(fake, 0o755);

  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.NORTH_BIN = fake;
  process.env.NORTH_PORT = "59999"; // unused -> presence/any bb write silently no-ops
  process.env.NORTH_STREAM_DIR = dir; // keep stream jsonl out of ~/code/agent-data
  process.env.AGENT_LAWS = "off"; // trim system-prompt file reads; irrelevant to the boundary
  process.env.AGENT_PRAXIS = "off";
  process.env.NORTH_ROUTING_POLICY = join(dir, "absent-routing-policy.json");
  process.env.NORTH_PROVIDER_OBSERVATIONS = join(dir, "absent-provider-observations.json");
  delete process.env.NORTH_ALLOCATION_MODE;
  delete process.env.NORTH_PROVIDER_ORDER;
  delete process.env.NORTH_PROVIDER_WEIGHTS;
  delete process.env.NORTH_RESERVED_FRONTIER_PROVIDER;
  delete process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE;
  delete process.env.NORTH_OPENAI_ENTITLEMENT_PRESSURE;

  // Scrub inherited identity so a test spawn cannot adopt the invoking session's id/coordinator.
  delete process.env.AGENT_ID;
  delete process.env.NORTH_AGENT_ID;
  delete process.env.AGENT_MODEL;
  delete process.env.AGENT_ROLE;
  delete process.env.AGENT_EFFORT;
  process.env.AGENT_COORDINATOR = TEST_COORDINATOR; // pin the graveyard coordinator
});

afterAll(() => {
  for (const k of MANAGED_ENV) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test("a query that dies mid-stream -> partial return + agent_death notification", async () => {
  const { spawn } = await import("../src/spawn");

  // Fake SDK query: yields one assistant turn (simulating work-in-progress on a long gate),
  // then throws the exact exitError the real ProcessTransport raises on an OOM kill.
  const dyingQuery: any = () =>
    (async function* () {
      yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "starting long gate" }] } };
      throw new Error("Claude Code process terminated by signal 9");
    })();

  let result: string | undefined;
  let threw = false;
  try {
    result = await spawn({ prompt: "run a long gate", agentId: "test-dead-W3", queryFn: dyingQuery });
  } catch {
    threw = true;
  }

  // 1. Supervision: spawn resolved with a (partial) string instead of rejecting.
  expect(threw).toBe(false);
  expect(typeof result).toBe("string");

  // 2. The death was announced: an agent_death fact on @swarm naming the dead agent.
  expect(existsSync(log)).toBe(true);
  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("tell @swarm agent_death");
  expect(logged).toContain("test-dead-W3");
  expect(logged).toContain("signal 9");

  // 3. Identity is scrubbed: writeAgentFacts routed through the fake (NORTH_BIN honored,
  //    not a bare-`north` escape) and stamped the SYNTHETIC coordinator — proving no test
  //    spawn adopts the invoking session's real coordinator id.
  expect(logged).toContain(`coordinator ${TEST_COORDINATOR}`);
  const inheritedCoord = origEnv.AGENT_COORDINATOR;
  if (inheritedCoord) expect(logged).not.toContain(inheritedCoord);
});

test("an exhausted run envelope rejects before an injected provider boundary is called", async () => {
  const policy = join(dir, "denied-routing-policy.json");
  writeFileSync(policy, JSON.stringify({
    version: 1, mode: "preferential",
    targets: [{ id: "anthropic", provider: "anthropic" }, { id: "openai", provider: "openai" }],
    targetOrder: ["anthropic", "openai"],
    envelopes: { month: { runs: 0 } },
  }));
  const absentPolicy = process.env.NORTH_ROUTING_POLICY!;
  const originalAccounting = process.env.NORTH_ENVELOPE_ACCOUNTING;
  try {
    process.env.NORTH_ROUTING_POLICY = policy;
    process.env.NORTH_ENVELOPE_ACCOUNTING = join(dir, "denied-accounting.json");
    let providerCalls = 0;
    await expect((await import("../src/spawn")).spawn({
      prompt: "must not run", agentId: "denied-before-provider",
      queryFn: () => { providerCalls++; return { async *[Symbol.asyncIterator]() {} } as any; },
    })).rejects.toThrow("runs 0/0");
    expect(providerCalls).toBe(0);
  } finally {
    process.env.NORTH_ROUTING_POLICY = absentPolicy;
    if (originalAccounting === undefined) delete process.env.NORTH_ENVELOPE_ACCOUNTING;
    else process.env.NORTH_ENVELOPE_ACCOUNTING = originalAccounting;
  }
});

test("Gaffer-derived frontier tier is hydrated before envelope admission", async () => {
  const policy = join(dir, "denied-frontier-policy.json");
  writeFileSync(policy, JSON.stringify({
    version: 1, mode: "preferential",
    targets: [{ id: "anthropic", provider: "anthropic" }, { id: "openai", provider: "openai" }],
    targetOrder: ["anthropic", "openai"],
    envelopes: { month: { runs: 10, frontierRuns: 0 } },
  }));
  const absentPolicy = process.env.NORTH_ROUTING_POLICY!;
  const originalAccounting = process.env.NORTH_ENVELOPE_ACCOUNTING;
  try {
    process.env.NORTH_ROUTING_POLICY = policy;
    process.env.NORTH_ENVELOPE_ACCOUNTING = join(dir, "denied-frontier-accounting.json");
    let providerCalls = 0;
    await expect((await import("../src/spawn")).spawn({
      prompt: "must not run", agentId: "gaffer-frontier-before-provider",
      routingMetadata: { role: "designer" },
      queryFn: () => { providerCalls++; return { async *[Symbol.asyncIterator]() {} } as any; },
    })).rejects.toThrow("frontierRuns 0/0");
    expect(providerCalls).toBe(0);
  } finally {
    process.env.NORTH_ROUTING_POLICY = absentPolicy;
    if (originalAccounting === undefined) delete process.env.NORTH_ENVELOPE_ACCOUNTING;
    else process.env.NORTH_ENVELOPE_ACCOUNTING = originalAccounting;
  }
});
