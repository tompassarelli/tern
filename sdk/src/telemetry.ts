// Telemetry auto-capture — write each agent run's tuple as facts so the system
// has a queryable feedback loop (calibrate estimates against actuals, see who ran
// what at what cost). Records to a dedicated `run-<agent>-<ts>` subject that has
// NO title, so runs never show up as threads on the board — they're queryable via
// fram, invisible to the work views. Fire-and-forget: telemetry must NEVER block
// or fail an agent run, so writes are async and all errors are swallowed.
import { execFile } from "node:child_process";

export interface RunRecord {
  thread: string; // the thread driven, or "(ad-hoc)" for a bare spawn
  agent: string; // agent id / handle
  tokens: number; // total tokens this run (from tokensOf)
  durationMs: number; // SDK result duration_ms
  posture: string; // unplanned | atomic | composite | spawn
  // Routing dials — the EFFECTIVE final dial the run finished at (escalation-aware:
  // spawn passes rung() after any ladder climb, so this is the tier that actually did
  // the work, not necessarily the spawn tier on @agent:<id>). Denormalized onto @run so
  // dial analytics need no @run.agent -> @agent:<id> join, and so escalation cases
  // (started opus/high, finished opus/xhigh) report the tier that carried the outcome.
  model?: string; // opus | sonnet | haiku
  effort?: string; // low | medium | high | xhigh | max
  role?: string; // executor | implementer | integrator | designer | researcher | ...
  provider?: string; // anthropic | openai
  providerReason?: string; // explainable auto/explicit routing decision
  outcome: string; // "ran" | "error" | "budget_exceeded" | "budget_exhausted" | "struggle_ceiling"
  // escalate-not-kill (thread 019f1194-ca57) — present only on escalation-enabled runs.
  // Option A yields ONE @run row per spawn with an internal escalation chain, NOT one
  // row per tier (north-reconcile.clj queries adapt in lockstep — follow-up).
  costUsd?: number; // authoritative SDK total_cost_usd (falls back to the in-loop estimate)
  numTurns?: number; // SDKResultMessage.num_turns (was dropped before)
  errorCount?: number; // tool_result errors this run
  escalationTier?: number; // final ladder tier (omit / <0 = escalation off)
  escalations?: Array<{ from: string; to: string; reason: string; atCost: number }>;
}

export function recordRun(rec: RunRecord): void {
  // base36 ms suffix keeps the id unique per agent without a clock dependency the
  // board cares about; this is runtime code, not a workflow script, so Date is fine.
  const id = `run-${rec.agent}-${Date.now().toString(36)}`;
  const facts: Array<[string, string]> = [
    ["kind", "run"],
    ["thread", rec.thread],
    ["agent", rec.agent],
    ["tokens", String(Math.round(rec.tokens))],
    ["duration_ms", String(Math.round(rec.durationMs))],
    ["posture", rec.posture],
    ["outcome", rec.outcome],
    ["at", new Date().toISOString()],
  ];
  if (rec.model) facts.push(["model", rec.model]);
  if (rec.effort) facts.push(["effort", rec.effort]);
  if (rec.role) facts.push(["role", rec.role]);
  if (rec.provider) facts.push(["provider", rec.provider]);
  if (rec.providerReason) facts.push(["provider_reason", rec.providerReason]);
  if (rec.costUsd != null) facts.push(["cost_usd", rec.costUsd.toFixed(4)]);
  if (rec.numTurns != null) facts.push(["num_turns", String(rec.numTurns)]);
  if (rec.errorCount != null) facts.push(["error_count", String(rec.errorCount)]);
  if (rec.escalationTier != null && rec.escalationTier >= 0)
    facts.push(["escalation_tier", String(rec.escalationTier)]);
  if (rec.escalations && rec.escalations.length) {
    facts.push(["escalation_count", String(rec.escalations.length)]);
    facts.push(["escalation_path", rec.escalations.map((e) => `${e.from}>${e.to}`).join(" ")]);
    facts.push(["escalation_reasons", rec.escalations.map((e) => e.reason).join(",")]);
  }
  for (const [p, v] of facts) {
    // async + ignored: never let telemetry add latency to, or break, the run.
    try {
      execFile(process.env.NORTH_BIN ?? "north", ["tell", id, p, v], () => {});
    } catch {
      /* swallow */
    }
  }
}
