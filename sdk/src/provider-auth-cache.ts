import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ProviderId } from "./providers/types";

/**
 * Cross-process cache of the last *definitive* CLI authentication verdict per
 * routing target. A definitive verdict is one the provider CLI actually
 * produced (exited with a status code): logged in, or genuinely logged out.
 *
 * Two independent problems motivate persistence, both observed as the provider
 * status surface flapping under load:
 *
 *   1. Stampede. `providers --json` and every `selectProvider` route spawn a
 *      fresh `claude auth status` / `codex login status` per target. Rapid or
 *      concurrent callers fork dozens of these against the same isolated home,
 *      and the resulting CPU/IO contention pushes each spawn past its short
 *      timeout. A recent authenticated verdict is reused instead of re-probing
 *      (single-flight across processes), so a burst collapses to one probe.
 *
 *   2. Fail-closed classification. When a probe cannot complete (spawn timeout,
 *      fork failure, killed), that is absence of fresh evidence, never proof of
 *      a missing login. The last definitive verdict is retained rather than
 *      downgrading a healthy account to `authentication_missing`.
 *
 * The store is advisory: any read/write failure degrades silently to a live
 * probe. It never carries provider diagnostics — only the fixed verdict enum.
 */
export type AuthVerdictReason = "ready" | "authentication_missing" | "command_missing";

export interface CachedAuthState {
  provider: ProviderId;
  installed: boolean;
  authenticated: boolean;
  /** Availability *before* the caller applies routing policy (e.g. disabled). */
  available: boolean;
  reason: AuthVerdictReason;
  /** Epoch milliseconds of the definitive probe. */
  at: number;
}

interface AuthStateFile {
  version: 1;
  states: Record<string, CachedAuthState>;
}

const DEFAULT_AUTH_STATE_PATH = resolve(homedir(), ".local/state/north/provider-auth-state.json");

/**
 * Resolve from the parent process environment, never a target's isolated child
 * env: one shared file keyed per target keeps the verdict for every account in
 * one place, and the writer is always the parent probe process.
 */
export function authStateCachePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NORTH_AUTH_STATE_CACHE) return env.NORTH_AUTH_STATE_CACHE;
  const observations = env.NORTH_PROVIDER_OBSERVATIONS;
  if (observations) return `${observations}.auth-state.json`;
  return DEFAULT_AUTH_STATE_PATH;
}

export function authCacheKey(provider: ProviderId, targetId: string | undefined): string {
  return provider + ":" + (targetId ?? "ambient");
}

function isCachedAuthState(value: unknown): value is CachedAuthState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (state.provider === "anthropic" || state.provider === "openai")
    && typeof state.installed === "boolean"
    && typeof state.authenticated === "boolean"
    && typeof state.available === "boolean"
    && (state.reason === "ready" || state.reason === "authentication_missing" || state.reason === "command_missing")
    && typeof state.at === "number" && Number.isFinite(state.at);
}

function readFile(path: string): AuthStateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { version: 1, states: {} };
    const states = (parsed as { states?: unknown }).states;
    const valid: Record<string, CachedAuthState> = {};
    if (typeof states === "object" && states !== null)
      for (const [key, value] of Object.entries(states as Record<string, unknown>))
        if (isCachedAuthState(value)) valid[key] = value;
    return { version: 1, states: valid };
  } catch {
    return { version: 1, states: {} };
  }
}

export function readAuthState(path: string, key: string): CachedAuthState | undefined {
  return readFile(path).states[key];
}

/** Best-effort atomic merge write. A broken store must never abort a probe. */
export function writeAuthState(path: string, key: string, state: CachedAuthState): void {
  try {
    const current = readFile(path);
    current.states[key] = state;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(current)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    /* advisory cache: silently degrade to live probing */
  }
}
