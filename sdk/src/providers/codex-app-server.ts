import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, constants, fsyncSync, lstatSync, mkdtempSync, openSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codexConfigArguments } from "../accounts";
import { managedNorthMcpEnvironment } from "../execution-admission";
import { parseStrictJson, StrictJsonlFrames } from "../strict-json";
import { trustedGitProjectRoot, trustedManagedCodexExecutable } from "../trusted-runtime";
import type { TerminalTokenUsage } from "../usage";
import type { OpenAIAuthoritySurface } from "./authority";
import { expectedManagedCodexHooks } from "./codex-managed-hooks";

const SUPERVISOR = resolve(import.meta.dir, "codex-supervisor.ts");
const RPC_TIMEOUT_MS = 20_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FRAMES = 20_000;
const MAX_INVENTORY_PAGES = 32;
const MAX_MCP_SERVERS = 64;
const MAX_ID_BYTES = 512;
const MAX_QUEUED_NOTIFICATIONS = 256;
const MANAGED_CODEX_VERSION = "0.144.4";
const SUPERVISOR_FRAME_PREFIX = "NORTH_CODEX_RPC 1 ";

// This is the complete non-removed feature registry in Codex 0.144.4.  The
// initialize version attestation below makes a newly-added default fail closed
// until this manifest is reviewed.  Only the execution primitives and North's
// managed hooks remain enabled.
export const MANAGED_CODEX_ENABLED_FEATURES = [
  "hooks",
  "shell_tool",
  "unified_exec",
] as const;
export const MANAGED_CODEX_DISABLED_FEATURES = [
  "apps",
  "apply_patch_streaming_events",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "chronicle",
  "code_mode",
  "code_mode_host",
  "code_mode_only",
  "computer_use",
  "concurrent_reasoning_summaries",
  "current_time_reminder",
  "default_mode_request_user_input",
  "deferred_executor",
  "enable_request_compression",
  "enable_fanout",
  "enable_mcp_apps",
  "exec_permission_approvals",
  "fast_mode",
  "goals",
  "guardian_approval",
  "image_generation",
  "in_app_browser",
  "item_ids",
  "local_thread_store_compression",
  "memories",
  "mentions_v2",
  "multi_agent",
  "multi_agent_v2",
  "network_proxy",
  "non_prefixed_mcp_tool_names",
  "personality",
  "plugin_sharing",
  "plugins",
  "prevent_idle_sleep",
  "realtime_conversation",
  "remote_compaction_v2",
  "remote_plugin",
  "request_permissions_tool",
  "respect_system_proxy",
  "rollout_budget",
  "runtime_metrics",
  "secret_auth_storage",
  "shell_snapshot",
  "shell_zsh_fork",
  "skill_mcp_dependency_install",
  "standalone_web_search",
  "terminal_visualization_instructions",
  "token_budget",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec_zsh_fork",
  "use_agent_identity",
  "use_legacy_landlock",
  "web_search_cached",
  "web_search_request",
  "workspace_dependencies",
] as const;

type JsonObject = Record<string, unknown>;
type RpcId = number | string;

export interface ManagedCodexNorthServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ManagedCodexAppServerOptions {
  command: string;
  /** Test-only executable prefix, e.g. a Bun fixture script. */
  commandPrefix?: string[];
  /** Test seam; production always retains the parent-death supervisor. */
  useSupervisor?: boolean;
  /** Test-only in-memory transport seam. */
  spawnProcess?: typeof spawn;
  /** Test-only canonical executable attestation target. */
  testExpectedExecutable?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  model: string;
  effort?: string;
  developerInstructions: string;
  surface: OpenAIAuthoritySurface;
  north: ManagedCodexNorthServer;
  timeoutMs?: number;
  onActivity?: () => void;
}

export interface ManagedCodexResult {
  text: string;
  usage: TerminalTokenUsage & {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
  };
}

export class ManagedCodexPreThreadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedCodexPreThreadError";
  }
}

function record(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function boundedString(value: unknown, label: string, maxBytes = MAX_ID_BYTES): string {
  if (typeof value !== "string" || !value || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > maxBytes
      || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`${label} must be a bounded canonical string`);
  return value;
}

function protocolId(value: unknown, label: string): string {
  const id = boundedString(value, label);
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value as object).sort()
      .map((key) => [key, canonical((value as JsonObject)[key])]));
  return value;
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(canonical(value)) !== JSON.stringify(canonical(expected)))
    throw new Error(`${label} does not match North's exact managed Codex contract`);
}

function onlyKeys(value: JsonObject, expected: readonly string[], label: string): void {
  exact(Object.keys(value).sort(), [...expected].sort(), `${label} fields`);
}

function optionalBoundedString(value: unknown, label: string, maxBytes = MAX_ID_BYTES): string | null {
  if (value === null) return null;
  return boundedString(value, label, maxBytes);
}

function tomlStringMap(values: Record<string, string>): string {
  return `{${Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",")}}`;
}

function tomlProjectMap(root: string): string {
  return `{${JSON.stringify(root)}={trust_level="untrusted"}}`;
}

