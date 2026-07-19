import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type {
  SpawnedProcess,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

const DEFAULT_GRACE_MS = 250;
const DEFAULT_TERM_MS = 1_500;
const DEFAULT_KILL_MS = 1_500;
const GROUP_POLL_MS = 20;
const DEFAULT_DISPOSAL_GRACE_MS = 2_250;

type Spawn = typeof nodeSpawn;

export interface AnthropicProcessLifecycle {
  /** POSIX owns a process group; Windows owns only the direct child. */
  spawnClaudeCodeProcess: (options: ClaudeSpawnOptions) => SpawnedProcess;
  /** Await graceful EOF, then TERM/KILL escalation, leader reaping, and PGID disappearance. */
  settle(): Promise<void>;
  /** Synchronous last defense for a second signal or the host's exit event. */
  forceKill(): void;
  /** True after the SDK has constructed its provider subprocess. */
  started(): boolean;
}

type ProcessSignal = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

export interface AnthropicProcessLifecycleOptions {
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  graceMs?: number;
  termMs?: number;
  killMs?: number;
  currentProcessGroupId?: () => number | undefined;
  processSignal?: ProcessSignal;
}

interface ForceableOwnership { forceKill(): void }

const ownedProcesses = new Set<ForceableOwnership>();
let exitFallbackInstalled = false;

function processGroupFromProc(): number | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    // /proc/<pid>/stat: pid (comm) state ppid pgrp ... . The command name can
    // contain spaces and parentheses, so parse only after its final ')'.
    const stat = readFileSync("/proc/self/stat", "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const pgrp = Number(tail[2]);
    return Number.isSafeInteger(pgrp) && pgrp > 1 ? pgrp : undefined;
  } catch {
    return undefined;
  }
}

function installExitFallback(): void {
  if (exitFallbackInstalled) return;
  exitFallbackInstalled = true;
  process.on("exit", forceOwnedGroupsAtExit);
}

function uninstallExitFallbackIfIdle(): void {
  if (!exitFallbackInstalled || ownedProcesses.size > 0) return;
  process.off("exit", forceOwnedGroupsAtExit);
  exitFallbackInstalled = false;
}

