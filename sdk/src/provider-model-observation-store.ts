import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { withFileLease } from "./file-lease";
import { providerSupportsModel, resolveModelAlias } from "./providers/catalog";
import type { ProviderId, RoutingTarget } from "./providers/types";

export const ANTHROPIC_MODEL_OBSERVATION_SOURCE =
  "claude-agent-sdk:Query.supportedModels" as const;
export const PROVIDER_MODEL_OBSERVATION_TTL_MS = 5 * 60 * 1000;
export const MAX_PROVIDER_MODEL_OBSERVATION_STORE_BYTES = 256 * 1024;
export const MAX_PROVIDER_MODEL_OBSERVATION_TARGETS = 256;
export const MAX_PROVIDER_MODELS_PER_TARGET = 128;
export const DEFAULT_PROVIDER_MODEL_OBSERVATIONS_PATH = resolve(
  homedir(), ".local/state/north/provider-model-observations.json",
);

export interface ProviderModelObservation {
  provider: ProviderId;
  targetId: string;
  authMode: "ambient" | "isolated";
  profile?: string;
  observedAt: string;
  source: typeof ANTHROPIC_MODEL_OBSERVATION_SOURCE;
  /** Exact Gaffer model IDs only; provider aliases are normalized before persistence. */
  models: string[];
  /** A newer failed control read is unknown evidence, never a reusable positive. */
  collectionFailure?: {
    observedAt: string;
    reason: string;
  };
}

export interface ProviderModelObservationStore {
  version: 1;
  observations: ProviderModelObservation[];
}

export interface ProviderModelAdmissionReceipt {
  provider: "anthropic";
  targetId: string;
  authMode: "ambient" | "isolated";
  profile?: string;
  model: string;
  observedAt: string;
  source: typeof ANTHROPIC_MODEL_OBSERVATION_SOURCE;
  observationDigest: string;
}

const PORTABLE_TARGET = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error(`invalid provider model observation: ${label} fields changed`);
}

function targetIdentity(
  target: Pick<RoutingTarget, "id" | "provider" | "authMode" | "profile">
    | Pick<ProviderModelObservation, "targetId" | "provider" | "authMode" | "profile">,
): string {
  const id = "targetId" in target ? target.targetId : target.id;
  return [target.provider, id, target.authMode ?? "ambient", target.profile ?? ""].join("\u0000");
}

function validateTargetIdentity(value: ProviderModelObservation): void {
  if (!PORTABLE_TARGET.test(value.targetId))
    throw new Error("invalid provider model observation: target id is not portable");
  if (value.authMode === "isolated") {
    if (!value.profile || !PORTABLE_TARGET.test(value.profile))
      throw new Error("invalid provider model observation: isolated target profile is missing");
  } else if (value.profile !== undefined) {
    throw new Error("invalid provider model observation: ambient target has an isolated profile");
  }
}

