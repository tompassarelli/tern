import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authCacheKey,
  authStateCachePath,
  readAuthState,
  writeAuthState,
  type CachedAuthState,
} from "../src/provider-auth-cache";

const temporary: string[] = [];
const saved = {
  cache: process.env.NORTH_AUTH_STATE_CACHE,
  observations: process.env.NORTH_PROVIDER_OBSERVATIONS,
};
afterEach(() => {
  if (saved.cache === undefined) delete process.env.NORTH_AUTH_STATE_CACHE; else process.env.NORTH_AUTH_STATE_CACHE = saved.cache;
  if (saved.observations === undefined) delete process.env.NORTH_PROVIDER_OBSERVATIONS; else process.env.NORTH_PROVIDER_OBSERVATIONS = saved.observations;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "north-auth-cache-unit-"));
  temporary.push(directory);
  return join(directory, "auth-state.json");
}

const ready: CachedAuthState = {
  provider: "anthropic", installed: true, authenticated: true, available: true, reason: "ready", at: 1_000,
};

test("path override wins; else derives beside the observation store; else the default", () => {
  process.env.NORTH_AUTH_STATE_CACHE = "/tmp/explicit-auth.json";
  expect(authStateCachePath()).toBe("/tmp/explicit-auth.json");
  delete process.env.NORTH_AUTH_STATE_CACHE;
  process.env.NORTH_PROVIDER_OBSERVATIONS = "/tmp/obs.json";
  expect(authStateCachePath()).toBe("/tmp/obs.json.auth-state.json");
  delete process.env.NORTH_PROVIDER_OBSERVATIONS;
  expect(authStateCachePath()).toContain("provider-auth-state.json");
});

test("keys separate ambient from each isolated target", () => {
  expect(authCacheKey("anthropic", undefined)).not.toBe(authCacheKey("anthropic", "claude-work"));
  expect(authCacheKey("openai", "a")).not.toBe(authCacheKey("openai", "b"));
});

test("write then read round-trips one verdict per key", () => {
  const path = scratch();
  writeAuthState(path, "k1", ready);
  writeAuthState(path, "k2", { ...ready, provider: "openai", reason: "authentication_missing", authenticated: false, available: false });
  expect(readAuthState(path, "k1")).toMatchObject({ reason: "ready", authenticated: true });
  expect(readAuthState(path, "k2")).toMatchObject({ reason: "authentication_missing", authenticated: false });
  expect(readAuthState(path, "absent")).toBeUndefined();
});

test("a corrupt or absent store degrades to undefined, never throws", () => {
  const path = scratch();
  expect(readAuthState(path, "k1")).toBeUndefined();
  writeFileSync(path, "{ this is not json");
  expect(readAuthState(path, "k1")).toBeUndefined();
  // A subsequent write recovers the store.
  writeAuthState(path, "k1", ready);
  expect(readAuthState(path, "k1")).toMatchObject({ reason: "ready" });
});

test("malformed cached entries are dropped, valid siblings survive", () => {
  const path = scratch();
  writeFileSync(path, JSON.stringify({
    version: 1,
    states: { good: ready, bad: { provider: "anthropic", reason: "nonsense" } },
  }));
  expect(readAuthState(path, "good")).toMatchObject({ reason: "ready" });
  expect(readAuthState(path, "bad")).toBeUndefined();
});
