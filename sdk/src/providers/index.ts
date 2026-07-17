import { anthropicProvider } from "./anthropic";
import { openaiProvider } from "./openai";
import {
  ProviderEscalationUnsupportedError, ProviderRetrySafeError,
  type AgentProvider, type ProviderId, type ProviderPreference, type RoutingDecision,
} from "./types";
import type { AgentQuery } from "./types";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { resolveTier, type SemanticTier } from "./catalog";
import {
  applyHarnessRoute, harnessRouteSeed,
  type Effort, type HarnessCompositionEvidence,
} from "../harness";
import { markExecutionAdmission } from "../execution-admission";
export {
  ProviderSelectionError, resourcePolicyFromEnv, selectProvider, selectProviderFromAvailability,
} from "../provider-routing";
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

// Automatic fallback is intentionally proof-carrying and pre-side-effect only:
// the adapter must raise ProviderRetrySafeError from a typed condition that
// proves the request was never accepted. No event count or error prose can
// establish that proof. The production Claude adapter currently forwards SDK
// errors unchanged because that SDK exposes no such typed signal.
export function routedQuery(
  decision: RoutingDecision,
  args: { prompt: string | AsyncIterable<any>; options: Options },
  tier?: SemanticTier,
  providerRegistry: Record<ProviderId, AgentProvider> = providers,
  beforeFallback?: () => Promise<void>,
  onRoute?: (decision: RoutingDecision, evidence?: HarnessCompositionEvidence) => void,
): AgentQuery {
  let active: AgentQuery | undefined;
  const prompt = replayablePrompt(args.prompt);
  const requestedReasoning = args.options.effort as Effort | undefined;
  const seed = harnessRouteSeed(args.options);
  const optionsFor = (provider: ProviderId): { options: Options; evidence?: HarnessCompositionEvidence } => {
    // Preserve an explicit model across sibling accounts of the same provider.
    // A cross-provider fallback resolves the semantic tier afresh for that provider.
    const preserveSeed = decision.fallbackCount === 0 || seed?.provider === provider;
    const resolved = preserveSeed
      ? { model: seed?.model, effort: requestedReasoning }
      : resolveTier(provider, tier, undefined, requestedReasoning);
    // applyHarnessRoute looks up immutable composition state by object identity;
    // start from the original harness object and overlay route capacity afterwards.
    const rebuilt = applyHarnessRoute(args.options, provider, resolved.model);
    // A managed route already received a fresh, authority-sealed object from
    // applyHarnessRoute. Preserve that identity; only non-harness callers need
    // a defensive clone here.
    const options = (rebuilt.options === args.options
      ? { ...rebuilt.options }
      : rebuilt.options) as Options;
    if (rebuilt.options === args.options && resolved.model) options.model = resolved.model;
    if (resolved.effort) options.effort = resolved.effort;
    decision.resolvedModel = options.model ?? resolved.model;
    decision.resolvedEffort = options.effort;
    return { options, evidence: rebuilt.evidence };
  };
  return {
    interrupt: async () => { await active?.interrupt?.(); },
    supportsInFlightEscalation: () => Boolean(
      active?.setModel && active?.applyFlagSettings &&
      (active.supportsInFlightEscalation?.() ?? true),
    ),
    setModel: async (model: string) => {
      if (!active?.setModel) throw new ProviderEscalationUnsupportedError(
        `provider ${decision.provider} does not support in-flight model escalation`,
      );
      await active.setModel(model);
      decision.resolvedModel = model;
    },
    applyFlagSettings: async (settings) => {
      if (!active?.applyFlagSettings) throw new ProviderEscalationUnsupportedError(
        `provider ${decision.provider} does not support in-flight effort escalation`,
      );
      await active.applyFlagSettings(settings);
      if (settings.effortLevel !== undefined && settings.effortLevel !== null) {
        decision.resolvedEffort = settings.effortLevel;
      }
    },
    async *[Symbol.asyncIterator]() {
      let emitted = 0;
      while (true) {
        try {
          const route = optionsFor(decision.provider);
          const options = route.options;
          const provider = providerRegistry[decision.provider];
          if (provider.admit) {
            await provider.admit({
              options,
              target: decision.routingTargets[decision.target],
            });
            markExecutionAdmission(decision.provider, options);
          }
          onRoute?.(decision, route.evidence);
          active = provider.query({
            prompt,
            options,
            target: decision.routingTargets[decision.target],
          });
          for await (const event of active as AsyncIterable<any>) { emitted++; yield event; }
          return;
        } catch (err: any) {
          const fallbackTarget = decision.fallbackTargets[0];
          const fallbackProvider = decision.fallbackProviders[0];
          if (decision.requestedTarget === undefined && emitted === 0 && fallbackTarget && fallbackProvider
              && err instanceof ProviderRetrySafeError) {
            await beforeFallback?.();
            decision.fallbackTargets.shift();
            decision.fallbackProviders.shift();
            const previousTarget = decision.target;
            const previousProvider = decision.provider;
            decision.target = fallbackTarget;
            decision.provider = fallbackProvider;
            decision.entitlementPressure = decision.targetEntitlementPressures[fallbackTarget] ?? "unknown";
            decision.fallbackCount++;
            decision.fallbackTargetPath.push(fallbackTarget);
            decision.fallbackPath.push(fallbackProvider);
            decision.fallbackReasons.push(Object.freeze({
              sequence: decision.fallbackCount,
              reason: "provider_retry_safe_before_acceptance",
              fromTarget: previousTarget,
              fromProvider: previousProvider,
              toTarget: fallbackTarget,
              toProvider: fallbackProvider,
            }));
            continue;
          }
          throw err;
        }
      }
    },
  };
}
export { ProviderEscalationUnsupportedError, ProviderRetrySafeError } from "./types";
export type {
  AgentProvider, AllocationMode, EntitlementPressure, ProviderId, ProviderPreference,
  ResourcePolicy, RoutingDecision, RoutingFallbackReason, RoutingPreference, RoutingRequest,
} from "./types";
