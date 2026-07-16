import type { Options } from "@anthropic-ai/claude-agent-sdk";

export type ProviderId = "anthropic" | "openai";
export type ProviderPreference = ProviderId | "auto";
export type EntitlementPressure = "plenty" | "normal" | "low" | "exhausted" | "unknown";
export type AllocationMode = "preferential" | "balanced" | "reserved";

export interface RoutingTarget {
  id: string;
  provider: ProviderId;
  /** Reserved for a future provider adapter account/profile selector. */
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
}

export interface ProviderUsageObservation {
  targetId: string;
  provider: ProviderId;
  observedAt: string;
  until?: string;
  /** Adapter-normalized state when the provider does not expose numeric windows. */
  state?: EntitlementPressure;
  windows?: ProviderUsageWindow[];
}

export interface ProviderUsageObservationStore {
  version: 1;
  observations: ProviderUsageObservation[];
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
  pressureObservations?: Record<string, PressureObservation>;
  automatedPressureObservations?: Record<string, ProviderUsageObservation>;
  targetWeights?: Record<string, number>;
  reservedFrontierTarget?: string;
  reservedFrontierProvider?: ProviderId;
  envelopes?: ResourceEnvelopes;
}

export interface ProviderAvailability {
  provider: ProviderId;
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
  interrupt?(): Promise<void>;
  setModel?(model: string): Promise<void> | void;
}

/**
 * A provider may raise this only when it can prove the request was not accepted
 * and no externally observable tool/model side effect occurred. North never
 * infers retry safety from error text or from an empty output stream.
 */
export class ProviderRetrySafeError extends Error {
  readonly retrySafeBeforeAcceptance = true;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderRetrySafeError";
  }
}

export interface AgentProvider {
  id: ProviderId;
  probe(): ProviderAvailability;
  query(args: { prompt: string | AsyncIterable<any>; options: Options }): AgentQuery;
}

export interface RoutingDecision {
  requested: ProviderPreference;
  provider: ProviderId;
  reason: string;
  availability: ProviderAvailability[];
  fallbackProviders: ProviderId[];
  fallbackCount: number;
  fallbackPath: ProviderId[];
  allocationMode: AllocationMode;
  entitlementPressure: EntitlementPressure;
  entitlementPressures: Partial<Record<ProviderId, EntitlementPressure>>;
  /** Actual model/effort used by the currently active provider route. */
  resolvedModel?: string;
  resolvedEffort?: string;
}
