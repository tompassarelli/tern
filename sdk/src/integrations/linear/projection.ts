import {
  assertNoReservedNorthMarker,
  canonicalJson,
  normalizeBody,
  normalizeLifecycle,
  normalizeStringList,
  normalizeSyncFields,
  normalizeText,
  normalizeThreadId,
  sha256Canonical,
} from "./normalize";
import type {
  LinearCommentMutationPlan,
  LinearRemoteComment,
  LinearSyncFields,
  LinearThreadProjection,
  NorthCommentEvent,
  NorthCommentKind,
  NorthThreadSyncSource,
  ProjectedLinearComment,
} from "./types";

const FIELD_NAMES = ["lifecycle", "body", "done_when", "bar_evidence", "repo"] as const;
type ManagedFieldName = typeof FIELD_NAMES[number];

const COMMENT_MARKER = /<!-- north:comment:(progress|outcome|learning):([0-9a-f]{64}) -->/;

function openingMarker(threadId: string): string {
  return `<!-- north:thread:${threadId} -->`;
}

function closingMarker(threadId: string): string {
  return `<!-- /north:thread:${threadId} -->`;
}

function fieldOpening(name: ManagedFieldName): string {
  return `<!-- north:field:${name} -->`;
}

function fieldClosing(name: ManagedFieldName): string {
  return `<!-- /north:field:${name} -->`;
}

function fieldBlock(name: ManagedFieldName, content: string): string {
  return `${fieldOpening(name)}\n${content}\n${fieldClosing(name)}`;
}

function checkboxLines(values: readonly string[]): string {
  return values.map((value) => `- [ ] ${value}`).join("\n");
}

