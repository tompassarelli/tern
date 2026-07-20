import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";

export class TrustedGitOracleError extends Error {
  constructor(readonly code: "execution_failed" | "unexpected_result", options?: ErrorOptions) {
    super(`trusted Git oracle ${code.replace("_", " ")}`, options);
    this.name = "TrustedGitOracleError";
  }
}

function trustedStoreExecutable(
  candidates: readonly (string | undefined)[],
  pattern: RegExp,
  label: string,
): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const target = realpathSync(candidate);
      if (!pattern.test(target)) continue;
      accessSync(target, constants.X_OK);
      return target;
    } catch {
      // A candidate is evidence only after canonical-path and executable proof.
    }
  }
  throw new Error(`trusted Nix-store ${label} executable unavailable`);
}

/** A username safe to interpolate into a fixed system-profile path. */
function safeProfileUser(user: string | undefined): string | undefined {
  return user && /^[a-z_][a-z0-9_-]*$/.test(user) ? user : undefined;
}

/**
 * Fixed, non-arbitrary entry points to a NixOS-immutable Git, most trusted
 * first: the wrapper's explicit injection, the root-managed system profile, the
 * root-managed home-manager per-user profile, then the caller's own Nix
 * profile. These are ENTRY hints only — trust is never granted by the location.
 * Every candidate must still pass the canonical `/nix/store` + executable proof
 * below, so a repointed profile symlink or a shim can only ever resolve to the
 * immutable store or be rejected. Ambient `$PATH` is deliberately absent.
 */
function defaultTrustedGitPointers(): readonly (string | undefined)[] {
  const home = process.env.HOME;
  const user = safeProfileUser(process.env.USER);
  return [
    process.env.NORTH_GIT_BIN,
    "/run/current-system/sw/bin/git",
    user ? `/etc/profiles/per-user/${user}/bin/git` : undefined,
    home ? `${home}/.nix-profile/bin/git` : undefined,
  ];
}

/**
 * Resolve a Git whose real canonical executable lives in the immutable Nix
 * store. Managed spawns do not always inherit the wrapper's NORTH_GIT_BIN, so
 * the default candidates also include the real NixOS current-system/profile
 * layout — but only as entry hints. Ambient `$PATH` and writable shim locations
 * are never candidates, and every accepted path is proven to canonicalize into
 * `/nix/store` and be executable. Absent that proof, resolution fails closed.
 */
export function trustedGitExecutable(
  candidates: readonly (string | undefined)[] = defaultTrustedGitPointers(),
): string {
  return trustedStoreExecutable(
    candidates,
    /^\/nix\/store\/[0-9a-z]{32}-git(?:-[^/]+)?\/bin\/git$/,
    "Git",
  );
}

/**
 * Fixed, non-arbitrary entry points to a NixOS-immutable Babashka, most trusted
 * first: the wrapper's explicit peer/MCP/CLI injections, then the same
 * root-managed system-profile, home-manager per-user profile, and per-user Nix
 * profile layout as Git. Managed children do not always inherit the wrapper's
 * NORTH_PEER_BB/NORTH_MCP_BB, so the `bb` powering the durable North mail feed
 * must be discoverable from these immutable pointers. As with Git these are ENTRY
 * hints only — every candidate still passes the canonical `/nix/store` +
 * executable proof below, so a repointed profile symlink or writable shim can
 * only resolve into the immutable store or be rejected. Ambient `$PATH` is
 * deliberately absent, and absence of proof stays fail-closed.
 */
function defaultTrustedBabashkaPointers(): readonly (string | undefined)[] {
  const home = process.env.HOME;
  const user = safeProfileUser(process.env.USER);
  return [
    process.env.NORTH_PEER_BB,
    process.env.NORTH_MCP_BB,
    process.env.NORTH_BB,
    "/run/current-system/sw/bin/bb",
    user ? `/etc/profiles/per-user/${user}/bin/bb` : undefined,
    home ? `${home}/.nix-profile/bin/bb` : undefined,
  ];
}

