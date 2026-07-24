#!/usr/bin/env bun
/**
 * Own one Codex process tree independently of the North host's survival.
 *
 * The host keeps supervisor stdin open solely as a liveness lease; POSIX
 * one-shot prompts and duplex RPC arrive through the bounded private
 * spool/FIFO, while Windows retains its fd-4 pipe fallback. Kernel EOF
 * therefore proves host death even under SIGKILL. Codex runs in its own
 * process group; every supervisor exit path terminates and waits for that
 * whole group before emitting its terminal receipt.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readFileSync,
  realpathSync, rmSync, statSync, unlinkSync, watch, writeSync,
} from "node:fs";
import {
  codexSupervisorStatusLine, type CodexSupervisorStatus,
} from "./codex-supervisor-protocol";

const PROMPT = "NORTH_CODEX_PROMPT ";
const MAX_PROMPT_BYTES = 16 * 1024 * 1024;
const MAX_DUPLEX_FRAME_BYTES = 1024 * 1024;
const DUPLEX_FRAME_PREFIX = "NORTH_CODEX_RPC 1 ";
const MAX_DUPLEX_HEADER_BYTES = 128;
const MAX_DUPLEX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DUPLEX_FRAMES = 20_000;
const MAX_SCAN_FRAMES_PER_TICK = 128;
const MAX_SCAN_BYTES_PER_TICK = 4 * 1024 * 1024;
const TERM_MS = 750;
// Once the direct provider has exited, anything left in its process group is
// an inherited orphan, not a still-running provider turn. Give TERM one short
// scheduling window, then reap decisively so inherited pipes cannot consume
// the host's entire outer teardown budget under load.
const ORPHAN_TERM_MS = 100;
const KILL_MS = 750;
const PIPE_CLOSE_MS = 750;
const POSIX_GROUP = process.platform !== "win32";
const rawArgs = process.argv.slice(2);
const duplex = rawArgs[0] === "--duplex";
const oneShotSpool = rawArgs[0] === "--oneshot-spool";
const spooledInput = duplex || oneShotSpool;
const controlPath = spooledInput ? rawArgs[1] : undefined;
const [executable, ...args] = spooledInput ? rawArgs.slice(2) : rawArgs;
function receipt(value: CodexSupervisorStatus): void {
  const bytes = Buffer.from(`${codexSupervisorStatusLine(value)}\n`, "utf8");
  let offset = 0;
  try {
    while (offset < bytes.byteLength)
      offset += writeSync(2, bytes, offset, bytes.byteLength - offset);
  } catch {
    // Stderr is a supervisor-only status channel; provider stderr is drained
    // separately. EPIPE means the North host is gone, and stdin EOF still
    // drives provider cleanup.
  }
}

function decodeDuplexFrame(
  frame: Buffer,
  maxPayloadBytes = MAX_DUPLEX_FRAME_BYTES,
  allowEmpty = false,
): Buffer {
  const newline = frame.indexOf(0x0a);
  if (newline < 0 || newline >= MAX_DUPLEX_HEADER_BYTES)
    throw new Error("managed Codex control frame header is invalid");
  const header = frame.subarray(0, newline).toString("ascii");
  const match = /^NORTH_CODEX_RPC 1 (0|[1-9][0-9]*) ([0-9a-f]{64})$/.exec(header);
  if (!match) throw new Error("managed Codex control frame header is invalid");
  const length = Number(match[1]);
  if (!Number.isSafeInteger(length) || length < (allowEmpty ? 0 : 1) || length > maxPayloadBytes)
    throw new Error("managed Codex control frame length is invalid");
  const payload = frame.subarray(newline + 1);
  if (payload.byteLength !== length)
    throw new Error("managed Codex control frame is incomplete");
  const digest = createHash("sha256").update(payload).digest("hex");
  if (digest !== match[2])
    throw new Error("managed Codex control frame checksum is invalid");
  return payload;
}

if (!executable) {
  receipt("UNAVAILABLE");
  process.exit(127);
}

let controlDirectory: string | undefined;
let providerInputFd: number | undefined;
let providerWriterFd: number | undefined;
let stopControl = () => {};
if (spooledInput) {
  try {
    if (!controlPath) throw new Error("missing control directory");
    controlDirectory = realpathSync(controlPath);
    const metadata = statSync(controlDirectory);
    if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && metadata.uid !== process.getuid()))
      throw new Error("unsafe control directory");
    stopControl = () => {
      if (providerInputFd !== undefined) {
        try { closeSync(providerInputFd); } catch {}
        providerInputFd = undefined;
      }
      if (providerWriterFd !== undefined) {
        try { closeSync(providerWriterFd); } catch {}
        providerWriterFd = undefined;
      }
      try { rmSync(controlDirectory!, { recursive: true, force: true }); } catch {}
    };
    const mkfifo = process.env.NORTH_MKFIFO_BIN;
    if (!mkfifo) throw new Error("sealed mkfifo path missing");
    const coreutils = realpathSync(mkfifo);
    if (!/^\/nix\/store\/[0-9a-z]{32}-coreutils(?:-full)?-[^/]+\/bin\/coreutils$/.test(coreutils))
      throw new Error("trusted mkfifo unavailable");
    const fifo = `${controlDirectory}/provider-input.fifo`;
    const created = spawnSync(coreutils, ["--coreutils-prog=mkfifo", "-m", "600", fifo], {
      env: { LC_ALL: "C", PATH: "" },
      stdio: "ignore",
    });
    if (created.status !== 0 || created.error || !lstatSync(fifo).isFIFO())
      throw new Error("managed Codex provider FIFO unavailable");
    const guard = openSync(fifo, constants.O_RDWR);
    try {
      providerInputFd = openSync(fifo, constants.O_RDONLY);
      providerWriterFd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } finally {
      closeSync(guard);
    }
  } catch {
    stopControl();
    receipt("UNAVAILABLE");
    process.exit(127);
  }
}
process.once("exit", () => { stopControl(); });

let child: ChildProcessWithoutNullStreams;
const providerInputIdentity = spooledInput && providerInputFd !== undefined
  ? fstatSync(providerInputFd)
  : undefined;
try {
  const providerEnv = { ...process.env };
  delete providerEnv.NORTH_MKFIFO_BIN;
  child = spawn(executable, args, {
    detached: POSIX_GROUP,
    env: providerEnv,
    stdio: [spooledInput ? providerInputFd! : "pipe", "pipe", "pipe"],
  }) as unknown as ChildProcessWithoutNullStreams;
  if (spooledInput && providerInputFd !== undefined) {
    const inheritedFd = providerInputFd;
    setImmediate(() => {
      if (providerInputFd !== inheritedFd) return;
      providerInputFd = undefined;
      try {
        const current = fstatSync(inheritedFd);
        if (providerInputIdentity
            && current.dev === providerInputIdentity.dev
            && current.ino === providerInputIdentity.ino)
          closeSync(inheritedFd);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EBADF"))
          void shutdown();
      }
    });
  }
} catch {
  receipt("UNAVAILABLE");
  process.exit(127);
}

let providerExit:
  | { code: number | null; signal: NodeJS.Signals | null }
  | undefined;
let shutdownPromise: Promise<void> | undefined;
let promptAccepted = spooledInput;

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
  const termMs = providerExit === undefined ? TERM_MS : ORPHAN_TERM_MS;
  const goneAfterTerm = POSIX_GROUP
    ? await waitUntil(() => !groupExists(), termMs)
    : await waitUntil(() => child.exitCode !== null || child.signalCode !== null, termMs);
  if (goneAfterTerm) return;
  signalGroup("SIGKILL");
  if (POSIX_GROUP)
    await waitUntil(() => !groupExists(), KILL_MS);
  else
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, KILL_MS);
}

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    try { await terminateProvider(); }
    finally { stopControl(); }
  })();
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
const stderrDrain = (async () => {
  for await (const _ of child.stderr) { /* provider diagnostics stay private */ }
})();
let closeResolved = false;
let resolveClose!: () => void;
const providerClosed = new Promise<void>((resolve) => { resolveClose = resolve; });
const pipesClosed = Promise.allSettled([providerClosed, stdoutPump, stderrDrain]);
const noteClosed = () => {
  if (closeResolved) return;
  closeResolved = true;
  resolveClose();
};
let startReceipt: "pending" | "started" | "unavailable" = "pending";
const noteStarted = () => {
  if (startReceipt !== "pending") return;
  startReceipt = "started";
  receipt("STARTED");
};
const noteUnavailable = () => {
  if (startReceipt !== "pending") return;
  startReceipt = "unavailable";
  receipt("UNAVAILABLE");
};
child.once("error", () => {
  noteUnavailable();
  providerExit = { code: 127, signal: null };
  noteClosed();
});
child.once("spawn", noteStarted);
// Bun can expose a live pid before a subsequently attached `spawn` listener
// observes the event. A live pid is the same successful-exec proof, and the
// idempotent receipt keeps the ordinary event path exact.
setTimeout(() => {
  if (child.pid !== undefined) noteStarted();
}, 0);
child.once("exit", (code, signal) => {
  providerExit = { code, signal };
  // Reap any inherited descendants left in the direct Codex process group.
  void shutdown();
});
child.once("close", noteClosed);

