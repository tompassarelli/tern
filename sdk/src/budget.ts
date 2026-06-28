// Token budget — the declarative spend cap (replaces the concurrency cap). Set it
// once: `lodestar tell @swarm budget_total 500000`. Every agent run charges its
// token usage to @swarm/budget_spent via the coordinator's ATOMIC :bump op (fram-1,
// e3e9adf) — read-add-write under the lock, so N executors charging at once never
// lose an update. Executors stop dispatching once spent >= total. Bounds the real
// resource (spend) regardless of fan-out. No budget_total set => unbounded (opt-in).
import { createConnection } from "node:net";

const PORT = Number(process.env.LODESTAR_PORT ?? 7977);
const SUBJECT = process.env.LODESTAR_BUDGET ?? "@swarm";

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

// Resolve a single-valued claim to a number, or null if unset/unreadable.
async function readNum(pred: string): Promise<number | null> {
  try {
    const r = await coordOp(`{:op :resolved :te ${JSON.stringify(SUBJECT)} :p ${JSON.stringify(pred)}}`);
    const m = r.match(/:value\s+"?(-?\d+(?:\.\d+)?)"?/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Tokens left, or Infinity if no budget is set (the unbounded, opt-in default).
export async function remaining(): Promise<number> {
  const total = await readNum("budget_total");
  if (total == null || Number.isNaN(total)) return Infinity;
  return total - ((await readNum("budget_spent")) ?? 0);
}

// Total tokens for one agent run (input + output + cache) from the SDK result msg.
export function tokensOf(resultMsg: any): number {
  const u = resultMsg?.usage ?? {};
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
}

// Atomically add `tokens` to @swarm/budget_spent via the coordinator :bump op —
// race-proof under concurrent charges (read-add-write inside the lock). No-op when
// no budget is set, so unbudgeted runs stay untracked.
export async function charge(tokens: number): Promise<void> {
  if (tokens <= 0) return;
  if ((await readNum("budget_total")) == null) return; // no budget => don't track
  try {
    await coordOp(`{:op :bump :te ${JSON.stringify(SUBJECT)} :p "budget_spent" :n ${Math.round(tokens)}}`);
  } catch {}
}
