import type { Fact } from "./north-client";
import type { Topology } from "./routing-metadata";

export interface Posture {
  planned: boolean;
  atomic: boolean;
  parentId?: string;
  title: string;
  hasDriver: boolean;
  hasOutcome: boolean;
  committed: boolean;
  doneWhen: string[];
}

// Derive agent posture from a thread's facts.
// planned: explicit `planned true` fact, or has part_of children (derived externally)
// atomic: planned + no children (leaf node), or explicit `atomic true` fact
export function derivePosture(
  facts: Fact[],
  hasChildren: boolean
): Posture {
  const get = (pred: string) =>
    facts.find((c) => c.predicate === pred)?.value;
  const has = (pred: string) =>
    facts.some((c) => c.predicate === pred);

  const explicitPlanned = get("planned") === "true";
  const explicitAtomic = get("atomic") === "true";
  const planned = explicitPlanned || hasChildren;
  const atomic = explicitAtomic || (planned && !hasChildren);

  return {
    planned,
    atomic,
    parentId: get("part_of")?.replace(/^@/, ""),
    title: get("title") ?? "(untitled)",
    hasDriver: has("driver"),
    hasOutcome: has("outcome"),
    committed: has("committed"),
    // done_when is multi-valued — every fact is one completion criterion, order preserved.
    doneWhen: facts.filter((c) => c.predicate === "done_when").map((c) => c.value),
  };
}

// Managed routing topology and North's thread lifecycle are separate axes.
// A committed worker leaf is accepted executable work even when older graph
// producers did not materialize planned/atomic facts. An orchestrator still
// receives the lifecycle-derived planning posture, while a worker can never
// own a composite thread.
export function deriveManagedDispatchPosture(
  facts: Fact[],
  hasChildren: boolean,
  topology: Topology,
): Posture {
  const posture = derivePosture(facts, hasChildren);
  if (topology === "worker" && hasChildren) {
    throw new Error("managed worker dispatch requires a leaf thread without children");
  }
  if (topology === "worker" && posture.committed) {
    return { ...posture, planned: true, atomic: true };
  }
  return posture;
}

// Build the dynamic prompt injected into the agent based on thread posture.
export function buildPrompt(
  threadId: string,
  posture: Posture,
  facts: Fact[]
): string {
  const context = `Thread: ${posture.title} (@${threadId})`;
  const notes = facts
    .filter((c) => c.predicate === "note")
    .map((c) => c.value)
    .join("\n");

  // Done-bars: completion is gated on observed evidence, not the agent's say-so. Injected
  // into EVERY posture so a barred thread carries its exit criteria regardless of shape.
  const bars = doneBars(threadId, posture);

  if (!posture.planned) {
    return [
      context,
      "",
      "This task has NOT been planned yet. Your job:",
      "1. Investigate what this task requires (read files, understand scope)",
      "2. Break it into atomic subtasks if it's composite",
      "3. Report back with: a plan (subtask titles + what each does), or confirmation that it's atomic and ready to execute directly",
      "",
      "Do NOT execute the task. Plan only. Be specific about file paths and changes.",
      notes ? `\nContext notes:\n${notes}` : "",
      bars,
    ].join("\n");
  }

  if (posture.atomic) {
    return [
      context,
      "",
      "This task is ATOMIC — it has been planned and cannot be broken down further.",
      "Execute it directly. Don't decompose or delegate.",
      notes ? `\nContext notes:\n${notes}` : "",
      bars,
    ].join("\n");
  }

  // Planned but not atomic — has subtasks
  return [
    context,
    "",
    "This task has been decomposed into subtasks.",
    "Check which subtasks are ready (unblocked, no driver, no outcome) and report them.",
    "Do NOT execute subtasks yourself — they will be dispatched separately.",
    notes ? `\nContext notes:\n${notes}` : "",
    bars,
  ].join("\n");
}

// Done-bars block appended to every posture prompt. A barred thread lists its exit criteria
// (probe + expected result) numbered verbatim; a committed thread with no bar is told to
// define one before executing. Returns "" when neither applies (no trailing noise).
function doneBars(threadId: string, posture: Posture): string {
  if (posture.doneWhen.length) {
    return [
      "",
      "DONE-BARS — this thread is done ONLY when each bar below has evidence (probe run + result observed). " +
        "Cite evidence per bar in your report; record with the managed North MCP " +
        "`evidence_record` tool (`mcp__north__evidence_record`) using the exact bar and observed result. " +
        "The tool invocation binds evidence to this exact managed run; a plain thread bar_evidence fact is review text, not delivery proof:",
      ...posture.doneWhen.map((bar, i) => `${i + 1}. ${bar}`),
    ].join("\n");
  }
  if (posture.committed) {
    return [
      "",
      "This thread has NO done-bar. FIRST ACT: define your own — " +
        "use the managed North MCP `tell` tool (`mcp__north__tell`) with " +
        `id \`${threadId}\`, predicate \`done_when\`, and value \`<probe + expected result>\` — before executing.`,
    ].join("\n");
  }
  return "";
}
