#!/usr/bin/env bash
# Hermetic latency/fail-open stress tests for the PostToolUse observability hook.
# Exercises cold cache, a delayed/down coordinator, repeated and concurrent calls,
# large envelopes, stale singleflight recovery, private output buffering, and the
# print-before-ack delivery boundary.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$ROOT/bin/north-on-tooluse"
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

valid_control_character_json() {
  python3 - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
context = payload["hookSpecificOutput"]["additionalContext"]
assert payload["hookSpecificOutput"]["hookEventName"] == "PostToolUse"
assert 'deadline "proof" \\ route' in context
assert "complete\tbody before stalled ack" in context
PY
}

FAKE_HOME="$TMP/home"
SHIM="$TMP/shim"
STATE="$TMP/state"
PROJECT="$TMP/project"
mkdir -p "$FAKE_HOME/code/north/cli" "$SHIM" "$STATE" "$PROJECT"

cat >"$SHIM/bb" <<'EOF'
#!/usr/bin/env bash
set -u
kind=other
case "${1:-}" in
  -e) kind=repair ;;
  *presence-cli.clj) kind=presence ;;
  *inbox-peek.clj) kind=inbox ;;
esac
marker="$HOOK_TEST_STATE/live-$kind-$$"
: >"$marker"
printf '%s %s\n' "$kind" "$$" >>"$HOOK_TEST_STATE/starts.log"
trap 'rm -f "$marker"' EXIT
if [ "${HOOK_TEST_MODE:-fast}" = slow ] || [ "${HOOK_TEST_MODE:-fast}" = badjson ]; then
  if [ "$kind" = inbox ]; then
    printf '✉ from peer — deadline "proof" \\ route\n'
    printf '  complete\tbody before stalled ack\n'
  fi
fi
if [ "${HOOK_TEST_MODE:-fast}" = slow ]; then
  sleep 30
fi
exit 0
EOF
chmod +x "$SHIM/bb"
: >"$STATE/starts.log"

payload() {
  local sid="$1"
  printf '{"session_id":"%s","cwd":"%s","hook_event_name":"PostToolUse","effort":{"level":"xhigh"}}' \
    "$sid" "$PROJECT"
}

run_hook() {
  local xdg="$1" mode="$2" sid="$3" out="$4"
  mkdir -p "$xdg"
  payload "$sid" | env -i \
    HOME="$FAKE_HOME" PATH="$SHIM:$PATH" XDG_RUNTIME_DIR="$xdg" \
    HOOK_TEST_STATE="$STATE" HOOK_TEST_MODE="$mode" AGENT_PROVIDER=openai \
    bash "$HOOK" >"$out" 2>/dev/null
}

await_locks() {
  local xdg="$1"
  for _ in $(seq 1 200); do
    if ! find "$xdg" -type d -name '*.lock' -print -quit 2>/dev/null | grep -q .; then
      return 0
    fi
    sleep 0.01
  done
  return 1
}

echo "== cold healthy path stays low-latency and converges maintenance =="
XDG_FAST="$TMP/xdg-fast"
OUT_FAST="$TMP/fast.out"
t0="$(date +%s%3N)"
run_hook "$XDG_FAST" fast cold-fast-0001 "$OUT_FAST"
rc=$?
elapsed=$(( $(date +%s%3N) - t0 ))
check "cold hook exits zero" test "$rc" -eq 0
check "cold healthy hook completes under 1s (${elapsed}ms)" test "$elapsed" -lt 1000
check "background maintenance completes" await_locks "$XDG_FAST"
check "route convergence cache committed" test -s "$XDG_FAST/north-agent-routes/cold-fast-0001"
check "presence throttle marker committed" test -s "$XDG_FAST/north-presence-renew/session-project-cold-fas"

