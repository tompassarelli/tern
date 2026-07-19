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
// Shared with reserve-link.clj: Unicode White_Space, every control, and BOM
// are forbidden anywhere in an identity-authority token.
const AUTHORITY_FORBIDDEN = /[\p{White_Space}\p{Cc}\uFEFF]/u;
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
  if (value !== normalized || AUTHORITY_FORBIDDEN.test(normalized)
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
  if (!value || value !== value.trim() || AUTHORITY_FORBIDDEN.test(value)
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

/**
 * Linear identity-authority timestamp profile: an RFC3339-shaped full
 * date-time with seconds and an explicit known offset no wider than ±14:00.
 * Leap seconds and the `-00:00` unknown-offset sentinel are unsupported;
 * precision beyond milliseconds is accepted only when every discarded digit
 * is zero.
 */
export function canonicalLinearInstant(value: Nullable<string>, name: string): string {
  const exact = normalizeLinearOpaqueToken(name, value, 128);
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|([+-])([0-9]{2}):([0-9]{2}))$/.exec(exact);
  if (!match)
    throw new Error(`Linear ${name} is not a supported canonical instant`);
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw,
    fraction = "", zone, offsetSign, offsetHourRaw, offsetMinuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const offsetHour = Number(offsetHourRaw ?? 0);
  const offsetMinute = Number(offsetMinuteRaw ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31, leap ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31,
  ];
  if (month < 1 || month > 12
      || day < 1 || day > monthDays[month - 1]!
      || hour > 23 || minute > 59 || second > 59
      || (zone !== "Z"
        && (offsetHour > 14 || offsetMinute > 59
          || (offsetHour === 14 && offsetMinute !== 0)
          || (offsetSign === "-" && offsetHour === 0 && offsetMinute === 0)))) {
    throw new Error(`Linear ${name} is not a supported canonical instant`);
  }
  if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3)))
    throw new Error(`Linear ${name} has unsupported sub-millisecond precision`);
  const parsed = Date.parse(exact);
  if (!Number.isFinite(parsed))
    throw new Error(`Linear ${name} is not a supported canonical instant`);
  return new Date(parsed).toISOString();
}

export function normalizeLinearRemoteKey(value: Nullable<string>): string {
  const normalized = requireNonempty("issue key", value);
  if (value !== normalized || AUTHORITY_FORBIDDEN.test(normalized)
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
