// Fable-window gate (routing-overhaul PART 3) — proves BOTH sides of the mechanical
// gate without touching the system clock: the arg form and the NORTH_FABLE_NOW env form.
// Also proves the gate reaches the escalation ladder: the Fable rung appears above
// opus/xhigh iff the window is open, and closes with zero code change.
import { test, expect, afterEach } from "bun:test";
import { fableWindowOpen, FABLE_WINDOW_END_ISO } from "../src/fable-window";
import { activeLadder, tierIndexOf, LADDER } from "../src/ladder";

const JUST_BEFORE = "2026-07-20T06:59:59.999Z";
const AT_CUTOFF = "2026-07-20T07:00:00.000Z";

afterEach(() => { delete process.env.NORTH_FABLE_NOW; });

test("exclusive cutoff is 2026-07-20T07:00Z after July 19 23:59:59 PDT", () => {
  expect(FABLE_WINDOW_END_ISO).toBe("2026-07-20T07:00:00Z");
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
  const open = activeLadder();
  expect(open.length).toBe(LADDER.length + 1);
  expect(open[open.length - 1]).toEqual({ model: "fable", effort: "high" });

  process.env.NORTH_FABLE_NOW = AT_CUTOFF;
  const closed = activeLadder();
  expect(closed.length).toBe(LADDER.length);
  expect(closed.some((r) => r.model === "fable")).toBe(false);
});

test("base ladder ends at opus/xhigh; fable sits strictly above it", () => {
  expect(LADDER[LADDER.length - 1]).toEqual({ model: "opus", effort: "xhigh" });
  process.env.NORTH_FABLE_NOW = JUST_BEFORE;
  expect(tierIndexOf("fable", "high")).toBe(LADDER.length); // reachable in-window
  process.env.NORTH_FABLE_NOW = AT_CUTOFF;
  // out-of-window an unknown rung falls back to the default start tier, never a fable tier
  expect(tierIndexOf("fable", "high")).not.toBe(LADDER.length);
});
