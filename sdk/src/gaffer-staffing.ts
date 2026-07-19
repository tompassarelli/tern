import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RoutingMetadata, RoutingOverrideField } from "./routing-metadata";
import {
  GAFFER_CAPABILITIES, requireGafferCapabilities, validateTopologyCapabilities,
  type GafferCapability,
} from "./gaffer-capabilities";
import { requireGafferRoleId } from "./gaffer-role-id";

interface StaffingPreset {
  name: string; taskGrade: string; tier: string; deliberation: string;
  topology: string; posture?: string;
  capabilities: GafferCapability[];
}
interface StaffingCatalog {
  sourceVersion: 1 | 2;
  vocabulary: { capabilities: GafferCapability[] };
  defaults: Omit<StaffingPreset, "name">;
  presets: StaffingPreset[];
  aliases: Array<{ name: string; target: string }>;
}

export const DEFAULT_GAFFER_STAFFING_PATH = resolve(
  process.env.GAFFER_HOME ?? resolve(homedir(), "code/gaffer"), "staffing/catalog.json",
);

export function loadGafferStaffing(
  path = process.env.GAFFER_STAFFING_CATALOG ?? DEFAULT_GAFFER_STAFFING_PATH,
): StaffingCatalog {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const sourceVersion = value.version;
  const presets = sourceVersion === 1 ? value.recipes : sourceVersion === 2 ? value.presets : undefined;
  if ((sourceVersion !== 1 && sourceVersion !== 2) || !Array.isArray(presets) ||
      !Array.isArray(value.aliases) || !value.defaults)
    throw new Error(`invalid Gaffer staffing catalog at ${path}`);
  const vocabulary = requireGafferCapabilities(
    value.vocabulary?.capabilities, "staffing catalog vocabulary.capabilities",
  );
  if (JSON.stringify([...vocabulary].sort()) !== JSON.stringify([...GAFFER_CAPABILITIES].sort()))
    throw new Error(`Gaffer capability vocabulary drift at ${path}`);
  const presetNames = new Set<string>();
  for (const preset of presets) {
    requireGafferRoleId(preset.name, "staffing catalog preset");
    if (presetNames.has(preset.name)) throw new Error(`duplicate Gaffer preset ${preset.name}`);
    presetNames.add(preset.name);
    preset.capabilities = requireGafferCapabilities(
      preset.capabilities, `staffing preset ${preset.name}.capabilities`,
    );
    if (preset.topology !== "worker" && preset.topology !== "orchestrator")
      throw new Error(`invalid Gaffer topology for ${preset.name}`);
    validateTopologyCapabilities(preset.topology, preset.capabilities, `${preset.name}.capabilities`);
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
  return catalog.aliases.find(({ name }) => name === role)?.target ?? role;
}

export function gafferCapabilities(
  metadata: RoutingMetadata,
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

/** Fill only omitted axes; explicit spawn/MCP values always win independently. */
export function applyGafferStaffing(metadata: RoutingMetadata, catalog = loadGafferStaffing()): RoutingMetadata {
  const role = canonicalStaffingRole(metadata.role, catalog);
  if (!role) return metadata;
  const preset = catalog.presets.find(({ name }) => name === role);
  if (!preset) {
    const missing = ["taskGrade", "domainRequirements", "topology", "tier", "reasoning", "posture"]
      .filter((field) => metadata[field as keyof RoutingMetadata] === undefined);
    const composition = metadata.composition;
    const nearestKnown = composition?.kind === "bespoke" &&
      (composition.nearestPreset === undefined ||
       catalog.presets.some(({ name }) => name === composition.nearestPreset));
    if (composition?.kind !== "bespoke" || composition.id !== role || !composition.bespokeReason ||
        typeof composition.promotionCandidate !== "boolean" || !composition.contract || !nearestKnown || missing.length) {
      const detail = missing.length ? `; missing executable axes: ${missing.join(", ")}` : "";
      throw new Error(
        `unknown Gaffer role ${role} requires composition.kind=bespoke, composition.id=${role}, `
        + "an optional-but-valid nearestPreset, composition.bespokeReason, explicit promotionCandidate, "
        + `structured contract, and all routing axes${detail}`,
      );
    }
    validateTopologyCapabilities(
      metadata.topology!, composition.contract.capabilities, `${role}.capabilities`,
    );
    return { ...metadata, role };
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
    (metadata.topology ?? preset.topology) as "worker" | "orchestrator",
    preset.capabilities,
    `${role}.capabilities`,
  );
  return {
    role,
    taskGrade: metadata.taskGrade ?? base.taskGrade as RoutingMetadata["taskGrade"],
    domainRequirements: metadata.domainRequirements ?? [],
    topology: metadata.topology ?? base.topology as RoutingMetadata["topology"],
    tier: metadata.tier ?? base.tier as RoutingMetadata["tier"],
    reasoning: metadata.reasoning ?? base.reasoning as RoutingMetadata["reasoning"],
    posture: metadata.posture ?? base.posture as RoutingMetadata["posture"],
    composition: composition ?? { kind: "preset", id: role, overrides: [] },
  };
}

/**
 * Managed North lanes must have an attributable staffing decision. A known
 * role hydrates to a canonical preset in applyGafferStaffing; an unknown role
 * survives only with the complete bespoke contract validated there. Native
 * provider sessions are outside this boundary and remain honestly unselected.
 */
export function requireManagedGafferSelection(
  metadata: RoutingMetadata,
  surface = "managed North agent",
): RoutingMetadata {
  if (!metadata.role || !metadata.composition) {
    throw new Error(
      `${surface} requires a Gaffer role: select a canonical preset role, `
      + "or provide a distinct bespoke role with complete routing axes and composition contract",
    );
  }
  return metadata;
}
