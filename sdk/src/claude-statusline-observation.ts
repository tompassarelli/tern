import { anthropicTargetId } from "./providers/anthropic-observations";
import { writeProviderUsageObservations } from "./provider-observation-store";
import type { ProviderUsageObservation, ProviderUsageWindow } from "./providers/types";

type StatuslineWindow = { used_percentage?: unknown; resets_at?: unknown };

function statuslineWindow(limitId: string, value: unknown): ProviderUsageWindow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { used_percentage: usedPercent, resets_at: resetsAt } = value as StatuslineWindow;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) return undefined;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return undefined;
  const date = new Date((resetsAt < 1_000_000_000_000 ? resetsAt * 1_000 : resetsAt));
  if (!Number.isFinite(date.getTime())) return undefined;
  return { limitId, usedPercent, resetsAt: date.toISOString() };
}

/** Normalize the subscriber limits Claude Code already sends to its statusline. */
export function observationFromClaudeStatusline(
  payload: unknown,
  targetId = anthropicTargetId(),
  now = new Date(),
): ProviderUsageObservation | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const rateLimits = (payload as Record<string, unknown>).rate_limits;
  if (!rateLimits || typeof rateLimits !== "object" || Array.isArray(rateLimits)) return undefined;
  const limits = rateLimits as Record<string, unknown>;
  const windows = [
    statuslineWindow("five_hour", limits.five_hour),
    statuslineWindow("seven_day", limits.seven_day),
  ].filter((window): window is ProviderUsageWindow => window !== undefined);
  if (!windows.length) return undefined;
  return { targetId, provider: "anthropic", observedAt: now.toISOString(), windows };
}

/** Best-effort ingestion: malformed/missing telemetry is deliberately a no-op. */
export async function ingestClaudeStatusline(
  payload: unknown,
  options: {
    targetId?: string;
    now?: Date;
    write?: (observation: ProviderUsageObservation) => Promise<unknown>;
  } = {},
): Promise<boolean> {
  const observation = observationFromClaudeStatusline(payload, options.targetId, options.now);
  if (!observation) return false;
  try {
    await (options.write ?? writeProviderUsageObservations)(observation);
    return true;
  } catch {
    return false;
  }
}
