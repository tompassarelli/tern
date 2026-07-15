// Unit tests for the SDK worker authoring-guard bridge (authoring-guards.ts).
// Hermetic: no real guard scripts, no coordinator — synthetic fixture scripts written
// to a temp dir cover each rung of the guard-result protocol (deny-JSON, exit-2+stderr,
// exit-0 allow, timeout allow, missing-script allow) plus the first-deny-wins chain.
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGuardScript, evaluateGuards } from "../src/authoring-guards";

let dir: string;
const script = (name: string, body: string): string => {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
};

// Fixtures modeled on the real guards' output shapes.
const DENY_JSON = `#!/usr/bin/env bash
cat >/dev/null   # drain the hook JSON on stdin, exactly as the real guards do
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"clock in first: north clock start <id>"}}'
exit 0
`;
const EXIT2_STDERR = `#!/usr/bin/env bash
cat >/dev/null
printf 'tripwire: recursive delete outside safe roots\\n' >&2
exit 2
`;
const ALLOW_EXIT0 = `#!/usr/bin/env bash
cat >/dev/null
exit 0
`;
const ALLOW_CONTEXT = `#!/usr/bin/env bash
cat >/dev/null
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"heads up"}}'
exit 0
`;
const SLEEP_PAST = `#!/usr/bin/env bash
cat >/dev/null
sleep 5
exit 0
`;
const ECHO_STDIN = `#!/usr/bin/env bash
cat > "$STDIN_CAP"   # capture what the harness fed on stdin
exit 0
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "guard-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HOOK = { tool_name: "Write", tool_input: { file_path: "/x" }, cwd: "/x", session_id: "s" };

describe("runGuardScript — result protocol", () => {
  test("deny JSON on stdout -> deny surfaced with its reason", async () => {
    const d = await runGuardScript(script("deny.sh", DENY_JSON), HOOK);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toContain("clock in first");
  });

  test("exit 2 + stderr -> deny with stderr as reason", async () => {
    const d = await runGuardScript(script("exit2.sh", EXIT2_STDERR), HOOK);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toContain("recursive delete");
  });

  test("exit 0, empty stdout -> allow", async () => {
    const d = await runGuardScript(script("allow.sh", ALLOW_EXIT0), HOOK);
    expect(d.decision).toBe("allow");
  });

  test("JSON without a deny decision (additionalContext only) -> allow", async () => {
    const d = await runGuardScript(script("ctx.sh", ALLOW_CONTEXT), HOOK);
    expect(d.decision).toBe("allow");
  });

  test("script that sleeps past the timeout -> allow (fail-open)", async () => {
    const d = await runGuardScript(script("slow.sh", SLEEP_PAST), HOOK, 200);
    expect(d.decision).toBe("allow");
  });

  test("missing script -> allow (fail-open)", async () => {
    const d = await runGuardScript(join(dir, "does-not-exist.sh"), HOOK);
    expect(d.decision).toBe("allow");
  });

  test("hook input is delivered on stdin as JSON the guards can parse", async () => {
    const cap = join(dir, "stdin.json");
    process.env.STDIN_CAP = cap;
    await runGuardScript(script("echo.sh", ECHO_STDIN), HOOK);
    delete process.env.STDIN_CAP;
    const seen = JSON.parse(require("node:fs").readFileSync(cap, "utf8"));
    expect(seen.tool_name).toBe("Write");
    expect(seen.tool_input.file_path).toBe("/x");
  });
});

describe("evaluateGuards — chain, first deny wins", () => {
  test("all allow -> allow", async () => {
    const chain = [script("a1.sh", ALLOW_EXIT0), script("a2.sh", ALLOW_EXIT0)];
    expect((await evaluateGuards(chain, HOOK)).decision).toBe("allow");
  });

  test("a middle deny short-circuits and wins", async () => {
    const chain = [
      script("c1.sh", ALLOW_EXIT0),
      script("c2.sh", DENY_JSON),
      script("c3.sh", EXIT2_STDERR), // must NOT run — first deny already won
    ];
    const d = await evaluateGuards(chain, HOOK);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toContain("clock in first");
  });

  test("empty chain -> allow", async () => {
    expect((await evaluateGuards([], HOOK)).decision).toBe("allow");
  });
});
