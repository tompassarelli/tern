// Pure tests for the early-exit-with-live-children contract (thread 019f4ed2,
// half b): committed lifecycle evidence and command specs, without a live
// coordinator. The impure graph query remains covered by the E2E probe.
import { test, expect, describe } from "bun:test";
import {
  earlyExitCommands,
  gatherLiveChildren,
  resolveChildLifecycle,
} from "../src/children";
import {
  laneResolvedByFacts,
  terminalManifestSha256,
  type TerminalFact,
} from "../src/terminal-projection";

const modernLane: TerminalFact[] = [
  { predicate: "outcome", value: "ran" },
  { predicate: "process_outcome", value: "ran" },
  { predicate: "delivery_outcome", value: "unverified" },
  {
    predicate: "delivery_reason",
    value: "provider_terminal_success_without_external_verification",
  },
];
const markedLane: TerminalFact[] = [
  ...modernLane,
  {
    predicate: "terminal_manifest_sha256",
    value: terminalManifestSha256(modernLane)!,
  },
];
const partialRun: TerminalFact[] = [
  { predicate: "agent", value: "child" },
  { predicate: "outcome", value: "ran" },
  { predicate: "process_outcome", value: "ran" },
];
const committedRun: TerminalFact[] = [
  ...partialRun,
  { predicate: "kind", value: "run" },
];

describe("committed child lifecycle evidence", () => {
  test("terminal digest uses the cross-runtime canonical encoding", () => {
    expect(terminalManifestSha256(modernLane)).toBe(
      "9514cd8eaf6900c116c6c2ae68e7918f423e45bb187b97ae067ddf729f2d55cd",
    );
  });

  test("a partial modern lane is unresolved until its exact digest marker lands", () => {
    expect(laneResolvedByFacts(modernLane, [])).toBe(false);
    expect(laneResolvedByFacts(markedLane, [])).toBe(true);
    expect(laneResolvedByFacts(
      markedLane.map((fact) => fact.predicate === "terminal_manifest_sha256"
        ? { ...fact, value: "corrupt" }
        : fact),
      [],
    )).toBe(false);
  });

  test("a tagged run is unresolved until kind=run lands last", () => {
    expect(laneResolvedByFacts([], [partialRun])).toBe(false);
    expect(laneResolvedByFacts([], [committedRun])).toBe(true);
  });

  test("a graph read failure fails open without orphan claims", () => {
    expect(gatherLiveChildren(
      "director",
      () => { throw new Error("coordinator unavailable"); },
      () => false,
    )).toEqual([]);
    expect(gatherLiveChildren(
      "director",
      () => ["@agent:child"],
      () => { throw new Error("terminal read failed"); },
    )).toEqual([]);
    // A committed lane terminal short-circuits the secondary run read entirely.
    let runRead = false;
    expect(resolveChildLifecycle(markedLane, () => {
      runRead = true;
      throw new Error("run query unavailable");
    })).toBe(true);
    expect(runRead).toBe(false);
  });
});

describe("earlyExitCommands", () => {
  const TS = "2026-07-11T00:00:00.000Z";

  test("bare: one early_exit_children fact on @agent:<id> naming the orphans", () => {
    const cmds = earlyExitCommands("W1", ["c1", "c2"], {}, TS);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].args).toEqual([
      "tell", "agent:W1", "early_exit_children", "W1 | orphaned: c1,c2 | " + TS,
    ]);
  });

  test("with coordinator: adds a loud EARLY EXIT WITH LIVE CHILDREN peer ping", () => {
    const cmds = earlyExitCommands("W1", ["c1", "c2"], { coordinator: "coord" }, TS);
    expect(cmds).toHaveLength(2);
    expect(cmds[1].cmd).toBe("bb");
    expect(cmds[1].args).toContain("send");
    expect(cmds[1].args).toContain("W1"); // from
    expect(cmds[1].args).toContain("coord"); // to
    expect(cmds[1].args).toContain("EARLY EXIT WITH LIVE CHILDREN");
    expect(cmds[1].args[cmds[1].args.length - 1]).toContain("c1,c2");
    expect(cmds[1].args[cmds[1].args.length - 1]).toContain("2 live child");
  });
});
