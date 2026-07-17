import { afterEach, expect, test } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { codexHarnessArguments, openaiProvider } from "../src/providers/openai";
import { ProviderRetrySafeError, routedQuery } from "../src/providers";
import { harnessOptions } from "../src/harness";
import { applyGafferStaffing } from "../src/gaffer-staffing";
import { markExecutionAdmission } from "../src/execution-admission";
import { selectProviderFromAvailability } from "../src/provider-routing";

const savedBin = process.env.NORTH_CODEX_BIN;
const savedHome = process.env.HOME;
const savedPort = process.env.NORTH_PORT;
const savedLaws = process.env.AGENT_LAWS;
const savedGaffer = process.env.GAFFER_HOME;
const northRoot = realpathSync(join(import.meta.dir, "../.."));
const temporary: string[] = [];
afterEach(() => {
  if (savedBin === undefined) delete process.env.NORTH_CODEX_BIN;
  else process.env.NORTH_CODEX_BIN = savedBin;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPort === undefined) delete process.env.NORTH_PORT;
  else process.env.NORTH_PORT = savedPort;
  if (savedLaws === undefined) delete process.env.AGENT_LAWS;
  else process.env.AGENT_LAWS = savedLaws;
  if (savedGaffer === undefined) delete process.env.GAFFER_HOME;
  else process.env.GAFFER_HOME = savedGaffer;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function resultFromScript(lines: string[]): Promise<any> {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-usage-"));
  temporary.push(directory);
  const command = join(directory, "fake-codex");
  writeFileSync(command, `#!/usr/bin/env bash\n${lines.map((line) => `printf '%s\\n' '${line}'`).join("\n")}\n`);
  chmodSync(command, 0o700);
  process.env.NORTH_CODEX_BIN = command;
  const messages: any[] = [];
  for await (const message of openaiProvider.query({ prompt: "x", options: {} as any }) as AsyncIterable<any>) {
    messages.push(message);
  }
  return messages.at(-1);
}

test("Codex adapter owns the cumulative total and does not double-count subsets", async () => {
  const result = await resultFromScript([
    JSON.stringify({ type: "turn.completed", usage: {
      input_tokens: 100, cached_input_tokens: 60,
      output_tokens: 20, reasoning_output_tokens: 7,
    } }),
  ]);
  expect(result.usage).toEqual({
    input_tokens: 100, cached_input_tokens: 60,
    output_tokens: 20, reasoning_output_tokens: 7,
  });
  expect(result._north_usage).toEqual({
    provider: "openai", terminal_count: 1,
    scope: "codex_fresh_invocation_thread_cumulative",
    total_status: "exact", total_tokens: 120,
  });
  expect(result).not.toHaveProperty("duration_ms");
});

test("Codex preserves only present counters and zero completed terminals stays unknown", async () => {
  const incomplete = await resultFromScript([
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0 } }),
  ]);
  expect(incomplete.usage).toEqual({ input_tokens: 0 });
  expect(incomplete._north_usage).toMatchObject({
    terminal_count: 1, total_status: "unknown_incomplete_terminal",
  });
  expect(incomplete._north_usage).not.toHaveProperty("total_tokens");

  const absent = await resultFromScript([]);
  expect(absent.usage).toEqual({});
  expect(absent._north_usage).toMatchObject({ terminal_count: 0, total_status: "unknown_no_terminal" });
});

test("repeated Codex completed events use the last cumulative snapshot explicitly", async () => {
  const result = await resultFromScript([
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } }),
    JSON.stringify({ type: "turn.completed", usage: {
      input_tokens: 9, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1,
    } }),
  ]);
  expect(result.usage).toEqual({
    input_tokens: 9, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1,
  });
  expect(result._north_usage).toMatchObject({ terminal_count: 2, total_status: "exact", total_tokens: 11 });
});

test("Codex error events terminate and reap the child before propagating", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-child-"));
  temporary.push(directory);
  const command = join(directory, "fake-codex");
  const terminated = join(directory, "terminated");
  writeFileSync(command, `#!/usr/bin/env bash
trap 'printf terminated > "${terminated}"; exit 0' TERM
printf '%s\\n' '{"type":"error","message":"CODEX_EVENT_CANARY_DO_NOT_EXPOSE"}'
while true; do :; done
`);
  chmodSync(command, 0o700);
  process.env.NORTH_CODEX_BIN = command;
  const query = openaiProvider.query({ prompt: "x", options: {} as any });
  let caught: unknown;
  try { for await (const _ of query as AsyncIterable<any>) {} }
  catch (error) { caught = error; }
  expect((caught as Error).message).toBe("openai_provider_execution_failed");
  expect((caught as Error).message).not.toContain("CODEX_EVENT_CANARY_DO_NOT_EXPOSE");
  expect(existsSync(terminated)).toBe(true);
  expect(readFileSync(terminated, "utf8")).toBe("terminated");
});

