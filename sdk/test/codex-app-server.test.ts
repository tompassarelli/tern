import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
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
import { codexSupervisorStatusLine } from "../src/providers/codex-supervisor-protocol";
import type { OpenAIAuthoritySurface } from "../src/providers/authority";
import { providerSessionKey, providerTurnKey } from "../src/providers/provider-join";

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
    const turnIds = [
      "019f7abc-0000-7000-8000-000000000002",
      "019f7abc-0000-7000-8000-000000000003",
      "019f7abc-0000-7000-8000-000000000004",
    ];
    let turnStarts = 0;
    // The live turn id for the turn currently being served. Continuation turns
    // reuse the same thread but MUST carry a distinct turn id.
    let turnId = turnIds[0]!;
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
      const mcp = item("mcp-1", "mcpToolCall", {
        server: "north", tool: "tell",
        arguments: { secret: "CANARY-private-argument" },
        result: "CANARY-private-result",
      });
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
        if (mode === "config-warning" || mode === "config-warning-drift") {
          const expectedSummary = "Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load.\n"
            + `    1. ${cwd}/.codex\n`
            + `       ${cwd} is marked as untrusted in ${codexHome}/config.toml. To load project-local config, hooks, and exec policies, mark it trusted.\n`;
          notify("configWarning", {
            summary: mode === "config-warning-drift" ? `${expectedSummary}drift` : expectedSummary,
            details: null,
          });
        }
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
        turnId = turnIds[Math.min(turnStarts, turnIds.length - 1)]!;
        turnStarts += 1;
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
  const run = new ManagedCodexAppServerRun(options);
  const result = await run.execute();
  expect(result).toEqual({
    text: "managed answer",
    usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 },
    providerJoin: {
      version: "north-provider-join:v1",
      sessionKey: providerSessionKey("019f7abc-0000-7000-8000-000000000001"),
      turnKeys: [providerTurnKey("openai", "019f7abc-0000-7000-8000-000000000002")],
      sessionPersistence: "ephemeral",
      coverage: "exact",
    },
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
  expect(run.mcpActivity()).toEqual({
    source: "codex-app-server:item-completed", coverage: "exact", totalCalls: 1,
    tools: [{ server: "north", tool: "tell", count: 1 }],
  });
  expect(JSON.stringify(run.mcpActivity())).not.toContain("CANARY");
});

test("a later North frame drives a same-thread continuation turn under re-proven authority", async () => {
  const { options, requests } = setup();
  const reduction = "reconcile the settled child lanes into the parent thread";
  const later: Array<string | undefined> = [reduction];
  const run = new ManagedCodexAppServerRun(options);
  const settlements: Array<{ text: string; usage: unknown }> = [];
  // First frame is the launch prompt; `nextInput` supplies exactly one later
  // frame, then settles the session.
  for await (const turnResult of run.session(async () => later.shift())) {
    settlements.push(turnResult);
  }
  const expected = (turnId: string) => ({
    text: "managed answer",
    usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 },
    providerJoin: {
      version: "north-provider-join:v1",
      sessionKey: providerSessionKey("019f7abc-0000-7000-8000-000000000001"),
      turnKeys: [providerTurnKey("openai", turnId)],
      sessionPersistence: "ephemeral",
      coverage: "exact",
    },
  });
  // One terminal result per consumed frame.
  expect(settlements).toEqual([
    expected("019f7abc-0000-7000-8000-000000000002"),
    expected("019f7abc-0000-7000-8000-000000000003"),
  ]);
  expect(run.mcpActivity()?.totalCalls).toBe(2);

  // Exactly one provider thread, two turns bound to it.
  expect(requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
  const turnStarts = requests.filter(({ method }) => method === "turn/start");
  expect(turnStarts).toHaveLength(2);
  expect(turnStarts.map((request) => request.params.threadId)).toEqual([
    "019f7abc-0000-7000-8000-000000000001",
    "019f7abc-0000-7000-8000-000000000001",
  ]);
  // The continuation turn consumed the LATER North frame, not a replay of the
  // launch prompt.
  expect(turnStarts[0].params.input).toEqual([{ type: "text", text: "perform managed work" }]);
  expect(turnStarts[1].params.input).toEqual([{ type: "text", text: reduction }]);

  // The session initializes once but re-proves the exact authority surface on
  // every turn: web-disabled config, hook set, and MCP tool grant are all
  // re-read pre-turn and the config fingerprint is re-attested post-turn.
  expect(requests.filter(({ method }) => method === "initialize")).toHaveLength(1);
  expect(requests.filter(({ method }) => method === "config/read")).toHaveLength(5);
  expect(requests.filter(({ method }) => method === "hooks/list")).toHaveLength(3);
  expect(requests.filter(({ method }) => method === "mcpServerStatus/list")).toHaveLength(6);
});

