import { resolve as pathResolve } from "node:path";
const REPO_ROOT = pathResolve(import.meta.dir, "..", "..");
import { StreamWriter } from "./stream-writer";
import { harnessOptions, type Effort } from "./harness";
import { tokensOf, costOf, remaining } from "./budget";
import { recordRun } from "./telemetry";
import { notifyDeath } from "./death";
import { inputChannel } from "./coordination";
import { writeAgentFacts, writeAgentOutcome, goalFromPrompt } from "./identity";
import { makeStruggleState, updateStruggle, checkStruggle, resetStruggle } from "./struggle";
import { activeLadder, tierIndexOf, decideEscalation, escalateInFlight } from "./ladder";
import { withStallWatchdog, stallMs, notifyStall, notifyTurnCap } from "./watchdog";
import { makeBgTracker, bgContinuationMessage, maxBgContinuations } from "./bgtasks";
import { liveChildren, notifyEarlyExitChildren } from "./children";
import { clockStart, clockFinalize } from "./clock";
import {
  refreshCodexEntitlementIfStale, routedQuery, selectProvider, shouldRefreshCodexEntitlement,
  type ProviderPreference,
} from "./providers";
import type { AgentQuery } from "./providers/types";
import { resolveTier, type SemanticTier } from "./providers/catalog";
import { canonicalRole, routingMetadataFromEnv, validateRoutingMetadata, type RoutingMetadata } from "./routing-metadata";

interface SpawnOptions {
  prompt: string;
  agentId?: string;
  model?: string;
  effort?: Effort;
  tools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
  budgetUsd?: number; // per-run (or per-tier when escalating) USD spend cap (thread 019f1194-ca57)
  escalate?: boolean; // escalate-not-kill: climb the ladder on struggle instead of stopping
  role?: string;
  posture?: string;
  thread?: string; // billable thread — when set, auto-clock this spawn like dispatch (bare id); ad-hoc spawns (no thread) never clock
  caveman?: "off" | "lite" | "full"; // per-spawn terse-output dial; overrides ambient AGENT_CAVEMAN
  coordinator?: string; // spawning coordinator handle -> gets a direct peer ping on death
  provider?: ProviderPreference;
  tier?: SemanticTier;
  routingMetadata?: RoutingMetadata;
  queryFn?: (args: any) => AgentQuery; // injection seam for tests; bypasses provider selection
  // Known limitation: on escalate path the system prompt is built once at the starting tier,
  // so a mid-flight model change does not swap the model-delta block.
}

