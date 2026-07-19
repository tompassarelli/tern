// Per-lane git worktree isolation (design: docs/private/worktree-isolation-report.md).
// A worktree lane owns its OWN index + working tree, so a `git add -A` in one lane can
// never sweep a peer's junk into a feature commit, and a peer's stage/commit can never
// reset this lane's index mid-stage. north stays REPO-AGNOSTIC: this module does generic
// `git worktree add` + an optional caller-supplied setup command; every repo-specific tax
// (copy gitignored env, pick a port, run e2e) rides in the INJECTED payload text, not here.
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
import { basename, resolve } from "node:path";

const SOURCE_ROOT = resolve(import.meta.dir, "..", "..");

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

// Absolute path of a lane's worktree. /tmp (not <repo>-worktrees/) DELIBERATELY: it matches
// kea's already-in-production worktree-lane pattern (msa131-*, msa210* on /tmp) AND wins the
// btrfs reflink/CoW clone for a near-free `git worktree add` — measured ~free in kea (report
// Q1). basename keys it to the repo so two repos never collide.
export function worktreePath(agentId: string, repoRoot: string): string {
  return `/tmp/${basename(repoRoot)}-${worktreeBranch(agentId)}`;
}

// `git -C <repoRoot> worktree add <path> -b lane-<id> HEAD` — the whole provisioning verb.
export function provisionArgs(agentId: string, repoRoot: string): string[] {
  return ["-C", repoRoot, "worktree", "add", worktreePath(agentId, repoRoot), "-b", worktreeBranch(agentId), "HEAD"];
}

// The two commands a clean removal issues, managed from the MAIN checkout (worktrees are
// removed from the primary tree). Plain `worktree remove` (no --force): git refusing a dirty
// tree is a belt-and-suspenders backstop UNDER the cleanliness gate, never a forced delete.
export function removeArgs(agentId: string, repoRoot: string): { worktree: string[]; branch: string[] } {
  return {
    worktree: ["-C", repoRoot, "worktree", "remove", worktreePath(agentId, repoRoot)],
    branch: ["-C", repoRoot, "branch", "-d", worktreeBranch(agentId)],
  };
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

// FAIL LOUD. `git worktree add`; then, if a setupCmd was given, run it in the fresh worktree
// (the generic repo-setup hook — bun install, env copy, etc., supplied by the caller). Any
// failure THROWS so spawn can decide (it must never silently drop into the shared tree). On a
// setup failure we best-effort remove the half-baked worktree first, so a throw doesn't strand it.
export function provisionWorktree(agentId: string, opts: { repoRoot: string; setupCmd?: string }): { path: string; branch: string } {
  const path = worktreePath(agentId, opts.repoRoot);
  const branch = worktreeBranch(agentId);
  git(provisionArgs(agentId, opts.repoRoot)); // throws on git error — intentional (no silent fallback)
  if (opts.setupCmd) {
    try {
      execFileSync("sh", ["-c", opts.setupCmd], { cwd: path, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      try { git(removeArgs(agentId, opts.repoRoot).worktree); git(removeArgs(agentId, opts.repoRoot).branch); } catch { /* best-effort unwind */ }
      throw new Error(`worktree setupCmd failed for @agent:${agentId}: ${(e as any)?.message ?? e}`);
    }
  }
  return { path, branch };
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

// A worktree can be provisioned successfully and then lose a later admission
// race before runSpawn owns it. Reclaim that unused clean tree without force;
// keep and surface anything dirty or unreadable. Provisioning failures never
// reach this function, so they still produce zero identity/run writes.
export function rollbackProvisionedWorktree(
  agentId: string,
  loc: { path: string; branch: string; repoRoot: string },
): void {
  try {
    const dirty = worktreeDirty(loc.path);
    if (dirty === null) {
      tellOrphaned(agentId, loc.path, "spawn aborted before provider execution; git status unavailable — manual check");
      return;
    }
    if (dirty) {
      tellOrphaned(agentId, loc.path, "spawn aborted before provider execution; tree dirty — manual salvage");
      return;
    }
    const rm = removeArgs(agentId, loc.repoRoot);
    try {
      git(rm.worktree);
      git(rm.branch);
    } catch {
      tellOrphaned(agentId, loc.path, "spawn aborted before provider execution; non-force cleanup refused");
    }
  } catch {
    /* fail-open: preserve the tree */
  }
}

// Surface a kept worktree as a durable, queryable fact so the sweep + a human can salvage it.
function tellOrphaned(agentId: string, path: string, reason: string): void {
  try {
    execFileSync(northBin(), ["tell", `agent:${agentId}`, "worktree_orphaned", `${path} | ${reason}`],
      { stdio: "ignore", timeout: 10_000 });
  } catch { /* best-effort */ }
}

// FAIL OPEN. Compute dirtiness, apply the salvage-gated decision: remove (clean `ran`) or
// keep + surface a `worktree_orphaned` fact (everything else). Never throws out of a
// finalizing lane — mirrors clockFinalize / notifyDeath.
export function worktreeFinalize(agentId: string, outcome: string, loc: { path: string; branch: string; repoRoot: string }): void {
  try {
    const dirty = worktreeDirty(loc.path);
    if (dirty === null) {
      tellOrphaned(agentId, loc.path, "git status unavailable at finalize — kept for manual check");
      return;
    }
    const decision = worktreeCleanupDecision(outcome, dirty);
    if (decision === "remove") {
      const rm = removeArgs(agentId, loc.repoRoot);
      try {
        git(rm.worktree);
        git(rm.branch);
      } catch {
        // git refused (e.g. a race left the tree dirty) — the dirtiness gate already passed,
        // so this is the backstop: keep + surface rather than force-delete.
        tellOrphaned(agentId, loc.path, "clean-exit but `git worktree remove` refused — manual check");
      }
    } else {
      const reason = decision === "keep-clean-exit"
        ? "outcome=ran but tree dirty — uncommitted changes on clean exit (reporting anomaly)"
        : `outcome=${outcome} — mid-work stop; salvage before reaping`;
      tellOrphaned(agentId, loc.path, reason);
    }
  } catch {
    /* fail-open: a finalize must never be bricked by cleanup */
  }
}
