import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import {
  ProviderRetrySafeError, type AgentProvider, type AgentQuery, type ProviderAvailability,
  type RoutingTarget,
} from "./types";
import { probeAnthropic } from "../provider-routing";
import { observeAnthropicQuery } from "./anthropic-observations";
import { providerEnvironmentForTarget } from "../accounts";
import { resolve } from "node:path";
import { requireGafferCapabilities } from "../gaffer-capabilities";
import {
  admitExecution, admitPinnedProvider, consumeExecutionAdmission,
  validateManagedExecutionEnvelope,
} from "../execution-admission";
import {
  READONLY_SHELL_SERVER, READONLY_SHELL_TOOL,
} from "../readonly-shell";
import {
  canonicalHarnessModelAvailability,
  COORDINATION_TOOLS, hasCanonicalAuthoringHooks, hasCanonicalHarnessAuthority, managedToolPolicy,
  NATIVE_AGENT_TOOLS, ORCHESTRATION_TOOLS,
} from "../harness";
import { validateModelAdmissionReceipt } from "../provider-model-observation-store";
import {
  createAnthropicProcessLifecycle, settleAnthropicProcessOwner,
  type AnthropicProcessLifecycle,
} from "./anthropic-process";

// Selection already proved a CLI-owned first-party Claude.ai session, and the
// target environment strips API-key, cloud, and alternate-endpoint transports.
// Claude Code Agent SDK 0.3.195 reports `none` for that subscription flow even
// though its current ApiKeySource declaration omits the runtime value.
const SUBSCRIPTION_SAFE_API_KEY_SOURCES = new Set(["oauth", "none"]);
export async function disposeAnthropicSdkQuery(
  rawQuery: Pick<Query, "return"> | undefined,
  lifecycle: AnthropicProcessLifecycle | undefined,
  abort: AbortController | undefined,
  graceMs?: number,
): Promise<void> {
  if (!lifecycle || !abort) {
    if (rawQuery) await rawQuery.return(undefined);
    return;
  }
  await settleAnthropicProcessOwner({
    lifecycle,
    abortController: abort,
    dispose: rawQuery ? () => rawQuery.return(undefined) : undefined,
    ...(graceMs === undefined ? {} : { disposalGraceMs: graceMs }),
  });
}

function exactStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function normalizedAnthropicMessage(message: any): any {
  if (!message || typeof message !== "object") return message;
  if (message.type === "system" && message.subtype === "init"
      && !SUBSCRIPTION_SAFE_API_KEY_SOURCES.has(message.apiKeySource)) {
    throw new Error("anthropic_subscription_authentication_required");
  }
  if (message.type === "result" && message.subtype !== "success") {
    return { ...message, errors: ["anthropic_provider_execution_failed"] };
  }
  if (message.type === "assistant" && message.error && message.message && typeof message.message === "object") {
    return { ...message, message: { ...message.message, content: [] } };
  }
  if (message.type === "auth_status") {
    return {
      ...message,
      output: [],
      ...(message.error === undefined ? {} : { error: "anthropic_provider_authentication_failed" }),
    };
  }
  if (message.type === "system" && message.subtype === "mirror_error") {
    return { ...message, error: "anthropic_provider_execution_failed" };
  }
  if (message.type === "system" && message.subtype === "status" && message.compact_error !== undefined) {
    return { ...message, compact_error: "anthropic_provider_execution_failed" };
  }
  return message;
}

