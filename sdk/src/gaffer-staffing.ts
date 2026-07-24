import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  RoutingDraft, RoutingMetadata, RoutingOverrideField, RoutingRequest,
} from "./routing-metadata";
import {
  POSTURES, REASONING_LEVELS, SEMANTIC_TIERS, TASK_GRADES, TOPOLOGIES,
  parseCompleteRoutingRequest,
} from "./routing-metadata";
import {
  GAFFER_CAPABILITIES, GAFFER_PRESET_CAPABILITIES, requireGafferCapabilities,
  validateTopologyCapabilities,
  type GafferCapability,
} from "./gaffer-capabilities";
import { requireGafferRoleId } from "./gaffer-role-id";
import { requireProviderNeutralRoute } from "./provider-neutral-route";
import {
  projectStaffingCatalog, staffingSource, warnGraphCatalogFallback,
} from "./orchestration-graph-source";

interface StaffingPreset {
  name: string; taskGrade: string; tier: string; deliberation: string;
  topology: string; posture: string; tagline: string; description: string;
  capabilities: GafferCapability[];
}
interface StaffingDefaults {
  taskGrade: string;
  tier: string;
  deliberation: string;
  topology: string;
  posture: string;
}
interface StaffingCatalog {
  sourceVersion: 2;
  vocabulary: { capabilities: GafferCapability[] };
  defaults: StaffingDefaults;
  presets: StaffingPreset[];
  aliases: Array<{ name: string; target: string }>;
}

export const GAFFER_STOCK_ROLE_IDS = [
  "executor", "implementer", "integrator", "designer", "director", "scout",
  "analyst", "reviewer", "verifier", "judge", "research-scientist",
] as const;
const STOCK_AUTHORING_ROLES = new Set(["executor", "implementer", "integrator"]);

export const DEFAULT_GAFFER_STAFFING_PATH = resolve(
  process.env.GAFFER_HOME ?? resolve(homedir(), "code/gaffer"), "staffing/catalog.json",
);

const TOP_LEVEL_FIELDS = ["$schema", "version", "vocabulary", "defaults", "presets", "aliases"];
const VOCABULARY_FIELDS = [
  "taskGrades", "semanticTiers", "deliberations", "topologies", "postures", "capabilities",
];
const DEFAULT_FIELDS = ["taskGrade", "tier", "deliberation", "topology", "posture"];
const PRESET_FIELDS = [
  "name", "taskGrade", "tier", "deliberation", "topology", "posture",
  "capabilities", "tagline", "description",
];

function exactKeys(value: unknown, allowed: readonly string[], label: string): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`staffing catalog: ${label} must be an object`);
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => key !== "$schema" && !Object.hasOwn(value, key));
  if (unknown.length) throw new Error(`staffing catalog: ${label} has unknown field(s): ${unknown.join(", ")}`);
  if (missing.length) throw new Error(`staffing catalog: ${label} is missing field(s): ${missing.join(", ")}`);
  return true;
}

function uniqueVocabulary(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0
      || value.some((entry) => typeof entry !== "string" || !entry))
    throw new Error(`staffing catalog: vocabulary.${label} must contain non-empty strings`);
  if (new Set(value).size !== value.length)
    throw new Error(`staffing catalog: duplicate vocabulary.${label}`);
  return value;
}

