import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ProviderId } from "./types";
import type { Effort } from "../harness";
import { fableWindowOpen } from "../fable-window";

export type SemanticTier = "economy" | "standard" | "senior" | "frontier";
export const SEMANTIC_TIER_ORDER: readonly SemanticTier[] = [
  "economy", "standard", "senior", "frontier",
];
export interface ResolvedTier { tier?: SemanticTier; model?: string; effort?: Effort; }
export interface CatalogEscalationRung {
  provider: ProviderId;
  tier: SemanticTier;
  model: string;
  effort: Effort;
}
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

interface ProviderCatalog {
  provider: ProviderId;
  modelAliases: Record<string, string>;
  modelDeltas: Record<string, ModelDeltaDescriptor>;
  tiers: Record<SemanticTier, ProviderTier>;
}

function gafferHome(): string {
  return resolve(process.env.GAFFER_HOME ?? `${process.env.HOME}/code/gaffer`);
}

function providerCatalog(provider: ProviderId): ProviderCatalog {
  const path = resolve(gafferHome(), "providers", `${provider}.json`);
  const catalog = JSON.parse(readFileSync(path, "utf8")) as ProviderCatalog;
  if (catalog.provider !== provider || !catalog.tiers || !catalog.modelAliases || !catalog.modelDeltas)
    throw new Error(`invalid Gaffer provider catalog for ${provider} at ${path}`);
  return catalog;
}

/** Resolve a provider-local family alias to the exact catalog model ID. */
export function resolveModelAlias(provider: ProviderId, model?: string): string | undefined {
  if (!model) return undefined;
  return providerCatalog(provider).modelAliases[model] ?? model;
}

/**
 * Return the catalog-declared family alias for a concrete model. Usage-window
 * routing must use this declaration, never infer a family from model spelling.
 */
export function modelFamily(provider: ProviderId, model?: string): string | undefined {
  if (!model) return undefined;
  const catalog = providerCatalog(provider);
  const concrete = catalog.modelAliases[model] ?? model;
  return Object.entries(catalog.modelAliases)
    .find(([, exact]) => exact === concrete)?.[0];
}

export function modelFamilies(provider: ProviderId): string[] {
  return Object.keys(providerCatalog(provider).modelAliases).sort();
}

export function providerSupportsModel(provider: ProviderId, model?: string): boolean {
  if (!model) return true;
  const catalog = providerCatalog(provider);
  const concrete = catalog.modelAliases[model] ?? model;
  return Object.hasOwn(catalog.modelDeltas, concrete);
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

/**
 * Project Gaffer's provider-local semantic tiers into a concrete escalation
 * order. Duplicate model/effort pairs (for example a senior ceiling repeated
 * as the frontier floor) collapse to their first occurrence. A catalog that
 * regresses effort on a new pair is ambiguous and fails closed.
 */
export function catalogEscalationRungs(provider: ProviderId): CatalogEscalationRung[] {
  const effortRank: Record<Effort, number> = {
    low: 0, medium: 1, high: 2, xhigh: 3, max: 4,
  };
  const seen = new Set<string>();
  const result: CatalogEscalationRung[] = [];
  let priorRank = -1;
  for (const tier of SEMANTIC_TIER_ORDER) {
    const entry = tierEntry(provider, tier);
    const model = resolveModelAlias(provider, entry.model);
    if (!model) throw new Error(`provider ${provider} semantic tier ${tier} resolved no model`);
    for (const effort of supportedReasoning(provider, tier)) {
      const key = `${model}\u0000${effort}`;
      if (seen.has(key)) continue;
      const rank = effortRank[effort];
      if (rank < priorRank) {
        throw new Error(
          `provider ${provider} escalation catalog regresses from effort rank ${priorRank} `
          + `to ${effort} at semantic tier ${tier}`,
        );
      }
      seen.add(key);
      priorRank = rank;
      result.push({ provider, tier, model, effort });
    }
  }
  return result;
}

export function providerSupportsRoute(provider: ProviderId, tier?: SemanticTier, reasoning?: Effort): boolean {
  return !tier || !reasoning || supportedReasoning(provider, tier).includes(reasoning);
}

export function resolveTier(provider: ProviderId, tier?: SemanticTier, model?: string, effort?: Effort): ResolvedTier {
  if (model && !providerSupportsModel(provider, model))
    throw new Error(`provider ${provider} does not declare model ${model}`);
  if (!tier) return { model: resolveModelAlias(provider, model), effort };
  const entry = tierEntry(provider, tier);
  const levels = entry.efforts ?? entry.reasoning ?? [];
  if (effort && !levels.includes(effort)) {
    throw new Error(
      `provider ${provider} cannot resolve semantic tier ${tier} with reasoning ${effort}; `
      + `supported reasoning: ${levels.join(", ")}`,
    );
  }

  // Fable is a temporary North runtime promotion, not a Gaffer model pin. Keep
  // any catalog-valid requested reasoning exact and default an unspecified
  // request to xhigh. Max stays on Opus; an explicit model remains the opt-out.
  const temporaryFable = provider === "anthropic" && tier === "frontier" && !model
    && effort !== "max" && fableWindowOpen();
  const resolvedModel = temporaryFable
    ? resolveModelAlias(provider, "fable")
    : resolveModelAlias(provider, model ?? (entry.model === "auto" ? undefined : entry.model));
  const resolvedEffort = temporaryFable
    ? effort ?? "xhigh"
    : effort ?? entry.defaultEffort ?? entry.defaultReasoning;
  return { tier, model: resolvedModel, effort: resolvedEffort };
}
