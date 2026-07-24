import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  ReasoningLevel, RoutingOverrideField, RoutingRequest, RoutingTier,
} from "./routing-metadata";
import { DEFAULT_GAFFER_STAFFING_PATH } from "./gaffer-staffing";
import { DEFAULT_ROUTING_POLICY_PATH } from "./resource-policy";
import { projectCatalogGraphPin, staffingSource, type CatalogGraphPin } from "./orchestration-graph-source";
import { verifyPolicyDigestPin } from "./orchestration-policy-pin";

export const ROUTING_ASSESSMENT_POLICY_VERSION = "minimum-sufficient-v1" as const;
export const ROUTING_PIN_POLICY_VERSION = "north-routing-pin-v1" as const;
export const MAX_PIN_LIFETIME_MS = 24 * 60 * 60 * 1_000;

const SIGNAL_VALUES = {
  decisionOwnership: ["none", "bounded", "cross-boundary", "system-shaping", "open-solution-class"],
  seamScope: ["none", "established", "consequential", "system-wide"],
  errorExposure: ["contained-reversible", "material-recoverable", "high-or-hard-to-reverse"],
  oracleStrength: ["not-applicable", "objective-local", "objective-end-to-end", "partial", "judgment-only"],
  foundationalImpact: ["none", "implementation-only", "invariant-decision-owned"],
  dependencyShape: ["atomic-cohesive", "deterministic-workflow", "parallel-breadth", "dynamic-decomposition", "tightly-coupled-sequential"],
  reasoningShape: ["deterministic", "bounded-branching", "multi-hypothesis", "system-synthesis", "exceptional"],
} as const;

type SignalKey = keyof typeof SIGNAL_VALUES;
type SignalValue<K extends SignalKey> = typeof SIGNAL_VALUES[K][number];

export interface RoutingAssessmentSignals {
  decisionOwnership: SignalValue<"decisionOwnership">;
  seamScope: SignalValue<"seamScope">;
  errorExposure: SignalValue<"errorExposure">;
  oracleStrength: SignalValue<"oracleStrength">;
  foundationalImpact: SignalValue<"foundationalImpact">;
  dependencyShape: SignalValue<"dependencyShape">;
  reasoningShape: SignalValue<"reasoningShape">;
}

export type RoutingExceptionCode =
  | "explicit-human-floor"
  | "recent-lower-tier-failure"
  | "calibration-experiment"
  | "unmodeled-risk";

export interface RoutingAssessment {
  $schema?: string;
  version: typeof ROUTING_ASSESSMENT_POLICY_VERSION;
  signals: RoutingAssessmentSignals;
  derived: { minimumTier: RoutingTier; minimumReasoning: ReasoningLevel; ruleCodes: string[] };
  selected: { tier: RoutingTier; reasoning: ReasoningLevel };
  exception?: { code: RoutingExceptionCode; detail: string };
  exceptionalDeliberation?: string;
}

export type RoutingPinKind = "provider" | "account" | "model";
export type RoutingPinReasonCode =
  | "explicit-human-request"
  | "provider-recovery"
  | "capability-requirement"
  | "calibration-experiment";

export interface RoutingPinEvidence {
  policyVersion: typeof ROUTING_PIN_POLICY_VERSION;
  issuedAt: string;
  expiresAt: string;
  reasonCode: RoutingPinReasonCode;
  detail: string;
  pins: Array<{ kind: RoutingPinKind; value: string }>;
}

export interface RoutingAdmissionReceipt {
  version: 1;
  routingRequestSha256: string;
  routingAssessmentSha256?: string;
  pinEvidenceSha256?: string;
  /**
   * Catalog-FILE digests over the Gaffer JSON on disk. Present ONLY under
   * NORTH_STAFFING_SOURCE=file (the retained rollback path). In graph mode
   * (the Phase 2 default) they are absent — the graph pin below replaces them
   * so the receipt never digests a file the graph may no longer mirror.
   */
  staffingCatalogSha256?: string;
  providerCatalogsSha256?: string;
  routingPolicySha256: string;
  stockAxes?: {
    taskGrade: string;
    topology: string;
    tier: string;
    reasoning: string;
    posture: string;
  };
  appliedAxes: {
    taskGrade: string;
    topology: string;
    tier: string;
    reasoning: string;
    posture: string;
  };
  overrideEvidence: {
    changedAxes: RoutingOverrideField[];
    status: "none" | "composition-only" | "assessment-exception";
    exceptionCode?: RoutingExceptionCode;
  };
  pinEvidenceStatus: "none" | "missing" | "legacy-missing" | "current";
  /**
   * §3.2 digest pin: present only when the staffing source is the graph (the
   * Phase 2 default). It is the verified three-way-equal digest of the
   * canonical selection-rule table, so the receipt names the exact policy state
   * admission accepted. Absent under NORTH_STAFFING_SOURCE=file.
   */
  orchestrationPolicyPinSha256?: string;
  /**
   * §3.1 point 6 receipt migration: graph-mode replacement for the catalog-FILE
   * digests. Present only when the staffing source is the graph. Names the exact
   * graph state admitted against: the sha256 of the canonical JSON projection of
   * the catalog subgraph, the @catalog:current pointer version, and the daemon's
   * global tx watermark at projection time. Absent under NORTH_STAFFING_SOURCE=file.
   */
  orchestrationCatalogDigestSha256?: string;
  orchestrationCatalogVersion?: number;
  orchestrationCatalogTxVersion?: number;
}

