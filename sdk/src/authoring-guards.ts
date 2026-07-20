// Programmatic parity for the interactive PreToolUse authoring guards.
// ============================================================================
// THE SMOKING GUN: harness.ts builds worker Options with a programmatic `hooks`
// object and settingSources:[], so the SDK never loads ~/.claude/settings.json —
// every north-dispatched worker ran with ZERO authoring guards. north-clock-guard
// never fired for a single worker edit, and nearly all edit volume IS worker
// edits: ~30% of billable client wall-time shipped unclocked in one week.
//
// We deliberately keep settingSources empty (enabling one would drag the user-settings surface —
// permissions, MCP, statusline, plugins — into workers). Instead we RE-EXECUTE the
// same guard scripts the interactive matchers run, in-process, and translate their
// CLI-hook-protocol output into the SDK's HookJSONOutput. One source of truth for
// the guard LOGIC (the .sh scripts), two callers (Claude Code CLI + this harness).
//
// Guard-script result protocol:
//   - stdout JSON with hookSpecificOutput.permissionDecision === "deny"
//       -> DENY, reason = permissionDecisionReason
//       (code-upstream-guard, firn-guard, north-clock-guard)
//   - process exit code 2 -> DENY, reason = stderr
//       (tripwire-guard)
//   - with NORTH_CLOCK_GUARD_ATTEST=1, north-clock-guard must positively emit:
//       {"northClockGuard":"allow"}          matching live clock proven
//       {"northClockGuard":"not-applicable"} valid envelope proven nonbillable
//     Missing/empty/unknown/error/timeout is unavailable and the harness denies.
//   - other guards remain advisory on unavailable; their explicit denials still win.
// ============================================================================
import {
  spawn, type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseStrictJson } from "./strict-json";

// Guard scripts default to the portable ~/.agents/hooks, overridable by an exact
// AGENT_HOOKS_DIR. No provider checkout fallback: a host without the directory
// simply finds no scripts and every advisory guard is skipped (fail-open); the
// canonical clock guard's absence denies unavailable instead.
export function authoringHooksDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_HOOKS_DIR?.trim();
  if (override) return resolve(override);
  return resolve(env.HOME ?? "", ".agents", "hooks");
}

export const HOOKS_DIR = authoringHooksDir();

export type GuardDecision =
  | { decision: "deny"; reason: string }
  | {
      decision: "allow";
      northClockGuard?: "allow" | "not-applicable";
    }
  | { decision: "unavailable"; reason: string };

const ALLOW: GuardDecision = { decision: "allow" };
export const BILLABLE_CLOCK_GUARD_UNAVAILABLE = "billable_clock_guard_unavailable";
const GUARD_OUTPUT_MAX_BYTES = 64 * 1024;
const GUARD_TERM_GRACE_MS = 100;
const GUARD_KILL_GRACE_MS = 100;
const GUARD_POSIX_PROCESS_GROUP = process.platform !== "win32";

function signalGuardProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (GUARD_POSIX_PROCESS_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already be gone; fall back to the direct child.
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

export function authoringGuardsOff(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.AGENT_NO_AUTHORING_HOOKS ?? env.CLAUDE_NO_AUTHORING_HOOKS ?? "";
  if (explicit === "0" || explicit === "false") return false;
  if (explicit) return true;
  const statePath = env.NORTH_HARNESS_STATE
    ?? env.AUTHORING_KILLSWITCH_STATE
    ?? (env.HOME ? resolve(env.HOME, ".local/state/north/harness.conf") : undefined);
  if (!statePath) return false;
  try {
    const values = readFileSync(statePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("guards="));
    return values.at(-1)?.slice("guards=".length) === "off";
  } catch {
    return false;
  }
}

// Resolve a guard by name to its absolute path IF it exists, else null. The harness
// existence-checks the guard lists at startup with this and drops the missing ones,
// so a portable SDK checkout never tries to run a script that isn't there.
export function resolveGuard(name: string): string | null {
  const p = resolve(HOOKS_DIR, name);
  return existsSync(p) ? p : null;
}

/**
 * Resolve one managed guard chain while retaining the canonical clock path
 * unconditionally. Optional advisory guards may be absent on portable hosts;
 * the clock guard never disappears at import time—spawn failure is the stable
 * unavailable denial required by the billing invariant.
 */
export function resolveManagedGuardChain(
  names: readonly string[],
  hooksDir = HOOKS_DIR,
): string[] {
  return names.flatMap((name) => {
    const path = resolve(hooksDir, name);
    return name === "north-clock-guard.sh" || existsSync(path) ? [path] : [];
  });
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
  env?: NodeJS.ProcessEnv,
): Promise<GuardDecision> {
  return new Promise((resolveP) => {
    let child: ChildProcessWithoutNullStreams;
    const clockAttestation = scriptPath.endsWith("/north-clock-guard.sh");
    try {
      // Execute the script directly so its shebang picks the interpreter. Callers
      // may add per-lane topology without mutating shared process.env; otherwise
      // Node inherits the parent environment unchanged.
      const childEnv = clockAttestation
        ? { ...(env ?? process.env), NORTH_CLOCK_GUARD_ATTEST: "1" }
        : env;
      child = spawn(scriptPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: GUARD_POSIX_PROCESS_GROUP,
        ...(childEnv ? { env: childEnv } : {}),
      });
    } catch {
      return resolveP({ decision: "unavailable", reason: "guard process spawn failed" });
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminating = false;
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (d: GuardDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      resolveP(d);
    };
    const terminate = (decision: GuardDecision) => {
      if (terminating || settled) return;
      terminating = true;
      clearTimeout(timer);
      signalGuardProcessTree(child, "SIGTERM");
      termTimer = setTimeout(() => {
        signalGuardProcessTree(child, "SIGKILL");
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        killTimer = setTimeout(() => finish(decision), GUARD_KILL_GRACE_MS);
      }, GUARD_TERM_GRACE_MS);
    };

    const timer = setTimeout(() => {
      terminate({ decision: "unavailable", reason: "guard process timed out" });
    }, timeoutMs);

    const capture = (chunks: Buffer[]) => (chunk: Buffer | string) => {
      if (settled || terminating) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (!Number.isSafeInteger(outputBytes) || outputBytes > GUARD_OUTPUT_MAX_BYTES) {
        terminate({
          decision: "unavailable",
          reason: "guard process output exceeded bounded size",
        });
        return;
      }
      chunks.push(bytes);
    };
    child.stdout.on("data", capture(stdoutChunks));
    child.stderr.on("data", capture(stderrChunks));
    child.on("error", () => {
      if (terminating) return;
      finish({ decision: "unavailable", reason: "guard process unavailable" });
    });

    child.on("close", (code) => {
      if (terminating) return;
      let stdout: string;
      let stderr: string;
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        stdout = decoder.decode(Buffer.concat(stdoutChunks));
        stderr = decoder.decode(Buffer.concat(stderrChunks));
      } catch {
        return finish({
          decision: "unavailable",
          reason: "guard process emitted invalid UTF-8",
        });
      }
      // stdout-JSON deny (the majority of guards) takes precedence, then exit-2 deny.
      const jsonDecision = parseJsonDecision(stdout, clockAttestation);
      if (jsonDecision?.decision === "deny") return finish(jsonDecision);
      if (code === 2) {
        const reason = stderr.trim() || "blocked by authoring guard (exit 2)";
        return finish({ decision: "deny", reason });
      }
      if (code !== 0)
        return finish({ decision: "unavailable", reason: `guard process exited ${code}` });
      if (clockAttestation
          && (jsonDecision?.decision !== "allow"
              || jsonDecision.northClockGuard === undefined))
        return finish({
          decision: "unavailable",
          reason: "clock guard attestation was not exact",
        });
      finish(jsonDecision ?? ALLOW);
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
function parseJsonDecision(
  stdout: string,
  clockAttestation: boolean,
): GuardDecision | null {
  const s = stdout.trim();
  if (!s) return null;
  let obj: any;
  try {
    obj = parseStrictJson(s, "authoring guard output", {
      maxBytes: GUARD_OUTPUT_MAX_BYTES,
      maxDepth: 32,
      maxNodes: 4_096,
    });
  } catch {
    return null; // non-JSON stdout -> no opinion
  }
  const hso = obj?.hookSpecificOutput;
  if (hso?.permissionDecision === "deny") {
    return {
      decision: "deny",
      reason: typeof hso.permissionDecisionReason === "string"
        ? hso.permissionDecisionReason
        : "blocked by authoring guard",
    };
  }
  const exactClockEnvelope = clockAttestation
    && typeof obj === "object"
    && obj !== null
    && !Array.isArray(obj)
    && Object.keys(obj).length === 1
    && Object.keys(obj)[0] === "northClockGuard";
  return exactClockEnvelope
      && (obj.northClockGuard === "allow" || obj.northClockGuard === "not-applicable")
    ? { decision: "allow", northClockGuard: obj.northClockGuard }
    : null;
}

// Run a chain of guards in order; FIRST DENY WINS and short-circuits the rest
// (mirrors the CLI, where any matcher-hook's deny stops the tool). All-allow -> allow.
export async function evaluateGuards(
  scriptPaths: string[],
  hookInput: unknown,
  timeoutMs = 10000,
  env?: NodeJS.ProcessEnv,
  requiredAttestationPaths: ReadonlySet<string> = new Set(),
): Promise<GuardDecision> {
  for (const p of scriptPaths) {
    const d = await runGuardScript(p, hookInput, timeoutMs, env);
    if (d.decision === "deny") return d;
    if (requiredAttestationPaths.has(p)
        && (d.decision !== "allow" || d.northClockGuard === undefined)) {
      return { decision: "deny", reason: BILLABLE_CLOCK_GUARD_UNAVAILABLE };
    }
  }
  return ALLOW;
}
