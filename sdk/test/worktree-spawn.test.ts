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
import type {
  WorktreeAllocationEvent,
  WorktreeAllocationRegistration,
} from "../src/worktree";
import { ProviderRetrySafeError } from "../src/providers";

let dir: string;      // fake-north sandbox
let log: string;      // fake-north invocation log
let repo: string;     // scratch git repo the opt-in lane worktrees off of
let origCwd: string;

const MANAGED_ENV = [
  "PATH", "NORTH_BIN", "NORTH_PEER_BB", "NORTH_IDENTITY_TEST_REDIRECT", "NORTH_PORT", "NORTH_STREAM_DIR",
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
  const fakeBb = join(dir, "bb");
  writeFileSync(fakeBb, `#!/usr/bin/env bash\nprintf 'bb %s\\n' "$*" >> "${log}"\nexit 0\n`);
  chmodSync(fakeBb, 0o755);

  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.NORTH_BIN = fake;
  process.env.NORTH_PEER_BB = fakeBb;
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

test("managed authoring without a registered worktree fails closed before canonical mutation", async () => {
  const { spawn } = await import("./support/spawn");
  const sink: { options?: any } = {};
  const agentId = "wt-off-1";
  let providerQueries = 0;
  let thrown: unknown;
  try { await spawn({
    prompt: "trivial default lane", agentId, worktree: false,
    routingMetadata: presetRequest("integrator"),
    queryFn: (args: any) => {
      providerQueries++;
      return capturingQuery(sink)(args);
    },
    feedSubscriber: () => readySubscription(),
  }); } catch (error) { thrown = error; }

  expect(String(thrown)).toContain("managed mutation requires a registered worktree allocation");
  expect(String(thrown)).toContain("canonical checkout mutation denied");
  expect(providerQueries).toBe(0);
  expect(sink.options).toBeUndefined();
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
  const registrations: WorktreeAllocationRegistration[] = [];
  const events: WorktreeAllocationEvent[] = [];

  const result = await spawn({
    prompt: "trivial worktree lane", agentId, worktree: true,
    routingMetadata: presetRequest("integrator"),
    queryFn: capturingQuery(sink),
    feedSubscriber: () => readySubscription(),
    worktreeAllocationWriter: {
      register: (registration: WorktreeAllocationRegistration) => registrations.push(registration),
      event: (_subject: string, event: WorktreeAllocationEvent) => events.push(event),
    },
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
  expect(registrations).toHaveLength(1);
  expect(registrations[0]).toMatchObject({
    worktree: expectedPath,
    durableRef: `refs/heads/lane-${agentId}`,
    repositoryLayout: "standalone",
    agent: `@agent:${agentId}`,
    thread: "@thread:ad-hoc",
    concern: "@concern:unattributed",
  });
  expect(events.map(({ type }) => type)).toEqual([
    "provisioned", "authority-profiled", "quarantined",
  ]);
  expect(events[1].providerAuthorityProfile).toMatchObject({
    phase: "resolved",
    authMode: expect.stringMatching(/^(ambient|isolated)$/),
  });
  expect(existsSync(expectedPath)).toBe(true);
  const branches = execFileSync("git", ["-C", repo, "branch", "--list", `lane-${agentId}`], { encoding: "utf8" });
  expect(branches).toContain(`lane-${agentId}`);
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", expectedPath]);
  execFileSync("git", ["-C", repo, "branch", "-D", `lane-${agentId}`]);
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
  // Physical registration is now the one intentional pre-Git side effect. The
  // collision leaves an append-only planned -> quarantined history plus an
  // explicit orphan-recovery fact, while provider/admission/run remain unreachable.
  const afterLog = existsSync(log) ? readFileSync(log, "utf8") : "";
  const delta = afterLog.slice(beforeLog.length).trim().split("\n");
  expect(delta).toHaveLength(3);
  expect(delta[0]).toContain("worktree-allocation-internal.clj 59999 register");
  expect(delta[1]).toContain('"type":"quarantined"');
  expect(delta[1]).toContain('"code":"durable_ref_collision"');
  expect(delta[1]).toContain('"resourceState":"quarantined"');
  expect(delta.slice(0, 2).every((line) => line.startsWith("bb "))).toBe(true);
  expect(delta[2]).toBe(
    `tell agent:${agentId} worktree_orphaned ${expectedPath} | worktree provisioning failed after physical identity appeared — inspect; never auto-delete`,
  );
  expect(delta.join("\n")).not.toContain("must never reach provider execution");

  execFileSync("git", ["-C", repo, "branch", "-d", "--", branch]);
});

test("pre-provider admission failure preserves the physical resource in quarantine", async () => {
  const { spawn } = await import("./support/spawn");
  const agentId = "wt-admission-fail-1";
  const expectedPath = `/tmp/${require("node:path").basename(repo)}-lane-${agentId}`;
  const registrations: WorktreeAllocationRegistration[] = [];
  const events: WorktreeAllocationEvent[] = [];
  let providerQueries = 0;
  process.chdir(repo);
  let thrown: unknown;
  try {
    await spawn({
      prompt: "admission must roll back before provider",
      agentId,
      worktree: true,
      routingMetadata: presetRequest("integrator"),
      queryFn: () => {
        providerQueries++;
        return capturingQuery({})({ options: {} });
      },
      feedSubscriber: () => readySubscription(),
      worktreeAllocationWriter: {
        register: (registration: WorktreeAllocationRegistration) => registrations.push(registration),
        event: (_subject: string, event: WorktreeAllocationEvent) => events.push(event),
      },
      admitBillableClock: () => { throw new Error("injected_clock_admission_failure"); },
      completeResourceEnvelope: async () => {},
    });
  } catch (error) {
    thrown = error;
  } finally {
    process.chdir(origCwd);
  }

  expect(String(thrown)).toContain("injected_clock_admission_failure");
  expect(providerQueries).toBe(0);
  expect(registrations).toHaveLength(1);
  expect(events.map(({ type }) => type)).toEqual(["provisioned", "quarantined"]);
  expect(events.at(-1)).toMatchObject({ type: "quarantined", resourceState: "quarantined" });
  expect(existsSync(expectedPath)).toBe(true);
  expect(execFileSync(
    "git", ["-C", repo, "branch", "--list", `lane-${agentId}`], { encoding: "utf8" },
  )).toContain(`lane-${agentId}`);
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", expectedPath]);
  execFileSync("git", ["-C", repo, "branch", "-D", `lane-${agentId}`]);
});

test("typed provider preflight refusal preserves a queryable quarantine with exact recovery", async () => {
  const { spawn } = await import("./support/spawn");
  const agentId = "wt-provider-preflight-fail-1";
  const expectedPath = `/tmp/${require("node:path").basename(repo)}-lane-${agentId}`;
  const events: WorktreeAllocationEvent[] = [];
  process.chdir(repo);
  try {
    const result = await spawn({
      prompt: "typed retry-safe provider preflight refusal",
      agentId,
      worktree: true,
      routingMetadata: presetRequest("integrator"),
      queryFn: () => (async function* () {
        throw new ProviderRetrySafeError("injected_provider_admission_refusal");
      })(),
      feedSubscriber: () => readySubscription(),
      worktreeAllocationWriter: {
        register: () => {},
        event: (_subject: string, event: WorktreeAllocationEvent) => events.push(event),
      },
    });
    expect(result).toBe("");
  } finally {
    process.chdir(origCwd);
  }

  expect(events.map(({ type }) => type)).toEqual([
    "provisioned", "authority-profiled", "quarantined",
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "quarantined",
    resourceState: "quarantined",
    error: { code: "provider_preflight_refused", phase: "provider_admission" },
    recovery: {
      action: "inspect-and-salvage",
      resource: expectedPath,
      durableRef: `refs/heads/lane-${agentId}`,
    },
  });
  expect(existsSync(expectedPath)).toBe(true);

  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", expectedPath]);
  execFileSync("git", ["-C", repo, "branch", "-D", `lane-${agentId}`]);
});
