import {
  startup,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { providerEnvironmentForTarget } from "../accounts";
import { writeProviderUsageObservations } from "../provider-observation-store";
import type {
  ProviderUsageObservation,
  ProviderUsageUnavailableComponent,
  ProviderUsageWindow,
  RoutingTarget,
} from "./types";

const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET" as const;
const DEFAULT_TIMEOUT_MS = 30_000;

export const ANTHROPIC_USAGE_SOURCE = "claude-agent-sdk:usage-control-experimental";

export type AnthropicUsageUnavailableReason =
  | "anthropic_usage_capability_unavailable"
  | "anthropic_usage_probe_aborted"
  | "anthropic_usage_probe_failed"
  | "anthropic_usage_probe_timed_out"
  | "anthropic_usage_rate_limits_unavailable"
  | "anthropic_usage_response_schema_changed"
  | "anthropic_usage_windows_unavailable";

export type UnavailableUsageComponent = ProviderUsageUnavailableComponent;

export interface AnthropicUsageResult {
  source: typeof ANTHROPIC_USAGE_SOURCE;
  observation: ProviderUsageObservation;
  unavailableComponents: UnavailableUsageComponent[];
}

export class AnthropicUsageUnavailableError extends Error {
  constructor(readonly reason: AnthropicUsageUnavailableReason) {
    super(reason);
    this.name = "AnthropicUsageUnavailableError";
  }
}

interface UsageQuery {
  [USAGE_METHOD]?: () => Promise<unknown>;
  close(): void;
}

interface UsageWarmQuery {
  query(prompt: AsyncIterable<SDKUserMessage>): UsageQuery;
  close(): void;
}

type StartUsageQuery = (params: {
  options?: Options;
  initializeTimeoutMs?: number;
}) => Promise<UsageWarmQuery>;

export interface ReadAnthropicUsageOptions {
  target: RoutingTarget;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  timeoutMs?: number;
  start?: StartUsageQuery;
  storePath?: string;
  signal?: AbortSignal;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedWindow(
  limitId: string,
  value: unknown,
  unavailable: UnavailableUsageComponent[],
): ProviderUsageWindow | undefined {
  if (!record(value)) {
    if (value !== null && value !== undefined)
      unavailable.push({ limitId, reason: "component_schema_changed" });
    return undefined;
  }
  if (typeof value.utilization !== "number" || !Number.isFinite(value.utilization) || value.utilization < 0) {
    unavailable.push({ limitId, reason: "utilization_unavailable" });
    return undefined;
  }
  if (typeof value.resets_at !== "string" || !Number.isFinite(Date.parse(value.resets_at))) {
    unavailable.push({ limitId, reason: "reset_unavailable" });
    return undefined;
  }
  return { limitId, usedPercent: value.utilization, resetsAt: new Date(Date.parse(value.resets_at)).toISOString() };
}

function modelLimitId(value: Record<string, unknown>, index: number): string {
  // display_name is provider-controlled diagnostic text. Never persist it.
  // Recognize only exact public family labels; everything else gets an opaque
  // local ordinal and remains route-dependent rather than contaminating a
  // concrete known family.
  const normalized = typeof value.display_name === "string"
    ? value.display_name.trim().toLowerCase().replace(/[ ._-]+/g, "-")
    : "";
  const known: Record<string, string> = {
    fable: "fable", "fable-5": "fable", "claude-fable": "fable", "claude-fable-5": "fable",
    opus: "opus", "opus-4-8": "opus", "claude-opus": "opus", "claude-opus-4-8": "opus",
    sonnet: "sonnet", "sonnet-5": "sonnet", "claude-sonnet": "sonnet", "claude-sonnet-5": "sonnet",
  };
  return `claude:model:${known[normalized] ?? `opaque-${index + 1}`}`;
}

/**
 * Parse only the documented subscription windows. The experimental response
 * already carries additional fields in the wild, so unknown fields are
 * deliberately ignored and never become usage, billing, or routing facts.
 */
export function normalizeAnthropicUsage(
  value: unknown,
  targetId: string,
  now = new Date(),
): AnthropicUsageResult {
  if (!record(value)
      || !("subscription_type" in value)
      || typeof value.rate_limits_available !== "boolean")
    throw new AnthropicUsageUnavailableError("anthropic_usage_response_schema_changed");
  if (value.subscription_type === null || !value.rate_limits_available)
    throw new AnthropicUsageUnavailableError("anthropic_usage_rate_limits_unavailable");
  if (typeof value.subscription_type !== "string")
    throw new AnthropicUsageUnavailableError("anthropic_usage_response_schema_changed");
  if (!record(value.rate_limits))
    throw new AnthropicUsageUnavailableError("anthropic_usage_response_schema_changed");

  const unavailableComponents: UnavailableUsageComponent[] = [];
  const windows: ProviderUsageWindow[] = [];
  for (const field of ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"] as const) {
    const window = normalizedWindow(`claude:${field}`, value.rate_limits[field], unavailableComponents);
    if (window) windows.push(window);
  }
  if (value.rate_limits.model_scoped !== undefined && value.rate_limits.model_scoped !== null) {
    if (!Array.isArray(value.rate_limits.model_scoped))
      unavailableComponents.push({ limitId: "claude:model_scoped", reason: "component_schema_changed" });
    else value.rate_limits.model_scoped.forEach((component, index) => {
      const limitId = record(component) ? modelLimitId(component, index) : `claude:model:${index + 1}`;
      const window = normalizedWindow(limitId, component, unavailableComponents);
      if (window) windows.push(window);
    });
  }
  if (!windows.length)
    throw new AnthropicUsageUnavailableError("anthropic_usage_windows_unavailable");
  return {
    source: ANTHROPIC_USAGE_SOURCE,
    observation: {
      targetId,
      provider: "anthropic",
      source: ANTHROPIC_USAGE_SOURCE,
      observedAt: now.toISOString(),
      windows,
      ...(unavailableComponents.length ? { unavailableComponents } : {}),
    },
    unavailableComponents,
  };
}

function responseSchemaChanged(error: unknown): boolean {
  return error instanceof AnthropicUsageUnavailableError
    && error.reason === "anthropic_usage_response_schema_changed";
}

function idlePrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      if (!signal.aborted)
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
}

function timed<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      action();
    };
    const aborted = () => finish(() => reject(
      new AnthropicUsageUnavailableError("anthropic_usage_probe_aborted"),
    ));
    const timer = setTimeout(() => finish(() => reject(
      new AnthropicUsageUnavailableError("anthropic_usage_probe_timed_out"),
    )), timeoutMs);
    timer.unref?.();
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new AnthropicUsageUnavailableError("anthropic_usage_probe_failed"))),
    );
  });
}

