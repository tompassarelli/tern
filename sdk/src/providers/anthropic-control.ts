import {
  startup,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { providerEnvironmentForTarget } from "../accounts";
import {
  AnthropicUsageUnavailableError,
  normalizeAnthropicUsage,
  type AnthropicUsageResult,
  type AnthropicUsageUnavailableReason,
} from "./anthropic-usage";
import {
  createAnthropicProcessLifecycle,
  settleAnthropicProcessOwner,
  type AnthropicProcessLifecycle,
} from "./anthropic-process";
import type { RoutingTarget } from "./types";

const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET" as const;
const DEFAULT_TIMEOUT_MS = 30_000;

export type AnthropicControlFailureReason =
  | "anthropic_control_capability_unavailable"
  | "anthropic_control_probe_aborted"
  | "anthropic_control_probe_failed"
  | "anthropic_control_probe_timed_out";

export type AnthropicControlSurface<T> =
  | { ok: true; value: T; observedAt: string }
  | { ok: false; reason: AnthropicControlFailureReason; attemptedAt: string };

export type AnthropicUsageControlSurface =
  | { ok: true; value: AnthropicUsageResult; observedAt: string }
  | {
      ok: false;
      reason: AnthropicControlFailureReason | AnthropicUsageUnavailableReason;
      attemptedAt: string;
    };

interface ControlQuery {
  [USAGE_METHOD]?: () => Promise<unknown>;
  supportedModels?: () => Promise<unknown>;
  return?: (value?: undefined) => Promise<unknown>;
  [Symbol.asyncDispose]?: () => PromiseLike<void>;
  close(): void;
}

interface ControlWarmQuery {
  query(prompt: AsyncIterable<SDKUserMessage>): ControlQuery;
  [Symbol.asyncDispose]?: () => PromiseLike<void>;
  close(): void;
}

export type StartAnthropicControl = (params: {
  options?: Options;
  initializeTimeoutMs?: number;
}) => Promise<ControlWarmQuery>;

export interface ReadAnthropicControlOptions {
  target: RoutingTarget;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  usage?: boolean;
  models?: boolean;
  now?: () => Date;
  start?: StartAnthropicControl;
  createLifecycle?: () => AnthropicProcessLifecycle;
  /** Supervisor-owned cancellation; forwarded into this control's owned controller. */
  signal?: AbortSignal;
}

export interface AnthropicControlObservation {
  usage?: AnthropicUsageControlSurface;
  models?: AnthropicControlSurface<unknown>;
}

function idlePrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      if (!signal.aborted)
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
}

function controlFailure(error: unknown): AnthropicControlFailureReason {
  if (error instanceof Error) {
    if (error.message === "anthropic_control_probe_timed_out")
      return "anthropic_control_probe_timed_out";
    if (error.message === "anthropic_control_probe_aborted")
      return "anthropic_control_probe_aborted";
  }
  return "anthropic_control_probe_failed";
}

function timed<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      action();
    };
    const aborted = () => finish(() => reject(new Error("anthropic_control_probe_aborted")));
    const timer = setTimeout(
      () => finish(() => reject(new Error("anthropic_control_probe_timed_out"))),
      timeoutMs,
    );
    timer.unref?.();
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new Error("anthropic_control_probe_failed"))),
    );
  });
}

async function disposeControlHandle(
  query: ControlQuery | undefined,
  warm: ControlWarmQuery | undefined,
): Promise<void> {
  if (query) {
    const asyncDispose = query[Symbol.asyncDispose];
    if (asyncDispose) await asyncDispose.call(query);
    else if (query.return) await query.return(undefined);
    else query.close();
    return;
  }
  const asyncDispose = warm?.[Symbol.asyncDispose];
  if (asyncDispose) await asyncDispose.call(warm);
  else warm?.close();
}

async function surface(
  operation: (() => Promise<unknown>) | undefined,
  remaining: () => number,
  now: () => Date,
  signal: AbortSignal,
): Promise<AnthropicControlSurface<unknown>> {
  if (!operation) return {
    ok: false,
    reason: "anthropic_control_capability_unavailable",
    attemptedAt: now().toISOString(),
  };
  try {
    const value = await timed(Promise.resolve().then(operation), remaining(), signal);
    return { ok: true, value, observedAt: now().toISOString() };
  } catch (error) {
    return {
      ok: false,
      reason: controlFailure(error),
      attemptedAt: now().toISOString(),
    };
  }
}

