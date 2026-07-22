// Telemetry auto-capture — write each agent run's tuple as facts so the system
// has a queryable feedback loop (calibrate estimates against actuals, see who ran
// what and with how many observed tokens). Records to a dedicated
// `run:<agent>-<uuid>` subject that has
// NO title, so runs never show up as threads on the board — they're queryable via
// fram, invisible to the work views. Terminal publication is bounded and
// non-throwing: callers wait for its settlement before waking a coordinator,
// but an unavailable telemetry sink never replaces the provider outcome.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { RoutingRequest } from "./routing-metadata";
import type { NormalizedTokenUsage } from "./usage";
import type { AllocationEvidence, RoutingFallbackReason } from "./providers/types";
import type { HarnessCompositionEvidence } from "./harness";
import { GAFFER_CAPABILITIES } from "./gaffer-capabilities";
import type { DeliveryProof } from "./delivery-verification";
import type { ProviderAuthoritySurface } from "./providers";
import { providerBilling, settleSpend } from "./spend-guard";
import {
  parseJudgmentGrade,
  type JudgmentGradeSnapshot,
} from "./judgment-grade";
import {
  STRUGGLE_DETECTOR_POLICY_VERSION,
  STRUGGLE_THRESHOLD_MAX,
  type StruggleObservation,
} from "./struggle";
import type { ProviderModelAdmissionReceipt } from "./provider-model-observation-store";
import { canonicalWriteModel } from "./providers/catalog";
import type { ProviderId } from "./providers/types";
import type {
  RoutingAdmissionReceipt, RoutingAssessment, RoutingPinEvidence,
} from "./routing-economics";

const REPO = resolve(import.meta.dir, "../..");
const internalWriter = resolve(REPO, "cli/run-fact-internal.clj");
const STRUGGLE_TRIGGER_VALUES: ReadonlySet<string> = new Set([
  "consecutive_errors", "tool_loop", "no_progress",
]);

export interface RunRecord {
  thread: string; // the thread driven, or "(ad-hoc)" for a bare spawn
  agent: string; // agent id / handle
  tokens?: number; // legacy exact total for producers without structured terminal usage
  tokenUsage?: NormalizedTokenUsage; // observed components plus terminal scope/status
  durationMs: number; // North-observed wall-clock duration
  providerDurationMs?: number; // provider-reported duration when available
  posture: string; // unplanned | atomic | composite | spawn
  // Effective admitted route, denormalized onto @run so dial analytics need no
  // @run.agent -> @agent:<id> join. Pre-side-effect fallback may change these
  // values before execution; the route is immutable once side effects begin.
  model?: string; // opus | sonnet | haiku
  effort?: string; // low | medium | high | xhigh | max
  role?: string; // executor | implementer | integrator | designer | researcher | ...
  provider?: string; // anthropic | openai
  providerTarget?: string; // exact account/target that executed the final route
  providerReason?: string; // explainable auto/explicit routing decision
  /** Exact target/model supportedModels evidence admitted for the final route. */
  modelAvailability?: ProviderModelAdmissionReceipt;
  requestedProvider?: string;
  requestedTarget?: string;
  requestedTier?: string;
  requestedModel?: string;
  requestedEffort?: string;
  routingMetadata?: RoutingRequest;
  routingAssessment?: RoutingAssessment;
  routingAdmissionReceipt?: RoutingAdmissionReceipt;
  routingPinEvidence?: RoutingPinEvidence;
  /** Explicit execution-ledger provenance. Missing on legacy rows means unknown. */
  executionSource?: "north-managed" | "provider-native";
  executionTransport?: "anthropic-agent-sdk" | "codex-app-server" | "codex-cli" | "provider-hook";
  providerSessionPersistence?: "persisted" | "ephemeral" | "unknown";
  northSessionId?: string;
  threadProvenance?: "exact" | "ad-hoc" | "unknown";
  turnProvenance?: "provider-terminal" | "pre-provider" | "unknown";
  /** Redacted identifiers proving which operational prompt/tool contracts were applied. */
  promptComposition?: HarnessCompositionEvidence;
  /** Exact provider-executable authority from the final admitted route. */
  effectiveAuthority?: ProviderAuthoritySurface;
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
  /** Full nested-cause chain for a blocked_preflight (or other retry-safe) death — the
   * real underlying failure a bare processOutcome code otherwise swallows (thread 019f8300). */
  preflightCause?: string;
  deliveryOutcome?: string;
  deliveryReason?: string;
  deliveryProof?: DeliveryProof;
  numTurns?: number; // SDKResultMessage.num_turns (was dropped before)
  compactions?: number; // count of SDK compact_boundary events observed this run (audit fix 4)
  /** Immutable admission-time dispatcher judgment; required by recordRun. */
  judgmentGrade?: JudgmentGradeSnapshot;
  /** Provider-neutral observer result; required by recordRun. */
  struggleObservation?: StruggleObservation;
  // Legacy in-flight escalation fields — the machinery is retired; these stay so
  // historical @run rows (escalation_* facts, routing-report escalated column) keep
  // reading. No current producer sets them.
  escalationTier?: number; // legacy final ladder tier
  escalations?: Array<{ from: string; to: string; reason: string }>;
  // Spend guard (build-order step 2). Present only on an API-billed run that
  // carried a reservation from admission. No producer sets these until the first
  // API adapter lands (step 4) and threads the reservation from admission through
  // to the terminal record; the settlement below is dormant until then. The
  // reaper's dead-lane settlement is a separate step-3 seam. Micro-USD integers.
  spendTarget?: string;
  spendPeriod?: string;
  spendReservationMicrousd?: number;
}

