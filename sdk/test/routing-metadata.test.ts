import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyGafferStaffing } from "../src/gaffer-staffing";
import { canonicalRole, routingMetadataFromEnv, validateRoutingMetadata } from "../src/routing-metadata";
import { newRunId, runFacts } from "../src/telemetry";

const ENV_KEYS = [
  "AGENT_ROLE", "AGENT_TASK_GRADE", "AGENT_DOMAIN_REQUIREMENTS", "AGENT_TOPOLOGY",
  "AGENT_TIER", "AGENT_REASONING", "AGENT_POSTURE", "AGENT_COMPOSITION",
];
afterEach(() => { for (const key of ENV_KEYS) delete process.env[key]; });

const bespokeContract = {
  responsibility: "reconstruct migration provenance",
  deliverable: "an evidence-linked timeline",
  capabilities: ["filesystem.read", "filesystem.search", "shell.readonly", "coordination"] as const,
  mayDecide: ["which read-only traces to follow"],
  mustEscalate: ["destructive recovery"],
  doneWhen: ["every transition is sourced"],
  report: "timeline, contradictions, and gaps",
};

describe("Gaffer routing metadata boundary", () => {
  test("accepts and normalizes the complete composition payload", () => {
    process.env.AGENT_TASK_GRADE = "staff";
    process.env.AGENT_ROLE = "migration-forensics";
    process.env.AGENT_DOMAIN_REQUIREMENTS = JSON.stringify(["distributed-systems", "Nix"]);
    process.env.AGENT_TOPOLOGY = "orchestrator";
    process.env.AGENT_TIER = "frontier";
    process.env.AGENT_REASONING = "xhigh";
    process.env.AGENT_POSTURE = "explore";
    process.env.AGENT_COMPOSITION = JSON.stringify({
      kind: "bespoke", id: "migration-forensics", nearestPreset: "analyst",
      bespokeReason: "crosses provenance and schema recovery", promotionCandidate: true,
      contract: bespokeContract,
    });
    expect(routingMetadataFromEnv()).toEqual({
      role: "migration-forensics", taskGrade: "staff", domainRequirements: ["distributed-systems", "Nix"],
      topology: "orchestrator", tier: "frontier", reasoning: "xhigh", posture: "explore",
      composition: { kind: "bespoke", id: "migration-forensics", nearestPreset: "analyst",
        bespokeReason: "crosses provenance and schema recovery", promotionCandidate: true,
        contract: bespokeContract },
    });
  });

  test("rejects invalid grades, domains, topology, and unexplained bespoke roles", () => {
    expect(() => validateRoutingMetadata({ taskGrade: "guru" as any })).toThrow("taskGrade");
    expect(() => validateRoutingMetadata({ topology: "manager" as any })).toThrow("topology");
    expect(() => validateRoutingMetadata({ domainRequirements: [""] })).toThrow("domainRequirements");
    expect(() => validateRoutingMetadata({ domainRequirements: ["Nix", "Nix"] }))
      .toThrow("domainRequirements must not contain duplicates");
    expect(() => validateRoutingMetadata({ domainRequirements: ["Nix", " Nix "] }))
      .toThrow("domainRequirements must not contain duplicates");
    expect(() => validateRoutingMetadata({ topology: "verifier" as any })).toThrow("topology");
    expect(() => validateRoutingMetadata({ role: "x", composition: { kind: "bespoke", id: "x" } as any })).toThrow("bespokeReason");
    expect(() => validateRoutingMetadata({
      role: "x", composition: { kind: "bespoke", id: "x", nearestPreset: "analyst",
        bespokeReason: "one-off", promotionCandidate: false, contract: bespokeContract },
    })).toThrow("bespoke composition requires all routing axes");
  });

  test("researcher fails as ambiguous while explicit research functions remain canonical", () => {
    expect(() => canonicalRole("researcher")).toThrow("role researcher is retired because it was ambiguous");
    expect(canonicalRole("scout")).toBe("scout");
    expect(canonicalRole("analyst")).toBe("analyst");
    expect(canonicalRole("research-scientist")).toBe("research-scientist");
    expect(canonicalRole("migration-forensics")).toBe("migration-forensics");
  });

  test("rejects unknown request fields and composition identity drift", () => {
    for (const field of ["provider", "invokedAs", "shape", "allocation"]) {
      expect(() => validateRoutingMetadata({ role: "integrator", [field]: "unexpected" } as any))
        .toThrow("routing metadata has unknown field");
    }
    expect(() => validateRoutingMetadata({
      role: "integrator", composition: { kind: "preset", id: "scout", overrides: [] },
    })).toThrow("composition.id must match canonical role integrator");
    expect(() => validateRoutingMetadata({
      role: "integrator", composition: { kind: "preset", id: "integrator", overrides: [], extra: true } as any,
    })).toThrow("composition has unknown field");
  });

  test("bespoke capability contracts reject widening, ambiguity, and missing authority", () => {
    const request = {
      role: "read-only-specialist", taskGrade: "senior", domainRequirements: [],
      topology: "worker", tier: "senior", reasoning: "high", posture: "preserve",
      composition: {
        kind: "bespoke", id: "read-only-specialist", bespokeReason: "no preset fits",
        promotionCandidate: false, contract: { ...bespokeContract },
      },
    } as const;
    expect(() => validateRoutingMetadata({
      ...request,
      composition: { ...request.composition, contract: { ...request.composition.contract, capabilities: [] } },
    } as any)).toThrow("capabilities must be a non-empty array");
    expect(() => validateRoutingMetadata({
      ...request,
      composition: { ...request.composition, contract: {
        ...request.composition.contract, capabilities: ["filesystem.read", "filesystem.read"],
      } },
    } as any)).toThrow("capabilities must not contain duplicates");
    expect(() => validateRoutingMetadata({
      ...request,
      composition: { ...request.composition, contract: {
        ...request.composition.contract, capabilities: ["filesystem.read", "root"],
      } },
    } as any)).toThrow("capabilities contain unknown values");
    expect(() => validateRoutingMetadata({
      ...request,
      composition: { ...request.composition, contract: {
        ...request.composition.contract, capabilities: ["filesystem.read", "shell", "shell.readonly"],
      } },
    } as any)).toThrow("shell and shell.readonly are mutually exclusive");
  });
});

