import { resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
const REPO_ROOT = pathResolve(import.meta.dir, "..", "..");
import { StreamWriter } from "./stream-writer";
import {
  harnessCompositionEvidence, harnessOptions,
  type Effort, type HarnessCompositionEvidence,
} from "./harness";
import { normalizeUsage } from "./usage";
import { newRunId, recordRun } from "./telemetry";
import { notifyDeath } from "./death";
import { inputChannel } from "./coordination";
import {
  bespokeContractFingerprint, writeAgentFacts, writeAgentTerminal, updateAgentRoute, goalFromPrompt,
  userAnchoredPath,
} from "./identity";
import { BESPOKE_FINGERPRINT_DOMAIN, BESPOKE_FINGERPRINT_VERSION } from "./bespoke-contract";
import { makeStruggleState, updateStruggle, checkStruggle, resetStruggle } from "./struggle";
import {
  activeLadder, tierIndexOf, decideEscalation, escalateInFlight,
  type AppliedEscalationRoute,
} from "./ladder";
import { withStallWatchdog, stallMs, notifyStall, notifyTurnCap } from "./watchdog";
import { makeBgTracker, bgContinuationMessage, maxBgContinuations } from "./bgtasks";
import {
  childContinuationMessage, decideChildTurnEnd, initialChildContinuationState,
  notifyEarlyExitChildren, reconcileChildren, type ChildReconciliation,
} from "./children";
import { clockStart, clockFinalize } from "./clock";
import {
  routedQuery, selectProvider, ProviderEscalationUnsupportedError, ProviderRetrySafeError,
  type ProviderPreference,
} from "./providers";
import { refreshCodexEntitlementsIfStale } from "./codex-entitlement";
import type { AgentQuery } from "./providers/types";
import { resolveTier, type SemanticTier } from "./providers/catalog";
import { canonicalRole, routingMetadataFromEnv, validateRoutingMetadata, type RoutingMetadata } from "./routing-metadata";
import {
  applyGafferStaffing, gafferCapabilities, requireManagedGafferSelection,
} from "./gaffer-staffing";
import { refreshAccountUsages } from "./account-usage";
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
import { getThreadFacts, normalizeNorthEntityId } from "./north-client";
import {
  loadDeliveryRunState, newDeliveryRunContext, reserveDeliveryRun,
  type DeliveryReservation, type DeliveryRunContext, type DeliveryRunState,
} from "./delivery-evidence";

export interface SpawnOptions {
  prompt: string;
  agentId?: string;
  model?: string;
  effort?: Effort;
  tools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
  escalate?: boolean; // escalate-not-kill: climb the ladder on struggle instead of stopping
  role: string;
  posture?: string;
  thread?: string; // exact work/evidence thread; also auto-clock like dispatch. Raw ad-hoc spawns omit it.
  caveman?: "off" | "lite" | "full"; // per-spawn terse-output dial; overrides ambient AGENT_CAVEMAN
  coordinator?: string; // spawning coordinator handle -> gets a direct peer ping on death
  provider?: ProviderPreference;
  target?: string;
  tier?: SemanticTier;
  routingMetadata?: RoutingMetadata;
  project?: string;
  sessionId?: string;
  queryFn?: (args: any) => AgentQuery; // injection seam for tests; bypasses provider selection
  /** Hermetic seam for the capability-bound delivery reservation/evidence store. */
  deliveryRuntime?: {
    reserve: (context: DeliveryRunContext) => DeliveryReservation;
    load: (runId: string) => DeliveryRunState;
  };
  /** Hermetic terminal thread read for delivery assessment. */
  loadThreadFacts?: typeof getThreadFacts;
  /** Hermetic graph seam for orchestrator child reconciliation. */
  childReconciler?: (agentId: string) => ChildReconciliation;
}

export function createSpawnAgentId(now = Date.now(), uuid = randomUUID()): string {
  return `lane-${now.toString(36)}-${uuid}`;
}

function composeSpawnOptions(opts: SpawnOptions): SpawnOptions & { routingMetadata: RoutingMetadata } {
  // Library calls are request-owned. Only the CLI adapter below explicitly
  // imports its already-scrubbed child environment into RoutingMetadata.
  const requestedMetadata = opts.routingMetadata ? validateRoutingMetadata(opts.routingMetadata) : {};
  // The public spawn dials are part of the composition request, not a second
  // overlay after staffing. Merge them first so a role-only request can hydrate
  // from Gaffer while every explicitly supplied axis wins independently.
  const explicitMetadata = validateRoutingMetadata({
    ...requestedMetadata,
    ...(opts.role != null ? { role: opts.role } : {}),
    ...(opts.tier != null ? { tier: opts.tier } : {}),
    ...(opts.effort != null ? { reasoning: opts.effort } : {}),
    ...(opts.posture != null ? { posture: opts.posture as RoutingMetadata["posture"] } : {}),
  });
  const routingMetadata = requireManagedGafferSelection(
    validateRoutingMetadata(applyGafferStaffing(explicitMetadata)),
    "managed North spawn",
  );
  return {
    ...opts,
    routingMetadata,
    role: canonicalRole(routingMetadata.role)!,
    tier: routingMetadata.tier,
    effort: routingMetadata.reasoning as Effort | undefined,
    posture: routingMetadata.posture,
  };
}

async function runSpawn(opts: SpawnOptions & { routingMetadata: RoutingMetadata }, envelopeAdmission?: EnvelopeAdmission): Promise<string> {
  const runStartedAt = process.hrtime.bigint();
  // Composition is deliberately complete before admission and stays immutable
  // through routing, identity, provider execution, and terminal telemetry.
  const routingMetadata = opts.routingMetadata;
  const capabilities = gafferCapabilities(routingMetadata);
  const requested = { provider: opts.provider, target: opts.target,
    tier: opts.tier, model: opts.model, effort: opts.effort };
  const agentId = opts.agentId ?? createSpawnAgentId();
  let runId = newRunId(agentId);
  const runContext = opts.thread
    ? newDeliveryRunContext(runId, opts.thread, agentId)
    : undefined;
  const runtime = opts.deliveryRuntime ?? (opts.queryFn ? undefined : {
    reserve: reserveDeliveryRun,
    load: loadDeliveryRunState,
  });
  let deliveryReservation: DeliveryReservation | undefined;
  let deliveryReservationReady = false;
  const stream = new StreamWriter(agentId);
  const requestedTier = opts.tier;
  const requestedReasoning = opts.effort;
  const providerPreference = opts.provider ?? "auto";
  const targetPreference = opts.target;
  const routingRequest = { provider: providerPreference, target: targetPreference };
  if (!opts.queryFn) admitPinnedProvider(opts.provider, capabilities);
  // Injected query functions own their entire provider boundary; keeping the
  // refresh out of that path makes tests and alternative adapters hermetic.
  if (!opts.queryFn) {
    try { await refreshAccountUsages({ requested: routingRequest }); } catch { /* telemetry is advisory */ }
    try { await refreshCodexEntitlementsIfStale({ requested: routingRequest }); } catch { /* telemetry is advisory */ }
  }
  const routing = selectProvider(routingRequest, undefined,
    {
      tier: requestedTier, reasoning: requestedReasoning, model: opts.model,
      stableKey: agentId, capabilities,
    });
  const resolved = resolveTier(routing.provider, requestedTier, opts.model, opts.effort);
  opts.model = resolved.model;
  opts.effort = resolved.effort;
  // The hydrated Gaffer selection is canonical. Never let an inherited parent
  // env relabel this child as an alias or a different role.
  const identityRole = routingMetadata.role!;
  const composition = routingMetadata.composition!;
  const identityBase = {
    kind: "lane" as const,
    role: identityRole,
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
    repo: userAnchoredPath(process.cwd()),
    goal: goalFromPrompt(opts.prompt),
    coordinator: opts.coordinator,
  };
  writeAgentFacts(agentId, {
    ...identityBase,
    model: opts.model,
    provider: routing.provider,
    providerTarget: routing.target,
    effort: opts.effort,
  });
  const escalate = opts.escalate ?? process.env.AGENT_ESCALATE === "1";
  // escalate-not-kill (thread 019f1194-ca57): a struggling agent climbs the LADDER
  // in-flight (setModel on the live streaming-input query) instead of being killed at
  // a turn cap. Opt-in via opts.escalate / AGENT_ESCALATE; off => behaves as before.
  // Snapshot the active ladder once per run (includes the Fable rung iff the window is
  // open); tier indices below resolve against THIS array, matching decideEscalation.
  const ladder = activeLadder(routing.provider);
  let tier = escalate ? tierIndexOf(routing.provider, opts.model, opts.effort, ladder) : -1; // -1 = fixed model (legacy)
  const rung = () => (tier >= 0 ? ladder[tier] : { model: opts.model, effort: opts.effort });
  let acceptedModel = opts.model;
  let acceptedEffort = opts.effort;
  const activeRoute = () => ({
    provider: routing.provider,
    providerTarget: routing.target,
    model: routing.resolvedModel ?? acceptedModel,
    effort: routing.resolvedEffort ?? acceptedEffort,
  });
  let identityRoute = `${routing.provider}|${routing.target}|${opts.model ?? ""}|${opts.effort ?? ""}`;
  const refreshIdentityRoute = (required = false) => {
    const route = activeRoute();
    const next = `${route.provider}|${route.providerTarget}|${route.model ?? ""}|${route.effort ?? ""}`;
    if (next === identityRoute) return;
    try {
      updateAgentRoute(agentId, { ...identityBase, ...route });
      identityRoute = next;
    } catch (error) {
      if (required) throw error;
    }
  };
  const st = makeStruggleState();
  const ch = inputChannel(opts.prompt); // streaming-input mode -> unlocks q.setModel()

  console.log(`[spawn] @agent:${agentId} starting provider=${routing.provider} target=${routing.target}${resolved.tier ? ` tier=${resolved.tier}` : ""} (${routing.reason})${escalate ? ` (escalate from ${acceptedModel}/${acceptedEffort})` : ""}`);

  // Auto-clock only when this spawn carries a billable thread — ad-hoc spawns
  // aren't billable by default. Same per-agent treatment as dispatch.
  if (opts.thread) clockStart(agentId, opts.thread);

  let result = "", resultMsg: any = null, outcome = "ran";
  const terminalMessages: any[] = [];
  const escalations: Array<{ from: string; to: string; reason: string }> = [];
  const end = (oc: string) => { outcome = oc; try { ch.end(); } catch { /* already closed */ } };

  let compositionEvidence: HarnessCompositionEvidence | undefined;
  const queryFn = opts.queryFn ?? ((args: any) => routedQuery(
    routing, args, requestedTier, undefined, () => reserveResourceEnvelopeRetry(envelopeAdmission),
    (_decision, evidence) => {
      refreshIdentityRoute(true);
      if (evidence) compositionEvidence = evidence;
    },
  ));
  const noteAppliedEscalation = (route: AppliedEscalationRoute) => {
    if (route.model !== undefined) acceptedModel = route.model;
    if (route.effort !== undefined) acceptedEffort = route.effort;
  };
  let q: AgentQuery | undefined;
  let queryInterrupted = false;
  const interruptQuery = async () => {
    if (queryInterrupted || !q) return;
    queryInterrupted = true;
    try { await q.interrupt?.(); } catch { /* preserve the terminal provider error */ }
  };

  // Error boundary (thread 019f2800): the SDK runs the turn in a subprocess; if it dies
  // (OOM SIGKILL / parent SIGTERM / idle Transport-closed) readMessages() THROWS exitError
  // here. Without this try/catch the throw escaped -> recordRun skipped, no death signal,
  // channel leaked. Now: catch -> outcome "died" + notifyDeath (fact + peer ping); finally
  // -> ALWAYS end the channel + record the run; return the PARTIAL result (supervision, not
  // fail-fast) so one worker's death never rejects a spawnParallel Promise.all batch.
  // Stream watchdog (thread 019f4d54): a stall (no SDK message for N min while the
  // query is open) is otherwise INVISIBLE — the iterator neither yields nor throws, so
  // the catch below never fires. Wrap the iterator: N min silence -> stalled fact +
  // coordinator ping (surface); 2N -> abort + outcome=stalled + notifyDeath (terminal).
  const coordHandle = opts.coordinator;
  const window = stallMs();
  let stallAborted = false;
  // Background-task refusal (thread 019f4ed2): a lane that ends its turn while a
  // harness-tracked background Bash task is live must NOT finalize — the SDK
  // auto-continues the model on task settlement, but only if we keep the loop alive
  // instead of breaking on the first `result`. Track the live set; bgContinuations
  // counts CONSECUTIVE no-progress refusals (reset on settlement) for the stuck-lane cap.
  const bgTracker = makeBgTracker();
  let bgContinuations = 0;
  const orchestrator = routingMetadata.topology === "orchestrator";
  const reconcile = opts.childReconciler ?? reconcileChildren;
  let childContinuation = initialChildContinuationState();
  try {
  // Reserve only at the last pre-provider seam. Earlier routing/admission
  // failures must not strand undiscoverable reservation-only subjects.
  if (runContext) {
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
  }
  const agentOptions = harnessOptions({
    self: agentId,
    extraTools: opts.tools ?? ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    model: rung().model, effort: rung().effort,
    provider: routing.provider,
    routingMetadata,
    omitModelDeltaReason: escalate ? "cross_model_escalation_enabled" : undefined,
    systemPrompt: opts.systemPrompt, maxTurns: opts.maxTurns,
    role: opts.role, posture: opts.posture,
    cwd: process.cwd(),
    deliveryRun: deliveryReservationReady ? runContext : undefined,
    // per-spawn dial wins over ambient env; env-or-full is the harness fallback
    caveman: opts.caveman ?? process.env.AGENT_CAVEMAN ?? "full",
  });
  compositionEvidence = harnessCompositionEvidence(agentOptions);
  const activeQuery = queryFn({
    prompt: ch.stream(),
    options: agentOptions,
  });
  q = activeQuery;
  const watched = withStallWatchdog((activeQuery as AsyncIterable<any>)[Symbol.asyncIterator](), {
    stallMs: window,
    onStall: (mins) => notifyStall(agentId, mins, { coordinator: coordHandle }),
    onAbort: () => { stallAborted = true; },
  });
  for await (const message of watched) {
    const msg = message as any;
    // routedQuery mutates the decision before the first fallback-provider event.
    // Refresh from that structured decision before the event is exposed.
    refreshIdentityRoute();
    stream.writeSDKMessage(msg);
    if (bgTracker.observe(msg) === "settled") bgContinuations = 0; // forward progress refreshes the cap

    if (escalate) {
      updateStruggle(msg, st);
      const trigger = checkStruggle(st);
      if (trigger) {
        const d = decideEscalation(tier, ladder);
        if (d.kind === "escalate") {
          const from = `${rung().model}/${rung().effort}`;
          try {
            await escalateInFlight(routing.provider, activeQuery, ch, ladder[d.toTier], trigger, noteAppliedEscalation);
          } catch (err) {
            // setModel and effort are two provider controls, not an atomic API.
            // Project any successful first control before preserving the second
            // control's real error, then terminate the still-live child.
            refreshIdentityRoute();
            await interruptQuery();
            if (err instanceof ProviderEscalationUnsupportedError) {
              end("provider_escalation_unsupported");
              break;
            }
            throw err;
          }
          tier = d.toTier;
          refreshIdentityRoute();
          escalations.push({ from, to: `${rung().model}/${rung().effort}`, reason: trigger });
          resetStruggle(st);
          continue; // same loop, smarter tier
        }
        end(d.kind);
        await interruptQuery();
        break;
      }
    }

    if (msg.type === "result") {
      terminalMessages.push(msg);
      if (typeof msg.result === "string") result = msg.result;
      resultMsg = msg;
      const cap = typeof msg.subtype === "string" && msg.subtype.startsWith("error_max")
        ? msg.subtype
        : null;
      if (cap) {
        end(cap === "error_max_turns" ? "max_turns" : "capped");
        const partial = result.trim() ? `partial: ${result.trim().slice(0, 200)}` : "no partial result";
        notifyTurnCap(agentId, `${cap} — ${partial}`, { coordinator: coordHandle });
        break;
      }
      const providerError = msg.subtype !== "success"
        || msg.is_error === true
        || (Array.isArray(msg.errors) && msg.errors.length > 0);
      if (providerError) {
        end("provider_error");
        break;
      }
      if (escalate && !result.trim()) { // terminal empty result -> escalate rather than give up
        const d = decideEscalation(tier, ladder);
        if (d.kind === "escalate") {
          const from = `${rung().model}/${rung().effort}`;
          try {
            await escalateInFlight(routing.provider, activeQuery, ch, ladder[d.toTier], "empty_result", noteAppliedEscalation);
          } catch (err) {
            refreshIdentityRoute();
            await interruptQuery();
            if (err instanceof ProviderEscalationUnsupportedError) {
              end("provider_escalation_unsupported");
              break;
            }
            throw err;
          }
          tier = d.toTier;
          refreshIdentityRoute();
          escalations.push({ from, to: `${rung().model}/${rung().effort}`, reason: "empty_result" });
          resetStruggle(st);
          continue;
        }
      }
      if (ch.pending() === 0) {
        // Refuse to exit while harness-tracked background tasks are live (thread 019f4ed2,
        // half a). Inject a continuation message + keep looping: the SDK re-invokes the
        // model, the task settles (task_notification / task_updated), bgContinuations
        // resets, and a later result with an empty live set finalizes clean. The cap
        // (default 5 consecutive no-progress refusals) prevents infinite-looping a stuck
        // lane — it then falls through to finalize, and the after-loop early-exit check
        // makes the abandoned work loud.
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
            reconcile(agentId),
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
            const blockedOutcome = decision.reason === "child_reconciliation_unavailable"
              ? "child_reconciliation_unavailable"
              : "orchestrator_children_incomplete";
            console.error(
              `[harness] @agent:${agentId} orchestrator completion blocked: ${decision.reason}${decision.live?.length ? ` (${decision.live.join(", ")})` : ""}`,
            );
            end(blockedOutcome);
            break;
          }
        }
        end("ran");
        break; // MUST end the channel or the query hangs
      }
    }
  }
  if (!resultMsg && outcome === "ran") {
    // A clean iterator close is transport completion, not provider success.
    // Only an explicit terminal result may establish process=ran.
    outcome = "provider_error";
  }
  if (stallAborted) {
    // 2N of silence: make the stall TERMINAL + VISIBLE. Interrupt the hung query, record
    // outcome=stalled, and fire the death path (agent_death fact + coordinator ping) so a
    // stall is never a silent hang again.
    outcome = "stalled";
    await interruptQuery();
    notifyDeath(agentId, new Error(`stalled — no SDK output for ${Math.max(2, 2 * Math.round(window / 60_000))}min`),
      { thread: undefined, coordinator: coordHandle });
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
      notifyDeath(agentId, err, { thread: undefined, coordinator: opts.coordinator });
    }
  } finally {
    end(outcome); // idempotent: close the channel so the query + any leak unwinds
    // A terminal SDK result does not guarantee the provider subprocess has
    // exited while streaming input remains open. Interrupt exactly once after
    // closing input so a completed lane cannot retain its Bun/CLI process tree.
    await interruptQuery();
  }

  // Belt-and-suspenders terminal gate. A child may appear after the last
  // provider result, and an unavailable graph is not evidence of zero children.
  // Workers keep historical best-effort notification semantics; only a
  // successful orchestrator is prevented from publishing process=ran.
  const finalChildren = reconcile(agentId);
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

  // Close the auto-clock (only if this spawn opened one): crash -> orphan-close, else stop.
  if (opts.thread) clockFinalize(agentId, outcome);

  // Commit the lane's process/delivery terminal (SYNC, digest marker last)
  // before exit so the reactor cannot mistake a completed lane for silence.
  refreshIdentityRoute();
  let delivery: DeliveryAssessment | undefined;
  if (outcome === "ran" && opts.thread) {
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
            opts.thread,
            agentId,
            (opts.loadThreadFacts ?? getThreadFacts)(opts.thread),
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
  const finalRoute = activeRoute();
  const numTurns = typeof resultMsg?.num_turns === "number"
    ? resultMsg.num_turns
    // A retry-safe preflight block proves the provider accepted no turn. This
    // zero is North-observed; every other missing provider value stays absent.
    : terminal.processOutcome === "blocked_preflight" ? 0 : undefined;
  recordRun({
    thread: opts.thread ?? "(ad-hoc)", agent: agentId, posture: "spawn",
    // Effective FINAL dial (rung() reflects any in-flight escalation); env-fallback
    // mirrors the identity write so a bare AGENT_MODEL spawn is still attributed.
    model: finalRoute.model,
    effort: finalRoute.effort,
    role: opts.role,
    provider: routing.provider, providerTarget: routing.target, providerReason: routing.selectionReason,
    requestedProvider: routing.requestedProvider, requestedTarget: requested.target, requestedTier: requested.tier,
    requestedModel: requested.model, requestedEffort: requested.effort,
    allocationMode: routing.allocationMode, entitlementPressure: routing.entitlementPressure,
    allocationEvidence: routing.allocationEvidenceByTarget,
    fallbackCount: routing.fallbackCount, fallbackPath: routing.fallbackPath,
    fallbackTargetPath: routing.fallbackTargetPath,
    fallbackReasons: routing.fallbackReasons,
    envelopeScopes: envelopeAdmission?.scopes.map(({ id }) => id),
    envelopeRetries: envelopeAdmission?.retries,
    envelopeAdvisories: envelopeAdmission?.advisories,
    routingMetadata,
    promptComposition: compositionEvidence,
    tokenUsage,
    durationMs: Number(process.hrtime.bigint() - runStartedAt) / 1_000_000,
    providerDurationMs: typeof resultMsg?.duration_ms === "number" ? resultMsg.duration_ms : undefined,
    outcome, processOutcome: terminal.processOutcome,
    deliveryOutcome: terminal.deliveryOutcome, deliveryReason: terminal.deliveryReason,
    deliveryProof: terminal.deliveryProof,
    numTurns,
    errorCount: st.totalErrors, escalationTier: tier,
    escalations: escalations.length ? escalations : undefined,
  }, runId);
  // completion ping mirrors the death ping: the coordinator's inbox hook surfaces it.
  // Suppress it for outcomes that already fired a dedicated ping (died -> AGENT DEATH,
  // stalled -> AGENT DEATH via notifyDeath, max_turns/capped -> TURN CAP) — one terminal
  // event, one ping, no contradictory "COMPLETE outcome=stalled" noise.
  const coord = opts.coordinator;
  const alreadySignaled = new Set(["died", "stalled", "max_turns", "capped"]);
  if (coord && !alreadySignaled.has(outcome)) {
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("bb", [`${REPO_ROOT}/cli/msg-cli.clj`, process.env.NORTH_PORT ?? "7977",
        "send", agentId, coord, "AGENT COMPLETE",
        `process=${terminal.processOutcome} delivery=${terminal.deliveryOutcome}`],
      { stdio: "ignore", timeout: 10000 });
    } catch { /* non-fatal */ }
  }
  console.log(`[spawn] @agent:${agentId} complete (process=${outcome}, delivery=${terminal.deliveryOutcome}` +
    `${escalations.length ? `, ${escalations.length} escalation(s) -> ${rung().model}/${rung().effort}` : ""})`);
  return result;
}