echo "== 20MB envelope is parsed once, not once per field =="
XDG_LARGE="$TMP/xdg-large"
OUT_LARGE="$TMP/large.out"
t0="$(date +%s%3N)"
python3 -c 'import sys
sys.stdout.write("{\"session_id\":\"large-payload-01\",\"cwd\":\"'"$PROJECT"'\",\"hook_event_name\":\"PostToolUse\",\"tool_response\":\"" + "x" * 20000000 + "\"}")' |
  env -i HOME="$FAKE_HOME" PATH="$SHIM:$PATH" XDG_RUNTIME_DIR="$XDG_LARGE" \
    HOOK_TEST_STATE="$STATE" HOOK_TEST_MODE=fast AGENT_PROVIDER=openai \
    bash "$HOOK" >"$OUT_LARGE" 2>/dev/null
rc=$?
elapsed=$(( $(date +%s%3N) - t0 ))
check "large-payload hook exits zero" test "$rc" -eq 0
check "20MB hook completes under 1.5s (${elapsed}ms)" test "$elapsed" -lt 1500
await_locks "$XDG_LARGE" || true

echo "== malformed inner output becomes a clean no-op =="
PY_SHIM="$TMP/python-shim"
mkdir -p "$PY_SHIM"
REAL_PYTHON="$(command -v python3)"
cat >"$PY_SHIM/python3" <<EOF
#!/usr/bin/env bash
if [ "\${HOOK_TEST_HANG_TOOLUSE_VALIDATOR:-0}" = 1 ] &&
    [ "\${1:-}" = -c ] &&
    printf '%s' "\${2:-}" | grep -Fq 'specific = payload["hookSpecificOutput"]'; then
  sleep 30
  exit 1
fi
if [ "\${HOOK_TEST_BAD_SERIALIZER:-0}" = 1 ] &&
    [ "\${1:-}" = -c ] &&
    printf '%s' "\${2:-}" | grep -Fq 'context = sys.stdin.read()'; then
  printf '{malformed'
  exit 0
fi
exec "$REAL_PYTHON" "\$@"
EOF
chmod +x "$PY_SHIM/python3"
XDG_BADJSON="$TMP/xdg-badjson"
OUT_BADJSON="$TMP/badjson.out"
mkdir -p "$XDG_BADJSON"
payload malformed-child-01 |
  env -i HOME="$FAKE_HOME" PATH="$PY_SHIM:$SHIM:$PATH" XDG_RUNTIME_DIR="$XDG_BADJSON" \
    HOOK_TEST_STATE="$STATE" HOOK_TEST_MODE=badjson HOOK_TEST_BAD_SERIALIZER=1 \
    AGENT_PROVIDER=openai bash "$HOOK" >"$OUT_BADJSON" 2>"$OUT_BADJSON.err"
rc=$?
check "malformed-child hook exits zero" test "$rc" -eq 0
check "malformed-child stdout is empty" test ! -s "$OUT_BADJSON"
check "malformed-child stderr is empty" test ! -s "$OUT_BADJSON.err"
await_locks "$XDG_BADJSON" || true

echo "== outer validation and emission are independently deadline-bounded =="
XDG_VALIDATOR="$TMP/xdg-validator"
OUT_VALIDATOR="$TMP/validator.out"
mkdir -p "$XDG_VALIDATOR"
t0="$(date +%s%3N)"
payload validator01 |
  env -i HOME="$FAKE_HOME" PATH="$PY_SHIM:$SHIM:$PATH" XDG_RUNTIME_DIR="$XDG_VALIDATOR" \
    HOOK_TEST_STATE="$STATE" HOOK_TEST_MODE=badjson HOOK_TEST_HANG_TOOLUSE_VALIDATOR=1 \
    AGENT_PROVIDER=openai bash "$HOOK" >"$OUT_VALIDATOR" 2>"$OUT_VALIDATOR.err"
rc=$?
elapsed=$(( $(date +%s%3N) - t0 ))
check "hanging-validator hook exits zero" test "$rc" -eq 0
check "hanging validator is cut off under 2s (${elapsed}ms)" test "$elapsed" -lt 2000
check "hanging validator emits no stdout" test ! -s "$OUT_VALIDATOR"
check "hanging validator emits no stderr" test ! -s "$OUT_VALIDATOR.err"
await_locks "$XDG_VALIDATOR" || true

