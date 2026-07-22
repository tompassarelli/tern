#!/usr/bin/env bash
# Public wrapper semantics that require no live coordinator or corpus mutation.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
fram_origin=${FRAM_PATH:-$root/../fram}
scratch=$(mktemp -d -t north-snapshot-cli.XXXXXX)
fram=$scratch/fram
daemon_pid=
cleanup() {
  if [[ -n "$daemon_pid" ]]; then kill "$daemon_pid" 2>/dev/null || true; fi
  rm -rf "${scratch:?}"
}
trap cleanup EXIT

if git -C "$fram_origin" rev-parse --verify HEAD >/dev/null 2>&1; then
  git clone --quiet --shared "$fram_origin" "$fram"
else
  mkdir -p "$fram"
  cp -a "$fram_origin/." "$fram/"
fi

"$root/bin/north" help >"$scratch/help.out"
grep -q 'north snapshot create|verify|restore-plan' "$scratch/help.out"

set +e
"$root/bin/north" snapshot unknown >"$scratch/unknown.out" 2>&1
unknown_rc=$?
"$root/bin/north" snapshot verify fake --execute >"$scratch/verify-execute.out" 2>&1
verify_execute_rc=$?
"$root/bin/north" snapshot create --unknown >"$scratch/unknown-option.out" 2>&1
unknown_option_rc=$?
set -e

[[ "$unknown_rc" -eq 2 ]]
[[ "$verify_execute_rc" -eq 2 ]]
[[ "$unknown_option_rc" -eq 2 ]]
grep -q '^north snapshot: usage:' "$scratch/unknown.out"
grep -q 'verify is read-only' "$scratch/verify-execute.out"
grep -q 'unknown option' "$scratch/unknown-option.out"

for required in "$fram/bin/fram-daemon" "$fram/out/fram/rt.clj"; do
  [[ -e "$required" ]] || {
    printf 'snapshot CLI integration: missing Fram runtime: %s\n' "$required" >&2
    exit 2
  }
done

home=$scratch/home
state=$scratch/state
live=$scratch/live
store=$scratch/snapshots
coordination=$live/coordination.log
telemetry=$live/telemetry.log
runtime_state=$state/north/fram-runtime
runtime_generation=$runtime_state/generations/snapshot-cli-generation
runtime_identity=$runtime_generation/current.identity
runtime_file=$runtime_generation/active.runtime
launcher=$scratch/direct-controller
daemon_output=$scratch/daemon.out
port=$(bb -e '(with-open [socket (java.net.ServerSocket. 0)] (println (.getLocalPort socket)))')
mkdir -p "$home" "$runtime_generation" "$live"
printf '%s\n' '{:tx 1, :op "assert", :l "@thread", :p "title", :r "before", :frame "snapshot-cli-test"}' >"$coordination"
: >"$telemetry"
chmod 0600 "$coordination"
chmod 0660 "$telemetry"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$launcher"
chmod 0755 "$launcher"
if ! git -C "$fram" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "$fram" init -q
  git -C "$fram" add -A
  GIT_AUTHOR_NAME='snapshot cli test' \
  GIT_AUTHOR_EMAIL='snapshot-cli-test@invalid' \
  GIT_COMMITTER_NAME='snapshot cli test' \
  GIT_COMMITTER_EMAIL='snapshot-cli-test@invalid' \
    git -C "$fram" commit -q -m 'snapshot CLI detached Fram fixture'
fi
fram_source=$(cd "$fram" && pwd -P)
fram_daemon=$(cd "$(dirname "$fram/bin/fram-daemon")" && pwd -P)/$(basename "$fram/bin/fram-daemon")
fram_rev=$(git -C "$fram" rev-parse --verify HEAD)
fram_tree=$(git -C "$fram" rev-parse --verify 'HEAD^{tree}')
owner_token=$(bb -e '(println (str (java.util.UUID/randomUUID)))')
ln -s active/current "$runtime_state/current"
ln -s generations/snapshot-cli-generation "$runtime_state/active"
ln -s "$fram_source" "$runtime_generation/current"
printf '%s\n' \
  north-fram-runtime-v1 \
  checkout \
  "$fram_source" \
  "$fram_rev" \
  "$fram_tree" \
  "$fram_source" \
  "$fram_daemon" \
  >"$runtime_identity"
runtime_identity_sha=$(sha256sum "$runtime_identity" | cut -d' ' -f1)

