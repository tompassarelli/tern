import { afterEach, describe, expect, test } from "bun:test";
import { canonicalRole, routingMetadataFromEnv, validateRoutingMetadata } from "../src/routing-metadata";
import { runFacts } from "../src/telemetry";

const ENV_KEYS = ["AGENT_TASK_GRADE", "AGENT_DOMAIN_REQUIREMENTS", "AGENT_TOPOLOGY", "AGENT_COMPOSITION"];
afterEach(() => { for (const key of ENV_KEYS) delete process.env[key]; });

describe("Gaffer routing metadata boundary", () => {
  test("accepts and normalizes the complete composition payload", () => {
    process.env.AGENT_TASK_GRADE = "staff";
    process.env.AGENT_DOMAIN_REQUIREMENTS = JSON.stringify(["distributed-systems", "Nix"]);
    process.env.AGENT_TOPOLOGY = "orchestrator";
    process.env.AGENT_COMPOSITION = JSON.stringify({
      kind: "bespoke", id: "migration-forensics", nearestPreset: "investigator",
      bespokeReason: "crosses provenance and schema recovery", promotionCandidate: true,
    });
    expect(routingMetadataFromEnv()).toEqual({
      taskGrade: "staff", domainRequirements: ["distributed-systems", "Nix"], topology: "orchestrator",
      composition: { kind: "bespoke", id: "migration-forensics", nearestPreset: "investigator",
        bespokeReason: "crosses provenance and schema recovery", promotionCandidate: true },
    });
  });

  test("rejects invalid grades, domains, topology, and unexplained bespoke roles", () => {
    expect(() => validateRoutingMetadata({ taskGrade: "guru" as any })).toThrow("taskGrade");
    expect(() => validateRoutingMetadata({ topology: "manager" as any })).toThrow("topology");
    expect(() => validateRoutingMetadata({ domainRequirements: [""] })).toThrow("domainRequirements");
    expect(() => validateRoutingMetadata({ composition: { kind: "bespoke", id: "x" } })).toThrow("bespokeReason");
  });

  test("researcher remains a compatibility alias, not a canonical role", () => {
    expect(canonicalRole("researcher")).toBe("scout");
    expect(canonicalRole("research-scientist")).toBe("research-scientist");
    expect(canonicalRole("migration-forensics")).toBe("migration-forensics");
  });
});

test("run telemetry records requested routing, composition, and outcome together", () => {
  const facts = runFacts({
    thread: "(ad-hoc)", agent: "lane-1", tokens: 12, durationMs: 34, posture: "spawn", outcome: "ran",
    provider: "openai", model: "effective-model", effort: "high",
    requestedProvider: "auto", requestedTier: "frontier", requestedEffort: "max",
    routingMetadata: { taskGrade: "research-grade", domainRequirements: ["computer-science"], topology: "worker",
      composition: { kind: "preset", id: "research-scientist", promotionCandidate: false } },
  }, "2026-07-16T00:00:00.000Z");
  expect(facts).toContainEqual(["outcome", "ran"]);
  expect(facts).toContainEqual(["requested_provider", "auto"]);
  expect(facts).toContainEqual(["requested_tier", "frontier"]);
  expect(facts).toContainEqual(["task_grade", "research-grade"]);
  expect(facts).toContainEqual(["domain_requirement", "computer-science"]);
  expect(facts).toContainEqual(["topology", "worker"]);
  expect(facts).toContainEqual(["composition_id", "research-scientist"]);
  expect(facts).toContainEqual(["promotion_candidate", "false"]);
});
