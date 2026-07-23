// Per-lane git workspace isolation (design: docs/private/worktree-isolation-report.md).
// A workspace lane owns its OWN index + working tree, so a `git add -A` in one lane can
// never sweep a peer's junk into a feature commit, and a peer's stage/commit can never
// reset this lane's index mid-stage. north stays REPO-AGNOSTIC: this module does the
// provisioning + an optional caller-supplied setup command; every repo-specific tax
// (copy gitignored env, pick a port, run e2e) rides in the INJECTED payload text, not here.
//
// MECHANISM: a managed writable lane gets a SELF-CONTAINED CLONE, not a linked worktree.
// A linked worktree's commit machinery (index.lock, per-worktree gitdir, shared refs) lives
// in the PARENT repo's .git/worktrees/<id>/ — outside a provider's workspace-write sandbox
// (Codex `workspace-write` allows writes only under the workspace path and has no --add-dir),
// so `git commit` dies with "index.lock ... read-only" (defect 019f8eaa, canary 3 rerun). A
// `git clone --no-hardlinks` puts the whole git-dir INSIDE the workspace, so every commit
// write stays inside the sandbox. --no-hardlinks keeps the object store fully independent
// (immune to a canonical `git gc`); origin's PUSH url is neutered to a sentinel so a lane
// cannot accidentally push into the canonical checkout, while origin's FETCH url stays the
// canonical repo (the landing rebase reads origin/main). The ledger vocabulary stays
// "worktree" throughout — this is a MECHANISM swap, not a rename.
//
// Mirrors death.ts's PURE/impure split: pure command-builders + the cleanup-decision table
// are unit-testable with no live git; the impure shell-outs are thin. Two hard rules match
// the rest of the finalize surface:
//   - provisionWorktree FAILS LOUD (throws) — a provisioning failure must NEVER silently
//     fall back to the shared tree (that would reintroduce the shared-index bug); an
//     explicitly isolated spawn aborts before provider/identity/run side effects.
//   - worktreeFinalize is FAIL-OPEN (never throws) — a finalizing lane must never be
//     bricked by a cleanup hiccup, exactly like clockFinalize / notifyDeath.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ProviderPreference, RoutingDecision } from "./providers/types";

const SOURCE_ROOT = resolve(import.meta.dir, "..", "..");
const ALLOCATION_WRITER = resolve(SOURCE_ROOT, "cli", "worktree-allocation-internal.clj");
const ALLOCATION_VERSION = "north:worktree-allocation:v1" as const;
const ALLOCATION_LEASE_MS = 30 * 60_000;

export type WorktreeResourceState = "planned" | "active" | "absent" | "quarantined";
export type WorktreeAllocationEventType =
  | "registered" | "provisioned" | "authority-profiled" | "run-rotated"
  | "provision-failed" | "rolled-back" | "released" | "quarantined";

export interface WorktreeProviderAuthorityProfile {
  version: 1;
  phase: "requested" | "resolved";
  provider: ProviderPreference;
  target: string;
  authMode: "unresolved" | "ambient" | "isolated";
  profile: string;
}

export interface WorktreeAllocationEvent {
  version: 1;
  id: string;
  type: WorktreeAllocationEventType;
  observedAt: string;
  resourceState: WorktreeResourceState;
  headOid?: string;
  run?: string;
  providerAuthorityProfile?: WorktreeProviderAuthorityProfile;
  error?: { code: string; phase: string };
  recovery?: {
    action: "none" | "inspect-and-salvage" | "remove-if-clean";
    resource: string;
    durableRef: string;
  };
}

export interface WorktreeAllocationRegistration {
  version: typeof ALLOCATION_VERSION;
  subject: string;
  repositoryIdentity: string;
  gitCommonDir: string;
  sourceRoot: string;
  repositoryLayout: "standalone" | "linked";
  worktree: string;
  durableRef: string;
  baseOid: string;
  headOid: string;
  run: string;
  agent: string;
  thread: string;
  concern: string;
  allocationNonce: string;
  lease: {
    version: 1;
    holder: string;
    issuedAt: string;
    expiresAt: string;
    enforcement: "phase-1-record-only";
  };
  providerAuthorityProfile: WorktreeProviderAuthorityProfile;
  event: WorktreeAllocationEvent;
}

