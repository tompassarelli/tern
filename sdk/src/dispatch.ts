import { getThreadFacts, getChildren } from "./north-client";
import { derivePosture, buildPrompt } from "./posture";
import { StreamWriter } from "./stream-writer";
import { harnessOptions, DEFAULT_SYSTEM_PROMPT, type Effort } from "./harness";
import { inputChannel, subscribeFeed } from "./coordination";
import { tokensOf } from "./budget";
import { recordRun } from "./telemetry";
import { notifyDeath } from "./death";
import { withStallWatchdog, stallMs, notifyStall, notifyTurnCap } from "./watchdog";
import { makeBgTracker, bgContinuationMessage, maxBgContinuations } from "./bgtasks";
import { liveChildren, notifyEarlyExitChildren } from "./children";
import { clockStart, clockFinalize } from "./clock";
import { routedQuery, selectProvider, type ProviderPreference } from "./providers";
import { resolveTier, type SemanticTier } from "./providers/catalog";
import { canonicalRole, routingMetadataFromEnv } from "./routing-metadata";

const PLAN_TOOLS = ["Read", "Grep", "Glob", "Bash"];
const EXEC_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];
const SURVEY_TOOLS = ["Read", "Grep", "Glob"];

interface DispatchResult {
  threadId: string;
  posture: "unplanned" | "atomic" | "composite";
  result: string;
}

