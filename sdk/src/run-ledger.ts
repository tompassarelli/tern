import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PromptEconomicsEvidence } from "./harness";
import type { NormalizedTokenUsage } from "./usage";
import type { CavemanResolution } from "./caveman";
import type { McpActivityObservation } from "./tool-activity";

const REPO = resolve(import.meta.dir, "../..");
const CONTRACT_PATH = resolve(REPO, "contracts/agent-run-ledger-v1.json");
const internalWriter = resolve(REPO, "cli/run-event-internal.clj");

interface EventSpec { required: string[]; allowed: string[] }
interface LedgerContract {
  version: string;
  coverage: Array<"exact" | "partial" | "unknown">;
  eventTypes: Record<string, EventSpec>;
  fieldKinds: Record<string, "digest" | "identifier" | "entity" | "count">;
  privacy: { maxIdentifierLength: number; forbiddenKeyFragments: string[] };
}

export const AGENT_RUN_LEDGER_CONTRACT = Object.freeze(
  JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as LedgerContract,
);
export const AGENT_RUN_LEDGER_VERSION = AGENT_RUN_LEDGER_CONTRACT.version;
export const AGENT_RUN_EVENT_TYPES = Object.freeze(
  Object.keys(AGENT_RUN_LEDGER_CONTRACT.eventTypes),
);

export type RunEventType = keyof typeof AGENT_RUN_LEDGER_CONTRACT.eventTypes;
export type ObservationCoverage = "exact" | "partial" | "unknown";
export type RunEventPayload = Readonly<Record<string, string | number>>;

export interface RunLedgerIdentity {
  run: string;
  thread: string;
  agent: string;
  parentRun?: string;
  parentThread?: string;
  coordinator?: string;
  cavemanMode?: string;
  cavemanSource?: string;
}

export interface AgentRunEvent extends RunLedgerIdentity {
  version: string;
  subject: string;
  sequence: number;
  type: string;
  observedAt: string;
  source: string;
  coverage: ObservationCoverage;
  payload: RunEventPayload;
  digest: string;
}

export interface AgentRunLedgerSummary {
  version: string;
  eventCount: number;
  firstSequence: number;
  lastSequence: number;
  terminalSequence: number;
  digest: string;
  coverage: ReadonlyArray<Readonly<{ source: string; coverage: ObservationCoverage }>>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]*$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ENTITY = /^@?(?:run:[A-Za-z0-9_.:-]+|[A-Za-z0-9][A-Za-z0-9_.:-]*)$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalEntity(value: string, label: string): string {
  if (!ENTITY.test(value)) throw new Error(`invalid run ledger ${label}`);
  return value.startsWith("@") ? value : `@${value}`;
}

function validateIdentity(identity: RunLedgerIdentity): RunLedgerIdentity {
  const validated: RunLedgerIdentity = {
    run: canonicalEntity(identity.run, "run"),
    thread: identity.thread === "(ad-hoc)"
      ? identity.thread
      : canonicalEntity(identity.thread, "thread"),
    agent: identity.agent.replace(/^@agent:/, ""),
  };
  if (!IDENTIFIER.test(validated.agent)) throw new Error("invalid run ledger agent");
  if (!validated.run.startsWith("@run:")) throw new Error("run ledger run must be a @run: entity");
  if (identity.parentRun) validated.parentRun = canonicalEntity(identity.parentRun, "parentRun");
  if (identity.parentThread)
    validated.parentThread = canonicalEntity(identity.parentThread, "parentThread");
  if (identity.coordinator) {
    const coordinator = identity.coordinator.replace(/^@agent:/, "");
    if (!IDENTIFIER.test(coordinator)) throw new Error("invalid run ledger coordinator");
    validated.coordinator = coordinator;
  }
  if (identity.cavemanMode) {
    if (!new Set(["off", "lite", "full"]).has(identity.cavemanMode))
      throw new Error("invalid run ledger Caveman mode");
    validated.cavemanMode = identity.cavemanMode;
  }
  if (identity.cavemanSource) {
    if (!new Set(["request", "env", "default"]).has(identity.cavemanSource))
      throw new Error("invalid run ledger Caveman source");
    validated.cavemanSource = identity.cavemanSource;
  }
  return validated;
}

