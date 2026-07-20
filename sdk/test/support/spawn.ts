import {
  createSpawnAgentId,
  spawn as productionSpawn,
  spawnParallel as productionSpawnParallel,
  type SpawnOptions,
} from "../../src/spawn";
import { bindSpawnTestRuntime } from "../../src/internal/test-runtime";

const RUNTIME_FIELDS = new Set([
  "queryFn", "deliveryRuntime", "loadThreadFacts",
  "childSettlementReader", "feedSubscriber",
  "registerTermination", "refreshAccountUsages", "refreshCodexEntitlements",
  "admitResourceEnvelope", "completeResourceEnvelope", "admitBillableClock",
]);

function prepared(value: SpawnOptions & Record<string, unknown>): SpawnOptions {
  const request: Record<string, unknown> = {};
  const runtime: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(value))
    (RUNTIME_FIELDS.has(field) ? runtime : request)[field] = fieldValue;
  bindSpawnTestRuntime(request, runtime);
  return request as unknown as SpawnOptions;
}

export function spawn(value: SpawnOptions & Record<string, unknown>): Promise<string> {
  return productionSpawn(prepared(value));
}

export function spawnParallel(
  values: Array<SpawnOptions & Record<string, unknown>>,
): Promise<string[]> {
  return productionSpawnParallel(values.map(prepared));
}

export { createSpawnAgentId };
