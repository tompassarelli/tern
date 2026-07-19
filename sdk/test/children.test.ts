// Pure tests for the early-exit-with-live-children contract (thread 019f4ed2,
// half b): committed lifecycle evidence and command specs, without a live
// coordinator. The impure graph query remains covered by the E2E probe.
import { test, expect, describe } from "bun:test";
import {
  assessChildFinalization,
  CHILD_SETTLEMENT_MAX_CHILDREN,
  CHILD_SETTLEMENT_MAX_RUNS,
  childReductionMessage,
  decideChildTurnEnd,
  earlyExitCommands,
  gatherChildSettlement,
  initialChildContinuationState,
  resolveChildLifecycle,
  settleChildrenBounded,
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

type CommandCall = {
  command: string;
  args: string[];
  options: { timeoutMs: number; maxBuffer: number };
};

const factRows = (
  subject: string,
  facts: readonly TerminalFact[],
): Array<{ subject: string; predicate: string; value: string }> =>
  facts.map((fact) => ({ subject, predicate: fact.predicate, value: fact.value }));

const childEnvelope = (
  children: Array<{ subject: string; predicate: string; value: string }> = [],
  runs: Array<{ subject: string; predicate: string; value: string }> = [],
  overrides: Record<string, unknown> = {},
): string => JSON.stringify({
  protocol: "north.child-settlement",
  version: 1,
  coordinator: "director",
  children,
  runs,
  ...overrides,
});

function boundedSettlement(
  responses: Array<string | Uint8Array | Error>,
  options: { now?: () => number; deadlineMs?: number } = {},
): { settlement: ReturnType<typeof settleChildrenBounded>; calls: CommandCall[] } {
  const calls: CommandCall[] = [];
  const settlement = settleChildrenBounded("director", {
    run: (command, args, commandOptions) => {
      calls.push({ command, args, options: commandOptions });
      const response = responses[calls.length - 1];
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error("unexpected child settlement command");
      return response;
    },
    ...options,
  });
  return { settlement, calls };
}

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

describe("bounded atomic child settlement", () => {
  test("classifies lane and run terminals from exactly one snapshot subprocess", () => {
    const laneTerminal = boundedSettlement([
      childEnvelope([
        { subject: "agent:lane-child", predicate: "coordinator", value: "director" },
        ...factRows("agent:lane-child", markedLane),
      ]),
    ]);
    expect(laneTerminal.settlement).toEqual({
      kind: "settled",
      children: ["@agent:lane-child"],
    });
    expect(laneTerminal.calls).toHaveLength(1);
    expect(laneTerminal.calls[0]!.args).toEqual([
      "json", "child-settlement", "director",
    ]);

    const runTerminal = boundedSettlement([
      childEnvelope([
        { subject: "agent:run-child", predicate: "coordinator", value: "director" },
      ], [
        { subject: "run-terminal", predicate: "agent", value: "run-child" },
        ...factRows("run-terminal", committedRun.filter((fact) => fact.predicate !== "agent")),
      ]),
    ]);
    expect(runTerminal.settlement).toEqual({
      kind: "settled",
      children: ["@agent:run-child"],
    });
    expect(runTerminal.calls).toHaveLength(1);
  });

  test("a maximum-cardinality live set remains one subprocess with no fallback", () => {
    const subjects = Array.from(
      { length: CHILD_SETTLEMENT_MAX_CHILDREN },
      (_, index) => `agent:child-${index}`,
    );
    const childFacts = subjects.map((subject) => ({
      subject,
      predicate: "coordinator",
      value: "director",
    }));
    const { settlement, calls } = boundedSettlement([
      childEnvelope(childFacts),
    ]);
    expect(settlement.kind).toBe("live");
    if (settlement.kind !== "live") throw new Error("expected live settlement");
    expect(settlement.live).toHaveLength(CHILD_SETTLEMENT_MAX_CHILDREN);
    expect(calls).toHaveLength(1);
  });

  test("child and run cardinality overflow fail before any per-subject fallback", () => {
    const children = Array.from(
      { length: CHILD_SETTLEMENT_MAX_CHILDREN + 1 },
      (_, index) => ({
        subject: `agent:child-${index}`,
        predicate: "coordinator",
        value: "director",
      }),
    );
    const childOverflow = boundedSettlement([childEnvelope(children)]);
    expect(childOverflow.settlement).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("subject bound"),
    });
    expect(childOverflow.calls).toHaveLength(1);

    const runs = Array.from(
      { length: CHILD_SETTLEMENT_MAX_RUNS + 1 },
      (_, index) => [
        { subject: `run-${index}`, predicate: "agent", value: "child" },
        { subject: `run-${index}`, predicate: "kind", value: "run" },
      ],
    ).flat();
    const runOverflow = boundedSettlement([
      childEnvelope([
        { subject: "agent:child", predicate: "coordinator", value: "director" },
      ], runs),
    ]);
    expect(runOverflow.settlement).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("subject bound"),
    });
    expect(runOverflow.calls).toHaveLength(1);
  });

  test("one wall-clock deadline bounds the sole subprocess and its validation", () => {
    const samples = [0, 0, 60];
    const { settlement, calls } = boundedSettlement([
      childEnvelope([
        { subject: "agent:child", predicate: "coordinator", value: "director" },
      ]),
    ], {
      deadlineMs: 50,
      now: () => samples.shift() ?? 60,
    });
    expect(settlement).toEqual({
      kind: "unavailable",
      reason: "child settlement aggregate deadline exceeded",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.timeoutMs).toBe(50);

    const expired = boundedSettlement([childEnvelope()], {
      deadlineMs: 50,
      now: (() => {
        const values = [0, 51];
        return () => values.shift() ?? 51;
      })(),
    });
    expect(expired.settlement).toMatchObject({
      kind: "unavailable",
      reason: "child settlement aggregate deadline exceeded",
    });
    expect(expired.calls).toHaveLength(0);
  });

  test("malformed, partial, oversized, duplicate-key, and invalid UTF-8 envelopes fail closed", () => {
    for (const output of [
      "{\"not\":\"an envelope\"}\n",
      "{\"protocol\":\"north.child-settlement\"",
      '{"protocol":"north.child-settlement","protocol":"other","version":1,"coordinator":"director","children":[],"runs":[]}',
    ]) {
      const attempt = boundedSettlement([output]);
      expect(attempt.settlement.kind).toBe("unavailable");
      expect(attempt.calls).toHaveLength(1);
    }

    const oversized = boundedSettlement([
      "x".repeat(2 * 1024 * 1024 + 1),
    ]);
    expect(oversized.settlement).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("output bound"),
    });
    expect(oversized.calls).toHaveLength(1);

    const invalidUtf8 = boundedSettlement([new Uint8Array([0xff])]);
    expect(invalidUtf8.settlement).toEqual({
      kind: "unavailable",
      reason: "child settlement projection returned invalid UTF-8",
    });
    expect(invalidUtf8.calls).toHaveLength(1);
  });

  test("the versioned envelope is closed and coordinator-bound", () => {
    for (const overrides of [
      { protocol: "north.child-settlement.v2" },
      { version: 2 },
      { coordinator: "other" },
      { unknown: true },
    ]) {
      const attempt = boundedSettlement([childEnvelope([], [], overrides)]);
      expect(attempt.settlement.kind).toBe("unavailable");
      expect(attempt.calls).toHaveLength(1);
    }
  });

  test("noncanonical and unknown identities fail closed", () => {
    for (const children of [
      [{ subject: "@agent:child", predicate: "coordinator", value: "director" }],
      [{ subject: "thread:child", predicate: "coordinator", value: "director" }],
      [{ subject: "agent:", predicate: "coordinator", value: "director" }],
    ]) {
      const attempt = boundedSettlement([childEnvelope(children)]);
      expect(attempt.settlement.kind).toBe("unavailable");
    }
    for (const run of [
      "agent:not-a-run",
      "@run-child",
      "run-",
    ]) {
      const attempt = boundedSettlement([
        childEnvelope([
          { subject: "agent:child", predicate: "coordinator", value: "director" },
        ], [
          { subject: run, predicate: "agent", value: "child" },
          { subject: run, predicate: "kind", value: "run" },
        ]),
      ]);
      expect(attempt.settlement.kind).toBe("unavailable");
    }
  });

  test("duplicate rows and duplicate authority values fail closed", () => {
    const duplicateRow = boundedSettlement([
      childEnvelope([
        { subject: "agent:child", predicate: "coordinator", value: "director" },
        { subject: "agent:child", predicate: "coordinator", value: "director" },
      ]),
    ]);
    expect(duplicateRow.settlement).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("duplicate fact row"),
    });

    const duplicateAuthority = boundedSettlement([
      childEnvelope([
        { subject: "agent:child", predicate: "coordinator", value: "director" },
        { subject: "agent:child", predicate: "coordinator", value: "other" },
      ]),
    ]);
    expect(duplicateAuthority.settlement).toEqual({
      kind: "unavailable",
      reason: "child settlement projection returned invalid child authority",
    });

    const duplicateRunAuthority = boundedSettlement([
      childEnvelope([
        { subject: "agent:child", predicate: "coordinator", value: "director" },
      ], [
        { subject: "run-child", predicate: "agent", value: "child" },
        { subject: "run-child", predicate: "agent", value: "other" },
        { subject: "run-child", predicate: "kind", value: "run" },
      ]),
    ]);
    expect(duplicateRunAuthority.settlement).toEqual({
      kind: "unavailable",
      reason: "child settlement projection returned invalid run authority",
    });
  });

  test("partial run commits and unrelated run authority never become terminals", () => {
    const partial = boundedSettlement([
      childEnvelope([
        { subject: "agent:child", predicate: "coordinator", value: "director" },
      ], [
        { subject: "run-child", predicate: "agent", value: "child" },
        { subject: "run-child", predicate: "outcome", value: "ran" },
      ]),
    ]);
    expect(partial.settlement).toEqual({
      kind: "unavailable",
      reason: "child settlement projection returned invalid run authority",
    });

    const unrelated = boundedSettlement([
      childEnvelope([
        { subject: "agent:child", predicate: "coordinator", value: "director" },
      ], [
        { subject: "run-other", predicate: "agent", value: "other" },
        { subject: "run-other", predicate: "kind", value: "run" },
      ]),
    ]);
    expect(unrelated.settlement).toEqual({
      kind: "unavailable",
      reason: "child settlement projection returned invalid run authority",
    });
  });

  test("empty snapshot remains distinct from command or protocol unavailability", () => {
    const empty = boundedSettlement([childEnvelope()]);
    expect(empty.settlement).toEqual({ kind: "settled", children: [] });
    expect(empty.calls).toHaveLength(1);

    const unavailable = boundedSettlement([new Error("coordinator unavailable")]);
    expect(unavailable.settlement).toEqual({
      kind: "unavailable",
      reason: "coordinator unavailable",
    });
    expect(unavailable.calls).toHaveLength(1);
  });

  test("mixed terminal/live children preserve the exact live identity", () => {
    const { settlement, calls } = boundedSettlement([
      childEnvelope([
        { subject: "agent:done", predicate: "coordinator", value: "director" },
        ...factRows("agent:done", markedLane),
        { subject: "agent:live", predicate: "coordinator", value: "director" },
      ]),
    ]);
    expect(settlement).toEqual({
      kind: "live",
      children: ["@agent:done", "@agent:live"],
      live: ["@agent:live"],
    });
    expect(calls).toHaveLength(1);
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

  test("a previously live child cannot disappear into an empty settled set", () => {
    const live = decideChildTurnEnd(initialChildContinuationState(), {
      kind: "live", children: ["@agent:a"], live: ["@agent:a"],
    }, 2);
    const regressed = decideChildTurnEnd(live.state, {
      kind: "settled", children: [],
    }, 2);
    expect(regressed).toMatchObject({
      action: "block",
      reason: "child_set_regressed",
      missing: ["@agent:a"],
      state: {
        observedChildren: ["@agent:a"],
      },
    });
  });

  test("child-set regression is detected before a pending reduction is acknowledged", () => {
    const pending = decideChildTurnEnd(initialChildContinuationState(), {
      kind: "settled", children: ["@agent:a"],
    }, 2);
    const regressed = decideChildTurnEnd(pending.state, {
      kind: "settled", children: [],
    }, 2);
    expect(regressed).toMatchObject({
      action: "block",
      reason: "child_set_regressed",
      missing: ["@agent:a"],
    });
    expect(regressed.state.pendingSettledSignature).toBe("@agent:a");
    expect(regressed.state.acknowledgedSettledSignature).toBeUndefined();
  });

  test("replacing an observed child with a new identity is a regression", () => {
    const first = decideChildTurnEnd(initialChildContinuationState(), {
      kind: "live", children: ["@agent:a"], live: ["@agent:a"],
    }, 2);
    const replaced = decideChildTurnEnd(first.state, {
      kind: "live", children: ["@agent:b"], live: ["@agent:b"],
    }, 2);
    expect(replaced).toMatchObject({
      action: "block",
      reason: "child_set_regressed",
      missing: ["@agent:a"],
      state: {
        observedChildren: ["@agent:a"],
      },
    });
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
        observedChildren: ["@agent:a", "@agent:b"],
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

  test("the final gate rejects an empty set after an acknowledged child reduction", () => {
    const pending = decideChildTurnEnd(initialChildContinuationState(), {
      kind: "settled", children: ["@agent:a"],
    }, 2);
    const acknowledged = decideChildTurnEnd(pending.state, {
      kind: "settled", children: ["@agent:a"],
    }, 2);
    expect(assessChildFinalization(acknowledged.state, {
      kind: "settled", children: [],
    })).toEqual({
      ok: false,
      outcome: "orchestrator_child_set_inconsistent",
      missing: ["@agent:a"],
      reason: "previously observed coordinator relation disappeared",
    });
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
      kind: "live", children: ["a", "b"], live: ["b"],
    }, 2);
    expect(advanced).toMatchObject({ action: "continue", attempt: 1 });
    const unchanged = decideChildTurnEnd(advanced.state, {
      kind: "live", children: ["a", "b"], live: ["b"],
    }, 2);
    const capped = decideChildTurnEnd(unchanged.state, {
      kind: "live", children: ["a", "b"], live: ["b"],
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
