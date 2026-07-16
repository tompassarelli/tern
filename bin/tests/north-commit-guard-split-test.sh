#!/usr/bin/env bash
# Regression: the commit backstop must join thread ownership in coordination.log
# to open clock sessions in telemetry.log, and must ignore a stale pre-split
# facts.log whenever the canonical pair exists. The deny recipe's Linear lookup
# is folded from that same pair.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GUARD="$(cd "$HERE/.." && pwd)/north-commit-guard"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

HOME_TEST="$TMP/home"
STATE="$HOME_TEST/.local/state/north"
REPO="$HOME_TEST/code/client/fakeclient/work"
mkdir -p "$STATE" "$REPO" "$HOME_TEST/code/north/bin"
ln -s "$GUARD" "$HOME_TEST/code/north/bin/north"

git -C "$REPO" init -q -b fakeclient-123-work
git -C "$REPO" -c user.name=test -c user.email=test@example.invalid commit --allow-empty -qm init

event() {
  printf '{:tx %s :op "%s" :l "%s" :p "%s" :r "%s" :frame "test"}\n' "$1" "$2" "$3" "$4" "$5"
}
line() { event "$1" assert "$2" "$3" "$4"; }

run_guard() {
  (cd "$REPO" && env -u FRAM_LOG -u FRAM_TELEMETRY_LOG HOME="$HOME_TEST" bash "$GUARD")
}

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { if "$@"; then ok "$CHECK_LABEL"; else bad "$CHECK_LABEL"; fi; }

echo "== live split allows while stale monolith denies =="
{
  line 1 '@stale-thread' owner fakeclient
  line 2 '@stale-thread' linear FAKECLIENT-123
} > "$STATE/facts.log"
{
  line 101 '@live-thread' owner fakeclient
  line 102 '@live-thread' linear FAKECLIENT-123
} > "$STATE/coordination.log"
{
  line 103 '@live-session' session_of '@live-thread'
  line 104 '@live-session' start_time '2026-07-16T12:00:00Z'
} > "$STATE/telemetry.log"

CHECK_LABEL="split owner + telemetry session permit commit"
check run_guard

echo "== mismatched retract does not clear the current singleton value =="
{
  line 120 '@live-thread' owner fakeclient
  line 121 '@live-thread' linear FAKECLIENT-123
} > "$STATE/coordination.log"
{
  line 122 '@closed-session' session_of '@live-thread'
  line 123 '@closed-session' start_time '2026-07-16T12:00:00Z'
  line 124 '@closed-session' end_time '2026-07-16T12:15:00Z'
  event 125 retract '@closed-session' end_time '2026-07-16T11:59:00Z'
} > "$STATE/telemetry.log"
set +e
run_guard >/dev/null 2>&1
MISMATCHED_RETRACT_RC=$?
set -e
CHECK_LABEL="retracting a non-current end_time leaves the session closed"
check test "$MISMATCHED_RETRACT_RC" -eq 1

echo "== live split denies and supplies its hint while stale monolith allows =="
{
  line 1 '@stale-thread' owner fakeclient
  line 2 '@stale-thread' linear FAKECLIENT-123
  line 3 '@stale-session' session_of '@stale-thread'
  line 4 '@stale-session' start_time '2026-07-16T11:00:00Z'
} > "$STATE/facts.log"
{
  line 201 '@live-thread' owner fakeclient
  line 202 '@live-thread' linear FAKECLIENT-123
  line 203 '@other-thread' owner otherclient
  line 250 '@retracted-thread' linear FAKECLIENT-123
  event 251 retract '@retracted-thread' linear FAKECLIENT-123
  event 252 retract '@live-thread' linear SOME-OTHER-999
} > "$STATE/coordination.log"
{
  line 204 '@other-session' session_of '@other-thread'
  line 205 '@other-session' start_time '2026-07-16T12:30:00Z'
} > "$STATE/telemetry.log"

set +e
OUT="$(run_guard 2>&1)"
RC=$?
set -e
CHECK_LABEL="stale monolith open clock does not permit commit"
check test "$RC" -eq 1
CHECK_LABEL="deny recipe resolves Linear link from coordination.log"
check grep -Fq 'clock start live-thread' <<< "$OUT"
CHECK_LABEL="deny recipe does not use stale facts.log link"
if grep -Fq 'clock start stale-thread' <<< "$OUT"; then bad "$CHECK_LABEL"; else ok "$CHECK_LABEL"; fi
CHECK_LABEL="deny recipe ignores a retracted newer Linear link"
if grep -Fq 'clock start retracted-thread' <<< "$OUT"; then bad "$CHECK_LABEL"; else ok "$CHECK_LABEL"; fi
CHECK_LABEL="mismatched live split owner is reported"
check grep -Fq "open owners: otherclient" <<< "$OUT"

echo "== legacy facts.log remains the fallback when no split exists =="
rm -f "$STATE/coordination.log" "$STATE/telemetry.log"
{
  line 301 '@legacy-thread' owner fakeclient
  line 302 '@legacy-session' session_of '@legacy-thread'
  line 303 '@legacy-session' start_time '2026-07-16T13:00:00Z'
} > "$STATE/facts.log"
CHECK_LABEL="legacy monolith permits commit only when split is absent"
check run_guard

echo
echo "north-commit-guard-split-test: $PASS passed, $FAIL failed"
test "$FAIL" -eq 0
