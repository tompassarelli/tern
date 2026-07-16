export type Nullable<T> = T | null | undefined;

export interface LinearIssueIdentity {
  workspaceId: string;
  issueId: string;
}

export interface LinearIssueReference extends LinearIssueIdentity {
  /** Human-facing and mutable (for example, MSA-123). Never part of identity. */
  identifier?: Nullable<string>;
  /** Mutable team/broker scope metadata. A team transfer must not relink the issue. */
  scopeId?: Nullable<string>;
}

export type NorthLifecycleCategory =
  | "speculative"
  | "ready"
  | "blocked"
  | "active"
  | "dormant"
  | "done"
  | "abandoned";

export interface NorthCommentEvent {
  /** A stable source event/fact id. Content hashing is the compatibility fallback. */
  id?: Nullable<string>;
  body: Nullable<string>;
}

export interface NorthThreadSyncSource {
  threadId: string;
  title: Nullable<string>;
  body?: Nullable<string>;
  doneWhen?: Nullable<readonly Nullable<string>[]>;
  barEvidence?: Nullable<readonly Nullable<string>[]>;
  repos?: Nullable<readonly Nullable<string>[]>;
  lifecycle: NorthLifecycleCategory;
  progress?: Nullable<readonly NorthCommentEvent[]>;
  outcome?: Nullable<string>;
  learning?: Nullable<readonly NorthCommentEvent[]>;
}

export interface LinearSyncFields {
  title: string;
  body: string;
  doneWhen: readonly string[];
  barEvidence: readonly string[];
  repos: readonly string[];
  lifecycle: NorthLifecycleCategory;
}

export type NorthCommentKind = "progress" | "outcome" | "learning";

export interface ProjectedLinearComment {
  kind: NorthCommentKind;
  sourceId: string;
  marker: string;
  body: string;
  hash: string;
}

export interface LinearThreadProjection {
  threadId: string;
  fields: LinearSyncFields;
  comments: readonly ProjectedLinearComment[];
  hash: string;
}

export interface LinearRemoteComment {
  id: string;
  body: Nullable<string>;
}

export interface LinearIssueSnapshot extends LinearIssueReference {
  title: Nullable<string>;
  description?: Nullable<string>;
  comments?: Nullable<readonly LinearRemoteComment[]>;
}

export interface LinearSyncBaseline {
  identity: LinearIssueIdentity;
  threadId: string;
  fields: LinearSyncFields;
  hash: string;
}

/** Linear is a projection: remote edits to these fields are drift, not authority. */
export const NORTH_OWNED_LINEAR_FIELDS = [
  "title", "body", "doneWhen", "barEvidence", "repos", "lifecycle",
] as const satisfies readonly (keyof LinearSyncFields)[];

export type LinearSyncField = typeof NORTH_OWNED_LINEAR_FIELDS[number];

export type LinearFieldReconciliationCategory =
  | "unchanged"
  | "local-change"
  | "remote-drift"
  | "converged"
  | "divergent";

export interface LinearFieldReconciliation {
  field: LinearSyncField;
  category: LinearFieldReconciliationCategory;
  baseHash: string;
  localHash: string;
  remoteHash: string;
}

export interface LinearCommentCreatePlan {
  action: "create";
  marker: string;
  body: string;
}

export interface LinearCommentUpdatePlan {
  action: "update";
  commentId: string;
  marker: string;
  body: string;
}

export type LinearCommentMutationPlan = LinearCommentCreatePlan | LinearCommentUpdatePlan;

export interface LinearIssueUpdatePayload {
  title?: string;
  description?: string;
}

export interface LinearApplyPlan {
  issue: LinearIssueUpdatePayload;
  comments: readonly LinearCommentMutationPlan[];
  expectedBaseline: LinearSyncBaseline;
  hash: string;
}

export type LinearReconciliationState =
  | "in-sync"
  | "local-ahead"
  | "remote-drift"
  | "divergent"
  | "mixed-conflict";

export interface LinearReconciliationResult {
  state: LinearReconciliationState;
  fields: readonly LinearFieldReconciliation[];
  conflicts: readonly LinearFieldReconciliation[];
  diagnostics: readonly string[];
  /** Present only when every North-owned field can be applied without conflict. */
  plan: LinearApplyPlan | null;
  /** Advances on semantic convergence. Persist only after a successful plan, if one exists. */
  nextBaseline: LinearSyncBaseline | null;
}
