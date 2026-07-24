import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Effort } from "../harness";
import type { ProviderModelAdmissionReceipt } from "../provider-model-observation-store";

export type ProviderId = "anthropic" | "openai";
export type ProviderPreference = ProviderId | "auto";
export type LiveInputCapability = "streaming" | "unsupported";
export interface RoutingRequest {
  provider?: ProviderPreference;
  /** Exact target pin. Exact pins never fall back to another target. */
  target?: string;
}
export type RoutingPreference = ProviderPreference | RoutingRequest;
export type EntitlementPressure = "plenty" | "normal" | "low" | "exhausted" | "unknown";
export type AllocationMode = "preferential" | "balanced" | "reserved";
export type TargetAuthMode = "ambient" | "isolated";

export interface RoutingTarget {
  id: string;
  provider: ProviderId;
  /** Missing means ambient for policies written before per-target auth existed. */
  authMode?: TargetAuthMode;
  profile?: string;
}

export interface PressureObservation {
  state: EntitlementPressure;
  observedAt: string;
  until?: string;
}

export interface ProviderUsageWindow {
  limitId?: string;
  usedPercent: number;
  resetsAt: string;
  /** Explicit on ambiguous event sources when the number came from the provider. */
  measurementKind?: "provider-measured";
}

/**
 * A provider's categorical rate-limit signal. Unlike a usage window, this is
 * not a numeric utilization measurement.
 */
export interface ProviderUsageCategoricalSignal {
  kind: "warning" | "rejection";
  limitId?: string;
  resetsAt?: string;
}

export type ProviderUsageSource =
  | "claude-agent-sdk:usage-control-experimental"
  | "claude-agent-sdk:rate-limit-event"
  | "claude-code:statusline"
  | "codex-app-server:account-rate-limits";

export interface ProviderUsageUnavailableComponent {
  limitId: string;
  reason: "reset_unavailable" | "utilization_unavailable" | "component_schema_changed";
}

export type ProviderUsageCollectionFailureReason =
  | "anthropic_usage_capability_unavailable"
  | "anthropic_usage_probe_failed"
  | "anthropic_usage_probe_timed_out"
  | "anthropic_usage_rate_limits_unavailable"
  | "anthropic_usage_response_schema_changed"
  | "anthropic_usage_windows_unavailable"
  | "codex_usage_command_unavailable"
  | "codex_usage_probe_failed"
  | "codex_usage_probe_timed_out"
  | "codex_usage_response_schema_changed"
  | "codex_usage_subscription_auth_required"
  | "codex_usage_transport_failed"
  | "codex_usage_windows_unavailable";

export interface ProviderUsageCollectionFailure {
  observedAt: string;
  reason: ProviderUsageCollectionFailureReason;
}

export interface ProviderUsageObservation {
  targetId: string;
  provider: ProviderId;
  /** Missing only on v1 observations written before source provenance existed. */
  source?: ProviderUsageSource;
  observedAt: string;
  until?: string;
  /** Adapter-normalized state when the provider does not expose numeric windows. */
  state?: EntitlementPressure;
  windows?: ProviderUsageWindow[];
  /** Provider-emitted severity kept separate from numeric utilization. */
  categoricalSignals?: ProviderUsageCategoricalSignal[];
  /** Fixed, non-secret reasons that a provider-exposed component was omitted. */
  unavailableComponents?: ProviderUsageUnavailableComponent[];
  /** A failed refresh attached to the last trustworthy observation. */
  collectionFailure?: ProviderUsageCollectionFailure;
}

export interface ProviderUsageObservationStore {
  version: 1;
  observations: ProviderUsageObservation[];
}

