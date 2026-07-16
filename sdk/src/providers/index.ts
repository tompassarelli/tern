import { anthropicProvider } from "./anthropic";
import { openaiProvider } from "./openai";
import type { AgentProvider, ProviderId, ProviderPreference, RoutingDecision } from "./types";
import type { AgentQuery } from "./types";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { resolveTier, type SemanticTier } from "./catalog";
export { resourcePolicyFromEnv, selectProvider, selectProviderFromAvailability } from "../provider-routing";

const providers: Record<ProviderId, AgentProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

export function providerFor(id: ProviderId): AgentProvider { return providers[id]; }

const RETRYABLE_PROVIDER_ERROR = /usage.?limit|rate.?limit|quota|capacity|overload|exhausted|entitlement|auth(?:entication|orization)?|unauthorized|forbidden|log(?:ged)?\s?in|sign.?in|429|401|403/i;

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
): AgentQuery {
  let active: AgentQuery | undefined;
  const prompt = replayablePrompt(args.prompt);
  const optionsFor = (provider: ProviderId): Options => {
    if (provider === decision.fallbackPath[0]) return args.options;
    const resolved = resolveTier(provider, tier);
    return { ...args.options, model: resolved.model, effort: resolved.effort };
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
          if (decision.requested === "auto" && emitted === 0 && fallback && RETRYABLE_PROVIDER_ERROR.test(message)) {
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
export type { AgentProvider, AllocationMode, EntitlementPressure, ProviderId, ProviderPreference, ResourcePolicy, RoutingDecision } from "./types";
