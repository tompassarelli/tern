import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Phase 1 dual-read seam for the Gaffer -> North Orchestration migration
 * (thread 019f8f5c). `NORTH_STAFFING_SOURCE` selects where the staffing catalog
 * and provider catalogs are read from:
 *
 *   file  (DEFAULT) — the Gaffer JSON files, byte-for-byte as today.
 *   graph           — the imported @catalog:current subgraph, reconstructed to
 *                     the identical JSON shape by orchestration-project-cli.clj.
 *
 * The equality gate (cli/tests/orchestration-parity-test.clj) proves the two
 * sources are byte-equal after normalization, so switching the flag never
 * changes a routing decision. The default is NOT flipped in Phase 1.
 */
export type StaffingSource = "file" | "graph";

export function staffingSource(): StaffingSource {
  return process.env.NORTH_STAFFING_SOURCE === "graph" ? "graph" : "file";
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
