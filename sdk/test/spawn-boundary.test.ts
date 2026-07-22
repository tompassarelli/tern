// End-to-end error-boundary test, hermetic (no live coordinator, no network).
// Injects a queryFn whose async generator THROWS mid-stream — exactly what the real SDK
// does when its subprocess dies (readMessages() rethrows exitError) — and asserts spawn():
//   1. does NOT reject (returns a partial string) — supervision, not fail-fast;
//   2. emits the death notification (agent_death fact on @swarm) via the fix's finally path.
// All coordinator writes are redirected to a fake `north` on PATH + NORTH_BIN, logged to a
// temp file; NORTH_PORT points at an unused port so any stray bb write no-ops.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { presetRequest } from "./routing-fixtures";
import { LiveFeedReapTimeoutError } from "../src/coordination";

let dir: string;
let log: string;

function readySubscription(stop: () => void = () => {}) {
  return Object.assign(stop, {
    ready: Promise.resolve(),
    drain: async () => {},
    isArmed: () => true,
  });
}

function reapTimeoutSubscription(counter: { stops: number }) {
  const error = new LiveFeedReapTimeoutError(5_000);
  const settlement = Promise.reject(error);
  void settlement.catch(() => {});
  return Object.assign(() => {
    counter.stops++;
    return settlement;
  }, {
    ready: Promise.resolve(),
    drain: async () => {},
    isArmed: () => true,
  });
}

function pinEvidence(provider: "anthropic" | "openai") {
  const issuedAt = new Date();
  return {
    policyVersion: "north-routing-pin-v1" as const,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60 * 60 * 1000).toISOString(),
    reasonCode: "explicit-human-request" as const,
    detail: "spawn boundary fixture",
    pins: [{ kind: "provider" as const, value: provider }],
  };
}

// Every env key this test mutates — snapshot for exact restore (set-or-delete) in afterAll,
// so a scrub here never leaks into sibling suites. Includes the INHERITED IDENTITY keys:
// a real north session runs with AGENT_ID / NORTH_AGENT_ID / AGENT_COORDINATOR (+ model/
// role/effort) exported, and a naive spawn INHERITS them — so scripted test deaths would
// stamp the REAL coordinator onto @agent:test-dead-W3 and ping a live session every reactor
// sweep (~50s). We scrub identity and pin a SYNTHETIC coordinator so any fact/ping the
// harness emits routes nowhere real, even if a future edit lets a write escape the fake.
const MANAGED_ENV = [
  "PATH", "NORTH_BIN", "NORTH_PEER_BB", "NORTH_IDENTITY_TEST_REDIRECT", "NORTH_PORT", "NORTH_STREAM_DIR", "AGENT_LAWS", "AGENT_PRAXIS",
  "AGENT_ID", "NORTH_AGENT_ID", "AGENT_COORDINATOR", "AGENT_TOPOLOGY", "AGENT_MODEL", "AGENT_ROLE", "AGENT_EFFORT", "AGENT_TARGET",
  "NORTH_ROUTING_POLICY", "NORTH_ENVELOPE_ACCOUNTING",
  "NORTH_AUTH_STATE_CACHE",
  "NORTH_PROVIDER_OBSERVATIONS", "NORTH_ALLOCATION_MODE", "NORTH_PROVIDER_ORDER",
  "NORTH_PROVIDER_WEIGHTS", "NORTH_RESERVED_FRONTIER_PROVIDER",
  "NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE", "NORTH_OPENAI_ENTITLEMENT_PRESSURE",
] as const;
const origEnv: Record<string, string | undefined> = {};
for (const k of MANAGED_ENV) origEnv[k] = process.env[k];

