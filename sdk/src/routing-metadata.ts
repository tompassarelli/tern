export const TASK_GRADES = ["novice", "junior", "mid", "senior", "staff", "principal", "research-grade"] as const;
export type TaskGrade = typeof TASK_GRADES[number];

export const TOPOLOGIES = ["worker", "verifier", "orchestrator"] as const;
export type Topology = typeof TOPOLOGIES[number];

export const COMPOSITION_KINDS = ["preset", "bespoke"] as const;
export type CompositionKind = typeof COMPOSITION_KINDS[number];
export const SEMANTIC_TIERS = ["economy", "standard", "senior", "frontier"] as const;
export type RoutingTier = typeof SEMANTIC_TIERS[number];
export const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = typeof REASONING_LEVELS[number];
export const POSTURES = ["explore", "deliver", "preserve"] as const;
export type RoutingPosture = typeof POSTURES[number];

export interface AgentComposition {
  kind: CompositionKind;
  id: string;
  nearestPreset?: string;
  bespokeReason?: string;
  promotionCandidate?: boolean;
}

export interface RoutingMetadata {
  role?: string;
  taskGrade?: TaskGrade;
  domainRequirements?: string[];
  topology?: Topology;
  tier?: RoutingTier;
  reasoning?: ReasoningLevel;
  posture?: RoutingPosture;
  composition?: AgentComposition;
}

function member<T extends readonly string[]>(values: T, value: unknown, field: string): T[number] | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !values.includes(value))
    throw new Error(`${field} must be one of: ${values.join(", ")}`);
  return value as T[number];
}

export function canonicalRole(role?: string): string | undefined {
  try { return canonicalStaffingRole(role); }
  catch { return role === "researcher" ? "scout" : role; }
}

export function validateRoutingMetadata(value: RoutingMetadata): RoutingMetadata {
  const role = value.role;
  if (role != null && (typeof role !== "string" || !role.trim())) throw new Error("role must be a non-empty string");
  const taskGrade = member(TASK_GRADES, value.taskGrade, "taskGrade");
  const topology = member(TOPOLOGIES, value.topology, "topology");
  const tier = member(SEMANTIC_TIERS, value.tier, "tier");
  const reasoning = member(REASONING_LEVELS, value.reasoning, "reasoning");
  const posture = member(POSTURES, value.posture, "posture");
  const domainRequirements = value.domainRequirements;
  if (domainRequirements != null && (!Array.isArray(domainRequirements) || domainRequirements.some((x) => typeof x !== "string" || !x.trim())))
    throw new Error("domainRequirements must be an array of non-empty strings");
  const composition = value.composition;
  if (composition != null) {
    member(COMPOSITION_KINDS, composition.kind, "composition.kind");
    if (typeof composition.id !== "string" || !composition.id.trim()) throw new Error("composition.id must be a non-empty string");
    if (composition.nearestPreset != null && (typeof composition.nearestPreset !== "string" || !composition.nearestPreset.trim()))
      throw new Error("composition.nearestPreset must be a non-empty string");
    if (composition.bespokeReason != null && (typeof composition.bespokeReason !== "string" || !composition.bespokeReason.trim()))
      throw new Error("composition.bespokeReason must be a non-empty string");
    if (composition.promotionCandidate != null && typeof composition.promotionCandidate !== "boolean")
      throw new Error("composition.promotionCandidate must be boolean");
    if (composition.kind === "bespoke" && !composition.bespokeReason)
      throw new Error("bespoke composition requires composition.bespokeReason");
  }
  return {
    ...(role ? { role: canonicalRole(role.trim()) } : {}),
    ...(taskGrade ? { taskGrade } : {}),
    ...(domainRequirements ? { domainRequirements: domainRequirements.map((x) => x.trim()) } : {}),
    ...(topology ? { topology } : {}),
    ...(tier ? { tier } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(posture ? { posture } : {}),
    ...(composition ? { composition } : {}),
  };
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
    reasoning: (process.env.AGENT_REASONING ?? process.env.AGENT_EFFORT) as ReasoningLevel | undefined,
    posture: process.env.AGENT_POSTURE as RoutingPosture | undefined,
    composition: jsonEnv<AgentComposition>("AGENT_COMPOSITION"),
  });
}
import { canonicalStaffingRole } from "./gaffer-staffing";