async function usageSurface(
  operation: (() => Promise<unknown>) | undefined,
  targetId: string,
  remaining: () => number,
  now: () => Date,
  signal: AbortSignal,
): Promise<AnthropicUsageControlSurface> {
  if (!operation) return {
    ok: false,
    reason: "anthropic_control_capability_unavailable",
    attemptedAt: now().toISOString(),
  };
  const normalizeResponse = async (): Promise<Extract<AnthropicUsageControlSurface, { ok: true }>> => {
    const value = await timed(Promise.resolve().then(operation), remaining(), signal);
    const observedAt = now();
    return {
      ok: true,
      value: normalizeAnthropicUsage(value, targetId, observedAt),
      observedAt: observedAt.toISOString(),
    };
  };
  try {
    try {
      return await normalizeResponse();
    } catch (error) {
      if (!(error instanceof AnthropicUsageUnavailableError)
          || error.reason !== "anthropic_usage_response_schema_changed") throw error;
      // Preserve the experimental usage surface's single schema retry. It is
      // still the same idle Query and the same shared startup deadline.
      return await normalizeResponse();
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof AnthropicUsageUnavailableError
        ? error.reason
        : controlFailure(error),
      attemptedAt: now().toISOString(),
    };
  }
}

/**
 * Read independent subscription-control surfaces through one initialized CLI
 * and one idle Query. No SDK user message is ever produced. A failure on one
 * control method is data for that method only; the sibling result survives.
 */
export async function readAnthropicControlObservation(
  options: ReadAnthropicControlOptions,
): Promise<AnthropicControlObservation> {
  if (!options.usage && !options.models) return {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  const upstreamSignal = options.signal;
  const forwardAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) forwardAbort();
  else upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });
  const lifecycle = (options.createLifecycle ?? createAnthropicProcessLifecycle)();
  const now = options.now ?? (() => new Date());
  let warm: ControlWarmQuery | undefined;
  let query: ControlQuery | undefined;
  let startupDisposition: "pending" | "accepted" | "closed" = "pending";
  let releaseStartupDisposition!: () => void;
  const startupDispositionKnown = new Promise<void>((resolve) => {
    releaseStartupDisposition = resolve;
  });
  const env = providerEnvironmentForTarget("anthropic", options.target, { env: options.env });
  const startupPromise = Promise.resolve().then(() => {
    if (controller.signal.aborted)
      throw new Error("anthropic_control_probe_aborted");
    return (options.start ?? (startup as StartAnthropicControl))({
      initializeTimeoutMs: timeoutMs,
      options: {
        abortController: controller,
        cwd: tmpdir(),
        env,
        mcpServers: {},
        persistSession: false,
        settingSources: [],
        spawnClaudeCodeProcess: lifecycle.spawnClaudeCodeProcess,
        strictMcpConfig: true,
        systemPrompt: "",
        tools: [],
      },
    });
  });
  // A startup can ignore its timeout and resolve after this function has
  // already returned a failed observation. Keep that resolution observed and
  // dispose the late WarmQuery through the same sealed lifecycle. No late
  // resolution may resurrect an owned subprocess or leak an unhandled promise.
  void startupPromise.then(async (lateWarm) => {
    await startupDispositionKnown;
    if (startupDisposition !== "accepted") {
      try {
        await settleAnthropicProcessOwner({
          lifecycle,
          abortController: controller,
          dispose: () => disposeControlHandle(undefined, lateWarm),
        });
      } catch { /* the lifecycle is already sealed; no provider diagnostics escape */ }
    }
  }, () => { /* timed() already maps startup failures to provider-private evidence */ });
  try {
    try {
      warm = await timed(startupPromise, remaining(), controller.signal);
      startupDisposition = "accepted";
      releaseStartupDisposition();
      query = warm.query(idlePrompt(controller.signal));
    } catch (error) {
      if (startupDisposition === "pending") {
        startupDisposition = "closed";
        releaseStartupDisposition();
      }
      const reason = controlFailure(error);
      return {
        ...(options.usage ? { usage: { ok: false as const, reason, attemptedAt: now().toISOString() } } : {}),
        ...(options.models ? { models: { ok: false as const, reason, attemptedAt: now().toISOString() } } : {}),
      };
    }
    const [usage, models] = await Promise.all([
      options.usage
        ? usageSurface(
            query[USAGE_METHOD]?.bind(query), options.target.id,
            remaining, now, controller.signal,
          )
        : Promise.resolve(undefined),
      options.models
        ? surface(query.supportedModels?.bind(query), remaining, now, controller.signal)
        : Promise.resolve(undefined),
    ]);
    return {
      ...(usage ? { usage } : {}),
      ...(models ? { models } : {}),
    };
  } finally {
    if (startupDisposition === "pending") {
      startupDisposition = "closed";
      releaseStartupDisposition();
    }
    upstreamSignal?.removeEventListener("abort", forwardAbort);
    try {
      await settleAnthropicProcessOwner({
        lifecycle,
        abortController: controller,
        dispose: query || warm ? () => disposeControlHandle(query, warm) : undefined,
      });
    } catch {
      // A process whose disappearance cannot be proved invalidates every
      // otherwise-successful control surface. Keep diagnostics provider-private
      // while making the fail-closed boundary explicit to the caller.
      throw new Error("anthropic_control_lifecycle_settlement_failed");
    }
  }
}
