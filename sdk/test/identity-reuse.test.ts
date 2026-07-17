import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentFacts } from "../src/identity";

const saved = process.env.NORTH_BIN;
const savedRedirect = process.env.NORTH_IDENTITY_TEST_REDIRECT;
let directory = "";
afterEach(() => {
  if (saved === undefined) delete process.env.NORTH_BIN; else process.env.NORTH_BIN = saved;
  if (savedRedirect === undefined) delete process.env.NORTH_IDENTITY_TEST_REDIRECT;
  else process.env.NORTH_IDENTITY_TEST_REDIRECT = savedRedirect;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test("sequential lane-id reuse retracts the prior outcome before publishing identity", () => {
  directory = mkdtempSync(join(tmpdir(), "north-identity-reuse-"));
  const log = join(directory, "commands.log");
  const fake = join(directory, "north");
  writeFileSync(fake, `#!/usr/bin/env bash
if [ "$1 $2" = "json show" ]; then
  printf '%s\\n' '[{"predicate":"kind","value":"lane"},{"predicate":"outcome","value":"ran"},{"predicate":"process_outcome","value":"ran"},{"predicate":"delivery_outcome","value":"unverified"},{"predicate":"delivery_reason","value":"provider_terminal_success_without_external_verification"},{"predicate":"terminal_manifest_sha256","value":"old"}]'
  exit 0
fi
printf '%s\\n' "$*" >> "${log}"
`);
  chmodSync(fake, 0o700);
  process.env.NORTH_BIN = fake;
  process.env.NORTH_IDENTITY_TEST_REDIRECT = "1";

  writeAgentFacts("stable-id", {
    kind: "lane", role: "migration-cartographer",
    compositionKind: "bespoke", compositionId: "migration-cartographer",
    compositionNearestPreset: "analyst", compositionBespokeReason: "schema archaeology",
    compositionPromotionCandidate: false,
  });
  const commands = readFileSync(log, "utf8").trim().split("\n");
  const firstTell = commands.findIndex((command) => command.startsWith("tell "));
  expect(commands).toContain("retract agent:stable-id outcome ran");
  expect(commands).toContain("retract agent:stable-id process_outcome ran");
  expect(commands).toContain("retract agent:stable-id delivery_outcome unverified");
  expect(commands).toContain("retract agent:stable-id terminal_manifest_sha256 old");
  expect(firstTell).toBeGreaterThan(0);
  expect(commands.slice(0, firstTell).every((command) => command.startsWith("retract "))).toBe(true);
  expect(commands[firstTell]).toBe("tell agent:stable-id kind lane");
  expect(commands).toContain("tell agent:stable-id nearest_preset analyst");
  expect(commands).toContain("tell agent:stable-id bespoke_reason schema archaeology");
  expect(commands).toContain("tell agent:stable-id promotion_candidate false");
});
