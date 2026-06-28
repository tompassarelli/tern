// Spawn-budget cap — the safety rail that makes fan-out safe to run unattended.
// N named slots (@swarm-slot:1..N) leased through fram's EXCLUSIVE lease (the same
// primitive P3 uses). An executor must hold a slot before it spawns a real agent;
// since acquire-lease is atomic in the coordinator's lock, the global count of
// concurrent agents can never exceed N — no fork-bomb, no runaway credit burn.
//
// Self-contained: speaks the coordinator's line-delimited EDN socket directly, so
// it needs no cli/ change (fram-1's reactor gates on the SAME slot pool from its side).
import { createConnection } from "node:net";

const PORT = Number(process.env.LODESTAR_PORT ?? 7977);
export const SWARM_MAX = Number(process.env.LODESTAR_SWARM_MAX ?? 4);

// One request/response against the coordinator (one EDN line each way).
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

// Acquire one free slot. Returns the slot key held, or null if all N are taken
// (= at cap → caller backs off). ttl so a crashed holder's slot self-frees.
export async function acquireSlot(holder: string, ttlMs = 600_000): Promise<string | null> {
  for (let i = 1; i <= SWARM_MAX; i++) {
    const res = `@swarm-slot:${i}`;
    try {
      const r = await coordOp(
        `{:op :acquire-lease :holder ${JSON.stringify(holder)} :res ${JSON.stringify(res)} :ttl-ms ${ttlMs}}`
      );
      if (!r.includes(":reject")) return res; // granted (a reject means this slot is held)
    } catch {
      // socket/timeout — treat this slot as unavailable, try the next
    }
  }
  return null; // every slot held — budget exhausted
}

export async function releaseSlot(holder: string, slot: string): Promise<void> {
  try {
    await coordOp(`{:op :release-lease :holder ${JSON.stringify(holder)} :res ${JSON.stringify(slot)}}`);
  } catch {
    // best-effort; the ttl reaps it anyway
  }
}
