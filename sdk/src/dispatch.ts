import { query } from "@anthropic-ai/claude-agent-sdk";
import { getThreadClaims } from "./lodestar-client";
import { derivePosture, buildPrompt } from "./posture";

const LODESTAR_PORT = 7977;

const PLAN_TOOLS = ["Read", "Grep", "Glob", "Bash"];
const EXEC_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];
const SURVEY_TOOLS = ["Read", "Grep", "Glob"];

interface DispatchResult {
  threadId: string;
  posture: "unplanned" | "atomic" | "composite";
  result: string;
}

export async function dispatch(threadId: string): Promise<DispatchResult> {
  const claims = await getThreadClaims(LODESTAR_PORT, threadId);
  if (!claims.length) {
    throw new Error(`Thread @${threadId} not found or has no claims`);
  }

  // Derive posture from claims. hasChildren=false until we wire the query protocol.
  const hasChildren = false;
  const posture = derivePosture(claims, hasChildren);

  if (posture.hasOutcome) {
    return { threadId, posture: "atomic", result: "already done" };
  }

  const prompt = buildPrompt(threadId, posture, claims);
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

  console.log(`[dispatch] @${threadId} — ${posture.title}`);
  console.log(`[dispatch] posture: ${postureLabel}, tools: ${tools.join(",")}`);

  let result = "";

  for await (const message of query({
    prompt,
    options: {
      allowedTools: tools,
      permissionMode: "acceptEdits",
      systemPrompt: `You are a lodestar worker agent executing thread @${threadId}. Report results concisely.`,
    },
  })) {
    const msg = message as any;

    if ("result" in msg) {
      result = msg.result;
    }

    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text?.trim()) {
          process.stdout.write(block.text);
        }
      }
    }
  }

  console.log(`\n[dispatch] @${threadId} complete`);
  return { threadId, posture: postureLabel, result };
}

export async function dispatchParallel(
  threadIds: string[]
): Promise<DispatchResult[]> {
  return Promise.all(threadIds.map((id) => dispatch(id)));
}

async function main() {
  const threadId = process.argv[2];
  if (!threadId) {
    console.error("usage: bun run src/dispatch.ts <thread-id>");
    process.exit(1);
  }

  const result = await dispatch(threadId);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