test("a continuation turn that widens config authority fails closed", async () => {
  // `fingerprint-mutation` mutates the sessionFlags layer version on the 2nd+
  // config/read. The launch turn's pre-turn re-read (configReads>1) already
  // trips it, so the very first turn fails and no continuation is served.
  const { options, requests } = setup("fingerprint-mutation");
  const run = new ManagedCodexAppServerRun(options);
  let caught: unknown;
  try {
    for await (const _ of run.session(async () => "a later frame")) { /* unreachable */ }
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe("openai_provider_execution_failed");
  // The authority regression is caught before a second turn can start.
  expect(requests.filter(({ method }) => method === "turn/start").length).toBeLessThanOrEqual(1);
});

function supervisedStatusChild(drive: (stderr: PassThrough) => void): any {
  return (() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
      exitCode: number | null; signalCode: NodeJS.Signals | null;
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdin, stdout, stderr, stdio: [stdin, stdout, stderr],
      pid: 5100, exitCode: null, signalCode: null, killed: false,
    });
    let exited = false;
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      child.exitCode = code;
      child.signalCode = signal;
      try { stdout.end(); } catch { /* already closed */ }
      queueMicrotask(() => { child.emit("exit", code, signal); child.emit("close", code, signal); });
    };
    stdin.on("finish", () => exit(null, "SIGTERM"));
    (child as any).kill = (signal: NodeJS.Signals = "SIGTERM") => { exit(null, signal); return true; };
    queueMicrotask(() => { child.emit("spawn"); drive(stderr); });
    return child;
  }) as any;
}