export function loadGafferStaffing(
  path = process.env.GAFFER_STAFFING_CATALOG ?? DEFAULT_GAFFER_STAFFING_PATH,
): StaffingCatalog {
  // Dual-read seam (Phase 1): graph mode reconstructs the identical catalog
  // shape from @catalog:current; file mode (default) reads the Gaffer JSON.
  // On projector failure graph mode FALLS BACK to the packaged JSON so spawn
  // admission never blocks on the graph (the named failure is logged).
  let value: Record<string, any>;
  if (staffingSource() === "graph") {
    try {
      value = projectStaffingCatalog() as Record<string, any>;
    } catch (error) {
      warnGraphCatalogFallback("staffing catalog", error);
      value = JSON.parse(readFileSync(path, "utf8"));
    }
  } else {
    value = JSON.parse(readFileSync(path, "utf8"));
  }
  const sourceVersion = value.version;
  if (sourceVersion !== 2) throw new Error("staffing catalog: version must be 2");
  exactKeys(value, TOP_LEVEL_FIELDS, "top level");
  exactKeys(value.vocabulary, VOCABULARY_FIELDS, "vocabulary");
  const vocabularyByAxis = Object.fromEntries(
    VOCABULARY_FIELDS.map((axis) => [axis, uniqueVocabulary(value.vocabulary[axis], axis)]),
  );
  for (const [axis, expected] of Object.entries({
    taskGrades: TASK_GRADES,
    semanticTiers: SEMANTIC_TIERS,
    deliberations: REASONING_LEVELS,
    topologies: TOPOLOGIES,
    postures: POSTURES,
    capabilities: GAFFER_PRESET_CAPABILITIES,
  })) {
    const actual = [...vocabularyByAxis[axis]].sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
      throw new Error(`Gaffer wire vocabulary drift at ${path}: ${axis}`);
  }
  exactKeys(value.defaults, DEFAULT_FIELDS, "defaults");
  for (const [field, axis] of [
    ["taskGrade", "taskGrades"], ["tier", "semanticTiers"], ["deliberation", "deliberations"],
    ["topology", "topologies"], ["posture", "postures"],
  ] as const) {
    if (!vocabularyByAxis[axis].includes(value.defaults[field]))
      throw new Error(`staffing catalog: invalid defaults.${field}`);
  }
  const presets = value.presets;
  if (!Array.isArray(presets) || presets.length === 0)
    throw new Error("staffing catalog: presets must be non-empty");
  if (!Array.isArray(value.aliases))
    throw new Error("staffing catalog: aliases must be an array");
  const vocabulary = requireGafferCapabilities(
    value.vocabulary?.capabilities, "staffing catalog vocabulary.capabilities",
  );
  if (JSON.stringify([...vocabulary].sort())
      !== JSON.stringify([...GAFFER_PRESET_CAPABILITIES].sort()))
    throw new Error(`Gaffer capability vocabulary drift at ${path}`);
  const presetNames = new Set<string>();
  for (const preset of presets) {
    exactKeys(preset, PRESET_FIELDS, `preset ${preset?.name ?? "<unknown>"}`);
    requireGafferRoleId(preset.name, "staffing catalog preset");
    if (presetNames.has(preset.name)) throw new Error(`duplicate Gaffer preset ${preset.name}`);
    presetNames.add(preset.name);
    preset.capabilities = requireGafferCapabilities(
      preset.capabilities, `staffing preset ${preset.name}.capabilities`,
    );
    if (preset.capabilities.some((capability: GafferCapability) => !vocabulary.includes(capability)))
      throw new Error(`staffing preset ${preset.name}.capabilities contains a bespoke-only capability`);
    for (const [field, axis] of [
      ["taskGrade", "taskGrades"], ["tier", "semanticTiers"], ["deliberation", "deliberations"],
      ["topology", "topologies"], ["posture", "postures"],
    ] as const) {
      if (!vocabularyByAxis[axis].includes(preset[field]))
        throw new Error(`${preset.name}: invalid ${field} ${JSON.stringify(preset[field])}`);
    }
    if (typeof preset.tagline !== "string" || !preset.tagline.trim()
        || typeof preset.description !== "string" || !preset.description.trim())
      throw new Error(`${preset.name}: missing tagline or description`);
    if (preset.topology !== "worker" && preset.topology !== "orchestrator")
      throw new Error(`invalid Gaffer topology for ${preset.name}`);
    validateTopologyCapabilities(preset.topology, preset.capabilities, `${preset.name}.capabilities`);
  }
  const exactNames = [...GAFFER_STOCK_ROLE_IDS].sort();
  const actualNames = [...presetNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(exactNames))
    throw new Error(`Gaffer stock preset set drift at ${path}`);
  const orchestrators = presets.filter(({ topology }) => topology === "orchestrator")
    .map(({ name }) => name);
  if (orchestrators.length !== 1 || orchestrators[0] !== "director")
    throw new Error(`Gaffer stock topology drift at ${path}: only director may orchestrate`);
  if (value.aliases.length !== 0)
    throw new Error(`Gaffer stock alias drift at ${path}: canonical release has no aliases`);
  for (const preset of presets) {
    const capabilities = new Set(preset.capabilities);
    if (!capabilities.has("filesystem.read") || !capabilities.has("filesystem.search"))
      throw new Error(`Gaffer stock role ${preset.name} must retain read and search authority`);
    if (STOCK_AUTHORING_ROLES.has(preset.name)) {
      if (!capabilities.has("filesystem.write") || !capabilities.has("shell"))
        throw new Error(`Gaffer stock authoring role ${preset.name} must retain write and shell authority`);
    } else if (capabilities.has("filesystem.write") || capabilities.has("shell")
               || !capabilities.has("shell.readonly")) {
      throw new Error(`Gaffer stock nonauthoring role ${preset.name} must remain read-only`);
    }
    if ((preset.name === "director") !== capabilities.has("coordination"))
      throw new Error("Gaffer stock coordination authority belongs only to director");
  }
  for (const alias of value.aliases) {
    requireGafferRoleId(alias.name, "staffing catalog alias");
    requireGafferRoleId(alias.target, "staffing catalog alias target");
    if (!presetNames.has(alias.target)) throw new Error(`Gaffer alias target is missing: ${alias.target}`);
  }
  return { sourceVersion, vocabulary: value.vocabulary, defaults: value.defaults, presets, aliases: value.aliases };
}

