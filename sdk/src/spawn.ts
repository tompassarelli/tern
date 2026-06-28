import { query } from "@anthropic-ai/claude-agent-sdk";
import { StreamWriter } from "./stream-writer";
import { harnessOptions, type Effort } from "./harness";
import { charge, tokensOf } from "./budget";

interface SpawnOptions {
  prompt: string;
  agentId?: string;
  model?: string;
  effort?: Effort;
  tools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
}

export async function spawn(opts: SpawnOptions): Promise<string> {
  const agentId =
    opts.agentId ?? `sdk-${Date.now().toString(36).slice(-8)}`;
  const stream = new StreamWriter(agentId);

  console.log(`[spawn] @agent:${agentId} starting`);

  let result = "";
  let resultMsg: any = null;

  for await (const message of query({
    prompt: opts.prompt,
    options: harnessOptions({
      self: agentId,
      extraTools: opts.tools ?? ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
      model: opts.model,
      effort: opts.effort,
      systemPrompt: opts.systemPrompt,
      maxTurns: opts.maxTurns,
    }),
  })) {
    const msg = message as any;
    stream.writeSDKMessage(msg);

    if ("result" in msg) {
      result = msg.result ?? "";
      resultMsg = msg;
    }
  }

  await charge(tokensOf(resultMsg)); // bill this run's tokens to the shared budget (atomic :bump)
  console.log(`[spawn] @agent:${agentId} complete`);
  return result;
}

// Spawn multiple agents in parallel — the core win over the bash fleet.
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
