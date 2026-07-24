import { resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
const REPO_ROOT = pathResolve(import.meta.dir, "..", "..");
import { StreamWriter } from "./stream-writer";
import {
  DEFAULT_SYSTEM_PROMPT, harnessCompositionEvidence, harnessOptions, renewHarnessPresence,
  type Effort, type HarnessCompositionEvidence,
} from "./harness";
import {
  provisionWorktree, recordWorktreeAuthorityProfile, recordWorktreeRunRotation,
  resolvedWorktreeAuthorityProfile, rollbackProvisionedWorktree,
  worktreeFinalize, worktreePayload,
  type ProvisionedWorktree, type WorktreeAllocationWriter,
  type WorktreeTerminalFailure,
} from "./worktree";
import { normalizeUsage } from "./usage";
import { classifyTurnProvenance, newRunId, recordRun } from "./telemetry";
import { collectProviderJoinEvidence } from "./providers/provider-join";
import { publishRunLifecycleLedger } from "./run-ledger";
import { resolveManagedCaveman, type CavemanResolution } from "./caveman";
import { unknownMcpActivity } from "./tool-activity";
import { causeChain, deathReason, notifyDeath } from "./death";
import {
  inputChannel,
  LiveFeedReapTimeoutError,
  subscribeFeed,
} from "./coordination";
import {
  bespokeContractFingerprint, writeAgentFacts, writeAgentTerminal, updateAgentRoute, goalFromPrompt,
  userAnchoredPath,
} from "./identity";
import { BESPOKE_FINGERPRINT_DOMAIN, BESPOKE_FINGERPRINT_VERSION } from "./bespoke-contract";
import {
  makeStruggleObserver, resolveStrugglePolicy,
  assertExpectedStrugglePolicy,
  type StrugglePolicy,
} from "./struggle";
import { withStallWatchdog, stallMs, notifyStall, notifyTurnCap } from "./watchdog";
import { makeBgTracker, bgContinuationMessage, maxBgContinuations } from "./bgtasks";
import {
  assessChildFinalization, childContinuationMessage, childDispatchMessage, childReductionMessage,
  continuationRaceOutcome, decideChildTurnEnd, initialChildContinuationState, notifyEarlyExitChildren,
  requiredDirectChildCount, settleChildren,
  type ChildSettlement, type OrchestratorContinuationKind,
} from "./children";
import { admitBillableClock } from "./clock";
import {
  formatProviderAuthoritySurface, providerLiveInput, routedQuery, selectProvider,
  selectProviderForExecution,
  ProviderRetrySafeError,
  type ProviderAuthoritySurface, type ProviderPreference,
} from "./providers";
import type { AgentQuery } from "./providers/types";
import { resolveTier, type SemanticTier } from "./providers/catalog";
import type { RoutingRequest } from "./routing-metadata";
import { admitRoutingRequest, routingRequestFromEnv } from "./routing-admission";
import {
  gafferCapabilities,
} from "./gaffer-staffing";
import { refreshAccountUsages } from "./account-usage";
import {
  admitResourceEnvelope, completeResourceEnvelope, envelopeContextFromEnv,
  reserveResourceEnvelopeRetry, ResourceEnvelopeExceededError, type EnvelopeAdmission,
} from "./resource-envelopes";
import { assertCoordinationAuthority } from "./topology-authority";
import { admitPinnedProvider } from "./execution-admission";
import {
  classifyExecutionTerminal, EMPTY_RESULT_OUTCOME, isEmptyResultTerminal,
  PROVIDER_PROCESS_DEATH_OUTCOME,
} from "./execution-outcome";
import { ManagedLiveInputRoute } from "./live-input-route";
import {
  admitRoutingEconomics, type AdmittedRoutingEconomics,
  type RoutingAssessment, type RoutingPinEvidence,
} from "./routing-economics";
import {
  notifyTerminalSettlement, TerminalPublicationBudget, type TerminalNotification,
} from "./terminal-notification";
import { assessThreadDelivery, type DeliveryAssessment } from "./delivery-verification";
import { getThreadFacts, normalizeNorthEntityId } from "./north-client";
import {
  loadDeliveryRunState, newDeliveryRunContext, reserveDeliveryRun,
  type DeliveryReservation, type DeliveryRunContext, type DeliveryRunState,
} from "./delivery-evidence";
import { takeSpawnTestRuntime } from "./internal/test-runtime";
import {
  adHocJudgmentGrade, judgmentGradeFromThreadFacts,
  type JudgmentGradeSnapshot,
} from "./judgment-grade";
import {
  ManagedQueryTermination, type HostTerminationRegistrar,
} from "./query-lifecycle";

export interface SpawnOptions {
  prompt: string;
  agentId?: string;
  model?: string;
  effort?: Effort;
  tools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
  /** Equality-only compatibility alias; routingMetadata remains authoritative. */
  role?: string;
  posture?: string;
  thread?: string; // exact work/evidence thread; managed runs verify the human client session separately.
  concern?: string; // exact physical-allocation concern owner; absent is explicitly unattributed.
  caveman?: "off" | "lite" | "full"; // request override for the fork-backed response strategy
  coordinator?: string; // spawning coordinator handle -> gets a direct peer ping on death
  provider?: ProviderPreference;
  target?: string;
  tier?: SemanticTier;
  routingMetadata: RoutingRequest;
  /** Gaffer-owned minimum-sufficient assessment; separate from the eight-field request. */
  routingAssessment?: RoutingAssessment;
  /** North-owned evidence for explicit provider/account/model pins. */
  pinEvidence?: RoutingPinEvidence;
  project?: string;
  sessionId?: string;
  worktree?: boolean; // OPT-IN: provision an isolated per-lane git worktree (own index+tree); default OFF => zero behavior change
  setupCmd?: string; // optional repo-setup hook run in the fresh worktree (e.g. `bun install`); repo-specific, never baked into north
}

interface SpawnRuntime {
  queryFn?: (args: any) => AgentQuery;
  deliveryRuntime?: {
    reserve: (context: DeliveryRunContext) => DeliveryReservation;
    load: (runId: string) => DeliveryRunState;
  };
  loadThreadFacts?: typeof getThreadFacts;
  childSettlementReader?: (agentId: string) => ChildSettlement;
  feedSubscriber?: typeof subscribeFeed;
  registerTermination?: HostTerminationRegistrar;
  refreshAccountUsages?: typeof refreshAccountUsages;
  admitResourceEnvelope?: typeof admitResourceEnvelope;
  completeResourceEnvelope?: typeof completeResourceEnvelope;
  admitBillableClock?: typeof admitBillableClock;
  worktreeAllocationWriter?: WorktreeAllocationWriter;
}

const SPAWN_OPTION_FIELDS = new Set([
  "prompt", "agentId", "model", "effort", "tools", "systemPrompt", "maxTurns",
  "role", "posture", "thread", "concern", "caveman", "coordinator", "provider",
  "target", "tier", "routingMetadata", "project", "sessionId", "worktree", "setupCmd",
  "routingAssessment", "pinEvidence",
]);

function allowlistedSpawnOptions(value: SpawnOptions): SpawnOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("managed North spawn request must be an object");
  const admitted: Record<string, unknown> = {};
  for (const [field, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!SPAWN_OPTION_FIELDS.has(field))
      throw new Error(`managed North spawn request has unknown field ${field}`);
    if (descriptor.get || descriptor.set)
      throw new Error(`managed North spawn request field ${field} must be a data property`);
    admitted[field] = descriptor.value;
  }
  return admitted as unknown as SpawnOptions;
}

