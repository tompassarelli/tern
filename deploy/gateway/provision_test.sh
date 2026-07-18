#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PROVISION="$ROOT/deploy/gateway/provision.sh"
TMP="$(mktemp -d)"
STATE="$TMP/launcher-state"
FAKE_UP="$TMP/fake-north-coord-up"
FAKE_BB="$TMP/fake-bb"
FAKE_BIN="$TMP/fake-bin"
REAL_BB="$(command -v bb)"
REAL_CHMOD="$(command -v chmod)"
mkdir -p "$STATE" "$TMP/home" "$TMP/fram/bin"

cleanup() {
  if [[ -f "$STATE/all-pids" ]]; then
    while IFS= read -r pid; do
      [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill "$pid" 2>/dev/null || true
    done <"$STATE/all-pids"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

cat >"$FAKE_UP" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${PROVISION_TEST_STATE:?}"
: "${NORTH_COORD_PID_FILE:?}"
[[ "${FRAM_REQUIRE_LOG_FENCE:-}" == 1 ]]
[[ "$FRAM_LOG" == /* ]]
[[ "$NORTH_HOME" == /* ]]
[[ "$FRAM_HOME" == /* ]]
[[ "$FRAM_BIN" == "$FRAM_HOME/bin" ]]
[[ $# -eq 0 ]]
if readlink /proc/$$/fd/* 2>/dev/null |
   grep -qE '(lifecycle\.|tenants[.]edn.*[.]lock)'; then
  echo "fake launcher inherited a provisioning lock" >&2
  exit 52
fi

{
  printf 'FRAM_REQUIRE_LOG_FENCE=%s\n' "$FRAM_REQUIRE_LOG_FENCE"
  printf 'FRAM_PORT=%s\n' "$FRAM_PORT"
  printf 'FRAM_LOG=%s\n' "$FRAM_LOG"
  printf 'FRAM_BIN=%s\n' "$FRAM_BIN"
  printf 'NORTH_HOME=%s\n' "$NORTH_HOME"
  printf 'NORTH_COORD_PID_FILE=%s\n' "$NORTH_COORD_PID_FILE"
} >"$PROVISION_TEST_STATE/last-launch"
printf 'launch\n' >>"$PROVISION_TEST_STATE/launches"

if [[ "${PROVISION_TEST_FAIL_START:-0}" == 1 ]]; then
  exit 41
fi

nohup sleep 300 </dev/null >/dev/null 2>&1 &
pid=$!
(umask 077; printf '%s\n' "$pid" >"$NORTH_COORD_PID_FILE")
printf '%s\n' "$pid" >>"$PROVISION_TEST_STATE/all-pids"

# Simulate a concurrent creator winning after this process's absent preflight
# but before its atomic init. Provision must preserve that winner and stop only
# the coordinator it owns.
if [[ "${PROVISION_TEST_RACE_CREATE:-0}" == 1 ]]; then
  bb -e '
    (let [[path tenant] *command-line-args*]
      (spit path
            (str (pr-str
                   {tenant {:tokens #{(apply str (repeat 64 "a"))}
                            :coordinator-port 19991
                            :coordinator-log "/winner/facts.log"}})
                 "\n")))' \
    "$PROVISION_TEST_REGISTRY" "$PROVISION_TEST_RACE_TENANT"
fi

if [[ "${PROVISION_TEST_PAUSE_AFTER_PID:-0}" == 1 ]]; then
  sleep 2
fi
EOF
chmod +x "$FAKE_UP"

cat >"$FAKE_BB" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "$PROVISION_TEST_ROOT/cli/coord.clj" &&
      "${2:-}" == strict-probe ]]; then
  {
    printf 'port=%s\n' "${3:-}"
    printf 'log=%s\n' "${4:-}"
    printf 'FRAM_LOG=%s\n' "${FRAM_LOG:-}"
    printf 'NORTH_PORT=%s\n' "${NORTH_PORT:-}"
  } >"$PROVISION_TEST_STATE/last-probe"
  [[ "${PROVISION_TEST_PROBE_FAIL:-0}" != 1 ]]
  echo '{:ready true :version 1}'
  exit 0
fi
exec "$REAL_BB" "$@"
EOF
chmod +x "$FAKE_BB"

mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/chmod" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
target="${!#}"
if [[ -n "${PROVISION_TEST_SIGNAL_AFTER_PUBLISH_PATH:-}" &&
      "$target" == "$PROVISION_TEST_SIGNAL_AFTER_PUBLISH_PATH" &&
      ! -e "$PROVISION_TEST_STATE/post-publish-signaled" ]]; then
  : >"$PROVISION_TEST_STATE/post-publish-signaled"
  if [[ "${PROVISION_TEST_CORRUPT_AFTER_PUBLISH:-0}" == 1 ]]; then
    printf ' {}\n' >>"$target"
  fi
  kill -TERM "$PPID"
fi
exec "$REAL_CHMOD" "$@"
EOF
chmod +x "$FAKE_BIN/chmod"

REG_DIR="$TMP/registry dir \"quoted\""
REGISTRY="$REG_DIR/tenants.edn"
DATA_ROOT="$TMP/tenant data"
mkdir -p "$REG_DIR" "$DATA_ROOT"

common_env=(
  HOME="$TMP/home"
  FRAM_HOME="$TMP/fram"
  NORTH_HOME="$ROOT"
  NORTH_COORD_UP="$FAKE_UP"
  GATEWAY_TENANTS="$REGISTRY"
  NORTH_TENANT_ROOT="$DATA_ROOT"
  PROVISION_TEST_STATE="$STATE"
  PROVISION_TEST_ROOT="$ROOT"
  REAL_BB="$REAL_BB"
  REAL_CHMOD="$REAL_CHMOD"
)

run_provision() {
  env "${common_env[@]}" "$PROVISION" "$@"
}

free_port() {
  local port="$1"
  while ss -tlnH "sport = :$port" 2>/dev/null | grep -q .; do
    port=$((port + 1))
  done
  printf '%s\n' "$port"
}

wait_dead() {
  local pid="$1"
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

# A failed strict startup never publishes a route or an undisclosed token hash.
FAIL_REGISTRY="$TMP/start-failure/tenants.edn"
FAIL_ROOT="$TMP/start-failure/data"
mkdir -p "$(dirname "$FAIL_REGISTRY")" "$FAIL_ROOT"
FAIL_PORT="$(free_port 18310)"
if env "${common_env[@]}" \
  GATEWAY_TENANTS="$FAIL_REGISTRY" NORTH_TENANT_ROOT="$FAIL_ROOT" \
  PROVISION_TEST_FAIL_START=1 \
  "$PROVISION" startup-failure "$FAIL_PORT" >"$TMP/start-failure.out" 2>&1; then
  echo "provision test: startup failure returned success" >&2
  exit 1
fi
[[ ! -e "$FAIL_REGISTRY" ]]
grep -q 'registry was not changed' "$TMP/start-failure.out"

# Supervised deployments register only an already-running strict, same-log
# coordinator. A failed probe publishes nothing; a successful probe mints the
# route without invoking or claiming the standalone launcher.
REGISTER_REGISTRY="$TMP/register-existing/tenants.edn"
REGISTER_ROOT="$TMP/register-existing/data"
REGISTER_LOG="$TMP/register-existing/supervised/facts.log"
mkdir -p "$REGISTER_ROOT" "$(dirname "$REGISTER_LOG")"
: >"$REGISTER_LOG"
REGISTER_PORT="$(free_port 18315)"
if env "${common_env[@]}" \
  GATEWAY_TENANTS="$REGISTER_REGISTRY" NORTH_TENANT_ROOT="$REGISTER_ROOT" \
  NORTH_BB="$FAKE_BB" PROVISION_TEST_PROBE_FAIL=1 \
  "$PROVISION" register-existing supervised "$REGISTER_PORT" "$REGISTER_LOG" \
  >"$TMP/register-fail.out" 2>&1; then
  echo "provision test: failed strict existing probe was registered" >&2
  exit 1
fi
[[ ! -e "$REGISTER_REGISTRY" ]]

REGISTER_OUT="$(
  env "${common_env[@]}" \
    GATEWAY_TENANTS="$REGISTER_REGISTRY" NORTH_TENANT_ROOT="$REGISTER_ROOT" \
    NORTH_BB="$FAKE_BB" \
    "$PROVISION" register-existing supervised "$REGISTER_PORT" "$REGISTER_LOG"
)"
REGISTER_TOKEN="$(awk '/^  [0-9a-f]{64}$/ {print $1}' <<<"$REGISTER_OUT")"
REGISTER_HASH="$(printf '%s' "$REGISTER_TOKEN" | sha256sum | cut -d' ' -f1)"
grep -Fxq "port=$REGISTER_PORT" "$STATE/last-probe"
grep -Fxq "log=$(realpath -m -- "$REGISTER_LOG")" "$STATE/last-probe"
bb -e '
  (let [[path hash port log] *command-line-args*
        row (get (clojure.edn/read-string (slurp path)) "supervised")]
    (assert (= #{hash} (:tokens row)))
    (assert (= (parse-long port) (:coordinator-port row)))
    (assert (= log (:coordinator-log row))))' \
  "$REGISTER_REGISTRY" "$REGISTER_HASH" "$REGISTER_PORT" \
  "$(realpath -m -- "$REGISTER_LOG")"

# Successful create must use the strict North lifecycle surface, then atomically
# publish one canonical route/token generation with private modes.
PORT="$(free_port 18320)"
CREATE_OUT="$(run_provision acme "$PORT")"
TOKEN="$(awk '/^  [0-9a-f]{64}$/ {print $1}' <<<"$CREATE_OUT")"
[[ "$TOKEN" =~ ^[0-9a-f]{64}$ ]]
TOKEN_HASH="$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)"
LOG="$(realpath -m -- "$DATA_ROOT/acme/facts.log")"
PID_FILE="$DATA_ROOT/acme/coordinator.pid"
IFS= read -r CREATED_PID <"$PID_FILE"
kill -0 "$CREATED_PID"

grep -Fxq 'FRAM_REQUIRE_LOG_FENCE=1' "$STATE/last-launch"
grep -Fxq "FRAM_PORT=$PORT" "$STATE/last-launch"
grep -Fxq "FRAM_LOG=$LOG" "$STATE/last-launch"
grep -Fxq "NORTH_HOME=$ROOT" "$STATE/last-launch"
grep -Fxq "NORTH_COORD_PID_FILE=$PID_FILE" "$STATE/last-launch"

bb -e '
  (let [[path token-hash port log] *command-line-args*
        registry (clojure.edn/read-string (slurp path))
        row (get registry "acme")]
    (assert (= #{token-hash} (:tokens row)))
    (assert (= (parse-long port) (:coordinator-port row)))
    (assert (= log (:coordinator-log row))))' \
  "$REGISTRY" "$TOKEN_HASH" "$PORT" "$LOG"
[[ "$(stat -c '%a' "$REGISTRY")" == 600 ]]
[[ "$(stat -c '%a' "$REGISTRY.lock")" == 600 ]]
[[ "$(stat -c '%a' "$DATA_ROOT/acme")" == 700 ]]
[[ "$(stat -c '%a' "$LOG")" == 600 ]]
[[ "$(stat -c '%a' "$PID_FILE")" == 600 ]]

kill "$CREATED_PID"
wait_dead "$CREATED_PID"

# Existing tenants fail before launch and remain byte-identical. Rotate/revoke
# are the only supported token mutations.
REGISTRY_HASH="$(sha256sum "$REGISTRY" | cut -d' ' -f1)"
LAUNCH_COUNT="$(wc -l <"$STATE/launches")"
if run_provision acme "$(free_port 18330)" >"$TMP/existing.out" 2>&1; then
  echo "provision test: existing tenant was reinitialized" >&2
  exit 1
fi
[[ "$REGISTRY_HASH" == "$(sha256sum "$REGISTRY" | cut -d' ' -f1)" ]]
[[ "$LAUNCH_COUNT" == "$(wc -l <"$STATE/launches")" ]]
grep -q 'already registered; use rotate or revoke' "$TMP/existing.out"

# Two real create commands for one absent tenant share a lifecycle lock across
# preflight, strict startup, and publication. Exactly one may launch/publish;
# the loser observes the committed row before touching the shared PID/log.
CONCURRENT_REGISTRY="$TMP/concurrent-create/tenants.edn"
CONCURRENT_ROOT="$TMP/concurrent-create/data"
mkdir -p "$(dirname "$CONCURRENT_REGISTRY")" "$CONCURRENT_ROOT"
CONCURRENT_LAUNCHES_BEFORE="$(wc -l <"$STATE/launches")"
CC_PORT_A="$(free_port 18335)"
CC_PORT_B="$(free_port 18336)"
(
  set +e
  timeout 15s env "${common_env[@]}" \
    GATEWAY_TENANTS="$CONCURRENT_REGISTRY" NORTH_TENANT_ROOT="$CONCURRENT_ROOT" \
    "$PROVISION" one-winner "$CC_PORT_A" >"$TMP/create-a.out" 2>&1
  printf '%s\n' "$?" >"$TMP/create-a.rc"
) &
CC_A=$!
(
  set +e
  timeout 15s env "${common_env[@]}" \
    GATEWAY_TENANTS="$CONCURRENT_REGISTRY" NORTH_TENANT_ROOT="$CONCURRENT_ROOT" \
    "$PROVISION" one-winner "$CC_PORT_B" >"$TMP/create-b.out" 2>&1
  printf '%s\n' "$?" >"$TMP/create-b.rc"
) &
CC_B=$!
wait "$CC_A" || true
wait "$CC_B" || true
RC_A="$(<"$TMP/create-a.rc")"
RC_B="$(<"$TMP/create-b.rc")"
[[ "$RC_A" -ne 124 && "$RC_B" -ne 124 ]]
if ! { [[ "$RC_A" -eq 0 && "$RC_B" -ne 0 ]] ||
       [[ "$RC_A" -ne 0 && "$RC_B" -eq 0 ]]; }; then
  echo "provision test: concurrent creates did not produce exactly one winner" >&2
  exit 1
fi
[[ "$((CONCURRENT_LAUNCHES_BEFORE + 1))" == "$(wc -l <"$STATE/launches")" ]]
CC_PID_FILE="$CONCURRENT_ROOT/one-winner/coordinator.pid"
IFS= read -r CC_PID <"$CC_PID_FILE"
kill -0 "$CC_PID"
bb -e '
  (let [row (get (clojure.edn/read-string (slurp (first *command-line-args*)))
                 "one-winner")]
    (assert (= 1 (count (:tokens row))))
    (assert (contains? #{(parse-long (second *command-line-args*))
                         (parse-long (nth *command-line-args* 2))}
                       (:coordinator-port row))))' \
  "$CONCURRENT_REGISTRY" "$CC_PORT_A" "$CC_PORT_B"
kill "$CC_PID"
wait_dead "$CC_PID"

# If another creator wins between preflight and init, preserve its exact row,
# stop this process's unpublished coordinator, and never compensate by deleting
# concurrent state.
RACE_REGISTRY="$TMP/race/tenants.edn"
RACE_ROOT="$TMP/race/data"
mkdir -p "$(dirname "$RACE_REGISTRY")" "$RACE_ROOT"
RACE_PORT="$(free_port 18340)"
if env "${common_env[@]}" \
  GATEWAY_TENANTS="$RACE_REGISTRY" NORTH_TENANT_ROOT="$RACE_ROOT" \
  PROVISION_TEST_RACE_CREATE=1 PROVISION_TEST_REGISTRY="$RACE_REGISTRY" \
  PROVISION_TEST_RACE_TENANT=race-winner \
  "$PROVISION" race-winner "$RACE_PORT" >"$TMP/race.out" 2>&1; then
  echo "provision test: concurrent init winner was overwritten" >&2
  exit 1
fi
RACE_PID="$(tail -n 1 "$STATE/all-pids")"
wait_dead "$RACE_PID"
bb -e '
  (let [row (get (clojure.edn/read-string (slurp (first *command-line-args*)))
                 "race-winner")]
    (assert (= 19991 (:coordinator-port row)))
    (assert (= "/winner/facts.log" (:coordinator-log row)))
    (assert (= #{(apply str (repeat 64 "a"))} (:tokens row))))' \
  "$RACE_REGISTRY"
grep -q 'stopped the unpublished coordinator' "$TMP/race.out"

# TERM while the strict launcher owns a PID but before publication runs the
# armed EXIT cleanup: no registry row and no orphaned daemon survive.
INT_REGISTRY="$TMP/interrupted/tenants.edn"
INT_ROOT="$TMP/interrupted/data"
mkdir -p "$(dirname "$INT_REGISTRY")" "$INT_ROOT"
INT_PORT="$(free_port 18350)"
env "${common_env[@]}" \
  GATEWAY_TENANTS="$INT_REGISTRY" NORTH_TENANT_ROOT="$INT_ROOT" \
  PROVISION_TEST_PAUSE_AFTER_PID=1 \
  "$PROVISION" interrupted "$INT_PORT" >"$TMP/interrupted.out" 2>&1 &
INT_PROVISION_PID=$!
INT_PID_FILE="$INT_ROOT/interrupted/coordinator.pid"
for _ in $(seq 1 100); do
  [[ -s "$INT_PID_FILE" ]] && break
  sleep 0.02
done
[[ -s "$INT_PID_FILE" ]]
IFS= read -r INT_COORD_PID <"$INT_PID_FILE"
kill -TERM "$INT_PROVISION_PID"
wait "$INT_PROVISION_PID" 2>/dev/null || true
wait_dead "$INT_COORD_PID"
[[ ! -e "$INT_REGISTRY" ]]
[[ ! -e "$INT_PID_FILE" ]]

# TERM can also arrive after the registry's atomic rename but before the shell
# marks publication complete. The EXIT guard re-reads the exact route/token and
# leaves its now-published coordinator alive instead of creating a dead route.
POST_REGISTRY="$TMP/post-publish/tenants.edn"
POST_ROOT="$TMP/post-publish/data"
mkdir -p "$(dirname "$POST_REGISTRY")" "$POST_ROOT"
POST_PORT="$(free_port 18360)"
rm -f "$STATE/post-publish-signaled"
set +e
timeout 15s env "${common_env[@]}" \
  PATH="$FAKE_BIN:$PATH" \
  GATEWAY_TENANTS="$POST_REGISTRY" NORTH_TENANT_ROOT="$POST_ROOT" \
  PROVISION_TEST_SIGNAL_AFTER_PUBLISH_PATH="$POST_REGISTRY" \
  "$PROVISION" post-publish "$POST_PORT" >"$TMP/post-publish.out" 2>&1
POST_RC=$?
set -e
[[ "$POST_RC" -ne 0 && "$POST_RC" -ne 124 ]]
[[ -e "$STATE/post-publish-signaled" && -s "$POST_REGISTRY" ]]
POST_PID_FILE="$POST_ROOT/post-publish/coordinator.pid"
IFS= read -r POST_COORD_PID <"$POST_PID_FILE"
kill -0 "$POST_COORD_PID"
bb -e '
  (let [row (get (clojure.edn/read-string (slurp (first *command-line-args*)))
                 "post-publish")]
    (assert (= (parse-long (second *command-line-args*))
               (:coordinator-port row)))
    (assert (= 1 (count (:tokens row)))))' \
  "$POST_REGISTRY" "$POST_PORT"
kill "$POST_COORD_PID"
wait_dead "$POST_COORD_PID"

# An expected-looking first form followed by trailing EDN is not a published
# registry generation: the exact parser rejects it and cleanup stops the
# unpublished coordinator.
BAD_POST_REGISTRY="$TMP/post-publish-trailing/tenants.edn"
BAD_POST_ROOT="$TMP/post-publish-trailing/data"
mkdir -p "$(dirname "$BAD_POST_REGISTRY")" "$BAD_POST_ROOT"
BAD_POST_PORT="$(free_port 18370)"
rm -f "$STATE/post-publish-signaled"
set +e
timeout 15s env "${common_env[@]}" \
  PATH="$FAKE_BIN:$PATH" \
  GATEWAY_TENANTS="$BAD_POST_REGISTRY" NORTH_TENANT_ROOT="$BAD_POST_ROOT" \
  PROVISION_TEST_SIGNAL_AFTER_PUBLISH_PATH="$BAD_POST_REGISTRY" \
  PROVISION_TEST_CORRUPT_AFTER_PUBLISH=1 \
  "$PROVISION" trailing-publish "$BAD_POST_PORT" \
  >"$TMP/post-publish-trailing.out" 2>&1
BAD_POST_RC=$?
set -e
[[ "$BAD_POST_RC" -ne 0 && "$BAD_POST_RC" -ne 124 && -s "$BAD_POST_REGISTRY" ]]
BAD_POST_PID_FILE="$BAD_POST_ROOT/trailing-publish/coordinator.pid"
BAD_POST_COORD_PID="$(tail -n 1 "$STATE/all-pids")"
wait_dead "$BAD_POST_COORD_PID"
[[ ! -e "$BAD_POST_PID_FILE" ]]

# Invalid shape and injection-shaped input fail without changing the registry or
# reaching the launcher. A quote-bearing registry path already exercised the
# safe argv boundary on every successful mutation above.
BAD_EXACT="$TMP/bad-exact.edn"
printf '{} {}\n' >"$BAD_EXACT"
BAD_HASH="$(sha256sum "$BAD_EXACT" | cut -d' ' -f1)"
if env "${common_env[@]}" GATEWAY_TENANTS="$BAD_EXACT" \
  "$PROVISION" rotate acme >"$TMP/bad-exact.out" 2>&1; then
  echo "provision test: trailing EDN form was accepted" >&2
  exit 1
fi
[[ "$BAD_HASH" == "$(sha256sum "$BAD_EXACT" | cut -d' ' -f1)" ]]

BAD_ROOT="$TMP/bad-root.edn"
printf '[]\n' >"$BAD_ROOT"
if env "${common_env[@]}" GATEWAY_TENANTS="$BAD_ROOT" \
  "$PROVISION" rotate acme >"$TMP/bad-root.out" 2>&1; then
  echo "provision test: non-map registry root was accepted" >&2
  exit 1
fi

PWNED="$TMP/interpolation-pwned"
PAYLOAD="bad\";(spit \"$PWNED\" \"yes\")"
if run_provision rotate "$PAYLOAD" >"$TMP/injection.out" 2>&1; then
  echo "provision test: injection-shaped tenant was accepted" >&2
  exit 1
fi
[[ ! -e "$PWNED" ]]

# Concurrent rotations serialize around one exact registry snapshot: every
# token survives, proving the lock closes lost-update races.
ROTATIONS=8
pids=()
for i in $(seq 1 "$ROTATIONS"); do
  timeout 15s env "${common_env[@]}" "$PROVISION" rotate acme \
    >"$TMP/rotate-$i.out" 2>"$TMP/rotate-$i.err" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do
  wait "$pid"
done

rotation_hashes=("$TOKEN_HASH")
for i in $(seq 1 "$ROTATIONS"); do
  token="$(awk '/^  [0-9a-f]{64}$/ {print $1}' "$TMP/rotate-$i.out")"
  rotation_hashes+=("$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)")
done
bb -e '
  (let [registry (clojure.edn/read-string (slurp (first *command-line-args*)))
        expected (set (rest *command-line-args*))
        actual (get-in registry ["acme" :tokens])]
    (assert (= expected actual)))' \
  "$REGISTRY" "${rotation_hashes[@]}"

echo "provision tests: PASS (strict transaction, validation, modes, injection safety, concurrent rotation)"
