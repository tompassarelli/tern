// Real-time coordination for SDK agents. A peer's ping is injected into the agent's
// RUNNING query as a user turn — no re-arm, no background-task exit dance (the SDK twin
// of the Claude Code interrupt, but cleaner). The query runs in streaming-input mode;
// a continuous `lodestar-listen` subprocess feeds each delivered message into the channel.
import { spawn as procSpawn, type ChildProcess } from "node:child_process";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const LISTEN = `${REPO}/cli/lodestar-listen.clj`;
const PORT = process.env.LODESTAR_PORT ?? "7977";

function userMsg(text: string): SDKUserMessage {
  // priority 'now' = urgent: jump the queue so a real-time ping is seen ASAP.
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, priority: "now" };
}

// A controllable input channel. Yields `initial` first, then anything push()ed; the
// query stays alive (and interruptible) until end(). This is what keeps an SDK agent
// "listening" without polling or re-arming.
export function inputChannel(initial: string) {
  const queue: SDKUserMessage[] = [userMsg(initial)];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(text: string) { queue.push(userMsg(text)); wake?.(); wake = null; },
    end() { closed = true; wake?.(); wake = null; },
    pending() { return queue.length; }, // unconsumed injected pings — lets a task agent end when idle
    async *stream(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((r) => (wake = r)); // suspend the query until a peer pings
      }
    },
  };
}

// Subscribe to the lodestar feed for `self`; invoke onMail for each delivered message.
// Implementation: loop `lodestar-listen --once` (which FLUSHES on exit — continuous mode
// buffers its stdout when piped, so MAIL never arrives until the buffer fills). The
// re-spawn loop lives HERE in the host process, so it is invisible to the agent — the
// agent never re-arms. Returns stop() to tear down.
export function subscribeFeed(self: string, onMail: (summary: string) => void): () => void {
  let stopped = false;
  let cur: ChildProcess | null = null;
  const loop = () => {
    if (stopped) return;
    cur = procSpawn("bb", [LISTEN, PORT, self, "--once"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    cur.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    cur.on("exit", () => {
      if (stopped) return;
      const from = /from:\s*(.*)/.exec(out)?.[1]?.trim() ?? "?";
      const subj = /subject:\s*(.*)/.exec(out)?.[1]?.trim() ?? "";
      const body = /body:\s*([\s\S]*?)\s*$/.exec(out)?.[1]?.trim();
      if (body) onMail(`[lodestar real-time ping from ${from} — ${subj}]\n${body}`);
      loop(); // re-arm host-side (the agent does nothing)
    });
  };
  loop();
  return () => { stopped = true; try { cur?.kill(); } catch { /* already gone */ } };
}
