import { randomUUID } from "node:crypto";
import { getThreadFacts, getChildren, normalizeNorthEntityId } from "./north-client";
import { derivePosture, buildPrompt } from "./posture";
import { StreamWriter } from "./stream-writer";
import {
  harnessCompositionEvidence, harnessOptions, DEFAULT_SYSTEM_PROMPT,
  type Effort, type HarnessCompositionEvidence,
} from "./harness";
import { inputChannel, subscribeFeed } from "./coordination";
import { normalizeUsage } from "./usage";
import { newRunId, recordRun } from "./telemetry";
import { notifyDeath } from "./death";
import { withStallWatchdog, stallMs, notifyStall, notifyTurnCap } from "./watchdog";
import { makeBgTracker, bgContinuationMessage, maxBgContinuations } from "./bgtasks";
import {
  childContinuationMessage, decideChildTurnEnd, initialChildContinuationState,
  notifyEarlyExitChildren, reconcileChildren, type ChildReconciliation,
} from "./children";
import {
  bespokeContractFingerprint, writeAgentFacts, writeAgentTerminal, updateAgentRoute,
  userAnchoredPath,
} from "./identity";
import { BESPOKE_FINGERPRINT_DOMAIN, BESPOKE_FINGERPRINT_VERSION } from "./bespoke-contract";
import { clockStart, clockFinalize } from "./clock";
import {
  routedQuery, selectProvider, ProviderRetrySafeError, type ProviderPreference,
} from "./providers";
import type { AgentQuery } from "./providers/types";
import { refreshCodexEntitlementsIfStale } from "./codex-entitlement";
import { resolveTier, type SemanticTier } from "./providers/catalog";
import { routingMetadataFromEnv, validateRoutingMetadata, type RoutingMetadata } from "./routing-metadata";
import {
  applyGafferStaffing, gafferCapabilities, requireManagedGafferSelection,
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
import { assessThreadDelivery, type DeliveryAssessment } from "./delivery-verification";
import {
  loadDeliveryRunState, newDeliveryRunContext, reserveDeliveryRun,
  type DeliveryReservation, type DeliveryRunContext, type DeliveryRunState,
} from "./delivery-evidence";

const PLAN_TOOLS = ["Read", "Grep", "Glob", "Bash"];
const EXEC_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];
const SURVEY_TOOLS = ["Read", "Grep", "Glob"];

interface DispatchResult {
  threadId: string;
  posture: "unplanned" | "atomic" | "composite";
  result: string;
}

export interface DispatchDependencies {
  claimDriver?: typeof claimDispatchDriver;
  driverOptions?: DispatchDriverOptions;
  /** Explicit staffing request for programmatic callers; CLI/MCP adapters use env. */
  routingMetadata?: RoutingMetadata;
  /** Explicit child identity for a programmatic handoff; never inferred from a parent. */
  agentId?: string;
  /** Hermetic provider boundary for tests and alternate programmatic adapters. */
  queryFn?: (args: any) => AgentQuery;
  /** Read seams keep programmatic dispatch tests off the live coordination graph. */
  loadThreadFacts?: typeof getThreadFacts;
  loadChildren?: typeof getChildren;
  /** Hermetic seam for the capability-bound delivery reservation/evidence store. */
  deliveryRuntime?: {
    reserve: (context: DeliveryRunContext) => DeliveryReservation;
    load: (runId: string) => DeliveryRunState;
  };
  /** Hermetic graph seam for orchestrator child reconciliation. */
  childReconciler?: (agentId: string) => ChildReconciliation;
}

export function createDispatchAgentId(threadId: string, now = Date.now(), uuid = randomUUID()): string {
  const threadFragment = threadId.replace(/[^a-z0-9]/gi, "").slice(-12) || "thread";
  return `sdk-${threadFragment}-${now.toString(36)}-${uuid}`;
}

export function selectDispatchAgentId(
  threadId: string,
  dependencies: DispatchDependencies = {},
): string {
  if (dependencies.agentId) return dependencies.agentId;
  const preclaimed = dependencies.driverOptions?.preclaimed
    ?? process.env.NORTH_DISPATCH_DRIVER_PRECLAIMED === "1";
  if (preclaimed && process.env.AGENT_ID) return process.env.AGENT_ID;
  return createDispatchAgentId(threadId);
}

