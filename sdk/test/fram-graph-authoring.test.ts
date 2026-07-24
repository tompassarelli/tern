import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  GAFFER_CAPABILITIES, hasAuthoringCapability,
} from "../src/gaffer-capabilities";
import {
  gafferCapabilities, loadGafferStaffing,
} from "../src/gaffer-staffing";
import type { RoutingRequest } from "../src/routing-metadata";
import {
  hasCanonicalHarnessAuthority, harnessOptions, managedToolPolicy,
} from "../src/harness";
import {
  validateManagedExecutionEnvelope,
} from "../src/execution-admission";
import {
  FRAM_MCP_COMMAND, FRAM_MCP_TOOL_NAMES, FRAM_MCP_TOOLS, framMcpEnvironment,
} from "../src/fram-graph-authoring";
import {
  compileProviderAuthoritySurface,
} from "../src/providers/authority";
import { eligibleForProviderProcessDeathRetry } from "../src/spawn";

const north = resolve(import.meta.dir, "../..");
const originalAgentLaws = process.env.AGENT_LAWS;

afterEach(() => {
  if (originalAgentLaws === undefined) delete process.env.AGENT_LAWS;
  else process.env.AGENT_LAWS = originalAgentLaws;
});

const graphAuthoringRequest: RoutingRequest = {
  role: "beagle-graph-author",
  taskGrade: "senior",
  domainRequirements: ["Beagle graph authoring"],
  topology: "worker",
  tier: "senior",
  reasoning: "high",
  posture: "deliver",
  composition: {
    kind: "bespoke",
    id: "beagle-graph-author",
    bespokeReason: "Fram graph editing is a distinct sealed authority",
    promotionCandidate: false,
    contract: {
      responsibility: "author a graph-upstream Beagle module",
      deliverable: "a compiler-accepted graph edit",
      capabilities: [
        "filesystem.read",
        "filesystem.search",
        "shell.readonly",
        "graph-authoring.fram",
      ],
      mayDecide: ["which graph edit verb fits the requested change"],
      mustEscalate: ["any text edit to graph-upstream source"],
      doneWhen: ["the graph edit recompiles"],
      report: "edited definitions and compiler result",
    },
  },
};

test("graph-authoring.fram is bespoke-only and classed as mutation authority", () => {
  const catalog = loadGafferStaffing();
  expect(GAFFER_CAPABILITIES).toContain("graph-authoring.fram");
  expect(catalog.vocabulary.capabilities).not.toContain("graph-authoring.fram");
  for (const preset of catalog.presets)
    expect(preset.capabilities).not.toContain("graph-authoring.fram");
  expect(gafferCapabilities(graphAuthoringRequest)).toContain("graph-authoring.fram");
  expect(hasAuthoringCapability(["graph-authoring.fram"])).toBe(true);
  expect(eligibleForProviderProcessDeathRetry(
    "openai_provider_execution_failed", "worker", ["graph-authoring.fram"],
  )).toBe(false);
});

test("managed providers compile the exact sealed Fram MCP only when explicitly requested", () => {
  process.env.AGENT_LAWS = "off";
  for (const provider of ["anthropic", "openai"] as const) {
    const options = harnessOptions({
      self: `${provider}-fram-graph-author`,
      provider,
      cwd: north,
      presenceRegistrar: false,
      routingMetadata: graphAuthoringRequest,
    }) as any;
    expect(hasCanonicalHarnessAuthority(options, provider)).toBe(true);
    expect(Object.keys(options.mcpServers)).toEqual([
      "north", "north-readonly-shell", "fram",
    ]);
    expect(options.mcpServers.fram).toEqual({
      type: "stdio",
      command: FRAM_MCP_COMMAND,
      args: [],
      env: framMcpEnvironment(north),
    });
    expect(Object.isFrozen(options.mcpServers.fram)).toBe(true);
    expect(Object.isFrozen(options.mcpServers.fram.env)).toBe(true);
    expect(options.mcpServers.fram.env.FRAM_SRC).toBe(north);
    expect(options.mcpServers.fram.env.FRAM_CODE_LOG).toBe(resolve(north, ".fram/code.log"));
    expect(options.allowedTools).toEqual(expect.arrayContaining([...FRAM_MCP_TOOLS]));
    expect(options.disallowedTools).not.toEqual(expect.arrayContaining([...FRAM_MCP_TOOLS]));
    expect(() => validateManagedExecutionEnvelope(
      provider, options.northCapabilities, options,
    )).not.toThrow();
    expect(compileProviderAuthoritySurface(provider, options).capabilities)
      .toContain("graph-authoring.fram");

    const missingFram = {
      ...options,
      mcpServers: Object.fromEntries(
        Object.entries(options.mcpServers).filter(([name]) => name !== "fram"),
      ),
    };
    expect(() => validateManagedExecutionEnvelope(
      provider, missingFram.northCapabilities, missingFram,
    )).toThrow(`${provider}_managed_fram_mcp_contract_missing`);
  }

  const absentPolicy = managedToolPolicy(["filesystem.read"]);
  expect(absentPolicy.disallowedTools).toEqual(expect.arrayContaining([...FRAM_MCP_TOOLS]));
  expect(FRAM_MCP_TOOL_NAMES).toHaveLength(10);
});
