#!/usr/bin/env bash
# Regression for the package purity guard (flake.nix installPhase scan).
#
# The guard rejects any embedded checkout/home/cache path in the packaged
# output, with exactly two audited exceptions: the NixOS runtime entry-hint
# pointers /run/current-system/sw/bin/{git,bb} in sdk/src/trusted-runtime.ts.
# Those are root-managed symlinks that trustedStoreExecutable() still forces to
# canonicalize into the immutable /nix/store, so they never widen trust; they
# exist because managed spawns do not always inherit NORTH_GIT_BIN / NORTH_BB.
#
# This test proves the exemption is NARROW: only those two literals, only in
# that one file, are spared. It extracts the impurity_pattern and sanctioned
# allowlist regexes straight from flake.nix so it tracks the real guard rather
# than a hand-copied duplicate that could silently drift.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
flake="$repo_root/flake.nix"

impurity_pattern=$(sed -n "s/^[[:space:]]*impurity_pattern='\(.*\)'\$/\1/p" "$flake")
sanctioned=$(sed -n "s/^[[:space:]]*sanctioned='\(.*\)'\$/\1/p" "$flake")
[ -n "$impurity_pattern" ] || { echo "FAIL: impurity_pattern not found in flake.nix" >&2; exit 1; }
[ -n "$sanctioned" ] || { echo "FAIL: sanctioned allowlist not found in flake.nix" >&2; exit 1; }

# Mirror the guard's residual computation exactly.
scan() {
  LC_ALL=C rg --hidden -n "$impurity_pattern" "$1" | LC_ALL=C rg -v "$sanctioned" || true
}

work=$(mktemp -d)
trap 'rm -rf "${work:?}"' EXIT

pass() { echo "ok: $1"; }
expect_clean() { # dir label
  [ -z "$(scan "$1")" ] || { echo "FAIL: $2" >&2; scan "$1" >&2; exit 1; }
  pass "$2"
}
expect_flagged() { # dir label
  [ -n "$(scan "$1")" ] || { echo "FAIL: $2" >&2; exit 1; }
  pass "$2"
}

# A: the exact sanctioned pointer lines are exempted (guard passes clean).
mkdir -p "$work/a/sdk/src"
cat > "$work/a/sdk/src/trusted-runtime.ts" <<'EOF'
    process.env.NORTH_GIT_BIN,
    "/run/current-system/sw/bin/git",
    "/run/current-system/sw/bin/bb",
EOF
expect_clean "$work/a" "sanctioned git/bb entry-hint pointers are exempted"

# B: a real home/checkout path in the SAME file stays fatal.
mkdir -p "$work/b/sdk/src"
cat > "$work/b/sdk/src/trusted-runtime.ts" <<'EOF'
    "/run/current-system/sw/bin/git",
    "/home/tom/code/north/leak",
EOF
expect_flagged "$work/b" "a home path inside trusted-runtime.ts is still fatal"

# C: a non-git/bb system-profile target in that file stays fatal.
mkdir -p "$work/c/sdk/src"
printf '    "/run/current-system/sw/bin/evil",\n' > "$work/c/sdk/src/trusted-runtime.ts"
expect_flagged "$work/c" "a non-git/bb system-profile path is not exempted"

# D: the sanctioned literal in ANY OTHER file stays fatal.
mkdir -p "$work/d/sdk/src"
printf '    "/run/current-system/sw/bin/git",\n' > "$work/d/sdk/src/other.ts"
expect_flagged "$work/d" "the exemption does not apply outside trusted-runtime.ts"

# E: the live repository source carries no UNSANCTIONED impurity.
expect_clean "$repo_root/sdk/src" "sdk/src has no unsanctioned impurity"

echo "PASS: purity-guard allowlist is narrow (git/bb entry hints only)"
