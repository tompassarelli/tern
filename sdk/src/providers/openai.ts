import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ProviderRetrySafeError, type AgentProvider, type AgentQuery, type ProviderAvailability } from "./types";
import type { RoutingTarget } from "./types";
import { probeOpenAI } from "../provider-routing";
import type { AdapterUsageMetadata, TerminalTokenUsage } from "../usage";
import { codexConfigArguments, providerEnvironmentForTarget } from "../accounts";
import type { GafferCapability } from "../gaffer-capabilities";
import {
  admitExecution, admitPinnedProvider, consumeExecutionAdmission,
  managedNorthMcpEnvironment, validateManagedExecutionEnvelope,
} from "../execution-admission";
import {
  canonicalGlobalAgents, GLOBAL_AGENTS_MAX_BYTES, hasCanonicalHarnessAuthority,
  renewHarnessPresence,
} from "../harness";
import {
  CODEX_WORKER_NORTH_ENABLED_TOOLS, compileProviderAuthoritySurface,
  type OpenAIAuthoritySurface,
} from "./authority";
import { parseStrictJson, StrictJsonlFrames } from "../strict-json";
import { assertInstalledManagedCodexHooks } from "./codex-managed-hooks";
import {
  trustedGitProjectRoot, trustedManagedCodexExecutable,
} from "../trusted-runtime";

type ManagedCommandResolver = () => string;

const managedCommandReceipts = new WeakMap<object, string>();

function resolveManagedCommand(resolver: ManagedCommandResolver): string {
  try {
    const resolved = resolver();
    if (typeof resolved !== "string" || !resolved.trim()) throw new Error("empty managed Codex executable");
    return resolved;
  } catch (cause) {
    throw new ProviderRetrySafeError(
      "openai_provider_executable_unavailable_before_acceptance", { cause },
    );
  }
}

function recordManagedCommand(options: unknown, resolved: string): void {
  if ((typeof options !== "object" && typeof options !== "function") || options === null)
    throw new ProviderRetrySafeError("openai_managed_command_receipt_unavailable");
  managedCommandReceipts.set(options as object, resolved);
}

function takeManagedCommand(options: unknown): string | undefined {
  if ((typeof options !== "object" && typeof options !== "function") || options === null) return undefined;
  const key = options as object;
  const resolved = managedCommandReceipts.get(key);
  managedCommandReceipts.delete(key);
  return resolved;
}
const CODEX_SUPERVISOR = resolve(import.meta.dir, "codex-supervisor.ts");

/** Per-invocation Codex restrictions derived from the provider-neutral harness contract. */
export function codexHarnessArguments(options: any): string[] {
  const denied = new Set(Array.isArray(options?.disallowedTools) ? options.disallowedTools : []);
  const surface = options?.northCapabilities === undefined
    ? undefined
    : compileProviderAuthoritySurface("openai", options) as OpenAIAuthoritySurface;
  const args = surface ? managedCodexAuthorityArguments(options, surface) : [];
  if (surface?.nativeMultiAgent === "disabled"
      || (!surface && ["Agent", "Task", "Workflow"].some((tool) => denied.has(tool)))) {
    // North is the canonical two-tier spawn surface; native Codex subagents would
    // create an unobserved third authority path even for orchestrators.
    args.push("--disable", "multi_agent");
  }
  if (!surface
      && (denied.has("mcp__north__spawn") || denied.has("mcp__north__dispatch"))) {
    args.push("--config", `mcp_servers.north.enabled_tools=${JSON.stringify(CODEX_WORKER_NORTH_ENABLED_TOOLS)}`);
  }
  if (surface) {
    args.push("--sandbox", surface.sandbox);
    if (surface.web === "disabled")
      args.push("--config", 'web_search="disabled"');
  }
  return args;
}

