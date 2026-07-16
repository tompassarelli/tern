import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { validateRoutingMetadata } from "../src/routing-metadata";
import { runFacts } from "../src/telemetry";
import { applyGafferStaffing, loadGafferStaffing } from "../src/gaffer-staffing";

const north = resolve(import.meta.dir, "../..");
const gaffer = process.env.GAFFER_HOME ?? resolve(north, "../gaffer");
const compose = resolve(gaffer, "scripts/compose-routing.mjs");

function composed(...args: string[]): any {
  const result = spawnSync(process.execPath, [compose, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

test("Gaffer composition survives North validation into complete run telemetry", () => {
  const request = composed("integrator", "--taskGrade", "staff", "--domain", "Nix,Beagle",
    "--topology", "orchestrator", "--tier", "frontier", "--deliberation", "xhigh", "--posture", "preserve");
  const metadata = validateRoutingMetadata(request);
  expect(metadata).toEqual({
    role: "integrator", taskGrade: "staff", domainRequirements: ["Nix", "Beagle"],
    topology: "orchestrator", tier: "frontier", reasoning: "xhigh", posture: "preserve",
    composition: { kind: "preset", id: "integrator" },
  });

  const facts = runFacts({
    thread: "(ad-hoc)", agent: "lane-contract", tokens: 1, durationMs: 2,
    posture: "spawn", outcome: "ran", role: request.role,
    requestedProvider: request.provider, requestedTier: request.tier, requestedEffort: request.reasoning,
    routingMetadata: metadata,
  }, "2026-07-16T00:00:00.000Z");
  for (const fact of [
    ["requested_role", "integrator"], ["task_grade", "staff"],
    ["domain_requirement", "Nix"], ["domain_requirement", "Beagle"],
    ["topology", "orchestrator"], ["routing_tier", "frontier"],
    ["requested_reasoning", "xhigh"], ["routing_posture", "preserve"],
    ["composition_kind", "preset"], ["composition_id", "integrator"],
  ]) expect(facts).toContainEqual(fact);
});

test("SDK role-only spawns inherit catalog axes while explicit axes win independently", () => {
  const catalog = loadGafferStaffing(resolve(gaffer, "staffing/catalog.json"));
  expect(applyGafferStaffing({ role: "integrator", tier: "frontier", topology: "orchestrator" }, catalog)).toEqual({
    role: "integrator", taskGrade: "senior", domainRequirements: [], topology: "orchestrator",
    tier: "frontier", reasoning: "high", posture: "deliver",
    composition: { kind: "preset", id: "integrator" },
  });
  expect(applyGafferStaffing({ role: "researcher" }, catalog)).toMatchObject({
    role: "scout", taskGrade: "junior", tier: "economy", reasoning: "low",
  });
});

test("North CLI reads staffing/catalog.json and carries independent overrides", () => {
  const result = spawnSync("bb", [resolve(north, "cli/agents-cli.clj"), "spawn", "scout", "contract probe",
    "--dry-run", "--taskGrade", "principal", "--domain", "computer-science", "--topology", "verifier",
    "--tier", "frontier", "--reasoning", "xhigh", "--posture", "preserve"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", GAFFER_STAFFING_CATALOG: resolve(gaffer, "staffing/catalog.json") },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("grade=principal tier=frontier reasoning=xhigh");
  expect(result.stdout).toContain("AGENT_DOMAIN_REQUIREMENTS=[\"computer-science\"]");
  expect(result.stdout).toContain("AGENT_TOPOLOGY=verifier");
  expect(result.stdout).toContain("AGENT_COMPOSITION={\"kind\":\"preset\",\"id\":\"scout\"}");
});

test("bespoke Gaffer composition rationale reaches North telemetry", () => {
  const request = composed("migration-forensics", "--nearest", "analyst", "--rationale",
    "provenance tracing plus schema recovery");
  const metadata = validateRoutingMetadata(request);
  expect(metadata.composition).toMatchObject({
    kind: "bespoke", id: "migration-forensics", nearestPreset: "analyst",
    bespokeReason: "provenance tracing plus schema recovery", promotionCandidate: false,
  });
  const facts = runFacts({ thread: "(ad-hoc)", agent: "lane-bespoke", tokens: 0, durationMs: 0,
    posture: "spawn", outcome: "ran", routingMetadata: metadata });
  expect(facts).toContainEqual(["bespoke_reason", "provenance tracing plus schema recovery"]);
  expect(facts).toContainEqual(["promotion_candidate", "false"]);
});

test("North MCP advertises the complete composition contract", () => {
  const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`;
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], { input: request, encoding: "utf8" });
  expect(result.status).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  const spawn = response.result.tools.find((tool: any) => tool.name === "spawn");
  for (const field of ["role", "taskGrade", "domainRequirements", "topology", "tier", "reasoning", "posture", "composition"])
    expect(spawn.inputSchema.properties[field]).toBeDefined();
  expect(spawn.inputSchema.properties.reasoning.enum).toContain("xhigh");
});
