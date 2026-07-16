import { spawnSync } from "node:child_process";
import type { SemanticTier } from "./providers/catalog";
import type {
  EntitlementPressure,
  ProviderAvailability,
  ProviderId,
  ProviderPreference,
  ResourcePolicy,
  RoutingDecision,
} from "./providers/types";

const PROVIDERS: ProviderId[] = ["anthropic", "openai"];

function providerList(value: string | undefined): ProviderId[] {
  const parsed = (value ?? "anthropic,openai")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ProviderId => PROVIDERS.includes(entry as ProviderId));
  return [...new Set(parsed.length ? parsed : PROVIDERS)];
}

function pressure(value: string | undefined): EntitlementPressure {
  return value === "plenty" || value === "normal" || value === "low" || value === "exhausted"
    ? value
    : "unknown";
}

function weights(value: string | undefined): Partial<Record<ProviderId, number>> {
  const result: Partial<Record<ProviderId, number>> = {};
  for (const item of (value ?? "").split(",")) {
    const [id, raw] = item.split("=").map((part) => part.trim());
    const parsed = Number(raw);
    if (PROVIDERS.includes(id as ProviderId) && Number.isFinite(parsed) && parsed > 0)
      result[id as ProviderId] = parsed;
  }
  return result;
}

export function resourcePolicyFromEnv(): ResourcePolicy {
  const rawMode = process.env.NORTH_ALLOCATION_MODE;
  const mode = rawMode === "balanced" || rawMode === "reserved" ? rawMode : "preferential";
  const reserved = process.env.NORTH_RESERVED_FRONTIER_PROVIDER;
  return {
    mode,
    providerOrder: providerList(process.env.NORTH_PROVIDER_ORDER),
    pressures: {
      anthropic: pressure(process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE),
      openai: pressure(process.env.NORTH_OPENAI_ENTITLEMENT_PRESSURE),
    },
    weights: weights(process.env.NORTH_PROVIDER_WEIGHTS),
    reservedFrontierProvider: PROVIDERS.includes(reserved as ProviderId) ? reserved as ProviderId : undefined,
  };
}

export function probeAnthropic(): ProviderAvailability {
  if (process.env.NORTH_DISABLE_ANTHROPIC === "1")
    return { provider: "anthropic", available: false, reason: "disabled" };
  return { provider: "anthropic", available: true, reason: "ready" };
}

export function probeOpenAI(): ProviderAvailability {
  if (process.env.NORTH_DISABLE_OPENAI === "1")
    return { provider: "openai", available: false, reason: "disabled" };
  const command = process.env.NORTH_CODEX_BIN ?? "codex";
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 3000 });
  if (result.error || result.status !== 0)
    return {
      provider: "openai",
      available: false,
      reason: "command_missing",
      detail: result.error?.message ?? result.stderr,
    };
  return { provider: "openai", available: true, reason: "ready", detail: result.stdout.trim() };
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const pressureWeight: Record<EntitlementPressure, number> = {
  plenty: 4,
  normal: 2,
  unknown: 1,
  low: 0.25,
  exhausted: 0,
};

function stateOf(availability: ProviderAvailability[], id: ProviderId): ProviderAvailability {
  return availability.find((entry) => entry.provider === id) ?? {
    provider: id, available: false, reason: "unknown",
  };
}

export function selectProviderFromAvailability(
  requested: ProviderPreference,
  availability: ProviderAvailability[],
  policy: ResourcePolicy,
  tier?: SemanticTier,
  stableKey = "default",
): RoutingDecision {
  const getPressure = (id: ProviderId) => policy.pressures[id] ?? "unknown";
  const eligible = (id: ProviderId) => stateOf(availability, id).available && getPressure(id) !== "exhausted";

  if (requested !== "auto") {
    const state = stateOf(availability, requested);
    if (!state.available)
      throw new Error(`provider ${requested} unavailable: ${state.reason}${state.detail ? ` (${state.detail})` : ""}`);
    if (getPressure(requested) === "exhausted")
      throw new Error(`provider ${requested} entitlement exhausted`);
    return {
      requested,
      provider: requested,
      reason: `explicit provider; mode=${policy.mode}; pressure=${getPressure(requested)}`,
      availability,
      fallbackProviders: [],
      fallbackCount: 0,
      fallbackPath: [requested],
      allocationMode: policy.mode,
      entitlementPressure: getPressure(requested),
      entitlementPressures: policy.pressures,
    };
  }

  const order = [...new Set([...policy.providerOrder, ...PROVIDERS])];
  const candidates = order.filter(eligible);
  if (!candidates.length)
    throw new Error(`no agent provider available: ${availability.map((entry) => `${entry.provider}=${entry.reason}/${getPressure(entry.provider)}`).join(", ")}`);

  let chosen: ProviderId;
  let detail: string;
  if (policy.mode === "reserved" && policy.reservedFrontierProvider) {
    const reserve = policy.reservedFrontierProvider;
    if (tier === "frontier" && eligible(reserve)) {
      chosen = reserve;
      detail = `frontier reserve=${reserve}`;
    } else {
      const alternatives = candidates.filter((id) => id !== reserve);
      chosen = alternatives[0] ?? candidates[0];
      detail = tier === "frontier" ? `reserve=${reserve} unavailable` : `preserving frontier reserve=${reserve}`;
    }
  } else if (policy.mode === "balanced") {
    const weighted = candidates.map((id) => ({
      id,
      weight: Math.max(0.001, (policy.weights?.[id] ?? 1) * pressureWeight[getPressure(id)]),
    }));
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    let slot = (stableHash(stableKey) / 0x1_0000_0000) * total;
    chosen = weighted[weighted.length - 1].id;
    for (const item of weighted) {
      slot -= item.weight;
      if (slot < 0) { chosen = item.id; break; }
    }
    detail = `stable-key=${stableKey}; effective-weights=${weighted.map(({ id, weight }) => `${id}:${weight}`).join(",")}`;
  } else {
    chosen = candidates[0];
    detail = `order=${order.join(" -> ")}`;
  }

  return {
    requested: "auto",
    provider: chosen,
    reason: `mode=${policy.mode}; pressure=${getPressure(chosen)}; ${detail}`,
    availability,
    fallbackProviders: candidates.filter((id) => id !== chosen),
    fallbackCount: 0,
    fallbackPath: [chosen],
    allocationMode: policy.mode,
    entitlementPressure: getPressure(chosen),
    entitlementPressures: policy.pressures,
  };
}

export function selectProvider(
  requested?: ProviderPreference,
  policy: ResourcePolicy = resourcePolicyFromEnv(),
  context: { tier?: SemanticTier; stableKey?: string } = {},
): RoutingDecision {
  const preference = requested ?? (process.env.AGENT_PROVIDER as ProviderPreference | undefined) ?? "auto";
  const availability = [probeAnthropic(), probeOpenAI()];
  return selectProviderFromAvailability(preference, availability, policy, context.tier, context.stableKey);
}
