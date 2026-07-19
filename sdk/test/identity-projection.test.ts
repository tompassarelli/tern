import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  agentRouteFacts, gafferProvenance, goalFromPrompt, providerTargetLabel, renderDisplayName, semanticHandle,
} from "../src/identity";
import type { ObservedAgentIdentity } from "../src/identity";

interface RosterFixture {
  name: string;
  id: string;
  facts: Record<string, string>;
  expected: {
    providerLabel: string;
    modelDisplay: string;
    effortDisplay: string;
    gafferProvenance: string;
    semanticHandle: string;
    displayName: string;
    primaryLine: string;
  };
}

const rosterFixtures = JSON.parse(readFileSync(
  new URL("./fixtures/agent-roster-contract.json", import.meta.url),
  "utf8",
)) as RosterFixture[];

function observedIdentity(facts: Record<string, string>): ObservedAgentIdentity {
  const promotion = facts.promotion_candidate === undefined
    ? undefined : facts.promotion_candidate === "true";
  return {
    kind: (facts.kind ?? "lane") as ObservedAgentIdentity["kind"],
    role: facts.role,
    model: facts.model,
    provider: facts.provider,
    providerTarget: facts.provider_target,
    effort: facts.effort,
    compositionKind: facts.composition_kind as ObservedAgentIdentity["compositionKind"],
    compositionId: facts.composition_id,
    compositionOverrides: facts.composition_overrides === undefined
      ? undefined : JSON.parse(facts.composition_overrides),
    compositionOverrideReason: facts.composition_override_reason,
    compositionNearestPreset: facts.nearest_preset,
    compositionBespokeReason: facts.bespoke_reason,
    compositionPromotionCandidate: promotion,
    compositionContractFingerprint: facts.composition_contract_sha256,
    compositionContractFingerprintVersion: facts.composition_contract_fingerprint_version,
    compositionContractFingerprintDomain: facts.composition_contract_fingerprint_domain,
    repo: facts.repo,
    goal: facts.goal,
  };
}

test("shared roster fixtures preserve semantic identity across provider adapters", () => {
  for (const fixture of rosterFixtures) {
    const identity = observedIdentity(fixture.facts);
    expect(providerTargetLabel(identity), fixture.name).toBe(fixture.expected.providerLabel);
    expect(gafferProvenance(identity), fixture.name).toBe(fixture.expected.gafferProvenance);
    expect(semanticHandle(fixture.id, identity), fixture.name).toBe(fixture.expected.semanticHandle);
    expect(renderDisplayName(fixture.id, identity), fixture.name).toBe(fixture.expected.displayName);
    expect(fixture.facts.display_name, fixture.name).not.toBe(fixture.expected.primaryLine);
  }
});

test("semantic handles keep provider-specific model families and stable control suffixes", () => {
  expect(semanticHandle("sdk-a205e9ce", {
    kind: "lane", provider: "openai", model: "gpt-5.6-sol", effort: "xhigh",
    role: "designer", compositionKind: "preset", compositionId: "designer", compositionOverrides: [],
  })).toBe("openai-sol-xhigh-gaffer-designer-a205e9ce");
});

test("managed identity exposes the exact account target and Gaffer template", () => {
  const identity = {
    kind: "lane" as const, provider: "openai", providerTarget: "codex-work",
    model: "gpt-5.6-sol", effort: "xhigh", compositionKind: "preset" as const,
    role: "designer", compositionId: "designer", compositionOverrides: [],
    goal: "Build the account-aware roster",
  };
  expect(providerTargetLabel(identity)).toBe("openai:codex-work");
  expect(renderDisplayName("lane-a205e9ce", identity))
    .toBe("openai:codex-work · sol · xhigh · gaffer:designer · Build the account-aware roster");
  expect(semanticHandle("lane-a205e9ce", identity)).toBe("openai-codex-work-sol-xhigh-gaffer-designer-a205e9ce");
  expect(providerTargetLabel({ kind: "lane", provider: "anthropic", providerTarget: "anthropic" }))
    .toBe("anthropic:ambient");
  expect(providerTargetLabel({ kind: "session", provider: "anthropic" })).toBe("anthropic");
});

test("fallback route facts replace provider target and refresh public identity", () => {
  const base = {
    kind: "lane" as const, model: "opus", effort: "high", compositionKind: "preset" as const,
    role: "integrator", compositionId: "integrator", compositionOverrides: [], goal: "Integrate the change",
  };
  const initial = Object.fromEntries(agentRouteFacts("lane-route", {
    ...base, provider: "anthropic", providerTarget: "claude-personal",
  }));
  const fallback = Object.fromEntries(agentRouteFacts("lane-route", {
    ...base, provider: "openai", providerTarget: "codex-work", model: "gpt-5.6-sol", effort: "xhigh",
  }));
  expect(initial.provider_target).toBe("claude-personal");
  expect(fallback).toMatchObject({ provider: "openai", provider_target: "codex-work" });
  expect(fallback.display_name).toContain("openai:codex-work · sol · xhigh · gaffer:integrator");
});

test("Gaffer provenance distinguishes exact, overridden, bespoke, native, and legacy debt", () => {
  expect(gafferProvenance({
    kind: "lane", role: "designer", compositionKind: "preset",
    compositionId: "designer", compositionOverrides: [],
  }))
    .toBe("gaffer:designer");
  expect(gafferProvenance({
    kind: "lane", role: "integrator", compositionKind: "preset", compositionId: "integrator",
    compositionOverrides: ["tier", "reasoning"], compositionOverrideReason: "high leverage seam",
  })).toBe("gaffer:integrator+override(tier,reasoning)");
  expect(gafferProvenance({
    kind: "lane", role: "migration-forensics", compositionKind: "bespoke",
    compositionId: "migration-forensics", compositionBespokeReason: "one-off provenance analysis",
    compositionPromotionCandidate: false, compositionContractFingerprint: "a".repeat(64),
    compositionContractFingerprintVersion: "v1",
    compositionContractFingerprintDomain: "north:bespoke-contract:v1",
  }))
    .toBe("gaffer:bespoke:migration-forensics");
  expect(gafferProvenance({ kind: "session" }))
    .toBe("gaffer:not-selected");
  expect(gafferProvenance({ kind: "lane" })).toBe("gaffer:legacy-debt");
  expect(gafferProvenance({
    kind: "lane", compositionKind: "preset", compositionId: "integrator",
    compositionOverrides: ["tier"],
  })).toBe("gaffer:legacy-debt");
});

test("managed missing composition and historical none are decode-only legacy debt", () => {
  expect(semanticHandle("lane-legacy", {
    kind: "lane", provider: "openai", providerTarget: "codex-work",
    model: "gpt-5.6-sol", effort: "high",
  })).toBe("openai-codex-work-sol-high-gaffer-legacy-debt-legacy");
  // Migration compatibility only: current native writers omit composition_kind.
  expect(semanticHandle("session-native", {
    kind: "session", provider: "openai", model: "gpt-5.6-sol", effort: "unobserved",
    compositionKind: "none",
  })).toBe("openai-sol-unobserved-gaffer-not-selected-native");
});

test("delegated prompt scaffolding yields the actual delegated task", () => {
  const prompt = `CONTEXT BRIEF:\n- prior context\n\nDELEGATE TASK: Implement the canonical agent roster.\n\nOPERATING CONTRACT: verify it`;
  expect(goalFromPrompt(prompt)).toBe("Implement the canonical agent roster.");
});
