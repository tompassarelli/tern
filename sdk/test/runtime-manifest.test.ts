import { expect, test } from "bun:test";
import {
  RUNTIME_MANIFEST_IDENTITY_DOMAIN,
  RUNTIME_MANIFEST_JSON_SCHEMA,
  RUNTIME_MANIFEST_VERSION,
  canonicalRuntimeManifestPayload,
  createRuntimeManifest,
  parseRuntimeManifest,
  runtimeManifestIdentity,
  serializeRuntimeManifest,
  type RuntimeManifestInputV1,
} from "../src/runtime-manifest";

const store = (hash: string, name: string): string => `/nix/store/${hash}-${name}`;
const digest = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);
const northStorePath = store("a".repeat(32), "north-sdk");

const filesystemHostilePathCases = [
  {
    path: `${northStorePath}\u0000suffix`,
    parserError: "canonical immutable /nix/store path",
  },
  {
    path: `${northStorePath}/lone-high-\uD800`,
    parserError: "runtime manifest contains ill-formed Unicode",
  },
  {
    path: `${northStorePath}/lone-low-\uDC00`,
    parserError: "runtime manifest contains ill-formed Unicode",
  },
] as const;

const filesystemSafeUnicodePaths = [
  `${northStorePath}/emoji-\u{1F600}`,
  `${northStorePath}/replacement-\uFFFD`,
  `${northStorePath}/literal-%00`,
] as const;

const input: RuntimeManifestInputV1 = {
  commits: {
    north: commit("1"),
    fram: commit("2"),
    gaffer: commit("3"),
    firnAgentConfig: commit("4"),
  },
  artifacts: {
    north: { path: store("a".repeat(32), "north-sdk"), sha256: digest("5") },
    fram: { path: store("b".repeat(32), "fram-runtime"), sha256: digest("6") },
    gaffer: { path: store("c".repeat(32), "gaffer-catalog") + "/catalog.json", sha256: digest("7") },
    firnAgentConfig: { path: store("d".repeat(32), "agent-config"), sha256: digest("8") },
  },
};

test("runtime manifest v1 has deterministic timestamp-free canonical identity", () => {
  const manifest = createRuntimeManifest(input);
  expect(manifest.version).toBe(RUNTIME_MANIFEST_VERSION);
  expect(manifest.identity).toBe("a64778f9600ae571e7dbbef4eef780b39621935c24814855f5753bf2ab40ec9f");
  expect(manifest.identity).toBe(createRuntimeManifest(structuredClone(input)).identity);
  expect(Object.keys(manifest)).toEqual(["version", "identity", "commits", "artifacts"]);
  expect(Object.keys(manifest)).not.toContain("createdAt");
  expect(Object.keys(manifest)).not.toContain("updatedAt");
  expect(canonicalRuntimeManifestPayload({
    artifacts: input.artifacts,
    commits: input.commits,
    version: RUNTIME_MANIFEST_VERSION,
  })).toBe(JSON.stringify({
    version: RUNTIME_MANIFEST_VERSION,
    commits: input.commits,
    artifacts: input.artifacts,
  }));
  expect(RUNTIME_MANIFEST_IDENTITY_DOMAIN).toBe("north:runtime-manifest-identity:v1");
});

test("strict parser round-trips canonical serialization and recomputes identity", () => {
  const manifest = createRuntimeManifest(input);
  expect(parseRuntimeManifest(serializeRuntimeManifest(manifest))).toEqual(manifest);

  const reordered = JSON.stringify({
    artifacts: manifest.artifacts,
    commits: manifest.commits,
    identity: manifest.identity,
    version: manifest.version,
  });
  expect(parseRuntimeManifest(reordered)).toEqual(manifest);

  const forged = structuredClone(manifest);
  forged.commits.fram = commit("9");
  expect(() => parseRuntimeManifest(JSON.stringify(forged))).toThrow("identity mismatch");
});

