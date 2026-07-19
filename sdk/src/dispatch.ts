import { randomUUID } from "node:crypto";
import { getThreadFacts, getChildren, normalizeNorthEntityId } from "./north-client";
import { derivePosture, buildPrompt } from "./posture";
import { StreamWriter } from "./stream-writer";
import {
  harnessCompositionEvidence, harnessOptions, renewHarnessPresence, DEFAULT_SYSTEM_PROMPT,
  type Effort, type HarnessCompositionEvidence,
} from "./harness";
import { inputChannel, subscribeFeed } from "./coordination";
import { normalizeUsage } from "./usage";
import { newRunId, recordRun } from "./telemetry";
import { deathReason, notifyDeath } from "./death";
import { withStallWatchdog, stallMs, notifyStall, notifyTurnCap } from "./watchdog";
import { makeBgTracker, bgContinuationMessage, maxBgContinuations } from "./bgtasks";
import {
  assessChildFinalization, childContinuationMessage, childReductionMessage,
  decideChildTurnEnd, initialChildContinuationState, notifyEarlyExitChildren,
  settleChildren, type ChildSettlement,
} from "./children";
import {
  bespokeContractFingerprint, writeAgentFacts, writeAgentTerminal, updateAgentRoute,
  userAnchoredPath,
} from "./identity";
import { BESPOKE_FINGERPRINT_DOMAIN, BESPOKE_FINGERPRINT_VERSION } from "./bespoke-contract";
import {
  admitBillableClock, clockFinalize, clockStop,
  type BillableClockAdmission,
} from "./clock";
import {
  formatProviderAuthoritySurface, providerLiveInput, routedQuery, selectProvider, ProviderRetrySafeError,
  type ProviderAuthoritySurface, type ProviderPreference,
} from "./providers";
import type { AgentQuery } from "./providers/types";
import { refreshCodexEntitlementsIfStale } from "./codex-entitlement";
import { resolveTier, type SemanticTier } from "./providers/catalog";
import type { RoutingRequest } from "./routing-metadata";
import { admitRoutingRequest, routingRequestFromEnv } from "./routing-admission";
import {
  gafferCapabilities,
} from "./gaffer-staffing";
import { refreshAccountUsages } from "./account-usage";
import { resolveDispatchWorkingDirectory } from "./dispatch-context";
import {
  claimDispatchDriver, DispatchDriverReleaseError, type DispatchDriverOptions,
} from "./dispatch-driver";
import {
  admitResourceEnvelope, completeResourceEnvelope, envelopeContextFromEnv,
  reserveResourceEnvelopeRetry, ResourceEnvelopeExceededError, type EnvelopeAdmission,
} from "./resource-envelopes";
import {
  assertCoordinationAuthority, assertManagedChildTopology,
} from "./topology-authority";
import { admitPinnedProvider } from "./execution-admission";
import { classifyExecutionTerminal } from "./execution-outcome";
import {
  notifyTerminalSettlement, TerminalPublicationBudget, type TerminalNotification,
} from "./terminal-notification";
import { assessThreadDelivery, type DeliveryAssessment } from "./delivery-verification";
import {
  loadDeliveryRunState, newDeliveryRunContext, reserveDeliveryRun,
  type DeliveryReservation, type DeliveryRunContext, type DeliveryRunState,
} from "./delivery-evidence";
import { takeDispatchTestRuntime } from "./internal/test-runtime";
import { ManagedLiveInputRoute } from "./live-input-route";
import {
  makeStruggleObserver, resolveStrugglePolicy,
  assertExpectedStrugglePolicy,
  type StrugglePolicy,
} from "./struggle";
import {
  judgmentGradeFromThreadFacts,
  type JudgmentGradeSnapshot,
} from "./judgment-grade";

const PLAN_TOOLS = ["Read", "Grep", "Glob", "Bash"];
const EXEC_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];
const SURVEY_TOOLS = ["Read", "Grep", "Glob"];

interface DispatchResult {
  threadId: string;
  posture: "unplanned" | "atomic" | "composite";
  result: string;
}

interface ManagedClockLease {
  admission: BillableClockAdmission;
  finalized: boolean;
}

export interface DispatchDependencies {
  /** Complete per-subtask request; programmatic callers never inherit ambient routing. */
  routingMetadata: RoutingRequest;
  /** Explicit child identity for a programmatic handoff; never inferred from a parent. */
  agentId?: string;
}

interface DispatchRuntime {
  claimDriver?: typeof claimDispatchDriver;
  driverOptions?: DispatchDriverOptions;
  queryFn?: (args: any) => AgentQuery;
  loadThreadFacts?: typeof getThreadFacts;
  loadChildren?: typeof getChildren;
  deliveryRuntime?: {
    reserve: (context: DeliveryRunContext) => DeliveryReservation;
    load: (runId: string) => DeliveryRunState;
  };
  childSettlementReader?: (agentId: string) => ChildSettlement;
  feedSubscriber?: typeof subscribeFeed;
}

