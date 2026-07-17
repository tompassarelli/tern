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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveGuard, evaluateGuards } from "./authoring-guards";
import { recordDenial } from "./guard-log";
import { resolveModelAlias, resolveModelDelta } from "./providers/catalog";
import type { ProviderId } from "./providers/types";
import type { RoutingMetadata, RoutingOverrideField, Topology } from "./routing-metadata";
import { applyGafferStaffing, gafferCapabilities } from "./gaffer-staffing";
import { validateRoutingMetadata } from "./routing-metadata";
import type { GafferCapability } from "./gaffer-capabilities";
import {
  BESPOKE_FINGERPRINT_DOMAIN, BESPOKE_FINGERPRINT_VERSION,
  bespokeContractFingerprint, canonicalGafferCapabilities,
} from "./bespoke-contract";
import { assertCoordinationAuthority } from "./topology-authority";

// sdk/src/harness.ts -> repo root (~/code/north).
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
  if (presentRouting.length !== 1 && presentRouting.length !== PEER_ROUTING_FIELDS.length) {
    throw new Error(
      `${op} routing must be role-only (canonical preset hydration) or the complete `
      + `${PEER_ROUTING_FIELDS.join(", ")} envelope`,
    );
  }
  const metadata = Object.fromEntries(
    PEER_ROUTING_FIELDS.filter((field) => Object.hasOwn(args, field)).map((field) => [field, args[field]]),
  ) as RoutingMetadata;
  applyGafferStaffing(validateRoutingMetadata(metadata));
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
const COORDINATION_TOOLS = [
  "mcp__north__capture",
  "mcp__north__tell",
  "mcp__north__show",
  "mcp__north__ready",
  "mcp__north__next",
  "mcp__north__board",
  "mcp__north__plate",
];
const ORCHESTRATION_TOOLS = [
  "mcp__north__dispatch",
  "mcp__north__spawn",
  "mcp__north-peer__command_peer",
];
const NATIVE_AGENT_TOOLS = ["Agent", "Task", "Workflow"];
const CAPABILITY_TOOLS: Record<GafferCapability, string[]> = {
  "filesystem.read": ["Read"],
  "filesystem.search": ["Grep", "Glob"],
  "filesystem.write": ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  shell: ["Bash"],
  "shell.readonly": ["Bash"],
  web: ["WebSearch", "WebFetch"],
  coordination: ORCHESTRATION_TOOLS,
};
const ALL_CAPABILITY_TOOLS = [...new Set(Object.values(CAPABILITY_TOOLS).flat())];

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
  routingMetadata?: RoutingMetadata;
  /** A live run may change models in-place, so no exact-model delta can remain valid. */
  omitModelDeltaReason?: string;
  caveman?: string; // resolved terse-output mode (off|lite|full); fallback env-or-full when omitted
  cwd?: string; // provider working directory; dispatch resolves this from thread repo facts
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
    "Mini-syntax (full spec: ~/code/north/sdk/src/vendor/eso/SPEC.md):\n" +
    "  !eso/1              ← required header\n" +
    "  name=value          ← scalar field\n" +
    "  items[N]{a,b,c}     ← N records, schema declared once; N is a checksum\n" +
    "  val1\\tval2\\tval3   ← one tab-delimited row per record (strings with tabs/newlines use JSON quoting)";
}

