import { accessSync, constants } from "node:fs";
import { spawn as procSpawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { GafferCapability } from "./gaffer-capabilities";
import { providerSupportsCapabilities } from "./gaffer-capabilities";
import { preflightReadonlyShell, ReadonlyShellUnavailableError } from "./readonly-shell";
import { ProviderRetrySafeError, type ProviderId } from "./providers/types";

const REPO = resolve(import.meta.dir, "../..");
const ENGINE = `${REPO}/bin/north`;
const MCP = `${REPO}/bin/north-mcp`;
const COORD = `${REPO}/cli/coord.clj`;
const COORDINATOR_PROBE_OUTPUT_BYTES = 16_384;
const admissionReceipts = new WeakMap<object, Set<ProviderId>>();

/**
 * The complete environment boundary exposed to the managed North MCP process.
 *
 * Provider CLIs still receive their own scrubbed account environment, but MCP
 * servers are a separate authority boundary: never forward the ambient process
 * environment (which may contain credentials or unrelated provider settings).
 * Keep only lane identity, North/Fram instance selection, routing runtime knobs,
 * and attribution/provenance selectors required by the North executable.
 */
export const MANAGED_NORTH_MCP_ENV_KEYS = [
  "NORTH_BIN",
  "AGENT_ID",
  "AGENT_TOPOLOGY",
  "AGENT_COORDINATOR",
  "NORTH_PORT",
  "NORTH_RUN_ID",
  "NORTH_THREAD_ID",
  "NORTH_RUN_CAPABILITY",
  "NORTH_HOME",
  "NORTH_STREAM_DIR",
  "NORTH_AGENT_LOGS_DIR",
  "NORTH_NO_COLOR",
  "NORTH_STALL_MS",
  "NORTH_BG_MAX_CONTINUATIONS",
  "NORTH_MCP_BB",
  "NORTH_MCP_BUN",
  "FRAM_BIN",
  "FRAM_HOME",
  "FRAM_LOG",
  "FRAM_PORT",
  "FRAM_SINGLE_VALUED",
  "FRAM_TELEMETRY_LOG",
  "FRAM_TERMINAL_PREDS",
  "FRAM_THREADS",
  "FRAM_TIME_DIR",
  "FRAM_WITHDRAWN_PREDS",
  "GAFFER_HOME",
  "GAFFER_STAFFING_CATALOG",
  "NORTH_ROUTING_POLICY",
  "NORTH_PROVIDER_OBSERVATIONS",
  "NORTH_ALLOCATION_MODE",
  "NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE",
  "NORTH_OPENAI_ENTITLEMENT_PRESSURE",
  "NORTH_PROVIDER_ORDER",
  "NORTH_PROVIDER_WEIGHTS",
  "NORTH_RESERVED_FRONTIER_PROVIDER",
  "NORTH_ENVELOPE_ACCOUNTING",
  "NORTH_HARNESS_STATE",
  "NORTH_LEGACY_HARNESS_STATE",
  "NORTH_FABLE_NOW",
  "NORTH_AUTHOR",
  "NORTH_DRIVER",
  "NORTH_LEAD",
  "NORTH_PROJECT",
  "NORTH_PROPOSED_BY",
  "NORTH_SOURCE",
  "NORTH_PACKAGE_REV",
] as const;

export function managedNorthMcpEnvironment(
  source: NodeJS.ProcessEnv | Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(MANAGED_NORTH_MCP_ENV_KEYS.flatMap((key) => {
    const value = source[key];
    return typeof value === "string" ? [[key, value]] : [];
  }));
}

function sameStringMap(actual: unknown, expected: Record<string, string>): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const entries = Object.entries(actual as Record<string, unknown>);
  return entries.length === Object.keys(expected).length
    && entries.every(([key, value]) => value === expected[key])
    && Object.keys(expected).every((key) => Object.hasOwn(actual, key));
}