export async function spawn(opts: SpawnOptions): Promise<string> {
  const requested = { provider: opts.provider ?? process.env.AGENT_PROVIDER, tier: opts.tier ?? process.env.AGENT_TIER,
    model: opts.model ?? process.env.AGENT_MODEL, effort: opts.effort ?? process.env.AGENT_EFFORT };
  const routingMetadata = opts.routingMetadata ? validateRoutingMetadata(opts.routingMetadata) : routingMetadataFromEnv();
  opts.role = canonicalRole(opts.role ?? process.env.AGENT_ROLE);
  const agentId = opts.agentId ?? `lane-${Date.now().toString(36).slice(-8)}`;
  const stream = new StreamWriter(agentId);
  const requestedTier = opts.tier ?? process.env.AGENT_TIER as SemanticTier | undefined;
  const providerPreference = opts.provider ?? process.env.AGENT_PROVIDER as ProviderPreference | undefined ?? "auto";
  // Injected query functions own their entire provider boundary; keeping the
  // refresh out of that path makes tests and alternative adapters hermetic.
  if (!opts.queryFn && shouldRefreshCodexEntitlement(providerPreference)) await refreshCodexEntitlementIfStale();
  const routing = selectProvider(providerPreference, undefined, { tier: requestedTier, stableKey: agentId });
  const resolved = resolveTier(routing.provider, requestedTier, opts.model, opts.effort);
  opts.model = resolved.model;
  opts.effort = resolved.effort;
  writeAgentFacts(agentId, {
    kind: "lane",
    role: opts.role,
    model: opts.model ?? process.env.AGENT_MODEL,
    effort: (opts.effort ?? process.env.AGENT_EFFORT) as string | undefined,
    repo: process.cwd().split("/").pop(),
    goal: goalFromPrompt(opts.prompt),
    coordinator: opts.coordinator ?? process.env.AGENT_COORDINATOR,
  });
  const escalate = opts.escalate ?? process.env.AGENT_ESCALATE === "1";
  const tierBudgetUsd = opts.budgetUsd ?? (Number(process.env.AGENT_BUDGET_USD) || Infinity);

  // escalate-not-kill (thread 019f1194-ca57): a struggling agent climbs the LADDER
  // in-flight (setModel on the live streaming-input query) instead of being killed at
  // a turn cap. Opt-in via opts.escalate / AGENT_ESCALATE; off => behaves as before.
  // Snapshot the active ladder once per run (includes the Fable rung iff the window is
  // open); tier indices below resolve against THIS array, matching decideEscalation.
  const ladder = activeLadder();
  let tier = escalate ? tierIndexOf(opts.model, opts.effort) : -1; // -1 = fixed model (legacy)
  const rung = () => (tier >= 0 ? ladder[tier] : { model: opts.model, effort: opts.effort });
  const st = makeStruggleState();
  const ch = inputChannel(opts.prompt); // streaming-input mode -> unlocks q.setModel()

  if (escalate && !Number.isFinite(await remaining())) {
    console.warn(`[spawn] @agent:${agentId} escalation ON but no budget_total — no spend floor; ` +
      `it stops only at the ladder ceiling. Set: north tell @swarm budget_total <usd>`);
  }
  console.log(`[spawn] @agent:${agentId} starting provider=${routing.provider}${resolved.tier ? ` tier=${resolved.tier}` : ""} (${routing.reason})${escalate ? ` (escalate @ tier ${tier} ${rung().model}/${rung().effort})` : ""}`);

  // Auto-clock only when this spawn carries a billable thread — ad-hoc spawns
  // aren't billable by default. Same per-agent treatment as dispatch.
  if (opts.thread) clockStart(agentId, opts.thread);

  let result = "", resultMsg: any = null, outcome = "ran";
  let runCost = 0, tierStartCost = 0;
  const escalations: Array<{ from: string; to: string; reason: string; atCost: number }> = [];
  const end = (oc: string) => { outcome = oc; try { ch.end(); } catch { /* already closed */ } };

  const queryFn = opts.queryFn ?? ((args: any) => routedQuery(routing, args, requestedTier));
  const q = queryFn({
    prompt: ch.stream(),
    options: harnessOptions({
      self: agentId,
      extraTools: opts.tools ?? ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
      model: rung().model, effort: rung().effort,
      systemPrompt: opts.systemPrompt, maxTurns: opts.maxTurns,
      role: opts.role, posture: opts.posture,
      // per-spawn dial wins over ambient env; env-or-full is the harness fallback
      caveman: opts.caveman ?? process.env.AGENT_CAVEMAN ?? "full",
    }),
  });

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
  const coordHandle = opts.coordinator ?? process.env.AGENT_COORDINATOR;
  const window = stallMs();
  let stallAborted = false;
  // Background-task refusal (thread 019f4ed2): a lane that ends its turn while a
  // harness-tracked background Bash task is live must NOT finalize — the SDK
  // auto-continues the model on task settlement, but only if we keep the loop alive
  // instead of breaking on the first `result`. Track the live set; bgContinuations
  // counts CONSECUTIVE no-progress refusals (reset on settlement) for the stuck-lane cap.
  const bgTracker = makeBgTracker();
  let bgContinuations = 0;
  const watched = withStallWatchdog((q as AsyncIterable<any>)[Symbol.asyncIterator](), {
    stallMs: window,
    onStall: (mins) => notifyStall(agentId, mins, { coordinator: coordHandle }),
    onAbort: () => { stallAborted = true; },
  });

  try {
  for await (const message of watched) {
    const msg = message as any;
    stream.writeSDKMessage(msg);
    if (bgTracker.observe(msg) === "settled") bgContinuations = 0; // forward progress refreshes the cap
    runCost += costOf(rung().model, msg.message?.usage ?? msg.usage); // price at the CURRENT tier

    if (escalate) {
      updateStruggle(msg, st);
      let trigger: string | null = checkStruggle(st);
      if (!trigger && runCost - tierStartCost >= tierBudgetUsd) trigger = "budget_exceeded";
      if (trigger) {
        const d = await decideEscalation(tier);
        if (d.kind === "escalate") {
          const from = `${rung().model}/${rung().effort}`;
          tier = d.toTier;
          if (!q.setModel) { end("provider_escalation_unsupported"); break; }
          await escalateInFlight(q as any, ch, ladder[tier], trigger);
          escalations.push({ from, to: `${rung().model}/${rung().effort}`, reason: trigger, atCost: runCost });
          resetStruggle(st);
          tierStartCost = runCost;
          continue; // same loop, smarter tier
        }
        end(d.kind); // budget_exhausted | struggle_ceiling
        try { await (q as any).interrupt?.(); } catch {}
        break;
      }
    } else if (runCost >= tierBudgetUsd) { // legacy fixed-model spend cap (df473b8)
      end("budget_exceeded");
      console.log(`[spawn] @agent:${agentId} hit budget $${tierBudgetUsd} (est $${runCost.toFixed(3)}) — stopping`);
      try { await (q as any).interrupt?.(); } catch {}
      break;
    }

    if ("result" in msg) {
      result = msg.result ?? "";
      resultMsg = msg;
      if (escalate && !result.trim()) { // terminal empty result -> escalate rather than give up
        const d = await decideEscalation(tier);
        if (d.kind === "escalate") {
          const from = `${rung().model}/${rung().effort}`;
          tier = d.toTier;
          if (!q.setModel) { end("provider_escalation_unsupported"); break; }
          await escalateInFlight(q as any, ch, ladder[tier], "empty_result");
          escalations.push({ from, to: `${rung().model}/${rung().effort}`, reason: "empty_result", atCost: runCost });
          resetStruggle(st);
          tierStartCost = runCost;
          continue;
        }
      }
      if (ch.pending() === 0) {
        // Turn-cap ping (thread 019f4d54): a maxTurns / max-budget terminal arrives as a
        // `result` with an error_max_* subtype. Ignoring it records outcome="ran" — a cap
        // masquerades as success. Detect it, mark the outcome, and ping the coordinator
        // with a partial-result note instead of stopping silently.
        const cap = typeof msg.subtype === "string" && msg.subtype.startsWith("error_max") ? msg.subtype : null;
        if (cap) {
          end(cap === "error_max_turns" ? "max_turns" : "capped");
          const partial = result.trim() ? `partial: ${result.trim().slice(0, 200)}` : "no partial result";
          notifyTurnCap(agentId, `${cap} — ${partial}`, { coordinator: coordHandle });
          break;
        }
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
        end("ran");
        break; // MUST end the channel or the query hangs
      }
    }
  }
  if (stallAborted) {
    // 2N of silence: make the stall TERMINAL + VISIBLE. Interrupt the hung query, record
    // outcome=stalled, and fire the death path (agent_death fact + coordinator ping) so a
    // stall is never a silent hang again.
    outcome = "stalled";
    try { await (q as any).interrupt?.(); } catch {}
    notifyDeath(agentId, new Error(`stalled — no SDK output for ${Math.max(2, 2 * Math.round(window / 60_000))}min`),
      { thread: undefined, coordinator: coordHandle });
  }
  } catch (err) {
    outcome = "died";
    notifyDeath(agentId, err, { thread: undefined, coordinator: opts.coordinator ?? process.env.AGENT_COORDINATOR });
  } finally {
    end(outcome); // idempotent: close the channel so the query + any leak unwinds
  }

  // Early exit with live children (thread 019f4ed2, half b): on TRUE finalize (any
  // terminal path), if this lane spawned agents that have not yet reported an outcome,
  // make the orphaning loud NOW instead of waiting up to 30min for the reactor's sweep —
  // a loud lane-log line + coordinator ping + a durable early_exit_children fact.
  // Fail-open: a graph hiccup here must never break the finalize.
  try {
    const orphans = liveChildren(agentId);
    if (orphans.length) notifyEarlyExitChildren(agentId, orphans, { coordinator: coordHandle });
  } catch { /* never block finalize */ }

  // Close the auto-clock (only if this spawn opened one): crash -> orphan-close, else stop.
  if (opts.thread) clockFinalize(agentId, outcome);

  // Record the terminal outcome ON the lane entity (SYNC, before exit) so the reactor's
  // presence-lapse sweep never reaps a completed lane as died-unreported. `outcome` is
  // final here (all terminal paths — ran/died/stalled/capped/budget — have settled it).
  writeAgentOutcome(agentId, outcome);

  recordRun({
    thread: "(ad-hoc)", agent: agentId, posture: "spawn",
    // Effective FINAL dial (rung() reflects any in-flight escalation); env-fallback
    // mirrors the identity write so a bare AGENT_MODEL spawn is still attributed.
    model: rung().model ?? opts.model ?? process.env.AGENT_MODEL,
    effort: rung().effort ?? opts.effort ?? process.env.AGENT_EFFORT,
    role: opts.role,
    provider: routing.provider, providerReason: routing.reason,
    requestedProvider: requested.provider, requestedTier: requested.tier,
    requestedModel: requested.model, requestedEffort: requested.effort,
    allocationMode: routing.allocationMode, entitlementPressure: routing.entitlementPressure,
    fallbackCount: routing.fallbackCount, fallbackPath: routing.fallbackPath,
    routingMetadata,
    tokens: tokensOf(resultMsg), durationMs: resultMsg?.duration_ms ?? 0, outcome,
    costUsd: resultMsg?.total_cost_usd ?? runCost, numTurns: resultMsg?.num_turns ?? 0,
    errorCount: st.totalErrors, escalationTier: tier,
    escalations: escalations.length ? escalations : undefined,
  });
  // completion ping mirrors the death ping: the coordinator's inbox hook surfaces it.
  // Suppress it for outcomes that already fired a dedicated ping (died -> AGENT DEATH,
  // stalled -> AGENT DEATH via notifyDeath, max_turns/capped -> TURN CAP) — one terminal
  // event, one ping, no contradictory "COMPLETE outcome=stalled" noise.
  const coord = opts.coordinator ?? process.env.AGENT_COORDINATOR;
  const alreadySignaled = new Set(["died", "stalled", "max_turns", "capped"]);
  if (coord && !alreadySignaled.has(outcome)) {
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("bb", [`${REPO_ROOT}/cli/msg-cli.clj`, process.env.NORTH_PORT ?? "7977",
        "send", agentId, coord, "AGENT COMPLETE", `outcome=${outcome}`], { stdio: "ignore", timeout: 10000 });
    } catch { /* non-fatal */ }
  }
  console.log(`[spawn] @agent:${agentId} complete (${outcome}` +
    `${escalations.length ? `, ${escalations.length} escalation(s) -> ${rung().model}/${rung().effort}` : ""})`);
  return result;
}

// Spawn multiple agents in parallel — the core win over the bash swarm.
export async function spawnParallel(
  tasks: SpawnOptions[]
): Promise<string[]> {
  return Promise.all(tasks.map((t) => spawn(t)));
}

if (import.meta.main) {
  const prompt = process.argv.slice(2).join(" ");
  if (!prompt) {
    console.error("usage: bun run src/spawn.ts <prompt>");
    process.exit(1);
  }

  spawn({
    prompt,
    agentId: process.env.AGENT_ID,
    model: process.env.AGENT_MODEL,
    effort: process.env.AGENT_EFFORT as Effort | undefined,
    provider: process.env.AGENT_PROVIDER as ProviderPreference | undefined,
    tier: process.env.AGENT_TIER as SemanticTier | undefined,
    routingMetadata: routingMetadataFromEnv(),
  })
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