function forceOwnedGroupsAtExit(): void {
  // The exit event cannot await. It is only a synchronous last defense; normal
  // SIGTERM/SIGINT and turn completion use settle() and prove disappearance.
  for (const owned of [...ownedProcesses]) owned.forceKill();
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function systemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

class OwnedPosixGroup {
  private child: ChildProcess | undefined;
  private pgid: number | undefined;
  private leaderExited = false;
  private exitResolve!: () => void;
  private readonly exitPromise = new Promise<void>((resolve) => {
    this.exitResolve = resolve;
  });
  private settlePromise: Promise<void> | undefined;
  private settled = false;
  private sealed = false;
  private forwardedAbort: AbortSignal | undefined;
  private forwardedAbortListener: (() => void) | undefined;

  constructor(
    private readonly spawnProcess: Spawn,
    private readonly graceMs: number,
    private readonly termMs: number,
    private readonly killMs: number,
    private readonly currentProcessGroupId: () => number | undefined,
    private readonly processSignal: ProcessSignal,
  ) {}

  started(): boolean {
    return this.child !== undefined;
  }

  spawn(options: ClaudeSpawnOptions): SpawnedProcess {
    if (this.sealed) throw new Error("anthropic_process_lifecycle_closed");
    if (this.child) throw new Error("anthropic_process_lifecycle_already_started");
    // Do not pass options.signal to Node spawn. The SDK owns that forwarded
    // signal and emits it only after stdin EOF + its grace window; Node would
    // translate it into child.kill(), which cannot reach descendants.
    const child = this.spawnProcess(options.command, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    this.child = child;
    const exited = () => {
      if (this.leaderExited) return;
      this.leaderExited = true;
      this.detachForwardedAbort();
      this.exitResolve();
    };
    // spawn() returns a ChildProcess even for asynchronous ENOENT. Attach the
    // error listener before inspecting pid so that an invalid spawn can never
    // become an unhandled process error after this method rejects.
    child.once("exit", exited);
    child.once("error", exited);
    const pgid = child.pid;
    const parentGroup = this.currentProcessGroupId();
    if (!Number.isSafeInteger(pgid) || pgid === undefined || pgid <= 1
        || pgid === process.pid || pgid === process.ppid || pgid === parentGroup) {
      try { child.kill("SIGKILL"); } catch { /* best effort for invalid ownership */ }
      throw new Error("anthropic_owned_process_group_invalid");
    }
    this.pgid = pgid;
    ownedProcesses.add(this);
    installExitFallback();
    if (!child.stdin || !child.stdout) {
      try { this.signalGroup("SIGKILL"); } catch { /* settle() remains authoritative */ }
      throw new Error("anthropic_provider_stdio_unavailable");
    }

    this.forwardedAbort = options.signal;
    this.forwardedAbortListener = () => { this.signalGroup("SIGTERM"); };
    if (options.signal.aborted) this.forwardedAbortListener();
    else options.signal.addEventListener("abort", this.forwardedAbortListener, { once: true });

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      // A sent signal is not proof of exit. Preserve the ChildProcess state so
      // the SDK may still perform its own TERM/KILL escalation.
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      kill: (signal) => this.signalGroup(signal),
      on: (event: "exit" | "error", listener: any) => { child.on(event, listener); },
      once: (event: "exit" | "error", listener: any) => { child.once(event, listener); },
      off: (event: "exit" | "error", listener: any) => { child.off(event, listener); },
    } as SpawnedProcess;
  }

  private detachForwardedAbort(): void {
    if (this.forwardedAbort && this.forwardedAbortListener)
      this.forwardedAbort.removeEventListener("abort", this.forwardedAbortListener);
    this.forwardedAbort = undefined;
    this.forwardedAbortListener = undefined;
  }

  private groupExists(): boolean {
    if (this.settled || this.pgid === undefined) return false;
    try {
      this.processSignal(-this.pgid, 0);
      return true;
    } catch (error) {
      if (systemCode(error) === "ESRCH") return false;
      throw error;
    }
  }

  private signalGroup(signal: NodeJS.Signals): boolean {
    if (this.settled || this.pgid === undefined) return false;
    const pgid = this.pgid;
    if (pgid <= 1 || pgid === process.pid || pgid === process.ppid
        || pgid === this.currentProcessGroupId()) {
      throw new Error("anthropic_owned_process_group_identity_lost");
    }
    try {
      this.processSignal(-pgid, signal);
      return true;
    } catch (error) {
      if (systemCode(error) === "ESRCH") {
        return false;
      }
      throw error;
    }
  }

  private async waitForGroupGone(milliseconds: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, milliseconds);
    while (this.groupExists()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(GROUP_POLL_MS, remaining));
    }
    return true;
  }

  private async waitForLeaderExit(milliseconds: number): Promise<boolean> {
    if (this.leaderExited) return true;
    let timedOut = false;
    await Promise.race([
      this.exitPromise,
      delay(milliseconds).then(() => { timedOut = true; }),
    ]);
    return !timedOut || this.leaderExited;
  }

  private markSettled(): void {
    if (this.settled) return;
    this.settled = true;
    this.detachForwardedAbort();
    ownedProcesses.delete(this);
    uninstallExitFallbackIfIdle();
  }

  settle(): Promise<void> {
    // Seal synchronously. A timed-out SDK startup may still attempt its custom
    // spawn on a later turn; it must never create ownership after cleanup has
    // already proved the lifecycle empty.
    this.sealed = true;
    return this.settlePromise ??= this.settleOnce();
  }

  private async settleOnce(): Promise<void> {
    if (!this.child || this.pgid === undefined || this.settled) {
      this.markSettled();
      return;
    }
    if (await this.waitForGroupGone(this.graceMs)) {
      if (!await this.waitForLeaderExit(this.killMs))
        throw new Error("anthropic_process_leader_reap_failed");
      this.markSettled();
      return;
    }
    this.signalGroup("SIGTERM");
    if (await this.waitForGroupGone(this.termMs)) {
      if (!await this.waitForLeaderExit(this.killMs))
        throw new Error("anthropic_process_leader_reap_failed");
      this.markSettled();
      return;
    }
    this.signalGroup("SIGKILL");
    const [groupGone, leaderGone] = await Promise.all([
      this.waitForGroupGone(this.killMs),
      this.waitForLeaderExit(this.killMs),
    ]);
    if (!groupGone || !leaderGone)
      throw new Error("anthropic_process_group_reap_failed");
    this.markSettled();
  }

  forceKill(): void {
    this.sealed = true;
    if (this.settled) return;
    if (this.pgid === undefined) {
      this.markSettled();
      return;
    }
    try {
      const signalled = this.signalGroup("SIGKILL");
      if (!signalled && this.leaderExited) this.markSettled();
    } catch { /* synchronous exit defense */ }
  }
}