export interface WorktreeAllocationWriter {
  register(registration: WorktreeAllocationRegistration): void;
  event(subject: string, event: WorktreeAllocationEvent): void;
}

export interface WorktreeAllocationOwnership {
  runId: string;
  thread?: string;
  concern?: string;
  provider?: ProviderPreference;
  target?: string;
  writer?: WorktreeAllocationWriter;
}

export interface ManagedWorktreeAllocation {
  subject: string;
  nonce: string;
  durableRef: string;
  baseOid: string;
  headOid: string;
  runId: string;
  state: WorktreeResourceState;
  writer: WorktreeAllocationWriter;
}

export interface ProvisionedWorktree {
  path: string;
  branch: string;
  repoRoot: string;
  allocation: ManagedWorktreeAllocation;
}

export interface WorktreeTerminalFailure {
  code: string;
  phase: string;
}

function allocationBb(): string {
  return process.env.NORTH_PEER_BB ?? "bb";
}

export const defaultWorktreeAllocationWriter: WorktreeAllocationWriter = {
  register(registration) {
    execFileSync(allocationBb(), [
      ALLOCATION_WRITER,
      process.env.NORTH_PORT ?? "7977",
      "register",
      JSON.stringify(registration),
    ], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  },
  event(subject, event) {
    execFileSync(allocationBb(), [
      ALLOCATION_WRITER,
      process.env.NORTH_PORT ?? "7977",
      "event",
      subject,
      JSON.stringify(event),
    ], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  },
};

function exactEntity(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return value.startsWith("@") ? value : `@${value}`;
}

function oid(repoRoot: string, rev: string): string {
  return git(["-C", repoRoot, "rev-parse", "--verify", rev]).trim();
}

function gitCommonDir(repoRoot: string): string {
  return realpathSync(git([
    "-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir",
  ]).trim());
}

function sourceRoot(repoRoot: string): string {
  return realpathSync(git(["-C", repoRoot, "rev-parse", "--show-toplevel"]).trim());
}

function repositoryIdentity(commonDir: string): string {
  const digest = createHash("sha256")
    .update("north:git-common-dir:v1\0")
    .update(commonDir)
    .digest("hex");
  return `north:git-common-dir-sha256:v1:${digest}`;
}

function requestedAuthorityProfile(
  provider: ProviderPreference = "auto",
  target?: string,
): WorktreeProviderAuthorityProfile {
  return {
    version: 1,
    phase: "requested",
    provider,
    target: target ?? "unresolved",
    authMode: "unresolved",
    profile: "unresolved",
  };
}

export function resolvedWorktreeAuthorityProfile(
  decision: RoutingDecision,
): WorktreeProviderAuthorityProfile {
  const target = decision.routingTargets[decision.target];
  if (!target || target.provider !== decision.provider)
    throw new Error("worktree allocation cannot resolve the selected provider authority target");
  const authMode = target.authMode ?? "ambient";
  if (authMode === "isolated" && !target.profile)
    throw new Error("worktree allocation resolved an isolated authority without a profile");
  return {
    version: 1,
    phase: "resolved",
    provider: target.provider,
    target: target.id,
    authMode,
    profile: authMode === "isolated" ? target.profile! : "ambient",
  };
}

function newAllocationEvent(
  allocation: Pick<ManagedWorktreeAllocation, "headOid" | "runId">,
  type: WorktreeAllocationEventType,
  resourceState: WorktreeResourceState,
  extra: Partial<WorktreeAllocationEvent> = {},
): WorktreeAllocationEvent {
  return {
    version: 1,
    id: randomUUID(),
    type,
    observedAt: new Date().toISOString(),
    resourceState,
    headOid: allocation.headOid,
    run: exactEntity(allocation.runId, "(unavailable)"),
    ...extra,
  };
}

function writeAllocationEvent(
  allocation: ManagedWorktreeAllocation,
  type: WorktreeAllocationEventType,
  resourceState: WorktreeResourceState,
  extra: Partial<WorktreeAllocationEvent> = {},
): void {
  allocation.writer.event(
    allocation.subject,
    newAllocationEvent(allocation, type, resourceState, extra),
  );
  allocation.state = resourceState;
}

export function recordWorktreeAuthorityProfile(
  allocation: ManagedWorktreeAllocation,
  profile: WorktreeProviderAuthorityProfile,
): void {
  writeAllocationEvent(allocation, "authority-profiled", allocation.state, {
    providerAuthorityProfile: profile,
  });
}

export function recordWorktreeRunRotation(
  allocation: ManagedWorktreeAllocation,
  runId: string,
): void {
  writeAllocationEvent(allocation, "run-rotated", allocation.state, {
    run: exactEntity(runId, "(unavailable)"),
  });
  // The graph acknowledgement is the identity boundary. A rejected write must
  // leave every later event on the prior, durably-known run.
  allocation.runId = runId;
}

export function worktreeNorthExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.NORTH_BIN) return env.NORTH_BIN;
  return resolve(env.NORTH_HOME ?? SOURCE_ROOT, "bin", "north");
}

