import { anthropicProvider } from "./anthropic";
import { openaiProvider } from "./openai";
import type { AgentProvider, ProviderId, ProviderPreference, RoutingDecision } from "./types";
import type { AgentQuery } from "./types";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
export { resourcePolicyFromEnv, selectProvider, selectProviderFromAvailability } from "../provider-routing";

const providers: Record<ProviderId, AgentProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

export function providerFor(id: ProviderId): AgentProvider { return providers[id]; }

const CAPACITY_ERROR = /quota|credit|rate.?limit|usage.?limit|billing|exhausted|429/i;

// Automatic fallback is intentionally pre-side-effect only: if the primary has
// emitted any event, North cannot prove that retrying is safe. A capacity/auth
// failure before the first event may route to the next healthy provider.
export function routedQuery(
  decision: RoutingDecision,
  args: { prompt: string | AsyncIterable<any>; options: Options },
): AgentQuery {
  let active: AgentQuery | undefined;
  return {
    interrupt: async () => { await active?.interrupt?.(); },
    setModel: async (model: string) => {
      if (!active?.setModel) throw new Error(`provider ${decision.provider} does not support in-flight model escalation`);
      await active.setModel(model);
    },
    async *[Symbol.asyncIterator]() {
      let emitted = 0;
      try {
        active = providerFor(decision.provider).query(args);
        for await (const event of active as AsyncIterable<any>) { emitted++; yield event; }
      } catch (err: any) {
        const openai = decision.availability.find((x) => x.provider === "openai");
        if (decision.requested === "auto" && decision.provider === "anthropic" && emitted === 0 &&
            openai?.available && CAPACITY_ERROR.test(String(err?.message ?? err))) {
          decision.provider = "openai";
          decision.reason = `fallback before side effects: ${String(err?.message ?? err).slice(0, 160)}`;
          active = providerFor("openai").query(args);
          yield* active as AsyncIterable<any>;
          return;
        }
        throw err;
      }
    },
  };
}
export type { AgentProvider, AllocationMode, EntitlementPressure, ProviderId, ProviderPreference, ResourcePolicy, RoutingDecision } from "./types";