const DISPATCH_DEPENDENCY_FIELDS = new Set(["routingMetadata", "agentId"]);

function allowlistedDispatchDependencies(
  value: DispatchDependencies,
): DispatchDependencies {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("managed North dispatch request must be an object");
  const admitted: Record<string, unknown> = {};
  for (const [field, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!DISPATCH_DEPENDENCY_FIELDS.has(field))
      throw new Error(`managed North dispatch request has unknown field ${field}`);
    if (descriptor.get || descriptor.set)
      throw new Error(`managed North dispatch request field ${field} must be a data property`);
    admitted[field] = descriptor.value;
  }
  return admitted as unknown as DispatchDependencies;
}

interface DispatchAgentIdOptions {
  agentId?: string;
  driverOptions?: DispatchDriverOptions;
}

export function createDispatchAgentId(threadId: string, now = Date.now(), uuid = randomUUID()): string {
  const threadFragment = threadId.replace(/[^a-z0-9]/gi, "").slice(-12) || "thread";
  return `sdk-${threadFragment}-${now.toString(36)}-${uuid}`;
}

export function selectDispatchAgentId(
  threadId: string,
  dependencies: DispatchAgentIdOptions = {},
): string {
  if (dependencies.agentId) return dependencies.agentId;
  const preclaimed = dependencies.driverOptions?.preclaimed
    ?? process.env.NORTH_DISPATCH_DRIVER_PRECLAIMED === "1";
  if (preclaimed && process.env.AGENT_ID) return process.env.AGENT_ID;
  return createDispatchAgentId(threadId);
}

