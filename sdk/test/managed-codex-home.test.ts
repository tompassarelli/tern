import { afterEach, expect, test } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareManagedCodexHome } from "../src/providers/managed-codex-home";
import {
  MANAGED_NONCLIENT_RECEIPT_FILE_ENV,
} from "../src/providers/managed-nonclient-receipt";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "north-managed-home-test-"));
  temporary.push(root);
  const accountHome = join(root, "account");
  const lawsHome = join(root, ".agents");
  mkdirSync(accountHome, { recursive: true, mode: 0o700 });
  mkdirSync(lawsHome, { recursive: true, mode: 0o700 });
  const laws = join(lawsHome, "AGENTS.md");
  writeFileSync(laws, "CANONICAL_MANAGED_CODEX_LAWS\n", { mode: 0o600 });
  writeFileSync(join(accountHome, "auth.json"), '{"auth_mode":"chatgpt"}\n', { mode: 0o600 });
  return {
    root,
    accountHome,
    laws,
    env: {
      ...process.env,
      HOME: root,
      AGENT_LAWS: "on",
      AGENT_LAWS_PATH: laws,
      CODEX_HOME: accountHome,
      CODEX_SQLITE_HOME: join(accountHome, "sqlite"),
      [MANAGED_NONCLIENT_RECEIPT_FILE_ENV]: "/tmp/ambient-forged-receipt",
      NORTH_MANAGED_NONCLIENT_RECEIPT_PATH: "/tmp/ambient-legacy-receipt",
      NORTH_MANAGED_NONCLIENT_RECEIPT_CAPABILITY: "f".repeat(64),
    },
  };
}

test("managed Codex gets one pristine home with only auth, canonical laws, and isolated sqlite", () => {
  const { accountHome, env, laws } = fixture();
  const config = join(accountHome, "config.toml");
  writeFileSync(config, '[projects."/home/tom"]\ntrust_level = "trusted"\n', { mode: 0o600 });
  writeFileSync(join(accountHome, "hooks.json"), "{}\n", { mode: 0o600 });
  mkdirSync(join(accountHome, "rules"));
  mkdirSync(join(accountHome, "skills"));
  writeFileSync(join(accountHome, "models_cache.json"), '{"models":[{"base_instructions":"hostile"}]}\n');

  const prepared = prepareManagedCodexHome(env);
  temporary.push(prepared.home);
  try {
    expect(prepared.home).not.toBe(accountHome);
    expect(prepared.env.CODEX_HOME).toBe(prepared.home);
    expect(prepared.env.CODEX_SQLITE_HOME).toBe(join(prepared.home, "sqlite"));
    expect(prepared.env).not.toHaveProperty(MANAGED_NONCLIENT_RECEIPT_FILE_ENV);
    expect(prepared.env).not.toHaveProperty("NORTH_MANAGED_NONCLIENT_RECEIPT_PATH");
    expect(prepared.env).not.toHaveProperty("NORTH_MANAGED_NONCLIENT_RECEIPT_CAPABILITY");
    expect(readdirSync(prepared.home).sort()).toEqual(["AGENTS.md", "auth.json", "sqlite"]);
    expect(readlinkSync(join(prepared.home, "auth.json")))
      .toBe(resolve(accountHome, "auth.json"));
    expect(readlinkSync(join(prepared.home, "AGENTS.md"))).toBe(resolve(laws));
    expect(readFileSync(config, "utf8")).toContain('trust_level = "trusted"');
    expect(existsSync(join(prepared.home, "config.toml"))).toBe(false);
    expect(existsSync(join(prepared.home, "hooks.json"))).toBe(false);
    expect(existsSync(join(prepared.home, "rules"))).toBe(false);
    expect(existsSync(join(prepared.home, "skills"))).toBe(false);
    expect(existsSync(join(prepared.home, "models_cache.json"))).toBe(false);
  } finally {
    prepared.dispose();
  }
  expect(existsSync(prepared.home)).toBe(false);
  expect(existsSync(config)).toBe(true);
});

test("concurrent managed Codex launches share only account auth and never sqlite or home state", () => {
  const { accountHome, env } = fixture();
  const first = prepareManagedCodexHome(env);
  const second = prepareManagedCodexHome(env);
  temporary.push(first.home, second.home);
  try {
    expect(first.home).not.toBe(second.home);
    expect(first.env.CODEX_SQLITE_HOME).not.toBe(second.env.CODEX_SQLITE_HOME);
    expect(readlinkSync(join(first.home, "auth.json")))
      .toBe(resolve(accountHome, "auth.json"));
    expect(readlinkSync(join(second.home, "auth.json")))
      .toBe(resolve(accountHome, "auth.json"));
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("managed Codex refuses missing, redirected, or non-private authentication", () => {
  const missing = fixture();
  rmSync(join(missing.accountHome, "auth.json"));
  expect(() => prepareManagedCodexHome(missing.env))
    .toThrow("managed Codex account authentication is missing");

  const redirected = fixture();
  const outside = join(redirected.root, "outside-auth.json");
  writeFileSync(outside, "{}\n", { mode: 0o600 });
  rmSync(join(redirected.accountHome, "auth.json"));
  symlinkSync(outside, join(redirected.accountHome, "auth.json"));
  expect(() => prepareManagedCodexHome(redirected.env))
    .toThrow("managed Codex account authentication is not a regular file");

  const publicAuth = fixture();
  chmodSync(join(publicAuth.accountHome, "auth.json"), 0o644);
  expect(() => prepareManagedCodexHome(publicAuth.env))
    .toThrow("managed Codex account authentication is not private");
});
