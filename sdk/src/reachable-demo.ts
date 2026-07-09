// Standalone proof of the SDK real-time interrupt: an agent in streaming-input mode
// that a peer can ping mid-run — the ping is injected into the LIVE query, no re-arm.
//
//   AGENT_ID=demo1 MAX_PINGS=1 bun run src/reachable-demo.ts
//   # then, from anywhere:
//   bb cli/north-listen... no — to PING it:
//   bb ~/code/north/cli/msg-cli.clj 7977 send tester demo1 "URGENT" "look at flake.bnix"
import { query } from "@anthropic-ai/claude-agent-sdk";
import { harnessOptions } from "./harness";
import { inputChannel, subscribeFeed } from "./coordination";

const self = process.env.AGENT_ID ?? `sdk-reachable-${Date.now().toString(36).slice(-6)}`;
const maxPings = Number(process.env.MAX_PINGS ?? 1);

const ch = inputChannel(
  `You are north coordination agent "${self}". Reply with ONE short line acknowledging you are live and listening. ` +
  `Then stay idle. When you receive a message tagged [north real-time ping ...], that is a peer reaching you in ` +
  `real time mid-run — reply with ONE line: who pinged you and what they want.`,
);

let results = 0;
const stop = subscribeFeed(self, (m) => {
  console.log(`\n>>> peer ping arriving — injecting into the RUNNING agent:\n${m}\n`);
  ch.push(m);
});

const q = query({ prompt: ch.stream(), options: harnessOptions({ self, model: "haiku", extraTools: ["Bash"] }) });

console.log(`[reachable] @${self} live. Ping it:\n  bb ~/code/north/cli/msg-cli.clj 7977 send tester ${self} "URGENT" "<msg>"\n`);
for await (const msg of q as any) {
  if (msg.type === "assistant") {
    const txt = (msg.message?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    if (txt.trim()) console.log(`[${self}] ${txt.trim()}`);
  }
  if ("result" in msg) {
    results++;
    if (results >= 1 + maxPings) { ch.end(); break; } // initial turn + maxPings pings, then done
  }
}
stop();
ch.end();
console.log(`[reachable] done after ${results} turn(s)`);