async function runDispatch(
  threadId: string,
  judgmentGrade: JudgmentGradeSnapshot,
  strugglePolicy: StrugglePolicy,
  envelopeAdmission?: EnvelopeAdmission,
  hydratedMetadata?: RoutingRequest,
  hydratedWorkingDirectory?: string,
  hydratedAgentId?: string,
  queryFn?: (args: any) => AgentQuery,
  hydratedFacts?: ReturnType<typeof getThreadFacts>,
  hydratedChildren?: ReturnType<typeof getChildren>,
  loadTerminalFacts: typeof getThreadFacts = getThreadFacts,
  deliveryRuntime?: DispatchRuntime["deliveryRuntime"],
  childSettlementReader: (agentId: string) => ChildSettlement = settleChildren,
  feedSubscriber: typeof subscribeFeed = subscribeFeed,
  clockLease?: ManagedClockLease,
): Promise<DispatchResult> {
  const runStartedAt = process.hrtime.bigint();
  const routingMetadata = hydratedMetadata;
  if (!routingMetadata) throw new Error("managed North dispatch execution requires explicit routingMetadata");
  const role = routingMetadata.role!;
  const capabilities = gafferCapabilities(routingMetadata);
  const facts = hydratedFacts ?? getThreadFacts(threadId);
  if (!facts.length) {
    throw new Error(`Thread @${threadId} not found or has no facts`);
  }

  const children = hydratedChildren ?? getChildren(threadId);
  const hasChildren = children.length > 0;
  const posture = derivePosture(facts, hasChildren);

  // Done-bars: a committed thread with no done_when has no machine-checkable exit criterion —
  // the worker will define its own as first act (see buildPrompt). Warn so the gap is visible.
  if (posture.committed && posture.doneWhen.length === 0) {
    console.log(`[dispatch] ⚠ @${threadId} committed but has NO done_when — worker will define its own done bar as first act`);
  }

  // Judgment grade is the dispatcher's immutable S/M/L estimate of judgment
  // saturation, not the worker's. It feeds aggregate calibration. Warn (teach,
  // never block or inject) when a committed thread lacks it, mirroring the
  // done_when warning above. Bands live in docs/provider-architecture.md.
  if (posture.committed && judgmentGrade.status === "unavailable") {
    console.log(`[dispatch] ⚠ @${threadId} committed but has NO judgment_grade — set s|m|l (S≤3 / M 4-11 / L≥12 expected decision points) so the detector can calibrate`);
  } else if (judgmentGrade.status === "invalid") {
    console.log(`[dispatch] ⚠ @${threadId} has malformed legacy judgment_grade evidence — replace it with exact s|m|l before calibration`);
  }

  if (posture.hasOutcome) {
    return { threadId, posture: "atomic", result: "already done" };
  }

  const workingDirectory = hydratedWorkingDirectory ?? resolveDispatchWorkingDirectory(facts);

  const prompt = buildPrompt(threadId, posture, facts);
  const postureTools = posture.atomic
    ? EXEC_TOOLS
    : posture.planned
      ? SURVEY_TOOLS
      : PLAN_TOOLS;

  const postureLabel = !posture.planned
    ? "unplanned"
    : posture.atomic
      ? "atomic"
      : "composite";

  const agentId = hydratedAgentId ?? createDispatchAgentId(threadId);
  let runId = newRunId(agentId);
  const runContext = newDeliveryRunContext(runId, threadId, agentId);
  const runtime = deliveryRuntime ?? (queryFn ? undefined : {
    reserve: reserveDeliveryRun,
    load: loadDeliveryRunState,
  });
  let deliveryReservation: DeliveryReservation | undefined;
  let deliveryReservationReady = false;
  const stream = new StreamWriter(agentId);
  const requestedTier = routingMetadata.tier ?? process.env.AGENT_TIER as SemanticTier | undefined;
  const requestedReasoning = (routingMetadata.reasoning ?? process.env.AGENT_EFFORT) as Effort | undefined;
  const providerPreference = process.env.AGENT_PROVIDER as ProviderPreference | undefined ?? "auto";
  const targetPreference = process.env.AGENT_TARGET;
  const routingRequest = { provider: providerPreference, target: targetPreference };
  if (!queryFn) {
    admitPinnedProvider(providerPreference, capabilities);
    try { await refreshAccountUsages({ requested: routingRequest }); } catch { /* telemetry is advisory */ }
    try { await refreshCodexEntitlementsIfStale({ requested: routingRequest }); } catch { /* telemetry is advisory */ }
  }
  const routing = selectProvider(routingRequest, undefined,
    { tier: requestedTier, reasoning: requestedReasoning,
      model: process.env.AGENT_MODEL, stableKey: agentId, capabilities });
  const resolved = resolveTier(routing.provider, requestedTier,
    process.env.AGENT_MODEL, requestedReasoning);
  const composition = routingMetadata.composition!;
  const identityBase = {
    kind: "lane",
    role,
    compositionKind: composition.kind,
    compositionId: composition.id,
    compositionOverrides: composition.kind === "preset" ? composition.overrides : undefined,
    compositionOverrideReason: composition.kind === "preset" ? composition.overrideReason : undefined,
    compositionNearestPreset: composition.kind === "bespoke" ? composition.nearestPreset : undefined,
    compositionBespokeReason: composition.kind === "bespoke" ? composition.bespokeReason : undefined,
    compositionPromotionCandidate: composition.kind === "bespoke" ? composition.promotionCandidate : undefined,
    compositionContractFingerprint: composition.kind === "bespoke"
      ? bespokeContractFingerprint(composition.contract) : undefined,
    compositionContractFingerprintVersion: composition.kind === "bespoke"
      ? BESPOKE_FINGERPRINT_VERSION : undefined,
    compositionContractFingerprintDomain: composition.kind === "bespoke"
      ? BESPOKE_FINGERPRINT_DOMAIN : undefined,
    repo: userAnchoredPath(workingDirectory),
    goal: posture.title,
    coordinator: process.env.AGENT_COORDINATOR,
  } as const;
  const initialLiveInput = providerLiveInput(routing.provider);
  const ch = inputChannel(prompt);
  const liveInputRoute = new ManagedLiveInputRoute(
    agentId,
    identityBase,
    {
      provider: routing.provider,
      providerTarget: routing.target,
      liveInput: initialLiveInput,
      model: resolved.model,
      effort: resolved.effort,
    },
    (message) => ch.push(message),
    feedSubscriber,
  );
  writeAgentFacts(agentId, { ...identityBase, model: resolved.model,
    provider: routing.provider, providerTarget: routing.target,
    liveInput: initialLiveInput, ...liveInputRoute.initialProjection(),
    effort: resolved.effort });
  const activeRoute = () => ({
    provider: routing.provider,
    providerTarget: routing.target,
    liveInput: providerLiveInput(routing.provider),
    model: routing.resolvedModel ?? resolved.model,
    effort: routing.resolvedEffort ?? resolved.effort,
  });
  const refreshIdentityRoute = (required = false) => {
    liveInputRoute.refresh(activeRoute(), required);
  };

  console.log(`[dispatch] @${threadId} — ${posture.title}`);

  let result = "";
  let resultMsg: any = null;
  const terminalMessages: any[] = [];
  let outcome = "ran";

  // Real-time coordination: run the prompt in streaming-input mode so peers can inject
  // pings only when the admitted provider can consume turns after its initial prompt.
  // Stream watchdog (thread 019f4d54): wrap the SDK iterator so a stall (no message for
  // N min while the query is open) is caught — the iterator neither yields nor throws on
  // a hang, so the catch below would never fire. N min silence -> stalled fact + ping;
  // 2N -> abort + outcome=stalled + a durable death fact. Terminal peer wakes
  // are deferred until the terminal and run publications settle.
  const coordHandle = process.env.AGENT_COORDINATOR;
  const window = stallMs();
  let stallAborted = false;
  let terminalSignal: Pick<TerminalNotification, "detail" | "subject"> = {};
  const terminalAuxiliaryWrites: Array<(timeoutMs: number) => void> = [];
  let liveInputFreezeError: unknown;
  // Background-task refusal (thread 019f4ed2, half a): don't finalize on the first
  // `result` while a harness-tracked background task is live — see bgtasks.ts.
  const bgTracker = makeBgTracker();
  let bgContinuations = 0;
  const orchestrator = routingMetadata.topology === "orchestrator";
  const struggle = makeStruggleObserver(strugglePolicy);
  let childContinuation = initialChildContinuationState();
  let q: AgentQuery | undefined;
  let injectedCompositionEvidence: HarnessCompositionEvidence | undefined;
  let admittedRoute: {
    provider: ProviderAuthoritySurface["provider"];
    evidence: HarnessCompositionEvidence | undefined;
    authority: ProviderAuthoritySurface;
  } | undefined;
  let queryInterrupted = false;
  const interruptQuery = async () => {
    if (queryInterrupted || !q) return;
    queryInterrupted = true;
    try { await q.interrupt?.(); } catch { /* cleanup must not replace the terminal outcome */ }
  };

  let compactions = 0; // SDK auto-compaction events observed across the run (audit fix 4)
  // Error boundary (thread 019f2800): the SDK runs the turn in a subprocess; if it dies
  // (OOM SIGKILL / parent SIGTERM / idle Transport-closed) the generator THROWS exitError
  // here. catch -> outcome "died" + durable agent_death facts on this thread and @swarm;
  // finally -> ALWAYS stop the feed and close the channel. The peer wake is emitted only
  // after the committed terminal and run publication attempts have settled.
  try {
    // Reserve only at the last pre-provider seam. Earlier routing/admission
    // failures must not strand undiscoverable reservation-only subjects.
    try {
      if (runtime) {
        deliveryReservation = runtime.reserve(runContext);
        if (!deliveryReservation) throw new Error("reservation acknowledgement unavailable");
        deliveryReservationReady = true;
      }
    } catch {
      const abandonedRunId = runId;
      runId = newRunId(agentId);
      console.error(
        `[delivery] @${abandonedRunId} reservation unavailable; rotating telemetry to @${runId} and leaving delivery unverified`,
      );
    }
    const agentOptions = harnessOptions({
      self: agentId,
      extraTools: postureTools,
      model: resolved.model,
      effort: resolved.effort,
      provider: routing.provider,
      routingMetadata,
      role,
      posture: routingMetadata.posture,
      cwd: workingDirectory,
      deliveryRun: deliveryReservationReady ? runContext : undefined,
      systemPrompt: `You are a north agent executing thread @${threadId}. ${DEFAULT_SYSTEM_PROMPT}`,
    });
    console.log(
      `[dispatch] posture: ${postureLabel}, provider: ${routing.provider}, `
      + `target: ${routing.target} (${routing.reason})`,
    );
    if (queryFn) injectedCompositionEvidence = harnessCompositionEvidence(agentOptions);
    const queryArgs = {
      prompt: ch.stream(),
      options: agentOptions,
    };
    if (queryFn && feedSubscriber !== subscribeFeed)
      await liveInputRoute.activate(activeRoute());
    q = queryFn
      ? queryFn(queryArgs)
      : routedQuery(routing, queryArgs, requestedTier,
        async (transition) => {
          await liveInputRoute.beforeFallback(
            transition,
            () => reserveResourceEnvelopeRetry(envelopeAdmission),
          );
        },
        async (_decision, evidence, authority) => {
          if (!authority) return;
          await liveInputRoute.activate({
            ...activeRoute(),
            liveInput: authority.liveInput,
          });
          admittedRoute = { provider: authority.provider, evidence, authority };
          console.log(
            `[dispatch] effective authority: ${formatProviderAuthoritySurface(authority)}`,
          );
        });
    const watched = withStallWatchdog((q as AsyncIterable<any>)[Symbol.asyncIterator](), {
      stallMs: window,
      onStall: (mins) => notifyStall(agentId, mins, { coordinator: coordHandle }),
      onAbort: () => { stallAborted = true; },
    });
    for await (const message of watched) {
      const msg = message as any;
      renewHarnessPresence(agentOptions);
      refreshIdentityRoute();
      stream.writeSDKMessage(msg);
      if (msg.type === "system" && msg.subtype === "compact_boundary") {
        compactions++;
        console.error(`[harness] @agent:${agentId} context compaction #${compactions} (compact_boundary)`);
      }
      if (bgTracker.observe(msg) === "settled") bgContinuations = 0; // forward progress refreshes the cap

      const struggleTrigger = struggle.observe(msg);
      if (struggleTrigger) {
        console.error(
          `[struggle] @agent:${agentId} sensor fired: ${struggleTrigger} `
          + `(turn ${struggle.state.turn}, ${struggle.state.totalErrors} tool error(s)) `
          + "— recorded as execution-axis evidence, no in-flight change",
        );
      }

      if (msg.type === "result") {
        terminalMessages.push(msg);
        if (typeof msg.result === "string") result = msg.result;
        resultMsg = msg;
        const cap = typeof msg.subtype === "string" && msg.subtype.startsWith("error_max")
          ? msg.subtype
          : null;
        if (cap) {
          outcome = cap === "error_max_turns" ? "max_turns" : "capped";
          const partial = result.trim()
            ? `partial: ${result.trim().slice(0, 200)}`
            : "no partial result";
          const detail = `${cap} — ${partial}`;
          terminalSignal = { subject: "TURN CAP", detail };
          terminalAuxiliaryWrites.push((timeoutMs) =>
            notifyTurnCap(agentId, detail, {}, timeoutMs)
          );
          break;
        }
        const providerError = msg.subtype !== "success"
          || msg.is_error === true
          || (Array.isArray(msg.errors) && msg.errors.length > 0);
        if (providerError) {
          outcome = "provider_error";
          break;
        }
        if (ch.pending() === 0) {
          // Refuse to exit while background tasks are live (half a) — inject a
          // continuation + keep looping so the SDK auto-continues to task settlement.
          if (bgTracker.size() > 0 && bgContinuations < maxBgContinuations()) {
            bgContinuations++;
            const live = bgTracker.live();
            console.error(`[harness] @agent:${agentId} refusing turn-end exit — ${live.length} live background task(s): ${live.join(", ")} (continuation ${bgContinuations}/${maxBgContinuations()})`);
            ch.push(bgContinuationMessage(live));
            continue; // do NOT finalize; keep the query loop alive
          }
          if (bgTracker.size() > 0) {
            console.error(`[harness] @agent:${agentId} continuation cap (${maxBgContinuations()}) reached with ${bgTracker.size()} task(s) still live — finalizing anyway`);
          }
          if (orchestrator) {
            const decision = decideChildTurnEnd(
              childContinuation,
              childSettlementReader(agentId),
              maxBgContinuations(),
            );
            childContinuation = decision.state;
            if (decision.action === "continue") {
              if (decision.reason === "children_live") {
                console.error(
                  `[harness] @agent:${agentId} refusing orchestrator turn-end — ${decision.live.length} live child lane(s): ${decision.live.join(", ")} (no-progress ${decision.attempt}/${decision.cap})`,
                );
                ch.push(childContinuationMessage(decision.live));
              } else {
                console.error(
                  `[harness] @agent:${agentId} requiring post-settlement reduction — ${decision.children.length} settled child lane(s): ${decision.children.join(", ")}`,
                );
                ch.push(childReductionMessage(decision.children));
              }
              continue;
            }
            if (decision.action === "block") {
              outcome = decision.reason === "child_reconciliation_unavailable"
                ? "child_reconciliation_unavailable"
                : decision.reason === "child_set_regressed"
                  ? "orchestrator_child_set_inconsistent"
                  : "orchestrator_children_incomplete";
              const detail = decision.missing?.length
                ? ` (missing previously observed: ${decision.missing.join(", ")})`
                : decision.live?.length
                  ? ` (${decision.live.join(", ")})`
                  : "";
              console.error(
                `[harness] @agent:${agentId} orchestrator completion blocked: ${decision.reason}${detail}`,
              );
              break;
            }
          }
          break; // task done + no pending peer ping -> finish
        }
      }

      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text?.trim()) {
            process.stdout.write(block.text);
          }
        }
      }
    }
    if (!resultMsg && outcome === "ran") {
      // Iterator completion without an explicit provider terminal is not a
      // successful execution, even when the transport itself closed cleanly.
      outcome = "provider_error";
    }
    if (stallAborted) {
      // 2N of silence: interrupt the hung query, mark outcome=stalled, and fire the death
      // path durably. Its terminal peer wake follows publication settlement.
      outcome = "stalled";
      await interruptQuery();
      const err = new Error(
        `stalled — no SDK output for ${Math.max(2, 2 * Math.round(window / 60_000))}min`,
      );
      terminalSignal = { subject: "AGENT DEATH", detail: deathReason(err) };
      terminalAuxiliaryWrites.push((timeoutMs) =>
        notifyDeath(agentId, err, { thread: threadId }, timeoutMs)
      );
    }
  } catch (err) {
    if (err instanceof ResourceEnvelopeExceededError) {
      outcome = "resource_envelope_exceeded";
      console.error(`[envelope] @agent:${agentId} ${err.message}`);
    } else if (err instanceof ProviderRetrySafeError) {
      // A spend-guard refusal carries its own terminal outcome; every other
      // retry-safe preflight block stays blocked_preflight.
      const carried = (err as { processOutcome?: unknown }).processOutcome;
      outcome = typeof carried === "string" ? carried : "blocked_preflight";
      console.error(`[${outcome}] @agent:${agentId} ${err.message}`);
    } else {
      outcome = "died";
      terminalSignal = { subject: "AGENT DEATH", detail: deathReason(err) };
      terminalAuxiliaryWrites.push((timeoutMs) =>
        notifyDeath(agentId, err, { thread: threadId }, timeoutMs)
      );
    }
  } finally {
    try {
      await liveInputRoute.freezeAndUnbind();
    } catch (error) {
      liveInputFreezeError = error;
    }
    try { ch.end(); } catch { /* already closed */ }
    // Streaming input can keep the provider subprocess alive even after it has
    // emitted a terminal result. Close the active query exactly once so Bun and
    // the provider CLI cannot survive a completed dispatch.
    await interruptQuery();
  }

  if (liveInputFreezeError) {
    try {
      await liveInputRoute.freezeAndUnbind();
      liveInputFreezeError = undefined;
    } catch {
      outcome = "died";
      const error = liveInputFreezeError instanceof Error
        ? liveInputFreezeError
        : new Error("managed live-input route could not be frozen");
      terminalSignal = { subject: "AGENT DEATH", detail: deathReason(error) };
      terminalAuxiliaryWrites.push((timeoutMs) =>
        notifyDeath(agentId, error, { thread: threadId }, timeoutMs)
      );
    }
  }

  // Final child gate is deliberately adjacent to terminal publication. It
  // catches a child appearing after the last provider result and treats graph
  // unavailability as unknown, never as an empty child set.
  const finalChildren = childSettlementReader(agentId);
  if (orchestrator && outcome === "ran") {
    const finalization = assessChildFinalization(childContinuation, finalChildren);
    if (!finalization.ok) {
      outcome = finalization.outcome;
      if (finalization.outcome === "orchestrator_child_set_inconsistent") {
        console.error(
          `[harness] @agent:${agentId} CHILD SET REGRESSED: missing previously observed coordinator relation(s) ${finalization.missing?.join(", ") ?? "(unknown)"}; terminal cannot be process=ran`,
        );
      }
    }
  }
  if (finalChildren.kind === "live") {
    terminalAuxiliaryWrites.push((timeoutMs) =>
      notifyEarlyExitChildren(agentId, finalChildren.live, {}, timeoutMs)
    );
    const childDetail =
      `${finalChildren.live.length} live child(ren): ${finalChildren.live.join(",")}`;
    terminalSignal = terminalSignal.subject
      ? {
          ...terminalSignal,
          detail: [terminalSignal.detail, childDetail].filter(Boolean).join("; "),
        }
      : { subject: "EARLY EXIT WITH LIVE CHILDREN", detail: childDetail };
  } else if (orchestrator && finalChildren.kind === "unavailable") {
    console.error(
      `[harness] @agent:${agentId} CHILD SETTLEMENT UNAVAILABLE: ${finalChildren.reason}; terminal cannot be process=ran`,
    );
  } else if (orchestrator && outcome === "orchestrator_reduction_incomplete"
             && finalChildren.kind === "settled") {
    console.error(
      `[harness] @agent:${agentId} CHILD RESULTS UNREDUCED: settled set changed or lacked a completed reduction turn (${finalChildren.children.join(", ")}); terminal cannot be process=ran`,
    );
  }

  // Close only the exact clock positively opened by this dispatch preflight.
  if (clockLease?.admission.kind === "opened") {
    clockFinalize(agentId, outcome);
    clockLease.finalized = true;
  }

  // Commit the lane's process/delivery terminal (SYNC, digest marker last)
  // before exit. Mirrors spawn.ts at the same reap-avoidance seam.
  refreshIdentityRoute();
  let delivery: DeliveryAssessment | undefined;
  if (outcome === "ran") {
    if (!deliveryReservationReady || !deliveryReservation || !runtime) {
      delivery = {
        deliveryOutcome: "unverified",
        deliveryReason: "delivery_reservation_unavailable_at_finalize",
      };
    } else {
      const reservedRunId = runId;
      let runState: DeliveryRunState | undefined;
      try {
        runState = runtime.load(runId);
      } catch {
        runState = undefined;
      }
      if (!runState?.reservationValid) {
        runId = newRunId(agentId);
        deliveryReservationReady = false;
        console.error(
          `[delivery] @${reservedRunId} reservation invalid at finalize; rotating telemetry to @${runId} and leaving delivery unverified`,
        );
        delivery = {
          deliveryOutcome: "unverified",
          deliveryReason: "delivery_reservation_unavailable_at_finalize",
        };
      } else {
        try {
          delivery = assessThreadDelivery(
            threadId,
            agentId,
            loadTerminalFacts(threadId),
            deliveryReservation.baselineDoneWhen.map(
              (value) => ({ predicate: "done_when", value }),
            ),
            runId,
            runState.evidence,
          );
        } catch {
          delivery = {
            deliveryOutcome: "unverified",
            deliveryReason: "delivery_thread_unavailable_at_finalize",
          };
        }
      }
    }
  }
  const terminal = classifyExecutionTerminal(outcome, delivery);
  const publicationBudget = new TerminalPublicationBudget();
  for (const [index, writeAuxiliary] of terminalAuxiliaryWrites.entries()) {
    writeAuxiliary(
      publicationBudget.publicationTimeout(
        terminalAuxiliaryWrites.length - index + 2,
      ),
    );
  }
  const terminalPublication = writeAgentTerminal(
    agentId,
    terminal,
    publicationBudget.publicationTimeout(2),
  );

  const tokenUsage = normalizeUsage(terminalMessages, routing.provider);
  const numTurns = typeof resultMsg?.num_turns === "number"
    ? resultMsg.num_turns
    // A retry-safe preflight block proves the provider accepted no turn. This
    // zero is North-observed; every other missing provider value stays absent.
    : terminal.processOutcome === "blocked_preflight"
      || terminal.processOutcome === "blocked_spend_guard" ? 0 : undefined;
  const runPublication = await recordRun({ thread: threadId, agent: agentId, tokenUsage,
              model: routing.resolvedModel ?? resolved.model, effort: routing.resolvedEffort ?? resolved.effort,
              role,
              provider: routing.provider, providerTarget: routing.target, providerReason: routing.selectionReason,
              requestedProvider: routing.requestedProvider,
              requestedTarget: targetPreference,
              requestedTier,
              requestedModel: process.env.AGENT_MODEL,
              requestedEffort: routingMetadata.reasoning ?? process.env.AGENT_EFFORT,
              allocationMode: routing.allocationMode,
              entitlementPressure: routing.entitlementPressure,
              allocationEvidence: routing.allocationEvidenceByTarget,
              fallbackCount: routing.fallbackCount,
              fallbackPath: routing.fallbackPath,
              fallbackTargetPath: routing.fallbackTargetPath,
              fallbackReasons: routing.fallbackReasons,
              envelopeScopes: envelopeAdmission?.scopes.map(({ id }) => id),
              envelopeRetries: envelopeAdmission?.retries,
              envelopeAdvisories: envelopeAdmission?.advisories,
              routingMetadata,
              promptComposition: admittedRoute?.evidence ?? injectedCompositionEvidence,
              effectiveAuthority: admittedRoute?.authority,
              compactions,
              durationMs: Number(process.hrtime.bigint() - runStartedAt) / 1_000_000,
              providerDurationMs: typeof resultMsg?.duration_ms === "number" ? resultMsg.duration_ms : undefined,
              posture: postureLabel, outcome,
              processOutcome: terminal.processOutcome,
              deliveryOutcome: terminal.deliveryOutcome,
              deliveryReason: terminal.deliveryReason,
              deliveryProof: terminal.deliveryProof,
              numTurns,
              judgmentGrade,
              struggleObservation: struggle.snapshot(),
              }, runId, publicationBudget.publicationTimeout(1));
  notifyTerminalSettlement(
    agentId,
    coordHandle,
    {
      outcome,
      terminal,
      terminalPublication,
      runPublication,
      ...terminalSignal,
    },
    publicationBudget.notificationTimeout(),
  );
  console.log(`\n[dispatch] @${threadId} process=${outcome} delivery=${terminal.deliveryOutcome}`);
  return { threadId, posture: postureLabel, result };
}

