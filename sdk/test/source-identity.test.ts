import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutSourceIdentity } from "../src/providers/source-identity";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("checkout source identity distinguishes clean and dirty revisions", () => {
  const root = mkdtempSync(join(tmpdir(), "north-source-identity-"));
  temporary.push(root);
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.name", "North Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "north@example.invalid"]);
  writeFileSync(join(root, "tracked"), "clean\n");
  execFileSync("git", ["-C", root, "add", "tracked"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  expect(checkoutSourceIdentity(root)).toMatch(/^checkout [0-9a-f]+ clean$/);
  writeFileSync(join(root, "tracked"), "dirty\n");
  expect(checkoutSourceIdentity(root)).toMatch(/^checkout [0-9a-f]+ dirty$/);
});
