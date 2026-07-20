import { expect, test } from "bun:test";
import {
  checkStruggle, makeStruggleObserver, makeStruggleState,
  resolveStrugglePolicy, updateStruggle, type StruggleTrigger,
} from "../src/struggle";

function toolResult(
  state: ReturnType<typeof makeStruggleState>,
  tool: string,
  id: string,
  isError = false,
  input: unknown = { id },
): void {
  updateStruggle({ type: "assistant", message: { content: [
    { type: "tool_use", id, name: tool, input },
  ] } }, state);
  updateStruggle({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: id, is_error: isError },
  ] } }, state);
}

// Tool_use-free assistant messages, one per applicable provider event shape: a
// streamed text preamble, an Anthropic extended-thinking block, a Codex-style
// reasoning block, and empty/absent content. None of these carries tool activity,
// so none is a work turn.
function preToolShapes(index: number): unknown[] {
  return [
    { type: "assistant", message: { content: [{ type: "text", text: `planning ${index}` }] } },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: `weighing ${index}` }] } },
    { type: "assistant", message: { content: [{ type: "reasoning", summary: `reasoning ${index}` }] } },
    { type: "assistant", message: { content: [] } },
    { type: "assistant", message: {} },
  ];
}

test("topology policy defaults and strict bounded overrides are deterministic", () => {
  const workerPolicy = resolveStrugglePolicy("worker", {});
  expect(workerPolicy).toEqual({
    version: "north:struggle-observer:v1",
    topology: "worker",
    errorStreak: 3,
    loopRepeat: 3,
    loopWindow: 20,
    noProgressTurns: 6,
  });
  expect(Object.isFrozen(workerPolicy)).toBe(true);
  expect(() => { (workerPolicy as any).errorStreak = 99; }).toThrow(TypeError);
  expect(workerPolicy.errorStreak).toBe(3);
  expect(resolveStrugglePolicy("orchestrator", {})).toMatchObject({
    topology: "orchestrator", noProgressTurns: 12,
  });
  expect(resolveStrugglePolicy("orchestrator", {
    STRUGGLE_ERROR_STREAK: "5",
    STRUGGLE_LOOP_REPEAT: "4",
    STRUGGLE_LOOP_WINDOW: "30",
    STRUGGLE_STALL_TURNS: "9",
    STRUGGLE_STALL_TURNS_ORCHESTRATOR: "18",
  })).toMatchObject({
    errorStreak: 5, loopRepeat: 4, loopWindow: 30, noProgressTurns: 18,
  });

  for (const [name, value] of [
    ["STRUGGLE_ERROR_STREAK", "0"],
    ["STRUGGLE_LOOP_REPEAT", "-1"],
    ["STRUGGLE_LOOP_WINDOW", "3.5"],
    ["STRUGGLE_STALL_TURNS", " 6"],
    ["STRUGGLE_STALL_TURNS_ORCHESTRATOR", "1001"],
  ]) {
    expect(() => resolveStrugglePolicy("worker", { [name]: value }))
      .toThrow("positive integer between 1 and 1000");
  }
  expect(() => resolveStrugglePolicy("worker", {
    STRUGGLE_LOOP_REPEAT: "5", STRUGGLE_LOOP_WINDOW: "4",
  })).toThrow("less than or equal");
  expect(() => resolveStrugglePolicy("worker", {
    STRUGGLE_STALL_TURNS: "20", STRUGGLE_STALL_TURNS_ORCHESTRATOR: "10",
  })).toThrow("greater than or equal");
});

