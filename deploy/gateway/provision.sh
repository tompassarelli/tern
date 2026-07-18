#!/usr/bin/env bash
# Tenant lifecycle for the North gateway. Tokens are stored HASHED (sha-256);
# the plaintext is printed ONCE. Rotation keeps the old token valid until you
# revoke it, so clients can roll over with no downtime.
#
#   ./provision.sh <tenant> [coordinator-port]   create: mint token, start coordinator, register
#   ./provision.sh register-existing <tenant> <port> <absolute-log-path>
#                                                   register an already supervised strict coordinator
#   ./provision.sh rotate <tenant>               mint a NEW token (old stays valid until revoked)
#   ./provision.sh revoke <tenant> <token>       drop a token (give the plaintext you're retiring)
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
FRAM="${FRAM_HOME:-${HOME:?HOME must be set when FRAM_HOME is unset}/code/fram}"
NORTH="${NORTH_HOME:-$(cd "$HERE/../.." && pwd -P)}"
COORD_UP="${NORTH_COORD_UP:-$NORTH/bin/north-coord-up}"
NORTH_BB="${NORTH_BB:-bb}"
REGISTRY="${GATEWAY_TENANTS:-$HERE/tenants.edn}"
DATA_ROOT="${NORTH_TENANT_ROOT:-${HOME:?HOME must be set when NORTH_TENANT_ROOT is unset}/.local/state/north/tenants}"

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 1
}
mint_token() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
hash_token() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
die() { echo "provision: $*" >&2; exit 1; }
validate_tenant() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{0,62}$ ]] ||
    die "tenant must match ^[a-z][a-z0-9-]{0,62}$"
}
validate_port() {
  if ! [[ "$1" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$1 > 65535 )); then
    die "coordinator port must be an integer from 1 through 65535"
  fi
}
canonical_absolute() {
  [[ "$1" == /* ]] || die "$2 must be absolute: $1"
  realpath -m -- "$1"
}

REGISTRY="$(canonical_absolute "$REGISTRY" GATEWAY_TENANTS)"
DATA_ROOT="$(canonical_absolute "$DATA_ROOT" NORTH_TENANT_ROOT)"
FRAM="$(canonical_absolute "$FRAM" FRAM_HOME)"
NORTH="$(canonical_absolute "$NORTH" NORTH_HOME)"
COORD_UP="$(canonical_absolute "$COORD_UP" NORTH_COORD_UP)"
mkdir -p -- "$(dirname "$REGISTRY")" "$DATA_ROOT"
[[ -x "$COORD_UP" ]] || die "North strict coordinator launcher is not executable: $COORD_UP"
for command in bb flock realpath sha256sum ss; do
  command -v "$command" >/dev/null 2>&1 || die "required command is unavailable: $command"
done
if [[ "$NORTH_BB" != */* ]]; then
  NORTH_BB="$(command -v "$NORTH_BB" 2>/dev/null || true)"
fi
[[ -x "$NORTH_BB" ]] || die "North coordinator probe runtime is not executable: $NORTH_BB"

# Upsert tenant field(s) in the EDN registry (bb keeps it valid EDN). The write is
# ATOMIC: bb spits a temp file, then `mv` renames it over the registry (same dir =
# rename(2)), so a concurrently-reloading gateway sees the OLD or the NEW file,
# never a truncated/partial one. A lock also prevents two lifecycle commands
# from both reading the same old snapshot and losing one update. `init` sets the
# port, canonical corpus identity, and token in one registry generation.
# All data crosses the bb boundary as argv, never interpolated Clojure source.
#   reg_edit <tenant> <add-token|remove-token> <token-hash>
#   reg_edit <tenant> init <port> <token-hash> <absolute-log-path>
reg_edit() {
  local tenant="$1" operation="$2" value="${3:-}" token_hash="${4:-}" log_path="${5:-}"
  local tmp lock_file="$REGISTRY.lock"
  tmp="$(mktemp "$REGISTRY.tmp.XXXXXX")"
  chmod 0600 "$tmp"

  exec 9>"$lock_file"
  flock 9
  if ! bb -e '
    (require (quote [clojure.edn :as edn])
             (quote [clojure.java.io :as io])
             (quote [clojure.pprint :as pp]))
    (let [[registry-path tmp-path tenant operation value token-hash log-path]
          *command-line-args*
          read-exact
          (fn [text]
            (with-open [reader (java.io.PushbackReader.
                                (java.io.StringReader. text))]
              (let [eof (Object.)
                    form (edn/read {:eof eof} reader)
                    trailing (edn/read {:eof eof} reader)]
                (when (or (identical? eof form)
                          (not (identical? eof trailing)))
                  (throw (ex-info "registry must contain exactly one EDN form" {})))
                form)))
          registry-file (io/file registry-path)
          registry (if (.exists registry-file)
                     (read-exact (slurp registry-file))
                     {})
          _ (when-not (map? registry)
              (throw (ex-info "registry root must be a map" {})))
          existing? (contains? registry tenant)
          current (get registry tenant {})
          _ (when-not (map? current)
              (throw (ex-info "tenant entry must be a map" {:tenant tenant})))
          _ (when (and (#{"add-token" "remove-token"} operation)
                       (not existing?))
              (throw (ex-info "tenant is not registered" {:tenant tenant})))
          _ (when (and (= "init" operation) existing?)
              (throw (ex-info "tenant is already registered; use rotate or revoke"
                              {:tenant tenant})))
          token-set
          (fn [entry]
            (let [tokens (:tokens entry)
                  legacy (:token-sha256 entry)]
              (when-not (or (nil? tokens) (set? tokens))
                (throw (ex-info ":tokens must be a set" {:tenant tenant})))
              (when-not (or (nil? legacy) (string? legacy))
                (throw (ex-info ":token-sha256 must be a string" {:tenant tenant})))
              (into (or tokens #{}) (when legacy [legacy]))))
          updated
          (case operation
            "add-token"
            (-> current
                (assoc :tokens (conj (token-set current) value))
                (dissoc :token-sha256))

            "remove-token"
            (-> current
                (assoc :tokens (disj (token-set current) value))
                (dissoc :token-sha256))

            "init"
            (-> current
                (assoc :coordinator-port (Integer/parseInt value))
                (assoc :coordinator-log log-path)
                (assoc :tokens (conj (token-set current) token-hash))
                (dissoc :token-sha256))

            (throw (ex-info "unsupported registry operation" {:operation operation})))]
      (spit tmp-path (with-out-str (pp/pprint (assoc registry tenant updated)))))' \
      "$REGISTRY" "$tmp" "$tenant" "$operation" "$value" "$token_hash" "$log_path"; then
    rm -f -- "$tmp"
    flock -u 9
    return 1
  fi
  mv -f -- "$tmp" "$REGISTRY"
  chmod 0600 "$REGISTRY"
  flock -u 9
}

tenant_must_be_absent() {
  local tenant="$1" lock_file="$REGISTRY.lock"
  exec 9>"$lock_file"
  flock 9
  if ! bb -e '
    (require (quote [clojure.edn :as edn])
             (quote [clojure.java.io :as io]))
    (let [[registry-path tenant] *command-line-args*
          registry-file (io/file registry-path)
          registry
          (if (.exists registry-file)
            (with-open [reader (java.io.PushbackReader.
                                (java.io.StringReader. (slurp registry-file)))]
              (let [eof (Object.)
                    form (edn/read {:eof eof} reader)
                    trailing (edn/read {:eof eof} reader)]
                (when (or (identical? eof form)
                          (not (identical? eof trailing))
                          (not (map? form)))
                  (throw (ex-info "registry must contain exactly one EDN map" {})))
                form))
            {})]
      (when (contains? registry tenant)
        (throw (ex-info "tenant is already registered; use rotate or revoke"
                        {:tenant tenant}))))' \
      "$REGISTRY" "$tenant"; then
    flock -u 9
    exec 9>&-
    return 1
  fi
  flock -u 9
  exec 9>&-
}

LIFECYCLE_FD=7
acquire_tenant_lifecycle() {
  local tenant="$1"
  local lock_file="$REGISTRY.lifecycle.$tenant.lock"
  exec 7>"$lock_file"
  flock "$LIFECYCLE_FD"
}

strict_probe_existing() {
  local port="$1" log="$2" output
  if ! output="$(
    FRAM_LOG="$log" NORTH_PORT="$port" \
      "$NORTH_BB" "$NORTH/cli/coord.clj" strict-probe "$port" "$log" 2>&1
  )"; then
    printf '%s\n' "$output" >&2
    return 1
  fi
}

stop_owned_coordinator() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
}

UNPUBLISHED_COORD_PID=
UNPUBLISHED_PID_FILE=
COORDINATOR_PUBLISHED=0
PENDING_TENANT=
PENDING_PORT=
PENDING_LOG=
PENDING_TOKEN_HASH=
pending_route_is_published() {
  [[ -n "$PENDING_TENANT" && -n "$PENDING_PORT" &&
     -n "$PENDING_LOG" && -n "$PENDING_TOKEN_HASH" ]] || return 1
  local lock_file="$REGISTRY.lock"
  local rc=0
  exec 8>"$lock_file"
  flock 8
  bb -e '
    (require (quote [clojure.edn :as edn]))
    (let [[path tenant port log token-hash] *command-line-args*
          read-exact
          (fn [text]
            (with-open [reader (java.io.PushbackReader.
                                (java.io.StringReader. text))]
              (let [eof (Object.)
                    form (edn/read {:eof eof} reader)
                    trailing (edn/read {:eof eof} reader)]
                (when (or (identical? eof form)
                          (not (identical? eof trailing)))
                  (throw (ex-info "registry must contain exactly one EDN form" {})))
                form)))]
      (try
        (let [registry (read-exact (slurp path))
              row (get registry tenant)]
          (if (and (map? registry)
                   (map? row)
                   (= (parse-long port) (:coordinator-port row))
                   (= log (:coordinator-log row))
                   (contains? (or (:tokens row) #{}) token-hash))
            (System/exit 0)
            (System/exit 1)))
        (catch Throwable _
          (System/exit 1))))' \
    "$REGISTRY" "$PENDING_TENANT" "$PENDING_PORT" "$PENDING_LOG" "$PENDING_TOKEN_HASH" ||
    rc=$?
  flock -u 8
  return "$rc"
}

cleanup_unpublished_coordinator() {
  local pid="$UNPUBLISHED_COORD_PID"
  trap '' INT TERM
  if [[ "$COORDINATOR_PUBLISHED" -eq 0 ]]; then
    # A signal may be delivered after reg_edit's atomic rename but before that
    # function reaches its explicit unlock. Release our own registry FD before
    # the exact publication check opens FD8, or cleanup deadlocks on itself.
    flock -u 9 2>/dev/null || true
    exec 9>&-
    if pending_route_is_published; then
      COORDINATOR_PUBLISHED=1
      return 0
    fi
    if [[ -z "$pid" && -n "$UNPUBLISHED_PID_FILE" && -r "$UNPUBLISHED_PID_FILE" ]]; then
      IFS= read -r pid <"$UNPUBLISHED_PID_FILE" || pid=
    fi
    [[ -z "$pid" ]] || stop_owned_coordinator "$pid"
    [[ -z "$UNPUBLISHED_PID_FILE" ]] || rm -f -- "$UNPUBLISHED_PID_FILE"
  fi
}

[ $# -ge 1 ] || usage
case "$1" in
  rotate)
    [ $# -eq 2 ] || usage
    TENANT="$2"
    validate_tenant "$TENANT"
    acquire_tenant_lifecycle "$TENANT"
    TOKEN="$(mint_token)"; reg_edit "$TENANT" add-token "$(hash_token "$TOKEN")"
    echo "rotated tenant '$TENANT' — NEW token (old stays valid until you revoke it):"
    echo "  $TOKEN" ;;
  revoke)
    [ $# -eq 3 ] || usage
    TENANT="$2"
    OLD="$3"
    validate_tenant "$TENANT"
    [[ -n "$OLD" ]] || die "token to revoke must not be empty"
    acquire_tenant_lifecycle "$TENANT"
    reg_edit "$TENANT" remove-token "$(hash_token "$OLD")"
    echo "revoked a token for tenant '$TENANT'." ;;
  register-existing)
    [ $# -eq 4 ] || usage
    TENANT="$2"
    PORT="$3"
    LOG="$4"
    validate_tenant "$TENANT"
    validate_port "$PORT"
    LOG="$(canonical_absolute "$LOG" coordinator-log)"
    acquire_tenant_lifecycle "$TENANT"
    tenant_must_be_absent "$TENANT" ||
      die "registry preflight failed; existing tenant was not changed"
    strict_probe_existing "$PORT" "$LOG" ||
      die "existing coordinator failed strict same-log readiness; registry was not changed"
    TOKEN="$(mint_token)"
    reg_edit "$TENANT" init "$PORT" "$(hash_token "$TOKEN")" "$LOG"
    echo "registered strict existing coordinator for tenant '$TENANT'  port=$PORT  log=$LOG"
    echo "TOKEN (shown once — store it now; only the hash is kept):"
    echo "  $TOKEN" ;;
  *)
    [ $# -le 2 ] || usage
    TENANT="$1"
    PORT="${2:-}"
    validate_tenant "$TENANT"
    acquire_tenant_lifecycle "$TENANT"
    tenant_must_be_absent "$TENANT" ||
      die "registry preflight failed; no coordinator was started"
    if [ -z "$PORT" ]; then
      PORT=7800
      while ss -tlnH "sport = :$PORT" 2>/dev/null | grep -q .; do PORT=$((PORT+1)); done
    fi
    validate_port "$PORT"
    if ss -tlnH "sport = :$PORT" 2>/dev/null | grep -q .; then
      die "coordinator port $PORT is already in use"
    fi
    TDIR="$DATA_ROOT/$TENANT"
    mkdir -p -- "$TDIR"
    chmod 0700 "$TDIR"
    LOG="$(canonical_absolute "$TDIR/facts.log" coordinator-log)"
    touch "$LOG"
    chmod 0600 "$LOG"
    TOKEN="$(mint_token)"
    PID_FILE="$TDIR/coordinator.pid"
    rm -f -- "$PID_FILE"
    UNPUBLISHED_PID_FILE="$PID_FILE"
    trap cleanup_unpublished_coordinator EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if ! NORTH_HOME="$NORTH" FRAM_HOME="$FRAM" FRAM_BIN="$FRAM/bin" \
      FRAM_PORT="$PORT" FRAM_LOG="$LOG" FRAM_REQUIRE_LOG_FENCE=1 \
      FRAM_DAEMON_LOG="$TDIR/coordinator.log" NORTH_COORD_PID_FILE="$PID_FILE" \
      "$COORD_UP" 7>&-; then
      die "strict coordinator failed readiness; registry was not changed"
    fi
    if ! IFS= read -r COORD_PID <"$PID_FILE" ||
       ! [[ "$COORD_PID" =~ ^[1-9][0-9]*$ ]] ||
       ! kill -0 "$COORD_PID" 2>/dev/null; then
      die "strict launcher returned without publishing a live owned coordinator PID; registry was not changed"
    fi
    UNPUBLISHED_COORD_PID="$COORD_PID"
    TOKEN_HASH="$(hash_token "$TOKEN")"
    PENDING_TENANT="$TENANT"
    PENDING_PORT="$PORT"
    PENDING_LOG="$LOG"
    PENDING_TOKEN_HASH="$TOKEN_HASH"
    if ! reg_edit "$TENANT" init "$PORT" "$TOKEN_HASH" "$LOG"; then
      die "registry publication failed; stopped the unpublished coordinator"
    fi
    COORDINATOR_PUBLISHED=1
    trap - EXIT INT TERM
    echo "provisioned tenant '$TENANT'  port=$PORT  log=$LOG"
    echo "TOKEN (shown once — store it now; only the hash is kept):"
    echo "  $TOKEN" ;;
esac
