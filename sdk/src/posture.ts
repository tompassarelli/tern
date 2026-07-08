import type { Fact } from "./tern-client";

export interface Posture {
  planned: boolean;
  atomic: boolean;
  parentId?: string;
  title: string;
  hasDriver: boolean;
  hasOutcome: boolean;
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
  };
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
    ].join("\n");
  }

  if (posture.atomic) {
    return [
      context,
      "",
      "This task is ATOMIC — it has been planned and cannot be broken down further.",
      "Execute it directly. Don't decompose or delegate.",
      notes ? `\nContext notes:\n${notes}` : "",
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
  ].join("\n");
}