function tomlStringMap(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(",")}}`;
}

function defaultCodexProjectRoot(cwd: string): string {
  return trustedGitProjectRoot(cwd);
}

function managedDeveloperInstructions(options: any): string {
  if (typeof options?.systemPrompt !== "string" || !options.systemPrompt.trim())
    throw new ProviderRetrySafeError("openai_developer_instructions_contract_missing");
  return options.systemPrompt;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Prove the selected Codex home will natively load the one canonical global
 * AGENTS source. Project instructions remain explicit developer instructions;
 * duplicating the global constitution there would give it two prompt entries.
 */
export function assertCodexGlobalAgentsForEnvironment(
  env: NodeJS.ProcessEnv,
  developerInstructions: string,
): void {
  // Codex has no supported switch that suppresses only CODEX_HOME/AGENTS.md:
  // project_doc_max_bytes=0 suppresses project discovery, not global guidance.
  // Pretending AGENT_LAWS=off worked would silently diverge from Anthropic.
  if (env.AGENT_LAWS === "off")
    throw new ProviderRetrySafeError("openai_agent_laws_opt_out_unenforceable");
  let canonical;
  try { canonical = canonicalGlobalAgents(env); }
  catch (cause) {
    throw new ProviderRetrySafeError("openai_canonical_global_agents_unavailable", { cause });
  }
  if (!canonical) return;

  const codexHome = env.CODEX_HOME?.trim();
  if (!codexHome)
    throw new ProviderRetrySafeError("openai_codex_home_missing");
  const target = resolve(codexHome, "AGENTS.md");
  const override = resolve(codexHome, "AGENTS.override.md");
  try {
    lstatSync(override);
    throw new ProviderRetrySafeError("openai_global_agents_override_present");
  } catch (error) {
    if (error instanceof ProviderRetrySafeError) throw error;
    if (!isMissing(error))
      throw new ProviderRetrySafeError("openai_global_agents_override_uninspectable", { cause: error });
  }

  let targetRealpath: string;
  let targetInfo;
  try {
    targetInfo = statSync(target);
    targetRealpath = realpathSync(target);
  } catch (cause) {
    throw new ProviderRetrySafeError("openai_target_global_agents_unavailable", { cause });
  }
  if (!targetInfo.isFile())
    throw new ProviderRetrySafeError("openai_target_global_agents_not_regular_file");
  let targetBytes: Buffer;
  try { targetBytes = readFileSync(target); }
  catch (cause) {
    throw new ProviderRetrySafeError("openai_target_global_agents_unavailable", { cause });
  }
  if (targetInfo.size > GLOBAL_AGENTS_MAX_BYTES || targetBytes.byteLength > GLOBAL_AGENTS_MAX_BYTES)
    throw new ProviderRetrySafeError("openai_target_global_agents_oversized");
  try { new TextDecoder("utf-8", { fatal: true }).decode(targetBytes); }
  catch (cause) {
    throw new ProviderRetrySafeError("openai_target_global_agents_invalid_utf8", { cause });
  }
  if (targetRealpath !== canonical.realpath || !targetBytes.equals(canonical.bytes))
    throw new ProviderRetrySafeError("openai_target_global_agents_not_canonical");
  if (developerInstructions.includes(canonical.text.trim()))
    throw new ProviderRetrySafeError("openai_global_agents_duplicated_in_developer_instructions");
}

function managedCodexTargetEnvironment(
  options: any,
  target: RoutingTarget | undefined,
): NodeJS.ProcessEnv {
  let env: NodeJS.ProcessEnv;
  try {
    env = providerEnvironmentForTarget("openai", target, { env: options.env });
  } catch (cause) {
    throw new ProviderRetrySafeError("openai_target_environment_invalid", { cause });
  }
  assertCodexGlobalAgentsForEnvironment(env, managedDeveloperInstructions(options));
  return env;
}

function managedCodexAuthorityArguments(
  options: any,
  surface: OpenAIAuthoritySurface,
): string[] {
  // This helper is also exported indirectly through codexHarnessArguments, so
  // retain the same fail-closed envelope check as the executable adapter.
  if (!hasCanonicalHarnessAuthority(options, "openai"))
    throw new ProviderRetrySafeError("openai_harness_authority_seal_missing");
  validateManagedExecutionEnvelope("openai", [...surface.capabilities], options);
  admitPinnedProvider("openai", surface.capabilities);
  const north = options.mcpServers.north;
  const cwd = realpathSync(options.cwd ?? process.cwd());
  const projectRoot = defaultCodexProjectRoot(cwd);
  const northEnv = managedNorthMcpEnvironment(north.env);
  const developerInstructions = managedDeveloperInstructions(options);
  const args = [
    // Auth still comes from the selected CODEX_HOME, but its config.toml (and
    // therefore ambient Linear/Fram MCPs and plugin state) does not.
    "--strict-config",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--disable", "plugins",
    // The root requirements layer enforces allow_managed_hooks_only=true and
    // pins the exact North Pre/Post surface. User/session config cannot enable
    // that policy in Codex 0.144, so admission parses /etc requirements itself;
    // this flag only keeps the pinned stable feature explicitly on.
    "--enable", "hooks",
    // Preserve North/Gaffer/project authority at developer precedence. Managed
    // task stdin contains only the task and can never override this contract.
    "--config", `developer_instructions=${JSON.stringify(developerInstructions)}`,
    // Pin Codex's normal Git-root discovery and mark that canonical root
    // untrusted at CLI precedence. Project .codex layers are ignored. The
    // provider-neutral harness injects its bounded root-to-cwd project AGENTS
    // block exactly once, so native project-doc loading is disabled here.
    "--config", 'project_root_markers=[".git"]',
    "--config", `projects.${JSON.stringify(projectRoot)}.trust_level="untrusted"`,
    "--config", "project_doc_max_bytes=0",
    // Reconstitute only the canonical North stdio server proven by admission.
    // Managed requirements remain non-bypassable, and system config may still
    // contribute administrator-approved MCPs. User/account/project MCPs do not.
    "--config", `mcp_servers.north.command=${JSON.stringify(north.command)}`,
    "--config", `mcp_servers.north.args=${JSON.stringify(north.args)}`,
    "--config", `mcp_servers.north.env=${tomlStringMap(northEnv)}`,
    "--config", "mcp_servers.north.enabled=true",
    "--config", "mcp_servers.north.required=true",
  ];
  args.push(
    "--config",
    `mcp_servers.north.enabled_tools=${JSON.stringify(surface.northEnabledTools)}`,
  );
  return args;
}

export function codexGlobalArguments(options: any): string[] {
  void options;
  return [];
}

export function probeCodex(target?: RoutingTarget): ProviderAvailability {
  return probeOpenAI(target);
}

function validateOpenAIHarness(options: any): GafferCapability[] | undefined {
  if (options?.northCapabilities === undefined) return undefined;
  if (!hasCanonicalHarnessAuthority(options, "openai"))
    throw new ProviderRetrySafeError("openai_harness_authority_seal_missing");
  const surface = compileProviderAuthoritySurface("openai", options) as OpenAIAuthoritySurface;
  const capabilities = [...surface.capabilities];
  validateManagedExecutionEnvelope("openai", capabilities, options);
  admitPinnedProvider("openai", capabilities);
  managedDeveloperInstructions(options);
  if (surface.sandbox === "workspace-write") {
    let cwd: string;
    let projectRoot: string;
    try {
      cwd = realpathSync(options?.cwd ?? process.cwd());
      projectRoot = defaultCodexProjectRoot(cwd);
    } catch (cause) {
      throw new ProviderRetrySafeError("openai_write_workspace_identity_unavailable", { cause });
    }
    // Codex's unified-exec hook intentionally omits a per-call workdir. The
    // clock invariant therefore relies on the other half of the executable
    // boundary too: workspace-write has no --add-dir, and the admitted cwd is
    // the canonical project root. A client project root appears in common hook
    // cwd; a non-client root cannot sandbox-write a client checkout.
    if (cwd !== projectRoot)
      throw new ProviderRetrySafeError("openai_write_workspace_must_be_project_root");
  }
  return capabilities;
}

type ManagedHooksProbe = () => void;

async function admitOpenAIWithManagedHooksProbe(
  options: any,
  target: RoutingTarget | undefined,
  assertManagedHooks: ManagedHooksProbe,
  resolveCommand: ManagedCommandResolver = trustedManagedCodexExecutable,
): Promise<void> {
  const capabilities = validateOpenAIHarness(options);
  if (!capabilities) return;
  assertManagedHooks();
  // Resolve the root-trusted executable before admission can publish the route
  // or construct a provider query. The one-use receipt closes the async
  // admit -> synchronous query seam without re-running a fallible resolver
  // after onRoute.
  const resolvedCommand = resolveManagedCommand(resolveCommand);
  managedCodexTargetEnvironment(options, target);
  await admitExecution("openai", capabilities, options?.cwd ?? process.cwd(), options, target);
  recordManagedCommand(options, resolvedCommand);
}

export async function admitOpenAI(options: any, target?: RoutingTarget): Promise<void> {
  await admitOpenAIWithManagedHooksProbe(
    options, target, assertInstalledManagedCodexHooks,
  );
}

async function initialPrompt(value: string | AsyncIterable<any>): Promise<string> {
  if (typeof value === "string") return value;
  const it = value[Symbol.asyncIterator]();
  try {
    const first = await it.next();
    if (first.done) return "";
    const v = first.value;
    if (typeof v === "string") return v;
    if (v?.type === "user" && typeof v.message?.content === "string") return v.message.content;
    if (v?.type === "user" && Array.isArray(v.message?.content))
      return v.message.content.map((x: any) => x.text ?? "").join("\n");
    return String(v?.text ?? v?.content ?? v ?? "");
  } finally {
    try { await it.return?.(); } catch { /* provider teardown owns the terminal error */ }
  }
}

function modelForCodex(model?: string): string | undefined {
  // Anthropic aliases have no valid cross-provider meaning. An explicit OpenAI
  // model is honored; semantic/default aliases defer to the user's Codex config.
  if (!model || /^(sonnet|opus|haiku|fable|economy|standard|senior|frontier)/.test(model)) return undefined;
  return model;
}

const CODEX_SUPERVISOR_GRACE_MS = 1_750;
const CODEX_SUPERVISOR_KILL_MS = 750;
const CODEX_PROMPT_HEADER = "NORTH_CODEX_PROMPT ";
const CODEX_PROMPT_MAX_BYTES = 16 * 1024 * 1024;
const CODEX_SUPERVISOR_STATUS_MAX_BYTES = 4 * 1024;
const CODEX_SUPERVISOR_STATUS_MAX_FRAMES = 4;

function supervisorExited(child: ChildProcessWithoutNullStreams): boolean {
  // An async spawn failure has no pid and emits `error`, not `exit`.
  return child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
}

function waitForExitBounded(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (supervisorExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    // Listen first, then re-check state to close the exit-before-listener race.
    child.once("exit", onExit);
    if (supervisorExited(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(supervisorExited(child)), timeoutMs);
  });
}

function closeSupervisorControl(child: ChildProcessWithoutNullStreams): void {
  try { child.stdin.end(); } catch { /* already closed */ }
}

function destroySupervisorControl(child: ChildProcessWithoutNullStreams): void {
  try { child.stdin.destroy(); } catch { /* already closed */ }
}

function destroyCodexPipes(child: ChildProcessWithoutNullStreams): void {
  try { child.stdin.destroy(); } catch { /* already closed */ }
  try { child.stdout.destroy(); } catch { /* already closed */ }
  try { child.stderr.destroy(); } catch { /* already closed */ }
  const status = (child.stdio as any[])[3];
  try { status?.destroy(); } catch { /* already closed */ }
  destroySupervisorControl(child);
}

async function terminateCodexProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  // Closing supervisor stdin asks it to terminate and reap the complete Codex
  // process group. The prompt is length-framed and stdin deliberately remains
  // open afterwards, so the kernel generates this same EOF if North is
  // SIGKILLed; cleanup does not depend on a live Bun callback.
  closeSupervisorControl(child);
  if (!await waitForExitBounded(child, CODEX_SUPERVISOR_GRACE_MS)) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    if (!await waitForExitBounded(child, CODEX_SUPERVISOR_KILL_MS)) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await waitForExitBounded(child, CODEX_SUPERVISOR_KILL_MS);
    }
  }
  destroyCodexPipes(child);
}

interface SupervisorObservation {
  started: Promise<"started" | "unavailable">;
  completed: Promise<number>;
}

function observeSupervisor(
  child: ChildProcessWithoutNullStreams,
): SupervisorObservation {
  const status = (child.stdio as any[])[3] as NodeJS.ReadableStream | undefined;
  let startedSettled = false;
  let resolveStarted!: (value: "started" | "unavailable") => void;
  let rejectStarted!: (error: unknown) => void;
  const started = new Promise<"started" | "unavailable">((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const settleStarted = (value: "started" | "unavailable") => {
    if (startedSettled) throw new Error("openai_provider_execution_failed");
    startedSettled = true;
    resolveStarted(value);
  };
  const completed = (async (): Promise<number> => {
    if (!status) throw new Error("openai_provider_execution_failed");
    const frames = new StrictJsonlFrames({
      label: "Codex supervisor status",
      maxLineBytes: CODEX_SUPERVISOR_STATUS_MAX_BYTES,
      maxTotalBytes: CODEX_SUPERVISOR_STATUS_MAX_BYTES,
      maxFrames: CODEX_SUPERVISOR_STATUS_MAX_FRAMES,
    });
    let unavailable = false;
    for await (const chunk of status) {
      for (const line of frames.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      )) {
        if (line === "STARTED") {
          if (unavailable) throw new Error("openai_provider_execution_failed");
          settleStarted("started");
          continue;
        }
        if (line === "UNAVAILABLE") {
          if (startedSettled || unavailable)
            throw new Error("openai_provider_execution_failed");
          unavailable = true;
          settleStarted("unavailable");
          continue;
        }
        const exit = /^EXIT (0|[1-9][0-9]{0,2})$/.exec(line);
        const code = exit ? Number(exit[1]) : NaN;
        if (!Number.isInteger(code) || code > 255 || !startedSettled)
          throw new Error("openai_provider_execution_failed");
        return code;
      }
    }
    frames.finish();
    throw new Error("openai_provider_execution_failed");
  })();
  void completed.catch((error) => {
    if (!startedSettled) {
      startedSettled = true;
      rejectStarted(error);
    }
  });
  return { started, completed };
}

async function writeSupervisorPrompt(
  child: ChildProcessWithoutNullStreams,
  prompt: string,
): Promise<void> {
  const bytes = Buffer.from(prompt, "utf8");
  if (bytes.byteLength > CODEX_PROMPT_MAX_BYTES)
    throw new Error("openai_provider_execution_failed");
  const frame = Buffer.concat([
    Buffer.from(`${CODEX_PROMPT_HEADER}${bytes.byteLength}\n`, "utf8"),
    bytes,
  ]);
  await new Promise<void>((resolve, reject) => {
    child.stdin.write(frame, (error) => error ? reject(error) : resolve());
  });
}

type JsonObject = Record<string, unknown>;
interface ExactCodexUsage extends TerminalTokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

const CODEX_JSONL_MAX_LINE_BYTES = 1024 * 1024;
const CODEX_JSONL_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const CODEX_JSONL_MAX_EVENTS = 10_000;
const CODEX_ID_MAX_BYTES = 512;

function objectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length
      || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} has an unknown or missing field`);
  }
}

