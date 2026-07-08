// End-to-end error-boundary test, hermetic (no live coordinator, no network).
// Injects a queryFn whose async generator THROWS mid-stream — exactly what the real SDK
// does when its subprocess dies (readMessages() rethrows exitError) — and asserts spawn():
//   1. does NOT reject (returns a partial string) — supervision, not fail-fast;
//   2. emits the death notification (agent_death fact on @swarm) via the fix's finally path.
// All coordinator writes are redirected to a fake `tern` on PATH + TERN_BIN, logged to a
// temp file; TERN_PORT points at an unused port so any stray bb write no-ops.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
let log: string;
const origEnv = { ...process.env };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tern-death-"));
  log = join(dir, "death.log");
  // Fake `tern`: append every invocation's args to the log, succeed. Stands in for both the
  // death fact (tell @swarm ...) and the telemetry recordRun tells — neither hits the graph.
  const fake = join(dir, "tern");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
  chmodSync(fake, 0o755);

  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.TERN_BIN = fake;
  process.env.TERN_PORT = "59999"; // unused -> presence/any bb write silently no-ops
  process.env.TERN_STREAM_DIR = dir; // keep stream jsonl out of ~/code/agent-data
  process.env.AGENT_LAWS = "off"; // trim system-prompt file reads; irrelevant to the boundary
  process.env.AGENT_PRAXIS = "off";
});

afterAll(() => {
  process.env.PATH = origEnv.PATH;
  process.env.TERN_BIN = origEnv.TERN_BIN;
  process.env.TERN_PORT = origEnv.TERN_PORT;
  process.env.TERN_STREAM_DIR = origEnv.TERN_STREAM_DIR;
  process.env.AGENT_LAWS = origEnv.AGENT_LAWS;
  process.env.AGENT_PRAXIS = origEnv.AGENT_PRAXIS;
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
});
