// Programmatic parity for the interactive PreToolUse authoring guards.
// ============================================================================
// THE SMOKING GUN: harness.ts builds worker Options with a programmatic `hooks`
// object and NO settingSources, so the SDK never loads ~/.claude/settings.json —
// every north-dispatched worker ran with ZERO authoring guards. north-clock-guard
// never fired for a single worker edit, and nearly all edit volume IS worker
// edits: ~30% of billable client wall-time shipped unclocked in one week.
//
// We do NOT enable settingSources (it would drag the whole user-settings surface —
// permissions, MCP, statusline, plugins — into workers). Instead we RE-EXECUTE the
// same guard scripts the interactive matchers run, in-process, and translate their
// CLI-hook-protocol output into the SDK's HookJSONOutput. One source of truth for
// the guard LOGIC (the .sh scripts), two callers (Claude Code CLI + this harness).
//
// Guard-script result protocol (as the four wired guards actually emit):
//   - stdout JSON with hookSpecificOutput.permissionDecision === "deny"
//       -> DENY, reason = permissionDecisionReason
//       (code-upstream-guard, firn-guard, north-clock-guard)
//   - process exit code 2 -> DENY, reason = stderr
//       (tripwire-guard)
//   - anything else — exit 0, non-JSON stdout, timeout, spawn error, missing script
//       -> ALLOW (fail-open, matching interactive `additionalContext`/no-op semantics
//        and the guards' own fail-open-on-coordinator-down posture)
// ============================================================================
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Guard scripts live in nixos-config (the ~/.claude/* symlink source). Resolved
// absolute so the SDK stays portable — a machine without the checkout simply finds
// no scripts and every guard is skipped (fail-open).
export const HOOKS_DIR = resolve(
  process.env.HOME ?? "",
  "code/nixos-config/dotfiles/claude/hooks",
);

export type GuardDecision =
  | { decision: "deny"; reason: string }
  | { decision: "allow" };

const ALLOW: GuardDecision = { decision: "allow" };

// Resolve a guard by name to its absolute path IF it exists, else null. The harness
// existence-checks the guard lists at startup with this and drops the missing ones,
// so a portable SDK checkout never tries to run a script that isn't there.
export function resolveGuard(name: string): string | null {
  const p = resolve(HOOKS_DIR, name);
  return existsSync(p) ? p : null;
}

// Run one guard script: exec it, feed the hook input as JSON on stdin exactly as the
// CLI hook protocol delivers it ({tool_name, tool_input:{file_path|command,...},
// cwd, session_id, ...}), and interpret the result per the protocol above.
// Inherits the parent process env (default spawn behavior — NOT overridden) so the
// guards see FRAM_LOG, CLAUDE_NO_AUTHORING_HOOKS, and the rest of the killswitch env.
export function runGuardScript(
  scriptPath: string,
  hookInput: unknown,
  timeoutMs = 10000,
): Promise<GuardDecision> {
  return new Promise((resolveP) => {
    let child;
    try {
      // Execute the script directly so its shebang picks the interpreter. env is
      // inherited (no `env` option = default = parent env passthrough).
      child = spawn(scriptPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return resolveP(ALLOW); // spawn threw synchronously -> fail-open
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (d: GuardDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(d);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(ALLOW); // timeout -> fail-open
    }, timeoutMs);

    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("error", () => finish(ALLOW)); // ENOENT / EACCES / etc -> fail-open

    child.on("close", (code) => {
      // stdout-JSON deny (the majority of guards) takes precedence, then exit-2 deny.
      const jsonDeny = parseJsonDeny(stdout);
      if (jsonDeny !== null) return finish({ decision: "deny", reason: jsonDeny });
      if (code === 2) {
        const reason = stderr.trim() || "blocked by authoring guard (exit 2)";
        return finish({ decision: "deny", reason });
      }
      finish(ALLOW); // exit 0 / non-JSON stdout / unknown code -> allow
    });

    try {
      child.stdin?.end(JSON.stringify(hookInput));
    } catch {
      // stdin write failed — the close handler still fires and decides. No-op here.
    }
  });
}

// Extract a deny reason from a guard's stdout JSON, or null if it isn't a deny.
// A guard may print non-JSON (nothing, additionalContext-only, log noise) — all null.
function parseJsonDeny(stdout: string): string | null {
  const s = stdout.trim();
  if (!s) return null;
  let obj: any;
  try {
    obj = JSON.parse(s);
  } catch {
    return null; // non-JSON stdout -> no opinion
  }
  const hso = obj?.hookSpecificOutput;
  if (hso?.permissionDecision === "deny") {
    return typeof hso.permissionDecisionReason === "string"
      ? hso.permissionDecisionReason
      : "blocked by authoring guard";
  }
  return null;
}

// Run a chain of guards in order; FIRST DENY WINS and short-circuits the rest
// (mirrors the CLI, where any matcher-hook's deny stops the tool). All-allow -> allow.
export async function evaluateGuards(
  scriptPaths: string[],
  hookInput: unknown,
  timeoutMs = 10000,
): Promise<GuardDecision> {
  for (const p of scriptPaths) {
    const d = await runGuardScript(p, hookInput, timeoutMs);
    if (d.decision === "deny") return d;
  }
  return ALLOW;
}
