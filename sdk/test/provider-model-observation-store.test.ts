import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTHROPIC_MODEL_OBSERVATION_SOURCE,
  failedProviderModelObservation,
  MAX_PROVIDER_MODEL_OBSERVATION_STORE_BYTES,
  MAX_PROVIDER_MODEL_OBSERVATION_TARGETS,
  MAX_PROVIDER_MODELS_PER_TARGET,
  modelAdmissionReceipt,
  modelObservationForTarget,
  parseProviderModelObservationStore,
  providerModelObservationIsFresh,
  readProviderModelObservations,
  validateModelAdmissionReceipt,
  writeProviderModelObservation,
  type ProviderModelObservation,
} from "../src/provider-model-observation-store";
import {
  AnthropicModelsUnavailableError,
  normalizeAnthropicSupportedModels,
} from "../src/providers/anthropic-models";
import type { RoutingTarget } from "../src/providers/types";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function temporaryStore(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "north-model-observations-"));
  roots.push(root);
  return join(root, "observations.json");
}

const ambient: RoutingTarget = {
  id: "claude-personal", provider: "anthropic", authMode: "ambient",
};
const isolated: RoutingTarget = {
  id: "claude-work", provider: "anthropic", authMode: "isolated", profile: "work",
};
const now = new Date("2026-07-20T10:00:00.000Z");

function observation(
  target: RoutingTarget,
  models = ["claude-fable-5"],
  observedAt = now,
): ProviderModelObservation {
  return normalizeAnthropicSupportedModels(
    models.map((value) => ({ value, displayName: "PRIVATE CANARY" })),
    target,
    observedAt,
  );
}

test("supportedModels trusts only value, maps Gaffer aliases, and detects normalized collisions", () => {
  expect(normalizeAnthropicSupportedModels([
    { value: "fable", displayName: "not authority", description: "PRIVATE CANARY" },
    { value: "future-provider-model", aliases: ["fable"] },
  ], ambient, now).models).toEqual(["claude-fable-5"]);
  expect(normalizeAnthropicSupportedModels([], ambient, now).models).toEqual([]);
  expect(() => normalizeAnthropicSupportedModels([
    { value: "fable" }, { value: "claude-fable-5" },
  ], ambient, now)).toThrow(AnthropicModelsUnavailableError);
  try {
    normalizeAnthropicSupportedModels([{ value: "fable" }, { value: "claude-fable-5" }], ambient, now);
  } catch (error) {
    expect((error as AnthropicModelsUnavailableError).reason).toBe("anthropic_models_collision");
  }
  expect(() => normalizeAnthropicSupportedModels([{ displayName: "fable" }], ambient, now))
    .toThrow("anthropic_models_response_schema_changed");
});

test("strict store rejects future, malformed, duplicate-target, and unknown model evidence", () => {
  const valid = observation(ambient);
  const store = { version: 1, observations: [valid] };
  expect(parseProviderModelObservationStore(store, now)).toEqual(store);
  expect(() => parseProviderModelObservationStore({
    version: 1,
    observations: [{ ...valid, observedAt: new Date(now.getTime() + 1).toISOString() }],
  }, now)).toThrow("future-dated");
  expect(() => parseProviderModelObservationStore({
    version: 1, observations: [{ ...valid, models: ["claude-fable-5", "claude-fable-5"] }],
  }, now)).toThrow("not canonical");
  expect(() => parseProviderModelObservationStore({
    version: 1, observations: [{ ...valid, models: ["unknown-model"] }],
  }, now)).toThrow("not an exact Gaffer declaration");
  expect(() => parseProviderModelObservationStore({
    version: 1, observations: [valid, valid],
  }, now)).toThrow("duplicate target");
  expect(() => parseProviderModelObservationStore({ version: 2, observations: [] }, now))
    .toThrow("schema changed");
});

