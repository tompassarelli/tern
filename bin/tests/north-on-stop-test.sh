#!/usr/bin/env bash
# shellcheck disable=SC2016 # Fake-command bodies expand only when fixtures run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/bin/north-on-stop"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE_PATH="$PATH"
FAKE="$TMP/fake-bin"
RUNTIME="$TMP/runtime"
mkdir -p "$FAKE" "$RUNTIME/north-agent-ids" "$RUNTIME/north-delegated"

fail() {
  printf 'north-on-stop-test: %s\n' "$*" >&2
  exit 1
}

write_fake() {
  local name="$1" body="$2"
  printf '#!/usr/bin/env bash\n%s\n' "$body" >"$FAKE/$name"
  chmod 0755 "$FAKE/$name"
}

clear_fakes() {
  rm -f "$FAKE/git" "$FAKE/pgrep"
}

invoke() {
  local input="$1" output="$2" error="$3"
  set +e
  env PATH="$FAKE:$BASE_PATH" XDG_RUNTIME_DIR="$RUNTIME" \
    "$HOOK" <<<"$input" >"$output" 2>"$error"
  local status=$?
  set -e
  [ "$status" -eq 0 ] || fail "hook returned $status"
  [ ! -s "$error" ] || fail "hook emitted stderr"
}

assert_empty() {
  [ ! -s "$1" ] || fail "expected empty output from $1"
}

assert_block() {
  local output="$1" expected_id="$2"
  python3 - "$output" "$expected_id" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
expected_id = sys.argv[2]
value = json.loads(path.read_text(encoding="utf-8"))
assert set(value) == {"decision", "reason"}
assert value["decision"] == "block"
assert isinstance(value["reason"], str) and value["reason"]
assert expected_id in value["reason"]
assert f"north-arm {expected_id}" in value["reason"]
PY
}

session="stop-test-session"
agent_id="session-stop-test-deadbeef"
input="$(printf '{"cwd":"%s","session_id":"%s"}' "$TMP" "$session")"
printf '%s\n' "$agent_id" >"$RUNTIME/north-agent-ids/$session"

# Malformed input and a clean session with no delegation marker both allow.
clear_fakes
invoke '{"cwd":' "$TMP/malformed.out" "$TMP/malformed.err"
assert_empty "$TMP/malformed.out"
invoke '{"cwd":"'"$TMP"'","session_id":"one","session_id":"two"}' \
  "$TMP/duplicate-input.out" "$TMP/duplicate-input.err"
assert_empty "$TMP/duplicate-input.out"
padding="$(head -c 70000 /dev/zero | tr '\000' x)"
invoke '{"cwd":"/'"$padding"'","session_id":"oversized"}' \
  "$TMP/oversized-input.out" "$TMP/oversized-input.err"
assert_empty "$TMP/oversized-input.out"
unset padding
invoke "$input" "$TMP/no-marker.out" "$TMP/no-marker.err"
assert_empty "$TMP/no-marker.out"

# A held-open stdin is under the WHOLE-hook supervisor, not an unbounded `cat`.
fifo="$TMP/held-open.fifo"
mkfifo "$fifo"
start_ms="$(date +%s%3N)"
env PATH="$FAKE:$BASE_PATH" XDG_RUNTIME_DIR="$RUNTIME" \
  "$HOOK" <"$fifo" >"$TMP/held-open.out" 2>"$TMP/held-open.err" &
hook_pid=$!
exec 9>"$fifo"
printf '%s' '{"cwd":"/still/open"' >&9
set +e
wait "$hook_pid"
held_status=$?
set -e
elapsed_ms=$(( $(date +%s%3N) - start_ms ))
exec 9>&-
[ "$held_status" -eq 0 ] || fail "held-open stdin returned $held_status"
[ "$elapsed_ms" -lt 3000 ] || fail "held-open stdin took ${elapsed_ms}ms"
assert_empty "$TMP/held-open.out"
assert_empty "$TMP/held-open.err"

# A hung git (including a TERM-resistant descendant) fails open and is reaped.
write_fake git '
printf "%s\n" "$$" >"$NORTH_TEST_CHILD_PID"
trap "" TERM
while :; do sleep 30; done
'
start_ms="$(date +%s%3N)"
NORTH_TEST_CHILD_PID="$TMP/hung-git.pid" invoke \
  "$input" "$TMP/hung-git.out" "$TMP/hung-git.err"
elapsed_ms=$(( $(date +%s%3N) - start_ms ))
[ "$elapsed_ms" -lt 3000 ] || fail "hung git took ${elapsed_ms}ms"
assert_empty "$TMP/hung-git.out"
sleep 0.3
hung_git_pid="$(cat "$TMP/hung-git.pid")"
if kill -0 "$hung_git_pid" 2>/dev/null; then
  kill -KILL "$hung_git_pid" 2>/dev/null || true
  fail "hung git survived the supervisor"
fi

# A background descendant that inherits git stdout cannot hold a command
# substitution pipe open; the tempfile supervisor kills the whole session.
write_fake git '
(
  printf "%s\n" "$BASHPID" >"$NORTH_TEST_CHILD_PID"
  trap "" TERM
  while :; do sleep 30; done
) &
printf "%s\n" "$2"
exit 0
'
NORTH_TEST_CHILD_PID="$TMP/inherited-pipe.pid" invoke \
  "$input" "$TMP/inherited-pipe.out" "$TMP/inherited-pipe.err"
