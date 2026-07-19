import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ProviderId } from "./types";
import type { ReasoningLevel, RoutingTier } from "../routing-metadata";

export type SemanticTier = RoutingTier;
type Effort = ReasoningLevel;
export const SEMANTIC_TIER_ORDER: readonly SemanticTier[] = [
  "economy", "standard", "senior", "frontier",
];
export interface ResolvedTier { tier?: SemanticTier; model?: string; effort?: Effort; }
export type ModelDeltaDescriptor =
  | { kind: "calibrated"; path: string }
  | { kind: "none"; reason: string };
export type ResolvedModelDelta = ModelDeltaDescriptor & {
  provider: ProviderId;
  model: string;
  absolutePath?: string;
};

interface ProviderTier {
  model: string;
  efforts?: Effort[];
  defaultEffort?: Effort;
  reasoning?: Effort[];
  defaultReasoning?: Effort;
}

interface ProviderModel {
  efforts?: Effort[];
  reasoning?: Effort[];
  routes?: Partial<Record<SemanticTier, Effort[]>>;
}

interface ProviderCatalog {
  provider: ProviderId;
  modelAliases: Record<string, string>;
  models: Record<string, ProviderModel>;
  modelDeltas: Record<string, ModelDeltaDescriptor>;
  tiers: Record<SemanticTier, ProviderTier>;
}

function gafferHome(): string {
  return resolve(process.env.GAFFER_HOME ?? `${process.env.HOME}/code/gaffer`);
}

function providerCatalog(provider: ProviderId): ProviderCatalog {
  const path = resolve(gafferHome(), "providers", `${provider}.json`);
  const catalog = JSON.parse(readFileSync(path, "utf8")) as ProviderCatalog;
  if (catalog.provider !== provider || !catalog.tiers || !catalog.modelAliases
      || !catalog.models || !catalog.modelDeltas)
    throw new Error(`invalid Gaffer provider catalog for ${provider} at ${path}`);
  return catalog;
}

/** Resolve a provider-local family alias to the exact catalog model ID. */
export function resolveModelAlias(provider: ProviderId, model?: string): string | undefined {
  if (!model) return undefined;
  const aliases = providerCatalog(provider).modelAliases;
  return Object.hasOwn(aliases, model) ? aliases[model] : model;
}

/**
 * Return the catalog-declared family alias for a concrete model. Usage-window
 * routing must use this declaration, never infer a family from model spelling.
 */
export function modelFamily(provider: ProviderId, model?: string): string | undefined {
  if (!model) return undefined;
  const catalog = providerCatalog(provider);
  const concrete = Object.hasOwn(catalog.modelAliases, model) ? catalog.modelAliases[model] : model;
  return Object.entries(catalog.modelAliases)
    .find(([, exact]) => exact === concrete)?.[0];
}

export function modelFamilies(provider: ProviderId): string[] {
  return Object.keys(providerCatalog(provider).modelAliases).sort();
}

export function providerSupportsModel(provider: ProviderId, model?: string): boolean {
  if (!model) return true;
  const catalog = providerCatalog(provider);
  const concrete = Object.hasOwn(catalog.modelAliases, model) ? catalog.modelAliases[model] : model;
  return Object.hasOwn(catalog.models, concrete);
}

function tierEntry(provider: ProviderId, tier: SemanticTier): ProviderTier {
  const entry = providerCatalog(provider).tiers?.[tier];
  if (!entry) throw new Error(`provider ${provider} does not define semantic tier ${tier}`);
  if (typeof entry.model !== "string" || !entry.model.trim())
    throw new Error(`provider ${provider} semantic tier ${tier} has no model resolution`);
  const levels = entry.efforts ?? entry.reasoning;
  if (!Array.isArray(levels) || levels.length === 0)
    throw new Error(`provider ${provider} semantic tier ${tier} has no reasoning resolution`);
  return entry;
}