const northBin = () => worktreeNorthExecutable();

// ---- PURE builders (no I/O; testable off strings) --------------------------------------

// The branch a lane's worktree sits on. `lane-<agentId>` — cut from HEAD at provision.
export function worktreeBranch(agentId: string): string {
  return `lane-${agentId}`;
}

// Absolute path of a lane's workspace (the clone root; its .git lives INSIDE). /tmp (not
// <repo>-worktrees/) DELIBERATELY: it matches kea's already-in-production worktree-lane
// pattern (msa131-*, msa210* on /tmp). basename separates the normal case of repositories
// with distinct names; the allocation ledger makes any residual path/ref collision explicit.
export function worktreePath(agentId: string, repoRoot: string): string {
  return `/tmp/${basename(repoRoot)}-${worktreeBranch(agentId)}`;
}

// Push url sentinel: an unroutable transport so an accidental `git push` from a lane clone
// fails hard (no such remote helper) instead of reaching the canonical checkout.
export const CLONE_PUSH_SENTINEL = "north-disabled://managed-clone-no-push" as const;

// The three provisioning verbs of a self-contained clone (git-dir INSIDE the workspace):
//   1. clone   — `git clone --no-hardlinks <repoRoot> <path>` (independent object store).
//   2. branch  — `git -C <path> checkout -b lane-<id> <baseOid>` in the CLONE's own ref space.
//   3. neuter  — `git -C <path> remote set-url --push origin <sentinel>` (fetch url kept).
export function cloneArgs(agentId: string, repoRoot: string): string[] {
  return ["clone", "--no-hardlinks", repoRoot, worktreePath(agentId, repoRoot)];
}
export function cloneBranchArgs(agentId: string, repoRoot: string, baseOid = "HEAD"): string[] {
  return ["-C", worktreePath(agentId, repoRoot), "checkout", "-b", worktreeBranch(agentId), baseOid];
}
export function cloneNeuterPushArgs(agentId: string, repoRoot: string): string[] {
  return ["-C", worktreePath(agentId, repoRoot), "remote", "set-url", "--push", "origin", CLONE_PUSH_SENTINEL];
}

// A clean removal of a self-contained clone is a single filesystem delete of the workspace
// directory — the whole git-dir (branch, refs, index) lives inside it, so there is NO
// canonical linked-worktree registration or shared branch to unwind. Plain `rm -rf <path>`
// under the cleanliness gate, never against a dirty/salvage tree (worktreeCleanupDecision
// owns that asymmetry). Returned as an arg array so the recovery surface shells it directly.
export function removeArgs(agentId: string, repoRoot: string): { workspace: string[] } {
  return { workspace: ["-rf", "--", worktreePath(agentId, repoRoot)] };
}

// PURE cleanup decision — the salvage gate. The asymmetry is the whole design: a wrongful
// KEEP costs only disk (bounded, cheap to defer to the sweep), a wrongful REMOVE destroys a
// crashed/capped lane's uncommitted WIP (unrecoverable). So remove ONLY on the provably-safe
// case — a clean turn-end with nothing uncommitted; everything else KEEPS.
//   - 'remove'          : ran + clean          -> reclaim disk inline
//   - 'keep-clean-exit' : ran + dirty          -> a clean-exit lane that left uncommitted
//                                                 changes is a reporting bug; keep + surface
//   - 'keep-salvage'    : any non-`ran` outcome -> crash/cap/budget/struggle: partial WIP
//                         (died/stalled/capped/  likely present; the tree is the only salvage
//                          max_turns/budget_*/    artifact. Keep regardless of dirtiness.
//                          struggle_ceiling)
export type CleanupDecision = "remove" | "keep-clean-exit" | "keep-salvage";
export function worktreeCleanupDecision(outcome: string, dirty: boolean): CleanupDecision {
  if (outcome !== "ran") return "keep-salvage";
  return dirty ? "keep-clean-exit" : "remove";
}

