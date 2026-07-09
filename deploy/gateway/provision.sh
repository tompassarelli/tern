#!/usr/bin/env bash
# Tenant lifecycle for the North gateway. Tokens are stored HASHED (sha-256);
# the plaintext is printed ONCE. Rotation keeps the old token valid until you
# revoke it, so clients can roll over with no downtime.
#
#   ./provision.sh <tenant> [coordinator-port]   create: mint token, start coordinator, register
#   ./provision.sh rotate <tenant>               mint a NEW token (old stays valid until revoked)
#   ./provision.sh revoke <tenant> <token>       drop a token (give the plaintext you're retiring)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FRAM="${FRAM_HOME:-$HOME/code/fram}"
REGISTRY="${GATEWAY_TENANTS:-$HERE/tenants.edn}"
DATA_ROOT="${NORTH_TENANT_ROOT:-$HOME/.local/state/north/tenants}"

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 1
}
mint_token() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
hash_token() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

# Upsert tenant field(s) in the EDN registry (bb keeps it valid EDN). The write is
# ATOMIC: bb spits a temp file, then `mv` renames it over the registry (same dir =
# rename(2)), so a concurrently-reloading gateway sees the OLD or the NEW file, never a
# truncated/partial one. `init` sets port AND token in ONE write so `create` never
# leaves a port-without-token mid-state for the gateway to cache.
#   reg_edit <tenant> <add-token|remove-token|set-port> <value>
#   reg_edit <tenant> init <port> <token-hash>
reg_edit() {
  local tmp="$REGISTRY.tmp.$$"
  bb -e "
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.pprint :as pp])
(def p \"$REGISTRY\")
(def reg (if (.exists (io/file p)) (edn/read-string (slurp p)) {}))
(def cur (get reg \"$1\" {}))
(defn tokset [m] (into (set (:tokens m)) (when-let [h (:token-sha256 m)] [h])))
(def updated (case \"$2\"
  \"add-token\"    (-> cur (assoc :tokens (conj (tokset cur) \"$3\")) (dissoc :token-sha256))
  \"remove-token\" (-> cur (assoc :tokens (disj (tokset cur) \"$3\")) (dissoc :token-sha256))
  \"set-port\"     (assoc cur :coordinator-port (Integer/parseInt \"$3\"))
  \"init\"         (-> cur (assoc :coordinator-port (Integer/parseInt \"$3\"))
                         (assoc :tokens (conj (tokset cur) \"${4:-}\"))
                         (dissoc :token-sha256))))
(spit \"$tmp\" (with-out-str (pp/pprint (assoc reg \"$1\" updated))))"
  mv -f "$tmp" "$REGISTRY"   # atomic rename: readers never see a partial file
}

[ $# -ge 1 ] || usage
case "$1" in
  rotate)
    [ $# -eq 2 ] || usage; TENANT="$2"
    TOKEN="$(mint_token)"; reg_edit "$TENANT" add-token "$(hash_token "$TOKEN")"
    echo "rotated tenant '$TENANT' — NEW token (old stays valid until you revoke it):"
    echo "  $TOKEN" ;;
  revoke)
    [ $# -eq 3 ] || usage; TENANT="$2"; OLD="$3"
    reg_edit "$TENANT" remove-token "$(hash_token "$OLD")"
    echo "revoked a token for tenant '$TENANT'." ;;
  *)
    TENANT="$1"; PORT="${2:-}"
    if [ -z "$PORT" ]; then
      PORT=7800
      while ss -tlnH "sport = :$PORT" 2>/dev/null | grep -q .; do PORT=$((PORT+1)); done
    fi
    TDIR="$DATA_ROOT/$TENANT"; mkdir -p "$TDIR"; LOG="$TDIR/facts.log"; touch "$LOG"
    TOKEN="$(mint_token)"
    reg_edit "$TENANT" init "$PORT" "$(hash_token "$TOKEN")"   # port + token in ONE atomic write
    FRAM_PORT="$PORT" FRAM_LOG="$LOG" "$FRAM/bin/fram-up"
    echo "provisioned tenant '$TENANT'  port=$PORT  log=$LOG"
    echo "TOKEN (shown once — store it now; only the hash is kept):"
    echo "  $TOKEN" ;;
esac