function boundedProtocolString(value: unknown, label: string, maxBytes = CODEX_ID_MAX_BYTES): string {
  if (typeof value !== "string" || !value || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a bounded canonical string`);
  }
  return value;
}

function protocolId(value: unknown, label: string): string {
  const id = boundedProtocolString(value, label);
  if (!/^[A-Za-z0-9._:-]+$/.test(id))
    throw new Error(`${label} must be a canonical protocol id`);
  return id;
}

function validateCodexItem(value: unknown): { type: string; text?: string } {
  const item = objectValue(value, "Codex item");
  const type = boundedProtocolString(item.type, "Codex item type");
  protocolId(item.id, "Codex item id");
  // Item payloads are provider-incidental, not North authority. Keep them
  // strictly framed/parsed/bounded and require stable identity, but do not
  // freeze Codex's evolving command/MCP/web/todo payload union here. Only the
  // final agent text is consumed by North, so that field alone is typed.
  if (type === "agent_message") {
    if (typeof item.text !== "string")
      throw new Error("Codex agent-message text must be a string");
    return { type, text: item.text };
  }
  return { type };
}

function exactUsage(value: unknown): ExactCodexUsage {
  const usage = objectValue(value, "Codex terminal usage");
  exactKeys(
    usage,
    ["cached_input_tokens", "input_tokens", "output_tokens", "reasoning_output_tokens"],
    "Codex terminal usage",
  );
  const counter = (name: string): number => {
    const token = usage[name];
    if (typeof token !== "number" || !Number.isSafeInteger(token) || token < 0)
      throw new Error(`Codex terminal usage ${name} is invalid`);
    return token;
  };
  const inputTokens = counter("input_tokens");
  const cachedInputTokens = counter("cached_input_tokens");
  const outputTokens = counter("output_tokens");
  const reasoningOutputTokens = counter("reasoning_output_tokens");
  if (cachedInputTokens > inputTokens || reasoningOutputTokens > outputTokens
      || !Number.isSafeInteger(inputTokens + outputTokens)) {
    throw new Error("Codex terminal usage counters are incoherent");
  }
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
  };
}

interface CodexProtocolResult {
  text?: string;
  usage?: ExactCodexUsage;
}

class CodexExecProtocol {
  private phase: "thread" | "turn" | "running" | "completed" = "thread";
  private usage?: ExactCodexUsage;

  accept(line: string): CodexProtocolResult {
    if (this.phase === "completed")
      throw new Error("Codex emitted an event after its terminal");
    const event = objectValue(parseStrictJson(line, "Codex exec event", {
      maxBytes: CODEX_JSONL_MAX_LINE_BYTES,
      maxDepth: 64,
      maxNodes: 50_000,
    }), "Codex exec event");
    const type = event.type;
    if (type === "error") {
      exactKeys(event, ["message", "type"], "Codex error event");
      boundedProtocolString(event.message, "Codex error message", CODEX_JSONL_MAX_LINE_BYTES);
      throw new Error("Codex emitted an unrecoverable error");
    }
    if (type === "thread.started") {
      if (this.phase !== "thread") throw new Error("Codex thread start is out of order");
      exactKeys(event, ["thread_id", "type"], "Codex thread-start event");
      protocolId(event.thread_id, "Codex thread id");
      this.phase = "turn";
      return {};
    }
    if (type === "turn.started") {
      if (this.phase !== "turn") throw new Error("Codex turn start is out of order");
      exactKeys(event, ["type"], "Codex turn-start event");
      this.phase = "running";
      return {};
    }
    if (type === "turn.failed") {
      if (this.phase !== "running") throw new Error("Codex turn failure is out of order");
      exactKeys(event, ["error", "type"], "Codex turn-failed event");
      const error = objectValue(event.error, "Codex turn failure");
      exactKeys(error, ["message"], "Codex turn failure");
      boundedProtocolString(error.message, "Codex turn failure message", CODEX_JSONL_MAX_LINE_BYTES);
      throw new Error("Codex turn failed");
    }
    if (type === "turn.completed") {
      if (this.phase !== "running") throw new Error("Codex turn terminal is out of order");
      exactKeys(event, ["type", "usage"], "Codex turn-completed event");
      this.usage = exactUsage(event.usage);
      this.phase = "completed";
      return { usage: this.usage };
    }
    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      if (this.phase !== "running") throw new Error("Codex item event is out of order");
      exactKeys(event, ["item", "type"], "Codex item event");
      const item = validateCodexItem(event.item);
      return type === "item.completed" && item.type === "agent_message"
        ? { text: item.text }
        : {};
    }
    throw new Error("Codex emitted an unknown event");
  }

  finish(): ExactCodexUsage {
    if (this.phase !== "completed" || !this.usage)
      throw new Error("Codex closed without one successful terminal");
    return this.usage;
  }
}

function codexUsage(usage: ExactCodexUsage): {
  usage: TerminalTokenUsage;
  metadata: AdapterUsageMetadata;
} {
  // Codex says cached_input_tokens is a subset of input_tokens and
  // reasoning_output_tokens is a subset of output_tokens. The adapter owns this
  // formula so the provider-neutral recorder can never add either subset twice.
  return {
    usage,
    metadata: {
      provider: "openai",
      terminal_count: 1,
      scope: "codex_fresh_invocation_thread_cumulative",
      total_status: "exact",
      total_tokens: usage.input_tokens! + usage.output_tokens!,
    },
  };
}

class CodexQuery implements AgentQuery {
  private child?: ChildProcessWithoutNullStreams;
  private interruptPromise?: Promise<void>;
  constructor(
    private prompt: string | AsyncIterable<any>,
    private options: any,
    private target?: RoutingTarget,
    private admitted = false,
    private assertManagedHooks: ManagedHooksProbe = assertInstalledManagedCodexHooks,
    private resolveManagedCommand: ManagedCommandResolver = trustedManagedCodexExecutable,
    private admittedManagedCommand?: string,
  ) {}

  supportsInFlightEscalation(): boolean { return false; }

  async interrupt(): Promise<void> {
    if (this.interruptPromise) return this.interruptPromise;
    const child = this.child;
    if (!child) return;
    const cleanup = (async () => {
      // Always address the process group, even after the direct child exited.
      await terminateCodexProcessTree(child);
    })();
    this.interruptPromise = cleanup;
    try { await cleanup; }
    finally {
      if (this.interruptPromise === cleanup) this.interruptPromise = undefined;
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<any> {
    const admitted = this.admitted;
    this.admitted = false;
    if (admitted) validateOpenAIHarness(this.options);
    else await admitOpenAIWithManagedHooksProbe(
      this.options, this.target, this.assertManagedHooks, this.resolveManagedCommand,
    );
    const managed = this.options?.northCapabilities !== undefined;
    // Repeat the root-managed hook proof at the final pre-spawn seam. This
    // closes the filesystem race between routed admission and Codex startup.
    if (managed) this.assertManagedHooks();
    const env = managed
      ? managedCodexTargetEnvironment(this.options, this.target)
      : providerEnvironmentForTarget("openai", this.target, { env: this.options.env });
    const task = await initialPrompt(this.prompt);
    const prompt = managed
      ? task
      : this.options.systemPrompt
      ? `${this.options.systemPrompt}\n\n## Task\n${task}`
      : task;
    const args = [
      ...codexGlobalArguments(this.options),
      "exec", ...codexConfigArguments(env), ...codexHarnessArguments(this.options),
      "--json", "--color", "never", "--skip-git-repo-check",
    ];
    const model = modelForCodex(this.options.model);
    if (model) args.push("--model", model);
    if (this.options.effort) args.push("--config", `model_reasoning_effort=${JSON.stringify(this.options.effort)}`);
    if (this.options.cwd) args.push("--cd", this.options.cwd);
    args.push("-");
    // Managed admission resolved this before onRoute and left a one-use
    // receipt. Direct adapter calls perform the same admission lazily above.
    // Unmanaged sessions retain the ordinary CLI string lookup and never enter
    // the trusted-runtime resolver path.
    const resolvedCommand = managed
      ? this.admittedManagedCommand ?? takeManagedCommand(this.options)
      : env.NORTH_CODEX_BIN ?? "codex";
    this.admittedManagedCommand = undefined;
    if (!resolvedCommand)
      throw new ProviderRetrySafeError("openai_managed_command_receipt_unavailable");
    const child = spawn(
      process.execPath,
      [CODEX_SUPERVISOR, resolvedCommand, ...args],
      {
        cwd: this.options.cwd ?? process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        detached: false,
      },
    ) as unknown as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stdin.on("error", () => { /* child process error is classified below */ });
    const supervision = observeSupervisor(child);
    let providerStarted = false;
    let result = "";
    const frames = new StrictJsonlFrames({
      label: "Codex exec",
      maxLineBytes: CODEX_JSONL_MAX_LINE_BYTES,
      maxTotalBytes: CODEX_JSONL_MAX_TOTAL_BYTES,
      maxFrames: CODEX_JSONL_MAX_EVENTS,
    });
    const protocol = new CodexExecProtocol();
    let usage: ExactCodexUsage | undefined;
    child.stderr.resume();
    try {
      const startStatus = await supervision.started;
      if (startStatus === "unavailable") {
        throw new ProviderRetrySafeError(
          "openai_provider_executable_unavailable_before_acceptance",
        );
      }
      providerStarted = true;
      await writeSupervisorPrompt(child, prompt);
      for await (const chunk of child.stdout) {
        for (const line of frames.push(chunk)) {
          const accepted = protocol.accept(line);
          // Every accepted native frame is activity, including command/MCP
          // item frames that yield no assistant text. The production renewer is
          // throttled, so a noisy provider cannot create unbounded graph writes.
          renewHarnessPresence(this.options);
          if (accepted.text !== undefined) {
            result = accepted.text || result;
            if (accepted.text) {
              yield {
                type: "assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: accepted.text }],
                },
              };
            }
          }
          if (accepted.usage) usage = accepted.usage;
        }
      }
      frames.finish();
      const supervisorExit = await supervision.completed;
      if (supervisorExit !== 0)
        throw new Error("openai_provider_execution_failed");
      usage = protocol.finish();
    } catch (error) {
      try { await this.interrupt(); } catch { /* cleanup must not replace the provider error */ }
      try { await supervision.completed; } catch { /* preserve the provider error */ }
      if (error instanceof ProviderRetrySafeError && !providerStarted)
        throw error;
      throw new Error("openai_provider_execution_failed");
    } finally {
      destroyCodexPipes(child);
      this.child = undefined;
    }
    if (!usage) throw new Error("openai_provider_execution_failed");
    const normalizedUsage = codexUsage(usage);
    yield {
      type: "result", subtype: "success", result,
      num_turns: 1,
      usage: normalizedUsage.usage,
      _north_usage: normalizedUsage.metadata,
    };
  }
}

