import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectCatalogGraphPin } from "../src/orchestration-graph-source";

// Phase 3 slice 4 (§3.1 point 6): under NORTH_STAFFING_SOURCE=graph the admission
// receipt names the EXACT graph state — a subgraph digest plus the catalog pointer
// version and the daemon tx watermark — instead of digesting catalog FILES. These
// assertions are hermetic (no live coordinator): the projector JSON is driven by a
// fake `bb`, exactly as the §3.2 policy-pin suite does. The end-to-end receipt
// against the real coordinator is recorded as bar_evidence on the thread.

const DIGEST = "c".repeat(64);
const priorBb = process.env.NORTH_PEER_BB;
const scratch: string[] = [];

afterEach(() => {
  if (priorBb === undefined) delete process.env.NORTH_PEER_BB;
  else process.env.NORTH_PEER_BB = priorBb;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeBb(body: string): void {
  const dir = mkdtempSync(join(tmpdir(), "north-catalog-pin-"));
  scratch.push(dir);
  const bb = join(dir, "bb");
  writeFileSync(bb, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(bb, 0o755);
  process.env.NORTH_PEER_BB = bb;
}

test("projectCatalogGraphPin parses the catalog digest and both version watermarks", () => {
  fakeBb(`printf '%s' '{"catalogVersion":3,"coordinatorVersion":322995,`
    + `"catalogDigestSha256":"${DIGEST}"}'`);
  const pin = projectCatalogGraphPin();
  expect(pin).toEqual({
    catalogVersion: 3, coordinatorVersion: 322995, catalogDigestSha256: DIGEST,
  });
});

test("projectCatalogGraphPin rejects a non-digest catalog hash rather than admitting it", () => {
  fakeBb(`printf '%s' '{"catalogVersion":1,"coordinatorVersion":1,"catalogDigestSha256":"nope"}'`);
  expect(() => projectCatalogGraphPin()).toThrow(/catalogDigestSha256 must be a sha256 digest/);
});

test("projectCatalogGraphPin rejects a non-positive catalog version", () => {
  fakeBb(`printf '%s' '{"catalogVersion":0,"coordinatorVersion":1,"catalogDigestSha256":"${DIGEST}"}'`);
  expect(() => projectCatalogGraphPin()).toThrow(/catalogVersion must be a positive integer/);
});

test("projectCatalogGraphPin fails closed when the projector cannot run", () => {
  fakeBb("exit 7");
  expect(() => projectCatalogGraphPin()).toThrow(/projection failed/);
});
