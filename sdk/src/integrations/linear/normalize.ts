import { createHash } from "node:crypto";
import type {
  LinearIssueIdentity,
  LinearIssueReference,
  LinearSyncFields,
  NorthLifecycleCategory,
  Nullable,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RESERVED_MARKER = /<!--\s*\/?north:/i;
const LIFECYCLES = new Set<NorthLifecycleCategory>([
  "speculative", "ready", "blocked", "active", "dormant", "done", "abandoned",
]);

export function normalizeLineEndings(value: Nullable<string>): string {
  return (value ?? "").replace(/\r\n?/g, "\n");
}

export function normalizeText(value: Nullable<string>): string {
  return normalizeLineEndings(value).trim();
}

export function normalizeThreadId(value: Nullable<string>): string {
  const normalized = normalizeText(value);
  if (!THREAD_ID.test(normalized)) {
    throw new Error(`North threadId is not safe for a managed marker: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function assertNoReservedNorthMarker(name: string, value: string): void {
  if (RESERVED_MARKER.test(value)) {
    throw new Error(`${name} contains North's reserved managed-marker namespace`);
  }
}

export function normalizeBody(value: Nullable<string>): string {
  return normalizeLineEndings(value).replace(/[ \t]+$/gm, "").trim();
}

export function normalizeStringList(values: Nullable<readonly Nullable<string>[]>): readonly string[] {
  return [...new Set((values ?? []).map((value) => normalizeText(value).replace(/\n+/g, " ")).filter(Boolean))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function requireNonempty(name: string, value: Nullable<string>): string {
  const normalized = normalizeText(value);
  if (!normalized) throw new Error(`Linear ${name} must be non-empty`);
  return normalized;
}

export function normalizeLinearIdentity(value: LinearIssueReference): LinearIssueIdentity {
  const issueId = requireNonempty("issue UUID", value.issueId).toLowerCase();
  if (!UUID.test(issueId)) throw new Error(`Linear issueId must be a UUID, received ${JSON.stringify(value.issueId)}`);
  return {
    workspaceId: requireNonempty("workspaceId", value.workspaceId),
    issueId,
  };
}

export function linearIdentityKey(value: LinearIssueReference): string {
  const identity = normalizeLinearIdentity(value);
  return `linear:${encodeURIComponent(identity.workspaceId)}:${identity.issueId}`;
}

export function sameLinearIdentity(left: LinearIssueReference, right: LinearIssueReference): boolean {
  return linearIdentityKey(left) === linearIdentityKey(right);
}

export function normalizeLifecycle(value: NorthLifecycleCategory): NorthLifecycleCategory {
  if (!LIFECYCLES.has(value)) throw new Error(`unknown North lifecycle category: ${String(value)}`);
  return value;
}

export function normalizeSyncFields(value: LinearSyncFields): LinearSyncFields {
  return {
    title: normalizeText(value.title),
    body: normalizeBody(value.body),
    doneWhen: normalizeStringList(value.doneWhen),
    barEvidence: normalizeStringList(value.barEvidence),
    repos: normalizeStringList(value.repos),
    lifecycle: normalizeLifecycle(value.lifecycle),
  };
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
