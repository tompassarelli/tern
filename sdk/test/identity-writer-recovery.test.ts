import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentTerminal } from "../src/identity";

test("commit-unknown retry reuses one logical operation and lifecycle holder", () => {
  const dir = mkdtempSync(join(tmpdir(), "north-identity-recovery-"));
  const fakeBb = join(dir, "bb");
  const calls = join(dir, "calls");
  const gate = join(dir, "first-call");
  const previousPath = process.env.PATH;
  const previousRedirect = process.env.NORTH_IDENTITY_TEST_REDIRECT;
  try {
    writeFileSync(fakeBb, `#!/usr/bin/env bash
printf '%s %s\n' "$6" "$7" >> "${calls}"
if [ ! -e "${gate}" ]; then
  : > "${gate}"
  sleep 1
fi
printf '{"ok":true,"result":{"status":"committed","operation_id":"%s","reason":"exact_replay"}}\n' "$7"
`);
    chmodSync(fakeBb, 0o755);
    process.env.PATH = `${dir}:${previousPath ?? ""}`;
    delete process.env.NORTH_IDENTITY_TEST_REDIRECT;

    const status = writeAgentTerminal(
      `lost-ack-${process.pid}`,
      {
        processOutcome: "died",
        deliveryOutcome: "blocked",
        deliveryReason: "provider_process_died",
      },
      50,
    );
    const attempts = readFileSync(calls, "utf8").trim().split("\n");
    expect(status).toBe("recorded");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
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
  const dir = mkdtempSync(join(tmpdir(), "north-identity-budget-"));
  const fakeBb = join(dir, "bb");
  const previousPath = process.env.PATH;
  const previousRedirect = process.env.NORTH_IDENTITY_TEST_REDIRECT;
  try {
    writeFileSync(fakeBb, "#!/usr/bin/env bash\nsleep 2\n");
    chmodSync(fakeBb, 0o755);
    process.env.PATH = `${dir}:${previousPath ?? ""}`;
    delete process.env.NORTH_IDENTITY_TEST_REDIRECT;

    const budgetMs = 200;
    const startedAt = performance.now();
    const status = writeAgentTerminal(
      `absolute-budget-${process.pid}`,
      {
        processOutcome: "died",
        deliveryOutcome: "blocked",
        deliveryReason: "provider_process_died",
      },
      budgetMs,
    );
    const elapsedMs = performance.now() - startedAt;

    expect(status).toBe("indeterminate");
    expect(elapsedMs).toBeGreaterThanOrEqual(budgetMs * 0.75);
    // Two independent 200ms attempts would exceed 400ms. Allow ordinary CI
    // process-reap jitter while proving both attempts share one deadline.
    expect(elapsedMs).toBeLessThan(budgetMs * 1.625);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousRedirect === undefined) delete process.env.NORTH_IDENTITY_TEST_REDIRECT;
    else process.env.NORTH_IDENTITY_TEST_REDIRECT = previousRedirect;
    rmSync(dir, { recursive: true, force: true });
  }
});