// The protocol text block injected into a worktree lane's system prompt. Tight + GENERIC
// (no kea specifics — those ride in the caller's brief). Tells the lane: where it is, how to
// LAND (commit -> rebase -> ff-merge -> push), how to VERIFY from a worktree (portless tests
// HERE; app-load needs repo setup + a HIGH port; never stock e2e), and where reports go (the
// MAIN tree's docs/private at an absolute path — the worktree's own docs/private is invisible
// to the coordinator).
export function worktreePayload(o: { path: string; branch: string; mainReportsDir: string }): string {
  return [
    ``,
    `## Worktree isolation — you run in an ISOLATED git worktree`,
    `Your working tree is \`${o.path}\` on branch \`${o.branch}\` — your OWN index + tree.`,
    `Nothing you stage or commit can touch a peer's index, and no peer can reset yours.`,
    `Stage freely (\`git add -A\` is safe here); commit on \`${o.branch}\` only.`,
    ``,
    `### Landing protocol (get your branch into main)`,
    `1. Commit all work on \`${o.branch}\` (own index — zero cross-lane contamination).`,
    `2. Rebase onto latest main IN THIS WORKTREE: \`git fetch && git rebase origin/main\`.`,
    `   Resolve any conflicts HERE — you hold the context. Step 3 is impossible until clean.`,
    `3. The coordinator ff-merges in the main tree: \`git merge --ff-only ${o.branch}\`.`,
    `   \`--ff-only\` guarantees no merge commit; if it can't fast-forward, re-rebase (you were stale).`,
    `4. Push from the main tree via \`safe-push\` (never raw git push).`,
    ``,
    `### Verify protocol (from a worktree)`,
    `- Portless checks (vitest / typecheck / unit + integration tests) → run HERE, in the worktree.`,
    `- App-load smoke needs repo setup: copy any gitignored env files in, \`bun install --frozen-lockfile\`,`,
    `  then run the dev server on a HIGH port via the repo's own port flag (NOT the default port).`,
    `- NEVER run stock e2e / playwright from a worktree: \`reuseExistingServer\` FALSE-GREENS against`,
    `  whatever already listens on the default port — it verifies the wrong code. Defer e2e to after merge.`,
    ``,
    `### Reports`,
    `Write every report to the MAIN tree at \`${o.mainReportsDir}/<slug>.md\` (ABSOLUTE path).`,
    `Your worktree's own docs/private is invisible to the coordinator — it polls the main tree.`,
  ].join("\n");
}

// ---- impure shell (thin) ---------------------------------------------------------------

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
}

function refExists(repoRoot: string, durableRef: string): boolean {
  try {
    git(["-C", repoRoot, "show-ref", "--verify", "--quiet", durableRef]);
    return true;
  } catch {
    return false;
  }
}

function registrationFor(
  agentId: string,
  opts: { repoRoot: string } & WorktreeAllocationOwnership,
): { registration: WorktreeAllocationRegistration; allocation: ManagedWorktreeAllocation } {
  const root = sourceRoot(opts.repoRoot);
  const commonDir = gitCommonDir(root);
  const baseOid = oid(root, "HEAD");
  const branch = worktreeBranch(agentId);
  const path = worktreePath(agentId, root);
  const durableRef = `refs/heads/${branch}`;
  const nonce = randomUUID();
  const subject = `@worktree-allocation:${nonce}`;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ALLOCATION_LEASE_MS);
  const profile = requestedAuthorityProfile(opts.provider, opts.target);
  const run = exactEntity(opts.runId, "(unavailable)");
  const agent = exactEntity(`agent:${agentId}`, "(unavailable)");
  const event: WorktreeAllocationEvent = {
    version: 1,
    id: randomUUID(),
    type: "registered",
    observedAt: issuedAt.toISOString(),
    resourceState: "planned",
    headOid: baseOid,
    run,
  };
  const registration: WorktreeAllocationRegistration = {
    version: ALLOCATION_VERSION,
    subject,
    repositoryIdentity: repositoryIdentity(commonDir),
    gitCommonDir: commonDir,
    sourceRoot: root,
    repositoryLayout: lstatSync(join(root, ".git")).isFile() ? "linked" : "standalone",
    worktree: path,
    durableRef,
    baseOid,
    headOid: baseOid,
    run,
    agent,
    thread: exactEntity(opts.thread, "@thread:ad-hoc"),
    concern: exactEntity(opts.concern, "@concern:unattributed"),
    allocationNonce: nonce,
    lease: {
      version: 1,
      holder: agent,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      enforcement: "phase-1-record-only",
    },
    providerAuthorityProfile: profile,
    event,
  };
  const writer = opts.writer ?? defaultWorktreeAllocationWriter;
  writer.register(registration);
  return {
    registration,
    allocation: {
      subject,
      nonce,
      durableRef,
      baseOid,
      headOid: baseOid,
      runId: opts.runId,
      state: "planned",
      writer,
    },
  };
}