export interface AllocationEvidence {
  kind: "numeric-headroom" | "categorical-pressure" | "conservative-floor";
  source: ProviderUsageSource | "legacy-observation" | "manual-policy" | "policy-default";
  observedAt?: string;
  limitId?: string;
  /** Present only for a provider-reported numeric measurement. */
  usedPercent?: number;
  resetsAt?: string;
  /** A routing-only conversion of categorical severity, never provider-measured usage. */
  routingFloorPercent?: number;
  routingFloorExpiresAt?: string;
  /** Optional raw measurement joined to the same canonical provider window. */
  measuredUsedPercent?: number;
  measurementSource?: ProviderUsageSource | "legacy-observation";
  measurementObservedAt?: string;
  collectionFailure?: ProviderUsageCollectionFailure;
}

export interface EnvelopeLimits {
  runs?: number;
  frontierRuns?: number;
  retries?: number;
  parallelism?: number;
}

export interface ResourceEnvelopes {
  default?: EnvelopeLimits;
  month?: EnvelopeLimits;
  week?: EnvelopeLimits;
  projects?: Record<string, EnvelopeLimits>;
  sessions?: Record<string, EnvelopeLimits>;
}

export interface ResourcePolicy {
  version?: 1;
  mode: AllocationMode;
  targets?: RoutingTarget[];
  targetOrder?: string[];
  providerOrder: ProviderId[];
  pressures: Partial<Record<ProviderId, EntitlementPressure>>;
  weights?: Partial<Record<ProviderId, number>>;
  /** Executable pressure keyed by routing target; provider pressures are a compatibility projection. */
  targetPressures?: Record<string, EntitlementPressure>;
  pressureObservations?: Record<string, PressureObservation>;
  /**
   * Compatibility projection of the most constraining provider observation per
   * target. Route selection uses `automatedPressureObservationSets` so a
   * model-scoped window cannot discard independent generic evidence.
   */
  automatedPressureObservations?: Record<string, ProviderUsageObservation>;
  /** Latest usable observation from every independent source, keyed by target. */
  automatedPressureObservationSets?: Record<string, ProviderUsageObservation[]>;
  targetWeights?: Record<string, number>;
  reservedFrontierTarget?: string;
  reservedFrontierProvider?: ProviderId;
  envelopes?: ResourceEnvelopes;
}

export interface ProviderAvailability {
  provider: ProviderId;
  /** Present when the probe was run in a routing target's authentication context. */
  targetId?: string;
  installed?: boolean;
  authenticated?: boolean;
  available: boolean;
  reason: "ready" | "command_missing" | "authentication_missing" | "disabled" | "unknown";
  detail?: string;
}

// Deliberately query-shaped while North migrates its mature supervision loop to
// normalized events. Both adapters satisfy this boundary; provider SDK imports do
// not escape their adapter directory.
export interface AgentQuery {
  [Symbol.asyncIterator](): AsyncIterator<any>;
  /** Exact adapter transport selected for this query; absent until unknowable. */
  readonly executionTransport?: "anthropic-agent-sdk" | "codex-app-server" | "codex-cli";
  interrupt?(): Promise<void>;
  /** Idempotently dispose the provider query and await its owned process boundary. */
  close?(): Promise<void>;
  /** Synchronous second-signal/host-exit defense; never a normal cleanup path. */
  forceClose?(): void;
  setModel?(model: string): Promise<void> | void;
  applyFlagSettings?(settings: { effortLevel?: Effort | null }): Promise<void> | void;
  /** True only when both model and effort can be changed on the active run. */
  supportsInFlightEscalation?(): boolean;
  /** Argument-free actual MCP activity observed by the selected adapter. */
  mcpActivity?(): import("../tool-activity").McpActivityObservation;
  /** Privacy-bounded native command completion evidence observed by the adapter. */
  nativeCommandActivity?(): import("../native-command-activity").NativeCommandActivityObservation;
}

export class ProviderEscalationUnsupportedError extends Error {
  readonly code = "provider_escalation_unsupported";
  constructor(message: string) {
    super(message);
    this.name = "ProviderEscalationUnsupportedError";
  }
}

