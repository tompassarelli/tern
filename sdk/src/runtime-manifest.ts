import { createHash } from "node:crypto";
import { parseStrictJson } from "./strict-json";

export const RUNTIME_MANIFEST_VERSION = "north:runtime-manifest:v1" as const;
export const RUNTIME_MANIFEST_IDENTITY_DOMAIN = "north:runtime-manifest-identity:v1";
export const MAX_RUNTIME_MANIFEST_UTF8_BYTES = 64 * 1024;

const COMPONENTS = ["north", "fram", "gaffer", "firnAgentConfig"] as const;
const COMMIT_PATTERN = "^[0-9a-f]{40}$";
const SHA256_PATTERN = "^[0-9a-f]{64}$";
// node:fs rejects NUL and maps lone UTF-16 surrogates to U+FFFD during UTF-8 encoding.
// Restricting path text to Unicode scalar values keeps manifest identity bound to filesystem bytes.
const FILESYSTEM_PATH_CHARACTER_PATTERN =
  "(?:[^\\u0000/\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])";
const IMMUTABLE_PATH_PATTERN =
  `^/nix/store/[0-9a-z]{32}-${FILESYSTEM_PATH_CHARACTER_PATTERN}+(?:/${FILESYSTEM_PATH_CHARACTER_PATTERN}+)*$`;

export type RuntimeComponent = typeof COMPONENTS[number];

export interface RuntimeArtifactV1 {
  path: string;
  sha256: string;
}

export type RuntimeCommitsV1 = Record<RuntimeComponent, string>;
export type RuntimeArtifactsV1 = Record<RuntimeComponent, RuntimeArtifactV1>;

export interface RuntimeManifestIdentityPayloadV1 {
  version: typeof RUNTIME_MANIFEST_VERSION;
  commits: RuntimeCommitsV1;
  artifacts: RuntimeArtifactsV1;
}

export interface RuntimeManifestV1 extends RuntimeManifestIdentityPayloadV1 {
  identity: string;
}

export interface RuntimeManifestInputV1 {
  commits: RuntimeCommitsV1;
  artifacts: RuntimeArtifactsV1;
}

const artifactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "sha256"],
  properties: {
    path: { type: "string", pattern: IMMUTABLE_PATH_PATTERN },
    sha256: { type: "string", pattern: SHA256_PATTERN },
  },
} as const;

/** Machine-readable shape. Identity recomputation is enforced by parseRuntimeManifest. */
export const RUNTIME_MANIFEST_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:north:runtime-manifest:v1",
  title: "North runtime manifest v1",
  type: "object",
  additionalProperties: false,
  required: ["version", "identity", "commits", "artifacts"],
  properties: {
    version: { const: RUNTIME_MANIFEST_VERSION },
    identity: { type: "string", pattern: SHA256_PATTERN },
    commits: {
      type: "object",
      additionalProperties: false,
      required: COMPONENTS,
      properties: Object.fromEntries(COMPONENTS.map((component) => [
        component,
        { type: "string", pattern: COMMIT_PATTERN },
      ])),
    },
    artifacts: {
      type: "object",
      additionalProperties: false,
      required: COMPONENTS,
      properties: Object.fromEntries(COMPONENTS.map((component) => [component, artifactSchema])),
    },
  },
} as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unknown = actual.filter((key) => !expected.includes(key));
  if (missing.length || unknown.length) {
    throw new Error([
      `${label} has invalid fields`,
      missing.length ? `missing: ${missing.join(", ")}` : "",
      unknown.length ? `unknown: ${unknown.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }
}

function exactLowerHex(value: unknown, length: number, label: string): string {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`).test(value))
    throw new Error(`${label} must be exactly ${length} lowercase hexadecimal characters`);
  return value;
}

function immutableArtifactPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !new RegExp(IMMUTABLE_PATH_PATTERN).test(value))
    throw new Error(`${label} must be a canonical immutable /nix/store path`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === ".."))
    throw new Error(`${label} must be a canonical immutable /nix/store path`);
  return value;
}

