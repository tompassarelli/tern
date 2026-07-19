import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  bootstrapAccountConfig, codexConfigArguments, providerEnvironmentForTarget,
} from "../src/accounts";

const root = join(import.meta.dir, "..");
const cli = join(root, "src/account-cli.ts");
const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "north-account-test-"));
  temporaryHomes.push(home);
  const claude = join(home, ".claude");
  const codex = join(home, ".codex");
  const bin = join(home, "bin");
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  mkdirSync(bin, { recursive: true });

  writeFileSync(join(claude, "CLAUDE.md"), "shared claude instructions\n");
  mkdirSync(join(claude, "skills"));
  writeFileSync(join(claude, ".credentials.json"), "never-link-this\n");
  mkdirSync(join(claude, "sessions"));
  writeFileSync(join(codex, "AGENTS.md"), "shared codex instructions\n");
  writeFileSync(join(codex, "config.toml"), "model = 'test'\n");
  writeFileSync(join(codex, "auth.json"), "never-link-this\n");
  mkdirSync(join(codex, "log"));
  writeFileSync(join(codex, "state.sqlite"), "never-link-this\n");

  const fake = join(bin, "fake-provider.cjs");
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const isClaude = Boolean(process.env.CLAUDE_CONFIG_DIR);
const root = isClaude ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
const record = { argv: process.argv.slice(2), root, sqlite: process.env.CODEX_SQLITE_HOME,
  sensitiveEnvPresent: Boolean(process.env.CLAUDE_PRIVATE_CREDENTIAL || process.env.CODEX_PRIVATE_CREDENTIAL) };
fs.appendFileSync(path.join(process.env.HOME, "calls.jsonl"), JSON.stringify(record) + "\\n");
const login = isClaude ? process.argv[2] === "auth" && process.argv[3] === "login"
  : process.argv[2] === "login" && process.argv[3] !== "status";
