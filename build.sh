#!/usr/bin/env bash
# Recompile Tern's Beagle (.bclj) sources to Clojure into out/.
#
# Tern is a CONSUMER of the Fram engine (~/code/fram): the engine's beagle
# sources are linked in (src/fram, gitignored) so the type checker resolves
# fram.* fully, and fram/out is on the runtime classpath (see bin/tern).
# You only need this to rebuild from the .bclj sources (requires Beagle + Fram).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/src"; OUT="$HERE/out"
BEAGLE="${BEAGLE_HOME:-$HOME/code/beagle}"
FRAM="${FRAM_HOME:-$HOME/code/fram}"

# Link the engine sources so beagle resolves fram.* with full types.
ln -sfn "$FRAM/src/fram" "$SRC/fram"

mkdir -p "$OUT/tern"
for m in projections validate staleness clock clockify audit gatepolicy main; do
  BEAGLE_EMIT_SRCLOC=0 direnv exec "$BEAGLE" "$BEAGLE/bin/beagle-build" \
    "$SRC/tern/$m.bclj" "$OUT/tern/$m.clj" >/dev/null
  echo "  built tern/$m"
done
echo "tern built -> $OUT  (engine: $FRAM/out on classpath at runtime)"
