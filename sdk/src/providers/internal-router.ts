import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentProvider, AgentQuery, ProviderFallbackTransition, ProviderId, RoutingDecision,
} from "./types";
import {
  ProviderEscalationUnsupportedError, ProviderRetrySafeError,
} from "./types";
import { resolveTier, type SemanticTier } from "./catalog";
import {
  applyHarnessRoute, harnessRouteSeed,
  type Effort, type HarnessCompositionEvidence,
} from "../harness";
import { markExecutionAdmission } from "../execution-admission";
import {
  compileProviderAuthoritySurface, type ProviderAuthoritySurface,
} from "./authority";

function replayablePrompt(
  prompt: string | AsyncIterable<any>,
): string | AsyncIterable<any> {
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
        if (index < cache.length) {
          yield cache[index++];
          continue;
        }
        const item = await readNext();
        if (item.done) return;
        index++;
        yield item.value;
      }
    },
  };
}

/**
 * Internal router harness. The injectable registry exists solely for hermetic
 * adapter/fallback tests and is deliberately not re-exported by providers/index.
 * Production callers receive routedQuery, which closes over the canonical
 * Anthropic/OpenAI registry.
 */
export function routedQueryWithRegistry(
  decision: RoutingDecision,
  args: { prompt: string | AsyncIterable<any>; options: Options },
  tier: SemanticTier | undefined,
  providerRegistry: Readonly<Record<ProviderId, AgentProvider>>,
  beforeFallback?: (transition: ProviderFallbackTransition) => Promise<void>,
  onRoute?: (
    decision: RoutingDecision,
    evidence: HarnessCompositionEvidence | undefined,
    authority: ProviderAuthoritySurface | undefined,
  ) => Promise<void> | void,
  onRouteAttempt?: (decision: RoutingDecision) => void,
): AgentQuery {
  let active: AgentQuery | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const prompt = replayablePrompt(args.prompt);
  const requestedReasoning = args.options.effort as Effort | undefined;
  const seed = harnessRouteSeed(args.options);
  const optionsFor = (
    provider: ProviderId,
  ): { options: Options; evidence?: HarnessCompositionEvidence } => {
    const preserveSeed = decision.fallbackCount === 0 || seed?.provider === provider;
    const resolved = preserveSeed
      ? { model: seed?.model, effort: requestedReasoning }
      : resolveTier(provider, tier, undefined, requestedReasoning);
    const rebuilt = applyHarnessRoute(
      args.options, provider, resolved.model, resolved.effort,
      {
        targetId: decision.target,
        receipt: decision.modelAvailabilityReceipts?.[decision.target],
      },
    );
    const options = (rebuilt.options === args.options
      ? { ...rebuilt.options }
      : rebuilt.options) as Options;
    if (rebuilt.options === args.options && resolved.model)
      options.model = resolved.model;
    if (rebuilt.options === args.options && resolved.effort)
      options.effort = resolved.effort;
    decision.resolvedModel = options.model ?? resolved.model;
    decision.resolvedEffort = options.effort;
    return { options, evidence: rebuilt.evidence };
  };
  return {
    get executionTransport() { return active?.executionTransport; },
    interrupt: async () => { await active?.interrupt?.(); },
    close: () => closePromise ??= (async () => {
      closed = true;
      await active?.close?.();
    })(),
    forceClose: () => {
      closed = true;
      active?.forceClose?.();
    },
    supportsInFlightEscalation: () => Boolean(
      active?.setModel && active?.applyFlagSettings
      && (active.supportsInFlightEscalation?.() ?? true),
    ),
    setModel: async (model: string) => {
      if (!active?.setModel)
        throw new ProviderEscalationUnsupportedError(
          `provider ${decision.provider} does not support in-flight model escalation`,
        );
      await active.setModel(model);
      decision.resolvedModel = model;
    },
    applyFlagSettings: async (settings) => {
      if (!active?.applyFlagSettings)
        throw new ProviderEscalationUnsupportedError(
          `provider ${decision.provider} does not support in-flight effort escalation`,
        );
      await active.applyFlagSettings(settings);
      if (settings.effortLevel !== undefined && settings.effortLevel !== null)
        decision.resolvedEffort = settings.effortLevel;
    },
    async *[Symbol.asyncIterator]() {
      let emitted = 0;
      while (true) {
        if (closed) return;
        try {
          onRouteAttempt?.(decision);
          const route = optionsFor(decision.provider);
          const options = route.options;
          const provider = providerRegistry[decision.provider];
          const managed = (options as any).northCapabilities !== undefined;
          if (managed && !provider.admit)
            throw new ProviderRetrySafeError(
              "managed_provider_admission_unavailable",
            );
          if (provider.admit) {
            await provider.admit({
              options,
              target: decision.routingTargets[decision.target],
            });
            markExecutionAdmission(decision.provider, options);
          }
          const authority = !managed
            ? undefined
            : compileProviderAuthoritySurface(decision.provider, options);
          if (authority && authority.provider !== decision.provider)
            throw new ProviderRetrySafeError(
              "provider_authority_route_mismatch",
            );
          await onRoute?.(decision, route.evidence, authority);
          if (closed) return;
          active = provider.query({
            prompt,
            options,
            target: decision.routingTargets[decision.target],
          });
          if (closed) {
            await active.close?.();
            return;
          }
          for await (const event of active as AsyncIterable<any>) {
            emitted++;
            yield event;
          }
          return;
        } catch (error) {
          const fallbackTarget = decision.fallbackTargets[0];
          const fallbackProvider = decision.fallbackProviders[0];
          if (
            decision.requestedTarget === undefined
            && emitted === 0
            && fallbackTarget
            && fallbackProvider
            && error instanceof ProviderRetrySafeError
          ) {
            // Retry safety proves the provider did not accept the turn; it does
            // not imply its preflight process already exited. Reap the failed
            // route before constructing a fallback target.
            await active?.close?.();
            const previousTarget = decision.target;
            const previousProvider = decision.provider;
            await beforeFallback?.({
              fromTarget: previousTarget,
              fromProvider: previousProvider,
              fromLiveInput: providerRegistry[previousProvider].liveInput,
              toTarget: fallbackTarget,
              toProvider: fallbackProvider,
              toLiveInput: providerRegistry[fallbackProvider].liveInput,
            });
            decision.fallbackTargets.shift();
            decision.fallbackProviders.shift();
            decision.target = fallbackTarget;
            decision.provider = fallbackProvider;
            decision.entitlementPressure =
              decision.targetEntitlementPressures[fallbackTarget] ?? "unknown";
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
          throw error;
        }
      }
    },
  };
}
