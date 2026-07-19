// Early-exit-with-live-children — the graph-side half of the never-die-with-live-work
// fix (thread 019f4ed2). Half (a) (bgtasks.ts) stops a lane exiting while its OWN
// in-process background Bash tasks run. This half covers the other orphaning path:
// a lane that SPAWNED child agents (each records `coordinator <this-lane>` on
// @agent:<child>) and then truly finalizes while those children have not yet reported
// an outcome — exactly specimen sdk-524a451b (orchestrator said "turn ends here",
// exited, its two workers completed later into a dead inbox; the next wave never fired).
//
// The reactor's died-unreported sweep eventually catches this (lapsed >30min), but that
// is a 30-minute-late signal. This fires it IMMEDIATELY, at the moment of exit, so the
// coordinator learns "I am leaving children behind" now, loudly, with the ids named.
//
// A child is SETTLED (not orphaned) only by a committed lifecycle signal:
// a digest-marked modern lane terminal (or a true pre-process_outcome legacy
// lane), or a tagged run whose last-write kind=run marker landed. Everything
// here is explicit: settlement is not parent reduction, and graph
// unavailability is not the same state as no children.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { normalizeNorthEntityId, type Fact } from "./north-client";
import { parseStrictJson } from "./strict-json";
import { laneResolvedByFacts } from "./terminal-projection";

const REPO = resolve(import.meta.dir, "..", "..");
const MSG_CLI = `${REPO}/cli/msg-cli.clj`;
const northBin = () => process.env.NORTH_BIN ?? `${REPO}/bin/north`;
const port = () => process.env.NORTH_PORT ?? "7977";

export const CHILD_SETTLEMENT_MAX_CHILDREN = 128;
export const CHILD_SETTLEMENT_MAX_RUNS = 512;
export const CHILD_SETTLEMENT_MAX_FACT_ROWS = 32_768;
export const CHILD_SETTLEMENT_DEADLINE_MS = 5_000;
const CHILD_SETTLEMENT_MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const CHILD_SETTLEMENT_PROTOCOL = "north.child-settlement";
const CHILD_SETTLEMENT_VERSION = 1;

interface ChildSettlementCommandOptions {
  timeoutMs: number;
  maxBuffer: number;
}

export interface ChildSettlementBulkDependencies {
  run: (
    command: string,
    args: string[],
    options: ChildSettlementCommandOptions,
  ) => string | Uint8Array;
  now?: () => number;
  /** Tests may tighten, never widen, the production wall-clock budget. */
  deadlineMs?: number;
}

