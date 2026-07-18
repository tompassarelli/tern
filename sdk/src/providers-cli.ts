import { probeAnthropic, probeOpenAI, resourcePolicyFromEnv, selectProviderFromAvailability,
  balancedAllocationEstimates, type BalancedAllocationEstimate } from "./provider-routing";
import { refreshAccountUsages, type AccountUsageReport } from "./account-usage";
import { northSourceIdentity } from "./providers/source-identity";
import type {
  AllocationEvidence,
  AllocationMode,
  EntitlementPressure,
  ProviderAvailability,
  ProviderId,
  ProviderUsageUnavailableComponent,
  ProviderUsageWindow,
  ResourcePolicy,
} from "./providers/types";
import { modelFamilies, resolveModelAlias } from "./providers/catalog";

const DIAGNOSTIC_STABLE_KEY = "north-providers-diagnostic";

export interface ProviderUsageStatus {
  status: "observed" | "unavailable";
  cached: boolean;
  source: string;
  observedAt: string;
  lastSuccessfulObservedAt: string | null;
  collectionAttemptedAt: string | null;
  windows: ProviderUsageWindow[];
  unavailableComponents: ProviderUsageUnavailableComponent[];
  reason: string | null;
}

export interface ProviderTargetStatus {
  id: string;
  provider: ProviderId;
  installed: boolean;
  authenticated: boolean;
  available: boolean;
  availabilityReason: ProviderAvailability["reason"];
  routing: "eligible" | "unavailable" | "disabled" | "exhausted";
  headroom: EntitlementPressure;
  usage: ProviderUsageStatus | null;
  allocation: {
    eligible: boolean;
    effectiveWeight: number;
    approximateShare: number;
    evidence: AllocationEvidence;
  } | null;
  /** Model-family constraints omitted from the route-unspecified scalar. */
  scopedConstraints: Array<{
    family: string;
    model: string;
    headroom: EntitlementPressure;
    routing: "eligible" | "exhausted";
    evidence: AllocationEvidence;
  }>;
}

export interface ProvidersStatusDocument {
  schemaVersion: 3;
  source: string;
  allocationMode: AllocationMode;
  providers: Array<{
    provider: ProviderId;
    label: string;
    targets: ProviderTargetStatus[];
  }>;
  diagnosticRouteProbe: {
    stableKey: string;
    available: boolean;
    target: string | null;
    provider: ProviderId | null;
    reason: string;
  };
}

function sourceIdentity(): string {
  const root = new URL("../..", import.meta.url).pathname;
  return northSourceIdentity(root);
}

function usageStatus(report: AccountUsageReport | undefined): ProviderUsageStatus | null {
  if (!report) return null;
  return {
    status: report.status,
    cached: report.cached,
    source: report.source,
    observedAt: report.observedAt,
    lastSuccessfulObservedAt: report.lastSuccessfulObservedAt ?? null,
    collectionAttemptedAt: report.collectionAttemptedAt ?? null,
    windows: report.observation.windows ?? [],
    unavailableComponents: report.unavailableComponents,
    reason: report.reason ?? null,
  };
}

function targetStatus(
  availability: ProviderAvailability,
  policy: ResourcePolicy,
  usage: AccountUsageReport | undefined,
  estimate: BalancedAllocationEstimate | undefined,
  scopedConstraints: ProviderTargetStatus["scopedConstraints"] = [],
): ProviderTargetStatus {
  const headroom = estimate?.pressure
    ?? policy.targetPressures?.[availability.targetId!]
    ?? policy.pressures[availability.provider]
    ?? "unknown";
  return {
    id: availability.targetId!,
    provider: availability.provider,
    installed: availability.installed === true,
    authenticated: availability.authenticated === true,
    available: availability.available,
    availabilityReason: availability.reason,
    routing: availability.reason === "disabled" ? "disabled"
      : !availability.available ? "unavailable"
        : headroom === "exhausted" ? "exhausted"
          : "eligible",
    headroom,
    usage: usageStatus(usage),
    allocation: policy.mode === "balanced" && estimate ? {
      eligible: estimate.eligible,
      effectiveWeight: estimate.effectiveWeight,
      approximateShare: estimate.approximateShare,
      evidence: estimate.allocationEvidence,
    } : null,
    scopedConstraints,
  };
}