function allocationRecovery(
  allocation: ManagedWorktreeAllocation,
  path: string,
  action: "none" | "inspect-and-salvage" | "remove-if-clean",
): WorktreeAllocationEvent["recovery"] {
  return { action, resource: path, durableRef: allocation.durableRef };
}

function tryPublishQuarantine(
  allocation: ManagedWorktreeAllocation,
  extra: Partial<WorktreeAllocationEvent>,
): void {
  try { writeAllocationEvent(allocation, "quarantined", "quarantined", extra); }
  catch { /* registration remains the durable pre-Git identity; never delete on uncertainty */ }
}

// FAIL LOUD. `git worktree add`; then, if a setupCmd was given, run it in the fresh worktree
// (the generic repo-setup hook — bun install, env copy, etc., supplied by the caller). Any
// failure THROWS so spawn can decide (it must never silently drop into the shared tree).
// Once Git has created any physical identity, this phase never reclaims it automatically:
// uncertainty is quarantined for an explicit later recovery decision.
export function provisionWorktree(
  agentId: string,
  opts: { repoRoot: string; setupCmd?: string } & WorktreeAllocationOwnership,
): ProvisionedWorktree {
  // All calls above are read-only Git discovery. The marker-last registration
  // is the first mutation and MUST acknowledge before git can create a path/ref.
  const { registration, allocation } = registrationFor(agentId, opts);
  const repoRoot = registration.sourceRoot;
  const path = registration.worktree;
  const branch = worktreeBranch(agentId);
  let phase = "physical_preflight";
  try {
    if (existsSync(path)) throw new Error("derived worktree path is already occupied");
    if (refExists(repoRoot, allocation.durableRef))
      throw new Error("derived durable ref is already occupied");
    phase = "git_provision";
    // Self-contained clone: git-dir lands INSIDE `path`, so a workspace-only write sandbox
    // can commit. Cut the lane branch at the exact base oid in the clone's own ref space,
    // then neuter the push url so the lane cannot reach the canonical checkout.
    git(cloneArgs(agentId, repoRoot));
    git(cloneBranchArgs(agentId, repoRoot, allocation.baseOid));
    git(cloneNeuterPushArgs(agentId, repoRoot));
    phase = "head_observation";
    allocation.headOid = oid(path, "HEAD");
    phase = "allocation_publication";
    writeAllocationEvent(allocation, "provisioned", "active");
    if (opts.setupCmd) {
      phase = "setup";
      execFileSync("sh", ["-c", opts.setupCmd], { cwd: path, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
    }
    return { path, branch, repoRoot, allocation };
  } catch (error) {
    const resourcePresent = existsSync(path) || refExists(repoRoot, allocation.durableRef);
    const code = phase === "setup"
      ? "setup_failed"
      : phase === "allocation_publication"
        ? "allocation_publication_failed"
        : phase === "head_observation"
          ? "head_observation_failed"
        : phase === "physical_preflight" && existsSync(path)
          ? "worktree_path_collision"
          : phase === "physical_preflight"
            ? "durable_ref_collision"
            : "git_worktree_add_failed";
    if (!resourcePresent) {
      writeAllocationEvent(allocation, "provision-failed", "absent", {
        error: { code, phase },
        recovery: allocationRecovery(allocation, path, "none"),
      });
      writeAllocationEvent(allocation, "rolled-back", "absent");
    } else {
      tryPublishQuarantine(allocation, {
        error: { code, phase },
        recovery: allocationRecovery(allocation, path, "inspect-and-salvage"),
      });
      tellOrphaned(agentId, path, "worktree provisioning failed after physical identity appeared — inspect; never auto-delete");
    }
    throw new Error(
      `worktree ${phase} failed for @agent:${agentId}; allocation=${allocation.subject}; `
      + `resource=${resourcePresent ? "quarantined" : "absent"}`,
      { cause: error },
    );
  }
}

// `git -C <path> status --porcelain` non-empty => uncommitted changes present.
// null is uncertainty, never cleanliness.
function worktreeDirty(path: string): boolean | null {
  try {
    return git(["-C", path, "status", "--porcelain"]).trim().length > 0;
  } catch {
    return null;
  }
}

// A post-provision admission failure never proves that deleting the physical
// resource is safe. Preserve it under its pre-Git registration and publish the
// strongest quarantine observation the coordinator will acknowledge.
export function rollbackProvisionedWorktree(
  agentId: string,
  loc: ProvisionedWorktree,
): void {
  const dirty = worktreeDirty(loc.path);
  const code = dirty === null ? "git_status_unavailable"
    : dirty ? "worktree_dirty" : "admission_aborted";
  tryPublishQuarantine(loc.allocation, {
    error: { code, phase: "admission_rollback" },
    recovery: allocationRecovery(
      loc.allocation, loc.path, dirty === false ? "remove-if-clean" : "inspect-and-salvage",
    ),
  });
  tellOrphaned(agentId, loc.path, "spawn aborted before provider execution; preserved for explicit recovery");
}

// Surface a kept worktree as a durable, queryable fact so the sweep + a human can salvage it.
function tellOrphaned(agentId: string, path: string, reason: string): void {
  try {
    execFileSync(northBin(), ["tell", `agent:${agentId}`, "worktree_orphaned", `${path} | ${reason}`],
      { stdio: "ignore", timeout: 10_000 });
  } catch { /* best-effort */ }
}

// FAIL OPEN and preserve-only. Even a clean successful lane is not reclaimed by
// the provider process; landing/recovery owns that later explicit decision.
export function worktreeFinalize(
  agentId: string,
  outcome: string,
  loc: ProvisionedWorktree,
  terminalFailure?: WorktreeTerminalFailure,
): void {
  try {
    const dirty = worktreeDirty(loc.path);
    if (dirty === null) {
      tryPublishQuarantine(loc.allocation, {
        error: { code: "git_status_unavailable", phase: "finalize" },
        recovery: allocationRecovery(loc.allocation, loc.path, "inspect-and-salvage"),
      });
      tellOrphaned(agentId, loc.path, "git status unavailable at finalize — inspect allocation ledger");
      return;
    }
    // Lifecycle events carry the exact final commit even though the immutable
    // registration's base/head pair remains the provisioning snapshot.
    loc.allocation.headOid = oid(loc.path, "HEAD");
    const decision = worktreeCleanupDecision(outcome, dirty);
    const reason = decision === "remove"
      ? "clean terminal preserved for explicit landing/reclamation"
      : decision === "keep-clean-exit"
        ? "outcome=ran but tree dirty — inspect before recovery"
        : `outcome=${outcome} — salvage before recovery`;
    tryPublishQuarantine(loc.allocation, {
      error: {
        code: terminalFailure?.code
          ?? (decision === "remove" ? "manual_reclamation_required"
            : decision === "keep-clean-exit" ? "clean_exit_dirty" : "salvage_required"),
        phase: terminalFailure?.phase ?? "finalize",
      },
      recovery: allocationRecovery(
        loc.allocation, loc.path, decision === "remove" ? "remove-if-clean" : "inspect-and-salvage",
      ),
    });
    tellOrphaned(agentId, loc.path, reason);
  } catch {
    // Provider execution already completed; preserve the historical fail-open
    // terminal contract. The static committed allocation remains queryable.
    try { tellOrphaned(agentId, loc.path, "allocation finalization indeterminate — manual check"); }
    catch { /* fail-open: a finalize must never be bricked by cleanup */ }
  }
}
