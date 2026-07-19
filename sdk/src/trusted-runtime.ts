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

/**
 * Resolve only the exact Git injected by North's Nix wrapper. Ambient PATH and
 * user-profile pointers are never candidates.
 */
export function trustedGitExecutable(
  candidates: readonly (string | undefined)[] = [process.env.NORTH_GIT_BIN],
): string {
  return trustedStoreExecutable(
    candidates,
    /^\/nix\/store\/[0-9a-z]{32}-git(?:-[^/]+)?\/bin\/git$/,
    "Git",
  );
}

/**
 * Managed provider execution never consults NORTH_CODEX_BIN or PATH. The
 * package wrapper overwrites this private selector with its exact Codex input.
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
