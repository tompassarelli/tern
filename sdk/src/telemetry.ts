// Telemetry auto-capture — write each agent run's tuple as facts so the system
// has a queryable feedback loop (calibrate estimates against actuals, see who ran
// what and with how many observed tokens). Records to a dedicated
// `run-<agent>-<ts>` subject that has
// NO title, so runs never show up as threads on the board — they're queryable via
// fram, invisible to the work views. Fire-and-forget: telemetry must NEVER block
// or fail an agent run, so writes are async and all errors are swallowed.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { RoutingMetadata } from "./routing-metadata";
import type { NormalizedTokenUsage } from "./usage";
import type { AllocationEvidence, RoutingFallbackReason } from "./providers/types";
import type { HarnessCompositionEvidence } from "./harness";
import { GAFFER_CAPABILITIES } from "./gaffer-capabilities";

const REPO = resolve(import.meta.dir, "../..");
const internalWriter = resolve(REPO, "cli/run-fact-internal.clj");

export interface RunRecord {
  thread: string; // the thread driven, or "(ad-hoc)" for a bare spawn
  agent: string; // agent id / handle
  tokens?: number; // legacy exact total for producers without structured terminal usage
  tokenUsage?: NormalizedTokenUsage; // observed components plus terminal scope/status
  durationMs: number; // North-observed wall-clock duration
  providerDurationMs?: number; // provider-reported duration when available
  posture: string; // unplanned | atomic | composite | spawn
  // Routing dials — the EFFECTIVE final dial the run finished at (escalation-aware:
  // spawn passes rung() after any ladder climb, so this is the tier that actually did
  // the work, not necessarily the spawn tier on @agent:<id>). Denormalized onto @run so
  // dial analytics need no @run.agent -> @agent:<id> join, and so escalation cases
  // (started opus/high, finished opus/xhigh) report the tier that carried the outcome.
  model?: string; // opus | sonnet | haiku
  effort?: string; // low | medium | high | xhigh | max
  role?: string; // executor | implementer | integrator | designer | researcher | ...
  provider?: string; // anthropic | openai
  providerTarget?: string; // exact account/target that executed the final route
  providerReason?: string; // explainable auto/explicit routing decision
  requestedProvider?: string;
  requestedTarget?: string;
  requestedTier?: string;
  requestedModel?: string;
  requestedEffort?: string;
  routingMetadata?: RoutingMetadata;
  /** Redacted identifiers proving which operational prompt/tool contracts were applied. */
  promptComposition?: HarnessCompositionEvidence;
  allocationMode?: string;
  entitlementPressure?: string;
  allocationEvidence?: Record<string, AllocationEvidence>;
  fallbackCount?: number;
  fallbackPath?: string[];
  fallbackTargetPath?: string[];
  fallbackReasons?: RoutingFallbackReason[];
  envelopeScopes?: string[];
  envelopeRetries?: number;
  envelopeAdvisories?: string[];
  outcome: string; // "ran" | "error" | "resource_envelope_exceeded" | ...
  processOutcome?: string;
  deliveryOutcome?: string;
  deliveryReason?: string;
  // escalate-not-kill (thread 019f1194-ca57) — present only on escalation-enabled runs.
  // Option A yields ONE @run row per spawn with an internal escalation chain, NOT one
  // row per tier (north-reconcile.clj queries adapt in lockstep — follow-up).
  numTurns?: number; // SDKResultMessage.num_turns (was dropped before)
  errorCount?: number; // tool_result errors this run
  escalationTier?: number; // final ladder tier (omit / <0 = escalation off)
  escalations?: Array<{ from: string; to: string; reason: string }>;
}

