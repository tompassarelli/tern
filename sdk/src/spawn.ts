import { resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
const REPO_ROOT = pathResolve(import.meta.dir, "..", "..");
import { StreamWriter } from "./stream-writer";
import {
  DEFAULT_SYSTEM_PROMPT, harnessCompositionEvidence, harnessOptions, renewHarnessPresence,
  type Effort, type HarnessCompositionEvidence,
} from "./harness";
import {
  provisionWorktree, rollbackProvisionedWorktree, worktreeFinalize, worktreePayload,
} from "./worktree";
import { normalizeUsage } from "./usage";
import { newRunId, recordRun } from "./telemetry";
import { deathReason, notifyDeath } from "./death";
import { inputChannel, subscribeFeed } from "./coordination";
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
  assessChildFinalization, childContinuationMessage, childReductionMessage,
  decideChildTurnEnd, initialChildContinuationState, notifyEarlyExitChildren,
  settleChildren, type ChildSettlement,
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
import {
  assertCoordinationAuthority, assertManagedChildTopology,
} from "./topology-authority";
import { admitPinnedProvider } from "./execution-admission";
import { classifyExecutionTerminal } from "./execution-outcome";
import { ManagedLiveInputRoute } from "./live-input-route";
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
  caveman?: "off" | "lite" | "full"; // per-spawn terse-output dial; overrides ambient AGENT_CAVEMAN
  coordinator?: string; // spawning coordinator handle -> gets a direct peer ping on death
  provider?: ProviderPreference;
  target?: string;
  tier?: SemanticTier;
  routingMetadata: RoutingRequest;
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
}

