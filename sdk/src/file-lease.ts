import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FileLeaseOptions {
  attempts?: number;
  waitMs?: number;
  unknownStaleMs?: number;
  /** Deterministic adversarial-test seam after observing a recoverable owner. */
  afterRecoveryOwnerObserved?: () => Promise<void>;
  /** Deterministic adversarial-test seam after recovery ownership transfers. */
  afterRecoveryOwnerRemoved?: () => Promise<void>;
}

interface LockOwner { token: string; pid: number; createdAt: string }

const LEGACY_OWNER = "owner.json";
const ownerName = (token: string) => `owner.${token}.json`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

interface ObservedOwner { name: string; owner?: LockOwner }

async function ownerAt(path: string): Promise<ObservedOwner | undefined> {
  try {
    const names = (await readdir(path)).filter((name) =>
      name === LEGACY_OWNER || (name.startsWith("owner.") && name.endsWith(".json"))
    ).sort();
    const name = names[0];
    if (!name) return undefined;
    try {
      const value = JSON.parse(await readFile(join(path, name), "utf8"));
      const owner = typeof value?.token === "string" && Number.isInteger(value?.pid)
        && typeof value?.createdAt === "string" ? value as LockOwner : undefined;
      return { name, owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) return { name };
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeEmptyLock(path: string): Promise<void> {
  try { await rmdir(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTEMPTY means an atomically-published live successor owns the pathname.
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}

async function recoverDeadOwner(path: string, options: FileLeaseOptions): Promise<boolean> {
  const observed = await ownerAt(path);
  if (observed?.owner && processAlive(observed.owner.pid)) return false;
  if (observed && !observed.owner) {
    try {
      const info = await stat(join(path, observed.name));
      if (Date.now() - info.mtimeMs <= (options.unknownStaleMs ?? 30_000)) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A prior recoverer crashed after removing ownership. Helping it finish is
      // safe: a successor is published non-empty in one atomic rename.
    }
  }
  if (observed) {
    await options.afterRecoveryOwnerObserved?.();
    try {
      // The token is part of the pathname. A delayed recoverer can therefore
      // only remove the owner it observed, never a successor's owner (ABA).
      await unlink(join(path, observed.name));
      await options.afterRecoveryOwnerRemoved?.();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await removeEmptyLock(path);
  return true;
}

/**
 * Exclusive crash-recoverable directory lease.
 *
 * Acquisition builds a private non-empty directory and atomically renames it to
 * the public lock path. Ownership filenames contain their unique token.
 * Recovery transfers ownership by unlinking that observed token's filename;
 * only then may the now-empty old directory be removed. A concurrently-published
 * successor is already non-empty, so every late rmdir fails instead of deleting
 * the successor. This closes compare+unlink ABA without an external dependency.
 */
export async function acquireFileLease(path: string, options: FileLeaseOptions = {}): Promise<{ release(): Promise<void> }> {
  const attempts = options.attempts ?? 250;
  const waitMs = options.waitMs ?? 20;
  const token = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = `${path}.candidate.${process.pid}.${randomUUID()}`;
    try {
      await mkdir(candidate, { mode: 0o700 });
      const owner: LockOwner = { token, pid: process.pid, createdAt: new Date().toISOString() };
      await writeFile(join(candidate, ownerName(token)), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
      await rename(candidate, path);
      return {
        release: async () => {
          try { await unlink(join(path, ownerName(token))); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          await removeEmptyLock(path);
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      if (!await recoverDeadOwner(path, options)) await delay(waitMs);
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
  }
  throw new Error(`timed out waiting for filesystem lease ${path}`);
}

export async function withFileLease<T>(path: string, operation: () => Promise<T>, options?: FileLeaseOptions): Promise<T> {
  const lease = await acquireFileLease(path, options);
  try { return await operation(); }
  finally { await lease.release(); }
}
