import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAnthropic, probeOpenAI } from "../src/provider-routing";
import { authCacheKey, readAuthState, writeAuthState, type CachedAuthState } from "../src/provider-auth-cache";

const saved = {
  claude: process.env.NORTH_CLAUDE_BIN,
  codex: process.env.NORTH_CODEX_BIN,
  home: process.env.HOME,
  authCache: process.env.NORTH_AUTH_STATE_CACHE,
};
const temporary: string[] = [];
let authCachePath = "";
beforeEach(() => {
  // Isolate the cross-process auth-state cache per test so a definitive verdict
  // from one case never coalesces into the next (and never touches real state).
  const directory = mkdtempSync(join(tmpdir(), "north-auth-cache-"));
  temporary.push(directory);
  authCachePath = join(directory, "auth-state.json");
  process.env.NORTH_AUTH_STATE_CACHE = authCachePath;
});
afterEach(() => {
  if (saved.claude === undefined) delete process.env.NORTH_CLAUDE_BIN; else process.env.NORTH_CLAUDE_BIN = saved.claude;
  if (saved.codex === undefined) delete process.env.NORTH_CODEX_BIN; else process.env.NORTH_CODEX_BIN = saved.codex;
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.authCache === undefined) delete process.env.NORTH_AUTH_STATE_CACHE; else process.env.NORTH_AUTH_STATE_CACHE = saved.authCache;
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
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":false,"authMethod":"none"}'; exit 0; fi
exit 2`);
  expect(probeAnthropic()).toMatchObject({
    provider: "anthropic", installed: true, authenticated: false,
    available: false, reason: "authentication_missing",
  });
});

test("Claude authenticated subscription surface is ready without a model turn", () => {
  process.env.NORTH_CLAUDE_BIN = command("claude", `
if [ "$1" = "--version" ]; then echo 'claude 1'; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0; fi
exit 2`);
  expect(probeAnthropic()).toMatchObject({ installed: true, authenticated: true, available: true, reason: "ready" });
});

test("Claude API-key authentication is not a subscription surface", () => {
  process.env.NORTH_CLAUDE_BIN = command("claude", `
if [ "$1" = "--version" ]; then echo 'claude 1'; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}'; exit 0; fi
exit 2`);
  expect(probeAnthropic()).toMatchObject({
    installed: true, authenticated: false, available: false, reason: "authentication_missing",
  });
});

test("Claude target probes use the selected isolated config directory", () => {
  const home = mkdtempSync(join(tmpdir(), "north-claude-probe-targets-"));
  temporary.push(home);
  process.env.HOME = home;
  const firstRoot = join(home, ".local/state/north/accounts/anthropic/one");
  const secondRoot = join(home, ".local/state/north/accounts/anthropic/two");
  mkdirSync(firstRoot, { recursive: true, mode: 0o700 });
  mkdirSync(secondRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(firstRoot, "logged-in"), "yes\n");
  process.env.NORTH_CLAUDE_BIN = command("claude", `
