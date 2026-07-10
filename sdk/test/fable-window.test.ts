// Fable-window gate (routing-overhaul PART 3) — proves BOTH sides of the mechanical
// gate without touching the system clock: the arg form and the NORTH_FABLE_NOW env form.
// Also proves the gate reaches the escalation ladder: the Fable rung appears above
// opus/xhigh iff the window is open, and closes with zero code change.
import { test, expect, afterEach } from "bun:test";
import { fableWindowOpen, FABLE_WINDOW_END_ISO } from "../src/fable-window";
import { activeLadder, tierIndexOf, LADDER } from "../src/ladder";

const IN_WINDOW = "2026-07-11T12:00:00Z";   // before cutoff (2026-07-12T16:00:00Z)
const AFTER_WINDOW = "2026-07-13T00:00:01Z"; // after cutoff

afterEach(() => { delete process.env.NORTH_FABLE_NOW; });

test("cutoff is 2026-07-12T16:00Z == 2026-07-13 00:00 Asia/Shanghai", () => {
  expect(FABLE_WINDOW_END_ISO).toBe("2026-07-12T16:00:00Z");
});

test("fableWindowOpen(arg): open before cutoff, closed at/after", () => {
  expect(fableWindowOpen(IN_WINDOW)).toBe(true);
  expect(fableWindowOpen(AFTER_WINDOW)).toBe(false);
  expect(fableWindowOpen(FABLE_WINDOW_END_ISO)).toBe(false); // boundary is exclusive
});

test("NORTH_FABLE_NOW env overrides the clock (both sides)", () => {
  process.env.NORTH_FABLE_NOW = IN_WINDOW;
  expect(fableWindowOpen()).toBe(true);
  process.env.NORTH_FABLE_NOW = AFTER_WINDOW;
  expect(fableWindowOpen()).toBe(false);
});

test("activeLadder() appends the fable rung ONLY inside the window", () => {
  process.env.NORTH_FABLE_NOW = IN_WINDOW;
  const open = activeLadder();
  expect(open.length).toBe(LADDER.length + 1);
  expect(open[open.length - 1]).toEqual({ model: "fable", effort: "high" });

  process.env.NORTH_FABLE_NOW = AFTER_WINDOW;
  const closed = activeLadder();
  expect(closed.length).toBe(LADDER.length);
  expect(closed.some((r) => r.model === "fable")).toBe(false);
});

test("base ladder ends at opus/xhigh; fable sits strictly above it", () => {
  expect(LADDER[LADDER.length - 1]).toEqual({ model: "opus", effort: "xhigh" });
  process.env.NORTH_FABLE_NOW = IN_WINDOW;
  expect(tierIndexOf("fable", "high")).toBe(LADDER.length); // reachable in-window
  process.env.NORTH_FABLE_NOW = AFTER_WINDOW;
  // out-of-window an unknown rung falls back to the default start tier, never a fable tier
  expect(tierIndexOf("fable", "high")).not.toBe(LADDER.length);
});
