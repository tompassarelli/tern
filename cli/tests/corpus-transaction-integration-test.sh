#!/usr/bin/env bash
# Real split-coordinator proof for the generic corpus transaction CLI: lease-only
# checkpoint, controlled restart, version non-regression, acknowledged-race
# preservation, and mixed-pair crash recovery all run against Fram's daemon.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
fram=${FRAM_PATH:-$root/../fram}
for required in "$root/bin/north" "$fram/bin/fram-daemon" "$fram/out/fram/rt.clj"; do
  [[ -e "$required" ]] || {
    printf 'corpus transaction integration: missing runtime: %s\n' "$required" >&2
    exit 2
  }
done

scratch=$(mktemp -d -t 'north-corpus-transaction.XXXXXX')
pid_file=$scratch/coordinator.pid
daemon_log=$scratch/coordinator.out
coord_log=$scratch/coordination.log
telemetry_log=$scratch/telemetry.log
state_dir=$scratch/transaction-state
plan_file=$scratch/plan.edn
launcher=$scratch/direct-controller
port=$(bb -e '(with-open [socket (java.net.ServerSocket. 0)] (println (.getLocalPort socket)))')

cleanup() {
  if [[ -s "$pid_file" ]]; then
    pid=$(<"$pid_file")
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.02
    done
  fi
  if [[ "${KEEP_CORPUS_TRANSACTION_SCRATCH:-0}" == 1 ]]; then
    printf 'kept corpus transaction scratch: %s\n' "$scratch" >&2
  else
    rm -rf "${scratch:?}"
  fi
}
trap cleanup EXIT

write_controller() {
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'probe() {' \
    '  TEST_ROOT="$TEST_ROOT" TEST_PORT="$FRAM_PORT" TEST_LOG="$FRAM_LOG" bb -cp "$FRAM_OUT" -e '\''(load-file (str (System/getenv "TEST_ROOT") "/cli/coord.clj")) (let [s (north.coord/strict-coordinator-status (parse-long (System/getenv "TEST_PORT")) (System/getenv "TEST_LOG"))] (when (:ready s) (println :ready)))'\'' 2>/dev/null' \
    '}' \
    'case "${1:-}" in' \
    '  --stop)' \
    '    if [[ "${INJECT_WRITE_ON_STOP:-0}" == 1 ]]; then' \
    '      TEST_ROOT="$TEST_ROOT" TEST_PORT="$FRAM_PORT" bb -cp "$FRAM_OUT" -e '\''(load-file (str (System/getenv "TEST_ROOT") "/cli/coord.clj")) (let [r (north.coord/append! (parse-long (System/getenv "TEST_PORT")) "@real-stop-race" "note" "acknowledged-before-stop")] (when-not (:ok r) (throw (ex-info "race write rejected" r))))'\''' \
    '    fi' \
    '    if [[ -s "$TEST_PID_FILE" ]]; then' \
    '      pid=$(<"$TEST_PID_FILE")' \
    '      kill "$pid" 2>/dev/null || true' \
    '      for _ in $(seq 1 200); do' \
    '        probe_output=$(probe || true)' \
    '        [[ "$probe_output" != :ready ]] || { sleep 0.02; continue; }' \
    '        break' \
    '      done' \
    '      if [[ "$(probe || true)" == :ready ]]; then exit 1; fi' \
    '      unlink "$TEST_PID_FILE"' \
    '    fi' \
    '    ;;' \
    '  "")' \
    '    if [[ "$(probe || true)" == :ready ]]; then exit 0; fi' \
    '    FRAM_REQUIRE_LOG_FENCE=1 nohup "$TEST_DAEMON" "$FRAM_PORT" "$FRAM_LOG" </dev/null >"$TEST_DAEMON_LOG" 2>&1 &' \
    '    pid=$!; printf "%s\n" "$pid" >"$TEST_PID_FILE"' \
    '    for _ in $(seq 1 200); do' \
    '      [[ "$(probe || true)" != :ready ]] || exit 0' \
    '      kill -0 "$pid" 2>/dev/null || exit 1' \
    '      sleep 0.05' \
    '    done' \
    '    exit 1' \
    '    ;;' \
    '  *) exit 2 ;;' \
    'esac' \
    >"$launcher"
  chmod 0755 "$launcher"
}

