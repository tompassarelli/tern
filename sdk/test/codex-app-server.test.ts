import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  MANAGED_CODEX_DISABLED_FEATURES, MANAGED_CODEX_ENABLED_FEATURES,
  ManagedCodexAppServerRun, ManagedCodexPreThreadError,
  managedCodexAppServerLaunch,
} from "../src/providers/codex-app-server";
import { expectedManagedCodexHooks } from "../src/providers/codex-managed-hooks";
import type { OpenAIAuthoritySurface } from "../src/providers/authority";

function firstLine(stream: NodeJS.ReadableStream, label: string): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error(`${label} timed out`)), 2_000);
    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
    };
    const finish = (error?: Error, line?: string) => {
      cleanup();
      if (error) reject(error);
      else resolveLine(line!);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(undefined, buffer.slice(0, newline));
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error(`${label} ended before a frame`));
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

function supervisorFrame(line: string, digest?: string): Buffer {
  const payload = Buffer.from(line, "utf8");
  const checksum = digest ?? createHash("sha256").update(payload).digest("hex");
  return Buffer.concat([
    Buffer.from(`NORTH_CODEX_RPC 1 ${payload.byteLength} ${checksum}\n`, "ascii"),
    payload,
  ]);
}

function writeAtomicSupervisorFrame(path: string, line: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, supervisorFrame(line));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch { return; }
    await Bun.sleep(10);
  }
  throw new Error(`process ${pid} survived its teardown bound`);
}

