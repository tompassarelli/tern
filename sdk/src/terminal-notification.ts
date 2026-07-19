import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { ExecutionTerminal } from "./execution-outcome";
import type { TerminalPublicationStatus } from "./identity";
import type { RunPublicationStatus } from "./telemetry";

const REPO = resolve(import.meta.dir, "..", "..");
const MSG_CLI = `${REPO}/cli/msg-cli.clj`;
const port = () => process.env.NORTH_PORT ?? "7977";
const peerBb = () => process.env.NORTH_PEER_BB ?? "bb";
const DEFAULT_PUBLICATION_BUDGET_MS = 10_000;
const MIN_PUBLICATION_BUDGET_MS = 100;
const MAX_PUBLICATION_BUDGET_MS = 60_000;

type Command = { cmd: string; args: string[] };

export interface TerminalNotification {
  outcome: string;
  terminal: ExecutionTerminal;
  terminalPublication: TerminalPublicationStatus;
  runPublication: RunPublicationStatus;
  detail?: string;
  subject?: string;
}

export function terminalPublicationBudgetMs(raw = process.env.NORTH_TERMINAL_PUBLICATION_BUDGET_MS): number {
  if (raw === undefined) return DEFAULT_PUBLICATION_BUDGET_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_PUBLICATION_BUDGET_MS;
  return Math.min(MAX_PUBLICATION_BUDGET_MS, Math.max(MIN_PUBLICATION_BUDGET_MS, value));
}

/**
 * One wall-clock budget covers terminal publication, run publication, and the
 * peer wake. Publication stages split the non-peer remainder fairly; a slow
 * first stage therefore cannot consume the wake-up's reserved final slice.
 */
export class TerminalPublicationBudget {
  private readonly startedAt: number;
  private readonly peerReserveMs: number;

  constructor(
    readonly totalMs = terminalPublicationBudgetMs(),
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startedAt = this.now();
    this.peerReserveMs = Math.max(1, Math.floor(totalMs / 5));
  }

  publicationTimeout(stagesRemaining: number): number {
    const elapsed = Math.max(0, this.now() - this.startedAt);
    const available = Math.max(1, this.totalMs - elapsed - this.peerReserveMs);
    return Math.max(1, Math.floor(available / Math.max(1, stagesRemaining)));
  }

  notificationTimeout(): number {
    const elapsed = Math.max(0, this.now() - this.startedAt);
    return Math.max(1, Math.floor(this.totalMs - elapsed));
  }
}

function defaultSubject(outcome: string, terminal: ExecutionTerminal): string {
  if (outcome === "died" || outcome === "stalled") return "AGENT DEATH";
  if (outcome === "max_turns" || outcome === "capped") return "TURN CAP";
  return terminal.deliveryOutcome === "blocked" ? "AGENT BLOCKED" : "AGENT COMPLETE";
}

function boundedDetail(detail?: string): string | undefined {
  const value = detail?.replace(/\s+/g, " ").trim().slice(0, 500);
  return value || undefined;
}

export function terminalNotificationCommand(
  agentId: string,
  coordinator: string | undefined,
  notification: TerminalNotification,
): Command | undefined {
  if (!coordinator) return undefined;
  const detail = boundedDetail(notification.detail);
  const body = [
    detail,
    `process=${notification.terminal.processOutcome}`,
    `delivery=${notification.terminal.deliveryOutcome}`,
    `terminal=${notification.terminalPublication}`,
    `run=${notification.runPublication}`,
  ].filter(Boolean).join(" — ");
  return {
    cmd: peerBb(),
    args: [
      MSG_CLI,
      port(),
      "send",
      agentId,
      coordinator,
      notification.subject ?? defaultSubject(notification.outcome, notification.terminal),
      body,
    ],
  };
}

export function notifyTerminalSettlement(
  agentId: string,
  coordinator: string | undefined,
  notification: TerminalNotification,
  timeoutMs = 10_000,
): void {
  const command = terminalNotificationCommand(agentId, coordinator, notification);
  if (!command) return;
  try {
    execFileSync(command.cmd, command.args, {
      encoding: "utf8",
      timeout: Math.max(1, Math.floor(timeoutMs)),
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Publication settlement remains authoritative. Notification is only a
    // wake-up and never replaces the lane's real execution outcome.
  }
}
