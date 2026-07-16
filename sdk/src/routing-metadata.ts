export const TASK_GRADES = ["novice", "junior", "mid", "senior", "staff", "principal", "research-grade"] as const;
export type TaskGrade = typeof TASK_GRADES[number];

export const TOPOLOGIES = ["worker", "verifier", "orchestrator"] as const;
export type Topology = typeof TOPOLOGIES[number];

export const COMPOSITION_KINDS = ["preset", "bespoke"] as const;
export type CompositionKind = typeof COMPOSITION_KINDS[number];

export interface AgentComposition {
  kind: CompositionKind;
  id: string;
  nearestPreset?: string;
  bespokeReason?: string;
  promotionCandidate?: boolean;
}

export interface RoutingMetadata {
  taskGrade?: TaskGrade;
  domainRequirements?: string[];
  topology?: Topology;
  composition?: AgentComposition;
}

function member<T extends readonly string[]>(values: T, value: unknown, field: string): T[number] | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !values.includes(value))
    throw new Error(`${field} must be one of: ${values.join(", ")}`);
  return value as T[number];
}

export function canonicalRole(role?: string): string | undefined {
  return role === "researcher" ? "scout" : role;
}

export function validateRoutingMetadata(value: RoutingMetadata): RoutingMetadata {
  const taskGrade = member(TASK_GRADES, value.taskGrade, "taskGrade");
  const topology = member(TOPOLOGIES, value.topology, "topology");
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
  return { taskGrade, topology, domainRequirements: domainRequirements?.map((x) => x.trim()), composition };
}

function jsonEnv<T>(name: string): T | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; }
  catch { throw new Error(`${name} must contain valid JSON`); }
}

export function routingMetadataFromEnv(): RoutingMetadata {
  return validateRoutingMetadata({
    taskGrade: process.env.AGENT_TASK_GRADE as TaskGrade | undefined,
    domainRequirements: jsonEnv<string[]>("AGENT_DOMAIN_REQUIREMENTS"),
    topology: process.env.AGENT_TOPOLOGY as Topology | undefined,
    composition: jsonEnv<AgentComposition>("AGENT_COMPOSITION"),
  });
}
