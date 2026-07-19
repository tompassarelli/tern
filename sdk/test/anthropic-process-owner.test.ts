import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAnthropicProcessLifecycle,
  settleAnthropicProcessOwner,
} from "../src/providers/anthropic-process";

const fixture = join(import.meta.dir, "fixtures", "anthropic-process-tree.mjs");
const temporary: string[] = [];
const groups = new Set<number>();

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code) : undefined;
}

function pidGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return errorCode(error) === "ESRCH"; }
}

function groupGone(pgid: number): boolean {
  try { process.kill(-pgid, 0); return false; }
  catch (error) { return errorCode(error) === "ESRCH"; }
}

async function eventually(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function pidRecord(path: string): Promise<{
  leader: number;
  descendant: number;
  pgid: number;
}> {
  let record: { leader: number; descendant: number; pgid: number } | undefined;
  await eventually(() => {
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
      return true;
    } catch { return false; }
  }, "process ownership record");
  return record!;
}

afterEach(() => {
  for (const pgid of groups) {
    if (!groupGone(pgid)) {
      try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  groups.clear();
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("POSIX settlement proves leader, descendant, and PGID disappearance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-anthropic-owner-"));
  temporary.push(directory);
  const recordPath = join(directory, "pids.json");
  const lifecycle = createAnthropicProcessLifecycle({
    graceMs: 20,
    termMs: 100,
    killMs: 1_000,
  });
  const child = lifecycle.spawnClaudeCodeProcess({
    command: process.execPath,
    args: [fixture, "hold"],
    cwd: directory,
    env: { ...process.env, NORTH_PID_FILE: recordPath, NORTH_IGNORE_TERM: "1" },
    signal: new AbortController().signal,
  });
  const pids = await pidRecord(recordPath);
  groups.add(pids.pgid);
  child.stdin.end();
  await lifecycle.settle();
  await eventually(
    () => pidGone(pids.leader) && pidGone(pids.descendant) && groupGone(pids.pgid),
    "owned POSIX process group disappearance",
  );
  groups.delete(pids.pgid);
});

test("settle and force-close synchronously seal a lifecycle before first spawn", async () => {
  for (const platform of ["linux", "win32"] as const) {
    for (const close of ["settle", "forceKill"] as const) {
      let spawnCalls = 0;
      const lifecycle = createAnthropicProcessLifecycle({
        platform,
        spawn: (() => { spawnCalls++; throw new Error("must not spawn"); }) as any,
      });
      if (close === "settle") await lifecycle.settle();
      else lifecycle.forceKill();
      expect(() => lifecycle.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: process.env,
        signal: new AbortController().signal,
      })).toThrow("anthropic_process_lifecycle_closed");
      expect(spawnCalls).toBe(0);
    }
  }
});

posixTest("late warm resolution after disposal timeout leaves no process or unhandled rejection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-anthropic-late-warm-"));
  temporary.push(directory);
  const recordPath = join(directory, "pids.json");
  const lifecycle = createAnthropicProcessLifecycle({
    graceMs: 10,
    termMs: 100,
    killMs: 1_000,
  });
  let child: ReturnType<NonNullable<typeof lifecycle.spawnClaudeCodeProcess>> | undefined;
  const lateWarm = new Promise<{ close(): void }>((resolve, reject) => {
    setTimeout(() => {
      try {
        child = lifecycle.spawnClaudeCodeProcess({
          command: process.execPath,
          args: [fixture, "hold"],
          cwd: directory,
          env: { ...process.env, NORTH_PID_FILE: recordPath, NORTH_IGNORE_TERM: "1" },
          signal: new AbortController().signal,
        });
        // Resolve after the owner disposal budget. The attached disposer must
        // remain observed even though authoritative process settlement wins.
        setTimeout(() => resolve({
          close: () => { try { child?.stdin.end(); } catch { /* already reaped */ } },
        }), 300);
      } catch (error) { reject(error); }
    }, 0);
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const recordPromise = pidRecord(recordPath);
    const settlement = settleAnthropicProcessOwner({
      lifecycle,
      abortController: new AbortController(),
      dispose: async () => (await lateWarm).close(),
      disposalGraceMs: 150,
    });
    const settlementAssertion = expect(settlement).rejects.toThrow(
      "anthropic_sdk_disposal_timeout",
    );
    const pids = await recordPromise;
    groups.add(pids.pgid);
    await settlementAssertion;
    await eventually(
      () => pidGone(pids.leader) && pidGone(pids.descendant) && groupGone(pids.pgid),
      "late warm process group disappearance",
    );
    groups.delete(pids.pgid);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

posixTest("startup attempting its first spawn after timeout is sealed before process creation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-anthropic-sealed-start-"));
  temporary.push(directory);
  const recordPath = join(directory, "pids.json");
  const lifecycle = createAnthropicProcessLifecycle();
  const lateStartup = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      try {
        lifecycle.spawnClaudeCodeProcess({
          command: process.execPath,
          args: [fixture, "hold"],
          cwd: directory,
          env: { ...process.env, NORTH_PID_FILE: recordPath },
          signal: new AbortController().signal,
        });
        resolve();
      } catch (error) { reject(error); }
    }, 50);
  });
  await expect(settleAnthropicProcessOwner({
    lifecycle,
    abortController: new AbortController(),
    dispose: () => lateStartup,
    disposalGraceMs: 10,
  })).rejects.toThrow("anthropic_sdk_disposal_timeout");
  await expect(lateStartup).rejects.toThrow("anthropic_process_lifecycle_closed");
  expect(lifecycle.started()).toBe(false);
  expect(existsSync(recordPath)).toBe(false);
});
