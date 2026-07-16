// Fable window — the OWNER-ORDERED, time-gated exception (routing-overhaul PART 3).
// A TEMPORARY, MECHANICAL (not prose) gate: until the cutoff, orchestrator forks route
// model=fable and the escalation ladder gains a Fable rung above opus/xhigh. After the
// cutoff the gate closes with ZERO code change — the date comparison simply flips.
//
// Promotion ends 2026-07-19T23:59:59 PDT (UTC-7). Use the clean exclusive
// boundary 2026-07-20T07:00:00Z (= 2026-07-20 15:00 Asia/Taipei).
// Auto-expiring: no dial to un-set, no toggle to remember.
//
// Testable WITHOUT touching the system clock: pass `now`, or set NORTH_FABLE_NOW
// (ISO-8601) to override "now" — so a test proves BOTH sides of the gate. Precedence:
// explicit arg > NORTH_FABLE_NOW env > real clock.
export const FABLE_WINDOW_END_ISO = "2026-07-20T07:00:00Z";
const FABLE_WINDOW_END_MS = Date.parse(FABLE_WINDOW_END_ISO);

export function fableWindowOpen(now?: Date | string | number): boolean {
  const override = process.env.NORTH_FABLE_NOW;
  const t =
    now != null ? new Date(now).getTime()
    : override ? Date.parse(override)
    : Date.now();
  return Number.isFinite(t) && t < FABLE_WINDOW_END_MS;
}
