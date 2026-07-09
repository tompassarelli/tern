import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve as pathResolve } from "node:path";
const REPO_ROOT = pathResolve(import.meta.dir, "..", "..");
import { StreamWriter } from "./stream-writer";
import { harnessOptions, type Effort } from "./harness";
import { tokensOf, costOf, remaining } from "./budget";
import { recordRun } from "./telemetry";
import { notifyDeath } from "./death";
import { inputChannel } from "./coordination";
import { writeAgentFacts, goalFromPrompt } from "./identity";
import { makeStruggleState, updateStruggle, checkStruggle, resetStruggle } from "./struggle";
import { LADDER, tierIndexOf, decideEscalation, escalateInFlight } from "./ladder";

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
  coordinator?: string; // spawning coordinator handle -> gets a direct peer ping on death
  queryFn?: typeof query; // injection seam for tests; defaults to the real SDK query()
  // Known limitation: on escalate path the system prompt is built once at the starting tier,
  // so a mid-flight model change does not swap the model-delta block.
}

export async function spawn(opts: SpawnOptions): Promise<string> {
  const agentId = opts.agentId ?? `lane-${Date.now().toString(36).slice(-8)}`;
  const stream = new StreamWriter(agentId);
  writeAgentFacts(agentId, {
    kind: "lane",
    role: opts.role ?? process.env.AGENT_ROLE,
    model: opts.model ?? process.env.AGENT_MODEL,
    effort: (opts.effort ?? process.env.AGENT_EFFORT) as string | undefined,
    repo: process.cwd().split("/").pop(),
    goal: goalFromPrompt(opts.prompt),
  });
  const escalate = opts.escalate ?? process.env.AGENT_ESCALATE === "1";
  const tierBudgetUsd = opts.budgetUsd ?? (Number(process.env.AGENT_BUDGET_USD) || Infinity);

  // escalate-not-kill (thread 019f1194-ca57): a struggling agent climbs the LADDER
  // in-flight (setModel on the live streaming-input query) instead of being killed at
  // a turn cap. Opt-in via opts.escalate / AGENT_ESCALATE; off => behaves as before.
  let tier = escalate ? tierIndexOf(opts.model, opts.effort) : -1; // -1 = fixed model (legacy)
  const rung = () => (tier >= 0 ? LADDER[tier] : { model: opts.model, effort: opts.effort });
  const st = makeStruggleState();
  const ch = inputChannel(opts.prompt); // streaming-input mode -> unlocks q.setModel()

  if (escalate && !Number.isFinite(await remaining())) {
    console.warn(`[spawn] @agent:${agentId} escalation ON but no budget_total — no spend floor; ` +
      `it stops only at the ladder ceiling. Set: tern tell @swarm budget_total <usd>`);
  }
  console.log(`[spawn] @agent:${agentId} starting${escalate ? ` (escalate @ tier ${tier} ${rung().model}/${rung().effort})` : ""}`);

  let result = "", resultMsg: any = null, outcome = "ran";
  let runCost = 0, tierStartCost = 0;
  const escalations: Array<{ from: string; to: string; reason: string; atCost: number }> = [];
  const end = (oc: string) => { outcome = oc; try { ch.end(); } catch { /* already closed */ } };

  const q = (opts.queryFn ?? query)({
    prompt: ch.stream(),
    options: harnessOptions({
      self: agentId,
      extraTools: opts.tools ?? ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
      model: rung().model, effort: rung().effort,
      systemPrompt: opts.systemPrompt, maxTurns: opts.maxTurns,
      role: opts.role, posture: opts.posture,
    }),
  });

  // Error boundary (thread 019f2800): the SDK runs the turn in a subprocess; if it dies
  // (OOM SIGKILL / parent SIGTERM / idle Transport-closed) readMessages() THROWS exitError
  // here. Without this try/catch the throw escaped -> recordRun skipped, no death signal,
  // channel leaked. Now: catch -> outcome "died" + notifyDeath (fact + peer ping); finally
  // -> ALWAYS end the channel + record the run; return the PARTIAL result (supervision, not
  // fail-fast) so one worker's death never rejects a spawnParallel Promise.all batch.
  try {
  for await (const message of q) {
    const msg = message as any;
    stream.writeSDKMessage(msg);
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
          await escalateInFlight(q, ch, LADDER[tier], trigger);
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
          await escalateInFlight(q, ch, LADDER[tier], "empty_result");
          escalations.push({ from, to: `${rung().model}/${rung().effort}`, reason: "empty_result", atCost: runCost });
          resetStruggle(st);
          tierStartCost = runCost;
          continue;
        }
      }
      if (ch.pending() === 0) { end("ran"); break; } // MUST end the channel or the query hangs
    }
  }
  } catch (err) {
    outcome = "died";
    notifyDeath(agentId, err, { thread: undefined, coordinator: opts.coordinator ?? process.env.AGENT_COORDINATOR });
  } finally {
    end(outcome); // idempotent: close the channel so the query + any leak unwinds
  }

  recordRun({
    thread: "(ad-hoc)", agent: agentId, posture: "spawn",
    tokens: tokensOf(resultMsg), durationMs: resultMsg?.duration_ms ?? 0, outcome,
    costUsd: resultMsg?.total_cost_usd ?? runCost, numTurns: resultMsg?.num_turns ?? 0,
    errorCount: st.totalErrors, escalationTier: tier,
    escalations: escalations.length ? escalations : undefined,
  });
  // completion ping mirrors the death ping: the coordinator's inbox hook surfaces it.
  const coord = opts.coordinator ?? process.env.AGENT_COORDINATOR;
  if (coord && outcome !== "died") {
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("bb", [`${REPO_ROOT}/cli/msg-cli.clj`, process.env.TERN_PORT ?? "7977",
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
  })
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
