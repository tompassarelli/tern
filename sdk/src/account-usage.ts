import { createHash } from "node:crypto";
import {
  routingPolicyPath,
  type AccountContext,
} from "./accounts";
import {
  CodexUsageUnavailableError,
  CODEX_USAGE_SOURCE,
  readCodexEntitlementObservation,
  type CodexUsageUnavailableReason,
} from "./codex-entitlement";
import { withFileLease } from "./file-lease";
import {
  ProviderRefreshCancelledError,
  throwIfProviderRefreshCancelled,
} from "./provider-cancellation";
import { writeProviderUsageObservations } from "./provider-observation-store";
import {
  ANTHROPIC_USAGE_SOURCE,
  AnthropicUsageUnavailableError,
  normalizeAnthropicUsage,
  readAnthropicSubscriptionUsage,
  type AnthropicUsageResult,
  type AnthropicUsageUnavailableReason,
  type UnavailableUsageComponent,
} from "./providers/anthropic-usage";
import {
  readAnthropicControlObservation,
  type AnthropicControlFailureReason,
  type AnthropicUsageControlSurface,
  type StartAnthropicControl,
} from "./providers/anthropic-control";
import type { AnthropicProcessLifecycle } from "./providers/anthropic-process";
import {
  AnthropicModelsUnavailableError,
  normalizeAnthropicSupportedModels,
} from "./providers/anthropic-models";
import {
  failedProviderModelObservation,
  modelObservationForTarget,
  providerModelObservationAttemptIsFresh,
  providerModelObservationPath,
  readProviderModelObservations,
  writeProviderModelObservation,
  type ProviderModelObservation,
} from "./provider-model-observation-store";
import type {
  ProviderId,
  ProviderUsageCollectionFailureReason,
  ProviderUsageObservation,
  RoutingPreference,
  RoutingTarget,
} from "./providers/types";
import {
  automatedPressure,
  COLLECTION_FAILURE_TTL_MS,
  DEFAULT_PROVIDER_OBSERVATIONS_PATH,
  loadResourcePolicy,
  loadProviderUsageObservations,
  OBSERVATION_CLOCK_SKEW_MS,
} from "./resource-policy";

export const ACCOUNT_USAGE_TTL_MS = COLLECTION_FAILURE_TTL_MS;
const DEFAULT_ACCOUNT_USAGE_PROBE_TIMEOUT_MS = 30_000;
const ACCOUNT_USAGE_LEASE_WAIT_MS = 20;

export type AccountUsageUnavailableReason = AnthropicUsageUnavailableReason
  | CodexUsageUnavailableReason
  | "usage_observation_store_unavailable";

export interface AccountUsageReport {
  accountId: string;
  provider: ProviderId;
  source: typeof ANTHROPIC_USAGE_SOURCE | typeof CODEX_USAGE_SOURCE;
  observedAt: string;
  /** Timestamp of the successful windows/state being displayed, when any. */
  lastSuccessfulObservedAt?: string;
  /** Timestamp of the latest failed collection attempt, distinct from evidence age. */
  collectionAttemptedAt?: string;
  status: "observed" | "unavailable";
  cached: boolean;
  observation: ProviderUsageObservation;
  unavailableComponents: UnavailableUsageComponent[];
  reason?: AccountUsageUnavailableReason;
  /** Current supportedModels attempt, kept in memory for execution admission. */
  modelAvailabilityAttempt?: AccountModelAvailabilityAttempt;
}

export type AccountModelAvailabilityAttempt =
  | { status: "persisted"; observation: ProviderModelObservation }
  | { status: "unavailable"; targetId: string; attemptedAt: string; reason: string };

type ReadAnthropic = typeof readAnthropicSubscriptionUsage;
type ReadCodex = typeof readCodexEntitlementObservation;

export interface RefreshAccountUsageOptions {
  /** Exact routing targets to observe. ProviderAccount[] remains structurally compatible. */
  accounts?: AccountUsageTarget[];
  /** Refresh only accounts eligible for this route request. */
  requested?: RoutingPreference;
  context?: AccountContext;
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  now?: Date;
  storePath?: string;
  timeoutMs?: number;
  /** Supervisor-owned cancellation for provider control probes. */
  signal?: AbortSignal;
  /** Collect target-scoped supportedModels beside usage through one warm control Query. */
  observeAnthropicModels?: boolean;
  modelStorePath?: string;
  startAnthropicControl?: StartAnthropicControl;
  createAnthropicControlLifecycle?: () => AnthropicProcessLifecycle;
  readAnthropic?: ReadAnthropic;
  readCodex?: ReadCodex;
}