export function createSpawnAgentId(now = Date.now(), uuid = randomUUID()): string {
  return `lane-${now.toString(36)}-${uuid}`;
}

interface ManagedWorktreeLease extends ProvisionedWorktree {
  finalized: boolean;
}

// Bounded auto-retry for retry-safe provider-process deaths (thread 019f8f81,
// 2026-07-23 gen-1018 cluster: 4x openai_provider_execution_failed, zero retry).
// Constant-in-code, deliberately not env-tunable — a single fresh-run retry,
// never a loop. Terminal truthfulness: if the retry also dies, BOTH runs are
// recorded and the original death fact is never rewritten (see recordRun's
// retryOfRun/retryAttempt provenance below).
const PROVIDER_PROCESS_DEATH_MAX_RETRIES = 1;

/**
 * All three must hold before a provider-process death is retried:
 *  - the death class is provider-process-level (PROVIDER_PROCESS_DEATH_OUTCOME,
 *    i.e. openai_provider_execution_failed / provider_process_died), never a
 *    preflight block, stall, cap, or resource-envelope refusal;
 *  - topology is worker — an orchestrator's live child obligations make retry
 *    semantics wrong (a fresh run cannot honestly re-inherit them);
 *  - the lane's capability surface is read-only (no filesystem.write/shell) —
 *    a writable lane may already have mutated the checkout, so re-running it
 *    is unsafe.
 */
export function eligibleForProviderProcessDeathRetry(
  outcome: string,
  topology: string | undefined,
  capabilities: readonly string[],
): boolean {
  if (outcome !== PROVIDER_PROCESS_DEATH_OUTCOME) return false;
  if (topology !== "worker") return false;
  if (capabilities.includes("filesystem.write") || capabilities.includes("shell")) return false;
  return true;
}

interface RetryContext {
  retryOfRun: string;
  retryAttempt: number;
  // Bare agent id of the terminal-committed lane this fresh identity follows.
  // Terminal identities are immutable — the retry mints its OWN agent id
  // (opts.agentId is overridden by the caller before runSpawn) and links back
  // to the original via this provenance field rather than reusing its subject.
  retryOfAgent: string;
}

// Only the executable bootstrap can classify selectors inherited from a
// serialized pre-evidence envelope as legacy. Programmatic callers cannot opt
// themselves into the compatibility warning path.
let bootstrapLegacyPinCompatibilityGranted = false;

function composeSpawnOptions(opts: SpawnOptions): SpawnOptions & {
  routingMetadata: RoutingRequest;
  routingEconomics: AdmittedRoutingEconomics;
} {
  const routingMetadata = admitRoutingRequest(
    opts.routingMetadata ?? {}, "managed North spawn",
  );
  const aliases = [
    ["role", opts.role, routingMetadata.role],
    ["tier", opts.tier, routingMetadata.tier],
    ["effort", opts.effort, routingMetadata.reasoning],
    ["posture", opts.posture, routingMetadata.posture],
  ] as const;
  for (const [field, supplied, canonical] of aliases) {
    if (supplied !== undefined && supplied !== canonical) {
      throw new Error(
        `managed North spawn ${field} compatibility alias must equal routingMetadata `
        + `(${JSON.stringify(supplied)} != ${JSON.stringify(canonical)})`,
      );
    }
  }
  const routingEconomics = admitRoutingEconomics({
    request: routingMetadata,
    routingAssessment: opts.routingAssessment,
    pinEvidence: opts.pinEvidence,
    provider: opts.provider,
    target: opts.target,
    model: opts.model,
    allowLegacyMissingPinEvidence: bootstrapLegacyPinCompatibilityGranted,
    surface: "managed North spawn routing economics",
  });
  return {
    ...opts,
    routingMetadata,
    routingAssessment: routingEconomics.assessment,
    pinEvidence: routingEconomics.pinEvidence,
    routingEconomics,
    role: routingMetadata.role,
    tier: routingMetadata.tier,
    effort: routingMetadata.reasoning as Effort | undefined,
    posture: routingMetadata.posture,
  };
}

