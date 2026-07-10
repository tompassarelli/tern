// Escalation ladder for escalate-not-kill (thread 019f1194-ca57). On struggle an
// agent climbs ONE rung — a smarter model and/or higher effort — IN-FLIGHT (no
// respawn, no context re-serialization), instead of being killed at a turn cap.
//
// Ceiling is opus/xhigh (raised from opus/high): applyFlagSettings accepts
// Settings.effortLevel up to "xhigh" (sdk.d.ts), so xhigh IS settable mid-run — only
// "max" effort needs the deferred Option-B interrupt+resume. The Fable rung sits ABOVE
// opus/xhigh and is present ONLY inside the owner-ordered window (fable-window.ts): a
// lane escalates to Fable exactly when opus/xhigh demonstrably spins. fable/high is
// also <= xhigh effort, so setModel + applyFlagSettings apply it cleanly in-flight.
import type { Effort } from "./harness";
import { resolveModel } from "./harness";
import { remaining, costOf } from "./budget";
import { fableWindowOpen } from "./fable-window";

const BASE_LADDER: Array<{ model: string; effort: Effort }> = [
  { model: "haiku", effort: "low" },     // 0 cheap baseline
  { model: "haiku", effort: "high" },    // 1 haiku ceiling
  { model: "sonnet", effort: "medium" }, // 2 default start / first model jump
  { model: "sonnet", effort: "high" },   // 3 workhorse
  { model: "sonnet", effort: "xhigh" },  // 4 sonnet ceiling
  { model: "opus", effort: "high" },     // 5 judgment
  { model: "opus", effort: "xhigh" },    // 6 opus ceiling (standing in-flight top)
];

const FABLE_RUNG: { model: string; effort: Effort } = { model: "fable", effort: "high" };

// The ladder in effect NOW: base ramp, plus the Fable rung while the window is open.
// Date-dependent, computed per call so the rung vanishes the instant the window closes —
// the mechanical half of the gate (fable-window.ts is the other).
export function activeLadder(): Array<{ model: string; effort: Effort }> {
  return fableWindowOpen() ? [...BASE_LADDER, FABLE_RUNG] : BASE_LADDER;
}

// Back-compat: the base ramp as a constant (for importers indexing a fixed tier).
export const LADDER = BASE_LADDER;

// Default starting rung when escalation is on but no model is pinned: sonnet/medium.
export const DEFAULT_START_TIER = 2;

export function tierIndexOf(model?: string, effort?: Effort): number {
  if (!model) return DEFAULT_START_TIER;
  const ladder = activeLadder();
  const i = ladder.findIndex((t) => t.model === model && (!effort || t.effort === effort));
  return i >= 0 ? i : DEFAULT_START_TIER;
}

// Rough min spend to run the next tier ~20 turns — reuses budget.ts pricing so the
// affordability gate is consistent with how spend is actually charged.
function estTierFloor(rung: { model: string }): number {
  return costOf(rung.model, { input_tokens: 30_000, output_tokens: 8_000 }) * 20;
}

export type EscDecision =
  | { kind: "escalate"; toTier: number }
  | { kind: "struggle_ceiling" }
  | { kind: "budget_exhausted" };

// Can we climb? Ceiling -> struggle_ceiling; can't afford the next tier -> budget_exhausted.
// Uses the ACTIVE ladder so the Fable rung is a real climb target while the window is open.
export async function decideEscalation(tier: number): Promise<EscDecision> {
  const ladder = activeLadder();
  if (tier >= ladder.length - 1) return { kind: "struggle_ceiling" };
  const next = tier + 1;
  if ((await remaining()) < estTierFloor(ladder[next])) return { kind: "budget_exhausted" };
  return { kind: "escalate", toTier: next };
}

// In-flight rung change (Option A): swap model + effort on the live query and nudge
// the agent. setModel applies to the NEXT turn ("subsequent responses"); the current
// turn finishes on the old tier. All v1 efforts are <= xhigh, so applyFlagSettings
// always succeeds — the "max" caveat only bites the deferred opus/max rung.
export async function escalateInFlight(
  q: any,
  ch: { push: (t: string) => void },
  rung: { model: string; effort: Effort },
  reason: string,
): Promise<void> {
  try { await q.setModel?.(resolveModel(rung.model)); } catch { /* SDK shape drift — guarded */ }
  try { await q.applyFlagSettings?.({ effortLevel: rung.effort }); } catch { /* same */ }
  ch.push(
    `[escalation] You appear stuck (${reason}). Upgraded to ${rung.model}/${rung.effort}. ` +
      `Step back, reconsider your approach from first principles, then proceed.`,
  );
}