export type AccountUsageTarget = Pick<RoutingTarget, "id" | "provider" | "authMode" | "profile">;

export function accountUsageLeaseOptions(timeoutMs = DEFAULT_ACCOUNT_USAGE_PROBE_TIMEOUT_MS): {
  attempts: number;
  waitMs: number;
} {
  return {
    attempts: Math.ceil((timeoutMs + 1_000) / ACCOUNT_USAGE_LEASE_WAIT_MS),
    waitMs: ACCOUNT_USAGE_LEASE_WAIT_MS,
  };
}

function targetFor(account: AccountUsageTarget): RoutingTarget {
  return account.authMode === "isolated"
    ? { id: account.id, provider: account.provider, authMode: "isolated", profile: account.profile! }
    : { id: account.id, provider: account.provider, authMode: "ambient" };
}

function sourceFor(provider: ProviderId): AccountUsageReport["source"] {
  return provider === "anthropic" ? ANTHROPIC_USAGE_SOURCE : CODEX_USAGE_SOURCE;
}

function cachedObservation(storePath: string, account: AccountUsageTarget): ProviderUsageObservation | undefined {
  try {
    return loadProviderUsageObservations(storePath)?.observations
      .filter(({ provider, source, targetId }) =>
        provider === account.provider && targetId === account.id && source === sourceFor(account.provider))
      .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
  } catch {
    return undefined;
  }
}

function timestampIsCurrent(value: string | undefined, now: Date, ttlMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp <= now.getTime() + OBSERVATION_CLOCK_SKEW_MS
    && now.getTime() - timestamp <= ttlMs;
}

function isFreshAuthoritative(observation: ProviderUsageObservation | undefined, now: Date): boolean {
  if (!observation?.windows?.length) return false;
  return !observation.collectionFailure
    && timestampIsCurrent(observation.observedAt, now, ACCOUNT_USAGE_TTL_MS)
    && observation.windows.some(({ resetsAt }) => Date.parse(resetsAt) > now.getTime());
}

function hasFreshCollectionFailure(observation: ProviderUsageObservation | undefined, now: Date): boolean {
  return timestampIsCurrent(observation?.collectionFailure?.observedAt, now, COLLECTION_FAILURE_TTL_MS);
}

function observedReport(
  account: AccountUsageTarget,
  observation: ProviderUsageObservation,
  cached: boolean,
  unavailableComponents: UnavailableUsageComponent[] = observation.unavailableComponents ?? [],
  modelAvailabilityAttempt?: AccountModelAvailabilityAttempt,
): AccountUsageReport {
  return {
    accountId: account.id,
    provider: account.provider,
    source: sourceFor(account.provider),
    observedAt: observation.observedAt,
    lastSuccessfulObservedAt: observation.observedAt,
    status: "observed",
    cached,
    observation,
    unavailableComponents,
    ...(modelAvailabilityAttempt ? { modelAvailabilityAttempt } : {}),
  };
}

function unavailableReason(error: unknown, provider: ProviderId): AccountUsageUnavailableReason {
  if (error instanceof AnthropicUsageUnavailableError) return error.reason;
  if (error instanceof CodexUsageUnavailableError) return error.reason;
  return provider === "openai" ? "codex_usage_probe_failed" : "anthropic_usage_probe_failed";
}

function unavailableReport(
  account: AccountUsageTarget,
  observation: ProviderUsageObservation,
  reason: AccountUsageUnavailableReason,
  cached: boolean,
  modelAvailabilityAttempt?: AccountModelAvailabilityAttempt,
): AccountUsageReport {
  return {
    accountId: account.id,
    provider: account.provider,
    source: sourceFor(account.provider),
    observedAt: observation.observedAt,
    ...(observation.windows?.length ? { lastSuccessfulObservedAt: observation.observedAt } : {}),
    ...(observation.collectionFailure?.observedAt
      ? { collectionAttemptedAt: observation.collectionFailure.observedAt }
      : {}),
    status: "unavailable",
    cached,
    observation,
    unavailableComponents: observation.unavailableComponents ?? [],
    reason,
    ...(modelAvailabilityAttempt ? { modelAvailabilityAttempt } : {}),
  };
}

