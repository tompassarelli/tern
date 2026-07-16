import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAnthropic, probeOpenAI } from "../src/provider-routing";

const saved = { claude: process.env.NORTH_CLAUDE_BIN, codex: process.env.NORTH_CODEX_BIN };
const temporary: string[] = [];
afterEach(() => {
  if (saved.claude === undefined) delete process.env.NORTH_CLAUDE_BIN; else process.env.NORTH_CLAUDE_BIN = saved.claude;
  if (saved.codex === undefined) delete process.env.NORTH_CODEX_BIN; else process.env.NORTH_CODEX_BIN = saved.codex;
  delete process.env.NORTH_DISABLE_ANTHROPIC;
  delete process.env.NORTH_DISABLE_OPENAI;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function command(name: string, body: string): string {
  const directory = mkdtempSync(join(tmpdir(), `north-${name}-probe-`));
  temporary.push(directory);
  const path = join(directory, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

test("Claude readiness distinguishes installation from subscription authentication", () => {
  process.env.NORTH_CLAUDE_BIN = command("claude", `
if [ "$1" = "--version" ]; then echo 'claude 1'; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":false}'; exit 0; fi
exit 2`);
  expect(probeAnthropic()).toMatchObject({
    provider: "anthropic", installed: true, authenticated: false,
    available: false, reason: "authentication_missing",
  });
});

test("Claude authenticated subscription surface is ready without a model turn", () => {
  process.env.NORTH_CLAUDE_BIN = command("claude", `
if [ "$1" = "--version" ]; then echo 'claude 1'; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":true}'; exit 0; fi
exit 2`);
  expect(probeAnthropic()).toMatchObject({ installed: true, authenticated: true, available: true, reason: "ready" });
});

test("Codex readiness distinguishes installation from ChatGPT subscription authentication", () => {
  process.env.NORTH_CODEX_BIN = command("codex", `
if [ "$1" = "--version" ]; then echo 'codex 1'; exit 0; fi
if [ "$1 $2" = "login status" ]; then echo 'Not logged in'; exit 1; fi
exit 2`);
  expect(probeOpenAI()).toMatchObject({
    provider: "openai", installed: true, authenticated: false,
    available: false, reason: "authentication_missing",
  });
});

test("Codex exit-zero negative login text is not authentication", () => {
  process.env.NORTH_CODEX_BIN = command("codex", `
if [ "$1" = "--version" ]; then echo 'codex 1'; exit 0; fi
if [ "$1 $2" = "login status" ]; then echo 'Not logged in'; exit 0; fi
exit 2`);
  expect(probeOpenAI()).toMatchObject({
    provider: "openai", installed: true, authenticated: false,
    available: false, reason: "authentication_missing",
  });
});

test("Codex rejects ambiguous exit-zero text that is not the exact ChatGPT contract", () => {
  process.env.NORTH_CODEX_BIN = command("codex", `
if [ "$1" = "--version" ]; then echo 'codex 1'; exit 0; fi
if [ "$1 $2" = "login status" ]; then echo 'Logged in'; exit 0; fi
exit 2`);
  expect(probeOpenAI()).toMatchObject({ installed: true, authenticated: false, available: false });
});

test("Codex ChatGPT login status is ready without a model turn", () => {
  process.env.NORTH_CODEX_BIN = command("codex", `
if [ "$1" = "--version" ]; then echo 'codex 1'; exit 0; fi
if [ "$1 $2" = "login status" ]; then echo 'Logged in using ChatGPT'; exit 0; fi
exit 2`);
  expect(probeOpenAI()).toMatchObject({ installed: true, authenticated: true, available: true, reason: "ready" });
});

test("Codex accepts the exact positive contract on stderr", () => {
  process.env.NORTH_CODEX_BIN = command("codex", `
if [ "$1" = "--version" ]; then echo 'codex 1'; exit 0; fi
if [ "$1 $2" = "login status" ]; then echo 'Logged in using ChatGPT' >&2; exit 0; fi
exit 2`);
  expect(probeOpenAI()).toMatchObject({ installed: true, authenticated: true, available: true });
});

test("disabled is routing policy and preserves independent installation/authentication facts", () => {
  process.env.NORTH_CODEX_BIN = command("codex", `
if [ "$1" = "--version" ]; then echo 'codex 1'; exit 0; fi
if [ "$1 $2" = "login status" ]; then echo 'Logged in using ChatGPT'; exit 0; fi
exit 2`);
  process.env.NORTH_DISABLE_OPENAI = "1";
  expect(probeOpenAI()).toMatchObject({
    provider: "openai", installed: true, authenticated: true,
    available: false, reason: "disabled",
  });
});