function validatePayload(type: string, payload: RunEventPayload): RunEventPayload {
  const spec = AGENT_RUN_LEDGER_CONTRACT.eventTypes[type];
  if (!spec) throw new Error(`unsupported run ledger event type: ${type}`);
  if (!payload || Array.isArray(payload) || typeof payload !== "object")
    throw new Error("run ledger event payload must be an object");
  const keys = Object.keys(payload);
  for (const key of keys) {
    const normalized = key.toLowerCase();
    if (AGENT_RUN_LEDGER_CONTRACT.privacy.forbiddenKeyFragments.some(
      (fragment) => normalized.includes(fragment),
    )) throw new Error(`privacy-forbidden run ledger field: ${key}`);
    if (!spec.allowed.includes(key)) throw new Error(`unexpected ${type} payload field: ${key}`);
    const value = payload[key];
    const kind = AGENT_RUN_LEDGER_CONTRACT.fieldKinds[key];
    if (kind === "count") {
      if (!Number.isSafeInteger(value) || (value as number) < 0)
        throw new Error(`invalid run ledger count: ${key}`);
    } else if (typeof value !== "string") {
      throw new Error(`invalid run ledger string field: ${key}`);
    } else if (kind === "digest") {
      if (!DIGEST.test(value)) throw new Error(`invalid run ledger digest: ${key}`);
    } else if (kind === "entity") {
      canonicalEntity(value, key);
    } else if (!IDENTIFIER.test(value)
      || value.length > AGENT_RUN_LEDGER_CONTRACT.privacy.maxIdentifierLength) {
      throw new Error(`invalid run ledger identifier: ${key}`);
    }
  }
  for (const required of spec.required) {
    if (!Object.hasOwn(payload, required)) throw new Error(`missing ${type} payload field: ${required}`);
  }
  return Object.freeze({ ...payload });
}

function coverageRank(coverage: ObservationCoverage): number {
  return coverage === "unknown" ? 0 : coverage === "partial" ? 1 : 2;
}

export class AgentRunLedger {
  readonly identity: RunLedgerIdentity;
  #events: AgentRunEvent[] = [];
  #finalized = false;

  constructor(identity: RunLedgerIdentity) {
    this.identity = Object.freeze(validateIdentity(identity));
  }

