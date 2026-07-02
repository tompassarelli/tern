import { query } from "@anthropic-ai/claude-agent-sdk";
import { StreamWriter } from "./stream-writer";
import { harnessOptions, type Effort } from "./harness";
import { tokensOf, costOf, remaining } from "./budget";
import { recordRun } from "./telemetry";
import { inputChannel } from "./coordination";
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
}

export async function spawn(opts: SpawnOptions): Promise<string> {
  const agentId = opts.agentId ?? `sdk-${Date.now().toString(36).slice(-8)}`;
  const stream = new StreamWriter(agentId);
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

  const q = query({
    prompt: ch.stream(),
    options: harnessOptions({
      self: agentId,
      extraTools: opts.tools ?? ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
      model: rung().model, effort: rung().effort,
      systemPrompt: opts.systemPrompt, maxTurns: opts.maxTurns,
    }),
  });

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

  recordRun({
    thread: "(ad-hoc)", agent: agentId, posture: "spawn",
    tokens: tokensOf(resultMsg), durationMs: resultMsg?.duration_ms ?? 0, outcome,
    costUsd: resultMsg?.total_cost_usd ?? runCost, numTurns: resultMsg?.num_turns ?? 0,
    errorCount: st.totalErrors, escalationTier: tier,
    escalations: escalations.length ? escalations : undefined,
  });
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
