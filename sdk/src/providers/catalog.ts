import { readFileSync } from "node:fs";
import type { ProviderId } from "./types";
import type { Effort } from "../harness";
import { fableWindowOpen } from "../fable-window";

export type SemanticTier = "economy" | "standard" | "senior" | "frontier";
export interface ResolvedTier { tier?: SemanticTier; model?: string; effort?: Effort; }

export function resolveTier(provider: ProviderId, tier?: SemanticTier, model?: string, effort?: Effort): ResolvedTier {
  if (!tier) return { model, effort };
  const path = `${process.env.GAFFER_HOME ?? `${process.env.HOME}/code/gaffer`}/providers/${provider}.json`;
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  const entry = catalog.tiers?.[tier];
  if (!entry) throw new Error(`provider ${provider} does not define semantic tier ${tier}`);
  // Frontier is a semantic request. Gaffer's frontier recipes carry a default
  // deliberation, but that default must not accidentally disable the temporary
  // Anthropic promotion. An explicit model remains the opt-out; Fable itself
  // resolves to the effort it supports while requested reasoning stays in telemetry.
  const temporaryFable = provider === "anthropic" && tier === "frontier" && !model && fableWindowOpen();
  const resolvedModel = temporaryFable ? "fable" : model ?? (entry.model === "auto" ? undefined : entry.model);
  const resolvedEffort = temporaryFable ? "high" : effort ?? entry.defaultEffort ?? entry.defaultReasoning;
  return { tier, model: resolvedModel, effort: resolvedEffort as Effort | undefined };
}
