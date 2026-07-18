import { expect, test } from "bun:test";
import {
  buildProvidersStatusDocument,
  renderProvidersStatus,
  type ProvidersStatusDocument,
} from "../src/providers-cli";
import type { AccountUsageReport } from "../src/account-usage";
import type { ProviderAvailability, ResourcePolicy } from "../src/providers/types";

const observedAt = new Date().toISOString();
const resetsAt = "2099-01-01T00:00:00.000Z";
const availability: ProviderAvailability[] = [
  { targetId: "claude-personal", provider: "anthropic", installed: true,
    authenticated: true, available: true, reason: "ready" },
  { targetId: "codex-personal", provider: "openai", installed: true,
    authenticated: true, available: true, reason: "ready" },
];
const policy: ResourcePolicy = {
  version: 1,
  mode: "balanced",
  targets: [
    { id: "claude-personal", provider: "anthropic", authMode: "isolated", profile: "claude-personal" },
    { id: "codex-personal", provider: "openai", authMode: "isolated", profile: "codex-personal" },
  ],
  targetOrder: ["claude-personal", "codex-personal"],
  providerOrder: ["anthropic", "openai"],
  pressures: { anthropic: "low", openai: "plenty" },
  targetPressures: { "claude-personal": "low", "codex-personal": "plenty" },
  automatedPressureObservations: {
    "claude-personal": {
      targetId: "claude-personal", provider: "anthropic", observedAt,
      windows: [{ limitId: "claude:seven_day", usedPercent: 80, resetsAt }],
    },
    "codex-personal": {
      targetId: "codex-personal", provider: "openai", observedAt,
      windows: [{ limitId: "codex:primary", usedPercent: 20, resetsAt }],
    },
  },
};
const accountUsage: AccountUsageReport[] = [{
  accountId: "codex-personal",
  provider: "openai",
  source: "codex-app-server:account-rate-limits",
  observedAt,
  status: "observed",
  cached: true,
  observation: {
    targetId: "codex-personal", provider: "openai",
    source: "codex-app-server:account-rate-limits", observedAt,
    windows: [{ limitId: "codex:primary", usedPercent: 20, resetsAt }],
  },
  unavailableComponents: [],
}];

function document(): ProvidersStatusDocument {
  return buildProvidersStatusDocument({
    source: "checkout abc123 dirty", accountUsage, policy, availability, stableKey: "fixture-key",
  });
}

test("providers JSON schema groups targets and exposes normalized balanced estimates", () => {
  const first = document();
  const second = document();
  expect(second).toEqual(first);
  expect(first).toMatchObject({
    schemaVersion: 3,
    source: "checkout abc123 dirty",
    allocationMode: "balanced",
    providers: [
      {
        provider: "anthropic", label: "Claude / Anthropic",
        targets: [{
          id: "claude-personal", installed: true, authenticated: true,
          headroom: "low", usage: null,
          allocation: {
            eligible: true, effectiveWeight: 0.2, approximateShare: 0.2,
            evidence: { kind: "numeric-headroom", source: "legacy-observation",
              limitId: "claude:seven_day", usedPercent: 80 },
          },
        }],
      },
      {
        provider: "openai", label: "Codex / OpenAI",
        targets: [{
          id: "codex-personal", installed: true, authenticated: true,
          headroom: "plenty",
          usage: { status: "observed", cached: true, source: "codex-app-server:account-rate-limits" },
          allocation: {
            eligible: true, effectiveWeight: 0.8, approximateShare: 0.8,
            evidence: { kind: "numeric-headroom", source: "legacy-observation",
              limitId: "codex:primary", usedPercent: 20 },
          },
        }],
      },
    ],
    diagnosticRouteProbe: { stableKey: "fixture-key", available: true },
  });
  expect(JSON.parse(JSON.stringify(first))).toEqual(first);
});

test("human provider rendering labels estimates as non-quotas and the chooser as a diagnostic probe", () => {
  const rendered = renderProvidersStatus(document());
  expect(rendered).toContain("allocation mode  balanced");
  expect(rendered).toContain("balanced estimate (route unspecified): weight 0.2 · approximately 20.0% of eligible auto routes (not a quota)");
  expect(rendered).toContain("balanced estimate (route unspecified): weight 0.8 · approximately 80.0% of eligible auto routes (not a quota)");
  expect(rendered).toContain(`allocation evidence: legacy-observation · observed ${observedAt} · claude:seven_day · provider-measured 80% used`);
  expect(rendered).toContain("diagnostic route probe (not a preference; stable key: fixture-key)");
  expect(rendered).toContain("one deterministic probe only; per-account estimates above are conservative without a tier/model and may vary by route");
  expect(rendered).not.toContain("sample auto route");
});

test("categorical allocation reports the actual driving source and exhausted routing", () => {
  const categorical: ResourcePolicy = {
    ...policy,
    targetPressures: { "claude-personal": "low", "codex-personal": "exhausted" },
    automatedPressureObservations: undefined,
    automatedPressureObservationSets: {
      "claude-personal": [{
        targetId: "claude-personal", provider: "anthropic",
        source: "claude-agent-sdk:rate-limit-event", observedAt, state: "low",
      }],
      "codex-personal": [{
        targetId: "codex-personal", provider: "openai",
        source: "codex-app-server:account-rate-limits", observedAt, state: "exhausted",
      }],
    },
  };
  const result = buildProvidersStatusDocument({
    source: "fixture", accountUsage: [], policy: categorical, availability,
  });
  expect(result.providers[0]!.targets[0]).toMatchObject({
    headroom: "low", routing: "eligible",
    allocation: { evidence: { kind: "categorical-pressure",
      source: "claude-agent-sdk:rate-limit-event", observedAt } },
  });
  expect(result.providers[1]!.targets[0]).toMatchObject({
    headroom: "exhausted", routing: "exhausted",
    allocation: { eligible: false, effectiveWeight: 0 },
  });
});

test("status JSON and prose distinguish a routing floor from provider-measured utilization", () => {
  const calibrated: ResourcePolicy = {
    ...policy,
    automatedPressureObservations: undefined,
    automatedPressureObservationSets: {
      "claude-personal": [
        {
          targetId: "claude-personal", provider: "anthropic",
          source: "claude-agent-sdk:usage-control-experimental", observedAt,
          windows: [{
            limitId: "claude:seven_day", usedPercent: 55,
            resetsAt: "2099-01-01T01:59:59.671Z",
          }],
        },
        {
          targetId: "claude-personal", provider: "anthropic",
          source: "claude-agent-sdk:rate-limit-event", observedAt,
          categoricalSignals: [{
            kind: "warning", limitId: "seven_day", resetsAt: "2099-01-01T02:00:00.000Z",
          }],
        },
      ],
    },
  };
  const result = buildProvidersStatusDocument({
    source: "fixture", accountUsage: [], policy: calibrated, availability,
  });
  const evidence = result.providers[0]!.targets[0]!.allocation!.evidence;
  expect(evidence).toMatchObject({
    kind: "conservative-floor",
    routingFloorPercent: 80,
    measuredUsedPercent: 55,
    measurementSource: "claude-agent-sdk:usage-control-experimental",
  });
  expect(evidence.usedPercent).toBeUndefined();
  const rendered = renderProvidersStatus(result);
  expect(rendered).toContain("routing-only categorical floor 80%");
  expect(rendered).toContain("separate provider measurement 55% via claude-agent-sdk:usage-control-experimental");
  expect(rendered).not.toContain("provider-measured 80%");
});