async function runSpawn(
  opts: SpawnOptions & {
    routingMetadata: RoutingRequest;
    routingEconomics: AdmittedRoutingEconomics;
  },
  judgmentGrade: JudgmentGradeSnapshot,
  strugglePolicy: StrugglePolicy,
  caveman: CavemanResolution,
  envelopeAdmission?: EnvelopeAdmission,
  injected: SpawnRuntime = {},
  termination: ManagedQueryTermination = new ManagedQueryTermination(),
  worktreeLease?: ManagedWorktreeLease,
  retryContext?: RetryContext,
): Promise<{ result: string; outcome: string; runId: string }> {
  const runStartedAt = process.hrtime.bigint();
  // Composition is deliberately complete before admission and stays immutable
  // through routing, identity, provider execution, and terminal telemetry.
  const routingMetadata = opts.routingMetadata;
  const capabilities = gafferCapabilities(routingMetadata);
  const requested = { provider: opts.provider, target: opts.target,
    tier: opts.tier, model: opts.model, effort: opts.effort };
  const agentId = opts.agentId ?? createSpawnAgentId();
  const repoRoot = worktreeLease?.repoRoot ?? process.cwd();
  const wt = worktreeLease;
  let runId = worktreeLease?.allocation.runId ?? newRunId(agentId);
  const runContext = opts.thread
    ? newDeliveryRunContext(runId, opts.thread, agentId)
    : undefined;
  const deliveryRuntime = injected.deliveryRuntime ?? (injected.queryFn ? undefined : {
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
  if (!injected.queryFn) admitPinnedProvider(opts.provider, capabilities);
  // Injected query functions own their entire provider boundary; keeping the
  // refresh out of that path makes tests and alternative adapters hermetic.
  const routingContext = {
    tier: requestedTier, reasoning: requestedReasoning, model: opts.model,
    stableKey: agentId, capabilities, signal: termination.signal,
  };
  let routing;
  if (injected.queryFn) {
    routing = selectProvider(routingRequest, undefined, routingContext);
  } else {
    try {
      routing = await selectProviderForExecution(
        routingRequest,
        undefined,
        routingContext,
        injected.refreshAccountUsages
          ? { refreshAccountUsages: injected.refreshAccountUsages }
          : {},
      );
    } catch (error) {
      // Provider refresh cancellation is an internal control edge. If the host
      // caused it, retain the host signal as the public lifecycle terminal.
      termination.throwIfTerminated();
      throw error;
    }
  }
  termination.throwIfTerminated();
  if (wt && injected.queryFn) {
    // An injected provider owns its boundary and never enters routedQuery's
    // attempt hook, so publish its selected authority at the same pre-query seam.
    recordWorktreeAuthorityProfile(
      wt.allocation,
      resolvedWorktreeAuthorityProfile(routing),
    );
  }
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
    worktree: wt?.path,
    branch: wt?.branch,
    retryOfAgent: retryContext?.retryOfAgent,
  };
  const initialLiveInput = providerLiveInput(routing.provider);
  const ch = inputChannel(opts.prompt); // streaming input keeps the managed live-steering route open
  termination.attachInput(() => { try { ch.end(); } catch { /* already closed */ } });
  const liveInputRoute = new ManagedLiveInputRoute(
    agentId,
    identityBase,
    {
      provider: routing.provider,
      providerTarget: routing.target,
      liveInput: initialLiveInput,
      model: opts.model,
      effort: opts.effort,
    },
    (message) => ch.push(message),
    injected.feedSubscriber ?? subscribeFeed,
  );
  await writeAgentFacts(agentId, {
    ...identityBase,
    model: opts.model,
    provider: routing.provider,
    providerTarget: routing.target,
    liveInput: initialLiveInput,
    ...liveInputRoute.initialProjection(),
    effort: opts.effort,
  });
  const activeRoute = () => ({
    provider: routing.provider,
    providerTarget: routing.target,
    liveInput: providerLiveInput(routing.provider),
    model: routing.resolvedModel ?? opts.model,
    effort: routing.resolvedEffort ?? opts.effort,
  });
  const refreshIdentityRoute = (required = false) => {
    liveInputRoute.refresh(activeRoute(), required);
  };
  const struggle = makeStruggleObserver(strugglePolicy);

  console.log(`[spawn] @agent:${agentId} starting provider=${routing.provider} target=${routing.target}${resolved.tier ? ` tier=${resolved.tier}` : ""} (${routing.reason})`);

  let result = "", resultMsg: any = null, outcome = "ran";
  // Full nested-cause chain for a blocked_preflight (or other retry-safe) death,
  // set alongside `outcome` in the catch below and carried onto @run so the
  // real underlying failure survives past the banner-only stdout log.
  let preflightCause: string | undefined;
  let worktreeTerminalFailure: WorktreeTerminalFailure | undefined;
  const terminalMessages: any[] = [];
  const end = (oc: string) => { outcome = oc; try { ch.end(); } catch { /* already closed */ } };

  let injectedCompositionEvidence: HarnessCompositionEvidence | undefined;
  let admittedRoute: {
    provider: ProviderAuthoritySurface["provider"];
    evidence: HarnessCompositionEvidence | undefined;
    authority: ProviderAuthoritySurface;
  } | undefined;
  const queryFn = injected.queryFn ?? ((args: any) => routedQuery(
    routing, args, requestedTier, async (transition) => {
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
      console.log(`[spawn] effective authority: ${formatProviderAuthoritySurface(authority)}`);
    },
    (decision) => {
      if (wt) {
        recordWorktreeAuthorityProfile(
          wt.allocation,
          resolvedWorktreeAuthorityProfile(decision),
        );
      }
    },
  ));
  // This boundary distinguishes North/Gaffer prompt assembly from the provider
  // query itself. A throw before construction cannot honestly be a provider
  // process death because no provider query has been created or accepted.
  let providerQueryConstructionStarted = false;
  let queryCloseError: unknown;
  let activeExecutionQuery: AgentQuery | undefined;

  // Error boundary (thread 019f2800): the SDK runs the turn in a subprocess; if it dies
  // (OOM SIGKILL / parent SIGTERM / idle Transport-closed) readMessages() THROWS exitError
  // here. Without this try/catch the throw escaped -> recordRun skipped, no death signal,
  // channel leaked. Now: catch -> outcome "died" + durable death fact; finally
  // -> ALWAYS end the channel + record the run; return the PARTIAL result (supervision, not
  // fail-fast) so one worker's death never rejects a spawnParallel Promise.all batch.
  // Stream watchdog (thread 019f4d54): a stall (no SDK message for N min while the
  // query is open) is otherwise INVISIBLE — the iterator neither yields nor throws, so
  // the catch below never fires. Wrap the iterator: N min silence -> stalled fact +
  // coordinator ping (diagnostic); 2N -> abort + outcome=stalled + durable death fact.
  // Every terminal peer wake is deferred until the terminal and run publications settle.
  const coordHandle = opts.coordinator;
  const window = stallMs();
  let stallAborted = false;
  let terminalSignal: Pick<TerminalNotification, "detail" | "subject"> = {};
  const terminalAuxiliaryWrites: Array<(timeoutMs: number) => void> = [];
  let liveInputFreezeError: unknown;
  // Background-task refusal (thread 019f4ed2): a lane that ends its turn while a
  // harness-tracked background Bash task is live must NOT finalize — the SDK
  // auto-continues the model on task settlement, but only if we keep the loop alive
  // instead of breaking on the first `result`. Track the live set; bgContinuations
  // counts CONSECUTIVE no-progress refusals (reset on settlement) for the stuck-lane cap.
  const bgTracker = makeBgTracker();
  let bgContinuations = 0;
  const orchestrator = routingMetadata.topology === "orchestrator";
  const readChildSettlement = injected.childSettlementReader ?? settleChildren;
  let childContinuation = initialChildContinuationState(
    requiredDirectChildCount(routingMetadata),
  );
  // Orchestrator continuation race (thread 019f8ec5): the obligation whose
  // continuation was injected at the last turn-end and not yet discharged by a
  // genuine (non-empty) provider result. If the next result is a degenerate
  // empty terminal (the continuation raced the Anthropic session's teardown),
  // this drives an explicit blocked outcome instead of a ran_empty masquerade.
  let pendingContinuation: OrchestratorContinuationKind | undefined;
  // Anthropic streaming input races session teardown after the model's final
  // result (thread 019f8ec5): a continuation injected into the live channel then
  // lands on a closing stream. For a streaming-input provider an orchestrator
  // continuation instead ends the turn and opens a fresh RESUMED turn once a
  // session id has been observed. Codex (frame-based, liveInput=unsupported)
  // re-opens a turn per frame already and keeps the injection path untouched.
  // `sessionId` is the last session id the provider published; `pendingResume`
  // is the continuation message to carry into the next resumed turn.
  const resumeContinuations = orchestrator
    && providerLiveInput(routing.provider) === "streaming";
  let sessionId: string | undefined;
  let pendingResume: string | undefined;
  let compactions = 0; // SDK auto-compaction events observed across the run (audit fix 4)
  try {
  // Reserve only at the last pre-provider seam. Earlier routing/admission
  // failures must not strand undiscoverable reservation-only subjects.
  if (runContext) {
    try {
      if (deliveryRuntime) {
        deliveryReservation = deliveryRuntime.reserve(runContext);
        if (!deliveryReservation) throw new Error("reservation acknowledgement unavailable");
        deliveryReservationReady = true;
      }
    } catch (error) {
      const abandonedRunId = runId;
      runId = newRunId(agentId);
      if (wt) recordWorktreeRunRotation(wt.allocation, runId);
      // Loud + diagnosable (thread 019f9063): the prior message swallowed the
      // writer's exact rejection (freshness, thread-identity, or malformed-ack
      // reasons all read identically as "unavailable"), so a real ordering
      // defect and a healthy-but-raced reservation were indistinguishable from
      // the log alone. The underlying message is a bounded, already-sanitized
      // Fram rejection or JS Error text — safe to surface directly.
      console.error(
        `[delivery] @${abandonedRunId} reservation unavailable; rotating telemetry to @${runId} `
        + `and leaving delivery unverified: ${(error as Error)?.message ?? String(error)}`,
      );
    }
  }
  const agentOptions = harnessOptions({
    self: agentId,
    extraTools: opts.tools ?? ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    model: opts.model, effort: opts.effort,
    provider: routing.provider,
    modelAvailability: {
      exactModelPinned: requested.model !== undefined,
      targetId: routing.target,
      receipt: routing.modelAvailabilityReceipts?.[routing.target],
    },
    routingMetadata,
    // Worktree lane: run tools IN the worktree (cwd) and append the
    // isolation+landing+verify protocol to the prompt. Composed HERE so
    // harness.ts stays a thin cwd knob.
    systemPrompt: wt
      ? (opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT)
        + worktreePayload({ path: wt.path, branch: wt.branch, mainReportsDir: repoRoot + "/docs/private" })
      : opts.systemPrompt,
    maxTurns: opts.maxTurns,
    abortController: termination.abortController,
    role: opts.role, posture: opts.posture,
    cwd: wt?.path ?? process.cwd(),
    deliveryRun: deliveryReservationReady ? runContext : undefined,
    cavemanInstructions: caveman.instructions,
  });
  injectedCompositionEvidence = harnessCompositionEvidence(agentOptions);
  if (injected.queryFn && injected.feedSubscriber)
    await liveInputRoute.activate(activeRoute());
  termination.throwIfTerminated();
  providerQueryConstructionStarted = true;
  turnLoop: while (true) {
  const resumeMessage = pendingResume;
  pendingResume = undefined;
  // Turn 1 (and every non-resumed provider) reads the managed streaming channel
  // so live steering and background-task continuations keep working unchanged.
  // A resumed continuation turn reads a fresh single-message channel carrying
  // the continuation and asks the adapter to resume the observed session.
  const turnChannel = resumeMessage === undefined ? ch : inputChannel(resumeMessage);
  const activeQuery = queryFn({
    prompt: turnChannel.stream(),
    options: agentOptions,
    ...(resumeMessage === undefined ? {} : { resume: sessionId }),
  });
  activeExecutionQuery = activeQuery;
  termination.attachQuery(activeQuery);
  const watched = withStallWatchdog((activeQuery as AsyncIterable<any>)[Symbol.asyncIterator](), {
    stallMs: window,
    onStall: (mins) => notifyStall(agentId, mins, { coordinator: coordHandle }),
    onAbort: () => { stallAborted = true; },
  });
  let openResumeTurn = false;
  for await (const message of watched) {
    const msg = message as any;
    if (typeof msg.session_id === "string") sessionId = msg.session_id;
    renewHarnessPresence(agentOptions);
    // routedQuery mutates the decision before the first fallback-provider event.
    // Refresh from that structured decision before the event is exposed.
    refreshIdentityRoute();
    stream.writeSDKMessage(msg);
    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      compactions++;
      console.error(`[harness] @agent:${agentId} context compaction #${compactions} (compact_boundary)`);
    }
    if (bgTracker.observe(msg) === "settled") bgContinuations = 0; // forward progress refreshes the cap

    // Struggle sensors are OBSERVE-ONLY now: fold the message, and on the first
    // occurrence of each trigger leave a stderr breadcrumb. The run does NOT change
    // route or terminate — the accumulated triggers become terminal `struggle` run
    // facts below, feeding D2's execution-axis diagnosis without any in-flight swap.
    const trigger = struggle.observe(msg);
    if (trigger) {
      console.error(`[struggle] @agent:${agentId} sensor fired: ${trigger} (turn ${struggle.state.turn}, ${struggle.state.totalErrors} tool error(s)) — recorded as execution-axis evidence, no in-flight change`);
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
        end("provider_error");
        break;
      }
      if (turnChannel.pending() === 0) {
        // A resumed continuation turn reads its own fresh channel, so gate
        // turn-end on that turn's channel; for turn 1 turnChannel IS ch, so
        // non-orchestrator and codex lanes keep byte-identical behavior.
        // Orchestrator continuation race (thread 019f8ec5): a continuation
        // injected at a prior turn-end asks the provider for ANOTHER genuine
        // turn, but the Anthropic session may already be tearing down after its
        // final message — the continuation then lands on a closing stream and
        // the provider answers with a degenerate empty-success terminal.
        // decideChildTurnEnd would otherwise read that empty result as a
        // completed continuation (acknowledging a reduction that never ran) and
        // finalize it as ran_empty. An outstanding continuation is discharged
        // ONLY by a non-empty result; an empty terminal here is the race, so
        // record the obligation-specific blocked outcome loudly instead.
        if (orchestrator && pendingContinuation && result.trim() === "") {
          const raced = continuationRaceOutcome(pendingContinuation);
          console.error(
            `[harness] @agent:${agentId} orchestrator ${pendingContinuation} continuation answered by an empty provider terminal — closing-stream race, recording ${raced} (never ran_empty)`,
          );
          end(raced);
          break;
        }
        pendingContinuation = undefined; // a genuine result discharges the obligation
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
          turnChannel.push(bgContinuationMessage(live));
          continue; // do NOT finalize; keep the query loop alive
        }
        if (bgTracker.size() > 0) {
          console.error(`[harness] @agent:${agentId} continuation cap (${maxBgContinuations()}) reached with ${bgTracker.size()} task(s) still live — finalizing anyway`);
        }
        if (orchestrator) {
          const decision = decideChildTurnEnd(
            childContinuation,
            readChildSettlement(agentId),
            maxBgContinuations(),
          );
          childContinuation = decision.state;
          if (decision.action === "continue") {
            let continuation: string;
            if (decision.reason === "children_live") {
              console.error(
                `[harness] @agent:${agentId} refusing orchestrator turn-end — ${decision.live.length} live child lane(s): ${decision.live.join(", ")} (no-progress ${decision.attempt}/${decision.cap})`,
              );
              continuation = childContinuationMessage(decision.live);
            } else if (decision.reason === "child_dispatch_required") {
              console.error(
                `[harness] @agent:${agentId} requiring direct-child dispatch — ${decision.children.length}/${decision.required} child lane(s) observed (no-progress ${decision.attempt}/${decision.cap})`,
              );
              continuation = childDispatchMessage(decision.children, decision.required);
            } else {
              console.error(
                `[harness] @agent:${agentId} requiring post-settlement reduction — ${decision.children.length} settled child lane(s): ${decision.children.join(", ")}`,
              );
              continuation = childReductionMessage(decision.children);
            }
            // Remember the outstanding obligation so a degenerate empty terminal
            // on the next turn (a closing-stream race) blocks explicitly rather
            // than falsely discharging the continuation.
            pendingContinuation = decision.reason;
            if (resumeContinuations && sessionId !== undefined) {
              // Streaming provider + an observed session: do NOT push into the
              // closing stream. End this turn and open a fresh resumed turn
              // carrying the continuation (thread 019f8ec5 prevention). A resume
              // that still comes back empty is caught by the empty-terminal guard
              // above / the final child gate — recorded as the obligation-specific
              // blocked outcome, never a ran_empty masquerade.
              console.error(
                `[harness] @agent:${agentId} opening a resumed continuation turn on session ${sessionId} instead of injecting into the closing stream`,
              );
              pendingResume = continuation;
              openResumeTurn = true;
              break;
            }
            ch.push(continuation);
            continue;
          }
          if (decision.action === "block") {
            const blockedOutcome = decision.reason === "child_reconciliation_unavailable"
              ? "child_reconciliation_unavailable"
              : decision.reason === "child_set_regressed"
                ? "orchestrator_child_set_inconsistent"
                : decision.reason === "child_dispatch_continuation_cap"
                  ? "orchestrator_child_obligation_unmet"
                  : "orchestrator_children_incomplete";
            const detail = decision.missing?.length
              ? ` (missing previously observed: ${decision.missing.join(", ")})`
              : decision.live?.length
                ? ` (${decision.live.join(", ")})`
                : decision.required !== undefined
                  ? ` (${decision.children?.length ?? 0}/${decision.required} direct children)`
                : "";
            console.error(
              `[harness] @agent:${agentId} orchestrator completion blocked: ${decision.reason}${detail}`,
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
  // Turn complete. A resume-based continuation ended this turn cleanly so no
  // continuation was pushed into its closing stream; close the finished query
  // and loop to open the resumed turn. Any other terminal is final for the run.
  if (turnChannel !== ch) { try { turnChannel.end(); } catch { /* fresh resume channel */ } }
  if (!openResumeTurn) break turnLoop;
  try { await activeQuery.close?.(); }
  catch (error) { queryCloseError = error; }
  }
  if (!resultMsg && outcome === "ran") {
    // A clean iterator close is transport completion, not provider success.
    // Only an explicit terminal result may establish process=ran.
    outcome = "provider_error";
  }
  if (isEmptyResultTerminal(outcome, result)) {
    // A provider success terminal with empty result (0b) is a DEGENERATE
    // completion, not a delivery (thread 019f8300): opus-high extended-thinking
    // turns that hit the output-token ceiling truncate before committing any
    // final text — the last assistant block is an unanswered tool_use or a
    // terminal thinking block — yet the SDK still yields subtype=success/
    // result="". Recording it as process=ran read as a clean no-op. Make it a
    // distinct LOUD terminal so a zero-deliverable lane never masquerades as
    // AGENT COMPLETE.
    outcome = EMPTY_RESULT_OUTCOME;
    const turns = typeof resultMsg?.num_turns === "number" ? `${resultMsg.num_turns} turns` : "unknown turns";
    terminalSignal = {
      subject: "AGENT EMPTY RESULT",
      detail: `provider success terminal with empty result (0b) after ${turns} — no deliverable text committed (likely output-token ceiling hit mid extended-thinking/tool_use)`,
    };
    console.error(`[empty-result] @agent:${agentId} provider success terminal carried 0b result — recording process=ran_empty (loud, non-clean)`);
  }
  if (stallAborted) {
    // 2N of silence: make the stall TERMINAL + VISIBLE. Interrupt the hung query, record
    // outcome=stalled, and record the death path durably. Its terminal peer wake
    // is deferred until the authoritative terminal and run publications settle.
    outcome = "stalled";
    await termination.close();
    const err = new Error(
      `stalled — no SDK output for ${Math.max(2, 2 * Math.round(window / 60_000))}min`,
    );
    terminalSignal = { subject: "AGENT DEATH", detail: deathReason(err) };
    terminalAuxiliaryWrites.push((timeoutMs) =>
      notifyDeath(agentId, err, { thread: undefined }, timeoutMs)
    );
  }
  } catch (err) {
    if (err instanceof ResourceEnvelopeExceededError) {
      outcome = "resource_envelope_exceeded";
      worktreeTerminalFailure = {
        code: "resource_envelope_retry_refused",
        phase: "provider_preflight",
      };
      console.error(`[envelope] @agent:${agentId} ${err.message}`);
    } else if (err instanceof ProviderRetrySafeError) {
      // A spend-guard refusal carries its own terminal outcome; every other
      // retry-safe preflight block stays blocked_preflight.
      const carried = (err as { processOutcome?: unknown }).processOutcome;
      outcome = typeof carried === "string" ? carried : "blocked_preflight";
      worktreeTerminalFailure = {
        code: "provider_preflight_refused",
        phase: "provider_admission",
      };
      preflightCause = causeChain(err);
      console.error(`[${outcome}] @agent:${agentId} ${preflightCause}`);
    } else if (!providerQueryConstructionStarted) {
      outcome = "blocked_preflight";
      worktreeTerminalFailure = {
        code: "spawn_pre_provider_setup_failed",
        phase: "provider_preflight",
      };
      preflightCause = `spawn_pre_provider_setup_failed: ${causeChain(err)}`;
      console.error(`[blocked_preflight] @agent:${agentId} ${preflightCause}`);
    } else {
      outcome = "died";
      terminalSignal = { subject: "AGENT DEATH", detail: deathReason(err) };
      terminalAuxiliaryWrites.push((timeoutMs) =>
        notifyDeath(agentId, err, { thread: undefined }, timeoutMs)
      );
    }
  } finally {
    try {
      await liveInputRoute.freezeAndUnbind();
    } catch (error) {
      liveInputFreezeError = error;
    }
    end(outcome); // idempotent: close the channel so the query + any leak unwinds
    // A terminal SDK result does not guarantee the provider subprocess has
    // exited while streaming input remains open. Interrupt exactly once after
    // closing input so a completed lane cannot retain its Bun/CLI process tree.
    try { await termination.close(); }
    catch (error) { queryCloseError = error; }
  }

  // Snapshot BEFORE any cleanup-only failure below can touch outcome: this is
  // the provider's own terminal, not a cleanup verdict. A lane that already
  // reached its success terminal (a real result was read) has done the work;
  // teardown of the terminal live-feed drain afterward is usually best-effort
  // cleanup, not part of the provider turn. The exception is a typed direct-
  // child reap timeout: an unreaped managed child means the process itself has
  // not earned a clean terminal. A drain failure that happens BEFORE a success
  // terminal (no result yet) also stays fail-closed via the branches below.
  const reachedProviderSuccessTerminal = outcome === "ran";

  const hostSignal = termination.hostSignal();
  if (hostSignal) {
    outcome = "died";
    const error = new Error(`host terminated by ${hostSignal}`);
    terminalSignal = { subject: "AGENT DEATH", detail: deathReason(error) };
  } else if (queryCloseError) {
    outcome = "died";
    const error = queryCloseError instanceof Error
      ? queryCloseError : new Error("provider query cleanup failed");
    terminalSignal = { subject: "AGENT DEATH", detail: deathReason(error) };
  }

  if (liveInputFreezeError) {
    let retrySucceeded = false;
    try {
      await liveInputRoute.freezeAndUnbind();
      retrySucceeded = true;
    } catch { /* the original freeze error remains the terminal authority */ }
    const error = liveInputFreezeError instanceof Error
      ? liveInputFreezeError
      : new Error("managed live-input route could not be frozen");
    const terminalSettlementFailed = error instanceof LiveFeedReapTimeoutError;
    if (retrySucceeded && !terminalSettlementFailed) {
      liveInputFreezeError = undefined;
    } else {
      if (reachedProviderSuccessTerminal && !terminalSettlementFailed) {
        // Completed provider turn: the feed leak is real (best-effort, logged
        // for operator follow-up) but it is cleanup after success — process/
        // delivery already earned by the completed turn stays as recorded.
        // No AGENT DEATH fact/ping: that channel means "the provider died",
        // which did not happen here and must not be asserted.
        console.error(
          `[live-input] @agent:${agentId} terminal live-feed drain failed after a completed provider turn — process/delivery preserved (${error.message})`,
        );
      } else {
        // A direct child that cannot be reaped is not a completed managed
        // process, even if the provider emitted a result first. Keep the
        // original typed settlement error and prohibit a clean terminal.
        outcome = "died";
        terminalSignal = { subject: "AGENT DEATH", detail: deathReason(error) };
        terminalAuxiliaryWrites.push((timeoutMs) =>
          notifyDeath(agentId, error, { thread: undefined }, timeoutMs)
        );
      }
    }
  }

  // Belt-and-suspenders terminal gate. A child may appear after the last
  // provider result, and an unavailable graph is not evidence of zero children.
  // Workers keep historical best-effort notification semantics; only a
  // successful orchestrator is prevented from publishing process=ran.
  const finalChildren = readChildSettlement(agentId);
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
  } else if (orchestrator && outcome === "orchestrator_child_obligation_unmet"
             && finalChildren.kind === "settled") {
    console.error(
      `[harness] @agent:${agentId} DIRECT-CHILD OBLIGATION UNMET: ${finalChildren.children.length}/${childContinuation.requiredChildren} direct child lane(s) observed; terminal cannot be process=ran`,
    );
  }

  // Salvage-gated worktree cleanup (only if this spawn provisioned one): remove
  // on a clean ran, KEEP + surface a worktree_orphaned fact on any
  // crash/cap/dirty tail. Fail-open.
  if (wt) {
    worktreeFinalize(agentId, outcome, wt, worktreeTerminalFailure);
    wt.finalized = true;
  }

  // Commit the lane's process/delivery terminal (SYNC, digest marker last)
  // before exit so the reactor cannot mistake a completed lane for silence.
  refreshIdentityRoute();
  let delivery: DeliveryAssessment | undefined;
  if (outcome === "ran" && opts.thread) {
    if (!deliveryReservationReady || !deliveryReservation || !deliveryRuntime) {
      delivery = {
        deliveryOutcome: "unverified",
        deliveryReason: "delivery_reservation_unavailable_at_finalize",
      };
    } else {
      const reservedRunId = runId;
      let runState: DeliveryRunState | undefined;
      let loadError: unknown;
      try {
        runState = deliveryRuntime.load(runId);
      } catch (error) {
        runState = undefined;
        loadError = error;
      }
      if (!runState?.reservationValid) {
        runId = newRunId(agentId);
        if (wt) {
          try { recordWorktreeRunRotation(wt.allocation, runId); }
          catch (error) {
            console.error(
              `[worktree] ${wt.allocation.subject} could not record terminal run rotation: ${String(error)}`,
            );
          }
        }
        deliveryReservationReady = false;
        // Loud + diagnosable (thread 019f9063): a load failure and a load that
        // simply found no valid reservation both used to read identically.
        console.error(
          `[delivery] @${reservedRunId} reservation invalid at finalize; rotating telemetry to @${runId} `
          + `and leaving delivery unverified`
          + (loadError !== undefined
            ? `: ${(loadError as Error)?.message ?? String(loadError)}`
            : ""),
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
            (injected.loadThreadFacts ?? getThreadFacts)(opts.thread),
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
  // The terminal marker is the lane's authoritative lifecycle boundary. It
  // must never queue behind diagnostic writes or lose their shared budget.
  const terminalPublication = writeAgentTerminal(
    agentId,
    terminal,
    publicationBudget.publicationTimeout(1),
  );
  for (const [index, writeAuxiliary] of terminalAuxiliaryWrites.entries()) {
    writeAuxiliary(
      publicationBudget.publicationTimeout(
        terminalAuxiliaryWrites.length - index + 2,
      ),
    );
  }

  const tokenUsage = normalizeUsage(terminalMessages, routing.provider);
  const providerJoin = collectProviderJoinEvidence(terminalMessages);
  const finalRoute = activeRoute();
  const promptComposition = admittedRoute?.evidence ?? injectedCompositionEvidence;
  const mcpActivity = activeExecutionQuery?.mcpActivity?.()
    ?? unknownMcpActivity("provider-activity-unavailable");
  const nativeCommandActivity = activeExecutionQuery?.nativeCommandActivity?.();
  const runLedger = await publishRunLifecycleLedger({
    run: runId,
    thread: opts.thread ?? "(ad-hoc)",
    agent: agentId,
    ...(process.env.NORTH_RUN_ID ? { parentRun: process.env.NORTH_RUN_ID } : {}),
    ...(process.env.NORTH_THREAD_ID ? { parentThread: process.env.NORTH_THREAD_ID } : {}),
    ...(coordHandle ? { coordinator: coordHandle } : {}),
    cavemanMode: caveman.resolvedMode,
    cavemanSource: caveman.source,
  }, {
    promptEconomics: promptComposition?.promptEconomics,
    tokenUsage,
    compactions,
    outcome,
    caveman,
    mcpActivity,
  }, publicationBudget.publicationTimeout(2)).catch(() => undefined);
  const numTurns = typeof resultMsg?.num_turns === "number"
    ? resultMsg.num_turns
    // A retry-safe preflight block proves the provider accepted no turn. This
    // zero is North-observed; every other missing provider value stays absent.
    : terminal.processOutcome === "blocked_preflight"
      || terminal.processOutcome === "blocked_spend_guard" ? 0 : undefined;
  const runPublication = await recordRun({
    thread: opts.thread ?? "(ad-hoc)", agent: agentId, posture: "spawn",
    // Effective FINAL dial; env-fallback mirrors the identity write so a bare
    // AGENT_MODEL spawn is still attributed.
    model: finalRoute.model,
    effort: finalRoute.effort,
    role: routingMetadata.role,
    provider: routing.provider, providerTarget: routing.target, providerReason: routing.selectionReason,
    modelAvailability: routing.modelAvailabilityReceipts?.[routing.target],
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
    routingAssessment: opts.routingEconomics.assessment,
    routingAdmissionReceipt: opts.routingEconomics.receipt,
    routingPinEvidence: opts.routingEconomics.pinEvidence,
    executionSource: "north-managed",
    executionTransport: activeExecutionQuery?.executionTransport
      ?? (routing.provider === "anthropic" ? "anthropic-agent-sdk" : undefined),
    caveman, mcpActivity, nativeCommandActivity,
    providerSessionPersistence: providerJoin?.sessionPersistence ?? "unknown",
    providerJoin,
    northSessionId: opts.sessionId,
    threadProvenance: opts.thread ? "exact" : "ad-hoc",
    turnProvenance: classifyTurnProvenance(resultMsg, terminal.processOutcome),
    promptComposition,
    promptCompositionVersion: promptComposition?.promptEconomics?.compositionVersion,
    promptCompositionDigest: promptComposition?.promptEconomics?.compositionDigest,
    capabilityClass: promptComposition?.promptEconomics?.capabilityClass,
    runLedger,
    effectiveAuthority: admittedRoute?.authority,
    tokenUsage,
    durationMs: Number(process.hrtime.bigint() - runStartedAt) / 1_000_000,
    providerDurationMs: typeof resultMsg?.duration_ms === "number" ? resultMsg.duration_ms : undefined,
    outcome, processOutcome: terminal.processOutcome,
    deliveryOutcome: terminal.deliveryOutcome, deliveryReason: terminal.deliveryReason,
    deliveryProof: terminal.deliveryProof,
    numTurns,
    compactions,
    judgmentGrade,
    struggleObservation: struggle.snapshot(),
    preflightCause,
    retryOfRun: retryContext?.retryOfRun,
    retryAttempt: retryContext?.retryAttempt,
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
  const struggleSnapshot = struggle.snapshot();
  // Include turns + result size on the completion line. The banner-only stdout
  // .log is the artifact operators skim; without a work signal here a lane that
  // ran dozens of turns reads as identical to a zero-turn no-op (the 2026-07-21
  // "instant-DOA" misdiagnosis, where 33-47-turn process=ran lanes were reported
  // as dead because their work lives in the .stream.jsonl transcript, not stdout).
  console.log(`[spawn] @agent:${agentId} complete (process=${outcome}, delivery=${terminal.deliveryOutcome}` +
    `, turns=${numTurns ?? "?"}, result=${result.length}b` +
    `${struggleSnapshot.triggers.length ? `, struggle: ${struggleSnapshot.triggers.join(",")}` : ""})`);
  return { result, outcome, runId };
}

// TRUE only in the import.meta.main adapter bootstrap below: that process runs
// under the CHILD's composed identity env (AGENT_TOPOLOGY=worker etc.), and the
// invoking adapter (bb agents-cli) already enforced the real caller's authority
// BEFORE composing it. Re-asserting here would read the child's topology as the
// caller's and deny every managed delegate (the 2026-07-17 self-deny bug).
let bootstrapAuthorityGranted = false;

export class RecursiveChildBindingError extends Error {
  readonly code = "NORTH_RECURSIVE_CHILD_BINDING_REQUIRED";
  readonly preSideEffect = true;

  constructor(message: string) {
    super(message);
    this.name = "RecursiveChildBindingError";
  }
}

function assertRecursiveChildBinding(
  composed: SpawnOptions,
  callerTopology: string | undefined,
  loadThreadFacts: typeof getThreadFacts,
): void {
  if (callerTopology !== "orchestrator") return;
  const parentThread = process.env.NORTH_THREAD_ID;
  const parentRun = process.env.NORTH_RUN_ID;
  const parentCapability = process.env.NORTH_RUN_CAPABILITY;
  if (!parentThread || !parentRun || !parentCapability || !composed.thread) {
    throw new RecursiveChildBindingError(
      "recursive SDK spawn requires an exact managed parent run and a fresh child thread",
    );
  }
  let child: string;
  let parent: string;
  try {
    child = normalizeNorthEntityId(composed.thread);
    parent = normalizeNorthEntityId(parentThread);
  } catch {
    throw new RecursiveChildBindingError(
      "recursive SDK spawn received an invalid parent or child thread id",
    );
  }
  if (child === parent) {
    throw new RecursiveChildBindingError(
      "recursive SDK spawn cannot reuse the parent thread as the child thread",
    );
  }
  let parents: string[];
  try {
    parents = loadThreadFacts(child)
      .filter((fact) => fact.predicate === "part_of")
      .map((fact) => normalizeNorthEntityId(fact.value));
  } catch {
    throw new RecursiveChildBindingError(
      "recursive SDK spawn could not verify the child thread parent link",
    );
  }
  if (parents.length !== 1 || parents[0] !== parent) {
    throw new RecursiveChildBindingError(
      "recursive SDK spawn requires exactly one child part_of link to its immediate parent thread",
    );
  }
}

export async function spawn(opts: SpawnOptions): Promise<string> {
  const injected = takeSpawnTestRuntime<SpawnRuntime>(opts) ?? {};
  const admitted = allowlistedSpawnOptions(opts);
  const callerTopology = process.env.AGENT_TOPOLOGY;
  if (!bootstrapAuthorityGranted) assertCoordinationAuthority("spawn", callerTopology);
  const composed = composeSpawnOptions(admitted);
  const caveman = resolveManagedCaveman(
    composed.caveman ?? (process.env.NORTH_CAVEMAN_SOURCE === "request"
      ? process.env.AGENT_CAVEMAN : undefined),
  );
  if (!bootstrapAuthorityGranted) {
    assertRecursiveChildBinding(
      composed, callerTopology, injected.loadThreadFacts ?? getThreadFacts,
    );
  }
  const requestedCapabilities = gafferCapabilities(composed.routingMetadata);
  const requestsMutation = requestedCapabilities.includes("filesystem.write")
    || requestedCapabilities.includes("shell");
  const requestsRegisteredWorkspace = composed.worktree
    ?? process.env.AGENT_WORKTREE === "1";
  if (requestsMutation && !requestsRegisteredWorkspace) {
    throw new Error(
      "managed mutation requires a registered worktree allocation; canonical checkout mutation denied",
    );
  }
  // Resolve the exact observer policy and immutable dispatcher grade before
  // clock/resource/provider side effects. Thread-backed spawns snapshot the
  // admission projection; raw ad-hoc work is explicitly unavailable.
  const strugglePolicy = resolveStrugglePolicy(composed.routingMetadata.topology!);
  assertExpectedStrugglePolicy(strugglePolicy);
  let judgmentGrade = adHocJudgmentGrade();
  if (composed.thread) {
    try {
      judgmentGrade = judgmentGradeFromThreadFacts(
        (injected.loadThreadFacts ?? getThreadFacts)(composed.thread),
      );
    } catch {
      judgmentGrade = judgmentGradeFromThreadFacts([]);
    }
  }
  const context = envelopeContextFromEnv();
  const requestedTier = composed.tier;
  const agentId = composed.agentId ?? createSpawnAgentId();
  // Pin the generated id so admission, telemetry, and the provider run name the
  // same lane. Admission completes before entitlement refresh or provider query.
  composed.agentId = agentId;
  composed.sessionId = composed.sessionId ?? context.sessionId;
  // Explicit isolation is an admission requirement, not a preference. Provision
  // before clocks, resource reservations, provider probes, stream/identity facts,
  // run reservations, or the provider query. A failure rejects this spawn and can
  // never silently execute in the shared checkout.
  let worktreeLease: ManagedWorktreeLease | undefined;
  if (composed.worktree ?? process.env.AGENT_WORKTREE === "1") {
    const repoRoot = process.cwd();
    const allocationRunId = newRunId(agentId);
    try {
      const provisioned = provisionWorktree(agentId, {
        repoRoot,
        setupCmd: composed.setupCmd ?? process.env.AGENT_SETUP_CMD,
        runId: allocationRunId,
        thread: composed.thread,
        concern: composed.concern ?? process.env.NORTH_CONCERN_ID,
        provider: composed.provider,
        target: composed.target,
        writer: injected.worktreeAllocationWriter,
      });
      worktreeLease = { ...provisioned, finalized: false };
      console.log(
        `[spawn] @agent:${agentId} worktree ${provisioned.path} on ${provisioned.branch}`,
      );
    } catch (error) {
      throw new Error(
        `[spawn] @agent:${agentId} explicit worktree provisioning failed; `
        + `spawn aborted before provider execution: ${(error as any)?.message ?? error}`,
        { cause: error },
      );
    }
  }
  const termination = new ManagedQueryTermination(injected?.registerTermination);
  let admission: EnvelopeAdmission | undefined;
  let result!: string;
  let failed = false;
  let primaryError: unknown;
  try {
    (injected?.admitBillableClock ?? admitBillableClock)({
      agentId,
      capabilities: gafferCapabilities(composed.routingMetadata),
      cwd: process.cwd(),
      threadId: composed.thread,
    });
    termination.throwIfTerminated();
    admission = await (injected?.admitResourceEnvelope ?? admitResourceEnvelope)({
      agentId, tier: requestedTier, project: composed.project ?? context.project,
      sessionId: composed.sessionId ?? context.sessionId,
    });
    termination.throwIfTerminated();
    for (const advisory of admission?.advisories ?? [])
      console.warn(`[envelope] advisory: ${advisory}`);
    // Each attempt gets its OWN shallow copy: runSpawn resolves opts.model/
    // opts.effort onto its argument in place, and a retry must re-resolve from
    // the original request, not inherit the prior attempt's pinned resolution.
    let attempt = await runSpawn(
      { ...composed }, judgmentGrade, strugglePolicy,
      caveman, admission, injected, termination, worktreeLease,
    );
    let retries = 0;
    // The lane whose identity is terminal-committed by the attempt that just
    // finished; a retry mints a FRESH agent id rather than reusing it. Terminal
    // identities are immutable by design (identity.ts writeAgentTerminal) — a
    // second publish against the same @agent: subject is durably rejected
    // (status=not_committed reason=terminal_committed), so reuse is not an
    // option here, only a fresh mint linked back by provenance.
    let deadAgentId = agentId;
    while (
      retries < PROVIDER_PROCESS_DEATH_MAX_RETRIES
      && eligibleForProviderProcessDeathRetry(
        attempt.outcome, composed.routingMetadata.topology, requestedCapabilities,
      )
    ) {
      retries++;
      const deadRunId = attempt.runId;
      const retryAgentId = createSpawnAgentId();
      console.error(
        `[spawn] @agent:${deadAgentId} provider-process death (run @${deadRunId}) is retry-safe `
        + `(worker + read-only capabilities) — retrying once as a fresh run on a fresh `
        + `@agent:${retryAgentId} (attempt ${retries})`,
      );
      termination.throwIfTerminated();
      attempt = await runSpawn(
        { ...composed, agentId: retryAgentId }, judgmentGrade, strugglePolicy,
        caveman, admission, injected, termination, worktreeLease,
        { retryOfRun: deadRunId, retryAttempt: retries, retryOfAgent: deadAgentId },
      );
      deadAgentId = retryAgentId;
    }
    result = attempt.result;
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  // Awaiting runSpawn proves every terminal/run publication attempt either
  // settled or was never reached. Keep the host barrier closed through every
  // outer cleanup that can otherwise be cut off by process.exit.
  termination.publicationSettled();
  const cleanupErrors: unknown[] = [];
  try { await (injected?.completeResourceEnvelope ?? completeResourceEnvelope)(admission); }
  catch (error) { cleanupErrors.push(error); }
  finally {
    termination.cleanupSettled();
    termination.release();
  }
  if (worktreeLease && !worktreeLease.finalized) {
    try { rollbackProvisionedWorktree(agentId, worktreeLease); }
    catch (error) { cleanupErrors.push(error); }
    finally { worktreeLease.finalized = true; }
  }
  const errors = failed ? [primaryError, ...cleanupErrors] : cleanupErrors;
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "spawn execution and outer cleanup failed");
  return result;
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
  bootstrapLegacyPinCompatibilityGranted = true;
  const prompt = process.argv.slice(2).join(" ");
  if (!prompt) {
    console.error("usage: bun run src/spawn.ts <prompt>");
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
    thread: delegateThread,
    coordinator: process.env.AGENT_COORDINATOR,
    routingMetadata: routingRequestFromEnv("managed North spawn bootstrap"),
    routingAssessment: process.env.AGENT_ROUTING_ASSESSMENT
      ? JSON.parse(process.env.AGENT_ROUTING_ASSESSMENT) : undefined,
    pinEvidence: process.env.NORTH_ROUTING_PIN_EVIDENCE
      ? JSON.parse(process.env.NORTH_ROUTING_PIN_EVIDENCE) : undefined,
  })
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
