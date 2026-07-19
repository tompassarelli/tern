// The provider-neutral harness contract. One place builds the query Options that
// both the Claude SDK and Codex adapter consume, so graph tools, Gaffer authority,
// topology enforcement, reasoning, model calibration, and system instructions
// stay identical across dispatch.ts and spawn.ts.
//
// The two things that make a North-orchestrated agent more than a generic run:
//   1. north MCP — native fact-graph verbs (capture/tell/ready/next/...),
//      so agents act on facts, not by Edit-ing text files.
//   2. explicit orchestrator topology — and only that topology — may dispatch or
//      command peers. Workers and topology-neutral lanes remain terminal.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import {
  authoringGuardsOff, evaluateGuards, HOOKS_DIR, resolveManagedGuardChain,
} from "./authoring-guards";
import { recordDenial } from "./guard-log";
import { resolveModelAlias, resolveModelDelta, resolveTier } from "./providers/catalog";
import type { ProviderId } from "./providers/types";
import {
  type RoutingDraft, type RoutingOverrideField, type RoutingRequest, type Topology,
} from "./routing-metadata";
import { admitRoutingRequest } from "./routing-admission";
import { gafferCapabilities } from "./gaffer-staffing";
import type { GafferCapability } from "./gaffer-capabilities";
import {
  BESPOKE_FINGERPRINT_DOMAIN, BESPOKE_FINGERPRINT_VERSION,
  bespokeContractFingerprint, canonicalGafferCapabilities,
} from "./bespoke-contract";
import { assertCoordinationAuthority } from "./topology-authority";
import {
  MAX_READONLY_COMMAND_BYTES, READONLY_SHELL_SERVER, READONLY_SHELL_TOOL, runReadonlyShell,
} from "./readonly-shell";
import { managedNorthMcpEnvironment } from "./execution-admission";

// sdk/src/harness.ts -> its relocatable runtime root.
const REPO = resolve(import.meta.dir, "../..");
const ENGINE = `${REPO}/bin/north`;
const MCP = `${REPO}/bin/north-mcp`;
const MSG_CLI = `${REPO}/cli/msg-cli.clj`;
const northPort = () => process.env.NORTH_PORT ?? "7977";
const peerBb = () => process.env.NORTH_PEER_BB ?? "bb";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// Minimal EDN for a flat args map (the envelope contract's :args are flat):
// keywordize keys; @refs and :keywords pass bare; everything else is a quoted
// string (EDN strings are JSON-compatible); numbers/bools bare.
function ednArgs(args: Record<string, unknown>): string {
  const val = (v: unknown): string => {
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    return /^[@:]/.test(s) ? s : JSON.stringify(s);
  };
  return `{${Object.entries(args).map(([k, v]) => `:${k} ${val(v)}`).join(" ")}}`;
}

const PEER_ROUTING_FIELDS = [
  "role", "taskGrade", "domainRequirements", "topology", "tier", "reasoning", "posture", "composition",
] as const;
const PEER_ROUTE_ADAPTER_FIELDS = ["provider", "target", "model"] as const;
type PeerOperation = "spawn" | "dispatch" | "tell" | "acquire";

function exactPeerFields(args: Record<string, unknown>, allowed: readonly string[], operation: string): void {
  const unknown = Object.keys(args).filter((field) => !allowed.includes(field));
  if (unknown.length) throw new Error(`${operation} has unknown field(s): ${unknown.join(", ")}`);
}

/** Validate the fact-envelope before msg-cli can publish its routing key. */
export function validatePeerCommandArgs(op: PeerOperation, args: Record<string, unknown>): void {
  if (args == null || typeof args !== "object" || Array.isArray(args))
    throw new Error(`${op} args must be an object`);
  const nonEmpty = (field: string) => typeof args[field] === "string" && Boolean((args[field] as string).trim());
  if (op === "tell") {
    exactPeerFields(args, ["id", "pred", "value"], op);
    if (!["id", "pred", "value"].every(nonEmpty)) throw new Error("tell requires id, pred, and value");
    return;
  }
  if (op === "acquire") {
    exactPeerFields(args, ["resource", "holder"], op);
    if (!nonEmpty("resource")) throw new Error("acquire requires resource");
    return;
  }
  const workField = op === "spawn" ? "prompt" : "thread";
  exactPeerFields(args, [workField, ...PEER_ROUTING_FIELDS, ...PEER_ROUTE_ADAPTER_FIELDS], op);
  if (!nonEmpty(workField) || !nonEmpty("role"))
    throw new Error(`${op} requires ${workField} and an explicit Gaffer role`);
  const presentRouting = PEER_ROUTING_FIELDS.filter((field) => Object.hasOwn(args, field));
  if (presentRouting.length !== PEER_ROUTING_FIELDS.length) {
    const missing = PEER_ROUTING_FIELDS.filter((field) => !Object.hasOwn(args, field));
    throw new Error(
      `${op} requires the complete eight-field Gaffer request; missing: ${missing.join(", ")}`,
    );
  }
  const metadata = Object.fromEntries(
    PEER_ROUTING_FIELDS.filter((field) => Object.hasOwn(args, field)).map((field) => [field, args[field]]),
  ) as RoutingDraft;
  admitRoutingRequest(metadata, `managed peer ${op}`);
}

export function sendPeerCommand(
  self: string,
  to: string,
  op: PeerOperation,
  args: Record<string, unknown>,
): string {
  assertCoordinationAuthority(`command_peer:${op}`);
  if (op === "spawn" || op === "dispatch") {
    throw new Error(
      `peer ${op} is unsupported until atomic command claim + child reconciliation land; use North MCP/CLI ${op}`,
    );
  }
  validatePeerCommandArgs(op, args);
  const commandArgs = { ...args };
  return execFileSync(peerBb(), [MSG_CLI, northPort(), "send-cmd", self, to, op, ednArgs(commandArgs)], {
    encoding: "utf8",
  });
}