export interface AdmittedRoutingEconomics {
  assessment?: RoutingAssessment;
  pinEvidence?: RoutingPinEvidence;
  receipt: RoutingAdmissionReceipt;
}

const ASSESSMENT_FIELDS = new Set([
  "$schema", "version", "signals", "derived", "selected", "exception", "exceptionalDeliberation",
]);
const SIGNAL_FIELDS = new Set(Object.keys(SIGNAL_VALUES));
const DERIVED_FIELDS = new Set(["minimumTier", "minimumReasoning", "ruleCodes"]);
const SELECTED_FIELDS = new Set(["tier", "reasoning"]);
const EXCEPTION_FIELDS = new Set(["code", "detail"]);
const PIN_FIELDS = new Set(["policyVersion", "issuedAt", "expiresAt", "reasonCode", "detail", "pins"]);
const PIN_ITEM_FIELDS = new Set(["kind", "value"]);
const TIERS = new Set<unknown>(["economy", "standard", "senior", "frontier"]);
const REASONING = new Set<unknown>(["low", "medium", "high", "xhigh", "max"]);
const EXCEPTION_CODES = new Set<unknown>([
  "explicit-human-floor", "recent-lower-tier-failure", "calibration-experiment", "unmodeled-risk",
]);
const PIN_REASON_CODES = new Set<unknown>([
  "explicit-human-request", "provider-recovery", "capability-requirement", "calibration-experiment",
]);
const PIN_KINDS = new Set<unknown>(["provider", "account", "model"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<unknown>, label: string): T {
  if (!allowed.has(value)) throw new Error(`${label} has an unsupported value`);
  return value as T;
}

function uniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${label} must be a non-empty array`);
  const normalized = value.map((item, index) => requiredString(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates`);
  return normalized;
}