export function classifyTurnProvenance(
  resultTerminal: unknown,
  processOutcome: string | undefined,
): NonNullable<RunRecord["turnProvenance"]> {
  if (resultTerminal && typeof resultTerminal === "object") return "provider-terminal";
  if (processOutcome === "blocked_preflight" || processOutcome === "blocked_spend_guard")
    return "pre-provider";
  return "unknown";
}

export type ObservedRunRecord = RunRecord & Required<
  Pick<RunRecord, "judgmentGrade" | "struggleObservation">
>;

export type RunPublicationStatus = "recorded" | "unavailable";

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
  if (rec.preflightCause) facts.push(["preflight_cause", rec.preflightCause]);
  if (rec.deliveryOutcome) facts.push(["delivery_outcome", rec.deliveryOutcome]);
  if (rec.deliveryReason) facts.push(["delivery_reason", rec.deliveryReason]);
  if (rec.deliveryProof?.deliveryEvidence)
    facts.push(["delivery_evidence", rec.deliveryProof.deliveryEvidence]);
  if (rec.deliveryProof?.deliveryEvidenceSha256)
    facts.push(["delivery_evidence_sha256", rec.deliveryProof.deliveryEvidenceSha256]);
  if (rec.deliveryProof?.deliveryAttestation)
    facts.push(["delivery_attestation", rec.deliveryProof.deliveryAttestation]);
  if (rec.deliveryProof?.deliveryAttestationSha256)
    facts.push(["delivery_attestation_sha256", rec.deliveryProof.deliveryAttestationSha256]);
  // Canonicalize AT WRITE: every caller (spawn/dispatch admission, fallback,
  // legacy env-fallback) funnels through the one shared alias map (Gaffer
  // catalogs' modelAliases, see providers/catalog.ts) so a `model` fact is
  // never a bare family alias (opus/sonnet/fable/haiku/...), and a model that
  // does not belong to the executed provider (fallback-death lag) writes no
  // model rather than a phantom cross-provider one.
  const model = canonicalWriteModel(rec.provider as ProviderId | undefined, rec.model);
  if (model) facts.push(["model", model]);
  if (rec.effort) facts.push(["effort", rec.effort]);
  if (rec.role) facts.push(["role", rec.role]);
  if (rec.provider) facts.push(["provider", rec.provider]);
  if (rec.providerTarget) facts.push(["provider_target", rec.providerTarget]);
  if (rec.providerReason) facts.push(["provider_reason", rec.providerReason]);
  if (rec.modelAvailability) {
    const evidence = rec.modelAvailability;
    if (rec.provider !== evidence.provider
        || rec.providerTarget !== evidence.targetId
        || model !== evidence.model) {
      throw new Error("model availability evidence does not match the final provider route");
    }
    facts.push(["model_availability_target", evidence.targetId]);
    facts.push(["model_availability_source", evidence.source]);
    facts.push(["model_availability_observed_at", evidence.observedAt]);
    facts.push(["model_availability_model", evidence.model]);
    facts.push(["model_availability_digest", evidence.observationDigest]);
  }
  const authority = rec.effectiveAuthority;
  if (authority) {
    if (rec.provider && authority.provider !== rec.provider) {
      throw new Error(
        `effective authority provider ${authority.provider} does not match final provider ${rec.provider}`,
      );
    }
    facts.push(["effective_authority_provider", authority.provider]);
    facts.push(["effective_native_multi_agent", authority.nativeMultiAgent]);
    facts.push(["effective_live_input", authority.liveInput]);
    facts.push(["effective_authoring_hooks", authority.authoringHooks]);
    for (const capability of authority.capabilities)
      facts.push(["effective_authority_capability", capability]);
    for (const tool of authority.northEnabledTools)
      facts.push(["effective_north_enabled_tool", tool]);
    if (authority.provider === "openai") {
      facts.push(["effective_sandbox", authority.sandbox]);
      facts.push(["effective_web", authority.web]);
    } else {
      facts.push(["effective_web", authority.web]);
      for (const tool of authority.builtins) facts.push(["effective_builtin", tool]);
      for (const tool of authority.managedTools) facts.push(["effective_mcp_tool", tool]);
    }
  }
  if (rec.requestedProvider) facts.push(["requested_provider", rec.requestedProvider]);
  if (rec.requestedTarget) facts.push(["requested_target", rec.requestedTarget]);
  if (rec.requestedTier) facts.push(["requested_tier", rec.requestedTier]);
  if (rec.requestedModel) facts.push(["requested_model", rec.requestedModel]);
  if (rec.requestedEffort) facts.push(["requested_effort", rec.requestedEffort]);
  if (rec.executionSource) facts.push(["execution_source", rec.executionSource]);
  if (rec.executionTransport) facts.push(["execution_transport", rec.executionTransport]);
  if (rec.providerSessionPersistence)
    facts.push(["provider_session_persistence", rec.providerSessionPersistence]);
  if (rec.northSessionId) facts.push(["north_session_id", rec.northSessionId]);
  if (rec.threadProvenance) facts.push(["thread_provenance", rec.threadProvenance]);
  if (rec.turnProvenance) facts.push(["turn_provenance", rec.turnProvenance]);
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
  const assessment = rec.routingAssessment;
  const receipt = rec.routingAdmissionReceipt;
  if (receipt) {
    facts.push(["routing_admission_receipt_version", String(receipt.version)]);
    facts.push(["routing_request_sha256", receipt.routingRequestSha256]);
    facts.push(["staffing_catalog_sha256", receipt.staffingCatalogSha256]);
    facts.push(["provider_catalogs_sha256", receipt.providerCatalogsSha256]);
    facts.push(["routing_policy_sha256", receipt.routingPolicySha256]);
    facts.push(["routing_assessment_status", assessment ? "recorded" : "unavailable"]);
    if (receipt.routingAssessmentSha256)
      facts.push(["routing_assessment_sha256", receipt.routingAssessmentSha256]);
    facts.push(["routing_pin_evidence_status", receipt.pinEvidenceStatus]);
    if (receipt.pinEvidenceSha256)
      facts.push(["routing_pin_evidence_sha256", receipt.pinEvidenceSha256]);
    facts.push(["routing_override_evidence_status", receipt.overrideEvidence.status]);
    if (receipt.overrideEvidence.exceptionCode)
      facts.push(["routing_override_exception_code", receipt.overrideEvidence.exceptionCode]);
    for (const field of receipt.overrideEvidence.changedAxes)
      facts.push(["routing_receipt_override", field]);
    for (const [axis, value] of Object.entries(receipt.appliedAxes))
      facts.push([`routing_applied_${axis}`, value]);
    for (const [axis, value] of Object.entries(receipt.stockAxes ?? {}))
      facts.push([`routing_stock_${axis}`, value]);
  }
  if (assessment) {
    facts.push(["routing_assessment_policy", assessment.version]);
    for (const [signal, value] of Object.entries(assessment.signals))
      facts.push([`routing_signal_${signal}`, value]);
    facts.push(["routing_derived_tier", assessment.derived.minimumTier]);
    facts.push(["routing_derived_reasoning", assessment.derived.minimumReasoning]);
    for (const code of assessment.derived.ruleCodes)
      facts.push(["routing_rule_code", code]);
    facts.push(["routing_selected_tier", assessment.selected.tier]);
    facts.push(["routing_selected_reasoning", assessment.selected.reasoning]);
    if (assessment.exception) {
      facts.push(["routing_exception_code", assessment.exception.code]);
      facts.push(["routing_exception_detail", assessment.exception.detail]);
    }
    if (assessment.exceptionalDeliberation)
      facts.push(["routing_exceptional_deliberation", assessment.exceptionalDeliberation]);
  }
  if (rec.routingPinEvidence) {
    const pin = rec.routingPinEvidence;
    facts.push(["routing_pin_policy", pin.policyVersion]);
    facts.push(["routing_pin_issued_at", pin.issuedAt]);
    facts.push(["routing_pin_expires_at", pin.expiresAt]);
    facts.push(["routing_pin_reason_code", pin.reasonCode]);
    facts.push(["routing_pin_detail", pin.detail]);
    for (const item of pin.pins)
      facts.push(["routing_pin", JSON.stringify(item)]);
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
  if (rec.spendTarget && rec.spendReservationMicrousd != null) {
    // spend_evidence mirrors the settlement rule: exact terminal token usage
    // will settle DOWN; anything else keeps the worst-case reservation.
    const exactSpend = rec.tokenUsage?.totalStatus === "exact";
    facts.push(["spend_target", rec.spendTarget]);
    facts.push(["spend_envelope_microusd", String(rec.spendReservationMicrousd)]);
    facts.push(["spend_reserved_microusd", String(rec.spendReservationMicrousd)]);
    facts.push(["spend_evidence", exactSpend ? "exact" : "reserved-worst-case"]);
  }
  if (rec.numTurns != null) facts.push(["num_turns", String(rec.numTurns)]);
  if (rec.compactions) facts.push(["compactions", String(rec.compactions)]);
  if (rec.judgmentGrade) {
    const snapshot = rec.judgmentGrade;
    const validGrade = parseJudgmentGrade(snapshot.grade);
    const valid = snapshot.status === "valid"
      && snapshot.source === "thread"
      && validGrade === snapshot.grade;
    const unavailable = snapshot.status === "unavailable"
      && snapshot.grade === undefined
      && (snapshot.source === "thread" || snapshot.source === "ad-hoc");
    const invalid = snapshot.status === "invalid"
      && snapshot.grade === undefined
      && snapshot.source === "thread";
    if (!valid && !unavailable && !invalid) {
      throw new Error("invalid run-local judgment_grade snapshot");
    }
    if (validGrade) facts.push(["judgment_grade", validGrade]);
    facts.push(["judgment_grade_status", snapshot.status]);
    facts.push(["judgment_grade_source", snapshot.source]);
  }
  if (rec.struggleObservation) {
    const observation = rec.struggleObservation;
    if (observation.policyVersion !== STRUGGLE_DETECTOR_POLICY_VERSION) {
      throw new Error("unsupported struggle detector policy version");
    }
    if (observation.topology !== "worker" && observation.topology !== "orchestrator") {
      throw new Error("invalid struggle topology");
    }
    for (const [name, value] of [
      ["error-streak", observation.errorStreakThreshold],
      ["loop-repeat", observation.loopRepeatThreshold],
      ["loop-window", observation.loopWindow],
      ["no-progress", observation.noProgressTurnThreshold],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > STRUGGLE_THRESHOLD_MAX) {
        throw new Error(`invalid struggle ${name} threshold`);
      }
    }
    if (observation.loopRepeatThreshold > observation.loopWindow) {
      throw new Error("struggle loop-repeat threshold exceeds loop window");
    }
    if (!Number.isSafeInteger(observation.errorCount) || observation.errorCount < 0) {
      throw new Error("invalid struggle error count");
    }
    if (new Set(observation.triggers).size !== observation.triggers.length
        || observation.triggers.some((trigger) => !STRUGGLE_TRIGGER_VALUES.has(trigger))) {
      throw new Error("invalid struggle trigger observation");
    }
    facts.push(["error_count", String(observation.errorCount)]);
    facts.push(["struggle_detector_policy_version", observation.policyVersion]);
    facts.push(["struggle_topology", observation.topology]);
    facts.push(["struggle_error_streak_threshold", String(observation.errorStreakThreshold)]);
    facts.push(["struggle_loop_repeat_threshold", String(observation.loopRepeatThreshold)]);
    facts.push(["struggle_loop_window", String(observation.loopWindow)]);
    facts.push([
      "struggle_no_progress_turn_threshold",
      String(observation.noProgressTurnThreshold),
    ]);
    for (const reason of observation.triggers) facts.push(["struggle", reason]);
  }
  if (rec.escalationTier != null && rec.escalationTier >= 0)
    facts.push(["escalation_tier", String(rec.escalationTier)]);
  if (rec.escalations && rec.escalations.length) {
    facts.push(["escalation_count", String(rec.escalations.length)]);
    facts.push(["escalation_path", rec.escalations.map((e) => `${e.from}>${e.to}`).join(" ")]);
    facts.push(["escalation_reasons", rec.escalations.map((e) => e.reason).join(",")]);
  }
  return facts;
}