// Repeat-safe peer fact operations. Managed spawn/dispatch stay on North's
// canonical MCP/CLI surfaces until command claims + child reconciliation exist.
export function peerCommandServer(self: string) {
  return createSdkMcpServer({
    name: "north-peer",
    version: "0.1.0",
    tools: [
      tool(
        "command_peer",
        "Command a peer over the North fact feed with repeat-safe operations: " +
          "tell {id, pred, value} | acquire {resource}. Managed spawn/dispatch " +
          "use North's canonical MCP/CLI tools.",
        {
          to: z
            .string()
            .describe("exact recipient agent handle or held role; use literal '*' to broadcast"),
          op: z.enum(["tell", "acquire"]),
          args: z
            .record(z.string(), z.any())
            .describe("op-specific repeat-safe fact arguments"),
        },
        async ({ to, op, args }) => {
          try {
            const out = sendPeerCommand(self, to, op, args);
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

// Coordination tools are universal; orchestration tools are positive authority.
export const COORDINATION_TOOLS = [
  "mcp__north__capture",
  "mcp__north__tell",
  "mcp__north__evidence_record",
  "mcp__north__show",
  "mcp__north__ready",
  "mcp__north__next",
  "mcp__north__board",
  "mcp__north__plate",
];
export const ORCHESTRATION_TOOLS = [
  "mcp__north__dispatch",
  "mcp__north__spawn",
  "mcp__north-peer__command_peer",
];
export const NATIVE_AGENT_TOOLS = ["Agent", "Task", "Workflow"];
export const NORTH_MCP_TOOL_NAMES = [
  "ready",
  "next",
  "board",
  "plate",
  "blocked",
  "agenda",
  "leverage",
  "needs_review",
  "validate",
  "show",
  "capture",
  "tell",
  "evidence_record",
  "retract",
  "clock_start",
  "clock_stop",
  "clock_status",
  "clock_report",
  "presentation",
  "linear_get",
  "linear_import",
  "linear_plan",
  "linear_sync",
  "dispatch",
  "spawn",
] as const;
const ALL_NORTH_MCP_TOOLS = NORTH_MCP_TOOL_NAMES.map((name) => `mcp__north__${name}`);
const CAPABILITY_TOOLS: Record<GafferCapability, string[]> = {
  "filesystem.read": ["Read"],
  "filesystem.search": ["Grep", "Glob"],
  "filesystem.write": ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  shell: ["Bash"],
  "shell.readonly": [READONLY_SHELL_TOOL],
  web: ["WebSearch", "WebFetch"],
  coordination: ORCHESTRATION_TOOLS,
};
const ALL_CAPABILITY_TOOLS = [...new Set(Object.values(CAPABILITY_TOOLS).flat())];

export interface ManagedToolPolicy {
  /** Exact Claude SDK built-in availability surface. MCP tools are configured separately. */
  tools: string[];
  /** Auto-approval policy only; never interpreted as availability. */
  allowedTools: string[];
  /** Explicit defense-in-depth denies, including every noncontract North MCP tool. */
  disallowedTools: string[];
}

export function managedToolPolicy(
  capabilities: readonly GafferCapability[],
): ManagedToolPolicy {
  const selectedCapabilityTools = [
    ...new Set(capabilities.flatMap((capability) => CAPABILITY_TOOLS[capability])),
  ];
  const orchestrationAllowed = capabilities.includes("coordination");
  const allowedTools = [...new Set([
    ...selectedCapabilityTools,
    ...COORDINATION_TOOLS,
    ...(orchestrationAllowed ? ORCHESTRATION_TOOLS : []),
  ])];
  const disallowedTools = [...new Set([
    ...NATIVE_AGENT_TOOLS,
    ...ALL_CAPABILITY_TOOLS.filter((toolName) => !selectedCapabilityTools.includes(toolName)),
    ...ALL_NORTH_MCP_TOOLS.filter((toolName) => !allowedTools.includes(toolName)),
    ...(!orchestrationAllowed ? ["mcp__north-peer__command_peer"] : []),
  ])];
  return {
    tools: selectedCapabilityTools.filter((toolName) => !toolName.startsWith("mcp__")),
    allowedTools,
    disallowedTools,
  };
}

function readonlyShellServer(cwd: string) {
  return createSdkMcpServer({
    name: READONLY_SHELL_SERVER,
    version: "0.1.0",
    tools: [
      tool(
        "run",
        "Run one command in North's network-isolated read-only shell. The checkout and host "
          + "filesystem are read-only; only an ephemeral /tmp is writable.",
        {
          command: z.string().min(1).max(MAX_READONLY_COMMAND_BYTES)
            .describe("Command interpreted intentionally by bash -lc inside the read-only sandbox"),
          timeoutMs: z.number().finite().int().min(100).max(120_000).optional()
            .describe("Bounded command timeout in milliseconds (default: 30000; maximum: 120000)"),
        },
        async ({ command, timeoutMs }) => {
          try {
            const result = await runReadonlyShell(command, cwd, timeoutMs);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              ...(!result.ok ? { isError: true } : {}),
            };
          } catch (error: any) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: error?.code ?? "readonly_shell_unavailable",
                  message: error?.message ?? String(error),
                }),
              }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}

export interface HarnessOpts {
  self: string; // this agent's id/handle (peer commands + stream identity)
  extraTools?: string[]; // posture file-tools (Read/Edit/Write/...)
  model?: string;
  effort?: Effort;
  systemPrompt?: string;
  maxTurns?: number;
  role?: string;
  posture?: string;
  provider?: ProviderId;
  routingMetadata?: RoutingRequest;
  /** A live run may change models in-place, so no exact-model delta can remain valid. */
  omitModelDeltaReason?: string;
  caveman?: string; // resolved terse-output mode (off|lite|full); fallback env-or-full when omitted
  cwd?: string; // provider working directory; dispatch resolves this from thread repo facts
  /** Capability-bound delivery context reserved before provider execution. */
  deliveryRun?: {
    runId: string;
    threadId: string;
    capability: string;
  };
  /** Test seam: false suppresses graph presence; a function captures registration hermetically. */
  presenceRegistrar?: false | ((self: string, cwd: string) => void);
  /** Matching heartbeat seam. Omit with production registration for the real renewer. */
  presenceRenewer?: false | ((self: string) => void);
}

// Auto-connect every SDK-spawned agent to north coordination — the SDK twin of
// the bin/north-on-spawn SessionStart hook. Presence so it shows on the roster;
// the concern protocol appended to the system prompt so it self-coordinates.
function registerPresence(self: string, cwd: string): void {
  // fire-and-forget — coordination must never delay or break a spawn.
  // The canonical :7977 log — NOT a separate daemon: presence on :7978
  // stranded, invisible to concern/roster/board which all read :7977.
  // Resolve the port at dispatch time: Bun caches this module across test files,
  // while each hermetic spawn test installs its own transport after import.
  execFile("bb", [`${REPO}/cli/presence-cli.clj`, northPort(), "register", self, cwd, self], () => {});
}

// SDK-lane presence heartbeat (F2). registerPresence writes the lease ONCE at
// spawn; the 30min TTL then lapses under any lane working longer — falsely
// `lapsed` while alive, which the concern-decay machinery reads as STALE. Fix:
// renew the lease on ACTIVITY. This is the SDK twin of bin/north-on-tooluse (the
// Claude Code PostToolUse hook) — renewal MEANS "this agent ran a tool just now"
// (IS-WORKING), so a lapsed lease stays a real death signal. NOT a setInterval:
// a timer on a hung-but-alive process would renew forever and defeat the
// reactor's stuck-fork reaping (lapsed>30min + no outcome -> died-unreported).
// Throttle ≥60s per agent (a bb spawn per tool call is pure waste against a
// 30min lease); marker is an in-process Map (the hook callback runs in this host
// process, so no XDG marker file needed — and it can't alias across agents).
const RENEW_THROTTLE_MS = 60_000;
const lastRenew = new Map<string, number>();
function renewPresence(self: string): void {
  const now = Date.now();
  const prev = lastRenew.get(self) ?? 0;
  if (now - prev < RENEW_THROTTLE_MS) return;
  lastRenew.set(self, now); // stamp before dispatch so a burst of tool calls spawns one bb
  // Best-effort + timeout-bounded: any failure is swallowed, never breaks the
  // tool call. On failure, roll the stamp back (only if no newer renew landed)
  // so the next tool call retries — same retry semantics as north-on-tooluse.
  execFile("bb", [`${REPO}/cli/presence-cli.clj`, northPort(), "renew", self], { timeout: 5000 }, (err) => {
    if (err && lastRenew.get(self) === now) lastRenew.set(self, prev);
  });
}
function withCoordination(self: string, base: string, cwd: string): string {
  const repo = cwd.split("/").filter(Boolean).pop() ?? "repo";
  const proto = [
    ``, `## north coordination`,
    `You are agent "${self}" in "${repo}". Other agents may work here concurrently.`,
    `Coordinate through CONCERNS, not locks — work coexists; declaring never blocks. Before`,
    `editing code for a feature, declare it so others can see + shape around your work:`,
    `  ${REPO}/bin/concern declare ${self} ${repo} "<what you're building>" <file1,file2,...>`,
    `  ${REPO}/bin/concern overlap <id>   # who's in your footprint; likely-to-land marked — build against it`,
    `  ${REPO}/bin/concern status <id> likely-to-land · done <id> · ls [repo]`,
    ``,
    `Internal notes / status / scratch / handoffs -> docs/private/ (gitignored), NEVER public docs/.`,
    `Run \`${REPO}/bin/ensure-private-docs\` to set up the ignore in a repo before writing there.`,
  ].join("\n");
  return `${base}\n${proto}`;
}

// AGENT_ESO=on|off — appends dense-handoff instruction to every spawned agent.
// When on, agents emit uniform arrays of ≥10 records as ESO instead of JSON/markdown.
function esoAppendix(): string {
  const mode = process.env.AGENT_ESO ?? "on";
  if (mode !== "on") return "";
  return "\n\n" +
    "DENSE HANDOFF — when a final report contains a uniform array of ≥10 similar records " +
    "(grep hits, findings, file lists), emit it in ESO format instead of JSON or markdown table.\n" +
    `Mini-syntax (full spec: ${REPO}/sdk/src/vendor/eso/SPEC.md):\n` +
    "  !eso/1              ← required header\n" +
    "  name=value          ← scalar field\n" +
    "  items[N]{a,b,c}     ← N records, schema declared once; N is a checksum\n" +
    "  val1\\tval2\\tval3   ← one tab-delimited row per record (strings with tabs/newlines use JSON quoting)";
}

// AGENT_LAWS=on|off — appends the user's provider-neutral global AGENTS.md to Anthropic
// workers. Codex loads the same global file natively; injecting it there would duplicate
// the constitution. Project AGENTS files are composed explicitly for both providers below.
// A custom-string systemPrompt bypasses the SDK's claude_code preset, which is the
// only path that injects CLAUDE.md — so without this, workers get NONE of the
// global laws interactive sessions live under. ~/.codex/AGENTS.md is the one
// provider-neutral bootstrap source. Missing, replaced, unreadable, malformed,
// or oversized authority is a hard configuration error; AGENT_LAWS=off is the
// sole explicit escape hatch.
export const GLOBAL_AGENTS_MAX_BYTES = 32 * 1024;

export interface CanonicalGlobalAgents {
  path: string;
  realpath: string;
  bytes: Buffer;
  text: string;
}

function agentLawsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.AGENT_LAWS ?? "on";
  if (mode === "on") return true;
  if (mode === "off") return false;
  throw new Error("AGENT_LAWS must be exactly 'on' or 'off'");
}

function readGlobalAgents(path: string, label: string): Omit<CanonicalGlobalAgents, "path" | "realpath"> {
  let info;
  try { info = statSync(path); }
  catch (cause) {
    throw new Error(`global AGENTS bootstrap cannot inspect ${label}: ${path}`, { cause });
  }
  if (!info.isFile())
    throw new Error(`global AGENTS bootstrap ${label} is not a regular file: ${path}`);
  if (info.size > GLOBAL_AGENTS_MAX_BYTES)
    throw new Error(`global AGENTS bootstrap exceeds ${GLOBAL_AGENTS_MAX_BYTES} bytes at: ${path}`);

  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch (cause) {
    throw new Error(`global AGENTS bootstrap cannot read ${label}: ${path}`, { cause });
  }
  if (bytes.byteLength > GLOBAL_AGENTS_MAX_BYTES)
    throw new Error(`global AGENTS bootstrap exceeds ${GLOBAL_AGENTS_MAX_BYTES} bytes at: ${path}`);

  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) {
    throw new Error(`global AGENTS bootstrap is not valid UTF-8 at: ${path}`, { cause });
  }
  if (!text.trim()) throw new Error(`global AGENTS bootstrap is empty at: ${path}`);
  return { bytes, text };
}

/** The exact provider-neutral global authority source for this process home. */
export function canonicalGlobalAgents(
  env: NodeJS.ProcessEnv = process.env,
): CanonicalGlobalAgents | undefined {
  if (!agentLawsEnabled(env)) return undefined;
  const home = env.HOME?.trim();
  if (!home) throw new Error("global AGENTS bootstrap requires HOME");
  const path = resolve(home, ".codex", "AGENTS.md");
  const source = readGlobalAgents(path, "canonical source");
  let canonicalPath: string;
  try { canonicalPath = realpathSync(path); }
  catch (cause) {
    throw new Error(`global AGENTS bootstrap cannot resolve canonical source: ${path}`, { cause });
  }
  return { path, realpath: canonicalPath, ...source };
}

function globalLawsAppendix(): string {
  const laws = canonicalGlobalAgents();
  if (!laws) return "";
  const trailingNewline = laws.text.endsWith("\n") ? "" : "\n";
  return `\n\n## Global laws — ${laws.path} (binds every provider and agent)\n\n`
    + laws.text + trailingNewline;
}

export const PROJECT_AGENTS_MAX_BYTES = 32 * 1024;

function gitRootForProject(cwd: string): { cwd: string; root: string } {
  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync(cwd);
    if (!statSync(canonicalCwd).isDirectory())
      throw new Error(`working directory is not a directory: ${canonicalCwd}`);
  } catch (cause) {
    throw new Error(`project AGENTS bootstrap cannot resolve cwd: ${cwd}`, { cause });
  }
  let cursor = canonicalCwd;
  while (true) {
    const marker = resolve(cursor, ".git");
    try {
      const markerStat = statSync(marker);
      if (!markerStat.isDirectory() && !markerStat.isFile())
        throw new Error(`Git marker is neither file nor directory: ${marker}`);
      return { cwd: canonicalCwd, root: cursor };
    } catch (error: any) {
      if (error?.code !== "ENOENT")
        throw new Error(`project AGENTS bootstrap cannot inspect Git marker: ${marker}`, { cause: error });
    }
    const parent = dirname(cursor);
    if (parent === cursor) return { cwd: canonicalCwd, root: canonicalCwd };
    cursor = parent;
  }
}

function projectInstructionFile(directory: string): string | undefined {
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const path = resolve(directory, name);
    let info;
    try {
      info = statSync(path);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`project AGENTS bootstrap cannot inspect: ${path}`, { cause: error });
    }
    if (!info.isFile())
      throw new Error(`project instruction source is not a regular file: ${path}`);
    if (info.size > PROJECT_AGENTS_MAX_BYTES) {
      throw new Error(
        `project AGENTS bootstrap exceeds ${PROJECT_AGENTS_MAX_BYTES} bytes at: ${path}`,
      );
    }
    return path;
  }
  return undefined;
}

/**
 * Deterministic, bounded root-to-cwd project instruction composition.
 *
 * Managed Codex disables native project-doc loading and consumes this same block,
 * while Anthropic receives it directly because the SDK's settings sources are
 * sealed off. A discovered but unreadable/malformed/oversized instruction source
 * blocks the spawn instead of silently creating a provider-specific authority gap.
 */
export function projectAgentsAppendix(cwd: string): string {
  if (!agentLawsEnabled()) return "";
  const project = gitRootForProject(cwd);
  const rel = relative(project.root, project.cwd);
  if (rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error(`project AGENTS bootstrap cwd escapes Git root: ${project.cwd}`);
  const directories = [project.root];
  let cursor = project.root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    directories.push(cursor);
  }

  const sections: string[] = [];
  for (const directory of directories) {
    const path = projectInstructionFile(directory);
    if (!path) continue;
    let source: Buffer;
    try { source = readFileSync(path); }
    catch (cause) {
      throw new Error(`project AGENTS bootstrap cannot read: ${path}`, { cause });
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(source).trim(); }
    catch (cause) {
      throw new Error(`project AGENTS bootstrap is not valid UTF-8: ${path}`, { cause });
    }
    if (!text) continue;
    const next = [...sections, `### ${path}\n\n${text}`];
    const appendix = `\n\n## Project instructions — Git root to cwd\n\n${next.join("\n\n")}`;
    if (Buffer.byteLength(appendix, "utf8") > PROJECT_AGENTS_MAX_BYTES) {
      throw new Error(
        `project AGENTS bootstrap exceeds ${PROJECT_AGENTS_MAX_BYTES} bytes at: ${path}`,
      );
    }
    sections.push(next.at(-1)!);
  }
  return sections.length
    ? `\n\n## Project instructions — Git root to cwd\n\n${sections.join("\n\n")}`
    : "";
}

function providerInstructionAppendix(provider: ProviderId, cwd: string): string {
  // Codex keeps native global AGENTS discovery but native project loading is
  // disabled by the managed adapter, so project instructions are explicit once.
  return (provider === "anthropic" ? globalLawsAppendix() : "")
    + projectAgentsAppendix(cwd);
}

function assertCanonicalGlobalAgentsExactlyOnce(prompt: string): void {
  const canonical = canonicalGlobalAgents();
  if (!canonical) return;
  const needle = canonical.text.trim();
  let count = 0;
  let offset = 0;
  while ((offset = prompt.indexOf(needle, offset)) !== -1) {
    count++;
    offset += needle.length;
  }
  if (count !== 1)
    throw new Error(`Anthropic global AGENTS bootstrap expected exactly once, observed ${count}`);
}

function gafferHome(): string {
  return resolve(process.env.GAFFER_HOME ?? `${process.env.HOME}/code/gaffer`);
}

function gafferDocs(): string { return resolve(gafferHome(), "docs"); }

function extractFenceFromSection(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const headingLower = `## ${heading.toLowerCase()}`;
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() === headingLower) { sectionStart = i + 1; break; }
  }
  if (sectionStart === -1) return null;
  let fenceOpen = -1;
  for (let i = sectionStart; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (fenceOpen === -1 && trimmed.startsWith("## ")) break; // next heading, no fence found
    if (fenceOpen === -1 && trimmed.startsWith("```")) { fenceOpen = i + 1; continue; }
    if (fenceOpen !== -1 && trimmed.startsWith("```")) return lines.slice(fenceOpen, i).join("\n");
  }
  return null;
}

function extractFirstFence(text: string): string | null {
  const lines = text.split("\n");
  let fenceOpen = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (fenceOpen === -1 && trimmed.startsWith("```")) { fenceOpen = i + 1; continue; }
    if (fenceOpen !== -1 && trimmed.startsWith("```")) return lines.slice(fenceOpen, i).join("\n");
  }
  return null;
}

