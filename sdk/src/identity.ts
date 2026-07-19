// Agent identity facts — ids stay meaningless + immutable; everything meaningful
// is a FACT on @agent:<id> in the coordination log (design: thread 019f40f8).
// Predicates (single-valued, declared via the schema-write gate): kind role model
// provider provider_target effort composition_kind composition_id composition_overrides
// composition_override_reason goal spawned_at display_handle display_name; repo stays
// multi (threads span repos).
// Initial publication is a hard pre-provider gate. The scoped writer clears any
// prior generation, writes the exact projection, reads it back, and commits a
// manifest marker last. Route refresh and terminal outcome remain lifecycle
// telemetry, with required-vs-advisory behavior chosen by their callers.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  BESPOKE_FINGERPRINT_DOMAIN, BESPOKE_FINGERPRINT_VERSION,
} from "./bespoke-contract";
import type { ExecutionTerminal } from "./execution-outcome";
import { classifyExecutionTerminal } from "./execution-outcome";
import type { LiveInputCapability } from "./providers/types";
export { bespokeContractFingerprint } from "./bespoke-contract";

export type LiveInputState = "pending" | "armed" | "frozen";

// NORTH_BIN override mirrors death.ts/clock.ts/children.ts/watchdog.ts, so the whole
// coordinator-writing surface resolves the SAME engine — and a hermetic test that points
// NORTH_BIN at a fake redirects identity writes too. A bare `north` on PATH ignored that
// seam, so identity tells escaped the fake, hit the real CLI (~3.7s/call against a dead
// port) and wrote test agents into the production graph.
const REPO = resolve(import.meta.dir, "..", "..");
const northBin = () => process.env.NORTH_BIN ?? `${REPO}/bin/north`;
const internalWriter = resolve(REPO, "cli/agent-fact-internal.clj");
const INTERNAL_WRITER_TIMEOUT_MS = 10_000;
const INTERNAL_WRITE_LEASE_TTL_MS = 60_000;

/** Read-side projection. `none` is accepted only for historical native rows. */
export interface ObservedAgentIdentity {
  kind: "lane" | "session" | "cron";
  role?: string;
  model?: string; // tier name as spawned (opus|sonnet|haiku); SDK resolves the full id
  provider?: string;
  providerTarget?: string;
  liveInput?: LiveInputCapability;
  liveInputState?: LiveInputState;
  /** Opaque UUIDv4 route generation; changes on every live-input/route publication. */
  liveInputEpoch?: string;
  effort?: string;
  compositionKind?: "preset" | "bespoke" | "none";
  compositionId?: string;
  compositionOverrides?: string[];
  compositionOverrideReason?: string;
  compositionNearestPreset?: string;
  compositionBespokeReason?: string;
  compositionPromotionCandidate?: boolean;
  compositionContractFingerprint?: string;
  compositionContractFingerprintVersion?: string;
  compositionContractFingerprintDomain?: string;
  repo?: string;
  goal?: string;
  // spawning coordinator handle. Persisted (not just held at ping time) so it survives
  // the spawning session: the reactor's died-unreported sweep reads it to ping on a
  // silent hard-kill (sweep-lanes! in north-reactor.clj), and `north health` folds it to
  // compute ping-loss (lanes that carried a coordinator but landed no COMPLETE/DEATH).
  coordinator?: string;
}

/** Write-side contract for every North-managed provider lane. */
export interface ManagedLaneIdentity extends ObservedAgentIdentity {
  kind: "lane";
  role: string;
  liveInput: LiveInputCapability;
  liveInputState: LiveInputState;
  liveInputEpoch: string;
  compositionKind: "preset" | "bespoke";
  compositionId: string;
}

export type AgentIdentity = ObservedAgentIdentity;
export type TerminalPublicationStatus = "recorded" | "unavailable";

