// Struggle detection for escalate-not-kill (thread 019f1194-ca57). Scores a LIVE
// run off its SDK message stream so a stuck agent can be ESCALATED to a smarter
// tier instead of guillotined at a turn cap. Three signals, all derived inside the
// spawn for-await loop (no extra I/O): an error STREAK, a tool LOOP, a no-PROGRESS
// stall. Thresholds are env-tunable (initial values are estimates — calibrate off
// @run telemetry once escalation has run in anger).
const ERROR_STREAK = Number(process.env.STRUGGLE_ERROR_STREAK) || 3;
const LOOP_REPEAT = Number(process.env.STRUGGLE_LOOP_REPEAT) || 3;
const LOOP_WINDOW = Number(process.env.STRUGGLE_LOOP_WINDOW) || 20;
const STALL_TURNS = Number(process.env.STRUGGLE_STALL_TURNS) || 6;

// Tools whose SUCCESSFUL result counts as forward progress (work recorded / files
// changed). A run that keeps producing these isn't stuck, however many turns it takes.
const PROGRESS_TOOLS = new Set([
  "Edit", "Write", "NotebookEdit",
  "mcp__north__capture", "mcp__north__tell",
]);

export type StruggleTrigger = "consecutive_errors" | "tool_loop" | "no_progress";

export interface StruggleState {
  turn: number; // assistant-turn counter
  consecutiveErrors: number;
  totalErrors: number; // cumulative, for telemetry
  lastProgressTurn: number;
  fingerprints: string[]; // ring of recent tool-call fingerprints (<= LOOP_WINDOW)
  pending: Map<string, string>; // tool_use_id -> tool name, to classify the matching result
}

export function makeStruggleState(): StruggleState {
  return { turn: 0, consecutiveErrors: 0, totalErrors: 0, lastProgressTurn: 0, fingerprints: [], pending: new Map() };
}

function fingerprint(name: string, input: unknown): string {
  let s = "";
  try { s = JSON.stringify(input) ?? ""; } catch { s = String(input); }
  return name + ":" + s.slice(0, 200);
}

// Fold one SDK message into the struggle state.
export function updateStruggle(msg: any, st: StruggleState): void {
  if (msg?.type === "assistant") {
    st.turn++;
    for (const b of msg.message?.content ?? []) {
      if (b?.type === "tool_use") {
        st.pending.set(b.id, b.name);
        st.fingerprints.push(fingerprint(b.name, b.input));
        if (st.fingerprints.length > LOOP_WINDOW) st.fingerprints.shift();
      }
    }
  } else if (msg?.type === "user") {
    for (const b of msg.message?.content ?? []) {
      if (b?.type === "tool_result") {
        const name = st.pending.get(b.tool_use_id) ?? "";
        st.pending.delete(b.tool_use_id);
        if (b.is_error) {
          st.consecutiveErrors++;
          st.totalErrors++;
        } else {
          st.consecutiveErrors = 0;
          if (PROGRESS_TOOLS.has(name)) st.lastProgressTurn = st.turn;
        }
      }
    }
  }
}

// The struggle verdict, or null if the run looks healthy.
export function checkStruggle(st: StruggleState): StruggleTrigger | null {
  if (st.consecutiveErrors >= ERROR_STREAK) return "consecutive_errors";
  const counts = new Map<string, number>();
  for (const f of st.fingerprints) {
    const n = (counts.get(f) ?? 0) + 1;
    counts.set(f, n);
    if (n >= LOOP_REPEAT) return "tool_loop";
  }
  if (st.turn - st.lastProgressTurn >= STALL_TURNS) return "no_progress";
  return null;
}

// After an escalation: clear the transient signals so the smarter tier starts fresh
// (else it would re-trigger immediately on the same accumulated evidence).
export function resetStruggle(st: StruggleState): void {
  st.consecutiveErrors = 0;
  st.fingerprints = [];
  st.lastProgressTurn = st.turn;
}
