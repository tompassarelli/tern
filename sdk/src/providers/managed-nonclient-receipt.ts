import { execFileSync } from "node:child_process";
import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import {
  closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { clientOwnerForProjectRoot } from "../clock";
import { runReservationValid } from "../delivery-evidence";
import { getThreadFacts, type Fact } from "../north-client";
import {
  gitOracleEnvironment, trustedGitExecutable,
} from "../trusted-runtime";

export const MANAGED_NONCLIENT_RECEIPT_VERSION =
  "north:managed-nonclient-admission:v1";
export const MANAGED_NONCLIENT_RECEIPT_FILE_ENV =
  "NORTH_MANAGED_NONCLIENT_ADMISSION_FILE";
const LEGACY_MANAGED_NONCLIENT_RECEIPT_ENV = [
  "NORTH_MANAGED_NONCLIENT_RECEIPT_PATH",
  "NORTH_MANAGED_NONCLIENT_RECEIPT_CAPABILITY",
] as const;
export const MANAGED_NONCLIENT_RECEIPT_FRESHNESS_MS = 30 * 60 * 1_000;
export const MAX_MANAGED_NONCLIENT_RECEIPT_BYTES = 16 * 1_024;

const MAX_GIT_OUTPUT_BYTES = 64 * 1_024;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,512}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface ValidatedManagedCodexThreadAuthority {
  providerThreadId: string;
  cwd: string;
  projectRoot: string;
  workspaceRoots: readonly [string];
  sandbox: {
    type: "workspaceWrite";
    writableRoots: readonly [];
    networkAccess: false;
    excludeTmpdirEnvVar: false;
    excludeSlashTmp: false;
  };
}

export interface ManagedNonclientReceiptRuntime {
  now?: () => number;
  readFacts?: (id: string) => Fact[];
  runGit?: (cwd: string, args: readonly string[]) => string;
  realpath?: (path: string) => string;
  randomSuffix?: () => string;
  randomNonce?: () => string;
}

export interface ManagedNonclientReceiptAuthority {
  readonly path: string;
  refresh(authority: ValidatedManagedCodexThreadAuthority): void;
  revoke(): void;
  dispose(): void;
}

interface ManagedAdmissionReceipt {
  authority: {
    agent: string;
    managedLane: "1";
    projectRoot: string;
    provider: "openai";
    providerThread: string;
    sandbox: {
      excludeSlashTmp: false;
      excludeTmpdirEnvVar: false;
      networkAccess: false;
      runtimeWorkspaceRoots: readonly [string];
      type: "workspaceWrite";
      writableRoots: readonly [];
    };
    topology: "worker";
    workspaceRoot: string;
  };
  issuedAt: string;
  laneRegistration: {
    branch: string;
    kind: "lane";
    manifestSha256: string;
    repo: string;
    repoRoot: string;
    subject: string;
    worktree: string;
  };
  mac?: string;
  nonce: string;
  notAfter: string;
  runReservation: {
    capabilitySha256: string;
    manifestSha256: string;
    reporter: string;
    reservedAt: string;
    subject: string;
    thread: string;
  };
  version: typeof MANAGED_NONCLIENT_RECEIPT_VERSION;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort()
      .map((key) => [key, canonical(record[key])]));
  }
  return value;
}

export function canonicalManagedNonclientJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function one(facts: readonly Fact[], predicate: string): string {
  const values = facts.filter((fact) => fact.predicate === predicate)
    .map((fact) => fact.value);
  if (values.length !== 1 || !values[0])
    throw new Error(`managed non-client admission requires singleton ${predicate}`);
  return values[0];
}

function laneManifest(lane: {
  subject: string;
  kind: "lane";
  repo: string;
  worktree: string;
  branch: string;
}): string {
  return sha256(["subject", "kind", "repo", "worktree", "branch"]
    .map((field) => `${field}\0${lane[field as keyof typeof lane]}\n`).join(""));
}

function expandUserPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function assertSafeId(value: string, label: string): string {
  const normalized = value.replace(/^@/, "");
  if (!SAFE_ID.test(normalized) || normalized !== normalized.trim())
    throw new Error(`managed non-client admission ${label} is invalid`);
  return normalized;
}

function parseWorktreeList(output: string): Array<{ path: string; branch?: string }> {
  if (Buffer.byteLength(output, "utf8") > MAX_GIT_OUTPUT_BYTES)
    throw new Error("managed non-client admission Git registration is oversized");
  return output.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
    }
    if (!path) throw new Error("managed non-client admission Git registration is malformed");
    return { path, ...(branch ? { branch } : {}) };
  });
}

