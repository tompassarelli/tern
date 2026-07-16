import {
  normalizeLinearIdentity,
  normalizeSyncFields,
  normalizeText,
  normalizeThreadId,
  sameLinearIdentity,
  sha256Canonical,
} from "./normalize";
import {
  parseManagedLinearDescription,
  planLinearCommentMutations,
  replaceManagedLinearDescription,
} from "./projection";
import { NORTH_OWNED_LINEAR_FIELDS } from "./types";
import type {
  LinearApplyPlan,
  LinearFieldReconciliation,
  LinearFieldReconciliationCategory,
  LinearIssueIdentity,
  LinearIssueSnapshot,
  LinearReconciliationResult,
  LinearSyncBaseline,
  LinearSyncField,
  LinearSyncFields,
  LinearThreadProjection,
} from "./types";

const FIELDS: readonly LinearSyncField[] = NORTH_OWNED_LINEAR_FIELDS;
const DESCRIPTION_FIELDS = new Set<LinearSyncField>(["body", "doneWhen", "barEvidence", "repos", "lifecycle"]);

function baselineHash(identity: LinearIssueIdentity, threadId: string, fields: LinearSyncFields): string {
  return sha256Canonical({ identity, threadId, fields });
}

export function createLinearSyncBaseline(
  identityInput: LinearIssueIdentity,
  threadIdInput: string,
  fieldsInput: LinearSyncFields,
): LinearSyncBaseline {
  const identity = normalizeLinearIdentity(identityInput);
  const threadId = normalizeThreadId(threadIdInput);
  const fields = normalizeSyncFields(fieldsInput);
  return { identity, threadId, fields, hash: baselineHash(identity, threadId, fields) };
}

function reconcileField(
  field: LinearSyncField,
  base: LinearSyncFields,
  local: LinearSyncFields,
  remote: LinearSyncFields,
): LinearFieldReconciliation {
  const baseHash = sha256Canonical(base[field]);
  const localHash = sha256Canonical(local[field]);
  const remoteHash = sha256Canonical(remote[field]);
  let category: LinearFieldReconciliationCategory;
  if (localHash === remoteHash) category = localHash === baseHash ? "unchanged" : "converged";
  else if (remoteHash === baseHash) category = "local-change";
  else if (localHash === baseHash) category = "remote-drift";
  else category = "divergent";
  return { field, category, baseHash, localHash, remoteHash };
}

function stateFor(fields: readonly LinearFieldReconciliation[], hasCommentChanges: boolean): LinearReconciliationResult["state"] {
  const conflicts = fields.filter(({ category }) => category === "remote-drift" || category === "divergent");
  if (conflicts.length > 0) {
    const kinds = new Set(conflicts.map(({ category }) => category));
    const hasIndependentLocalChange = fields.some(({ category }) => category === "local-change");
    if (kinds.size > 1 || hasIndependentLocalChange || hasCommentChanges) return "mixed-conflict";
    return kinds.has("divergent") ? "divergent" : "remote-drift";
  }
  return fields.some(({ category }) => category === "local-change") || hasCommentChanges ? "local-ahead" : "in-sync";
}

function malformedDescriptionResult(
  base: LinearSyncBaseline,
  local: LinearThreadProjection,
  remote: LinearIssueSnapshot,
  error: unknown,
): LinearReconciliationResult {
  const remoteTitleFields = normalizeSyncFields({ ...base.fields, title: normalizeText(remote.title) });
  const title = reconcileField("title", base.fields, local.fields, remoteTitleFields);
  const invalidHash = sha256Canonical({ malformedManagedDescription: remote.description ?? "" });
  const descriptionConflicts = FIELDS.filter((field) => DESCRIPTION_FIELDS.has(field)).map((field) => ({
    field,
    category: "divergent" as const,
    baseHash: sha256Canonical(base.fields[field]),
    localHash: sha256Canonical(local.fields[field]),
    remoteHash: invalidHash,
  }));
  const fields = [title, ...descriptionConflicts];
  const conflicts = fields.filter(({ category }) => category === "remote-drift" || category === "divergent");
  return {
    state: title.category === "local-change" ? "mixed-conflict" : "divergent",
    fields,
    conflicts,
    diagnostics: [error instanceof Error ? error.message : String(error)],
    plan: null,
    nextBaseline: null,
  };
}

export function reconcileLinearIssue(input: {
  baseline: LinearSyncBaseline;
  local: LinearThreadProjection;
  remote: LinearIssueSnapshot;
}): LinearReconciliationResult {
  const baseline = createLinearSyncBaseline(input.baseline.identity, input.baseline.threadId, input.baseline.fields);
  if (baseline.hash !== input.baseline.hash) throw new Error("Linear sync baseline hash does not match its contents");
  if (baseline.threadId !== normalizeThreadId(input.local.threadId)) {
    throw new Error(`Linear baseline is for North thread @${baseline.threadId}, not @${input.local.threadId}`);
  }
  if (!sameLinearIdentity(baseline.identity, input.remote)) {
    throw new Error("Linear issue identity does not match the sync baseline");
  }
  const localFields = normalizeSyncFields(input.local.fields);
  let managed: ReturnType<typeof parseManagedLinearDescription>;
  try {
    managed = parseManagedLinearDescription(input.remote.description, baseline.threadId);
  } catch (error) {
    return malformedDescriptionResult(baseline, input.local, input.remote, error);
  }
  const remoteFields = normalizeSyncFields({
    title: normalizeText(input.remote.title),
    body: managed?.body ?? "",
    doneWhen: managed?.doneWhen ?? [],
    barEvidence: managed?.barEvidence ?? [],
    repos: managed?.repos ?? [],
    lifecycle: managed?.lifecycle ?? "speculative",
  });
  const fields = FIELDS.map((field) => reconcileField(field, baseline.fields, localFields, remoteFields));
  const comments = planLinearCommentMutations(input.local.comments, input.remote.comments);
  const state = stateFor(fields, comments.length > 0);
  const conflicts = fields.filter(({ category }) => category === "remote-drift" || category === "divergent");
  if (conflicts.length > 0) {
    return { state, fields, conflicts, diagnostics: [], plan: null, nextBaseline: null };
  }

  const locallyChanged = new Set(fields.filter(({ category }) => category === "local-change").map(({ field }) => field));
  const issue: LinearApplyPlan["issue"] = {};
  if (locallyChanged.has("title")) issue.title = localFields.title;
  if (FIELDS.some((field) => DESCRIPTION_FIELDS.has(field) && locallyChanged.has(field))) {
    issue.description = replaceManagedLinearDescription(input.remote.description, baseline.threadId, localFields);
  }
  const expectedBaseline = createLinearSyncBaseline(baseline.identity, baseline.threadId, localFields);
  const hasIssueChanges = Object.keys(issue).length > 0;
  const hasPlan = hasIssueChanges || comments.length > 0;
  const plan: LinearApplyPlan | null = hasPlan
    ? { issue, comments, expectedBaseline, hash: sha256Canonical({ issue, comments, expectedBaseline }) }
    : null;
  return {
    state,
    fields,
    conflicts: [],
    diagnostics: [],
    plan,
    nextBaseline: plan ? null : expectedBaseline,
  };
}