export function resolveModelDelta(provider: ProviderId, model: string): ResolvedModelDelta {
  const descriptor = providerCatalog(provider).modelDeltas[model];
  if (!descriptor) {
    throw new Error(
      `provider ${provider} model ${model} has no exact modelDeltas entry; `
      + "declare a calibrated path or explicit none in Gaffer's provider catalog",
    );
  }
  if (descriptor.kind === "none") {
    if (typeof descriptor.reason !== "string" || !descriptor.reason.trim())
      throw new Error(`provider ${provider} model ${model} has malformed none model delta`);
    return { provider, model, kind: "none", reason: descriptor.reason.trim() };
  }
  if (descriptor.kind !== "calibrated" || typeof descriptor.path !== "string" || !descriptor.path.trim())
    throw new Error(`provider ${provider} model ${model} has malformed calibrated model delta`);
  const root = gafferHome();
  const absolutePath = resolve(root, descriptor.path);
  if (!absolutePath.startsWith(`${root}${sep}`))
    throw new Error(`provider ${provider} model ${model} delta path escapes Gaffer contract root`);
  return { provider, model, kind: "calibrated", path: descriptor.path, absolutePath };
}

export function supportedReasoning(provider: ProviderId, tier: SemanticTier): readonly Effort[] {
  const entry = tierEntry(provider, tier);
  return entry.efforts ?? entry.reasoning ?? [];
}

function supportedReasoningForModel(
  provider: ProviderId,
  model: string,
): readonly Effort[] {
  const catalog = providerCatalog(provider);
  const declaration = Object.hasOwn(catalog.models, model) ? catalog.models[model] : undefined;
  return declaration?.efforts ?? declaration?.reasoning ?? [];
}

function assertModelEffortPair(
  provider: ProviderId,
  model: string | undefined,
  effort: Effort | undefined,
  tier?: SemanticTier,
): void {
  if (!model || !effort) return;
  const catalog = providerCatalog(provider);
  const declaration = Object.hasOwn(catalog.models, model) ? catalog.models[model] : undefined;
  const rawSupported = supportedReasoningForModel(provider, model).includes(effort);
  const routeSupported = !tier || declaration?.routes?.[tier]?.includes(effort) === true;
  const supported = rawSupported && routeSupported;
  if (!supported) {
    throw new Error(
      `provider ${provider} model ${model} does not support reasoning ${effort}`
      + (tier ? ` at semantic tier ${tier}` : ""),
    );
  }
}

export function providerSupportsRoute(
  provider: ProviderId,
  tier?: SemanticTier,
  reasoning?: Effort,
  model?: string,
): boolean {
  if (model) {
    const concrete = resolveModelAlias(provider, model);
    if (!concrete || !providerSupportsModel(provider, concrete)) return false;
    if (!reasoning) return tier === undefined;
    const catalog = providerCatalog(provider);
    const declaration = catalog.models[concrete];
    return supportedReasoningForModel(provider, concrete).includes(reasoning)
      && (!tier || declaration?.routes?.[tier]?.includes(reasoning) === true);
  }
  return !tier || !reasoning || supportedReasoning(provider, tier).includes(reasoning);
}

export function resolveTier(provider: ProviderId, tier?: SemanticTier, model?: string, effort?: Effort): ResolvedTier {
  if (model && !providerSupportsModel(provider, model))
    throw new Error(`provider ${provider} does not declare model ${model}`);
  if (model) {
    const resolvedModel = resolveModelAlias(provider, model)!;
    if (tier && !effort) {
      throw new Error(
        `provider ${provider} exact model ${resolvedModel} requires explicit reasoning at semantic tier ${tier}`,
      );
    }
    assertModelEffortPair(provider, resolvedModel, effort, tier);
    return { ...(tier ? { tier } : {}), model: resolvedModel, effort };
  }
  if (!tier) {
    return { effort };
  }
  const entry = tierEntry(provider, tier);
  const levels = entry.efforts ?? entry.reasoning ?? [];
  if (effort && !levels.includes(effort)) {
    throw new Error(
      `provider ${provider} cannot resolve semantic tier ${tier} with reasoning ${effort}; `
      + `supported reasoning: ${levels.join(", ")}`,
    );
  }

  // Unpinned composition preserves the canonical tier row. Exact pins return
  // above and never consult this default model or infer a tier/model cross-product.
  const resolvedModel = resolveModelAlias(provider, entry.model === "auto" ? undefined : entry.model);
  const resolvedEffort = effort ?? entry.defaultEffort ?? entry.defaultReasoning;
  assertModelEffortPair(
    provider,
    resolvedModel,
    resolvedEffort,
    tier,
  );
  return { tier, model: resolvedModel, effort: resolvedEffort };
}