test("store byte, target, model, identifier, and reason cardinalities are bounded", async () => {
  const path = await temporaryStore();
  await writeFile(path, Buffer.alloc(MAX_PROVIDER_MODEL_OBSERVATION_STORE_BYTES + 1, 0x20));
  await expect(readProviderModelObservations(path, now)).rejects.toThrow("exceeds byte ceiling");

  const valid = observation(ambient);
  expect(() => parseProviderModelObservationStore({
    version: 1,
    observations: Array.from(
      { length: MAX_PROVIDER_MODEL_OBSERVATION_TARGETS + 1 }, () => valid,
    ),
  }, now)).toThrow("schema changed");
  expect(() => parseProviderModelObservationStore({
    version: 1,
    observations: [{
      ...valid,
      models: Array.from({ length: MAX_PROVIDER_MODELS_PER_TARGET + 1 }, () => "claude-fable-5"),
    }],
  }, now)).toThrow("schema changed");
  expect(() => parseProviderModelObservationStore({
    version: 1, observations: [{ ...valid, models: ["x".repeat(257)] }],
  }, now)).toThrow("malformed");
  expect(() => parseProviderModelObservationStore({
    version: 1, observations: [{
      ...valid,
      models: [],
      collectionFailure: { observedAt: now.toISOString(), reason: "x".repeat(129) },
    }],
  }, now)).toThrow("collection failure is malformed");
});

test("observations stay target/auth scoped and concurrent writes remain atomic mode 0600", async () => {
  const path = await temporaryStore();
  await Promise.all([
    writeProviderModelObservation(observation(ambient), path, now),
    writeProviderModelObservation(observation(isolated, ["claude-opus-4-8"]), path, now),
  ]);
  const store = await readProviderModelObservations(path, now);
  expect(store?.observations).toHaveLength(2);
  expect(modelObservationForTarget(store, ambient)?.models).toEqual(["claude-fable-5"]);
  expect(modelObservationForTarget(store, isolated)?.models).toEqual(["claude-opus-4-8"]);
  expect(modelObservationForTarget(store, { ...isolated, authMode: "ambient", profile: undefined }))
    .toBeUndefined();
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readFile(path, "utf8")).not.toContain("PRIVATE CANARY");
});

test("fresh empty and later failed observations revoke a prior positive", async () => {
  const path = await temporaryStore();
  const positive = observation(ambient);
  await writeProviderModelObservation(positive, path, now);
  const receipt = modelAdmissionReceipt(positive, ambient, "claude-fable-5", now)!;
  expect(await validateModelAdmissionReceipt(receipt, ambient, "claude-fable-5", path, now)).toBe(true);

  const emptyAt = new Date(now.getTime() + 1_000);
  await writeProviderModelObservation(observation(ambient, [], emptyAt), path, emptyAt);
  expect(modelObservationForTarget(await readProviderModelObservations(path, emptyAt), ambient)?.models)
    .toEqual([]);
  expect(await validateModelAdmissionReceipt(receipt, ambient, "claude-fable-5", path, emptyAt))
    .toBe(false);

  const failureAt = new Date(now.getTime() + 2_000);
  await writeProviderModelObservation(
    failedProviderModelObservation(ambient, "anthropic_models_probe_failed", failureAt),
    path,
    failureAt,
  );
  const failed = modelObservationForTarget(await readProviderModelObservations(path, failureAt), ambient);
  expect(failed?.collectionFailure?.reason).toBe("anthropic_models_probe_failed");
  expect(providerModelObservationIsFresh(failed, failureAt)).toBe(false);
});

test("stale positive evidence never produces or revalidates a receipt", async () => {
  const path = await temporaryStore();
  const staleAt = new Date(now.getTime() - 5 * 60 * 1000 - 1);
  const stale = observation(ambient, ["claude-fable-5"], staleAt);
  await writeProviderModelObservation(stale, path, now);
  expect(providerModelObservationIsFresh(stale, now)).toBe(false);
  expect(modelAdmissionReceipt(stale, ambient, "claude-fable-5", now)).toBeUndefined();
  const forged = {
    provider: "anthropic" as const,
    targetId: ambient.id,
    authMode: "ambient" as const,
    model: "claude-fable-5",
    observedAt: stale.observedAt,
    source: ANTHROPIC_MODEL_OBSERVATION_SOURCE,
    observationDigest: "0".repeat(64),
  };
  expect(await validateModelAdmissionReceipt(forged, ambient, forged.model, path, now)).toBe(false);
});
