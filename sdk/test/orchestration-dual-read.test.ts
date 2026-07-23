import { afterEach, expect, test } from "bun:test";
import { staffingSource } from "../src/orchestration-graph-source";
import { loadGafferStaffing } from "../src/gaffer-staffing";

// Phase 1 dual-read seam (thread 019f8f5c). These assertions are hermetic: the
// FILE path is the default and reads the packaged Gaffer contract; the GRAPH
// path is exercised against an unreachable coordinator so its wiring is proven
// without depending on a live import. Byte-parity of the two live sources is
// proven separately by cli/tests/orchestration-parity-test.clj and
// src/orchestration-dual-read-probe.ts against a coordinator.

const priorSource = process.env.NORTH_STAFFING_SOURCE;
const priorPort = process.env.NORTH_PORT;

afterEach(() => {
  if (priorSource === undefined) delete process.env.NORTH_STAFFING_SOURCE;
  else process.env.NORTH_STAFFING_SOURCE = priorSource;
  if (priorPort === undefined) delete process.env.NORTH_PORT;
  else process.env.NORTH_PORT = priorPort;
});

test("staffing source defaults to file and never silently flips", () => {
  delete process.env.NORTH_STAFFING_SOURCE;
  expect(staffingSource()).toBe("file");
  process.env.NORTH_STAFFING_SOURCE = "";
  expect(staffingSource()).toBe("file");
  process.env.NORTH_STAFFING_SOURCE = "anything-else";
  expect(staffingSource()).toBe("file");
  process.env.NORTH_STAFFING_SOURCE = "graph";
  expect(staffingSource()).toBe("graph");
});

test("file source (default) loads the packaged stock catalog", () => {
  delete process.env.NORTH_STAFFING_SOURCE;
  const catalog = loadGafferStaffing();
  expect(catalog.sourceVersion).toBe(2);
  expect(catalog.presets.map((p) => p.name).sort()).toEqual([
    "analyst", "designer", "director", "executor", "implementer", "integrator",
    "judge", "research-scientist", "reviewer", "scout", "verifier",
  ]);
});

test("graph source routes through the projector (fails closed when unreachable)", () => {
  process.env.NORTH_STAFFING_SOURCE = "graph";
  process.env.NORTH_PORT = "1"; // unreachable coordinator
  expect(() => loadGafferStaffing()).toThrow(/NORTH_STAFFING_SOURCE=graph projection failed/);
});