function killProcess(pid: number | undefined, group = false): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return;
  if (group && process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tools = ["ready", "show", "tell"];
const surface = {
  provider: "openai",
  capabilities: ["read", "search", "write", "shell"],
  nativeMultiAgent: "disabled",
  liveInput: "unsupported",
  authoringHooks: "managed-only",
  northEnabledTools: tools,
  sandbox: "workspace-write",
  web: "disabled",
} as OpenAIAuthoritySurface;

function hookRows() {
  const rows: any[] = [];
  for (const [event, groups] of Object.entries(expectedManagedCodexHooks())) {
    for (const group of groups) for (const hook of group.hooks) rows.push({
      key: `${event}:${rows.length}`,
      eventName: event[0]!.toLowerCase() + event.slice(1),
      handlerType: "command",
      matcher: group.matcher ?? null,
      command: hook.command,
      timeoutSec: hook.timeout,
      statusMessage: null,
      sourcePath: "/etc/codex/hooks",
      source: "system",
      pluginId: null,
      displayOrder: rows.length,
      enabled: true,
      isManaged: true,
      currentHash: `sha256:${String(rows.length).padStart(64, "0")}`,
      trustStatus: "managed",
    });
  }
  return rows;
}

function turn(id: string, status: "inProgress" | "completed") {
  return {
    id, items: [], itemsView: "notLoaded", status, error: null,
    startedAt: 1, completedAt: status === "completed" ? 2 : null,
    durationMs: status === "completed" ? 1 : null,
  };
}

function hookRun(
  id: string,
  eventName: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  const completed = status !== "running";
  return {
    id, eventName, handlerType: "command", executionMode: "sync",
    scope: eventName === "sessionStart" ? "thread" : "turn",
    sourcePath: "/etc/codex/hooks", source: "system", displayOrder: 0,
    status, statusMessage: completed && status !== "completed" ? "fixture failure" : null,
    startedAt: 1, completedAt: completed ? 2 : null, durationMs: completed ? 1 : null,
    entries: completed && status !== "completed" ? [{ kind: "error", text: "fixture failure" }] : [],
    ...overrides,
  };
}

function setup(mode = "ok") {
  const root = mkdtempSync(join(tmpdir(), "north-managed-codex-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  const sqliteHome = join(codexHome, "sqlite");
  mkdirSync(sqliteHome, { recursive: true });
  writeFileSync(join(codexHome, "AGENTS.md"), "canonical global instructions\n");
  const executable = join(root, "codex");
  writeFileSync(executable, "#!/bin/sh\nexit 1\n");
  chmodSync(executable, 0o700);
  const cwd = realpathSync(join(import.meta.dir, "../.."));
  const requests: any[] = [];
  const features = Object.fromEntries([
    ...MANAGED_CODEX_ENABLED_FEATURES.map((name) => [name, true]),
    ...MANAGED_CODEX_DISABLED_FEATURES.map((name) => [name, false]),
  ]);
  const north = {
    command: "/nix/store/north/bin/north-mcp",
    args: [] as string[],
    env: { NORTH_BIN: "/nix/store/north/bin/north" },
  };
  const session = {
    cli_auth_credentials_store: "file",
    forced_login_method: "chatgpt",
    model_provider: "openai",
    sqlite_home: sqliteHome,
    project_root_markers: [".git"],
    projects: { [cwd]: { trust_level: "untrusted" } },
    project_doc_max_bytes: 0,
    mcp_servers: { north: {
      command: north.command, args: [], env: north.env,
      enabled: true, required: true, enabled_tools: tools,
    } },
    web_search: "disabled",
    features,
  };
  const baseConfig = {
    config: {
      features, mcp_servers: session.mcp_servers, projects: session.projects,
      project_doc_max_bytes: 0, model_provider: "openai",
      cli_auth_credentials_store: "file", forced_login_method: "chatgpt",
      sqlite_home: sqliteHome, apps: null, plugins: {}, marketplaces: {},
    },
    origins: {},
    layers: [
      { name: { type: "sessionFlags" }, version: `sha256:${"1".repeat(64)}`, config: session },
      { name: { type: "project", dotCodexFolder: join(cwd, ".codex") },
        version: `sha256:${"2".repeat(64)}`, config: {}, disabledReason: "untrusted" },
      { name: { type: "user", file: join(codexHome, "config.toml"), profile: null },
        version: `sha256:${"3".repeat(64)}`, config: {} },
      { name: { type: "system", file: "/etc/codex/config.toml" },
        version: `sha256:${"4".repeat(64)}`, config: {} },
    ],
  };
  let configReads = 0;
  let nextPid = 4100;
  const spawnProcess = (() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
      exitCode: number | null; signalCode: NodeJS.Signals | null;
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdin, stdout, stderr, stdio: [stdin, stdout, stderr],
      pid: nextPid++, exitCode: null, signalCode: null, killed: false,
    });
    const send = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
    const result = (request: any, value: unknown) => send({ id: request.id, result: value });
    const fail = (request: any) => send({
      id: request.id, error: { code: -32000, message: "fixture failure" },
    });
    const notify = (method: string, params: unknown) => send({ method, params });
    const threadId = "019f7abc-0000-7000-8000-000000000001";
    const turnId = "019f7abc-0000-7000-8000-000000000002";
    const item = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, ...extra });
    const lifecycle = (kind: "started" | "completed", value: any, at: number) => notify(
      `item/${kind}`,
      { item: value, threadId, turnId, [kind === "started" ? "startedAtMs" : "completedAtMs"]: at },
    );
    const emitHook = (event: string, terminalStatus = "completed", id = `hook-${event}`) => {
      let hookTurnId: string | null = event === "sessionStart" ? null : turnId;
      let scope = event === "sessionStart" ? "thread" : "turn";
      if (mode === "hook-session-turn" && event === "sessionStart") hookTurnId = turnId;
      if (mode === "hook-session-scope" && event === "sessionStart") scope = "turn";
      if (mode === "hook-tool-null-turn" && event === "preToolUse") hookTurnId = null;
      if (mode === "hook-tool-thread-scope" && event === "preToolUse") scope = "thread";
      notify("hook/started", { threadId, turnId: hookTurnId,
        run: hookRun(id, event, "running", { scope }) });
      if (mode === "hook-missing-completion" && event === "preToolUse") return;
      notify("hook/completed", { threadId, turnId: hookTurnId,
        run: hookRun(id, mode === "hook-completion-event-drift" && event === "preToolUse"
          ? "postToolUse" : event, terminalStatus, { scope }) });
      if (mode === "hook-duplicate-completion" && event === "preToolUse")
        notify("hook/completed", { threadId, turnId, run: hookRun(id, event, terminalStatus) });
    };
    const mcpServer = () => {
      const server: any = {
        name: "north",
        serverInfo: {
          name: "north", title: null, version: "0.1.0", description: null,
          icons: null, websiteUrl: null,
        },
        tools: Object.fromEntries(tools.map((name) => [name, {
          name, inputSchema: { type: "object" }, description: null, annotations: null,
        }])),
        resources: [], resourceTemplates: [], authStatus: "unsupported",
      };
      if (mode === "mcp-resource") server.resources = [{ uri: "file:///hostile" }];
      if (mode === "mcp-template") server.resourceTemplates = [{ uriTemplate: "file:///{x}" }];
      if (mode === "mcp-auth") server.authStatus = "oauth";
      if (mode === "mcp-server-info") server.serverInfo.version = "9.9.9";
      return server;
    };
    const startedThread = (request: any) => {
      const thread: any = {
        id: threadId, extra: null, sessionId: "019f7abc-0000-7000-8000-000000000000",
        forkedFromId: null, parentThreadId: null, preview: "", ephemeral: true,
        historyMode: "legacy", modelProvider: "openai", createdAt: 1, updatedAt: 1,
        recencyAt: 1, status: { type: "idle" }, path: null, cwd, cliVersion: "0.144.4",
        source: "appServer", threadSource: null, agentNickname: null, agentRole: null,
        gitInfo: null, name: null, turns: [],
      };
      const response: any = {
        thread, model: request.params.model, modelProvider: request.params.modelProvider,
        serviceTier: null, cwd, runtimeWorkspaceRoots: [],
        instructionSources: [join(codexHome, "AGENTS.md")], approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite", writableRoots: [], networkAccess: false,
          excludeTmpdirEnvVar: false, excludeSlashTmp: false,
        },
        activePermissionProfile: null, reasoningEffort: "high",
        multiAgentMode: "explicitRequestOnly",
      };
      const mutations: Record<string, () => void> = {
        "thread-model": () => { response.model = "wrong"; },
        "thread-provider": () => { response.modelProvider = "hostile"; },
        "thread-service-tier": () => { response.serviceTier = "priority"; },
        "thread-cwd": () => { response.cwd = root; },
        "thread-roots": () => { response.runtimeWorkspaceRoots = [root]; },
        "thread-sources": () => { response.instructionSources.push(join(cwd, "AGENTS.md")); },
        "thread-approval": () => { response.approvalPolicy = "on-request"; },
        "thread-reviewer": () => { response.approvalsReviewer = "auto_review"; },
        "thread-sandbox": () => { response.sandbox.networkAccess = true; },
        "thread-profile": () => { response.activePermissionProfile = { id: ":workspace", extends: null }; },
        "thread-effort": () => { response.reasoningEffort = "low"; },
        "thread-multi-agent": () => { response.multiAgentMode = "proactive"; },
        "thread-ephemeral": () => { thread.ephemeral = false; },
        "thread-object-provider": () => { thread.modelProvider = "hostile"; },
        "thread-object-cwd": () => { thread.cwd = root; },
        "thread-extra-authority": () => { response.futureAuthority = true; },
      };
      mutations[mode]?.();
      return response;
    };
    const emitRuntime = () => {
      const startedTurn: any = turn(turnId, "inProgress");
      if (mode === "notification-turn-extra") startedTurn.futureAuthority = true;
      notify("turn/started", { threadId, turn: startedTurn });
      emitHook("preToolUse", mode === "hook-pretool-failed" ? "failed"
        : mode === "hook-pretool-blocked" ? "blocked"
        : mode === "hook-pretool-stopped" ? "stopped" : "completed", "hook-pre");
      const command = item("command-1", "commandExecution");
      lifecycle("started", command, 10);
      notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: command.id, delta: "ok\n" });
      notify("item/commandExecution/terminalInteraction", {
        threadId, turnId, itemId: command.id, processId: "process-1", stdin: "",
      });
      lifecycle("completed", command, 11);
      const file = item("file-1", "fileChange");
      lifecycle("started", file, 12);
      notify("item/fileChange/outputDelta", { threadId, turnId, itemId: file.id, delta: "patched" });
      notify("item/fileChange/patchUpdated", { threadId, turnId, itemId: file.id, changes: [] });
      lifecycle("completed", file, 13);
      const mcp = item("mcp-1", "mcpToolCall");
      lifecycle("started", mcp, 14);
      notify("item/mcpToolCall/progress", { threadId, turnId, itemId: mcp.id, message: "working" });
      lifecycle("completed", mcp, 15);
      const reasoning = item("reasoning-1", "reasoning");
      lifecycle("started", reasoning, 16);
      notify("item/reasoning/summaryPartAdded", { threadId, turnId, itemId: reasoning.id, summaryIndex: 0 });
      notify("item/reasoning/summaryTextDelta", {
        threadId, turnId, itemId: reasoning.id, delta: "summary", summaryIndex: 0,
      });
      notify("item/reasoning/textDelta", {
        threadId, turnId, itemId: reasoning.id, delta: "reasoning", contentIndex: 0,
      });
      lifecycle("completed", reasoning, 17);
      notify("item/plan/delta", { threadId, turnId, itemId: "plan-1", delta: "plan" });
      notify("turn/plan/updated", {
        threadId, turnId, explanation: null, plan: [{ step: "work", status: "completed" }],
      });
      notify("turn/diff/updated", { threadId, turnId, diff: "diff --git a/a b/a" });
      const answer = item("answer-1", "agentMessage", { text: "managed answer" });
      notify("item/agentMessage/delta", { threadId, turnId, itemId: answer.id, delta: "managed answer" });
      lifecycle("completed", answer, 18);
      emitHook("postToolUse", mode === "hook-posttool-stopped" ? "stopped"
        : mode === "hook-posttool-failed" ? "failed" : "completed", "hook-post");
      notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: {
        totalTokens: 12, inputTokens: 9, cachedInputTokens: 4,
        outputTokens: 3, reasoningOutputTokens: 1,
      } } });
      if (mode === "notification-wrong-thread")
        notify("turn/diff/updated", { threadId: "wrong", turnId, diff: "x" });
      if (mode === "notification-malformed")
        notify("item/mcpToolCall/progress", { threadId, turnId, itemId: "mcp-1", message: 7 });
      const completedTurn: any = turn(turnId, "completed");
      if (mode === "notification-terminal-error") completedTurn.error = { message: "hidden failure" };
      notify("turn/completed", { threadId, turn: completedTurn });
    };
    const handle = (request: any) => {
      requests.push(structuredClone(request));
      if (request.method === "initialized") return;
      if (request.method === "initialize") {
        const userAgent = mode === "runtime-version" ? "north/0.145.0 (test)"
          : mode === "runtime-version-prefix" ? "hostile/north/0.144.4 (test)"
          : mode === "runtime-version-suffix" ? "north/0.144.4-hostile (test)"
          : "north/0.144.4 (test)";
        result(request, {
          userAgent,
          codexHome, platformFamily: "unix", platformOs: "linux",
        });
        const remote: any = {
          status: "disabled", serverName: "fixture", installationId: "fixture-installation",
          environmentId: null,
        };
        if (mode === "remote-enabled") remote.status = "enabled";
        if (mode === "remote-extra-field") remote.futureAuthority = true;
        if (mode === "remote-missing-installation") delete remote.installationId;
        notify("remoteControl/status/changed", remote);
        if (mode === "notification-unknown-prethread")
          notify("future/authority", { enabled: true });
        if (mode === "server-request-prethread")
          send({ id: "provider-request", method: "future/request", params: {} });
        notify("account/rateLimits/updated", { rateLimits: {
          limitId: null, limitName: null, primary: null, secondary: null, credits: null,
          individualLimit: null, planType: null, rateLimitReachedType: null,
        } });
        return;
      }
      if (request.method === "account/read") {
        result(request, { account: { type: "chatgpt", email: "fixture@example.test", planType: "pro" },
          requiresOpenaiAuth: true });
        return;
      }
      if (request.method === "config/read") {
        configReads += 1;
        const current = structuredClone(baseConfig);
        if (mode === "project-enabled") {
          current.layers[1].config = { mcp_servers: { hostile: { command: "hostile" } } };
          delete (current.layers[1] as any).disabledReason;
        }
        if (mode === "feature-default-enabled") current.config.features.browser_use = true;
        if (mode === "feature-omitted") delete current.config.features.browser_use;
        if (mode === "fingerprint-mutation" && configReads > 1)
          current.layers[0].version = `sha256:${"f".repeat(64)}`;
        if (mode === "terminal-notification-unknown" && configReads > 2)
          notify("future/authority", { enabled: true });
        result(request, current);
        return;
      }
      if (request.method === "configRequirements/read") {
        const failureMode = mode === "hook-failure-continue" ? "continue"
          : mode === "hook-failure-unrecognized" ? "future-mode"
          : "block";
        result(request, { requirements: {
          allowManagedHooksOnly: true, allowRemoteControl: false,
          ...(mode === "hook-failure-unattested" ? {} : { managedHookFailureMode: failureMode }),
          featureRequirements: { hooks: true }, hooks: { managedDir: "/etc/codex/hooks" },
        } });
        return;
      }
      if (request.method === "hooks/list") {
        result(request, { data: [{ cwd: request.params.cwds[0], hooks: hookRows(),
          warnings: mode === "hook-warning" ? ["fixture warning"] : [], errors: [] }] });
        return;
      }
      if (request.method === "mcpServerStatus/list") {
        expect(request.params.detail).toBe("full");
        if (!request.params.cursor) result(request, { data: [], nextCursor: "north-page" });
        else result(request, { data: [mcpServer()], nextCursor: null });
        return;
      }
      if (request.method === "thread/start") {
        if (mode === "thread-failure") { fail(request); return; }
        result(request, startedThread(request));
        const notificationThread = startedThread(request).thread;
        if (mode === "notification-thread-cwd") notificationThread.cwd = root;
        notify("thread/started", { thread: notificationThread });
        emitHook("sessionStart", mode === "hook-session-failed" ? "failed"
          : mode === "hook-session-stopped" ? "stopped" : "completed", "hook-session");
        return;
      }
      if (request.method === "turn/start") {
        result(request, { turn: turn(turnId, "inProgress") });
        queueMicrotask(emitRuntime);
        return;
      }
      fail(request);
    };
    let buffer = "";
    stdin.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line) handle(JSON.parse(line));
      }
    });
    let exited = false;
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      child.exitCode = code;
      child.signalCode = signal;
      stdout.end();
      stderr.end();
      queueMicrotask(() => { child.emit("exit", code, signal); child.emit("close", code, signal); });
    };
    stdin.on("finish", () => exit(0, null));
    (child as any).kill = (signal: NodeJS.Signals = "SIGTERM") => { exit(null, signal); return true; };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as any;
  const env = { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome };
  const options = {
    command: executable,
    testExpectedExecutable: executable,
    useSupervisor: false,
    spawnProcess,
    env,
    cwd,
    prompt: "perform managed work",
    model: "gpt-fixture-exact",
    effort: "high",
    developerInstructions: "bounded developer contract",
    surface,
    north,
    timeoutMs: 500,
  };
  return { root, codexHome, executable, requests, options };
}

