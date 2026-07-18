#!/usr/bin/env bash
# End-to-end North/Fram corpus-identity fence. A coordinator serving log A must
# reject every North surface configured for log B, and neither file may change.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
fram="${FRAM_PATH:-$root/../fram}"
for required in "$fram/bin/fram" "$fram/bin/fram-daemon" "$fram/out/fram/rt.clj"; do
  [[ -e "$required" ]] || {
    echo "coord log fence test: missing Fram runtime: $required" >&2
    exit 2
  }
done

tmp="$(mktemp -d -t 'north log fence.XXXXXX')"
daemon_pid=
cleanup() {
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

mkdir -p "$tmp/served corpus" "$tmp/expected corpus" "$tmp/home" "$tmp/threads"
log_a="$tmp/served corpus/facts.log"
log_b="$tmp/expected corpus/facts.log"
: >"$log_a"
: >"$log_b"
cp "$log_a" "$tmp/log-a.before"
cp "$log_b" "$tmp/log-b.before"
port="$(bb -e '(with-open [s (java.net.ServerSocket. 0)] (println (.getLocalPort s)))')"

FRAM_REQUIRE_LOG_FENCE=1 FRAM_PORT="$port" FRAM_LOG="$log_a" \
  "$fram/bin/fram-daemon" "$port" "$log_a" \
  >"$tmp/daemon.out" 2>"$tmp/daemon.err" &
daemon_pid=$!

healthy=
for _ in $(seq 1 120); do
  doctor_output="$(
    HOME="$tmp/home" FRAM_PORT="$port" FRAM_LOG="$log_a" \
      "$fram/bin/fram" doctor 2>&1 || true
  )"
  if [[ "${doctor_output%%$'\n'*}" =~ ^coordinator\ UP\ on\ 127\.0\.0\.1:$port\ \(v[0-9]+\)$ ]]; then
    healthy=1
    break
  fi
  kill -0 "$daemon_pid" 2>/dev/null || break
  sleep 0.25
done
if [[ -z "$healthy" ]]; then
  cat "$tmp/daemon.err" >&2
  echo "coord log fence test: strict coordinator did not start" >&2
  exit 1
fi

strict_probe="$(
  HOME="$tmp/home" FRAM_LOG="$log_a" \
    bb "$root/cli/coord.clj" strict-probe "$port" "$log_a"
)"
grep -q ':ready true' <<<"$strict_probe"
grep -q ':version [0-9]' <<<"$strict_probe"

common_env=(
  HOME="$tmp/home"
  FRAM_HOME="$fram"
  FRAM_BIN="$fram/bin"
  FRAM_OUT="$fram/out"
  FRAM_PORT="$port"
  FRAM_LOG="$log_b"
  FRAM_THREADS="$tmp/threads"
)

shared_result="$(
  env "${common_env[@]}" NORTH_ROOT="$root" bb -e '
    (load-file (str (System/getenv "NORTH_ROOT") "/cli/coord.clj"))
    (prn (north.coord/append!
          (Integer/parseInt (System/getenv "FRAM_PORT"))
          "@shared-writer" "note" "must-not-land"))'
)"
grep -q ':code :log-mismatch' <<<"$shared_result"

capture_output="$(
  env "${common_env[@]}" "$root/bin/north" capture "must not land in either corpus" 2>&1
)"
grep -q 'writes won.t serialize' <<<"$capture_output"

tell_output="$(
  env "${common_env[@]}" "$root/bin/north" tell @wire-handle note must-not-land 2>&1
)"
grep -q 'REJECTED by coordinator.*different log' <<<"$tell_output"

set +e
env "${common_env[@]}" timeout 5 \
  bb "$root/cli/north-listen.clj" "$port" fence-probe --once \
  >"$tmp/listener.out" 2>&1
listener_rc=$?
set -e
[[ "$listener_rc" -ne 0 && "$listener_rc" -ne 124 ]]
grep -q 'refused the fenced subscription' "$tmp/listener.out"
if grep -q 'listening' "$tmp/listener.out"; then
  echo "coord log fence test: rejected listener announced itself as subscribed" >&2
  exit 1
fi

set +e
env "${common_env[@]}" timeout 3 \
  bb "$root/cli/north-reactor.clj" "$port" 100 \
  >"$tmp/reactor.out" 2>&1
reactor_rc=$?
set -e
[[ "$reactor_rc" -eq 124 ]]
grep -q 'subscription lost.*refused the fenced subscription' "$tmp/reactor.out"
reactor_retries="$(grep -c 'subscription lost' "$tmp/reactor.out")"
(( reactor_retries >= 1 && reactor_retries <= 4 ))

# Defense in depth: strict mode rejects a raw write even if a future North
# client accidentally bypasses the envelope.
raw_result="$(
  NORTH_TEST_PORT="$port" bb -e '
    (require (quote [clojure.edn :as edn]) (quote [clojure.java.io :as io]))
    (with-open [s (java.net.Socket. "127.0.0.1"
                                   (Integer/parseInt (System/getenv "NORTH_TEST_PORT")))]
      (let [w (.getOutputStream s) r (io/reader (.getInputStream s))]
        (.write w (.getBytes (str (pr-str {:op :assert
                                           :te "@raw-writer"
                                           :p "note"
                                           :r "must-not-land"}) "\n")))
        (.flush w)
        (prn (edn/read-string (.readLine r)))))'
)"
grep -q ':code :log-fence-required' <<<"$raw_result"

cmp "$tmp/log-a.before" "$log_a"
cmp "$tmp/log-b.before" "$log_b"
echo "coord log fence integration: PASS"