function parseObservation(value: unknown, now: Date): ProviderModelObservation {
  if (!record(value)) throw new Error("invalid provider model observation: entry must be an object");
  const hasProfile = Object.hasOwn(value, "profile");
  const hasFailure = Object.hasOwn(value, "collectionFailure");
  exactKeys(
    value,
    ["provider", "targetId", "authMode", ...(hasProfile ? ["profile"] : []), "observedAt", "source", "models",
      ...(hasFailure ? ["collectionFailure"] : [])],
    "entry",
  );
  if (value.provider !== "anthropic"
      || value.source !== ANTHROPIC_MODEL_OBSERVATION_SOURCE
      || (value.authMode !== "ambient" && value.authMode !== "isolated")
      || typeof value.targetId !== "string"
      || typeof value.observedAt !== "string"
      || (hasProfile && typeof value.profile !== "string")
      || !Array.isArray(value.models)
      || value.models.length > MAX_PROVIDER_MODELS_PER_TARGET) {
    throw new Error("invalid provider model observation: entry schema changed");
  }
  const observedAt = Date.parse(value.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > now.getTime())
    throw new Error("invalid provider model observation: timestamp is invalid or future-dated");
  const models = value.models;
  if (models.some((model) => typeof model !== "string" || !model.trim() || model.length > 256))
    throw new Error("invalid provider model observation: exact model set is malformed");
  if (new Set(models).size !== models.length || [...models].sort().some((model, index) => model !== models[index]))
    throw new Error("invalid provider model observation: exact model set is not canonical");
  for (const model of models) {
    if (!providerSupportsModel("anthropic", model)
        || resolveModelAlias("anthropic", model) !== model) {
      throw new Error("invalid provider model observation: model is not an exact Gaffer declaration");
    }
  }
  let collectionFailure: ProviderModelObservation["collectionFailure"];
  if (hasFailure) {
    if (!record(value.collectionFailure))
      throw new Error("invalid provider model observation: collection failure is malformed");
    exactKeys(value.collectionFailure, ["observedAt", "reason"], "collection failure");
    const failureAt = typeof value.collectionFailure.observedAt === "string"
      ? Date.parse(value.collectionFailure.observedAt) : Number.NaN;
    if (!Number.isFinite(failureAt) || failureAt > now.getTime()
        || failureAt < observedAt || typeof value.collectionFailure.reason !== "string"
        || value.collectionFailure.reason.length > 128
        || !/^[a-z0-9_]+$/.test(value.collectionFailure.reason)) {
      throw new Error("invalid provider model observation: collection failure is malformed");
    }
    collectionFailure = {
      observedAt: new Date(failureAt).toISOString(),
      reason: value.collectionFailure.reason,
    };
  }
  const observation: ProviderModelObservation = {
    provider: "anthropic",
    targetId: value.targetId,
    authMode: value.authMode,
    ...(hasProfile ? { profile: value.profile as string } : {}),
    observedAt: new Date(observedAt).toISOString(),
    source: ANTHROPIC_MODEL_OBSERVATION_SOURCE,
    models: [...models] as string[],
    ...(collectionFailure ? { collectionFailure } : {}),
  };
  validateTargetIdentity(observation);
  return observation;
}

export function parseProviderModelObservationStore(
  value: unknown,
  now = new Date(),
): ProviderModelObservationStore {
  if (!record(value)) throw new Error("invalid provider model observation store: expected object");
  exactKeys(value, ["version", "observations"], "store");
  if (value.version !== 1 || !Array.isArray(value.observations)
      || value.observations.length > MAX_PROVIDER_MODEL_OBSERVATION_TARGETS)
    throw new Error("invalid provider model observation store: schema changed");
  const observations = value.observations.map((observation) => parseObservation(observation, now));
  const identities = observations.map(targetIdentity);
  if (new Set(identities).size !== identities.length)
    throw new Error("invalid provider model observation store: duplicate target observation");
  return { version: 1, observations };
}

export function providerModelObservationPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.NORTH_PROVIDER_MODEL_OBSERVATIONS ?? DEFAULT_PROVIDER_MODEL_OBSERVATIONS_PATH);
}

export async function readProviderModelObservations(
  path = providerModelObservationPath(),
  now = new Date(),
): Promise<ProviderModelObservationStore | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(MAX_PROVIDER_MODEL_OBSERVATION_STORE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer, offset, buffer.length - offset, offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PROVIDER_MODEL_OBSERVATION_STORE_BYTES)
      throw new Error("invalid provider model observation store: file exceeds byte ceiling");
    return parseProviderModelObservationStore(
      JSON.parse(buffer.subarray(0, offset).toString("utf8")), now,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError)
      throw new Error("invalid provider model observation store: JSON could not be parsed");
    throw error;
  } finally {
    await handle?.close();
  }
}

export function providerModelObservationIsFresh(
  observation: ProviderModelObservation | undefined,
  now = new Date(),
): observation is ProviderModelObservation {
  return !observation?.collectionFailure
    && providerModelObservationAttemptIsFresh(observation, now);
}

/**
 * A recent failed collection is reusable only as negative evidence. This keeps
 * an exact route blocked without launching a new control process on every
 * dispatch; it can never mint a positive admission receipt.
 */