test("one app-server proves authority and executes realistic shell/file/MCP traffic", async () => {
  const { options, requests } = setup();
  const result = await new ManagedCodexAppServerRun(options).execute();
  expect(result).toEqual({
    text: "managed answer",
    usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 },
  });
  expect(requests.filter(({ method }) => method === "initialize")).toHaveLength(1);
  expect(requests.filter(({ method }) => method === "config/read")).toHaveLength(3);
  expect(requests.filter(({ method }) => method === "hooks/list")).toHaveLength(2);
  expect(requests.filter(({ method }) => method === "mcpServerStatus/list")).toHaveLength(4);
  const thread = requests.find(({ method }) => method === "thread/start");
  const turnRequest = requests.find(({ method }) => method === "turn/start");
  expect(thread.params).toEqual({
    model: "gpt-fixture-exact", modelProvider: "openai", approvalPolicy: "never",
    approvalsReviewer: "user", sandbox: "workspace-write",
    config: { model_reasoning_effort: "high" },
    developerInstructions: "bounded developer contract", ephemeral: true,
  });
  expect(turnRequest.params).toEqual({
    threadId: "019f7abc-0000-7000-8000-000000000001",
    input: [{ type: "text", text: "perform managed work" }], effort: "high",
  });
});

test("the production duplex supervisor carries RPC and bounds host-EOF cleanup", async () => {
  const supervisor = join(import.meta.dir, "../src/providers/codex-supervisor.ts");
  const fixture = join(import.meta.dir, "fixtures/fake-codex-app-server.mjs");
  const controlRoot = mkdtempSync(join(tmpdir(), "north-codex-control-test-"));
  roots.push(controlRoot);
  const child = spawn(process.execPath, [
    supervisor, "--duplex", controlRoot, process.execPath, fixture,
  ], {
    env: {
      ...process.env,
      NORTH_MKFIFO_BIN: realpathSync(Bun.which("mkfifo")!),
      FAKE_CODEX_RESPONSES: JSON.stringify({ probe: { transport: "exact" } }),
    },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const status = (child.stdio as any[])[3] as NodeJS.ReadableStream;
  child.stderr.resume();
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  try {
    expect(await firstLine(status, "Codex supervisor start receipt")).toBe("STARTED");
    const firstTemporary = join(controlRoot, ".000000000001.test.tmp");
    writeAtomicSupervisorFrame(
      firstTemporary, `${JSON.stringify({ id: 1, method: "probe", params: {} })}\n`,
    );
    const secondTemporary = join(controlRoot, ".000000000002.test.tmp");
    writeAtomicSupervisorFrame(
      secondTemporary, `${JSON.stringify({ id: 2, method: "probe", params: {} })}\n`,
    );
    renameSync(secondTemporary, join(controlRoot, "000000000002.req"));
    await Bun.sleep(40);
    expect(output).toBe("");
    renameSync(firstTemporary, join(controlRoot, "000000000001.req"));
    const deadline = Date.now() + 2_000;
    while (output.trim().split("\n").filter(Boolean).length < 2 && Date.now() < deadline)
      await Bun.sleep(10);
    expect(output.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { id: 1, result: { transport: "exact" } },
      { id: 2, result: { transport: "exact" } },
    ]);
  } finally {
    child.stdin.end();
    const closed = await Promise.race([
      new Promise<boolean>((resolveClose) => child.once("close", () => resolveClose(true))),
      new Promise<boolean>((resolveClose) => setTimeout(() => resolveClose(false), 3_000)),
    ]);
    if (!closed) child.kill("SIGKILL");
    expect(closed).toBe(true);
  }
  expect(existsSync(controlRoot)).toBe(false);
}, 5_000);

test("the one-shot supervisor transfers an exact bounded prompt without argv or env exposure", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "north-codex-oneshot-test-"));
  roots.push(root);
  const controlRoot = mkdtempSync(join(root, "control-"));
  const supervisor = join(import.meta.dir, "../src/providers/codex-supervisor.ts");
  const provider = join(root, "provider.mjs");
  const prompt = "exact prompt\nwith unicode 🧭 and a NUL \u0000 tail";
  writeFileSync(provider, `
const canary = ${JSON.stringify(prompt)};
if (process.argv.some((value) => value.includes(canary))
    || Object.values(process.env).some((value) => value?.includes(canary))) process.exit(41);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(Buffer.concat(chunks));
`);
  const child = spawn(process.execPath, [
    supervisor, "--oneshot-spool", controlRoot, process.execPath, provider,
  ], {
    env: { ...process.env, NORTH_MKFIFO_BIN: realpathSync(Bun.which("mkfifo")!) },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const status = (child.stdio as any[])[3] as NodeJS.ReadableStream;
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  child.stderr.resume();
  try {
    expect(await firstLine(status, "Codex one-shot start receipt")).toBe("STARTED");
    const temporary = join(controlRoot, ".000000000001.test.tmp");
    writeAtomicSupervisorFrame(temporary, prompt);
    renameSync(temporary, join(controlRoot, "000000000001.req"));
    const closed = await Promise.race([
      new Promise<boolean>((resolveClose) => child.once("close", () => resolveClose(true))),
      new Promise<boolean>((resolveClose) => setTimeout(() => resolveClose(false), 3_000)),
    ]);
    expect(closed).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(Buffer.concat(output).toString("utf8")).toBe(prompt);
    expect(existsSync(controlRoot)).toBe(false);
  } finally {
    try { child.stdin.end(); } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}, 5_000);

test("the duplex supervisor rejects symlinked, oversized, corrupt, and over-permissive frames", async () => {
  const supervisor = join(import.meta.dir, "../src/providers/codex-supervisor.ts");
  const fixture = join(import.meta.dir, "fixtures/fake-codex-app-server.mjs");
  for (const mode of ["symlink", "oversized", "corrupt", "permissions"] as const) {
    const controlRoot = mkdtempSync(join(tmpdir(), "north-codex-control-invalid-"));
    roots.push(controlRoot);
    const child = spawn(process.execPath, [
      supervisor, "--duplex", controlRoot, process.execPath, fixture,
    ], {
      env: {
        ...process.env,
        NORTH_MKFIFO_BIN: realpathSync(Bun.which("mkfifo")!),
        FAKE_CODEX_RESPONSES: JSON.stringify({ probe: { transport: "must-not-run" } }),
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    child.stdout.resume();
    child.stderr.resume();
    const closed = new Promise<boolean>((resolveClose) => child.once("close", () => resolveClose(true)));
    try {
      const status = (child.stdio as any[])[3] as NodeJS.ReadableStream;
      expect(await firstLine(status, `Codex ${mode} start receipt`)).toBe("STARTED");
      const request = join(controlRoot, "000000000001.req");
      if (mode === "symlink") {
        writeFileSync(join(controlRoot, "target"), "hostile\n", { mode: 0o600 });
        symlinkSync("target", request);
      } else if (mode === "oversized") {
        writeFileSync(request, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
      } else if (mode === "corrupt") {
        writeFileSync(request, supervisorFrame("hostile\n", "0".repeat(64)), { mode: 0o600 });
      } else {
        writeFileSync(request, "hostile\n", { mode: 0o644 });
      }
      const didClose = await Promise.race([
        closed,
        new Promise<boolean>((resolveClose) => setTimeout(() => resolveClose(false), 3_000)),
      ]);
      expect(didClose).toBe(true);
      expect(existsSync(controlRoot)).toBe(false);
    } finally {
      try { child.stdin.end(); } catch {}
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
}, 12_000);

test("kernel host EOF reaps a non-reading provider group within the derived bound", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "north-codex-host-death-"));
  roots.push(root);
  const controlRoot = mkdtempSync(join(root, "control-"));
  const supervisor = join(import.meta.dir, "../src/providers/codex-supervisor.ts");
  const provider = join(root, "provider.mjs");
  const hostScript = join(root, "host.mjs");
  const supervisorPidPath = join(root, "supervisor.pid");
  const providerPidPath = join(root, "provider.pid");
  const descendantPidPath = join(root, "descendant.pid");
  writeFileSync(provider, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(providerPidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
const descendant = spawn(process.execPath, ["-e",
  'process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000)'], { stdio: "ignore" });
writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
setInterval(() => {}, 1000);
`);
  writeFileSync(hostScript, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const supervisor = spawn(process.execPath, ${JSON.stringify([
    supervisor, "--duplex", controlRoot, process.execPath, provider,
  ])}, { env: process.env, stdio: ["pipe", "ignore", "ignore", "ignore"] });
writeFileSync(${JSON.stringify(supervisorPidPath)}, String(supervisor.pid));
setInterval(() => {}, 1000);
`);
  const host = spawn(process.execPath, [hostScript], {
    env: { ...process.env, NORTH_MKFIFO_BIN: realpathSync(Bun.which("mkfifo")!) },
    stdio: "ignore",
  });
  let supervisorPid: number | undefined;
  let providerPid: number | undefined;
  let descendantPid: number | undefined;
  try {
    await Promise.all([
      waitForFile(supervisorPidPath), waitForFile(providerPidPath), waitForFile(descendantPidPath),
    ]);
    supervisorPid = Number(readFileSync(supervisorPidPath, "utf8"));
    providerPid = Number(readFileSync(providerPidPath, "utf8"));
    descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    const temporary = join(controlRoot, ".000000000001.test.tmp");
    writeAtomicSupervisorFrame(temporary, "x".repeat(1024 * 1024));
    renameSync(temporary, join(controlRoot, "000000000001.req"));
    await Bun.sleep(50);

    const startedAt = Date.now();
    host.kill("SIGKILL");
    await new Promise<void>((resolveClose) => host.once("close", () => resolveClose()));
    await Promise.all([
      waitForProcessGone(supervisorPid, 3_000),
      waitForProcessGone(providerPid, 3_000),
      waitForProcessGone(descendantPid, 3_000),
    ]);
    expect(Date.now() - startedAt).toBeLessThan(2_750);
    expect(existsSync(controlRoot)).toBe(false);
  } finally {
    killProcess(host.pid);
    killProcess(supervisorPid);
    killProcess(providerPid, true);
    killProcess(descendantPid);
  }
}, 8_000);

test("spooled supervisors require the wrapper-sealed Nix mkfifo binary", async () => {
  const supervisor = join(import.meta.dir, "../src/providers/codex-supervisor.ts");
  const fixture = join(import.meta.dir, "fixtures/fake-codex-app-server.mjs");
  const inheritedStatusWrapper = join(
    import.meta.dir, "fixtures/run-with-inherited-status-fd.mjs",
  );
  for (const inputMode of ["--duplex", "--oneshot-spool"]) {
    for (const mkfifo of [undefined, fixture]) {
      const controlRoot = mkdtempSync(join(tmpdir(), "north-codex-control-mkfifo-"));
      roots.push(controlRoot);
      const env = { ...process.env, NORTH_MKFIFO_BIN: mkfifo };
      if (mkfifo === undefined) delete env.NORTH_MKFIFO_BIN;
      const child = spawn(process.execPath, [
        inheritedStatusWrapper,
        supervisor, inputMode, controlRoot, process.execPath, fixture,
      ], { env, stdio: ["pipe", "pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
      child.stdout.resume();
      child.stderr.resume();
      const status = (child.stdio as any[])[3] as NodeJS.ReadableStream;
      expect(await firstLine(status, "Codex sealed mkfifo rejection")).toBe("UNAVAILABLE");
      await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
      expect(existsSync(controlRoot)).toBe(false);
    }
  }
});

test("pre-thread authority mutants fail before thread/start", async () => {
  const modes = [
    "runtime-version", "runtime-version-prefix", "runtime-version-suffix",
    "project-enabled", "hook-warning", "hook-failure-unattested",
    "hook-failure-continue", "hook-failure-unrecognized",
    "feature-default-enabled", "feature-omitted", "mcp-resource", "mcp-template", "mcp-auth",
    "mcp-server-info", "remote-enabled", "remote-extra-field", "remote-missing-installation",
    "notification-unknown-prethread", "server-request-prethread",
  ];
  for (const mode of modes) {
    const { options, requests } = setup(mode);
    await expect(new ManagedCodexAppServerRun(options).execute())
      .rejects.toBeInstanceOf(ManagedCodexPreThreadError);
    expect(requests.some(({ method }) => method === "thread/start")).toBe(false);
  }
});

test("every security-relevant thread/start response field is attested independently", async () => {
  const modes = [
    "thread-model", "thread-provider", "thread-service-tier", "thread-cwd", "thread-roots",
    "thread-sources", "thread-approval", "thread-reviewer", "thread-sandbox", "thread-profile",
    "thread-effort", "thread-multi-agent", "thread-ephemeral", "thread-object-provider",
    "thread-object-cwd", "thread-extra-authority",
  ];
  for (const mode of modes) {
    const { options, requests } = setup(mode);
    let caught: unknown;
    try { await new ManagedCodexAppServerRun(options).execute(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ManagedCodexPreThreadError);
    expect((caught as Error).message).toBe("openai_provider_execution_failed");
    expect(requests.some(({ method }) => method === "turn/start")).toBe(false);
  }
});

test("post-thread drift, rejection, malformed traffic, and hook failures are never retry-safe", async () => {
  const modes = [
    "fingerprint-mutation", "thread-failure", "notification-wrong-thread", "notification-malformed",
    "notification-thread-cwd", "notification-turn-extra", "notification-terminal-error",
    "hook-session-failed", "hook-session-stopped", "hook-pretool-failed", "hook-pretool-blocked",
    "hook-pretool-stopped", "hook-posttool-stopped", "hook-posttool-failed",
    "hook-missing-completion", "hook-duplicate-completion", "hook-session-turn",
    "hook-session-scope", "hook-tool-null-turn", "hook-tool-thread-scope",
    "hook-completion-event-drift", "terminal-notification-unknown",
  ];
  for (const mode of modes) {
    const { options } = setup(mode);
    let caught: unknown;
    try { await new ManagedCodexAppServerRun(options).execute(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ManagedCodexPreThreadError);
    expect((caught as Error).message).toBe("openai_provider_execution_failed");
  }
});

test("filesystem authority and executable provenance fail before thread/start", async () => {
  {
    const { options, codexHome } = setup();
    writeFileSync(join(codexHome, "config.toml"), "model = 'hostile'\n");
    expect(() => managedCodexAppServerLaunch(options))
      .toThrow("openai_codex_authority_filesystem_invalid");
  }
  {
    const { options, root } = setup();
    const other = join(root, "other-codex");
    writeFileSync(other, "#!/bin/sh\nexit 1\n");
    chmodSync(other, 0o700);
    options.command = other;
    expect(() => managedCodexAppServerLaunch(options))
      .toThrow("openai_codex_authority_filesystem_invalid");
  }
});