export const PROVIDER_RUNTIME_TELEMETRY_VERSION = "north:provider-runtime:v1" as const;
export const PROVIDER_UNSENT_PROOF_VERSION = "north:provider-unsent-proof:v1" as const;

export type ProviderRuntimeMode = "native" | "managed";
export type ProviderDispatchPhase =
  | "preaccept"
  | "acceptance_ambiguous"
  | "accepted"
  | "terminal";
export type ProviderReplayDisposition =
  | "proved_unsent"
  | "forbidden"
  | "successor_grant_only"
  | "not_applicable";
export type ProviderCheckpointDisposition =
  | "none"
  | "exact_successor_required"
  | "exact_successor_granted";
export type ProviderPublicationDisposition =
  | "not_started"
  | "cas_pending"
  | "cas_committed"
  | "unverified";
export type ProviderRuntimeReason =
  | "proved_unsent_preaccept"
  | "retry_proof_missing"
  | "openai_provider_acceptance_ambiguous"
  | "openai_provider_failed_after_acceptance"
  | "exact_checkpoint_successor_granted"
  | "delivery_reservation_publication_unverified"
  | "provider_terminal_settled";

export interface ProviderRuntimeTelemetry {
  version: typeof PROVIDER_RUNTIME_TELEMETRY_VERSION;
  mode: ProviderRuntimeMode;
  phase: ProviderDispatchPhase;
  reason: ProviderRuntimeReason;
  replay: ProviderReplayDisposition;
  checkpoint: ProviderCheckpointDisposition;
  publication: ProviderPublicationDisposition;
}

const PROVIDER_RUNTIME_REASONS: readonly ProviderRuntimeReason[] = [
  "proved_unsent_preaccept",
  "retry_proof_missing",
  "openai_provider_acceptance_ambiguous",
  "openai_provider_failed_after_acceptance",
  "exact_checkpoint_successor_granted",
  "delivery_reservation_publication_unverified",
  "provider_terminal_settled",
];

export function providerRuntimeTelemetryValid(
  telemetry: ProviderRuntimeTelemetry | undefined,
): telemetry is ProviderRuntimeTelemetry {
  if (!telemetry
      || Object.keys(telemetry).sort().join(",")
        !== "checkpoint,mode,phase,publication,reason,replay,version"
      || telemetry.version !== PROVIDER_RUNTIME_TELEMETRY_VERSION
      || (telemetry.mode !== "native" && telemetry.mode !== "managed")
      || !PROVIDER_RUNTIME_REASONS.includes(telemetry.reason)
      || !["not_started", "cas_pending", "cas_committed", "unverified"]
        .includes(telemetry.publication)) return false;
  switch (telemetry.reason) {
    case "proved_unsent_preaccept":
      return telemetry.phase === "preaccept"
        && telemetry.replay === "proved_unsent" && telemetry.checkpoint === "none";
    case "retry_proof_missing":
    case "openai_provider_acceptance_ambiguous":
      return telemetry.phase === "acceptance_ambiguous"
        && telemetry.replay === "forbidden" && telemetry.checkpoint === "none";
    case "openai_provider_failed_after_acceptance":
      return telemetry.phase === "accepted"
        && telemetry.replay === "successor_grant_only"
        && telemetry.checkpoint === "exact_successor_required";
    case "exact_checkpoint_successor_granted":
      return telemetry.phase === "accepted"
        && telemetry.replay === "successor_grant_only"
        && telemetry.checkpoint === "exact_successor_granted";
    case "delivery_reservation_publication_unverified":
    case "provider_terminal_settled":
      return telemetry.phase === "terminal"
        && (telemetry.replay === "forbidden" || telemetry.replay === "not_applicable")
        && telemetry.checkpoint === "none";
  }
}

interface ProviderUnsentProofCommon {
  version: typeof PROVIDER_UNSENT_PROOF_VERSION;
  durability: "adapter_receipt";
  requestBytesPrepared: number;
  requestBytesSent: 0;
  observableEvents: 0;
}

