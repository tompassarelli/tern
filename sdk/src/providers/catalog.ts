import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ProviderId } from "./types";
import type { ReasoningLevel, RoutingTier } from "../routing-metadata";
import { projectProviderCatalog, staffingSource } from "../orchestration-graph-source";

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
  contextWindow?: { tokens: number; effectiveFrom: string };
}

interface ProviderCatalog {
  provider: ProviderId;
  modelAliases: Record<string, string>;
  models: Record<string, ProviderModel>;
  modelDeltas: Record<string, ModelDeltaDescriptor>;
  tiers: Record<SemanticTier, ProviderTier>;
}

export interface CatalogFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface CachedProviderCatalog<T> {
  identity: CatalogFileIdentity;
  value: T;
}

export interface ProviderCatalogFileReader {
  identity(path: string): CatalogFileIdentity;
  read(path: string): string;
}

function catalogFileIdentity(path: string): CatalogFileIdentity {
  const stats = statSync(path, { bigint: true });
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameCatalogFile(
  left: CatalogFileIdentity,
  right: CatalogFileIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

const nodeCatalogFileReader: ProviderCatalogFileReader = {
  identity: catalogFileIdentity,
  read: (path) => readFileSync(path, "utf8"),
};

/** @internal Exported for deterministic cache-boundary tests, not the SDK barrel. */
export class ProviderCatalogFileCache<T> {
  readonly #entries = new Map<string, CachedProviderCatalog<T>>();

  constructor(
    private readonly reader: ProviderCatalogFileReader = nodeCatalogFileReader,
    private readonly attempts = 2,
  ) {}

  load(path: string, parse: (source: string) => T): T {
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const before = this.reader.identity(path);
      const cached = this.#entries.get(path);
      if (cached && sameCatalogFile(cached.identity, before)) return cached.value;

      const source = this.reader.read(path);
      const after = this.reader.identity(path);
      if (!sameCatalogFile(before, after)) continue;

      const value = parse(source);
      this.#entries.set(path, { identity: after, value });
      return value;
    }
    throw new Error(`Gaffer provider catalog changed while reading ${path}`);
  }
}

const providerCatalogCache = new ProviderCatalogFileCache<ProviderCatalog>();

function gafferHome(): string {
  return resolve(process.env.GAFFER_HOME ?? `${process.env.HOME}/code/gaffer`);
}

function validateProviderCatalog(
  catalog: ProviderCatalog,
  provider: ProviderId,
  where: string,
): ProviderCatalog {
  if (catalog.provider !== provider || !catalog.tiers || !catalog.modelAliases
      || !catalog.models || !catalog.modelDeltas)
    throw new Error(`invalid Gaffer provider catalog for ${provider} at ${where}`);
  return catalog;
}

function providerCatalog(provider: ProviderId): ProviderCatalog {
  // Dual-read seam (Phase 1): graph mode reconstructs the identical provider
  // catalog shape from @catalog:current; file mode (default) reads the JSON.
  if (staffingSource() === "graph") {
    return validateProviderCatalog(
      projectProviderCatalog(provider) as ProviderCatalog,
      provider,
      `graph @catalog:current provider ${provider}`,
    );
  }
  const path = resolve(gafferHome(), "providers", `${provider}.json`);
  return providerCatalogCache.load(
    path,
    (source) => validateProviderCatalog(JSON.parse(source) as ProviderCatalog, provider, path),
  );
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

export interface ProviderContextWindowObservation {
  provider: ProviderId;
  model: string;
  tokens: number;
  effectiveFrom: string;
  source: "gaffer-provider-catalog";
}

/** Observe Gaffer's exact-model provider ceiling without changing allocation. */
export function observeProviderContextWindow(
  provider: ProviderId,
  model?: string,
): ProviderContextWindowObservation | undefined {
  if (!model) return undefined;
  const catalog = providerCatalog(provider);
  const concrete = Object.hasOwn(catalog.modelAliases, model) ? catalog.modelAliases[model] : model;
  const value = catalog.models[concrete]?.contextWindow;
  if (!value || !Number.isSafeInteger(value.tokens) || value.tokens < 1
      || typeof value.effectiveFrom !== "string") return undefined;
  return {
    provider, model: concrete, tokens: value.tokens,
    effectiveFrom: value.effectiveFrom, source: "gaffer-provider-catalog",
  };
}

/**
 * Canonicalize a model value for a WRITE onto a durable fact (run telemetry,
 * lane identity). The single place both write paths must call — never
 * reimplement alias resolution locally, and never assert a bare family alias
 * (opus/sonnet/fable/haiku/...) as a model fact.
 *
 * Also refuses a cross-provider phantom: if `model` does not belong to
 * `provider`'s catalog after alias resolution (the fallback-death case where
 * routed-intent model lags the executed provider, e.g. a gpt-* id recorded
 * against provider=anthropic), the caller gets `undefined` back. Writing no
 * model is correct; writing the stale routed one is not.
 */
export function canonicalWriteModel(
  provider: ProviderId | undefined,
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  if (!provider) return undefined;
  // A native/interactive session can carry a provider string North models no
  // catalog for; we cannot canonicalize what we cannot resolve, so preserve the
  // model verbatim rather than crash the fact write or drop the datum. Only a
  // catalog-KNOWN provider gets alias resolution + the cross-provider phantom
  // guard below.
  let concrete: string;
  try {
    concrete = resolveModelAlias(provider, model) ?? model;
    if (!providerSupportsModel(provider, concrete)) return undefined;
  } catch {
    return model;
  }
  return concrete;
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
