import { createHash } from "node:crypto";
import type {
  LinearIssueIdentity,
  LinearIssueReference,
  LinearSyncFields,
  NorthLifecycleCategory,
  Nullable,
} from "./types";
import { assertWellFormedUnicode } from "../../strict-json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RESERVED_MARKER = /<!--\s*\/?north:/i;
export const MAX_LINEAR_CONNECTOR_BYTES = 256;
export const MAX_LINEAR_REMOTE_KEY_BYTES = 512;
export const MAX_LINEAR_THREAD_ID_BYTES = 512;
export const MAX_LINEAR_OPAQUE_TOKEN_BYTES = 512;
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
  if (typeof value !== "string")
    throw new Error(`North threadId is not safe for a managed marker: ${JSON.stringify(value)}`);
  const normalized = normalizeText(value);
  if (value !== normalized || !THREAD_ID.test(normalized)
      || utf8Bytes(normalized) > MAX_LINEAR_THREAD_ID_BYTES) {
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
  if (typeof value !== "string") throw new Error(`Linear ${name} must be a string`);
  assertWellFormedUnicode(value, `Linear ${name}`);
  const normalized = normalizeText(value);
  if (!normalized) throw new Error(`Linear ${name} must be non-empty`);
  return normalized;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizeLinearConnector(value: Nullable<string>): string {
  const normalized = requireNonempty("connector", value);
  if (value !== normalized || /\s|[\u0000-\u001f\u007f]/u.test(normalized)
      || utf8Bytes(normalized) > MAX_LINEAR_CONNECTOR_BYTES)
    throw new Error(`Linear connector must be canonical and at most ${MAX_LINEAR_CONNECTOR_BYTES} UTF-8 bytes`);
  return normalized;
}

export function normalizeLinearOpaqueToken(
  name: string,
  value: Nullable<string>,
  maxBytes = MAX_LINEAR_OPAQUE_TOKEN_BYTES,
): string {
  if (typeof value !== "string") throw new Error(`Linear ${name} must be a string`);
  assertWellFormedUnicode(value, `Linear ${name}`);
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
      || utf8Bytes(value) > maxBytes)
    throw new Error(`Linear ${name} must be canonical and at most ${maxBytes} UTF-8 bytes`);
  return value;
}

/**
 * UUID case policy: accept either uniform/mixed hexadecimal case at intake,
 * reject surrounding padding/control bytes, and store lowercase canonically.
 */
export function normalizeLinearUuid(name: string, value: Nullable<string>): string {
  const exact = normalizeLinearOpaqueToken(name, value, 64);
  if (!UUID.test(exact))
    throw new Error(`Linear ${name} must be a UUID, received ${JSON.stringify(value)}`);
  return exact.toLowerCase();
}

export function canonicalLinearInstant(value: Nullable<string>, name: string): string {
  const exact = normalizeLinearOpaqueToken(name, value, 128);
  const parsed = Date.parse(exact);
  if (!Number.isFinite(parsed))
    throw new Error(`Linear ${name} is not a valid timestamp`);
  return new Date(parsed).toISOString();
}

export function normalizeLinearRemoteKey(value: Nullable<string>): string {
  const normalized = requireNonempty("issue key", value);
  if (value !== normalized || /\s|[\u0000-\u001f\u007f]/u.test(normalized)
      || utf8Bytes(normalized) > MAX_LINEAR_REMOTE_KEY_BYTES)
    throw new Error(`Linear issue key must be canonical and at most ${MAX_LINEAR_REMOTE_KEY_BYTES} UTF-8 bytes`);
  return normalized;
}

export function normalizeLinearIdentity(value: LinearIssueReference): LinearIssueIdentity {
  if (value.identityKind === "linear-uuid") {
    const workspaceId = normalizeLinearUuid("workspaceId", value.workspaceId);
    const issueId = normalizeLinearUuid("issueId", value.issueId);
    return { identityKind: "linear-uuid", workspaceId, issueId };
  }
  if (value.identityKind === "mcp-bootstrap-v1" || value.identityKind === "mcp-bootstrap-v2") {
    const fingerprint = requireNonempty("connector fingerprint", value.fingerprint).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fingerprint))
      throw new Error(`Linear connector fingerprint must be 64 lowercase hex characters, received ${JSON.stringify(value.fingerprint)}`);
    return {
      identityKind: value.identityKind,
      connector: normalizeLinearConnector(value.connector),
      fingerprint,
    };
  }
  throw new Error(`unknown Linear identity kind: ${String((value as { identityKind?: unknown }).identityKind)}`);
}

export function linearIdentityKey(value: LinearIssueReference): string {
  const identity = normalizeLinearIdentity(value);
  return identity.identityKind === "linear-uuid"
    ? `linear:uuid:${encodeURIComponent(identity.workspaceId)}:${identity.issueId}`
    : `linear:${identity.identityKind}:${encodeURIComponent(identity.connector)}:${identity.fingerprint}`;
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
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
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

/** Hash exact UTF-8 text bytes. Unlike canonical JSON hashing, line endings remain significant. */
export function sha256Text(value: Nullable<string>): string {
  return createHash("sha256").update(value ?? "", "utf8").digest("hex");
}
