// Spawn-wiring proof for per-lane worktree isolation (design: docs/private/worktree-isolation-report.md).
// The pure salvage-gate + payload contract live in worktree.test.ts; THIS file drives the
// impure spawn() seam end-to-end, hermetically (fake `north` on NORTH_BIN, unused NORTH_PORT,
// injected queryFn that CAPTURES the SDK Options and returns a clean `ran`). Two guarantees:
//   1. DEFAULT OFF => zero behavior change: no `cwd` in Options, no worktree payload appended
//      to the system prompt, no worktree/branch fact written, no /tmp worktree created.
//   2. OPT-IN (worktree:true) => a real worktree provisioned at /tmp/<repo>-lane-<id> on
//      branch lane-<id>; Options.cwd points INTO it; the isolation payload is appended; the
//      worktree/branch facts route through NORTH_BIN; a clean `ran` removes the tree inline.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { presetRequest } from "./routing-fixtures";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;      // fake-north sandbox
let log: string;      // fake-north invocation log
let repo: string;     // scratch git repo the opt-in lane worktrees off of
let origCwd: string;

const MANAGED_ENV = [
  "PATH", "NORTH_BIN", "NORTH_IDENTITY_TEST_REDIRECT", "NORTH_PORT", "NORTH_STREAM_DIR",
  "AGENT_LAWS", "AGENT_PRAXIS",
  "AGENT_ID", "NORTH_AGENT_ID", "AGENT_COORDINATOR", "AGENT_MODEL", "AGENT_ROLE", "AGENT_EFFORT",
  "AGENT_WORKTREE", "AGENT_SETUP_CMD",
  "AGENT_TOPOLOGY", "AGENT_TASK_GRADE", "AGENT_REASONING", "AGENT_POSTURE",
  "AGENT_PROVIDER", "AGENT_TARGET", "AGENT_TIER", "AGENT_IDENTITY_ROLE",
  "AGENT_DOMAIN_REQUIREMENTS", "AGENT_COMPOSITION",
] as const;
const origEnv: Record<string, string | undefined> = {};
for (const k of MANAGED_ENV) origEnv[k] = process.env[k];

const TEST_COORDINATOR = `test-coordinator-${process.pid}`;

// A fake SDK query that CAPTURES the Options it was handed, then yields a single clean
// `result` turn so spawn() finalizes outcome=`ran` (the only worktree-removal case).
function capturingQuery(sink: { options?: any }) {
  return (args: any) => {
    sink.options = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "done" };
    })();
  };
}

// Hermetic feed subscription (live-input route) matching spawn-boundary.test.ts.
function readySubscription(stop: () => void = () => {}) {
  return Object.assign(stop, {
    ready: Promise.resolve(),
    drain: async () => {},
    isArmed: () => true,
  });
}

beforeAll(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "north-wt-spawn-"));
  log = join(dir, "north.log");
  const fake = join(dir, "north");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
  chmodSync(fake, 0o755);

  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.NORTH_BIN = fake;
  process.env.NORTH_IDENTITY_TEST_REDIRECT = "1";
  process.env.NORTH_PORT = "59999";
  process.env.NORTH_STREAM_DIR = dir;
  process.env.AGENT_LAWS = "off";
  process.env.AGENT_PRAXIS = "off";
  delete process.env.AGENT_ID;
  delete process.env.NORTH_AGENT_ID;
  delete process.env.AGENT_MODEL;
  delete process.env.AGENT_ROLE;
  delete process.env.AGENT_EFFORT;
  delete process.env.AGENT_WORKTREE;
  delete process.env.AGENT_SETUP_CMD;
  // A live managed lane exports its own Gaffer envelope; a hermetic spawn test
  // must not inherit worker topology (spawn would be denied) or any routing pin.
  delete process.env.AGENT_TOPOLOGY;
  delete process.env.AGENT_TASK_GRADE;
  delete process.env.AGENT_REASONING;
  delete process.env.AGENT_POSTURE;
  delete process.env.AGENT_PROVIDER;
  delete process.env.AGENT_TARGET;
  delete process.env.AGENT_TIER;
  delete process.env.AGENT_IDENTITY_ROLE;
  delete process.env.AGENT_DOMAIN_REQUIREMENTS;
  delete process.env.AGENT_COMPOSITION;
  process.env.AGENT_COORDINATOR = TEST_COORDINATOR;

  // Scratch git repo the opt-in lane cuts its worktree from. basename must be unique so the
  // /tmp/<basename>-lane-<id> path can't collide with a real repo's worktree.
  repo = join(dir, `wtspawnrepo-${process.pid}`);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "hello\n");
  execFileSync("git", ["-C", repo, "add", "a.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
});