function exactSectionFence(path: string, heading: string, label: string): string {
  let source: string;
  try { source = readFileSync(path, "utf8"); }
  catch { throw new Error(`Gaffer contract unavailable: ${label} (${path})`); }
  const block = extractFenceFromSection(source, heading);
  if (!block?.trim()) throw new Error(`Gaffer contract malformed: ${label} has no fenced block (${path})`);
  return block;
}

function exactFirstFence(path: string, label: string): string {
  let source: string;
  try { source = readFileSync(path, "utf8"); }
  catch { throw new Error(`Gaffer contract unavailable: ${label} (${path})`); }
  const block = extractFirstFence(source);
  if (!block?.trim()) throw new Error(`Gaffer contract malformed: ${label} has no fenced block (${path})`);
  return block;
}

function listLines(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

function bespokeRoleBlock(metadata: RoutingRequest): string {
  if (metadata.composition?.kind !== "bespoke") throw new Error("bespoke role block requires bespoke composition");
  const c = metadata.composition.contract;
  return [
    `ROLE: BESPOKE ${metadata.composition.id.toUpperCase()}.`,
    `Responsibility: ${c.responsibility}`,
    `Deliverable: ${c.deliverable}`,
    "May decide:", listLines(c.mayDecide),
    "Must escalate:", listLines(c.mustEscalate),
    "Done when:", listLines(c.doneWhen),
    `REPORT: ${c.report}`,
    `Why bespoke: ${metadata.composition.bespokeReason}`,
    `Promotion candidate: ${metadata.composition.promotionCandidate ? "yes" : "no"}.`,
  ].join("\n");
}

function requirementSlug(requirement: string): string {
  return requirement.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function domainContextCandidates(cwd: string, requirement: string): string[] {
  const slug = requirementSlug(requirement);
  const candidates = [
    resolve(cwd, "AGENTS.md"),
    resolve(cwd, "docs", `${slug}.md`),
    resolve(cwd, "docs", "domains", `${slug}.md`),
    resolve(process.env.HOME ?? "", ".agents", "skills", slug, "SKILL.md"),
    resolve(process.env.HOME ?? "", ".codex", "skills", slug, "SKILL.md"),
    resolve(process.env.HOME ?? "", "code/nixos-config/dotfiles/agents/skills", slug, "SKILL.md"),
    resolve(gafferHome(), "docs", "domains", `${slug}.md`),
  ];
  return [...new Set(candidates.filter(existsSync))];
}

function domainContextGate(requirements: string[], cwd: string): string {
  if (!requirements.length) return "";
  const entries = requirements.map((requirement) => {
    const candidates = domainContextCandidates(cwd, requirement);
    return [
      `### ${requirement}`,
      candidates.length
        ? `Candidate entry points (candidates are not proof of expertise):\n${listLines(candidates)}`
        : "No context candidate was discovered by the harness.",
    ].join("\n");
  });
  return [
    "## Gaffer domain-context gate",
    "Before any side effect, satisfy every domain requirement by reading the relevant",
    "repo-local authoritative docs, triggered skills, or provider capability contract.",
    "For each requirement, name the exact artifact actually read and apply it. A candidate",
    "path is only an entry point, never evidence that you possess the expertise. If no",
    "authoritative context exists or access is missing, report `DOMAIN CONTEXT MISSING:",
    "<requirement>` to the orchestrator and stop before side effects; never fake expertise.",
    ...entries,
  ].join("\n");
}

export interface ModelDeltaEvidence {
  provider?: ProviderId;
  model?: string;
  kind: "calibrated" | "none" | "omitted";
  path?: string;
  reason?: string;
}

export interface HarnessCompositionEvidence {
  roleKind?: "preset" | "bespoke";
  roleId?: string;
  bespokeContractHash?: string;
  bespokeContractFingerprintVersion?: string;
  bespokeContractFingerprintDomain?: string;
  presetOverrides?: RoutingOverrideField[];
  presetOverrideReasonHash?: string;
  capabilities?: GafferCapability[];
  commsContractHash?: string;
  taskGrade?: string;
  domainRequirements?: string[];
  topology?: Topology;
  tier?: string;
  reasoning?: string;
  posture?: string;
  modelDelta?: ModelDeltaEvidence;
}

interface HarnessCompositionState {
  baseSystemPrompt: string;
  cwd: string;
  evidence: HarnessCompositionEvidence;
  routingRequest?: RoutingRequest;
  capabilities?: readonly GafferCapability[];
  routeBase: Options;
  initialProvider?: ProviderId;
  initialModel?: string;
  initialEffort?: Effort;
  omitModelDeltaReason?: string;
}

const harnessComposition = new WeakMap<object, HarnessCompositionState>();
const appliedEvidence = new WeakMap<object, HarnessCompositionEvidence>();
const harnessActivityRenewers = new WeakMap<object, () => void>();
interface HarnessAuthoritySeal {
  provider: ProviderId;
  optionKeys: readonly string[];
  systemPrompt: string;
  routingRequest: RoutingRequest;
  capabilities: readonly GafferCapability[];
  evidence: HarnessCompositionEvidence;
  env: object;
  mcpServers: object;
  mcpServerEntries: Array<[string, unknown]>;
  northServer: object;
  tools?: unknown;
  allowedTools: unknown;
  disallowedTools?: unknown;
  settingSources?: unknown;
  strictMcpConfig?: unknown;
  permissionMode?: unknown;
  agentId: string;
  managedLane: "1";
  topology: Topology;
  cwd: string;
  effort?: Effort;
  model?: string;
  maxTurns?: number;
}
const harnessAuthoritySeals = new WeakMap<object, HarnessAuthoritySeal>();
interface AuthoringHookSealEntry {
  matcher?: string;
  hooks: unknown[];
}
interface AuthoringHookSeal {
  topology?: string;
  entries: AuthoringHookSealEntry[];
  postEntries: AuthoringHookSealEntry[];
  mcpServers: Array<[string, unknown]>;
}
const authoringHookSeals = new WeakMap<object, AuthoringHookSeal>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sealHarnessAuthority(options: Options, provider: ProviderId): void {
  const raw = options as any;
  if (!raw.northRoutingRequest || !raw.northCapabilities) return;
  const evidence = appliedEvidence.get(options as object);
  const northServer = raw.mcpServers?.north;
  if (!evidence || typeof raw.systemPrompt !== "string"
      || !raw.env || !northServer || typeof raw.cwd !== "string") return;
  harnessAuthoritySeals.set(options as object, {
    provider,
    optionKeys: Object.freeze(Object.keys(raw).sort()),
    systemPrompt: raw.systemPrompt,
    routingRequest: raw.northRoutingRequest,
    capabilities: raw.northCapabilities,
    evidence,
    env: raw.env,
    mcpServers: raw.mcpServers,
    mcpServerEntries: Object.entries(raw.mcpServers),
    northServer,
    tools: raw.tools,
    allowedTools: raw.allowedTools,
    disallowedTools: raw.disallowedTools,
    settingSources: raw.settingSources,
    strictMcpConfig: raw.strictMcpConfig,
    permissionMode: raw.permissionMode,
    agentId: raw.env.AGENT_ID,
    managedLane: raw.env.NORTH_MANAGED_LANE,
    topology: raw.env.AGENT_TOPOLOGY,
    cwd: raw.cwd,
    effort: raw.effort,
    model: raw.model,
    maxTurns: raw.maxTurns,
  });
}

/** Exact harness-owned authority receipt consumed by both provider adapters. */
export function hasCanonicalHarnessAuthority(options: Options, provider: ProviderId): boolean {
  const raw = options as any;
  const seal = harnessAuthoritySeals.get(options as object);
  const mcpServerEntries = Object.entries(raw.mcpServers ?? {});
  const optionKeys = Object.keys(raw).sort();
  return Boolean(
    seal
    && seal.provider === provider
    && optionKeys.length === seal.optionKeys.length
    && optionKeys.every((key, index) => key === seal.optionKeys[index])
    && raw.systemPrompt === seal.systemPrompt
    && raw.northRoutingRequest === seal.routingRequest
    && raw.northCapabilities === seal.capabilities
    && appliedEvidence.get(options as object) === seal.evidence
    && raw.env === seal.env
    && raw.mcpServers === seal.mcpServers
    && mcpServerEntries.length === seal.mcpServerEntries.length
    && mcpServerEntries.every(([name, server], index) =>
      name === seal.mcpServerEntries[index]?.[0]
      && server === seal.mcpServerEntries[index]?.[1])
    && raw.mcpServers?.north === seal.northServer
    && raw.tools === seal.tools
    && raw.allowedTools === seal.allowedTools
    && raw.disallowedTools === seal.disallowedTools
    && raw.settingSources === seal.settingSources
    && raw.strictMcpConfig === seal.strictMcpConfig
    && raw.permissionMode === seal.permissionMode
    && raw.env.AGENT_ID === seal.agentId
    && raw.env.NORTH_MANAGED_LANE === seal.managedLane
    && raw.env.AGENT_TOPOLOGY === seal.topology
    && raw.cwd === seal.cwd
    && raw.effort === seal.effort
    && raw.model === seal.model
    && raw.maxTurns === seal.maxTurns,
  );
}

function sealAuthoringHooks(options: Options): void {
  const entries = (options.hooks as any)?.PreToolUse;
  const postEntries = (options.hooks as any)?.PostToolUse;
  if (!Array.isArray(entries) || !Array.isArray(postEntries)) return;
  const snapshot = (values: any[]): AuthoringHookSealEntry[] =>
    values.map((entry: any) => ({
      matcher: entry?.matcher,
      hooks: Array.isArray(entry?.hooks) ? [...entry.hooks] : [],
    }));
  authoringHookSeals.set(options as object, {
    topology: (options.env as any)?.AGENT_TOPOLOGY,
    entries: snapshot(entries),
    postEntries: snapshot(postEntries),
    mcpServers: Object.entries((options.mcpServers as any) ?? {}),
  });
}

function inheritAuthoringHookSeal(source: Options, target: Options): void {
  const seal = authoringHookSeals.get(source as object);
  if (seal) authoringHookSeals.set(target as object, seal);
}

/**
 * Provider admission proof that the SDK-only guard chain and exact MCP server
 * instances came from harnessOptions and were not replaced before the model turn.
 */
export function hasCanonicalAuthoringHooks(options: Options): boolean {
  const seal = authoringHookSeals.get(options as object);
  const hookSurface = options.hooks as any;
  const entries = (options.hooks as any)?.PreToolUse;
  const postEntries = (options.hooks as any)?.PostToolUse;
  const mcpServers = Object.entries((options.mcpServers as any) ?? {});
  if (!seal
      || !hookSurface
      || Object.keys(hookSurface).sort().join(",") !== "PostToolUse,PreToolUse"
      || (options.env as any)?.AGENT_TOPOLOGY !== seal.topology
      || !Array.isArray(entries)
      || !Array.isArray(postEntries)
      || entries.length !== seal.entries.length
      || postEntries.length !== seal.postEntries.length
      || mcpServers.length !== seal.mcpServers.length
      || mcpServers.some(([name, server], index) =>
        name !== seal.mcpServers[index][0] || server !== seal.mcpServers[index][1])) return false;
  const exactEntries = (actualEntries: any[], expectedEntries: AuthoringHookSealEntry[]) =>
    expectedEntries.every((expected, index) => {
      const actual = actualEntries[index];
      const expectedKeys = expected.matcher === undefined ? ["hooks"] : ["hooks", "matcher"];
      return actual && typeof actual === "object" && !Array.isArray(actual)
        && Object.keys(actual).sort().join(",") === expectedKeys.join(",")
        && actual.matcher === expected.matcher
        && Array.isArray(actual?.hooks)
        && actual.hooks.length === expected.hooks.length
        && actual.hooks.every((hook: unknown, hookIndex: number) =>
          hook === expected.hooks[hookIndex]);
    });
  return exactEntries(entries, seal.entries)
    && exactEntries(postEntries, seal.postEntries);
}

/** Compose Gaffer's authority contracts. Missing canonical artifacts are fatal. */
export function gafferAppendix(metadata: RoutingDraft | undefined, cwd = process.cwd()): {
  appendix: string;
  evidence: HarnessCompositionEvidence;
} {
  if (!metadata || Object.keys(metadata).length === 0) return { appendix: "", evidence: {} };
  // Axis-only appendix composition remains useful for native/prompt tests, but
  // selecting a managed role is an execution-grade act and therefore admits
  // only the complete request before any authority prompt is constructed.
  const admitted = metadata.role || metadata.composition
    ? admitRoutingRequest(metadata, "Gaffer appendix")
    : undefined;
  const routing: RoutingDraft = admitted ?? metadata;
  const blocks: string[] = [];
  const evidence: HarnessCompositionEvidence = {};
  if (admitted) {
    const composition = admitted.composition;
    if (composition.id !== admitted.role)
      throw new Error(`Gaffer composition ${composition.id} does not match role ${admitted.role}`);
    if (composition.kind === "preset") {
      const role = exactSectionFence(resolve(gafferDocs(), "roles.md"), admitted.role, `role:${admitted.role}`);
      blocks.push(`## Gaffer role contract — preset:${admitted.role}\n${role}`);
      if (composition.overrides.length) {
        blocks.push([
          "## Gaffer preset override",
          `Axes changed: ${composition.overrides.join(", ")}.`,
          `Reason: ${composition.overrideReason}`,
        ].join("\n"));
        evidence.presetOverrides = [...composition.overrides];
        evidence.presetOverrideReasonHash = createHash("sha256")
          .update(composition.overrideReason!).digest("hex");
      }
    } else {
      blocks.push(`## Gaffer role contract — bespoke:${composition.id}\n${bespokeRoleBlock(admitted)}`);
      evidence.bespokeContractHash = bespokeContractFingerprint(composition.contract);
      evidence.bespokeContractFingerprintVersion = BESPOKE_FINGERPRINT_VERSION;
      evidence.bespokeContractFingerprintDomain = BESPOKE_FINGERPRINT_DOMAIN;
    }
    evidence.roleKind = composition.kind;
    evidence.roleId = composition.id;
    evidence.capabilities = composition.kind === "bespoke"
      ? canonicalGafferCapabilities(composition.contract.capabilities)
      : gafferCapabilities(admitted);
    const comms = exactSectionFence(resolve(gafferDocs(), "comms.md"), "universal", "comms:universal");
    blocks.push(`## Gaffer communication contract — universal\n${comms}`);
    evidence.commsContractHash = createHash("sha256").update(comms).digest("hex");
  }
  if (routing.taskGrade) {
    const block = exactSectionFence(
      resolve(gafferDocs(), "task-grades.md"), routing.taskGrade, `task-grade:${routing.taskGrade}`,
    );
    blocks.push(`## Gaffer task grade — ${routing.taskGrade}\n${block}`);
    evidence.taskGrade = routing.taskGrade;
  }
  if (routing.domainRequirements?.length) {
    blocks.push(domainContextGate(routing.domainRequirements, cwd));
    evidence.domainRequirements = [...routing.domainRequirements];
  }
  if (routing.topology) {
    const block = exactSectionFence(
      resolve(gafferDocs(), "topologies.md"), routing.topology, `topology:${routing.topology}`,
    );
    blocks.push(`## Gaffer topology — ${routing.topology}\n${block}`);
    evidence.topology = routing.topology;
  }
  if (routing.tier || routing.reasoning) {
    blocks.push([
      "## Gaffer capacity route",
      `Semantic tier: ${routing.tier ?? "unselected"}.`,
      `Reasoning: ${routing.reasoning ?? "unselected"}.`,
      "Capacity does not widen the role, grade, topology, or domain authority above.",
    ].join("\n"));
    evidence.tier = routing.tier;
    evidence.reasoning = routing.reasoning;
  }
  if (routing.posture) {
    const block = exactSectionFence(
      resolve(gafferDocs(), "postures.md"), routing.posture, `posture:${routing.posture}`,
    );
    blocks.push(`## Gaffer posture — ${routing.posture}\n${block}`);
    evidence.posture = routing.posture;
  }
  return { appendix: blocks.length ? `\n\n${blocks.join("\n\n")}` : "", evidence };
}

function modelDeltaAppendix(provider?: ProviderId, model?: string, omitReason?: string): {
  appendix: string;
  evidence: ModelDeltaEvidence;
} {
  if (omitReason) return { appendix: "", evidence: { provider, model, kind: "omitted", reason: omitReason } };
  if (!provider || !model) return {
    appendix: "", evidence: { provider, model, kind: "omitted", reason: !provider ? "provider_unresolved" : "model_unresolved" },
  };
  const delta = resolveModelDelta(provider, model);
  if (delta.kind === "none") return {
    appendix: "", evidence: { provider, model, kind: "none", reason: delta.reason },
  };
  const block = exactFirstFence(delta.absolutePath!, `model-delta:${provider}:${model}`);
  return {
    appendix: `\n\n## Gaffer exact-model delta — ${provider}:${model}\n${block}`,
    evidence: { provider, model, kind: "calibrated", path: delta.path },
  };
}

/** Rebuild a harness prompt for an exact provider/model route; never inherit a stale delta. */
export function applyHarnessRoute(
  options: Options,
  provider: ProviderId,
  model?: string,
  effort?: Effort,
): {
  options: Options;
  evidence?: HarnessCompositionEvidence;
} {
  const state = harnessComposition.get(options as object);
  if (!state) return { options };
  const sourceSeal = harnessAuthoritySeals.get(options as object);
  if (sourceSeal && !hasCanonicalHarnessAuthority(options, sourceSeal.provider))
    throw new Error("harness authority source mutated before route application");
  if (state.routingRequest
      && ((options as any).northRoutingRequest !== state.routingRequest
        || (options as any).northCapabilities !== state.capabilities
        || !hasCanonicalAuthoringHooks(options))) {
    throw new Error("harness composition root mutated before route application");
  }
  const concreteModel = resolveModelAlias(provider, model);
  const delta = modelDeltaAppendix(provider, concreteModel, state.omitModelDeltaReason);
  const systemPrompt = state.baseSystemPrompt
    + providerInstructionAppendix(provider, state.cwd)
    + delta.appendix;
  if (provider === "anthropic") assertCanonicalGlobalAgentsExactlyOnce(systemPrompt);
  const next = {
    ...state.routeBase,
    model: concreteModel ?? state.initialModel,
    effort: effort ?? state.initialEffort,
    systemPrompt,
  } as Options;
  harnessComposition.set(next as object, state);
  const renewActivity = harnessActivityRenewers.get(options as object);
  if (renewActivity) harnessActivityRenewers.set(next as object, renewActivity);
  inheritAuthoringHookSeal(options, next);
  const evidence = { ...state.evidence, modelDelta: delta.evidence };
  appliedEvidence.set(next as object, deepFreeze(evidence));
  sealHarnessAuthority(next, provider);
  return { options: next, evidence };
}

export function harnessRouteSeed(options: Options): { provider?: ProviderId; model?: string } | undefined {
  const state = harnessComposition.get(options as object);
  return state ? { provider: state.initialProvider, model: state.initialModel } : undefined;
}

export function harnessCompositionEvidence(options: Options): HarnessCompositionEvidence | undefined {
  return appliedEvidence.get(options as object) ?? harnessComposition.get(options as object)?.evidence;
}

/** Provider-neutral activity heartbeat used by both SDK and CLI adapters. */
export function renewHarnessPresence(options: Options): void {
  harnessActivityRenewers.get(options as object)?.();
}

/** Compatibility name for callers that only need role/posture blocks. */
export function praxisAppendix(_model?: string, role?: string, posture?: string): string {
  const blocks: string[] = [];
  if (role) blocks.push(`## Praxis — role: ${role}\n${exactSectionFence(
    resolve(gafferDocs(), "roles.md"), role, `role:${role}`,
  )}`);
  if (posture) blocks.push(`## Praxis — posture: ${posture}\n${exactSectionFence(
    resolve(gafferDocs(), "postures.md"), posture, `posture:${posture}`,
  )}`);
  return blocks.length ? `\n\n${blocks.join("\n\n")}` : "";
}

// AGENT_CAVEMAN=full|lite|off — appends terse-output instruction to every spawned agent.
// Per-spawn override rides in via HarnessOpts.caveman (spawn tool's `caveman` param);
// env-or-full remains the fallback ONLY when no resolved mode was passed.
export function cavemanAppendix(mode?: string): string {
  mode = mode ?? process.env.AGENT_CAVEMAN ?? "full";
  if (mode === "full") return "\n\n" +
    "CAVEMAN OUTPUT MODE (full) — respond terse like smart caveman. Drop articles (a/an/the), " +
    "filler (just/really/basically/actually), pleasantries, hedging. Fragments OK. Short synonyms. " +
    "Technical terms exact. ALL technical substance stays. Code blocks, commit messages, quoted errors: " +
    "write NORMAL, never compressed. Security warnings and irreversible-action confirmations: write normal, clear.";
  if (mode === "lite") return "\n\n" +
    "CAVEMAN OUTPUT MODE (lite) — terse. No filler, no pleasantries, minimal hedging. " +
    "Technical substance exact. Code/commits/quoted errors/security content: normal prose.";
  return "";
}

// SDK worker authoring-guard parity (see authoring-guards.ts for the WHY). The SDK
// never loads ~/.claude/settings.json, so we re-run the SAME PreToolUse guard scripts
// the interactive matchers run and translate their output into HookJSONOutput.
// PARITY SOURCE: ~/code/nixos-config/dotfiles/claude/settings.json (PreToolUse). These
// lists are the POST-parity target — a parallel lane is adding north-clock-guard to
// the interactive Bash matcher; keep both in lockstep with settings.json.
//   Edit|Write|MultiEdit -> code-upstream, firn, north-clock
//   Bash                 -> tripwire, firn, north-clock
// Optional advisory guards are existence-checked once. The clock path is
// retained unconditionally: missing/unexecutable is unavailable and denies.
const EDIT_GUARDS = resolveManagedGuardChain([
  "code-upstream-guard.sh", "firn-guard.sh", "north-clock-guard.sh",
]);
const BASH_GUARDS = resolveManagedGuardChain([
  "tripwire-guard.sh", "firn-guard.sh", "north-clock-guard.sh",
]);
const WORKER_BASH_GUARDS = resolveManagedGuardChain([
  "agent-spawn-guard.sh", "tripwire-guard.sh", "firn-guard.sh", "north-clock-guard.sh",
]);
const REQUIRED_CLOCK_GUARD = resolve(HOOKS_DIR, "north-clock-guard.sh");

// One matcher's callback: run its guard chain (first deny wins) over the hook input,
// translate to HookJSONOutput. A deny blocks THIS tool call (permissionDecision:deny)
// but does NOT halt the agent (`continue` stays default-true) — the worker sees the
// reason and can clock in + retry, exactly like the interactive deny. The canonical
// clock guard must positively classify every matched tool envelope: a live clock
// yields "allow", a proven nonbillable envelope yields "not-applicable", and every
// missing/empty/error/timeout/unknown result denies unavailable. This keeps shell
// semantics in one guard instead of duplicating an inevitably incomplete classifier.
async function guardHook(self: string, scripts: string[], input: unknown, topology?: Topology) {
  const env = topology ? { ...process.env, AGENT_TOPOLOGY: topology } : process.env;
  if (authoringGuardsOff(env)) return { continue: true };
  const deny = (reason: string) => {
    recordDenial(self, reason, input);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: reason,
      },
    };
  };
  try {
    const d = await evaluateGuards(
      scripts,
      input,
      10000,
      env,
      new Set([REQUIRED_CLOCK_GUARD]),
    );
    if (d.decision === "deny") {
      // Durable trail: record the denial as a `kind guard_denial` fact so a worker
      // block is learnable after the fact (which agent, which guard, what target).
      // Fire-and-forget — never delay or break the tool call the guard decided.
      return deny(d.reason);
    }
  } catch { return deny("billable_clock_guard_unavailable"); }
  return { continue: true };
}