function familyScopedEvidence(family: string, evidence: AllocationEvidence): boolean {
  const id = evidence.limitId?.toLowerCase() ?? "";
  return id.includes(`seven_day_${family}`) || id === `claude:model:${family}`;
}

export function buildProvidersStatusDocument(input: {
  source: string;
  accountUsage: AccountUsageReport[];
  policy: ResourcePolicy;
  availability: ProviderAvailability[];
  stableKey?: string;
}): ProvidersStatusDocument {
  const stableKey = input.stableKey ?? DIAGNOSTIC_STABLE_KEY;
  const estimates = input.policy.mode === "balanced"
    ? balancedAllocationEstimates(input.availability, input.policy)
    : [];
  const scopedByTarget = new Map<string, ProviderTargetStatus["scopedConstraints"]>();
  if (input.policy.mode === "balanced") {
    for (const family of modelFamilies("anthropic")) {
      const model = resolveModelAlias("anthropic", family)!;
      for (const estimate of balancedAllocationEstimates(
        input.availability, input.policy, undefined, undefined, model,
      )) {
        if (estimate.provider !== "anthropic" || !familyScopedEvidence(family, estimate.allocationEvidence)) continue;
        scopedByTarget.set(estimate.target, [...(scopedByTarget.get(estimate.target) ?? []), {
          family, model, headroom: estimate.pressure,
          routing: estimate.pressure === "exhausted" ? "exhausted" : "eligible",
          evidence: estimate.allocationEvidence,
        }]);
      }
    }
  }
  const targetStatuses = input.availability.map((availability) => targetStatus(
    availability,
    input.policy,
    input.accountUsage.find(({ accountId }) => accountId === availability.targetId),
    estimates.find(({ target }) => target === availability.targetId),
    scopedByTarget.get(availability.targetId!) ?? [],
  ));
  let diagnosticRouteProbe: ProvidersStatusDocument["diagnosticRouteProbe"];
  try {
    const decision = selectProviderFromAvailability("auto", input.availability, input.policy, undefined, stableKey);
    diagnosticRouteProbe = {
      stableKey,
      available: true,
      target: decision.target,
      provider: decision.provider,
      reason: decision.reason,
    };
  } catch (error) {
    diagnosticRouteProbe = {
      stableKey,
      available: false,
      target: null,
      provider: null,
      reason: error instanceof Error ? error.message : "provider selection unavailable",
    };
  }
  return {
    schemaVersion: 3,
    source: input.source,
    allocationMode: input.policy.mode,
    providers: ([
      { provider: "anthropic", label: "Claude / Anthropic" },
      { provider: "openai", label: "Codex / OpenAI" },
    ] as const).map((group) => ({
      ...group,
      targets: targetStatuses.filter(({ provider }) => provider === group.provider),
    })).filter(({ targets }) => targets.length > 0),
    diagnosticRouteProbe,
  };
}

function displayNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function renderAllocationEvidence(evidence: AllocationEvidence): string {
  const pieces = [
    evidence.source,
    ...(evidence.observedAt ? [`observed ${evidence.observedAt}`] : []),
    ...(evidence.limitId ? [evidence.limitId] : []),
  ];
  if (evidence.kind === "conservative-floor") {
    pieces.push(`routing-only categorical floor ${evidence.routingFloorPercent}%`);
    if (evidence.routingFloorExpiresAt) pieces.push(`expires ${evidence.routingFloorExpiresAt}`);
    if (evidence.measuredUsedPercent !== undefined)
      pieces.push(`separate provider measurement ${evidence.measuredUsedPercent}% via ${evidence.measurementSource ?? "unknown source"}${evidence.measurementObservedAt ? ` at ${evidence.measurementObservedAt}` : ""}`);
  } else if (evidence.usedPercent !== undefined) {
    pieces.push(`provider-measured ${evidence.usedPercent}% used`);
  }
  return pieces.join(" · ");
}

