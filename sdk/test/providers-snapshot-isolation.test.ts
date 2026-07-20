import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");
const providersCli = join(root, "src/providers-cli.ts");
const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// Reproduce the exact host shape: an OpenAI isolated account whose home holds a
// Codex-written regular-file config.toml (trust + model-availability UI state),
// beside a healthy authenticated Anthropic account. `north providers --json`
// must isolate the OpenAI target and still report the eligible Anthropic target.
function fixture(codexConfig: (root: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "north-snapshot-isolation-"));
  temporaryHomes.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });

  const claudeBin = join(bin, "claude");
  writeFileSync(claudeBin, `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo 'claude 1'; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then
  echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0
fi
exit 2
`);
  chmodSync(claudeBin, 0o755);

  const codexBin = join(bin, "codex");
  writeFileSync(codexBin, `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo 'codex 1'; exit 0; fi
if [ "$1 $2" = "login status" ]; then echo 'Not logged in' >&2; exit 1; fi
exit 2
`);
  chmodSync(codexBin, 0o755);

  // Codex writes its own per-account config.toml inside CODEX_HOME.
  const codexRoot = join(home, ".local/state/north/accounts/openai/codex-broken");
  mkdirSync(codexRoot, { recursive: true, mode: 0o700 });
  codexConfig(codexRoot);

  const policyDir = join(home, ".config/north");
  mkdirSync(policyDir, { recursive: true });
  const policy = join(policyDir, "routing-policy.json");
  writeFileSync(policy, `${JSON.stringify({
    version: 1,
    mode: "balanced",
    targets: [
      { id: "claude-personal", provider: "anthropic", authMode: "isolated", profile: "claude-personal" },
      { id: "codex-broken", provider: "openai", authMode: "isolated", profile: "codex-broken" },
    ],
    targetOrder: ["claude-personal", "codex-broken"],
    providerOrder: ["anthropic", "openai"],
  }, null, 2)}\n`);

  // Fresh authoritative usage cache so the snapshot resolves headroom without a
  // live provider spawn (the SUT here is availability isolation, not usage).
  const observedAt = new Date().toISOString();
  const resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const observations = join(home, ".local/state/north/provider-usage-observations.json");
  writeFileSync(observations, `${JSON.stringify({ version: 1, observations: [
    { targetId: "claude-personal", provider: "anthropic", observedAt,
      source: "claude-agent-sdk:usage-control-experimental",
      windows: [{ limitId: "claude:seven_day", usedPercent: 10, resetsAt }] },
    { targetId: "codex-broken", provider: "openai", observedAt,
      source: "codex-app-server:account-rate-limits",
      windows: [{ limitId: "codex:primary", usedPercent: 10, resetsAt }] },
  ] })}\n`);

  const env = {
    ...process.env,
    // Keep the real Gaffer catalog resolvable once HOME is redirected.
    GAFFER_HOME: process.env.GAFFER_HOME ?? `${process.env.HOME}/code/gaffer`,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    NORTH_ROUTING_POLICY: policy,
    NORTH_CLAUDE_BIN: claudeBin,
    NORTH_CODEX_BIN: codexBin,
    NORTH_PROVIDER_OBSERVATIONS: observations,
    NORTH_AUTH_STATE_CACHE: join(home, "auth-state.json"),
  };
  const run = () => spawnSync("bun", ["run", providersCli, "--json"], { env, encoding: "utf8" });
  return { home, codexRoot, run };
}

test("an OpenAI account-local config failure cannot abort the JSON snapshot or hide the eligible Anthropic target", () => {
  const { run } = fixture((codexRoot) => {
    writeFileSync(join(codexRoot, "config.toml"), '[projects."/w"]\ntrust_level = "trusted"\n', { mode: 0o600 });
  });
  const result = run();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

  const document = JSON.parse(result.stdout);
  const anthropic = document.providers.find((group: { provider: string }) => group.provider === "anthropic");
  const openai = document.providers.find((group: { provider: string }) => group.provider === "openai");
  // The healthy Anthropic sibling remains visible and eligible.
  expect(anthropic.targets).toHaveLength(1);
  expect(anthropic.targets[0]).toMatchObject({
    id: "claude-personal", authenticated: true, available: true, routing: "eligible",
  });
  // The OpenAI target is isolated, present, and honestly unavailable — never
  // silently promoted, never erasing the snapshot.
  expect(openai.targets).toHaveLength(1);
  expect(openai.targets[0]).toMatchObject({ id: "codex-broken", available: false });
  expect(openai.targets[0].routing).not.toBe("eligible");
});

test("a hostile authority-bearing config.toml symlink still cannot abort the snapshot", () => {
  const { run } = fixture((codexRoot) => {
    // A dangling symlink escaping the isolated home: managed execution refuses
    // it fail-closed, but read-only observation must not abort the snapshot.
    symlinkSync("/nonexistent/hostile/config.toml", join(codexRoot, "config.toml"));
  });
  const result = run();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const document = JSON.parse(result.stdout);
  const anthropic = document.providers.find((group: { provider: string }) => group.provider === "anthropic");
  expect(anthropic.targets[0]).toMatchObject({
    id: "claude-personal", available: true, routing: "eligible",
  });
});