export function providerModelObservationAttemptIsFresh(
  observation: ProviderModelObservation | undefined,
  now = new Date(),
): observation is ProviderModelObservation {
  if (!observation) return false;
  const observedAt = Date.parse(
    observation.collectionFailure?.observedAt ?? observation.observedAt,
  );
  return Number.isFinite(observedAt)
    && observedAt <= now.getTime()
    && now.getTime() - observedAt <= PROVIDER_MODEL_OBSERVATION_TTL_MS;
}

export function modelObservationForTarget(
  store: ProviderModelObservationStore | undefined,
  target: RoutingTarget,
): ProviderModelObservation | undefined {
  const identity = targetIdentity({
    id: target.id,
    provider: target.provider,
    authMode: target.authMode,
    profile: target.profile,
  });
  return store?.observations.find((observation) => targetIdentity(observation) === identity);
}

export function modelObservationDigest(observation: ProviderModelObservation): string {
  return createHash("sha256").update(JSON.stringify({
    provider: observation.provider,
    targetId: observation.targetId,
    authMode: observation.authMode,
    profile: observation.profile ?? null,
    observedAt: observation.observedAt,
    source: observation.source,
    models: observation.models,
    collectionFailure: observation.collectionFailure ?? null,
  })).digest("hex");
}

export function failedProviderModelObservation(
  target: RoutingTarget,
  reason: string,
  now = new Date(),
): ProviderModelObservation {
  const authMode = target.authMode ?? "ambient";
  return {
    provider: "anthropic",
    targetId: target.id,
    authMode,
    ...(authMode === "isolated" ? { profile: target.profile } : {}),
    observedAt: now.toISOString(),
    source: ANTHROPIC_MODEL_OBSERVATION_SOURCE,
    models: [],
    collectionFailure: { observedAt: now.toISOString(), reason },
  };
}

export function modelAdmissionReceipt(
  observation: ProviderModelObservation,
  target: RoutingTarget,
  model: string,
  now = new Date(),
): ProviderModelAdmissionReceipt | undefined {
  if (!providerModelObservationIsFresh(observation, now)
      || modelObservationForTarget({ version: 1, observations: [observation] }, target) !== observation
      || !observation.models.includes(model)) return undefined;
  return Object.freeze({
    provider: "anthropic",
    targetId: observation.targetId,
    authMode: observation.authMode,
    ...(observation.profile ? { profile: observation.profile } : {}),
    model,
    observedAt: observation.observedAt,
    source: observation.source,
    observationDigest: modelObservationDigest(observation),
  });
}

export async function validateModelAdmissionReceipt(
  receipt: ProviderModelAdmissionReceipt | undefined,
  target: RoutingTarget,
  model: string,
  path = providerModelObservationPath(),
  now = new Date(),
): Promise<boolean> {
  if (!receipt || receipt.provider !== "anthropic" || receipt.targetId !== target.id
      || receipt.authMode !== (target.authMode ?? "ambient")
      || receipt.profile !== target.profile || receipt.model !== model
      || receipt.source !== ANTHROPIC_MODEL_OBSERVATION_SOURCE) return false;
  let store: ProviderModelObservationStore | undefined;
  try { store = await readProviderModelObservations(path, now); }
  catch { return false; }
  const observation = modelObservationForTarget(store, target);
  const current = observation && modelAdmissionReceipt(observation, target, model, now);
  return Boolean(current
    && current.observedAt === receipt.observedAt
    && current.observationDigest === receipt.observationDigest);
}

export async function writeProviderModelObservation(
  incoming: ProviderModelObservation,
  path = providerModelObservationPath(),
  now = new Date(),
): Promise<ProviderModelObservationStore> {
  const normalized = parseObservation(incoming, now);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLease(`${path}.lock`, async () => {
    const existing = await readProviderModelObservations(path, now);
    const identity = targetIdentity(normalized);
    const observations = [
      ...(existing?.observations ?? []).filter((observation) => targetIdentity(observation) !== identity),
      normalized,
    ].sort((left, right) => targetIdentity(left).localeCompare(targetIdentity(right)));
    const store = parseProviderModelObservationStore({ version: 1, observations }, now);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      await chmod(path, 0o600);
      return store;
    } finally {
      await rm(temporary, { force: true });
    }
  });
}