write_op() {
  local path=$1 tx=$2 subject=$3 predicate=$4 value=$5
  printf '{:tx %s, :op "assert", :l "%s", :p "%s", :r "%s", :by "integration"}\n' \
    "$tx" "$subject" "$predicate" "$value" >"$path"
}

make_plan() {
  local candidate_coord=$1 candidate_telemetry=$2
  TEST_ROOT=$root TEST_PLAN=$plan_file TEST_COORD=$coord_log \
  TEST_TELEMETRY=$telemetry_log TEST_CANDIDATE_COORD=$candidate_coord \
  TEST_CANDIDATE_TELEMETRY=$candidate_telemetry \
    bb -cp "$fram/out" -e '
      (load-file (str (System/getenv "TEST_ROOT") "/cli/corpus-transaction.clj"))
      (let [plan (north.corpus-transaction/make-plan
                  {:purpose "real-split-integration"
                   :live {:coordination (System/getenv "TEST_COORD")
                          :telemetry (System/getenv "TEST_TELEMETRY")}
                   :candidate {:coordination (System/getenv "TEST_CANDIDATE_COORD")
                               :telemetry (System/getenv "TEST_CANDIDATE_TELEMETRY")}
                   :target {}
                   :runtime {}})]
        (spit (System/getenv "TEST_PLAN") (str (pr-str plan) "\n"))
        (println (:plan-id plan)))'
}

coord_value() {
  local subject=$1 predicate=$2
  FRAM_LOG=$coord_log FRAM_TELEMETRY_LOG=$telemetry_log \
  TEST_ROOT=$root TEST_PORT=$port TEST_SUBJECT=$subject TEST_PREDICATE=$predicate \
    bb -cp "$fram/out" -e '
      (load-file (str (System/getenv "TEST_ROOT") "/cli/coord.clj"))
      (println (or (north.coord/resolved
                    (parse-long (System/getenv "TEST_PORT"))
                    (System/getenv "TEST_SUBJECT")
                    (System/getenv "TEST_PREDICATE")) ""))'
}

coord_version() {
  FRAM_LOG=$coord_log FRAM_TELEMETRY_LOG=$telemetry_log \
  TEST_ROOT=$root TEST_PORT=$port bb -cp "$fram/out" -e '
    (load-file (str (System/getenv "TEST_ROOT") "/cli/coord.clj"))
    (println (north.coord/cur-ver (parse-long (System/getenv "TEST_PORT"))))'
}

common_env=(
  HOME="$scratch/home"
  FRAM_HOME="$fram"
  FRAM_BIN="$fram/bin"
  FRAM_OUT="$fram/out"
  FRAM_LOG="$coord_log"
  FRAM_TELEMETRY_LOG="$telemetry_log"
  FRAM_PORT="$port"
  NORTH_PORT="$port"
  NORTH_CORPUS_CONTROLLER=direct
  NORTH_COORD_LAUNCHER="$launcher"
  NORTH_CORPUS_TRANSACTION_DIR="$state_dir"
  TEST_ROOT="$root"
  TEST_DAEMON="$fram/bin/fram-daemon"
  TEST_DAEMON_LOG="$daemon_log"
  TEST_PID_FILE="$pid_file"
)

mkdir -p "$scratch/home" "$state_dir"
write_controller
write_op "$coord_log" 1 @live-thread title live-before-transaction
write_op "$telemetry_log" 2 @live-run kind run
env "${common_env[@]}" "$launcher"
[[ $(coord_version) == 2 ]]

# All-new application: candidate watermark 1000 survives a real process bounce.
candidate_coord_1=$scratch/candidate-1-coordination.log
candidate_telemetry_1=$scratch/candidate-1-telemetry.log
write_op "$candidate_coord_1" 1000 @candidate-one title installed-one
write_op "$candidate_telemetry_1" 999 @candidate-run-one kind run
plan_id=$(make_plan "$candidate_coord_1" "$candidate_telemetry_1")
env "${common_env[@]}" "$root/bin/north" corpus-transaction \
  apply "$plan_file" --confirm-plan "$plan_id" >"$scratch/apply-one.out"