assert_empty "$TMP/inherited-pipe.out"
sleep 0.3
inherited_pid="$(cat "$TMP/inherited-pipe.pid")"
if kill -0 "$inherited_pid" 2>/dev/null; then
  kill -KILL "$inherited_pid" 2>/dev/null || true
  fail "inherited-pipe descendant survived the supervisor"
fi

# The old environment recursion marker cannot bypass the positional supervisor.
write_fake git '
printf "%s\n" "$$" >"$NORTH_TEST_CHILD_PID"
trap "" TERM
while :; do sleep 30; done
'
start_ms="$(date +%s%3N)"
NORTH_STOP_INNER=1 NORTH_TEST_CHILD_PID="$TMP/hostile-env.pid" invoke \
  "$input" "$TMP/hostile-env.out" "$TMP/hostile-env.err"
elapsed_ms=$(( $(date +%s%3N) - start_ms ))
[ "$elapsed_ms" -lt 2500 ] || fail "hostile env bypass took ${elapsed_ms}ms"
assert_empty "$TMP/hostile-env.out"
sleep 0.3
hostile_env_pid="$(cat "$TMP/hostile-env.pid")"
if kill -0 "$hostile_env_pid" 2>/dev/null; then
  kill -KILL "$hostile_env_pid" 2>/dev/null || true
  fail "hostile env bypass left a child"
fi

# A marker plus exact live listener allows. Missing listener emits one complete
# validated block object.
clear_fakes
write_fake git 'printf "%s\n" "$2"'
touch "$RUNTIME/north-delegated/$agent_id"
write_fake pgrep "printf '%s\n' '123 bb /north/north-listen.clj 7977 $agent_id --once'"
invoke "$input" "$TMP/listener.out" "$TMP/listener.err"
assert_empty "$TMP/listener.out"

write_fake pgrep 'exit 1'
invoke "$input" "$TMP/missing.out" "$TMP/missing.err"
assert_block "$TMP/missing.out" "$agent_id"

# An empty session id can still use a canonical, explicit North agent id.
ambient_id="session-stop-test-ambient"
touch "$RUNTIME/north-delegated/$ambient_id"
ambient_input="$(printf '{"cwd":"%s"}' "$TMP")"
NORTH_AGENT_ID="$ambient_id" invoke \
  "$ambient_input" "$TMP/ambient-id.out" "$TMP/ambient-id.err"
assert_block "$TMP/ambient-id.out" "$ambient_id"

# stop_hook_active is the first semantic allow and never reaches git/pgrep.
write_fake git 'printf called >"$NORTH_TEST_CALLED"; exit 1'
write_fake pgrep 'printf called >"$NORTH_TEST_CALLED"; exit 1'
active_input="$(printf '{"cwd":"%s","session_id":"%s","stop_hook_active":true}' "$TMP" "$session")"
NORTH_TEST_CALLED="$TMP/active-called" invoke \
  "$active_input" "$TMP/active.out" "$TMP/active.err"
assert_empty "$TMP/active.out"
[ ! -e "$TMP/active-called" ] || fail "stop_hook_active reached semantic subprocesses"

# A hung pgrep after a real marker also fails open and leaves no process behind.
write_fake git 'printf "%s\n" "$2"'
write_fake pgrep '
printf "%s\n" "$$" >"$NORTH_TEST_CHILD_PID"
trap "" TERM
while :; do sleep 30; done
'
start_ms="$(date +%s%3N)"
NORTH_TEST_CHILD_PID="$TMP/hung-pgrep.pid" invoke \
  "$input" "$TMP/hung-pgrep.out" "$TMP/hung-pgrep.err"
elapsed_ms=$(( $(date +%s%3N) - start_ms ))
[ "$elapsed_ms" -lt 3000 ] || fail "hung pgrep took ${elapsed_ms}ms"
assert_empty "$TMP/hung-pgrep.out"
sleep 0.3
hung_pgrep_pid="$(cat "$TMP/hung-pgrep.pid")"
if kill -0 "$hung_pgrep_pid" 2>/dev/null; then
  kill -KILL "$hung_pgrep_pid" 2>/dev/null || true
  fail "hung pgrep survived the supervisor"
fi

# Hostile cache text is never interpolated into a path, regex or JSON block.
clear_fakes
write_fake git 'printf "%s\n" "$2"'
write_fake pgrep 'exit 1'
printf '%s\n' 'bad"id' 'second-line' >"$RUNTIME/north-agent-ids/$session"
invoke "$input" "$TMP/hostile-cache.out" "$TMP/hostile-cache.err"
assert_empty "$TMP/hostile-cache.out"
printf '%s\n' "$agent_id" >"$RUNTIME/north-agent-ids/$session"

# Repeated concurrent missing-listener checks remain complete JSON objects; no
# partial writes or nonzero hook statuses emerge under ordinary contention.
for index in $(seq 1 20); do
  (
    env PATH="$FAKE:$BASE_PATH" XDG_RUNTIME_DIR="$RUNTIME" \
      "$HOOK" <<<"$input" >"$TMP/concurrent-$index.out" 2>"$TMP/concurrent-$index.err"
  ) &
done
wait
for index in $(seq 1 20); do
  [ ! -s "$TMP/concurrent-$index.err" ] || fail "concurrent run $index emitted stderr"
  assert_block "$TMP/concurrent-$index.out" "$agent_id"
done

printf 'north-on-stop-test: passed\n'
