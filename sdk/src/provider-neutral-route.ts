import { providerSupportsRoute } from "./providers/catalog";
import type { ReasoningLevel, RoutingTier } from "./routing-metadata";

/** A semantic route is executable when at least one pinned provider catalog offers it. */
export function requireProviderNeutralRoute(
  tier: RoutingTier,
  reasoning: ReasoningLevel,
): void {
  if ((["anthropic", "openai"] as const)
    .some((provider) => providerSupportsRoute(provider, tier, reasoning))) return;
  throw new Error(
    `unsupported route: tier '${tier}' with deliberation '${reasoning}' `
    + "resolves through no provider catalog",
  );
}