function validateObservationForAccount(
  account: AccountUsageTarget,
  observation: ProviderUsageObservation,
): void {
  if (observation.targetId !== account.id
      || observation.provider !== account.provider
      || observation.source !== sourceFor(account.provider))
    throw new Error("provider usage observation identity mismatch");
}

function cachedReport(
  account: AccountUsageTarget,
  observation: ProviderUsageObservation | undefined,
  now: Date,
): AccountUsageReport | undefined {
  if (!observation) return undefined;
  if (hasFreshCollectionFailure(observation, now))
    return unavailableReport(account, observation, observation.collectionFailure!.reason, true);
  if (isFreshAuthoritative(observation, now)) return observedReport(account, observation, true);
  return undefined;
}

function modelFailureReason(reason: AnthropicControlFailureReason): string {
  switch (reason) {
    case "anthropic_control_capability_unavailable": return "anthropic_models_capability_unavailable";
    case "anthropic_control_probe_aborted": return "anthropic_models_probe_aborted";
    case "anthropic_control_probe_timed_out": return "anthropic_models_probe_timed_out";
    default: return "anthropic_models_probe_failed";
  }
}

function usageFailure(
  reason: Extract<AnthropicUsageControlSurface, { ok: false }>["reason"],
): AnthropicUsageUnavailableError {
  if (reason.startsWith("anthropic_usage_"))
    return new AnthropicUsageUnavailableError(reason as AnthropicUsageUnavailableReason);
  switch (reason) {
    case "anthropic_control_capability_unavailable":
      return new AnthropicUsageUnavailableError("anthropic_usage_capability_unavailable");
    case "anthropic_control_probe_aborted":
      return new AnthropicUsageUnavailableError("anthropic_usage_probe_aborted");
    case "anthropic_control_probe_timed_out":
      return new AnthropicUsageUnavailableError("anthropic_usage_probe_timed_out");
    default:
      return new AnthropicUsageUnavailableError("anthropic_usage_probe_failed");
  }
}

async function freshModelEvidence(
  account: AccountUsageTarget,
  options: RefreshAccountUsageOptions,
  now: Date,
): Promise<boolean> {
  if (!options.observeAnthropicModels || account.provider !== "anthropic") return true;
  try {
    const target = targetFor(account);
    const path = options.modelStorePath ?? providerModelObservationPath(options.env ?? options.context?.env);
    return providerModelObservationAttemptIsFresh(
      modelObservationForTarget(await readProviderModelObservations(path, now), target),
      now,
    );
  } catch {
    return false;
  }
}

async function persistFailedModelAttempt(
  target: RoutingTarget,
  modelStorePath: string,
  attemptedAt: string,
  reason: string,
  signal?: AbortSignal,
): Promise<AccountModelAvailabilityAttempt> {
  throwIfProviderRefreshCancelled(signal);
  try {
    const failed = failedProviderModelObservation(target, reason, new Date(attemptedAt));
    await writeProviderModelObservation(failed, modelStorePath, new Date(attemptedAt));
    throwIfProviderRefreshCancelled(signal);
    return { status: "persisted", observation: failed };
  } catch (error) {
    if (error instanceof ProviderRefreshCancelledError || signal?.aborted)
      throw new ProviderRefreshCancelledError();
    return {
      status: "unavailable", targetId: target.id,
      attemptedAt, reason: "anthropic_models_observation_store_unavailable",
    };
  }
}

