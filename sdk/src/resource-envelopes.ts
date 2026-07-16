import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { loadResourcePolicy } from "./resource-policy";
import type { EnvelopeLimits, ResourceEnvelopes } from "./providers/types";
import type { SemanticTier } from "./providers/catalog";
import { withFileLease } from "./file-lease";

export const DEFAULT_ENVELOPE_ACCOUNTING_PATH = resolve(homedir(), ".local/state/north/resource-envelope-accounting.json");

interface ScopeState {
  runs: number;
  frontierRuns: number;
  retries: number;
  active: Record<string, { pid: number; startedAt: string }>;
}

interface AccountingState {
  version: 1;
  scopes: Record<string, ScopeState>;
}

interface ApplicableScope {
  id: string;
  limits: EnvelopeLimits;
}

export interface EnvelopeAdmission {
  id: string;
  path: string;
  scopes: ApplicableScope[];
  tier?: SemanticTier;
  retries: number;
  advisories: string[];
}

export interface EnvelopeAdmissionRequest {
  tier?: SemanticTier;
  project?: string;
  sessionId?: string;
  agentId: string;
  envelopes?: ResourceEnvelopes;
  path?: string;
  now?: Date;
}

export class ResourceEnvelopeExceededError extends Error {
  constructor(public scope: string, public limit: keyof EnvelopeLimits, public used: number, public allowed: number) {
    super(`resource envelope ${scope} exhausted: ${limit} ${used}/${allowed}`);
    this.name = "ResourceEnvelopeExceededError";
  }
}

export function envelopeContextFromEnv(cwd = process.cwd()): { project: string; sessionId?: string } {
  const project = process.env.NORTH_PROJECT ?? cwd.split("/").filter(Boolean).at(-1) ?? "unknown";
  const sessionId = process.env.NORTH_SESSION_ID ?? process.env.CLAUDE_SESSION_ID
    ?? process.env.CODEX_THREAD_ID ?? process.env.AGENT_COORDINATOR;
  return { project, ...(sessionId ? { sessionId } : {}) };
}

const emptyScope = (): ScopeState => ({ runs: 0, frontierRuns: 0, retries: 0, active: {} });
const emptyState = (): AccountingState => ({ version: 1, scopes: {} });

function utcWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((day.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Month/week are UTC recurring global scopes. Project limits are cumulative for
 * the named project. Session limits are cumulative for that session. `default`
 * is a per-session template used only when no named session override exists;
 * without a stable session id it is reported as advisory and not invented.
 */
export function applicableEnvelopeScopes(
  envelopes: ResourceEnvelopes,
  context: { project?: string; sessionId?: string; now?: Date },
): { scopes: ApplicableScope[]; advisories: string[] } {
  const now = context.now ?? new Date();
  const scopes: ApplicableScope[] = [];
  const advisories: string[] = [];
  if (envelopes.month) scopes.push({ id: `month:${now.toISOString().slice(0, 7)}`, limits: envelopes.month });
  if (envelopes.week) scopes.push({ id: `week:${utcWeek(now)}`, limits: envelopes.week });
  if (context.project && envelopes.projects?.[context.project])
    scopes.push({ id: `project:${context.project}`, limits: envelopes.projects[context.project] });
  if (context.sessionId) {
    const specific = envelopes.sessions?.[context.sessionId];
    if (specific) scopes.push({ id: `session:${context.sessionId}`, limits: specific });
    else if (envelopes.default) scopes.push({ id: `default:${context.sessionId}`, limits: envelopes.default });
  } else if (envelopes.default || (envelopes.sessions && Object.keys(envelopes.sessions).length)) {
    advisories.push("session/default envelope not enforceable: no stable session id");
  }
  return { scopes, advisories };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function pruneDeadLeases(state: AccountingState): void {
  for (const scope of Object.values(state.scopes)) {
    for (const [id, lease] of Object.entries(scope.active)) {
      if (!processAlive(lease.pid)) delete scope.active[id];
    }
  }
}

function parseState(value: unknown, path: string): AccountingState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid resource envelope accounting at ${path}: top level must be an object`);
  const raw = value as any;
  if (raw.version !== 1 || typeof raw.scopes !== "object" || raw.scopes === null || Array.isArray(raw.scopes))
    throw new Error(`invalid resource envelope accounting at ${path}: expected version 1 with scopes object`);
  for (const [id, scope] of Object.entries(raw.scopes as Record<string, any>)) {
    if (!scope || ![scope.runs, scope.frontierRuns, scope.retries].every((n: unknown) => Number.isInteger(n) && (n as number) >= 0)
      || typeof scope.active !== "object" || scope.active === null || Array.isArray(scope.active))
      throw new Error(`invalid resource envelope accounting at ${path}: malformed scope ${id}`);
  }
  return raw as AccountingState;
}

async function readState(path: string): Promise<AccountingState> {
  try {
    const raw = await readFile(path, "utf8");
    try { return parseState(JSON.parse(raw), path); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`invalid resource envelope accounting at ${path}: could not parse JSON: ${error.message}`);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

async function mutateState<T>(path: string, mutation: (state: AccountingState) => T): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  return withFileLease(lockPath, async () => {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
    const state = await readState(path);
    pruneDeadLeases(state);
    const result = mutation(state);
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    return result;
    } finally { await rm(temporary, { force: true }); }
  });
}

function check(scopeId: string, state: ScopeState, limits: EnvelopeLimits, tier?: SemanticTier): void {
  if (limits.runs !== undefined && state.runs >= limits.runs)
    throw new ResourceEnvelopeExceededError(scopeId, "runs", state.runs, limits.runs);
  if (tier === "frontier" && limits.frontierRuns !== undefined && state.frontierRuns >= limits.frontierRuns)
    throw new ResourceEnvelopeExceededError(scopeId, "frontierRuns", state.frontierRuns, limits.frontierRuns);
  const active = Object.keys(state.active).length;
  if (limits.parallelism !== undefined && active >= limits.parallelism)
    throw new ResourceEnvelopeExceededError(scopeId, "parallelism", active, limits.parallelism);
}

export async function admitResourceEnvelope(request: EnvelopeAdmissionRequest): Promise<EnvelopeAdmission | undefined> {
  const envelopes = request.envelopes ?? loadResourcePolicy()?.envelopes;
  if (!envelopes) return undefined;
  const applicable = applicableEnvelopeScopes(envelopes, request);
  if (!applicable.scopes.length) return applicable.advisories.length ? {
    id: randomUUID(), path: request.path ?? process.env.NORTH_ENVELOPE_ACCOUNTING ?? DEFAULT_ENVELOPE_ACCOUNTING_PATH,
    scopes: [], tier: request.tier, retries: 0, advisories: applicable.advisories,
  } : undefined;
  const admission: EnvelopeAdmission = {
    id: randomUUID(), path: request.path ?? process.env.NORTH_ENVELOPE_ACCOUNTING ?? DEFAULT_ENVELOPE_ACCOUNTING_PATH,
    scopes: applicable.scopes, tier: request.tier, retries: 0, advisories: applicable.advisories,
  };
  await mutateState(admission.path, (state) => {
    for (const scope of admission.scopes) check(scope.id, state.scopes[scope.id] ?? emptyScope(), scope.limits, request.tier);
    for (const scope of admission.scopes) {
      const usage = state.scopes[scope.id] ??= emptyScope();
      usage.runs++;
      if (request.tier === "frontier") usage.frontierRuns++;
      usage.active[admission.id] = { pid: process.pid, startedAt: (request.now ?? new Date()).toISOString() };
    }
  });
  return admission;
}

/** Reserve a provider fallback before its adapter is invoked. */
export async function reserveResourceEnvelopeRetry(admission: EnvelopeAdmission | undefined): Promise<void> {
  if (!admission?.scopes.length) return;
  await mutateState(admission.path, (state) => {
    for (const scope of admission.scopes) {
      const usage = state.scopes[scope.id] ??= emptyScope();
      if (scope.limits.retries !== undefined && usage.retries >= scope.limits.retries)
        throw new ResourceEnvelopeExceededError(scope.id, "retries", usage.retries, scope.limits.retries);
    }
    for (const scope of admission.scopes) (state.scopes[scope.id] ??= emptyScope()).retries++;
    admission.retries++;
  });
}

export async function completeResourceEnvelope(admission: EnvelopeAdmission | undefined): Promise<void> {
  if (!admission?.scopes.length) return;
  await mutateState(admission.path, (state) => {
    for (const scope of admission.scopes) delete state.scopes[scope.id]?.active[admission.id];
  });
}