// AGENT_LAWS=on|off — appends the user's provider-neutral global AGENTS.md to every spawned agent.
// A custom-string systemPrompt bypasses the SDK's claude_code preset, which is the
// only path that injects CLAUDE.md — so without this, workers get NONE of the
// global laws interactive sessions live under. Read per spawn (~/.claude/CLAUDE.md
// is an out-of-store symlink into nixos-config, so it's always the current text —
// one source, no drift). Fail-open: unreadable file must never block a spawn.
function globalLawsAppendix(): string {
  if ((process.env.AGENT_LAWS ?? "on") !== "on") return "";
  try {
    const candidates = [
      `${process.env.HOME}/.codex/AGENTS.md`,
      `${process.env.HOME}/.agents/AGENTS.md`,
      `${process.env.HOME}/.claude/CLAUDE.md`, // migration fallback
    ];
    const path = candidates.find((p) => { try { readFileSync(p); return true; } catch { return false; } });
    if (!path) return "";
    const laws = readFileSync(path, "utf8").trim();
    return laws
      ? `\n\n## Global laws — ${path} (binds every provider and agent)\n\n` + laws
      : "";
  } catch {
    return "";
  }
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

function bespokeRoleBlock(metadata: RoutingMetadata): string {
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
  evidence: HarnessCompositionEvidence;
  initialProvider?: ProviderId;
  initialModel?: string;
  omitModelDeltaReason?: string;
}

const harnessComposition = new WeakMap<object, HarnessCompositionState>();
const appliedEvidence = new WeakMap<object, HarnessCompositionEvidence>();

/** Compose Gaffer's authority contracts. Missing canonical artifacts are fatal. */
export function gafferAppendix(metadata: RoutingMetadata | undefined, cwd = process.cwd()): {
  appendix: string;
  evidence: HarnessCompositionEvidence;
} {
  if (!metadata || Object.keys(metadata).length === 0) return { appendix: "", evidence: {} };
  const blocks: string[] = [];
  const evidence: HarnessCompositionEvidence = {};
  if (metadata.role) {
    const composition = metadata.composition;
    if (!composition) throw new Error(`Gaffer role ${metadata.role} has no composition provenance`);
    if (composition.id !== metadata.role)
      throw new Error(`Gaffer composition ${composition.id} does not match role ${metadata.role}`);
    if (composition.kind === "preset") {
      const role = exactSectionFence(resolve(gafferDocs(), "roles.md"), metadata.role, `role:${metadata.role}`);
      blocks.push(`## Gaffer role contract — preset:${metadata.role}\n${role}`);
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
      blocks.push(`## Gaffer role contract — bespoke:${composition.id}\n${bespokeRoleBlock(metadata)}`);
      evidence.bespokeContractHash = bespokeContractFingerprint(composition.contract);
      evidence.bespokeContractFingerprintVersion = BESPOKE_FINGERPRINT_VERSION;
      evidence.bespokeContractFingerprintDomain = BESPOKE_FINGERPRINT_DOMAIN;
    }
    evidence.roleKind = composition.kind;
    evidence.roleId = composition.id;
    evidence.capabilities = composition.kind === "bespoke"
      ? canonicalGafferCapabilities(composition.contract.capabilities)
      : gafferCapabilities(metadata);
    const comms = exactSectionFence(resolve(gafferDocs(), "comms.md"), "universal", "comms:universal");
    blocks.push(`## Gaffer communication contract — universal\n${comms}`);
    evidence.commsContractHash = createHash("sha256").update(comms).digest("hex");
  } else if (metadata.composition) {
    throw new Error("Gaffer composition requires a role");
  }
  if (metadata.taskGrade) {
    const block = exactSectionFence(
      resolve(gafferDocs(), "task-grades.md"), metadata.taskGrade, `task-grade:${metadata.taskGrade}`,
    );
    blocks.push(`## Gaffer task grade — ${metadata.taskGrade}\n${block}`);
    evidence.taskGrade = metadata.taskGrade;
  }
  if (metadata.domainRequirements?.length) {
    blocks.push(domainContextGate(metadata.domainRequirements, cwd));
    evidence.domainRequirements = [...metadata.domainRequirements];
  }
  if (metadata.topology) {
    const block = exactSectionFence(
      resolve(gafferDocs(), "topologies.md"), metadata.topology, `topology:${metadata.topology}`,
    );
    blocks.push(`## Gaffer topology — ${metadata.topology}\n${block}`);
    evidence.topology = metadata.topology;
  }
  if (metadata.tier || metadata.reasoning) {
    blocks.push([
      "## Gaffer capacity route",
      `Semantic tier: ${metadata.tier ?? "unselected"}.`,
      `Reasoning: ${metadata.reasoning ?? "unselected"}.`,
      "Capacity does not widen the role, grade, topology, or domain authority above.",
    ].join("\n"));
    evidence.tier = metadata.tier;
    evidence.reasoning = metadata.reasoning;
  }
  if (metadata.posture) {
    const block = exactSectionFence(
      resolve(gafferDocs(), "postures.md"), metadata.posture, `posture:${metadata.posture}`,
    );
    blocks.push(`## Gaffer posture — ${metadata.posture}\n${block}`);
    evidence.posture = metadata.posture;
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
export function applyHarnessRoute(options: Options, provider: ProviderId, model?: string): {
  options: Options;
  evidence?: HarnessCompositionEvidence;
} {
  const state = harnessComposition.get(options as object);
  if (!state) return { options };
  const concreteModel = resolveModelAlias(provider, model);
  const delta = modelDeltaAppendix(provider, concreteModel, state.omitModelDeltaReason);
  const next = {
    ...options,
    model: concreteModel ?? options.model,
    systemPrompt: state.baseSystemPrompt + delta.appendix,
  } as Options;
  harnessComposition.set(next as object, state);
  const evidence = { ...state.evidence, modelDelta: delta.evidence };
  appliedEvidence.set(next as object, evidence);
  return { options: next, evidence };
}

export function harnessRouteSeed(options: Options): { provider?: ProviderId; model?: string } | undefined {
  const state = harnessComposition.get(options as object);
  return state ? { provider: state.initialProvider, model: state.initialModel } : undefined;
}

export function harnessCompositionEvidence(options: Options): HarnessCompositionEvidence | undefined {
  return appliedEvidence.get(options as object) ?? harnessComposition.get(options as object)?.evidence;
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
// Resolved (existence-checked) ONCE at module load — a missing script is dropped
// silently so the SDK stays portable on a machine without the nixos-config checkout.
const EDIT_GUARDS = ["code-upstream-guard.sh", "firn-guard.sh", "north-clock-guard.sh"]
  .map(resolveGuard)
  .filter((p): p is string => p !== null);
const BASH_GUARDS = ["tripwire-guard.sh", "firn-guard.sh", "north-clock-guard.sh"]
  .map(resolveGuard)
  .filter((p): p is string => p !== null);
const WORKER_BASH_GUARDS = [
  "agent-spawn-guard.sh", "tripwire-guard.sh", "firn-guard.sh", "north-clock-guard.sh",
]
  .map(resolveGuard)
  .filter((p): p is string => p !== null);

// One matcher's callback: run its guard chain (first deny wins) over the hook input,
// translate to HookJSONOutput. A deny blocks THIS tool call (permissionDecision:deny)
// but does NOT halt the agent (`continue` stays default-true) — the worker sees the
// reason and can clock in + retry, exactly like the interactive deny. Fail-open on any
// internal error so a broken guard never bricks a worker.
async function guardHook(self: string, scripts: string[], input: unknown, topology?: Topology) {
  try {
    const env = topology ? { ...process.env, AGENT_TOPOLOGY: topology } : undefined;
    const d = await evaluateGuards(scripts, input, 10000, env);
    if (d.decision === "deny") {
      // Durable trail: record the denial as a `kind guard_denial` fact so a worker
      // block is learnable after the fact (which agent, which guard, what target).
      // Fire-and-forget — never delay or break the tool call the guard decided.
      recordDenial(self, d.reason, input);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: d.reason,
        },
      };
    }
  } catch {
    /* fail-open */
  }
  return { continue: true };
}

// The single Options builder. dispatch.ts + spawn.ts both route through here.
// Pre-create the engine's git-isolation stub for READ-ONLY lanes. The sandbox
// writes identity-isolation config to `$cwd/.gitconfig` during setup; with the
// whole cwd write-denied, bwrap can only rw-bind that path if the file already
// exists (a bind mount needs a mount point). Best-effort — an existing file is
// left untouched; a failure falls through to the engine's own error surface.
function ensureGitIsolationStub(cwd: string): string {
  const stub = resolve(cwd, ".gitconfig");
  try {
    writeFileSync(stub, "", { flag: "wx" }); // create-only; never truncate
  } catch { /* exists or uncreatable — engine surfaces the real error */ }
  return stub;
}

export function harnessOptions(o: HarnessOpts): Options {
  const cwd = o.cwd ?? process.cwd();
  const metadata = o.routingMetadata ?? (
    o.role || o.posture ? { role: o.role, posture: o.posture as RoutingMetadata["posture"] } : undefined
  );
  const topology = metadata?.topology;
  const gaffer = gafferAppendix(metadata, cwd);
  const capabilities = gaffer.evidence.capabilities;
  const baseSystemPrompt = withCoordination(o.self, o.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, cwd)
    + globalLawsAppendix() + gaffer.appendix + cavemanAppendix(o.caveman) + esoAppendix();
  // Orchestration is positive authority, never an ambient default. A lane with
  // no topology remains prompt-neutral but receives coordination-only tools.
  const orchestrationAllowed = topology === "orchestrator"
    && capabilities?.includes("coordination") === true;
  const selectedCapabilityTools = capabilities
    ? [...new Set(capabilities.flatMap((capability) => CAPABILITY_TOOLS[capability]))]
    : undefined;
  const disallowedTools = [...new Set([
    ...NATIVE_AGENT_TOOLS,
    ...(orchestrationAllowed ? [] : ORCHESTRATION_TOOLS),
    ...(selectedCapabilityTools
      ? ALL_CAPABILITY_TOOLS.filter((toolName) => !selectedCapabilityTools.includes(toolName))
      : []),
  ])];
  const allowedTools = [...new Set([
    ...(selectedCapabilityTools ?? o.extraTools ?? []).filter((name) => !disallowedTools.includes(name)),
    ...COORDINATION_TOOLS,
    ...(orchestrationAllowed ? ORCHESTRATION_TOOLS : []),
  ])];
  const enforcementTopology: Topology = orchestrationAllowed ? "orchestrator" : "worker";
  const { NORTH_DISPATCH_DRIVER_PRECLAIMED: _inheritedPreclaim, ...ambientEnv } = process.env;
  const childEnv = {
    ...ambientEnv,
    AGENT_ID: o.self,
    AGENT_TOPOLOGY: enforcementTopology,
  };
  if (o.presenceRegistrar !== false) (o.presenceRegistrar ?? registerPresence)(o.self, cwd);
  // An injected registrar denotes a hermetic boundary: never pair it with a
  // real graph renewer implicitly. Tests/adapters that want both injected
  // phases supply presenceRenewer explicitly. Production (both omitted) keeps
  // the real register + activity heartbeat pair.
  const presenceRenewer = o.presenceRenewer === false
    ? undefined
    : o.presenceRenewer ?? (o.presenceRegistrar === undefined ? renewPresence : undefined);
  const readonlyShell = capabilities?.includes("shell.readonly") === true;
  const options = {
    mcpServers: {
      north: { type: "stdio", command: MCP, args: [], env: { ...childEnv, NORTH_BIN: ENGINE } },
      ...(orchestrationAllowed ? { "north-peer": peerCommandServer(o.self) } : {}),
    },
    allowedTools,
    ...(disallowedTools.length ? { disallowedTools } : {}),
    model: o.provider ? resolveModelAlias(o.provider, o.model) : o.model,
    effort: o.effort, // the reasoning knob spawn.ts used to drop on the floor
    env: childEnv,
    permissionMode: capabilities && !capabilities.includes("filesystem.write") ? "default" : "acceptEdits",
    ...(readonlyShell ? {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        // denyWrite(cwd) alone bricked EVERY read-only lane's bash (2026-07-17):
        // the sandbox's own git-isolation writes a `.gitconfig` stub at cwd
        // during SETUP, so bwrap aborted with EROFS before any command ran
        // ("bash is dead for this whole session"). Carve out exactly that
        // engine-owned scaffolding path; the rest of cwd stays write-denied.
        // The stub must EXIST before spawn — bwrap can rw-bind an existing
        // file over an ro directory, but cannot create one inside it (see
        // ensureGitIsolationStub below).
        filesystem: {
          denyWrite: [resolve(cwd)],
          allowWrite: [ensureGitIsolationStub(cwd)],
        },
      },
    } : {}),
    ...(capabilities ? { northCapabilities: [...capabilities] } : {}),
    cwd,
    systemPrompt: baseSystemPrompt,
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
  const state: HarnessCompositionState = {
    baseSystemPrompt,
    evidence: gaffer.evidence,
    initialProvider: o.provider,
    initialModel: o.model,
    omitModelDeltaReason: o.omitModelDeltaReason,
  };
  harnessComposition.set(options as object, state);
  appliedEvidence.set(options as object, gaffer.evidence);
  if (o.provider) return applyHarnessRoute(options, o.provider, o.model).options;
  return options;
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are a north agent on a shared fact graph. Prefer native north coordination " +
  "tools over editing coordination state: capture/tell to record work and ready/next " +
  "to find it. Your Gaffer topology contract, when present, is the sole source of " +
  "delegation authority. Acquire before editing shared code. Report concisely.";
