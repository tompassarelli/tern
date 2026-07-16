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
  planBootstrapLinearDescriptionAdoption,
  planLinearCommentMutations,
  replaceManagedLinearDescription,
} from "./projection";
import { NORTH_OWNED_LINEAR_FIELDS } from "./types";
import type {
  LinearApplyPlan,
  LinearBootstrapDescriptionEvidence,
  LinearFieldReconciliation,
  LinearFieldReconciliationCategory,
  LinearIssueIdentity,
  LinearIssueSnapshot,
  LinearReconciliationResult,
  LinearSyncBaseline,
  LinearSyncField,
  LinearSyncFieldHashes,
  LinearSyncFields,
  LinearThreadProjection,
} from "./types";

const FIELDS: readonly LinearSyncField[] = NORTH_OWNED_LINEAR_FIELDS;
const DESCRIPTION_FIELDS = new Set<LinearSyncField>(["body", "doneWhen", "barEvidence", "repos", "lifecycle"]);
const SHA256 = /^[0-9a-f]{64}$/;

function hashesForFields(fields: LinearSyncFields): LinearSyncFieldHashes {
  return {
    title: sha256Canonical(fields.title),
    body: sha256Canonical(fields.body),
    doneWhen: sha256Canonical(fields.doneWhen),
    barEvidence: sha256Canonical(fields.barEvidence),
    repos: sha256Canonical(fields.repos),
    lifecycle: sha256Canonical(fields.lifecycle),
  };
}

function normalizeFieldHashes(value: LinearSyncFieldHashes): LinearSyncFieldHashes {
  const hash = (field: LinearSyncField): string => {
    const hash = value?.[field];
    if (!SHA256.test(hash)) throw new Error(`Linear sync baseline ${field} hash is invalid`);
    return hash;
  };
  return {
    title: hash("title"),
    body: hash("body"),
    doneWhen: hash("doneWhen"),
    barEvidence: hash("barEvidence"),
    repos: hash("repos"),
    lifecycle: hash("lifecycle"),
  };
}

function baselineHash(identity: LinearIssueIdentity, threadId: string, fieldHashes: LinearSyncFieldHashes): string {
  return sha256Canonical({ identity, threadId, fieldHashes });
}

export function createLinearSyncBaseline(
  identityInput: LinearIssueIdentity,
  threadIdInput: string,
  fieldsInput: LinearSyncFields,
): LinearSyncBaseline {
  const identity = normalizeLinearIdentity(identityInput);
  const threadId = normalizeThreadId(threadIdInput);
  const fields = normalizeSyncFields(fieldsInput);
  const fieldHashes = hashesForFields(fields);
  return { identity, threadId, fieldHashes, hash: baselineHash(identity, threadId, fieldHashes) };
}

export function validateLinearSyncBaseline(value: LinearSyncBaseline): LinearSyncBaseline {
  const identity = normalizeLinearIdentity(value.identity);
  const threadId = normalizeThreadId(value.threadId);
  const fieldHashes = normalizeFieldHashes(value.fieldHashes);
  const hash = baselineHash(identity, threadId, fieldHashes);
  if (hash !== value.hash) throw new Error("Linear sync baseline hash does not match its contents");
  return { identity, threadId, fieldHashes, hash };
}

function reconcileFieldHashes(
  field: LinearSyncField,
  baseHash: string,
  localHash: string,
  remoteHash: string,
): LinearFieldReconciliation {
  let category: LinearFieldReconciliationCategory;
  if (localHash === remoteHash) category = localHash === baseHash ? "unchanged" : "converged";
  else if (remoteHash === baseHash) category = "local-change";
  else if (localHash === baseHash) category = "remote-drift";
  else category = "divergent";
  return { field, category, baseHash, localHash, remoteHash };
}