export function canonicalStaffingRole(role: string | undefined, catalog = loadGafferStaffing()): string | undefined {
  if (role === undefined) return undefined;
  requireGafferRoleId(role);
  const alias = catalog.aliases.find(({ name }) => name === role);
  if (alias) throw new Error(`role must use canonical stock-template name ${alias.target}`);
  return role;
}

export function gafferCapabilities(
  metadata: RoutingRequest,
  catalog = loadGafferStaffing(),
): GafferCapability[] {
  const role = canonicalStaffingRole(metadata.role, catalog);
  if (!role || !metadata.composition)
    throw new Error("managed Gaffer capabilities require a selected role and composition");
  if (metadata.composition.kind === "bespoke")
    return requireGafferCapabilities(
      metadata.composition.contract.capabilities, "composition.contract.capabilities",
    );
  const preset = catalog.presets.find(({ name }) => name === role);
  if (!preset) throw new Error(`Gaffer preset ${role} is absent from the staffing catalog`);
  return [...preset.capabilities];
}

/** Compose a request: overrideable axes may vary, but stock topology is fixed. */
export function applyGafferStaffing(
  metadata: RoutingDraft,
  catalog = loadGafferStaffing(),
): RoutingRequest {
  const role = canonicalStaffingRole(metadata.role, catalog);
  if (!role) throw new Error("Gaffer request composer requires an explicit role");
  const preset = catalog.presets.find(({ name }) => name === role);
  if (!preset) {
    const composition = metadata.composition;
    const nearest = composition?.kind === "bespoke" && composition.nearestPreset
      ? catalog.presets.find(({ name }) => name === composition.nearestPreset)
      : undefined;
    const nearestKnown = composition?.kind === "bespoke"
      && (composition.nearestPreset === undefined || nearest !== undefined);
    const missing = ["taskGrade", "topology", "tier", "reasoning", "posture"]
      .filter((field) =>
        metadata[field as keyof RoutingMetadata] === undefined
        && nearest === undefined
      );
    if (composition?.kind !== "bespoke" || composition.id !== role || !composition.bespokeReason ||
        typeof composition.promotionCandidate !== "boolean" || !composition.contract || !nearestKnown || missing.length) {
      const detail = missing.length ? `; missing executable axes: ${missing.join(", ")}` : "";
      throw new Error(
        `unknown Gaffer role ${role} requires composition.kind=bespoke, composition.id=${role}, `
        + "an optional-but-valid nearestPreset, composition.bespokeReason, explicit promotionCandidate, "
        + `structured contract, and all unseeded routing axes${detail}`,
      );
    }
    const request = {
      ...metadata,
      role,
      taskGrade: metadata.taskGrade ?? nearest?.taskGrade,
      domainRequirements: metadata.domainRequirements ?? [],
      topology: metadata.topology ?? nearest?.topology,
      tier: metadata.tier ?? nearest?.tier,
      reasoning: metadata.reasoning ?? nearest?.deliberation,
      posture: metadata.posture ?? nearest?.posture ?? catalog.defaults.posture,
    } as RoutingRequest;
    validateTopologyCapabilities(
      request.topology, composition.contract.capabilities, `${role}.capabilities`,
    );
    requireProviderNeutralRoute(request.tier, request.reasoning);
    return parseCompleteRoutingRequest(request, "Gaffer request composer");
  }
  if (metadata.composition && (metadata.composition.kind !== "preset" || metadata.composition.id !== role)) {
    throw new Error(
      `known Gaffer role ${role} requires composition.kind=preset and composition.id=${role}; `
      + "use a distinct role name for a bespoke composition",
    );
  }
  // Stock-template topology is fixed by the preset, not an overridable axis: a
  // different topology is a different capability boundary and requires a
  // bespoke composition, never a preset override.
  if (metadata.topology !== undefined && metadata.topology !== preset.topology) {
    throw new Error(
      `stock-template topology is fixed at '${preset.topology}'; project a different topology through a bespoke composition`,
    );
  }
  const base = {
    taskGrade: preset.taskGrade,
    domainRequirements: [],
    topology: preset.topology,
    tier: preset.tier,
    reasoning: preset.deliberation,
    posture: preset.posture ?? catalog.defaults.posture,
  };
  if (metadata.topology !== undefined && metadata.topology !== preset.topology) {
    throw new Error(
      `stock-template topology is fixed at '${preset.topology}'; `
      + "use a bespoke composition with explicit capabilities to change topology",
    );
  }
  const overrideFields: RoutingOverrideField[] = [
    "taskGrade", "domainRequirements", "tier", "reasoning", "posture",
  ];
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const actualOverrides = overrideFields.filter((field) =>
    metadata[field] !== undefined && !same(metadata[field], base[field]));
  const composition = metadata.composition;
  if (actualOverrides.length && !composition) {
    throw new Error(
      `known Gaffer role ${role} overrides ${actualOverrides.join(", ")}; supply preset composition.overrides and composition.overrideReason`,
    );
  }
  if (composition?.kind === "preset") {
    const declared = [...composition.overrides].sort();
    const actual = [...actualOverrides].sort();
    if (!same(declared, actual))
      throw new Error(`composition.overrides must exactly record changed preset axes: ${actual.join(", ") || "none"}`);
    if (actualOverrides.length && !composition.overrideReason)
      throw new Error("preset axis overrides require composition.overrideReason");
    if (!actualOverrides.length && composition.overrideReason !== undefined)
      throw new Error("unchanged preset must omit composition.overrideReason");
  }
  validateTopologyCapabilities(
    preset.topology as "worker" | "orchestrator",
    preset.capabilities,
    `${role}.capabilities`,
  );
  const request = {
    role,
    taskGrade: metadata.taskGrade ?? base.taskGrade as RoutingMetadata["taskGrade"],
    domainRequirements: metadata.domainRequirements ?? [],
    topology: base.topology as RoutingMetadata["topology"],
    tier: metadata.tier ?? base.tier as RoutingMetadata["tier"],
    reasoning: metadata.reasoning ?? base.reasoning as RoutingMetadata["reasoning"],
    posture: metadata.posture ?? base.posture as RoutingMetadata["posture"],
    composition: composition ?? { kind: "preset", id: role, overrides: [] },
  } as RoutingRequest;
  requireProviderNeutralRoute(request.tier, request.reasoning);
  return parseCompleteRoutingRequest(request, "Gaffer request composer");
}

/**
 * Managed North lanes must have an attributable staffing decision. A known
 * role hydrates to a canonical preset in applyGafferStaffing; an unknown role
 * survives only with the complete bespoke contract validated there. Native
 * provider sessions are outside this boundary and remain honestly unselected.
 */
export function requireManagedGafferSelection(
  metadata: RoutingDraft,
  surface = "managed North agent",
): RoutingRequest {
  const required = [
    "role", "taskGrade", "domainRequirements", "topology",
    "tier", "reasoning", "posture", "composition",
  ] as const;
  const missing = required.filter((field) => metadata[field] === undefined);
  if (missing.length) {
    throw new Error(
      `${surface} requires the complete eight-field Gaffer request; missing: ${missing.join(", ")}`,
    );
  }
  return metadata as RoutingRequest;
}
