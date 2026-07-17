import {
  spawn, spawnSync, type ChildProcessByStdio, type SpawnSyncReturns,
} from "node:child_process";
import {
  accessSync, closeSync, constants, mkdtempSync, openSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576;
export const MAX_READONLY_COMMAND_BYTES = 64 * 1024;
export const READONLY_SHELL_SERVER = "north-readonly-shell";
export const READONLY_SHELL_TOOL = `mcp__${READONLY_SHELL_SERVER}__run`;

export interface ReadonlyShellPrerequisites {
  bwrap: string;
  bash: string;
  cwd: string;
  home: string;
  path: string;
}

export interface ReadonlyShellResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdout: string;
  stderr: string;
}

export class ReadonlyShellUnavailableError extends Error {
  readonly code = "readonly_shell_preflight_failed";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReadonlyShellUnavailableError";
  }
}

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JGE_K = 0x35;
const BPF_RET_K = 0x06;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050001;
const SECCOMP_RET_ALLOW = 0x7fff0000;

interface SeccompArchitecture {
  auditArch: number;
  socketSyscall: number;
  ioUringSetupSyscall: number;
  rejectsX32: boolean;
}

function seccompArchitecture(): SeccompArchitecture {
  if (process.platform !== "linux")
    throw new ReadonlyShellUnavailableError("readonly_shell_seccomp_requires_linux");
  if (process.arch === "x64")
    return {
      auditArch: 0xc000003e, socketSyscall: 41, ioUringSetupSyscall: 425, rejectsX32: true,
    };
  if (process.arch === "arm64")
    return {
      auditArch: 0xc00000b7, socketSyscall: 198, ioUringSetupSyscall: 425, rejectsX32: false,
    };
  throw new ReadonlyShellUnavailableError(
    `readonly_shell_seccomp_unsupported_architecture:${process.arch}`,
  );
}

/**
 * Classic BPF consumed directly by bubblewrap's --seccomp FD. Denying socket(2)
 * and io_uring_setup(2) is the load-bearing boundary: a read-only bind can still
 * contain mutable host Unix sockets, and IORING_OP_SOCKET otherwise bypasses a
 * filter that covers only the traditional syscall.
 */
export function readonlyShellSeccompProgram(): Buffer {
  const {
    auditArch, socketSyscall, ioUringSetupSyscall, rejectsX32,
  } = seccompArchitecture();
  const instructions: ReadonlyArray<readonly [number, number, number, number]> = [
    [BPF_LD_W_ABS, 0, 0, 4],                    // seccomp_data.arch
    [BPF_JMP_JEQ_K, 1, 0, auditArch],           // reject an unexpected ABI
    [BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS],
    [BPF_LD_W_ABS, 0, 0, 0],                    // seccomp_data.nr
    ...(rejectsX32
      ? [
        // AUDIT_ARCH_X86_64 also covers x32. Its syscall bit would turn
        // socket into 0x40000029 and evade a native-number equality check.
        [BPF_JMP_JGE_K, 0, 1, 0x40000000] as const,
        [BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS] as const,
      ]
      : []),
    [BPF_JMP_JEQ_K, 1, 0, socketSyscall],
    [BPF_JMP_JEQ_K, 0, 1, ioUringSetupSyscall],
    [BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM],
    [BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW],
  ] as const;
  const program = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, value], index) => {
    const offset = index * 8;
    program.writeUInt16LE(code, offset);
    program.writeUInt8(jt, offset + 2);
    program.writeUInt8(jf, offset + 3);
    program.writeUInt32LE(value >>> 0, offset + 4);
  });
  return program;
}

function openSocketDenyFilter(): number {
  const directory = mkdtempSync(join(tmpdir(), "north-readonly-seccomp-"));
  const path = join(directory, "filter.bpf");
  try {
    writeFileSync(path, readonlyShellSeccompProgram(), { mode: 0o600 });
    const fd = openSync(path, "r");
    rmSync(directory, { recursive: true, force: true });
    return fd;
  } catch (cause) {
    rmSync(directory, { recursive: true, force: true });
    if (cause instanceof ReadonlyShellUnavailableError) throw cause;
    throw new ReadonlyShellUnavailableError("readonly_shell_seccomp_filter_unavailable", { cause });
  }
}

