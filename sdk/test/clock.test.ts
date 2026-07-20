// Pure tests for managed client-session admission — no live coordinator.
// Managed lanes verify the independently owned human client session and never
// start, stop, adopt, or finalize billing clocks.
import { test, expect, describe } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  admitBillableClock, BillableClockPreflightError, clientTicketForBranch,
  trustedGitExecutable,
} from "../src/clock";
import {
  gitOracleEnvironment, TrustedGitOracleError, trustedGitProjectRoot,
  trustedManagedCodexExecutable,
} from "../src/trusted-runtime";

describe("required client clock admission", () => {
  const base = {
    agentId: "lane-clock-proof",
    capabilities: ["filesystem.write"],
    cwd: "/workspace",
  };
  const projectRoot = () => "/home/tom/code/client/msa/kea";
  const branchName = () => "msa-242-clock-admission";
  const thread = () => [
    { predicate: "title", value: "Clock admission work" },
    { predicate: "owner", value: "msa" },
    { predicate: "linear", value: "MSA-242" },
  ];
  const absent = "not clocked in for a client";
  const failureCode = (
    run: () => unknown,
    code: string,
  ) => {
    let caught: unknown;
    try { run(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(BillableClockPreflightError);
    expect(caught).toMatchObject({ code });
  };

  test("write-capable client work requires a bound thread before provider work", () => {
    failureCode(() => admitBillableClock(base, { projectRoot }),
      "billable_thread_required");
  });

  test("thread owner must be readable and exactly match the canonical client", () => {
    failureCode(() => admitBillableClock(
      { ...base, threadId: "thread-clock-proof" },
      {
        projectRoot,
        branchName,
        readThreadFacts: () => { throw new Error("offline"); },
      },
    ), "billable_thread_owner_unavailable");
    failureCode(() => admitBillableClock(
      { ...base, threadId: "thread-clock-proof" },
      {
        projectRoot,
        branchName,
        readThreadFacts: () => [
          { predicate: "title", value: "Clock admission work" },
          { predicate: "owner", value: "other" },
        ],
      },
    ), "billable_thread_owner_mismatch");
  });

  test("billing admission requires exactly one nonempty title-bearing thread", () => {
    for (const titles of [[], [""], ["   "], ["one", "two"]]) {
      failureCode(() => admitBillableClock(
        { ...base, threadId: "thread-clock-proof" },
        {
          projectRoot,
          branchName,
          readThreadFacts: () => [
            ...titles.map((value) => ({ predicate: "title", value })),
            { predicate: "owner", value: "msa" },
            { predicate: "linear", value: "MSA-242" },
          ],
        },
      ), "billable_thread_title_required");
    }
  });

  test("branch must carry one client ticket and thread linear must match it exactly", () => {
    failureCode(() => admitBillableClock(
      { ...base, threadId: "thread-clock-proof" },
      {
        projectRoot,
        branchName: () => "main",
        readThreadFacts: thread,
      },
    ), "billable_ticket_required");
    failureCode(() => admitBillableClock(
      { ...base, threadId: "thread-clock-proof" },
      {
        projectRoot,
        branchName,
        readThreadFacts: () => [
          { predicate: "title", value: "Clock admission work" },
          { predicate: "owner", value: "msa" },
          { predicate: "linear", value: "MSA-241" },
        ],
      },
    ), "billable_thread_linear_mismatch");
  });

  test("missing human client session blocks with one status-only read", () => {
    const calls: string[][] = [];
    failureCode(() => admitBillableClock(
      { ...base, threadId: "thread-clock-proof" },
      {
        projectRoot,
        branchName,
        readThreadFacts: thread,
        execute: ({ args }) => {
          calls.push(args);
          return absent;
        },
      },
    ), "billable_client_session_required");
    expect(calls).toEqual([["clock", "status"]]);
  });

  test("different human client session blocks without switching it", () => {
    const calls: string[][] = [];
    failureCode(() => admitBillableClock(
      { ...base, threadId: "thread-clock-proof" },
      {
        projectRoot,
        branchName,
        readThreadFacts: thread,
        execute: ({ args }) => {
          calls.push(args);
          return "clocked in for client other  (session human-session, rate 100/h)";
        },
      },
    ), "billable_client_session_mismatch");
    expect(calls).toEqual([["clock", "status"]]);
  });

  test("status transport failure is a distinct fail-closed readback error", () => {
    failureCode(() => admitBillableClock(
      { ...base, threadId: "thread-clock-proof" },
      {
        projectRoot,
        branchName,
        readThreadFacts: thread,
        execute: () => { throw new Error("coordinator unavailable"); },
      },
    ), "billable_client_session_readback_failed");
  });

  test("missing or placeholder captured rate fails closed before provider work", () => {
    for (const output of [
      "clocked in for client msa  (session human-session)",
      "clocked in for client msa  (session human-session, rate ?/h)",
    ]) {
      failureCode(() => admitBillableClock(
        { ...base, threadId: "thread-clock-proof" },
        { projectRoot, branchName, readThreadFacts: thread, execute: () => output },
      ), "billable_client_session_rate_required");
    }
  });

  test("invalid captured rate fails closed before provider work", () => {
    for (const rate of ["0", "-1", "120.5", "nope", "2147483648"]) {
      failureCode(() => admitBillableClock(
        { ...base, threadId: "thread-clock-proof" },
        {
          projectRoot, branchName, readThreadFacts: thread,
          execute: () => `clocked in for client msa  (session human-session, rate ${rate}/h)`,
        },
      ), "billable_client_session_rate_invalid");
    }
  });

  test("success verifies the exact human client and performs no clock mutation", () => {
    const calls: string[][] = [];
    expect(admitBillableClock(
      { ...base, threadId: "thread-clock-proof" },
      {
        projectRoot,
        branchName,
        readThreadFacts: thread,
        execute: ({ args }) => {
          calls.push(args);
          return "clocked in for client msa  (session human-session, rate 120/h)\n  since now";
        },
      },
    )).toEqual({
      kind: "verified",
      client: "msa",
      rate: "120",
      threadId: "thread-clock-proof",
    });
    expect(calls).toEqual([["clock", "status"]]);
  });

  test("legacy agent-only clock output cannot authorize human billing", () => {
    const calls: string[][] = [];
    failureCode(() => admitBillableClock(
      { ...base, threadId: "thread-clock-proof" },
      {
        projectRoot,
        branchName,
        readThreadFacts: thread,
        execute: ({ args }) => {
          calls.push(args);
          return "clocked in on thread-clock-proof  Existing  (agent lane-clock-proof)";
        },
      },
    ), "billable_client_session_required");
    expect(calls).toEqual([["clock", "status"]]);
  });

  test("one MSA human session admits independent MSA tickets without switching clocks", () => {
    const calls: Array<{ thread: string; args: string[]; actor?: string }> = [];
    const executeFor = (ticket: string) => ({ args, agentEnv }: { args: string[]; agentEnv?: string }) => {
      calls.push({ thread: ticket, args, actor: agentEnv });
      return "clocked in for client msa  (session human-session, rate 120/h)";
    };
    for (const [threadId, ticket] of [["thread-242", "MSA-242"], ["thread-243", "MSA-243"]]) {
      expect(admitBillableClock(
        { ...base, agentId: `lane-${ticket}`, threadId },
        {
          projectRoot,
          branchName: () => `${ticket.toLowerCase()}-work`,
          readThreadFacts: () => [
            { predicate: "title", value: `Clock admission ${ticket}` },
            { predicate: "owner", value: "msa" },
            { predicate: "linear", value: ticket },
          ],
          execute: executeFor(ticket),
        },
      )).toMatchObject({ kind: "verified", client: "msa", threadId });
    }
    expect(calls).toEqual([
      { thread: "MSA-242", args: ["clock", "status"], actor: "user" },
      { thread: "MSA-243", args: ["clock", "status"], actor: "user" },
    ]);
  });

  test("non-client and read-only work remain non-blocking without a thread", () => {
    expect(admitBillableClock(
      { ...base, cwd: "/workspace", capabilities: ["filesystem.read"] },
      { projectRoot },
    )).toEqual({ kind: "not-required" });
    expect(admitBillableClock(
      base,
      { projectRoot: () => "/home/tom/code/north" },
    )).toEqual({ kind: "not-required" });
  });
});

describe("clientTicketForBranch", () => {
  test("extracts only a boundary-delimited ticket for the exact client", () => {
    expect(clientTicketForBranch("feature/msa-242-clock-proof", "msa")).toBe("MSA-242");
    expect(clientTicketForBranch("MSA-7", "msa")).toBe("MSA-7");
    expect(clientTicketForBranch("feature/notmsa-242", "msa")).toBeUndefined();
    expect(clientTicketForBranch("feature/other-242", "msa")).toBeUndefined();
    expect(clientTicketForBranch("msa-242-msa-999", "msa")).toBeUndefined();
  });
});

test("clock admission rejects a mutable PATH-shadow Git as a trust root", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-shadow-git-"));
  const shadow = join(directory, "git");
  try {
    writeFileSync(shadow, "#!/bin/sh\nprintf forged\n");
    chmodSync(shadow, 0o755);
    expect(() => trustedGitExecutable([shadow]))
      .toThrow("trusted Nix-store Git executable unavailable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Git root authority ignores every ambient repository/config redirect", () => {
  const saved = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.startsWith("GIT_")));
  try {
    process.env.GIT_DIR = "/tmp/forged-git-dir";
    process.env.GIT_WORK_TREE = "/tmp/forged-work-tree";
    process.env.GIT_CEILING_DIRECTORIES = resolve(import.meta.dir, "..");
    process.env.GIT_CONFIG_GLOBAL = "/tmp/forged-global-config";
    process.env.GIT_CONFIG_SYSTEM = "/tmp/forged-system-config";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "include.path";
    process.env.GIT_CONFIG_VALUE_0 = "/tmp/forged-include";
    const root = resolve(import.meta.dir, "../..");
    expect(trustedGitProjectRoot(join(root, "sdk", "src"))).toBe(root);
    expect(gitOracleEnvironment()).toEqual({
      HOME: "/homeless-shelter",
      PATH: "",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CEILING_DIRECTORIES: "/",
    });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GIT_")) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test("Git root authority treats only Git's exact C-locale non-repository result as absence", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-no-git-root-"));
  try {
    expect(trustedGitProjectRoot(directory)).toBe(realpathSync(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Git root authority keeps every other fatal result fail-closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-fatal-git-root-"));
  const fakeGit = join(directory, "git");
  try {
    writeFileSync(fakeGit, "#!/bin/sh\nprintf '%s\\n' 'fatal: unsafe repository authority' >&2\nexit 128\n");
    chmodSync(fakeGit, 0o755);
    let caught: unknown;
    try { trustedGitProjectRoot(directory, fakeGit); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(TrustedGitOracleError);
    expect(caught).toMatchObject({ code: "execution_failed" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("managed Codex authority rejects mutable PATH and profile executables", () => {
  const directory = mkdtempSync(join(tmpdir(), "north-shadow-codex-"));
  const shadow = join(directory, "codex");
  try {
    writeFileSync(shadow, "#!/bin/sh\nexit 0\n");
    chmodSync(shadow, 0o755);
    expect(() => trustedManagedCodexExecutable([shadow]))
      .toThrow("trusted Nix-store Codex executable unavailable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
