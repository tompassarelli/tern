import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { ProviderRetrySafeError, type AgentProvider, type AgentQuery, type ProviderAvailability } from "./types";
import type { RoutingTarget } from "./types";
import { probeOpenAI } from "../provider-routing";
import type { AdapterUsageMetadata, TerminalTokenUsage, TokenTotalStatus } from "../usage";
import { codexConfigArguments, providerEnvironmentForTarget } from "../accounts";
import {
  requireGafferCapabilities, type GafferCapability,
} from "../gaffer-capabilities";
import {
  admitExecution, admitPinnedProvider, consumeExecutionAdmission,
  managedNorthMcpEnvironment, validateManagedExecutionEnvelope,
} from "../execution-admission";
import {
  canonicalGlobalAgents, GLOBAL_AGENTS_MAX_BYTES,
} from "../harness";

function command(env: NodeJS.ProcessEnv): string { return env.NORTH_CODEX_BIN ?? "codex"; }

const WORKER_NORTH_TOOLS = [
  "capture", "tell", "evidence_record", "show", "ready", "next", "board", "plate",
];
const ORCHESTRATOR_NORTH_TOOLS = [...WORKER_NORTH_TOOLS, "dispatch", "spawn"];

/** Per-invocation Codex restrictions derived from the provider-neutral harness contract. */
export function codexHarnessArguments(options: any): string[] {
  const denied = new Set(Array.isArray(options?.disallowedTools) ? options.disallowedTools : []);
  const capabilities = codexCapabilities(options);
  const args = capabilities ? managedCodexAuthorityArguments(options, capabilities) : [];
  if (capabilities || ["Agent", "Task", "Workflow"].some((tool) => denied.has(tool))) {
    // North is the canonical two-tier spawn surface; native Codex subagents would
    // create an unobserved third authority path even for orchestrators.
    args.push("--disable", "multi_agent");
  }
  if (!capabilities
      && (denied.has("mcp__north__spawn") || denied.has("mcp__north__dispatch"))) {
    args.push("--config", `mcp_servers.north.enabled_tools=${JSON.stringify(WORKER_NORTH_TOOLS)}`);
  }
  if (capabilities) {
    args.push("--sandbox", capabilities.includes("shell.readonly") ? "read-only" : "workspace-write");
    if (!capabilities.includes("web")) args.push("--config", 'web_search="disabled"');
  }
  return args;
}

function codexCapabilities(options: any): GafferCapability[] | undefined {
  if (options?.northCapabilities === undefined) return undefined;
  return requireGafferCapabilities(options.northCapabilities, "northCapabilities");
}

