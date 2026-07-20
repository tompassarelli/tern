import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ManagedWriterRuntime,
  writeAgentTerminal,
} from "../src/identity";

const blockedTerminal = {
  processOutcome: "died",
  deliveryOutcome: "blocked",
  deliveryReason: "provider_process_died",
} as const;

test("commit-unknown retry reuses one logical operation and lifecycle holder", () => {
  let nowMs = 0;
  const attempts: Array<{ args: string[]; timeoutMs: number }> = [];
  const runtime: ManagedWriterRuntime = {
    now: () => nowMs,
    execute: (args, timeoutMs) => {
      attempts.push({ args: [...args], timeoutMs });
      if (attempts.length === 1) {
        nowMs += 40;
        throw new Error("transport closed after durable commit");
      }
      nowMs += 10;
      return JSON.stringify({
        ok: true,
        result: {
          status: "committed",
          operation_id: args[6],
          reason: "exact_replay",
        },
      });
    },
  };

  const status = writeAgentTerminal(
    `lost-ack-${process.pid}`,
    blockedTerminal,
    200,
    runtime,
  );

  expect(status).toBe("recorded");
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.args).toEqual(attempts[1]?.args);
  expect(attempts.map(({ timeoutMs }) => timeoutMs)).toEqual([160, 160]);
  expect(attempts[0]?.args[5]).toMatch(
    /^managed-agent-writer:[0-9a-f-]{36}$/,
  );
  expect(attempts[0]?.args[6]).toMatch(/^[0-9a-f-]{36}$/);
});

test("real writer subprocess parses one typed acknowledgement under a measured startup bar", () => {
  const dir = mkdtempSync(join(tmpdir(), "north-identity-recovery-"));
  const fakeBb = join(dir, "bb");
  const calls = join(dir, "calls");
  const previousPath = process.env.PATH;
  const previousRedirect = process.env.NORTH_IDENTITY_TEST_REDIRECT;
  try {
    writeFileSync(fakeBb, `#!/usr/bin/env bash
if [ "\${1-}" = "--startup-probe" ]; then
  exit 0
fi
printf '%s %s\n' "$6" "$7" >> "${calls}"
printf '{"ok":true,"result":{"status":"committed","operation_id":"%s","reason":"exact_replay"}}\n' "$7"
`);
    chmodSync(fakeBb, 0o755);
    process.env.PATH = `${dir}:${previousPath ?? ""}`;
    delete process.env.NORTH_IDENTITY_TEST_REDIRECT;

    const startupSamples = Array.from({ length: 5 }, () => {
      const startedAt = performance.now();
      execFileSync(fakeBb, ["--startup-probe"], { stdio: "ignore" });
      return performance.now() - startedAt;
    });
    const observedStartupMs = Math.max(...startupSamples);
    // This is process-invocation coverage, not the absolute-budget assertion.
    // Derive a generous scheduler/load bar from a prewarmed executable; the
    // deterministic runtime tests below own exact deadline arithmetic.
    const stabilityBudgetMs = Math.ceil(Math.max(25, observedStartupMs) * 40);
    const status = writeAgentTerminal(
      `real-process-${process.pid}`,
      blockedTerminal,
      stabilityBudgetMs,
    );
    const attempts = readFileSync(calls, "utf8").trim().split("\n");
    expect(status).toBe("recorded");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatch(
      /^managed-agent-writer:[0-9a-f-]{36} [0-9a-f-]{36}$/,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousRedirect === undefined) delete process.env.NORTH_IDENTITY_TEST_REDIRECT;
    else process.env.NORTH_IDENTITY_TEST_REDIRECT = previousRedirect;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit-unknown classification stays inside one absolute writer budget", () => {
  const budgetMs = 200;
  let nowMs = 0;
  const attemptBudgets: number[] = [];
  const runtime: ManagedWriterRuntime = {
    now: () => nowMs,
    execute: (_args, timeoutMs) => {
      attemptBudgets.push(timeoutMs);
      nowMs += timeoutMs;
      throw new Error("simulated timeout at the exact attempt deadline");
    },
  };

  const status = writeAgentTerminal(
    `absolute-budget-${process.pid}`,
    blockedTerminal,
    budgetMs,
    runtime,
  );

  expect(status).toBe("indeterminate");
  expect(attemptBudgets).toEqual([160, 40]);
  expect(nowMs).toBe(budgetMs);
});
