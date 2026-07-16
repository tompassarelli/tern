import { anthropicProvider } from "./anthropic";
import { openaiProvider } from "./openai";
import { ProviderRetrySafeError, type AgentProvider, type ProviderId, type ProviderPreference, type RoutingDecision } from "./types";
import type { AgentQuery } from "./types";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { resolveTier, type SemanticTier } from "./catalog";
export { resourcePolicyFromEnv, selectProvider, selectProviderFromAvailability } from "../provider-routing";
export {
  applyProviderUsageObservations, automatedPressure, effectivePressure, loadProviderUsageObservations,
  loadResourcePolicy, parseProviderUsageObservations, parseResourcePolicy,
  pressureFromUsageWindows,
} from "../resource-policy";
export { mergeProviderUsageObservations, writeProviderUsageObservations } from "../provider-observation-store";
export {
  normalizeCodexRateLimits, observeCodexEntitlement, readCodexEntitlementObservation,
  refreshCodexEntitlementIfStale, shouldRefreshCodexEntitlement,
} from "../codex-entitlement";

const providers: Record<ProviderId, AgentProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

export function providerFor(id: ProviderId): AgentProvider { return providers[id]; }

function replayablePrompt(prompt: string | AsyncIterable<any>): string | AsyncIterable<any> {
  if (typeof prompt === "string") return prompt;
  const source = prompt[Symbol.asyncIterator]();
  const cache: any[] = [];
  let done = false;
  let pending: Promise<IteratorResult<any>> | undefined;
  const readNext = async (): Promise<IteratorResult<any>> => {
    if (done) return { done: true, value: undefined };
    pending ??= source.next().finally(() => { pending = undefined; });
    const item = await pending;
    if (item.done) done = true;
    else cache.push(item.value);
    return item;
  };
  return {
    async *[Symbol.asyncIterator]() {
      let index = 0;
      while (true) {
        if (index < cache.length) { yield cache[index++]; continue; }
        const item = await readNext();
        if (item.done) return;
        index++;
        yield item.value;
      }
    },
  };
}

// Automatic fallback is intentionally pre-side-effect only: if the primary has
// emitted any event, North cannot prove that retrying is safe. A capacity/auth
// failure before the first event may route to the next healthy provider.
export function routedQuery(
  decision: RoutingDecision,
  args: { prompt: string | AsyncIterable<any>; options: Options },
  tier?: SemanticTier,
  providerRegistry: Record<ProviderId, AgentProvider> = providers,
  beforeFallback?: () => Promise<void>,
): AgentQuery {
  let active: AgentQuery | undefined;
  const prompt = replayablePrompt(args.prompt);
  const optionsFor = (provider: ProviderId): Options => {
    const resolved = provider === decision.fallbackPath[0] ? undefined : resolveTier(provider, tier);
    const options = resolved
      ? { ...args.options, model: resolved.model, effort: resolved.effort }
      : args.options;
    decision.resolvedModel = options.model;
    decision.resolvedEffort = options.effort;
    return options;
  };
  return {
    interrupt: async () => { await active?.interrupt?.(); },
    setModel: async (model: string) => {
      if (!active?.setModel) throw new Error(`provider ${decision.provider} does not support in-flight model escalation`);
      await active.setModel(model);
    },
    async *[Symbol.asyncIterator]() {
      let emitted = 0;
      while (true) {
        try {
          active = providerRegistry[decision.provider].query({
            prompt,
            options: optionsFor(decision.provider),
          });
          for await (const event of active as AsyncIterable<any>) { emitted++; yield event; }
          return;
        } catch (err: any) {
          const message = String(err?.message ?? err);
          const fallback = decision.fallbackProviders[0];
          if (decision.requested === "auto" && emitted === 0 && fallback && err instanceof ProviderRetrySafeError) {
            await beforeFallback?.();
            decision.fallbackProviders.shift();
            const previous = decision.provider;
            decision.provider = fallback;
            decision.entitlementPressure = decision.entitlementPressures[fallback] ?? "unknown";
            decision.fallbackCount++;
            decision.fallbackPath.push(fallback);
            decision.reason = `fallback ${decision.fallbackCount} before side effects: ${previous} -> ${fallback}; ${message.slice(0, 160)}`;
            continue;
          }
          throw err;
        }
      }
    },
  };
}
export { ProviderRetrySafeError } from "./types";
export type { AgentProvider, AllocationMode, EntitlementPressure, ProviderId, ProviderPreference, ResourcePolicy, RoutingDecision } from "./types";
