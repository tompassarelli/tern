import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  readAnthropicControlObservation,
  type StartAnthropicControl,
} from "../src/providers/anthropic-control";
import { createAnthropicProcessLifecycle } from "../src/providers/anthropic-process";

const fixture = join(import.meta.dir, "fixtures", "anthropic-process-tree.mjs");
const temporary: string[] = [];
const groups = new Set<number>();
const posixTest = process.platform === "win32" ? test.skip : test;

interface ProcessRecord {
  leader: number;
  descendant: number;
  pgid: number;
}

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

async function readProcessRecord(path: string): Promise<ProcessRecord> {
  let value: ProcessRecord | undefined;
  await eventually(() => {
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
      return true;
    } catch { return false; }
  }, "control process ownership record");
  return value!;
}

function usageResponse(): unknown {
  return {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12, resets_at: "2099-01-01T00:00:00Z" },
    },
  };
}

function treeStart(
  directory: string,
  recordPath: string,
  usage: () => Promise<unknown>,
  models: () => Promise<unknown>,
  observed: (record: ProcessRecord) => void,
): StartAnthropicControl {
  return async ({ options }) => {
    const sdkOptions = options as Options;
    sdkOptions.spawnClaudeCodeProcess!({
      command: process.execPath,
      args: [fixture, "hold"],
      cwd: directory,
      env: {
        ...process.env,
        NORTH_PID_FILE: recordPath,
        NORTH_IGNORE_TERM: "1",
      },
      signal: new AbortController().signal,
    });
    observed(await readProcessRecord(recordPath));
    return {
      query: () => ({
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
        supportedModels: models,
        close() {},
      }),
      close() {},
    };
  };
}

function fastLifecycle() {
  return createAnthropicProcessLifecycle({ graceMs: 10, termMs: 50, killMs: 1_000 });
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

const scenarios: Array<{
  name: string;
  timeoutMs: number;
  usage: () => Promise<unknown>;
  models: () => Promise<unknown>;
  assertResult: (result: Awaited<ReturnType<typeof readAnthropicControlObservation>>) => void;
}> = [
  {
    name: "successful control read",
    timeoutMs: 500,
    usage: async () => usageResponse(),
    models: async () => [{ value: "fable" }],
    assertResult: (result) => {
      expect(result.usage?.ok).toBe(true);
      expect(result.models?.ok).toBe(true);
    },
  },
  {
    name: "supportedModels timeout",
    timeoutMs: 150,
    usage: async () => usageResponse(),
    models: () => new Promise<never>(() => {}),
    assertResult: (result) => {
      expect(result.usage?.ok).toBe(true);
      expect(result.models).toMatchObject({
        ok: false, reason: "anthropic_control_probe_timed_out",
      });
    },
  },
  {
    name: "usage schema failure",
    timeoutMs: 500,
    usage: async () => ({ incompatible: true }),
    models: async () => [{ value: "fable" }],
    assertResult: (result) => {
      expect(result.usage).toMatchObject({
        ok: false, reason: "anthropic_usage_response_schema_changed",
      });
      expect(result.models?.ok).toBe(true);
    },
  },
  {
    name: "one failed sibling surface",
    timeoutMs: 500,
    usage: async () => { throw new Error("PRIVATE FAILURE"); },
    models: async () => [{ value: "fable" }],
    assertResult: (result) => {
      expect(result.usage).toMatchObject({
        ok: false, reason: "anthropic_control_probe_failed",
      });
      expect(result.models?.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    },
  },
];

for (const scenario of scenarios) {
  posixTest(`warm control ${scenario.name} reaps its real process tree`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "north-anthropic-control-"));
    temporary.push(directory);
    const recordPath = join(directory, "pids.json");
    let pids: ProcessRecord | undefined;
    const result = await readAnthropicControlObservation({
      target: { id: "anthropic", provider: "anthropic", authMode: "ambient" },
      usage: true,
      models: true,
      timeoutMs: scenario.timeoutMs,
      start: treeStart(
        directory, recordPath, scenario.usage, scenario.models,
        (record) => { pids = record; groups.add(record.pgid); },
      ),
      createLifecycle: fastLifecycle,
    });
    scenario.assertResult(result);
    expect(pids).toBeDefined();
    await eventually(
      () => pidGone(pids!.leader) && pidGone(pids!.descendant) && groupGone(pids!.pgid),
      `${scenario.name} process tree disappearance`,
    );
    groups.delete(pids!.pgid);
  });
}

posixTest("late-resolving warm startup is reaped, observed, and disposed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-anthropic-control-late-"));
  temporary.push(directory);
  const recordPath = join(directory, "pids.json");
  let pids: ProcessRecord | undefined;
  let warmClosed = 0;
  const start: StartAnthropicControl = async ({ options }) => {
    const sdkOptions = options as Options;
    sdkOptions.spawnClaudeCodeProcess!({
      command: process.execPath,
      args: [fixture, "hold"],
      cwd: directory,
      env: {
        ...process.env,
        NORTH_PID_FILE: recordPath,
        NORTH_IGNORE_TERM: "1",
      },
      signal: new AbortController().signal,
    });
    pids = await readProcessRecord(recordPath);
    groups.add(pids.pgid);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      query: () => { throw new Error("late startup must never be queried"); },
      close: () => { warmClosed++; },
    };
  };
  const result = await readAnthropicControlObservation({
    target: { id: "anthropic", provider: "anthropic", authMode: "ambient" },
    usage: true,
    models: true,
    timeoutMs: 100,
    start,
    createLifecycle: fastLifecycle,
  });
  expect(result.usage).toMatchObject({
    ok: false, reason: "anthropic_control_probe_timed_out",
  });
  expect(result.models).toMatchObject({
    ok: false, reason: "anthropic_control_probe_timed_out",
  });
  expect(pids).toBeDefined();
  await eventually(
    () => pidGone(pids!.leader) && pidGone(pids!.descendant) && groupGone(pids!.pgid),
    "late-startup process tree disappearance",
  );
  groups.delete(pids!.pgid);
  await eventually(() => warmClosed === 1, "late WarmQuery disposal");
});