function assertNoFilesystemAuthority(codexHome: string): void {
  for (const name of ["config.toml", "hooks.json", "rules"] as const) {
    try {
      lstatSync(resolve(codexHome, name));
      throw new Error(`managed Codex account contains authority-bearing ${name}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
}

interface LaunchContract {
  args: string[];
  expectedSessionConfig: JsonObject;
  executable: string;
  codexHome: string;
  sqliteHome: string;
  cwd: string;
  projectRoot: string;
}

export function managedCodexAppServerLaunch(
  options: ManagedCodexAppServerOptions,
): LaunchContract {
  const codexHomeValue = options.env.CODEX_HOME?.trim();
  const sqliteHomeValue = options.env.CODEX_SQLITE_HOME?.trim();
  if (!codexHomeValue || !sqliteHomeValue)
    throw new ManagedCodexPreThreadError("openai_target_state_roots_missing");
  let codexHome: string;
  let sqliteHome: string;
  let cwd: string;
  let projectRoot: string;
  let executable: string;
  try {
    codexHome = realpathSync(codexHomeValue);
    sqliteHome = realpathSync(sqliteHomeValue);
    cwd = realpathSync(options.cwd);
    projectRoot = trustedGitProjectRoot(cwd);
    executable = realpathSync(options.command);
    const expectedExecutable = realpathSync(
      options.spawnProcess && options.useSupervisor === false && options.testExpectedExecutable
        ? options.testExpectedExecutable
        : trustedManagedCodexExecutable(),
    );
    if (executable !== expectedExecutable)
      throw new Error("managed Codex executable is not the pinned provider binary");
    assertNoFilesystemAuthority(codexHome);
  } catch (cause) {
    throw new ManagedCodexPreThreadError("openai_codex_authority_filesystem_invalid", { cause });
  }
  options.env.CODEX_HOME = codexHome;
  options.env.CODEX_SQLITE_HOME = sqliteHome;
  options.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";

  const northEnv = managedNorthMcpEnvironment(options.north.env);
  const features = Object.fromEntries([
    ...MANAGED_CODEX_ENABLED_FEATURES.map((name) => [name, true] as const),
    ...MANAGED_CODEX_DISABLED_FEATURES.map((name) => [name, false] as const),
  ]);
  const expectedSessionConfig: JsonObject = {
    cli_auth_credentials_store: "file",
    forced_login_method: "chatgpt",
    model_provider: "openai",
    sqlite_home: sqliteHome,
    project_root_markers: [".git"],
    projects: { [projectRoot]: { trust_level: "untrusted" } },
    project_doc_max_bytes: 0,
    mcp_servers: {
      north: {
        command: options.north.command,
        args: options.north.args,
        env: northEnv,
        enabled: true,
        required: true,
        enabled_tools: options.surface.northEnabledTools,
      },
    },
    web_search: options.surface.web === "disabled" ? "disabled" : undefined,
    features,
  };
  if (expectedSessionConfig.web_search === undefined) delete expectedSessionConfig.web_search;

  const args = [
    ...codexConfigArguments(options.env),
    "-c", 'project_root_markers=[".git"]',
    "-c", `projects=${tomlProjectMap(projectRoot)}`,
    "-c", "project_doc_max_bytes=0",
    "-c", `mcp_servers.north.command=${JSON.stringify(options.north.command)}`,
    "-c", `mcp_servers.north.args=${JSON.stringify(options.north.args)}`,
    "-c", `mcp_servers.north.env=${tomlStringMap(northEnv)}`,
    "-c", "mcp_servers.north.enabled=true",
    "-c", "mcp_servers.north.required=true",
    "-c", `mcp_servers.north.enabled_tools=${JSON.stringify(options.surface.northEnabledTools)}`,
    ...(options.surface.web === "disabled" ? ["-c", 'web_search="disabled"'] : []),
    ...MANAGED_CODEX_ENABLED_FEATURES.flatMap((name) => ["--enable", name]),
    ...MANAGED_CODEX_DISABLED_FEATURES.flatMap((name) => ["--disable", name]),
    "app-server", "--stdio", "--strict-config",
  ];
  return { args, expectedSessionConfig, executable, codexHome, sqliteHome, cwd, projectRoot };
}

interface Pending {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

type AppServerWriter = (
  line: string,
  callback: (error?: Error | null) => void,
) => void;

interface SupervisorControl {
  path: string;
  connected: Promise<void>;
  writeLine: AppServerWriter;
  close(): void;
}

function createSupervisorControl(): SupervisorControl {
  const directory = mkdtempSync(join(tmpdir(), "north-codex-control-"));
  let sequence = 0;
  let closed = false;
  return {
    path: directory,
    connected: Promise.resolve(),
    writeLine(line, callback) {
      if (closed || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        callback(new Error("managed Codex supervisor control is unavailable"));
        return;
      }
      sequence += 1;
      const stem = String(sequence).padStart(12, "0");
      const temporary = join(directory, `.${stem}.${process.pid}.tmp`);
      const request = join(directory, `${stem}.req`);
      let fd: number | undefined;
      try {
        fd = openSync(temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600);
        const payload = Buffer.from(line, "utf8");
        const digest = createHash("sha256").update(payload).digest("hex");
        const bytes = Buffer.concat([
          Buffer.from(`${SUPERVISOR_FRAME_PREFIX}${payload.byteLength} ${digest}\n`, "ascii"),
          payload,
        ]);
        let offset = 0;
        while (offset < bytes.byteLength)
          offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, request);
        callback();
      } catch (error) {
        try { if (fd !== undefined) closeSync(fd); } catch {}
        try { unlinkSync(temporary); } catch {}
        callback(error as Error);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try { rmSync(directory, { recursive: true, force: true }); } catch {}
    },
  };
}

const SAFE_NOTIFICATIONS = new Set([
  "remoteControl/status/changed",
  "mcpServer/startupStatus/updated",
  "account/rateLimits/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "turn/diff/updated",
  "turn/plan/updated",
  "hook/started",
  "hook/completed",
]);

class AppServerRpc {
  private nextId = 0;
  private pending = new Map<RpcId, Pending>();
  private frames = new StrictJsonlFrames({
    label: "managed Codex app-server",
    maxLineBytes: MAX_LINE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxFrames: MAX_FRAMES,
  });
  private terminal?: Error;
  private closed = false;
  private terminalListeners = new Set<(error: Error) => void>();

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private timeoutMs: number,
    private onNotification: (method: string, params: unknown) => void,
    private writeLine: AppServerWriter = (line, callback) => {
      child.stdin.write(line, callback);
    },
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stdout.on("end", () => {
      try { this.frames.finish(); }
      catch (cause) { this.fail(new Error("managed Codex closed with a partial frame", { cause })); }
    });
    child.stdout.on("error", () => this.fail(new Error("managed Codex stdout failed")));
    child.stderr.resume();
    child.stderr.on("error", () => {});
    child.stdin.on("error", () => this.fail(new Error("managed Codex stdin failed")));
    child.on("error", () => this.fail(new Error("managed Codex supervisor failed")));
    child.on("exit", () => {
      if (!this.closed) this.fail(new Error("managed Codex app-server exited unexpectedly"));
    });
  }

  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.terminalListeners) listener(error);
  }

  onTerminal(listener: (error: Error) => void): () => void {
    if (this.terminal) { listener(this.terminal); return () => {}; }
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  private rejectServerRequest(id: RpcId): void {
    this.writeLine(`${JSON.stringify({
      id, error: { code: -32601, message: "North does not grant app-server callback authority" },
    })}\n`, () => {});
    this.fail(new Error("managed Codex requested ungranted client authority"));
  }

  private onData(chunk: Buffer): void {
    try {
      for (const line of this.frames.push(chunk)) this.onLine(line);
    } catch (cause) {
      this.fail(new Error("managed Codex emitted invalid JSONL", { cause }));
    }
  }

  private onLine(line: string): void {
    let value: unknown;
    try { value = parseStrictJson(line, "managed Codex JSONL", { maxBytes: MAX_LINE_BYTES }); }
    catch (cause) { this.fail(new Error("managed Codex emitted malformed JSONL", { cause })); return; }
    let message: JsonObject;
    try { message = record(value, "managed Codex message"); }
    catch (error) { this.fail(error as Error); return; }
    if (typeof message.method === "string") {
      if ("id" in message) {
        if (!Object.keys(message).every((key) => ["id", "method", "params"].includes(key))) {
          this.fail(new Error("managed Codex server request envelope is invalid"));
          return;
        }
        const id = message.id;
        if (typeof id !== "number" && typeof id !== "string") {
          this.fail(new Error("managed Codex server request has invalid id"));
          return;
        }
        this.rejectServerRequest(id);
        return;
      }
      try { onlyKeys(message, ["method", "params"], "managed Codex notification"); }
      catch (error) { this.fail(error as Error); return; }
      if (!SAFE_NOTIFICATIONS.has(message.method)) {
        this.fail(new Error(`managed Codex emitted unsupported notification ${message.method}`));
        return;
      }
      try { this.onNotification(message.method, message.params); }
      catch (error) { this.fail(error instanceof Error ? error : new Error("managed Codex notification invalid")); }
      return;
    }
    const id = message.id;
    if (typeof id !== "number" && typeof id !== "string") {
      this.fail(new Error("managed Codex response has invalid id"));
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) { this.fail(new Error("managed Codex response id is unknown")); return; }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (("result" in message) === ("error" in message)) {
      const error = new Error(`managed Codex ${pending.method} response is malformed`);
      pending.reject(error); this.fail(error); return;
    }
    try { onlyKeys(message, ["id", "result" in message ? "result" : "error"],
      "managed Codex response"); }
    catch (error) { pending.reject(error as Error); this.fail(error as Error); return; }
    if ("error" in message) {
      const error = new Error(`managed Codex ${pending.method} failed`);
      pending.reject(error); this.fail(error); return;
    }
    pending.resolve(message.result);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.terminal) throw this.terminal;
    const id = ++this.nextId;
    const envelope = params === undefined ? { id, method } : { id, method, params };
    const line = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES)
      throw new Error(`managed Codex ${method} request is oversized`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.pending.get(id);
        if (!current) return;
        this.pending.delete(id);
        const error = new Error(`managed Codex ${method} timed out`);
        current.reject(error);
        this.fail(error);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, timer, resolve, reject });
      this.writeLine(line, (error) => {
        if (error) this.fail(new Error(`managed Codex ${method} write failed`));
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.terminal) throw this.terminal;
    const line = `${JSON.stringify(params === undefined ? { method } : { method, params })}\n`;
    this.writeLine(line, (error) => {
      if (error) this.fail(new Error(`managed Codex ${method} notification failed`));
    });
  }

  assertHealthy(): void {
    if (this.terminal) throw this.terminal;
  }

  markClosing(): void { this.closed = true; }
}

function configFingerprint(response: unknown): string {
  const body = record(response, "Codex config/read response");
  if (!Array.isArray(body.layers)) throw new Error("Codex config/read omitted layers");
  return JSON.stringify(canonical(body.layers.map((raw) => {
    const layer = record(raw, "Codex config layer");
    return {
      name: layer.name,
      version: layer.version,
      config: layer.config,
      ...(layer.disabledReason === undefined ? {} : { disabledReason: layer.disabledReason }),
    };
  })));
}

function validateConfig(
  response: unknown,
  contract: LaunchContract,
): string {
  const body = record(response, "Codex config/read response");
  const config = record(body.config, "Codex effective config");
  if (!Array.isArray(body.layers)) throw new Error("Codex config/read omitted layers");
  const layers = body.layers.map((raw) => record(raw, "Codex config layer"));
  const seen = new Map<string, number>();
  for (const layer of layers) {
    const name = record(layer.name, "Codex config layer name");
    const type = boundedString(name.type, "Codex config layer type", 64);
    seen.set(type, (seen.get(type) ?? 0) + 1);
    if (typeof layer.version !== "string" || !/^sha256:[0-9a-f]{64}$/.test(layer.version))
      throw new Error("Codex config layer has invalid version");
    const layerConfig = record(layer.config, "Codex config layer payload");
    if (type === "sessionFlags") {
      exact(layerConfig, contract.expectedSessionConfig, "Codex session authority layer");
    } else if (type === "project") {
      exact(layerConfig, {}, "Codex project layer");
      if (typeof layer.disabledReason !== "string" || !layer.disabledReason)
        throw new Error("Codex project layer is not disabled");
    } else if (type === "user") {
      exact(layerConfig, {}, "Codex user layer");
      if (name.profile !== null || name.file !== resolve(contract.codexHome, "config.toml"))
        throw new Error("Codex user layer names the wrong account");
    } else if (type === "system" || type === "mdm" || type === "enterpriseManaged"
        || type === "legacyManagedConfigTomlFromFile" || type === "legacyManagedConfigTomlFromMdm") {
      exact(layerConfig, {}, `Codex ${type} layer`);
    } else {
      throw new Error(`Codex exposed unknown config layer ${type}`);
    }
  }
  if (seen.get("sessionFlags") !== 1 || seen.get("user") !== 1)
    throw new Error("Codex config layer authority is incomplete");

  const expectedFeatures = Object.fromEntries([
    ...MANAGED_CODEX_ENABLED_FEATURES.map((name) => [name, true] as const),
    ...MANAGED_CODEX_DISABLED_FEATURES.map((name) => [name, false] as const),
  ]);
  exact(config.features, expectedFeatures, "Codex effective feature set");
  exact(config.mcp_servers, contract.expectedSessionConfig.mcp_servers, "Codex effective MCP set");
  exact(config.projects, contract.expectedSessionConfig.projects, "Codex project trust set");
  if (config.project_doc_max_bytes !== 0 || config.model_provider !== "openai"
      || config.cli_auth_credentials_store !== "file" || config.forced_login_method !== "chatgpt"
      || config.sqlite_home !== contract.sqliteHome || config.apps !== null
      || JSON.stringify(config.plugins) !== "{}" || JSON.stringify(config.marketplaces) !== "{}")
    throw new Error("Codex effective authority surface is not closed");
  return configFingerprint(response);
}

function camelEvent(value: string): string {
  return value[0]!.toLowerCase() + value.slice(1);
}

function expectedHookRows(): Array<JsonObject> {
  const rows: Array<JsonObject> = [];
  for (const [event, groups] of Object.entries(expectedManagedCodexHooks())) {
    for (const group of groups) for (const hook of group.hooks) rows.push({
      eventName: camelEvent(event),
      handlerType: "command",
      matcher: group.matcher ?? null,
      command: hook.command,
      timeoutSec: hook.timeout,
      sourcePath: "/etc/codex/hooks",
      source: "system",
      enabled: true,
      isManaged: true,
      trustStatus: "managed",
    });
  }
  return rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function validateRequirements(response: unknown): void {
  const body = record(response, "Codex requirements response");
  const requirements = record(body.requirements, "Codex requirements");
  if (requirements.allowManagedHooksOnly !== true || requirements.allowRemoteControl !== false
      || requirements.managedHookFailureMode !== "block")
    throw new Error("Codex requirements do not close managed hooks, failures, and remote control");
  exact(requirements.featureRequirements, { hooks: true }, "Codex feature requirements");
  const hooks = record(requirements.hooks, "Codex managed hook requirements");
  if (hooks.managedDir !== "/etc/codex/hooks")
    throw new Error("Codex managed hook requirements name the wrong directory");
}

function validateHooks(response: unknown, cwd: string): void {
  const body = record(response, "Codex hooks/list response");
  if (!Array.isArray(body.data) || body.data.length !== 1)
    throw new Error("Codex hooks/list returned the wrong cwd cardinality");
  const entry = record(body.data[0], "Codex hook cwd entry");
  if (entry.cwd !== cwd || !Array.isArray(entry.hooks)
      || !Array.isArray(entry.warnings) || entry.warnings.length
      || !Array.isArray(entry.errors) || entry.errors.length)
    throw new Error("Codex hook inventory has warnings, errors, or the wrong cwd");
  const rows = entry.hooks.map((raw) => {
    const hook = record(raw, "Codex hook metadata");
    return {
      eventName: hook.eventName,
      handlerType: hook.handlerType,
      matcher: hook.matcher,
      command: hook.command,
      timeoutSec: hook.timeoutSec,
      sourcePath: hook.sourcePath,
      source: hook.source,
      enabled: hook.enabled,
      isManaged: hook.isManaged,
      trustStatus: hook.trustStatus,
    };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  exact(rows, expectedHookRows(), "Codex managed hook inventory");
}

async function validateMcp(
  rpc: AppServerRpc,
  expectedTools: readonly string[],
  threadId?: string,
): Promise<void> {
  const servers: JsonObject[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_INVENTORY_PAGES; page++) {
    const response = record(await rpc.request("mcpServerStatus/list", {
      detail: "full",
      limit: 32,
      ...(cursor ? { cursor } : {}),
      ...(threadId ? { threadId } : {}),
    }), "Codex MCP inventory");
    if (!Array.isArray(response.data)) throw new Error("Codex MCP inventory data is invalid");
    for (const raw of response.data) {
      servers.push(record(raw, "Codex MCP server"));
      if (servers.length > MAX_MCP_SERVERS) throw new Error("Codex MCP inventory is oversized");
    }
    if (response.nextCursor == null) break;
    cursor = boundedString(response.nextCursor, "Codex MCP cursor", 4096);
    if (cursors.has(cursor)) throw new Error("Codex MCP cursor repeated");
    cursors.add(cursor);
    if (page === MAX_INVENTORY_PAGES - 1) throw new Error("Codex MCP inventory did not terminate");
  }
  if (servers.length !== 1 || servers[0]!.name !== "north")
    throw new Error("Codex MCP inventory is not exactly North");
  const north = servers[0]!;
  onlyKeys(north, [
    "name", "serverInfo", "tools", "resources", "resourceTemplates", "authStatus",
  ], "Codex North MCP server");
  exact(north.serverInfo, {
    name: "north",
    title: null,
    version: "0.1.0",
    description: null,
    icons: null,
    websiteUrl: null,
  }, "Codex North MCP server identity");
  if (north.authStatus !== "unsupported")
    throw new Error("Codex North MCP server unexpectedly carries authentication authority");
  exact(north.resources, [], "Codex North MCP resource surface");
  exact(north.resourceTemplates, [], "Codex North MCP resource-template surface");
  const tools = record(north.tools, "Codex North MCP tools");
  exact(Object.keys(tools).sort(), [...expectedTools].sort(), "Codex North MCP tool surface");
}

function validateAccount(response: unknown): void {
  const body = record(response, "Codex account/read response");
  const account = record(body.account, "Codex authenticated account");
  if (account.type !== "chatgpt" || body.requiresOpenaiAuth !== true)
    throw new Error("Codex selected account is not authenticated ChatGPT");
}

function validateInitialize(response: unknown, contract: LaunchContract): void {
  const initialized = record(response, "Codex initialize response");
  onlyKeys(initialized, ["userAgent", "codexHome", "platformFamily", "platformOs"],
    "Codex initialize response");
  const expectedPlatformOs = process.platform === "darwin" ? "macos"
    : process.platform === "linux" ? "linux"
    : undefined;
  const userAgent = typeof initialized.userAgent === "string"
    ? initialized.userAgent
    : "";
  const expectedUserAgent = `north/${MANAGED_CODEX_VERSION}`;
  if (initialized.codexHome !== contract.codexHome
      || !expectedPlatformOs || initialized.platformFamily !== "unix"
      || initialized.platformOs !== expectedPlatformOs
      || Buffer.byteLength(userAgent, "utf8") > 512
      || /[\u0000-\u001f\u007f]/.test(userAgent)
      || (userAgent !== expectedUserAgent && !userAgent.startsWith(`${expectedUserAgent} `)))
    throw new Error("Codex initialize did not attest the pinned provider runtime");
}

function expectedSandbox(surface: OpenAIAuthoritySurface): JsonObject {
  return surface.sandbox === "read-only"
    ? { type: "readOnly", networkAccess: false }
    : {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
}

function validateStartedThread(
  response: unknown,
  contract: LaunchContract,
  options: ManagedCodexAppServerOptions,
): string {
  const started = record(response, "Codex thread/start response");
  onlyKeys(started, [
    "thread", "model", "modelProvider", "serviceTier", "cwd", "runtimeWorkspaceRoots",
    "instructionSources", "approvalPolicy", "approvalsReviewer", "sandbox",
    "activePermissionProfile", "reasoningEffort", "multiAgentMode",
  ], "Codex thread/start response");
  const thread = record(started.thread, "Codex started thread");
  onlyKeys(thread, [
    "id", "extra", "sessionId", "forkedFromId", "parentThreadId", "preview", "ephemeral",
    "historyMode", "modelProvider", "createdAt", "updatedAt", "recencyAt", "status", "path",
    "cwd", "cliVersion", "source", "threadSource", "agentNickname", "agentRole", "gitInfo",
    "name", "turns",
  ], "Codex started thread");
  const threadId = protocolId(thread.id, "Codex thread id");
  protocolId(thread.sessionId, "Codex session id");
  if (started.model !== options.model || started.modelProvider !== "openai"
      || started.serviceTier !== null || started.cwd !== contract.cwd
      || thread.ephemeral !== true || thread.modelProvider !== "openai"
      || thread.cwd !== contract.cwd || thread.parentThreadId !== null
      || started.approvalPolicy !== "never" || started.approvalsReviewer !== "user"
      || started.activePermissionProfile !== null
      || started.reasoningEffort !== (options.effort ?? null)
      || started.multiAgentMode !== "explicitRequestOnly")
    throw new Error("Codex thread/start resolved different execution authority");
  exact(started.runtimeWorkspaceRoots, [], "Codex thread runtime workspace roots");
  exact(started.instructionSources, [resolve(contract.codexHome, "AGENTS.md")],
    "Codex thread instruction sources");
  exact(started.sandbox, expectedSandbox(options.surface), "Codex thread sandbox");
  return threadId;
}

function validateStartedTurn(response: unknown): string {
  const started = record(response, "Codex turn/start response");
  onlyKeys(started, ["turn"], "Codex turn/start response");
  const turn = record(started.turn, "Codex started turn");
  onlyKeys(turn, [
    "id", "items", "itemsView", "status", "error", "startedAt", "completedAt", "durationMs",
  ], "Codex started turn");
  const turnId = protocolId(turn.id, "Codex turn id");
  if (turn.status !== "inProgress" || turn.error !== null || !Array.isArray(turn.items)
      || turn.items.length !== 0)
    throw new Error("Codex turn did not start with the exact managed lifecycle");
  return turnId;
}

interface RuntimeNotificationState {
  threadId: string;
  cwd: string;
  turnId?: string;
  hookRuns: Map<string, string>;
  text: string;
  usage?: ManagedCodexResult["usage"];
  terminalSeen: boolean;
}

function validateNotifiedTurn(
  value: unknown,
  expectedId: string | undefined,
  expectedStatus: "inProgress" | "completed",
  label: string,
): void {
  const turn = record(value, label);
  onlyKeys(turn, [
    "id", "items", "itemsView", "status", "error", "startedAt", "completedAt", "durationMs",
  ], label);
  if (!expectedId || turn.id !== expectedId || turn.status !== expectedStatus
      || turn.error !== null || !Array.isArray(turn.items) || turn.itemsView !== "notLoaded"
      || !Number.isSafeInteger(turn.startedAt) || (turn.startedAt as number) < 0)
    throw new Error(`${label} is invalid`);
  if (expectedStatus === "inProgress") {
    if (turn.completedAt !== null || turn.durationMs !== null || turn.items.length !== 0)
      throw new Error(`${label} is invalid`);
    return;
  }
  if (!Number.isSafeInteger(turn.completedAt) || (turn.completedAt as number) < 0
      || !Number.isSafeInteger(turn.durationMs) || (turn.durationMs as number) < 0)
    throw new Error(`${label} is invalid`);
}

function exactRuntimeIds(
  params: JsonObject,
  state: RuntimeNotificationState,
  label: string,
  requireTurn = true,
): void {
  if (params.threadId !== state.threadId)
    throw new Error(`${label} belongs to another thread`);
  if (requireTurn && (!state.turnId || params.turnId !== state.turnId))
    throw new Error(`${label} belongs to another turn`);
}

function validateHookNotification(
  method: "hook/started" | "hook/completed",
  value: unknown,
  state: RuntimeNotificationState,
): void {
  const params = record(value, "Codex hook notification");
  onlyKeys(params, ["threadId", "turnId", "run"], "Codex hook notification");
  exactRuntimeIds(params, state, "Codex hook", params.turnId !== null);
  if (params.turnId !== null && params.turnId !== state.turnId)
    throw new Error("Codex hook belongs to another turn");
  const run = record(params.run, "Codex hook run");
  onlyKeys(run, [
    "id", "eventName", "handlerType", "executionMode", "scope", "sourcePath", "source",
    "displayOrder", "status", "statusMessage", "startedAt", "completedAt", "durationMs",
    "entries",
  ], "Codex hook run");
  const id = protocolId(run.id, "Codex hook run id");
  const allowedEvents = new Set(Object.keys(expectedManagedCodexHooks()).map(camelEvent));
  const eventName = boundedString(run.eventName, "Codex hook event", 64);
  const threadScoped = eventName === "sessionStart";
  if (!allowedEvents.has(eventName)
      || run.handlerType !== "command" || run.executionMode !== "sync"
      || run.scope !== (threadScoped ? "thread" : "turn")
      || (threadScoped ? params.turnId !== null : params.turnId !== state.turnId)
      || run.sourcePath !== "/etc/codex/hooks" || run.source !== "system"
      || !Number.isSafeInteger(run.displayOrder) || (run.displayOrder as number) < 0
      || !Number.isSafeInteger(run.startedAt) || (run.startedAt as number) < 0
      || !Array.isArray(run.entries) || run.entries.length > 64)
    throw new Error("Codex hook run provenance is invalid");
  for (const raw of run.entries) {
    const entry = record(raw, "Codex hook output entry");
    onlyKeys(entry, ["kind", "text"], "Codex hook output entry");
    if (!["warning", "stop", "feedback", "context", "error"].includes(String(entry.kind)))
      throw new Error("Codex hook output kind is invalid");
    if (typeof entry.text !== "string" || Buffer.byteLength(entry.text, "utf8") > 64 * 1024)
      throw new Error("Codex hook output is invalid");
  }
  const identity = JSON.stringify(canonical({
    eventName: run.eventName,
    handlerType: run.handlerType,
    executionMode: run.executionMode,
    scope: run.scope,
    sourcePath: run.sourcePath,
    source: run.source,
    displayOrder: run.displayOrder,
    startedAt: run.startedAt,
  }));
  if (method === "hook/started") {
    if (run.status !== "running" || run.statusMessage !== null || run.completedAt !== null
        || run.durationMs !== null || run.entries.length !== 0 || state.hookRuns.has(id))
      throw new Error("Codex hook start lifecycle is invalid");
    state.hookRuns.set(id, identity);
    return;
  }
  if (!state.hookRuns.has(id) || state.hookRuns.get(id) !== identity)
    throw new Error("Codex hook completion is missing its exact start");
  state.hookRuns.delete(id);
  if (run.status !== "completed" || run.completedAt === null || run.durationMs === null
      || !Number.isSafeInteger(run.completedAt) || !Number.isSafeInteger(run.durationMs)
      || (run.completedAt as number) < (run.startedAt as number)
      || (run.durationMs as number) < 0 || run.statusMessage !== null)
    throw new Error("Codex managed hook did not complete successfully");
}

function validateProgressNotification(
  method: string,
  value: unknown,
  state: RuntimeNotificationState,
): void {
  const params = record(value, `Codex ${method} notification`);
  if (method === "thread/started") {
    onlyKeys(params, ["thread"], "Codex thread/started notification");
    const thread = record(params.thread, "Codex thread/started thread");
    onlyKeys(thread, [
      "id", "extra", "sessionId", "forkedFromId", "parentThreadId", "preview", "ephemeral",
      "historyMode", "modelProvider", "createdAt", "updatedAt", "recencyAt", "status", "path",
      "cwd", "cliVersion", "source", "threadSource", "agentNickname", "agentRole", "gitInfo",
      "name", "turns",
    ], "Codex thread/started thread");
    if (thread.id !== state.threadId || thread.ephemeral !== true
        || thread.modelProvider !== "openai" || thread.cwd !== state.cwd
        || thread.parentThreadId !== null)
      throw new Error("Codex thread/started notification changed authority");
    return;
  }
  if (method === "thread/status/changed") {
    onlyKeys(params, ["threadId", "status"], "Codex thread status notification");
    exactRuntimeIds(params, state, "Codex thread status", false);
    const status = record(params.status, "Codex thread status");
    if (!["idle", "active"].includes(String(status.type)))
      throw new Error("Codex thread entered an invalid managed status");
    return;
  }
  if (method === "turn/started") {
    onlyKeys(params, ["threadId", "turn"], "Codex turn/started notification");
    if (params.threadId !== state.threadId) throw new Error("Codex turn belongs to another thread");
    validateNotifiedTurn(params.turn, state.turnId, "inProgress", "Codex turn/started notification");
    return;
  }
  if (method === "thread/tokenUsage/updated") {
    state.usage = usageFromNotification(params, state.threadId, state.turnId!);
    return;
  }
  if (method === "item/started" || method === "item/completed") {
    onlyKeys(params, ["item", "threadId", "turnId",
      method === "item/started" ? "startedAtMs" : "completedAtMs"], `Codex ${method}`);
    exactRuntimeIds(params, state, `Codex ${method}`);
    const timestamp = params[method === "item/started" ? "startedAtMs" : "completedAtMs"];
    if (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0)
      throw new Error(`Codex ${method} timestamp is invalid`);
    const item = record(params.item, `Codex ${method} item`);
    protocolId(item.id, `Codex ${method} item id`);
    boundedString(item.type, `Codex ${method} item type`, 128);
    if (method === "item/completed" && item.type === "agentMessage") {
      if (typeof item.text !== "string") throw new Error("Codex agent message text is invalid");
      state.text = item.text;
    }
    return;
  }
  if (method === "turn/completed") {
    onlyKeys(params, ["threadId", "turn"], "Codex turn completion");
    if (state.terminalSeen) throw new Error("Codex emitted multiple turn terminals");
    if (params.threadId !== state.threadId) throw new Error("Codex turn terminal is for another thread");
    validateNotifiedTurn(params.turn, state.turnId, "completed", "Codex completed turn");
    if (state.hookRuns.size) throw new Error("Codex turn completed with unfinished managed hooks");
    state.terminalSeen = true;
    return;
  }
  if (method === "hook/started" || method === "hook/completed") {
    validateHookNotification(method, params, state);
    return;
  }
  if (method === "account/rateLimits/updated") {
    onlyKeys(params, ["rateLimits"], "Codex rate-limit notification");
    record(params.rateLimits, "Codex rate-limit snapshot");
    return;
  }
  if (method === "mcpServer/startupStatus/updated") {
    onlyKeys(params, ["threadId", "name", "status", "error", "failureReason"],
      "Codex MCP startup notification");
    if ((params.threadId !== null && params.threadId !== state.threadId)
        || params.name !== "north" || !["starting", "ready"].includes(String(params.status))
        || params.error !== null || params.failureReason !== null)
      throw new Error("Codex North MCP startup status is invalid");
    return;
  }

  const deltaMethods = new Set([
    "item/agentMessage/delta", "item/plan/delta", "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta", "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
  ]);
  if (deltaMethods.has(method)) {
    const keys = ["threadId", "turnId", "itemId", "delta"];
    if (method === "item/reasoning/summaryTextDelta") keys.push("summaryIndex");
    if (method === "item/reasoning/textDelta") keys.push("contentIndex");
    onlyKeys(params, keys, `Codex ${method}`);
    exactRuntimeIds(params, state, `Codex ${method}`);
    protocolId(params.itemId, `Codex ${method} item id`);
    if (typeof params.delta !== "string") throw new Error(`Codex ${method} delta is invalid`);
    for (const key of ["summaryIndex", "contentIndex"])
      if (key in params && (!Number.isSafeInteger(params[key]) || (params[key] as number) < 0))
        throw new Error(`Codex ${method} index is invalid`);
    return;
  }
  if (method === "item/reasoning/summaryPartAdded") {
    onlyKeys(params, ["threadId", "turnId", "itemId", "summaryIndex"], `Codex ${method}`);
    exactRuntimeIds(params, state, `Codex ${method}`);
    protocolId(params.itemId, `Codex ${method} item id`);
    if (!Number.isSafeInteger(params.summaryIndex) || (params.summaryIndex as number) < 0)
      throw new Error("Codex reasoning summary index is invalid");
    return;
  }
  if (method === "item/commandExecution/terminalInteraction") {
    onlyKeys(params, ["threadId", "turnId", "itemId", "processId", "stdin"], `Codex ${method}`);
    exactRuntimeIds(params, state, `Codex ${method}`);
    protocolId(params.itemId, `Codex ${method} item id`);
    protocolId(params.processId, `Codex ${method} process id`);
    if (typeof params.stdin !== "string") throw new Error("Codex terminal interaction is invalid");
    return;
  }
  if (method === "item/fileChange/patchUpdated") {
    onlyKeys(params, ["threadId", "turnId", "itemId", "changes"], `Codex ${method}`);
    exactRuntimeIds(params, state, `Codex ${method}`);
    protocolId(params.itemId, `Codex ${method} item id`);
    if (!Array.isArray(params.changes)) throw new Error("Codex file patch changes are invalid");
    return;
  }
  if (method === "item/mcpToolCall/progress") {
    onlyKeys(params, ["threadId", "turnId", "itemId", "message"], `Codex ${method}`);
    exactRuntimeIds(params, state, `Codex ${method}`);
    protocolId(params.itemId, `Codex ${method} item id`);
    boundedString(params.message, `Codex ${method} message`, 64 * 1024);
    return;
  }
  if (method === "turn/diff/updated") {
    onlyKeys(params, ["threadId", "turnId", "diff"], `Codex ${method}`);
    exactRuntimeIds(params, state, `Codex ${method}`);
    if (typeof params.diff !== "string") throw new Error("Codex turn diff is invalid");
    return;
  }
  if (method === "turn/plan/updated") {
    onlyKeys(params, ["threadId", "turnId", "explanation", "plan"], `Codex ${method}`);
    exactRuntimeIds(params, state, `Codex ${method}`);
    if ((params.explanation !== null && typeof params.explanation !== "string")
        || !Array.isArray(params.plan)) throw new Error("Codex turn plan is invalid");
    return;
  }
  throw new Error(`managed Codex emitted unsupported notification ${method}`);
}

function usageFromNotification(value: unknown, threadId: string, turnId: string): ManagedCodexResult["usage"] {
  const params = record(value, "Codex token usage notification");
  if (params.threadId !== threadId || params.turnId !== turnId)
    throw new Error("Codex token usage belongs to another turn");
  const tokenUsage = record(params.tokenUsage, "Codex token usage");
  const total = record(tokenUsage.total, "Codex cumulative token usage");
  const counter = (name: string): number => {
    const number = total[name];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
      throw new Error(`Codex token usage ${name} is invalid`);
    return number;
  };
  const result = {
    input_tokens: counter("inputTokens"),
    cached_input_tokens: counter("cachedInputTokens"),
    output_tokens: counter("outputTokens"),
    reasoning_output_tokens: counter("reasoningOutputTokens"),
  };
  if (counter("totalTokens") !== result.input_tokens + result.output_tokens
      || result.cached_input_tokens > result.input_tokens
      || result.reasoning_output_tokens > result.output_tokens)
    throw new Error("Codex cumulative token usage is incoherent");
  return result;
}

function supervisorPreflightFailure(
  child: ChildProcessWithoutNullStreams,
): { failure: Promise<never>; stop(): void } {
  const status = (child.stdio as any[])[3] as NodeJS.ReadableStream | undefined;
  if (!status) return {
    failure: Promise.reject(new Error("Codex supervisor status pipe is absent")),
    stop() {},
  };
  const frames = new StrictJsonlFrames({ label: "Codex supervisor", maxLineBytes: 128, maxFrames: 2 });
  let stopped = false;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  const onData = (chunk: Buffer) => {
    if (stopped) return;
    try {
      for (const line of frames.push(chunk)) {
        if (line === "STARTED") continue;
        stopped = true;
        rejectFailure(new Error(line === "UNAVAILABLE"
          ? "Codex executable unavailable"
          : "Codex supervisor emitted invalid start receipt"));
      }
    } catch (error) {
      stopped = true;
      rejectFailure(error as Error);
    }
  };
  const onEnd = () => {
    if (stopped) return;
    stopped = true;
    rejectFailure(new Error("Codex supervisor closed before authority preflight"));
  };
  status.on("data", onData);
  status.on("end", onEnd);
  return {
    failure,
    stop() {
      stopped = true;
      status.removeListener("data", onData);
      status.removeListener("end", onEnd);
      try {
        status.resume();
      } catch {}
    },
  };
}

async function closeProcess(
  child: ChildProcessWithoutNullStreams,
  rpc?: AppServerRpc,
  control?: SupervisorControl,
): Promise<void> {
  rpc?.markClosing();
  control?.close();
  const closed = new Promise<boolean>((resolveClose) =>
    child.once("close", () => resolveClose(true)));
  try { child.stdin.end(); } catch {}
  const settled = await Promise.race([
    closed,
    // Supervisor owns 750ms TERM + 750ms KILL + one 750ms pipe-close
    // deadline. Three 10ms poll quanta cover its bounded predicate checks.
    new Promise<boolean>((resolveExit) => setTimeout(() => resolveExit(false), 2_280)),
  ]);
  let reaped = settled;
  if (!settled) {
    try { child.kill("SIGKILL"); } catch {}
    reaped = await Promise.race([
      closed,
      new Promise<boolean>((resolveExit) => setTimeout(() => resolveExit(false), 750)),
    ]);
  }
  for (const stream of [child.stdin, child.stdout, child.stderr, (child.stdio as any[])[3]]) {
    try { stream?.destroy(); } catch {}
  }
  if (!reaped) throw new Error("managed Codex supervisor exceeded its teardown bound");
}

function awaitChildSpawn(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolveSpawn, reject) => {
    const timer = setTimeout(() => reject(new Error("managed Codex process spawn timed out")), timeoutMs);
    child.once("spawn", () => { clearTimeout(timer); resolveSpawn(); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("managed Codex process unavailable")); });
  });
}

export class ManagedCodexAppServerRun {
  private child?: ChildProcessWithoutNullStreams;
  private rpc?: AppServerRpc;
  private control?: SupervisorControl;
  private threadStarted = false;

  constructor(private options: ManagedCodexAppServerOptions) {}

  async interrupt(): Promise<void> {
    if (this.child) await closeProcess(this.child, this.rpc, this.control);
  }

  async execute(): Promise<ManagedCodexResult> {
    let contract: LaunchContract;
    try { contract = managedCodexAppServerLaunch(this.options); }
    catch (error) {
      if (error instanceof ManagedCodexPreThreadError) throw error;
      throw new ManagedCodexPreThreadError("openai_codex_launch_contract_invalid", { cause: error });
    }
    const supervised = this.options.useSupervisor !== false;
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const control = supervised
      ? createSupervisorControl()
      : undefined;
    this.control = control;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(
        supervised ? process.execPath : contract.executable,
        supervised
          ? [SUPERVISOR, "--duplex", control!.path, contract.executable,
            ...(this.options.commandPrefix ?? []), ...contract.args]
          : [...(this.options.commandPrefix ?? []), ...contract.args], {
        cwd: contract.cwd,
        env: this.options.env,
        stdio: supervised ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
        detached: false,
      }) as unknown as ChildProcessWithoutNullStreams;
    } catch (cause) {
      control?.close();
      this.control = undefined;
      throw new ManagedCodexPreThreadError("openai_codex_supervisor_unavailable", { cause });
    }
    this.child = child;
    let remoteDisabled = false;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let runtimeState: RuntimeNotificationState | undefined;
    const queuedNotifications: Array<{ method: string; value: unknown }> = [];
    let terminalResolve!: () => void;
    let terminalReject!: (error: Error) => void;
    const terminal = new Promise<void>((resolveTerminal, rejectTerminal) => {
      terminalResolve = resolveTerminal;
      terminalReject = rejectTerminal;
    });
    // Authority preflight can fail before the turn waiter is reached. Attach a
    // handler immediately so that the same error is observed by the main flow,
    // never as a detached unhandled rejection.
    void terminal.catch(() => {});
    const validateConnectionNotification = (method: string, value: unknown): boolean => {
      if (method === "remoteControl/status/changed") {
        const params = record(value, "Codex remote-control status");
        onlyKeys(params, ["status", "serverName", "installationId", "environmentId"],
          "Codex remote-control status");
        if (remoteDisabled || params.status !== "disabled"
            || typeof params.serverName !== "string" || !params.serverName
            || Buffer.byteLength(params.serverName, "utf8") > 256
            || typeof params.installationId !== "string" || !params.installationId
            || Buffer.byteLength(params.installationId, "utf8") > 256
            || (params.environmentId !== null
              && (typeof params.environmentId !== "string" || !params.environmentId
                || Buffer.byteLength(params.environmentId, "utf8") > 256)))
          throw new Error("Codex remote control is not exactly disabled");
        remoteDisabled = true;
        return true;
      }
      if (method === "mcpServer/startupStatus/updated") {
        const params = record(value, "Codex MCP startup notification");
        onlyKeys(params, ["threadId", "name", "status", "error", "failureReason"],
          "Codex MCP startup notification");
        if ((params.threadId !== null && params.threadId !== threadId)
            || params.name !== "north" || !["starting", "ready"].includes(String(params.status))
            || params.error !== null || params.failureReason !== null)
          throw new Error("Codex North MCP startup status is invalid");
        return true;
      }
      if (method === "account/rateLimits/updated") {
        const params = record(value, "Codex rate-limit notification");
        onlyKeys(params, ["rateLimits"], "Codex rate-limit notification");
        record(params.rateLimits, "Codex rate-limit snapshot");
        return true;
      }
      return false;
    };
    const canProcessWithoutTurn = (entry: { method: string; value: unknown }): boolean => {
      if (entry.method === "thread/started" || entry.method === "thread/status/changed") return true;
      if (entry.method === "hook/started" || entry.method === "hook/completed") {
        try {
          const params = record(entry.value, "Codex hook notification");
          const run = record(params.run, "Codex hook run");
          return params.turnId === null && run.eventName === "sessionStart";
        }
        catch { return true; }
      }
      return false;
    };
    const processRuntime = (entry: { method: string; value: unknown }): void => {
      if (!runtimeState) throw new Error("Codex runtime notification preceded thread authority");
      const wasTerminal = runtimeState.terminalSeen;
      validateProgressNotification(entry.method, entry.value, runtimeState);
      if (!wasTerminal && runtimeState.terminalSeen) terminalResolve();
    };
    const drainQueued = (withTurn: boolean): void => {
      for (let index = 0; index < queuedNotifications.length;) {
        const entry = queuedNotifications[index]!;
        if (!withTurn && !canProcessWithoutTurn(entry)) { index += 1; continue; }
        queuedNotifications.splice(index, 1);
        processRuntime(entry);
      }
    };
    const onNotification = (method: string, value: unknown) => {
      this.options.onActivity?.();
      if (validateConnectionNotification(method, value)) return;
      const entry = { method, value };
      if (!runtimeState || (!runtimeState.turnId && !canProcessWithoutTurn(entry))) {
        if (queuedNotifications.length >= MAX_QUEUED_NOTIFICATIONS)
          throw new Error("Codex queued too many pre-authority notifications");
        queuedNotifications.push(entry);
        return;
      }
      processRuntime(entry);
    };
    const rpc = new AppServerRpc(
      child, this.options.timeoutMs ?? RPC_TIMEOUT_MS, onNotification, control?.writeLine,
    );
    this.rpc = rpc;
    const removeTerminal = rpc.onTerminal(terminalReject);
    const supervisor = supervised ? supervisorPreflightFailure(child) : {
      failure: new Promise<never>(() => {}), stop() {},
    };
    let primaryFailed = false;
    let protocolSucceeded = false;
    try {
      await awaitChildSpawn(child, this.options.timeoutMs ?? RPC_TIMEOUT_MS);
      if (control) await Promise.race([control.connected, supervisor.failure]);
      const initialized = await Promise.race([
        rpc.request("initialize", {
          clientInfo: { name: "north", title: "North", version: "1" },
          capabilities: { experimentalApi: true },
        }),
        supervisor.failure,
      ]);
      supervisor.stop();
      validateInitialize(initialized, contract);
      rpc.notify("initialized", {});
      validateAccount(await rpc.request("account/read", {}));
      const config = await rpc.request("config/read", { includeLayers: true, cwd: contract.cwd });
      const fingerprint = validateConfig(config, contract);
      validateRequirements(await rpc.request("configRequirements/read"));
      validateHooks(await rpc.request("hooks/list", { cwds: [contract.cwd] }), contract.cwd);
      await validateMcp(rpc, this.options.surface.northEnabledTools);
      if (!remoteDisabled) throw new Error("Codex did not prove remote control disabled");
      assertNoFilesystemAuthority(contract.codexHome);

      // thread/start may execute SessionStart hooks. From this dispatch onward,
      // every failure is terminal and must never be presented as fallback-safe.
      this.threadStarted = true;
      const started = record(await rpc.request("thread/start", {
        model: this.options.model,
        modelProvider: "openai",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: this.options.surface.sandbox,
        config: this.options.effort ? { model_reasoning_effort: this.options.effort } : {},
        developerInstructions: this.options.developerInstructions,
        ephemeral: true,
      }), "Codex thread/start response");
      threadId = validateStartedThread(started, contract, this.options);
      runtimeState = {
        threadId,
        cwd: contract.cwd,
        hookRuns: new Map(),
        text: "",
        terminalSeen: false,
      };
      drainQueued(false);
      if (runtimeState.hookRuns.size || queuedNotifications.length)
        throw new Error("Codex thread/start left unresolved lifecycle notifications");

      const repeated = await rpc.request("config/read", { includeLayers: true, cwd: contract.cwd });
      if (validateConfig(repeated, contract) !== fingerprint)
        throw new Error("Codex config authority changed after thread/start");
      validateHooks(await rpc.request("hooks/list", { cwds: [contract.cwd] }), contract.cwd);
      await validateMcp(rpc, this.options.surface.northEnabledTools, threadId);
      assertNoFilesystemAuthority(contract.codexHome);

      const turnStart = record(await rpc.request("turn/start", {
        threadId,
        input: [{ type: "text", text: this.options.prompt }],
        ...(this.options.effort ? { effort: this.options.effort } : {}),
      }), "Codex turn/start response");
      turnId = validateStartedTurn(turnStart);
      runtimeState.turnId = turnId;
      drainQueued(true);
      await terminal;
      if (!runtimeState.terminalSeen || !runtimeState.usage || runtimeState.hookRuns.size
          || queuedNotifications.length)
        throw new Error("Codex closed without exact terminal usage and lifecycle");
      const terminalConfig = await rpc.request("config/read", {
        includeLayers: true, cwd: contract.cwd,
      });
      if (validateConfig(terminalConfig, contract) !== fingerprint)
        throw new Error("Codex config authority changed at terminal settlement");
      rpc.assertHealthy();
      protocolSucceeded = true;
      return { text: runtimeState.text, usage: runtimeState.usage };
    } catch (error) {
      primaryFailed = true;
      if (!this.threadStarted)
        throw new ManagedCodexPreThreadError("openai_codex_authority_preflight_failed", { cause: error });
      throw new Error("openai_provider_execution_failed", { cause: error });
    } finally {
      supervisor.stop();
      removeTerminal();
      try {
        await closeProcess(child, rpc, control);
        if (protocolSucceeded) rpc.assertHealthy();
      } catch (error) {
        if (!primaryFailed)
          throw new Error("openai_provider_execution_failed", { cause: error });
      }
      this.child = undefined;
      this.rpc = undefined;
      this.control = undefined;
    }
  }
}
