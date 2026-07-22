import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  provisionWorktree,
  rollbackProvisionedWorktree,
  worktreeFinalize,
  type WorktreeAllocationEvent,
  type WorktreeAllocationRegistration,
  type WorktreeAllocationWriter,
} from "../src/worktree";

interface Capture {
  registrations: WorktreeAllocationRegistration[];
  events: Array<{ subject: string; event: WorktreeAllocationEvent }>;
}

function captureWriter(
  capture: Capture,
  failRegister = false,
): WorktreeAllocationWriter {
  return {
    register(registration) {
      if (failRegister) throw new Error("injected registration refusal");
      capture.registrations.push(structuredClone(registration));
    },
    event(subject, event) {
      capture.events.push({ subject, event: structuredClone(event) });
    },
  };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function initializedRepo(root: string, name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "north-test@example.invalid");
  git(repo, "config", "user.name", "North test");
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-qm", "base");
  return repo;
}

function ownership(id: string, capture: Capture) {
  return {
    runId: `run:${id}-00000000-0000-4000-8000-000000000000`,
    thread: "019f8a82-3dce-7418-b2c0-fc6184fc79c6",
    concern: "concern-1784735694797-a27c",
    provider: "auto" as const,
    writer: captureWriter(capture),
  };
}

let root: string;
let repo: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "north-worktree-allocation-"));
  repo = initializedRepo(root, `standalone-${process.pid}`);
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("physical allocation registration", () => {
  test("standalone repository publishes the exact content-free ownership projection before provisioning", () => {
    const capture: Capture = { registrations: [], events: [] };
    const id = `standalone-${process.pid}`;
    const lease = provisionWorktree(id, { repoRoot: repo, ...ownership(id, capture) });
    const registration = capture.registrations[0];

    expect(registration.repositoryLayout).toBe("standalone");
    expect(registration.gitCommonDir).toBe(realpathSync(join(repo, ".git")));
    expect(registration.sourceRoot).toBe(realpathSync(repo));
    expect(registration.worktree).toBe(lease.path);
    expect(registration.durableRef).toBe(`refs/heads/lane-${id}`);
    expect(registration.baseOid).toBe(git(repo, "rev-parse", "HEAD"));
    expect(registration.headOid).toBe(registration.baseOid);
    expect(registration.run).toStartWith("@run:");
    expect(registration.agent).toBe(`@agent:${id}`);
    expect(registration.thread).toBe("@019f8a82-3dce-7418-b2c0-fc6184fc79c6");
    expect(registration.concern).toBe("@concern-1784735694797-a27c");
    expect(registration.lease.enforcement).toBe("phase-1-record-only");
    expect(registration.providerAuthorityProfile).toEqual({
      version: 1, phase: "requested", provider: "auto", target: "unresolved",
      authMode: "unresolved", profile: "unresolved",
    });
    expect(capture.events.map(({ event }) => event.type)).toEqual(["provisioned"]);
    expect(Object.keys(registration).sort()).toEqual([
      "agent", "allocationNonce", "baseOid", "concern", "durableRef", "event",
      "gitCommonDir", "headOid", "lease", "providerAuthorityProfile",
      "repositoryIdentity", "repositoryLayout", "run", "sourceRoot", "subject",
      "thread", "version", "worktree",
    ]);

    worktreeFinalize(id, "ran", { ...lease });
    expect(capture.events.at(-1)?.event.type).toBe("released");
    expect(existsSync(lease.path)).toBe(false);
  });

  test("linked source retains physical common-dir identity while naming the exact linked root", () => {
    const source = join(root, `linked-source-${process.pid}`);
    git(repo, "worktree", "add", "-q", "-b", `linked-source-${process.pid}`, source, "HEAD");
    const capture: Capture = { registrations: [], events: [] };
    const id = `linked-${process.pid}`;
    const lease = provisionWorktree(id, { repoRoot: source, ...ownership(id, capture) });
    const registration = capture.registrations[0];

    expect(registration.repositoryLayout).toBe("linked");
    expect(registration.sourceRoot).toBe(realpathSync(source));
    expect(registration.gitCommonDir).toBe(realpathSync(join(repo, ".git")));
    expect(registration.repositoryIdentity).toStartWith("north:git-common-dir-sha256:v1:");

    worktreeFinalize(id, "ran", { ...lease });
    git(repo, "worktree", "remove", source);
    git(repo, "branch", "-d", `linked-source-${process.pid}`);
  });

  test("two independently admitted allocations have collision-free nonce, ref, path, and ownership", async () => {
    const left: Capture = { registrations: [], events: [] };
    const right: Capture = { registrations: [], events: [] };
    const leftId = `concurrent-left-${process.pid}`;
    const rightId = `concurrent-right-${process.pid}`;
    const [leftLease, rightLease] = await Promise.all([
      Promise.resolve().then(() => provisionWorktree(leftId, {
        repoRoot: repo, ...ownership(leftId, left),
      })),
      Promise.resolve().then(() => provisionWorktree(rightId, {
        repoRoot: repo, ...ownership(rightId, right),
      })),
    ]);

    expect(left.registrations[0].allocationNonce).not.toBe(right.registrations[0].allocationNonce);
    expect(left.registrations[0].subject).not.toBe(right.registrations[0].subject);
    expect(leftLease.path).not.toBe(rightLease.path);
    expect(leftLease.allocation.durableRef).not.toBe(rightLease.allocation.durableRef);
    expect(existsSync(leftLease.path)).toBe(true);
    expect(existsSync(rightLease.path)).toBe(true);

    worktreeFinalize(leftId, "ran", { ...leftLease });
    worktreeFinalize(rightId, "ran", { ...rightLease });
  });
});