test("cleanup failure never replaces the real Codex provider error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-cleanup-"));
  temporary.push(directory);
  const command = join(directory, "fake-codex");
  writeFileSync(command, `#!/usr/bin/env bash
printf '%s\\n' '{"type":"error","message":"CODEX_CLEANUP_CANARY_DO_NOT_EXPOSE"}'
exit 2
`);
  chmodSync(command, 0o700);
  process.env.NORTH_CODEX_BIN = command;
  const query = openaiProvider.query({ prompt: "x", options: {} as any });
  query.interrupt = async () => { throw new Error("cleanup failed"); };

  await expect(async () => { for await (const _ of query as AsyncIterable<any>) {} })
    .toThrow("openai_provider_execution_failed");
});

test("Codex nonzero exit redacts stderr and is never retry-safe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-reject-"));
  temporary.push(directory);
  const command = join(directory, "fake-codex");
  writeFileSync(command, "#!/usr/bin/env bash\nprintf 'CODEX_STDERR_CANARY_DO_NOT_EXPOSE' >&2\nexit 2\n");
  chmodSync(command, 0o700);
  process.env.NORTH_CODEX_BIN = command;
  const query = openaiProvider.query({ prompt: "x", options: {} as any });
  let caught: unknown;
  try { for await (const _ of query as AsyncIterable<any>) {} }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(ProviderRetrySafeError);
  expect((caught as Error).message).toBe("openai_provider_execution_failed");
  expect((caught as Error).message).not.toContain("CODEX_STDERR_CANARY_DO_NOT_EXPOSE");
});

test("a genuinely missing Codex executable is handled and retry-safe", async () => {
  process.env.NORTH_CODEX_BIN = join(tmpdir(), `north-no-such-codex-${process.pid}`);
  const query = openaiProvider.query({ prompt: "x", options: {} as any });
  let caught: unknown;
  try { for await (const _ of query as AsyncIterable<any>) {} }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ProviderRetrySafeError);
  expect((caught as Error).message).toBe("openai_provider_executable_unavailable_before_acceptance");
  expect((caught as Error).message).not.toContain(process.env.NORTH_CODEX_BIN!);
});