if (login) { fs.writeFileSync(path.join(root, "logged-in"), "yes"); process.exit(0); }
const loggedIn = fs.existsSync(path.join(root, "logged-in"));
if (isClaude) console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" }));
else if (loggedIn) console.log("Logged in using ChatGPT");
else console.error("Not logged in");
process.exit(loggedIn ? 0 : 1);
`);
  chmodSync(fake, 0o755);
  const fakeClaude = join(bin, "fake-claude");
  const fakeCodex = join(bin, "fake-codex");
  symlinkSync(fake, fakeClaude);
  symlinkSync(fake, fakeCodex);

  const policy = join(home, ".config/north/routing-policy.json");
  mkdirSync(join(home, ".config/north"), { recursive: true });
  writeFileSync(policy, `${JSON.stringify({
    version: 1,
    mode: "preferential",
    targets: [{ id: "ambient", provider: "anthropic", currentField: "keep-me" }],
    targetOrder: ["ambient"],
    providerOrder: ["anthropic", "openai"],
    futureTopLevel: { preserved: true },
  }, null, 2)}\n`);

  const env = {
    ...process.env,
    HOME: home,
    NORTH_ROUTING_POLICY: policy,
    NORTH_CLAUDE_BIN: fakeClaude,
    NORTH_CODEX_BIN: fakeCodex,
    CLAUDE_PRIVATE_CREDENTIAL: "must-not-propagate",
    CODEX_PRIVATE_CREDENTIAL: "must-not-propagate",
  };
  const run = (...args: string[]) => spawnSync("bun", ["run", cli, ...args], { env, encoding: "utf8" });
  return { home, policy, run };
}

test("add preserves routing fields, isolates roots, and links only allowlisted config", () => {
  const { home, policy, run } = fixture();
  expect(run("add", "claude-work", "anthropic").status).toBe(0);
  expect(run("add", "codex-personal", "openai").status).toBe(0);

  const document = JSON.parse(readFileSync(policy, "utf8"));
  expect(document.futureTopLevel).toEqual({ preserved: true });
  expect(document.targets[0]).toEqual({ id: "ambient", provider: "anthropic", currentField: "keep-me" });
  expect(document.targets.slice(1)).toEqual([
    { id: "claude-work", provider: "anthropic", profile: "claude-work", authMode: "isolated" },
    { id: "codex-personal", provider: "openai", profile: "codex-personal", authMode: "isolated" },
  ]);
  expect(document.targetOrder).toEqual(["ambient", "claude-work", "codex-personal"]);
  expect(statSync(policy).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(home, ".config/north")).filter((name) => name.includes(".tmp") || name.endsWith(".lock"))).toEqual([]);

  const claudeRoot = join(home, ".local/state/north/accounts/anthropic/claude-work");
  const codexRoot = join(home, ".local/state/north/accounts/openai/codex-personal");
  expect(claudeRoot).not.toBe(codexRoot);
  expect(statSync(claudeRoot).mode & 0o777).toBe(0o700);
  expect(statSync(codexRoot).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(claudeRoot, "CLAUDE.md")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(claudeRoot, "CLAUDE.md"))).toBe(join(home, ".claude/CLAUDE.md"));
  expect(lstatSync(join(claudeRoot, "skills")).isSymbolicLink()).toBe(true);
  expect(lstatSync(join(codexRoot, "AGENTS.md")).isSymbolicLink()).toBe(true);
  expect(lstatSync(join(codexRoot, "config.toml")).isSymbolicLink()).toBe(true);
  for (const forbidden of [
    join(claudeRoot, ".credentials.json"), join(claudeRoot, "sessions"),
    join(codexRoot, "auth.json"), join(codexRoot, "log"), join(codexRoot, "state.sqlite"),
  ]) expect(() => lstatSync(forbidden)).toThrow();
});

test("OpenAI bootstrap idempotently retires only North's legacy ambient hooks link", () => {
  const { home } = fixture();
  const ambientHooks = join(home, ".codex/hooks.json");
  writeFileSync(ambientHooks, "{}\n");
  const account = {
    id: "codex-migrate",
    provider: "openai" as const,
    profile: "codex-migrate",
    authMode: "isolated" as const,
    root: join(home, ".local/state/north/accounts/openai/codex-migrate"),
  };
  bootstrapAccountConfig(account, { home });
  writeFileSync(join(account.root, "auth.json"), "keep auth\n");
  symlinkSync(ambientHooks, join(account.root, "hooks.json"));
  const agentsLink = readlinkSync(join(account.root, "AGENTS.md"));
  const configLink = readlinkSync(join(account.root, "config.toml"));

  bootstrapAccountConfig(account, { home });
  bootstrapAccountConfig(account, { home });

  expect(() => lstatSync(join(account.root, "hooks.json"))).toThrow();
  expect(readlinkSync(join(account.root, "AGENTS.md"))).toBe(agentsLink);
  expect(readlinkSync(join(account.root, "config.toml"))).toBe(configLink);
  expect(readFileSync(join(account.root, "auth.json"), "utf8")).toBe("keep auth\n");

  const customHooks = join(home, "custom-hooks.json");
  writeFileSync(customHooks, "{}\n");
  symlinkSync(customHooks, join(account.root, "hooks.json"));
  bootstrapAccountConfig(account, { home });
  expect(readlinkSync(join(account.root, "hooks.json"))).toBe(customHooks);
});

test("the first account creates a balanced routing policy", () => {
  const { policy, run } = fixture();
  rmSync(policy, { force: true });
  expect(run("add", "claude-personal", "anthropic").status).toBe(0);
  expect(JSON.parse(readFileSync(policy, "utf8"))).toMatchObject({
    version: 1,
    mode: "balanced",
    targets: [{ id: "claude-personal", provider: "anthropic", authMode: "isolated" }],
    targetOrder: ["claude-personal"],
  });
});

test("concurrent adds serialize the read-append-replace transaction", async () => {
  const { home, policy } = fixture();
  const env = {
    ...process.env,
    HOME: home,
    NORTH_ROUTING_POLICY: policy,
  };
  const first = Bun.spawn(["bun", "run", cli, "add", "claude-one", "anthropic"], {
    env, stdout: "pipe", stderr: "pipe",
  });
  const second = Bun.spawn(["bun", "run", cli, "add", "codex-two", "openai"], {
    env, stdout: "pipe", stderr: "pipe",
  });
  expect(await first.exited).toBe(0);
  expect(await second.exited).toBe(0);
  const document = JSON.parse(readFileSync(policy, "utf8"));
  const ids = document.targets.map((target: { id: string }) => target.id);
  expect([...ids].sort()).toEqual(["ambient", "claude-one", "codex-two"]);
  expect(document.targetOrder).toEqual(ids);
});

test("same isolated target bootstraps safely across concurrent processes", async () => {
  const { home } = fixture();
  const accountRoot = join(home, ".local/state/north/accounts/anthropic/claude-shared");
  const ready = join(home, "bootstrap-ready");
  const start = join(home, "bootstrap-start");
  mkdirSync(ready);
  const workers = 16;
  const program = `
    import { bootstrapAccountConfig } from ${JSON.stringify(join(root, "src/accounts.ts"))};
    import { existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    writeFileSync(join(process.env.READY, String(process.pid)), "ready");
    while (!existsSync(process.env.START))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    bootstrapAccountConfig(JSON.parse(process.env.ACCOUNT), { home: process.env.HOME });
  `;
  const env = {
    ...process.env,
    HOME: home,
    READY: ready,
    START: start,
    ACCOUNT: JSON.stringify({
      id: "claude-shared", provider: "anthropic", profile: "claude-shared",
      authMode: "isolated", root: accountRoot,
    }),
  };
  const children = Array.from({ length: workers }, () => Bun.spawn(["bun", "--eval", program], {
    env, stdout: "pipe", stderr: "pipe",
  }));
  for (let attempt = 0; readdirSync(ready).length < workers && attempt < 1000; attempt++) await Bun.sleep(5);
  expect(readdirSync(ready)).toHaveLength(workers);
  writeFileSync(start, "go");
  const exits = await Promise.all(children.map((child) => child.exited));
  const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
  expect(exits, errors.join("\n")).toEqual(Array(workers).fill(0));
  for (const name of ["CLAUDE.md", "skills"]) {
    const destination = join(accountRoot, name);
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(readlinkSync(destination)).toBe(join(home, ".claude", name));
  }
});

test("unsafe ids are rejected without changing policy or escaping the account root", () => {
  const { home, policy, run } = fixture();
  const before = readFileSync(policy, "utf8");
  for (const id of ["../escape", "nested/account", ".", "..", "account.name", "Uppercase"]) {
    const result = run("add", id, "anthropic");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("lowercase portable slug");
    expect(readFileSync(policy, "utf8")).toBe(before);
  }
  expect(() => lstatSync(join(home, ".local/state/north/escape"))).toThrow();
});

test("two target ids cannot double-count one isolated subscription profile", () => {
  const { policy, run } = fixture();
  writeFileSync(policy, JSON.stringify({
    version: 1, mode: "balanced",
    targets: [
      { id: "claude-first", provider: "anthropic", authMode: "isolated", profile: "shared-claude" },
      { id: "claude-second", provider: "anthropic", authMode: "isolated", profile: "shared-claude" },
    ],
    targetOrder: ["claude-first", "claude-second"],
  }));

  const listed = run("list");
  expect(listed.status).toBe(2);
  expect(listed.stderr).toContain("share provider profile/root anthropic/shared-claude");
  expect(listed.stdout).toBe("");
});

test("login and status use disjoint provider homes and normalized account identity", () => {
  const { home, run } = fixture();
  expect(run("add", "claude-work", "anthropic").status).toBe(0);
  expect(run("add", "codex-personal", "openai").status).toBe(0);

  writeFileSync(join(home, ".claude/logged-in"), "ambient login must not count\n");
  writeFileSync(join(home, ".codex/logged-in"), "ambient login must not count\n");
  const empty = run("status");
  expect(empty.status).toBe(1);
  expect(empty.stdout).toBe([
    "Claude / Anthropic",
    "  claude-work  not logged in",
    "",
    "Codex / OpenAI",
    "  codex-personal  not logged in",
    "",
  ].join("\n"));

  expect(run("login", "claude-work").status).toBe(0);
  const split = run("status");
  expect(split.status).toBe(1);
  expect(split.stdout).toBe([
    "Claude / Anthropic",
    "  claude-work  logged in",
    "",
    "Codex / OpenAI",
    "  codex-personal  not logged in",
    "",
  ].join("\n"));
  const one = run("status", "claude-work");
  expect(one.status).toBe(0);
  expect(one.stdout).toBe("Claude / Anthropic\n  claude-work  logged in\n");

  const listed = run("list");
  expect(listed.status).toBe(0);
  expect(listed.stdout).toBe([
    "Claude / Anthropic",
    "  claude-work  logged in",
    "",
    "Codex / OpenAI",
    "  codex-personal  not logged in",
    "",
  ].join("\n"));
  expect(listed.stdout).not.toContain("/accounts/");
  expect(listed.stdout).not.toContain("\tanthropic\t");
  expect(listed.stdout).not.toContain("\u001b[");

  expect(run("login", "codex-personal").status).toBe(0);
  const ready = run("status");
  expect(ready.status).toBe(0);
  expect(ready.stdout).toContain("  claude-work  logged in");
  expect(ready.stdout).toContain("  codex-personal  logged in");

  const verbose = run("list", "--verbose");
  expect(verbose.status).toBe(0);
  expect(verbose.stdout).toContain("Claude / Anthropic\n  claude-work  logged in");
  expect(verbose.stdout).toContain("    provider: anthropic");
  expect(verbose.stdout).toContain("    profile:  claude-work");
  expect(verbose.stdout).toContain(`    root:     ${join(home, ".local/state/north/accounts/anthropic/claude-work")}`);
  expect(verbose.stdout).toContain("Codex / OpenAI\n  codex-personal  logged in");
  expect(verbose.stdout).toContain("    provider: openai");
  expect(verbose.stdout).toContain("    profile:  codex-personal");
  expect(verbose.stdout).toContain(`    root:     ${join(home, ".local/state/north/accounts/openai/codex-personal")}`);

  const invalidList = run("list", "--raw");
  expect(invalidList.status).toBe(2);
  expect(invalidList.stderr).toContain("north account list [--verbose]");

  const calls = readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(calls.every((call) => call.sensitiveEnvPresent === false)).toBe(true);
  const codexCalls = calls.filter((call) => call.root?.includes("/accounts/openai/"));
  expect(codexCalls.length).toBeGreaterThan(0);
  expect(codexCalls.every((call) => call.sqlite === join(call.root, "sqlite"))).toBe(true);
  expect(codexCalls.every((call) => call.argv.includes('cli_auth_credentials_store="file"'))).toBe(true);
  expect(codexCalls.every((call) => call.argv.includes('forced_login_method="chatgpt"'))).toBe(true);
  expect(codexCalls.every((call) => call.argv.includes('model_provider="openai"'))).toBe(true);
});

test("account help advertises the grouped list and verbose diagnostics", () => {
  const { run } = fixture();
  const help = run("--help");
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("north account list [--verbose]   grouped accounts + live login state");
  expect(help.stdout).toContain("north account usage [id] [--refresh]  subscription windows + reset metadata");
  expect(help.stdout).toContain("--refresh  bypass the five-minute authoritative usage cache");
  expect(help.stdout).toContain("--verbose  include provider, profile, and storage root diagnostics");
});

test("account usage groups cached per-account windows with source and reset metadata", () => {
  const { home, run } = fixture();
  expect(run("add", "claude-gmail", "anthropic").status).toBe(0);
  expect(run("add", "codex-proton", "openai").status).toBe(0);
  const observedAt = new Date().toISOString();
  const resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const observations = join(home, ".local/state/north/provider-usage-observations.json");
  mkdirSync(join(home, ".local/state/north"), { recursive: true });
  writeFileSync(observations, `${JSON.stringify({ version: 1, observations: [
    { targetId: "claude-gmail", provider: "anthropic", observedAt,
      source: "claude-agent-sdk:usage-control-experimental",
      windows: [{ limitId: "claude:seven_day", usedPercent: 40, resetsAt }] },
    { targetId: "codex-proton", provider: "openai", observedAt,
      source: "codex-app-server:account-rate-limits",
      windows: [{ limitId: "codex:primary", usedPercent: 55, resetsAt }] },
  ] })}\n`);

  const usage = run("usage");
  expect(usage.status).toBe(0);
  expect(usage.stdout).toContain("Claude / Anthropic\n  claude-gmail");
  expect(usage.stdout).toContain("headroom: plenty (observed, cached)");
  expect(usage.stdout).toContain("source:   claude-agent-sdk:usage-control-experimental");
  expect(usage.stdout).toContain(`usage evidence:  ${observedAt} (cached)`);
  expect(usage.stdout).not.toContain("    observed:");
  expect(usage.stdout).toContain(`claude:seven_day: 40% used · resets ${resetsAt}`);
  expect(usage.stdout).toContain("Codex / OpenAI\n  codex-proton");
  expect(usage.stdout).toContain("headroom: normal (observed, cached)");
  expect(usage.stdout).toContain("source:   codex-app-server:account-rate-limits");
  expect(usage.stdout).toContain(`codex:primary: 55% used · resets ${resetsAt}`);
});

test("account usage keeps proven exhaustion visible while a failed refresh is negatively cached", () => {
  const { home, run } = fixture();
  expect(run("add", "claude-gmail", "anthropic").status).toBe(0);
  const observedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const failedAt = new Date().toISOString();
  const resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const observations = join(home, ".local/state/north/provider-usage-observations.json");
  mkdirSync(join(home, ".local/state/north"), { recursive: true });
  writeFileSync(observations, `${JSON.stringify({ version: 1, observations: [{
    targetId: "claude-gmail", provider: "anthropic",
    source: "claude-agent-sdk:usage-control-experimental", observedAt,
    windows: [{ limitId: "claude:seven_day", usedPercent: 100, resetsAt }],
    collectionFailure: { observedAt: failedAt, reason: "anthropic_usage_probe_timed_out" },
  }] })}\n`);

  const usage = run("usage");
  expect(usage.status).toBe(1);
  expect(usage.stdout).toContain("headroom: exhausted (unavailable, cached)");
  expect(usage.stdout).toContain(`usage evidence:  ${observedAt} (cached)`);
  expect(usage.stdout).toContain(`collection tried: ${failedAt}`);
  expect(usage.stdout).toContain("Claude usage control probe timed out (anthropic_usage_probe_timed_out)");
});

test("subscription targets deny hostile provider transports while preserving ordinary environment", () => {
  const { home } = fixture();
  const hostile = {
    HOME: home,
    PATH: process.env.PATH,
    TERM: "xterm-256color",
    NORTH_TRACE: "keep",
    ANTHROPIC_LOG: "keep-anthropic-log",
    OPENAI_LOG: "keep-openai-log",
    AWS_MAX_ATTEMPTS: "7",
    ANTHROPIC_API_KEY: "canary",
    CLAUDE_CODE_OAUTH_TOKEN: "canary",
    ANTHROPIC_BASE_URL: "https://hostile.invalid",
    ANTHROPIC_CUSTOM_HEADERS: "Authorization: canary",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
    ANTHROPIC_VERTEX_BASE_URL: "https://hostile.invalid",
    AWS_ACCESS_KEY_ID: "canary",
    AWS_SECRET_ACCESS_KEY: "canary",
    AWS_PROFILE: "hostile",
    AWS_REGION: "hostile-1",
    AWS_SHARED_CREDENTIALS_FILE: "/tmp/canary",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/canary",
    GOOGLE_API_KEY: "canary",
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/canary",
    CLOUD_ML_REGION: "hostile-1",
    AZURE_OPENAI_ENDPOINT: "https://hostile.invalid",
    AZURE_CLIENT_SECRET: "canary",
    AZURE_SUBSCRIPTION_ID: "canary",
    OPENAI_API_KEY: "canary",
    OPENAI_BASE_URL: "https://hostile.invalid",
    OPENAI_DEFAULT_HEADERS: "Authorization: canary",
    OPENAI_API_TYPE: "azure",
    CHATGPT_BASE_URL: "https://hostile.invalid",
    BOTO_CONFIG: "/tmp/canary",
    CODEX_PRIVATE_CREDENTIAL: "canary",
    CLAUDE_CONFIG_DIR: "/tmp/hostile-claude",
    CODEX_HOME: "/tmp/hostile-codex",
    CODEX_SQLITE_HOME: "/tmp/hostile-sqlite",
    CODEX_PROFILE: "hostile",
  } satisfies NodeJS.ProcessEnv;
  const forbidden = Object.keys(hostile).filter((key) => ![
    "HOME", "PATH", "TERM", "NORTH_TRACE", "ANTHROPIC_LOG", "OPENAI_LOG", "AWS_MAX_ATTEMPTS",
    "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CODEX_SQLITE_HOME",
  ].includes(key));

  for (const [provider, profile] of [["anthropic", "claude-safe"], ["openai", "codex-safe"]] as const) {
    const env = providerEnvironmentForTarget(provider, {
      id: profile, provider, profile, authMode: "isolated",
    }, { home, env: hostile });
    for (const key of forbidden) expect(env[key]).toBeUndefined();
    expect(env).toMatchObject({
      HOME: home,
      TERM: "xterm-256color",
      NORTH_TRACE: "keep",
      ANTHROPIC_LOG: "keep-anthropic-log",
      OPENAI_LOG: "keep-openai-log",
      AWS_MAX_ATTEMPTS: "7",
    });
    const root = join(home, ".local/state/north/accounts", provider, profile);
    if (provider === "anthropic") {
      expect(env.CLAUDE_CONFIG_DIR).toBe(root);
      expect(env.CODEX_HOME).toBeUndefined();
    } else {
      expect(env.CODEX_HOME).toBe(root);
      expect(env.CODEX_SQLITE_HOME).toBe(join(root, "sqlite"));
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(codexConfigArguments(env)).toContain('model_provider="openai"');
    }
  }
});