common_env=(
  HOME="$home"
  XDG_STATE_HOME="$state"
  FRAM_HOME="$fram"
  FRAM_BIN="$fram/bin"
  FRAM_OUT="$fram/out"
  FRAM_LOG="$coordination"
  FRAM_TELEMETRY_LOG="$telemetry"
  FRAM_PORT="$port"
  NORTH_PORT="$port"
  NORTH_CORPUS_CONTROLLER=direct
  NORTH_COORD_LAUNCHER="$launcher"
  NORTH_COORD_RUNTIME_STATE="$runtime_state"
  NORTH_COORD_RUNTIME_GENERATION="$runtime_generation"
  NORTH_COORD_RUNTIME_IDENTITY="$runtime_identity"
  NORTH_COORD_RUNTIME_FILE="$runtime_file"
  NORTH_CORPUS_TRANSACTION_DIR="$scratch/transactions"
  NORTH_AUTHOR=snapshot-cli-test
)

NORTH_FRAM_RUNTIME=checkout \
NORTH_COORD_RUNTIME_STATE="$runtime_state" \
NORTH_COORD_RUNTIME_GENERATION="$runtime_generation" \
NORTH_COORD_RUNTIME_IDENTITY="$runtime_identity" \
NORTH_COORD_RUNTIME_FILE="$runtime_file" \
NORTH_COORD_SYSTEMD_UNIT=direct \
FRAM_REQUIRE_LOG_FENCE=1 FRAM_LOG="$coordination" \
  FRAM_TELEMETRY_LOG="$telemetry" FRAM_PORT="$port" \
  FRAM_RUNTIME_SOURCE="$fram_source" \
  FRAM_RUNTIME_REV="$fram_rev" \
  FRAM_RUNTIME_TREE="$fram_tree" \
  FRAM_RUNTIME_ORIGIN="$fram_source" \
  FRAM_RUNTIME_DAEMON="$fram_daemon" \
  FRAM_RUNTIME_OWNER_TOKEN="$owner_token" \
  "$fram/bin/fram-daemon" "$port" "$coordination" \
  >"$daemon_output" 2>&1 &