export async function dispatch(threadId: string): Promise<DispatchResult> {
  const routingMetadata = routingMetadataFromEnv();
  const role = canonicalRole(process.env.AGENT_ROLE);
  const facts = getThreadFacts(threadId);
  if (!facts.length) {
    throw new Error(`Thread @${threadId} not found or has no facts`);
  }

  const children = getChildren(threadId);
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

  const agentId =
    process.env.AGENT_ID ??
    `sdk-${threadId.replace(/[^a-z0-9]/gi, "").slice(-12)}`;
  const stream = new StreamWriter(agentId);
  const requestedTier = process.env.AGENT_TIER as SemanticTier | undefined;
  const routing = selectProvider(process.env.AGENT_PROVIDER as ProviderPreference | undefined, undefined,
    { tier: requestedTier, stableKey: agentId });
  const resolved = resolveTier(routing.provider, requestedTier,
    process.env.AGENT_MODEL, process.env.AGENT_EFFORT as Effort | undefined);

  console.log(`[dispatch] @${threadId} — ${posture.title}`);
  console.log(`[dispatch] posture: ${postureLabel}, provider: ${routing.provider} (${routing.reason}), tools: ${tools.join(",")}`);

  // Auto-clock (per-agent): open a session on this thread as THIS worker, so its
  // billable time attributes to the thread it actually worked — not one global
  // clock. Closed on exit below (clean stop / orphan-close on crash).
  clockStart(agentId, threadId);

  let result = "";
  let resultMsg: any = null;
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

  // Error boundary (thread 019f2800): the SDK runs the turn in a subprocess; if it dies
  // (OOM SIGKILL / parent SIGTERM / idle Transport-closed) the generator THROWS exitError
  // here. catch -> outcome "died" + notifyDeath (agent_death fact on this thread + @swarm,
  // peer ping to the coordinator); finally -> ALWAYS stop the feed, close the channel, and
  // record the run so the coordinator learns of the death instead of noticing silence.
  try {
    const q = routedQuery(routing, {
      prompt: ch.stream(),
      options: harnessOptions({
        self: agentId,
        extraTools: tools,
        model: resolved.model,
        effort: resolved.effort,
        systemPrompt: `You are a north worker agent executing thread @${threadId}. ${DEFAULT_SYSTEM_PROMPT}`,
      }),
    }, requestedTier);
    const watched = withStallWatchdog((q as AsyncIterable<any>)[Symbol.asyncIterator](), {
      stallMs: window,
      onStall: (mins) => notifyStall(agentId, mins, { coordinator: coordHandle }),
      onAbort: () => { stallAborted = true; },
    });
    for await (const message of watched) {
      const msg = message as any;
      stream.writeSDKMessage(msg);
      if (bgTracker.observe(msg) === "settled") bgContinuations = 0; // forward progress refreshes the cap

      if ("result" in msg) {
        result = msg.result;
        resultMsg = msg;
        if (ch.pending() === 0) {
          // Turn-cap ping (thread 019f4d54): a maxTurns/max-budget terminal arrives as a
          // `result` with an error_max_* subtype; recording it as a clean finish hides the
          // cap. Mark the outcome and ping the coordinator with a partial-result note.
          const cap = typeof msg.subtype === "string" && msg.subtype.startsWith("error_max") ? msg.subtype : null;
          if (cap) {
            outcome = cap === "error_max_turns" ? "max_turns" : "capped";
            const partial = (result ?? "").trim() ? `partial: ${(result ?? "").trim().slice(0, 200)}` : "no partial result";
            notifyTurnCap(agentId, `${cap} — ${partial}`, { coordinator: coordHandle });
            break;
          }
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
    if (stallAborted) {
      // 2N of silence: interrupt the hung query, mark outcome=stalled, and fire the death
      // path so a stall is terminal + visible instead of a silent hang.
      outcome = "stalled";
      try { await (q as any).interrupt?.(); } catch {}
      notifyDeath(agentId, new Error(`stalled — no SDK output for ${Math.max(2, 2 * Math.round(window / 60_000))}min`),
        { thread: threadId, coordinator: coordHandle });
    }
  } catch (err) {
    outcome = "died";
    notifyDeath(agentId, err, { thread: threadId, coordinator: process.env.AGENT_COORDINATOR });
  } finally {
    stopFeed();
    try { ch.end(); } catch { /* already closed */ }
  }

  // Early exit with live children (thread 019f4ed2, half b): flag orphaned spawned
  // agents loudly at finalize instead of waiting for the reactor's 30min sweep.
  try {
    const orphans = liveChildren(agentId);
    if (orphans.length) notifyEarlyExitChildren(agentId, orphans, { coordinator: coordHandle });
  } catch { /* never block finalize */ }

  // Close the auto-clock: a crash (died/stalled) orphan-closes (end_time + flag);
  // any other terminal (clean, turn-cap, budget) stops the session normally.
  clockFinalize(agentId, outcome);

  // Spend is no longer charged to a counter here; it is summed from the @run
  // cost_usd fact this run records below (remaining() folds Σ over @run costs).
  recordRun({ thread: threadId, agent: agentId, tokens: tokensOf(resultMsg),
              model: resolved.model, effort: resolved.effort,
              role,
              provider: routing.provider, providerReason: routing.reason,
              requestedProvider: process.env.AGENT_PROVIDER,
              requestedTier: process.env.AGENT_TIER,
              requestedModel: process.env.AGENT_MODEL,
              requestedEffort: process.env.AGENT_EFFORT,
              allocationMode: routing.allocationMode,
              entitlementPressure: routing.entitlementPressure,
              fallbackCount: routing.fallbackCount,
              fallbackPath: routing.fallbackPath,
              routingMetadata,
              durationMs: resultMsg?.duration_ms ?? 0, posture: postureLabel, outcome });
  console.log(`\n[dispatch] @${threadId} ${outcome === "died" ? "DIED" : "complete"}`);
  return { threadId, posture: postureLabel, result };
}

export async function dispatchParallel(
  threadIds: string[]
): Promise<DispatchResult[]> {
  return Promise.all(threadIds.map((id) => dispatch(id)));
}

if (import.meta.main) {
  const threadId = process.argv[2];
  if (!threadId) {
    console.error("usage: bun run src/dispatch.ts <thread-id>");
    process.exit(1);
  }

  dispatch(threadId)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