export function normalizeAnthropicQueryDiagnostics(source: AgentQuery): AgentQuery {
  const failed = () => new Error("anthropic_provider_execution_failed");
  return {
    executionTransport: source.executionTransport ?? "anthropic-agent-sdk",
    interrupt: source.interrupt && (async () => {
      try { await source.interrupt!(); } catch { throw failed(); }
    }),
    close: source.close && (async () => {
      try { await source.close!(); } catch { throw failed(); }
    }),
    forceClose: source.forceClose && (() => {
      try { source.forceClose!(); } catch { /* host exit cannot expose diagnostics */ }
    }),
    setModel: source.setModel && (async (model) => {
      try { await source.setModel!(model); } catch { throw failed(); }
    }),
    applyFlagSettings: source.applyFlagSettings && (async (settings) => {
      try { await source.applyFlagSettings!(settings); } catch { throw failed(); }
    }),
    supportsInFlightEscalation: () => {
      try {
        return Boolean(source.setModel && source.applyFlagSettings && (source.supportsInFlightEscalation?.() ?? true));
      }
      catch { throw failed(); }
    },
    mcpActivity: source.mcpActivity?.bind(source),
    async *[Symbol.asyncIterator]() {
      try {
        for await (const message of source as AsyncIterable<any>) yield normalizedAnthropicMessage(message);
      } catch {
        throw failed();
      }
    },
  };
}

function validateAnthropicHarness(options: any): ReturnType<typeof requireGafferCapabilities> | undefined {
  if (!options || !("northCapabilities" in options)) return undefined;
  const capabilities = requireGafferCapabilities(
    options.northCapabilities, "northCapabilities",
  );
  if (!hasCanonicalHarnessAuthority(options, "anthropic"))
    throw new ProviderRetrySafeError("anthropic_harness_authority_seal_missing");
  validateManagedExecutionEnvelope("anthropic", capabilities, options);
  admitPinnedProvider("anthropic", capabilities);
  const policy = managedToolPolicy(capabilities);
  if (!Array.isArray(options.settingSources) || options.settingSources.length !== 0)
    throw new ProviderRetrySafeError("anthropic_setting_sources_must_be_isolated");
  if (options.strictMcpConfig !== true)
    throw new ProviderRetrySafeError("anthropic_strict_mcp_config_required");
  const denied = new Set(options.disallowedTools ?? []);
  const allowed = new Set(options.allowedTools ?? []);
  const requireDenied = (tools: string[], capability: string) => {
    if (tools.some((toolName) => !denied.has(toolName)))
      throw new ProviderRetrySafeError(
        `anthropic_adapter_did_not_enforce_absent_${capability}_capability`,
      );
  };
  const requireAllowed = (tools: string[], capability: string) => {
    if (tools.some((toolName) => !allowed.has(toolName)))
      throw new ProviderRetrySafeError(
        `anthropic_adapter_did_not_apply_${capability}_capability`,
      );
  };
  requireDenied(NATIVE_AGENT_TOOLS, "native_agent");
  requireAllowed(COORDINATION_TOOLS, "north");

  const exactCapability = (present: boolean, tools: string[], capability: string) => {
    if (present) requireAllowed(tools, capability);
    else requireDenied(tools, capability);
  };
  exactCapability(capabilities.includes("filesystem.read"), ["Read"], "filesystem_read");
  exactCapability(capabilities.includes("filesystem.search"), ["Grep", "Glob"], "filesystem_search");
  exactCapability(
    capabilities.includes("filesystem.write"),
    ["Edit", "Write", "NotebookEdit"],
    "filesystem_write",
  );
  exactCapability(capabilities.includes("web"), ["WebSearch", "WebFetch"], "web");

  if (capabilities.includes("shell")) {
    requireAllowed(["Bash"], "shell");
    requireDenied([READONLY_SHELL_TOOL], "readonly_shell");
  } else if (capabilities.includes("shell.readonly")) {
    requireDenied(["Bash"], "shell");
    requireAllowed([READONLY_SHELL_TOOL], "readonly_shell");
  } else {
    requireDenied(["Bash", READONLY_SHELL_TOOL], "shell");
  }

  const expectedMcpServers = [
    "north",
    ...(capabilities.includes("coordination") ? ["north-peer"] : []),
    ...(capabilities.includes("shell.readonly") ? [READONLY_SHELL_SERVER] : []),
  ];
  if (capabilities.includes("coordination")) {
    requireAllowed(ORCHESTRATION_TOOLS, "coordination");
    const peer = options.mcpServers?.["north-peer"];
    if (peer?.type !== "sdk" || peer.name !== "north-peer")
      throw new ProviderRetrySafeError("anthropic_coordination_server_contract_missing");
  } else {
    requireDenied(ORCHESTRATION_TOOLS, "coordination");
  }

  const permissionMode = capabilities.includes("filesystem.write") ? "acceptEdits" : "default";
  if (options.permissionMode !== permissionMode)
    throw new ProviderRetrySafeError("anthropic_permission_mode_contract_missing");
  if (capabilities.includes("shell.readonly")) {
    const readonly = options.mcpServers?.[READONLY_SHELL_SERVER];
    if (readonly?.type !== "sdk" || readonly.name !== READONLY_SHELL_SERVER) {
      throw new ProviderRetrySafeError("anthropic_readonly_shell_contract_missing");
    }
  }
  const actualMcpServers = Object.keys(options.mcpServers ?? {});
  if (!exactStrings(actualMcpServers, expectedMcpServers))
    throw new ProviderRetrySafeError("anthropic_mcp_server_surface_contract_missing");
  if (!exactStrings(options.tools, policy.tools))
    throw new ProviderRetrySafeError("anthropic_builtin_tool_surface_contract_missing");
  if (!exactStrings(options.allowedTools, policy.allowedTools))
    throw new ProviderRetrySafeError("anthropic_auto_approval_contract_missing");
  if (!exactStrings(options.disallowedTools, policy.disallowedTools))
    throw new ProviderRetrySafeError("anthropic_denied_tool_contract_missing");
  if (!hasCanonicalAuthoringHooks(options))
    throw new ProviderRetrySafeError("anthropic_authoring_guard_contract_missing");
  return capabilities;
}

