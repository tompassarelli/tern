import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeProviderUsageObservations, writeProviderUsageObservations } from "../src/provider-observation-store";
import type { ProviderUsageObservation } from "../src/providers/types";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function destination(): string {
  const directory = mkdtempSync(join(tmpdir(), "north-observation-writer-"));
  temporary.push(directory);
  return join(directory, "nested", "provider-usage-observations.json");
}

function observation(targetId: string, provider: "anthropic" | "openai", observedAt: string): ProviderUsageObservation {
  return { targetId, provider, state: "normal", observedAt };
}

test("pure merge preserves other targets and keeps the newest target/provider observation", () => {
  const oldClaude = observation("claude", "anthropic", "2026-07-16T10:00:00Z");
  const codex = observation("codex", "openai", "2026-07-16T11:00:00Z");
  const newClaude = { ...oldClaude, state: "low" as const, observedAt: "2026-07-16T12:00:00Z" };
  const staleClaude = { ...oldClaude, state: "plenty" as const, observedAt: "2026-07-16T09:00:00Z" };
  const merged = mergeProviderUsageObservations({ version: 1, observations: [oldClaude, codex] }, [newClaude, staleClaude]);
  expect(merged.observations).toEqual([newClaude, codex]);
});

test("future timestamp poisoning is discarded instead of shadowing a current observation", () => {
  const poisoned = { ...observation("claude", "anthropic", "2099-01-01T00:00:00Z"), state: "exhausted" as const };
  const current = { ...observation("claude", "anthropic", "2026-07-16T12:00:00Z"), state: "plenty" as const };
  const merged = mergeProviderUsageObservations({ version: 1, observations: [poisoned] }, current,
    new Date("2026-07-16T12:01:00Z"));
  expect(merged.observations).toEqual([current]);
});

test("atomic writer creates parents, writes restrictive mode, and leaves no artifacts", async () => {
  const path = destination();
  const result = await writeProviderUsageObservations(observation("codex", "openai", "2026-07-16T11:00:00Z"), path);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(result);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(path, ".."))).toEqual(["provider-usage-observations.json"]);
});

test("concurrent writers serialize merge without losing providers or targets", async () => {
  const path = destination();
  const writes: Promise<unknown>[] = [];
  for (let index = 0; index < 20; index++) {
    writes.push(writeProviderUsageObservations(
      observation(`target-${index}`, index % 2 ? "anthropic" : "openai", `2026-07-16T11:${String(index).padStart(2, "0")}:00Z`),
      path,
    ));
  }
  await Promise.all(writes);
  const stored = JSON.parse(readFileSync(path, "utf8"));
  expect(stored.observations).toHaveLength(20);
  expect(new Set(stored.observations.map((item: ProviderUsageObservation) => item.targetId)).size).toBe(20);
});

test("100 repeated concurrent batches never lose a resolved write", async () => {
  for (let repetition = 0; repetition < 100; repetition++) {
    const path = destination();
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeProviderUsageObservations(
      observation(`target-${index}`, index % 2 ? "anthropic" : "openai",
        `2026-07-16T11:${String(index).padStart(2, "0")}:00Z`),
      path,
    )));
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.observations, `lost a write in repetition ${repetition + 1}`).toHaveLength(20);
  }
}, 40_000);

test("concurrent writes to one target retain the chronologically latest observation", async () => {
  const path = destination();
  await Promise.all(Array.from({ length: 20 }, (_, index) => writeProviderUsageObservations(
    observation("claude", "anthropic", `2026-07-16T11:${String(index).padStart(2, "0")}:00Z`), path,
  )));
  const stored = JSON.parse(readFileSync(path, "utf8"));
  expect(stored.observations).toHaveLength(1);
  expect(stored.observations[0].observedAt).toBe("2026-07-16T11:19:00Z");
});

test("invalid incoming observations fail before touching the filesystem", async () => {
  const path = destination();
  await expect(writeProviderUsageObservations({
    targetId: "codex", provider: "openai", observedAt: "not-a-date", state: "normal",
  }, path)).rejects.toThrow("invalid North provider usage observations at <incoming observations>");
  expect(existsSync(join(path, ".."))).toBe(false);
});

test("a malformed existing store fails loudly without replacing it", async () => {
  const path = destination();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{broken");
  await expect(writeProviderUsageObservations(
    observation("codex", "openai", "2026-07-16T11:00:00Z"), path,
  )).rejects.toThrow(`invalid North provider usage observations at ${path}: could not parse JSON`);
  expect(readFileSync(path, "utf8")).toBe("{broken");
  expect(readdirSync(join(path, ".."))).toEqual(["provider-usage-observations.json"]);
});
