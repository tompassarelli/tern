// Bounded auto-retry for retry-safe provider-process deaths (thread 019f8f81,
// 2026-07-23 gen-1018 cluster: 4x openai_provider_execution_failed, zero retry,
// all terminal). Hermetic (no live coordinator, no network): a fake `north` on
// PATH/NORTH_BIN logs every write so we can assert the fresh-run retry
// happened, provenance facts were recorded, and the eligibility gate (worker +
// read-only capabilities + provider-process death, never orchestrator, never
// writable) is honored.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { presetRequest } from "./routing-fixtures";

let dir: string;
let log: string;

function readySubscription() {
  return Object.assign(() => {}, {
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
    detail: "spawn retry fixture",
    pins: [{ kind: "provider" as const, value: provider }],
  };
}

const MANAGED_ENV = [
  "PATH", "NORTH_BIN", "NORTH_PEER_BB", "NORTH_IDENTITY_TEST_REDIRECT", "NORTH_PORT", "NORTH_STREAM_DIR",
  "AGENT_LAWS", "AGENT_PRAXIS", "AGENT_ID", "NORTH_AGENT_ID", "AGENT_COORDINATOR", "AGENT_TOPOLOGY",
  "AGENT_MODEL", "AGENT_ROLE", "AGENT_EFFORT", "AGENT_TARGET", "AGENT_WORKTREE",
  "AGENT_PROVIDER", "AGENT_IDENTITY_ROLE", "AGENT_TASK_GRADE", "AGENT_DOMAIN_REQUIREMENTS",
  "AGENT_COMPOSITION", "AGENT_POSTURE", "AGENT_REASONING",
  "NORTH_STRUGGLE_POLICY_EXPECTED", "STRUGGLE_ERROR_STREAK",
  "NORTH_ROUTING_POLICY", "NORTH_ENVELOPE_ACCOUNTING", "NORTH_AUTH_STATE_CACHE",
  "NORTH_PROVIDER_OBSERVATIONS", "NORTH_ALLOCATION_MODE", "NORTH_PROVIDER_ORDER",
  "NORTH_PROVIDER_WEIGHTS", "NORTH_RESERVED_FRONTIER_PROVIDER",
  "NORTH_ANTHROPIC_ENTITLEMENT_PRESSURE", "NORTH_OPENAI_ENTITLEMENT_PRESSURE",
] as const;
const origEnv: Record<string, string | undefined> = {};
for (const k of MANAGED_ENV) origEnv[k] = process.env[k];

const POISON_COORDINATOR = `poison-coordinator-retry-${process.pid}`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "north-retry-"));
  log = join(dir, "retry.log");
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
  process.env.NORTH_PORT = "59999";
  process.env.NORTH_STREAM_DIR = dir;
  process.env.AGENT_LAWS = "off";
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
  delete process.env.AGENT_TOPOLOGY;
  delete process.env.AGENT_ID;
  delete process.env.NORTH_AGENT_ID;
  delete process.env.AGENT_MODEL;
  delete process.env.AGENT_ROLE;
  delete process.env.AGENT_EFFORT;
  delete process.env.AGENT_TARGET;
  delete process.env.AGENT_WORKTREE;
  delete process.env.AGENT_PROVIDER;
  delete process.env.AGENT_IDENTITY_ROLE;
  delete process.env.AGENT_TASK_GRADE;
  delete process.env.AGENT_DOMAIN_REQUIREMENTS;
  delete process.env.AGENT_COMPOSITION;
  delete process.env.AGENT_POSTURE;
  delete process.env.AGENT_REASONING;
  delete process.env.NORTH_STRUGGLE_POLICY_EXPECTED;
  delete process.env.STRUGGLE_ERROR_STREAK;
  process.env.AGENT_COORDINATOR = POISON_COORDINATOR;
});