daemon_pid=$!
stat_line=$(<"/proc/$daemon_pid/stat")
stat_remainder=${stat_line##*) }
start_ticks=$(awk '{print $20}' <<<"$stat_remainder")
[[ "$start_ticks" =~ ^[0-9]+$ ]]
printf '%s\n' \
  'FORMAT=north-fram-active-runtime/v1' \
  "GENERATION=$runtime_generation" \
  "GENERATION_IDENTITY=$runtime_identity" \
  "GENERATION_IDENTITY_SHA256=$runtime_identity_sha" \
  'NORTH_FRAM_RUNTIME=checkout' \
  "FRAM_RUNTIME_SOURCE=$fram_source" \
  "FRAM_RUNTIME_REV=$fram_rev" \
  "FRAM_RUNTIME_TREE=$fram_tree" \
  "FRAM_RUNTIME_ORIGIN=$fram_source" \
  "FRAM_RUNTIME_DAEMON=$fram_daemon" \
  "FRAM_PORT=$port" \
  "FRAM_LOG=$coordination" \
  "FRAM_TELEMETRY_LOG=$telemetry" \
  "PID=$daemon_pid" \
  "PID_BIRTH=proc:$start_ticks" \
  "OWNER_TOKEN=$owner_token" \
  'CONTROLLER_UNIT=direct' \
  "CONTROLLER_MAIN_PID=$daemon_pid" \
  >"$runtime_file"
chmod 0600 "$runtime_file"

strict_ready() {
  TEST_ROOT="$root" TEST_PORT="$port" TEST_LOG="$coordination" \
    bb -cp "$fram/out" -e '
      (load-file (str (System/getenv "TEST_ROOT") "/cli/coord.clj"))
      (let [status (north.coord/strict-coordinator-status
                    (parse-long (System/getenv "TEST_PORT"))
                    (System/getenv "TEST_LOG"))]
        (when (:ready status) (println "ready")))' 2>/dev/null
}
for _ in $(seq 1 200); do
  [[ "$(strict_ready || true)" != ready ]] || break
  kill -0 "$daemon_pid" 2>/dev/null || {
    printf 'snapshot CLI disposable daemon exited:\n' >&2
    sed -n '1,80p' "$daemon_output" >&2
    exit 1
  }
  sleep 0.05
done
[[ "$(strict_ready || true)" == ready ]]

parse_field() {
  SNAPSHOT_RESULT="$1" SNAPSHOT_FIELD="$2" bb -e '
    (require (quote [clojure.edn :as edn]))
    (println (get (edn/read-string (System/getenv "SNAPSHOT_RESULT"))
                  (keyword (System/getenv "SNAPSHOT_FIELD"))))'
}

dry_run=$(env "${common_env[@]}" "$root/bin/north" snapshot create --store "$store")
[[ "$(parse_field "$dry_run" dry-run)" == true ]]
[[ ! -e "$store" ]]

created=$(env "${common_env[@]}" "$root/bin/north" snapshot create --store "$store" --execute)
snapshot_id=$(parse_field "$created" snapshot-id)
[[ "$snapshot_id" =~ ^snapshot-[0-9a-f]{64}$ ]]
[[ -d "$store/$snapshot_id" ]]
[[ $(stat -c '%a' "$store/$snapshot_id/coordination.log") == 600 ]]
[[ $(stat -c '%a' "$store/$snapshot_id/telemetry.log") == 660 ]]
[[ ! -s "$store/$snapshot_id/telemetry.log" ]]

verified=$(env "${common_env[@]}" "$root/bin/north" snapshot verify "$snapshot_id" --store "$store")
[[ "$(parse_field "$verified" ok)" == true ]]

TEST_ROOT="$root" TEST_PORT="$port" env "${common_env[@]}" \
  bb -cp "$fram/out" -e '
    (load-file (str (System/getenv "TEST_ROOT") "/cli/coord.clj"))
    (let [response (north.coord/append!
                    (parse-long (System/getenv "TEST_PORT"))
                    "@newer" "title" "after-snapshot")]
      (when-not (:ok response) (throw (ex-info "append failed" response))))'

coord_before=$(sha256sum "$coordination" | cut -d' ' -f1)
telem_before=$(sha256sum "$telemetry" | cut -d' ' -f1)
restore_dry=$(env "${common_env[@]}" "$root/bin/north" snapshot restore-plan "$snapshot_id" --store "$store")
[[ "$(parse_field "$restore_dry" dry-run)" == true ]]
[[ ! -e "$store/candidates" ]]
restore=$(env "${common_env[@]}" "$root/bin/north" snapshot restore-plan "$snapshot_id" --store "$store" --execute)
plan_path=$(parse_field "$restore" plan-path)
plan_id=$(parse_field "$restore" plan-id)
candidate_id=$(parse_field "$restore" candidate-id)
watermark=$(parse_field "$restore" watermark-tx)
[[ "$plan_id" =~ ^plan-[0-9a-f]{64}$ ]]
[[ "$candidate_id" =~ ^candidate-[0-9a-f]{64}$ ]]
[[ "$watermark" -gt 1 ]]
[[ -f "$plan_path" ]]
[[ "$coord_before" == "$(sha256sum "$coordination" | cut -d' ' -f1)" ]]
[[ "$telem_before" == "$(sha256sum "$telemetry" | cut -d' ' -f1)" ]]

TEST_ROOT="$root" TEST_PLAN="$plan_path" TEST_COORD="$coordination" \
TEST_TELEMETRY="$telemetry" TEST_SNAPSHOT="$snapshot_id" \
TEST_CANDIDATE="$candidate_id" \
  bb -cp "$fram/out" -e '
    (load-file (str (System/getenv "TEST_ROOT") "/cli/corpus-transaction.clj"))
    (let [snapshot-id (System/getenv "TEST_SNAPSHOT")
          candidate-id (System/getenv "TEST_CANDIDATE")
          plan (north.corpus-transaction/read-edn-file!
                "snapshot restore plan" (System/getenv "TEST_PLAN"))
          verified
          (north.corpus-transaction/verify-plan!
           plan {:coordination (System/getenv "TEST_COORD")
                 :telemetry (System/getenv "TEST_TELEMETRY")})
          expected
          {:format north.corpus-transaction/snapshot-restore-provenance-format
           :source_snapshot
           {:snapshot_id snapshot-id
            :manifest_sha256 (subs snapshot-id (count "snapshot-"))}
           :restore_candidate
           {:candidate_id candidate-id
            :manifest_sha256 (subs candidate-id (count "candidate-"))}}]
      (when-not (= expected (:provenance verified))
        (throw (ex-info "snapshot CLI restore provenance mismatch"
                        {:expected expected
                         :actual (:provenance verified)}))))' >/dev/null

cp -p "$runtime_file" "$scratch/runtime.saved"
sed 's/^FRAM_RUNTIME_REV=.*/FRAM_RUNTIME_REV=wrong-runtime/' \
  "$scratch/runtime.saved" >"$runtime_file"
set +e
env "${common_env[@]}" "$root/bin/north" snapshot verify "$snapshot_id" --store "$store" \
  >"$scratch/wrong-runtime.out" 2>&1
wrong_runtime_rc=$?
set -e
[[ "$wrong_runtime_rc" -eq 1 ]]
grep -Eq 'runtime (identity|revision/tree)' "$scratch/wrong-runtime.out"
cp -p "$scratch/runtime.saved" "$runtime_file"

cp -p "$launcher" "$scratch/launcher.saved"
printf '%s\n' '# changed identity' >>"$launcher"
set +e
env "${common_env[@]}" "$root/bin/north" snapshot verify "$snapshot_id" --store "$store" \
  >"$scratch/wrong-controller.out" 2>&1
wrong_controller_rc=$?
set -e
[[ "$wrong_controller_rc" -eq 1 ]]
grep -q 'controller identity does not match' "$scratch/wrong-controller.out"
cp -p "$scratch/launcher.saved" "$launcher"

printf 'snapshot CLI disposable integration: PASS\n'
