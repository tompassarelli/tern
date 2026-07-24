import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { providerPreacceptError } from "./types";

export const CODEX_MANAGED_REQUIREMENTS = "/etc/codex/requirements.toml";
export const CODEX_MANAGED_HOOKS_DIR = "/etc/codex/hooks";
const MAX_REQUIREMENTS_BYTES = 128 * 1024;

interface ManagedCommandHook {
  type: "command";
  command: string;
  timeout: number;
}

interface ManagedMatcher {
  matcher?: string;
  hooks: ManagedCommandHook[];
}

const command = (
  name: string,
  timeout = 10,
  managedDir = CODEX_MANAGED_HOOKS_DIR,
  interpreter: "bash" | "node" = "bash",
): ManagedCommandHook => ({
  type: "command",
  command: [
    resolve(managedDir, "runtime/env"),
    "-u", "BASH_ENV",
    "-u", "ENV",
    resolve(managedDir, `runtime/${interpreter}`),
    resolve(managedDir, name),
  ].join(" "),
  timeout,
});

/**
 * Exact provider-native lifecycle/authoring/activity boundary for Codex.
 *
 * The `*-codex` lifecycle wrappers are identity-aware. With AGENT_ID present
 * (a managed North lane), they are graph/identity no-ops because the harness
 * owns registration, activity renewal, delegation settlement, and terminal
 * publication. Without AGENT_ID (a native Codex session), they delegate to the
 * pinned native lifecycle scripts with provider=openai. Reusing the native
 * scripts directly here would mint a duplicate session-* identity for one lane.
 */
export function expectedManagedCodexHooks(
  managedDir = CODEX_MANAGED_HOOKS_DIR,
): Record<
  "SessionStart" | "SubagentStart" | "PreToolUse" | "PostToolUse" | "Stop",
  ManagedMatcher[]
> {
  return {
    SessionStart: [{
      hooks: [
        command("beagle-session-start.sh", 30, managedDir),
        command("north-on-spawn-codex", 15, managedDir),
      ],
    }],
    SubagentStart: [{
      hooks: [command("north-on-spawn-codex", 15, managedDir)],
    }],
    PreToolUse: [
      {
        matcher: "^(Agent|Task|Workflow)$",
        hooks: [command("agent-spawn-guard.sh", 10, managedDir)],
      },
      {
        matcher: "^(Edit|Write|MultiEdit|apply_patch)$",
        hooks: [
          command("code-upstream-guard.sh", 10, managedDir),
          command("firn-guard.sh", 10, managedDir),
          command("north-clock-guard-codex", 10, managedDir),
        ],
      },
      {
        matcher: "^Bash$",
        hooks: [
          command("agent-spawn-guard.sh", 10, managedDir),
          command("tripwire-guard.sh", 10, managedDir),
          command("firn-guard.sh", 10, managedDir),
          command("north-clock-guard-codex", 10, managedDir),
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "^Bash$",
        hooks: [
          command("logcompress-hook.js", 10, managedDir, "node"),
          command("north-on-tooluse-codex", 10, managedDir),
        ],
      },
      {
        matcher: "^(Edit|Write|MultiEdit|apply_patch)$",
        hooks: [
          command("racket-build-guard.sh", 15, managedDir),
          command("north-on-tooluse-codex", 10, managedDir),
        ],
      },
      {
        matcher: "^(mcp__north__spawn|mcp__north__dispatch|Task|Agent)$",
        hooks: [command("north-mark-delegated-codex", 10, managedDir)],
      },
    ],
    Stop: [{
      hooks: [command("north-on-stop-codex", 10, managedDir)],
    }],
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value as object).sort()
      .map((key) => [key, canonical((value as any)[key])]));
  return value;
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(canonical(value)) !== JSON.stringify(canonical(expected)))
    throw new Error(`${label} does not match North's exact managed Codex contract`);
}

/**
 * Validate the requirements policy itself, not user/session config. Codex
 * intentionally ignores allow_managed_hooks_only outside requirements layers.
 */