const SPAWN_OPTION_FIELDS = new Set([
  "prompt", "agentId", "model", "effort", "tools", "systemPrompt", "maxTurns",
  "role", "posture", "thread", "caveman", "coordinator", "provider",
  "target", "tier", "routingMetadata", "project", "sessionId", "worktree", "setupCmd",
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

interface ManagedWorktreeLease {
  path: string;
  branch: string;
  repoRoot: string;
  finalized: boolean;
}

function composeSpawnOptions(opts: SpawnOptions): SpawnOptions & { routingMetadata: RoutingRequest } {
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
  return {
    ...opts,
    routingMetadata,
    role: routingMetadata.role,
    tier: routingMetadata.tier,
    effort: routingMetadata.reasoning as Effort | undefined,
    posture: routingMetadata.posture,
  };
}

async function runSpawn(
  opts: SpawnOptions & { routingMetadata: RoutingRequest },
  judgmentGrade: JudgmentGradeSnapshot,
  strugglePolicy: StrugglePolicy,
  envelopeAdmission?: EnvelopeAdmission,
  injected: SpawnRuntime = {},
  termination: ManagedQueryTermination = new ManagedQueryTermination(),
  worktreeLease?: ManagedWorktreeLease,
): Promise<string> {
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
  const resolved = resolveTier(routing.provider, requestedTier, opts.model, opts.effort);
  opts.model = resolved.model;
  opts.effort = resolved.effort;
  // The hydrated Gaffer selection is canonical. Never let an inherited parent
  // env relabel this child as an alias or a different role.
  const identityRole = routingMetadata.role!;
  const composition = routingMetadata.composition!;
  const repoRoot = worktreeLease?.repoRoot ?? process.cwd();
  const wt = worktreeLease;
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
  writeAgentFacts(agentId, {
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
  ));
  let queryCloseError: unknown;

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
  let childContinuation = initialChildContinuationState();
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
    // per-spawn dial wins over ambient env; env-or-full is the harness fallback
    caveman: opts.caveman ?? process.env.AGENT_CAVEMAN ?? "full",
  });
  if (injected.queryFn) injectedCompositionEvidence = harnessCompositionEvidence(agentOptions);
  if (injected.queryFn && injected.feedSubscriber)
    await liveInputRoute.activate(activeRoute());
  termination.throwIfTerminated();
  const activeQuery = queryFn({
    prompt: ch.stream(),
    options: agentOptions,
  });
  termination.attachQuery(activeQuery);
  const watched = withStallWatchdog((activeQuery as AsyncIterable<any>)[Symbol.asyncIterator](), {
    stallMs: window,
    onStall: (mins) => notifyStall(agentId, mins, { coordinator: coordHandle }),
    onAbort: () => { stallAborted = true; },
  });
  for await (const message of watched) {
    const msg = message as any;
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
            readChildSettlement(agentId),
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
            const blockedOutcome = decision.reason === "child_reconciliation_unavailable"
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
  // teardown of the terminal live-feed drain afterward is best-effort cleanup,
  // not part of the provider turn, and must not retroactively convert a
  // completed lane into process=died — that would erase real evidence/outcome
  // the lane already recorded. A drain failure that happens BEFORE a success
  // terminal (no result yet) is a genuine feed/provider failure and stays
  // fail-closed via the branches below, unchanged.
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
    try {
      await liveInputRoute.freezeAndUnbind();
      liveInputFreezeError = undefined;
    } catch {
      const error = liveInputFreezeError instanceof Error
        ? liveInputFreezeError
        : new Error("managed live-input route could not be frozen");
      if (reachedProviderSuccessTerminal) {
        // Completed provider turn: the feed leak is real (best-effort, logged
        // for operator follow-up) but it is cleanup after success — process/
        // delivery already earned by the completed turn stays as recorded.
        // No AGENT DEATH fact/ping: that channel means "the provider died",
        // which did not happen here and must not be asserted.
        console.error(
          `[live-input] @agent:${agentId} terminal live-feed drain failed after a completed provider turn — process/delivery preserved (${error.message})`,
        );
      } else {
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
  }

  // Salvage-gated worktree cleanup (only if this spawn provisioned one): remove
  // on a clean ran, KEEP + surface a worktree_orphaned fact on any
  // crash/cap/dirty tail. Fail-open.
  if (wt) {
    worktreeFinalize(agentId, outcome, { path: wt.path, branch: wt.branch, repoRoot });
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
      try {
        runState = deliveryRuntime.load(runId);
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

  const tokenUsage = normalizeUsage(terminalMessages, routing.provider);
  const finalRoute = activeRoute();
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
    promptComposition: admittedRoute?.evidence ?? injectedCompositionEvidence,
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
  }, runId, publicationBudget.publicationTimeout(1));
  for (const [index, writeAuxiliary] of terminalAuxiliaryWrites.entries()) {
    writeAuxiliary(
      publicationBudget.publicationTimeout(
        terminalAuxiliaryWrites.length - index,
      ),
    );
  }
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
  return result;
}

// TRUE only in the import.meta.main adapter bootstrap below: that process runs
// under the CHILD's composed identity env (AGENT_TOPOLOGY=worker etc.), and the
// invoking adapter (bb agents-cli) already enforced the real caller's authority
// BEFORE composing it. Re-asserting here would read the child's topology as the
// caller's and deny every managed delegate (the 2026-07-17 self-deny bug).
let bootstrapAuthorityGranted = false;

export async function spawn(opts: SpawnOptions): Promise<string> {
  const injected = takeSpawnTestRuntime<SpawnRuntime>(opts) ?? {};
  const admitted = allowlistedSpawnOptions(opts);
  const callerTopology = process.env.AGENT_TOPOLOGY;
  if (!bootstrapAuthorityGranted) assertCoordinationAuthority("spawn", callerTopology);
  const composed = composeSpawnOptions(admitted);
  if (!bootstrapAuthorityGranted) {
    assertManagedChildTopology(
      "spawn", composed.routingMetadata.topology, callerTopology,
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
  // Explicit isolation is an admission requirement, not a preference. Provision
  // before clocks, resource reservations, provider probes, stream/identity facts,
  // run reservations, or the provider query. A failure rejects this spawn and can
  // never silently execute in the shared checkout.
  let worktreeLease: ManagedWorktreeLease | undefined;
  if (composed.worktree ?? process.env.AGENT_WORKTREE === "1") {
    const repoRoot = process.cwd();
    try {
      const provisioned = provisionWorktree(agentId, {
        repoRoot,
        setupCmd: composed.setupCmd ?? process.env.AGENT_SETUP_CMD,
      });
      worktreeLease = { ...provisioned, repoRoot, finalized: false };
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
    result = await runSpawn(
      composed, judgmentGrade, strugglePolicy,
      admission, injected, termination, worktreeLease,
    );
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
    rollbackProvisionedWorktree(agentId, worktreeLease);
    worktreeLease.finalized = true;
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
  })
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
