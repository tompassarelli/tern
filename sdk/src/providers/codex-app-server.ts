import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, constants, fsyncSync, lstatSync, mkdtempSync, openSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { codexConfigArguments } from "../accounts";
import { managedNorthMcpEnvironment } from "../execution-admission";
import {
  NativeCommandActivityAccumulator, NORTH_BINARY_PROBE_SCRIPT, unknownNativeCommandActivity,
  type NativeCommandActivityObservation, type NativeCommandStatus,
} from "../native-command-activity";
import { parseStrictJson, StrictJsonlFrames } from "../strict-json";
import { trustedGitProjectRoot, trustedManagedCodexExecutable } from "../trusted-runtime";
import type { TerminalTokenUsage } from "../usage";
import { McpActivityAccumulator, normalizeCodexMcpIdentity } from "../tool-activity";
import {
  FRAM_GRAPH_AUTHORING_CAPABILITY, FRAM_MCP_SERVER, FRAM_MCP_TOOL_NAMES,
  hasCanonicalFramMcpServer,
} from "../fram-graph-authoring";
import type { OpenAIAuthoritySurface } from "./authority";
import { expectedManagedCodexHooks } from "./codex-managed-hooks";
import { CODEX_SUPERVISOR_STATUS_PREFIX } from "./codex-supervisor-protocol";
import { providerJoinEvidence, type ProviderJoinEvidence } from "./provider-join";

const SUPERVISOR = resolve(import.meta.dir, "codex-supervisor.ts");
const ENGINE = resolve(import.meta.dir, "../../../bin/north");
const RPC_TIMEOUT_MS = 20_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FRAMES = 20_000;
const MAX_INVENTORY_PAGES = 32;
const MAX_MCP_SERVERS = 64;
const MAX_ID_BYTES = 512;
const MAX_QUEUED_NOTIFICATIONS = 256;
const MAX_DISABLED_PROJECT_CONFIG_BYTES = 64 * 1024;
const MAX_DISABLED_PROJECT_CONFIG_DEPTH = 16;
const MAX_DISABLED_PROJECT_CONFIG_NODES = 2_048;
const MAX_SAFETY_BUFFERING_VALUES = 64;
const MAX_SAFETY_BUFFERING_VALUE_BYTES = 4_096;
const MANAGED_CODEX_VERSION = "0.144.4";
const SUPERVISOR_FRAME_PREFIX = "NORTH_CODEX_RPC 1 ";
const CODEX_SHELL_PREFLIGHT_TIMEOUT_MS = 5_000;
const CODEX_SHELL_PREFLIGHT_OUTPUT_BYTES = 4_096;
const CODEX_SHELL_PREFLIGHT_COMMAND = Object.freeze([
  "bash", "--noprofile", "--norc", "-c", NORTH_BINARY_PROBE_SCRIPT,
]);

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
  "apply_patch_freeform",
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
  fram?: ManagedCodexNorthServer;
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
  providerJoin: ProviderJoinEvidence;
}

// A later North input frame for the same provider thread, or `undefined` to
// settle the session after the current turn. The session drives one Codex turn
// per resolved frame; every turn re-proves the exact managed authority surface
// before it starts and again at its terminal settlement, so a continuation can
// never widen capability (web stays disabled) mid-session.
export type ManagedCodexNextInput = () => Promise<string | undefined>;

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