let bootstrapAuthorityGranted = false;

export async function dispatch(
  threadIdInput: string,
  dependencies: DispatchDependencies,
): Promise<DispatchResult> {
  const injected = takeDispatchTestRuntime<DispatchRuntime>(dependencies) ?? {};
  const admitted = allowlistedDispatchDependencies(dependencies);
  const callerTopology = process.env.AGENT_TOPOLOGY;
  if (!bootstrapAuthorityGranted) {
    assertCoordinationAuthority("dispatch", callerTopology);
  }
  const threadId = normalizeNorthEntityId(threadIdInput);
  // Routing admission is the first request-dependent boundary. Even a
  // completed thread must not make an incomplete/hostile managed envelope look
  // accepted, and a preclaimed fast path must not touch driver state first.
  const routingMetadata = admitRoutingRequest(
    admitted.routingMetadata ?? {}, "managed North dispatch",
  );
  if (!bootstrapAuthorityGranted) {
    assertManagedChildTopology(
      "dispatch", routingMetadata.topology, callerTopology,
    );
  }
  // The detector policy is an admission input: reject malformed overrides before
  // any graph claim, clock, resource envelope, or provider-selection side effect.
  const strugglePolicy = resolveStrugglePolicy(routingMetadata.topology!);
  assertExpectedStrugglePolicy(strugglePolicy);
  // Avoid charging an admission for an unknown or already-completed thread.
  const facts = (injected.loadThreadFacts ?? getThreadFacts)(threadId);
  if (!facts.length) throw new Error(`Thread @${threadId} not found or has no facts`);
  const judgmentGrade = judgmentGradeFromThreadFacts(facts);
  const children = (injected.loadChildren ?? getChildren)(threadId);
  const preflight = derivePosture(facts, children.length > 0);
  if (preflight.hasOutcome) {
    const preclaimed = injected.driverOptions?.preclaimed
      ?? process.env.NORTH_DISPATCH_DRIVER_PRECLAIMED === "1";
    if (preclaimed) {
      const agentId = selectDispatchAgentId(threadId, {
        agentId: admitted.agentId,
        driverOptions: injected.driverOptions,
      });
      const driver = (injected.claimDriver ?? claimDispatchDriver)(
        threadId, agentId, injected.driverOptions,
      );
      if (driver.release() === false) throw new DispatchDriverReleaseError(threadId);
    }
    return { threadId, posture: "atomic", result: "already done" };
  }
  const workingDirectory = resolveDispatchWorkingDirectory(facts);
  const agentId = selectDispatchAgentId(threadId, {
    agentId: admitted.agentId,
    driverOptions: injected.driverOptions,
  });
  const clockLease: ManagedClockLease = {
    admission: admitBillableClock({
      agentId,
      capabilities: gafferCapabilities(routingMetadata),
      cwd: workingDirectory,
      threadId,
    }),
    finalized: false,
  };
  let driver: ReturnType<typeof claimDispatchDriver> | undefined;
  let admission: EnvelopeAdmission | undefined;
  try {
    driver = (injected.claimDriver ?? claimDispatchDriver)(
      threadId, agentId, injected.driverOptions,
    );
    const context = envelopeContextFromEnv(workingDirectory);
    admission = await admitResourceEnvelope({
      agentId, tier: routingMetadata.tier ?? process.env.AGENT_TIER as SemanticTier | undefined,
      project: context.project, sessionId: context.sessionId,
    });
    for (const advisory of admission?.advisories ?? []) console.warn(`[envelope] advisory: ${advisory}`);
    return await runDispatch(
      threadId, judgmentGrade, strugglePolicy,
      admission, routingMetadata, workingDirectory, agentId, injected.queryFn,
      facts, children, injected.loadThreadFacts ?? getThreadFacts,
      injected.deliveryRuntime,
      injected.childSettlementReader,
      injected.feedSubscriber ?? subscribeFeed,
      clockLease,
    );
  } finally {
    try { await completeResourceEnvelope(admission); }
    finally {
      if (clockLease.admission.kind === "opened" && !clockLease.finalized)
        clockStop(agentId);
      if (driver && driver.release() === false) {
        console.error(`[dispatch] safe driver release unavailable for @${threadId}; liveness reaper remains armed`);
      }
    }
  }
}

export async function dispatchParallel(
  threadIds: string[],
  dependencies: DispatchDependencies,
): Promise<DispatchResult[]> {
  assertCoordinationAuthority("dispatchParallel");
  if (dependencies.agentId && threadIds.length > 1)
    throw new Error("dispatchParallel cannot reuse one explicit agentId across multiple children");
  return Promise.all(threadIds.map((id) => dispatch(id, dependencies)));
}

if (import.meta.main) {
  // The Clojure adapter checked the caller before replacing its environment
  // with the composed child identity. Direct library calls retain both checks.
  bootstrapAuthorityGranted = true;
  const threadId = process.argv[2];
  if (!threadId) {
    console.error("usage: bun run src/dispatch.ts <thread-id>");
    process.exit(1);
  }
  dispatch(threadId, {
    agentId: process.env.AGENT_ID,
    routingMetadata: routingRequestFromEnv("managed North dispatch bootstrap"),
  })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
