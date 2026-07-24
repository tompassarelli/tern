import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalGlobalAgents } from "../harness";
import { scrubManagedNonclientReceiptEnvironment } from "./managed-nonclient-receipt";

const MANAGED_HOME_PREFIX = "north-managed-codex-";
const MAX_AUTH_BYTES = 1024 * 1024;
const activeHomes = new Set<string>();
let exitCleanupInstalled = false;

export interface PreparedManagedCodexHome {
  env: NodeJS.ProcessEnv;
  home: string;
  accountHome: string;
  dispose(): void;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function removeHome(home: string): void {
  if (!activeHomes.delete(home)) return;
  rmSync(home, { recursive: true, force: true });
}

function trackHome(home: string): void {
  activeHomes.add(home);
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once("exit", () => {
    for (const active of [...activeHomes]) {
      try { removeHome(active); } catch { /* process exit cannot recover cleanup */ }
    }
  });
}

function exactPrivateAuthFile(accountHome: string): string {
  const auth = resolve(accountHome, "auth.json");
  let info;
  try { info = lstatSync(auth); }
  catch (cause) {
    if (isMissing(cause)) throw new Error("managed Codex account authentication is missing", { cause });
    throw new Error("managed Codex account authentication is uninspectable", { cause });
  }
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("managed Codex account authentication is not a regular file");
  if (info.size <= 0 || info.size > MAX_AUTH_BYTES)
    throw new Error("managed Codex account authentication has invalid size");
  if ((info.mode & 0o077) !== 0)
    throw new Error("managed Codex account authentication is not private");
  const canonical = realpathSync(auth);
  if (canonical !== auth)
    throw new Error("managed Codex account authentication escapes its account home");
  return canonical;
}

/**
 * Materialize the state boundary for one managed Codex launch. The selected
 * account remains the durable authentication store, but its mutable interactive
 * config, rules, hooks, plugins, skills, history, caches, and sqlite databases
 * are never a managed provider home. The launch sees only the exact auth file,
 * the canonical provider-neutral AGENTS source, and a new private sqlite root.
 */
export function prepareManagedCodexHome(
  accountEnv: NodeJS.ProcessEnv,
): PreparedManagedCodexHome {
  const accountHomeValue = accountEnv.CODEX_HOME?.trim();
  if (!accountHomeValue) throw new Error("managed Codex account home is missing");
  const accountHome = realpathSync(accountHomeValue);
  const auth = exactPrivateAuthFile(accountHome);
  const agents = canonicalGlobalAgents(accountEnv);
  if (!agents) throw new Error("managed Codex canonical AGENTS authority is disabled");

  const home = mkdtempSync(join(tmpdir(), MANAGED_HOME_PREFIX));
  trackHome(home);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    removeHome(home);
  };
  try {
    chmodSync(home, 0o700);
    mkdirSync(join(home, "sqlite"), { mode: 0o700 });
    chmodSync(join(home, "sqlite"), 0o700);
    symlinkSync(auth, join(home, "auth.json"));
    symlinkSync(agents.realpath, join(home, "AGENTS.md"));
    const env = {
      ...accountEnv,
      CODEX_HOME: home,
      CODEX_SQLITE_HOME: join(home, "sqlite"),
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
    };
    scrubManagedNonclientReceiptEnvironment(env);
    return {
      env,
      home,
      accountHome,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