/**
 * Resolve the Babashka that runs North's own coordinator/live-feed scripts, whose
 * real canonical executable lives in the immutable Nix store. Unlike the provider
 * CLI, `bb` only interprets North's version-controlled `.clj` and its exact
 * store hash is behaviorally irrelevant to trust, so any canonical
 * `/nix/store/*-babashka/bin/bb` that is executable is safely discoverable from
 * the entry hints above. Ambient `$PATH` and writable shim locations are never
 * candidates; absent the `/nix/store` + X_OK proof, resolution fails closed.
 */
export function trustedNorthBabashkaExecutable(
  candidates: readonly (string | undefined)[] = defaultTrustedBabashkaPointers(),
): string {
  return trustedStoreExecutable(
    candidates,
    /^\/nix\/store\/[0-9a-z]{32}-babashka(?:-[^/]+)?\/bin\/bb$/,
    "Babashka",
  );
}

/**
 * Managed provider execution never consults NORTH_CODEX_BIN or PATH, and unlike
 * Git/Babashka it is NOT broadened to ambient system pointers: the managed Codex
 * IS the billed provider, so its exact wrapper-pinned build is an identity, not a
 * fungible infrastructure tool. Substituting whatever `codex` the ambient system
 * profile happens to expose would let the environment swap the provider binary
 * (and its protocol/version) out from under a managed run. The package wrapper
 * overwrites this private selector with its exact Codex input; absent that, it
 * fails closed by design.
 */
export function trustedManagedCodexExecutable(
  candidates: readonly (string | undefined)[] =
    [process.env.NORTH_MANAGED_CODEX_BIN],
): string {
  return trustedStoreExecutable(
    candidates,
    /^\/nix\/store\/[0-9a-z]{32}-[^/]*codex[^/]*\/bin\/codex$/,
    "Codex",
  );
}

/**
 * Git root/branch discovery is an authority oracle. Give it a closed
 * environment so GIT_DIR, GIT_WORK_TREE, config include paths, ceiling
 * directories, and repository-replacement variables cannot redirect it.
 */
export function gitOracleEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: "/homeless-shelter",
    PATH: "",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // Pin discovery's upper boundary so Git 2.54 emits the same exact
    // non-repository diagnostic on mounted and ordinary filesystems.
    GIT_CEILING_DIRECTORIES: "/",
  };
}

export function trustedGitProjectRoot(
  cwd: string,
  gitExecutable = trustedGitExecutable(),
): string {
  const canonicalCwd = realpathSync(cwd);
  try {
    const root = execFileSync(
      gitExecutable,
      ["-C", canonicalCwd, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        env: gitOracleEnvironment(),
        timeout: 2_000,
        maxBuffer: 16 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (!root) throw new TrustedGitOracleError("unexpected_result");
    return realpathSync(root);
  } catch (cause) {
    if (cause instanceof TrustedGitOracleError) throw cause;
    const error = cause as NodeJS.ErrnoException & {
      status?: number | null;
      stderr?: Buffer | string;
    };
    const stderr = String(error.stderr ?? "").trim();
    // A real, canonical cwd need not be a Git checkout. This one exact
    // C-locale result is absence, not oracle failure. Every execution/config/
    // ownership error remains fatal.
    if (error.status === 128
        && /^fatal: not a git repository \(or any of the parent directories\): \.git$/.test(stderr)) {
      return canonicalCwd;
    }
    throw new TrustedGitOracleError("execution_failed", { cause });
  }
}

export function trustedGitBranchName(
  projectRoot: string,
  gitExecutable = trustedGitExecutable(),
): string {
  return execFileSync(
    gitExecutable,
    ["-C", projectRoot, "branch", "--show-current"],
    {
      encoding: "utf8",
      env: gitOracleEnvironment(),
      timeout: 2_000,
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
}
