// Provider-neutral struggle observation over the normalized SDK message stream.
// The observer changes no route in flight: it records execution-axis evidence for
// terminal telemetry and later calibration.

export const STRUGGLE_DETECTOR_POLICY_VERSION = "north:struggle-observer:v1";
export const STRUGGLE_THRESHOLD_MAX = 1_000;

export type StruggleTopology = "worker" | "orchestrator";
export type StruggleTrigger = "consecutive_errors" | "tool_loop" | "no_progress";

export interface StrugglePolicy {
  readonly version: typeof STRUGGLE_DETECTOR_POLICY_VERSION;
  readonly topology: StruggleTopology;
  readonly errorStreak: number;
  readonly loopRepeat: number;
  readonly loopWindow: number;
  readonly noProgressTurns: number;
}

export interface StruggleState {
  readonly policy: StrugglePolicy;
  // `turn` counts every assistant message the provider emits (raw provider event
  // index, used only for the diagnostic breadcrumb). `workTurns` counts only turns
  // that issued at least one tool_use — the genuine progress-attempt turns the
  // no-progress clock is measured against. Pre-tool provider events (streamed
  // text, reasoning/thinking-only assistant messages) advance `turn` but NOT
  // `workTurns`, so a startup narration burst cannot masquerade as a stall.
  turn: number;
  workTurns: number;
  consecutiveErrors: number;
  totalErrors: number;
  lastProgressTurn: number;
  fingerprints: string[];
  pending: Map<string, string>;
}

export interface StruggleObservation {
  readonly policyVersion: typeof STRUGGLE_DETECTOR_POLICY_VERSION;
  readonly topology: StruggleTopology;
  readonly errorStreakThreshold: number;
  readonly loopRepeatThreshold: number;
  readonly loopWindow: number;
  readonly noProgressTurnThreshold: number;
  readonly errorCount: number;
  readonly triggers: ReadonlyArray<StruggleTrigger>;
}

export interface StruggleObserver {
  readonly state: StruggleState;
  observe(message: unknown): StruggleTrigger | null;
  snapshot(): StruggleObservation;
}

const DEFAULTS = {
  errorStreak: 3,
  loopRepeat: 3,
  loopWindow: 20,
  workerNoProgress: 6,
  orchestratorNoProgress: 12,
} as const;

// Successful work/evidence/coordination actions refresh the no-progress clock.
// Repeating an identical call can still trip tool_loop, so widening this set does
// not hide mechanical retries.
const STRUGGLE_PROGRESS_TOOLS: ReadonlySet<string> = new Set([
  "Read", "Grep", "Glob", "Bash", "WebSearch", "WebFetch",
  "Edit", "Write", "NotebookEdit",
  "mcp__north__show", "mcp__north__ready", "mcp__north__next",
  "mcp__north__board", "mcp__north__plate", "mcp__north__blocked",
  "mcp__north__agenda", "mcp__north__leverage", "mcp__north__needs_review",
  "mcp__north__validate", "mcp__north__clock_status",
  "mcp__north__capture", "mcp__north__tell", "mcp__north__retract",
  "mcp__north__evidence_record", "mcp__north__spawn", "mcp__north__dispatch",
]);

type StruggleEnvironment = Readonly<Record<string, string | undefined>>;

function boundedPositiveInteger(
  env: StruggleEnvironment,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer between 1 and ${STRUGGLE_THRESHOLD_MAX}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > STRUGGLE_THRESHOLD_MAX) {
    throw new Error(`${name} must be a positive integer between 1 and ${STRUGGLE_THRESHOLD_MAX}`);
  }
  return value;
}

export function resolveStrugglePolicy(
  topology: StruggleTopology,
  env: StruggleEnvironment = process.env,
): StrugglePolicy {
  if (topology !== "worker" && topology !== "orchestrator") {
    throw new Error(`struggle observer requires worker|orchestrator topology, got ${String(topology)}`);
  }
  const errorStreak = boundedPositiveInteger(
    env, "STRUGGLE_ERROR_STREAK", DEFAULTS.errorStreak,
  );
  const loopRepeat = boundedPositiveInteger(
    env, "STRUGGLE_LOOP_REPEAT", DEFAULTS.loopRepeat,
  );
  const loopWindow = boundedPositiveInteger(
    env, "STRUGGLE_LOOP_WINDOW", DEFAULTS.loopWindow,
  );
  if (loopRepeat > loopWindow) {
    throw new Error("STRUGGLE_LOOP_REPEAT must be less than or equal to STRUGGLE_LOOP_WINDOW");
  }
  const workerNoProgress = boundedPositiveInteger(
    env, "STRUGGLE_STALL_TURNS", DEFAULTS.workerNoProgress,
  );
  const orchestratorNoProgress = boundedPositiveInteger(
    env, "STRUGGLE_STALL_TURNS_ORCHESTRATOR", DEFAULTS.orchestratorNoProgress,
  );
  if (orchestratorNoProgress < workerNoProgress) {
    throw new Error(
      "STRUGGLE_STALL_TURNS_ORCHESTRATOR must be greater than or equal to STRUGGLE_STALL_TURNS",
    );
  }
  return Object.freeze({
    version: STRUGGLE_DETECTOR_POLICY_VERSION,
    topology,
    errorStreak,
    loopRepeat,
    loopWindow,
    noProgressTurns: topology === "orchestrator" ? orchestratorNoProgress : workerNoProgress,
  });
}

