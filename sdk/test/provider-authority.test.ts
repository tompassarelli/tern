import { afterEach, expect, test } from "bun:test";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyHarnessRoute,
  canonicalGlobalAgents,
  COORDINATION_TOOLS,
  domainSkillsDir,
  GLOBAL_AGENTS_MAX_BYTES,
  globalLawsPath,
  hasCanonicalHarnessAuthority,
  hasCanonicalAuthoringHooks,
  harnessOptions,
  NORTH_MCP_TOOL_NAMES,
  PROJECT_AGENTS_MAX_BYTES,
  projectAgentsAppendix,
} from "../src/harness";
import { providerEnvironmentForTarget } from "../src/accounts";
import { applyGafferStaffing } from "../src/gaffer-staffing";
import { admitRoutingRequest } from "../src/routing-admission";
import {
  MANAGED_NORTH_MCP_ENV_KEYS, validateManagedExecutionEnvelope,
} from "../src/execution-admission";
import {
  assertCodexGlobalAgentsForEnvironment, codexHarnessArguments,
} from "../src/providers/openai";
import {
  compileProviderAuthoritySurface,
} from "../src/providers/authority";
import {
  MANAGED_CODEX_DISABLED_FEATURES, MANAGED_CODEX_ENABLED_FEATURES,
} from "../src/providers/codex-app-server";

const north = join(import.meta.dir, "../..");
const temporary: string[] = [];
const envKeys = [
  "HOME", "AGENT_LAWS", "AGENT_LAWS_PATH", "AGENT_SKILLS_DIR", "NORTH_PORT",
  "FRAM_LOG", "FRAM_TELEMETRY_LOG",
  "FRAM_THREADS", "UNRELATED_SECRET_CANARY", "GAFFER_HOME", "NORTH_MANAGED_LANE",
  "NORTH_CODEX_BIN", "NORTH_MANAGED_CODEX_BIN",
] as const;
const inheritedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = inheritedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function designer(provider: "anthropic" | "openai", self: string): any {
  return harnessOptions({
    self,
    provider,
    cwd: north,
    presenceRegistrar: false,
    routingMetadata: applyGafferStaffing({ role: "designer" }),
  }) as any;
}