async function runDispatch(
  threadId: string,
  envelopeAdmission?: EnvelopeAdmission,
  hydratedMetadata?: ReturnType<typeof routingMetadataFromEnv>,
  hydratedWorkingDirectory?: string,
  hydratedAgentId?: string,
  queryFn?: (args: any) => AgentQuery,
  hydratedFacts?: ReturnType<typeof getThreadFacts>,
  hydratedChildren?: ReturnType<typeof getChildren>,
  loadTerminalFacts: typeof getThreadFacts = getThreadFacts,
  deliveryRuntime?: DispatchDependencies["deliveryRuntime"],
  childReconciler: (agentId: string) => ChildReconciliation = reconcileChildren,
): Promise<DispatchResult> {
  const runStartedAt = process.hrtime.bigint();
  const routingMetadata = hydratedMetadata ?? validateRoutingMetadata(applyGafferStaffing(routingMetadataFromEnv()));
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

  if (posture.hasOutcome) {
    return { threadId, posture: "atomic", result: "already done" };
  }

  const workingDirectory = hydratedWorkingDirectory ?? resolveDispatchWorkingDirectory(facts);

  const prompt = buildPrompt(threadId, posture, facts);
  const tools = posture.atomic
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
  writeAgentFacts(agentId, { ...identityBase, model: resolved.model,
    provider: routing.provider, providerTarget: routing.target, effort: resolved.effort });
  let identityRoute = `${routing.provider}|${routing.target}|${resolved.model ?? ""}|${resolved.effort ?? ""}`;
  const refreshIdentityRoute = (required = false) => {
    const route = { provider: routing.provider,
      providerTarget: routing.target,
      model: routing.resolvedModel ?? resolved.model,
      effort: routing.resolvedEffort ?? resolved.effort };
    const next = `${route.provider}|${route.providerTarget}|${route.model ?? ""}|${route.effort ?? ""}`;
    if (next === identityRoute) return;
    try {
      updateAgentRoute(agentId, { ...identityBase, ...route });
      identityRoute = next;
    } catch (error) {
      if (required) throw error;
    }
  };

  console.log(`[dispatch] @${threadId} — ${posture.title}`);
  console.log(`[dispatch] posture: ${postureLabel}, provider: ${routing.provider}, target: ${routing.target} (${routing.reason}), tools: ${tools.join(",")}`);

  // Auto-clock (per-agent): open a session on this thread as THIS worker, so its
  // billable time attributes to the thread it actually worked — not one global
  // clock. Closed on exit below (clean stop / orphan-close on crash).
  clockStart(agentId, threadId);

  let result = "";
  let resultMsg: any = null;
  const terminalMessages: any[] = [];
  let outcome = "ran";

  // Real-time coordination: run the prompt in streaming-input mode so peers can inject
  // pings into THIS run (no re-arm — subscribeFeed re-spawns host-side, invisibly).
  const ch = inputChannel(prompt);
  const stopFeed = subscribeFeed(agentId, (m) => ch.push(m));

  // Stream watchdog (thread 019f4d54): wrap the SDK iterator so a stall (no message for
  // N min while the query is open) is caught — the iterator neither yields nor throws on
  // a hang, so the catch below would never fire. N min silence -> stalled fact + ping;
  // 2N -> abort + outcome=stalled + notifyDeath.
  const coordHandle = process.env.AGENT_COORDINATOR;
  const window = stallMs();
  let stallAborted = false;
  // Background-task refusal (thread 019f4ed2, half a): don't finalize on the first
  // `result` while a harness-tracked background task is live — see bgtasks.ts.
  const bgTracker = makeBgTracker();
  let bgContinuations = 0;
  const orchestrator = routingMetadata.topology === "orchestrator";
  let childContinuation = initialChildContinuationState();
  let q: AgentQuery | undefined;
  let compositionEvidence: HarnessCompositionEvidence | undefined;
  let queryInterrupted = false;
  const interruptQuery = async () => {
    if (queryInterrupted || !q) return;
    queryInterrupted = true;
    try { await q.interrupt?.(); } catch { /* cleanup must not replace the terminal outcome */ }
  };

  // Error boundary (thread 019f2800): the SDK runs the turn in a subprocess; if it dies
  // (OOM SIGKILL / parent SIGTERM / idle Transport-closed) the generator THROWS exitError
  // here. catch -> outcome "died" + notifyDeath (agent_death fact on this thread + @swarm,
  // peer ping to the coordinator); finally -> ALWAYS stop the feed, close the channel, and
  // record the run so the coordinator learns of the death instead of noticing silence.
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
      extraTools: tools,
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
    compositionEvidence = harnessCompositionEvidence(agentOptions);
    const queryArgs = {
      prompt: ch.stream(),
      options: agentOptions,
    };
    q = queryFn
      ? queryFn(queryArgs)
      : routedQuery(routing, queryArgs, requestedTier, undefined,
        () => reserveResourceEnvelopeRetry(envelopeAdmission),
        (_decision, evidence) => {
          refreshIdentityRoute(true);
          if (evidence) compositionEvidence = evidence;
        });
    const watched = withStallWatchdog((q as AsyncIterable<any>)[Symbol.asyncIterator](), {
      stallMs: window,
      onStall: (mins) => notifyStall(agentId, mins, { coordinator: coordHandle }),
      onAbort: () => { stallAborted = true; },
    });
    for await (const message of watched) {
      const msg = message as any;
      refreshIdentityRoute();
      stream.writeSDKMessage(msg);
      if (bgTracker.observe(msg) === "settled") bgContinuations = 0; // forward progress refreshes the cap

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
          notifyTurnCap(agentId, `${cap} — ${partial}`, { coordinator: coordHandle });
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
              childReconciler(agentId),
              maxBgContinuations(),
            );
            childContinuation = decision.state;
            if (decision.action === "continue") {
              console.error(
                `[harness] @agent:${agentId} refusing orchestrator turn-end — ${decision.live.length} live child lane(s): ${decision.live.join(", ")} (no-progress ${decision.attempt}/${decision.cap})`,
              );
              ch.push(childContinuationMessage(decision.live));
              continue;
            }
            if (decision.action === "block") {
              outcome = decision.reason === "child_reconciliation_unavailable"
                ? "child_reconciliation_unavailable"
                : "orchestrator_children_incomplete";
              console.error(
                `[harness] @agent:${agentId} orchestrator completion blocked: ${decision.reason}${decision.live?.length ? ` (${decision.live.join(", ")})` : ""}`,
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
      // path so a stall is terminal + visible instead of a silent hang.
      outcome = "stalled";
      await interruptQuery();
      notifyDeath(agentId, new Error(`stalled — no SDK output for ${Math.max(2, 2 * Math.round(window / 60_000))}min`),
        { thread: threadId, coordinator: coordHandle });
    }
  } catch (err) {
    if (err instanceof ResourceEnvelopeExceededError) {
      outcome = "resource_envelope_exceeded";
      console.error(`[envelope] @agent:${agentId} ${err.message}`);
    } else if (err instanceof ProviderRetrySafeError) {
      outcome = "blocked_preflight";
      console.error(`[preflight] @agent:${agentId} ${err.message}`);
    } else {
      outcome = "died";
      notifyDeath(agentId, err, { thread: threadId, coordinator: process.env.AGENT_COORDINATOR });
    }
  } finally {
    stopFeed();
    try { ch.end(); } catch { /* already closed */ }
    // Streaming input can keep the provider subprocess alive even after it has
    // emitted a terminal result. Close the active query exactly once so Bun and
    // the provider CLI cannot survive a completed dispatch.
    await interruptQuery();
  }

  // Final child gate is deliberately adjacent to terminal publication. It
  // catches a child appearing after the last provider result and treats graph
  // unavailability as unknown, never as an empty child set.
  const finalChildren = childReconciler(agentId);
  if (orchestrator && outcome === "ran") {
    if (finalChildren.kind === "live") outcome = "orchestrator_children_incomplete";
    if (finalChildren.kind === "unavailable") outcome = "child_reconciliation_unavailable";
  }
  if (finalChildren.kind === "live") {
    notifyEarlyExitChildren(agentId, finalChildren.live, { coordinator: coordHandle });
  } else if (orchestrator && finalChildren.kind === "unavailable") {
    console.error(
      `[harness] @agent:${agentId} CHILD RECONCILIATION UNAVAILABLE: ${finalChildren.reason}; terminal cannot be process=ran`,
    );
  }

  // Close the auto-clock: a crash (died/stalled) orphan-closes (end_time + flag);
  // any other terminal (clean or provider-capped) stops the session normally.
  clockFinalize(agentId, outcome);

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
  writeAgentTerminal(agentId, terminal);

  const tokenUsage = normalizeUsage(terminalMessages, routing.provider);
  const numTurns = typeof resultMsg?.num_turns === "number"
    ? resultMsg.num_turns
    // A retry-safe preflight block proves the provider accepted no turn. This
    // zero is North-observed; every other missing provider value stays absent.
    : terminal.processOutcome === "blocked_preflight" ? 0 : undefined;
  recordRun({ thread: threadId, agent: agentId, tokenUsage,
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
              promptComposition: compositionEvidence,
              durationMs: Number(process.hrtime.bigint() - runStartedAt) / 1_000_000,
              providerDurationMs: typeof resultMsg?.duration_ms === "number" ? resultMsg.duration_ms : undefined,
              posture: postureLabel, outcome,
              processOutcome: terminal.processOutcome,
              deliveryOutcome: terminal.deliveryOutcome,
              deliveryReason: terminal.deliveryReason,
              deliveryProof: terminal.deliveryProof,
              numTurns }, runId);
  console.log(`\n[dispatch] @${threadId} process=${outcome} delivery=${terminal.deliveryOutcome}`);
  return { threadId, posture: postureLabel, result };
}

