import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyHarnessRoute, gafferAppendix, harnessCompositionEvidence, harnessOptions,
} from "../src/harness";
import { applyGafferStaffing } from "../src/gaffer-staffing";
import type { RoutingMetadata } from "../src/routing-metadata";
import { runFacts } from "../src/telemetry";
import { codexGlobalArguments, codexHarnessArguments } from "../src/providers/openai";
import {
  MANAGED_CODEX_DISABLED_FEATURES, MANAGED_CODEX_ENABLED_FEATURES,
} from "../src/providers/codex-app-server";
import {
  compileProviderAuthoritySurface, formatProviderAuthoritySurface,
} from "../src/providers";
import { resolveTier } from "../src/providers/catalog";
import { READONLY_SHELL_SERVER, READONLY_SHELL_TOOL } from "../src/readonly-shell";

const north = resolve(import.meta.dir, "../..");
const savedEnv = Object.fromEntries(
  ["GAFFER_HOME", "AGENT_LAWS", "AGENT_PRAXIS", "NORTH_BIN", "NORTH_DISPATCH_DRIVER_PRECLAIMED"]
    .map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const preset = (role: string): RoutingMetadata => applyGafferStaffing({ role });
const managedCodexPreview = [
  ...MANAGED_CODEX_ENABLED_FEATURES.flatMap((name) => ["--enable", name]),
  ...MANAGED_CODEX_DISABLED_FEATURES.flatMap((name) => ["--disable", name]),
];

const bespoke: RoutingMetadata = {
  role: "migration-forensics",
  taskGrade: "staff",
  domainRequirements: ["schema-recovery"],
  topology: "worker",
  tier: "frontier",
  reasoning: "xhigh",
  posture: "preserve",
  composition: {
    kind: "bespoke",
    id: "migration-forensics",
    nearestPreset: "analyst",
    bespokeReason: "the preset has the wrong authority boundary",
    promotionCandidate: true,
    contract: {
      responsibility: "trace the historical migration without changing it",
      deliverable: "an evidence-linked transition map",
      capabilities: ["filesystem.read", "filesystem.search", "shell.readonly"],
      mayDecide: ["which read-only trace to follow"],
      mustEscalate: ["any destructive recovery"],
      doneWhen: ["every transition has provenance"],
      report: "timeline, contradictions, and gaps",
    },
  },
};

test("preset roles receive the exact canonical role contract and fail closed when it is absent", () => {
  const composed = gafferAppendix(preset("integrator"), north);
  expect(composed.appendix).toContain("## Gaffer role contract — preset:integrator");
  expect(composed.appendix).toContain("ROLE: INTEGRATOR. Deliverable: a working change across seams");
  expect(composed.evidence).toMatchObject({ roleKind: "preset", roleId: "integrator" });

  const empty = mkdtempSync(join(tmpdir(), "north-gaffer-missing-"));
  try {
    process.env.GAFFER_HOME = empty;
    expect(() => gafferAppendix(preset("integrator"), north))
      .toThrow("/providers/anthropic.json");
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("bespoke composition executes its structured contract without impersonating nearest preset", () => {
  const composed = gafferAppendix(bespoke, north);
  expect(composed.appendix).toContain("## Gaffer role contract — bespoke:migration-forensics");
  expect(composed.appendix).toContain("Responsibility: trace the historical migration without changing it");
  expect(composed.appendix).toContain("Must escalate:\n- any destructive recovery");
  expect(composed.appendix).not.toContain("ROLE: ANALYST");
  expect(composed.evidence.bespokeContractHash).toMatch(/^[a-f0-9]{64}$/);
});

test("task grade is an exact authority block and remains orthogonal to semantic tier", () => {
  const composed = gafferAppendix({ taskGrade: "novice", tier: "frontier", reasoning: "xhigh" }, north);
  expect(composed.appendix).toContain("TASK GRADE: NOVICE. The brief must be fully specified");
  expect(composed.appendix).toContain("Semantic tier: frontier.");
  expect(composed.appendix).toContain("Reasoning: xhigh.");
  expect(composed.evidence).toMatchObject({ taskGrade: "novice", tier: "frontier", reasoning: "xhigh" });
});

test("domain requirements install a before-side-effect context gate, not an expertise claim", () => {
  const composed = gafferAppendix({ domainRequirements: ["Beagle", "unknown-specialty"] }, north);
  expect(composed.appendix).toContain("Before any side effect, satisfy every domain requirement");
  expect(composed.appendix).toContain("candidates are not proof of expertise");
  expect(composed.appendix).toContain("DOMAIN CONTEXT MISSING:");
  expect(composed.appendix).toContain("### Beagle");
  expect(composed.appendix).toContain("### unknown-specialty");
});

test("topology controls prompt and tools with positive-only orchestration authority", async () => {
  process.env.AGENT_LAWS = "off";
  const worker = harnessOptions({
    self: "worker-topology", provider: "openai", model: "gpt-5.6-sol",
    presenceRegistrar: false, routingMetadata: preset("integrator"),
  }) as any;
  expect(worker.systemPrompt).toContain("TOPOLOGY: WORKER");
  expect(worker.allowedTools).not.toContain("Agent");
  expect(worker.allowedTools).not.toContain("mcp__north__spawn");
  expect(worker.disallowedTools).toContain("mcp__north__dispatch");
  expect(worker.mcpServers["north-peer"]).toBeUndefined();
  process.env.NORTH_BIN = "/bin/true";
  const workerBash = worker.hooks.PreToolUse.find((entry: any) => entry.matcher === "Bash").hooks[0];
  expect(await workerBash({
    tool_name: "Bash", tool_input: { command: "north spawn implementer forbidden" }, cwd: north,
  })).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });

  const orchestrator = harnessOptions({
    self: "orchestrator-topology", provider: "openai", model: "gpt-5.6-sol",
    presenceRegistrar: false,
    routingMetadata: preset("director"),
  }) as any;
  expect(orchestrator.systemPrompt).toContain("TOPOLOGY: ORCHESTRATOR");
  expect(orchestrator.allowedTools).toContain("mcp__north__spawn");
  expect(orchestrator.allowedTools).toContain("mcp__north-peer__command_peer");
  expect(orchestrator.disallowedTools).toContain("Agent");

  const neutral = harnessOptions({ self: "neutral-topology", presenceRegistrar: false }) as any;
  expect(neutral.systemPrompt).not.toContain("TOPOLOGY: WORKER");
  expect(neutral.systemPrompt).not.toContain("TOPOLOGY: ORCHESTRATOR");
  expect(neutral.allowedTools).not.toContain("mcp__north__spawn");
  expect(neutral.disallowedTools).toContain("mcp__north__spawn");
  expect(neutral.disallowedTools).toContain("Agent");
});

test("Gaffer capabilities compile to exact provider authority before work starts", () => {
  process.env.AGENT_LAWS = "off";
  const designer = harnessOptions({
    self: "capability-designer", provider: "anthropic", model: "opus", cwd: north,
    presenceRegistrar: false, routingMetadata: preset("designer"),
  }) as any;
  expect(designer.northCapabilities).toEqual([
    "filesystem.read", "filesystem.search", "shell.readonly",
  ]);
  expect(designer.allowedTools).toEqual(expect.arrayContaining([
    "Read", "Grep", "Glob", READONLY_SHELL_TOOL,
  ]));
  expect(designer.allowedTools).not.toContain("Bash");
  expect(designer.disallowedTools).toContain("Bash");
  expect(designer.mcpServers[READONLY_SHELL_SERVER]).toBeDefined();
  expect(designer.allowedTools).not.toEqual(expect.arrayContaining(["Edit", "Write", "WebSearch"]));
  expect(designer.disallowedTools).toEqual(expect.arrayContaining([
    "Edit", "Write", "MultiEdit", "NotebookEdit", "WebSearch", "WebFetch",
    "mcp__north__spawn", "mcp__north__dispatch",
  ]));
  expect(designer.permissionMode).toBe("default");
  expect(designer.sandbox).toBeUndefined();
  const loggedSurface = formatProviderAuthoritySurface(
    compileProviderAuthoritySurface("anthropic", designer),
  );
  expect(loggedSurface).toBe(
    "provider=anthropic; capabilities=filesystem.read,filesystem.search,shell.readonly; "
    + "native-multi-agent=disabled; "
    + "live-input=streaming; "
    + "authoring-hooks=harness-exact; "
    + "north enabled_tools=capture,tell,evidence_record,show,ready,next,board,plate; "
    + "web=disabled; sdk builtins=Read,Grep,Glob; "
    + "mcp tools=mcp__north-readonly-shell__run,mcp__north__capture,mcp__north__tell,"
    + "mcp__north__evidence_record,mcp__north__show,mcp__north__ready,mcp__north__next,"
    + "mcp__north__board,mcp__north__plate",
  );
  expect(loggedSurface).not.toMatch(/\b(Edit|Write|Bash)\b/);

  const director = harnessOptions({
    self: "capability-director", provider: "openai", model: "gpt-5.6-sol", cwd: north,
    presenceRegistrar: false, routingMetadata: preset("director"),
  }) as any;
  expect(director.allowedTools).toEqual(expect.arrayContaining([
    "Read", "Grep", "Glob", READONLY_SHELL_TOOL, "WebSearch", "WebFetch",
    "mcp__north__spawn", "mcp__north__dispatch", "mcp__north-peer__command_peer",
  ]));
  expect(director.disallowedTools).toEqual(expect.arrayContaining([
    "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Agent", "Task", "Workflow",
  ]));
  expect(director.allowedTools).toContain(READONLY_SHELL_TOOL);
  expect(director.allowedTools).not.toContain("Bash");
  expect(codexGlobalArguments(director)).toEqual([]);
  expect(codexHarnessArguments(director)).toEqual(managedCodexPreview);
  const directorSurface = compileProviderAuthoritySurface("openai", director);
  expect(directorSurface.northEnabledTools).toEqual(expect.arrayContaining(["spawn", "dispatch"]));
  expect(directorSurface.web).toBe("cached");
  expect(director.mcpServers[READONLY_SHELL_SERVER]).toBeDefined();

  const integrator = harnessOptions({
    self: "capability-integrator", provider: "openai", model: "gpt-5.6-sol", cwd: north,
    presenceRegistrar: false, routingMetadata: preset("integrator"),
  }) as any;
  expect(integrator.allowedTools).toEqual(expect.arrayContaining([
    "Read", "Grep", "Glob", "Edit", "Write", "Bash",
  ]));
  expect(integrator.disallowedTools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
  expect(codexGlobalArguments(integrator)).toEqual([]);
  expect(codexHarnessArguments(integrator)).toEqual(managedCodexPreview);
});

test("managed capacity resolves from the complete request before the provider seal", () => {
  process.env.AGENT_LAWS = "off";
  const request = preset("designer");
  for (const provider of ["openai", "anthropic"] as const) {
    const resolved = resolveTier(provider, request.tier, undefined, request.reasoning);
    const options = harnessOptions({
      self: `${provider}-request-capacity`,
      provider,
      presenceRegistrar: false,
      routingMetadata: request,
    }) as any;
    expect(options.model).toBe(resolved.model);
    expect(options.effort).toBe(resolved.effort);
    expect(compileProviderAuthoritySurface(provider, options).provider).toBe(provider);
  }
  expect(() => harnessOptions({
    self: "mismatched-effort",
    provider: "anthropic",
    effort: "high",
    presenceRegistrar: false,
    routingMetadata: request,
  })).toThrow("effort compatibility alias must equal routingMetadata.reasoning");
});

test("posture remains effective even when the retired praxis toggle is off", () => {
  process.env.AGENT_PRAXIS = "off";
  const composed = gafferAppendix({ posture: "preserve" }, north);
  expect(composed.appendix).toContain("POSTURE: PRESERVE — legacy, shared infra");
});

test("model calibration uses exact catalog keys and never applies stale alias deltas", () => {
  process.env.AGENT_LAWS = "off";
  const opus = harnessOptions({
    self: "delta-opus", provider: "anthropic", model: "opus",
    presenceRegistrar: false,
    routingMetadata: preset("integrator"),
  });
  expect(opus.systemPrompt).not.toContain("Gaffer exact-model delta");
  expect(harnessCompositionEvidence(opus)?.modelDelta).toMatchObject({
    provider: "anthropic", model: "claude-opus-4-8", kind: "none",
  });

  const fallback = applyHarnessRoute(opus, "openai", "gpt-5.6-sol");
  expect(fallback.options.systemPrompt).toContain("Gaffer exact-model delta — openai:gpt-5.6-sol");
  expect(fallback.options.systemPrompt).toContain("ANCHOR LINE");
  expect(fallback.evidence?.modelDelta).toMatchObject({
    provider: "openai", model: "gpt-5.6-sol", kind: "calibrated",
    path: "docs/deltas/gpt-5.6-sol.md",
  });

  expect(() => harnessOptions({
    self: "delta-substring", provider: "anthropic", model: "custom-opus-lookalike",
    presenceRegistrar: false,
    routingMetadata: preset("integrator"),
  })).toThrow("provider anthropic does not declare model custom-opus-lookalike");

  const fable = harnessOptions({
    self: "delta-fable", provider: "anthropic", model: "fable",
    presenceRegistrar: false,
    routingMetadata: preset("designer"),
  });
  expect(fable.systemPrompt).not.toContain("Gaffer exact-model delta");
  expect(harnessCompositionEvidence(fable)?.modelDelta).toMatchObject({
    provider: "anthropic", model: "claude-fable-5", kind: "none",
  });
});

test("cross-model escalation omits calibration explicitly instead of retaining stale instructions", () => {
  process.env.AGENT_LAWS = "off";
  const options = harnessOptions({
    self: "delta-escalating", provider: "anthropic", model: "opus",
    presenceRegistrar: false,
    routingMetadata: preset("integrator"), omitModelDeltaReason: "cross_model_escalation_enabled",
  });
  expect(options.systemPrompt).not.toContain("Gaffer exact-model delta");
  expect(harnessCompositionEvidence(options)?.modelDelta).toEqual({
    provider: "anthropic", model: "claude-opus-4-8", kind: "omitted", reason: "cross_model_escalation_enabled",
  });
});

test("Codex receives per-run native-agent disablement and a worker North allowlist", () => {
  const worker = codexHarnessArguments({
    disallowedTools: ["Agent", "Task", "Workflow", "mcp__north__spawn", "mcp__north__dispatch"],
  });
  expect(worker).toEqual([
    "--disable", "multi_agent", "--config",
    "mcp_servers.north.enabled_tools=[\"capture\",\"tell\",\"evidence_record\",\"show\",\"ready\",\"next\",\"board\",\"plate\"]",
  ]);
  expect(codexHarnessArguments({ disallowedTools: ["Agent"] })).toEqual(["--disable", "multi_agent"]);
});

test("nested North MCP attribution pins the immediate agent and drops inherited preclaim state", () => {
  process.env.NORTH_DISPATCH_DRIVER_PRECLAIMED = "parent-claim";
  const registrations: Array<[string, string]> = [];
  const options = harnessOptions({
    self: "immediate-parent",
    presenceRegistrar: (self, cwd) => registrations.push([self, cwd]),
  }) as any;
  expect(registrations).toEqual([["immediate-parent", process.cwd()]]);
  expect(options.mcpServers.north.env.AGENT_ID).toBe("immediate-parent");
  expect(options.mcpServers.north.env.NORTH_DISPATCH_DRIVER_PRECLAIMED).toBeUndefined();
  expect(options.env.AGENT_ID).toBe("immediate-parent");
  expect(options.env.NORTH_DISPATCH_DRIVER_PRECLAIMED).toBeUndefined();
});

test("telemetry proves bespoke composition without exposing contract text", () => {
  const composed = gafferAppendix(bespoke, north);
  const canary = bespoke.composition?.kind === "bespoke" ? bespoke.composition.contract.responsibility : "";
  const facts = runFacts({
    thread: "thread", agent: "lane", durationMs: 1, posture: "spawn", outcome: "ran",
    routingMetadata: bespoke, promptComposition: composed.evidence,
  });
  expect(facts).toContainEqual(["applied_role_contract", "bespoke:migration-forensics"]);
  expect(facts.some(([predicate]) => predicate === "applied_bespoke_contract_sha256")).toBe(true);
  expect(facts).toContainEqual(["applied_bespoke_contract_fingerprint_version", "v1"]);
  expect(facts).toContainEqual([
    "applied_bespoke_contract_fingerprint_domain", "north:bespoke-contract:v1",
  ]);
  expect(facts.filter(([predicate]) => predicate === "applied_capability")).toEqual([
    ["applied_capability", "filesystem.read"],
    ["applied_capability", "filesystem.search"],
    ["applied_capability", "shell.readonly"],
  ]);
  expect(facts.find(([predicate]) => predicate === "applied_comms_contract_sha256")?.[1])
    .toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(facts)).not.toContain(canary);
});

test("preset override rationale is preserved as requested audit and hashed applied evidence", () => {
  const metadata = applyGafferStaffing({
    role: "integrator",
    tier: "frontier",
    reasoning: "xhigh",
    composition: {
      kind: "preset", id: "integrator", overrides: ["tier", "reasoning"],
      overrideReason: "this integrator owns the cross-seam reduction",
    },
  });
  const composed = gafferAppendix(metadata, north);
  const facts = runFacts({
    thread: "thread", agent: "lane", durationMs: 1, posture: "spawn", outcome: "ran",
    routingMetadata: metadata, promptComposition: composed.evidence,
  });
  expect(facts).toContainEqual(["composition_override", "tier"]);
  expect(facts).toContainEqual(["composition_override", "reasoning"]);
  expect(facts).toContainEqual(["composition_override_reason", "this integrator owns the cross-seam reduction"]);
  expect(facts).toContainEqual(["applied_preset_override", "tier"]);
  expect(facts).toContainEqual(["applied_preset_override", "reasoning"]);
  expect(facts.find(([predicate]) => predicate === "applied_preset_override_reason_sha256")?.[1])
    .toMatch(/^[a-f0-9]{64}$/);
});
