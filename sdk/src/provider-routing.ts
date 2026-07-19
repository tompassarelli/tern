import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  modelFamily,
  modelFamilies,
  providerSupportsModel,
  providerSupportsRoute,
  resolveTier,
  supportedReasoning,
  type SemanticTier,
} from "./providers/catalog";
import type { Effort } from "./harness";
import type {
  EntitlementPressure,
  AllocationEvidence,
  ProviderAvailability,
  ProviderId,
  ProviderPreference,
  RoutingPreference,
  ResourcePolicy,
  RoutingDecision,
  RoutingTarget,
} from "./providers/types";
import {
  applyProviderUsageObservations,
  automatedPressure,
  categoricalSignalExpiresAt,
  categoricalSignalIsActive,
  collectionFailureIsFresh,
  effectivePressure,
  loadProviderUsageObservations,
  normalizeLegacyRateLimitObservation,
  pressureObservationIsFresh,
  pressureFromCategoricalSignals,
  loadResourcePolicy,
  pressureFromUsageWindows,
  sameProviderWindow,
} from "./resource-policy";
import type {
  ProviderUsageCategoricalSignal,
  ProviderUsageObservation,
  ProviderUsageWindow,
} from "./providers/types";
import { codexConfigArguments, isClaudeSubscriptionStatus, providerEnvironmentForTarget } from "./accounts";
import {
  providerSupportsCapabilities, type GafferCapability,
} from "./gaffer-capabilities";
import { spendGuardEligible } from "./spend-guard";
import {
  authCacheKey,
  authStateCachePath,
  readAuthState,
  writeAuthState,
  type AuthVerdictReason,
  type CachedAuthState,
} from "./provider-auth-cache";

const PROVIDERS: ProviderId[] = ["anthropic", "openai"];

/** Reuse a definitive authenticated verdict younger than this without spawning. */
const AUTH_PROBE_COALESCE_TTL_MS = 10_000;
/** Retain the last definitive verdict this long when a fresh probe cannot complete. */
const AUTH_STATE_RETENTION_MS = 15 * 60 * 1000;

interface SpawnResultShape {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status: number | null;
}

/** ENOENT is the CLI genuinely being absent, distinct from a failed spawn. */
function spawnCommandMissing(result: SpawnResultShape): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * A probe "ran" only when the process exited with a status code. A set `error`
 * (timeout/ENOMEM/EAGAIN) or a kill `signal` (e.g. the timeout SIGTERM) means it
 * could not complete — absence of evidence, never a logged-out verdict.
 */
function spawnRanToCompletion(result: SpawnResultShape): boolean {
  return !result.error && result.signal == null && result.status !== null;
}

function availabilityOf(state: CachedAuthState, disabled: boolean, targetId?: string): ProviderAvailability {
  return {
    ...(targetId ? { targetId } : {}),
    provider: state.provider,
    installed: state.installed,
    authenticated: state.authenticated,
    available: disabled ? false : state.available,
    reason: disabled ? "disabled" : state.reason,
  };
}

function persistAuthVerdict(
  cachePath: string,
  key: string,
  provider: ProviderId,
  installed: boolean,
  reason: AuthVerdictReason,
): CachedAuthState {
  const state: CachedAuthState = {
    provider, installed,
    authenticated: reason === "ready",
    available: reason === "ready",
    reason,
    at: Date.now(),
  };
  writeAuthState(cachePath, key, state);
  return state;
}

/**
 * A probe could not complete. Retain the last definitive verdict (single source
 * of authentication truth), whether that was ready or logged-out, rather than
 * fabricating either. With no retained verdict the honest state is "unknown":
 * unavailable for routing but explicitly not `authentication_missing`.
 */
function unverifiableAuth(
  cachePath: string,
  key: string,
  provider: ProviderId,
  installed: boolean,
  disabled: boolean,
  targetId: string | undefined,
  now: number,
): ProviderAvailability {
  const retained = readAuthState(cachePath, key);
  if (retained && now - retained.at <= AUTH_STATE_RETENTION_MS)
    return availabilityOf(retained, disabled, targetId);
  return {
    ...(targetId ? { targetId } : {}),
    provider, installed,
    authenticated: false,
    available: false,
    reason: disabled ? "disabled" : "unknown",
  };
}

export type ProviderSelectionFailure =
  | "provider_unavailable"
  | "entitlement_exhausted"
  | "route_unresolvable"
  | "blocked_preflight"
  | "no_provider_available";

// Provider selection happens before a provider query is constructed, so this
// error is an explicit no-side-effect signal to callers such as discovery.
export class ProviderSelectionError extends Error {
  readonly preSideEffect = true;
  readonly processOutcome: "blocked_preflight" | undefined;

  constructor(readonly kind: ProviderSelectionFailure, message: string) {
    super(message);
    this.name = "ProviderSelectionError";
    this.processOutcome = kind === "blocked_preflight" ? "blocked_preflight" : undefined;
  }
}

function providerList(value: string | undefined): ProviderId[] {
  const parsed = (value ?? "anthropic,openai")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ProviderId => PROVIDERS.includes(entry as ProviderId));
  return [...new Set(parsed.length ? parsed : PROVIDERS)];
}

function pressure(value: string | undefined): EntitlementPressure {
  return value === "plenty" || value === "normal" || value === "low" || value === "exhausted"
    ? value
    : "unknown";
}

