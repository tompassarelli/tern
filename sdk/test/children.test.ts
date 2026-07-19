// Pure tests for the early-exit-with-live-children contract (thread 019f4ed2,
// half b): committed lifecycle evidence and command specs, without a live
// coordinator. The impure graph query remains covered by the E2E probe.
import { test, expect, describe } from "bun:test";
import {
  assessChildFinalization,
  childReductionMessage,
  decideChildTurnEnd,
  earlyExitCommands,
  gatherChildSettlement,
  initialChildContinuationState,
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

  test("no children and all terminal children are explicit settled states", () => {
    expect(gatherChildSettlement(
      "director",
      () => [],
      () => false,
    )).toEqual({ kind: "settled", children: [] });
    expect(gatherChildSettlement(
      "director",
      () => ["@agent:one", "@agent:two"],
      () => true,
    )).toEqual({
      kind: "settled",
      children: ["@agent:one", "@agent:two"],
    });
  });

  test("live children and read failures can never collapse to the same state", () => {
    expect(gatherChildSettlement(
      "director",
      () => ["@agent:done", "@agent:live"],
      (child) => child.endsWith("done"),
    )).toEqual({
      kind: "live",
      children: ["@agent:done", "@agent:live"],
      live: ["@agent:live"],
    });
    expect(gatherChildSettlement(
      "director",
      () => { throw new Error("coordinator unavailable"); },
      () => false,
    )).toEqual({ kind: "unavailable", reason: "coordinator unavailable" });
    expect(gatherChildSettlement(
      "director",
      () => ["@agent:child"],
      () => { throw new Error("terminal read failed"); },
    )).toEqual({ kind: "unavailable", reason: "terminal read failed" });
    // A committed lane terminal short-circuits the secondary run read entirely.
    let runRead = false;
    expect(resolveChildLifecycle(markedLane, () => {
      runRead = true;
      throw new Error("run query unavailable");
    })).toBe(true);
    expect(runRead).toBe(false);
  });
});

describe("orchestrator child continuation state", () => {
  test("an already-settled child requires one post-settlement provider result", () => {
    const first = decideChildTurnEnd(initialChildContinuationState(), {
      kind: "settled", children: ["@agent:a"],
    }, 2);
    expect(first).toMatchObject({
      action: "continue",
      reason: "child_reduction_required",
      children: ["@agent:a"],
    });
    expect(assessChildFinalization(first.state, {
      kind: "settled", children: ["@agent:a"],
    })).toMatchObject({
      ok: false,
      outcome: "orchestrator_reduction_incomplete",
    });
    const acknowledged = decideChildTurnEnd(first.state, {
      kind: "settled", children: ["@agent:a"],
    }, 2);
    expect(acknowledged).toMatchObject({
      action: "finish",
      state: { acknowledgedSettledSignature: "@agent:a", noProgress: 0 },
    });
    expect(assessChildFinalization(acknowledged.state, {
      kind: "settled", children: ["@agent:a"],
    })).toEqual({ ok: true });
  });

  test("terminality after a live observation still forces a reduction turn", () => {
    const live = decideChildTurnEnd(initialChildContinuationState(), {
      kind: "live", children: ["@agent:a"], live: ["@agent:a"],
    }, 2);
    expect(live).toMatchObject({
      action: "continue", reason: "children_live", attempt: 1, cap: 2,
    });
    const newlySettled = decideChildTurnEnd(live.state, {
      kind: "settled", children: ["@agent:a"],
    }, 2);
    expect(newlySettled).toMatchObject({
      action: "continue", reason: "child_reduction_required",
    });
    const reduced = decideChildTurnEnd(newlySettled.state, {
      kind: "settled", children: ["@agent:a"],
    }, 2);
    expect(reduced).toMatchObject({ action: "finish" });
  });

  test("each changed settled child-set signature requires another reduction turn", () => {
    const onePending = decideChildTurnEnd(initialChildContinuationState(), {
      kind: "settled", children: ["@agent:a"],
    }, 2);
    const changed = decideChildTurnEnd(onePending.state, {
      kind: "settled", children: ["@agent:b", "@agent:a"],
    }, 2);
    expect(changed).toMatchObject({
      action: "continue",
      reason: "child_reduction_required",
      children: ["@agent:b", "@agent:a"],
      state: {
        acknowledgedSettledSignature: "@agent:a",
        pendingSettledSignature: "@agent:a\u0000@agent:b",
      },
    });
    expect(assessChildFinalization(changed.state, {
      kind: "settled", children: ["@agent:a", "@agent:b"],
    })).toMatchObject({
      ok: false,
      outcome: "orchestrator_reduction_incomplete",
    });
    const reduced = decideChildTurnEnd(changed.state, {
      kind: "settled", children: ["@agent:a", "@agent:b"],
    }, 2);
    expect(reduced).toMatchObject({ action: "finish" });
    expect(assessChildFinalization(reduced.state, {
      kind: "settled", children: ["@agent:a", "@agent:b"],
    })).toEqual({ ok: true });
  });

  test("state advance resets consecutive no-progress while an unchanged set hits the cap", () => {
    const one = decideChildTurnEnd(initialChildContinuationState(), {
      kind: "live", children: ["a", "b"], live: ["a", "b"],
    }, 2);
    const two = decideChildTurnEnd(one.state, {
      kind: "live", children: ["a", "b"], live: ["a", "b"],
    }, 2);
    expect(two).toMatchObject({ action: "continue", attempt: 2 });
    const advanced = decideChildTurnEnd(two.state, {
      kind: "live", children: ["b"], live: ["b"],
    }, 2);
    expect(advanced).toMatchObject({ action: "continue", attempt: 1 });
    const unchanged = decideChildTurnEnd(advanced.state, {
      kind: "live", children: ["b"], live: ["b"],
    }, 2);
    const capped = decideChildTurnEnd(unchanged.state, {
      kind: "live", children: ["b"], live: ["b"],
    }, 2);
    expect(capped).toMatchObject({
      action: "block",
      reason: "children_live_at_continuation_cap",
      live: ["b"],
    });
  });

  test("an unavailable settlement read blocks immediately", () => {
    expect(decideChildTurnEnd(initialChildContinuationState(), {
      kind: "unavailable", reason: "graph offline",
    }, 5)).toMatchObject({
      action: "block",
      reason: "child_reconciliation_unavailable",
    });
  });

  test("the final gate rejects live, unavailable, and unacknowledged settled sets", () => {
    const initial = initialChildContinuationState();
    expect(assessChildFinalization(initial, {
      kind: "live", children: ["a"], live: ["a"],
    })).toEqual({
      ok: false,
      outcome: "orchestrator_children_incomplete",
      live: ["a"],
    });
    expect(assessChildFinalization(initial, {
      kind: "unavailable", reason: "graph offline",
    })).toEqual({
      ok: false,
      outcome: "child_reconciliation_unavailable",
      reason: "graph offline",
    });
    expect(assessChildFinalization(initial, {
      kind: "settled", children: ["a"],
    })).toEqual({
      ok: false,
      outcome: "orchestrator_reduction_incomplete",
      children: ["a"],
    });
  });

  test("the reduction continuation explicitly reaches the provider", () => {
    expect(childReductionMessage(["@agent:a"])).toContain(
      "post-settlement reduction turn",
    );
    expect(childReductionMessage(["@agent:a"])).toContain(
      "Consume their completion pings/reports",
    );
    expect(childReductionMessage(["@agent:a"])).toContain(
      "changed settled child set requires another reduction turn",
    );
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
