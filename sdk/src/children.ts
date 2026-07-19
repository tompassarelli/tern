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
import { getThreadFacts } from "./north-client";
import { laneResolvedByFacts } from "./terminal-projection";

const REPO = resolve(import.meta.dir, "..", "..");
const MSG_CLI = `${REPO}/cli/msg-cli.clj`;
const northBin = () => process.env.NORTH_BIN ?? `${REPO}/bin/north`;
const port = () => process.env.NORTH_PORT ?? "7977";

// Run a single-column rules query against the engine; return the bare string values
// (rows arrive as JSON arrays like ["@agent:x"]). Any transport/protocol defect
// throws into the explicit `unavailable` settlement state below.
function queryCol(rules: unknown): string[] {
  const out = execFileSync(northBin(), ["query", JSON.stringify(rules)], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const lines = out.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "(no results)")) return [];
  return lines.map((line) => {
    const row = JSON.parse(line);
    if (!Array.isArray(row) || row.length !== 1 || typeof row[0] !== "string") {
      throw new Error("child settlement query returned an invalid row");
    }
    return row[0];
  });
}

export type ChildSettlement =
  | { kind: "settled"; children: string[] }
  | { kind: "live"; children: string[]; live: string[] }
  | { kind: "unavailable"; reason: string };

export interface ChildContinuationState {
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
    reason: "children_live_at_continuation_cap" | "child_reconciliation_unavailable";
    live?: string[];
  };

export type ChildFinalizationDecision =
  | { ok: true }
  | {
    ok: false;
    outcome:
      | "orchestrator_children_incomplete"
      | "child_reconciliation_unavailable"
      | "orchestrator_reduction_incomplete";
    live?: string[];
    children?: string[];
    reason?: string;
  };

export function initialChildContinuationState(): ChildContinuationState {
  return { noProgress: 0 };
}

function setSignature(children: string[]): string {
  return [...new Set(children)].sort().join("\u0000");
}

function afterSuccessfulProviderResult(
  previous: ChildContinuationState,
): ChildContinuationState {
  if (!previous.pendingSettledSignature) return previous;
  return {
    noProgress: previous.noProgress,
    liveSignature: previous.liveSignature,
    acknowledgedSettledSignature: previous.pendingSettledSignature,
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
  // This function is called only after a successful provider result. Therefore
  // a pending settled signature can be acknowledged now: the provider has
  // completed the continuation that North injected for that exact child set.
  const acknowledged = afterSuccessfulProviderResult(previous);
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

const oneColRule = (bindPred: string, subj: string, pred: string, val: string) => ({
  find: bindPred,
  rules: [
    {
      head: { rel: bindPred, args: [{ var: bindPred }] },
      body: [{ rel: "triple", args: [subj === "?" ? { var: bindPred } : subj, pred, val === "?" ? { var: "_v" } : val] }],
    },
  ],
});

// Agents whose `coordinator` fact points at this lane.
function childrenOf(coordId: string): string[] {
  return queryCol(oneColRule("c", "?", "coordinator", coordId));
}

export function resolveChildLifecycle(
  laneFacts: ReturnType<typeof getThreadFacts>,
  readTaggedRuns: () => ReturnType<typeof getThreadFacts>[],
): boolean {
  if (laneResolvedByFacts(laneFacts, [])) return true;
  return laneResolvedByFacts([], readTaggedRuns());
}

// Does this child (subject literal, e.g. "@agent:x") carry a completion signal?
function childResolved(childSubject: string): boolean {
  const bare = childSubject.replace(/^@?agent:/, "");
  const laneFacts = getThreadFacts(`agent:${bare}`);
  return resolveChildLifecycle(laneFacts, () => {
    // The kind predicate is the run writer's commit marker, so a subject
    // carrying agent/outcome body facts but no kind is absent from this join.
    const runs = queryCol({
      find: "r",
      rules: [
        {
          head: { rel: "r", args: [{ var: "r" }] },
          body: [
            { rel: "triple", args: [{ var: "r" }, "agent", bare] },
            { rel: "triple", args: [{ var: "r" }, "kind", "run"] },
          ],
        },
      ],
    });
    return runs.map((run) => getThreadFacts(run.replace(/^@/, "")));
  });
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

export function settleChildren(coordId: string): ChildSettlement {
  return gatherChildSettlement(coordId, childrenOf, childResolved);
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
export function notifyEarlyExitChildren(agentId: string, liveIds: string[], ctx: EarlyExitCtx = {}): void {
  if (!liveIds.length) return;
  for (const { cmd, args } of earlyExitCommands(agentId, liveIds, ctx)) {
    try {
      execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      /* best-effort */
    }
  }
  console.error(`[early-exit] @agent:${agentId} EXITING WITH ${liveIds.length} LIVE CHILD(REN): ${liveIds.join(", ")}`);
}