class OwnedDirectChild {
  private child: ChildProcess | undefined;
  private leaderExited = false;
  private exitResolve!: () => void;
  private readonly exitPromise = new Promise<void>((resolve) => { this.exitResolve = resolve; });
  private settlePromise: Promise<void> | undefined;
  private settled = false;
  private sealed = false;
  private forwardedAbort: AbortSignal | undefined;
  private forwardedAbortListener: (() => void) | undefined;

  constructor(
    private readonly spawnProcess: Spawn,
    private readonly graceMs: number,
    private readonly termMs: number,
    private readonly killMs: number,
  ) {}

  started(): boolean { return this.child !== undefined; }

  spawn(options: ClaudeSpawnOptions): SpawnedProcess {
    if (this.sealed) throw new Error("anthropic_process_lifecycle_closed");
    if (this.child) throw new Error("anthropic_process_lifecycle_already_started");
    const child = this.spawnProcess(options.command, options.args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      detached: false,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    this.child = child;
    const exited = () => {
      if (this.leaderExited) return;
      this.leaderExited = true;
      this.detachForwardedAbort();
      this.exitResolve();
    };
    child.once("exit", exited);
    child.once("error", exited);
    if (!Number.isSafeInteger(child.pid) || child.pid === undefined || child.pid <= 1
        || child.pid === process.pid || child.pid === process.ppid) {
      try { child.kill("SIGKILL"); } catch { /* invalid child ownership */ }
      throw new Error("anthropic_owned_direct_child_invalid");
    }
    ownedProcesses.add(this);
    installExitFallback();
    if (!child.stdin || !child.stdout) {
      try { child.kill("SIGKILL"); } catch { /* settle remains authoritative */ }
      throw new Error("anthropic_provider_stdio_unavailable");
    }
    this.forwardedAbort = options.signal;
    this.forwardedAbortListener = () => { this.signalChild("SIGTERM"); };
    if (options.signal.aborted) this.forwardedAbortListener();
    else options.signal.addEventListener("abort", this.forwardedAbortListener, { once: true });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      kill: (signal) => this.signalChild(signal),
      on: (event: "exit" | "error", listener: any) => { child.on(event, listener); },
      once: (event: "exit" | "error", listener: any) => { child.once(event, listener); },
      off: (event: "exit" | "error", listener: any) => { child.off(event, listener); },
    } as SpawnedProcess;
  }

  private detachForwardedAbort(): void {
    if (this.forwardedAbort && this.forwardedAbortListener)
      this.forwardedAbort.removeEventListener("abort", this.forwardedAbortListener);
    this.forwardedAbort = undefined;
    this.forwardedAbortListener = undefined;
  }

  private signalChild(signal: NodeJS.Signals): boolean {
    if (this.settled || !this.child || this.leaderExited) return false;
    try { return this.child.kill(signal); }
    catch (error) {
      if (systemCode(error) === "ESRCH") return false;
      throw error;
    }
  }

  private async waitForExit(milliseconds: number): Promise<boolean> {
    if (this.leaderExited) return true;
    let timedOut = false;
    await Promise.race([
      this.exitPromise,
      delay(milliseconds).then(() => { timedOut = true; }),
    ]);
    return !timedOut || this.leaderExited;
  }

