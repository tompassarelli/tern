export type Nullable<T> = T | null | undefined;

export interface LinearUuidIdentity {
  identityKind: "linear-uuid";
  /** Native Linear workspace UUID. */
  workspaceId: string;
  /** Native immutable Linear issue UUID. */
  issueId: string;
}

export interface LinearMcpBootstrapV1Identity {
  identityKind: "mcp-bootstrap-v1";
  /** Configured MCP server name: the connector namespace, not a Linear workspace UUID. */
  connector: string;
  /** Legacy SHA-256 of connector + createdAt + initial key; never sent to Linear. */
  fingerprint: string;
}

export interface LinearMcpBootstrapV2Identity {
  identityKind: "mcp-bootstrap-v2";
  /** Configured MCP server name: the connector namespace, not a Linear workspace UUID. */
  connector: string;
  /**
   * SHA-256 of connector + canonical createdAt. Timestamp collisions fail
   * closed unless an exact managed marker proves the existing thread.
   */
  fingerprint: string;
}

export type LinearIssueIdentity =
  | LinearUuidIdentity
  | LinearMcpBootstrapV1Identity
  | LinearMcpBootstrapV2Identity;

interface LinearMutableReferenceMetadata {
  /** Human-facing and mutable (for example, MSA-123). Never part of identity. */
  identifier?: Nullable<string>;
  /** Mutable team/broker scope metadata. A team transfer must not relink the issue. */
  scopeId?: Nullable<string>;
}

export type LinearIssueReference = LinearIssueIdentity & LinearMutableReferenceMetadata;

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

export type LinearIssueSnapshot = LinearIssueReference & {
  title: Nullable<string>;
  description?: Nullable<string>;
  comments?: Nullable<readonly LinearRemoteComment[]>;
};

/** Linear is a projection: remote edits to these fields are drift, not authority. */
export const NORTH_OWNED_LINEAR_FIELDS = [
  "title", "body", "doneWhen", "barEvidence", "repos", "lifecycle",
] as const satisfies readonly (keyof LinearSyncFields)[];

export type LinearSyncField = typeof NORTH_OWNED_LINEAR_FIELDS[number];

export type LinearSyncFieldHashes = {
  readonly [Field in LinearSyncField]: string;
};

/** Serialized synchronization state. Field content remains in North, never duplicated here. */
export interface LinearSyncBaseline {
  identity: LinearIssueIdentity;
  threadId: string;
  fieldHashes: LinearSyncFieldHashes;
  hash: string;
}

export interface LinearBootstrapDescriptionEvidence {
  /** SHA-256 of the exact imported description bytes, including original line endings. */
  importedRawDescriptionHash: string;
}

export type LinearBootstrapDescriptionAdoption =
  | { state: "adopt"; description: string; rawDescriptionHash: string }
  | { state: "conflict"; diagnostic: string; rawDescriptionHash: string };

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
