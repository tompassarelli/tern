/**
 * Phase 1 dual-read parity probe for the Gaffer -> North Orchestration migration
 * (thread 019f8f5c). The `north spawn ... --dry-run` equivalent: it composes the
 * exact staffing + provider resolution the spawn path uses, once with
 * NORTH_STAFFING_SOURCE=file and once with =graph, and asserts the two are
 * identical. A live coordinator with @catalog:current imported is required.
 *
 *   bun run src/orchestration-dual-read-probe.ts [role]
 *
 * Exit 0 on byte-identical parity across both flag values; 1 on any divergence.
 */
import { applyGafferStaffing, gafferCapabilities, loadGafferStaffing } from "./gaffer-staffing";
import { resolveTier, SEMANTIC_TIER_ORDER } from "./providers/catalog";
import type { ProviderId } from "./providers/types";
import type { RoutingDraft } from "./routing-metadata";

const PROVIDERS: ProviderId[] = ["anthropic", "openai"];

function composeAll(role: string): unknown {
  const catalog = loadGafferStaffing();
  const request = applyGafferStaffing({ role } as RoutingDraft, catalog);
  const capabilities = gafferCapabilities(request, catalog);
  const routes: Record<string, unknown> = {};
  for (const provider of PROVIDERS) {
    for (const tier of SEMANTIC_TIER_ORDER) {
      routes[`${provider}/${tier}`] = resolveTier(provider, tier);
    }
  }
  return { request, capabilities, routes };
}

function withSource<T>(source: "file" | "graph", fn: () => T): T {
  const prior = process.env.NORTH_STAFFING_SOURCE;
  process.env.NORTH_STAFFING_SOURCE = source;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.NORTH_STAFFING_SOURCE;
    else process.env.NORTH_STAFFING_SOURCE = prior;
  }
}

const role = process.argv[2] ?? "verifier";
const fileComposition = withSource("file", () => composeAll(role));
const graphComposition = withSource("graph", () => composeAll(role));

const fileJson = JSON.stringify(fileComposition);
const graphJson = JSON.stringify(graphComposition);

if (fileJson === graphJson) {
  console.log(`✓ dual-read parity for role '${role}': file ≡ graph (${fileJson.length} bytes each)`);
  process.exit(0);
}
console.error(`✗ dual-read DIVERGES for role '${role}'`);
console.error(`  file : ${fileJson.slice(0, 400)}`);
console.error(`  graph: ${graphJson.slice(0, 400)}`);
process.exit(1);
