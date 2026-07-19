// P4 — self-organized discovery. An IDLE agent finds its own work with no human
// and no command: pull ready threads off the fact graph and dispatch them through
// the canonical harness boundary. Dispatch itself atomically owns the single
// driver claim, so discovery cannot drift into a second acquisition protocol.
// Jittered exponential backoff
// on empty/contended rounds so agents desynchronize instead of thundering an empty queue.
//
// This is the pull side of the loop: P1 (reactor) reacts to commands addressed to
// an agent; discover lets an idle agent SELECT its own work. Together: a thread is
// dropped, and whichever agent is free grabs it — leaderless.
import { execSync } from "node:child_process";
import { dispatch } from "./dispatch";
import { ProviderSelectionError } from "./provider-routing";
import { DispatchAlreadyActiveError } from "./dispatch-driver";
import type { RoutingRequest } from "./routing-metadata";
import { admitRoutingRequest, routingRequestFromEnv } from "./routing-admission";

export interface ReadyThread {
  id: string;
  title: string;
  condition: string;
}

// Unblocked, committed, undriven work off the fact graph.
function readyThreads(): ReadyThread[] {
  try {
    // --all: discovery needs the FULL ready set to pick from, not the curated
    // top-15 slice the JSON default now returns (parity with the MCP/CLI edge).
    const rows = JSON.parse(execSync("north json ready --all", { encoding: "utf8", timeout: 8000 }).trim());
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export interface DiscoverOpts {
  routingRequest: RoutingRequest;
  maxTasks?: number; // stop after N completed (default: unbounded)
  maxEmptyRounds?: number; // stop after N consecutive unsuccessful rounds (default 5)
}

export interface DiscoverDependencies {
  readyThreads: () => ReadyThread[];
  dispatch: (thread: string, routingRequest: RoutingRequest) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

const defaultDependencies: DiscoverDependencies = {
  readyThreads,
  dispatch: (thread, routingRequest) => dispatch(thread, { routingMetadata: routingRequest }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

function dispatchFailureReason(error: unknown): string {
  if (error instanceof ProviderSelectionError)
    return `provider routing ${error.kind.replaceAll("_", " ")} before side effects`;
  return "dispatch failed";
}

function errorSummary(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "unknown error";
}

// The pull loop. Returns the thread ids it drove to completion.
export async function discover(
  self: string,
  opts: DiscoverOpts,
  overrides: Partial<DiscoverDependencies> = {},
): Promise<string[]> {
  const routingRequest = admitRoutingRequest(
    opts.routingRequest ?? {}, "managed North discovery",
  );
  const dependencies = { ...defaultDependencies, ...overrides };
  const maxTasks = opts.maxTasks ?? Infinity;
  const maxEmpty = opts.maxEmptyRounds ?? 5;
  const done: string[] = [];
  let unsuccessfulRounds = 0;

  const backoff = async (why: string) => {
    unsuccessfulRounds++;
    const base = Math.min(30_000, 1_000 * 2 ** unsuccessfulRounds);
    const ms = Math.round(base * (0.5 + dependencies.random()));
    console.log(`[discover] ${self} ${why} (${unsuccessfulRounds}/${maxEmpty}) — backoff ${ms}ms`);
    await dependencies.sleep(ms);
  };

  while (done.length < maxTasks && unsuccessfulRounds < maxEmpty) {
    let attempted = false;
    for (const t of dependencies.readyThreads()) {
      console.log(`[discover] ${self} considering ${t.id} — ${t.title}`);
      let failure: unknown;
      let failed = false;
      try {
        await dependencies.dispatch(t.id, routingRequest);
        attempted = true;
        done.push(t.id);
        unsuccessfulRounds = 0;
        console.log(`[discover] ${self} finished ${t.id} (${done.length} total)`);
      } catch (e) {
        if (e instanceof DispatchAlreadyActiveError) {
          console.log(`[discover] ${self} skipped ${t.id} — another driver won`);
          continue;
        }
        attempted = true;
        failed = true;
        failure = e;
        console.error(`[discover] ${self} dispatch of ${t.id} failed: ${errorSummary(e)}`);
      }
      if (failed) await backoff(dispatchFailureReason(failure));
      break; // re-poll fresh — the graph moved
    }
    if (!attempted) await backoff("no acquirable work");
  }
  console.log(`[discover] ${self} exiting — drove ${done.length} thread(s)`);
  return done;
}

if (import.meta.main) {
  const self = process.env.AGENT_ID ?? `sdk-disc-${Date.now().toString(36).slice(-6)}`;
  const maxTasks = process.env.DISCOVER_MAX ? Number(process.env.DISCOVER_MAX) : undefined;
  discover(self, {
    routingRequest: routingRequestFromEnv("managed North discovery bootstrap"),
    maxTasks,
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
