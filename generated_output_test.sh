#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for module in projections validate staleness clock clockify audit gatepolicy main; do
  BEAGLE_EMIT_SRCLOC=0 direnv exec "$HOME/code/beagle" "$HOME/code/beagle/bin/beagle-build" \
    "$root/src/north/$module.bclj" "$tmp/$module.clj" >/dev/null
  cmp "$tmp/$module.clj" "$root/out/north/$module.clj"
done
if rg -n '/home/|\^\{:line' "$root/out/north"/*.clj; then
  echo "generated output contains source-location or absolute-home residue" >&2
  exit 1
fi
echo "generated-output: passed"
