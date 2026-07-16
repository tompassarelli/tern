// Agent identity facts — ids stay meaningless + immutable; everything meaningful
// is a FACT on @agent:<id> in the coordination log (design: thread 019f40f8).
// Predicates (single-valued, declared via the schema-write gate): kind role model
// vendor effort goal spawned_at display_name; repo stays multi (threads span repos).
// Writes shell to the installed `north tell` (the proven serialized OCC path) and
// are NON-FATAL: a facts failure must never kill a spawn.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// NORTH_BIN override mirrors death.ts/clock.ts/children.ts/watchdog.ts, so the whole
// coordinator-writing surface resolves the SAME engine — and a hermetic test that points
// NORTH_BIN at a fake redirects identity writes too. A bare `north` on PATH ignored that
// seam, so identity tells escaped the fake, hit the real CLI (~3.7s/call against a dead
// port) and wrote test agents into the production graph.
const REPO = resolve(import.meta.dir, "..", "..");
const northBin = () => process.env.NORTH_BIN ?? `${REPO}/bin/north`;

export interface AgentIdentity {
  kind: "lane" | "session" | "cron";
  role?: string;
  model?: string; // tier name as spawned (opus|sonnet|haiku); SDK resolves the full id
  vendor?: string;
  effort?: string;
  repo?: string;
  goal?: string;
  // spawning coordinator handle. Persisted (not just held at ping time) so it survives
  // the spawning session: the reactor's died-unreported sweep reads it to ping on a
  // silent hard-kill (sweep-lanes! in north-reactor.clj), and `north health` folds it to
  // compute ping-loss (lanes that carried a coordinator but landed no COMPLETE/DEATH).
  coordinator?: string;
}

const shortModel = (m?: string) => (m ?? "?").replace(/^claude-/, "");

export function renderDisplayName(id: string, f: AgentIdentity): string {
  const role = f.role ?? f.kind;
  const at = f.repo ? `@${f.repo}` : "";
  const dial = `${shortModel(f.model)}-${f.effort ?? "?"}`;
  const goal = f.goal ? ` — ${f.goal.length > 40 ? f.goal.slice(0, 37) + "…" : f.goal}` : "";
  return `${role}${at} ${dial}${goal} (${id})`;
}

function tell(subject: string, pred: string, value: string) {
  execFileSync(northBin(), ["tell", subject, pred, value], { stdio: "ignore", timeout: 10_000 });
}

export function writeAgentFacts(agentId: string, f: AgentIdentity): void {
  const subject = `agent:${agentId}`; // north tell @-prefixes bare ids
  const facts: Array<[string, string | undefined]> = [
    ["kind", f.kind],
    ["role", f.role],
    ["model", f.model],
    ["vendor", f.vendor ?? (f.model ? "anthropic" : undefined)],
    ["effort", f.effort],
    ["repo", f.repo],
    ["goal", f.goal],
    ["coordinator", f.coordinator],
    ["spawned_at", new Date().toISOString()],
    ["display_name", renderDisplayName(agentId, f)],
  ];
  for (const [p, v] of facts) {
    if (!v) continue;
    try {
      tell(subject, p, v);
    } catch {
      // non-fatal by design; presence falls back to the bare id
    }
  }
}

// Terminal-outcome fact on the agent entity ITSELF (@agent:<id>). The reactor's
// died-unreported sweep (cli/reap.clj reap-lane?) reaps a lane whose @agent outcome is
// EMPTY and whose presence lapsed >30min. A lane that reaches its finalize KNOWS its
// outcome, so writing it here is the exact line between a REPORTED terminal (any outcome —
// ran/died/stalled/capped) and a SILENT hard-kill (finally never ran → no outcome anywhere
// → correctly reaped). recordRun's @run write is async fire-and-forget and races process
// exit, so it cannot carry liveness; this write is SYNCHRONOUS (execFileSync) + NORTH_BIN-
// honoring like writeAgentFacts, so it lands before the process exits. Non-fatal by
// design: a failed outcome write must never break the finalize (a lane with no outcome is
// still correctly reaped — fail-safe).
export function writeAgentOutcome(agentId: string, outcome: string): void {
  if (!outcome) return;
  try {
    tell(`agent:${agentId}`, "outcome", outcome); // north tell @-prefixes the bare id -> @agent:<id>
  } catch {
    // non-fatal; presence-lapse reap still catches a truly silent death
  }
}

// First sentence (or first 100 chars) of a spawn prompt — the goal fact seed.
export function goalFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0] ?? "";
  const sentence = firstLine.split(/(?<=[.!?])\s/, 1)[0] ?? firstLine;
  return sentence.length > 100 ? sentence.slice(0, 97) + "…" : sentence;
}
