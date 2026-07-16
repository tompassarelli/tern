import type { SDKRateLimitEvent } from "@anthropic-ai/claude-agent-sdk";
import { writeProviderUsageObservations } from "../provider-observation-store";
import { resourcePolicyFromEnv } from "../provider-routing";
import type { AgentQuery, EntitlementPressure, ProviderUsageObservation } from "./types";

type RateLimitInfo = SDKRateLimitEvent["rate_limit_info"];

function instant(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  // Claude Code currently emits Unix timestamps; tolerate milliseconds as the
  // SDK surface is experimental and does not specify the unit.
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function usedPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  // Rate-limit events historically use a 0..1 utilization fraction while the
  // structured usage response names 0..100 percentages. Accept either shape.
  return value <= 1 ? value * 100 : value;
}

function state(info: RateLimitInfo, percent: number | undefined): EntitlementPressure | undefined {
  if (info.status === "rejected") return "exhausted";
  if (info.status === "allowed_warning") return "low";
  if (percent === undefined) return undefined;
  if (percent >= 100) return "exhausted";
  if (percent >= 80) return "low";
  if (percent >= 50) return "normal";
  return "plenty";
}

/** Normalize an event already emitted by Claude Code; no control request or model turn. */
export function observationFromAnthropicRateLimit(
  event: SDKRateLimitEvent,
  targetId: string,
  now = new Date(),
): ProviderUsageObservation {
  const info = event.rate_limit_info;
  const percent = usedPercent(info.utilization);
  const resetsAt = instant(info.resetsAt);
  const common = { targetId, provider: "anthropic" as const, observedAt: now.toISOString() };
  if (percent !== undefined && resetsAt) {
    return {
      ...common,
      windows: [{
        ...(info.rateLimitType ? { limitId: info.rateLimitType } : {}),
        usedPercent: percent,
        resetsAt,
      }],
    };
  }
  const normalizedState = state(info, percent);
  return {
    ...common,
    ...(normalizedState === undefined ? { state: "unknown" as const } : { state: normalizedState }),
    ...(resetsAt ? { until: resetsAt } : {}),
  };
}

export function anthropicTargetId(): string {
  const policy = resourcePolicyFromEnv();
  const order = policy.targetOrder ?? policy.targets?.map(({ id }) => id) ?? [];
  return order
    .map((id) => policy.targets?.find((target) => target.id === id))
    .find((target) => target?.provider === "anthropic")?.id ?? "anthropic";
}

/**
 * Observe Claude's normal message stream and preserve its query controls.
 * Collection is deliberately fail-open: routing telemetry must never break an
 * otherwise healthy agent turn.
 */
export function observeAnthropicQuery(
  source: AgentQuery,
  options: {
    targetId?: () => string;
    write?: (observation: ProviderUsageObservation) => Promise<unknown>;
    now?: () => Date;
  } = {},
): AgentQuery {
  const targetId = options.targetId ?? anthropicTargetId;
  const write = options.write ?? writeProviderUsageObservations;
  const now = options.now ?? (() => new Date());
  return {
    interrupt: source.interrupt?.bind(source),
    setModel: source.setModel?.bind(source),
    async *[Symbol.asyncIterator]() {
      for await (const message of source as AsyncIterable<any>) {
        if (message?.type === "rate_limit_event" && message.rate_limit_info) {
          try {
            await write(observationFromAnthropicRateLimit(message as SDKRateLimitEvent, targetId(), now()));
          } catch {
            // A malformed experimental event or unavailable state directory is
            // telemetry loss, not a reason to kill the provider stream.
          }
        }
        yield message;
      }
    },
  };
}