function weights(value: string | undefined): Partial<Record<ProviderId, number>> {
  const result: Partial<Record<ProviderId, number>> = {};
  for (const item of (value ?? "").split(",")) {
    const [id, raw] = item.split("=").map((part) => part.trim());
    const parsed = Number(raw);
    if (PROVIDERS.includes(id as ProviderId) && Number.isFinite(parsed) && parsed > 0)
      result[id as ProviderId] = parsed;
  }
  return result;
}

function declaredTargets(policy: ResourcePolicy): RoutingTarget[] {
  if (policy.targets?.length) return policy.targets;
  const providers = [...new Set([...policy.providerOrder, ...PROVIDERS])];
  return providers.map((id) => ({ id, provider: id, authMode: "ambient" }));
}

function orderedTargets(policy: ResourcePolicy): RoutingTarget[] {
  const targets = declaredTargets(policy);
  const byId = new Map(targets.map((target) => [target.id, target]));
  const configured = policy.targetOrder?.filter((id) => byId.has(id)) ?? [];
  const derived = policy.providerOrder.flatMap((provider) => targets.filter((target) => target.provider === provider).map(({ id }) => id));
  const order = [...new Set([...configured, ...derived, ...targets.map(({ id }) => id)])];
  return order.map((id) => byId.get(id)!);
}

function targetOrderForProviders(policy: ResourcePolicy, providers: ProviderId[]): string[] {
  const targets = orderedTargets(policy);
  return [...providers, ...PROVIDERS.filter((provider) => !providers.includes(provider))]
    .flatMap((provider) => targets.filter((target) => target.provider === provider).map(({ id }) => id));
}

export function resourcePolicyFromEnv(
  base: ResourcePolicy | undefined = loadResourcePolicy(),
  observations = (() => {
    try { return loadProviderUsageObservations(); }
    catch { return undefined; }
  })(),
): ResourcePolicy {
  const foundation: ResourcePolicy = base ?? {
    version: 1,
    mode: "balanced",
    targets: PROVIDERS.map((id) => ({ id, provider: id, authMode: "ambient" })),
    targetOrder: PROVIDERS,
    providerOrder: PROVIDERS,
    pressures: {},
    weights: {},
  };
  const observed = observations ? applyProviderUsageObservations(foundation, observations) : foundation;
  const rawMode = process.env.NORTH_ALLOCATION_MODE;
  const mode = rawMode === "balanced" || rawMode === "reserved" || rawMode === "preferential" ? rawMode : observed?.mode ?? "balanced";
  const reserved = process.env.NORTH_RESERVED_FRONTIER_PROVIDER;
  const envOrder = process.env.NORTH_PROVIDER_ORDER;
  const envWeights = process.env.NORTH_PROVIDER_WEIGHTS;
  const anthropicPressure = process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE;
  const openaiPressure = process.env.NORTH_OPENAI_ENTITLEMENT_PRESSURE;
  const providerPressureOverrides: Partial<Record<ProviderId, EntitlementPressure>> = {
    ...(anthropicPressure === undefined ? {} : { anthropic: pressure(anthropicPressure) }),
    ...(openaiPressure === undefined ? {} : { openai: pressure(openaiPressure) }),
  };
  const targets = declaredTargets(observed);
  const targetOrder = envOrder === undefined ? observed.targetOrder : targetOrderForProviders(observed, providerList(envOrder));
  const targetPressures = Object.fromEntries(targets.map((target) => [
    target.id,
    providerPressureOverrides[target.provider] ?? observed.targetPressures?.[target.id]
      ?? observed.pressures[target.provider] ?? "unknown",
  ])) as Record<string, EntitlementPressure>;
  const projectedPressures: Partial<Record<ProviderId, EntitlementPressure>> = {};
  const ordered = [...(targetOrder ?? []), ...targets.map(({ id }) => id).filter((id) => !(targetOrder ?? []).includes(id))];
  for (const id of ordered) {
    const target = targets.find((candidate) => candidate.id === id);
    if (target && projectedPressures[target.provider] === undefined)
      projectedPressures[target.provider] = targetPressures[id];
  }
  const reservedProvider = PROVIDERS.includes(reserved as ProviderId)
    ? reserved as ProviderId : observed.reservedFrontierProvider;
  const reservedTarget = PROVIDERS.includes(reserved as ProviderId)
    ? targets.find((target) => target.provider === reserved)?.id
    : observed.reservedFrontierTarget;
  const providerWeights = envWeights === undefined ? observed?.weights ?? {} : weights(envWeights);
  const targetWeights = envWeights === undefined ? observed.targetWeights : Object.fromEntries(
    targets.map((target) => [target.id, providerWeights[target.provider] ?? 1]),
  );
  const overriddenTargets = new Set(targets
    .filter((target) => providerPressureOverrides[target.provider] !== undefined)
    .map(({ id }) => id));
  const withoutOverriddenEvidence = <T>(values: Record<string, T> | undefined) => values === undefined
    ? undefined
    : Object.fromEntries(Object.entries(values).filter(([id]) => !overriddenTargets.has(id)));
  return {
    ...observed,
    targets,
    targetOrder,
    targetPressures,
    mode,
    providerOrder: envOrder === undefined ? observed?.providerOrder ?? PROVIDERS : providerList(envOrder),
    pressures: { ...observed.pressures, ...projectedPressures, ...providerPressureOverrides },
    weights: providerWeights,
    targetWeights,
    automatedPressureObservations: withoutOverriddenEvidence(observed.automatedPressureObservations),
    automatedPressureObservationSets: withoutOverriddenEvidence(observed.automatedPressureObservationSets),
    reservedFrontierProvider: reservedProvider,
    reservedFrontierTarget: reservedTarget,
  };
}