function validateShellPreflight(response: unknown): void {
  const result = record(response, "Codex command/exec response");
  onlyKeys(result, ["exitCode", "stdout", "stderr"], "Codex command/exec response");
  const expectedOutput = `${ENGINE}\n${ENGINE}\n`;
  if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0
      || result.stdout !== expectedOutput || result.stderr !== "")
    throw new Error("Codex command/exec did not preserve North's managed shell identity");
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
  // Each preflight cause carries its own code so a swallowed {cause} in the
  // lane log no longer collapses distinct authority failures into one opaque
  // string. Diagnosis reads the code; the {cause} keeps the raw error.
  const stage = <T>(code: string, run: () => T): T => {
    try {
      return run();
    } catch (cause) {
      throw new ManagedCodexPreThreadError(code, { cause });
    }
  };
  const codexHome = stage("openai_codex_state_root_unresolvable",
    () => realpathSync(codexHomeValue));
  const sqliteHome = stage("openai_codex_state_root_unresolvable",
    () => realpathSync(sqliteHomeValue));
  const cwd = stage("openai_codex_cwd_unresolvable", () => realpathSync(options.cwd));
  const projectRoot = stage("openai_codex_project_root_untrusted",
    () => trustedGitProjectRoot(cwd));
  const executable = stage("openai_codex_executable_pin_mismatch", () => {
    const resolved = realpathSync(options.command);
    const expectedExecutable = realpathSync(
      options.spawnProcess && options.testExpectedExecutable
        ? options.testExpectedExecutable
        : trustedManagedCodexExecutable(),
    );
    if (resolved !== expectedExecutable)
      throw new Error(
        `managed Codex executable ${resolved} is not the pinned provider binary ${expectedExecutable}`,
      );
    return resolved;
  });
  stage("openai_codex_authority_filesystem_invalid",
    () => assertNoFilesystemAuthority(codexHome));
  options.env.CODEX_HOME = codexHome;
  options.env.CODEX_SQLITE_HOME = sqliteHome;
  options.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";

  const managedPath = options.env.PATH;
  if (typeof managedPath !== "string" || !managedPath
      || managedPath !== managedPath.trim()
      || managedPath.split(delimiter)[0] !== dirname(ENGINE)
      || options.env.NORTH_BIN !== ENGINE)
    throw new ManagedCodexPreThreadError("openai_managed_shell_environment_invalid");
  const shellEnvironmentPolicy = {
    inherit: "core",
    set: { PATH: managedPath, NORTH_BIN: ENGINE },
  };

  const northEnv = managedNorthMcpEnvironment(options.north.env);
  const graphAuthoring = options.surface.capabilities.includes(FRAM_GRAPH_AUTHORING_CAPABILITY);
  if (graphAuthoring
    ? !options.fram || !hasCanonicalFramMcpServer({
      type: "stdio",
      command: options.fram.command,
      args: options.fram.args,
      env: options.fram.env,
    }, options.cwd)
    : options.fram !== undefined) {
    throw new ManagedCodexPreThreadError("openai_managed_fram_mcp_contract_missing");
  }
  const framConfig = options.fram
    ? {
      [FRAM_MCP_SERVER]: {
        command: options.fram.command,
        args: options.fram.args,
        env: options.fram.env,
        enabled: true,
        required: true,
        enabled_tools: [...FRAM_MCP_TOOL_NAMES],
      },
    }
    : {};
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
    allow_login_shell: false,
    shell_environment_policy: shellEnvironmentPolicy,
    mcp_servers: {
      north: {
        command: options.north.command,
        args: options.north.args,
        env: northEnv,
        enabled: true,
        required: true,
        enabled_tools: options.surface.northEnabledTools,
      },
      ...framConfig,
    },
    web_search: options.surface.web,
    features,
  };

  const args = [
    ...codexConfigArguments(options.env),
    "-c", 'project_root_markers=[".git"]',
    "-c", `projects=${tomlProjectMap(projectRoot)}`,
    "-c", "project_doc_max_bytes=0",
    "-c", "allow_login_shell=false",
    "-c", 'shell_environment_policy.inherit="core"',
    "-c", `shell_environment_policy.set=${tomlStringMap(shellEnvironmentPolicy.set)}`,
    "-c", `mcp_servers.north.command=${JSON.stringify(options.north.command)}`,
    "-c", `mcp_servers.north.args=${JSON.stringify(options.north.args)}`,
    "-c", `mcp_servers.north.env=${tomlStringMap(northEnv)}`,
    "-c", "mcp_servers.north.enabled=true",
    "-c", "mcp_servers.north.required=true",
    "-c", `mcp_servers.north.enabled_tools=${JSON.stringify(options.surface.northEnabledTools)}`,
    ...(options.fram ? [
      "-c", `mcp_servers.${FRAM_MCP_SERVER}.command=${JSON.stringify(options.fram.command)}`,
      "-c", `mcp_servers.${FRAM_MCP_SERVER}.args=${JSON.stringify(options.fram.args)}`,
      "-c", `mcp_servers.${FRAM_MCP_SERVER}.env=${tomlStringMap(options.fram.env)}`,
      "-c", `mcp_servers.${FRAM_MCP_SERVER}.enabled=true`,
      "-c", `mcp_servers.${FRAM_MCP_SERVER}.required=true`,
      "-c", `mcp_servers.${FRAM_MCP_SERVER}.enabled_tools=${JSON.stringify(FRAM_MCP_TOOL_NAMES)}`,
    ] : []),
    "-c", `web_search=${JSON.stringify(options.surface.web)}`,
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
type AppServerRequestHandler = (id: RpcId, method: string, params: unknown) => JsonObject | undefined;

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
  "configWarning",
  "deprecationNotice",
  "remoteControl/status/changed",
  "mcpServer/startupStatus/updated",
  "model/safetyBuffering/updated",
  "account/rateLimits/updated",
  "serverRequest/resolved",
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
    private onServerRequest: AppServerRequestHandler,
    private writeLine: AppServerWriter = (line, callback) => {
      child.stdin.write(line, callback);
    },
    private ownsStderr = true,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stdout.on("end", () => {
      try { this.frames.finish(); }
      catch (cause) { this.fail(new Error("managed Codex closed with a partial frame", { cause })); }
    });
    child.stdout.on("error", () => this.fail(new Error("managed Codex stdout failed")));
    if (this.ownsStderr) {
      child.stderr.resume();
      child.stderr.on("error", () => {});
    }
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
        let result: JsonObject | undefined;
        try { result = this.onServerRequest(id, message.method, message.params); }
        catch (error) { this.fail(error instanceof Error ? error : new Error("managed Codex callback invalid")); return; }
        if (result === undefined) { this.rejectServerRequest(id); return; }
        this.writeLine(`${JSON.stringify({ id, result })}\n`, (error) => {
          if (error) this.fail(new Error("managed Codex callback response failed", { cause: error }));
        });
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

function validateDisabledProjectConfig(value: JsonObject): void {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string")
    throw new Error("Codex disabled project layer is not JSON-serializable");
  parseStrictJson(serialized, "Codex disabled project layer", {
    maxBytes: MAX_DISABLED_PROJECT_CONFIG_BYTES,
    maxDepth: MAX_DISABLED_PROJECT_CONFIG_DEPTH,
    maxNodes: MAX_DISABLED_PROJECT_CONFIG_NODES,
  });
  const allowed = new Set(["mcp_servers", "hooks", "exec_policy"]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Codex disabled project config widened authority");
}

function validateConfig(
  response: unknown,
  contract: LaunchContract,
  exactProjectWarningSeen = false,
): string {
  const body = record(response, "Codex config/read response");
  const config = record(body.config, "Codex effective config");
  if (!Array.isArray(body.layers)) throw new Error("Codex config/read omitted layers");
  const layers = body.layers.map((raw) => record(raw, "Codex config layer"));
  const seen = new Map<string, number>();
  let projectWarningRequired = false;
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
      onlyKeys(layer, layer.disabledReason === undefined
        ? ["name", "version", "config"]
        : ["name", "version", "config", "disabledReason"], "Codex project layer");
      onlyKeys(name, ["type", "dotCodexFolder"], "Codex project layer name");
      if (layer.disabledReason !== undefined)
        boundedString(layer.disabledReason, "Codex project layer disabled reason", 4_096);
      validateDisabledProjectConfig(layerConfig);
      if (Object.keys(layerConfig).length > 0) projectWarningRequired = true;
      if (boundedString(name.dotCodexFolder, "Codex project layer folder", 4_096)
          !== join(contract.projectRoot, ".codex"))
        throw new Error("Codex project layer names an invalid config folder");
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
  if (projectWarningRequired && !exactProjectWarningSeen)
    throw new Error("Codex tracked project layer lacks its exact disabled warning");

  const expectedFeatures = Object.fromEntries([
    ...MANAGED_CODEX_ENABLED_FEATURES.map((name) => [name, true] as const),
    ...MANAGED_CODEX_DISABLED_FEATURES.map((name) => [name, false] as const),
    ["remote_control", false] as const,
  ]);
  exact(config.features, expectedFeatures, "Codex effective feature set");
  const sessionMcp = record(
    contract.expectedSessionConfig.mcp_servers, "Codex expected MCP session set",
  );
  const expectedEffectiveMcp = Object.fromEntries(Object.entries(sessionMcp).map(
    ([name, raw]) => [name, {
      ...record(raw, `Codex expected MCP session ${name}`),
      environment_id: "local",
      tool_timeout_sec: null,
    }],
  ));
  exact(config.mcp_servers, expectedEffectiveMcp, "Codex effective MCP set");
  exact(config.projects, contract.expectedSessionConfig.projects, "Codex project trust set");
  const sessionShellEnvironmentPolicy = record(
    contract.expectedSessionConfig.shell_environment_policy,
    "Codex expected shell environment policy",
  );
  exact(
    config.shell_environment_policy,
    {
      ...sessionShellEnvironmentPolicy,
      ignore_default_excludes: null,
      exclude: null,
      include_only: null,
      experimental_use_profile: null,
    },
    "Codex effective shell environment policy",
  );
  if (config.project_doc_max_bytes !== 0 || config.model_provider !== "openai"
      || config.cli_auth_credentials_store !== "file" || config.forced_login_method !== "chatgpt"
      || config.sqlite_home !== contract.sqliteHome || config.allow_login_shell !== false
      || config.apps !== null
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
  exact(started.runtimeWorkspaceRoots, [contract.cwd], "Codex thread runtime workspace roots");
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
  model: string;
  turnId?: string;
  hookRuns: Map<string, string>;
  text: string;
  usage?: ManagedCodexResult["usage"];
  terminalSeen: boolean;
  mcpActivity: McpActivityAccumulator;
  nativeCommands: NativeCommandActivityAccumulator;
}

function commandText(value: unknown, label: string, maxBytes = MAX_LINE_BYTES): string {
  if (typeof value !== "string" || !value
      || Buffer.byteLength(value, "utf8") > maxBytes)
    throw new Error(`${label} is invalid`);
  return value;
}

function nullableCommandText(value: unknown, label: string): string {
  if (value === null) return "";
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_LINE_BYTES)
    throw new Error(`${label} is invalid`);
  return value;
}

function validateCommandAction(value: unknown): void {
  const action = record(value, "Codex command action");
  const type = boundedString(action.type, "Codex command action type", 32);
  if (type === "read") {
    onlyKeys(action, ["type", "command", "name", "path"], "Codex read command action");
    commandText(action.command, "Codex read command action command");
    commandText(action.name, "Codex read command action name", 4_096);
    commandText(action.path, "Codex read command action path");
    return;
  }
  if (type === "listFiles") {
    onlyKeys(action, ["type", "command", "path"], "Codex list-files command action");
    commandText(action.command, "Codex list-files command action command");
    if (action.path !== null) commandText(action.path, "Codex list-files command action path");
    return;
  }
  if (type === "search") {
    onlyKeys(action, ["type", "command", "query", "path"], "Codex search command action");
    commandText(action.command, "Codex search command action command");
    if (action.query !== null) commandText(action.query, "Codex search command action query");
    if (action.path !== null) commandText(action.path, "Codex search command action path");
    return;
  }
  if (type === "unknown") {
    onlyKeys(action, ["type", "command"], "Codex unknown command action");
    commandText(action.command, "Codex unknown command action command");
    return;
  }
  throw new Error("Codex command action type is invalid");
}

function completedNativeCommand(
  item: JsonObject,
  state: RuntimeNotificationState,
): void {
  onlyKeys(item, [
    "id", "type", "command", "cwd", "processId", "source", "status",
    "commandActions", "aggregatedOutput", "exitCode", "durationMs",
  ], "Codex completed command execution");
  const id = protocolId(item.id, "Codex completed command execution id");
  if (item.type !== "commandExecution" || item.cwd !== state.cwd)
    throw new Error("Codex completed command execution changed authority");
  const command = commandText(item.command, "Codex completed command execution command");
  if (item.processId !== null) protocolId(item.processId, "Codex command process id");
  const source = String(item.source);
  if (!["agent", "userShell", "unifiedExecStartup", "unifiedExecInteraction"].includes(source))
    throw new Error("Codex completed command execution source is invalid");
  const status = String(item.status) as NativeCommandStatus;
  if (!["completed", "failed", "declined"].includes(status))
    throw new Error("Codex completed command execution status is not terminal");
  if (!Array.isArray(item.commandActions) || item.commandActions.length > 256)
    throw new Error("Codex completed command actions are invalid");
  for (const action of item.commandActions) validateCommandAction(action);
  const aggregatedOutput = nullableCommandText(
    item.aggregatedOutput, "Codex completed command execution output",
  );
  if (!Number.isSafeInteger(item.exitCode)
      || (item.exitCode as number) < -2_147_483_648
      || (item.exitCode as number) > 2_147_483_647)
    throw new Error("Codex completed command execution exit code is invalid");
  if (!Number.isSafeInteger(item.durationMs) || (item.durationMs as number) < 0)
    throw new Error("Codex completed command execution duration is invalid");
  if (!state.nativeCommands.observe({
    id: `${state.turnId}:${id}`,
    command,
    cwd: state.cwd,
    source: source as "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction",
    status,
    aggregatedOutput,
    exitCode: item.exitCode as number,
  })) throw new Error("Codex command completion is missing its exact start");
}

function startedNativeCommand(item: JsonObject, state: RuntimeNotificationState): void {
  onlyKeys(item, [
    "id", "type", "command", "cwd", "processId", "source", "status",
    "commandActions", "aggregatedOutput", "exitCode", "durationMs",
  ], "Codex started command execution");
  const id = protocolId(item.id, "Codex started command execution id");
  if (item.type !== "commandExecution" || item.cwd !== state.cwd
      || item.status !== "inProgress" || item.aggregatedOutput !== null
      || item.exitCode !== null || item.durationMs !== null)
    throw new Error("Codex started command execution lifecycle is invalid");
  commandText(item.command, "Codex started command execution command");
  if (item.processId !== null) protocolId(item.processId, "Codex command process id");
  if (!["agent", "userShell", "unifiedExecStartup", "unifiedExecInteraction"]
    .includes(String(item.source)))
    throw new Error("Codex started command execution source is invalid");
  if (!Array.isArray(item.commandActions) || item.commandActions.length > 256)
    throw new Error("Codex started command actions are invalid");
  for (const action of item.commandActions) validateCommandAction(action);
  if (!state.nativeCommands.start(`${state.turnId}:${id}`))
    throw new Error("Codex command start lifecycle is invalid");
}

function validateMcpStartupNotification(
  value: unknown,
  expectedThreadId: string | undefined,
  allowPendingThreadId = false,
): JsonObject {
  const params = record(value, "Codex MCP startup notification");
  onlyKeys(params, ["threadId", "name", "status", "error", "failureReason"],
    "Codex MCP startup notification");
  let validThreadId = params.threadId === null;
  if (typeof params.threadId === "string") {
    try {
      protocolId(params.threadId, "Codex MCP startup thread id");
      validThreadId = expectedThreadId === undefined
        ? allowPendingThreadId
        : params.threadId === expectedThreadId;
    } catch { validThreadId = false; }
  }
  if (!validThreadId || params.name !== "north"
      || !["starting", "ready"].includes(String(params.status))
      || params.error !== null || params.failureReason !== null) {
    const expected = expectedThreadId === undefined
      ? (allowPendingThreadId ? "null or the pending thread/start protocol id" : "null")
      : `null or ${JSON.stringify(expectedThreadId)}`;
    throw new Error(`Codex North MCP startup status is invalid: expected threadId ${expected}, `
      + `name \"north\", status \"starting\"|\"ready\", error null, failureReason null; `
      + `observed ${JSON.stringify(canonical(params))}`);
  }
  return params;
}

function validateSafetyBufferingNotification(
  value: unknown,
  state: RuntimeNotificationState,
): void {
  const params = record(value, "Codex safety-buffering notification");
  const keys = ["threadId", "turnId", "model", "useCases", "reasons", "showBufferingUi"];
  if ("fasterModel" in params) keys.push("fasterModel");
  onlyKeys(params, keys, "Codex safety-buffering notification");
  exactRuntimeIds(params, state, "Codex safety-buffering notification");
  if (boundedString(params.model, "Codex safety-buffering model") !== state.model)
    throw new Error("Codex safety-buffering notification changed the active model");
  for (const [key, label] of [["useCases", "use case"], ["reasons", "reason"]] as const) {
    const values = params[key];
    if (!Array.isArray(values) || values.length > MAX_SAFETY_BUFFERING_VALUES)
      throw new Error(`Codex safety-buffering ${key} are invalid`);
    values.forEach((entry, index) => boundedString(
      entry, `Codex safety-buffering ${label} ${index}`, MAX_SAFETY_BUFFERING_VALUE_BYTES,
    ));
  }
  if (typeof params.showBufferingUi !== "boolean")
    throw new Error("Codex safety-buffering UI flag is invalid");
  if ("fasterModel" in params)
    optionalBoundedString(params.fasterModel, "Codex safety-buffering faster model");
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
  const run = record(params.run, "Codex hook run");
  onlyKeys(run, [
    "id", "eventName", "handlerType", "executionMode", "scope", "sourcePath", "source",
    "displayOrder", "status", "statusMessage", "startedAt", "completedAt", "durationMs",
    "entries",
  ], "Codex hook run");
  const id = boundedString(run.id, "Codex hook run id", 512);
  const allowedEvents = new Set(Object.keys(expectedManagedCodexHooks()).map(camelEvent));
  const eventName = boundedString(run.eventName, "Codex hook event", 64);
  const threadScoped = eventName === "sessionStart";
  if (params.threadId !== state.threadId)
    throw new Error("Codex hook belongs to another thread");
  if (threadScoped) {
    if (params.turnId !== null) protocolId(params.turnId, "Codex session hook turn id");
  } else if (!state.turnId || params.turnId !== state.turnId) {
    throw new Error("Codex hook belongs to another turn");
  }
  if (!allowedEvents.has(eventName)
      || run.handlerType !== "command" || run.executionMode !== "sync"
      || run.scope !== (threadScoped ? "thread" : "turn")
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
    turnId: params.turnId,
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
    if (method === "item/started" && item.type === "commandExecution")
      startedNativeCommand(item, state);
    if (method === "item/completed" && item.type === "agentMessage") {
      if (typeof item.text !== "string") throw new Error("Codex agent message text is invalid");
      state.text = item.text;
    }
    if (method === "item/completed" && item.type === "mcpToolCall") {
      state.mcpActivity.observe(
        `${state.turnId}:${String(item.id)}`,
        normalizeCodexMcpIdentity(item.server, item.tool),
      );
    }
    if (method === "item/completed" && item.type === "commandExecution")
      completedNativeCommand(item, state);
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
    validateMcpStartupNotification(params, state.threadId);
    return;
  }
  if (method === "model/safetyBuffering/updated") {
    validateSafetyBufferingNotification(params, state);
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
  const status = child.stderr as NodeJS.ReadableStream | undefined;
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
      for (const line of frames.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        const statusLine = line.startsWith(CODEX_SUPERVISOR_STATUS_PREFIX)
          ? line.slice(CODEX_SUPERVISOR_STATUS_PREFIX.length)
          : undefined;
        if (statusLine === "STARTED") continue;
        stopped = true;
        rejectFailure(new Error(statusLine === "UNAVAILABLE"
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
  status.on("error", onEnd);
  return {
    failure,
    stop() {
      stopped = true;
      status.removeListener("data", onData);
      status.removeListener("end", onEnd);
      status.removeListener("error", onEnd);
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
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
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
  private readonly mcp = new McpActivityAccumulator("codex-app-server:item-completed");
  private nativeCommands?: NativeCommandActivityAccumulator;

  constructor(private options: ManagedCodexAppServerOptions) {}

  mcpActivity() { return this.mcp.snapshot(); }
  nativeCommandActivity(): NativeCommandActivityObservation {
    return this.nativeCommands?.snapshot()
      ?? unknownNativeCommandActivity("codex-app-server:not-started");
  }

  async interrupt(): Promise<void> {
    if (this.child) await closeProcess(this.child, this.rpc, this.control);
  }

  // Single-turn entry point: run exactly one turn on a fresh thread and tear the
  // session down. Preserved verbatim for the ~40 direct call sites and the
  // non-continuation worker path.
  async execute(): Promise<ManagedCodexResult> {
    const session = this.session(async () => undefined);
    const first = await session.next();
    if (first.done || !first.value)
      throw new Error("openai_provider_execution_failed");
    // Resume into the generator's finally so teardown (and any unclean-close
    // failure) is observed exactly as the pre-continuation flow observed it.
    await session.return(first.value);
    return first.value;
  }

  // Same-thread continuation. Yields one terminal result per turn; after each
  // turn the caller supplies the next North input frame (or `undefined` to
  // settle). The provider thread, MCP wiring, and authority fingerprint are
  // established once and re-proven per turn.
  async *session(nextInput: ManagedCodexNextInput): AsyncGenerator<ManagedCodexResult> {
    let contract: LaunchContract;
    try { contract = managedCodexAppServerLaunch(this.options); }
    catch (error) {
      if (error instanceof ManagedCodexPreThreadError) throw error;
      throw new ManagedCodexPreThreadError("openai_codex_launch_contract_invalid", { cause: error });
    }
    this.nativeCommands = new NativeCommandActivityAccumulator(contract.cwd, ENGINE);
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
        stdio: ["pipe", "pipe", "pipe"],
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
    const approvedServerRequests = new Set<RpcId>();
    const queuedNotifications: Array<{ method: string; value: unknown }> = [];
    let terminalResolve!: () => void;
    let terminalReject!: (error: Error) => void;
    // Reassigned per turn: each continuation turn installs a fresh terminal
    // barrier while `terminalResolve`/`terminalReject` (captured by the
    // notification closures below by reference) always point at the live turn.
    let terminal = new Promise<void>((resolveTerminal, rejectTerminal) => {
      terminalResolve = resolveTerminal;
      terminalReject = rejectTerminal;
    });
    // Authority preflight can fail before the turn waiter is reached. Attach a
    // handler immediately so that the same error is observed by the main flow,
    // never as a detached unhandled rejection.
    void terminal.catch(() => {});
    let exactProjectWarningSeen = false;
    const validateConnectionNotification = (method: string, value: unknown): boolean => {
      if (method === "configWarning") {
        const params = record(value, "Codex config warning");
        onlyKeys(params, ["summary", "details"], "Codex config warning");
        const expectedSummary = "Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load.\n"
          + `    1. ${contract.cwd}/.codex\n`
          + `       ${contract.cwd} is marked as untrusted in ${contract.codexHome}/config.toml. To load project-local config, hooks, and exec policies, mark it trusted.\n`;
        exact(params, { summary: expectedSummary, details: null }, "Codex config warning");
        exactProjectWarningSeen = true;
        return true;
      }
      if (method === "deprecationNotice") {
        const params = record(value, "Codex deprecation notice");
        onlyKeys(params, ["summary", "details"], "Codex deprecation notice");
        boundedString(params.summary, "Codex deprecation summary", 2_048);
        boundedString(params.details, "Codex deprecation details", 4_096);
        return true;
      }
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
        const pendingThreadStart = threadId === undefined && this.threadStarted;
        const params = validateMcpStartupNotification(value, threadId, pendingThreadStart);
        // Codex may emit a thread-scoped startup transition before the
        // thread/start response that establishes the exact local thread id.
        // Preserve it until that signed response arrives, then validate the
        // queued id against runtimeState through the normal strict path.
        if (params.threadId !== null && threadId === undefined) return false;
        return true;
      }
      if (method === "account/rateLimits/updated") {
        const params = record(value, "Codex rate-limit notification");
        onlyKeys(params, ["rateLimits"], "Codex rate-limit notification");
        record(params.rateLimits, "Codex rate-limit snapshot");
        return true;
      }
      if (method === "serverRequest/resolved") {
        const params = record(value, "Codex server request resolution");
        onlyKeys(params, ["threadId", "requestId"], "Codex server request resolution");
        const requestId = params.requestId;
        if (params.threadId !== threadId
            || (typeof requestId !== "number" && typeof requestId !== "string")
            || !approvedServerRequests.delete(requestId))
          throw new Error("Codex resolved an unknown server request");
        return true;
      }
      return false;
    };
    const canProcessWithoutTurn = (entry: { method: string; value: unknown }): boolean => {
      if (entry.method === "thread/started" || entry.method === "thread/status/changed"
          || entry.method === "mcpServer/startupStatus/updated") return true;
      if (entry.method === "hook/started" || entry.method === "hook/completed") {
        try {
          const params = record(entry.value, "Codex hook notification");
          const run = record(params.run, "Codex hook run");
          return run.eventName === "sessionStart";
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
    const onServerRequest: AppServerRequestHandler = (id, method, value) => {
      if (method !== "item/tool/requestUserInput") return undefined;
      const params = record(value, "Codex tool input request");
      onlyKeys(params, ["threadId", "turnId", "itemId", "questions", "autoResolutionMs"],
        "Codex tool input request");
      if (params.threadId !== threadId || params.turnId !== turnId || params.autoResolutionMs !== null)
        throw new Error("Codex tool input request belongs to another execution");
      const itemId = protocolId(params.itemId, "Codex tool input item id");
      if (!Array.isArray(params.questions) || params.questions.length !== 1)
        throw new Error("Codex tool input request must contain one approval question");
      const question = record(params.questions[0], "Codex North MCP approval question");
      onlyKeys(question, ["id", "header", "question", "isOther", "isSecret", "options"],
        "Codex North MCP approval question");
      const questionId = `mcp_tool_call_approval_${itemId}`;
      const prompt = boundedString(question.question, "Codex North MCP approval prompt", 512);
      const match = /^Allow the north MCP server to run tool "([a-z][a-z0-9_]*)"\?$/.exec(prompt);
      if (question.id !== questionId || question.header !== "Approve app tool call?"
          || question.isOther !== false || question.isSecret !== false || !match
          || !this.options.surface.northEnabledTools.includes(match[1]!))
        throw new Error("Codex requested approval outside North's sealed MCP grant");
      exact(question.options, [
        { label: "Allow", description: "Run the tool and continue." },
        { label: "Allow for this session", description: "Run the tool and remember this choice for this session." },
        { label: "Cancel", description: "Cancel this tool call." },
      ], "Codex North MCP approval options");
      approvedServerRequests.add(id);
      return { answers: { [questionId]: { answers: ["Allow"] } } };
    };
    const rpc = new AppServerRpc(
      child, this.options.timeoutMs ?? RPC_TIMEOUT_MS, onNotification, onServerRequest, control?.writeLine,
      !supervised,
    );
    this.rpc = rpc;
    // Route an RPC-level terminal failure into whichever turn is currently
    // waiting; the indirection is required so a defect during turn N rejects
    // turn N, not the already-settled turn 1 barrier.
    const removeTerminal = rpc.onTerminal((error) => terminalReject(error));
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
      const fingerprint = validateConfig(config, contract, exactProjectWarningSeen);
      validateRequirements(await rpc.request("configRequirements/read"));
      validateHooks(await rpc.request("hooks/list", { cwds: [contract.cwd] }), contract.cwd);
      await validateMcp(rpc, this.options.surface.northEnabledTools);
      if (!remoteDisabled) throw new Error("Codex did not prove remote control disabled");
      assertNoFilesystemAuthority(contract.codexHome);
      const shellPolicy = record(
        contract.expectedSessionConfig.shell_environment_policy,
        "Codex managed shell policy",
      );
      const shellEnvironment = record(shellPolicy.set, "Codex managed shell environment");
      validateShellPreflight(await rpc.request("command/exec", {
        command: [...CODEX_SHELL_PREFLIGHT_COMMAND],
        processId: null,
        tty: false,
        streamStdin: false,
        streamStdoutStderr: false,
        outputBytesCap: CODEX_SHELL_PREFLIGHT_OUTPUT_BYTES,
        disableOutputCap: false,
        disableTimeout: false,
        timeoutMs: CODEX_SHELL_PREFLIGHT_TIMEOUT_MS,
        cwd: contract.cwd,
        env: { PATH: shellEnvironment.PATH, NORTH_BIN: shellEnvironment.NORTH_BIN },
        size: null,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        permissionProfile: null,
      }));

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
        model: this.options.model,
        hookRuns: new Map(),
        text: "",
        terminalSeen: false,
        mcpActivity: this.mcp,
        nativeCommands: this.nativeCommands,
      };
      drainQueued(false);
      if (runtimeState.hookRuns.size || queuedNotifications.length)
        throw new Error("Codex thread/start left unresolved lifecycle notifications");

      // One turn per North input frame, on the same provider thread. The first
      // frame is the launch prompt; later frames arrive from `nextInput`.
      let input: string | undefined = this.options.prompt;
      while (true) {
        // Re-prove the exact authority surface before every turn: a stale or
        // widened config, hook set, or MCP tool grant fails the turn closed
        // rather than executing a continuation under changed capability.
        const repeated = await rpc.request("config/read", { includeLayers: true, cwd: contract.cwd });
        if (validateConfig(repeated, contract, exactProjectWarningSeen) !== fingerprint)
          throw new Error("Codex config authority changed after thread/start");
        validateHooks(await rpc.request("hooks/list", { cwds: [contract.cwd] }), contract.cwd);
        await validateMcp(rpc, this.options.surface.northEnabledTools, threadId);
        assertNoFilesystemAuthority(contract.codexHome);

        // Fresh terminal barrier and per-turn runtime accumulators. The closures
        // read `terminalResolve`/`runtimeState` by reference, so reassigning here
        // steers every subsequent notification at this turn.
        runtimeState.text = "";
        runtimeState.usage = undefined;
        runtimeState.turnId = undefined;
        runtimeState.terminalSeen = false;
        terminal = new Promise<void>((resolveTerminal, rejectTerminal) => {
          terminalResolve = resolveTerminal;
          terminalReject = rejectTerminal;
        });
        void terminal.catch(() => {});
        protocolSucceeded = false;

        const turnStart = record(await rpc.request("turn/start", {
          threadId,
          input: [{ type: "text", text: input }],
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
        if (validateConfig(terminalConfig, contract, exactProjectWarningSeen) !== fingerprint)
          throw new Error("Codex config authority changed at terminal settlement");
        rpc.assertHealthy();
        protocolSucceeded = true;
        this.mcp.complete();
        if (!this.nativeCommands.complete())
          throw new Error("Codex turn completed with unfinished native commands");
        yield {
          text: runtimeState.text,
          usage: runtimeState.usage,
          providerJoin: providerJoinEvidence("openai", {
            sessionId: threadId,
            turnIds: [turnId],
            // thread/start is admitted only with ephemeral:true above. This is
            // positive non-persistence evidence, not an inference from a
            // missing account-log record.
            sessionPersistence: "ephemeral",
          }),
        };

        input = await nextInput();
        if (input === undefined) break;
        this.mcp.reopen();
        this.nativeCommands.reopen();
      }
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