function closeInheritedFd(fd: number): void {
  // Bun currently closes an explicitly inherited fd after spawnSync; Node
  // leaves the parent copy open. Accommodate both without weakening the child.
  try { closeSync(fd); } catch { /* already closed by the runtime */ }
}

function executable(candidate: string): string | undefined {
  try {
    const path = realpathSync(candidate);
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

function resolveExecutable(name: string, override: string | undefined, path: string): string {
  const requested = override?.trim() || name;
  const direct = isAbsolute(requested) || requested.includes("/")
    ? executable(resolve(requested))
    : undefined;
  if (direct) return direct;
  if (!isAbsolute(requested) && !requested.includes("/")) {
    for (const directory of path.split(delimiter).filter(Boolean)) {
      const found = executable(join(directory, requested));
      if (found) return found;
    }
  }
  throw new ReadonlyShellUnavailableError(`${name}_executable_unavailable`);
}

function canonicalSandboxPath(path: string): string {
  return [...new Set(path.split(delimiter).filter(Boolean).flatMap((directory) => {
    try {
      const canonical = realpathSync(directory);
      return statSync(canonical).isDirectory() ? [canonical] : [];
    } catch {
      return [];
    }
  }))].join(delimiter);
}

function sandboxArguments(prerequisites: ReadonlyShellPrerequisites, seccompFd: number): string[] {
  return [
    "--die-with-parent",
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--assert-userns-disabled",
    "--new-session",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    // Defense in depth for the common D-Bus/Podman sockets. The seccomp rule is
    // still required because sockets can live anywhere in the read-only tree.
    "--tmpfs", "/run",
    "--tmpfs", "/tmp",
    "--dir", "/tmp/north-home",
    "--clearenv",
    // Keep canonical ~/ paths usable for repo/global instructions. The root
    // bind remains read-only; only cache/state locations below are ephemeral.
    "--setenv", "HOME", prerequisites.home,
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "XDG_CACHE_HOME", "/tmp/north-home/.cache",
    "--setenv", "XDG_CONFIG_HOME", "/tmp/north-home/.config",
    "--setenv", "XDG_DATA_HOME", "/tmp/north-home/.local/share",
    "--setenv", "PATH", prerequisites.path,
    "--setenv", "LANG", process.env.LANG ?? "C.UTF-8",
    "--chdir", prerequisites.cwd,
    "--seccomp", String(seccompFd),
  ];
}

/**
 * Prove the provider adapter can supply a read-only shell before a model turn is
 * accepted. The checkout is a read-only bind, the only writable mount is an
 * ephemeral /tmp, and --unshare-all gives the command no network namespace.
 */
export function preflightReadonlyShell(cwd: string): ReadonlyShellPrerequisites {
  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync(resolve(cwd));
    if (!statSync(canonicalCwd).isDirectory()) throw new Error("not a directory");
  } catch (cause) {
    throw new ReadonlyShellUnavailableError("readonly_shell_cwd_unavailable", { cause });
  }
  if (canonicalCwd === "/tmp" || canonicalCwd.startsWith("/tmp/")) {
    throw new ReadonlyShellUnavailableError("readonly_shell_cwd_hidden_by_ephemeral_tmp");
  }
  const path = process.env.PATH ?? "/usr/bin:/bin";
  const sandboxPath = canonicalSandboxPath(path);
  if (!sandboxPath)
    throw new ReadonlyShellUnavailableError("readonly_shell_executable_path_unavailable");
  let home: string;
  try {
    home = realpathSync(resolve(process.env.HOME ?? homedir()));
    if (!statSync(home).isDirectory()) throw new Error("not a directory");
  } catch (cause) {
    throw new ReadonlyShellUnavailableError("readonly_shell_home_unavailable", { cause });
  }
  if (home === "/tmp" || home.startsWith("/tmp/"))
    throw new ReadonlyShellUnavailableError("readonly_shell_home_hidden_by_ephemeral_tmp");
  const prerequisites = {
    bwrap: resolveExecutable("bwrap", process.env.NORTH_BWRAP_BIN, path),
    bash: resolveExecutable("bash", process.env.NORTH_BASH_BIN, path),
    cwd: canonicalCwd,
    home,
    path: sandboxPath,
  };
  const seccompFd = openSocketDenyFilter();
  const probeName = `.north-readonly-preflight-${process.pid}`;
  let probe: SpawnSyncReturns<string>;
  try {
    probe = spawnSync(prerequisites.bwrap, [
      ...sandboxArguments(prerequisites, 3),
      prerequisites.bash, "--noprofile", "--norc", "-lc",
      `if ( : > ${JSON.stringify(probeName)} ) 2>/dev/null; then rm -f -- ${JSON.stringify(probeName)}; exit 41; fi; p=$(mktemp /tmp/north-shell.XXXXXX) && test -f "$p" && rm -f -- "$p"`,
    ], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe", seccompFd],
    });
  } finally {
    closeInheritedFd(seccompFd);
  }
  if (probe.error || probe.status !== 0) {
    throw new ReadonlyShellUnavailableError(
      probe.status === 41
        ? "readonly_shell_checkout_is_writable"
        : `readonly_shell_sandbox_unavailable${probe.stderr?.trim() ? `: ${probe.stderr.trim()}` : ""}`,
      probe.error ? { cause: probe.error } : undefined,
    );
  }
  return prerequisites;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  remaining: { bytes: number },
): boolean {
  if (remaining.bytes <= 0) return false;
  if (chunk.length <= remaining.bytes) {
    chunks.push(chunk);
    remaining.bytes -= chunk.length;
    return true;
  }
  chunks.push(chunk.subarray(0, remaining.bytes));
  remaining.bytes = 0;
  return false;
}

