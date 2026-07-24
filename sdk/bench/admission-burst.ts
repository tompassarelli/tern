// Admission spawn-burst benchmark (scale mandate 019f90f5-3f67-765a-830e-cdc9ce48cfb3).
//
// SAFETY ENVELOPE (binding, see docs/private/admission-benchmark-brief.md):
//   - NEVER targets :7977 / the production log. Requires NORTH_PORT and
//     FRAM_LOG to be explicitly set to a scratch coordinator and refuses to
//     run against the production defaults.
//   - Drives the identity-fact-write path synthetically (writeAgentFacts, the
//     exact function a real managed-lane spawn calls). No provider spawn, no
//     `north spawn`/delegate call is used as load.
//
// Method: for each N in the burst matrix, spawn N `admission-worker.ts`
// child processes concurrently (Bun.spawn — real OS processes, so this is
// genuine concurrency, not single-thread Promise.all serialization over a
// synchronous execFileSync call). Each worker performs exactly one identity
// publish (one bb subprocess) and reports its own wall-clock. Repeat for
// >=3 trials per N.
import { loadavg } from "node:os";
import { readFileSync } from "node:fs";

const NORTH_PORT = process.env.NORTH_PORT;
const FRAM_LOG = process.env.FRAM_LOG;
const WORKER = new URL("./admission-worker.ts", import.meta.url).pathname;

function failClosed(message: string): never {
  console.error(`admission-burst: REFUSING — ${message}`);
  process.exit(2);
}

if (!NORTH_PORT || NORTH_PORT === "7977") {
  failClosed("NORTH_PORT must be set to a scratch coordinator port (never 7977/unset)");
}
if (!FRAM_LOG || FRAM_LOG === `${process.env.HOME}/.local/state/north/coordination.log`) {
  failClosed("FRAM_LOG must be set to a scratch log path (never the production coordination.log)");
}
if (!FRAM_LOG.startsWith("/tmp/")) {
  failClosed(`FRAM_LOG must live under /tmp/ for this benchmark (got ${FRAM_LOG})`);
}

const MATRIX = (process.env.BENCH_MATRIX ?? "1,10,25,50,100")
  .split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0);
const TRIALS = Number(process.env.BENCH_TRIALS ?? "3");
const EXPLORE = process.env.BENCH_EXPLORE ? Number(process.env.BENCH_EXPLORE) : undefined;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function runBurst(n: number, label: string) {
  const before = loadavg();
  const wallStart = performance.now();
  const children = Array.from({ length: n }, (_, i) => {
    const agentId = `bench-${label}-${wallStart.toFixed(0)}-${i}-${Math.random().toString(36).slice(2, 8)}`;
    return Bun.spawn({
      cmd: ["bun", WORKER, agentId],
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, NORTH_PORT, FRAM_LOG },
      stdout: "pipe",
      stderr: "pipe",
    });
  });
  const results = await Promise.all(children.map(async (child) => {
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    try {
      const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
      return { ...parsed, exitCode };
    } catch {
      return { ok: false, ms: NaN, error: "worker output unparseable", exitCode };
    }
  }));
  const wallMs = performance.now() - wallStart;
  const after = loadavg();
  const okResults = results.filter((r) => r.ok);
  const failures = results.length - okResults.length;
  const perAdmissionMs = okResults.map((r) => r.ms as number).sort((a, b) => a - b);
  return {
    n,
    trials_label: label,
    wallMs,
    throughputPerSec: n / (wallMs / 1000),
    failures,
    p50: percentile(perAdmissionMs, 50),
    p95: percentile(perAdmissionMs, 95),
    loadBefore: before,
    loadAfter: after,
  };
}

async function main() {
  console.log(`# admission-burst — NORTH_PORT=${NORTH_PORT} FRAM_LOG=${FRAM_LOG}`);
  console.log(`# matrix=${MATRIX.join(",")} trials=${TRIALS} explore=${EXPLORE ?? "none"}`);
  const rows: Array<Record<string, unknown>> = [];
  for (const n of MATRIX) {
    for (let t = 1; t <= TRIALS; t++) {
      const row = await runBurst(n, `N${n}-t${t}`);
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  if (EXPLORE) {
    const row = await runBurst(EXPLORE, `explore-N${EXPLORE}`);
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  console.log(`# nproc=${(() => {
    try { return readFileSync("/proc/cpuinfo", "utf8").split("\nprocessor").length - 1; }
    catch { return "unknown"; }
  })()}`);
}

main();