let bootstrapAuthorityGranted = false;

export async function dispatch(
  threadIdInput: string,
  dependencies: DispatchDependencies = {},
): Promise<DispatchResult> {
  const callerTopology = process.env.AGENT_TOPOLOGY;
  if (!bootstrapAuthorityGranted) {
    assertCoordinationAuthority("dispatch", callerTopology);
  }
  const threadId = normalizeNorthEntityId(threadIdInput);
  // Avoid charging an admission for an unknown or already-completed thread.
  const facts = (dependencies.loadThreadFacts ?? getThreadFacts)(threadId);
  if (!facts.length) throw new Error(`Thread @${threadId} not found or has no facts`);
  const children = (dependencies.loadChildren ?? getChildren)(threadId);
  const preflight = derivePosture(facts, children.length > 0);
  if (preflight.hasOutcome) {
    const preclaimed = dependencies.driverOptions?.preclaimed
      ?? process.env.NORTH_DISPATCH_DRIVER_PRECLAIMED === "1";
    if (preclaimed) {
      const agentId = selectDispatchAgentId(threadId, dependencies);
      const driver = (dependencies.claimDriver ?? claimDispatchDriver)(
        threadId, agentId, dependencies.driverOptions,
      );
      if (driver.release() === false) throw new DispatchDriverReleaseError(threadId);
    }
    return { threadId, posture: "atomic", result: "already done" };
  }
  const workingDirectory = resolveDispatchWorkingDirectory(facts);
  const agentId = selectDispatchAgentId(threadId, dependencies);
  const routingMetadata = requireManagedGafferSelection(
    validateRoutingMetadata(applyGafferStaffing(
      dependencies.routingMetadata ?? routingMetadataFromEnv(),
    )),
    "managed North dispatch",
  );
  if (!bootstrapAuthorityGranted) {
    assertManagedChildTopology(
      "dispatch", routingMetadata.topology, callerTopology,
    );
  }
  const driver = (dependencies.claimDriver ?? claimDispatchDriver)(threadId, agentId, dependencies.driverOptions);
  let admission: EnvelopeAdmission | undefined;
  try {
    const context = envelopeContextFromEnv(workingDirectory);
    admission = await admitResourceEnvelope({
      agentId, tier: routingMetadata.tier ?? process.env.AGENT_TIER as SemanticTier | undefined,
      project: context.project, sessionId: context.sessionId,
    });
    for (const advisory of admission?.advisories ?? []) console.warn(`[envelope] advisory: ${advisory}`);
    return await runDispatch(
      threadId, admission, routingMetadata, workingDirectory, agentId, dependencies.queryFn,
      facts, children, dependencies.loadThreadFacts ?? getThreadFacts,
      dependencies.deliveryRuntime,
      dependencies.childReconciler,
    );
  } finally {
    try { await completeResourceEnvelope(admission); }
    finally {
      if (driver.release() === false) {
        console.error(`[dispatch] safe driver release unavailable for @${threadId}; liveness reaper remains armed`);
      }
    }
  }
}

export async function dispatchParallel(
  threadIds: string[],
  dependencies: DispatchDependencies = {},
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
  if (!process.env.AGENT_ROLE) {
    console.error(
      "managed North dispatch requires AGENT_ROLE selecting a canonical Gaffer preset or complete bespoke composition",
    );
    process.exit(1);
  }

  dispatch(threadId, {
    agentId: process.env.AGENT_ID,
    routingMetadata: routingMetadataFromEnv(),
  })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