CAT_SHIM="$TMP/cat-shim"
mkdir -p "$CAT_SHIM"
REAL_CAT="$(command -v cat)"
cat >"$CAT_SHIM/cat" <<EOF
#!/usr/bin/env bash
case "\${1:-}" in
  *north-tooluse-output.*) sleep 30; exit 1 ;;
esac
exec "$REAL_CAT" "\$@"
EOF
chmod +x "$CAT_SHIM/cat"
XDG_EMITTER="$TMP/xdg-emitter"
OUT_EMITTER="$TMP/emitter.out"
mkdir -p "$XDG_EMITTER"
t0="$(date +%s%3N)"
payload emitter01 |
  env -i HOME="$FAKE_HOME" PATH="$CAT_SHIM:$SHIM:$PATH" XDG_RUNTIME_DIR="$XDG_EMITTER" \
    HOOK_TEST_STATE="$STATE" HOOK_TEST_MODE=badjson AGENT_PROVIDER=openai \
    bash "$HOOK" >"$OUT_EMITTER" 2>"$OUT_EMITTER.err"
rc=$?
elapsed=$(( $(date +%s%3N) - t0 ))
check "hanging-emitter hook exits zero" test "$rc" -eq 0
check "hanging emitter is cut off under 2s (${elapsed}ms)" test "$elapsed" -lt 2000
check "hanging emitter emits no stdout" test ! -s "$OUT_EMITTER"
check "hanging emitter emits no stderr" test ! -s "$OUT_EMITTER.err"
await_locks "$XDG_EMITTER" || true

echo "== down coordinator is bounded, private, and singleflight-coalesced =="
XDG_SLOW="$TMP/xdg-slow"
OUT_SLOW1="$TMP/slow1.out"
OUT_SLOW2="$TMP/slow2.out"
mkdir -p "$XDG_SLOW"
: >"$STATE/starts.log"
t0="$(date +%s%3N)"
run_hook "$XDG_SLOW" slow down-daemon-01 "$OUT_SLOW1" &
hook_pid=$!
sleep 0.2
buffer="$(find "$XDG_SLOW" -maxdepth 1 -type f -name 'north-tooluse-output.*' -print -quit)"
if [ -n "$buffer" ] && [ "$(stat -c %a "$buffer" 2>/dev/null)" = 600 ]; then
  ok "peer-mail buffer is an unpredictable mktemp file with mode 0600"
else
  bad "peer-mail buffer is an unpredictable mktemp file with mode 0600"
fi
wait "$hook_pid"
rc=$?
elapsed=$(( $(date +%s%3N) - t0 ))
check "down-daemon hook exits zero" test "$rc" -eq 0
check "down-daemon hook stays under 2s (${elapsed}ms)" test "$elapsed" -lt 2000
check "message printed before stalled ack is still delivered" grep -Fq "body before stalled ack" "$OUT_SLOW1"
check "quotes, backslashes, and control characters remain valid JSON" valid_control_character_json "$OUT_SLOW1"
check "private buffer is removed after delivery" test -z "$(find "$XDG_SLOW" -maxdepth 1 -name 'north-tooluse-output.*' -print -quit)"

t0="$(date +%s%3N)"
run_hook "$XDG_SLOW" slow down-daemon-01 "$OUT_SLOW2"
rc=$?
elapsed=$(( $(date +%s%3N) - t0 ))
check "repeated down-daemon hook exits zero" test "$rc" -eq 0
check "repeated down-daemon hook stays under 2s (${elapsed}ms)" test "$elapsed" -lt 2000
repair_starts="$(grep -c '^repair ' "$STATE/starts.log" || true)"
presence_starts="$(grep -c '^presence ' "$STATE/starts.log" || true)"
check "repeated hooks start only one live repair worker" test "$repair_starts" -eq 1
check "repeated hooks start only one live presence worker" test "$presence_starts" -eq 1
sleep 4.2
check "all delayed workers are gone after shared deadlines" test -z "$(find "$STATE" -name 'live-*' -print -quit)"
check "worker deadlines remove their singleflight locks" test -z "$(find "$XDG_SLOW" -type d -name '*.lock' -print -quit)"