afterAll(() => {
  try { process.chdir(origCwd); } catch {}
  for (const k of MANAGED_ENV) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test("DEFAULT (no worktree) => no cwd, no payload, no worktree fact, no /tmp tree — byte-identical", async () => {
  const { spawn } = await import("./support/spawn");
  const sink: { options?: any } = {};
  const agentId = "wt-off-1";
  const result = await spawn({
    prompt: "trivial default lane", agentId,
    routingMetadata: presetRequest("integrator"),
    queryFn: capturingQuery(sink),
    feedSubscriber: () => readySubscription(),
  });

  expect(typeof result).toBe("string");
  // The core guarantee: default off => cwd is the shared tree (process.cwd()),
  // never a provisioned worktree.
  expect(sink.options).toBeDefined();
  expect(sink.options.cwd).toBe(process.cwd());
  // No isolation payload appended to the system prompt.
  expect(sink.options.systemPrompt).not.toContain("Worktree isolation");
  expect(sink.options.systemPrompt).not.toContain("ISOLATED");
  // No worktree/branch fact was ever written for this lane.
  const logged = existsSync(log) ? readFileSync(log, "utf8") : "";
  expect(logged).not.toContain(`tell agent:${agentId} worktree`);
  expect(logged).not.toContain(`tell agent:${agentId} branch`);
  // No worktree directory materialized anywhere under /tmp for this id.
  expect(existsSync(`/tmp/${agentId}`)).toBe(false);
});

test("OPT-IN (worktree:true) => real worktree, cwd inside it, payload appended, facts written, clean ran removes it", async () => {
  const { spawn } = await import("./support/spawn");
  process.chdir(repo); // spawn reads repoRoot = process.cwd()
  const sink: { options?: any } = {};
  const agentId = "wt-on-1";
  const expectedPath = `/tmp/${require("node:path").basename(repo)}-lane-${agentId}`;

  const result = await spawn({
    prompt: "trivial worktree lane", agentId, worktree: true,
    routingMetadata: presetRequest("integrator"),
    queryFn: capturingQuery(sink),
    feedSubscriber: () => readySubscription(),
  });
  process.chdir(origCwd);

  expect(typeof result).toBe("string");
  // Options.cwd points INTO the provisioned worktree.
  expect(sink.options.cwd).toBe(expectedPath);
  // The isolation + landing + verify payload is appended to the lane's system prompt.
  expect(sink.options.systemPrompt).toContain("Worktree isolation");
  expect(sink.options.systemPrompt).toContain("ISOLATED");
  expect(sink.options.systemPrompt).toContain("--ff-only");
  // Reports pointed at the MAIN tree's docs/private (absolute), not the worktree's.
  expect(sink.options.systemPrompt).toContain(`${repo}/docs/private`);
  // worktree + branch facts routed through NORTH_BIN (not a bare-`north` escape).
  const logged = readFileSync(log, "utf8");
  expect(logged).toContain(`tell agent:${agentId} worktree ${expectedPath}`);
  expect(logged).toContain(`tell agent:${agentId} branch lane-${agentId}`);
  // Clean `ran` => the worktree + its branch were removed inline (salvage gate: remove case).
  expect(existsSync(expectedPath)).toBe(false);
  const branches = execFileSync("git", ["-C", repo, "branch", "--list", `lane-${agentId}`], { encoding: "utf8" });
  expect(branches.trim()).toBe("");
});

test("explicit worktree provisioning failure aborts before provider, admission, identity, or run side effects", async () => {
  const { spawn } = await import("./support/spawn");
  const agentId = "wt-provision-fail-1";
  const branch = `lane-${agentId}`;
  const expectedPath = `/tmp/${require("node:path").basename(repo)}-${branch}`;
  const beforeLog = existsSync(log) ? readFileSync(log, "utf8") : "";
  const sharedBytes = readFileSync(join(repo, "a.txt"), "utf8");
  const sink: { options?: any } = {};
  let providerQueries = 0;
  let clockAdmissions = 0;
  let envelopeAdmissions = 0;

  // Plant a real `git worktree add -b` failure: the exact derived branch
  // already exists. The branch is harmless and points at the scratch repo HEAD.
  execFileSync("git", ["-C", repo, "branch", branch, "HEAD"]);
  process.chdir(repo);
  let thrown: unknown;
  try {
    await spawn({
      prompt: "must never reach provider execution",
      agentId,
      worktree: true,
      routingMetadata: presetRequest("integrator"),
      queryFn: (args: any) => {
        providerQueries++;
        return capturingQuery(sink)(args);
      },
      feedSubscriber: () => readySubscription(),
      admitBillableClock: () => {
        clockAdmissions++;
        throw new Error("clock admission must be unreachable");
      },
      admitResourceEnvelope: async () => {
        envelopeAdmissions++;
        throw new Error("envelope admission must be unreachable");
      },
    });
  } catch (error) {
    thrown = error;
  } finally {
    process.chdir(origCwd);
  }

  expect(String(thrown)).toContain("explicit worktree provisioning failed");
  expect(String(thrown)).toContain("spawn aborted before provider execution");
  expect(providerQueries).toBe(0);
  expect(clockAdmissions).toBe(0);
  expect(envelopeAdmissions).toBe(0);
  expect(sink.options).toBeUndefined();
  expect(existsSync(expectedPath)).toBe(false);
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe(sharedBytes);
  expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  // NORTH_BIN captures every identity/run writer invocation. Exact byte equality
  // proves the failed isolated spawn published neither.
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(beforeLog);

  execFileSync("git", ["-C", repo, "branch", "-d", "--", branch]);
});