/** Adapter/runtime parity witness for managed CLI launches. */
export function assertExpectedStrugglePolicy(
  policy: StrugglePolicy,
  expected = process.env.NORTH_STRUGGLE_POLICY_EXPECTED,
): void {
  if (expected === undefined) return;
  if (expected !== JSON.stringify(policy)) {
    throw new Error("struggle detector policy changed between adapter preview and execution");
  }
}

export function makeStruggleState(
  topologyOrPolicy: StruggleTopology | StrugglePolicy = "worker",
): StruggleState {
  const resolved = typeof topologyOrPolicy === "string"
    ? resolveStrugglePolicy(topologyOrPolicy)
    : topologyOrPolicy;
  const policy = Object.freeze({ ...resolved });
  return {
    policy,
    turn: 0,
    workTurns: 0,
    consecutiveErrors: 0,
    totalErrors: 0,
    lastProgressTurn: 0,
    fingerprints: [],
    pending: new Map(),
  };
}

function fingerprint(name: string, input: unknown): string {
  let serialized = "";
  try { serialized = JSON.stringify(input) ?? ""; }
  catch { serialized = String(input); }
  return `${name}:${serialized.slice(0, 200)}`;
}

export function updateStruggle(message: any, state: StruggleState): void {
  if (message?.type === "assistant") {
    state.turn++;
    let toolUses = 0;
    for (const block of message.message?.content ?? []) {
      if (block?.type !== "tool_use") continue;
      toolUses++;
      state.pending.set(block.id, block.name);
      state.fingerprints.push(fingerprint(block.name, block.input));
      if (state.fingerprints.length > state.policy.loopWindow) state.fingerprints.shift();
    }
    // Only tool-issuing turns are work turns. A tool_use-free assistant message is
    // provider narration/reasoning or a streamed pre-tool event — real evidence of
    // NON-progress requires the agent to have actually acted. Advancing the stall
    // clock on these events is exactly the observed false positive: no_progress
    // fired at turn 6, 0 tool errors, before the worker's first tool call.
    if (toolUses > 0) state.workTurns++;
    return;
  }
  if (message?.type !== "user") return;
  for (const block of message.message?.content ?? []) {
    if (block?.type !== "tool_result") continue;
    const name = state.pending.get(block.tool_use_id) ?? "";
    state.pending.delete(block.tool_use_id);
    if (block.is_error) {
      state.consecutiveErrors++;
      state.totalErrors++;
    } else {
      state.consecutiveErrors = 0;
      // Baseline the no-progress clock in work-turn units (see StruggleState.turn).
      if (STRUGGLE_PROGRESS_TOOLS.has(name)) state.lastProgressTurn = state.workTurns;
    }
  }
}

export function checkStruggle(state: StruggleState): StruggleTrigger | null {
  if (state.consecutiveErrors >= state.policy.errorStreak) return "consecutive_errors";
  const counts = new Map<string, number>();
  for (const value of state.fingerprints) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count >= state.policy.loopRepeat) return "tool_loop";
  }
  if (state.workTurns - state.lastProgressTurn >= state.policy.noProgressTurns) return "no_progress";
  return null;
}

export function makeStruggleObserver(policy: StrugglePolicy): StruggleObserver {
  const state = makeStruggleState(policy);
  const fired = new Set<StruggleTrigger>();
  return {
    state,
    observe(message: unknown): StruggleTrigger | null {
      updateStruggle(message, state);
      const trigger = checkStruggle(state);
      if (!trigger || fired.has(trigger)) return null;
      fired.add(trigger);
      return trigger;
    },
    snapshot(): StruggleObservation {
      return Object.freeze({
        policyVersion: state.policy.version,
        topology: state.policy.topology,
        errorStreakThreshold: state.policy.errorStreak,
        loopRepeatThreshold: state.policy.loopRepeat,
        loopWindow: state.policy.loopWindow,
        noProgressTurnThreshold: state.policy.noProgressTurns,
        errorCount: state.totalErrors,
        triggers: Object.freeze([...fired]),
      });
    },
  };
}

if (import.meta.main) {
  const [command, topology, ...extra] = process.argv.slice(2);
  if (command !== "policy" || !topology || extra.length) {
    console.error("usage: bun run struggle.ts policy <worker|orchestrator>");
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(resolveStrugglePolicy(topology as StruggleTopology))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid struggle detector policy");
    process.exit(1);
  }
}