test("successful research, implementation, evidence, and coordination tools are progress", () => {
  const progressTools = [
    "Read", "Grep", "Glob", "Bash", "WebSearch", "WebFetch",
    "Edit", "Write", "NotebookEdit",
    "mcp__north__show", "mcp__north__ready", "mcp__north__next",
    "mcp__north__board", "mcp__north__plate", "mcp__north__blocked",
    "mcp__north__agenda", "mcp__north__leverage", "mcp__north__needs_review",
    "mcp__north__validate", "mcp__north__clock_status",
    "mcp__north__capture", "mcp__north__tell", "mcp__north__retract",
    "mcp__north__evidence_record", "mcp__north__spawn", "mcp__north__dispatch",
  ];
  for (const [index, tool] of progressTools.entries()) {
    const state = makeStruggleState(resolveStrugglePolicy("worker", {}));
    toolResult(state, tool, `success-${index}`);
    expect(state.lastProgressTurn).toBe(1);
    expect(checkStruggle(state)).toBeNull();
  }
});

test("failed progress tools stay negative and identical successful retries still loop", () => {
  for (const tool of ["Read", "Bash", "WebSearch", "mcp__north__spawn", "mcp__north__evidence_record"]) {
    const state = makeStruggleState(resolveStrugglePolicy("worker", {}));
    toolResult(state, tool, `failed-${tool}`, true);
    expect(state.lastProgressTurn).toBe(0);
    expect(state.totalErrors).toBe(1);
  }

  const repeated = makeStruggleState(resolveStrugglePolicy("worker", {}));
  for (let i = 0; i < 3; i++) toolResult(repeated, "Read", `read-${i}`, false, { file: "same" });
  expect(repeated.lastProgressTurn).toBe(3);
  expect(checkStruggle(repeated)).toBe("tool_loop");
});

test("no-progress is topology-bound and the observer snapshots the full policy", () => {
  for (const [topology, threshold] of [["worker", 6], ["orchestrator", 12]] as const) {
    const policy = resolveStrugglePolicy(topology, {});
    const observer = makeStruggleObserver(policy);
    for (let turn = 1; turn < threshold; turn++) {
      toolResult(observer.state, "UnknownTool", `${topology}-${turn}`);
      expect(observer.observe({ type: "system", subtype: "heartbeat" })).toBeNull();
      expect(checkStruggle(observer.state)).toBeNull();
    }
    toolResult(observer.state, "UnknownTool", `${topology}-${threshold}`);
    expect(checkStruggle(observer.state)).toBe("no_progress");
    // observe records the first distinct trigger in the terminal snapshot.
    expect(observer.observe({ type: "system", subtype: "heartbeat" })).toBe("no_progress");
    expect(observer.snapshot()).toEqual({
      policyVersion: "north:struggle-observer:v1",
      topology,
      errorStreakThreshold: 3,
      loopRepeatThreshold: 3,
      loopWindow: 20,
      noProgressTurnThreshold: threshold,
      errorCount: 0,
      triggers: ["no_progress"],
    });
    const snapshot = observer.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.triggers)).toBe(true);
    expect(() => { (snapshot.triggers as StruggleTrigger[]).push("tool_loop"); }).toThrow(TypeError);
  }
});

// FALSE POSITIVE: the exact systemic regression seen on three terminal workers —
// no_progress fired at turn 6, 0 tool errors, BEFORE the first tool call. A burst
// of tool_use-free provider events (any shape) must not exhaust the stall budget.
test("pre-tool provider events never fire no_progress before the first tool call", () => {
  for (const [topology, threshold] of [["worker", 6], ["orchestrator", 12]] as const) {
    const observer = makeStruggleObserver(resolveStrugglePolicy(topology, {}));
    // Feed well past the threshold across every applicable pre-tool event shape.
    for (let index = 0; index < threshold * 2; index++) {
      for (const message of preToolShapes(index)) {
        expect(observer.observe(message)).toBeNull();
      }
    }
    // The raw provider turn counter advanced, but no work turn ever did.
    expect(observer.state.turn).toBe(threshold * 2 * preToolShapes(0).length);
    expect(observer.state.workTurns).toBe(0);
    expect(observer.state.totalErrors).toBe(0);
    expect(checkStruggle(observer.state)).toBeNull();
    // The first real tool call proceeds normally; the preamble consumed no budget.
    toolResult(observer.state, "Read", `${topology}-first`);
    expect(observer.state.workTurns).toBe(1);
    expect(observer.state.lastProgressTurn).toBe(1);
    expect(checkStruggle(observer.state)).toBeNull();
  }
});

