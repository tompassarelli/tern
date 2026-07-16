import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireFileLease } from "../src/file-lease";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("an old but live slow writer never loses its lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-file-lease-"));
  temporary.push(directory);
  const path = join(directory, "store.lock");
  const slow = await acquireFileLease(path, { waitMs: 2, attempts: 500, unknownStaleMs: 5 });
  let competitorEntered = false;
  const competitor = acquireFileLease(path, { waitMs: 2, attempts: 500, unknownStaleMs: 5 })
    .then((lease) => { competitorEntered = true; return lease; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(competitorEntered).toBe(false);
  await slow.release();
  const successor = await competitor;
  expect(competitorEntered).toBe(true);
  await successor.release();
});

test("a slow writer in another live process cannot be stale-recovered", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-file-lease-child-"));
  temporary.push(directory);
  const path = join(directory, "store.lock");
  const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/hold-file-lease.ts"), path, "100"],
    { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.setEncoding("utf8");
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  let entered = false;
  const waiting = acquireFileLease(path, { waitMs: 2, attempts: 500, unknownStaleMs: 5 })
    .then((lease) => { entered = true; return lease; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(entered).toBe(false);
  await once(child, "exit");
  const lease = await waiting;
  expect(entered).toBe(true);
  await lease.release();
});

test("a recorded dead owner is recovered without an age guess", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-file-lease-dead-"));
  temporary.push(directory);
  const path = join(directory, "store.lock");
  mkdirSync(path);
  writeFileSync(join(path, "owner.json"), `${JSON.stringify({ token: "dead", pid: 2_000_000_000, createdAt: new Date().toISOString() })}\n`);
  const lease = await acquireFileLease(path, { waitMs: 2, attempts: 20 });
  expect(existsSync(path)).toBe(true);
  await lease.release();
  expect(existsSync(path)).toBe(false);
});

test("two recoverers cannot ABA-delete an atomically-published live successor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-file-lease-aba-"));
  temporary.push(directory);
  const path = join(directory, "store.lock");
  const protectedWrite = join(directory, "store.json");
  mkdirSync(path);
  writeFileSync(join(path, "owner.json"), `${JSON.stringify({
    token: "dead", pid: 2_000_000_000, createdAt: new Date().toISOString(),
  })}\n`);

  let announceRemoved!: () => void;
  const removed = new Promise<void>((resolve) => { announceRemoved = resolve; });
  let resumeFirst!: () => void;
  const firstMayContinue = new Promise<void>((resolve) => { resumeFirst = resolve; });
  let firstEntered = false;
  const first = acquireFileLease(path, {
    waitMs: 2, attempts: 500,
    afterRecoveryOwnerRemoved: async () => { announceRemoved(); await firstMayContinue; },
  }).then((lease) => { firstEntered = true; return lease; });

  await removed;
  // The second recoverer helps remove the ownerless dead directory, then
  // atomically publishes itself as the live successor while A is paused.
  const successor = await acquireFileLease(path, { waitMs: 2, attempts: 500 });
  writeFileSync(protectedWrite, "successor-write\n");
  resumeFirst();
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(firstEntered).toBe(false);
  expect((await Array.fromAsync(new Bun.Glob("owner.*.json").scan(path))).length).toBe(1);
  expect(await Bun.file(protectedWrite).text()).toBe("successor-write\n");

  await successor.release();
  const eventual = await first;
  expect(await Bun.file(protectedWrite).text()).toBe("successor-write\n");
  await eventual.release();
});

test("a recoverer paused after observing a dead owner cannot unlink a successor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "north-file-lease-observed-aba-"));
  temporary.push(directory);
  const path = join(directory, "store.lock");
  mkdirSync(path);
  writeFileSync(join(path, "owner.json"), `${JSON.stringify({
    token: "dead", pid: 2_000_000_000, createdAt: new Date().toISOString(),
  })}\n`);

  let announceObserved!: () => void;
  const observed = new Promise<void>((resolve) => { announceObserved = resolve; });
  let resumeFirst!: () => void;
  const firstMayContinue = new Promise<void>((resolve) => { resumeFirst = resolve; });
  let firstEntered = false;
  const first = acquireFileLease(path, {
    waitMs: 1, attempts: 2_000,
    afterRecoveryOwnerObserved: async () => { announceObserved(); await firstMayContinue; },
  }).then((lease) => { firstEntered = true; return lease; });

  await observed;
  const successor = await acquireFileLease(path, { waitMs: 1, attempts: 2_000 });
  resumeFirst();
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(firstEntered).toBe(false);
  expect((await Array.fromAsync(new Bun.Glob("owner.*.json").scan(path))).length).toBe(1);
  await successor.release();
  const eventual = await first;
  await eventual.release();
});