export async function admitAnthropic(options: any, target?: RoutingTarget): Promise<void> {
  const capabilities = validateAnthropicHarness(options);
  if (!capabilities) return;
  const modelAvailability = canonicalHarnessModelAvailability(options, "anthropic");
  if (!modelAvailability)
    throw new ProviderRetrySafeError("anthropic_model_availability_authority_missing");
  if (modelAvailability.required) {
    if (!target || modelAvailability.targetId !== target.id
        || modelAvailability.model !== options.model
        || typeof options.model !== "string"
        || !await validateModelAdmissionReceipt(
          modelAvailability.receipt,
          target,
          options.model,
          modelAvailability.observationPath,
        )) {
      throw new ProviderRetrySafeError("anthropic_model_availability_unproven");
    }
  }
  await admitExecution("anthropic", capabilities, resolve(options.cwd ?? process.cwd()), options, target);
}

export interface AnthropicQueryRuntime {
  query: typeof query;
  observe: typeof observeAnthropicQuery;
  createLifecycle: typeof createAnthropicProcessLifecycle;
  admit?: typeof admitAnthropic;
}

export function createAnthropicQuery(
  args: Parameters<AgentProvider["query"]>[0],
  admitted: boolean,
  runtime: AnthropicQueryRuntime = {
    query,
    observe: observeAnthropicQuery,
    createLifecycle: createAnthropicProcessLifecycle,
    admit: admitAnthropic,
  },
): AgentQuery {
  let source: AgentQuery | undefined;
  let rawQuery: Query | undefined;
  let lifecycle: AnthropicProcessLifecycle | undefined;
  let ownedAbort: AbortController | undefined;
  let detachCallerAbort: (() => void) | undefined;
  let initialization: Promise<AgentQuery> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  const callerSignal = args.options.abortController?.signal;
  const ensureOpen = () => {
    if (closed || callerSignal?.aborted) throw new Error("anthropic_query_closed");
  };
  const closedBeforeConstruction = (error: unknown) => !lifecycle && !rawQuery
    && error instanceof Error && error.message === "anthropic_query_closed";
  const initialize = async (): Promise<AgentQuery> => {
    ensureOpen();
    if (source) return source;
    initialization ??= (async () => {
      if (admitted) validateAnthropicHarness(args.options);
      else await (runtime.admit ?? admitAnthropic)(args.options, args.target);
      // Admission may await a subscription control probe. Close or host abort
      // during that wait is sticky: never construct a lifecycle or SDK Query
      // after the preflight resumes.
      ensureOpen();
      admitted = true;
      ownedAbort = new AbortController();
      if (callerSignal) {
        const forward = () => ownedAbort?.abort(callerSignal.reason);
        if (callerSignal.aborted) forward();
        else {
          callerSignal.addEventListener("abort", forward, { once: true });
          detachCallerAbort = () => callerSignal.removeEventListener("abort", forward);
        }
      }
      lifecycle = runtime.createLifecycle();
      const options = {
        ...args.options,
        abortController: ownedAbort,
        spawnClaudeCodeProcess: lifecycle.spawnClaudeCodeProcess,
        env: providerEnvironmentForTarget("anthropic", args.target, { env: args.options.env }),
        // Continuation resume (thread 019f8ec5): North opens this turn to
        // continue a prior session rather than injecting into its closing
        // stream. `resume` rides the post-seal SDK options only — the sealed
        // `args.options` the harness composed stays byte-identical, so the
        // authority seal validated above is untouched.
        ...(args.resume ? { resume: args.resume } : {}),
      };
      try {
        rawQuery = runtime.query({ prompt: args.prompt, options });
        source = runtime.observe(
          normalizeAnthropicQueryDiagnostics({
            executionTransport: "anthropic-agent-sdk",
            interrupt: () => rawQuery!.interrupt(),
            close: async () => {
              try { await disposeAnthropicSdkQuery(rawQuery, lifecycle, ownedAbort); }
              finally { detachCallerAbort?.(); }
            },
            forceClose: () => lifecycle?.forceKill(),
            setModel: (model) => rawQuery!.setModel(model),
            applyFlagSettings: (settings) => rawQuery!.applyFlagSettings(settings as any),
            supportsInFlightEscalation: () => true,
            [Symbol.asyncIterator]: () => rawQuery![Symbol.asyncIterator](),
          }),
          { targetId: () => args.target?.id ?? "anthropic" },
        );
        return source;
      } catch {
        try { await disposeAnthropicSdkQuery(rawQuery, lifecycle, ownedAbort); }
        catch { /* initialization failure stays provider-private */ }
        detachCallerAbort?.();
        throw new Error("anthropic_provider_execution_failed");
      }
    })();
    return initialization;
  };
  return {
    executionTransport: "anthropic-agent-sdk",
    interrupt: async () => { await (await initialize()).interrupt?.(); },
    close: () => closePromise ??= (async () => {
      closed = true;
      // A lazy query that was never initialized owns no subprocess. Closing it
      // must remain a pure no-op rather than accidentally accepting a turn.
      if (!initialization && !source) return;
      try {
        const initialized = await initialization;
        await initialized?.close?.();
      } catch (error) {
        if (!closedBeforeConstruction(error)) throw error;
      }
    })(),
    forceClose: () => {
      closed = true;
      lifecycle?.forceKill();
    },
    setModel: async (model) => { await (await initialize()).setModel?.(model); },
    applyFlagSettings: async (settings) => {
      await (await initialize()).applyFlagSettings?.(settings);
    },
    supportsInFlightEscalation: () => source
      ? Boolean(source.setModel && source.applyFlagSettings
        && (source.supportsInFlightEscalation?.() ?? true))
      : true,
    async *[Symbol.asyncIterator]() {
      if (closed) return;
      try {
        for await (const message of await initialize()) yield message;
      } catch (error) {
        if (!closedBeforeConstruction(error)) throw error;
      }
    },
  };
}

const canonicalAnthropicProvider: AgentProvider = {
  id: "anthropic",
  liveInput: "streaming",
  probe(target): ProviderAvailability {
    return probeAnthropic(target);
  },
  admit: ({ options, target }) => admitAnthropic(options, target),
  query(args) {
    const admitted = consumeExecutionAdmission("anthropic", args.options);
    // Direct adapter callers are admitted lazily before SDK query construction;
    // routedQuery carries a one-use receipt from the same full preflight.
    return createAnthropicQuery(args, admitted);
  },
};

export const anthropicProvider: AgentProvider = Object.freeze(
  canonicalAnthropicProvider,
);
