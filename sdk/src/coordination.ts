// Real-time coordination for SDK agents. A peer's ping is injected into the agent's
// RUNNING query as a user turn — no re-arm, no background-task exit dance (the SDK twin
// of the Claude Code interrupt, but cleaner). The query runs in streaming-input mode;
// a continuous `north-listen` subprocess feeds each delivered message into the channel.
import { spawn as procSpawn, type ChildProcess } from "node:child_process";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const LISTEN = `${REPO}/cli/north-listen.clj`;
const PORT = process.env.NORTH_PORT ?? "7977";
const DEFAULT_FEED_OUTPUT_BYTES = 65_536;

export interface SubscriptionRuntime {
  spawn?: typeof procSpawn;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  healthyResetMs?: number;
  maxOutputBytes?: number;
}

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

// Subscribe to the north feed for `self`; invoke onMail for each delivered message.
// Implementation: loop `north-listen --once` (which FLUSHES on exit — continuous mode
// buffers its stdout when piped, so MAIL never arrives until the buffer fills). The
// re-spawn loop lives HERE in the host process, so it is invisible to the agent — the
// agent never re-arms. Returns stop() to tear down.
export function subscribeFeed(
  self: string,
  onMail: (summary: string) => void,
  runtime: SubscriptionRuntime = {},
): () => void {
  const spawn = runtime.spawn ?? procSpawn;
  const schedule = runtime.schedule
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancel = runtime.cancel
    ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const now = runtime.now ?? Date.now;
  const initialBackoffMs = runtime.initialBackoffMs ?? 250;
  const maxBackoffMs = runtime.maxBackoffMs ?? 5_000;
  const healthyResetMs = runtime.healthyResetMs ?? 30_000;
  const maxOutputBytes = runtime.maxOutputBytes ?? DEFAULT_FEED_OUTPUT_BYTES;
  let stopped = false;
  let cur: ChildProcess | null = null;
  let timer: unknown = null;
  let rapidFailures = 0;

  const rearm = (delayMs: number) => {
    if (stopped) return;
    timer = schedule(() => {
      timer = null;
      loop();
    }, delayMs);
  };

  const loop = () => {
    if (stopped) return;
    const startedAt = now();
    try {
      cur = spawn("bb", [LISTEN, PORT, self, "--once"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      rapidFailures += 1;
      rearm(Math.min(maxBackoffMs, initialBackoffMs * (2 ** Math.min(rapidFailures - 1, 20))));
      return;
    }
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let finalized = false;
    cur.stdout!.on("data", (value: Buffer | string) => {
      if (outputLimitExceeded) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        chunks.length = 0;
        try { cur?.kill("SIGKILL"); } catch { /* close still finalizes/backoffs */ }
        return;
      }
      chunks.push(chunk);
    });
    const finish = () => {
      if (finalized) return;
      finalized = true;
      if (stopped) return;
      const out = outputLimitExceeded ? "" : Buffer.concat(chunks).toString("utf8");
      const from = /from:\s*(.*)/.exec(out)?.[1]?.trim() ?? "?";
      const subj = /subject:\s*(.*)/.exec(out)?.[1]?.trim() ?? "";
      const body = /body:\s*([\s\S]*?)\s*$/.exec(out)?.[1]?.trim();
      if (body) onMail(`[north real-time ping from ${from} — ${subj}]\n${body}`);
      const healthyRun = now() - startedAt >= healthyResetMs;
      if (body || healthyRun) rapidFailures = 0;
      else rapidFailures += 1;
      const delay = body || healthyRun
        ? 0
        : Math.min(maxBackoffMs, initialBackoffMs * (2 ** Math.min(rapidFailures - 1, 20)));
      rearm(delay);
    };
    // `exit` may precede the final stdout chunk. `close` is the terminal event
    // that guarantees both the process and its stdio are done, so only then is
    // it safe to decide whether this subscription delivered mail.
    cur.once("error", () => { /* `close` drains/finalizes this failed child */ });
    cur.once("close", () => {
      try {
        finish();
      } catch {
        // A consumer callback is outside the subscription's lifecycle
        // authority. It may reject this delivery, but must never strand the
        // single-flight re-arm loop.
        if (!stopped) {
          rapidFailures = 0;
          rearm(0);
        }
      }
    });
  };
  loop();
  return () => {
    stopped = true;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    try { cur?.kill(); } catch { /* already gone */ }
  };
}
