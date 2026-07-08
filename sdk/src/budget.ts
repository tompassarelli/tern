// Cost budget — the declarative spend cap (replaces the concurrency cap). Set it
// once: `tern tell @swarm budget_total 25` (a USD ceiling). Spend is a DERIVED
// SUM, never a mutated counter: remaining = budget_total − Σ(@run:* cost_usd),
// folded live from the immutable per-run `@run:<sid> cost_usd` facts presence-cli
// already writes (the same aggregate cli/tern-reconcile.clj reports). No
// `budget_spent` cell, no `:bump` op, no cross-file sync — full who-spent-what
// provenance for free. Executors stop dispatching once the sum crosses the cap.
// No budget_total set => unbounded (opt-in).
import { createConnection } from "node:net";

const PORT = Number(process.env.TERN_PORT ?? 7977);
const SUBJECT = process.env.TERN_BUDGET ?? "@swarm";

// One line-delimited EDN request/response against the coordinator socket.
function coordOp(op: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: "127.0.0.1", port: PORT }, () => sock.write(op + "\n"));
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        sock.end();
        resolve(buf.slice(0, nl));
      }
    });
    sock.on("error", reject);
    sock.setTimeout(4000, () => {
      sock.destroy();
      reject(new Error("coordinator timeout"));
    });
  });
}

// Resolve a single-valued fact to a number, or null if unset/unreadable.
async function readNum(pred: string): Promise<number | null> {
  try {
    const r = await coordOp(`{:op :resolved :te ${JSON.stringify(SUBJECT)} :p ${JSON.stringify(pred)}}`);
    const m = r.match(/:value\s+"?(-?\d+(?:\.\d+)?)"?/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Σ(@run:* cost_usd) — the live spend, folded from the immutable per-run cost
// facts (a Datalog aggregate, no mutable cell). The find returns (run, cost)
// PAIRS so two runs with an identical cost stay distinct rows — a cost-only find
// would collapse them under set semantics and under-count. 0 when none recorded.
async function spentSum(): Promise<number> {
  try {
    const q =
      '{:op :query :query {:find "c" :rules [{:head {:rel "c" :args [{:var "e"} {:var "v"}]}' +
      ' :body [{:rel "triple" :args [{:var "e"} "cost_usd" {:var "v"}]}]}]}}';
    const r = await coordOp(q);
    let sum = 0;
    for (const m of r.matchAll(/\[\s*"@run:[^"]*"\s+"?(-?[\d.]+)"?\s*\]/g)) {
      const n = Number(m[1]);
      if (!Number.isNaN(n)) sum += n;
    }
    return sum;
  } catch {
    return 0;
  }
}

// Budget left, or Infinity if no budget is set (the unbounded, opt-in default).
// remaining = budget_total − Σ(@run cost_usd).
export async function remaining(): Promise<number> {
  const total = await readNum("budget_total");
  if (total == null || Number.isNaN(total)) return Infinity;
  return total - (await spentSum());
}

// Approx public per-Mtok USD pricing by model family — for IN-RUN spend estimation
// (the live cap; thread 019f1194-ca57). The final recordRun still uses the SDK's
// authoritative total_cost_usd; this is only to decide when to stop mid-run.
const PRICING: Record<string, { in: number; out: number; cacheR: number; cacheW: number }> = {
  opus: { in: 15, out: 75, cacheR: 1.5, cacheW: 18.75 },
  sonnet: { in: 3, out: 15, cacheR: 0.3, cacheW: 3.75 },
  haiku: { in: 0.8, out: 4, cacheR: 0.08, cacheW: 1 },
};
function priceFor(model?: string) {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return PRICING.opus;
  if (m.includes("haiku")) return PRICING.haiku;
  return PRICING.sonnet; // default / sonnet tier
}
// USD cost of one message's usage block, given the run's model.
export function costOf(model: string | undefined, usage: any): number {
  if (!usage) return 0;
  const p = priceFor(model);
  return (
    ((usage.input_tokens ?? 0) * p.in +
      (usage.output_tokens ?? 0) * p.out +
      (usage.cache_read_input_tokens ?? 0) * p.cacheR +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheW) /
    1e6
  );
}

// Total tokens for one agent run (input + output + cache) from the SDK result msg.
// Retained: telemetry's recordRun folds this into the @run tuple. Spend itself is
// no longer charged here — it is summed from the @run cost_usd facts at read time.
export function tokensOf(resultMsg: any): number {
  const u = resultMsg?.usage ?? {};
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
}