/** Read claude.ai subscription windows through a control request; no prompt is ever sent. */
export async function readAnthropicSubscriptionUsage(
  options: ReadAnthropicUsageOptions,
): Promise<AnthropicUsageResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  let warm: UsageWarmQuery | undefined;
  let usageQuery: UsageQuery | undefined;
  try {
    if (controller.signal.aborted)
      throw new AnthropicUsageUnavailableError("anthropic_usage_probe_aborted");
    const env = providerEnvironmentForTarget("anthropic", options.target, { env: options.env });
    warm = await timed((options.start ?? (startup as StartUsageQuery))({
      initializeTimeoutMs: timeoutMs,
      options: {
        abortController: controller,
        cwd: tmpdir(),
        env,
        mcpServers: {},
        persistSession: false,
        settingSources: [],
        strictMcpConfig: true,
        systemPrompt: "",
        tools: [],
      },
    }), remaining(), controller.signal);
    usageQuery = warm.query(idlePrompt(controller.signal));
    const query = usageQuery;
    const method = query[USAGE_METHOD];
    if (typeof method !== "function")
      throw new AnthropicUsageUnavailableError("anthropic_usage_capability_unavailable");
    const normalizeResponse = async () => normalizeAnthropicUsage(
      await timed(method.call(query), remaining(), controller.signal),
      options.target.id,
      options.now,
    );
    try {
      return await normalizeResponse();
    } catch (error) {
      if (!responseSchemaChanged(error)) throw error;
      if (controller.signal.aborted)
        throw new AnthropicUsageUnavailableError("anthropic_usage_probe_aborted");
      // The control surface is read-only and emits no model turn. One retry
      // absorbs a transient experimental-envelope mismatch while the shared
      // deadline keeps permanent schema drift bounded and explicit.
      return await normalizeResponse();
    }
  } catch (error) {
    if (error instanceof AnthropicUsageUnavailableError) throw error;
    throw new AnthropicUsageUnavailableError("anthropic_usage_probe_failed");
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
    controller.abort();
    usageQuery?.close();
    if (!usageQuery) warm?.close();
  }
}

export async function observeAnthropicSubscriptionUsage(
  options: ReadAnthropicUsageOptions,
): Promise<AnthropicUsageResult> {
  const result = await readAnthropicSubscriptionUsage(options);
  await writeProviderUsageObservations(result.observation, options.storePath);
  return result;
}