test("every pinned commit, artifact path, and digest participates in identity", () => {
  const baseline = createRuntimeManifest(input).identity;
  const mutations: RuntimeManifestInputV1[] = [];
  for (const component of ["north", "fram", "gaffer", "firnAgentConfig"] as const) {
    const changedCommit = structuredClone(input);
    changedCommit.commits[component] = commit("9");
    mutations.push(changedCommit);

    const changedPath = structuredClone(input);
    changedPath.artifacts[component].path += "/changed";
    mutations.push(changedPath);

    const changedDigest = structuredClone(input);
    changedDigest.artifacts[component].sha256 = digest("9");
    mutations.push(changedDigest);
  }
  for (const mutation of mutations)
    expect(createRuntimeManifest(mutation).identity).not.toBe(baseline);
  expect(runtimeManifestIdentity({
    version: RUNTIME_MANIFEST_VERSION,
    commits: input.commits,
    artifacts: input.artifacts,
  })).toBe(baseline);
});

test("strict parser rejects ambiguous or widened manifest shape", () => {
  const manifest = createRuntimeManifest(input);
  const canonical = serializeRuntimeManifest(manifest);
  expect(() => parseRuntimeManifest(canonical.replace(
    `\"identity\":\"${manifest.identity}\"`,
    `\"identity\":\"${manifest.identity}\",\"identity\":\"${manifest.identity}\"`,
  ))).toThrow("duplicate object keys");

  for (const malformed of [
    { ...manifest, activatedAt: "2026-07-21T00:00:00Z" },
    { ...manifest, version: "north:runtime-manifest:v2" },
    { ...manifest, commits: { ...manifest.commits, north: "a".repeat(39) } },
    { ...manifest, commits: { ...manifest.commits, north: "A".repeat(40) } },
    { ...manifest, artifacts: { ...manifest.artifacts, north: {
      ...manifest.artifacts.north, sha256: "A".repeat(64),
    } } },
    { ...manifest, artifacts: { ...manifest.artifacts, north: {
      ...manifest.artifacts.north, extra: true,
    } } },
  ]) {
    expect(() => parseRuntimeManifest(JSON.stringify(malformed))).toThrow();
  }
});

test("artifact paths must be canonical immutable Nix-store paths", () => {
  for (const path of [
    "/tmp/north-runtime",
    "/run/current-system/sw/bin/north",
    `/nix/store/${"a".repeat(31)}-north`,
    `/nix/store/${"a".repeat(32)}-north/../other`,
    `/nix/store/${"a".repeat(32)}-north//catalog.json`,
    `/nix/store/${"a".repeat(32)}-north/`,
  ]) {
    const malformed = structuredClone(input);
    malformed.artifacts.north.path = path;
    expect(() => createRuntimeManifest(malformed)).toThrow("canonical immutable /nix/store path");
  }
});

test("artifact paths reject filesystem-hostile string encodings before identity", () => {
  for (const { path, parserError } of filesystemHostilePathCases) {
    const malformedInput = structuredClone(input);
    malformedInput.artifacts.north.path = path;
    expect(() => createRuntimeManifest(malformedInput)).toThrow(
      "canonical immutable /nix/store path",
    );

    const malformedManifest = structuredClone(createRuntimeManifest(input));
    malformedManifest.artifacts.north.path = path;
    expect(() => parseRuntimeManifest(JSON.stringify(malformedManifest))).toThrow(
      parserError,
    );
  }
});

test("artifact paths preserve filesystem-safe Unicode scalar values", () => {
  for (const path of filesystemSafeUnicodePaths) {
    const validInput = structuredClone(input);
    validInput.artifacts.north.path = path;
    const manifest = createRuntimeManifest(validInput);
    expect(parseRuntimeManifest(serializeRuntimeManifest(manifest))).toEqual(manifest);
  }
});

test("published JSON schema names exact v1 fields and rejects extensions", () => {
  expect(RUNTIME_MANIFEST_JSON_SCHEMA.additionalProperties).toBe(false);
  expect(RUNTIME_MANIFEST_JSON_SCHEMA.required).toEqual([
    "version", "identity", "commits", "artifacts",
  ]);
  expect(RUNTIME_MANIFEST_JSON_SCHEMA.properties.commits.required).toEqual([
    "north", "fram", "gaffer", "firnAgentConfig",
  ]);
  expect(RUNTIME_MANIFEST_JSON_SCHEMA.properties.artifacts.additionalProperties).toBe(false);
  const pathPattern = new RegExp(
    RUNTIME_MANIFEST_JSON_SCHEMA.properties.artifacts.properties.north.properties.path.pattern,
  );
  for (const { path } of filesystemHostilePathCases)
    expect(pathPattern.test(path)).toBe(false);
  for (const path of filesystemSafeUnicodePaths)
    expect(pathPattern.test(path)).toBe(true);
});