export function probeAnthropic(target?: RoutingTarget): ProviderAvailability {
  const env = providerEnvironmentForTarget("anthropic", target);
  const disabled = env.NORTH_DISABLE_ANTHROPIC === "1";
  const cachePath = authStateCachePath();
  const key = authCacheKey("anthropic", target?.id);
  const now = Date.now();

  // Coalesce: a recent authenticated verdict is reused without spawning, so a
  // burst of callers collapses to a single probe instead of a fork stampede.
  const cached = readAuthState(cachePath, key);
  if (cached?.reason === "ready" && now - cached.at <= AUTH_PROBE_COALESCE_TTL_MS)
    return availabilityOf(cached, disabled, target?.id);

  const command = env.NORTH_CLAUDE_BIN ?? "claude";
  const version = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 3000 });
  if (spawnCommandMissing(version) || (spawnRanToCompletion(version) && version.status !== 0))
    return availabilityOf(persistAuthVerdict(cachePath, key, "anthropic", false, "command_missing"), disabled, target?.id);
  if (!spawnRanToCompletion(version))
    return unverifiableAuth(cachePath, key, "anthropic", false, disabled, target?.id, now);

  const auth = spawnSync(command, ["auth", "status", "--json"], { env, encoding: "utf8", timeout: 3000 });
  if (!spawnRanToCompletion(auth))
    return unverifiableAuth(cachePath, key, "anthropic", true, disabled, target?.id, now);
  let loggedIn = false;
  try {
    const status = JSON.parse(auth.stdout || "{}");
    loggedIn = isClaudeSubscriptionStatus(status);
  } catch { /* malformed output is not authenticated */ }
  const reason: AuthVerdictReason = auth.status !== 0 || !loggedIn ? "authentication_missing" : "ready";
  return availabilityOf(persistAuthVerdict(cachePath, key, "anthropic", true, reason), disabled, target?.id);
}