function tomlStringMap(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(",")}}`;
}

function defaultCodexProjectRoot(cwd: string): string {
  const git = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
  const root = git.status === 0 ? git.stdout.trim() : "";
  return realpathSync(root || cwd);
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
  capabilities: GafferCapability[],
): string[] {
  // This helper is also exported indirectly through codexHarnessArguments, so
  // retain the same fail-closed envelope check as the executable adapter.
  validateManagedExecutionEnvelope("openai", capabilities, options);
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
    // Managed North owns its lifecycle and authority hooks outside Codex.
    // Disable native hooks entirely: account/project hooks are ambient
    // authority, and Codex 0.144 has no "managed hooks only" config key.
    "--disable", "hooks",
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
    `mcp_servers.north.enabled_tools=${JSON.stringify(
      capabilities.includes("coordination") ? ORCHESTRATOR_NORTH_TOOLS : WORKER_NORTH_TOOLS,
    )}`,
  );
  return args;
}

export function codexGlobalArguments(options: any): string[] {
  return codexCapabilities(options)?.includes("web") ? ["--search"] : [];
}

export function probeCodex(target?: RoutingTarget): ProviderAvailability {
  return probeOpenAI(target);
}

function validateOpenAIHarness(options: any): GafferCapability[] | undefined {
  const capabilities = codexCapabilities(options);
  if (!capabilities) return undefined;
  validateManagedExecutionEnvelope("openai", capabilities, options);
  admitPinnedProvider("openai", capabilities);
  managedDeveloperInstructions(options);
  return capabilities;
}

export async function admitOpenAI(options: any, target?: RoutingTarget): Promise<void> {
  const capabilities = validateOpenAIHarness(options);
  if (!capabilities) return;
  await admitExecution("openai", capabilities, options?.cwd ?? process.cwd(), options);
  // AgentProvider.admit runs before routed onRoute/query construction. Resolve
  // the exact selected account here so a bad CODEX_HOME cannot publish a route
  // as active or trigger provider work. Query repeats this proof at spawn time.
  managedCodexTargetEnvironment(options, target);
}

async function initialPrompt(value: string | AsyncIterable<any>): Promise<string> {
  if (typeof value === "string") return value;
  const it = value[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return "";
  const v = first.value;
  if (typeof v === "string") return v;
  if (v?.type === "user" && typeof v.message?.content === "string") return v.message.content;
  if (v?.type === "user" && Array.isArray(v.message?.content))
    return v.message.content.map((x: any) => x.text ?? "").join("\n");
  return String(v?.text ?? v?.content ?? v ?? "");
}

function modelForCodex(model?: string): string | undefined {
  // Anthropic aliases have no valid cross-provider meaning. An explicit OpenAI
  // model is honored; semantic/default aliases defer to the user's Codex config.
  if (!model || /^(sonnet|opus|haiku|fable|economy|standard|senior|frontier)/.test(model)) return undefined;
  return model;
}

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("close", resolve));
}

function observedToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function codexUsage(raw: any, terminalCount: number): {
  usage: TerminalTokenUsage;
  metadata: AdapterUsageMetadata;
} {
  const inputTokens = observedToken(raw?.input_tokens);
  const outputTokens = observedToken(raw?.output_tokens);
  const cachedInputTokens = observedToken(raw?.cached_input_tokens);
  const reasoningOutputTokens = observedToken(raw?.reasoning_output_tokens);
  const usage: TerminalTokenUsage = {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cached_input_tokens: cachedInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoning_output_tokens: reasoningOutputTokens } : {}),
  };
  // Codex says cached_input_tokens is a subset of input_tokens and
  // reasoning_output_tokens is a subset of output_tokens. The adapter owns this
  // formula so the provider-neutral recorder can never add either subset twice.
  const totalStatus: TokenTotalStatus = terminalCount === 0
    ? "unknown_no_terminal"
    : inputTokens === undefined || outputTokens === undefined
      ? "unknown_incomplete_terminal"
      : "exact";
  return {
    usage,
    metadata: {
      provider: "openai",
      terminal_count: terminalCount,
      scope: "codex_fresh_invocation_thread_cumulative",
      total_status: totalStatus,
      ...(totalStatus === "exact" ? { total_tokens: inputTokens! + outputTokens! } : {}),
    },
  };
}

class CodexQuery implements AgentQuery {
  private child?: ChildProcessWithoutNullStreams;
  constructor(
    private prompt: string | AsyncIterable<any>,
    private options: any,
    private target?: RoutingTarget,
    private admitted = false,
  ) {}

  supportsInFlightEscalation(): boolean { return false; }

  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<any> {
    const admitted = this.admitted;
    this.admitted = false;
    if (admitted) validateOpenAIHarness(this.options);
    else await admitOpenAI(this.options, this.target);
    const capabilities = codexCapabilities(this.options);
    const env = capabilities
      ? managedCodexTargetEnvironment(this.options, this.target)
      : providerEnvironmentForTarget("openai", this.target, { env: this.options.env });
    const task = await initialPrompt(this.prompt);
    const prompt = capabilities
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
    const child = spawn(command(env), args, { cwd: this.options.cwd ?? process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const launched = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.stdin.on("error", () => { /* child process error is classified below */ });
    try { await launched; }
    catch {
      this.child = undefined;
      throw new ProviderRetrySafeError("openai_provider_executable_unavailable_before_acceptance");
    }
    child.stdin.end(prompt);
    // Once the process has spawned, silence is not proof of non-acceptance: the
    // provider may have accepted work before the CLI emitted a recognized event.
    // Every subsequent failure therefore remains the original provider error.
    let result = "";
    let usage: any;
    let usageTerminalCount = 0;
    child.stderr.resume();
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        if (!line.trim()) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          const text = event.item.text ?? "";
          result = text || result;
          if (text) yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
        }
        if (event.type === "turn.completed") {
          usageTerminalCount++;
          usage = event.usage;
        }
        if (event.type === "error") throw new Error("openai_provider_execution_failed");
      }
      const code = await waitForClose(child);
      if (code !== 0) throw new Error("openai_provider_execution_failed");
    } catch (error) {
      try { await this.interrupt(); } catch { /* cleanup must not replace the provider error */ }
      throw error;
    } finally {
      this.child = undefined;
    }
    const normalizedUsage = codexUsage(usage, usageTerminalCount);
    yield {
      type: "result", subtype: "success", result,
      num_turns: 1,
      usage: normalizedUsage.usage,
      _north_usage: normalizedUsage.metadata,
    };
  }
}

export const openaiProvider: AgentProvider = {
  id: "openai",
  probe: probeCodex,
  admit: ({ options, target }) => admitOpenAI(options, target),
  query: ({ prompt, options, target }) => new CodexQuery(
    prompt, options, target, consumeExecutionAdmission("openai", options),
  ),
};
