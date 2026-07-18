#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRAM="${FRAM_HOME:-$HOME/code/fram}"
TMP="$(mktemp -d)"
LOG="$TMP/facts.log"
DAEMON_LOG="$TMP/coordinator.log"
PID=""

cleanup() {
  if [[ -n "$PID" ]]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

: >"$LOG"
PORT=17970
while ss -tlnH "sport = :$PORT" 2>/dev/null | grep -q .; do
  PORT=$((PORT + 1))
done

FRAM_REQUIRE_LOG_FENCE=1 \
FRAM_SINGLE_VALUED="title exp_id arm task_id state tokens wall_s updated" \
  "$FRAM/bin/fram-daemon" "$PORT" "$LOG" >"$DAEMON_LOG" 2>&1 &
PID=$!

for _ in $(seq 1 160); do
  if ss -tlnH "sport = :$PORT" 2>/dev/null | grep -q .; then
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    cat "$DAEMON_LOG" >&2
    exit 1
  fi
  sleep 0.25
done
ss -tlnH "sport = :$PORT" 2>/dev/null | grep -q . || {
  cat "$DAEMON_LOG" >&2
  echo "arena seed test: coordinator did not listen" >&2
  exit 1
}

EXP="arena-seed-test-$$"
OUTPUT="$(
  FRAM_LOG="$LOG" FRAM_PORT=1 NORTH_PORT="$PORT" NORTH_ARENA_NO_SLEEP=1 \
    timeout 30s "$ROOT/bin/arena-seed" "$EXP"
)"
grep -Fq "done. control landed 3/5" <<<"$OUTPUT"

RESULT="$(
  FRAM_LOG="$LOG" NORTH_PORT="$PORT" \
    bb -cp "$ROOT/out" -e '
      (load-file (str (first *command-line-args*) "/cli/coord.clj"))
      (let [port (parse-long (second *command-line-args*))
            exp (nth *command-line-args* 2)]
        (println
          (pr-str
            [(north.coord/resolved port (str "@arena-" exp "-graph-4") "state")
             (north.coord/resolved port (str "@arena-" exp "-control-4") "state")
             (north.coord/resolved port (str "@arena-" exp "-control-2") "state")])) )' \
      "$ROOT" "$PORT" "$EXP"
)"
[[ "$RESULT" == '["green" "failed" "blocked"]' ]]

echo "arena seed test: PASS (strict fenced coordinator, NORTH_PORT precedence, no 60s delay)"
