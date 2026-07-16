import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_PROVIDER_OBSERVATIONS_PATH, OBSERVATION_CLOCK_SKEW_MS,
  parseProviderUsageObservations,
} from "./resource-policy";
import type { ProviderUsageObservation, ProviderUsageObservationStore } from "./providers/types";
import { withFileLease } from "./file-lease";

function observationKey({ targetId, provider }: ProviderUsageObservation): string {
  return `${targetId}\u0000${provider}`;
}

/** Keep one newest observation for each target/provider pair. */
export function mergeProviderUsageObservations(
  existing: ProviderUsageObservationStore | undefined,
  incoming: ProviderUsageObservation | ProviderUsageObservation[],
  now = new Date(),
): ProviderUsageObservationStore {
  const newest = new Map<string, ProviderUsageObservation>();
  for (const observation of [...(existing?.observations ?? []), ...([incoming].flat())]) {
    if (Date.parse(observation.observedAt) > now.getTime() + OBSERVATION_CLOCK_SKEW_MS) continue;
    const key = observationKey(observation);
    const previous = newest.get(key);
    if (!previous || Date.parse(observation.observedAt) >= Date.parse(previous.observedAt))
      newest.set(key, observation);
  }
  return {
    version: 1,
    observations: [...newest.values()].sort((left, right) =>
      left.targetId.localeCompare(right.targetId) || left.provider.localeCompare(right.provider)),
  };
}

async function readExisting(path: string): Promise<ProviderUsageObservationStore | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    try { return parseProviderUsageObservations(JSON.parse(raw), path); }
    catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(`invalid North provider usage observations at ${path}: could not parse JSON: ${error.message}`);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Serialize read/merge/replace through a filesystem lock so independent
 * provider collectors cannot erase one another's observations.
 */
export async function writeProviderUsageObservations(
  incoming: ProviderUsageObservation | ProviderUsageObservation[],
  path = process.env.NORTH_PROVIDER_OBSERVATIONS ?? DEFAULT_PROVIDER_OBSERVATIONS_PATH,
): Promise<ProviderUsageObservationStore> {
  const validatedIncoming = parseProviderUsageObservations({ version: 1, observations: [incoming].flat() }, "<incoming observations>");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  return withFileLease(lockPath, async () => {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
    const merged = mergeProviderUsageObservations(await readExisting(path), validatedIncoming.observations);
    await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    return merged;
    } finally { await rm(temporary, { force: true }); }
  });
}