test("run telemetry records requested routing, composition, and outcome together", () => {
  const facts = runFacts({
    thread: "(ad-hoc)", agent: "lane-1", tokens: 12, durationMs: 34, posture: "spawn", outcome: "ran",
    provider: "openai", model: "effective-model", effort: "high",
    requestedProvider: "auto", requestedTier: "frontier", requestedEffort: "max",
    allocationMode: "reserved", entitlementPressure: "low", fallbackCount: 1,
    fallbackPath: ["anthropic", "openai"],
    envelopeScopes: ["month:2026-07", "project:north"], envelopeRetries: 1,
    envelopeAdvisories: ["session/default envelope not enforceable: no stable session id"],
    routingMetadata: { taskGrade: "research-grade", domainRequirements: ["computer-science"], topology: "worker",
      composition: { kind: "preset", id: "research-scientist", overrides: [] } },
  }, "2026-07-16T00:00:00.000Z");
  expect(facts).toContainEqual(["outcome", "ran"]);
  expect(facts).toContainEqual(["requested_provider", "auto"]);
  expect(facts).toContainEqual(["requested_tier", "frontier"]);
  expect(facts).toContainEqual(["allocation_mode", "reserved"]);
  expect(facts).toContainEqual(["entitlement_pressure", "low"]);
  expect(facts).toContainEqual(["fallback_count", "1"]);
  expect(facts).toContainEqual(["fallback_path", "anthropic -> openai"]);
  expect(facts).toContainEqual(["envelope_scope", "month:2026-07"]);
  expect(facts).toContainEqual(["envelope_scope", "project:north"]);
  expect(facts).toContainEqual(["envelope_retries", "1"]);
  expect(facts).toContainEqual(["envelope_advisory", "session/default envelope not enforceable: no stable session id"]);
  expect(facts).toContainEqual(["task_grade", "research-grade"]);
  expect(facts).toContainEqual(["domain_requirement", "computer-science"]);
  expect(facts).toContainEqual(["topology", "worker"]);
  expect(facts).toContainEqual(["composition_id", "research-scientist"]);
});

test("North validates Gaffer's shared cross-harness routing fixtures", () => {
  const packagedPath = resolve(import.meta.dir, "fixtures/gaffer-routing-request.fixtures.json");
  const fixtures = JSON.parse(readFileSync(packagedPath, "utf8"));
  for (const fixture of fixtures.valid)
    expect(() => applyGafferStaffing(validateRoutingMetadata(fixture.request))).not.toThrow();
  for (const fixture of fixtures.invalid)
    expect(() => applyGafferStaffing(validateRoutingMetadata(fixture.request))).toThrow(fixture.errorContains);

  // Gaffer is canonical when present in a development workspace, but North's
  // packaged acceptance test never requires a sibling checkout.
  const gafferHome = process.env.GAFFER_HOME ?? resolve(import.meta.dir, "../../../gaffer");
  const canonicalPath = resolve(gafferHome, "contracts/routing-request.fixtures.json");
  if (existsSync(canonicalPath))
    expect(JSON.parse(readFileSync(canonicalPath, "utf8"))).toEqual(fixtures);
});

test("run ids remain distinct when the wall clock does not advance", () => {
  expect(newRunId("same-agent")).not.toBe(newRunId("same-agent"));
});