// TRUE POSITIVE preserved: an initial pre-tool burst must not spend the stall
// budget, yet a genuine configured-length run of non-progress WORK turns after it
// still emits no_progress. Proves the fix shifts the baseline, never disables it.
test("genuine stall after a pre-tool preamble still emits no_progress at the bound", () => {
  for (const [topology, threshold] of [["worker", 6], ["orchestrator", 12]] as const) {
    const observer = makeStruggleObserver(resolveStrugglePolicy(topology, {}));
    for (let index = 0; index < threshold; index++)
      for (const message of preToolShapes(index)) observer.observe(message);
    expect(checkStruggle(observer.state)).toBeNull();

    // threshold - 1 non-progress work turns: still no fire.
    for (let turn = 1; turn < threshold; turn++) {
      toolResult(observer.state, "UnknownTool", `${topology}-stall-${turn}`);
      expect(checkStruggle(observer.state)).toBeNull();
    }
    // The configured-bound work turn trips it, exactly as the pre-fix bound did.
    toolResult(observer.state, "UnknownTool", `${topology}-stall-${threshold}`);
    expect(checkStruggle(observer.state)).toBe("no_progress");
    expect(observer.state.workTurns).toBe(threshold);
    expect(observer.observe({ type: "system", subtype: "heartbeat" })).toBe("no_progress");
    expect(observer.snapshot().triggers).toEqual(["no_progress"]);
  }
});

// Interleaved pre-tool events among work turns extend wall-clock but neither reset
// nor advance the work-turn clock, so a stall spread across narration still fires.
test("interleaved pre-tool narration does not reset or accelerate the stall clock", () => {
  const observer = makeStruggleObserver(resolveStrugglePolicy("worker", {}));
  for (let turn = 1; turn <= 6; turn++) {
    observer.observe({ type: "assistant", message: { content: [{ type: "text", text: `note ${turn}` }] } });
    toolResult(observer.state, "UnknownTool", `mixed-${turn}`);
    if (turn < 6) expect(checkStruggle(observer.state)).toBeNull();
  }
  expect(checkStruggle(observer.state)).toBe("no_progress");
  expect(observer.state.workTurns).toBe(6);
  expect(observer.state.turn).toBe(12); // 6 narration + 6 tool_use assistant messages
});

// Reconciles the independently accepted Headroom director regressions with the
// newer work-turn-based observer on main. Distinct planning remains progress,
// while lifecycle wait/reduction turns consume no work-turn budget at all.
test("orchestrator planning and lifecycle waits do not false-fire no_progress", () => {
  const observer = makeStruggleObserver(resolveStrugglePolicy("orchestrator", {}));
  const planningTools = ["Read", "Grep", "mcp__north__show", "mcp__north__board"];
  for (let turn = 1; turn <= 30; turn++) {
    toolResult(
      observer.state,
      planningTools[turn % planningTools.length]!,
      `planning-${turn}`,
      false,
      { query: turn },
    );
    expect(checkStruggle(observer.state)).toBeNull();
  }
  const workTurnsAfterPlanning = observer.state.workTurns;
  for (let wait = 0; wait < 40; wait++) {
    expect(observer.observe({
      type: "assistant",
      message: { content: [{ type: "text", text: `waiting for child ${wait}` }] },
    })).toBeNull();
  }
  expect(observer.state.workTurns).toBe(workTurnsAfterPlanning);
  expect(checkStruggle(observer.state)).toBeNull();
});

test("orchestrator unchanged polling remains an observable tool loop", () => {
  const observer = makeStruggleObserver(resolveStrugglePolicy("orchestrator", {}));
  for (let turn = 1; turn <= 3; turn++) {
    toolResult(observer.state, "mcp__north__show", `poll-${turn}`, false, { id: "same" });
  }
  expect(checkStruggle(observer.state)).toBe("tool_loop");
});