grep -q ':ok true' "$scratch/apply-one.out"
[[ $(coord_value @candidate-one title) == installed-one ]]
[[ $(coord_version) -ge 1000 ]]
[[ ! -e "$state_dir/active.edn" ]]

# A real acknowledged write inside the stop controller crosses the checkpoint.
# The transaction aborts, restarts, and keeps that exact write; candidate two is
# never served and the version cannot regress below the acknowledged append.
candidate_coord_2=$scratch/candidate-2-coordination.log
candidate_telemetry_2=$scratch/candidate-2-telemetry.log
write_op "$candidate_coord_2" 2000 @candidate-two title must-not-install
write_op "$candidate_telemetry_2" 1999 @candidate-run-two kind run
plan_id=$(make_plan "$candidate_coord_2" "$candidate_telemetry_2")
set +e
env "${common_env[@]}" INJECT_WRITE_ON_STOP=1 "$root/bin/north" corpus-transaction \
  apply "$plan_file" --confirm-plan "$plan_id" >"$scratch/apply-drift.out" 2>&1
drift_rc=$?
set -e
[[ "$drift_rc" -eq 1 ]]
grep -q ':aborted :source-drift' "$scratch/apply-drift.out"
[[ $(coord_value @real-stop-race note) == acknowledged-before-stop ]]
[[ $(coord_value @candidate-two title) == '' ]]
drift_version=$(coord_version)
[[ "$drift_version" -gt 1000 ]]
[[ ! -e "$state_dir/active.edn" ]]

# Crash after the first rename, discard builder sources, then recover offline.
# Immutable preimage objects restore the exact pre-crash split pair; a real boot
# and launcher settlement clear the exact lease and retain the version floor.
candidate_coord_3=$scratch/candidate-3-coordination.log
candidate_telemetry_3=$scratch/candidate-3-telemetry.log
write_op "$candidate_coord_3" 3000 @candidate-three title must-roll-back
write_op "$candidate_telemetry_3" 2999 @candidate-run-three kind run
plan_id=$(make_plan "$candidate_coord_3" "$candidate_telemetry_3")
set +e
env "${common_env[@]}" NORTH_CORPUS_TRANSACTION_FAIL_AFTER=coordination-renamed \
  "$root/bin/north" corpus-transaction apply "$plan_file" \
  --confirm-plan "$plan_id" >"$scratch/apply-crash.out" 2>&1
crash_rc=$?
set -e
[[ "$crash_rc" -eq 1 ]]
[[ -e "$state_dir/active.edn" ]]
if env "${common_env[@]}" TEST_ROOT=$root TEST_PORT=$port TEST_LOG=$coord_log \
     bb -cp "$fram/out" -e '
       (load-file (str (System/getenv "TEST_ROOT") "/cli/coord.clj"))
       (when (:ready (north.coord/strict-coordinator-status
                      (parse-long (System/getenv "TEST_PORT"))
                      (System/getenv "TEST_LOG")))
         (System/exit 1))'; then
  :
else
  printf 'coordinator remained online after crash boundary\n' >&2
  exit 1
fi
unlink "$candidate_coord_3"
unlink "$candidate_telemetry_3"
env "${common_env[@]}" "$root/bin/north" corpus-transaction recover --launcher \
  >"$scratch/recover.out"
grep -q ':data-result "rolled-back"' "$scratch/recover.out"
env "${common_env[@]}" "$launcher"
env "${common_env[@]}" "$root/bin/north" corpus-transaction settle --wait --launcher \
  >"$scratch/settle.out"
[[ ! -e "$state_dir/active.edn" ]]
[[ $(coord_value @real-stop-race note) == acknowledged-before-stop ]]
[[ $(coord_value @candidate-three title) == '' ]]
[[ $(coord_version) -ge "$drift_version" ]]

printf 'corpus transaction real split integration: PASS\n'
