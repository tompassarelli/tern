// Stream watchdog — the missing liveness signal (thread 019f4d54).
//
// THE BUG it kills: `for await (const message of q)` in spawn.ts/dispatch.ts awaits
// the SDK's async iterator with NO timeout. When the underlying turn STALLS without
// dying — context-window exhaustion mid-turn, an API 529/overload retried below the
// message layer, or a turn that simply never completes — the iterator neither yields
// nor throws. The error boundary (try/catch) only catches THROWS; a hang is not a
// throw, so finally/recordRun/notifyDeath never fire and the lane goes silent for
// hours, alive but terminal-invisible (specimens sdk-a63f2676, sdk-e30a4d6f: logs
// carry only "[spawn] starting").
//
// THE FIX: race each message against a stall timer. Liveness = ANY SDK message (a
// working lane emits assistant/tool_result/status messages steadily, so it never
// trips — BOUNDED: we never abort a lane that is producing output). Total message
// silence for N minutes -> onStall (surface, non-destructive). Silence for 2N ->
// onAbort (terminal). N is NORTH_STALL_MS (default 10min) so it is testable with a
// tiny override and tunable per workload.
//
// Known trade-off: a SINGLE tool call that runs >2N minutes emitting nothing (a very
// long silent build) would trip the abort — but such a call is pathological and the
// abort is visible + recoverable, not data loss. Default N=10min gives 20min of
// abort headroom, past which "silent" is indistinguishable from "hung".
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const MSG_CLI = `${REPO}/cli/msg-cli.clj`;
const northBin = () => process.env.NORTH_BIN ?? `${REPO}/bin/north`;
const port = () => process.env.NORTH_PORT ?? "7977";
const peerBb = () => process.env.NORTH_PEER_BB ?? "bb";

// Default stall window: 10 minutes. NORTH_STALL_MS overrides (ms) — the test seam.
export const DEFAULT_STALL_MS = 10 * 60_000;
export function stallMs(): number {
  const raw = Number(process.env.NORTH_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_MS;
}

export interface WatchdogHooks {
  stallMs: number;
  onStall: (mins: number) => void; // fires once when the stream first goes quiet N ms
  onAbort: () => void; // fires at 2N ms of silence; the generator then returns
}

// Wrap an async iterator, resetting a stall timer on every message. The timers are
// anchored to the moment we START awaiting the next message (i.e. just after the last
// one), so the abort deadline is a true 2N-from-last-message — not re-armed loosely
// across the stall->abort transition. A rejection from source.next() (the real SDK
// throwing exitError on a subprocess death) propagates OUT so the caller's existing
// error boundary still handles death; the watchdog only adds the SILENCE case.
export async function* withStallWatchdog<T>(
  source: AsyncIterator<T>,
  hooks: WatchdogHooks,
): AsyncGenerator<T> {
  const { stallMs, onStall, onAbort } = hooks;
  const mins = Math.max(1, Math.round(stallMs / 60_000));
  while (true) {
    const pending = source.next();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const stalledP = new Promise<"stall">((r) => { stallTimer = setTimeout(() => r("stall"), stallMs); });
    const abortedP = new Promise<"abort">((r) => { abortTimer = setTimeout(() => r("abort"), stallMs * 2); });
    try {
      const msgP = pending.then(() => "msg" as const);
      let tag = await Promise.race([msgP, stalledP, abortedP]);
      if (tag === "stall") {
        onStall(mins); // non-destructive: surface only, keep awaiting the same message
        tag = await Promise.race([msgP, abortedP]);
      }
      if (tag === "abort") {
        onAbort();
        return; // stop iterating; the caller interrupts the query + records outcome
      }
      const r = await pending; // resolved — cheap
      if (r.done) return;
      yield r.value;
    } finally {
      clearTimeout(stallTimer);
      clearTimeout(abortTimer);
    }
  }
}

export interface CoordCtx {
  coordinator?: string; // handle that gets the peer ping
}

type Cmd = { cmd: string; args: string[] };

// PURE: the command specs a stall emits — a durable `stalled` fact on @agent:<id>
// (queryable off the graph, like agent_death) + an "AGENT STALLED" peer ping. Pure so
// the contract is unit-testable without a live coordinator (mirrors death.ts).
export function stallCommands(
  agentId: string,
  mins: number,
  ctx: CoordCtx = {},
  ts: string = new Date().toISOString(),
): Cmd[] {
  const line = `${agentId} | no SDK output ${mins}min | ${ts}`;
  const cmds: Cmd[] = [
    { cmd: northBin(), args: ["tell", `agent:${agentId}`, "stalled", line] },
  ];
  if (ctx.coordinator) {
    cmds.push({ cmd: peerBb(), args: [MSG_CLI, port(), "send", agentId, ctx.coordinator, "AGENT STALLED", `${mins}min — no output (${ts})`] });
  }
  return cmds;
}

// PURE: the command specs a turn-cap emits — a durable `turn_capped` fact + a
// "TURN CAP" peer ping carrying a partial-result note, so a maxTurns stop is VISIBLE
// instead of masquerading as a clean completion.
export function turnCapCommands(
  agentId: string,
  note: string,
  ctx: CoordCtx = {},
  ts: string = new Date().toISOString(),
): Cmd[] {
  const cmds: Cmd[] = [
    { cmd: northBin(), args: ["tell", `agent:${agentId}`, "turn_capped", `${agentId} | ${ts}`] },
  ];
  if (ctx.coordinator) {
    cmds.push({ cmd: peerBb(), args: [MSG_CLI, port(), "send", agentId, ctx.coordinator, "TURN CAP", `${note} (${ts})`] });
  }
  return cmds;
}

// Execute a command spec list. Synchronous + fully swallowed: notifying must never
// throw out of a dying/stalling agent nor mask the original condition (like death.ts).
function emit(cmds: Cmd[]): void {
  for (const { cmd, args } of cmds) {
    try {
      execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "ignore", "ignore"] });
    } catch { /* best-effort: telemetry outcome still records the condition */ }
  }
}

export function notifyStall(agentId: string, mins: number, ctx: CoordCtx = {}): void {
  emit(stallCommands(agentId, mins, ctx));
  console.error(`[stall] @agent:${agentId} silent ${mins}min — no SDK output`);
}

export function notifyTurnCap(agentId: string, note: string, ctx: CoordCtx = {}): void {
  emit(turnCapCommands(agentId, note, ctx));
  console.error(`[turn-cap] @agent:${agentId} hit maxTurns — ${note}`);
}