function commits(value: unknown): RuntimeCommitsV1 {
  const source = record(value, "runtime manifest commits");
  exactKeys(source, COMPONENTS, "runtime manifest commits");
  return Object.fromEntries(COMPONENTS.map((component) => [
    component,
    exactLowerHex(source[component], 40, `runtime manifest ${component} commit`),
  ])) as unknown as RuntimeCommitsV1;
}

function artifact(value: unknown, component: RuntimeComponent): RuntimeArtifactV1 {
  const source = record(value, `runtime manifest ${component} artifact`);
  exactKeys(source, ["path", "sha256"], `runtime manifest ${component} artifact`);
  return {
    path: immutableArtifactPath(source.path, `runtime manifest ${component} artifact path`),
    sha256: exactLowerHex(source.sha256, 64, `runtime manifest ${component} artifact sha256`),
  };
}

function artifacts(value: unknown): RuntimeArtifactsV1 {
  const source = record(value, "runtime manifest artifacts");
  exactKeys(source, COMPONENTS, "runtime manifest artifacts");
  return Object.fromEntries(COMPONENTS.map((component) => [
    component,
    artifact(source[component], component),
  ])) as unknown as RuntimeArtifactsV1;
}

function identityPayload(value: unknown): RuntimeManifestIdentityPayloadV1 {
  const source = record(value, "runtime manifest identity payload");
  exactKeys(source, ["version", "commits", "artifacts"], "runtime manifest identity payload");
  if (source.version !== RUNTIME_MANIFEST_VERSION)
    throw new Error(`runtime manifest version must be ${RUNTIME_MANIFEST_VERSION}`);
  return {
    version: RUNTIME_MANIFEST_VERSION,
    commits: commits(source.commits),
    artifacts: artifacts(source.artifacts),
  };
}

/** Fixed key order makes this byte string the cross-runtime identity contract. */
export function canonicalRuntimeManifestPayload(value: unknown): string {
  return JSON.stringify(identityPayload(value));
}

export function runtimeManifestIdentity(value: unknown): string {
  const payload = canonicalRuntimeManifestPayload(value);
  return createHash("sha256")
    .update(`${RUNTIME_MANIFEST_IDENTITY_DOMAIN}\n${payload}`, "utf8")
    .digest("hex");
}

export function createRuntimeManifest(value: RuntimeManifestInputV1): RuntimeManifestV1 {
  const payload = identityPayload({ version: RUNTIME_MANIFEST_VERSION, ...value });
  return {
    version: payload.version,
    identity: runtimeManifestIdentity(payload),
    commits: payload.commits,
    artifacts: payload.artifacts,
  };
}

export function serializeRuntimeManifest(value: RuntimeManifestV1): string {
  const parsed = validateRuntimeManifest(value);
  return JSON.stringify(parsed);
}

export function validateRuntimeManifest(value: unknown): RuntimeManifestV1 {
  const source = record(value, "runtime manifest");
  exactKeys(source, ["version", "identity", "commits", "artifacts"], "runtime manifest");
  const payload = identityPayload({
    version: source.version,
    commits: source.commits,
    artifacts: source.artifacts,
  });
  const identity = exactLowerHex(source.identity, 64, "runtime manifest identity");
  const expected = runtimeManifestIdentity(payload);
  if (identity !== expected)
    throw new Error(`runtime manifest identity mismatch: expected ${expected}`);
  return {
    version: payload.version,
    identity,
    commits: payload.commits,
    artifacts: payload.artifacts,
  };
}

export function parseRuntimeManifest(text: string): RuntimeManifestV1 {
  return validateRuntimeManifest(parseStrictJson(text, "runtime manifest", {
    maxBytes: MAX_RUNTIME_MANIFEST_UTF8_BYTES,
    maxDepth: 8,
    maxNodes: 64,
  }));
}