export function renderProvidersStatus(document: ProvidersStatusDocument): string {
  const lines = [
    `source           ${document.source}`,
    `allocation mode  ${document.allocationMode}`,
  ];
  for (const group of document.providers) {
    lines.push("", group.label);
    for (const target of group.targets) {
      lines.push(`  ${target.id}`);
      lines.push(`    CLI:            ${target.installed ? "installed" : "unavailable"}`);
      lines.push(`    authentication: ${target.authenticated ? "logged in" : "not logged in"}`);
      lines.push(`    routing:        ${target.routing}`);
      lines.push(`    headroom:       ${target.headroom}`);
      if (target.allocation) {
        if (target.allocation.eligible)
          lines.push(`    balanced estimate (route unspecified): weight ${displayNumber(target.allocation.effectiveWeight)} · approximately ${(target.allocation.approximateShare * 100).toFixed(1)}% of eligible auto routes (not a quota)`);
        else
          lines.push(`    balanced estimate (route unspecified): ineligible · weight ${displayNumber(target.allocation.effectiveWeight)}`);
        const evidence = target.allocation.evidence;
        lines.push(`    allocation evidence: ${renderAllocationEvidence(evidence)}`);
        if (evidence.collectionFailure)
          lines.push(`      latest collection failure: ${evidence.collectionFailure.reason} · attempted ${evidence.collectionFailure.observedAt}`);
      }
      if (target.usage) {
        lines.push(`    usage source:    ${target.usage.source}`);
        if (target.usage.lastSuccessfulObservedAt)
          lines.push(`    usage evidence:  ${target.usage.lastSuccessfulObservedAt}${target.usage.cached ? " (cached)" : ""}`);
        if (target.usage.collectionAttemptedAt)
          lines.push(`    collection tried: ${target.usage.collectionAttemptedAt}`);
        for (const window of target.usage.windows)
          lines.push(`      ${window.limitId ?? "subscription"}: ${window.usedPercent}% used · resets ${window.resetsAt}`);
        for (const component of target.usage.unavailableComponents)
          lines.push(`      ${component.limitId}: unavailable (${component.reason})`);
        if (target.usage.status === "unavailable")
          lines.push(`    usage reason:    ${target.usage.reason ?? "usage_unavailable"}`);
      }
      for (const scoped of target.scopedConstraints) {
        const evidence = scoped.evidence;
        lines.push(`    route-dependent: ${scoped.family} (${scoped.model}) is ${scoped.routing}; headroom ${scoped.headroom}`);
        lines.push(`      evidence: ${renderAllocationEvidence(evidence)}`);
      }
    }
  }
  const sample = document.diagnosticRouteProbe;
  lines.push("");
  lines.push(sample.available
    ? `diagnostic route probe (not a preference; stable key: ${sample.stableKey})  ${sample.target} (${sample.provider})  ${sample.reason}`
    : `diagnostic route probe (not a preference; stable key: ${sample.stableKey})  unavailable  ${sample.reason}`);
  if (document.allocationMode === "balanced")
    lines.push("  one deterministic probe only; per-account estimates above are conservative without a tier/model and may vary by route");
  return `${lines.join("\n")}\n`;
}

export async function collectProvidersStatus(): Promise<ProvidersStatusDocument> {
  const accountUsage = await refreshAccountUsages();
  const policy = resourcePolicyFromEnv();
  const targets = policy.targets?.length ? policy.targets : [
    { id: "anthropic", provider: "anthropic" as const, authMode: "ambient" as const },
    { id: "openai", provider: "openai" as const, authMode: "ambient" as const },
  ];
  const availability = targets.map((target) => ({
    ...(target.provider === "anthropic" ? probeAnthropic(target) : probeOpenAI(target)),
    targetId: target.id,
  }));
  return buildProvidersStatusDocument({
    source: sourceIdentity(), accountUsage, policy, availability,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--json") || args.length > 1) {
    console.error("usage: north providers [--json]");
    process.exitCode = 2;
    return;
  }
  try {
    const document = await collectProvidersStatus();
    process.stdout.write(args[0] === "--json"
      ? `${JSON.stringify(document, null, 2)}\n`
      : renderProvidersStatus(document));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
