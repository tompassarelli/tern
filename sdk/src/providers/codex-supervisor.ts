#!/usr/bin/env bun
/**
 * Own one Codex process tree independently of the North host's survival.
 *
 * The host keeps supervisor stdin open after sending one bounded prompt frame.
 * Kernel EOF therefore proves host death even under SIGKILL. Codex runs in its
 * own process group; every supervisor exit path terminates and waits for that
 * whole group before emitting its terminal receipt.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeSync } from "node:fs";

const PROMPT = "NORTH_CODEX_PROMPT ";
const MAX_PROMPT_BYTES = 16 * 1024 * 1024;
const TERM_MS = 750;
const KILL_MS = 750;
const PIPE_CLOSE_MS = 750;
const POSIX_GROUP = process.platform !== "win32";
const [executable, ...args] = process.argv.slice(2);

function receipt(value: string): void {
  const bytes = Buffer.from(`${value}\n`, "utf8");
  let offset = 0;
  try {
    while (offset < bytes.byteLength)
      offset += writeSync(3, bytes, offset, bytes.byteLength - offset);
  } catch {
    // The status reader is owned by the North host. EPIPE here means that host
    // is gone; kernel EOF on supervisor stdin already drives provider cleanup.
  }
}

if (!executable) {
  receipt("UNAVAILABLE");
  process.exit(127);
}

let child: ChildProcessWithoutNullStreams;
try {
  child = spawn(executable, args, {
    detached: POSIX_GROUP,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch {
  receipt("UNAVAILABLE");
  process.exit(127);
}

let providerExit:
  | { code: number | null; signal: NodeJS.Signals | null }
  | undefined;
let shutdownPromise: Promise<void> | undefined;
let promptAccepted = false;

function groupExists(): boolean {
  if (!POSIX_GROUP || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalGroup(signal: NodeJS.Signals): void {
  if (POSIX_GROUP && child.pid !== undefined) {
    try { process.kill(-child.pid, signal); } catch { /* already gone */ }
    return;
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  return predicate();
}

async function terminateProvider(): Promise<void> {
  signalGroup("SIGTERM");
  const goneAfterTerm = POSIX_GROUP
    ? await waitUntil(() => !groupExists(), TERM_MS)
    : await waitUntil(() => child.exitCode !== null || child.signalCode !== null, TERM_MS);
  if (goneAfterTerm) return;
  signalGroup("SIGKILL");
  if (POSIX_GROUP)
    await waitUntil(() => !groupExists(), KILL_MS);
  else
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, KILL_MS);
}

function shutdown(): Promise<void> {
  shutdownPromise ??= terminateProvider();
  return shutdownPromise;
}

async function pump(
  source: NodeJS.ReadableStream,
  target: NodeJS.WritableStream,
): Promise<void> {
  for await (const chunk of source) {
    await new Promise<void>((resolve, reject) => {
      target.write(chunk, (error) => error ? reject(error) : resolve());
    });
  }
}

function closeOutput(target: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    target.once("error", done);
    target.end(done);
  });
}

const stdoutPump = pump(child.stdout, process.stdout);
const stderrPump = pump(child.stderr, process.stderr);
let closeResolved = false;
let resolveClose!: () => void;
const providerClosed = new Promise<void>((resolve) => { resolveClose = resolve; });
const pipesClosed = Promise.allSettled([providerClosed, stdoutPump, stderrPump]);
const noteClosed = () => {
  if (closeResolved) return;
  closeResolved = true;
  resolveClose();
};
child.once("error", () => {
  receipt("UNAVAILABLE");
  providerExit = { code: 127, signal: null };
  noteClosed();
});
child.once("spawn", () => receipt("STARTED"));
child.once("exit", (code, signal) => {
  providerExit = { code, signal };
  // Reap any inherited descendants left in the direct Codex process group.
  void shutdown();
});
child.once("close", noteClosed);

let input = Buffer.alloc(0);
let promptBytes: number | undefined;
process.stdin.on("data", (chunk: Buffer | string) => {
  if (promptAccepted) return;
  input = Buffer.concat([
    input,
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
  ]);
  if (promptBytes === undefined) {
    const newline = input.indexOf(0x0a);
    if (newline < 0) {
      if (input.length > 128) void shutdown();
      return;
    }
    const header = input.subarray(0, newline).toString("utf8");
    const match = /^NORTH_CODEX_PROMPT ([0-9]+)$/.exec(header);
    const parsed = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_PROMPT_BYTES) {
      void shutdown();
      return;
    }
    promptBytes = parsed;
    input = input.subarray(newline + 1);
  }
  if (input.length < promptBytes) return;
  if (input.length !== promptBytes) {
    void shutdown();
    return;
  }
  promptAccepted = true;
  child.stdin.end(input);
  input = Buffer.alloc(0);
});
process.stdin.once("end", () => { void shutdown(); });
process.stdin.once("close", () => { void shutdown(); });
process.stdin.once("error", () => { void shutdown(); });
process.stdin.resume();

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => { void shutdown(); });

await waitUntil(() => providerExit !== undefined || shutdownPromise !== undefined, 2 ** 31 - 1);
await shutdown();
if (!await waitUntil(() => closeResolved, PIPE_CLOSE_MS)) {
  child.stdout.destroy();
  child.stderr.destroy();
}
await Promise.race([
  pipesClosed,
  new Promise<void>((resolve) => setTimeout(resolve, PIPE_CLOSE_MS)),
]);

const exitCode = !providerExit
  ? 143
  : providerExit.code !== null
    ? providerExit.code
    : 128 + (
      providerExit.signal === "SIGTERM" ? 15
      : providerExit.signal === "SIGKILL" ? 9
      : providerExit.signal === "SIGINT" ? 2
      : providerExit.signal === "SIGHUP" ? 1
      : 1
    );
await Promise.race([
  Promise.all([closeOutput(process.stdout), closeOutput(process.stderr)]),
  new Promise<void>((resolve) => setTimeout(resolve, PIPE_CLOSE_MS)),
]);
receipt(`EXIT ${exitCode}`);
process.exit(exitCode);