let input = Buffer.alloc(0);
let promptBytes: number | undefined;
// Bun's global process.stdin can miss pipe traffic in a nested Bun host. A
// direct fd stream preserves kernel EOF semantics. Duplex provider traffic is
// an atomic, private spool feeding a mode-0600 FIFO because nested Bun drops
// parent-to-child pipe/IPC traffic in practice. The transport remains bounded,
// ordered, and outside argv/env.
const hostInput = createReadStream("/dev/null", { fd: 0, autoClose: false });
const acceptProviderBytes = (bytes: Buffer) => {
  if (promptAccepted) return;
  input = Buffer.concat([input, bytes]);
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
};
if (spooledInput) {
  const maxControlFrameBytes = oneShotSpool ? MAX_PROMPT_BYTES : MAX_DUPLEX_FRAME_BYTES;
  const maxControlFileBytes = maxControlFrameBytes + MAX_DUPLEX_HEADER_BYTES;
  const maxControlTotalBytes = oneShotSpool ? MAX_PROMPT_BYTES : MAX_DUPLEX_TOTAL_BYTES;
  const maxControlFrames = oneShotSpool ? 1 : MAX_DUPLEX_FRAMES;
  let nextFrame = 1;
  let duplexBytes = 0;
  let scanning = false;
  let rescanTimer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const providerQueue: Buffer[] = [];
  let providerQueueOffset = 0;
  let flushing = false;
  const scheduleFlush = () => {
    if (flushTimer || shutdownPromise) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushProviderQueue();
    }, 10);
  };
  const flushProviderQueue = () => {
    if (flushing || shutdownPromise || providerWriterFd === undefined) return;
    flushing = true;
    try {
      while (providerQueue.length) {
        const bytes = providerQueue[0]!;
        if (bytes.byteLength === 0) {
          providerQueue.shift();
          providerQueueOffset = 0;
          continue;
        }
        let written: number;
        try {
          written = writeSync(
            providerWriterFd, bytes, providerQueueOffset,
            bytes.byteLength - providerQueueOffset,
          );
        } catch (error) {
          const code = error instanceof Error && "code" in error ? error.code : undefined;
          if (code === "EAGAIN" || code === "EWOULDBLOCK") {
            scheduleFlush();
            return;
          }
          throw error;
        }
        if (written <= 0) {
          scheduleFlush();
          return;
        }
        providerQueueOffset += written;
        if (providerQueueOffset === bytes.byteLength) {
          providerQueue.shift();
          providerQueueOffset = 0;
        }
      }
      if (oneShotSpool && nextFrame === 2 && providerWriterFd !== undefined) {
        closeSync(providerWriterFd);
        providerWriterFd = undefined;
      }
    } catch {
      void shutdown();
    } finally {
      flushing = false;
    }
  };
  const scheduleScan = () => {
    if (rescanTimer || shutdownPromise) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = undefined;
      scan();
    }, 0);
  };
  const scan = () => {
    if (scanning || shutdownPromise) return;
    scanning = true;
    try {
      let tickFrames = 0;
      let tickBytes = 0;
      while (nextFrame <= maxControlFrames) {
        const request = `${controlDirectory}/${String(nextFrame).padStart(12, "0")}.req`;
        let requestFd: number | undefined;
        try {
          requestFd = openSync(request, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
          throw error;
        }
        let frame: Buffer;
        try {
          const metadata = fstatSync(requestFd);
          if (!metadata.isFile() || metadata.size > maxControlFileBytes
              || (metadata.mode & 0o077) !== 0
              || metadata.nlink !== 1
              || (typeof process.getuid === "function" && metadata.uid !== process.getuid()))
            throw new Error("unsafe managed Codex control frame");
          frame = readFileSync(requestFd);
          const after = fstatSync(requestFd);
          const current = lstatSync(request);
          if (after.dev !== metadata.dev || after.ino !== metadata.ino
              || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs
              || after.ctimeMs !== metadata.ctimeMs || current.dev !== metadata.dev
              || current.ino !== metadata.ino || current.size !== metadata.size)
            throw new Error("managed Codex control frame changed while reading");
        } finally {
          closeSync(requestFd);
        }
        const bytes = decodeDuplexFrame(frame, maxControlFrameBytes, oneShotSpool);
        duplexBytes += bytes.byteLength;
        if (duplexBytes > maxControlTotalBytes)
          throw new Error("managed Codex control exceeded its bound");
        unlinkSync(request);
        nextFrame += 1;
        providerQueue.push(bytes);
        tickFrames += 1;
        tickBytes += bytes.byteLength;
        flushProviderQueue();
        if (tickFrames >= MAX_SCAN_FRAMES_PER_TICK || tickBytes >= MAX_SCAN_BYTES_PER_TICK) {
          scheduleScan();
          break;
        }
      }
      if (nextFrame > maxControlFrames) {
        const overflow = `${controlDirectory}/${String(nextFrame).padStart(12, "0")}.req`;
        try {
          lstatSync(overflow);
          throw new Error("managed Codex control emitted too many frames");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
    } catch {
      void shutdown();
    } finally {
      scanning = false;
    }
  };
  let watcher: ReturnType<typeof watch> | undefined;
  try { watcher = watch(controlDirectory!, scan); } catch { /* interval remains authoritative */ }
  const interval = setInterval(scan, 10);
  const closeDuplexControl = stopControl;
  stopControl = () => {
    try { watcher?.close(); } catch {}
    clearInterval(interval);
    if (rescanTimer) clearTimeout(rescanTimer);
    if (flushTimer) clearTimeout(flushTimer);
    rescanTimer = undefined;
    flushTimer = undefined;
    providerQueue.length = 0;
    closeDuplexControl();
  };
  scan();
} else {
  const providerInput = createReadStream("/dev/null", { fd: 4, autoClose: true });
  providerInput.on("data", (chunk: Buffer | string) => {
    acceptProviderBytes(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  providerInput.once("end", () => { if (!promptAccepted) void shutdown(); });
  providerInput.once("close", () => { if (!promptAccepted) void shutdown(); });
  providerInput.once("error", () => { void shutdown(); });
  providerInput.resume();
}
hostInput.once("end", () => { void shutdown(); });
hostInput.once("close", () => { void shutdown(); });
hostInput.once("error", () => { void shutdown(); });
hostInput.resume();

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => { void shutdown(); });

await waitUntil(() => providerExit !== undefined || shutdownPromise !== undefined, 2 ** 31 - 1);
await shutdown();
const pipeDeadline = Date.now() + PIPE_CLOSE_MS;
const pipeTimeRemaining = () => Math.max(0, pipeDeadline - Date.now());
if (!await waitUntil(() => closeResolved, pipeTimeRemaining())) {
  child.stdout.destroy();
  child.stderr.destroy();
}
await Promise.race([
  pipesClosed,
  new Promise<void>((resolve) => setTimeout(resolve, pipeTimeRemaining())),
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
  closeOutput(process.stdout),
  new Promise<void>((resolve) => setTimeout(resolve, pipeTimeRemaining())),
]);
receipt(`EXIT ${exitCode}`);
await Promise.race([
  closeOutput(process.stderr),
  new Promise<void>((resolve) => setTimeout(resolve, pipeTimeRemaining())),
]);
process.exit(exitCode);