export function runFacts(rec: RunRecord, at = new Date().toISOString()): Array<[string, string]> {
  // base36 ms suffix keeps the id unique per agent without a clock dependency the
  // board cares about; this is runtime code, not a workflow script, so Date is fine.
  const facts: Array<[string, string]> = [
    ["kind", "run"],
    ["thread", rec.thread],
    ["agent", rec.agent],
  ];
  // Structured usage owns the aggregate whenever it is present. This prevents a
  // caller from reintroducing zero/summed guesses alongside an unknown terminal
  // status, or from drifting away from an adapter-computed exact total.
  const exactTokens = rec.tokenUsage
    ? rec.tokenUsage.totalStatus === "exact" ? rec.tokenUsage.total : undefined
    : rec.tokens;
  if (exactTokens != null) facts.push(["tokens", String(Math.round(exactTokens))]);
  facts.push(
    ["duration_ms", String(Math.round(rec.durationMs))],
    ["posture", rec.posture],
    ["outcome", rec.outcome],
    ["at", at],
  );
  if (rec.providerDurationMs != null)
    facts.push(["provider_duration_ms", String(Math.round(rec.providerDurationMs))]);
  if (rec.processOutcome) facts.push(["process_outcome", rec.processOutcome]);
  if (rec.deliveryOutcome) facts.push(["delivery_outcome", rec.deliveryOutcome]);
  if (rec.deliveryReason) facts.push(["delivery_reason", rec.deliveryReason]);
  if (rec.model) facts.push(["model", rec.model]);
  if (rec.effort) facts.push(["effort", rec.effort]);
  if (rec.role) facts.push(["role", rec.role]);
  if (rec.provider) facts.push(["provider", rec.provider]);
  if (rec.providerTarget) facts.push(["provider_target", rec.providerTarget]);
  if (rec.providerReason) facts.push(["provider_reason", rec.providerReason]);
  if (rec.requestedProvider) facts.push(["requested_provider", rec.requestedProvider]);
  if (rec.requestedTarget) facts.push(["requested_target", rec.requestedTarget]);
  if (rec.requestedTier) facts.push(["requested_tier", rec.requestedTier]);
  if (rec.requestedModel) facts.push(["requested_model", rec.requestedModel]);
  if (rec.requestedEffort) facts.push(["requested_effort", rec.requestedEffort]);
  if (rec.allocationMode) facts.push(["allocation_mode", rec.allocationMode]);
  if (rec.entitlementPressure) facts.push(["entitlement_pressure", rec.entitlementPressure]);
  for (const [target, evidence] of Object.entries(rec.allocationEvidence ?? {}))
    facts.push(["allocation_evidence", JSON.stringify({ target, ...evidence })]);
  if (rec.tokenUsage?.inputTokens != null)
    facts.push(["input_tokens", String(rec.tokenUsage.inputTokens)]);
  if (rec.tokenUsage?.outputTokens != null)
    facts.push(["output_tokens", String(rec.tokenUsage.outputTokens)]);
  if (rec.tokenUsage?.cacheCreateTokens != null)
    facts.push(["cache_create_tokens", String(rec.tokenUsage.cacheCreateTokens)]);
  if (rec.tokenUsage?.cacheReadTokens != null)
    facts.push(["cache_read_tokens", String(rec.tokenUsage.cacheReadTokens)]);
  if (rec.tokenUsage?.cachedInputTokens != null)
    facts.push(["cached_input_tokens", String(rec.tokenUsage.cachedInputTokens)]);
  if (rec.tokenUsage?.reasoningOutputTokens != null)
    facts.push(["reasoning_output_tokens", String(rec.tokenUsage.reasoningOutputTokens)]);
  if (rec.tokenUsage) {
    facts.push(["usage_terminal_count", String(rec.tokenUsage.terminalCount)]);
    if (rec.tokenUsage.terminalScope) facts.push(["usage_scope", rec.tokenUsage.terminalScope]);
    facts.push(["usage_total_status", rec.tokenUsage.totalStatus]);
  }
  if (rec.fallbackCount != null) facts.push(["fallback_count", String(rec.fallbackCount)]);
  if (rec.fallbackPath?.length) facts.push(["fallback_path", rec.fallbackPath.join(" -> ")]);
  if (rec.fallbackTargetPath?.length) facts.push(["fallback_target_path", rec.fallbackTargetPath.join(" -> ")]);
  for (const reason of rec.fallbackReasons ?? []) facts.push(["fallback_reason", JSON.stringify(reason)]);
  for (const scope of rec.envelopeScopes ?? []) facts.push(["envelope_scope", scope]);
  if (rec.envelopeRetries != null) facts.push(["envelope_retries", String(rec.envelopeRetries)]);
  for (const advisory of rec.envelopeAdvisories ?? []) facts.push(["envelope_advisory", advisory]);
  const metadata = rec.routingMetadata;
  if (metadata?.role) facts.push(["requested_role", metadata.role]);
  if (metadata?.tier) facts.push(["routing_tier", metadata.tier]);
  if (metadata?.reasoning) facts.push(["requested_reasoning", metadata.reasoning]);
  if (metadata?.posture) facts.push(["routing_posture", metadata.posture]);
  if (metadata?.taskGrade) facts.push(["task_grade", metadata.taskGrade]);
  if (metadata?.topology) facts.push(["topology", metadata.topology]);
  for (const domain of metadata?.domainRequirements ?? []) facts.push(["domain_requirement", domain]);
  if (metadata?.composition) {
    facts.push(["composition_kind", metadata.composition.kind]);
    facts.push(["composition_id", metadata.composition.id]);
    if (metadata.composition.kind === "preset") {
      for (const field of metadata.composition.overrides) facts.push(["composition_override", field]);
      if (metadata.composition.overrideReason)
        facts.push(["composition_override_reason", metadata.composition.overrideReason]);
    } else {
      if (metadata.composition.nearestPreset)
        facts.push(["nearest_preset", metadata.composition.nearestPreset]);
      facts.push(["bespoke_reason", metadata.composition.bespokeReason]);
      facts.push(["promotion_candidate", String(metadata.composition.promotionCandidate)]);
    }
  }
  const applied = rec.promptComposition;
  if (applied) {
    facts.push(["prompt_composition_applied", "true"]);
    if (applied.roleKind && applied.roleId)
      facts.push(["applied_role_contract", `${applied.roleKind}:${applied.roleId}`]);
    if (applied.bespokeContractHash)
      facts.push(["applied_bespoke_contract_sha256", applied.bespokeContractHash]);
    if (applied.bespokeContractFingerprintVersion)
      facts.push(["applied_bespoke_contract_fingerprint_version", applied.bespokeContractFingerprintVersion]);
    if (applied.bespokeContractFingerprintDomain)
      facts.push(["applied_bespoke_contract_fingerprint_domain", applied.bespokeContractFingerprintDomain]);
    for (const field of applied.presetOverrides ?? []) facts.push(["applied_preset_override", field]);
    if (applied.presetOverrideReasonHash)
      facts.push(["applied_preset_override_reason_sha256", applied.presetOverrideReasonHash]);
    const capabilityOrder = new Map(GAFFER_CAPABILITIES.map((capability, index) => [capability, index]));
    for (const capability of [...(applied.capabilities ?? [])]
      .sort((left, right) => capabilityOrder.get(left)! - capabilityOrder.get(right)!))
      facts.push(["applied_capability", capability]);
    if (applied.commsContractHash)
      facts.push(["applied_comms_contract_sha256", applied.commsContractHash]);
    if (applied.taskGrade) facts.push(["applied_task_grade", applied.taskGrade]);
    if (applied.topology) facts.push(["applied_topology", applied.topology]);
    if (applied.tier) facts.push(["applied_routing_tier", applied.tier]);
    if (applied.reasoning) facts.push(["applied_reasoning", applied.reasoning]);
    if (applied.posture) facts.push(["applied_posture", applied.posture]);
    for (const domain of applied.domainRequirements ?? []) facts.push(["applied_domain_requirement", domain]);
    // Zero is evidence: an explicitly empty applied domain axis must remain
    // distinguishable from historical telemetry that never recorded the axis.
    facts.push(["applied_domain_requirement_count", String(applied.domainRequirements?.length ?? 0)]);
    const delta = applied.modelDelta;
    if (delta) {
      if (delta.provider) facts.push(["model_delta_provider", delta.provider]);
      if (delta.model) facts.push(["model_delta_model", delta.model]);
      facts.push(["model_delta_kind", delta.kind]);
      if (delta.path) facts.push(["model_delta_path", delta.path]);
      if (delta.reason) facts.push(["model_delta_reason", delta.reason]);
    }
  }
  if (rec.numTurns != null) facts.push(["num_turns", String(rec.numTurns)]);
  if (rec.errorCount != null) facts.push(["error_count", String(rec.errorCount)]);
  if (rec.escalationTier != null && rec.escalationTier >= 0)
    facts.push(["escalation_tier", String(rec.escalationTier)]);
  if (rec.escalations && rec.escalations.length) {
    facts.push(["escalation_count", String(rec.escalations.length)]);
    facts.push(["escalation_path", rec.escalations.map((e) => `${e.from}>${e.to}`).join(" ")]);
    facts.push(["escalation_reasons", rec.escalations.map((e) => e.reason).join(",")]);
  }
  return facts;
}

export function recordRun(rec: RunRecord): void {
  const id = newRunId(rec.agent);
  const facts = runFacts(rec);
  // Hermetic capture engines intentionally retain the ordinary fact-verb shape.
  if (process.env.NORTH_IDENTITY_TEST_REDIRECT === "1") {
    for (const [predicate, value] of facts) {
      try {
        execFile(process.env.NORTH_BIN ?? "north", ["tell", id, predicate, value], () => {});
      } catch { /* swallow */ }
    }
    return;
  }
  try {
    execFile("bb", [
      internalWriter,
      process.env.NORTH_PORT ?? "7977",
      id,
      JSON.stringify(facts),
    ], () => {});
  } catch {
    /* telemetry must never replace the run's real terminal result */
  }
}

export function newRunId(agent: string): string {
  return `run-${agent}-${randomUUID()}`;
}