export function probeOpenAI(target?: RoutingTarget): ProviderAvailability {
  const env = providerEnvironmentForTarget("openai", target);
  const disabled = env.NORTH_DISABLE_OPENAI === "1";
  const cachePath = authStateCachePath();
  const key = authCacheKey("openai", target?.id);
  const now = Date.now();

  // Coalesce: reuse a recent authenticated verdict rather than re-forking.
  const cached = readAuthState(cachePath, key);
  if (cached?.reason === "ready" && now - cached.at <= AUTH_PROBE_COALESCE_TTL_MS)
    return availabilityOf(cached, disabled, target?.id);

  const command = env.NORTH_CODEX_BIN ?? "codex";
  const result = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 3000 });
  if (spawnCommandMissing(result) || (spawnRanToCompletion(result) && result.status !== 0))
    return availabilityOf(persistAuthVerdict(cachePath, key, "openai", false, "command_missing"), disabled, target?.id);
  if (!spawnRanToCompletion(result))
    return unverifiableAuth(cachePath, key, "openai", false, disabled, target?.id, now);

  const auth = spawnSync(command, ["login", "status", ...codexConfigArguments(env)], { env, encoding: "utf8", timeout: 3000 });
  if (!spawnRanToCompletion(auth))
    return unverifiableAuth(cachePath, key, "openai", true, disabled, target?.id, now);
  const authLines = `${auth.stdout}\n${auth.stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const loggedIn = auth.status === 0 && authLines.includes("Logged in using ChatGPT");
  const reason: AuthVerdictReason = loggedIn ? "ready" : "authentication_missing";
  return availabilityOf(persistAuthVerdict(cachePath, key, "openai", true, reason), disabled, target?.id);
}

function stableUnit(value: string): number {
  // Target IDs often share long prefixes. A 32-bit non-cryptographic hash
  // correlated those suffixes badly enough to turn equal a/b/c weights into an
  // observed ~50/25/25 split. SHA-256 supplies independent deterministic bits;
  // use its top 53 so conversion to Number remains exact.
  const bits = createHash("sha256").update(value).digest().readBigUInt64BE(0) >> 11n;
  return (Number(bits) + 1) / (0x20_0000_0000_0000 + 1);
}

function routeObservations(target: RoutingTarget, policy: ResourcePolicy): ProviderUsageObservation[] {
  const observations = policy.automatedPressureObservationSets?.[target.id]
    ?? (policy.automatedPressureObservations?.[target.id]
      ? [policy.automatedPressureObservations[target.id]!]
      : []);
  return observations.map(normalizeLegacyRateLimitObservation);
}

function routeLimitApplies(
  target: RoutingTarget,
  limitId: string | undefined,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
) : boolean {
  if (target.provider !== "anthropic") return true;
  if (!providerSupportsRoute(target.provider, tier, reasoning)) return false;
  const family = modelFamily(target.provider,
    model ? resolveTier(target.provider, tier, model, reasoning).model
      : tier ? resolveTier(target.provider, tier, undefined, reasoning).model
        : undefined);
  const id = limitId?.toLowerCase() ?? "";
  if (id.includes("seven_day_opus")) return family === "opus";
  if (id.includes("seven_day_sonnet")) return family === "sonnet";
  if (id.startsWith("claude:model:")) {
    const scopedFamily = id.slice("claude:model:".length);
    // Model-scoped data stays route-dependent even when its provider label is
    // opaque. A route-unspecified scalar excludes it; a concrete known family
    // includes only its own catalog-declared bucket.
    return scopedFamily === family;
  }
  return true;
}

function routeUsageWindows(
  target: RoutingTarget,
  observation: ProviderUsageObservation,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
) : ProviderUsageWindow[] | undefined {
  if (!observation.windows?.length) return undefined;
  return observation.windows.filter(({ limitId }) =>
    routeLimitApplies(target, limitId, tier, reasoning, model));
}

function routeCategoricalSignals(
  target: RoutingTarget,
  observation: ProviderUsageObservation,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
) : ProviderUsageCategoricalSignal[] | undefined {
  if (!observation.categoricalSignals?.length) return undefined;
  return observation.categoricalSignals.filter(({ limitId }) =>
    routeLimitApplies(target, limitId, tier, reasoning, model));
}

const pressureRank: Record<EntitlementPressure, number> = {
  exhausted: 4, low: 3, normal: 2, plenty: 1, unknown: 0,
};

interface RouteObservationEvidence {
  observation: ProviderUsageObservation;
  windows?: ProviderUsageWindow[];
  categoricalSignals?: ProviderUsageCategoricalSignal[];
  pressure?: EntitlementPressure;
  pressureKind?: "windows" | "categorical-signal" | "state" | "failure";
}

function routeObservationEvidence(
  target: RoutingTarget,
  policy: ResourcePolicy,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
  now = new Date(),
): RouteObservationEvidence[] {
  if (model && !providerSupportsModel(target.provider, model)) return [];
  return routeObservations(target, policy).map((observation) => {
    const windows = routeUsageWindows(target, observation, tier, reasoning, model);
    const categoricalSignals = routeCategoricalSignals(target, observation, tier, reasoning, model);
    let routePressure: EntitlementPressure | undefined;
    let pressureKind: RouteObservationEvidence["pressureKind"];
    if (collectionFailureIsFresh(observation, now)) {
      // Failed collection is absence of knowledge. Retain only a still-live,
      // route-matching exhaustion; never reward stale partial headroom.
      const windowPressure = windows?.length ? pressureFromUsageWindows(windows, now) : undefined;
      const signalPressure = categoricalSignals?.length
        ? pressureFromCategoricalSignals(observation, categoricalSignals, now)
        : undefined;
      routePressure = windowPressure === "exhausted" || signalPressure === "exhausted"
        ? "exhausted" : "unknown";
      pressureKind = "failure";
    } else {
      const observationFresh = pressureObservationIsFresh(observation, now);
      const staleWindowPressure = windows?.length ? pressureFromUsageWindows(windows, now) : undefined;
      const windowPressure = observationFresh ? staleWindowPressure
        : staleWindowPressure === "exhausted" ? "exhausted" : undefined;
      const signalPressure = categoricalSignals?.length
        ? pressureFromCategoricalSignals(observation, categoricalSignals, now)
        : undefined;
      const candidates: Array<{
        pressure: EntitlementPressure | undefined;
        kind: RouteObservationEvidence["pressureKind"];
      }> = [
        { pressure: windowPressure, kind: "windows" },
        { pressure: signalPressure, kind: "categorical-signal" },
        { pressure: observationFresh ? observation.state : undefined, kind: "state" },
      ];
      const driving = candidates
        .filter((candidate): candidate is typeof candidate & { pressure: EntitlementPressure } =>
          candidate.pressure !== undefined)
        .sort((left, right) => pressureRank[right.pressure] - pressureRank[left.pressure])[0];
      if (driving) {
        routePressure = driving.pressure;
        pressureKind = driving.kind;
      }
    }
    return { observation, windows, categoricalSignals, pressure: routePressure, pressureKind };
  });
}

function numericHeadroomEvidence(
  target: RoutingTarget,
  policy: ResourcePolicy,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
  now = new Date(),
): { headroom: number; evidence: AllocationEvidence } | undefined {
  const routeEvidence = routeObservationEvidence(target, policy, tier, reasoning, model, now);
  const measured = routeEvidence
    .filter(({ observation }) => collectionFailureIsFresh(observation, now)
      || pressureObservationIsFresh(observation, now))
    .flatMap(({ observation, windows }) => (windows ?? [])
      .filter(({ resetsAt }) => Date.parse(resetsAt) > now.getTime())
      .map((window) => ({ observation, window })));
  const candidates: Array<{
    headroom: number;
    observedAt: string;
    categorical: boolean;
    evidence: AllocationEvidence;
  }> = measured.map(({ observation, window }) => ({
    headroom: Math.min(
      observation.collectionFailure ? pressureWeight.unknown : 1,
      Math.max(0.001, (100 - Math.min(100, window.usedPercent)) / 100),
    ),
    observedAt: observation.observedAt,
    categorical: false,
    evidence: {
      kind: "numeric-headroom",
      source: observation.source ?? "legacy-observation",
      observedAt: observation.observedAt,
      ...(window.limitId ? { limitId: window.limitId } : {}),
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
      ...(observation.collectionFailure
        ? { collectionFailure: observation.collectionFailure }
        : {}),
    },
  }));
  for (const { observation, categoricalSignals } of routeEvidence) {
    for (const signal of categoricalSignals ?? []) {
      if (!categoricalSignalIsActive(observation, signal, now)) continue;
      if (collectionFailureIsFresh(observation, now) && signal.kind !== "rejection") continue;
      const routingFloorPercent = signal.kind === "rejection" ? 100 : 80;
      const matchingMeasurement = measured
        .filter(({ window }) => sameProviderWindow(target.provider, window, signal))
        .sort((left, right) =>
          Date.parse(right.observation.observedAt) - Date.parse(left.observation.observedAt))[0];
      candidates.push({
        headroom: Math.max(0.001, (100 - routingFloorPercent) / 100),
        observedAt: observation.observedAt,
        categorical: true,
        evidence: {
          kind: "conservative-floor",
          source: observation.source ?? "legacy-observation",
          observedAt: observation.observedAt,
          ...(signal.limitId ? { limitId: signal.limitId } : {}),
          ...(signal.resetsAt ? { resetsAt: signal.resetsAt } : {}),
          routingFloorPercent,
          ...(categoricalSignalExpiresAt(observation, signal)
            ? { routingFloorExpiresAt: categoricalSignalExpiresAt(observation, signal) }
            : {}),
          ...(matchingMeasurement ? {
            measuredUsedPercent: matchingMeasurement.window.usedPercent,
            measurementSource: matchingMeasurement.observation.source ?? "legacy-observation",
            measurementObservedAt: matchingMeasurement.observation.observedAt,
          } : {}),
        },
      });
    }
  }
  const driving = candidates.sort((left, right) =>
    left.headroom - right.headroom
      || Number(right.categorical) - Number(left.categorical)
      || Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
  if (!driving) return undefined;
  return { headroom: driving.headroom, evidence: driving.evidence };
}

function observedHeadroom(
  target: RoutingTarget,
  policy: ResourcePolicy,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
): number | undefined {
  return numericHeadroomEvidence(target, policy, tier, reasoning, model)?.headroom;
}

function categoricalAllocationEvidence(
  target: RoutingTarget,
  policy: ResourcePolicy,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
): { pressure: EntitlementPressure; evidence: AllocationEvidence } | undefined {
  const driving = routeObservationEvidence(target, policy, tier, reasoning, model)
    .filter((entry): entry is RouteObservationEvidence & { pressure: EntitlementPressure } =>
      entry.pressureKind === "state" && entry.pressure !== undefined && entry.pressure !== "unknown")
    .sort((left, right) => pressureRank[right.pressure] - pressureRank[left.pressure]
      || Date.parse(right.observation.observedAt) - Date.parse(left.observation.observedAt))[0];
  if (!driving) return undefined;
  return {
    pressure: driving.pressure,
    evidence: {
      kind: "categorical-pressure",
      source: driving.observation.source ?? "legacy-observation",
      observedAt: driving.observation.observedAt,
    },
  };
}

function decisiveAllocationEvidence(
  target: RoutingTarget,
  policy: ResourcePolicy,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
): AllocationEvidence | undefined {
  const now = new Date();
  const driving = routeObservationEvidence(target, policy, tier, reasoning, model)
    .filter((entry): entry is RouteObservationEvidence & { pressure: EntitlementPressure } =>
      entry.pressure !== undefined && entry.pressure !== "unknown")
    .sort((left, right) => pressureRank[right.pressure] - pressureRank[left.pressure]
      || Date.parse(right.observation.observedAt) - Date.parse(left.observation.observedAt))[0];
  if (!driving) return undefined;
  if (driving.pressureKind === "categorical-signal") {
    const floor = numericHeadroomEvidence(target, policy, tier, reasoning, model, now);
    if (floor?.evidence.kind === "conservative-floor") return floor.evidence;
  }
  const liveWindow = driving.pressureKind === "state" ? undefined : [...(driving.windows ?? [])]
    .filter(({ resetsAt }) => Date.parse(resetsAt) > now.getTime())
    .sort((left, right) => right.usedPercent - left.usedPercent)[0];
  return {
    kind: liveWindow ? "numeric-headroom" : "categorical-pressure",
    source: driving.observation.source ?? "legacy-observation",
    observedAt: driving.observation.observedAt,
    ...(liveWindow?.limitId ? { limitId: liveWindow.limitId } : {}),
    ...(liveWindow ? {
      usedPercent: liveWindow.usedPercent,
      resetsAt: liveWindow.resetsAt,
    } : {}),
    ...(driving.observation.collectionFailure
      ? { collectionFailure: driving.observation.collectionFailure }
      : {}),
  };
}

function routePressure(
  target: RoutingTarget,
  policy: ResourcePolicy,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
): EntitlementPressure {
  const evidence = routeObservationEvidence(target, policy, tier, reasoning, model);
  const known = evidence
    .map(({ pressure }) => pressure)
    .filter((value): value is EntitlementPressure => value !== undefined && value !== "unknown")
    .sort((left, right) => pressureRank[right] - pressureRank[left])[0];
  if (known) return known;
  // Unknown automated evidence is absence of knowledge. Preserve an explicit
  // manual pressure (especially exhaustion) rather than manufacturing plenty.
  if (evidence.length)
    return effectivePressure(policy.pressureObservations?.[target.id]);
  return policy.targetPressures?.[target.id] ?? policy.pressures[target.provider] ?? "unknown";
}

const pressureWeight: Record<EntitlementPressure, number> = {
  // Keep categorical fallbacks on the same 0..1 scale as numeric remaining
  // headroom. Otherwise an unknown account (formerly weight 1) could outweigh
  // a known account with 80% remaining (weight .8), rewarding telemetry loss.
  plenty: 1,
  normal: 0.5,
  unknown: 0.5,
  low: 0.1,
  exhausted: 0,
};

export interface BalancedAllocationEstimate {
  target: string;
  provider: ProviderId;
  eligible: boolean;
  pressure: EntitlementPressure;
  effectiveWeight: number;
  /** Normalized long-run routing estimate, not a provider quota. */
  approximateShare: number;
  /** Exact observation or policy fallback that produced `effectiveWeight`. */
  allocationEvidence: AllocationEvidence;
}

function effectiveTargetWeight(
  target: RoutingTarget,
  policy: ResourcePolicy,
  targetPressure: EntitlementPressure,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
): number {
  const configured = policy.targetWeights?.[target.id] ?? policy.weights?.[target.provider] ?? 1;
  const numeric = observedHeadroom(target, policy, tier, reasoning, model);
  const categorical = categoricalAllocationEvidence(target, policy, tier, reasoning, model);
  const factor = numeric === undefined
    ? pressureWeight[targetPressure]
    : categorical ? Math.min(numeric, pressureWeight[categorical.pressure]) : numeric;
  return Math.max(0.001, configured * factor);
}

/** Explain the proportional long-run auto-route implied by current balanced inputs. */
export function balancedAllocationEstimates(
  availability: ProviderAvailability[],
  policy: ResourcePolicy,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
  capabilities?: readonly GafferCapability[],
): BalancedAllocationEstimate[] {
  const estimates = orderedTargets(policy).map((target) => {
    const targetPressure = routePressure(target, policy, tier, reasoning, model);
    const numeric = numericHeadroomEvidence(target, policy, tier, reasoning, model);
    const categorical = categoricalAllocationEvidence(target, policy, tier, reasoning, model);
    const eligible = providerSupportsRoute(target.provider, tier, reasoning)
      && providerSupportsModel(target.provider, model)
      && providerSupportsCapabilities(target.provider, capabilities)
      && stateOfTarget(availability, target).available
      && targetPressure !== "exhausted"
      // An API-billed target without a complete spend budget is ineligible
      // exactly like an exhausted target; auto-route flows to subscription
      // siblings. Subscription targets are O(1) and never read the ledger.
      && spendGuardEligible(target.provider, target.id);
    const manual = policy.pressureObservations?.[target.id];
    const categoricalFactor = categorical ? pressureWeight[categorical.pressure] : undefined;
    const fallbackEvidence = categorical?.evidence ?? {
        kind: "categorical-pressure" as const,
        source: manual && pressureObservationIsFresh(manual) ? "manual-policy" as const : "policy-default" as const,
        ...(manual && pressureObservationIsFresh(manual) ? { observedAt: manual.observedAt } : {}),
      };
    const allocationEvidence = targetPressure === "exhausted"
      ? decisiveAllocationEvidence(target, policy, tier, reasoning, model) ?? fallbackEvidence
      : numeric && (categoricalFactor === undefined || numeric.headroom <= categoricalFactor)
        ? numeric.evidence
        : fallbackEvidence;
    return {
      target: target.id,
      provider: target.provider,
      eligible,
      pressure: targetPressure,
      effectiveWeight: eligible ? effectiveTargetWeight(target, policy, targetPressure, tier, reasoning, model) : 0,
      approximateShare: 0,
      allocationEvidence,
    };
  });
  const total = estimates.reduce((sum, { effectiveWeight }) => sum + effectiveWeight, 0);
  for (const estimate of estimates)
    estimate.approximateShare = total > 0 ? estimate.effectiveWeight / total : 0;
  return estimates;
}

function stateOf(availability: ProviderAvailability[], id: ProviderId): ProviderAvailability {
  return availability.find((entry) => entry.provider === id && entry.targetId === undefined) ?? {
    provider: id, installed: false, authenticated: false, available: false, reason: "unknown",
  };
}

function stateOfTarget(availability: ProviderAvailability[], target: RoutingTarget): ProviderAvailability {
  const exact = availability.find((entry) => entry.targetId === target.id && entry.provider === target.provider);
  if (exact) return exact;
  if ((target.authMode ?? "ambient") === "ambient") return stateOf(availability, target.provider);
  return {
    targetId: target.id, provider: target.provider, installed: false, authenticated: false,
    available: false, reason: "unknown", detail: "isolated target has not been probed",
  };
}

export function selectProviderFromAvailability(
  requested: RoutingPreference,
  availability: ProviderAvailability[],
  policy: ResourcePolicy,
  tier?: SemanticTier,
  stableKey = "default",
  reasoning?: Effort,
  model?: string,
  capabilities?: readonly GafferCapability[],
): RoutingDecision {
  const request = typeof requested === "string" ? { provider: requested } : requested;
  const requestedProvider = request.provider ?? "auto";
  const requestedTarget = request.target;
  const targets = orderedTargets(policy);
  const capabilityCompatible = (target: RoutingTarget) =>
    providerSupportsCapabilities(target.provider, capabilities);
  const routeCompatible = (target: RoutingTarget) => providerSupportsRoute(target.provider, tier, reasoning)
    && providerSupportsModel(target.provider, model)
    && capabilityCompatible(target);
  const targetPressures = Object.fromEntries(targets.map((target) => [
    target.id, routePressure(target, policy, tier, reasoning, model),
  ])) as Record<string, EntitlementPressure>;
  const targetAvailable = (target: RoutingTarget) => stateOfTarget(availability, target).available;
  const eligible = (target: RoutingTarget) => routeCompatible(target)
    && targetAvailable(target) && targetPressures[target.id] !== "exhausted"
    && spendGuardEligible(target.provider, target.id);
  const routeFailure = (providers: ProviderId[]) => {
    const support = [...new Set(providers)].map((provider) =>
      `${provider}=[${tier ? supportedReasoning(provider, tier).join(",") : "provider default"}]`).join("; ");
    return new ProviderSelectionError(
      "route_unresolvable",
      `no eligible provider resolves tier=${tier ?? "default"} reasoning=${reasoning ?? "default"}`
      + `${capabilities ? ` capabilities=[${capabilities.join(",")}]` : ""}; ${support}`,
    );
  };

  let candidates: RoutingTarget[];
  if (requestedTarget !== undefined) {
    const target = targets.find(({ id }) => id === requestedTarget);
    if (!target)
      throw new ProviderSelectionError("provider_unavailable", `routing target ${requestedTarget} is not configured`);
    if (requestedProvider !== "auto" && target.provider !== requestedProvider)
      throw new ProviderSelectionError("provider_unavailable",
        `routing target ${requestedTarget} belongs to ${target.provider}, not requested provider ${requestedProvider}`);
    if (!capabilityCompatible(target))
      throw new ProviderSelectionError(
        "blocked_preflight",
        `routing target ${target.id} cannot enforce the requested Gaffer capabilities`,
      );
    if (!routeCompatible(target)) throw routeFailure([target.provider]);
    const state = stateOfTarget(availability, target);
    if (!state.available)
      throw new ProviderSelectionError("provider_unavailable",
        `routing target ${target.id} unavailable through ${target.provider}: ${state.reason}`);
    if (targetPressures[target.id] === "exhausted")
      throw new ProviderSelectionError("entitlement_exhausted", `routing target ${target.id} entitlement exhausted`);
    candidates = [target];
  } else if (requestedProvider !== "auto") {
    const providerTargets = targets.filter((target) => target.provider === requestedProvider);
    if (!providerTargets.length)
      throw new ProviderSelectionError("provider_unavailable", `provider ${requestedProvider} has no configured routing target`);
    if (capabilities && providerTargets.every((target) => !capabilityCompatible(target)))
      throw new ProviderSelectionError(
        "blocked_preflight",
        `provider ${requestedProvider} cannot enforce the requested Gaffer capabilities`,
      );
    const compatibleTargets = providerTargets.filter(routeCompatible);
    if (!compatibleTargets.length) throw routeFailure([requestedProvider]);
    candidates = compatibleTargets.filter(eligible);
    if (!candidates.length && compatibleTargets.every((target) => !targetAvailable(target))) {
      if (compatibleTargets.length === 1) {
        const state = stateOfTarget(availability, compatibleTargets[0]);
        throw new ProviderSelectionError("provider_unavailable",
          `provider ${requestedProvider} unavailable: ${state.reason}`);
      }
      const states = compatibleTargets.map((target) => `${target.id}=${stateOfTarget(availability, target).reason}`).join(", ");
      throw new ProviderSelectionError("provider_unavailable",
        `provider ${requestedProvider} unavailable across routing targets: ${states}`);
    }
    if (!candidates.length)
      throw new ProviderSelectionError("entitlement_exhausted",
        `provider ${requestedProvider} entitlement exhausted (all routing targets)`);
  } else {
    if (!targets.some(routeCompatible)) throw routeFailure(targets.map(({ provider }) => provider));
    candidates = targets.filter(eligible);
  }

  if (!candidates.length)
    throw new ProviderSelectionError("no_provider_available",
      `no agent target available: ${targets.map((target) => `${target.id}=${stateOfTarget(availability, target).reason}/${targetPressures[target.id]}`).join(", ")}`);

  let chosen: RoutingTarget;
  let detail: string;
  const reserve = policy.reservedFrontierTarget
    ?? targets.find((target) => target.provider === policy.reservedFrontierProvider)?.id;
  if (requestedTarget !== undefined) {
    chosen = candidates[0];
    detail = `exact target=${chosen.id}`;
  } else if (policy.mode === "reserved" && reserve) {
    const reservedTarget = candidates.find(({ id }) => id === reserve);
    if (tier === "frontier" && reservedTarget) {
      candidates = [reservedTarget, ...candidates.filter(({ id }) => id !== reserve)];
      chosen = reservedTarget;
      detail = `frontier reserve=${reserve}`;
    } else {
      const alternatives = candidates.filter(({ id }) => id !== reserve);
      // Preserve the reserve through retries too: exhaust all non-reserve
      // accounts before admitting the reserved target as the final fallback.
      candidates = [...alternatives, ...(reservedTarget ? [reservedTarget] : [])];
      chosen = alternatives[0] ?? candidates[0];
      detail = tier === "frontier" ? `reserve=${reserve} unavailable` : `preserving frontier reserve=${reserve}`;
    }
  } else if (policy.mode === "balanced") {
    const weighted = candidates.map((target) => ({
      target,
      headroom: observedHeadroom(target, policy, tier, reasoning, model),
      weight: effectiveTargetWeight(target, policy, targetPressures[target.id], tier, reasoning, model),
    }));
    const ranked = weighted.map((item) => {
      // Weighted rendezvous hashing gives a stable proportional choice plus a
      // complete retry order, without a shared mutable round-robin counter.
      const unit = stableUnit(`${stableKey}\u0000${item.target.id}`);
      return { ...item, score: -Math.log(unit) / item.weight };
    }).sort((left, right) => left.score - right.score);
    candidates = ranked.map(({ target }) => target);
    chosen = candidates[0];
    detail = `stable-key=${stableKey}; effective-weights=${weighted.map(({ target, weight }) => `${target.id}:${Number(weight.toFixed(3))}`).join(",")}`;
  } else {
    chosen = candidates[0];
    detail = `order=${targets.filter(routeCompatible).map(({ id }) => id).join(" -> ")}`;
  }

  const fallbacks = requestedTarget === undefined ? candidates.filter(({ id }) => id !== chosen.id) : [];
  const routeReason = tier && reasoning ? `route=${tier}/${reasoning}; ` : "";
  const selectionReason = `${requestedProvider === "auto" ? "" : `explicit provider=${requestedProvider}; `}${routeReason}mode=${policy.mode}; target=${chosen.id}; pressure=${targetPressures[chosen.id]}; ${detail}`;
  const allocationEvidenceByTarget = policy.mode === "balanced"
    ? Object.fromEntries(balancedAllocationEstimates(
      availability, policy, tier, reasoning, model,
      capabilities,
    ).map((estimate) => [estimate.target, estimate.allocationEvidence]))
    : undefined;
  const decision: RoutingDecision = {
    requested: requestedProvider,
    requestedProvider,
    ...(requestedTarget === undefined ? {} : { requestedTarget }),
    target: chosen.id,
    provider: chosen.provider,
    routingTargets: Object.fromEntries(targets.map((target) => [target.id, target])),
    selectionReason,
    reason: selectionReason,
    availability,
    fallbackTargets: fallbacks.map(({ id }) => id),
    fallbackTargetPath: [chosen.id],
    fallbackProviders: fallbacks.map(({ provider }) => provider),
    fallbackCount: 0,
    fallbackPath: [chosen.provider],
    fallbackReasons: [],
    allocationMode: policy.mode,
    entitlementPressure: targetPressures[chosen.id],
    targetEntitlementPressures: targetPressures,
    entitlementPressures: policy.pressures,
    ...(allocationEvidenceByTarget ? { allocationEvidenceByTarget } : {}),
  };
  // RoutingDecision remains live for final provider/model/pressure attribution,
  // but the explanation of the original allocator choice is provenance. Make
  // both the canonical field and compatibility alias immutable at runtime.
  Object.defineProperties(decision, {
    selectionReason: { value: selectionReason, enumerable: true, writable: false, configurable: false },
    reason: { value: selectionReason, enumerable: true, writable: false, configurable: false },
  });
  return decision;
}

export function selectProvider(
  requested?: RoutingPreference,
  policy: ResourcePolicy = resourcePolicyFromEnv(),
  context: {
    tier?: SemanticTier; reasoning?: Effort; model?: string; stableKey?: string;
    capabilities?: readonly GafferCapability[];
  } = {},
  dependencies: {
    probeAnthropic?: typeof probeAnthropic;
    probeOpenAI?: typeof probeOpenAI;
  } = {},
): RoutingDecision {
  const preference = requested ?? (process.env.AGENT_PROVIDER as ProviderPreference | undefined) ?? "auto";
  const request = typeof preference === "string" ? { provider: preference } : preference;
  const requestedProvider = request.provider ?? "auto";
  const probeTargets = orderedTargets(policy).filter((target) =>
    request.target !== undefined ? target.id === request.target
      : requestedProvider !== "auto" ? target.provider === requestedProvider
        : true);
  const availability = probeTargets.map((target) => {
    try {
      return {
        ...(target.provider === "anthropic"
          ? (dependencies.probeAnthropic ?? probeAnthropic)(target)
          : (dependencies.probeOpenAI ?? probeOpenAI)(target)),
        targetId: target.id,
      };
    } catch {
      return {
        targetId: target.id, provider: target.provider, installed: false,
        authenticated: false, available: false, reason: "unknown" as const,
      };
    }
  });
  const reasoning = context.reasoning
    ?? (process.env.AGENT_REASONING ?? process.env.AGENT_EFFORT) as Effort | undefined;
  return selectProviderFromAvailability(preference, availability, policy,
    context.tier, context.stableKey, reasoning, context.model, context.capabilities);
}