test("a supervised launch whose status channel closes before STARTED fails preflight loud", async () => {
  const { options } = setup();
  const run = new ManagedCodexAppServerRun({
    ...options,
    useSupervisor: true,
    spawnProcess: supervisedStatusChild((stderr) => { stderr.end(); }),
  });
  let caught: unknown;
  try { await run.execute(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ManagedCodexPreThreadError);
  expect((caught as Error).message).toBe("openai_codex_authority_preflight_failed");
  expect((caught as Error).cause).toBeInstanceOf(Error);
  expect(((caught as Error).cause as Error).message)
    .toBe("Codex supervisor closed before authority preflight");
});

test("a supervised launch reads UNAVAILABLE off the supervisor stderr status channel", async () => {
  const { options } = setup();
  const run = new ManagedCodexAppServerRun({
    ...options,
    useSupervisor: true,
    spawnProcess: supervisedStatusChild((stderr) => {
      stderr.write(`${codexSupervisorStatusLine("UNAVAILABLE")}\n`);
    }),
  });
  let caught: unknown;
  try { await run.execute(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ManagedCodexPreThreadError);
  expect((caught as Error).message).toBe("openai_codex_authority_preflight_failed");
  expect(((caught as Error).cause as Error).message).toBe("Codex executable unavailable");
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
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const status = child.stderr;
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  try {
    expect(await firstLine(status, "Codex supervisor start receipt"))
      .toBe(codexSupervisorStatusLine("STARTED"));
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
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const status = child.stderr;
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  try {
    expect(await firstLine(status, "Codex one-shot start receipt"))
      .toBe(codexSupervisorStatusLine("STARTED"));
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
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    child.stdout.resume();
    const closed = new Promise<boolean>((resolveClose) => child.once("close", () => resolveClose(true)));
    try {
      const status = child.stderr;
      expect(await firstLine(status, `Codex ${mode} start receipt`))
        .toBe(codexSupervisorStatusLine("STARTED"));
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
  ])}, { env: process.env, stdio: ["pipe", "ignore", "ignore"] });
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

test("spooled supervisors require the wrapper-sealed Nix mkfifo binary", () => {
  const supervisor = join(import.meta.dir, "../src/providers/codex-supervisor.ts");
  const fixture = join(import.meta.dir, "fixtures/fake-codex-app-server.mjs");
  for (const inputMode of ["--duplex", "--oneshot-spool"]) {
    for (const mkfifo of [undefined, fixture]) {
      const controlRoot = mkdtempSync(join(tmpdir(), "north-codex-control-mkfifo-"));
      roots.push(controlRoot);
      const env = { ...process.env, NORTH_MKFIFO_BIN: mkfifo };
      if (mkfifo === undefined) delete env.NORTH_MKFIFO_BIN;
      const child = spawnSync(process.execPath, [
        supervisor, inputMode, controlRoot, process.execPath, fixture,
      ], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 2_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.stderr.trim()).toBe(codexSupervisorStatusLine("UNAVAILABLE"));
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
    "notification-unknown-prethread", "server-request-prethread", "config-warning-drift",
  ];
  for (const mode of modes) {
    const { options, requests } = setup(mode);
    await expect(new ManagedCodexAppServerRun(options).execute())
      .rejects.toBeInstanceOf(ManagedCodexPreThreadError);
    expect(requests.some(({ method }) => method === "thread/start")).toBe(false);
  }
});

test("the exact untrusted-project config warning is accepted before thread/start", async () => {
  const { options, requests } = setup("config-warning");
  await expect(new ManagedCodexAppServerRun(options).execute()).resolves.toBeDefined();
  expect(requests.some(({ method }) => method === "thread/start")).toBe(true);
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

function expectLaunchPreflightFailure(
  options: ReturnType<typeof setup>["options"],
  code: string,
): ManagedCodexPreThreadError {
  const remoteControlBefore = options.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED;
  let caught: unknown;
  try { managedCodexAppServerLaunch(options); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ManagedCodexPreThreadError);
  expect((caught as Error).message).toBe(code);
  expect(options.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED)
    .toBe(remoteControlBefore);
  return caught as ManagedCodexPreThreadError;
}

test("every launch preflight cause has stable diagnosis and fails before process authority", () => {
  for (const missing of ["CODEX_HOME", "CODEX_SQLITE_HOME"] as const) {
    const { options, requests } = setup();
    delete options.env[missing];
    const error = expectLaunchPreflightFailure(options, "openai_target_state_roots_missing");
    expect(error.cause).toBeUndefined();
    expect(requests).toEqual([]);
  }

  {
    const { options, root, requests } = setup();
    options.env.CODEX_HOME = join(root, "missing-codex-home");
    const error = expectLaunchPreflightFailure(options, "openai_codex_state_root_unresolvable");
    expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(requests).toEqual([]);
  }
  {
    const { options, codexHome, requests } = setup();
    rmSync(join(codexHome, "sqlite"), { recursive: true });
    const error = expectLaunchPreflightFailure(options, "openai_codex_state_root_unresolvable");
    expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(requests).toEqual([]);
  }
  {
    const { options, root, requests } = setup();
    options.cwd = join(root, "missing-cwd");
    const error = expectLaunchPreflightFailure(options, "openai_codex_cwd_unresolvable");
    expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(requests).toEqual([]);
  }
  {
    const { options, root, requests } = setup();
    const hostileCwd = join(root, "hostile-git-root");
    mkdirSync(hostileCwd);
    writeFileSync(join(hostileCwd, ".git"), "gitdir: /north-test-missing-git-dir\n");
    options.cwd = hostileCwd;
    const error = expectLaunchPreflightFailure(options, "openai_codex_project_root_untrusted");
    expect((error.cause as Error).name).toBe("TrustedGitOracleError");
    expect(requests).toEqual([]);
  }

  for (const missing of ["command", "expected"] as const) {
    const { options, root, requests } = setup();
    if (missing === "command") options.command = join(root, "missing-command");
    else options.testExpectedExecutable = join(root, "missing-expected-command");
    const error = expectLaunchPreflightFailure(options, "openai_codex_executable_pin_mismatch");
    expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(requests).toEqual([]);
  }
  {
    const { options, root, requests } = setup();
    const other = join(root, "other-codex");
    writeFileSync(other, "#!/bin/sh\nexit 1\n");
    chmodSync(other, 0o700);
    options.command = other;
    const error = expectLaunchPreflightFailure(options, "openai_codex_executable_pin_mismatch");
    expect((error.cause as Error).message).toContain("is not the pinned provider binary");
    expect(requests).toEqual([]);
  }

  for (const authority of ["config.toml", "hooks.json", "rules"] as const) {
    const { options, codexHome, requests } = setup();
    const path = join(codexHome, authority);
    if (authority === "rules") mkdirSync(path);
    else writeFileSync(path, "hostile\n");
    const error = expectLaunchPreflightFailure(
      options, "openai_codex_authority_filesystem_invalid",
    );
    expect((error.cause as Error).message)
      .toBe(`managed Codex account contains authority-bearing ${authority}`);
    expect(requests).toEqual([]);
  }
});
