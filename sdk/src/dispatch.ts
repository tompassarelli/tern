import { query } from "@anthropic-ai/claude-agent-sdk";
import { getThreadClaims, getChildren } from "./lodestar-client";
import { derivePosture, buildPrompt } from "./posture";
import { StreamWriter } from "./stream-writer";
import { harnessOptions, DEFAULT_SYSTEM_PROMPT, type Effort } from "./harness";
import { charge, tokensOf } from "./budget";

const PLAN_TOOLS = ["Read", "Grep", "Glob", "Bash"];
const EXEC_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];
const SURVEY_TOOLS = ["Read", "Grep", "Glob"];

interface DispatchResult {
  threadId: string;
  posture: "unplanned" | "atomic" | "composite";
  result: string;
}

export async function dispatch(threadId: string): Promise<DispatchResult> {
  const claims = getThreadClaims(threadId);
  if (!claims.length) {
    throw new Error(`Thread @${threadId} not found or has no claims`);
  }

  const children = getChildren(threadId);
  const hasChildren = children.length > 0;
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

  const agentId =
    process.env.AGENT_ID ??
    `sdk-${threadId.replace(/[^a-z0-9]/gi, "").slice(-12)}`;
  const stream = new StreamWriter(agentId);

  console.log(`[dispatch] @${threadId} — ${posture.title}`);
  console.log(`[dispatch] posture: ${postureLabel}, tools: ${tools.join(",")}`);

  let result = "";
  let resultMsg: any = null;

  for await (const message of query({
    prompt,
    options: harnessOptions({
      self: agentId,
      extraTools: tools,
      model: process.env.AGENT_MODEL,
      effort: process.env.AGENT_EFFORT as Effort | undefined,
      systemPrompt: `You are a lodestar worker agent executing thread @${threadId}. ${DEFAULT_SYSTEM_PROMPT}`,
    }),
  })) {
    const msg = message as any;
    stream.writeSDKMessage(msg);

    if ("result" in msg) {
      result = msg.result;
      resultMsg = msg;
    }

    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text?.trim()) {
          process.stdout.write(block.text);
        }
      }
    }
  }

  await charge(tokensOf(resultMsg)); // bill this run's tokens to the shared budget (atomic :bump)
  console.log(`\n[dispatch] @${threadId} complete`);
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