  append(
    type: string,
    payload: RunEventPayload,
    source: string,
    coverage: ObservationCoverage,
    observedAt = new Date().toISOString(),
  ): AgentRunEvent {
    if (this.#finalized) throw new Error("run ledger is finalized");
    if (!AGENT_RUN_LEDGER_CONTRACT.coverage.includes(coverage))
      throw new Error("invalid run ledger coverage");
    if (!IDENTIFIER.test(source)
      || source.length > AGENT_RUN_LEDGER_CONTRACT.privacy.maxIdentifierLength)
      throw new Error("invalid run ledger source");
    if (Number.isNaN(Date.parse(observedAt)) || !observedAt.endsWith("Z"))
      throw new Error("invalid run ledger observedAt");
    const sequence = this.#events.length;
    const safePayload = validatePayload(type, payload);
    const unsigned = {
      version: AGENT_RUN_LEDGER_VERSION,
      ...this.identity,
      sequence, type, observedAt, source, coverage, payload: safePayload,
    };
    const digest = sha256(canonical(unsigned));
    const runTail = this.identity.run.replace(/^@?run:/, "");
    // Sequence is the append slot. Keeping it as the whole event subject makes
    // competing observations for the same slot collide at the coordinator CAS
    // instead of creating two digest-suffixed siblings with ambiguous order.
    const subject = `@run:${runTail}:event:${String(sequence).padStart(8, "0")}`;
    const event = Object.freeze({ ...unsigned, subject, digest });
    this.#events.push(event);
    if (type === "terminal_cleanup") this.#finalized = true;
    return event;
  }

  events(): ReadonlyArray<AgentRunEvent> {
    return Object.freeze([...this.#events]);
  }

  finalize(): AgentRunLedgerSummary {
    const terminal = this.#events.at(-1);
    if (!this.#finalized || terminal?.type !== "terminal_cleanup")
      throw new Error("run ledger requires terminal_cleanup as its final event");
    const bySource = new Map<string, ObservationCoverage>();
    for (const event of this.#events) {
      const prior = bySource.get(event.source);
      if (!prior || coverageRank(event.coverage) < coverageRank(prior))
        bySource.set(event.source, event.coverage);
    }
    const coverage = [...bySource]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, value]) => Object.freeze({ source, coverage: value }));
    return Object.freeze({
      version: AGENT_RUN_LEDGER_VERSION,
      eventCount: this.#events.length,
      firstSequence: 0,
      lastSequence: terminal.sequence,
      terminalSequence: terminal.sequence,
      digest: sha256(canonical(this.#events.map((event) => event.digest))),
      coverage: Object.freeze(coverage),
    });
  }
}

export function eventFacts(event: AgentRunEvent): Array<[string, string]> {
  const identity = validateIdentity(event);
  const payload = validatePayload(event.type, event.payload);
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0)
    throw new Error("invalid run event sequence");
  if (!AGENT_RUN_LEDGER_CONTRACT.coverage.includes(event.coverage)
      || !IDENTIFIER.test(event.source)
      || Number.isNaN(Date.parse(event.observedAt)) || !event.observedAt.endsWith("Z"))
    throw new Error("invalid run event observation metadata");
  const unsigned = {
    version: AGENT_RUN_LEDGER_VERSION,
    ...identity,
    sequence: event.sequence,
    type: event.type,
    observedAt: event.observedAt,
    source: event.source,
    coverage: event.coverage,
    payload,
  };
  const expectedDigest = sha256(canonical(unsigned));
  const runTail = identity.run.replace(/^@?run:/, "");
  const expectedSubject = `@run:${runTail}:event:${String(event.sequence).padStart(8, "0")}`;
  if (event.version !== AGENT_RUN_LEDGER_VERSION
      || event.digest !== expectedDigest || event.subject !== expectedSubject)
    throw new Error("run event identity or digest mismatch");
  const facts: Array<[string, string]> = [
    ["kind", "run_event"],
    ["agent_run_ledger_version", AGENT_RUN_LEDGER_VERSION],
    ["run", identity.run],
    ["thread", identity.thread],
    ["agent", identity.agent],
    ["run_event_sequence", String(event.sequence)],
    ["run_event_type", event.type],
    ["run_event_observed_at", event.observedAt],
    ["run_event_source", event.source],
    ["run_event_coverage", event.coverage],
    ["run_event_data", canonical(payload)],
    ["run_event_sha256", expectedDigest],
  ];
  if (identity.cavemanMode) facts.push(["caveman_mode", identity.cavemanMode]);
  if (identity.cavemanSource) facts.push(["caveman_source", identity.cavemanSource]);
  if (identity.parentRun) facts.push(["parent_run", identity.parentRun]);
  if (identity.parentThread) facts.push(["parent_thread", identity.parentThread]);
  if (identity.coordinator) facts.push(["run_coordinator", identity.coordinator]);
  return facts;
}

export type RunEventPublicationStatus = "recorded" | "unavailable";

export function recordRunEvent(
  event: AgentRunEvent,
  timeoutMs = 10_000,
): Promise<RunEventPublicationStatus> {
  let facts: Array<[string, string]>;
  try { facts = eventFacts(event); } catch { return Promise.resolve("unavailable"); }
  return new Promise((resolvePublication) => {
    try {
      execFile("bb", [
        internalWriter,
        process.env.NORTH_PORT ?? "7977",
        event.subject,
        JSON.stringify(facts),
      ], { timeout: Math.max(1, Math.floor(timeoutMs)) }, (error) => {
        resolvePublication(error ? "unavailable" : "recorded");
      });
    } catch { resolvePublication("unavailable"); }
  });
}

export function recordRunEvents(
  events: ReadonlyArray<AgentRunEvent>,
  timeoutMs = 10_000,
): Promise<RunEventPublicationStatus> {
  let batch: Array<Readonly<{
    subject: string;
    facts: Array<[string, string]>;
  }>>;
  try {
    if (events.length === 0) return Promise.resolve("unavailable");
    batch = events.map((event) => Object.freeze({
      subject: event.subject,
      facts: eventFacts(event),
    }));
  } catch {
    return Promise.resolve("unavailable");
  }
  return new Promise((resolvePublication) => {
    try {
      execFile("bb", [
        internalWriter,
        process.env.NORTH_PORT ?? "7977",
        JSON.stringify(batch),
      ], { timeout: Math.max(1, Math.floor(timeoutMs)) }, (error) => {
        resolvePublication(error ? "unavailable" : "recorded");
      });
    } catch {
      resolvePublication("unavailable");
    }
  });
}

export interface RunLifecycleObservations {
  promptEconomics?: PromptEconomicsEvidence;
  tokenUsage: NormalizedTokenUsage;
  compactions: number;
  outcome: string;
  caveman: CavemanResolution;
  mcpActivity: McpActivityObservation;
}

/**
 * Publish the privacy-bounded lifecycle evidence that is available at the
 * terminal seam. A summary is returned only when every append reached the
 * coordinator; callers therefore cannot label a partial ledger complete.
 */
export async function publishRunLifecycleLedger(
  identity: RunLedgerIdentity,
  observations: RunLifecycleObservations,
  timeoutMs = 10_000,
  writer: (
    events: ReadonlyArray<AgentRunEvent>,
    timeoutMs: number,
  ) => Promise<RunEventPublicationStatus> = recordRunEvents,
): Promise<AgentRunLedgerSummary | undefined> {
  const ledger = new AgentRunLedger(identity);
  const events: AgentRunEvent[] = [];
  const economics = observations.promptEconomics;
  const caveman = observations.caveman;
  const cavemanPayload: Record<string, string | number> = {
    requestedMode: caveman.requestedMode,
    resolvedMode: caveman.resolvedMode,
    implementation: caveman.implementation,
    decisionReason: caveman.decisionReason,
    measurementCoverage: caveman.measurementCoverage,
  };
  for (const key of [
    "repository", "revision", "skillSha256", "skillBytes", "renderedSha256", "renderedBytes",
    "sourceKind", "resolutionProvenance",
  ] as const) {
    const value = caveman[key];
    if (value !== undefined) cavemanPayload[key] = value;
  }
  events.push(ledger.append(
    "caveman_observed", cavemanPayload, "north-caveman-adapter", caveman.measurementCoverage,
  ));

  const activity = observations.mcpActivity;
  const activitySummary: Record<string, string | number> = {};
  if (activity.totalCalls !== undefined) activitySummary.totalCalls = activity.totalCalls;
  if (activity.coverage !== "unknown") activitySummary.distinctTools = activity.tools.length;
  events.push(ledger.append("tool_activity", activitySummary, activity.source, activity.coverage));
  for (const tool of activity.tools) {
    events.push(ledger.append("tool_activity", {
      serverName: tool.server, toolName: tool.tool, callCount: tool.count,
    }, activity.source, activity.coverage));
  }
  if (economics) {
    const payload: Record<string, string | number> = {
      compositionVersion: economics.compositionVersion,
      compositionDigest: economics.compositionDigest,
      capabilityClass: economics.capabilityClass,
      capabilityCount: economics.capabilityCount,
      stablePrefixBytes: economics.stablePrefixBytes,
      uniqueTailBytes: economics.uniqueTailBytes,
      totalBytes: economics.totalBytes,
      byteMeasurementSource: economics.byteMeasurementSource,
      tokenMeasurementStatus: economics.tokenMeasurementStatus,
      tokenMeasurementSource: economics.tokenMeasurementSource,
      contextWindowStatus: economics.contextWindowStatus,
      contextWindowSource: economics.contextWindowSource,
      contextBudgetStatus: economics.contextBudgetStatus,
      contextBudgetSource: economics.contextBudgetSource,
      compactionPolicy: economics.compactionPolicy,
      compactionPolicyVersion: economics.compactionPolicyVersion,
    };
    for (const key of [
      "stablePrefixTokens", "uniqueTailTokens", "totalCompositionTokens",
      "providerContextWindowTokens", "contextWindowEffectiveFrom",
      "effectiveContextBudgetTokens",
    ] as const) {
      const value = economics[key];
      if (value !== undefined) payload[key] = value;
    }
    events.push(ledger.append(
      "prompt_constructed", payload, "north-harness-composer", "exact",
    ));
  }

  const usage = observations.tokenUsage;
  const usagePayload: Record<string, string | number> = { terminalCount: usage.terminalCount };
  for (const [key, value] of [
    ["inputTokens", usage.inputTokens],
    ["outputTokens", usage.outputTokens],
    ["reasoningOutputTokens", usage.reasoningOutputTokens],
  ] as const) if (value !== undefined) usagePayload[key] = value;
  if (usage.totalStatus === "exact" && usage.total !== undefined)
    usagePayload.totalTokens = usage.total;
  const componentCount = Object.keys(usagePayload).length - 1;
  events.push(ledger.append(
    "usage_observed", usagePayload, "provider-terminal",
    usage.totalStatus === "exact" ? "exact" : componentCount > 0 ? "partial" : "unknown",
  ));

  const cachePayload: Record<string, number> = {};
  for (const [key, value] of [
    ["cacheReadTokens", usage.cacheReadTokens],
    ["cacheCreateTokens", usage.cacheCreateTokens],
    ["cachedInputTokens", usage.cachedInputTokens],
  ] as const) if (value !== undefined) cachePayload[key] = value;
  events.push(ledger.append(
    "cache_observed", cachePayload, "provider-terminal-cache",
    Object.keys(cachePayload).length === 3 ? "exact"
      : Object.keys(cachePayload).length > 0 ? "partial" : "unknown",
  ));
  events.push(ledger.append("compaction_observed", {
    compactionCount: observations.compactions,
    compactionPolicy: economics?.compactionPolicy ?? "auto-compact-enabled",
    compactionPolicyVersion: economics?.compactionPolicyVersion
      ?? "north-native-auto-compact:v1",
    compactionEvidence: "sdk-compact-boundary",
  }, "north-sdk-stream", "exact"));
  events.push(ledger.append("terminal_cleanup", {
    outcome: observations.outcome,
    cleanupStatus: "observed",
  }, "north-managed-terminal", "exact"));

  // One writer process receives the full lifecycle budget. Spawning Babashka
  // once per event consumes most of the terminal timeout in cold starts and can
  // leave every production run without event evidence.
  const complete = await writer(Object.freeze([...events]), timeoutMs) === "recorded";
  // A caught transport crash has no provider terminal boundary. Its attempted
  // observations remain useful events, but the @run header must not claim a
  // complete lifecycle ledger.
  const terminalBoundaryObserved = !new Set(["died", "stalled"]).has(observations.outcome);
  return complete && terminalBoundaryObserved ? ledger.finalize() : undefined;
}