  private markSettled(): void {
    if (this.settled) return;
    this.settled = true;
    this.detachForwardedAbort();
    ownedProcesses.delete(this);
    uninstallExitFallbackIfIdle();
  }

  settle(): Promise<void> {
    this.sealed = true;
    return this.settlePromise ??= this.settleOnce();
  }

  private async settleOnce(): Promise<void> {
    if (!this.child || this.settled) {
      this.markSettled();
      return;
    }
    if (await this.waitForExit(this.graceMs)) {
      this.markSettled();
      return;
    }
    this.signalChild("SIGTERM");
    if (await this.waitForExit(this.termMs)) {
      this.markSettled();
      return;
    }
    this.signalChild("SIGKILL");
    if (!await this.waitForExit(this.killMs))
      throw new Error("anthropic_direct_child_reap_failed");
    this.markSettled();
  }

  forceKill(): void {
    this.sealed = true;
    if (this.settled) return;
    if (!this.child) {
      this.markSettled();
      return;
    }
    try {
      const signalled = this.signalChild("SIGKILL");
      if (!signalled && this.leaderExited) this.markSettled();
    } catch { /* synchronous exit defense */ }
  }
}

export interface SettleAnthropicProcessOwnerOptions {
  lifecycle: AnthropicProcessLifecycle;
  abortController: AbortController;
  dispose?: () => Promise<unknown> | unknown;
  disposalGraceMs?: number;
}

/**
 * Shared Query/WarmQuery cleanup seam. Provider disposal is bounded and may
 * wedge; owned process settlement is authoritative and always runs afterward.
 */
export async function settleAnthropicProcessOwner({
  lifecycle,
  abortController,
  dispose,
  disposalGraceMs = DEFAULT_DISPOSAL_GRACE_MS,
}: SettleAnthropicProcessOwnerOptions): Promise<void> {
  abortController.abort(new Error("north_anthropic_query_closed"));
  let disposalState: { kind: "settled" } | { kind: "failed"; error: unknown }
    | { kind: "timeout" } = dispose ? { kind: "timeout" } : { kind: "settled" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (dispose) {
    const disposal = Promise.resolve().then(dispose).then(
      () => ({ kind: "settled" as const }),
      (error) => ({ kind: "failed" as const, error }),
    );
    disposalState = await Promise.race([
      disposal,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), disposalGraceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  await lifecycle.settle();
  if (disposalState.kind === "timeout") throw new Error("anthropic_sdk_disposal_timeout");
  if (disposalState.kind === "failed") throw disposalState.error;
}

/**
 * Own the Claude CLI process tree on POSIX. Windows owns and reaps the direct
 * child with positive-PID signals only; North makes no descendant-tree claim
 * on that platform.
 */
export function createAnthropicProcessLifecycle(
  options: AnthropicProcessLifecycleOptions = {},
): AnthropicProcessLifecycle {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const owned = new OwnedDirectChild(
      options.spawn ?? nodeSpawn,
      options.graceMs ?? DEFAULT_GRACE_MS,
      options.termMs ?? DEFAULT_TERM_MS,
      options.killMs ?? DEFAULT_KILL_MS,
    );
    return {
      spawnClaudeCodeProcess: (spawnOptions) => owned.spawn(spawnOptions),
      settle: () => owned.settle(),
      forceKill: () => owned.forceKill(),
      started: () => owned.started(),
    };
  }
  const owned = new OwnedPosixGroup(
    options.spawn ?? nodeSpawn,
    options.graceMs ?? DEFAULT_GRACE_MS,
    options.termMs ?? DEFAULT_TERM_MS,
    options.killMs ?? DEFAULT_KILL_MS,
    options.currentProcessGroupId ?? processGroupFromProc,
    options.processSignal ?? ((pid, signal) => process.kill(pid, signal)),
  );
  return {
    spawnClaudeCodeProcess: (spawnOptions) => owned.spawn(spawnOptions),
    settle: () => owned.settle(),
    forceKill: () => owned.forceKill(),
    started: () => owned.started(),
  };
}
