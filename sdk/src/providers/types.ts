import type { Options } from "@anthropic-ai/claude-agent-sdk";

export type ProviderId = "anthropic" | "openai";
export type ProviderPreference = ProviderId | "auto";

export interface ProviderAvailability {
  provider: ProviderId;
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
}
