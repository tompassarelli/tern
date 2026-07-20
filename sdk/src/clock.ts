// Managed task timing and human billing are orthogonal. A managed client lane
// synchronously verifies the branch ticket, North thread, owner, and an already
// open owner-scoped HUMAN client session before provider/identity work. It never
// starts or stops billing time; each lane's elapsed time is existing run telemetry.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { getThreadFacts, type Fact } from "./north-client";
import {
  trustedGitBranchName, trustedGitExecutable, trustedGitProjectRoot,
} from "./trusted-runtime";
export { trustedGitExecutable } from "./trusted-runtime";

const REPO = resolve(import.meta.dir, "..", "..");
// NORTH_BIN override mirrors death.ts, so tests can point at a fake.
const northBin = () => process.env.NORTH_BIN ?? `${REPO}/bin/north`;

export type BillableClockPreflightCode =
  | "billable_thread_required"
  | "billable_ticket_required"
  | "billable_thread_owner_unavailable"
  | "billable_thread_owner_mismatch"
  | "billable_thread_linear_mismatch"
  | "billable_client_session_required"
  | "billable_client_session_mismatch"
  | "billable_client_session_rate_required"
  | "billable_client_session_rate_invalid"
  | "billable_client_session_readback_failed";

export class BillableClockPreflightError extends Error {
  readonly preSideEffect = true;

  constructor(readonly code: BillableClockPreflightCode) {
    super(code);
    this.name = "BillableClockPreflightError";
  }
}

export type BillableClockAdmission =
  | { kind: "not-required" }
  | {
      kind: "verified";
      client: string;
      rate: string;
      threadId: string;
    };

export interface BillableClockRuntime {
  projectRoot?: (cwd: string) => string;
  branchName?: (projectRoot: string) => string;
  gitExecutable?: () => string;
  readThreadFacts?: (threadId: string) => Fact[];
  execute?: (
    command: { args: string[]; agentEnv?: string },
  ) => string;
}

function runNorthCapture(
  cmd: { args: string[]; agentEnv?: string },
): string {
  return execFileSync(northBin(), cmd.args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: cmd.agentEnv
      ? { ...process.env, NORTH_AGENT_ID: cmd.agentEnv }
      : process.env,
  });
}

function defaultProjectRoot(cwd: string, gitExecutable: string): string {
  return trustedGitProjectRoot(cwd, gitExecutable);
}

/** Exact client identity encoded by a canonical project root, or undefined. */
export function clientOwnerForProjectRoot(projectRoot: string): string | undefined {
  const match = /(?:^|\/)code\/client\/([^/]+)(?:\/|$)/.exec(projectRoot);
  return match?.[1] || undefined;
}

function defaultBranchName(projectRoot: string, gitExecutable: string): string {
  return trustedGitBranchName(projectRoot, gitExecutable);
}

/** Canonical Linear ticket carried by a client branch, e.g. msa-242-x -> MSA-242. */
export function clientTicketForBranch(
  branchName: string,
  client: string,
): string | undefined {
  const escapedClient = client.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidates = [...branchName.matchAll(
    new RegExp(`${escapedClient}-[0-9]+`, "ig"),
  )].filter((match) => {
    const start = match.index ?? -1;
    const end = start + match[0].length;
    return start >= 0
      && (start === 0 || /[/_-]/.test(branchName[start - 1]!))
      && (end === branchName.length || /[/_-]/.test(branchName[end]!));
  });
  return candidates.length === 1 ? candidates[0]![0].toUpperCase() : undefined;
}

function clientStatus(output: string): { owner: string; rate?: string } | undefined {
  const line = output.split(/\r?\n/, 1)[0] ?? "";
  const owner = /^clocked in for client ([A-Za-z0-9][A-Za-z0-9._-]*)  \(session /.exec(line)?.[1];
  if (!owner) return undefined;
  const rate = /, rate ([^\s)]+)\/h\)$/.exec(line)?.[1];
  return { owner, ...(rate ? { rate } : {}) };
}

function validCapturedRate(rate: string): boolean {
  if (!/^[1-9][0-9]{0,9}$/.test(rate)) return false;
  const parsed = Number(rate);
  return Number.isInteger(parsed) && parsed <= 2_147_483_647;
}

/**
 * Required pre-provider client-session admission. Non-client or read-only work
 * is unchanged. A write-capable client lane binds the exact owner/Linear thread
 * and verifies an independently opened human session for that owner. No billing
 * mutation belongs to a managed lane.
 */
export function admitBillableClock(
  input: {
    agentId: string;
    capabilities: readonly string[];
    cwd: string;
    threadId?: string;
  },
  runtime: BillableClockRuntime = {},
): BillableClockAdmission {
  let resolvedGit: string | undefined;
  const gitExecutable = () => {
    if (!resolvedGit) {
      resolvedGit = runtime.gitExecutable
        ? trustedGitExecutable([runtime.gitExecutable()])
        : trustedGitExecutable();
    }
    return resolvedGit;
  };
  const projectRoot = runtime.projectRoot
    ? runtime.projectRoot(input.cwd)
    : defaultProjectRoot(input.cwd, gitExecutable());
  const client = clientOwnerForProjectRoot(projectRoot);
  const required = input.capabilities.includes("filesystem.write")
    && client !== undefined;
  if (!input.threadId) {
    if (required)
      throw new BillableClockPreflightError("billable_thread_required");
    return { kind: "not-required" };
  }
  if (required) {
    let ticket: string | undefined;
    try {
      ticket = clientTicketForBranch(
        runtime.branchName
          ? runtime.branchName(projectRoot)
          : defaultBranchName(projectRoot, gitExecutable()),
        client,
      );
    } catch {
      ticket = undefined;
    }
    if (!ticket)
      throw new BillableClockPreflightError("billable_ticket_required");
    let facts: Fact[];
    try {
      facts = (runtime.readThreadFacts ?? getThreadFacts)(input.threadId);
    } catch {
      throw new BillableClockPreflightError(
        "billable_thread_owner_unavailable",
      );
    }
    const owners = facts
      .filter(({ predicate }) => predicate === "owner")
      .map(({ value }) => value);
    if (owners.length !== 1 || owners[0] !== client)
      throw new BillableClockPreflightError("billable_thread_owner_mismatch");
    const linearTickets = facts
      .filter(({ predicate }) => predicate === "linear")
      .map(({ value }) => value);
    if (linearTickets.length !== 1 || linearTickets[0] !== ticket)
      throw new BillableClockPreflightError("billable_thread_linear_mismatch");
  }

  if (!required) return { kind: "not-required" };
  const execute = runtime.execute ?? runNorthCapture;
  const status = { args: ["clock", "status"], agentEnv: "user" };
  try {
    const observed = clientStatus(execute(status));
    if (!observed)
      throw new BillableClockPreflightError("billable_client_session_required");
    if (observed.owner !== client)
      throw new BillableClockPreflightError("billable_client_session_mismatch");
    if (!observed.rate || observed.rate === "?")
      throw new BillableClockPreflightError("billable_client_session_rate_required");
    if (!validCapturedRate(observed.rate))
      throw new BillableClockPreflightError("billable_client_session_rate_invalid");
    return {
      kind: "verified", client, rate: observed.rate, threadId: input.threadId,
    };
  } catch (error) {
    if (error instanceof BillableClockPreflightError) throw error;
    throw new BillableClockPreflightError("billable_client_session_readback_failed");
  }
}