function reconcileField(
  field: LinearSyncField,
  base: LinearSyncBaseline,
  local: LinearSyncFields,
  remote: LinearSyncFields,
): LinearFieldReconciliation {
  return reconcileFieldHashes(field, base.fieldHashes[field], sha256Canonical(local[field]), sha256Canonical(remote[field]));
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
  const title = reconcileFieldHashes(
    "title", base.fieldHashes.title, sha256Canonical(local.fields.title), sha256Canonical(normalizeText(remote.title)),
  );
  const invalidHash = sha256Canonical({ malformedManagedDescription: remote.description ?? "" });
  const descriptionConflicts = FIELDS.filter((field) => DESCRIPTION_FIELDS.has(field)).map((field) => ({
    field,
    category: "divergent" as const,
    baseHash: base.fieldHashes[field],
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

function bootstrapConflictResult(
  base: LinearSyncBaseline,
  local: LinearThreadProjection,
  remote: LinearIssueSnapshot,
  diagnostic: string,
  rawDescriptionHash: string,
): LinearReconciliationResult {
  const localFields = normalizeSyncFields(local.fields);
  const title = reconcileFieldHashes(
    "title", base.fieldHashes.title, sha256Canonical(localFields.title), sha256Canonical(normalizeText(remote.title)),
  );
  const poisonedBodyHash = sha256Canonical({ bootstrapRawDescriptionHash: rawDescriptionHash });
  const description = FIELDS.filter((field) => DESCRIPTION_FIELDS.has(field)).map((field) => {
    const localHash = sha256Canonical(localFields[field]);
    return reconcileFieldHashes(field, base.fieldHashes[field], localHash,
      field === "body" ? poisonedBodyHash : base.fieldHashes[field]);
  });
  const fields = [title, ...description];
  const conflicts = fields.filter(({ category }) => category === "remote-drift" || category === "divergent");
  return {
    state: stateFor(fields, false), fields, conflicts, diagnostics: [diagnostic], plan: null, nextBaseline: null,
  };
}

export function reconcileLinearIssue(input: {
  baseline: LinearSyncBaseline;
  local: LinearThreadProjection;
  remote: LinearIssueSnapshot;
  bootstrap?: LinearBootstrapDescriptionEvidence;
}): LinearReconciliationResult {
  const baseline = validateLinearSyncBaseline(input.baseline);
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
  const adoption = !managed && input.bootstrap ? planBootstrapLinearDescriptionAdoption({
    description: input.remote.description,
    threadId: baseline.threadId,
    fields: localFields,
    evidence: input.bootstrap,
  }) : null;
  if (adoption?.state === "conflict") {
    return bootstrapConflictResult(baseline, input.local, input.remote, adoption.diagnostic, adoption.rawDescriptionHash);
  }
  const remoteFields = managed ? normalizeSyncFields({
    title: normalizeText(input.remote.title),
    body: managed.body,
    doneWhen: managed.doneWhen,
    barEvidence: managed.barEvidence,
    repos: managed.repos,
    lifecycle: managed.lifecycle,
  }) : null;
  const absentFields = remoteFields ? null : normalizeSyncFields({
    title: normalizeText(input.remote.title), body: "", doneWhen: [], barEvidence: [], repos: [], lifecycle: "speculative",
  });
  const fields = FIELDS.map((field) => {
    if (field === "title") {
      return reconcileFieldHashes(field, baseline.fieldHashes[field], sha256Canonical(localFields[field]),
        sha256Canonical(normalizeText(input.remote.title)));
    }
    if (adoption?.state === "adopt") {
      return reconcileFieldHashes(field, baseline.fieldHashes[field], sha256Canonical(localFields[field]), baseline.fieldHashes[field]);
    }
    return reconcileField(field, baseline, localFields, remoteFields ?? absentFields!);
  });
  const comments = planLinearCommentMutations(input.local.comments, input.remote.comments);
  const forceDescriptionAdoption = adoption?.state === "adopt";
  const state = stateFor(fields, comments.length > 0 || forceDescriptionAdoption);
  const conflicts = fields.filter(({ category }) => category === "remote-drift" || category === "divergent");
  if (conflicts.length > 0) {
    return { state, fields, conflicts, diagnostics: [], plan: null, nextBaseline: null };
  }

  const locallyChanged = new Set(fields.filter(({ category }) => category === "local-change").map(({ field }) => field));
  const issue: LinearApplyPlan["issue"] = {};
  if (locallyChanged.has("title")) issue.title = localFields.title;
  if (forceDescriptionAdoption) {
    issue.description = adoption.description;
  } else if (FIELDS.some((field) => DESCRIPTION_FIELDS.has(field) && locallyChanged.has(field))) {
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
