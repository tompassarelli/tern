import type { SDKRateLimitEvent } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { listProviderAccounts } from "../accounts";
import { writeProviderUsageObservations } from "../provider-observation-store";
import type {
  AgentQuery,
  EntitlementPressure,
  ProviderUsageCategoricalSignal,
  ProviderUsageObservation,
} from "./types";

type RateLimitInfo = SDKRateLimitEvent["rate_limit_info"];

const KNOWN_RATE_LIMIT_TYPES = new Set([
  "five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet",
  "seven_day_fable",
  "claude:five_hour", "claude:seven_day", "claude:seven_day_oauth_apps",
  "claude:seven_day_opus", "claude:seven_day_sonnet", "claude:seven_day_fable",
]);

function safeRateLimitType(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (value === "seven_day_fable" || value === "claude:seven_day_fable") return "claude:model:fable";
  if (KNOWN_RATE_LIMIT_TYPES.has(value)) return value;
  // Preserve the fact that a present unknown type is scoped without persisting
  // provider-controlled text or turning it into generic account exhaustion.
  return "claude:model:opaque-event";
}

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
  return value <= 1 ? Number((value * 100).toFixed(10)) : value;
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
  const normalizedState = state(info, percent);
  const rateLimitType = safeRateLimitType(info.rateLimitType);
  const common = { targetId, provider: "anthropic" as const,
    source: "claude-agent-sdk:rate-limit-event" as const, observedAt: now.toISOString() };
  const categoricalSignal: ProviderUsageCategoricalSignal | undefined =
    info.status === "rejected" || info.status === "allowed_warning"
      ? {
          kind: info.status === "rejected" ? "rejection" : "warning",
          ...(rateLimitType ? { limitId: rateLimitType } : {}),
          ...(resetsAt ? { resetsAt } : {}),
        }
      : undefined;
  if (resetsAt && percent !== undefined) {
    return {
      ...common,
      windows: [{
        ...(rateLimitType ? { limitId: rateLimitType } : {}),
        usedPercent: percent,
        resetsAt,
        measurementKind: "provider-measured",
      }],
      ...(categoricalSignal ? { categoricalSignals: [categoricalSignal] } : {}),
    };
  }
  if (categoricalSignal) return { ...common, categoricalSignals: [categoricalSignal] };
  return {
    ...common,
    ...(normalizedState === undefined ? { state: "unknown" as const } : { state: normalizedState }),
    ...(resetsAt ? { until: resetsAt } : {}),
  };
}

/**
 * Resolve an interactive Claude statusline to a verified isolated account.
 * An ambient or ambiguous config root has no honest account attribution, so it
 * is dropped instead of being assigned to whichever Claude target is listed
 * first in policy.
 */
export function anthropicTargetId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configuredRoot = env.CLAUDE_CONFIG_DIR;
  if (!configuredRoot || !isAbsolute(configuredRoot)) return undefined;
  try {
    const canonicalRoot = realpathSync(resolve(configuredRoot));
    const matches = listProviderAccounts({ env }).filter((account) => {
      if (account.provider !== "anthropic") return false;
      try { return realpathSync(account.root) === canonicalRoot; }
      catch { return false; }
    });
    const requested = env.AGENT_TARGET;
    if (requested) return matches.some(({ id }) => id === requested) ? requested : undefined;
    return matches.length === 1 ? matches[0]!.id : undefined;
  } catch {
    return undefined;
  }
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
  // Provider queries always supply the selected target. The ambient fallback is
  // only a compatibility identity for direct wrappers; unlike statusline
  // ingestion it never guesses among configured isolated accounts.
  const targetId = options.targetId ?? (() => "anthropic");
  const write = options.write ?? writeProviderUsageObservations;
  const now = options.now ?? (() => new Date());
  return {
    interrupt: source.interrupt?.bind(source),
    setModel: source.setModel?.bind(source),
    applyFlagSettings: source.applyFlagSettings?.bind(source),
    supportsInFlightEscalation: () =>
      typeof source.setModel === "function" && typeof source.applyFlagSettings === "function" &&
      (source.supportsInFlightEscalation?.() ?? true),
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