const component = (value?: string) => {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || "unknown";
};
const shortModel = (m?: string) => {
  const normalized = component(m);
  for (const family of ["opus", "sonnet", "haiku", "fable", "sol", "terra", "luna"])
    if (normalized.split("-").includes(family)) return family;
  return normalized;
};
const idSuffix = (id: string) => component(id.split("-").at(-1));
const ROUTING_OVERRIDE_FIELDS = new Set([
  "taskGrade", "domainRequirements", "tier", "reasoning", "posture",
]);
const SAFE_ROLE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function userAnchoredPath(path: string): string {
  const home = homedir().replace(/\/+$/, "");
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function validPresetOverrides(f: AgentIdentity): string[] | undefined {
  if (f.compositionOverrides === undefined) return undefined;
  const overrides = f.compositionOverrides;
  if (new Set(overrides).size !== overrides.length
      || overrides.some((field) => !ROUTING_OVERRIDE_FIELDS.has(field))) return undefined;
  if (overrides.length > 0 !== Boolean(f.compositionOverrideReason?.trim())) return undefined;
  return overrides;
}

export function gafferProvenance(f: AgentIdentity): string {
  // A provider-native session did not pass through North staffing. Managed
  // lanes never borrow that honest label: missing or malformed composition
  // facts are migration debt, not an unselected current routing decision.
  if (f.kind === "session") return "gaffer:not-selected";
  const role = f.role?.trim();
  const compositionId = f.compositionId?.trim();
  if (!role || !compositionId || !SAFE_ROLE_ID.test(role)
      || !SAFE_ROLE_ID.test(compositionId) || role !== compositionId)
    return "gaffer:legacy-debt";
  if (f.compositionKind === "preset") {
    const overrides = validPresetOverrides(f);
    if (!overrides) return "gaffer:legacy-debt";
    const base = `gaffer:${compositionId}`;
    return overrides.length ? `${base}+override(${overrides.map(component).join(",")})` : base;
  }
  if (f.compositionKind === "bespoke"
      && Boolean(f.compositionBespokeReason?.trim())
      && typeof f.compositionPromotionCandidate === "boolean"
      && SHA256.test(f.compositionContractFingerprint ?? "")
      && f.compositionContractFingerprintVersion === BESPOKE_FINGERPRINT_VERSION
      && f.compositionContractFingerprintDomain === BESPOKE_FINGERPRINT_DOMAIN)
    return `gaffer:bespoke:${compositionId}`;
  return "gaffer:legacy-debt";
}

/** Preserve an unknown native session as provider-only; managed routes always supply providerTarget. */
export function providerTargetLabel(f: AgentIdentity): string {
  const provider = f.provider?.trim() || "unknown";
  const target = f.providerTarget?.trim();
  if (!target) return provider;
  return `${provider}:${target === provider || target === "ambient" ? "ambient" : target}`;
}

export function semanticHandle(id: string, f: AgentIdentity): string {
  const composition = component(gafferProvenance(f));
  return [component(providerTargetLabel(f)), shortModel(f.model), component(f.effort), composition, idSuffix(id)].join("-");
}

export function renderDisplayName(id: string, f: AgentIdentity): string {
  const goal = f.goal ? ` — ${f.goal.length > 40 ? f.goal.slice(0, 37) + "…" : f.goal}` : "";
  if (f.providerTarget) {
    const task = f.goal ? (f.goal.length > 40 ? f.goal.slice(0, 37) + "…" : f.goal) : "unknown";
    return `${providerTargetLabel(f)} · ${shortModel(f.model)} · ${component(f.effort)} · ${gafferProvenance(f)} · ${task}`;
  }
  return `${semanticHandle(id, f)}${goal}`;
}

export function agentRouteFacts(agentId: string, f: AgentIdentity): Array<[string, string | undefined]> {
  return [
    ["provider", f.provider],
    ["provider_target", f.providerTarget],
    ["live_input", f.liveInput],
    ["live_input_state", f.liveInputState],
    ["live_input_epoch", f.liveInputEpoch],
    ["model", f.model],
    ["effort", f.effort],
    ["display_handle", semanticHandle(agentId, f)],
    ["display_name", renderDisplayName(agentId, f)],
  ];
}

function writeHarnessAgentOperation(
  operation: "publish" | "route" | "terminal",
  subject: string,
  value: string,
  timeoutMs = INTERNAL_WRITER_TIMEOUT_MS,
) {
  if (process.env.NORTH_IDENTITY_TEST_REDIRECT === "1") {
    // Hermetic tests point NORTH_BIN at a tiny capture engine. Preserve the
    // ordinary fact-verb shape there so existing lifecycle assertions stay
    // readable, while every production publication goes through the scoped
    // readback/commit protocol below.
    if (operation === "terminal") {
      const facts = JSON.parse(value) as Record<string, string>;
      const startedAt = performance.now();
      for (const [predicate, factValue] of Object.entries(facts)) {
        const remaining = Math.max(1, Math.floor(timeoutMs - (performance.now() - startedAt)));
        execFileSync(northBin(), ["tell", subject, predicate, factValue], {
          stdio: "ignore",
          timeout: remaining,
        });
      }
      return;
    }
    if (operation === "publish") {
      try {
        const raw = execFileSync(northBin(), ["json", "show", subject], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
        });
        const current = JSON.parse(raw) as Array<{ predicate?: string; value?: string }>;
        for (const fact of current) {
          if (fact.predicate && fact.value)
            execFileSync(northBin(), ["retract", subject, fact.predicate, fact.value], { stdio: "ignore", timeout: 10_000 });
        }
      } catch {
        // A capture-only fake may not implement reads. Production never takes
        // this branch; dedicated coordinator integration tests cover readback.
      }
    }
    const facts = JSON.parse(value) as Record<string, string>;
    for (const [predicate, factValue] of Object.entries(facts))
      execFileSync(northBin(), ["tell", subject, predicate, factValue], { stdio: "ignore", timeout: 10_000 });
    return;
  }
  try {
    execFileSync("bb", [internalWriter, process.env.NORTH_PORT ?? "7977", operation, subject, value], {
      encoding: "utf8",
      env: {
        ...process.env,
        NORTH_IDENTITY_WRITER_TIMEOUT_MS: String(timeoutMs),
        NORTH_IDENTITY_WRITE_LEASE_TTL_MS: String(INTERNAL_WRITE_LEASE_TTL_MS),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
  } catch (cause) {
    const raw = cause && typeof cause === "object" && "stderr" in cause
      ? String((cause as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const detail = raw.split("\n").find((line) => line.startsWith("Message:"))?.slice("Message:".length).trim()
      ?? raw.split("\n").find((line) => line.includes(":reject"))?.trim()
      ?? raw.slice(-800);
    throw new Error(
      `managed agent ${operation} failed${detail ? `: ${detail}` : ""}`,
      { cause },
    );
  }
}

export function agentIdentityFacts(
  agentId: string,
  f: ManagedLaneIdentity,
  spawnedAt = new Date().toISOString(),
): Array<[string, string | undefined]> {
  return [
    ["kind", f.kind],
    ["display_handle", semanticHandle(agentId, f)],
    ["role", f.role],
    ["model", f.model],
    ["provider", f.provider],
    ["provider_target", f.providerTarget],
    ["live_input", f.liveInput],
    ["live_input_state", f.liveInputState],
    ["live_input_epoch", f.liveInputEpoch],
    ["effort", f.effort],
    ["composition_kind", f.compositionKind],
    ["composition_id", f.compositionId],
    ["composition_overrides", f.compositionOverrides === undefined
      ? undefined : JSON.stringify(f.compositionOverrides)],
    ["composition_override_reason", f.compositionOverrideReason],
    ["nearest_preset", f.compositionNearestPreset],
    ["bespoke_reason", f.compositionBespokeReason],
    ["promotion_candidate", f.compositionPromotionCandidate === undefined
      ? undefined : String(f.compositionPromotionCandidate)],
    ["composition_contract_sha256", f.compositionContractFingerprint],
    ["composition_contract_fingerprint_version", f.compositionContractFingerprintVersion],
    ["composition_contract_fingerprint_domain", f.compositionContractFingerprintDomain],
    ["repo", f.repo],
    ["goal", f.goal],
    ["coordinator", f.coordinator],
    ["spawned_at", spawnedAt],
    ["display_name", renderDisplayName(agentId, f)],
  ];
}

export function writeAgentFacts(agentId: string, f: ManagedLaneIdentity): void {
  const subject = `agent:${agentId}`; // north tell @-prefixes bare ids
  const facts = agentIdentityFacts(agentId, f);
  const projection = Object.fromEntries(facts.filter((fact): fact is [string, string] => fact[1] !== undefined && fact[1] !== ""));
  writeHarnessAgentOperation("publish", subject, JSON.stringify(projection));
}

// Refresh the route projection without resetting generation identity. This is
// used when a pre-side-effect provider fallback activates or an in-flight
// escalation changes model/effort. The control key and spawned_at stay stable.
export function updateAgentRoute(agentId: string, f: AgentIdentity): void {
  const route = Object.fromEntries(agentRouteFacts(agentId, f)
    .filter((fact): fact is [string, string] => fact[1] !== undefined && fact[1] !== ""));
  writeHarnessAgentOperation("route", `agent:${agentId}`, JSON.stringify(route));
}

// Crash-safe terminal projection on @agent:<id>. The scoped writer publishes
// process + delivery facts, verifies the exact projection, then lands
// terminal_manifest_sha256 last. The reactor accepts a modern terminal only
// through that marker; an interrupted publication therefore remains unresolved
// and is safely reaped after the presence-lapse bar. recordRun is a secondary,
// independently committed trail. This synchronous write remains non-fatal:
// lifecycle finalization must not throw merely because the evidence sink failed.
export function writeAgentTerminal(
  agentId: string,
  terminal: ExecutionTerminal,
  timeoutMs = INTERNAL_WRITER_TIMEOUT_MS,
): TerminalPublicationStatus {
  if (!terminal.processOutcome) return "unavailable";
  try {
    writeHarnessAgentOperation("terminal", `agent:${agentId}`, JSON.stringify({
      outcome: terminal.processOutcome,
      process_outcome: terminal.processOutcome,
      delivery_outcome: terminal.deliveryOutcome,
      delivery_reason: terminal.deliveryReason,
      ...(terminal.deliveryProof?.deliveryEvidence
        ? { delivery_evidence: terminal.deliveryProof.deliveryEvidence } : {}),
      ...(terminal.deliveryProof?.deliveryEvidenceSha256
        ? { delivery_evidence_sha256: terminal.deliveryProof.deliveryEvidenceSha256 } : {}),
      ...(terminal.deliveryProof?.deliveryAttestation
        ? { delivery_attestation: terminal.deliveryProof.deliveryAttestation } : {}),
      ...(terminal.deliveryProof?.deliveryAttestationSha256
        ? { delivery_attestation_sha256: terminal.deliveryProof.deliveryAttestationSha256 } : {}),
    }), timeoutMs);
    return "recorded";
  } catch {
    // Non-fatal; presence-lapse reap catches absent or torn terminal evidence.
    return "unavailable";
  }
}

/** Compatibility wrapper for callers not yet carrying the delivery axis. */
export function writeAgentOutcome(agentId: string, outcome: string): void {
  writeAgentTerminal(agentId, classifyExecutionTerminal(outcome));
}

// First sentence (or first 100 chars) of a spawn prompt — the goal fact seed.
export function goalFromPrompt(prompt: string): string {
  const delegated = prompt.match(/(?:^|\n)DELEGATE TASK:\s*([^\n]+)/)?.[1]?.trim();
  const firstLine = delegated ?? prompt.split("\n", 1)[0] ?? "";
  const sentence = firstLine.split(/(?<=[.!?])\s/, 1)[0] ?? firstLine;
  return sentence.length > 100 ? sentence.slice(0, 97) + "…" : sentence;
}
