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

const contract = JSON.stringify({
  responsibility: "reconstruct migration provenance", deliverable: "evidence-linked timeline",
  capabilities: ["filesystem.read", "filesystem.search", "shell.readonly"],
  mayDecide: ["read-only traces"], mustEscalate: ["destructive recovery"],
  doneWhen: ["every transition is sourced"], report: "timeline, contradictions, and gaps",
});

test("Gaffer composition survives North validation into complete run telemetry", () => {
  const request = composed("integrator", "--taskGrade", "staff", "--domain", "Nix,Beagle",
    "--tier", "frontier", "--deliberation", "xhigh", "--posture", "preserve",
    "--override-reason", "cross-provider foundational contract");
  const metadata = validateRoutingMetadata(request);
  expect(metadata).toEqual({
    role: "integrator", taskGrade: "staff", domainRequirements: ["Nix", "Beagle"],
    topology: "worker", tier: "frontier", reasoning: "xhigh", posture: "preserve",
    composition: { kind: "preset", id: "integrator",
      overrides: ["taskGrade", "domainRequirements", "tier", "reasoning", "posture"],
      overrideReason: "cross-provider foundational contract" },
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
    ["topology", "worker"], ["routing_tier", "frontier"],
    ["requested_reasoning", "xhigh"], ["routing_posture", "preserve"],
    ["composition_kind", "preset"], ["composition_id", "integrator"],
  ]) expect(facts).toContainEqual(fact);
});

test("SDK presets inherit catalog axes while declared compatible overrides win independently", () => {
  const catalog = loadGafferStaffing(resolve(gaffer, "staffing/catalog.json"));
  expect(() => applyGafferStaffing({ role: "integrator", tier: "frontier" }, catalog))
    .toThrow("supply preset composition.overrides");
  expect(applyGafferStaffing({ role: "integrator", tier: "frontier", reasoning: "xhigh",
    composition: { kind: "preset", id: "integrator", overrides: ["tier", "reasoning"],
      overrideReason: "cross-seam direction" } }, catalog)).toEqual({
    role: "integrator", taskGrade: "senior", domainRequirements: [], topology: "worker",
    tier: "frontier", reasoning: "xhigh", posture: "deliver",
    composition: { kind: "preset", id: "integrator", overrides: ["tier", "reasoning"],
      overrideReason: "cross-seam direction" },
  });
  expect(applyGafferStaffing({ role: "director" }, catalog)).toEqual({
    role: "director", taskGrade: "staff", domainRequirements: [], topology: "orchestrator",
    tier: "frontier", reasoning: "xhigh", posture: "deliver",
    composition: { kind: "preset", id: "director", overrides: [] },
  });
  expect(() => applyGafferStaffing({ role: "researcher" }, catalog))
    .toThrow("role researcher is retired because it was ambiguous");
});

test("North CLI reads staffing/catalog.json and carries independent overrides", () => {
  const result = spawnSync("bb", [resolve(north, "cli/agents-cli.clj"), "spawn", "scout", "contract probe",
    "--dry-run", "--taskGrade", "principal", "--domain", "computer-science",
    "--tier", "frontier", "--reasoning", "xhigh", "--posture", "preserve",
    "--override-reason", "principal research direction"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", GAFFER_STAFFING_CATALOG: resolve(gaffer, "staffing/catalog.json") },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("grade=principal tier=frontier reasoning=xhigh");
  expect(result.stdout).toContain("AGENT_DOMAIN_REQUIREMENTS=[\"computer-science\"]");
  expect(result.stdout).toContain("AGENT_TOPOLOGY=worker");
  expect(result.stdout).toContain("AGENT_COMPOSITION={\"kind\":\"preset\",\"id\":\"scout\",\"overrides\":[\"taskGrade\",\"domainRequirements\",\"tier\",\"reasoning\",\"posture\"],\"overrideReason\":\"principal research direction\"}");
});

test("North rejects unlogged bespoke roles and composition identity mismatches", () => {
  const catalog = loadGafferStaffing(resolve(gaffer, "staffing/catalog.json"));
  expect(() => applyGafferStaffing({ role: "special" }, catalog))
    .toThrow("unknown Gaffer role special requires composition.kind=bespoke");
  expect(() => validateRoutingMetadata({
    role: "integrator", composition: { kind: "preset", id: "scout", overrides: [] },
  })).toThrow("composition.id must match canonical role integrator");
  expect(() => applyGafferStaffing({
    role: "special", taskGrade: "staff", domainRequirements: [], topology: "worker",
    tier: "frontier", reasoning: "xhigh", posture: "explore",
    composition: { kind: "bespoke", id: "special", nearestPreset: "analyst",
      bespokeReason: "novel one-off", promotionCandidate: false, contract: JSON.parse(contract) },
  }, catalog)).not.toThrow();
});

test("bespoke Gaffer composition rationale reaches North telemetry", () => {
  const request = composed("migration-forensics", "--rationale",
    "provenance tracing plus schema recovery", "--contract", contract, "--no-promotion-candidate",
    "--task-grade", "senior", "--topology", "worker", "--tier", "senior",
    "--reasoning", "high", "--posture", "explore");
  const metadata = validateRoutingMetadata(request);
  expect(metadata.composition).toMatchObject({
    kind: "bespoke", id: "migration-forensics",
    bespokeReason: "provenance tracing plus schema recovery", promotionCandidate: false,
  });
  const facts = runFacts({ thread: "(ad-hoc)", agent: "lane-bespoke", tokens: 0, durationMs: 0,
    posture: "spawn", outcome: "ran", routingMetadata: metadata });
  expect(facts).toContainEqual(["bespoke_reason", "provenance tracing plus schema recovery"]);
  expect(facts).toContainEqual(["promotion_candidate", "false"]);
  expect(facts.some(([predicate]) => predicate === "nearest_preset")).toBe(false);
});

test("North MCP advertises the complete composition contract", () => {
  const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`;
  const result = spawnSync("bb", [resolve(north, "bin/north-mcp")], { input: request, encoding: "utf8" });
  expect(result.status).toBe(0);
  const response = JSON.parse(result.stdout.trim());
  const spawn = response.result.tools.find((tool: any) => tool.name === "spawn");
  for (const field of ["role", "taskGrade", "domainRequirements", "topology", "tier", "reasoning", "posture", "composition", "target"])
    expect(spawn.inputSchema.properties[field]).toBeDefined();
  const dispatch = response.result.tools.find((tool: any) => tool.name === "dispatch");
  expect(dispatch.inputSchema.properties.target).toBeDefined();
  expect(spawn.inputSchema.required).toEqual([
    "prompt", "role", "taskGrade", "domainRequirements", "topology",
    "tier", "reasoning", "posture", "composition",
  ]);
  expect(dispatch.inputSchema.required).toEqual([
    "id", "role", "taskGrade", "domainRequirements", "topology",
    "tier", "reasoning", "posture", "composition",
  ]);
  expect(spawn.inputSchema.properties.reasoning.enum).toContain("xhigh");
  expect(spawn.inputSchema.properties.composition.oneOf).toHaveLength(2);
});
