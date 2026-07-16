import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RoutingMetadata } from "./routing-metadata";

interface StaffingRecipe {
  name: string; taskGrade: string; tier: string; deliberation: string;
  topology: string; posture?: string;
}
interface StaffingCatalog {
  version: 1;
  defaults: Omit<StaffingRecipe, "name">;
  recipes: StaffingRecipe[];
  aliases: Array<{ name: string; target: string }>;
}

export const DEFAULT_GAFFER_STAFFING_PATH = resolve(
  process.env.GAFFER_HOME ?? resolve(homedir(), "code/gaffer"), "staffing/catalog.json",
);

export function loadGafferStaffing(
  path = process.env.GAFFER_STAFFING_CATALOG ?? DEFAULT_GAFFER_STAFFING_PATH,
): StaffingCatalog {
  const value = JSON.parse(readFileSync(path, "utf8")) as StaffingCatalog;
  if (value.version !== 1 || !Array.isArray(value.recipes) || !Array.isArray(value.aliases) || !value.defaults)
    throw new Error(`invalid Gaffer staffing catalog at ${path}`);
  return value;
}

export function canonicalStaffingRole(role: string | undefined, catalog = loadGafferStaffing()): string | undefined {
  return catalog.aliases.find(({ name }) => name === role)?.target ?? role;
}

/** Fill only omitted axes; explicit spawn/MCP values always win independently. */
export function applyGafferStaffing(metadata: RoutingMetadata, catalog = loadGafferStaffing()): RoutingMetadata {
  const role = canonicalStaffingRole(metadata.role, catalog);
  if (!role) return metadata;
  const recipe = catalog.recipes.find(({ name }) => name === role);
  if (!recipe) return { ...metadata, role };
  return {
    role,
    taskGrade: metadata.taskGrade ?? recipe.taskGrade as RoutingMetadata["taskGrade"],
    domainRequirements: metadata.domainRequirements ?? [],
    topology: metadata.topology ?? recipe.topology as RoutingMetadata["topology"],
    tier: metadata.tier ?? recipe.tier as RoutingMetadata["tier"],
    reasoning: metadata.reasoning ?? recipe.deliberation as RoutingMetadata["reasoning"],
    posture: metadata.posture ?? recipe.posture as RoutingMetadata["posture"] ?? catalog.defaults.posture as RoutingMetadata["posture"],
    composition: metadata.composition ?? { kind: "preset", id: role },
  };
}