export type ProviderUnsentProof = ProviderUnsentProofCommon & (
  | { mode: "managed"; source: "adapter_preflight" | "managed_pre_thread_receipt" }
  | { mode: "native"; source: "native_supervisor_unavailable" }
);

type ProviderUnsentProofInput =
  | { mode: "managed"; source: "adapter_preflight" | "managed_pre_thread_receipt"; requestBytesPrepared: number }
  | { mode: "native"; source: "native_supervisor_unavailable"; requestBytesPrepared: number };

function validByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function providerUnsentProofValid(
  proof: ProviderUnsentProof | undefined,
): proof is ProviderUnsentProof {
  return Boolean(proof
    && Object.keys(proof).sort().join(",")
      === "durability,mode,observableEvents,requestBytesPrepared,requestBytesSent,source,version"
    && proof.version === PROVIDER_UNSENT_PROOF_VERSION
    && ((proof.mode === "managed"
      && (proof.source === "adapter_preflight" || proof.source === "managed_pre_thread_receipt"))
      || (proof.mode === "native" && proof.source === "native_supervisor_unavailable"))
    && proof.durability === "adapter_receipt"
    && validByteCount(proof.requestBytesPrepared)
    && proof.requestBytesSent === 0
    && proof.observableEvents === 0);
}

/** Typed provider failure. Accepted and ambiguous failures are never replayable. */
export class ProviderRuntimeError extends Error {
  constructor(
    message: string,
    readonly telemetry: ProviderRuntimeTelemetry,
    options?: ErrorOptions,
  ) {
    super(message, options);
    if (!providerRuntimeTelemetryValid(telemetry))
      throw new Error("invalid provider runtime telemetry");
    this.name = "ProviderRuntimeError";
    Object.freeze(telemetry);
  }
}

/**
 * Preaccept failures remain non-replayable unless constructed with an exact
 * adapter receipt proving zero provider-bound bytes and zero observable events.
 * A bare instance is useful terminal classification, never fallback authority.
 */
export class ProviderRetrySafeError extends ProviderRuntimeError {
  readonly retrySafeBeforeAcceptance: boolean;

  constructor(
    message: string,
    options?: ErrorOptions,
    readonly unsentProof?: ProviderUnsentProof,
  ) {
    const proofValid = providerUnsentProofValid(unsentProof);
    super(message, {
      version: PROVIDER_RUNTIME_TELEMETRY_VERSION,
      mode: proofValid ? unsentProof.mode : "managed",
      phase: proofValid ? "preaccept" : "acceptance_ambiguous",
      reason: proofValid ? "proved_unsent_preaccept" : "retry_proof_missing",
      replay: proofValid ? "proved_unsent" : "forbidden",
      checkpoint: "none",
      publication: "not_started",
    }, options);
    this.name = "ProviderRetrySafeError";
    this.retrySafeBeforeAcceptance = proofValid;
    if (unsentProof) Object.freeze(unsentProof);
  }

  static provedUnsent(
    message: string,
    proof: ProviderUnsentProofInput,
    options?: ErrorOptions,
  ): ProviderRetrySafeError {
    if (!validByteCount(proof.requestBytesPrepared)
        || (proof.mode === "managed"
          ? proof.source !== "adapter_preflight" && proof.source !== "managed_pre_thread_receipt"
          : proof.source !== "native_supervisor_unavailable")) {
      throw new Error("provider unsent proof is invalid");
    }
    return new ProviderRetrySafeError(message, options, {
      version: PROVIDER_UNSENT_PROOF_VERSION,
      ...proof,
      durability: "adapter_receipt",
      requestBytesSent: 0,
      observableEvents: 0,
    });
  }
}

export function isProvedUnsentPreacceptFailure(
  error: unknown,
): error is ProviderRetrySafeError & { unsentProof: ProviderUnsentProof } {
  return error instanceof ProviderRetrySafeError
    && error.retrySafeBeforeAcceptance
    && error.telemetry.phase === "preaccept"
    && error.telemetry.replay === "proved_unsent"
    && providerUnsentProofValid(error.unsentProof);
}