function productionChildSettlementCommand(
  command: string,
  args: string[],
  options: ChildSettlementCommandOptions,
): Uint8Array {
  return execFileSync(command, args, {
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function decodedOutput(value: string | Uint8Array, label: string): string {
  const bytes = typeof value === "string"
    ? Buffer.from(value, "utf8")
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.byteLength > CHILD_SETTLEMENT_MAX_COMMAND_BYTES)
    throw new Error(`${label} exceeded its output bound`);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${label} returned invalid UTF-8`); }
  return text;
}

interface SubjectFact extends Fact {
  subject: string;
}

function subjectFactRows(parsed: unknown, label: string): SubjectFact[] {
  if (!Array.isArray(parsed) || parsed.length > CHILD_SETTLEMENT_MAX_FACT_ROWS)
    throw new Error(`${label} exceeded its row bound`);
  const rows: SubjectFact[] = [];
  const observed = new Set<string>();
  for (const row of parsed) {
    if (typeof row !== "object" || row === null || Array.isArray(row)
        || Object.keys(row).sort().join("\0") !== "predicate\0subject\0value") {
      throw new Error(`${label} returned an invalid fact row`);
    }
    const fact = row as Record<string, unknown>;
    if (typeof fact.subject !== "string" || typeof fact.predicate !== "string"
        || typeof fact.value !== "string") {
      throw new Error(`${label} returned an invalid fact row`);
    }
    const signature = `${fact.subject}\0${fact.predicate}\0${fact.value}`;
    if (observed.has(signature))
      throw new Error(`${label} returned a duplicate fact row`);
    observed.add(signature);
    rows.push({
      subject: fact.subject,
      predicate: fact.predicate,
      value: fact.value,
    });
  }
  return rows;
}

function groupedSubjectFacts(rows: SubjectFact[]): Map<string, Fact[]> {
  const grouped = new Map<string, Fact[]>();
  for (const row of rows) {
    const facts = grouped.get(row.subject) ?? [];
    facts.push({ predicate: row.predicate, value: row.value });
    grouped.set(row.subject, facts);
  }
  return grouped;
}

interface ChildIdentity {
  subject: string;
  graphId: string;
  agentId: string;
}

function childIdentity(value: string): ChildIdentity {
  if (!value.startsWith("agent:"))
    throw new Error("child settlement projection returned a non-agent child");
  const graphId = normalizeNorthEntityId(value);
  if (graphId !== value || graphId.length === "agent:".length)
    throw new Error("child settlement projection returned a noncanonical child");
  return {
    subject: `@${graphId}`,
    graphId,
    agentId: graphId.slice("agent:".length),
  };
}

function runIdentity(value: string): string {
  if (!value.startsWith("run-"))
    throw new Error("child settlement projection returned a non-run subject");
  const graphId = normalizeNorthEntityId(value);
  if (graphId !== value || graphId.length === "run-".length)
    throw new Error("child settlement projection returned a noncanonical run");
  return graphId;
}

function exactFactValue(facts: readonly Fact[], predicate: string): string | undefined {
  const values = facts.filter((fact) => fact.predicate === predicate).map((fact) => fact.value);
  return values.length === 1 ? values[0] : undefined;
}

export type ChildSettlement =
  | { kind: "settled"; children: string[] }
  | { kind: "live"; children: string[]; live: string[] }
  | { kind: "unavailable"; reason: string };

export interface ChildContinuationState {
  observedChildren: string[];
  liveSignature?: string;
  noProgress: number;
  pendingSettledSignature?: string;
  acknowledgedSettledSignature?: string;
}

export type ChildTurnEndDecision =
  | { action: "finish"; state: ChildContinuationState }
  | {
    action: "continue";
    reason: "children_live";
    state: ChildContinuationState;
    live: string[];
    attempt: number;
    cap: number;
  }
  | {
    action: "continue";
    reason: "child_reduction_required";
    state: ChildContinuationState;
    children: string[];
  }
  | {
    action: "block";
    state: ChildContinuationState;
    reason:
      | "children_live_at_continuation_cap"
      | "child_reconciliation_unavailable"
      | "child_set_regressed";
    live?: string[];
    missing?: string[];
  };

export type ChildFinalizationDecision =
  | { ok: true }
  | {
    ok: false;
    outcome:
      | "orchestrator_children_incomplete"
      | "child_reconciliation_unavailable"
      | "orchestrator_reduction_incomplete"
      | "orchestrator_child_set_inconsistent";
    live?: string[];
    children?: string[];
    missing?: string[];
    reason?: string;
  };

export function initialChildContinuationState(): ChildContinuationState {
  return { observedChildren: [], noProgress: 0 };
}

function canonicalChildren(children: string[]): string[] {
  return [...new Set(children)].sort();
}

function setSignature(children: string[]): string {
  return canonicalChildren(children).join("\u0000");
}

function observeChildren(
  previous: ChildContinuationState,
  children: string[],
): { state: ChildContinuationState; missing: string[] } {
  const current = new Set(canonicalChildren(children));
  const missing = previous.observedChildren.filter((child) => !current.has(child));
  if (missing.length > 0) return { state: previous, missing };
  return {
    state: {
      ...previous,
      observedChildren: canonicalChildren([
        ...previous.observedChildren,
        ...children,
      ]),
    },
    missing: [],
  };
}

function afterSuccessfulProviderResult(
  previous: ChildContinuationState,
): ChildContinuationState {
  if (!previous.pendingSettledSignature) return previous;
  return {
    ...previous,
    acknowledgedSettledSignature: previous.pendingSettledSignature,
    pendingSettledSignature: undefined,
  };
}

export function decideChildTurnEnd(
  previous: ChildContinuationState,
  settlement: ChildSettlement,
  cap: number,
): ChildTurnEndDecision {
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new Error("child continuation cap must be a non-negative safe integer");
  }
  let observed = previous;
  if (settlement.kind !== "unavailable") {
    const observation = observeChildren(previous, settlement.children);
    if (observation.missing.length > 0) {
      return {
        action: "block",
        state: observation.state,
        reason: "child_set_regressed",
        missing: observation.missing,
      };
    }
    observed = observation.state;
  }
  // This function is called only after a successful provider result. Therefore
  // a pending settled signature can be acknowledged now: the provider has
  // completed the continuation that North injected for that exact child set.
  // The child observation above MUST happen first: a disappeared coordinator
  // edge cannot acknowledge the reduction that was pending for that child.
  const acknowledged = afterSuccessfulProviderResult(observed);
  if (settlement.kind === "settled") {
    if (settlement.children.length === 0) {
      return {
        action: "finish",
        state: { ...acknowledged, liveSignature: undefined, noProgress: 0 },
      };
    }
    const signature = setSignature(settlement.children);
    if (acknowledged.acknowledgedSettledSignature === signature) {
      return {
        action: "finish",
        state: { ...acknowledged, liveSignature: undefined, noProgress: 0 },
      };
    }
    return {
      action: "continue",
      reason: "child_reduction_required",
      state: {
        ...acknowledged,
        liveSignature: undefined,
        noProgress: 0,
        pendingSettledSignature: signature,
      },
      children: settlement.children,
    };
  }
  if (settlement.kind === "unavailable") {
    return {
      action: "block",
      state: acknowledged,
      reason: "child_reconciliation_unavailable",
    };
  }
  const liveSignature = `${setSignature(settlement.children)}\u0001${setSignature(settlement.live)}`;
  const noProgress = acknowledged.liveSignature === liveSignature
    ? acknowledged.noProgress + 1
    : 1;
  const state = {
    ...acknowledged,
    liveSignature,
    noProgress,
    pendingSettledSignature: undefined,
  };
  if (noProgress > cap) {
    return {
      action: "block",
      state,
      reason: "children_live_at_continuation_cap",
      live: settlement.live,
    };
  }
  return {
    action: "continue",
    reason: "children_live",
    state,
    live: settlement.live,
    attempt: noProgress,
    cap,
  };
}

export function assessChildFinalization(
  state: ChildContinuationState,
  settlement: ChildSettlement,
): ChildFinalizationDecision {
  if (settlement.kind === "unavailable") {
    return {
      ok: false,
      outcome: "child_reconciliation_unavailable",
      reason: settlement.reason,
    };
  }
  const current = new Set(canonicalChildren(settlement.children));
  const missing = state.observedChildren.filter((child) => !current.has(child));
  if (missing.length > 0) {
    return {
      ok: false,
      outcome: "orchestrator_child_set_inconsistent",
      missing,
      reason: "previously observed coordinator relation disappeared",
    };
  }
  if (settlement.kind === "live") {
    return {
      ok: false,
      outcome: "orchestrator_children_incomplete",
      live: settlement.live,
    };
  }
  if (settlement.children.length === 0) return { ok: true };
  const signature = setSignature(settlement.children);
  if (state.acknowledgedSettledSignature === signature
      && state.pendingSettledSignature === undefined) {
    return { ok: true };
  }
  return {
    ok: false,
    outcome: "orchestrator_reduction_incomplete",
    children: settlement.children,
  };
}

export function resolveChildLifecycle(
  laneFacts: Fact[],
  readTaggedRuns: () => Fact[][],
): boolean {
  if (laneResolvedByFacts(laneFacts, [])) return true;
  return laneResolvedByFacts([], readTaggedRuns());
}

// Classify every child under one snapshot attempt. An empty or fully-terminal
// set is `settled`; this says nothing yet about parent reduction. A read failure
// remains `unavailable`.
export function gatherChildSettlement(
  coordId: string,
  readChildren: (id: string) => string[],
  resolved: (child: string) => boolean,
): ChildSettlement {
  try {
    if (!coordId) return { kind: "settled", children: [] };
    const kids = readChildren(coordId);
    if (!kids.length) return { kind: "settled", children: [] };
    const live = kids.filter((child) => !resolved(child));
    return live.length
      ? { kind: "live", children: kids, live }
      : { kind: "settled", children: kids };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "unknown child settlement failure",
    };
  }
}

/**
 * One-command child projection. North derives direct children, their complete
 * fact sets, and every tagged run for those children from one `live-facts`
 * vector and emits a closed, versioned envelope. This is one actual snapshot:
 * child growth/shrink and run commit cannot split across reads. The SDK still
 * independently validates the complete envelope, identities, authority facts,
 * cardinality and lifecycle markers before classifying anything.
 */
export function settleChildrenBounded(
  coordId: string,
  dependencies: ChildSettlementBulkDependencies,
): ChildSettlement {
  try {
    if (!coordId) return { kind: "settled", children: [] };
    const canonicalCoordId = normalizeNorthEntityId(coordId);
    const deadlineMs = dependencies.deadlineMs ?? CHILD_SETTLEMENT_DEADLINE_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0
        || deadlineMs > CHILD_SETTLEMENT_DEADLINE_MS) {
      throw new Error("child settlement deadline is invalid");
    }
    const now = dependencies.now ?? (() => performance.now());
    const deadline = now() + deadlineMs;
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) throw new Error("child settlement aggregate deadline exceeded");
    const output = decodedOutput(
      dependencies.run(
        northBin(),
        ["json", "child-settlement", canonicalCoordId],
        {
          timeoutMs: Math.max(1, remaining),
          maxBuffer: CHILD_SETTLEMENT_MAX_COMMAND_BYTES,
        },
      ),
      "child settlement projection",
    );
    if (now() > deadline) throw new Error("child settlement aggregate deadline exceeded");
    const parsed = parseStrictJson(output, "child settlement projection", {
      maxBytes: CHILD_SETTLEMENT_MAX_COMMAND_BYTES,
      maxDepth: 32,
      maxNodes: CHILD_SETTLEMENT_MAX_FACT_ROWS * 8 + 16,
    });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
        || Object.keys(parsed).sort().join("\0")
          !== "children\0coordinator\0protocol\0runs\0version") {
      throw new Error("child settlement projection returned an invalid envelope");
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope.protocol !== CHILD_SETTLEMENT_PROTOCOL
        || envelope.version !== CHILD_SETTLEMENT_VERSION
        || envelope.coordinator !== canonicalCoordId) {
      throw new Error("child settlement projection returned an incompatible envelope");
    }
    const childRows = subjectFactRows(
      envelope.children,
      "child settlement child projection",
    );
    const runRows = subjectFactRows(
      envelope.runs,
      "child settlement run projection",
    );
    if (childRows.length + runRows.length > CHILD_SETTLEMENT_MAX_FACT_ROWS)
      throw new Error("child settlement projection exceeded its cumulative row bound");
    const childFacts = groupedSubjectFacts(childRows);
    if (childFacts.size > CHILD_SETTLEMENT_MAX_CHILDREN)
      throw new Error("child settlement child projection exceeded its subject bound");
    const children = [...childFacts.keys()].map(childIdentity)
      .sort((left, right) => left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0);
    for (const child of children) {
      const facts = childFacts.get(child.graphId)!;
      if (exactFactValue(facts, "coordinator") !== canonicalCoordId)
        throw new Error("child settlement projection returned invalid child authority");
    }
    const runFacts = groupedSubjectFacts(runRows);
    if (runFacts.size > CHILD_SETTLEMENT_MAX_RUNS)
      throw new Error("child settlement run projection exceeded its subject bound");
    const runsByAgent = new Map(children.map((child) => [child.agentId, [] as Fact[][]]));
    for (const [rawRunId, facts] of runFacts) {
      runIdentity(rawRunId);
      const agent = exactFactValue(facts, "agent");
      if (exactFactValue(facts, "kind") !== "run" || !agent || !runsByAgent.has(agent))
        throw new Error("child settlement projection returned invalid run authority");
      runsByAgent.get(agent)!.push(facts);
    }

    const childSubjects = children.map((child) => child.subject);
    const live = children.filter((child) =>
      !resolveChildLifecycle(
        childFacts.get(child.graphId)!,
        () => runsByAgent.get(child.agentId)!,
      )).map((child) => child.subject);
    return live.length
      ? { kind: "live", children: childSubjects, live }
      : { kind: "settled", children: childSubjects };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "unknown child settlement failure",
    };
  }
}

export function settleChildren(coordId: string): ChildSettlement {
  return settleChildrenBounded(coordId, { run: productionChildSettlementCommand });
}

export function childContinuationMessage(liveIds: string[]): string {
  return [
    `North refuses orchestrator turn-end: ${liveIds.length} child lane(s) remain live (${liveIds.join(", ")}).`,
    "Keep this turn active, consume the North listener/peer results, reconcile completed work into the prebound thread,",
    "and return a later terminal result only after every child has a committed lifecycle terminal.",
  ].join(" ");
}

export function childReductionMessage(settledIds: string[]): string {
  return [
    `North requires a post-settlement reduction turn: ${settledIds.length} child lane(s) are terminal (${settledIds.join(", ")}).`,
    "Consume their completion pings/reports, inspect the child results as needed, and reduce those results into the prebound parent thread.",
    "Return a new terminal result only after that reduction; a changed settled child set requires another reduction turn.",
  ].join(" ");
}

export interface EarlyExitCtx {
  coordinator?: string;
}

type Cmd = { cmd: string; args: string[] };

// PURE: the command specs an early-exit-with-live-children emits — a durable
// `early_exit_children` fact on @agent:<id> (queryable, like agent_death/stalled) + a
// loud "EARLY EXIT WITH LIVE CHILDREN" peer ping naming the orphans. Pure so the
// contract is unit-testable without a live coordinator (mirrors death/watchdog).
export function earlyExitCommands(
  agentId: string,
  liveIds: string[],
  ctx: EarlyExitCtx = {},
  ts: string = new Date().toISOString(),
): Cmd[] {
  const ids = liveIds.join(",");
  const line = `${agentId} | orphaned: ${ids} | ${ts}`;
  const cmds: Cmd[] = [
    { cmd: northBin(), args: ["tell", `agent:${agentId}`, "early_exit_children", line] },
  ];
  if (ctx.coordinator) {
    cmds.push({
      cmd: "bb",
      args: [MSG_CLI, port(), "send", agentId, ctx.coordinator, "EARLY EXIT WITH LIVE CHILDREN",
        `${liveIds.length} live child(ren): ${ids} (${ts})`],
    });
  }
  return cmds;
}

// Emit the early-exit notification. Synchronous + fully swallowed (a finalizing lane
// must never throw out of this), and a loud stderr line so it shows in the lane log.
export function notifyEarlyExitChildren(
  agentId: string,
  liveIds: string[],
  ctx: EarlyExitCtx = {},
  timeoutMs = 10_000,
): void {
  if (!liveIds.length) return;
  const startedAt = performance.now();
  for (const { cmd, args } of earlyExitCommands(agentId, liveIds, ctx)) {
    try {
      const remaining = Math.max(
        1,
        Math.floor(timeoutMs - (performance.now() - startedAt)),
      );
      execFileSync(cmd, args, {
        encoding: "utf8",
        timeout: remaining,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      /* best-effort */
    }
  }
  console.error(`[early-exit] @agent:${agentId} EXITING WITH ${liveIds.length} LIVE CHILD(REN): ${liveIds.join(", ")}`);
}
