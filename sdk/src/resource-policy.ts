import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  AllocationMode,
  EntitlementPressure,
  EnvelopeLimits,
  PressureObservation,
  ProviderId,
  ProviderUsageObservation,
  ProviderUsageObservationStore,
  ProviderUsageWindow,
  ResourceEnvelopes,
  ResourcePolicy,
  RoutingTarget,
} from "./providers/types";

const PROVIDERS: ProviderId[] = ["anthropic", "openai"];
const PRESSURES: EntitlementPressure[] = ["plenty", "normal", "low", "exhausted", "unknown"];
const MODES: AllocationMode[] = ["preferential", "balanced", "reserved"];

/** Pressure observations are trustworthy for one day unless `until` is set. */
export const PRESSURE_TTL_MS = 24 * 60 * 60 * 1000;
export const OBSERVATION_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const DEFAULT_ROUTING_POLICY_PATH = resolve(homedir(), ".config/north/routing-policy.json");
export const DEFAULT_PROVIDER_OBSERVATIONS_PATH = resolve(homedir(), ".local/state/north/provider-usage-observations.json");

function fail(path: string, message: string): never {
  throw new Error(`invalid North routing policy at ${path}: ${message}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysOnly(path: string, label: string, value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(path, `${label} has unknown field(s): ${unknown.join(", ")}`);
}

function provider(path: string, value: unknown, label: string): ProviderId {
  if (!PROVIDERS.includes(value as ProviderId)) fail(path, `${label} must be anthropic or openai`);
  return value as ProviderId;
}

function finitePositive(path: string, value: unknown, label: string, integer = false, allowZero = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0) || (integer && !Number.isInteger(value)))
    fail(path, `${label} must be a ${allowZero ? "non-negative" : "positive"}${integer ? " integer" : " number"}`);
  return value;
}

function timestamp(path: string, value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    fail(path, `${label} must be an ISO-8601 timestamp`);
  return value;
}

function parseLimits(path: string, value: unknown, label: string): EnvelopeLimits {
  if (!object(value)) fail(path, `${label} must be an object`);
  keysOnly(path, label, value, ["runs", "frontierRuns", "retries", "parallelism"]);
  const result: EnvelopeLimits = {};
  for (const key of ["runs", "frontierRuns", "retries", "parallelism"] as const) {
    if (value[key] !== undefined)
      result[key] = finitePositive(path, value[key], `${label}.${key}`, true, key !== "parallelism");
  }
  return result;
}

function parseNamedLimits(path: string, value: unknown, label: string): Record<string, EnvelopeLimits> {
  if (!object(value)) fail(path, `${label} must be an object keyed by name`);
  return Object.fromEntries(Object.entries(value).map(([name, limits]) => {
    if (!name.trim()) fail(path, `${label} contains an empty name`);
    return [name, parseLimits(path, limits, `${label}.${name}`)];
  }));
}

function parseEnvelopes(path: string, value: unknown): ResourceEnvelopes {
  if (!object(value)) fail(path, "envelopes must be an object");
  keysOnly(path, "envelopes", value, ["default", "month", "week", "projects", "sessions"]);
  return {
    ...(value.default === undefined ? {} : { default: parseLimits(path, value.default, "envelopes.default") }),
    ...(value.month === undefined ? {} : { month: parseLimits(path, value.month, "envelopes.month") }),
    ...(value.week === undefined ? {} : { week: parseLimits(path, value.week, "envelopes.week") }),
    ...(value.projects === undefined ? {} : { projects: parseNamedLimits(path, value.projects, "envelopes.projects") }),
    ...(value.sessions === undefined ? {} : { sessions: parseNamedLimits(path, value.sessions, "envelopes.sessions") }),
  };
}

function parseTargets(path: string, value: unknown): RoutingTarget[] {
  if (!Array.isArray(value) || value.length === 0) fail(path, "targets must be a non-empty array");
  const targets = value.map((entry, index) => {
    const label = `targets[${index}]`;
    if (!object(entry)) fail(path, `${label} must be an object`);
    keysOnly(path, label, entry, ["id", "provider", "profile"]);
    if (typeof entry.id !== "string" || !entry.id.trim()) fail(path, `${label}.id must be a non-empty string`);
    if (entry.profile !== undefined && (typeof entry.profile !== "string" || !entry.profile.trim()))
      fail(path, `${label}.profile must be a non-empty string`);
    return { id: entry.id, provider: provider(path, entry.provider, `${label}.provider`),
      ...(entry.profile === undefined ? {} : { profile: entry.profile }) } as RoutingTarget;
  });
  if (new Set(targets.map(({ id }) => id)).size !== targets.length) fail(path, "target ids must be unique");
  return targets;
}

function stringList(path: string, value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    fail(path, `${label} must be an array of non-empty strings`);
  if (new Set(value).size !== value.length) fail(path, `${label} must not contain duplicates`);
  return value as string[];
}

function parsePressure(path: string, value: unknown, label: string): PressureObservation {
  if (!object(value)) fail(path, `${label} must be an object`);
  keysOnly(path, label, value, ["state", "observedAt", "until"]);
  if (!PRESSURES.includes(value.state as EntitlementPressure))
    fail(path, `${label}.state must be plenty, normal, low, exhausted, or unknown`);
  return {
    state: value.state as EntitlementPressure,
    observedAt: timestamp(path, value.observedAt, `${label}.observedAt`),
    ...(value.until === undefined ? {} : { until: timestamp(path, value.until, `${label}.until`) }),
  };
}

export function pressureObservationIsFresh(
  observation: Pick<PressureObservation, "observedAt" | "until"> | undefined,
  now = new Date(),
): boolean {
  if (!observation) return false;
  const observedAt = Date.parse(observation.observedAt);
  if (observedAt > now.getTime() + OBSERVATION_CLOCK_SKEW_MS) return false;
  const expiry = observation.until ? Date.parse(observation.until) : observedAt + PRESSURE_TTL_MS;
  return now.getTime() <= expiry;
}

export function effectivePressure(observation: PressureObservation | undefined, now = new Date()): EntitlementPressure {
  return pressureObservationIsFresh(observation, now) ? observation!.state : "unknown";
}

/** Provider-neutral utilization thresholds; the most constrained live window wins. */
export function pressureFromUsageWindows(windows: ProviderUsageWindow[], now = new Date()): EntitlementPressure | undefined {
  const relevant = windows.filter(({ resetsAt }) => Date.parse(resetsAt) > now.getTime());
  if (!relevant.length) return undefined;
  const worst = Math.max(...relevant.map(({ usedPercent }) => usedPercent));
  if (worst >= 100) return "exhausted";
  if (worst >= 80) return "low";
  if (worst >= 50) return "normal";
  return "plenty";
}

export function automatedPressure(
  observation: ProviderUsageObservation | undefined,
  now = new Date(),
): EntitlementPressure | undefined {
  if (!pressureObservationIsFresh(observation, now)) return undefined;
  if (observation?.windows?.length) return pressureFromUsageWindows(observation.windows, now);
  return observation?.state;
}

export function parseProviderUsageObservations(input: unknown, path = "<memory>"): ProviderUsageObservationStore {
  if (!object(input)) failObservations(path, "top level must be an object");
  const unknown = Object.keys(input).filter((key) => !["version", "observations"].includes(key));
  if (unknown.length) failObservations(path, `top level has unknown field(s): ${unknown.join(", ")}`);
  if (input.version !== 1) failObservations(path, "version must be 1");
  if (!Array.isArray(input.observations)) failObservations(path, "observations must be an array");
  const observations = input.observations.map((entry, index) => {
    const label = `observations[${index}]`;
    if (!object(entry)) failObservations(path, `${label} must be an object`);
    const unknownFields = Object.keys(entry).filter((key) => !["targetId", "provider", "state", "windows", "observedAt", "until"].includes(key));
    if (unknownFields.length) failObservations(path, `${label} has unknown field(s): ${unknownFields.join(", ")}`);
    if (typeof entry.targetId !== "string" || !entry.targetId.trim())
      failObservations(path, `${label}.targetId must be a non-empty string`);
    if (!PROVIDERS.includes(entry.provider as ProviderId))
      failObservations(path, `${label}.provider must be anthropic or openai`);
    if (entry.state !== undefined && !PRESSURES.includes(entry.state as EntitlementPressure))
      failObservations(path, `${label}.state must be plenty, normal, low, exhausted, or unknown`);
    let windows: ProviderUsageWindow[] | undefined;
    if (entry.windows !== undefined) {
      if (!Array.isArray(entry.windows) || entry.windows.length === 0)
        failObservations(path, `${label}.windows must be a non-empty array`);
      windows = entry.windows.map((window, windowIndex) => {
        const windowLabel = `${label}.windows[${windowIndex}]`;
        if (!object(window)) failObservations(path, `${windowLabel} must be an object`);
        const unknownWindowFields = Object.keys(window).filter((key) => !["limitId", "usedPercent", "resetsAt"].includes(key));
        if (unknownWindowFields.length)
          failObservations(path, `${windowLabel} has unknown field(s): ${unknownWindowFields.join(", ")}`);
        if (window.limitId !== undefined && (typeof window.limitId !== "string" || !window.limitId.trim()))
          failObservations(path, `${windowLabel}.limitId must be a non-empty string`);
        if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0)
          failObservations(path, `${windowLabel}.usedPercent must be a non-negative number`);
        return {
          ...(window.limitId === undefined ? {} : { limitId: window.limitId }),
          usedPercent: window.usedPercent,
          resetsAt: observationTimestamp(path, window.resetsAt, `${windowLabel}.resetsAt`),
        } as ProviderUsageWindow;
      });
    }
    if (entry.state === undefined && windows === undefined)
      failObservations(path, `${label} must contain state or windows`);
    const observedAt = observationTimestamp(path, entry.observedAt, `${label}.observedAt`);
    return {
      targetId: entry.targetId,
      provider: entry.provider as ProviderId,
      observedAt,
      ...(entry.state === undefined ? {} : { state: entry.state as EntitlementPressure }),
      ...(windows === undefined ? {} : { windows }),
      ...(entry.until === undefined ? {} : { until: observationTimestamp(path, entry.until, `${label}.until`) }),
    } as ProviderUsageObservation;
  });
  return { version: 1, observations };
}

function failObservations(path: string, message: string): never {
  throw new Error(`invalid North provider usage observations at ${path}: ${message}`);
}

function observationTimestamp(path: string, value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    failObservations(path, `${label} must be an ISO-8601 timestamp`);
  return value;
}

export function loadProviderUsageObservations(
  path = process.env.NORTH_PROVIDER_OBSERVATIONS ?? DEFAULT_PROVIDER_OBSERVATIONS_PATH,
): ProviderUsageObservationStore | undefined {
  if (!existsSync(path)) return undefined;
  let input: unknown;
  try { input = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    failObservations(path, `could not parse JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseProviderUsageObservations(input, path);
}

/**
 * Overlay fresh automated observations onto fresh manual policy observations.
 * The runtime still selects providers rather than profiles, so only the first
 * ordered target for each provider is executable today.
 */
export function applyProviderUsageObservations(
  policy: ResourcePolicy,
  store: ProviderUsageObservationStore | undefined,
  now = new Date(),
): ResourcePolicy {
  const targets = policy.targets ?? [];
  const order = policy.targetOrder ?? targets.map(({ id }) => id);
  const latest = new Map<string, ProviderUsageObservation>();
  for (const observation of store?.observations ?? []) {
    if (automatedPressure(observation, now) === undefined) continue;
    const target = targets.find(({ id }) => id === observation.targetId);
    if (!target || target.provider !== observation.provider) continue;
    const previous = latest.get(observation.targetId);
    if (!previous || Date.parse(observation.observedAt) > Date.parse(previous.observedAt))
      latest.set(observation.targetId, observation);
  }
  const pressures: Partial<Record<ProviderId, EntitlementPressure>> = {};
  const automatedPressureObservations: Record<string, ProviderUsageObservation> = {};
  for (const id of order) {
    const target = targets.find((candidate) => candidate.id === id);
    if (!target || pressures[target.provider] !== undefined) continue;
    const automated = latest.get(id);
    const manual = policy.pressureObservations?.[id];
    if (automated) {
      pressures[target.provider] = automatedPressure(automated, now)!;
      automatedPressureObservations[id] = automated;
    } else {
      pressures[target.provider] = effectivePressure(manual, now);
    }
  }
  return { ...policy, pressures, automatedPressureObservations };
}

export function parseResourcePolicy(input: unknown, path = "<memory>", now = new Date()): ResourcePolicy {
  if (!object(input)) fail(path, "top level must be an object");
  keysOnly(path, "top level", input, ["version", "mode", "targets", "targetOrder", "providerOrder", "weights",
    "reservedFrontierTarget", "pressures", "envelopes"]);
  if (input.version !== 1) fail(path, "version must be 1");
  if (!MODES.includes(input.mode as AllocationMode)) fail(path, "mode must be preferential, balanced, or reserved");
  const targets = parseTargets(path, input.targets);
  const ids = new Set(targets.map(({ id }) => id));
  const targetOrder = input.targetOrder === undefined ? targets.map(({ id }) => id) : stringList(path, input.targetOrder, "targetOrder");
  for (const id of targetOrder) if (!ids.has(id)) fail(path, `targetOrder references unknown target ${id}`);
  const providerOrder = input.providerOrder === undefined
    ? [...new Set(targetOrder.map((id) => targets.find((target) => target.id === id)!.provider))]
    : stringList(path, input.providerOrder, "providerOrder").map((id) => provider(path, id, "providerOrder entry"));

  const pressureObservations: Record<string, PressureObservation> = {};
  if (input.pressures !== undefined) {
    if (!object(input.pressures)) fail(path, "pressures must be an object keyed by target id");
    for (const [id, observation] of Object.entries(input.pressures)) {
      if (!ids.has(id)) fail(path, `pressures references unknown target ${id}`);
      pressureObservations[id] = parsePressure(path, observation, `pressures.${id}`);
    }
  }
  const targetWeights: Record<string, number> = {};
  if (input.weights !== undefined) {
    if (!object(input.weights)) fail(path, "weights must be an object keyed by target id");
    for (const [id, value] of Object.entries(input.weights)) {
      if (!ids.has(id)) fail(path, `weights references unknown target ${id}`);
      targetWeights[id] = finitePositive(path, value, `weights.${id}`);
    }
  }
  const reserved = input.reservedFrontierTarget;
  if (reserved !== undefined && (typeof reserved !== "string" || !ids.has(reserved)))
    fail(path, "reservedFrontierTarget must reference a declared target");

  // Provider routing is today's executable boundary. Multiple profiles may be
  // described now, but are deliberately collapsed to their provider until the
  // adapters can authenticate/select profiles truthfully.
  const pressureByProvider: Partial<Record<ProviderId, EntitlementPressure>> = {};
  const weightByProvider: Partial<Record<ProviderId, number>> = {};
  for (const id of targetOrder) {
    const target = targets.find((candidate) => candidate.id === id)!;
    if (pressureByProvider[target.provider] === undefined)
      pressureByProvider[target.provider] = effectivePressure(pressureObservations[id], now);
    if (weightByProvider[target.provider] === undefined)
      weightByProvider[target.provider] = targetWeights[id] ?? 1;
  }
  return {
    version: 1,
    mode: input.mode as AllocationMode,
    targets,
    targetOrder,
    providerOrder,
    pressures: pressureByProvider,
    weights: weightByProvider,
    pressureObservations,
    targetWeights,
    ...(reserved === undefined ? {} : {
      reservedFrontierTarget: reserved,
      reservedFrontierProvider: targets.find(({ id }) => id === reserved)!.provider,
    }),
    ...(input.envelopes === undefined ? {} : { envelopes: parseEnvelopes(path, input.envelopes) }),
  };
}

export function loadResourcePolicy(path = process.env.NORTH_ROUTING_POLICY ?? DEFAULT_ROUTING_POLICY_PATH, now = new Date()): ResourcePolicy | undefined {
  if (!existsSync(path)) return undefined;
  let input: unknown;
  try { input = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { fail(path, `could not parse JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return parseResourcePolicy(input, path, now);
}
