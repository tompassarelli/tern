#!/usr/bin/env bash
# Hermetic fail-open tests for the delegated-work PostToolUse marker.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$ROOT/bin/north-mark-delegated"
TMP="$(mktemp -d)"
trap 'jobs -pr | xargs -r kill 2>/dev/null || true; rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() {
  local label="$1"
  shift
  if "$@"; then ok "$label"; else bad "$label"; fi
}

payload() {
  printf '{"session_id":"delegated-marker-01","cwd":"%s","hook_event_name":"PostToolUse"}' "$TMP/project"
}

mkdir -p "$TMP/project"
XDG_FAST="$TMP/xdg-fast"
mkdir -p "$XDG_FAST"
t0="$(date +%s%3N)"
payload | XDG_RUNTIME_DIR="$XDG_FAST" bash "$HOOK" >"$TMP/fast.out" 2>"$TMP/fast.err"
rc=$?
elapsed=$(( $(date +%s%3N) - t0 ))
check "normal marker hook exits zero" test "$rc" -eq 0
check "normal marker hook completes under 1s (${elapsed}ms)" test "$elapsed" -lt 1000
check "normal marker hook emits no stdout" test ! -s "$TMP/fast.out"
check "normal marker hook emits no stderr" test ! -s "$TMP/fast.err"
check "normal marker is written" test -s "$XDG_FAST/north-delegated/session-project-delegate"

echo "== malformed input is a clean no-op =="
XDG_INVALID="$TMP/xdg-invalid"
mkdir -p "$XDG_INVALID"
printf '{broken' | XDG_RUNTIME_DIR="$XDG_INVALID" bash "$HOOK" >"$TMP/invalid.out" 2>"$TMP/invalid.err"
rc=$?
check "malformed input exits zero" test "$rc" -eq 0
check "malformed input emits no stdout" test ! -s "$TMP/invalid.out"
check "malformed input emits no stderr" test ! -s "$TMP/invalid.err"
check "malformed input writes no marker" test ! -d "$XDG_INVALID/north-delegated"

echo "== hanging git lookup is bounded below the provider deadline =="
SHIM="$TMP/shim"
mkdir -p "$SHIM"
cat >"$SHIM/git" <<'EOF'
#!/usr/bin/env bash
sleep 30
EOF
chmod +x "$SHIM/git"
XDG_HANG="$TMP/xdg-hang"
mkdir -p "$XDG_HANG"
t0="$(date +%s%3N)"
payload | PATH="$SHIM:$PATH" XDG_RUNTIME_DIR="$XDG_HANG" \
  bash "$HOOK" >"$TMP/hang.out" 2>"$TMP/hang.err"
rc=$?
elapsed=$(( $(date +%s%3N) - t0 ))
check "hanging-git hook exits zero" test "$rc" -eq 0
check "hanging-git hook is cut off before 3s (${elapsed}ms)" test "$elapsed" -lt 3000
check "hanging-git hook emits no stdout" test ! -s "$TMP/hang.out"
check "hanging-git hook emits no stderr" test ! -s "$TMP/hang.err"
check "hanging-git hook leaves no marker" test ! -d "$XDG_HANG/north-delegated"
sleep 0.3
check "hanging-git child is reaped" test -z "$(jobs -pr)"

echo
echo "north-mark-delegated-test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