async function refreshOne(
  account: AccountUsageTarget,
  options: RefreshAccountUsageOptions,
  storePath: string,
  now: Date,
): Promise<AccountUsageReport> {
  throwIfProviderRefreshCancelled(options.signal);
  let modelAvailabilityAttempt: AccountModelAvailabilityAttempt | undefined;
  const cached = cachedObservation(storePath, account);
  const initialCachedReport = cachedReport(account, cached, now);
  if (!options.force && initialCachedReport && await freshModelEvidence(account, options, now)) {
    throwIfProviderRefreshCancelled(options.signal);
    return initialCachedReport;
  }

  const targetHash = createHash("sha256").update(`${account.provider}\u0000${account.id}`).digest("hex").slice(0, 16);
  const lockPath = `${storePath}.account-usage.${targetHash}.lock`;
  try {
    const report = await withFileLease(lockPath, async () => {
      throwIfProviderRefreshCancelled(options.signal);
      const afterWait = cachedObservation(storePath, account);
      const afterWaitReport = cachedReport(account, afterWait, now);
      if (!options.force && afterWaitReport && await freshModelEvidence(account, options, now)) {
        throwIfProviderRefreshCancelled(options.signal);
        return afterWaitReport;
      }

      try {
        let observation: ProviderUsageObservation;
        let unavailableComponents: UnavailableUsageComponent[] = [];
        if (account.provider === "anthropic") {
          const target = targetFor(account);
          let result: AnthropicUsageResult;
          if (options.observeAnthropicModels && !options.readAnthropic) {
            const modelStorePath = options.modelStorePath
              ?? providerModelObservationPath(options.env ?? options.context?.env);
            const control = await readAnthropicControlObservation({
              target,
              env: options.env ?? options.context?.env,
              timeoutMs: options.timeoutMs,
              usage: true,
              models: true,
              now: options.now ? () => now : undefined,
              signal: options.signal,
              start: options.startAnthropicControl,
              createLifecycle: options.createAnthropicControlLifecycle,
            });
            const modelSurface = control.models!;
            const usageSurface = control.usage!;
            if ((!modelSurface.ok
                  && modelSurface.reason === "anthropic_control_probe_aborted")
                || (!usageSurface.ok
                  && usageSurface.reason === "anthropic_control_probe_aborted")) {
              throw new ProviderRefreshCancelledError();
            }
            throwIfProviderRefreshCancelled(options.signal);
            try {
              const modelObservation = modelSurface.ok
                ? normalizeAnthropicSupportedModels(
                    modelSurface.value, target, new Date(modelSurface.observedAt),
                  )
                : failedProviderModelObservation(
                    target, modelFailureReason(modelSurface.reason), new Date(modelSurface.attemptedAt),
                  );
              await writeProviderModelObservation(modelObservation, modelStorePath, new Date(modelObservation.observedAt));
              modelAvailabilityAttempt = { status: "persisted", observation: modelObservation };
            } catch (error) {
              const reason = error instanceof AnthropicModelsUnavailableError
                ? error.reason : "anthropic_models_response_schema_changed";
              const attemptedAt = modelSurface.ok ? modelSurface.observedAt : modelSurface.attemptedAt;
              modelAvailabilityAttempt = await persistFailedModelAttempt(
                target, modelStorePath, attemptedAt, reason, options.signal,
              );
            }
            if (!usageSurface.ok) throw usageFailure(usageSurface.reason);
            result = usageSurface.value;
          } else {
            result = await (options.readAnthropic ?? readAnthropicSubscriptionUsage)({
              target, env: options.env ?? options.context?.env,
              now, timeoutMs: options.timeoutMs, storePath,
              signal: options.signal,
            });
          }
          observation = result.observation;
          unavailableComponents = result.unavailableComponents;
        } else {
          observation = await (options.readCodex ?? readCodexEntitlementObservation)({
            target: targetFor(account), env: options.env ?? options.context?.env,
            now, timeoutMs: options.timeoutMs, signal: options.signal,
          });
        }
        throwIfProviderRefreshCancelled(options.signal);
        validateObservationForAccount(account, observation);
        await writeProviderUsageObservations(observation, storePath);
        return observedReport(
          account, observation, false, unavailableComponents, modelAvailabilityAttempt,
        );
      } catch (error) {
        if (error instanceof ProviderRefreshCancelledError || options.signal?.aborted)
          throw new ProviderRefreshCancelledError();
        if (!modelAvailabilityAttempt && options.observeAnthropicModels
            && account.provider === "anthropic" && !options.readAnthropic) {
          modelAvailabilityAttempt = await persistFailedModelAttempt(
            targetFor(account),
            options.modelStorePath
              ?? providerModelObservationPath(options.env ?? options.context?.env),
            now.toISOString(),
            "anthropic_models_probe_failed",
            options.signal,
          );
        }
        const reason = unavailableReason(error, account.provider) as ProviderUsageCollectionFailureReason;
        const prior = afterWait ?? cached;
        // A failed collection is absence of new knowledge. Preserve a still-live,
        // proven exhaustion so telemetry loss cannot make an account routable.
        const livePrior = prior?.windows?.some(({ resetsAt }) => Date.parse(resetsAt) > now.getTime());
        const failedObservation: ProviderUsageObservation = livePrior
          ? {
              ...prior!,
              collectionFailure: { observedAt: now.toISOString(), reason },
            }
          : {
              targetId: account.id,
              provider: account.provider,
              source: sourceFor(account.provider),
              observedAt: now.toISOString(),
              state: "unknown",
              collectionFailure: { observedAt: now.toISOString(), reason },
            };
        try {
          await writeProviderUsageObservations(failedObservation, storePath);
        } catch {
          return unavailableReport(
            account, failedObservation, "usage_observation_store_unavailable", false,
            modelAvailabilityAttempt,
          );
        }
        return unavailableReport(account, failedObservation, reason, false, modelAvailabilityAttempt);
      }
    }, accountUsageLeaseOptions(options.timeoutMs));
    throwIfProviderRefreshCancelled(options.signal);
    return report;
  } catch (error) {
    if (error instanceof ProviderRefreshCancelledError || options.signal?.aborted)
      throw new ProviderRefreshCancelledError();
    // The observation substrate is advisory. A broken or contended store must
    // neither abort the route nor leak filesystem diagnostics; retain only live
    // exhaustion evidence and otherwise degrade to explicit unknown.
    const fallback: ProviderUsageObservation = automatedPressure(cached, now) === "exhausted"
      ? cached!
      : {
          targetId: account.id,
          provider: account.provider,
          source: sourceFor(account.provider),
          observedAt: now.toISOString(),
          state: "unknown",
        };
    if (!modelAvailabilityAttempt && options.observeAnthropicModels
        && account.provider === "anthropic") {
      modelAvailabilityAttempt = {
        status: "unavailable",
        targetId: account.id,
        attemptedAt: now.toISOString(),
        reason: "anthropic_models_refresh_unavailable",
      };
    }
    return unavailableReport(
      account, fallback, "usage_observation_store_unavailable", false,
      modelAvailabilityAttempt,
    );
  }
}

