// Fable-window gate (routing-overhaul PART 3) — proves BOTH sides of the mechanical
// gate without touching the system clock: the arg form and the NORTH_FABLE_NOW env form.
// Also proves the gate reaches the escalation ladder: the Fable rung appears above
// opus/xhigh iff the window is open, and closes with zero code change.
import { test, expect, afterEach } from "bun:test";
import { fableWindowOpen, FABLE_WINDOW_END_ISO } from "../src/fable-window";
import { activeLadder, decideEscalation, tierIndexOf, LADDER } from "../src/ladder";

const JUST_BEFORE = "2026-07-20T03:59:59.999Z";
const AT_CUTOFF = "2026-07-20T04:00:00.000Z";

afterEach(() => { delete process.env.NORTH_FABLE_NOW; });

test("exclusive cutoff is midnight after Sunday July 19 in US Eastern time", () => {
  expect(FABLE_WINDOW_END_ISO).toBe("2026-07-20T04:00:00Z");
});

test("fableWindowOpen(arg): open one millisecond before, closed exactly at cutoff", () => {
  expect(fableWindowOpen(JUST_BEFORE)).toBe(true);
  expect(fableWindowOpen(AT_CUTOFF)).toBe(false); // boundary is exclusive
});

test("NORTH_FABLE_NOW env overrides the clock (both sides)", () => {
  process.env.NORTH_FABLE_NOW = JUST_BEFORE;
  expect(fableWindowOpen()).toBe(true);
  process.env.NORTH_FABLE_NOW = AT_CUTOFF;
  expect(fableWindowOpen()).toBe(false);
});

test("activeLadder() appends the fable rung ONLY inside the window", () => {
  process.env.NORTH_FABLE_NOW = JUST_BEFORE;
  const open = activeLadder("anthropic");
  expect(open.length).toBe(LADDER.length + 1);
  expect(open.slice(-1)).toEqual([
    { provider: "anthropic", tier: "frontier", model: "claude-fable-5", effort: "xhigh" },
  ]);

  process.env.NORTH_FABLE_NOW = AT_CUTOFF;
  const closed = activeLadder("anthropic");
  expect(closed.length).toBe(LADDER.length);
  expect(closed.some((r) => r.model === "claude-fable-5")).toBe(false);
});

test("base ladder ends at frontier opus/xhigh; fable sits strictly above it", () => {
  expect(LADDER[LADDER.length - 1]).toEqual({
    provider: "anthropic", tier: "frontier", model: "claude-opus-4-8", effort: "xhigh",
  });
  process.env.NORTH_FABLE_NOW = JUST_BEFORE;
  expect(tierIndexOf("anthropic", "fable", "xhigh")).toBe(LADDER.length);
  expect(decideEscalation(LADDER.length - 1, activeLadder("anthropic")))
    .toEqual({ kind: "escalate", toTier: LADDER.length });
  process.env.NORTH_FABLE_NOW = AT_CUTOFF;
  // Out of window an unavailable model is treated as a ceiling, never silently
  // downgraded to a cheaper default rung.
  expect(tierIndexOf("anthropic", "fable", "xhigh")).toBe(LADDER.length - 1);
});
