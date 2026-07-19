import {
  ANTHROPIC_MODEL_OBSERVATION_SOURCE,
  type ProviderModelObservation,
} from "../provider-model-observation-store";
import { providerSupportsModel, resolveModelAlias } from "./catalog";
import type { RoutingTarget } from "./types";

export type AnthropicModelsUnavailableReason =
  | "anthropic_models_capability_unavailable"
  | "anthropic_models_probe_aborted"
  | "anthropic_models_probe_failed"
  | "anthropic_models_probe_timed_out"
  | "anthropic_models_response_schema_changed"
  | "anthropic_models_collision";

export class AnthropicModelsUnavailableError extends Error {
  constructor(readonly reason: AnthropicModelsUnavailableReason) {
    super(reason);
    this.name = "AnthropicModelsUnavailableError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))
    return undefined;
  return value;
}

function declaredExact(value: string): string | undefined {
  const exact = resolveModelAlias("anthropic", value);
  return exact && providerSupportsModel("anthropic", exact) ? exact : undefined;
}

/**
 * Project provider-controlled ModelInfo onto Gaffer's exact allowlist. Unknown
 * provider models are ignored and can never prove availability. `value` is the
 * only SDK-declared authority field; display text and undocumented fields never
 * participate in routing.
 */
export function normalizeAnthropicSupportedModels(
  value: unknown,
  target: RoutingTarget,
  now = new Date(),
): ProviderModelObservation {
  if (!Array.isArray(value))
    throw new AnthropicModelsUnavailableError("anthropic_models_response_schema_changed");
  const exactModels = new Set<string>();
  for (const raw of value) {
    if (!record(raw) || identifier(raw.value) === undefined) {
      throw new AnthropicModelsUnavailableError("anthropic_models_response_schema_changed");
    }
    const primary = declaredExact(raw.value as string);
    // A future or otherwise unknown model is not route evidence.
    if (!primary) continue;
    if (exactModels.has(primary))
      throw new AnthropicModelsUnavailableError("anthropic_models_collision");
    exactModels.add(primary);
  }
  const models = [...exactModels].sort();
  const authMode = target.authMode ?? "ambient";
  if (authMode === "isolated" && !target.profile)
    throw new AnthropicModelsUnavailableError("anthropic_models_response_schema_changed");
  return {
    provider: "anthropic",
    targetId: target.id,
    authMode,
    ...(authMode === "isolated" ? { profile: target.profile } : {}),
    observedAt: now.toISOString(),
    source: ANTHROPIC_MODEL_OBSERVATION_SOURCE,
    models,
  };
}