if [ "$1" = "--version" ]; then echo 'claude 1'; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then
  printf '%s' "$CLAUDE_CONFIG_DIR" > "$CLAUDE_CONFIG_DIR/probe-root"
  if [ -f "$CLAUDE_CONFIG_DIR/logged-in" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0; fi
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
fi
exit 2`);
  const first = probeAnthropic({ id: "claude-one", provider: "anthropic", authMode: "isolated", profile: "one" });
  const second = probeAnthropic({ id: "claude-two", provider: "anthropic", authMode: "isolated", profile: "two" });
  expect(first).toMatchObject({ targetId: "claude-one", authenticated: true, available: true });
  expect(second).toMatchObject({ targetId: "claude-two", authenticated: false, available: false });
  expect(readFileSync(join(firstRoot, "probe-root"), "utf8")).toBe(firstRoot);
  expect(readFileSync(join(secondRoot, "probe-root"), "utf8")).toBe(secondRoot);
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

test("provider probes reduce hostile stdout and stderr to normalized availability reasons", () => {
  const canary = "PROVIDER_DIAGNOSTIC_CANARY_DO_NOT_EXPOSE";
  process.env.NORTH_CLAUDE_BIN = command("claude", `
if [ "$1" = "--version" ]; then echo 'claude 1 ${canary}'; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '${canary}' >&2; exit 1; fi
exit 2`);
  const claudeAuth = probeAnthropic();
  expect(claudeAuth).toMatchObject({ reason: "authentication_missing", available: false });
  expect(JSON.stringify(claudeAuth)).not.toContain(canary);

  process.env.NORTH_CLAUDE_BIN = command("claude", `echo '${canary}'; echo '${canary}' >&2; exit 2`);
  const claudeCommand = probeAnthropic();
  expect(claudeCommand).toMatchObject({ reason: "command_missing", available: false });
  expect(JSON.stringify(claudeCommand)).not.toContain(canary);

  process.env.NORTH_CODEX_BIN = command("codex", `
if [ "$1" = "--version" ]; then echo 'codex 1 ${canary}'; exit 0; fi
if [ "$1 $2" = "login status" ]; then echo '${canary}'; echo '${canary}' >&2; exit 1; fi
exit 2`);
  const codexAuth = probeOpenAI();
  expect(codexAuth).toMatchObject({ reason: "authentication_missing", available: false });
  expect(JSON.stringify(codexAuth)).not.toContain(canary);

  process.env.NORTH_CODEX_BIN = command("codex", `echo '${canary}'; echo '${canary}' >&2; exit 2`);
  const codexCommand = probeOpenAI();
  expect(codexCommand).toMatchObject({ reason: "command_missing", available: false });
  expect(JSON.stringify(codexCommand)).not.toContain(canary);
});

test("same-provider target probes use disjoint account authentication", () => {
  const home = mkdtempSync(join(tmpdir(), "north-codex-probe-targets-"));
  temporary.push(home);
  process.env.HOME = home;
  const firstRoot = join(home, ".local/state/north/accounts/openai/one");
  const secondRoot = join(home, ".local/state/north/accounts/openai/two");
  mkdirSync(firstRoot, { recursive: true, mode: 0o700 });
  mkdirSync(secondRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(firstRoot, "logged-in"), "yes\n");
  process.env.NORTH_CODEX_BIN = command("codex", `
if [ "$1" = "--version" ]; then echo 'codex 1'; exit 0; fi
if [ "$1 $2" = "login status" ]; then
  printf '%s\\n' "$@" > "$CODEX_HOME/probe-args"
  if [ -f "$CODEX_HOME/logged-in" ]; then echo 'Logged in using ChatGPT'; exit 0; fi
  echo 'Not logged in' >&2; exit 1
fi
exit 2`);
  const first = probeOpenAI({ id: "codex-one", provider: "openai", authMode: "isolated", profile: "one" });
  const second = probeOpenAI({ id: "codex-two", provider: "openai", authMode: "isolated", profile: "two" });
  expect(first).toMatchObject({ targetId: "codex-one", authenticated: true, available: true });
  expect(second).toMatchObject({ targetId: "codex-two", authenticated: false, available: false });
  for (const root of [firstRoot, secondRoot]) {
    const args = readFileSync(join(root, "probe-args"), "utf8");
    expect(args).toContain('cli_auth_credentials_store="file"');
    expect(args).toContain('model_provider="openai"');
    expect(args).toContain(`sqlite_home="${join(root, "sqlite")}"`);
  }
});

const readyState = (provider: "anthropic" | "openai", at: number): CachedAuthState =>
  ({ provider, installed: true, authenticated: true, available: true, reason: "ready", at });

// version prints, auth/login is killed by a signal: the classic contended-probe
// shape (spawn could not complete), distinct from the CLI reporting a verdict.
const killedAuthClaude = () => command("claude", `
if [ "$1" = "--version" ]; then echo 'claude 1'; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then kill -KILL $$; fi
exit 2`);
const killedAuthCodex = () => command("codex", `
if [ "$1" = "--version" ]; then echo 'codex 1'; exit 0; fi
if [ "$1 $2" = "login status" ]; then kill -KILL $$; fi
exit 2`);

test("an incomplete auth probe retains the last authenticated verdict instead of flapping to missing", () => {
  // Older than the coalesce window so the probe actually runs, within retention.
  writeAuthState(authCachePath, authCacheKey("anthropic", undefined), readyState("anthropic", Date.now() - 60_000));
  process.env.NORTH_CLAUDE_BIN = killedAuthClaude();
  expect(probeAnthropic()).toMatchObject({ authenticated: true, available: true, reason: "ready" });
});

test("a fresh authenticated verdict coalesces: a burst reuses it without spawning", () => {
  writeAuthState(authCachePath, authCacheKey("openai", undefined), readyState("openai", Date.now()));
  // Any invocation would fail --version and classify command_missing; reuse proves no spawn.
  process.env.NORTH_CODEX_BIN = command("codex", "exit 3");
  expect(probeOpenAI()).toMatchObject({ installed: true, authenticated: true, available: true, reason: "ready" });
});

test("an incomplete probe with no prior verdict is unknown, never authentication_missing", () => {
  process.env.NORTH_CODEX_BIN = killedAuthCodex();
  const result = probeOpenAI();
  expect(result).toMatchObject({ authenticated: false, available: false, reason: "unknown" });
  expect(result.reason).not.toBe("authentication_missing");
});

test("a definitive logged-out verdict is persisted and preserved across a later incomplete probe", () => {
  // First, the CLI genuinely reports logged out (revoked-equivalent): definitive.
  process.env.NORTH_CODEX_BIN = command("codex", `
if [ "$1" = "--version" ]; then echo 'codex 1'; exit 0; fi
if [ "$1 $2" = "login status" ]; then echo 'Not logged in'; exit 1; fi
exit 2`);
  expect(probeOpenAI()).toMatchObject({ authenticated: false, reason: "authentication_missing" });
  expect(readAuthState(authCachePath, authCacheKey("openai", undefined)))
    .toMatchObject({ reason: "authentication_missing", authenticated: false });

  // A subsequent contended probe must not upgrade a known-revoked account to ready.
  writeAuthState(authCachePath, authCacheKey("openai", undefined), {
    provider: "openai", installed: true, authenticated: false, available: false,
    reason: "authentication_missing", at: Date.now() - 60_000,
  });
  process.env.NORTH_CODEX_BIN = killedAuthCodex();
  expect(probeOpenAI()).toMatchObject({ authenticated: false, available: false, reason: "authentication_missing" });
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