describe("atomic failure and recovery", () => {
  test("registration refusal creates neither worktree path nor durable ref", () => {
    const capture: Capture = { registrations: [], events: [] };
    const id = `register-refusal-${process.pid}`;
    const path = `/tmp/${basename(repo)}-lane-${id}`;
    expect(() => provisionWorktree(id, {
      repoRoot: repo,
      ...ownership(id, capture),
      writer: captureWriter(capture, true),
    })).toThrow("injected registration refusal");
    expect(existsSync(path)).toBe(false);
    expect(git(repo, "branch", "--list", `lane-${id}`)).toBe("");
    expect(capture.events).toEqual([]);
  });

  test("durable-ref collision is recorded as an exact absent rollback without deleting the foreign ref", () => {
    const capture: Capture = { registrations: [], events: [] };
    const id = `ref-collision-${process.pid}`;
    const branch = `lane-${id}`;
    git(repo, "branch", branch, "HEAD");

    expect(() => provisionWorktree(id, { repoRoot: repo, ...ownership(id, capture) }))
      .toThrow("resource=absent");
    expect(capture.events.map(({ event }) => event.type)).toEqual([
      "provision-failed", "rolled-back",
    ]);
    expect(capture.events[0].event.error).toEqual({
      code: "durable_ref_collision", phase: "git_provision",
    });
    expect(capture.events[0].event.recovery?.action).toBe("none");
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
    expect(existsSync(`/tmp/${basename(repo)}-${branch}`)).toBe(false);

    git(repo, "branch", "-d", branch);
  });

  test("pre-provider admission rollback removes a clean resource and records absence", () => {
    const capture: Capture = { registrations: [], events: [] };
    const id = `admission-rollback-${process.pid}`;
    const lease = provisionWorktree(id, { repoRoot: repo, ...ownership(id, capture) });
    rollbackProvisionedWorktree(id, lease);

    expect(capture.events.at(-1)?.event).toMatchObject({
      type: "rolled-back", resourceState: "absent",
    });
    expect(existsSync(lease.path)).toBe(false);
    expect(git(repo, "branch", "--list", lease.branch)).toBe("");
  });

  test("dirty pre-provider rollback preserves and queryably quarantines with machine recovery", () => {
    const capture: Capture = { registrations: [], events: [] };
    const id = `admission-quarantine-${process.pid}`;
    const lease = provisionWorktree(id, { repoRoot: repo, ...ownership(id, capture) });
    writeFileSync(join(lease.path, "uncommitted.txt"), "salvage\n");
    const priorNorthBin = process.env.NORTH_BIN;
    process.env.NORTH_BIN = "/bin/true";
    try { rollbackProvisionedWorktree(id, lease); }
    finally {
      if (priorNorthBin === undefined) delete process.env.NORTH_BIN;
      else process.env.NORTH_BIN = priorNorthBin;
    }

    expect(capture.events.at(-1)?.event).toMatchObject({
      type: "quarantined",
      resourceState: "quarantined",
      error: { code: "worktree_dirty", phase: "admission_rollback" },
      recovery: {
        action: "inspect-and-salvage",
        resource: lease.path,
        durableRef: lease.allocation.durableRef,
      },
    });
    expect(existsSync(lease.path)).toBe(true);

    git(repo, "worktree", "remove", "--force", lease.path);
    git(repo, "branch", "-D", lease.branch);
  });
});