function accountsForRequest(accounts: AccountUsageTarget[], requested: RoutingPreference | undefined): AccountUsageTarget[] {
  if (!requested) return accounts;
  const request = typeof requested === "string" ? { provider: requested } : requested;
  if (request.target !== undefined) return accounts.filter(({ id }) => id === request.target);
  if (request.provider && request.provider !== "auto")
    return accounts.filter(({ provider }) => provider === request.provider);
  return accounts;
}

const DEFAULT_AMBIENT_USAGE_TARGETS: AccountUsageTarget[] = [
  { id: "anthropic", provider: "anthropic", authMode: "ambient" },
  { id: "openai", provider: "openai", authMode: "ambient" },
];

function configuredUsageTargets(options: RefreshAccountUsageOptions): AccountUsageTarget[] {
  const context: AccountContext = {
    ...options.context,
    ...(options.env === undefined ? {} : { env: options.env }),
  };
  const configured = loadResourcePolicy(routingPolicyPath(context))?.targets;
  return configured?.length ? configured : DEFAULT_AMBIENT_USAGE_TARGETS;
}

/** Refresh every configured routing account concurrently and never infer plenty from a failed probe. */
export async function refreshAccountUsages(
  options: RefreshAccountUsageOptions = {},
): Promise<AccountUsageReport[]> {
  throwIfProviderRefreshCancelled(options.signal);
  const now = options.now ?? new Date();
  const storePath = options.storePath
    ?? options.env?.NORTH_PROVIDER_OBSERVATIONS
    ?? options.context?.env?.NORTH_PROVIDER_OBSERVATIONS
    ?? process.env.NORTH_PROVIDER_OBSERVATIONS
    ?? DEFAULT_PROVIDER_OBSERVATIONS_PATH;
  const accounts = accountsForRequest(options.accounts ?? configuredUsageTargets(options), options.requested);
  return Promise.all(accounts.map((account) => refreshOne(account, options, storePath, now)));
}
