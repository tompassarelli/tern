// The lean harness — our own agent runtime over the Claude Agent SDK. One place
// that builds the query Options for every tern agent, so the things Claude
// Code's CLI doesn't give us (native graph tools, agent-to-agent command, the
// reasoning-effort knob, current model pins, our system prompt) are configured
// here, consistently, for both dispatch.ts and spawn.ts.
//
// The two things that make a tern agent more than a generic worker:
//   1. tern MCP — native claim-graph verbs (capture/tell/ready/next/...),
//      so agents act on claims, not by Edit-ing text files.
//   2. command_peer — emit a {:op :args} envelope over the claim feed; fram-1's
//      reactor (Phase 1) dispatches it. An agent commands a PEER with no human
//      and no parent in the loop. This is P2: the centralized-dispatch break.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";

// sdk/src/harness.ts -> repo root (~/code/tern).
const REPO = resolve(import.meta.dir, "../..");
const ENGINE = `${REPO}/bin/tern`;
const MCP = `${REPO}/bin/tern-mcp`;
const MSG_CLI = `${REPO}/cli/msg-cli.clj`;
const PORT = process.env.TERN_PORT ?? "7977";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// Model aliases — kept current. Not bound by Claude Code's xhigh cap; an agent
// can run opus at max effort here if the task warrants it.
const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};
export function resolveModel(m?: string): string | undefined {
  return m ? MODEL_MAP[m] ?? m : undefined;
}

// Minimal EDN for a flat args map (the envelope contract's :args are flat):
// keywordize keys; @refs and :keywords pass bare; everything else is a quoted
// string (EDN strings are JSON-compatible); numbers/bools bare.
function ednArgs(args: Record<string, unknown>): string {
  const val = (v: unknown): string => {
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = String(v);
    return /^[@:]/.test(s) ? s : JSON.stringify(s);
  };
  return `{${Object.entries(args).map(([k, v]) => `:${k} ${val(v)}`).join(" ")}}`;
}

// In-process MCP server: the decentralized peer-command tool. Emits the envelope
// via `msg-cli send-cmd <self> <to> <op> <args-edn>`; the reactor picks it off
// the fram feed. Contract (fram-1, Phase 0): {:op :spawn|:dispatch|:tell|:claim}.
export function peerCommandServer(self: string) {
  return createSdkMcpServer({
    name: "tern-peer",
    version: "0.1.0",
    tools: [
      tool(
        "command_peer",
        "Command a PEER agent over the tern claim feed — fram-1's reactor " +
          "dispatches it, no human relay. ops: spawn {prompt, model?} | " +
          "dispatch {thread} | tell {id, pred, value} | claim {resource}.",
        {
          to: z
            .string()
            .describe("recipient handle: a handle ('fram-1'), 'all', or dir wildcard ('nixos-config-*')"),
          op: z.enum(["spawn", "dispatch", "tell", "claim"]),
          args: z
            .record(z.string(), z.any())
            .describe("op-specific args, e.g. {prompt:'...'} for spawn, {thread:'@id'} for dispatch"),
        },
        async ({ to, op, args }) => {
          try {
            const out = execFileSync("bb", [MSG_CLI, PORT, "send-cmd", self, to, op, ednArgs(args)], {
              encoding: "utf8",
            });
            return { content: [{ type: "text", text: `sent {:op :${op}} -> ${to}\n${out}`.trim() }] };
          } catch (e: any) {
            return {
              content: [{ type: "text", text: `command_peer failed: ${e?.stderr ?? e?.message ?? e}` }],
              isError: true,
            };
          }
        }
      ),
    ],
  });
}

// The native claim-graph tools every agent gets (stdio MCP -> the tern engine).
const NATIVE_TOOLS = [
  "mcp__tern__capture",
  "mcp__tern__tell",
  "mcp__tern__show",
  "mcp__tern__ready",
  "mcp__tern__next",
  "mcp__tern__plate",
  "mcp__tern__dispatch",
  "mcp__tern__spawn",
  "mcp__tern-peer__command_peer",
];

export interface HarnessOpts {
  self: string; // this agent's id/handle (peer commands + stream identity)
  extraTools?: string[]; // posture file-tools (Read/Edit/Write/...)
  model?: string;
  effort?: Effort;
  systemPrompt?: string;
  maxTurns?: number;
}

// Auto-connect every SDK-spawned agent to tern coordination — the SDK twin of
// the bin/tern-on-spawn SessionStart hook. Presence so it shows on the roster;
// the concern protocol appended to the system prompt so it self-coordinates.
function registerPresence(self: string): void {
  // fire-and-forget — coordination must never delay or break a spawn.
  // PORT (the canonical :7977 log) — NOT a separate daemon: presence on :7978
  // stranded, invisible to concern/roster/board which all read :7977.
  execFile("bb", [`${REPO}/cli/presence-cli.clj`, PORT, "register", self, process.cwd(), self], () => {});
}
function withCoordination(self: string, base: string): string {
  const repo = process.cwd().split("/").filter(Boolean).pop() ?? "repo";
  const proto = [
    ``, `## tern coordination`,
    `You are agent "${self}" in "${repo}". Other agents may work here concurrently.`,
    `Coordinate through CONCERNS, not locks — work coexists; declaring never blocks. Before`,
    `editing code for a feature, declare it so others can see + shape around your work:`,
    `  ${REPO}/bin/concern declare ${self} ${repo} "<what you're building>" <file1,file2,...>`,
    `  ${REPO}/bin/concern shape <id>   # likely-to-land work in your footprint — build against it`,
    `  ${REPO}/bin/concern status <id> likely-to-land · done <id> · ls [repo]`,
    ``,
    `Internal notes / status / scratch / handoffs -> docs/private/ (gitignored), NEVER public docs/.`,
    `Run \`${REPO}/bin/ensure-private-docs\` to set up the ignore in a repo before writing there.`,
  ].join("\n");
  return `${base}\n${proto}`;
}

// The single Options builder. dispatch.ts + spawn.ts both route through here.
export function harnessOptions(o: HarnessOpts): Options {
  registerPresence(o.self);
  return {
    mcpServers: {
      tern: { type: "stdio", command: MCP, args: [], env: { ...process.env, TERN_BIN: ENGINE } },
      "tern-peer": peerCommandServer(o.self),
    },
    allowedTools: [...(o.extraTools ?? []), ...NATIVE_TOOLS],
    model: resolveModel(o.model),
    effort: o.effort, // the reasoning knob spawn.ts used to drop on the floor
    permissionMode: "acceptEdits",
    systemPrompt: withCoordination(o.self, o.systemPrompt ?? DEFAULT_SYSTEM_PROMPT),
    maxTurns: o.maxTurns ?? (Number(process.env.AGENT_MAX_TURNS) || 200),
  } as Options;
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are a tern worker agent on a shared claim graph. Prefer the native " +
  "tern tools over editing text: capture/tell to record work, ready/next to " +
  "find it, dispatch/spawn for in-process subagents, and command_peer to hand " +
  "work to another agent over the claim feed (decentralized — no human relay). " +
  "Claim before you edit shared code. Report concisely.";
