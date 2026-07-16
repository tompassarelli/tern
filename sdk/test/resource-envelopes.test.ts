import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitResourceEnvelope, applicableEnvelopeScopes, completeResourceEnvelope,
  reserveResourceEnvelopeRetry, ResourceEnvelopeExceededError,
} from "../src/resource-envelopes";
import type { ResourceEnvelopes } from "../src/providers/types";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function accounting(): string {
  const directory = mkdtempSync(join(tmpdir(), "north-envelope-test-"));
  temporary.push(directory);
  return join(directory, "state", "accounting.json");
}

test("scope derivation applies recurrent, matching project, and session-specific limits", () => {
  const envelopes: ResourceEnvelopes = {
    month: { runs: 20 }, week: { runs: 10 }, default: { runs: 3 },
    projects: { north: { frontierRuns: 2 } }, sessions: { interactive: { parallelism: 2 } },
  };
  expect(applicableEnvelopeScopes(envelopes, {
    project: "north", sessionId: "interactive", now: new Date("2026-07-16T12:00:00Z"),
  }).scopes.map(({ id }) => id)).toEqual(["month:2026-07", "week:2026-W29", "project:north", "session:interactive"]);
  expect(applicableEnvelopeScopes(envelopes, { sessionId: "other" }).scopes.at(-1)?.id).toBe("default:other");
  expect(applicableEnvelopeScopes(envelopes, {}).advisories).toEqual([
    "session/default envelope not enforceable: no stable session id",
  ]);
});

test("run and frontier admissions are counted durably and denied at the limit", async () => {
  const path = accounting();
  const envelopes: ResourceEnvelopes = { month: { runs: 2, frontierRuns: 1 } };
  const first = await admitResourceEnvelope({ agentId: "one", tier: "frontier", envelopes, path,
    now: new Date("2026-07-16T12:00:00Z") });
  await completeResourceEnvelope(first);
  await expect(admitResourceEnvelope({ agentId: "two", tier: "frontier", envelopes, path,
    now: new Date("2026-07-16T12:01:00Z") })).rejects.toMatchObject({
      name: "ResourceEnvelopeExceededError", scope: "month:2026-07", limit: "frontierRuns",
    });
  const standard = await admitResourceEnvelope({ agentId: "two", tier: "standard", envelopes, path,
    now: new Date("2026-07-16T12:02:00Z") });
  await completeResourceEnvelope(standard);
  await expect(admitResourceEnvelope({ agentId: "three", tier: "standard", envelopes, path,
    now: new Date("2026-07-16T12:03:00Z") })).rejects.toThrow("runs 2/2");
});

test("month and week counters recur while project counters remain cumulative", async () => {
  const path = accounting();
  const envelopes: ResourceEnvelopes = { month: { runs: 1 }, week: { runs: 1 }, projects: { north: { runs: 2 } } };
  const july = await admitResourceEnvelope({ agentId: "july", project: "north", envelopes, path,
    now: new Date("2026-07-31T12:00:00Z") });
  await completeResourceEnvelope(july);
  const august = await admitResourceEnvelope({ agentId: "august", project: "north", envelopes, path,
    now: new Date("2026-08-03T12:00:00Z") });
  await completeResourceEnvelope(august);
  await expect(admitResourceEnvelope({ agentId: "third", project: "north", envelopes, path,
    now: new Date("2026-09-01T12:00:00Z") })).rejects.toMatchObject({ scope: "project:north", limit: "runs" });
});

test("parallel admission is strict and race-free on the shared host", async () => {
  const path = accounting();
  const envelopes: ResourceEnvelopes = { month: { runs: 10, parallelism: 2 } };
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
    admitResourceEnvelope({ agentId: `lane-${index}`, envelopes, path, now: new Date("2026-07-16T12:00:00Z") })));
  const admitted = attempts.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof admitResourceEnvelope>>> => item.status === "fulfilled");
  const denied = attempts.filter((item) => item.status === "rejected");
  expect(admitted).toHaveLength(2);
  expect(denied).toHaveLength(3);
  expect(denied.every((item) => (item as PromiseRejectedResult).reason instanceof ResourceEnvelopeExceededError)).toBe(true);
  await Promise.all(admitted.map(({ value }) => completeResourceEnvelope(value)));
  const next = await admitResourceEnvelope({ agentId: "next", envelopes, path, now: new Date("2026-07-16T12:01:00Z") });
  await completeResourceEnvelope(next);
});

test("fallback retry reservation denies before exceeding any applicable scope", async () => {
  const path = accounting();
  const envelopes: ResourceEnvelopes = { month: { retries: 1 }, projects: { north: { retries: 2 } } };
  const admission = await admitResourceEnvelope({ agentId: "lane", project: "north", envelopes, path,
    now: new Date("2026-07-16T12:00:00Z") });
  await reserveResourceEnvelopeRetry(admission);
  expect(admission?.retries).toBe(1);
  await expect(reserveResourceEnvelopeRetry(admission)).rejects.toMatchObject({
    scope: "month:2026-07", limit: "retries", used: 1, allowed: 1,
  });
  expect(admission?.retries).toBe(1);
  await completeResourceEnvelope(admission);
});

test("accounting is written atomically with restrictive permissions", async () => {
  const path = accounting();
  const admission = await admitResourceEnvelope({ agentId: "lane", envelopes: { week: { runs: 2 } }, path,
    now: new Date("2026-07-16T12:00:00Z") });
  await completeResourceEnvelope(admission);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
});