// TRUE only in the import.meta.main adapter bootstrap below: that process runs
// under the CHILD's composed identity env (AGENT_TOPOLOGY=worker etc.), and the
// invoking adapter (bb agents-cli) already enforced the real caller's authority
// BEFORE composing it. Re-asserting here would read the child's topology as the
// caller's and deny every managed delegate (the 2026-07-17 self-deny bug).
let bootstrapAuthorityGranted = false;

export async function spawn(opts: SpawnOptions): Promise<string> {
  const callerTopology = process.env.AGENT_TOPOLOGY;
  if (!bootstrapAuthorityGranted) assertCoordinationAuthority("spawn", callerTopology);
  const composed = composeSpawnOptions(opts);
  if (!bootstrapAuthorityGranted) {
    assertManagedChildTopology(
      "spawn", composed.routingMetadata.topology, callerTopology,
    );
  }
  const context = envelopeContextFromEnv();
  const requestedTier = composed.tier;
  const agentId = composed.agentId ?? createSpawnAgentId();
  // Pin the generated id so admission, telemetry, and the provider run name the
  // same lane. Admission completes before entitlement refresh or provider query.
  composed.agentId = agentId;
  const admission = await admitResourceEnvelope({
    agentId, tier: requestedTier, project: composed.project ?? context.project,
    sessionId: composed.sessionId ?? context.sessionId,
  });
  for (const advisory of admission?.advisories ?? []) console.warn(`[envelope] advisory: ${advisory}`);
  try { return await runSpawn(composed, admission); }
  finally { await completeResourceEnvelope(admission); }
}

