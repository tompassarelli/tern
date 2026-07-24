// Single synthetic admission: one identity-fact publish through the exact
// SDK write path a real managed-lane spawn uses (writeAgentFacts →
// cli/agent-fact-internal.clj `publish`, one bb subprocess, ~25 identity
// facts). Run as its own process so N concurrent invocations model N
// concurrent lane admissions truthfully — writeAgentFacts is synchronous
// (execFileSync), so in-process Promise.all would serialize on one thread
// and understate real concurrency.
//
// Usage: bun admission-worker.ts <agentId>
// Env: NORTH_PORT, FRAM_LOG must point at the scratch coordinator — never
// the production port/log. This script performs no provider spawn, no
// north spawn/delegate call; it is a direct synthetic identity-fact write.
import { writeAgentFacts } from "../src/identity";

const agentId = process.argv[2];
if (!agentId) {
  console.error(JSON.stringify({ ok: false, error: "missing agentId arg" }));
  process.exit(2);
}

const t0 = performance.now();
try {
  await writeAgentFacts(agentId, {
    kind: "lane",
    role: "bench-role",
    liveInput: "unsupported",
    liveInputState: "frozen",
    liveInputEpoch: "00000000-0000-4000-8000-000000000020",
    compositionKind: "preset",
    compositionId: "bench-role",
    compositionOverrides: [],
    provider: "anthropic",
    providerTarget: "sonnet",
    model: "sonnet",
    effort: "medium",
    repo: "/home/tom/code/north",
    goal: "synthetic admission-burst benchmark (019f90f5)",
    coordinator: "bench-coordinator",
    worktree: `/tmp/admission-bench/wt/${agentId}`,
    branch: `lane-${agentId}`,
  });
  const ms = performance.now() - t0;
  console.log(JSON.stringify({ ok: true, agentId, ms }));
} catch (error) {
  const ms = performance.now() - t0;
  console.log(JSON.stringify({
    ok: false, agentId, ms,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}