afterAll(() => {
  for (const k of MANAGED_ENV) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

let stderrLines: string[] = [];
let originalConsoleError: typeof console.error;

beforeEach(() => {
  writeFileSync(log, "");
  stderrLines = [];
  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    stderrLines.push(args.map((a) => String(a)).join(" "));
  };
});

afterAll(() => {
  if (originalConsoleError) console.error = originalConsoleError;
});

function diesOnceThenSucceeds(errorMessage: string, calls: { n: number }) {
  return () => {
    calls.n++;
    if (calls.n === 1) {
      return (async function* () {
        throw new Error(errorMessage);
      })();
    }
    return (async function* () {
      yield { type: "result", subtype: "success", result: "recovered on retry", num_turns: 1 };
    })();
  };
}

function alwaysDies(errorMessage: string, calls: { n: number }) {
  return () => {
    calls.n++;
    return (async function* () {
      throw new Error(errorMessage);
    })();
  };
}

test("worker + read-only capabilities + provider-process death -> exactly one retry, fresh run, provenance recorded", async () => {
  const { spawn } = await import("./support/spawn");
  const calls = { n: 0 };

  const result = await spawn({
    prompt: "verify a completed gate",
    agentId: "test-retry-eligible",
    provider: "anthropic",
    pinEvidence: pinEvidence("anthropic"),
    routingMetadata: presetRequest("verifier"), // worker + shell.readonly, no filesystem.write/shell
    feedSubscriber: () => readySubscription(),
    queryFn: diesOnceThenSucceeds("openai_provider_execution_failed", calls),
  });

  expect(result).toBe("recovered on retry");
  expect(calls.n).toBe(2); // exactly one retry, not a loop

  const logged = readFileSync(log, "utf8");
  // The first (dead) run's death is announced (agent_death), never overwritten.
  expect(logged).toContain("agent_death");
  expect(logged).toContain("openai_provider_execution_failed");
  // Bounded-retry log line names the retry-safe classification.
  expect(stderrLines.some((l) => l.includes("retrying once as a fresh run"))).toBe(true);
  // Retry provenance facts landed on the retried @run.
  expect(logged).toMatch(/tell run:\S+ retry_of_run @run:\S+/);
  expect(logged).toMatch(/tell run:\S+ retry_attempt 1/);
  // Terminal identities are immutable: the retry must NOT reuse the original
  // agent id — it mints a fresh one (identity.ts writeAgentTerminal rejects a
  // second publish against an already terminal-committed @agent: subject).
  // The dead original keeps its own honest (died) terminal, never rewritten...
  expect(logged).toContain("tell agent:test-retry-eligible outcome died");
  // ...while the fresh retry identity carries retry_of_agent provenance back
  // to the original (bare id, no @) and its own terminal reflects recovery.
  expect(logged).toMatch(/tell agent:(?!test-retry-eligible\b)\S+ retry_of_agent test-retry-eligible/);
  expect(logged).toMatch(/tell agent:(?!test-retry-eligible\b)\S+ outcome ran/);
});

test("orchestrator topology never retries a provider-process death, even with read-only capabilities", async () => {
  const { spawn } = await import("./support/spawn");
  const calls = { n: 0 };

  const result = await spawn({
    prompt: "coordinate the gate",
    agentId: "test-retry-orchestrator",
    provider: "anthropic",
    pinEvidence: pinEvidence("anthropic"),
    routingMetadata: presetRequest("director"), // orchestrator, read-only capabilities
    feedSubscriber: () => readySubscription(),
    queryFn: alwaysDies("openai_provider_execution_failed", calls),
  });

  expect(typeof result).toBe("string"); // supervision, not fail-fast
  expect(calls.n).toBe(1); // no retry — child obligations make retry semantics wrong
  const logged = readFileSync(log, "utf8");
  expect(stderrLines.some((l) => l.includes("retrying once as a fresh run"))).toBe(false);
  expect(logged).toContain("tell agent:test-retry-orchestrator outcome died");
});

test("a writable worker (filesystem.write/shell) never retries a provider-process death", async () => {
  const { spawn } = await import("./support/spawn");
  const calls = { n: 0 };

  const result = await spawn({
    prompt: "implement the change",
    agentId: "test-retry-writable",
    provider: "anthropic",
    pinEvidence: pinEvidence("anthropic"),
    routingMetadata: presetRequest("implementer"), // worker + filesystem.write + shell
    feedSubscriber: () => readySubscription(),
    queryFn: alwaysDies("openai_provider_execution_failed", calls),
  });

  expect(typeof result).toBe("string");
  expect(calls.n).toBe(1); // a writable lane may have mutated; never re-run it
  const logged = readFileSync(log, "utf8");
  expect(stderrLines.some((l) => l.includes("retrying once as a fresh run"))).toBe(false);
  expect(logged).toContain("tell agent:test-retry-writable outcome died");
});

test("a retry that also dies records BOTH runs; the original death is never overwritten", async () => {
  const { spawn } = await import("./support/spawn");
  const calls = { n: 0 };

  const result = await spawn({
    prompt: "verify a flaky gate",
    agentId: "test-retry-still-dies",
    provider: "anthropic",
    pinEvidence: pinEvidence("anthropic"),
    routingMetadata: presetRequest("verifier"),
    feedSubscriber: () => readySubscription(),
    queryFn: alwaysDies("openai_provider_execution_failed", calls),
  });

  expect(typeof result).toBe("string");
  expect(calls.n).toBe(2); // one bounded retry attempted, then stops (never a loop)
  const logged = readFileSync(log, "utf8");
  expect(stderrLines.some((l) => l.includes("retrying once as a fresh run"))).toBe(true);
  // Two distinct @run subjects each carry their own death — count "kind run" writes.
  const runKindWrites = (logged.match(/tell run:\S+ kind run/g) ?? []).length;
  expect(runKindWrites).toBe(2);
  expect(logged).toMatch(/tell run:\S+ retry_of_run @run:\S+/);
  // Original terminal-committed identity keeps its own honest died terminal...
  expect(logged).toContain("tell agent:test-retry-still-dies outcome died");
  // ...and the retry minted a DISTINCT fresh identity (never reusing the
  // terminal-committed original) that also honestly reports died, linked back
  // by retry_of_agent provenance.
  expect(logged).toMatch(/tell agent:(?!test-retry-still-dies\b)\S+ retry_of_agent test-retry-still-dies/);
  expect(logged).toMatch(/tell agent:(?!test-retry-still-dies\b)\S+ outcome died/);
});

test("eligibility gate: only outcome=died (provider-process-level) + worker + read-only capabilities retries", async () => {
  const { eligibleForProviderProcessDeathRetry } = await import("../src/spawn");
  const readOnly = ["filesystem.read", "filesystem.search", "shell.readonly"] as const;
  const writable = ["filesystem.read", "filesystem.search", "filesystem.write", "shell"] as const;

  // The retry-safe case: exactly this combination is eligible.
  expect(eligibleForProviderProcessDeathRetry("died", "worker", readOnly)).toBe(true);

  // Every non-death outcome (blocked_preflight, stalled, resource_envelope_exceeded,
  // capped, max_turns, provider_error, ran_empty, ...) is never retried by this
  // policy, even with worker + read-only capabilities.
  for (const outcome of [
    "blocked_preflight", "blocked_spend_guard", "stalled", "resource_envelope_exceeded",
    "capped", "max_turns", "provider_error", "ran_empty", "ran",
  ]) {
    expect(eligibleForProviderProcessDeathRetry(outcome, "worker", readOnly)).toBe(false);
  }

  // Orchestrator topology never retries, even on a provider-process death.
  expect(eligibleForProviderProcessDeathRetry("died", "orchestrator", readOnly)).toBe(false);
  // A writable capability surface never retries, even on a provider-process death.
  expect(eligibleForProviderProcessDeathRetry("died", "worker", writable)).toBe(false);
  // Undefined topology (ad-hoc/unstaffed) never retries.
  expect(eligibleForProviderProcessDeathRetry("died", undefined, readOnly)).toBe(false);
});
