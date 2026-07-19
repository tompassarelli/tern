import {
  validateTopologyCapabilities, type GafferCapability,
} from "./gaffer-capabilities";
import { requireGafferRoleId } from "./gaffer-role-id";
import { canonicalBespokeContract } from "./bespoke-contract";
import { requireProviderNeutralRoute } from "./provider-neutral-route";

export const TASK_GRADES = ["novice", "junior", "mid", "senior", "staff", "principal", "research-grade"] as const;
export type TaskGrade = typeof TASK_GRADES[number];

export const TOPOLOGIES = ["worker", "orchestrator"] as const;
export type Topology = typeof TOPOLOGIES[number];

export const COMPOSITION_KINDS = ["preset", "bespoke"] as const;
export type CompositionKind = typeof COMPOSITION_KINDS[number];
export const SEMANTIC_TIERS = ["economy", "standard", "senior", "frontier"] as const;
export type RoutingTier = typeof SEMANTIC_TIERS[number];
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = typeof REASONING_LEVELS[number];
export const POSTURES = ["explore", "evaluate", "deliver", "preserve"] as const;
export type RoutingPosture = typeof POSTURES[number];

export const ROUTING_OVERRIDE_FIELDS = [
  "taskGrade", "domainRequirements", "tier", "reasoning", "posture",
] as const;
export type RoutingOverrideField = typeof ROUTING_OVERRIDE_FIELDS[number];

export interface BespokeContract {
  responsibility: string;
  deliverable: string;
  capabilities: GafferCapability[];
  mayDecide: string[];
  mustEscalate: string[];
  doneWhen: string[];
  report: string;
}

export interface PresetComposition {
  kind: "preset";
  id: string;
  overrides: RoutingOverrideField[];
  overrideReason?: string;
}

export interface BespokeComposition {
  kind: "bespoke";
  id: string;
  nearestPreset?: string;
  bespokeReason: string;
  promotionCandidate: boolean;
  contract: BespokeContract;
}
export type AgentComposition = PresetComposition | BespokeComposition;

/** The executable routing contract carried by every managed North boundary. */
export interface RoutingRequest {
  role: string;
  taskGrade: TaskGrade;
  domainRequirements: string[];
  topology: Topology;
  tier: RoutingTier;
  reasoning: ReasoningLevel;
  posture: RoutingPosture;
  composition: AgentComposition;
}

/** Partial input exists only while a trusted composer is constructing a request. */
export type RoutingDraft = Partial<RoutingRequest>;

/**
 * Compatibility name for parsing and composer utilities. Managed execution
 * surfaces must accept RoutingRequest, never this partial draft type.
 */
export type RoutingMetadata = RoutingDraft;

const ROUTING_FIELDS = new Set([
  "role", "taskGrade", "domainRequirements", "topology", "tier", "reasoning", "posture", "composition",
]);
const PRESET_COMPOSITION_FIELDS = new Set(["kind", "id", "overrides", "overrideReason"]);
const BESPOKE_COMPOSITION_FIELDS = new Set([
  "kind", "id", "nearestPreset", "bespokeReason", "promotionCandidate", "contract",
]);
const CONTRACT_FIELDS = new Set([
  "responsibility", "deliverable", "capabilities", "mayDecide", "mustEscalate", "doneWhen", "report",
]);

function rejectUnknownFields(value: object, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
}