function isoInstant(value: unknown, label: string): { source: string; time: number } {
  const source = requiredString(value, label);
  const time = Date.parse(source);
  if (!Number.isFinite(time) || !source.includes("T")) throw new Error(`${label} must be an ISO instant`);
  return { source: new Date(time).toISOString(), time };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function fileDigest(path: string): string {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
  catch { return "unavailable"; }
}

export function admitRoutingAssessment(
  value: unknown,
  request: RoutingRequest,
  surface = "managed North routing assessment",
): RoutingAssessment | undefined {
  if (value === undefined) return undefined;
  const raw = record(value, surface);
  exactFields(raw, ASSESSMENT_FIELDS, surface);
  if (raw.version !== ROUTING_ASSESSMENT_POLICY_VERSION)
    throw new Error(`${surface}.version must be ${ROUTING_ASSESSMENT_POLICY_VERSION}`);
  const schema = raw.$schema === undefined ? undefined : requiredString(raw.$schema, `${surface}.$schema`);
  const rawSignals = record(raw.signals, `${surface}.signals`);
  exactFields(rawSignals, SIGNAL_FIELDS, `${surface}.signals`);
  const signals = Object.fromEntries(Object.entries(SIGNAL_VALUES).map(([key, values]) => [
    key, enumValue(rawSignals[key], new Set(values), `${surface}.signals.${key}`),
  ])) as unknown as RoutingAssessmentSignals;
  const rawDerived = record(raw.derived, `${surface}.derived`);
  exactFields(rawDerived, DERIVED_FIELDS, `${surface}.derived`);
  const derived = {
    minimumTier: enumValue<RoutingTier>(rawDerived.minimumTier, TIERS, `${surface}.derived.minimumTier`),
    minimumReasoning: enumValue<ReasoningLevel>(
      rawDerived.minimumReasoning, REASONING, `${surface}.derived.minimumReasoning`,
    ),
    ruleCodes: uniqueStrings(rawDerived.ruleCodes, `${surface}.derived.ruleCodes`),
  };
  const rawSelected = record(raw.selected, `${surface}.selected`);
  exactFields(rawSelected, SELECTED_FIELDS, `${surface}.selected`);
  const selected = {
    tier: enumValue<RoutingTier>(rawSelected.tier, TIERS, `${surface}.selected.tier`),
    reasoning: enumValue<ReasoningLevel>(rawSelected.reasoning, REASONING, `${surface}.selected.reasoning`),
  };
  if (selected.tier !== request.tier || selected.reasoning !== request.reasoning)
    throw new Error(`${surface}.selected must equal the admitted RoutingRequest tier/reasoning`);
  const changed = selected.tier !== derived.minimumTier
    || selected.reasoning !== derived.minimumReasoning;
  let exception: RoutingAssessment["exception"];
  if (raw.exception !== undefined) {
    const candidate = record(raw.exception, `${surface}.exception`);
    exactFields(candidate, EXCEPTION_FIELDS, `${surface}.exception`);
    exception = {
      code: enumValue<RoutingExceptionCode>(candidate.code, EXCEPTION_CODES, `${surface}.exception.code`),
      detail: requiredString(candidate.detail, `${surface}.exception.detail`),
    };
  }
  if (changed !== Boolean(exception))
    throw new Error(`${surface}.exception is required exactly when selected differs from derived`);
  const max = derived.minimumReasoning === "max" || selected.reasoning === "max";
  const exceptionalDeliberation = raw.exceptionalDeliberation === undefined
    ? undefined : requiredString(raw.exceptionalDeliberation, `${surface}.exceptionalDeliberation`);
  if (max !== Boolean(exceptionalDeliberation))
    throw new Error(`${surface}.exceptionalDeliberation is required exactly when derived or selected reasoning is max`);
  const admitted: RoutingAssessment = {
    ...(schema ? { $schema: schema } : {}),
    version: ROUTING_ASSESSMENT_POLICY_VERSION, signals, derived, selected,
    ...(exception ? { exception } : {}),
    ...(exceptionalDeliberation ? { exceptionalDeliberation } : {}),
  };
  const gafferRoot = resolve(process.env.GAFFER_HOME ?? resolve(homedir(), "code/gaffer"));
  const validator = process.env.GAFFER_SELECTION_ASSESSMENT_MODULE
    ?? resolve(gafferRoot, "scripts/selection-assessment.mjs");
  const validation = spawnSync(process.execPath, [
    "--eval",
    "import {pathToFileURL} from 'node:url';const m=await import(pathToFileURL(process.argv[1]).href);let s='';for await(const c of process.stdin)s+=c;process.stdout.write(JSON.stringify(m.validateSelectionAssessment(JSON.parse(s))));",
    validator,
  ], { input: JSON.stringify(admitted), encoding: "utf8", timeout: 5_000 });
  if (validation.error || validation.status !== 0) {
    const detail = validation.stderr?.trim() || validation.error?.message || "canonical validator failed";
    throw new Error(`${surface} failed canonical Gaffer validation: ${detail}`);
  }
  let canonicalAssessment: unknown;
  try { canonicalAssessment = JSON.parse(validation.stdout); }
  catch { throw new Error(`${surface} canonical Gaffer validator returned invalid JSON`); }
  if (canonicalJson(canonicalAssessment) !== canonicalJson(admitted))
    throw new Error(`${surface} canonical Gaffer validator changed the admitted assessment`);
  return deepFreeze(admitted);
}

export function admitRoutingPinEvidence(
  value: unknown,
  pins: Partial<Record<RoutingPinKind, string>>,
  now = new Date(),
  surface = "managed North routing pin evidence",
): RoutingPinEvidence | undefined {
  if (value === undefined) return undefined;
  const raw = record(value, surface);
  exactFields(raw, PIN_FIELDS, surface);
  if (raw.policyVersion !== ROUTING_PIN_POLICY_VERSION)
    throw new Error(`${surface}.policyVersion must be ${ROUTING_PIN_POLICY_VERSION}`);
  const issued = isoInstant(raw.issuedAt, `${surface}.issuedAt`);
  const expires = isoInstant(raw.expiresAt, `${surface}.expiresAt`);
  if (issued.time > now.getTime() + 60_000) throw new Error(`${surface}.issuedAt is in the future`);
  if (expires.time <= now.getTime()) throw new Error(`${surface} is expired`);
  if (expires.time <= issued.time || expires.time - issued.time > MAX_PIN_LIFETIME_MS)
    throw new Error(`${surface} lifetime must be positive and no more than 24 hours`);
  const rawPins = raw.pins;
  if (!Array.isArray(rawPins) || rawPins.length === 0) throw new Error(`${surface}.pins must be non-empty`);
  const admittedPins = rawPins.map((item, index) => {
    const pin = record(item, `${surface}.pins[${index}]`);
    exactFields(pin, PIN_ITEM_FIELDS, `${surface}.pins[${index}]`);
    return {
      kind: enumValue<RoutingPinKind>(pin.kind, PIN_KINDS, `${surface}.pins[${index}].kind`),
      value: requiredString(pin.value, `${surface}.pins[${index}].value`),
    };
  });
  const unique = new Set(admittedPins.map(({ kind }) => kind));
  if (unique.size !== admittedPins.length) throw new Error(`${surface}.pins may contain each kind at most once`);
  const expected = Object.entries(pins).filter(([, pin]) => Boolean(pin));
  if (expected.length !== admittedPins.length
      || expected.some(([kind, expectedValue]) =>
        !admittedPins.some((pin) => pin.kind === kind && pin.value === expectedValue)))
    throw new Error(`${surface}.pins must exactly match explicit provider/account/model selectors`);
  return deepFreeze({
    policyVersion: ROUTING_PIN_POLICY_VERSION,
    issuedAt: issued.source,
    expiresAt: expires.source,
    reasonCode: enumValue<RoutingPinReasonCode>(raw.reasonCode, PIN_REASON_CODES, `${surface}.reasonCode`),
    detail: requiredString(raw.detail, `${surface}.detail`),
    pins: admittedPins,
  });
}

// §3.2 digest pin memo: the projection subprocess is identical across every
// admission in a process (the catalog pointer is atomic), so verify once and
// cache the pinned digest. Failure is NOT cached — a transient dead coordinator
// must be re-probed on the next admission rather than poisoning the process.
let policyPinDigest: string | undefined;
function graphPolicyPin(surface: string): string {
  if (policyPinDigest === undefined) policyPinDigest = verifyPolicyDigestPin(undefined, surface);
  return policyPinDigest;
}

// §3.1 point 6 catalog pin memo: the catalog pointer is atomic, so the subgraph
// digest + watermarks are identical across every admission in a process. Project
// once and cache; a transient failure is NOT cached (re-probe next admission).
let catalogGraphPin: CatalogGraphPin | undefined;
function graphCatalogPin(): CatalogGraphPin {
  if (catalogGraphPin === undefined) catalogGraphPin = projectCatalogGraphPin();
  return catalogGraphPin;
}

function stockAxes(request: RoutingRequest): RoutingAdmissionReceipt["stockAxes"] {
  if (request.composition.kind !== "preset") return undefined;
  const catalog = JSON.parse(readFileSync(
    process.env.GAFFER_STAFFING_CATALOG ?? DEFAULT_GAFFER_STAFFING_PATH, "utf8",
  )) as { presets?: Array<Record<string, unknown>> };
  const preset = catalog.presets?.find(({ name }) => name === request.role);
  if (!preset) throw new Error(`Gaffer stock preset ${request.role} is absent while issuing admission receipt`);
  return {
    taskGrade: String(preset.taskGrade), topology: String(preset.topology),
    tier: String(preset.tier), reasoning: String(preset.deliberation), posture: String(preset.posture),
  };
}

export function admitRoutingEconomics(args: {
  request: RoutingRequest;
  routingAssessment?: unknown;
  pinEvidence?: unknown;
  provider?: string;
  target?: string;
  model?: string;
  now?: Date;
  surface?: string;
  /** Compatibility only for selectors inherited from a legacy process envelope. */
  allowLegacyMissingPinEvidence?: boolean;
}): AdmittedRoutingEconomics {
  const surface = args.surface ?? "managed North routing economics";
  const assessment = admitRoutingAssessment(args.routingAssessment, args.request, surface);
  const explicitPins: Partial<Record<RoutingPinKind, string>> = {
    ...(args.provider && args.provider !== "auto" ? { provider: args.provider } : {}),
    ...(args.target ? { account: args.target } : {}),
    ...(args.model ? { model: args.model } : {}),
  };
  const pinEvidence = admitRoutingPinEvidence(
    args.pinEvidence, explicitPins, args.now, `${surface} pin evidence`,
  );
  if (args.request.reasoning === "max" && !assessment) {
    throw new Error(
      `${surface} reasoning=max requires a canonical routingAssessment with exceptional deliberation`,
    );
  }
  if (Object.keys(explicitPins).length > 0 && !pinEvidence
      && !args.allowLegacyMissingPinEvidence) {
    throw new Error(
      `${surface} explicit provider/account/model selectors require current typed pinEvidence`,
    );
  }
  // §3.2 fail-closed digest pin: when the graph is the authoritative staffing
  // source (Phase 2 default), admission refuses unless the graph policy digest
  // matches the canonical validator's baked table. File mode keeps the packaged
  // rollback path with no pin.
  const graphMode = staffingSource() === "graph";
  const policyPin = graphMode ? graphPolicyPin(surface) : undefined;
  // §3.1 point 6: in graph mode the receipt names the graph state (digest + two
  // watermarks) instead of digesting catalog FILES; file mode keeps the FILE
  // digests as the packaged rollback evidence.
  const catalogPin = graphMode ? graphCatalogPin() : undefined;
  const gafferRoot = resolve(process.env.GAFFER_HOME ?? resolve(homedir(), "code/gaffer"));
  const providerDigests = graphMode ? undefined : {
    anthropic: fileDigest(resolve(gafferRoot, "providers/anthropic.json")),
    openai: fileDigest(resolve(gafferRoot, "providers/openai.json")),
  };
  const stock = stockAxes(args.request);
  const overrides = args.request.composition.kind === "preset"
    ? [...args.request.composition.overrides] : [];
  const receipt: RoutingAdmissionReceipt = {
    version: 1,
    routingRequestSha256: digest(args.request),
    ...(assessment ? { routingAssessmentSha256: digest(assessment) } : {}),
    ...(pinEvidence ? { pinEvidenceSha256: digest(pinEvidence) } : {}),
    ...(graphMode ? {} : {
      staffingCatalogSha256: fileDigest(
        process.env.GAFFER_STAFFING_CATALOG ?? DEFAULT_GAFFER_STAFFING_PATH,
      ),
      providerCatalogsSha256: digest(providerDigests),
    }),
    routingPolicySha256: fileDigest(
      process.env.NORTH_ROUTING_POLICY ?? DEFAULT_ROUTING_POLICY_PATH,
    ),
    ...(stock ? { stockAxes: stock } : {}),
    appliedAxes: {
      taskGrade: args.request.taskGrade, topology: args.request.topology,
      tier: args.request.tier, reasoning: args.request.reasoning, posture: args.request.posture,
    },
    overrideEvidence: {
      changedAxes: overrides,
      status: assessment?.exception
        ? "assessment-exception" : overrides.length ? "composition-only" : "none",
      ...(assessment?.exception ? { exceptionCode: assessment.exception.code } : {}),
    },
    pinEvidenceStatus: Object.keys(explicitPins).length === 0
      ? "none" : pinEvidence ? "current" : "legacy-missing",
    ...(policyPin ? { orchestrationPolicyPinSha256: policyPin } : {}),
    ...(catalogPin ? {
      orchestrationCatalogDigestSha256: catalogPin.catalogDigestSha256,
      orchestrationCatalogVersion: catalogPin.catalogVersion,
      orchestrationCatalogTxVersion: catalogPin.coordinatorVersion,
    } : {}),
  };
  return deepFreeze({
    ...(assessment ? { assessment } : {}),
    ...(pinEvidence ? { pinEvidence } : {}),
    receipt,
  });
}

function jsonEnv(name: string): unknown {
  const source = process.env[name];
  if (!source) return undefined;
  try { return JSON.parse(source); }
  catch { throw new Error(`${name} must contain valid JSON`); }
}

export function routingEconomicsFromEnv(request: RoutingRequest): AdmittedRoutingEconomics {
  return admitRoutingEconomics({
    request,
    routingAssessment: jsonEnv("AGENT_ROUTING_ASSESSMENT"),
    pinEvidence: jsonEnv("NORTH_ROUTING_PIN_EVIDENCE"),
    provider: process.env.AGENT_PROVIDER,
    target: process.env.AGENT_TARGET,
    model: process.env.AGENT_MODEL,
    allowLegacyMissingPinEvidence: true,
    surface: "managed North environment routing economics",
  });
}