export function validateManagedCodexRequirements(
  source: string,
  managedDir = CODEX_MANAGED_HOOKS_DIR,
): void {
  let parsed: any;
  try { parsed = Bun.TOML.parse(source); }
  catch (cause) { throw new Error("managed Codex requirements are invalid TOML", { cause }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("managed Codex requirements must be a TOML document");
  exact(
    Object.keys(parsed).sort(),
    [
      "allow_managed_hooks_only", "allow_remote_control", "features", "hooks",
      "managed_hook_failure_mode",
    ].sort(),
    "managed Codex requirements root surface",
  );
  if (parsed.allow_managed_hooks_only !== true)
    throw new Error("managed Codex requirements must enforce allow_managed_hooks_only=true");
  if (parsed.allow_remote_control !== false)
    throw new Error("managed Codex requirements must enforce allow_remote_control=false");
  if (parsed.managed_hook_failure_mode !== "block")
    throw new Error('managed Codex requirements must enforce managed_hook_failure_mode="block"');
  exact(parsed.features, { hooks: true }, "managed Codex feature requirements");
  if (parsed.hooks?.managed_dir !== managedDir)
    throw new Error(`managed Codex requirements must pin hooks.managed_dir=${managedDir}`);
  const expected = expectedManagedCodexHooks(managedDir);
  const expectedKeys = [...Object.keys(expected), "managed_dir"].sort();
  if (Object.keys(parsed.hooks ?? {}).sort().join(",") !== expectedKeys.join(","))
    throw new Error("managed Codex hook event surface is not exact");
  for (const [event, entries] of Object.entries(expected))
    exact(parsed.hooks?.[event], entries, `managed Codex ${event}`);
}

function assertNixManagedFile(path: string, executable = false): void {
  const info = statSync(path);
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  const target = realpathSync(path);
  if (!target.startsWith("/nix/store/"))
    throw new Error(`${path} is not supplied by the verified Nix closure`);
  if (executable) accessSync(path, constants.X_OK);
}

function managedCommandPaths(
  value: string,
  managedDir = CODEX_MANAGED_HOOKS_DIR,
): { env: string; interpreter: string; script: string } {
  const env = resolve(managedDir, "runtime/env");
  const prefix = `${env} -u BASH_ENV -u ENV `;
  if (!value.startsWith(prefix))
    throw new Error("managed Codex hook command does not scrub shell startup authority");
  const tokens = value.slice(prefix.length).split(" ");
  if (tokens.length !== 2 || tokens.some((token) => !token))
    throw new Error("managed Codex hook command token sequence is not exact");
  const [interpreter, script] = tokens as [string, string];
  const allowedInterpreters = new Set([
    resolve(managedDir, "runtime/bash"),
    resolve(managedDir, "runtime/node"),
  ]);
  if (!allowedInterpreters.has(interpreter)
      || !script.startsWith(`${resolve(managedDir)}/`)
      || resolve(script) !== script) {
    throw new Error("managed Codex hook command paths are outside the managed closure");
  }
  return { env, interpreter, script };
}

/**
 * Pre-provider proof that Codex will load only the root-managed, exact hook
 * surface. Repeated immediately before process spawn to close the admission /
 * execution filesystem race.
 */
export function assertInstalledManagedCodexHooks(): void {
  try {
    assertNixManagedFile(CODEX_MANAGED_REQUIREMENTS);
    const bytes = readFileSync(CODEX_MANAGED_REQUIREMENTS);
    if (bytes.byteLength > MAX_REQUIREMENTS_BYTES)
      throw new Error("managed Codex requirements exceed the bounded size");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    validateManagedCodexRequirements(source);
    const expected = expectedManagedCodexHooks();
    const commands = new Set(Object.values(expected)
      .flatMap((entries) => entries.flatMap((entry) =>
        entry.hooks.map((hook) => hook.command))));
    for (const commandLine of commands) {
      const paths = managedCommandPaths(commandLine);
      assertNixManagedFile(paths.env, true);
      assertNixManagedFile(paths.interpreter, true);
      assertNixManagedFile(paths.script);
    }
  } catch (cause) {
    throw providerPreacceptError("openai_managed_hooks_contract_unavailable", { cause });
  }
}