/** Preflight helper for code that runs before prompt transport construction. */
export function providerPreacceptError(
  message: string,
  options?: ErrorOptions,
): ProviderRetrySafeError {
  return ProviderRetrySafeError.provedUnsent(message, {
    mode: "managed",
    source: "adapter_preflight",
    requestBytesPrepared: 0,
  }, options);
}

export interface RoutingFallbackReason {
  sequence: number;
  reason: "provider_retry_safe_before_acceptance";
  fromTarget: string;
  fromProvider: ProviderId;
  toTarget: string;
  toProvider: ProviderId;
  phase: "preaccept";
  replay: "proved_unsent";
  proof: ProviderUnsentProof;
}

export interface ProviderFallbackTransition {
  fromTarget: string;
  fromProvider: ProviderId;
  fromLiveInput: LiveInputCapability;
  toTarget: string;
  toProvider: ProviderId;
  toLiveInput: LiveInputCapability;
}

export interface AgentProvider {
  id: ProviderId;
  /** Whether this adapter can consume user turns after its initial prompt. */
  liveInput: LiveInputCapability;
  probe(target?: RoutingTarget): ProviderAvailability;
  /** Fail before a provider can accept the turn when the compiled harness is unenforceable. */
  admit?(args: {
    options: Options;
    target?: RoutingTarget;
  }): Promise<void> | void;
  /**
   * `resume` carries a prior provider session id so this construction opens a
   * fresh turn that continues that conversation instead of racing the previous
   * turn's closing stream (thread 019f8ec5). Only streaming-input adapters that
   * tear the session down after a terminal honor it; frame-based adapters
   * (codex) already re-open a turn per input frame and ignore it.
   */
  query(args: { prompt: string | AsyncIterable<any>; options: Options; target?: RoutingTarget; resume?: string }): AgentQuery;
}

export interface RoutingDecision {
  /** Compatibility alias for requestedProvider. */
  requested: ProviderPreference;
  requestedProvider: ProviderPreference;
  requestedTarget?: string;
  target: string;
  provider: ProviderId;
  /** Immutable target metadata used by provider adapters for target-scoped auth. */
  routingTargets: Record<string, RoutingTarget>;
  /** Initial allocation explanation. Never replaced by execution fallback detail. */
  readonly selectionReason: string;
  /** Compatibility alias for selectionReason. */
  readonly reason: string;
  availability: ProviderAvailability[];
  /** Remaining eligible target IDs, in retry order. */
  fallbackTargets: string[];
  /** Append-only target IDs actually attempted, beginning with the selected target. */
  readonly fallbackTargetPath: string[];
  /** Provider projection of fallbackTargets; duplicate providers are meaningful. */
  fallbackProviders: ProviderId[];
  fallbackCount: number;
  /** Append-only provider projection of fallbackTargetPath. */
  readonly fallbackPath: ProviderId[];
  /** Append-only redacted, structured fallback decisions in occurrence order. */
  readonly fallbackReasons: RoutingFallbackReason[];
  allocationMode: AllocationMode;
  entitlementPressure: EntitlementPressure;
  targetEntitlementPressures: Record<string, EntitlementPressure>;
  entitlementPressures: Partial<Record<ProviderId, EntitlementPressure>>;
  /** Immutable allocator inputs captured at decision time for later replay/audit. */
  allocationEvidenceByTarget?: Record<string, AllocationEvidence>;
  /** Fresh target/model observations admitted before provider execution. */
  readonly modelAvailabilityReceipts?: Readonly<Record<string, ProviderModelAdmissionReceipt>>;
  /** Targets whose concrete route is forbidden without such a receipt. */
  readonly modelAvailabilityRequiredTargets?: readonly string[];
  /** Actual model/effort used by the currently active provider route. */
  resolvedModel?: string;
  resolvedEffort?: string;
}
