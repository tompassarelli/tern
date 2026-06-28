// P4 — self-organized discovery. An IDLE agent finds its own work with no human
// and no command: pull ready threads off the claim graph, ATOMICALLY claim the
// driver (fram-1's P3 lease — race-proof, so N agents never double-drive the same
// thread), dispatch it through the harness, release. Jittered exponential backoff
// on empty/contended rounds so a swarm desyncs instead of thundering an empty queue.
//
// This is the pull side of the loop: P1 (reactor) reacts to commands addressed to
// an agent; discover lets an idle agent SELECT its own work. Together: a thread is
// dropped, and whichever agent is free grabs it — leaderless.
import { execSync, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { dispatch } from "./dispatch";
import { acquireSlot, releaseSlot, SWARM_MAX } from "./slots";

const REPO = resolve(import.meta.dir, "../..");
const CLAIM_CLI = `${REPO}/cli/claim-cli.clj`;
const PORT = process.env.LODESTAR_PORT ?? "7977";

interface ReadyThread {
  id: string;
  title: string;
  condition: string;
}

// Unblocked, committed, undriven work off the claim graph.
function readyThreads(): ReadyThread[] {
  try {
    const rows = JSON.parse(execSync("lodestar json ready", { encoding: "utf8", timeout: 8000 }).trim());
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

// Atomic driver claim (fram-1's P3 lease). True iff THIS agent won; false = a peer
// holds it (claim-cli exits 1 + prints DENIED). The race agentchat never closed.
function claimDriver(thread: string, holder: string): boolean {
  try {
    execFileSync("bb", [CLAIM_CLI, PORT, "claim", thread, holder], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function releaseDriver(thread: string, holder: string): void {
  try {
    execFileSync("bb", [CLAIM_CLI, PORT, "release", thread, holder], { stdio: "pipe" });
  } catch {}
}

export interface DiscoverOpts {
  maxTasks?: number; // stop after N completed (default: unbounded)
  maxEmptyRounds?: number; // stop after N consecutive empty/contended rounds (default 5)
}

// The pull loop. Returns the thread ids it drove to completion.
export async function discover(self: string, opts: DiscoverOpts = {}): Promise<string[]> {
  const maxTasks = opts.maxTasks ?? Infinity;
  const maxEmpty = opts.maxEmptyRounds ?? 5;
  const done: string[] = [];
  let empty = 0;

  const backoff = async (why: string) => {
    empty++;
    const base = Math.min(30_000, 1_000 * 2 ** empty);
    const ms = Math.round(base * (0.5 + Math.random())); // jitter desyncs the swarm
    console.log(`[discover] ${self} ${why} (${empty}/${maxEmpty}) — backoff ${ms}ms`);
    await new Promise((r) => setTimeout(r, ms));
  };

  while (done.length < maxTasks && empty < maxEmpty) {
    // Budget gate: hold one of N swarm slots before running ANY agent. No free
    // slot = at cap → back off. This is what stops a fan-out from fork-bombing.
    const slot = await acquireSlot(self);
    if (!slot) {
      await backoff(`at cap (${SWARM_MAX} slots full)`);
      continue;
    }
    let claimed = false;
    try {
      for (const t of readyThreads()) {
        if (!claimDriver(t.id, self)) continue; // peer got it — try the next ready thread
        claimed = true;
        empty = 0;
        console.log(`[discover] ${self} claimed ${t.id} — ${t.title}`);
        try {
          await dispatch(t.id);
          done.push(t.id);
          console.log(`[discover] ${self} finished ${t.id} (${done.length} total)`);
        } catch (e) {
          console.error(`[discover] ${self} dispatch of ${t.id} failed:`, e);
        } finally {
          releaseDriver(t.id, self);
        }
        break; // re-poll fresh — the graph moved
      }
    } finally {
      await releaseSlot(self, slot); // free the budget slot whether or not we found work
    }
    if (!claimed) await backoff("no claimable work");
  }
  console.log(`[discover] ${self} exiting — drove ${done.length} thread(s)`);
  return done;
}

if (import.meta.main) {
  const self = process.env.AGENT_ID ?? `sdk-disc-${Date.now().toString(36).slice(-6)}`;
  const maxTasks = process.env.DISCOVER_MAX ? Number(process.env.DISCOVER_MAX) : undefined;
  discover(self, { maxTasks }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