export async function runReadonlyShell(
  command: string,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ReadonlyShellResult> {
  if (!command.trim()) throw new Error("readonly shell command must be nonblank");
  if (Buffer.byteLength(command, "utf8") > MAX_READONLY_COMMAND_BYTES)
    throw new Error("readonly shell command exceeds 65536 UTF-8 bytes");
  if (!Number.isFinite(timeoutMs))
    throw new Error("readonly shell timeout must be finite");
  const boundedTimeout = Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.trunc(timeoutMs)));
  const prerequisites = preflightReadonlyShell(cwd);
  const seccompFd = openSocketDenyFilter();
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(prerequisites.bwrap, [
      ...sandboxArguments(prerequisites, 3),
      prerequisites.bash, "--noprofile", "--norc", "-lc", command,
    ], {
      // A separate process group gives timeout/output enforcement one kill target
      // for bwrap and every descendant. The PID namespace also collapses when its
      // init dies, but the host-side group kill is the explicit backstop.
      detached: true,
      stdio: ["ignore", "pipe", "pipe", seccompFd],
    }) as ChildProcessByStdio<null, Readable, Readable>;
  } finally {
    closeInheritedFd(seccompFd);
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const remaining = { bytes: MAX_OUTPUT_BYTES };
  let timedOut = false;
  let outputLimitExceeded = false;
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, boundedTimeout);
  child.stdout.on("data", (value: Buffer) => {
    if (!appendBounded(stdout, value, remaining)) {
      outputLimitExceeded = true;
      terminate();
    }
  });
  child.stderr.on("data", (value: Buffer) => {
    if (!appendBounded(stderr, value, remaining)) {
      outputLimitExceeded = true;
      terminate();
    }
  });
  const terminal = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    spawnError?: Error;
  }>((resolveTerminal) => {
    child.once("error", (spawnError) => resolveTerminal({
      exitCode: null, signal: null, spawnError,
    }));
    child.once("close", (exitCode, signal) => resolveTerminal({ exitCode, signal }));
  });
  clearTimeout(timer);
  if (terminal.spawnError) {
    throw new ReadonlyShellUnavailableError("readonly_shell_process_unavailable", {
      cause: terminal.spawnError,
    });
  }
  return {
    ok: terminal.exitCode === 0 && !timedOut && !outputLimitExceeded,
    exitCode: terminal.exitCode,
    signal: terminal.signal,
    timedOut,
    outputLimitExceeded,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}
