import { query } from "@anthropic-ai/claude-agent-sdk";
import { StreamWriter } from "./stream-writer";

// spawn.ts — SDK replacement for ~/code/fleet-data/spawn-agent.sh + lodestar-agent.sh
// Instead of: bash → bb presence-cli → bb lodestar-listen → claude -p → .stream.jsonl
// Now:        bun spawn.ts → query() → .stream.jsonl
//
// The lodestar daemons (:7977/:7978) are untouched — this replaces only the agent
// process, not the coordination layer.

interface SpawnOptions {
  prompt: string;
  agentId?: string;
  model?: string;
  effort?: string;
  tools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
}

export async function spawn(opts: SpawnOptions): Promise<string> {
  const agentId =
    opts.agentId ?? `sdk-${Date.now().toString(36).slice(-8)}`;
  const stream = new StreamWriter(agentId);

  console.log(`[spawn] @agent:${agentId} starting`);

  const modelMap: Record<string, string> = {
    opus: "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5-20251001",
  };

  let result = "";

  for await (const message of query({
    prompt: opts.prompt,
    options: {
      allowedTools: opts.tools ?? [
        "Read",
        "Edit",
        "Write",
        "Bash",
        "Grep",
        "Glob",
      ],
      permissionMode: "acceptEdits",
      model: opts.model ? modelMap[opts.model] ?? opts.model : undefined,
      systemPrompt:
        opts.systemPrompt ??
        "You are a lodestar worker agent. Execute your task directly and report results concisely.",
      maxTurns: opts.maxTurns ?? 50,
    },
  })) {
    const msg = message as any;
    stream.writeSDKMessage(msg);

    if ("result" in msg) {
      result = msg.result ?? "";
    }
  }

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
    model: process.env.AGENT_MODEL,
    effort: process.env.AGENT_EFFORT,
  })
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
