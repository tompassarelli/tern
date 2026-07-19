import { query } from "@anthropic-ai/claude-agent-sdk";
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
  COORDINATION_TOOLS, hasCanonicalAuthoringHooks, managedToolPolicy,
  NATIVE_AGENT_TOOLS, ORCHESTRATION_TOOLS,
} from "../harness";

// Selection already proved a CLI-owned first-party Claude.ai session, and the
// target environment strips API-key, cloud, and alternate-endpoint transports.
// Claude Code Agent SDK 0.3.195 reports `none` for that subscription flow even
// though its current ApiKeySource declaration omits the runtime value.
const SUBSCRIPTION_SAFE_API_KEY_SOURCES = new Set(["oauth", "none"]);

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
    interrupt: source.interrupt && (async () => {
      try { await source.interrupt!(); } catch { throw failed(); }
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
    ["Edit", "Write", "MultiEdit", "NotebookEdit"],
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
  await admitExecution("anthropic", capabilities, resolve(options.cwd ?? process.cwd()), options, target);
}

function createAnthropicQuery(
  args: Parameters<AgentProvider["query"]>[0],
  admitted: boolean,
): AgentQuery {
  let source: AgentQuery | undefined;
  let initialization: Promise<AgentQuery> | undefined;
  const initialize = async (): Promise<AgentQuery> => {
    if (source) return source;
    initialization ??= (async () => {
      if (admitted) validateAnthropicHarness(args.options);
      else await admitAnthropic(args.options, args.target);
      admitted = true;
      const options = {
        ...args.options,
        env: providerEnvironmentForTarget("anthropic", args.target, { env: args.options.env }),
      };
      try {
        source = observeAnthropicQuery(
          normalizeAnthropicQueryDiagnostics(query({ prompt: args.prompt, options })),
          { targetId: () => args.target?.id ?? "anthropic" },
        );
        return source;
      } catch {
        throw new Error("anthropic_provider_execution_failed");
      }
    })();
    return initialization;
  };
  return {
    interrupt: async () => { await (await initialize()).interrupt?.(); },
    setModel: async (model) => { await (await initialize()).setModel?.(model); },
    applyFlagSettings: async (settings) => {
      await (await initialize()).applyFlagSettings?.(settings);
    },
    supportsInFlightEscalation: () => source
      ? Boolean(source.setModel && source.applyFlagSettings
        && (source.supportsInFlightEscalation?.() ?? true))
      : true,
    async *[Symbol.asyncIterator]() {
      for await (const message of await initialize()) yield message;
    },
  };
}

export const anthropicProvider: AgentProvider = {
  id: "anthropic",
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