/**
 * Carry one successful async admission across the synchronous provider.query
 * construction seam. The receipt is scoped to the exact options object and
 * provider, and is consumed once; direct adapter calls have no receipt and
 * therefore retain their defense-in-depth admission.
 */
export function markExecutionAdmission(provider: ProviderId, options: unknown): void {
  if ((typeof options !== "object" && typeof options !== "function") || options === null) return;
  const key = options as object;
  const providers = admissionReceipts.get(key) ?? new Set<ProviderId>();
  providers.add(provider);
  admissionReceipts.set(key, providers);
}

export function consumeExecutionAdmission(provider: ProviderId, options: unknown): boolean {
  if ((typeof options !== "object" && typeof options !== "function") || options === null) return false;
  const key = options as object;
  const providers = admissionReceipts.get(key);
  if (!providers?.delete(provider)) return false;
  if (providers.size === 0) admissionReceipts.delete(key);
  return true;
}

export class ExecutionAdmissionError extends ProviderRetrySafeError {
  readonly code = "blocked_preflight";
  readonly processOutcome = "blocked_preflight";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutionAdmissionError";
  }
}

/**
 * `northCapabilities` marks a North-managed lane. Managed execution must carry
 * the canonical North MCP and an explicit child topology: an absent topology is
 * intentionally ambient authority for interactive top-level sessions, so
 * accepting it here would let a worker's shell invoke North as an orchestrator.
 */
export function validateManagedExecutionEnvelope(
  provider: ProviderId,
  capabilities: readonly GafferCapability[],
  options: any,
): void {
  const topology = capabilities.includes("coordination") ? "orchestrator" : "worker";
  const agentId = typeof options?.env?.AGENT_ID === "string"
    ? options.env.AGENT_ID.trim()
    : "";
  if (!agentId || options?.env?.AGENT_TOPOLOGY !== topology) {
    throw new ExecutionAdmissionError(`${provider}_managed_identity_topology_contract_missing`);
  }

  const north = options?.mcpServers?.north;
  const expectedNorthEnv = managedNorthMcpEnvironment({
    ...options?.env,
    NORTH_BIN: ENGINE,
  });
  if (north?.type !== "stdio"
      || typeof north.command !== "string"
      || resolve(north.command) !== MCP
      || !Array.isArray(north.args)
      || north.args.length !== 0
      || expectedNorthEnv.NORTH_BIN !== ENGINE
      || expectedNorthEnv.AGENT_ID !== agentId
      || expectedNorthEnv.AGENT_TOPOLOGY !== topology
      || typeof expectedNorthEnv.NORTH_PORT !== "string"
      || !expectedNorthEnv.NORTH_PORT.trim()
      || !sameStringMap(north.env, expectedNorthEnv)) {
    throw new ExecutionAdmissionError(`${provider}_managed_north_mcp_contract_missing`);
  }
}

