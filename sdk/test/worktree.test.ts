// Pure + hermetic tests for the worktree module (sdk/src/worktree.ts). No live git, no
// coordinator — only the PURE surface: the salvage-gate decision table, the injected
// payload contract, and branch/path/command naming. The impure shell-outs (provision,
// finalize) are covered end-to-end by the spawn opt-in proof, not mocked here.
import { test, expect, describe } from "bun:test";
import {
  worktreeBranch,
  worktreePath,
  provisionArgs,
  removeArgs,
  worktreeCleanupDecision,
  worktreePayload,
  worktreeNorthExecutable,
} from "../src/worktree";

describe("branch + path naming", () => {
  test("branch is lane-<agentId>", () => {
    expect(worktreeBranch("sdk-abc123")).toBe("lane-sdk-abc123");
  });
  test("path is /tmp/<repo-basename>-lane-<agentId>", () => {
    expect(worktreePath("sdk-abc123", "/home/tom/code/kea")).toBe("/tmp/kea-lane-sdk-abc123");
  });
  test("path keys off the repo basename, not the full path (no cross-repo collision)", () => {
    const a = worktreePath("x", "/home/tom/code/north");
    const b = worktreePath("x", "/other/place/kea");
    expect(a).toBe("/tmp/north-lane-x");
    expect(b).toBe("/tmp/kea-lane-x");
    expect(a).not.toBe(b);
  });
});

describe("git command builders", () => {
  test("provisionArgs is `git -C <root> worktree add <path> -b <branch> HEAD`", () => {
    expect(provisionArgs("abc", "/repo")).toEqual([
      "-C", "/repo", "worktree", "add", "/tmp/repo-lane-abc", "-b", "lane-abc", "HEAD",
    ]);
  });
  test("removeArgs uses PLAIN worktree remove (no --force) + branch -d", () => {
    const rm = removeArgs("abc", "/repo");
    expect(rm.worktree).toEqual(["-C", "/repo", "worktree", "remove", "/tmp/repo-lane-abc"]);
    expect(rm.branch).toEqual(["-C", "/repo", "branch", "-d", "lane-abc"]);
    expect(rm.worktree).not.toContain("--force");
  });
});

describe("North CLI authority", () => {
  test("NORTH_BIN wins; otherwise canonical NORTH_HOME wins and HOME is irrelevant", () => {
    expect(worktreeNorthExecutable({
      NORTH_BIN: "/exact/wrapped/north",
      NORTH_HOME: "/ignored/root",
      HOME: "/poisoned/home",
    })).toBe("/exact/wrapped/north");
    expect(worktreeNorthExecutable({
      NORTH_HOME: "/nix/store/example-north",
      HOME: "/poisoned/home",
    })).toBe("/nix/store/example-north/bin/north");
  });
});

describe("worktreeCleanupDecision — the salvage gate (8 outcomes × dirty/clean)", () => {
  // remove ONLY on a clean `ran`. Everything else keeps: `ran`+dirty is a reporting
  // anomaly (keep-clean-exit); every non-`ran` outcome keeps for salvage regardless of dirt.
  const NON_RAN = [
    "died", "stalled", "capped", "max_turns",
    "budget_exceeded", "budget_exhausted", "struggle_ceiling",
  ];

  test("ran + clean => remove (the ONLY removal case)", () => {
    expect(worktreeCleanupDecision("ran", false)).toBe("remove");
  });
  test("ran + dirty => keep-clean-exit (clean exit but uncommitted changes)", () => {
    expect(worktreeCleanupDecision("ran", true)).toBe("keep-clean-exit");
  });

  for (const oc of NON_RAN) {
    test(`${oc} + clean => keep-salvage`, () => {
      expect(worktreeCleanupDecision(oc, false)).toBe("keep-salvage");
    });
    test(`${oc} + dirty => keep-salvage`, () => {
      expect(worktreeCleanupDecision(oc, true)).toBe("keep-salvage");
    });
  }

  test("full table: only ran+clean removes; all 15 other cells keep", () => {
    const outcomes = ["ran", ...NON_RAN];
    const removals = outcomes
      .flatMap((oc) => [false, true].map((dirty) => ({ oc, dirty, d: worktreeCleanupDecision(oc, dirty) })))
      .filter((r) => r.d === "remove");
    expect(removals).toEqual([{ oc: "ran", dirty: false, d: "remove" }]);
  });
});

describe("worktreePayload — the injected protocol contract", () => {
  const p = worktreePayload({
    path: "/tmp/kea-lane-abc",
    branch: "lane-abc",
    mainReportsDir: "/home/tom/code/kea/docs/private",
  });

  test("names the worktree path + branch (isolation notice)", () => {
    expect(p).toContain("/tmp/kea-lane-abc");
    expect(p).toContain("lane-abc");
    expect(p).toContain("ISOLATED");
  });
  test("carries the LANDING protocol: commit -> rebase -> ff-merge -> push", () => {
    expect(p).toContain("git fetch && git rebase origin/main");
    expect(p).toContain("--ff-only");
    expect(p).toContain("safe-push");
  });
  test("carries the VERIFY protocol: portless-here, high port, never stock e2e", () => {
    expect(p.toLowerCase()).toContain("vitest");
    expect(p).toContain("HIGH port");
    expect(p.toLowerCase()).toContain("playwright");
    expect(p.toLowerCase()).toContain("reuseexistingserver");
  });
  test("points reports at the ABSOLUTE main-tree path", () => {
    expect(p).toContain("/home/tom/code/kea/docs/private/<slug>.md");
    expect(p).toContain("ABSOLUTE");
  });
});