export function harnessOptions(o: HarnessOpts): Options {
  const cwd = o.cwd ?? process.cwd();
  const metadata = o.routingMetadata
    ? admitRoutingRequest(o.routingMetadata, "managed North harness")
    : undefined;
  if (o.role !== undefined && (!metadata || o.role !== metadata.role))
    throw new Error("harness role compatibility alias requires an equal complete routingMetadata request");
  if (o.posture !== undefined && (!metadata || o.posture !== metadata.posture))
    throw new Error("harness posture compatibility alias requires an equal complete routingMetadata request");
  if (metadata && o.effort !== undefined && o.effort !== metadata.reasoning)
    throw new Error("harness effort compatibility alias must equal routingMetadata.reasoning");
  const effectiveEffort = metadata?.reasoning ?? o.effort;
  const effectiveModel = o.provider && metadata
    ? resolveTier(o.provider, metadata.tier, o.model, effectiveEffort).model
    : o.model;
  const topology = metadata?.topology;
  const gaffer = gafferAppendix(metadata, cwd);
  const capabilities = gaffer.evidence.capabilities;
  const baseSystemPrompt = withCoordination(o.self, o.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, cwd)
    + gaffer.appendix + cavemanAppendix(o.caveman) + esoAppendix();
  // Orchestration is positive authority, never an ambient default. A lane with
  // no topology remains prompt-neutral but receives coordination-only tools.
  const orchestrationAllowed = topology === "orchestrator"
    && capabilities?.includes("coordination") === true;
  const policy = capabilities ? managedToolPolicy(capabilities) : undefined;
  const disallowedTools = policy?.disallowedTools ?? [...new Set([
    ...NATIVE_AGENT_TOOLS,
    ...(orchestrationAllowed ? [] : ORCHESTRATION_TOOLS),
  ])];
  const allowedTools = policy?.allowedTools ?? [...new Set([
    ...(o.extraTools ?? []).filter((name) => !disallowedTools.includes(name)),
    ...COORDINATION_TOOLS,
    ...(orchestrationAllowed ? ORCHESTRATION_TOOLS : []),
  ])];
  const enforcementTopology: Topology = orchestrationAllowed ? "orchestrator" : "worker";
  const {
    NORTH_DISPATCH_DRIVER_PRECLAIMED: _inheritedPreclaim,
    NORTH_RUN_ID: _inheritedRun,
    NORTH_THREAD_ID: _inheritedThread,
    NORTH_RUN_CAPABILITY: _inheritedCapability,
    NORTH_MANAGED_LANE: _inheritedManagedLane,
    NORTH_CODEX_BIN: _inheritedCodexOverride,
    ...ambientEnv
  } = process.env;
  const childEnv = Object.freeze({
    ...ambientEnv,
    AGENT_ID: o.self,
    AGENT_TOPOLOGY: enforcementTopology,
    // Sealed authority marker consumed by the system-managed Codex lifecycle
    // wrappers. Ambient callers cannot inherit or forge managed-lane behavior.
    NORTH_MANAGED_LANE: "1",
    ...(o.deliveryRun ? {
      NORTH_RUN_ID: o.deliveryRun.runId,
      NORTH_THREAD_ID: o.deliveryRun.threadId,
      NORTH_RUN_CAPABILITY: o.deliveryRun.capability,
    } : {}),
    // One explicit value feeds lane presence, provider CLI, North MCP, and
    // admission. Never let a later process ambient choose a different graph.
    NORTH_PORT: northPort(),
  });
  // An injected registrar denotes a hermetic boundary: never pair it with a
  // real graph renewer implicitly. Tests/adapters that want both injected
  // phases supply presenceRenewer explicitly. Production (both omitted) keeps
  // the real register + activity heartbeat pair.
  const presenceRenewer = o.presenceRenewer === false
    ? undefined
    : o.presenceRenewer ?? (o.presenceRegistrar === undefined ? renewPresence : undefined);
  const readonlyShell = capabilities?.includes("shell.readonly") === true;
  const northMcpEnv = Object.freeze(
    managedNorthMcpEnvironment({ ...childEnv, NORTH_BIN: ENGINE }),
  );
  const northMcpServer = Object.freeze({
    type: "stdio", command: MCP,
    args: Object.freeze([]) as unknown as string[],
    env: northMcpEnv,
  });
  const mcpServers = Object.freeze({
    north: northMcpServer,
    ...(orchestrationAllowed
      ? { "north-peer": Object.freeze(peerCommandServer(o.self)) }
      : {}),
    // Compile the minimum authority surface for every retry-safe route up
    // front. Codex ignores Claude SDK tool allowlists and independently
    // enforces --sandbox read-only; an Anthropic fallback must still inherit
    // denied native Bash plus North's isolated read-only shell.
    ...(readonlyShell
      ? { [READONLY_SHELL_SERVER]: Object.freeze(readonlyShellServer(cwd)) }
      : {}),
  });
  const sealedTools = policy
    ? Object.freeze([...policy.tools]) as unknown as string[]
    : undefined;
  const sealedAllowedTools = Object.freeze([...allowedTools]) as unknown as string[];
  const sealedDisallowedTools = disallowedTools.length
    ? Object.freeze([...disallowedTools]) as unknown as string[]
    : undefined;
  const sealedSettingSources = policy
    ? Object.freeze([]) as unknown as NonNullable<Options["settingSources"]>
    : undefined;
  const initialInstructionAppendix = o.provider
    ? ""
    : globalLawsAppendix() + projectAgentsAppendix(cwd);
  const initialSystemPrompt = baseSystemPrompt + initialInstructionAppendix;
  if (!o.provider) assertCanonicalGlobalAgentsExactlyOnce(initialSystemPrompt);
  const options = {
    mcpServers,
    ...(policy ? {
      tools: sealedTools,
      settingSources: sealedSettingSources,
      strictMcpConfig: true,
    } : {}),
    allowedTools: sealedAllowedTools,
    ...(sealedDisallowedTools ? { disallowedTools: sealedDisallowedTools } : {}),
    model: o.provider ? resolveModelAlias(o.provider, effectiveModel) : effectiveModel,
    effort: effectiveEffort,
    env: childEnv,
    permissionMode: capabilities && !capabilities.includes("filesystem.write") ? "default" : "acceptEdits",
    ...(capabilities ? {
      northCapabilities: Object.freeze([...capabilities]) as unknown as GafferCapability[],
    } : {}),
    ...(metadata ? { northRoutingRequest: metadata } : {}),
    cwd,
    systemPrompt: initialSystemPrompt,
    maxTurns: o.maxTurns ?? (Number(process.env.AGENT_MAX_TURNS) || 200),
    hooks: {
      // PreToolUse authoring-guard parity — the fix for worker edits running with
      // ZERO guards (north-clock-guard never fired for a worker edit). Matchers +
      // guard chains mirror settings.json; first deny in a chain blocks the tool.
      PreToolUse: [
        { matcher: "Edit|Write|MultiEdit", hooks: [async (input: unknown) => guardHook(o.self, EDIT_GUARDS, input)] },
        { matcher: "Bash", hooks: [async (input: unknown) => guardHook(
          o.self, orchestrationAllowed ? BASH_GUARDS : WORKER_BASH_GUARDS, input, enforcementTopology,
        )] },
      ],
      // Presence heartbeat: renew the lease on tool activity (F2). Fire-and-forget +
      // never block/fail the tool call; always continue. PRESERVED exactly.
      PostToolUse: [{ hooks: [async () => {
        presenceRenewer?.(o.self);
        return { continue: true };
      }] }],
    },
  } as Options & { northCapabilities?: GafferCapability[] };
  // Hooks are executable authority, not an advisory bag. Freeze the exact
  // harness-owned surface and make every routed provider rebuild from this
  // canonical root rather than spreading a caller-mutated retry object.
  deepFreeze((options as any).hooks);
  const state: HarnessCompositionState = {
    baseSystemPrompt,
    cwd,
    evidence: gaffer.evidence,
    routingRequest: metadata,
    capabilities: (options as any).northCapabilities,
    routeBase: Object.freeze({ ...options }) as Options,
    initialProvider: o.provider,
    initialModel: effectiveModel,
    initialEffort: effectiveEffort,
    omitModelDeltaReason: o.omitModelDeltaReason,
  };
  harnessComposition.set(options as object, state);
  if (presenceRenewer)
    harnessActivityRenewers.set(options as object, () => presenceRenewer(o.self));
  appliedEvidence.set(options as object, deepFreeze(gaffer.evidence));
  sealAuthoringHooks(options);
  // Presence is an assertion that a runnable lane exists. Every synchronous
  // prompt/bootstrap contract for the initial route must succeed first, or a
  // malformed AGENTS/Gaffer/model source would leave a ghost roster entry.
  const routedOptions = o.provider
    ? applyHarnessRoute(options, o.provider, effectiveModel, effectiveEffort).options
    : options;
  if (o.presenceRegistrar !== false) (o.presenceRegistrar ?? registerPresence)(o.self, cwd);
  return routedOptions;
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are a north agent on a shared fact graph. Prefer native north coordination " +
  "tools over editing coordination state: capture/tell to record work and ready/next " +
  "to find it. Your Gaffer topology contract, when present, is the sole source of " +
  "delegation authority. Acquire before editing shared code. Report concisely.";
