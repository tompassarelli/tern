#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CUSTOM="$TMP/custom.log"
SPLIT="$TMP/coordination.log"
: >"$CUSTOM"
: >"$SPLIT"

TRACE="$(
  env -u FRAM_TELEMETRY_LOG \
    HOME="$TMP/home" \
    FRAM_LOG="$CUSTOM" \
    bash -x "$ROOT/bin/north" help 2>&1
)"

if ! grep -Fq "+ export FRAM_LOG=$CUSTOM" <<<"$TRACE"; then
  echo "FAIL: public bin/north did not preserve the explicit FRAM_LOG" >&2
  exit 1
fi
if grep -Fq "+ export FRAM_LOG=$SPLIT" <<<"$TRACE"; then
  echo "FAIL: public bin/north redirected an explicit FRAM_LOG to coordination.log" >&2
  exit 1
fi

echo "north explicit log: PASS"
