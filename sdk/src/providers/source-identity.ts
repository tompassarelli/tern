import { spawnSync } from "node:child_process";

/** Human-visible identity for a live checkout, including uncommitted state. */
export function checkoutSourceIdentity(root: string): string {
  const revision = spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"],
    { encoding: "utf8", timeout: 1000 });
  if (revision.status !== 0) return "checkout unknown";
  const status = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"],
    { encoding: "utf8", timeout: 1000 });
  const dirty = status.status !== 0 || status.stdout.trim().length > 0;
  return `checkout ${revision.stdout.trim()}${dirty ? " dirty" : " clean"}`;
}

export function northSourceIdentity(root: string): string {
  const packaged = process.env.NORTH_PACKAGE_REV;
  return packaged ? `nix-store ${packaged}` : checkoutSourceIdentity(root);
}
