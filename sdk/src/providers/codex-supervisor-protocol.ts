export const CODEX_SUPERVISOR_STATUS_PREFIX = "NORTH_CODEX_SUPERVISOR 1 " as const;

export type CodexSupervisorStatus =
  | "STARTED"
  | "UNAVAILABLE"
  | `EXIT ${number}`;

export function codexSupervisorStatusLine(status: CodexSupervisorStatus): string {
  return `${CODEX_SUPERVISOR_STATUS_PREFIX}${status}`;
}
