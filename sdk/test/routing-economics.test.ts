import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { applyGafferStaffing } from "../src/gaffer-staffing";
import {
  admitRoutingEconomics, MAX_PIN_LIFETIME_MS,
  type RoutingAssessment,
} from "../src/routing-economics";

const signals = {
  decisionOwnership: "none",
  seamScope: "none",
  errorExposure: "contained-reversible",
  oracleStrength: "objective-local",
  foundationalImpact: "none",
  dependencyShape: "atomic-cohesive",
  reasoningShape: "deterministic",
} as const;

const assessment: RoutingAssessment = {
  version: "minimum-sufficient-v1",
  signals,
  derived: {
    minimumTier: "economy", minimumReasoning: "low",
    ruleCodes: ["reasoning-shape:deterministic"],
  },
  selected: { tier: "economy", reasoning: "low" },
};

test("North's strict Ajv 2020 consumer compiles Gaffer's assessment schema before admission", () => {
  const gafferRoot = resolve(process.env.GAFFER_HOME ?? resolve(homedir(), "code/gaffer"));
  const schema = JSON.parse(readFileSync(
    resolve(gafferRoot, "contracts/selection-assessment.schema.json"), "utf8",
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  expect(validate(assessment), JSON.stringify(validate.errors)).toBe(true);

  const request = applyGafferStaffing({ role: "executor" });
  expect(admitRoutingEconomics({ request, routingAssessment: assessment }).assessment).toEqual(assessment);
});

test("North freezes the canonical Gaffer assessment and immutable catalog receipt", () => {
  const request = applyGafferStaffing({ role: "executor" });
  const admitted = admitRoutingEconomics({ request, routingAssessment: assessment });
  expect(admitted.assessment).toEqual(assessment);
  expect(Object.isFrozen(admitted)).toBe(true);
  expect(Object.isFrozen(admitted.assessment?.signals)).toBe(true);
  expect(admitted.receipt.stockAxes).toEqual({
    taskGrade: "novice", topology: "worker", tier: "economy",
    reasoning: "low", posture: "deliver",
  });
  for (const field of [
    "routingRequestSha256", "routingAssessmentSha256", "staffingCatalogSha256",
    "providerCatalogsSha256", "routingPolicySha256",
  ] as const) expect(admitted.receipt[field]).toMatch(/^(?:[0-9a-f]{64}|unavailable)$/);
  // File mode (the hermetic default) keeps the catalog-FILE digests and carries
  // NEITHER the §3.2 policy pin nor the §3.1(6) catalog graph pin.
  expect(admitted.receipt.orchestrationPolicyPinSha256).toBeUndefined();
  expect(admitted.receipt.orchestrationCatalogDigestSha256).toBeUndefined();
  expect(admitted.receipt.orchestrationCatalogVersion).toBeUndefined();
  expect(admitted.receipt.orchestrationCatalogTxVersion).toBeUndefined();
  expect(admitted.receipt.overrideEvidence).toEqual({ changedAxes: [], status: "none" });
});

test("North rejects a forged derived assessment through Gaffer's canonical validator", () => {
  const request = applyGafferStaffing({ role: "executor" });
  expect(() => admitRoutingEconomics({
    request,
    routingAssessment: {
      ...assessment,
      derived: { minimumTier: "standard", minimumReasoning: "medium", ruleCodes: ["forged"] },
      selected: { tier: "economy", reasoning: "low" },
      exception: { code: "calibration-experiment", detail: "forgery probe" },
    },
  })).toThrow(/canonical Gaffer validation|below derived minimum/);
});

test("pin evidence is exact, bounded, immutable, and visible when missing", () => {
  const request = applyGafferStaffing({ role: "executor" });
  const now = new Date("2026-07-22T12:00:00Z");
  const admitted = admitRoutingEconomics({
    request, provider: "openai", target: "codex-personal", model: "gpt-5.6-luna", now,
    pinEvidence: {
      policyVersion: "north-routing-pin-v1",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + MAX_PIN_LIFETIME_MS).toISOString(),
      reasonCode: "explicit-human-request",
      detail: "bounded exact route",
      pins: [
        { kind: "provider", value: "openai" },
        { kind: "account", value: "codex-personal" },
        { kind: "model", value: "gpt-5.6-luna" },
      ],
    },
  });
  expect(admitted.receipt.pinEvidenceStatus).toBe("current");
  expect(Object.isFrozen(admitted.pinEvidence?.pins)).toBe(true);

  expect(() => admitRoutingEconomics({ request, target: "codex-personal", now }))
    .toThrow("require current typed pinEvidence");
  const missing = admitRoutingEconomics({
    request, target: "codex-personal", now, allowLegacyMissingPinEvidence: true,
  });
  expect(missing.receipt.pinEvidenceStatus).toBe("legacy-missing");
  expect(() => admitRoutingEconomics({
    request, target: "codex-personal", now,
    pinEvidence: {
      policyVersion: "north-routing-pin-v1",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + MAX_PIN_LIFETIME_MS + 1).toISOString(),
      reasonCode: "explicit-human-request", detail: "too long",
      pins: [{ kind: "account", value: "codex-personal" }],
    },
  })).toThrow("no more than 24 hours");
});

test("new max reasoning fails closed without canonical exceptional assessment", () => {
  const request = applyGafferStaffing({
    role: "executor", tier: "frontier", reasoning: "max",
    composition: {
      kind: "preset", id: "executor", overrides: ["tier", "reasoning"],
      overrideReason: "exceptional deliberation required",
    },
  });
  expect(() => admitRoutingEconomics({ request }))
    .toThrow("reasoning=max requires a canonical routingAssessment");
});