// Spawn multiple agents in parallel — the core win over the bash swarm.
export async function spawnParallel(
  tasks: SpawnOptions[]
): Promise<string[]> {
  assertCoordinationAuthority("spawnParallel");
  return Promise.all(tasks.map((t) => spawn(t)));
}

if (import.meta.main) {
  // Caller authority was enforced by the invoking adapter before it composed
  // this process's env with the child identity — see bootstrapAuthorityGranted.
  bootstrapAuthorityGranted = true;
  const prompt = process.argv.slice(2).join(" ");
  if (!prompt) {
    console.error("usage: bun run src/spawn.ts <prompt>");
    process.exit(1);
  }
  const role = process.env.AGENT_ROLE;
  if (!role) {
    console.error(
      "managed North spawn requires AGENT_ROLE selecting a canonical Gaffer preset or complete bespoke composition",
    );
    process.exit(1);
  }
  const rawDelegateThread = process.env.NORTH_DELEGATE_THREAD_ID;
  delete process.env.NORTH_DELEGATE_THREAD_ID;
  let delegateThread: string | undefined;
  if (rawDelegateThread !== undefined) {
    try {
      delegateThread = normalizeNorthEntityId(rawDelegateThread);
    } catch {
      console.error("managed delegate bootstrap received an invalid exact North thread id");
      process.exit(1);
    }
  }

  spawn({
    prompt,
    agentId: process.env.AGENT_ID,
    model: process.env.AGENT_MODEL,
    effort: process.env.AGENT_EFFORT as Effort | undefined,
    provider: process.env.AGENT_PROVIDER as ProviderPreference | undefined,
    target: process.env.AGENT_TARGET,
    tier: process.env.AGENT_TIER as SemanticTier | undefined,
    role,
    thread: delegateThread,
    coordinator: process.env.AGENT_COORDINATOR,
    routingMetadata: routingMetadataFromEnv(),
  })
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