test("North MCP tool inventory and managed provider exposure stay exact", () => {
  const source = readFileSync(join(north, "bin/north-mcp"), "utf8");
  const main = source.slice(source.indexOf("(def tools"), source.indexOf(";; --- SDK agent tools"));
  const sdk = source.slice(source.indexOf("(def sdk-tools"), source.indexOf(";; Attribution"));
  const names = [...main.matchAll(/\{:name "([^"]+)"/g), ...sdk.matchAll(/\{:name "([^"]+)"/g)]
    .map((match) => match[1]);
  expect(names).toEqual([...NORTH_MCP_TOOL_NAMES]);

  const options = designer("anthropic", "anthropic-exact-surface");
  expect(options.settingSources).toEqual([]);
  expect(options.strictMcpConfig).toBe(true);
  expect(options.tools).toEqual(["Read", "Grep", "Glob"]);
  expect(options.allowedTools).toEqual([
    "Read", "Grep", "Glob", "mcp__north-readonly-shell__run", ...COORDINATION_TOOLS,
  ]);
  expect(options.allowedTools).toContain("mcp__north__evidence_record");
  expect(options.allowedTools).not.toContain("mcp__north__dispatch");
  expect(options.allowedTools).not.toContain("mcp__north__spawn");
  const contractNorth = new Set([
    ...COORDINATION_TOOLS.map((name) => name.replace("mcp__north__", "")),
  ]);
  for (const name of NORTH_MCP_TOOL_NAMES) {
    if (!contractNorth.has(name)) expect(options.disallowedTools).toContain(`mcp__north__${name}`);
  }
  expect(options.disallowedTools).toEqual(expect.arrayContaining([
    "mcp__north__clock_start",
    "mcp__north__linear_get",
    "mcp__north__linear_sync",
    "mcp__north__dispatch",
    "mcp__north__spawn",
  ]));

  const openaiWorker = designer("openai", "openai-exact-worker-surface");
  const workerSurface = compileProviderAuthoritySurface("openai", openaiWorker);
  expect(workerSurface.northEnabledTools).toEqual([
    "capture", "tell", "evidence_record", "show", "ready", "next", "board", "plate",
  ]);
  expect(workerSurface.northEnabledTools).not.toEqual(expect.arrayContaining(["dispatch", "spawn"]));
  expect(codexHarnessArguments(openaiWorker)).toEqual([
    ...MANAGED_CODEX_ENABLED_FEATURES.flatMap((name) => ["--enable", name]),
    ...MANAGED_CODEX_DISABLED_FEATURES.flatMap((name) => ["--disable", name]),
  ]);

  const director = harnessOptions({
    self: "openai-exact-orchestrator-surface",
    provider: "openai",
    cwd: north,
    presenceRegistrar: false,
    routingMetadata: applyGafferStaffing({ role: "director" }),
  }) as any;
  const directorSurface = compileProviderAuthoritySurface("openai", director);
  expect(directorSurface.northEnabledTools).toEqual(expect.arrayContaining(["dispatch", "spawn"]));
  expect(directorSurface.web).toBe("cached");
  expect(codexHarnessArguments(director)).toEqual([
    ...MANAGED_CODEX_ENABLED_FEATURES.flatMap((name) => ["--enable", name]),
    ...MANAGED_CODEX_DISABLED_FEATURES.flatMap((name) => ["--disable", name]),
  ]);
});

test("route application rejects request laundering and authoring hooks are an exact frozen surface", () => {
  const requestLaundered = designer("anthropic", "anthropic-request-laundering") as any;
  requestLaundered.northRoutingRequest = admitRoutingRequest(
    applyGafferStaffing({ role: "judge" }),
  );
  expect(() => applyHarnessRoute(
    requestLaundered, "anthropic", "claude-opus-4-6", "xhigh",
  )).toThrow("harness authority source mutated before route application");

  const hookLaundered = designer("anthropic", "anthropic-hook-laundering") as any;
  expect(Object.isFrozen(hookLaundered.hooks)).toBe(true);
  expect(Object.isFrozen(hookLaundered.hooks.PreToolUse)).toBe(true);
  expect(() => { hookLaundered.hooks.Stop = []; }).toThrow();
  hookLaundered.hooks = {
    ...hookLaundered.hooks,
    Stop: [{ hooks: [async () => ({ continue: true })] }],
  };
  expect(hasCanonicalAuthoringHooks(hookLaundered)).toBe(false);
  expect(() => applyHarnessRoute(
    hookLaundered, "anthropic", "claude-opus-4-6", "xhigh",
  )).toThrow("harness authority source mutated before route application");
});

test("provider authority surfaces are deeply frozen at every array boundary", () => {
  for (const provider of ["anthropic", "openai"] as const) {
    const surface = compileProviderAuthoritySurface(
      provider,
      designer(provider, `${provider}-deep-freeze`),
    ) as any;
    expect(Object.isFrozen(surface)).toBe(true);
    const arrays = [
      surface.capabilities,
      surface.northEnabledTools,
      ...(provider === "anthropic" ? [surface.builtins, surface.managedTools] : []),
    ] as string[][];
    for (const values of arrays) {
      const before = [...values];
      expect(Object.isFrozen(values)).toBe(true);
      expect(() => values.push("authority-mutation")).toThrow();
      expect(values).toEqual(before);
    }
    expect(() => { surface.liveInput = "forged"; }).toThrow();
  }
});

test("managed authority rejects every unowned SDK option on initial and fallback routes", () => {
  const hostile: Record<string, unknown> = {
    additionalDirectories: ["/home/tom/code/client"],
    plugins: [{ type: "local", path: "/tmp/hostile" }],
    extraArgs: { "dangerously-skip-permissions": "" },
    settings: "/tmp/hostile-settings.json",
    managedSettings: "/tmp/hostile-managed-settings.json",
    canUseTool: async () => ({ behavior: "allow" }),
    toolAliases: { Bash: "unrestricted" },
    allowDangerouslySkipPermissions: true,
  };
  for (const [field, value] of Object.entries(hostile)) {
    const initial = designer("anthropic", `anthropic-extra-${field}`) as any;
    initial[field] = value;
    expect(hasCanonicalHarnessAuthority(initial, "anthropic")).toBe(false);

    const source = designer("anthropic", `fallback-extra-${field}`) as any;
    const fallback = applyHarnessRoute(
      source, "openai", "gpt-5.6-terra", "high",
    ).options as any;
    fallback[field] = value;
    expect(hasCanonicalHarnessAuthority(fallback, "openai")).toBe(false);
  }

  const spend = designer("anthropic", "anthropic-max-turns-tamper") as any;
  spend.maxTurns = 1_000_000_000;
  expect(hasCanonicalHarnessAuthority(spend, "anthropic")).toBe(false);

  const settings = designer("anthropic", "anthropic-settings-tamper") as any;
  expect(Object.isFrozen(settings.settings)).toBe(true);
  expect(() => { settings.settings.autoCompactEnabled = false; }).toThrow();
  expect(hasCanonicalHarnessAuthority(settings, "anthropic")).toBe(true);
});

test("managed-lane marker is explicit, sealed, and never inherited or sent to North MCP", () => {
  process.env.NORTH_MANAGED_LANE = "ambient-forgery";
  process.env.NORTH_CODEX_BIN = "/tmp/ambient-codex-forgery";
  process.env.NORTH_MANAGED_CODEX_BIN =
    "/nix/store/00000000000000000000000000000000-codex-test/bin/codex";
  const options = designer("openai", "openai-managed-marker");
  expect(options.env.NORTH_MANAGED_LANE).toBe("1");
  expect(options.env).not.toHaveProperty("NORTH_CODEX_BIN");
  expect(options.env.NORTH_MANAGED_CODEX_BIN)
    .toBe("/nix/store/00000000000000000000000000000000-codex-test/bin/codex");
  expect(options.mcpServers.north.env).not.toHaveProperty("NORTH_MANAGED_LANE");
  expect(options.mcpServers.north.env).not.toHaveProperty("NORTH_MANAGED_CODEX_BIN");
  expect(Object.isFrozen(options.env)).toBe(true);
  expect(() => { options.env.NORTH_MANAGED_LANE = "0"; }).toThrow();
  expect(hasCanonicalHarnessAuthority(options, "openai")).toBe(true);

  const laundered = { ...options, env: { ...options.env, NORTH_MANAGED_LANE: "0" } };
  expect(hasCanonicalHarnessAuthority(laundered, "openai")).toBe(false);
});

test("both providers receive the exact custom North and Fram instance selectors without ambient secrets", () => {
  process.env.NORTH_PORT = "64129";
  process.env.FRAM_LOG = "/tmp/north-authority-facts.log";
  process.env.FRAM_TELEMETRY_LOG = "/tmp/north-authority-telemetry.log";
  process.env.FRAM_THREADS = "/tmp/north-authority-threads";
  process.env.UNRELATED_SECRET_CANARY = "must-not-cross-mcp-boundary";

  for (const provider of ["anthropic", "openai"] as const) {
    const options = designer(provider, `${provider}-custom-instance`);
    const env = options.mcpServers.north.env;
    expect(env).toMatchObject({
      NORTH_PORT: "64129",
      FRAM_LOG: "/tmp/north-authority-facts.log",
      FRAM_TELEMETRY_LOG: "/tmp/north-authority-telemetry.log",
      FRAM_THREADS: "/tmp/north-authority-threads",
    });
    expect(env).not.toHaveProperty("UNRELATED_SECRET_CANARY");
    expect(Object.keys(env).every((key) =>
      (MANAGED_NORTH_MCP_ENV_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(() => validateManagedExecutionEnvelope(
      provider, options.northCapabilities, options,
    )).not.toThrow();
  }

  const openai = designer("openai", "openai-custom-instance-runtime-layer");
  // The public argument preview is deliberately non-executable. Account and
  // MCP state enter only the same-process app-server layer that attests them.
  const preview = codexHarnessArguments(openai).join("\n");
  expect(preview).not.toContain("NORTH_PORT");
  expect(preview).not.toContain("FRAM_LOG");
  expect(preview).not.toContain("FRAM_TELEMETRY_LOG");
  expect(preview).not.toContain("FRAM_THREADS");
  expect(preview).not.toContain("UNRELATED_SECRET_CANARY");

  const tainted = {
    ...openai,
    mcpServers: {
      ...openai.mcpServers,
      north: {
        ...openai.mcpServers.north,
        env: { ...openai.mcpServers.north.env, UNRELATED_SECRET_CANARY: "injected" },
      },
    },
  };
  expect(() => validateManagedExecutionEnvelope(
    "openai", tainted.northCapabilities, tainted,
  )).toThrow("openai_managed_north_mcp_contract_missing");

  const omittedPort = {
    ...openai,
    mcpServers: {
      ...openai.mcpServers,
      north: {
        ...openai.mcpServers.north,
        env: Object.fromEntries(Object.entries(openai.mcpServers.north.env)
          .filter(([key]) => key !== "NORTH_PORT")),
      },
    },
  };
  expect(() => validateManagedExecutionEnvelope(
    "openai", omittedPort.northCapabilities, omittedPort,
  )).toThrow("openai_managed_north_mcp_contract_missing");

  const mutatedPort = {
    ...openai,
    mcpServers: {
      ...openai.mcpServers,
      north: {
        ...openai.mcpServers.north,
        env: { ...openai.mcpServers.north.env, NORTH_PORT: "64130" },
      },
    },
  };
  expect(() => validateManagedExecutionEnvelope(
    "openai", mutatedPort.northCapabilities, mutatedPort,
  )).toThrow("openai_managed_north_mcp_contract_missing");
});

test("managed lanes materialize the canonical default North port in lane and MCP environments", () => {
  delete process.env.NORTH_PORT;
  for (const provider of ["anthropic", "openai"] as const) {
    const options = designer(provider, `${provider}-default-port`);
    expect(options.env.NORTH_PORT).toBe("7977");
    expect(options.mcpServers.north.env.NORTH_PORT).toBe("7977");
    expect(() => validateManagedExecutionEnvelope(
      provider, options.northCapabilities, options,
    )).not.toThrow();
  }
});

test("canonical global AGENTS is fail-closed, bounded, valid UTF-8, and injected once for Anthropic", () => {
  const home = mkdtempSync(join(tmpdir(), "north-global-agents-"));
  temporary.push(home);
  // Exercise DEFAULT resolution: no explicit override, so laws must resolve from
  // ~/.agents/AGENTS.md — never a provider config home like ~/.codex.
  const agentsHome = join(home, ".agents");
  const source = join(agentsHome, "AGENTS.md");
  mkdirSync(agentsHome, { recursive: true });
  process.env.HOME = home;
  delete process.env.AGENT_LAWS_PATH;
  process.env.AGENT_LAWS = "on";

  expect(() => canonicalGlobalAgents()).toThrow("global AGENTS bootstrap cannot inspect canonical source");
  for (const provider of ["anthropic", undefined] as const) {
    let registrations = 0;
    expect(() => harnessOptions({
      self: `invalid-global-no-presence-${provider ?? "auto"}`,
      provider,
      cwd: north,
      presenceRegistrar: () => { registrations++; },
    })).toThrow("global AGENTS bootstrap cannot inspect canonical source");
    expect(registrations).toBe(0);
  }

  mkdirSync(source);
  expect(() => canonicalGlobalAgents()).toThrow("is not a regular file");
  rmSync(source, { recursive: true });

  writeFileSync(source, Buffer.from([0xc3, 0x28]));
  expect(() => canonicalGlobalAgents()).toThrow("is not valid UTF-8");

  writeFileSync(source, "x".repeat(GLOBAL_AGENTS_MAX_BYTES + 1));
  expect(() => canonicalGlobalAgents()).toThrow(
    `global AGENTS bootstrap exceeds ${GLOBAL_AGENTS_MAX_BYTES} bytes`,
  );

  writeFileSync(source, "GLOBAL_EXACT_ONCE_CANARY_67143\n");
  chmodSync(source, 0o000);
  try {
    expect(() => canonicalGlobalAgents()).toThrow("global AGENTS bootstrap cannot read canonical source");
  } finally {
    chmodSync(source, 0o600);
  }

  const canonical = canonicalGlobalAgents()!;
  expect(canonical.path).toBe(source);
  expect(canonical.text).toBe("GLOBAL_EXACT_ONCE_CANARY_67143\n");
  const anthropic = harnessOptions({
    self: "anthropic-global-exact-once",
    provider: "anthropic",
    cwd: north,
    presenceRegistrar: false,
  }) as any;
  expect(anthropic.systemPrompt.match(/GLOBAL_EXACT_ONCE_CANARY_67143/g)).toHaveLength(1);
  expect(() => harnessOptions({
    self: "anthropic-global-duplicate-denial",
    provider: "anthropic",
    cwd: north,
    presenceRegistrar: false,
    systemPrompt: "GLOBAL_EXACT_ONCE_CANARY_67143",
  })).toThrow("Anthropic global AGENTS bootstrap expected exactly once, observed 2");

  const openai = harnessOptions({
    self: "openai-global-native-only",
    provider: "openai",
    cwd: north,
    presenceRegistrar: false,
  }) as any;
  expect(openai.systemPrompt).not.toContain("GLOBAL_EXACT_ONCE_CANARY_67143");

  rmSync(source);
  process.env.AGENT_LAWS = "off";
  expect(canonicalGlobalAgents()).toBeUndefined();
  expect(() => harnessOptions({
    self: "anthropic-global-explicit-opt-out",
    provider: "anthropic",
    cwd: north,
    presenceRegistrar: false,
  })).not.toThrow();
});

test("global laws path resolves an exact override or the portable ~/.agents default, never a provider home", () => {
  const home = mkdtempSync(join(tmpdir(), "north-laws-path-"));
  temporary.push(home);

  // Default: ~/.agents/AGENTS.md, and specifically NOT a provider config home.
  const dfault = globalLawsPath({ HOME: home });
  expect(dfault).toBe(join(home, ".agents", "AGENTS.md"));
  expect(dfault).not.toBe(join(home, ".codex", "AGENTS.md"));
  expect(dfault).not.toContain(".codex");

  // An explicit AGENT_LAWS_PATH wins outright and is home-independent.
  const override = join(home, "custom", "LAWS.md");
  expect(globalLawsPath({ HOME: home, AGENT_LAWS_PATH: override })).toBe(override);
  expect(globalLawsPath({ AGENT_LAWS_PATH: override })).toBe(override);
  expect(globalLawsPath({ HOME: home, AGENT_LAWS_PATH: "  " })).toBe(dfault); // blank ignored

  // No override and no HOME is a hard configuration error, not a silent guess.
  expect(() => globalLawsPath({})).toThrow(
    "global AGENTS bootstrap requires AGENT_LAWS_PATH or HOME",
  );
});

test("domain skills dir resolves an exact override or the portable ~/.agents/skills default, never a provider checkout", () => {
  const home = mkdtempSync(join(tmpdir(), "north-skills-dir-"));
  temporary.push(home);

  const dfault = domainSkillsDir({ HOME: home });
  expect(dfault).toBe(join(home, ".agents", "skills"));
  expect(dfault).not.toBe(join(home, ".codex", "skills"));
  expect(dfault).not.toContain("nixos-config");

  const override = join(home, "portable-skills");
  expect(domainSkillsDir({ HOME: home, AGENT_SKILLS_DIR: override })).toBe(override);
  expect(domainSkillsDir({ AGENT_SKILLS_DIR: override })).toBe(override);
  expect(domainSkillsDir({ HOME: home, AGENT_SKILLS_DIR: "  " })).toBe(dfault); // blank ignored
});

test("ambient and isolated Codex targets resolve the exact canonical global AGENTS source", () => {
  const home = mkdtempSync(join(tmpdir(), "north-codex-global-targets-"));
  temporary.push(home);
  // The one canonical provider-neutral source lives at the portable ~/.agents
  // path (resolved via the explicit AGENT_LAWS_PATH override). Native Codex still
  // loads CODEX_HOME/AGENTS.md, so in the portable topology that file is a symlink
  // ONTO the one canonical source — their realpaths agree, so no divergence.
  const agentsHome = join(home, ".agents");
  const lawsSource = join(agentsHome, "AGENTS.md");
  mkdirSync(agentsHome, { recursive: true });
  writeFileSync(lawsSource, "CODEX_TARGET_GLOBAL_CANARY_81277\n");
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const source = join(codexHome, "AGENTS.md");
  symlinkSync(lawsSource, source);
  const baseEnv = { ...process.env, HOME: home, AGENT_LAWS: "on", AGENT_LAWS_PATH: lawsSource };

  const ambient = providerEnvironmentForTarget("openai", undefined, { env: baseEnv });
  expect(ambient.CODEX_HOME).toBe(codexHome);
  expect(() => assertCodexGlobalAgentsForEnvironment(
    ambient, "PROJECT_ONLY_DEVELOPER_CANARY",
  )).not.toThrow();
  expect(() => assertCodexGlobalAgentsForEnvironment(
    { ...ambient, AGENT_LAWS: "off" }, "PROJECT_ONLY_DEVELOPER_CANARY",
  )).toThrow("openai_agent_laws_opt_out_unenforceable");

  const target = {
    id: "codex-isolated-global-proof",
    provider: "openai" as const,
    authMode: "isolated" as const,
    profile: "isolated-global-proof",
  };
  const isolated = providerEnvironmentForTarget("openai", target, { env: baseEnv });
  const isolatedAgents = join(isolated.CODEX_HOME!, "AGENTS.md");
  expect(readlinkSync(isolatedAgents)).toBe(source);
  expect(() => assertCodexGlobalAgentsForEnvironment(
    isolated, "PROJECT_ONLY_DEVELOPER_CANARY",
  )).not.toThrow();

  expect(() => assertCodexGlobalAgentsForEnvironment(
    isolated, "CODEX_TARGET_GLOBAL_CANARY_81277",
  )).toThrow("openai_global_agents_duplicated_in_developer_instructions");

  const missingHome = join(home, "missing");
  mkdirSync(missingHome);
  expect(() => assertCodexGlobalAgentsForEnvironment(
    { ...baseEnv, CODEX_HOME: missingHome }, "PROJECT_ONLY_DEVELOPER_CANARY",
  )).toThrow("openai_target_global_agents_unavailable");

  const replacedHome = join(home, "replaced");
  mkdirSync(replacedHome);
  mkdirSync(join(replacedHome, "AGENTS.md"));
  expect(() => assertCodexGlobalAgentsForEnvironment(
    { ...baseEnv, CODEX_HOME: replacedHome }, "PROJECT_ONLY_DEVELOPER_CANARY",
  )).toThrow("openai_target_global_agents_not_regular_file");

  const copiedHome = join(home, "copied");
  mkdirSync(copiedHome);
  writeFileSync(join(copiedHome, "AGENTS.md"), readFileSync(source));
  expect(() => assertCodexGlobalAgentsForEnvironment(
    { ...baseEnv, CODEX_HOME: copiedHome }, "PROJECT_ONLY_DEVELOPER_CANARY",
  )).toThrow("openai_target_global_agents_not_canonical");

  const invalidHome = join(home, "invalid");
  mkdirSync(invalidHome);
  writeFileSync(join(invalidHome, "AGENTS.md"), Buffer.from([0xc3, 0x28]));
  expect(() => assertCodexGlobalAgentsForEnvironment(
    { ...baseEnv, CODEX_HOME: invalidHome }, "PROJECT_ONLY_DEVELOPER_CANARY",
  )).toThrow("openai_target_global_agents_invalid_utf8");

  const unreadableHome = join(home, "unreadable");
  mkdirSync(unreadableHome);
  const unreadable = join(unreadableHome, "AGENTS.md");
  writeFileSync(unreadable, readFileSync(source));
  chmodSync(unreadable, 0o000);
  try {
    expect(() => assertCodexGlobalAgentsForEnvironment(
      { ...baseEnv, CODEX_HOME: unreadableHome }, "PROJECT_ONLY_DEVELOPER_CANARY",
    )).toThrow("openai_target_global_agents_unavailable");
  } finally {
    chmodSync(unreadable, 0o600);
  }

  const oversizedHome = join(home, "oversized");
  mkdirSync(oversizedHome);
  writeFileSync(join(oversizedHome, "AGENTS.md"), "x".repeat(GLOBAL_AGENTS_MAX_BYTES + 1));
  expect(() => assertCodexGlobalAgentsForEnvironment(
    { ...baseEnv, CODEX_HOME: oversizedHome }, "PROJECT_ONLY_DEVELOPER_CANARY",
  )).toThrow("openai_target_global_agents_oversized");

  const linkedHome = join(home, "linked");
  mkdirSync(linkedHome);
  symlinkSync(source, join(linkedHome, "AGENTS.md"));
  writeFileSync(join(linkedHome, "AGENTS.override.md"), "OVERRIDE_MUST_NOT_WIN\n");
  expect(() => assertCodexGlobalAgentsForEnvironment(
    { ...baseEnv, CODEX_HOME: linkedHome }, "PROJECT_ONLY_DEVELOPER_CANARY",
  )).toThrow("openai_global_agents_override_present");
});

test("native Codex loads global AGENTS exactly once while managed project discovery is disabled", () => {
  const home = mkdtempSync(join(tmpdir(), "north-codex-native-agents-"));
  temporary.push(home);
  const codexHome = join(home, "codex-home");
  const project = join(home, "project");
  mkdirSync(codexHome);
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(codexHome, "AGENTS.md"), "NATIVE_GLOBAL_EXACT_ONCE_CANARY_41729\n");
  writeFileSync(join(project, "AGENTS.md"), "NATIVE_PROJECT_MUST_BE_SUPPRESSED_41729\n");
  const probe = spawnSync("codex", [
    "-C", project,
    "debug", "prompt-input",
    "-c", "project_doc_max_bytes=0",
    "NATIVE_TASK_CANARY_41729",
  ], {
    // AGENT_LAWS is a North switch, not a native Codex switch. This probe
    // proves why managed OpenAI must reject that opt-out as unenforceable.
    env: { ...process.env, AGENT_LAWS: "off", CODEX_HOME: codexHome },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(probe.error).toBeUndefined();
  expect(probe.status).toBe(0);
  expect(probe.stdout.match(/NATIVE_GLOBAL_EXACT_ONCE_CANARY_41729/g)).toHaveLength(1);
  expect(probe.stdout).not.toContain("NATIVE_PROJECT_MUST_BE_SUPPRESSED_41729");
  expect(probe.stdout.match(/NATIVE_TASK_CANARY_41729/g)).toHaveLength(1);
});

test("project AGENTS composition is bounded, root-to-cwd, override-aware, and provider-neutral", () => {
  const home = mkdtempSync(join(tmpdir(), "north-project-agents-"));
  temporary.push(home);
  const project = join(home, "project");
  const nested = join(project, "src", "module");
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  mkdirSync(join(home, ".agents"), { recursive: true });
  writeFileSync(join(home, ".agents", "AGENTS.md"), "GLOBAL_AUTHORITY_CANARY\n");
  writeFileSync(join(project, "AGENTS.md"), "ROOT_PROJECT_CANARY\n");
  writeFileSync(join(project, "src", "AGENTS.md"), "SRC_PROJECT_CANARY\n");
  writeFileSync(join(nested, "AGENTS.md"), "SHADOWED_PROJECT_CANARY\n");
  writeFileSync(join(nested, "AGENTS.override.md"), "OVERRIDE_PROJECT_CANARY\n");
  process.env.HOME = home;
  delete process.env.AGENT_LAWS_PATH;
  process.env.AGENT_LAWS = "on";
  process.env.GAFFER_HOME = inheritedEnv.GAFFER_HOME ?? join(north, "../gaffer");

  const appendix = projectAgentsAppendix(nested);
  expect(appendix.indexOf("ROOT_PROJECT_CANARY")).toBeLessThan(appendix.indexOf("SRC_PROJECT_CANARY"));
  expect(appendix.indexOf("SRC_PROJECT_CANARY")).toBeLessThan(appendix.indexOf("OVERRIDE_PROJECT_CANARY"));
  expect(appendix).not.toContain("SHADOWED_PROJECT_CANARY");

  const anthropic = harnessOptions({
    self: "anthropic-project-bootstrap", provider: "anthropic", cwd: nested, presenceRegistrar: false,
  }) as any;
  const openai = harnessOptions({
    self: "openai-project-bootstrap", provider: "openai", cwd: nested, presenceRegistrar: false,
  }) as any;
  for (const options of [anthropic, openai]) {
    expect(options.systemPrompt).toContain("ROOT_PROJECT_CANARY");
    expect(options.systemPrompt).toContain("SRC_PROJECT_CANARY");
    expect(options.systemPrompt).toContain("OVERRIDE_PROJECT_CANARY");
  }
  expect(anthropic.systemPrompt).toContain("GLOBAL_AUTHORITY_CANARY");
  expect(openai.systemPrompt).not.toContain("GLOBAL_AUTHORITY_CANARY");
  const managedOpenAI = harnessOptions({
    self: "openai-native-project-doc-suppression",
    provider: "openai",
    cwd: nested,
    presenceRegistrar: false,
    routingMetadata: applyGafferStaffing({ role: "designer" }),
  }) as any;
  expect(codexHarnessArguments(managedOpenAI)).not.toContain("project_doc_max_bytes=0");

  writeFileSync(join(project, "AGENTS.md"), "x".repeat(PROJECT_AGENTS_MAX_BYTES));
  expect(() => projectAgentsAppendix(nested)).toThrow(
    `project AGENTS bootstrap exceeds ${PROJECT_AGENTS_MAX_BYTES} bytes`,
  );
});