async function requireCoordinator(
  portValue: unknown,
  logValue: unknown,
  timeoutMs = 2_000,
): Promise<void> {
  if (typeof portValue !== "string" || !portValue.trim())
    throw new ExecutionAdmissionError("north_coordination_port_missing");
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new ExecutionAdmissionError("north_coordination_port_invalid");
  if (typeof logValue !== "string" || !logValue.trim())
    throw new ExecutionAdmissionError("north_coordination_log_missing");
  if (!isAbsolute(logValue) || resolve(logValue) !== logValue)
    throw new ExecutionAdmissionError("north_coordination_log_identity_invalid");
  const boundedTimeout = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(999_999, Math.trunc(timeoutMs)))
    : 2_000;
  const bb = process.env.NORTH_MCP_BB ?? process.env.NORTH_BB ?? "bb";
  let child;
  try {
    // Keep the wire contract in one place. `strict-probe` proves the fenced
    // version response, raw-request rejection, canonical served corpus, fatal
    // UTF-8 decoding, an exact terminal frame, and bounded response bytes.
    child = procSpawn(bb, [COORD, "strict-probe", String(port), logValue], {
      cwd: REPO,
      env: {
        ...process.env,
        FRAM_LOG: logValue,
        NORTH_COORD_CONNECT_TIMEOUT_MS: String(boundedTimeout),
        NORTH_COORD_READ_TIMEOUT_MS: String(boundedTimeout),
        NORTH_COORD_MAX_RESPONSE_BYTES: "4096",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new ExecutionAdmissionError("north_coordinator_preflight_failed", { cause });
  }

  let outputBytes = 0;
  let outputLimitExceeded = false;
  let timedOut = false;
  const countOutput = (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes <= COORDINATOR_PROBE_OUTPUT_BYTES) return;
    outputLimitExceeded = true;
    try { child.kill("SIGKILL"); } catch { /* already terminal */ }
  };
  child.stdout.on("data", countOutput);
  child.stderr.on("data", countOutput);
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGKILL"); } catch { /* already terminal */ }
  }, boundedTimeout);
  timer.unref?.();
  const terminal = await new Promise<{ code: number | null; cause?: Error }>((resolveTerminal) => {
    let settled = false;
    const finish = (result: { code: number | null; cause?: Error }) => {
      if (settled) return;
      settled = true;
      resolveTerminal(result);
    };
    child.once("error", (cause) => finish({ code: null, cause }));
    // `close`, unlike `exit`, means both bounded output streams are drained.
    child.once("close", (code) => finish({ code }));
  });
  clearTimeout(timer);
  if (timedOut)
    throw new ExecutionAdmissionError("north_coordinator_preflight_timed_out");
  if (outputLimitExceeded)
    throw new ExecutionAdmissionError("north_coordinator_preflight_output_too_large");
  if (terminal.cause)
    throw new ExecutionAdmissionError("north_coordinator_preflight_failed", { cause: terminal.cause });
  if (terminal.code !== 0)
    throw new ExecutionAdmissionError("north_coordinator_preflight_invalid_response");
}

/**
 * Provider-neutral, pre-turn admission. Every adapter calls this after compiling
 * its authority envelope and before constructing a provider query.
 */
export async function admitExecution(
  provider: ProviderId,
  capabilities: readonly GafferCapability[],
  cwd: string,
  options?: any,
): Promise<void> {
  if (!providerSupportsCapabilities(provider, capabilities)) {
    throw new ExecutionAdmissionError(`${provider}_adapter_cannot_enforce_gaffer_capabilities`);
  }
  try {
    accessSync(ENGINE, constants.X_OK);
  } catch (cause) {
    throw new ExecutionAdmissionError("north_executable_unavailable", { cause });
  }
  try {
    accessSync(MCP, constants.X_OK);
  } catch (cause) {
    throw new ExecutionAdmissionError("north_mcp_executable_unavailable", { cause });
  }
  if (provider === "anthropic" && capabilities.includes("shell.readonly")) {
    try {
      preflightReadonlyShell(cwd);
    } catch (error) {
      if (error instanceof ReadonlyShellUnavailableError)
        throw new ExecutionAdmissionError(error.message, { cause: error });
      throw error;
    }
  }
  // North MCP is part of every managed lane's identity and reporting surface,
  // not only an orchestrator tool. A worker starting against a dead coordinator
  // would be an unrecorded native run wearing managed metadata.
  await requireCoordinator(
    options?.mcpServers?.north?.env?.NORTH_PORT,
    options?.mcpServers?.north?.env?.FRAM_LOG,
  );
}

export function admitPinnedProvider(
  provider: ProviderId | "auto" | undefined,
  capabilities: readonly GafferCapability[],
): void {
  if (provider && provider !== "auto" && !providerSupportsCapabilities(provider, capabilities)) {
    throw new ExecutionAdmissionError(`${provider}_adapter_cannot_enforce_gaffer_capabilities`);
  }
}