function bulletLines(values: readonly string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

function validateManagedFields(fields: LinearSyncFields): void {
  assertNoReservedNorthMarker("North thread body", fields.body);
  for (const value of fields.doneWhen) assertNoReservedNorthMarker("North done_when", value);
  for (const value of fields.barEvidence) assertNoReservedNorthMarker("North bar_evidence", value);
  for (const value of fields.repos) assertNoReservedNorthMarker("North repo", value);
}

export function renderManagedLinearBlock(threadIdInput: string, fieldsInput: LinearSyncFields): string {
  const threadId = normalizeThreadId(threadIdInput);
  const fields = normalizeSyncFields(fieldsInput);
  validateManagedFields(fields);
  return [
    openingMarker(threadId),
    `## North thread \`@${threadId}\``,
    "",
    "Lifecycle",
    fieldBlock("lifecycle", fields.lifecycle),
    "",
    "### Body",
    fieldBlock("body", fields.body),
    "",
    "### Done when",
    fieldBlock("done_when", checkboxLines(fields.doneWhen)),
    "",
    "### Bar evidence",
    fieldBlock("bar_evidence", bulletLines(fields.barEvidence)),
    "",
    "### Repositories",
    fieldBlock("repo", bulletLines(fields.repos)),
    closingMarker(threadId),
  ].join("\n");
}

interface ManagedBlockRange {
  threadId: string;
  start: number;
  end: number;
  block: string;
}

function findManagedBlocks(description: string): readonly ManagedBlockRange[] {
  const blocks: ManagedBlockRange[] = [];
  const pattern = /<!-- north:thread:([^>\r\n]+) -->/g;
  for (let match = pattern.exec(description); match; match = pattern.exec(description)) {
    const threadId = match[1]!.trim();
    const close = closingMarker(threadId);
    const closeAt = description.indexOf(close, match.index + match[0].length);
    if (closeAt < 0) throw new Error(`unclosed North-managed Linear block for @${threadId}`);
    const end = closeAt + close.length;
    blocks.push({ threadId, start: match.index, end, block: description.slice(match.index, end) });
    pattern.lastIndex = end;
  }
  return blocks;
}

export function replaceManagedLinearDescription(
  descriptionInput: string | null | undefined,
  threadIdInput: string,
  fields: LinearSyncFields,
): string {
  const description = descriptionInput ?? "";
  const threadId = normalizeThreadId(threadIdInput);
  const managed = renderManagedLinearBlock(threadId, fields);
  const blocks = findManagedBlocks(description);
  const foreign = blocks.find((block) => block.threadId !== threadId);
  if (foreign) {
    throw new Error(`Linear issue is already linked to North thread @${foreign.threadId}`);
  }
  if (blocks.length > 1) throw new Error(`Linear issue contains duplicate North blocks for @${threadId}`);
  const existing = blocks[0];
  if (existing) return `${description.slice(0, existing.start)}${managed}${description.slice(existing.end)}`;
  if (!description) return managed;
  const separator = description.endsWith("\n\n") ? "" : description.endsWith("\n") ? "\n" : "\n\n";
  return `${description}${separator}${managed}`;
}

function extractField(block: string, name: ManagedFieldName): string {
  const open = fieldOpening(name);
  const close = fieldClosing(name);
  const start = block.indexOf(open);
  if (start < 0) return "";
  const contentStart = start + open.length;
  const end = block.indexOf(close, contentStart);
  if (end < 0) throw new Error(`unclosed North-managed Linear field ${name}`);
  return block.slice(contentStart, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function parseList(value: string, checkbox: boolean): readonly string[] {
  const items = value.split(/\r?\n/).flatMap((line) => {
    const match = checkbox ? /^\s*-\s*\[[ xX]\]\s+(.*)$/.exec(line) : /^\s*-\s+(.*)$/.exec(line);
    return match ? [match[1]!] : [];
  });
  return normalizeStringList(items);
}

export function parseManagedLinearDescription(
  descriptionInput: string | null | undefined,
  expectedThreadIdInput: string,
): Omit<LinearSyncFields, "title"> | null {
  const description = descriptionInput ?? "";
  const expectedThreadId = normalizeThreadId(expectedThreadIdInput);
  const blocks = findManagedBlocks(description);
  if (blocks.length === 0) return null;
  if (blocks.length > 1) throw new Error("Linear issue contains multiple North-managed blocks");
  const block = blocks[0]!;
  if (block.threadId !== expectedThreadId) {
    throw new Error(`Linear issue is linked to North thread @${block.threadId}, not @${expectedThreadId}`);
  }
  const parsed = {
    lifecycle: normalizeLifecycle(normalizeText(extractField(block.block, "lifecycle")) as LinearSyncFields["lifecycle"]),
    body: normalizeBody(extractField(block.block, "body")),
    doneWhen: parseList(extractField(block.block, "done_when"), true),
    barEvidence: parseList(extractField(block.block, "bar_evidence"), false),
    repos: parseList(extractField(block.block, "repo"), false),
  };
  assertNoReservedNorthMarker("Linear managed body", parsed.body);
  for (const value of parsed.doneWhen) assertNoReservedNorthMarker("Linear managed done_when", value);
  for (const value of parsed.barEvidence) assertNoReservedNorthMarker("Linear managed bar_evidence", value);
  for (const value of parsed.repos) assertNoReservedNorthMarker("Linear managed repo", value);
  return parsed;
}

function projectedComment(threadId: string, kind: NorthCommentKind, sourceIdInput: string, bodyInput: string): ProjectedLinearComment {
  const body = normalizeBody(bodyInput);
  assertNoReservedNorthMarker(`North ${kind} comment`, body);
  const sourceId = normalizeText(sourceIdInput) || sha256Canonical(body);
  const digest = sha256Canonical({ threadId, kind, sourceId });
  const marker = `<!-- north:comment:${kind}:${digest} -->`;
  const rendered = body ? `${body}\n\n${marker}` : marker;
  return { kind, sourceId, marker, body: rendered, hash: sha256Canonical(rendered) };
}

function eventComments(threadId: string, kind: "progress" | "learning", events: readonly NorthCommentEvent[]): ProjectedLinearComment[] {
  return events.flatMap((event) => {
    const body = normalizeBody(event.body);
    return body ? [projectedComment(threadId, kind, normalizeText(event.id) || sha256Canonical(body), body)] : [];
  });
}

export function projectNorthThread(
  source: NorthThreadSyncSource,
  options: { includeLearning?: boolean } = {},
): LinearThreadProjection {
  const threadId = normalizeThreadId(source.threadId);
  const fields = normalizeSyncFields({
    title: normalizeText(source.title),
    body: normalizeBody(source.body),
    doneWhen: normalizeStringList(source.doneWhen),
    barEvidence: normalizeStringList(source.barEvidence),
    repos: normalizeStringList(source.repos),
    lifecycle: source.lifecycle,
  });
  validateManagedFields(fields);
  const comments = [
    ...eventComments(threadId, "progress", source.progress ?? []),
    ...(normalizeBody(source.outcome) ? [projectedComment(threadId, "outcome", "outcome", normalizeBody(source.outcome))] : []),
    ...(options.includeLearning ? eventComments(threadId, "learning", source.learning ?? []) : []),
  ].sort((left, right) => {
    const leftKey = canonicalJson([left.kind, left.sourceId]);
    const rightKey = canonicalJson([right.kind, right.sourceId]);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return { threadId, fields, comments, hash: sha256Canonical({ threadId, fields, comments }) };
}

export function planLinearCommentMutations(
  projected: readonly ProjectedLinearComment[],
  remoteInput: readonly LinearRemoteComment[] | null | undefined,
): readonly LinearCommentMutationPlan[] {
  const byMarker = new Map<string, LinearRemoteComment>();
  for (const remote of remoteInput ?? []) {
    const match = COMMENT_MARKER.exec(remote.body ?? "");
    if (match) byMarker.set(match[0], remote);
  }
  const plans: LinearCommentMutationPlan[] = [];
  for (const comment of projected) {
    const remote = byMarker.get(comment.marker);
    if (!remote) plans.push({ action: "create", marker: comment.marker, body: comment.body });
    else if (normalizeBody(remote.body) !== normalizeBody(comment.body)) {
      plans.push({ action: "update", commentId: remote.id, marker: comment.marker, body: comment.body });
    }
  }
  return plans;
}
