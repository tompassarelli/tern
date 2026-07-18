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
  sha256Text,
} from "./normalize";
import type {
  LinearBootstrapDescriptionAdoption,
  LinearBootstrapDescriptionEvidence,
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

const COMMENT_MARKER_SOURCE = String.raw`<!-- north:comment:(progress|outcome|learning):([0-9a-f]{64}) -->`;
const RESERVED_COMMENT_MARKER = /<!--\s*\/?north:comment/i;

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

/** Return the one structurally valid managed thread marker, or null. */
export function managedLinearThreadId(
  descriptionInput: string | null | undefined,
): string | null {
  const description = descriptionInput ?? "";
  const blocks = findManagedBlocks(description);
  if (!blocks.length) {
    assertNoReservedNorthMarker("Linear unmanaged description", description);
    return null;
  }
  if (blocks.length > 1) throw new Error("Linear issue contains multiple North-managed blocks");
  const threadId = normalizeThreadId(blocks[0]!.threadId);
  parseManagedLinearDescription(description, threadId);
  return threadId;
}

/**
 * Hash the description as Linear is allowed to store it after a bridge write.
 *
 * Linear's Markdown round-trip inserts one blank line at a small, observed set
 * of bridge-owned HTML-comment/heading boundaries. The receipt canonicalizes
 * only those exact boundaries. User-authored text outside the managed block and
 * every byte inside managed fields remain part of the preimage unchanged.
 */
export function managedLinearDescriptionReceiptHash(
  descriptionInput: string | null | undefined,
  expectedThreadIdInput: string,
): string {
  const description = descriptionInput ?? "";
  const expectedThreadId = normalizeThreadId(expectedThreadIdInput);
  const blocks = findManagedBlocks(description);
  if (blocks.length !== 1) {
    throw new Error(`Linear description receipt requires exactly one North-managed block for @${expectedThreadId}`);
  }
  const block = blocks[0]!;
  if (block.threadId !== expectedThreadId) {
    throw new Error(`Linear description receipt is for @${block.threadId}, not @${expectedThreadId}`);
  }

  // Parse first so malformed, duplicated, or foreign reserved structure cannot
  // earn a receipt merely because its raw scaffold happens to hash.
  parseManagedLinearDescription(description, expectedThreadId);

  const boundaries = [
    [openingMarker(expectedThreadId), `## North thread \`@${expectedThreadId}\``],
    ["### Body", fieldOpening("body")],
    ["### Done when", fieldOpening("done_when")],
    ["### Bar evidence", fieldOpening("bar_evidence")],
    ["### Repositories", fieldOpening("repo")],
  ] as const;
  let canonicalBlock = block.block;
  for (const [before, after] of boundaries) {
    const compact = `${before}\n${after}`;
    const linear = `${before}\n\n${after}`;
    const compactCount = canonicalBlock.split(compact).length - 1;
    const linearCount = canonicalBlock.split(linear).length - 1;
    if (compactCount + linearCount !== 1) {
      throw new Error(`Linear description has unexpected bridge scaffold around ${before}`);
    }
    canonicalBlock = canonicalBlock.replace(linear, compact);
  }

  return sha256Canonical({
    version: "linear-managed-description-receipt-v1",
    before: description.slice(0, block.start),
    managed: canonicalBlock,
    after: description.slice(block.end),
  });
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
  if (existing) {
    parseManagedLinearDescription(description, threadId);
    return `${description.slice(0, existing.start)}${managed}${description.slice(existing.end)}`;
  }
  assertNoReservedNorthMarker("Linear unmanaged description", description);
  if (!description) return managed;
  const separator = description.endsWith("\n\n") ? "" : description.endsWith("\n") ? "\n" : "\n\n";
  return `${description}${separator}${managed}`;
}

/**
 * Adopt an import's unchanged raw description into one managed block. The raw
 * body is consumed by that block, not retained as duplicate unmanaged prose.
 */
export function planBootstrapLinearDescriptionAdoption(input: {
  description: string | null | undefined;
  threadId: string;
  fields: LinearSyncFields;
  evidence: LinearBootstrapDescriptionEvidence;
}): LinearBootstrapDescriptionAdoption {
  const description = input.description ?? "";
  const rawDescriptionHash = sha256Text(description);
  try {
    const managed = parseManagedLinearDescription(description, input.threadId);
    if (managed) {
      return { state: "conflict", diagnostic: "Linear description already contains a North-managed block", rawDescriptionHash };
    }
    assertNoReservedNorthMarker("Linear bootstrap description", description);
  } catch (error) {
    return {
      state: "conflict",
      diagnostic: error instanceof Error ? error.message : String(error),
      rawDescriptionHash,
    };
  }
  if (!/^[0-9a-f]{64}$/.test(input.evidence.importedRawDescriptionHash)) {
    return { state: "conflict", diagnostic: "imported Linear description hash is invalid", rawDescriptionHash };
  }
  if (rawDescriptionHash !== input.evidence.importedRawDescriptionHash) {
    return { state: "conflict", diagnostic: "Linear description changed after import", rawDescriptionHash };
  }
  return {
    state: "adopt",
    description: renderManagedLinearBlock(input.threadId, input.fields),
    rawDescriptionHash,
  };
}

function parseList(value: string, checkbox: boolean, field: ManagedFieldName): readonly string[] {
  if (!value) return [];
  const items = value.split("\n").map((line) => {
    const match = checkbox ? /^- \[[ xX]\] (.+)$/.exec(line) : /^- (.+)$/.exec(line);
    if (!match) throw new Error(`North-managed Linear field ${field} contains a malformed nonblank line`);
    const item = match[1]!;
    if (normalizeText(item) !== item)
      throw new Error(`North-managed Linear field ${field} contains non-canonical item whitespace`);
    return item;
  });
  const normalized = normalizeStringList(items);
  if (normalized.length !== items.length)
    throw new Error(`North-managed Linear field ${field} contains duplicate items`);
  return normalized;
}

function parseManagedLinearBlock(
  block: string,
  threadId: string,
): Omit<LinearSyncFields, "title"> {
  let cursor = 0;
  const expectLiteral = (literal: string, label: string): void => {
    if (!block.startsWith(literal, cursor))
      throw new Error(`Linear description has unexpected bridge scaffold at ${label}`);
    cursor += literal.length;
  };
  const expectBridgeBreak = (label: string): void => {
    if (block.startsWith("\n\n", cursor)) cursor += 2;
    else if (block.startsWith("\n", cursor)) cursor += 1;
    else throw new Error(`Linear description has unexpected bridge scaffold at ${label}`);
  };
  const takeField = (name: ManagedFieldName): string => {
    expectLiteral(fieldOpening(name), `${name} opening marker`);
    expectLiteral("\n", `${name} opening line`);
    const close = `\n${fieldClosing(name)}`;
    const closeAt = block.indexOf(close, cursor);
    if (closeAt < 0) throw new Error(`unclosed North-managed Linear field ${name}`);
    const content = block.slice(cursor, closeAt);
    cursor = closeAt + close.length;
    return content;
  };

  expectLiteral(openingMarker(threadId), "thread opening marker");
  expectBridgeBreak("thread heading");
  expectLiteral(`## North thread \`@${threadId}\``, "thread heading");
  expectLiteral("\n\nLifecycle\n", "lifecycle heading");
  const lifecycleRaw = takeField("lifecycle");
  expectLiteral("\n\n### Body", "body heading");
  expectBridgeBreak("body field");
  const body = takeField("body");
  expectLiteral("\n\n### Done when", "done_when heading");
  expectBridgeBreak("done_when field");
  const doneWhenRaw = takeField("done_when");
  expectLiteral("\n\n### Bar evidence", "bar_evidence heading");
  expectBridgeBreak("bar_evidence field");
  const barEvidenceRaw = takeField("bar_evidence");
  expectLiteral("\n\n### Repositories", "repo heading");
  expectBridgeBreak("repo field");
  const reposRaw = takeField("repo");
  expectLiteral("\n", "thread closing marker");
  expectLiteral(closingMarker(threadId), "thread closing marker");
  if (cursor !== block.length)
    throw new Error("Linear description has trailing content inside the North-managed block");

  if (normalizeText(lifecycleRaw) !== lifecycleRaw || lifecycleRaw.includes("\n"))
    throw new Error("North-managed Linear field lifecycle is not canonical");
  if (normalizeBody(body) !== body)
    throw new Error("North-managed Linear field body is not canonical");
  assertNoReservedNorthMarker("Linear managed body", body);
  const doneWhen = parseList(doneWhenRaw, true, "done_when");
  const barEvidence = parseList(barEvidenceRaw, false, "bar_evidence");
  const repos = parseList(reposRaw, false, "repo");
  for (const value of doneWhen) assertNoReservedNorthMarker("Linear managed done_when", value);
  for (const value of barEvidence) assertNoReservedNorthMarker("Linear managed bar_evidence", value);
  for (const value of repos) assertNoReservedNorthMarker("Linear managed repo", value);
  return {
    lifecycle: normalizeLifecycle(lifecycleRaw as LinearSyncFields["lifecycle"]),
    body,
    doneWhen,
    barEvidence,
    repos,
  };
}

export function parseManagedLinearDescription(
  descriptionInput: string | null | undefined,
  expectedThreadIdInput: string,
): Omit<LinearSyncFields, "title"> | null {
  const description = descriptionInput ?? "";
  const expectedThreadId = normalizeThreadId(expectedThreadIdInput);
  const blocks = findManagedBlocks(description);
  if (blocks.length === 0) {
    assertNoReservedNorthMarker("Linear unmanaged description", description);
    return null;
  }
  if (blocks.length > 1) throw new Error("Linear issue contains multiple North-managed blocks");
  const block = blocks[0]!;
  if (block.threadId !== expectedThreadId) {
    throw new Error(`Linear issue is linked to North thread @${block.threadId}, not @${expectedThreadId}`);
  }
  assertNoReservedNorthMarker(
    "Linear unmanaged description",
    `${description.slice(0, block.start)}${description.slice(block.end)}`,
  );
  return parseManagedLinearBlock(block.block, expectedThreadId);
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
  const byMarker = indexManagedLinearComments(remoteInput);
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

/** Parse the reserved comment namespace once for both planning and recovery. */
export function indexManagedLinearComments(
  remoteInput: readonly LinearRemoteComment[] | null | undefined,
): ReadonlyMap<string, LinearRemoteComment> {
  const byMarker = new Map<string, LinearRemoteComment>();
  for (const remote of remoteInput ?? []) {
    const body = remote.body ?? "";
    const markers = [...body.matchAll(new RegExp(COMMENT_MARKER_SOURCE, "g"))].map((match) => match[0]);
    const withoutCanonicalMarkers = body.replace(new RegExp(COMMENT_MARKER_SOURCE, "g"), "");
    if (RESERVED_COMMENT_MARKER.test(withoutCanonicalMarkers)) {
      throw new Error(`Linear comment ${remote.id} contains a malformed or foreign reserved North comment marker`);
    }
    if (markers.length > 1) {
      throw new Error(`Linear comment ${remote.id} contains multiple North-managed comment markers`);
    }
    const marker = markers[0];
    if (!marker) continue;
    const existing = byMarker.get(marker);
    if (existing) {
      throw new Error(`Linear comments ${existing.id} and ${remote.id} contain duplicate North-managed marker ${marker}`);
    }
    byMarker.set(marker, remote);
  }
  return byMarker;
}
