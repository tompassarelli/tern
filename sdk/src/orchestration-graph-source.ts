import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Dual-read seam for the Gaffer -> North Orchestration migration
 * (thread 019f8f5c). `NORTH_STAFFING_SOURCE` selects where the staffing catalog
 * and provider catalogs are read from:
 *
 *   graph (DEFAULT, Phase 2) — the imported @catalog:current subgraph,
 *                     reconstructed to the identical JSON shape by
 *                     orchestration-project-cli.clj; the graph is authoritative.
 *   file            — the Gaffer JSON files, byte-for-byte as today; the
 *                     retained rollback flag (retirement is Phase 4).
 *
 * The equality gate (cli/tests/orchestration-parity-test.clj) proves the two
 * sources are byte-equal after normalization, so switching the flag never
 * changes a routing decision. Phase 2 flips the default to GRAPH; only an
 * explicit NORTH_STAFFING_SOURCE=file falls back to the packaged files.
 */
export type StaffingSource = "file" | "graph";

export function staffingSource(): StaffingSource {
  return process.env.NORTH_STAFFING_SOURCE === "file" ? "file" : "graph";
}

const REPO = resolve(import.meta.dir, "..", "..");
const projectorCli = resolve(REPO, "cli/orchestration-project-cli.clj");

function bb(): string {
  return process.env.NORTH_PEER_BB ?? "bb";
}

function port(): string {
  return process.env.NORTH_PORT ?? "7977";
}

function project(args: string[]): unknown {
  let out: string;
  try {
    out = execFileSync(bb(), [projectorCli, port(), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `NORTH_STAFFING_SOURCE=graph projection failed (${args.join(" ")}); `
      + `is @catalog:current imported on port ${port()}? ${detail}`,
    );
  }
  return JSON.parse(out);
}

/** Graph projection of staffing/catalog.json (same shape the file loader parses). */
export function projectStaffingCatalog(): unknown {
  return project(["staffing"]);
}

/** Graph projection of providers/<provider>.json (same shape the file loader parses). */
export function projectProviderCatalog(provider: string): unknown {
  return project(["provider", provider]);
}

/**
 * §3.1 point 6 receipt evidence: the catalog subgraph digest plus the two
 * version watermarks that name the EXACT graph state an admission accepted.
 * Replaces the catalog-FILE sha256s the receipt carried in file mode, so a
 * graph-mode receipt never digests a file the graph may no longer mirror.
 */
export interface CatalogGraphPin {
  catalogVersion: number;
  coordinatorVersion: number;
  catalogDigestSha256: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function projectCatalogGraphPin(): CatalogGraphPin {
  const raw = project(["catalog-pin"]) as Record<string, unknown>;
  const catalogVersion = Number(raw.catalogVersion);
  const coordinatorVersion = Number(raw.coordinatorVersion);
  const catalogDigestSha256 = raw.catalogDigestSha256;
  if (!Number.isInteger(catalogVersion) || catalogVersion < 1)
    throw new Error("catalog graph pin: catalogVersion must be a positive integer");
  if (!Number.isInteger(coordinatorVersion) || coordinatorVersion < 0)
    throw new Error("catalog graph pin: coordinatorVersion must be a non-negative integer");
  if (typeof catalogDigestSha256 !== "string" || !HEX64.test(catalogDigestSha256))
    throw new Error("catalog graph pin: catalogDigestSha256 must be a sha256 digest");
  return { catalogVersion, coordinatorVersion, catalogDigestSha256 };
}
