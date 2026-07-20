// Unit tests for the SDK worker authoring-guard bridge (authoring-guards.ts).
// Hermetic: no real guard scripts, no coordinator — synthetic fixture scripts written
// to a temp dir cover each rung of the guard-result protocol (deny-JSON, exit-2+stderr,
// exit-0 allow, timeout/missing unavailable, positive clock attestations, and
// the first-deny-wins chain.
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authoringHooksDir, runGuardScript, evaluateGuards, resolveManagedGuardChain,
} from "../src/authoring-guards";

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
const CLOCK_ATTEST = (verdict: "allow" | "not-applicable") => `#!/usr/bin/env bash
cat >/dev/null
[ "\${NORTH_CLOCK_GUARD_ATTEST:-}" = 1 ] || exit 0
printf '%s' '{"northClockGuard":"${verdict}"}'
`;
const CLOCK_UNKNOWN = `#!/usr/bin/env bash
cat >/dev/null
printf '%s' '{"northClockGuard":"maybe"}'
`;
const CLOCK_EXTRA = `#!/usr/bin/env bash
cat >/dev/null
printf '%s' '{"northClockGuard":"allow","extra":true}'
`;
const CLOCK_DUPLICATE = `#!/usr/bin/env bash
cat >/dev/null
printf '%s' '{"northClockGuard":"not-applicable","northClockGuard":"allow"}'
`;
const OVERSIZED_OUTPUT = `#!/usr/bin/env bash
cat >/dev/null
head -c 70000 /dev/zero
`;
const FORKED_HELD_PIPE = `#!/usr/bin/env bash
cat >/dev/null
(
  trap '' TERM
  while :; do sleep 1; done
) &
printf '%s' "$!" > "$DESCENDANT_PID_FILE"
sleep 5
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "guard-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HOOK = { tool_name: "Write", tool_input: { file_path: "/x" }, cwd: "/x", session_id: "s" };

describe("authoringHooksDir — portable default and exact override", () => {
  test("defaults to ~/.agents/hooks, never a provider checkout", () => {
    const home = join(dir, "hooks-home");
    const dflt = authoringHooksDir({ HOME: home });
    expect(dflt).toBe(join(home, ".agents", "hooks"));
    expect(dflt).not.toContain("nixos-config");
    expect(dflt).not.toContain(".claude");
    expect(dflt).not.toContain(".codex");
  });

  test("an exact AGENT_HOOKS_DIR override wins outright and is home-independent", () => {
    const override = join(dir, "portable-hooks");
    expect(authoringHooksDir({ HOME: join(dir, "hooks-home"), AGENT_HOOKS_DIR: override }))
      .toBe(override);
    expect(authoringHooksDir({ AGENT_HOOKS_DIR: override })).toBe(override);
    // A blank override is ignored and falls back to the portable default.
    expect(authoringHooksDir({ HOME: join(dir, "hooks-home"), AGENT_HOOKS_DIR: "  " }))
      .toBe(join(dir, "hooks-home", ".agents", "hooks"));
  });
});

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

  test("script that sleeps past the timeout -> unavailable", async () => {
    const d = await runGuardScript(script("slow.sh", SLEEP_PAST), HOOK, 200);
    expect(d.decision).toBe("unavailable");
  });

  test("missing script -> unavailable", async () => {
    const d = await runGuardScript(join(dir, "does-not-exist.sh"), HOOK);
    expect(d.decision).toBe("unavailable");
  });

  test("clock child alone receives attestation mode and preserves both positive verdicts", async () => {
    for (const verdict of ["allow", "not-applicable"] as const) {
      const d = await runGuardScript(
        script("north-clock-guard.sh", CLOCK_ATTEST(verdict)),
        HOOK,
      );
      expect(d).toEqual({ decision: "allow", northClockGuard: verdict });
    }
  });

  test("clock attestation is an exact one-key, duplicate-free JSON object", async () => {
    for (const [name, body] of [
      ["extra", CLOCK_EXTRA],
      ["duplicate", CLOCK_DUPLICATE],
      ["unknown", CLOCK_UNKNOWN],
    ] as const) {
      mkdirSync(join(dir, `exact-${name}`));
      const decision = await runGuardScript(
        script(`exact-${name}/north-clock-guard.sh`, body),
        HOOK,
      );
      expect(decision.decision).toBe("unavailable");
    }
  });

  test("guard output is bounded and fails unavailable", async () => {
    const decision = await runGuardScript(
      script("oversized.sh", OVERSIZED_OUTPUT),
      HOOK,
      1_000,
    );
    expect(decision).toEqual({
      decision: "unavailable",
      reason: "guard process output exceeded bounded size",
    });
  });

  test.skipIf(process.platform === "win32")(
    "timeout terminates a forked descendant that holds inherited pipes",
    async () => {
      const pidFile = join(dir, "held-pipe-descendant.pid");
      const decisionPromise = runGuardScript(
        script("held-pipe.sh", FORKED_HELD_PIPE),
        HOOK,
        100,
        { ...process.env, DESCENDANT_PID_FILE: pidFile },
      );
      const deadline = Date.now() + 1_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      expect(await decisionPromise).toEqual({
        decision: "unavailable",
        reason: "guard process timed out",
      });
      let alive = true;
      const goneBy = Date.now() + 1_000;
      while (alive && Date.now() < goneBy) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(10);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    },
  );

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

  test("the required clock guard accepts only an exact positive classification", async () => {
    for (const verdict of ["allow", "not-applicable"] as const) {
      const clock = script("north-clock-guard.sh", CLOCK_ATTEST(verdict));
      expect(await evaluateGuards(
        [clock], HOOK, 500, undefined, new Set([clock]),
      )).toEqual({ decision: "allow" });
    }
    for (const [name, body] of [
      ["empty", ALLOW_EXIT0],
      ["unknown", CLOCK_UNKNOWN],
      ["extra", CLOCK_EXTRA],
      ["duplicate", CLOCK_DUPLICATE],
      ["timeout", SLEEP_PAST],
    ] as const) {
      const clock = script("north-clock-guard.sh", body);
      expect(await evaluateGuards(
        [clock], HOOK, 100, undefined, new Set([clock]),
      )).toEqual({ decision: "deny", reason: "billable_clock_guard_unavailable" });
    }
    const missing = join(dir, "missing", "north-clock-guard.sh");
    expect(await evaluateGuards(
      [missing], HOOK, 100, undefined, new Set([missing]),
    )).toEqual({ decision: "deny", reason: "billable_clock_guard_unavailable" });

    const nonExecutableDir = join(dir, "nonexec");
    mkdirSync(nonExecutableDir);
    const nonExecutable = join(nonExecutableDir, "north-clock-guard.sh");
    writeFileSync(nonExecutable, CLOCK_ATTEST("allow"));
    chmodSync(nonExecutable, 0o600);
    expect(await evaluateGuards(
      [nonExecutable], HOOK, 100, undefined, new Set([nonExecutable]),
    )).toEqual({ decision: "deny", reason: "billable_clock_guard_unavailable" });
  });

  test("import-time chain construction never filters a missing clock guard", async () => {
    const missingDir = join(dir, "absent-at-import");
    const chain = resolveManagedGuardChain([
      "optional.sh", "north-clock-guard.sh",
    ], missingDir);
    const clock = join(missingDir, "north-clock-guard.sh");
    expect(chain).toEqual([clock]);
    expect(await evaluateGuards(
      chain, HOOK, 100, undefined, new Set([clock]),
    )).toEqual({ decision: "deny", reason: "billable_clock_guard_unavailable" });
  });
});