echo "== stale locks recover and a concurrent cold burst does not duplicate workers =="
XDG_STALE="$TMP/xdg-stale"
mkdir -p "$XDG_STALE/north-agent-routes/stale-lo.repair.lock"
mkdir -p "$XDG_STALE/north-presence-renew/session-project-stale-lo.lock"
touch -d '20 seconds ago' \
  "$XDG_STALE/north-agent-routes/stale-lo.repair.lock" \
  "$XDG_STALE/north-presence-renew/session-project-stale-lo.lock"
: >"$STATE/starts.log"
run_hook "$XDG_STALE" fast stale-lo "$TMP/stale.out"
check "stale-lock repair completes" await_locks "$XDG_STALE"
check "stale route lock is reclaimed and cache commits" test -s "$XDG_STALE/north-agent-routes/stale-lo"
check "stale renewal lock is reclaimed and marker commits" test -s "$XDG_STALE/north-presence-renew/session-project-stale-lo"

XDG_BURST="$TMP/xdg-burst"
mkdir -p "$XDG_BURST"
: >"$STATE/starts.log"
t0="$(date +%s%3N)"
pids=()
for i in $(seq 1 8); do
  run_hook "$XDG_BURST" fast concurrent-cold "$TMP/burst-$i.out" &
  pids+=("$!")
done
burst_ok=1
for pid in "${pids[@]}"; do wait "$pid" || burst_ok=0; done
elapsed=$(( $(date +%s%3N) - t0 ))
check "eight concurrent hooks all exit zero" test "$burst_ok" -eq 1
check "eight concurrent hooks finish under 2s (${elapsed}ms)" test "$elapsed" -lt 2000
check "concurrent maintenance completes" await_locks "$XDG_BURST"
repair_starts="$(grep -c '^repair ' "$STATE/starts.log" || true)"
presence_starts="$(grep -c '^presence ' "$STATE/starts.log" || true)"
check "cold burst publishes identity once" test "$repair_starts" -eq 1
check "cold burst renews presence once" test "$presence_starts" -eq 1

echo "== real inbox helper flushes before a stalled ACK =="
cat >"$TMP/ack-stall-server.py" <<'PY'
import socket, sys, time

port_file = sys.argv[1]
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen()
with open(port_file, "w") as f:
    f.write(str(server.getsockname()[1]))

replies = [
    '{:ok [["@msg:flush-proof" "flush-agent"]]}',
    '{:values []}',
    '{:value "peer"}',
    '{:value "flush proof"}',
    '{:value "complete body"}',
]
index = 0
while True:
    conn, _ = server.accept()
    with conn:
        data = b""
        while not data.endswith(b"\n"):
            chunk = conn.recv(65536)
            if not chunk:
                break
            data += chunk
        if index < len(replies):
            conn.sendall((replies[index] + "\n").encode())
            index += 1
        else:
            time.sleep(30)
PY
PORT_FILE="$TMP/ack-stall.port"
python3 "$TMP/ack-stall-server.py" "$PORT_FILE" &
server_pid=$!
for _ in $(seq 1 100); do [ -s "$PORT_FILE" ] && break; sleep 0.01; done
port="$(cat "$PORT_FILE")"
set +e
timeout --signal=TERM --kill-after=0.1s 0.7s \
  bb "$ROOT/cli/inbox-peek.clj" "$port" flush-agent >"$TMP/flush.out" 2>/dev/null
flush_rc=$?
set -e
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
check "ACK stall reaches the helper deadline" test "$flush_rc" -eq 124
check "complete subject is flushed before ACK" grep -Fq "✉ from peer — flush proof" "$TMP/flush.out"
check "complete body is flushed before ACK" grep -Fq "  complete body" "$TMP/flush.out"

echo
echo "north-on-tooluse-stress-test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