function member<T extends readonly string[]>(values: T, value: unknown, field: string): T[number] | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !values.includes(value))
    throw new Error(`${field} must be one of: ${values.join(", ")}`);
  return value as T[number];
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function nonEmptyStrings(value: unknown, field: string, requireItems = false): string[] {
  if (!Array.isArray(value) || (requireItems && value.length === 0) ||
      value.some((item) => typeof item !== "string" || !item.trim()))
    throw new Error(`${field} must be ${requireItems ? "a non-empty" : "an"} array of non-empty strings`);
  const normalized = value.map((item) => item.trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} must not contain duplicates`);
  return normalized;
}

export function canonicalRole(role?: string): string | undefined {
  return role === undefined ? undefined : requireGafferRoleId(role);
}

export function validateRoutingMetadata(value: RoutingDraft): RoutingDraft {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    throw new Error("routing metadata must be an object");
  rejectUnknownFields(value, ROUTING_FIELDS, "routing metadata");
  const role = value.role === undefined ? undefined : requireGafferRoleId(value.role);
  const taskGrade = member(TASK_GRADES, value.taskGrade, "taskGrade");
  const topology = member(TOPOLOGIES, value.topology, "topology");
  const tier = member(SEMANTIC_TIERS, value.tier, "tier");
  const reasoning = member(REASONING_LEVELS, value.reasoning, "reasoning");
  const posture = member(POSTURES, value.posture, "posture");
  const domainRequirements = value.domainRequirements == null
    ? undefined
    : nonEmptyStrings(value.domainRequirements, "domainRequirements");
  if (tier && reasoning) requireProviderNeutralRoute(tier, reasoning);
  const composition: unknown = value.composition;
  let normalizedComposition: AgentComposition | undefined;
  if (composition != null) {
    if (typeof composition !== "object" || Array.isArray(composition))
      throw new Error("composition must be an object");
    const rawComposition = composition as Record<string, unknown>;
    const kind = member(COMPOSITION_KINDS, rawComposition.kind, "composition.kind");
    if (!kind) throw new Error("composition.kind is required");
    if (!role) throw new Error("composition requires role");
    const normalizedRole = canonicalRole(role)!;
    const compositionId = nonEmptyString(rawComposition.id, "composition.id");
    if (compositionId !== normalizedRole)
      throw new Error(`composition.id must match canonical role ${normalizedRole}`);
    if (kind === "preset") {
      rejectUnknownFields(rawComposition, PRESET_COMPOSITION_FIELDS, "composition");
      const overrides = nonEmptyStrings(rawComposition.overrides, "composition.overrides") as RoutingOverrideField[];
      if (overrides.some((field) => !ROUTING_OVERRIDE_FIELDS.includes(field)))
        throw new Error(`composition.overrides may contain only: ${ROUTING_OVERRIDE_FIELDS.join(", ")}`);
      if (overrides.length) nonEmptyString(rawComposition.overrideReason, "composition.overrideReason");
      else if (rawComposition.overrideReason !== undefined)
        throw new Error("unchanged preset must omit composition.overrideReason");
      normalizedComposition = {
        kind: "preset", id: compositionId, overrides,
        ...(overrides.length
          ? { overrideReason: nonEmptyString(rawComposition.overrideReason, "composition.overrideReason") }
          : {}),
      };
    } else {
      rejectUnknownFields(rawComposition, BESPOKE_COMPOSITION_FIELDS, "composition");
      const nearestPreset = rawComposition.nearestPreset === undefined
        ? undefined : nonEmptyString(rawComposition.nearestPreset, "composition.nearestPreset");
      const bespokeReason = nonEmptyString(rawComposition.bespokeReason, "composition.bespokeReason");
      if (typeof rawComposition.promotionCandidate !== "boolean")
        throw new Error("composition.promotionCandidate must be boolean");
      if (rawComposition.contract == null || typeof rawComposition.contract !== "object" || Array.isArray(rawComposition.contract))
        throw new Error("composition.contract must be an object");
      const rawContract = rawComposition.contract as Record<string, unknown>;
      rejectUnknownFields(rawContract, CONTRACT_FIELDS, "composition.contract");
      // Validation, child payload, harness composition, identity, and telemetry
      // all consume this one semantic form. No provider surface gets to trim or
      // deduplicate the authority contract differently from its fingerprint.
      const contract = canonicalBespokeContract(rawContract);
      const missing = [
        ["taskGrade", taskGrade], ["domainRequirements", domainRequirements], ["topology", topology],
        ["tier", tier], ["reasoning", reasoning], ["posture", posture],
      ].filter(([, field]) => field === undefined).map(([name]) => name);
      if (missing.length)
        throw new Error(`bespoke composition requires all routing axes; missing: ${missing.join(", ")}`);
      validateTopologyCapabilities(
        topology!, contract.capabilities, "composition.contract.capabilities",
      );
      normalizedComposition = {
        kind, id: compositionId, ...(nearestPreset ? { nearestPreset } : {}), bespokeReason,
        promotionCandidate: rawComposition.promotionCandidate, contract,
      };
    }
  }
  return {
    ...(role ? { role: canonicalRole(role) } : {}),
    ...(taskGrade ? { taskGrade } : {}),
    ...(domainRequirements ? { domainRequirements } : {}),
    ...(topology ? { topology } : {}),
    ...(tier ? { tier } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(posture ? { posture } : {}),
    ...(normalizedComposition ? { composition: normalizedComposition } : {}),
  };
}

export const ROUTING_REQUEST_FIELDS = [
  "role", "taskGrade", "domainRequirements", "topology",
  "tier", "reasoning", "posture", "composition",
] as const satisfies readonly (keyof RoutingRequest)[];

/** Structural/full parser only. Executable surfaces must call admitRoutingRequest. */
export function parseCompleteRoutingRequest(
  value: RoutingDraft,
  surface = "managed North agent",
): RoutingRequest {
  const normalized = validateRoutingMetadata(value);
  const missing = ROUTING_REQUEST_FIELDS.filter((field) => normalized[field] === undefined);
  if (missing.length) {
    throw new Error(
      `${surface} requires the complete eight-field Gaffer request; missing: ${missing.join(", ")}`,
    );
  }
  return normalized as RoutingRequest;
}

function jsonEnv<T>(name: string): T | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; }
  catch { throw new Error(`${name} must contain valid JSON`); }
}

export function routingMetadataFromEnv(): RoutingMetadata {
  return validateRoutingMetadata({
    role: process.env.AGENT_ROLE,
    taskGrade: process.env.AGENT_TASK_GRADE as TaskGrade | undefined,
    domainRequirements: jsonEnv<string[]>("AGENT_DOMAIN_REQUIREMENTS"),
    topology: process.env.AGENT_TOPOLOGY as Topology | undefined,
    tier: process.env.AGENT_TIER as RoutingTier | undefined,
    reasoning: process.env.AGENT_REASONING as ReasoningLevel | undefined,
    posture: process.env.AGENT_POSTURE as RoutingPosture | undefined,
    composition: jsonEnv<AgentComposition>("AGENT_COMPOSITION"),
  });
}