/**
 * @internal Hermetic test seam. Deliberately not exported by providers/index;
 * production remains closed over assertInstalledManagedCodexHooks below.
 */
export interface InternalOpenAIProviderTestRuntime {
  resolveManagedCommand?: () => string;
  onQueryConstruction?: () => void;
}

export function internalOpenAIProviderWithManagedHooksProbeForTest(
  assertManagedHooks: ManagedHooksProbe,
  runtime: InternalOpenAIProviderTestRuntime = {},
): AgentProvider {
  const resolveCommand = runtime.resolveManagedCommand ?? trustedManagedCodexExecutable;
  return {
    id: "openai",
    liveInput: "unsupported",
    probe: probeCodex,
    admit: ({ options, target }) =>
      admitOpenAIWithManagedHooksProbe(options, target, assertManagedHooks, resolveCommand),
    query: ({ prompt, options, target }) => {
      runtime.onQueryConstruction?.();
      const admitted = consumeExecutionAdmission("openai", options);
      return new CodexQuery(
        prompt,
        options,
        target,
        admitted,
        assertManagedHooks,
        resolveCommand,
        admitted ? takeManagedCommand(options) : undefined,
      );
    },
  };
}

export const openaiProvider: AgentProvider = Object.freeze(
  internalOpenAIProviderWithManagedHooksProbeForTest(assertInstalledManagedCodexHooks),
);
