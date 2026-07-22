import {
  createSpawnAgentId,
  spawn as productionSpawn,
  spawnParallel as productionSpawnParallel,
  type SpawnOptions,
} from "../../src/spawn";
import { bindSpawnTestRuntime } from "../../src/internal/test-runtime";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { worktreeBranch, worktreePath } from "../../src/worktree";

const RUNTIME_FIELDS = new Set([
  "queryFn", "deliveryRuntime", "loadThreadFacts",
  "childSettlementReader", "feedSubscriber",
  "registerTermination", "refreshAccountUsages", "refreshCodexEntitlements",
  "admitResourceEnvelope", "completeResourceEnvelope", "admitBillableClock",
  "worktreeAllocationWriter",
]);

function prepared(value: SpawnOptions & Record<string, unknown>): SpawnOptions {
  const request: Record<string, unknown> = {};
  const runtime: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(value))
    (RUNTIME_FIELDS.has(field) ? runtime : request)[field] = fieldValue;
  bindSpawnTestRuntime(request, runtime);
  return request as unknown as SpawnOptions;
}

export async function spawn(value: SpawnOptions & Record<string, unknown>): Promise<string> {
  if (value.worktree !== undefined) return productionSpawn(prepared(value));

  const agentId = value.agentId ?? createSpawnAgentId();
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const path = worktreePath(agentId, repoRoot);
  try {
    return await productionSpawn(prepared({ ...value, agentId, worktree: true }));
  } finally {
    if (existsSync(path)) {
      execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", path]);
      execFileSync("git", ["-C", repoRoot, "branch", "-D", "--", worktreeBranch(agentId)]);
    }
  }
}

export function spawnParallel(
  values: Array<SpawnOptions & Record<string, unknown>>,
): Promise<string[]> {
  return productionSpawnParallel(values.map(prepared));
}

export { createSpawnAgentId };
