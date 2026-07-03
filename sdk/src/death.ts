// Death notification — the missing signal. When a worker's SDK subprocess dies
// (OOM SIGKILL / parent SIGTERM / idle Transport-closed), the async generator throws
// exitError to us. Before this module, that throw escaped the message loop and the
// coordinator learned of the death only by noticing silence. Here we turn a death into
// a first-class CLAIM (so it is queryable off the graph) plus a direct peer PING (so a
// listening coordinator wakes at once) — fitting tern's existing idioms:
//   - `tern tell @swarm agent_death "<line>"`   (@swarm is the coordinator-visible roster
//     node — already where budget_total lives), and the driven thread if known;
//   - `msg-cli send <agentId> <coordinator> "AGENT DEATH" "<reason>"` for the direct ping.
//
// A dying path has two hard rules: it must FLUSH before the process exits (so writes are
// SYNCHRONOUS — execFileSync, not fire-and-forget), and it must NEVER itself throw (every
// step is wrapped + swallowed). Best-effort by construction.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const TERN = `${REPO}/bin/tern`;
const MSG_CLI = `${REPO}/cli/msg-cli.clj`;
const PORT = process.env.TERN_PORT ?? "7977";

export interface DeathContext {
  thread?: string; // the driven thread (dispatch) — gets its own agent_death claim
  coordinator?: string; // spawning coordinator handle — gets a direct peer ping
}

// Normalize any thrown value to a short, single-line reason. The SDK's exitError messages
// ("Claude Code process exited with code N", "... terminated by signal X", "Transport is
// closed") are exactly what we want to surface, verbatim but bounded.
export function deathReason(err: unknown): string {
  const raw =
    (err as any)?.message ??
    (typeof err === "string" ? err : null) ??
    String(err ?? "unknown");
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown";
}

// PURE: build the exact command specs a death emits, so the notification path is testable
// without shelling out or touching the coordinator. Order: claims first (durable record),
// peer ping last (transient wake). @swarm always; thread + coordinator only when known.
export function deathCommands(
  agentId: string,
  reason: string,
  ctx: DeathContext = {},
  ts: string = new Date().toISOString(),
): Array<{ cmd: string; args: string[] }> {
  const line = `${agentId} | ${reason} | ${ts}`;
  const cmds: Array<{ cmd: string; args: string[] }> = [
    { cmd: TERN, args: ["tell", "@swarm", "agent_death", line] },
  ];
  if (ctx.thread) {
    cmds.push({ cmd: TERN, args: ["tell", ctx.thread, "agent_death", line] });
  }
  if (ctx.coordinator) {
    cmds.push({
      cmd: "bb",
      args: [MSG_CLI, PORT, "send", agentId, ctx.coordinator, "AGENT DEATH", `${reason} (${ts})`],
    });
  }
  return cmds;
}

// Emit the death notification. Synchronous + fully swallowed: a failure to notify must
// never mask the original death nor throw out of the dying agent's finally block.
export function notifyDeath(agentId: string, err: unknown, ctx: DeathContext = {}): void {
  const reason = deathReason(err);
  for (const { cmd, args } of deathCommands(agentId, reason, ctx)) {
    try {
      execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      /* best-effort: coordinator can still see the death via telemetry outcome="died" */
    }
  }
  console.error(`[death] @agent:${agentId} died: ${reason}`);
}