export function recordRun(
  rec: ObservedRunRecord,
  id = newRunId(rec.agent),
  timeoutMs = 10_000,
): Promise<RunPublicationStatus> {
  let facts: Array<[string, string]>;
  try {
    facts = runFacts(rec);
  } catch (error) {
    console.error(
      `[telemetry] @${id} unavailable: ${
        error instanceof Error ? error.message : "run fact serialization failed"
      }`,
    );
    return Promise.resolve("unavailable");
  }
  // Terminal settlement of an API-billed reservation (spend-guard step 3).
  // Dormant until the spend fields are set; subscription runs never reach the
  // CAS. Never fails a run.
  if (rec.spendTarget && rec.spendPeriod && rec.spendReservationMicrousd != null
      && rec.provider && providerBilling(rec.provider) === "api-billed") {
    try {
      settleSpend({
        target: rec.spendTarget,
        period: rec.spendPeriod,
        reservedMicrousd: rec.spendReservationMicrousd,
        status: rec.tokenUsage?.totalStatus === "exact" ? "exact" : "unknown",
        inputTokens: rec.tokenUsage?.inputTokens,
        outputTokens: rec.tokenUsage?.outputTokens,
      });
    } catch { /* never fail a run on settlement */ }
  }
  return new Promise((resolvePublication) => {
    let resolved = false;
    const settle = (status: RunPublicationStatus) => {
      if (resolved) return;
      resolved = true;
      resolvePublication(status);
    };
    // Hermetic capture engines intentionally retain the ordinary fact-verb shape.
    if (process.env.NORTH_IDENTITY_TEST_REDIRECT === "1") {
      let remaining = facts.length;
      let committed = true;
      if (remaining === 0) {
        settle("recorded");
        return;
      }
      const factSettled = (error: Error | null) => {
        if (error) committed = false;
        remaining--;
        if (remaining === 0) settle(committed ? "recorded" : "unavailable");
      };
      for (const [predicate, value] of facts) {
        try {
          execFile(
            process.env.NORTH_BIN ?? "north",
            ["tell", id, predicate, value],
            { timeout: Math.max(1, Math.floor(timeoutMs)) },
            (error) => factSettled(error),
          );
        } catch {
          factSettled(new Error("run telemetry process unavailable"));
        }
      }
      return;
    }
    try {
      execFile("bb", [
        internalWriter,
        process.env.NORTH_PORT ?? "7977",
        id,
        JSON.stringify(facts),
      ], { timeout: Math.max(1, Math.floor(timeoutMs)) }, (error, _stdout, stderr) => {
        // Bounded and non-throwing, but NOT silent: a swallowed writer rejection
        // hid a 3-day telemetry outage (2026-07-17). A failed terminal write
        // leaves the run's tokens/outcome/duration unrecorded, so leave a loud
        // stderr breadcrumb — never a throw; the run's real result stands.
        if (error) {
          const detail = (stderr && String(stderr).trim()) || error.message;
          process.stderr.write(
            "[telemetry] recordRun write FAILED for " + id + ": " + detail + "\n",
          );
        }
        settle(error ? "unavailable" : "recorded");
      });
    } catch (error) {
      // execFile can throw synchronously (e.g. bb missing) before the callback.
      process.stderr.write(
        "[telemetry] recordRun could not spawn writer for " + id + ": " + String(error) + "\n",
      );
      settle("unavailable");
    }
  });
}

export function newRunId(agent: string): string {
  // `@run:` (colon), NOT `@run-`: the coordinator log-split routes a subject to
  // telemetry.log by its stored `kind` OR, kind-less, the token before its first
  // colon (fram coord_daemon subject-token). A run's body facts are written
  // BEFORE the terminal `kind run` commit marker, so during that window the
  // subject is kind-less; a dash id has no colon -> token nil -> the body facts
  // misroute to coordination.log (regression 2026-07-17). The colon puts `run`
  // in the token so every run-scoped write lands in telemetry.log immediately,
  // matching the @session:/@mine:/@guard_denial: telemetry-subject convention.
  return `run:${agent}-${randomUUID()}`;
}