// Poison coordinator: library spawn must not import it from ambient process state.
const POISON_COORDINATOR = `poison-coordinator-${process.pid}`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "north-death-"));
  log = join(dir, "death.log");
  // Fake `north`: append every invocation's args to the log, succeed. Stands in for the
  // death fact (tell @swarm ...), the identity tells (writeAgentFacts), and the telemetry
  // recordRun tells — none of which may hit the real graph. Requires every SDK module to
  // resolve the engine via NORTH_BIN (identity.ts was the lone bare-`north` holdout).
  const fake = join(dir, "north");
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
  chmodSync(fake, 0o755);
  const fakeBb = join(dir, "bb");
  writeFileSync(fakeBb, `#!/usr/bin/env bash\nprintf 'bb %s\\n' "$*" >> "${log}"\nexit 0\n`);
  chmodSync(fakeBb, 0o755);
  const fakeClaude = join(dir, "claude");
  writeFileSync(fakeClaude, `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then printf '%s\n' '2.1.0-test'; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  printf '%s\n' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'
  exit 0
fi
exit 2
`);
  chmodSync(fakeClaude, 0o755);
  const fakeCodex = join(dir, "codex");
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then printf '%s\n' 'codex-test'; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then printf '%s\n' 'Logged in using ChatGPT'; exit 0; fi
exit 2
`);
  chmodSync(fakeCodex, 0o755);

  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.NORTH_BIN = fake;
  process.env.NORTH_PEER_BB = fakeBb;
  process.env.NORTH_IDENTITY_TEST_REDIRECT = "1";
  process.env.NORTH_PORT = "59999"; // unused -> presence/any bb write silently no-ops
  process.env.NORTH_STREAM_DIR = dir; // keep stream jsonl out of ~/code/agent-data
  process.env.AGENT_LAWS = "off"; // trim system-prompt file reads; irrelevant to the boundary
  process.env.AGENT_PRAXIS = "off";
  process.env.NORTH_ROUTING_POLICY = join(dir, "absent-routing-policy.json");
  process.env.NORTH_PROVIDER_OBSERVATIONS = join(dir, "absent-provider-observations.json");
  process.env.NORTH_AUTH_STATE_CACHE = join(dir, "auth-state.json");
  delete process.env.NORTH_ALLOCATION_MODE;
  delete process.env.NORTH_PROVIDER_ORDER;
  delete process.env.NORTH_PROVIDER_WEIGHTS;
  delete process.env.NORTH_RESERVED_FRONTIER_PROVIDER;
  delete process.env.NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE;
  delete process.env.NORTH_OPENAI_ENTITLEMENT_PRESSURE;

  // Scrub inherited identity so a test spawn cannot adopt the invoking session's id/coordinator.
  // AGENT_TOPOLOGY in particular: a managed worker lane exports topology=worker, and library
  // spawn() asserts coordination authority against ambient AGENT_TOPOLOGY — so an unscrubbed
  // worker topology would make every spawn here throw NORTH_TOPOLOGY_AUTHORITY_DENIED instead
  // of exercising the death boundary. These tests are the top-level caller: no ambient topology.
  delete process.env.AGENT_TOPOLOGY;
  delete process.env.AGENT_ID;
  delete process.env.NORTH_AGENT_ID;
  delete process.env.AGENT_MODEL;
  delete process.env.AGENT_ROLE;
  delete process.env.AGENT_EFFORT;
  delete process.env.AGENT_TARGET;
  process.env.AGENT_COORDINATOR = POISON_COORDINATOR;
});

afterAll(() => {
  for (const k of MANAGED_ENV) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test("a query that dies mid-stream -> partial return + agent_death notification", async () => {
  const { spawn } = await import("./support/spawn");

  // Fake SDK query: yields one assistant turn (simulating work-in-progress on a long gate),
  // then throws the exact exitError the real ProcessTransport raises on an OOM kill.
  const dyingQuery: any = () =>
    (async function* () {
      yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "starting long gate" }] } };
      throw new Error("Claude Code process terminated by signal 9");
    })();

  let result: string | undefined;
  let threw = false;
  try {
    result = await spawn({ prompt: "run a long gate", agentId: "test-dead-W3",
      routingMetadata: presetRequest("integrator"), queryFn: dyingQuery,
      feedSubscriber: () => readySubscription() });
  } catch {
    threw = true;
  }

  // 1. Supervision: spawn resolved with a (partial) string instead of rejecting.
  expect(threw).toBe(false);
  expect(typeof result).toBe("string");

  // 2. The death was announced: an agent_death fact on @swarm naming the dead agent.
  expect(existsSync(log)).toBe(true);
  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("tell @swarm agent_death");
  expect(logged).toContain("test-dead-W3");
  expect(logged).toContain("signal 9");

  // 3. Identity is request-owned: writeAgentFacts routes through the fake
  //    (NORTH_BIN honored, not a bare-`north` escape) and does not import an
  //    ambient coordinator. Callers that need attribution pass it explicitly.
  expect(logged).not.toContain(`coordinator ${POISON_COORDINATOR}`);
  const inheritedCoord = origEnv.AGENT_COORDINATOR;
  if (inheritedCoord) expect(logged).not.toContain(inheritedCoord);
});

test("ad-hoc spawn subscribes its exact lane and injects a child completion ping", async () => {
  const { spawn } = await import("./support/spawn");
  let subscribedAgent = "";
  let deliver: ((message: string) => void) | undefined;
  let stopCalls = 0;
  let received = "";

  const result = await spawn({
    prompt: "coordinate one child",
    agentId: "test-spawn-live-feed",
    provider: "anthropic",
    pinEvidence: pinEvidence("anthropic"),
    routingMetadata: presetRequest("integrator"),
    feedSubscriber: (agentId, onMail) => {
      subscribedAgent = agentId;
      deliver = onMail;
      return readySubscription(() => { stopCalls++; });
    },
    queryFn: ({ prompt }: any) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]();
        const initial = await input.next();
        expect(initial.value.message.content).toBe("coordinate one child");
        deliver?.("child lane settled with outcome ran");
        const ping = await input.next();
        received = ping.value.message.content;
        yield {
          type: "result",
          subtype: "success",
          result: "reduced child result",
          num_turns: 1,
        };
      },
    }),
  });

  expect(result).toBe("reduced child result");
  expect(subscribedAgent).toBe("test-spawn-live-feed");
  expect(received).toContain("child lane settled");
  expect(stopCalls).toBe(1);
});

test("OpenAI exec lanes never arm a live-input subscription", async () => {
  const { spawn } = await import("./support/spawn");
  let subscriptions = 0;
  const result = await spawn({
    prompt: "one-shot Codex run",
    agentId: "test-openai-no-live-feed",
    provider: "openai",
    pinEvidence: pinEvidence("openai"),
    routingMetadata: presetRequest("integrator"),
    feedSubscriber: () => {
      subscriptions++;
      return readySubscription();
    },
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", result: "done", num_turns: 1 };
      },
    }),
  });
  expect(result).toBe("done");
  expect(subscriptions).toBe(0);
  expect(readFileSync(log, "utf8"))
    .toContain("tell agent:test-openai-no-live-feed live_input unsupported");
});

// Reproduces + fixes: a lane whose provider turn already completed (a real
// result was read) was reclassified process=died/delivery=blocked solely
// because the POST-completion terminal live-feed drain (freezeAndUnbind's
// settlement barrier) timed out/failed during cleanup. Terminal drain is
// cleanup after a completed turn; its failure must not erase the process/
// delivery the completed turn already earned.
test("a terminal live-feed drain failure AFTER a completed provider turn preserves process=ran, not died", async () => {
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");
  const failingDrainSubscription = () => Object.assign(() => {}, {
    ready: Promise.resolve(),
    drain: async () => { throw new Error("settlement feed drain timed out"); },
    isArmed: () => true,
  });

  const result = await spawn({
    prompt: "finish the turn, then let the feed drain fail",
    agentId: "test-drain-safe-completion",
    provider: "anthropic",
    pinEvidence: pinEvidence("anthropic"),
    routingMetadata: presetRequest("integrator"),
    feedSubscriber: () => failingDrainSubscription(),
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", result: "turn completed", num_turns: 1 };
      },
    }),
  });

  expect(result).toBe("turn completed");
  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("tell agent:test-drain-safe-completion outcome ran");
  expect(logged).toContain("tell agent:test-drain-safe-completion process_outcome ran");
  expect(logged).not.toContain("tell agent:test-drain-safe-completion outcome died");
  expect(logged).not.toContain("tell agent:test-drain-safe-completion delivery_outcome blocked");
  expect(logged).not.toContain("agent_death");
});

test("a spawn feed reap timeout cannot become a clean terminal on teardown retry", async () => {
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");
  const counter = { stops: 0 };

  const result = await spawn({
    prompt: "complete provider work but fail to reap the live feed",
    agentId: "test-spawn-reap-timeout",
    provider: "anthropic",
    pinEvidence: pinEvidence("anthropic"),
    routingMetadata: presetRequest("integrator"),
    feedSubscriber: () => reapTimeoutSubscription(counter),
    queryFn: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", result: "provider completed", num_turns: 1 };
      },
    }),
  });

  expect(result).toBe("provider completed");
  expect(counter.stops).toBe(1);
  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("tell agent:test-spawn-reap-timeout outcome died");
  expect(logged).toContain("tell agent:test-spawn-reap-timeout process_outcome died");
  expect(logged).toContain("tell agent:test-spawn-reap-timeout delivery_outcome blocked");
  expect(logged).toContain("North live feed did not reap after bounded termination");
  expect(logged).not.toContain("tell agent:test-spawn-reap-timeout outcome ran");
});

test("a dispatch feed reap timeout cannot become a clean terminal on teardown retry", async () => {
  const { dispatch } = await import("./support/dispatch");
  writeFileSync(log, "");
  const counter = { stops: 0 };
  const previousProvider = process.env.AGENT_PROVIDER;
  process.env.AGENT_PROVIDER = "anthropic";
  try {
    const result = await dispatch("thread-test-dispatch-reap-timeout", {
      agentId: "test-dispatch-reap-timeout",
      routingMetadata: presetRequest("integrator"),
      pinEvidence: pinEvidence("anthropic"),
      claimDriver: (() => ({ release() {} })) as any,
      feedSubscriber: () => reapTimeoutSubscription(counter),
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", result: "provider completed", num_turns: 1 };
        },
      }),
      loadThreadFacts: () => [
        { predicate: "title", value: "Dispatch feed reap timeout" },
        { predicate: "planned", value: "true" },
        { predicate: "atomic", value: "true" },
        { predicate: "judgment_grade", value: "s" },
      ],
      loadChildren: () => [],
    });

    expect(result.result).toBe("provider completed");
  } finally {
    if (previousProvider === undefined) delete process.env.AGENT_PROVIDER;
    else process.env.AGENT_PROVIDER = previousProvider;
  }
  expect(counter.stops).toBe(1);
  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("tell agent:test-dispatch-reap-timeout outcome died");
  expect(logged).toContain("tell agent:test-dispatch-reap-timeout process_outcome died");
  expect(logged).toContain("tell agent:test-dispatch-reap-timeout delivery_outcome blocked");
  expect(logged).toContain("North live feed did not reap after bounded termination");
  expect(logged).not.toContain("tell agent:test-dispatch-reap-timeout outcome ran");
});

// The fail-closed peer of the test above: when the provider itself never
// reaches a success terminal (dies mid-stream, no result read), a live-feed
// drain failure during the same cleanup path must still stay fail-closed —
// process=died is the correct, unchanged classification.
test("a terminal live-feed drain failure with NO completed provider result stays fail-closed (died)", async () => {
  const { spawn } = await import("./support/spawn");
  writeFileSync(log, "");
  const failingDrainSubscription = () => Object.assign(() => {}, {
    ready: Promise.resolve(),
    drain: async () => { throw new Error("settlement feed drain timed out"); },
    isArmed: () => true,
  });

  let threw = false;
  try {
    await spawn({
      prompt: "die before any result, then let the feed drain fail too",
      agentId: "test-drain-fail-closed",
      provider: "anthropic",
      pinEvidence: pinEvidence("anthropic"),
      routingMetadata: presetRequest("integrator"),
      feedSubscriber: () => failingDrainSubscription(),
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {
          throw new Error("Claude Code process terminated by signal 9");
        },
      }),
    });
  } catch {
    threw = true;
  }

  expect(threw).toBe(false); // supervision, not fail-fast
  const logged = readFileSync(log, "utf8");
  expect(logged).toContain("tell agent:test-drain-fail-closed outcome died");
  expect(logged).toContain("tell agent:test-drain-fail-closed process_outcome died");
  expect(logged).toContain("tell agent:test-drain-fail-closed delivery_outcome blocked");
  expect(logged).toContain("agent_death");
});

test("public spawn mints one full-entropy ID across admission, harness, and identity", async () => {
  const { spawn } = await import("./support/spawn");
  const policy = join(dir, "generated-id-policy.json");
  const accounting = join(dir, "generated-id-accounting.json");
  writeFileSync(policy, JSON.stringify({
    version: 1, mode: "preferential",
    targets: [{ id: "anthropic", provider: "anthropic" }, { id: "openai", provider: "openai" }],
    targetOrder: ["anthropic", "openai"],
    envelopes: { month: { runs: 10 } },
  }));
  const previousPolicy = process.env.NORTH_ROUTING_POLICY;
  const previousAccounting = process.env.NORTH_ENVELOPE_ACCOUNTING;
  let harnessId = "";
  try {
    writeFileSync(log, "");
    process.env.NORTH_ROUTING_POLICY = policy;
    process.env.NORTH_ENVELOPE_ACCOUNTING = accounting;
    const result = await spawn({
      prompt: "exercise generated identity",
      routingMetadata: presetRequest("integrator"),
      feedSubscriber: () => readySubscription(),
      queryFn: ({ options }: any) => {
        harnessId = options.mcpServers.north.env.AGENT_ID;
        return (async function* () {
          yield { type: "result", subtype: "success", result: "ok", duration_ms: 1, num_turns: 1 };
        })() as any;
      },
    });
    expect(result).toBe("ok");
    expect(harnessId).toMatch(/^lane-[a-z0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const logged = readFileSync(log, "utf8");
    expect(logged).toContain(`tell agent:${harnessId} kind lane`);
    expect(logged).toContain(`tell agent:${harnessId} outcome ran`);
    const envelopeState = JSON.parse(readFileSync(accounting, "utf8"));
    expect(Object.values(envelopeState.scopes)[0]).toMatchObject({ runs: 1, active: {} });
  } finally {
    if (previousPolicy === undefined) delete process.env.NORTH_ROUTING_POLICY;
    else process.env.NORTH_ROUTING_POLICY = previousPolicy;
    if (previousAccounting === undefined) delete process.env.NORTH_ENVELOPE_ACCOUNTING;
    else process.env.NORTH_ENVELOPE_ACCOUNTING = previousAccounting;
  }
});

test("an exhausted run envelope rejects before an injected provider boundary is called", async () => {
  const policy = join(dir, "denied-routing-policy.json");
  writeFileSync(policy, JSON.stringify({
    version: 1, mode: "preferential",
    targets: [{ id: "anthropic", provider: "anthropic" }, { id: "openai", provider: "openai" }],
    targetOrder: ["anthropic", "openai"],
    envelopes: { month: { runs: 0 } },
  }));
  const absentPolicy = process.env.NORTH_ROUTING_POLICY!;
  const originalAccounting = process.env.NORTH_ENVELOPE_ACCOUNTING;
  try {
    process.env.NORTH_ROUTING_POLICY = policy;
    process.env.NORTH_ENVELOPE_ACCOUNTING = join(dir, "denied-accounting.json");
    let providerCalls = 0;
    await expect((await import("./support/spawn")).spawn({
      prompt: "must not run", agentId: "denied-before-provider",
      routingMetadata: presetRequest("integrator"),
      queryFn: () => { providerCalls++; return { async *[Symbol.asyncIterator]() {} } as any; },
    })).rejects.toThrow("runs 0/0");
    expect(providerCalls).toBe(0);
  } finally {
    process.env.NORTH_ROUTING_POLICY = absentPolicy;
    if (originalAccounting === undefined) delete process.env.NORTH_ENVELOPE_ACCOUNTING;
    else process.env.NORTH_ENVELOPE_ACCOUNTING = originalAccounting;
  }
});

test("an enabled Caveman request with unproved fork provenance rejects before provider query", async () => {
  const priorHome = process.env.NORTH_CAVEMAN_HOME;
  const priorRev = process.env.NORTH_CAVEMAN_REV;
  process.env.NORTH_CAVEMAN_HOME = "/definitely/missing-caveman-fork";
  process.env.NORTH_CAVEMAN_REV = "020f650daa42a506660a2959f62f2a999d7e1018";
  let providerCalls = 0;
  let providerObservations = 0;
  try {
    await expect((await import("./support/spawn")).spawn({
      prompt: "must not reach provider", agentId: "caveman-provenance-before-provider",
      caveman: "lite", routingMetadata: presetRequest("integrator"),
      refreshAccountUsages: async () => { providerObservations++; throw new Error("must not probe"); },
      queryFn: () => { providerCalls++; return { async *[Symbol.asyncIterator]() {} } as any; },
    })).rejects.toThrow("managed Caveman fork provenance unavailable");
    expect(providerCalls).toBe(0);
    expect(providerObservations).toBe(0);
  } finally {
    if (priorHome === undefined) delete process.env.NORTH_CAVEMAN_HOME;
    else process.env.NORTH_CAVEMAN_HOME = priorHome;
    if (priorRev === undefined) delete process.env.NORTH_CAVEMAN_REV;
    else process.env.NORTH_CAVEMAN_REV = priorRev;
  }
});

test("Gaffer-derived frontier tier is hydrated before envelope admission", async () => {
  const policy = join(dir, "denied-frontier-policy.json");
  writeFileSync(policy, JSON.stringify({
    version: 1, mode: "preferential",
    targets: [{ id: "anthropic", provider: "anthropic" }, { id: "openai", provider: "openai" }],
    targetOrder: ["anthropic", "openai"],
    envelopes: { month: { runs: 10, frontierRuns: 0 } },
  }));
  const absentPolicy = process.env.NORTH_ROUTING_POLICY!;
  const originalAccounting = process.env.NORTH_ENVELOPE_ACCOUNTING;
  try {
    process.env.NORTH_ROUTING_POLICY = policy;
    process.env.NORTH_ENVELOPE_ACCOUNTING = join(dir, "denied-frontier-accounting.json");
    let providerCalls = 0;
    await expect((await import("./support/spawn")).spawn({
      prompt: "must not run", agentId: "gaffer-frontier-before-provider",
      routingMetadata: presetRequest("designer"),
      queryFn: () => { providerCalls++; return { async *[Symbol.asyncIterator]() {} } as any; },
    })).rejects.toThrow("frontierRuns 0/0");
    expect(providerCalls).toBe(0);
  } finally {
    process.env.NORTH_ROUTING_POLICY = absentPolicy;
    if (originalAccounting === undefined) delete process.env.NORTH_ENVELOPE_ACCOUNTING;
    else process.env.NORTH_ENVELOPE_ACCOUNTING = originalAccounting;
  }
});

test("public spawn and dispatch reject hermetic runtime fields before invoking them", async () => {
  let callbacks = 0;
  const { spawn: publicSpawn } = await import("../src/spawn");
  await expect(publicSpawn({
    prompt: "must reject structural injection",
    routingMetadata: presetRequest("integrator"),
    queryFn: () => {
      callbacks++;
      return { async *[Symbol.asyncIterator]() {} } as any;
    },
    deliveryRuntime: {
      reserve: () => { callbacks++; return {} as any; },
      load: () => { callbacks++; return {} as any; },
    },
  } as any)).rejects.toThrow("managed North spawn request has unknown field queryFn");

  const { dispatch: publicDispatch } = await import("../src/dispatch");
  await expect(publicDispatch("must-not-read-thread", {
    routingMetadata: presetRequest("integrator"),
    loadThreadFacts: () => {
      callbacks++;
      return [];
    },
    claimDriver: () => {
      callbacks++;
      return { release() {} } as any;
    },
  } as any)).rejects.toThrow("managed North dispatch request has unknown field loadThreadFacts");
  expect(callbacks).toBe(0);
});
