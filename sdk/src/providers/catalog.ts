import { readFileSync } from "node:fs";
import type { ProviderId } from "./types";
import type { Effort } from "../harness";

export type SemanticTier = "economy" | "standard" | "senior" | "frontier";
export interface ResolvedTier { tier?: SemanticTier; model?: string; effort?: Effort; }

export function resolveTier(provider: ProviderId, tier?: SemanticTier, model?: string, effort?: Effort): ResolvedTier {
  if (!tier) return { model, effort };
  const path = `${process.env.GAFFER_HOME ?? `${process.env.HOME}/code/gaffer`}/providers/${provider}.json`;
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  const entry = catalog.tiers?.[tier];
  if (!entry) throw new Error(`provider ${provider} does not define semantic tier ${tier}`);
  const resolvedModel = model ?? (entry.model === "auto" ? undefined : entry.model);
  const resolvedEffort = effort ?? entry.defaultEffort ?? entry.defaultReasoning;
  return { tier, model: resolvedModel, effort: resolvedEffort as Effort | undefined };
}