function defaultGit(cwd: string, args: readonly string[]): string {
  return execFileSync(trustedGitExecutable(), ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitOracleEnvironment(),
    timeout: 2_000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function atomicPublish(path: string, bytes: Buffer, randomSuffix: () => string): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANAGED_NONCLIENT_RECEIPT_BYTES)
    throw new Error("managed non-client admission receipt exceeds fixed bound");
  const temporary = `${path}.tmp-${randomSuffix()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600);
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

class ReceiptAuthority implements ManagedNonclientReceiptAuthority {
  readonly path: string;
  private readonly runId: string;
  private readonly threadId: string;
  private readonly agentId: string;
  private readonly runCapability: string;
  private readonly now: () => number;
  private readonly readFacts: (id: string) => Fact[];
  private readonly runGit: (cwd: string, args: readonly string[]) => string;
  private readonly canonicalPath: (path: string) => string;
  private readonly randomSuffix: () => string;
  private readonly randomNonce: () => string;
  private disposed = false;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    home: string,
    runtime: ManagedNonclientReceiptRuntime,
  ) {
    this.now = runtime.now ?? Date.now;
    this.readFacts = runtime.readFacts ?? getThreadFacts;
    this.runGit = runtime.runGit ?? defaultGit;
    this.canonicalPath = runtime.realpath ?? realpathSync;
    this.randomSuffix = runtime.randomSuffix ?? (() => randomBytes(8).toString("hex"));
    this.randomNonce = runtime.randomNonce ?? (() => randomBytes(32).toString("hex"));
    this.runId = assertSafeId(env.NORTH_RUN_ID ?? "", "run id");
    this.threadId = assertSafeId(env.NORTH_THREAD_ID ?? "", "thread id");
    this.agentId = assertSafeId((env.AGENT_ID ?? "").replace(/^agent:/, ""), "reporter");
    this.runCapability = env.NORTH_RUN_CAPABILITY ?? "";
    if (!SHA256.test(this.runCapability))
      throw new Error("managed non-client admission run capability is invalid");
    const requestedHome = resolve(home);
    const canonicalHome = this.canonicalPath(requestedHome);
    const info = lstatSync(requestedHome);
    if (canonicalHome !== requestedHome || !info.isDirectory()
        || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error("managed non-client admission home is not private");
    this.path = join(canonicalHome, "managed-nonclient-admission.json");
    env[MANAGED_NONCLIENT_RECEIPT_FILE_ENV] = this.path;
  }

  private receipt(authority: ValidatedManagedCodexThreadAuthority): ManagedAdmissionReceipt {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("managed non-client admission clock is invalid");
    const runFacts = this.readFacts(this.runId);
    if (!runReservationValid(runFacts))
      throw new Error("managed non-client admission run reservation is invalid");
    if (one(runFacts, "run_capability_sha256") !== sha256(this.runCapability)
        || one(runFacts, "run_reservation_thread") !== `@${this.threadId}`
        || one(runFacts, "run_reservation_agent") !== `@agent:${this.agentId}`)
      throw new Error("managed non-client admission run reservation binding changed");
    const reservedAt = Date.parse(one(runFacts, "run_reserved_at"));
    if (!Number.isFinite(reservedAt) || reservedAt > now
        || now - reservedAt > MANAGED_NONCLIENT_RECEIPT_FRESHNESS_MS)
      throw new Error("managed non-client admission run reservation is stale");
    if (runFacts.some((fact) => [
      "kind", "outcome", "process_outcome", "terminal_manifest_sha256",
    ].includes(fact.predicate)))
      throw new Error("managed non-client admission run is already terminal");

    const laneFacts = this.readFacts(`agent:${this.agentId}`);
    const branch = one(laneFacts, "branch");
    const worktree = this.canonicalPath(one(laneFacts, "worktree"));
    const repo = one(laneFacts, "repo");
    const expandedRepo = expandUserPath(repo);
    if (Buffer.byteLength(repo, "utf8") > 4096 || /[\u0000-\u001f]/.test(repo)
        || !isAbsolute(expandedRepo))
      throw new Error("managed non-client admission lane repo is invalid");
    const mainRoot = this.canonicalPath(expandedRepo);
    if (one(laneFacts, "kind") !== "lane" || one(laneFacts, "provider") !== "openai"
        || branch !== `lane-${this.agentId}`
        || laneFacts.some((fact) => ["outcome", "terminal_manifest_sha256"].includes(fact.predicate)))
      throw new Error("managed non-client admission lane registration is invalid");

    const cwd = this.canonicalPath(authority.cwd);
    const projectRoot = this.canonicalPath(authority.projectRoot);
    if (cwd !== worktree || projectRoot !== worktree
        || authority.workspaceRoots.length !== 1
        || this.canonicalPath(authority.workspaceRoots[0]) !== worktree
        || authority.sandbox.type !== "workspaceWrite"
        || authority.sandbox.writableRoots.length !== 0
        || authority.sandbox.networkAccess !== false
        || authority.sandbox.excludeTmpdirEnvVar !== false
        || authority.sandbox.excludeSlashTmp !== false)
      throw new Error("managed non-client admission provider workspace authority changed");
    if (clientOwnerForProjectRoot(mainRoot) !== undefined)
      throw new Error("managed non-client admission refuses client main roots");
    if (mainRoot === worktree)
      throw new Error("managed non-client admission requires a linked worktree");

    const gitRoot = this.canonicalPath(this.runGit(worktree,
      ["rev-parse", "--show-toplevel"]).trim());
    const gitBranch = this.runGit(worktree, ["branch", "--show-current"]).trim();
    const gitCommonDir = this.canonicalPath(this.runGit(worktree,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
    const gitDir = this.canonicalPath(this.runGit(worktree,
      ["rev-parse", "--path-format=absolute", "--git-dir"]).trim());
    const mainGitRoot = this.canonicalPath(this.runGit(mainRoot,
      ["rev-parse", "--show-toplevel"]).trim());
    const mainGitDir = this.canonicalPath(this.runGit(mainRoot,
      ["rev-parse", "--path-format=absolute", "--git-dir"]).trim());
    if (gitRoot !== worktree || gitBranch !== branch || mainGitRoot !== mainRoot
        || basename(gitCommonDir) !== ".git" || dirname(gitCommonDir) !== mainRoot
        || mainGitDir !== gitCommonDir || gitDir === gitCommonDir
        || !gitDir.startsWith(`${gitCommonDir}/worktrees/`))
      throw new Error("managed non-client admission Git linkage is invalid");
    const registrations = parseWorktreeList(this.runGit(mainRoot,
      ["worktree", "list", "--porcelain"]));
    if (registrations.filter((entry) => this.canonicalPath(entry.path) === mainRoot).length !== 1
        || registrations.filter((entry) => this.canonicalPath(entry.path) === worktree
          && entry.branch === branch).length !== 1)
      throw new Error("managed non-client admission Git worktree registration is invalid");

    const issuedAt = new Date(now).toISOString();
    const notAfter = new Date(now + MANAGED_NONCLIENT_RECEIPT_FRESHNESS_MS).toISOString();
    const subject = `@agent:${this.agentId}`;
    const registration = {
      subject,
      kind: "lane" as const,
      repo,
      repoRoot: mainRoot,
      worktree,
      branch,
    };
    const reservationManifest = one(runFacts, "run_reservation_manifest_sha256");
    if (!SHA256.test(reservationManifest))
      throw new Error("managed non-client admission run reservation manifest is invalid");
    const nonce = this.randomNonce();
    if (!SHA256.test(nonce))
      throw new Error("managed non-client admission nonce is invalid");
    return {
      authority: {
        agent: subject,
        managedLane: "1",
        projectRoot,
        provider: "openai",
        providerThread: assertSafeId(authority.providerThreadId, "provider thread id"),
        sandbox: {
          type: "workspaceWrite",
          runtimeWorkspaceRoots: [worktree],
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        topology: "worker",
        workspaceRoot: worktree,
      },
      issuedAt,
      laneRegistration: {
        ...registration,
        manifestSha256: laneManifest(registration),
      },
      nonce,
      notAfter,
      runReservation: {
        subject: `@${this.runId}`,
        thread: `@${this.threadId}`,
        reporter: subject,
        reservedAt: one(runFacts, "run_reserved_at"),
        manifestSha256: reservationManifest,
        capabilitySha256: sha256(this.runCapability),
      },
      version: MANAGED_NONCLIENT_RECEIPT_VERSION,
    };
  }

  refresh(authority: ValidatedManagedCodexThreadAuthority): void {
    if (this.disposed) throw new Error("managed non-client admission receipt is disposed");
    this.revoke();
    try {
      const receipt = this.receipt(authority);
      const key = Buffer.from(hkdfSync(
        "sha256",
        Buffer.from(this.runCapability, "hex"),
        Buffer.from(receipt.runReservation.manifestSha256, "hex"),
        Buffer.from(MANAGED_NONCLIENT_RECEIPT_VERSION, "ascii"),
        32,
      ));
      try {
        receipt.mac = createHmac("sha256", key)
          .update(canonicalManagedNonclientJson(receipt)).digest("hex");
      } finally {
        key.fill(0);
      }
      atomicPublish(this.path,
        Buffer.from(canonicalManagedNonclientJson(receipt), "utf8"), this.randomSuffix);
    } catch (error) {
      try { this.revoke(); } catch {}
      throw error;
    }
  }

  revoke(): void {
    try { unlinkSync(this.path); }
    catch (error) { if (!isMissing(error)) throw error; }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    let failure: unknown;
    try { this.revoke(); } catch (error) { failure = error; }
    scrubManagedNonclientReceiptEnvironment(this.env);
    if (failure) throw failure;
  }
}

export function prepareManagedNonclientReceipt(
  env: NodeJS.ProcessEnv,
  privateHome: string,
  runtime: ManagedNonclientReceiptRuntime = {},
): ManagedNonclientReceiptAuthority {
  scrubManagedNonclientReceiptEnvironment(env);
  return new ReceiptAuthority(env, privateHome, runtime);
}

export function scrubManagedNonclientReceiptEnvironment(env: NodeJS.ProcessEnv): void {
  delete env[MANAGED_NONCLIENT_RECEIPT_FILE_ENV];
  for (const key of LEGACY_MANAGED_NONCLIENT_RECEIPT_ENV) delete env[key];
}
