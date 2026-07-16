import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentFacts } from "../src/identity";

const saved = process.env.NORTH_BIN;
let directory = "";
afterEach(() => {
  if (saved === undefined) delete process.env.NORTH_BIN; else process.env.NORTH_BIN = saved;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test("sequential lane-id reuse retracts the prior outcome before publishing identity", () => {
  directory = mkdtempSync(join(tmpdir(), "north-identity-reuse-"));
  const log = join(directory, "commands.log");
  const fake = join(directory, "north");
  writeFileSync(fake, `#!/usr/bin/env bash
if [ "$1 $2" = "json show" ]; then
  printf '%s\\n' '[{"predicate":"kind","value":"lane"},{"predicate":"outcome","value":"ran"}]'
  exit 0
fi
printf '%s\\n' "$*" >> "${log}"
`);
  chmodSync(fake, 0o700);
  process.env.NORTH_BIN = fake;

  writeAgentFacts("stable-id", { kind: "lane", role: "implementer" });
  const commands = readFileSync(log, "utf8").trim().split("\n");
  expect(commands[0]).toBe("retract agent:stable-id outcome ran");
  expect(commands[1]).toBe("tell agent:stable-id kind lane");
});