test("two same-provider targets execute concurrently in disjoint Codex homes", async () => {
  const home = mkdtempSync(join(tmpdir(), "north-codex-targets-"));
  temporary.push(home);
  process.env.HOME = home;
  mkdirSync(join(home, ".codex"), { recursive: true });
  const command = join(home, "fake-codex");
  writeFileSync(command, `#!/usr/bin/env bash
printf '%s' "$CODEX_HOME" > "$CODEX_HOME/execution-root"
printf '%s\n' "$@" > "$CODEX_HOME/argv"
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\n' "$CODEX_HOME"
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  chmodSync(command, 0o700);
  process.env.NORTH_CODEX_BIN = command;
  const targets = [
    { id: "codex-one", provider: "openai" as const, authMode: "isolated" as const, profile: "one" },
    { id: "codex-two", provider: "openai" as const, authMode: "isolated" as const, profile: "two" },
  ];
  const execute = async (target: typeof targets[number]) => {
    const messages: any[] = [];
    for await (const message of openaiProvider.query({ prompt: target.id, options: {} as any, target }) as AsyncIterable<any>)
      messages.push(message);
    return messages.at(-1);
  };
  const [first, second] = await Promise.all(targets.map(execute));
  const firstRoot = join(home, ".local/state/north/accounts/openai/one");
  const secondRoot = join(home, ".local/state/north/accounts/openai/two");
  expect(first.result).toBe(firstRoot);
  expect(second.result).toBe(secondRoot);
  expect(readFileSync(join(firstRoot, "execution-root"), "utf8")).toBe(firstRoot);
  expect(readFileSync(join(secondRoot, "execution-root"), "utf8")).toBe(secondRoot);
  for (const root of [firstRoot, secondRoot]) {
    const argv = readFileSync(join(root, "argv"), "utf8");
    expect(argv).toContain('cli_auth_credentials_store="file"');
    expect(argv).toContain('forced_login_method="chatgpt"');
    expect(argv).toContain('model_provider="openai"');
    expect(argv).toContain(`sqlite_home="${join(root, "sqlite")}"`);
  }
});

test("Codex capability flags are global-before-exec and fail closed before process spawn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-capabilities-"));
  temporary.push(directory);
  const command = join(directory, "fake-codex");
  const argvPath = join(directory, "argv");
  const taskPath = join(directory, "task");
  writeFileSync(command, `#!/usr/bin/env bash
printf '%s\n' "$@" > "${argvPath}"
cat > "${taskPath}"
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`);
  chmodSync(command, 0o700);
  process.env.NORTH_CODEX_BIN = command;
  const canonical = harnessOptions({
    self: "openai-authority-probe",
    provider: "openai",
    model: "gpt-5.6-terra",
    routingMetadata: applyGafferStaffing({ role: "scout" }),
    presenceRegistrar: false,
  }) as any;
  // A direct adapter caller cannot widen authority by omitting Claude-shaped
  // deny metadata: Codex derives both hard restrictions from capabilities.
  const options = {
    ...canonical,
    disallowedTools: canonical.disallowedTools.filter(
      (toolName: string) => ![
        "Agent", "Task", "Workflow", "mcp__north__spawn", "mcp__north__dispatch",
      ].includes(toolName),
    ),
  };
  // This case exercises CLI authority compilation, not coordinator transport;
  // carry a one-use admission receipt so the unit test stays hermetic.
  markExecutionAdmission("openai", options);
  for await (const _ of openaiProvider.query({ prompt: "x", options }) as AsyncIterable<any>) {}
  const argv = readFileSync(argvPath, "utf8").trim().split("\n");
  expect(argv.slice(0, 2)).toEqual(["--search", "exec"]);
  expect(argv).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--disable", "multi_agent"]));
  expect(argv).toEqual(expect.arrayContaining([
    "--strict-config",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--disable", "plugins",
    "--disable", "hooks",
    'project_root_markers=[".git"]',
    `projects.${JSON.stringify(northRoot)}.trust_level="untrusted"`,
    "project_doc_max_bytes=0",
    `mcp_servers.north.command=${JSON.stringify(canonical.mcpServers.north.command)}`,
    "mcp_servers.north.args=[]",
    "mcp_servers.north.enabled=true",
    "mcp_servers.north.required=true",
  ]));
  const developerInstructions = argv.find((argument) =>
    argument.startsWith("developer_instructions="))!;
  expect(developerInstructions).toContain("Gaffer role contract");
  expect(developerInstructions).toContain("Project instructions — Git root to cwd");
  expect(readFileSync(taskPath, "utf8")).toBe("x");
  expect(readFileSync(taskPath, "utf8")).not.toContain("Gaffer role contract");
  expect(argv).toContain(
    `mcp_servers.north.env={NORTH_BIN=${JSON.stringify(canonical.mcpServers.north.env.NORTH_BIN)},`
    + `AGENT_ID=${JSON.stringify(canonical.mcpServers.north.env.AGENT_ID)},`
    + `AGENT_TOPOLOGY=${JSON.stringify(canonical.mcpServers.north.env.AGENT_TOPOLOGY)},`
    + `NORTH_PORT=${JSON.stringify(canonical.mcpServers.north.env.NORTH_PORT)}}`,
  );
  expect(argv).toContain("mcp_servers.north.required=true");
  expect(argv.some((argument) => /mcp_servers\\.(linear|fram)/i.test(argument))).toBe(false);
  expect(argv).not.toContain('web_search="disabled"');
  const nestedCwd = join(northRoot, "sdk", "src");
  const nestedArgs = codexHarnessArguments({ ...canonical, cwd: nestedCwd });
  expect(nestedArgs).toContain(
    `projects.${JSON.stringify(northRoot)}.trust_level="untrusted"`,
  );
  expect(nestedArgs).not.toContain(
    `projects.${JSON.stringify(nestedCwd)}.trust_level="untrusted"`,
  );

  rmSync(argvPath, { force: true });
  const unsupported = openaiProvider.query({
    prompt: "x",
    options: { ...canonical, northCapabilities: ["filesystem.read"] } as any,
  });
  await expect(async () => {
    for await (const _ of unsupported as AsyncIterable<any>) {}
  }).toThrow("openai_adapter_cannot_enforce_gaffer_capabilities");
  expect(existsSync(argvPath)).toBe(false);

  const ambientTopology = {
    ...canonical,
    env: { ...canonical.env, AGENT_TOPOLOGY: undefined },
  };
  await expect(async () => {
    for await (const _ of openaiProvider.query({
      prompt: "x", options: ambientTopology,
    }) as AsyncIterable<any>) {}
  }).toThrow("openai_managed_identity_topology_contract_missing");
  expect(existsSync(argvPath)).toBe(false);

  const missingDeveloperInstructions = { ...canonical, systemPrompt: "" };
  await expect(async () => {
    for await (const _ of openaiProvider.query({
      prompt: "x", options: missingDeveloperInstructions,
    }) as AsyncIterable<any>) {}
  }).toThrow("openai_developer_instructions_contract_missing");
  expect(existsSync(argvPath)).toBe(false);

  markExecutionAdmission("openai", canonical);
  const admitted = openaiProvider.query({
    prompt: "must not spawn", options: canonical,
  });
  canonical.env.AGENT_TOPOLOGY = undefined;
  await expect(async () => {
    for await (const _ of admitted as AsyncIterable<any>) {}
  }).toThrow("openai_managed_identity_topology_contract_missing");
  expect(existsSync(argvPath)).toBe(false);

  const missingGlobalHome = mkdtempSync(join(tmpdir(), "north-openai-missing-global-"));
  temporary.push(missingGlobalHome);
  const missingGlobal = {
    ...harnessOptions({
      self: "openai-missing-global-proof",
      provider: "openai",
      routingMetadata: applyGafferStaffing({ role: "scout" }),
      presenceRegistrar: false,
    }) as any,
  };
  missingGlobal.env = { ...missingGlobal.env, HOME: missingGlobalHome };
  markExecutionAdmission("openai", missingGlobal);
  await expect(async () => {
    for await (const _ of openaiProvider.query({
      prompt: "must not spawn", options: missingGlobal,
    }) as AsyncIterable<any>) {}
  }).toThrow("openai_canonical_global_agents_unavailable");
  expect(existsSync(argvPath)).toBe(false);
});

test("selected Codex account bootstrap fails during admission before onRoute or provider spawn", async () => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end("{:version \"target-admission\"}\n"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const home = mkdtempSync(join(tmpdir(), "north-openai-target-admission-"));
  temporary.push(home);
  process.env.HOME = home;
  process.env.AGENT_LAWS = "on";
  process.env.GAFFER_HOME = realpathSync(join(northRoot, "../gaffer"));
  process.env.NORTH_PORT = String((server.address() as AddressInfo).port);
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "AGENTS.md"), "TARGET_ADMISSION_CANONICAL\n");

  const target = {
    id: "codex-broken-target",
    provider: "openai" as const,
    authMode: "isolated" as const,
    profile: "broken-target",
  };
  const targetRoot = join(home, ".local/state/north/accounts/openai/broken-target");
  mkdirSync(targetRoot, { recursive: true });
  writeFileSync(join(targetRoot, "AGENTS.md"), "TARGET_REPLACEMENT_MUST_FAIL\n");

  const marker = join(home, "provider-spawned");
  const command = join(home, "fake-codex");
  writeFileSync(command, `#!/usr/bin/env bash\nprintf spawned > "${marker}"\n`);
  chmodSync(command, 0o700);
  process.env.NORTH_CODEX_BIN = command;

  const options = harnessOptions({
    self: "openai-target-admission-proof",
    provider: "openai",
    cwd: northRoot,
    routingMetadata: applyGafferStaffing({ role: "scout" }),
    presenceRegistrar: false,
  });
  await expect(openaiProvider.admit!({
    options: {
      ...options,
      env: { ...options.env, AGENT_LAWS: "off" },
    },
    target: { ...target, authMode: "ambient" },
  })).rejects.toThrow("openai_agent_laws_opt_out_unenforceable");
  expect(existsSync(marker)).toBe(false);

  const decision = selectProviderFromAvailability(
    { provider: "openai", target: target.id },
    [{ targetId: target.id, provider: "openai", available: true, reason: "ready" }],
    {
      mode: "balanced",
      targets: [target],
      targetOrder: [target.id],
      providerOrder: ["openai"],
      pressures: { openai: "normal" },
    },
    "economy",
    "target-admission-proof",
    "low",
  );
  let routePublished = false;
  const query = routedQuery(
    decision,
    { prompt: "must not run", options },
    "economy",
    undefined,
    undefined,
    () => { routePublished = true; },
  );
  try {
    await expect(async () => {
      for await (const _ of query as AsyncIterable<any>) {}
    }).toThrow("openai_target_environment_invalid");
    expect(routePublished).toBe(false);
    expect(existsSync(marker)).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
