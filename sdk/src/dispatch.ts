import { query } from "@anthropic-ai/claude-agent-sdk";
import { getThreadClaims, getChildren } from "./tern-client";
import { derivePosture, buildPrompt } from "./posture";
import { StreamWriter } from "./stream-writer";
import { harnessOptions, DEFAULT_SYSTEM_PROMPT, type Effort } from "./harness";
import { inputChannel, subscribeFeed } from "./coordination";
import { tokensOf } from "./budget";
import { recordRun } from "./telemetry";
import { notifyDeath } from "./death";

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
  let outcome = "ran";

  // Real-time coordination: run the prompt in streaming-input mode so peers can inject
  // pings into THIS run (no re-arm — subscribeFeed re-spawns host-side, invisibly).
  const ch = inputChannel(prompt);
  const stopFeed = subscribeFeed(agentId, (m) => ch.push(m));

  // Error boundary (thread 019f2800): the SDK runs the turn in a subprocess; if it dies
  // (OOM SIGKILL / parent SIGTERM / idle Transport-closed) the generator THROWS exitError
  // here. catch -> outcome "died" + notifyDeath (agent_death claim on this thread + @swarm,
  // peer ping to the coordinator); finally -> ALWAYS stop the feed, close the channel, and
  // record the run so the coordinator learns of the death instead of noticing silence.
  try {
    for await (const message of query({
      prompt: ch.stream(),
      options: harnessOptions({
        self: agentId,
        extraTools: tools,
        model: process.env.AGENT_MODEL,
        effort: process.env.AGENT_EFFORT as Effort | undefined,
        systemPrompt: `You are a tern worker agent executing thread @${threadId}. ${DEFAULT_SYSTEM_PROMPT}`,
      }),
    })) {
      const msg = message as any;
      stream.writeSDKMessage(msg);

      if ("result" in msg) {
        result = msg.result;
        resultMsg = msg;
        if (ch.pending() === 0) { break; } // task done + no pending peer ping -> finish
      }

      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text?.trim()) {
            process.stdout.write(block.text);
          }
        }
      }
    }
  } catch (err) {
    outcome = "died";
    notifyDeath(agentId, err, { thread: threadId, coordinator: process.env.AGENT_COORDINATOR });
  } finally {
    stopFeed();
    try { ch.end(); } catch { /* already closed */ }
  }

  // Spend is no longer charged to a counter here; it is summed from the @run
  // cost_usd claim this run records below (remaining() folds Σ over @run costs).
  recordRun({ thread: threadId, agent: agentId, tokens: tokensOf(resultMsg),
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
