#!/usr/bin/env bash
# Cross-host integration test: proves a coordinator started with FRAM_BIND=0.0.0.0
# is reachable through the gateway over a NON-loopback address (the multi-host
# path). Requires the Fram revision locked by North, including FRAM_BIND.
#   ./crosshost_test.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FRAM="${FRAM_HOME:-$HOME/code/fram}"
CPORT=7893; GPORT=8893
TMP="$(mktemp -d)"; LOG="$TMP/facts.log"; : > "$LOG"; REG="$TMP/tenants.edn"
TOKEN="xh-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
HASH="$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)"
# a non-loopback IPv4 (0.0.0.0 still serves loopback, so this falls back safely)
IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
IP="${IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"; IP="${IP:-127.0.0.1}"
printf '{"acme" {:tokens #{"%s"} :coordinator-port %s :coordinator-host "%s" :coordinator-log "%s"}}\n' \
  "$HASH" "$CPORT" "$IP" "$LOG" > "$REG"

CPID=""; GPID=""
cleanup(){ [ -n "$GPID" ] && kill "$GPID" 2>/dev/null || true
           [ -n "$CPID" ] && kill "$CPID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "coordinator FRAM_BIND=0.0.0.0 on :$CPORT ; gateway routes :coordinator-host=$IP"
FRAM_BIND=0.0.0.0 FRAM_REQUIRE_LOG_FENCE=1 \
  "$FRAM/bin/fram-daemon" "$CPORT" "$LOG" >"$TMP/coord.log" 2>&1 &
CPID=$!
for _ in $(seq 160); do ss -tlnH "sport = :$CPORT" 2>/dev/null | grep -q . && break; sleep 0.25; done  # JVM boot ~40s budget

GATEWAY_PORT="$GPORT" GATEWAY_TENANTS="$REG" bb -cp "$HERE/../../out" "$HERE/gateway.clj" >"$TMP/gw.log" 2>&1 &
GPID=$!
for _ in $(seq 40); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$GPORT/healthz)" = 200 ] && break; sleep 0.25; done

pass=0; fail=0
check(){ if [ "$2" = "$3" ]; then echo "  [PASS] $1"; pass=$((pass+1));
         else echo "  [FAIL] $1 — want '$2' got '$3'"; fail=$((fail+1)); fi; }

# 1. coordinator is bound to ALL interfaces, not just 127.0.0.1 (the FRAM_BIND path)
listen="$(ss -tlnH "sport = :$CPORT" 2>/dev/null | awk '{print $4}' | head -1)"
case "$listen" in
  0.0.0.0:*|\*:*|"[::]":*) check "coordinator bound non-loopback (FRAM_BIND=0.0.0.0)" ok ok ;;
  *)                       check "coordinator bound non-loopback (FRAM_BIND=0.0.0.0)" ok "got:$listen" ;;
esac

# 2. the safety warning is logged
if grep -qi UNAUTHENTICATED "$TMP/coord.log"; then
  check "unauthenticated warning logged" ok ok
else
  check "unauthenticated warning logged" ok missing
fi

# 3. the gateway forwards to the coordinator over the non-loopback host
body="$(curl -s -H "Authorization: Bearer $TOKEN" --data '{:op :version}' http://127.0.0.1:$GPORT/v1/rpc)"
case "$body" in *":version"*) check "gateway -> coordinator@$IP forwards" ok ok ;;
                *)             check "gateway -> coordinator@$IP forwards" ok "got:$body" ;; esac

echo
if [ "$fail" -eq 0 ]; then echo "crosshost: ALL $pass PASS (coordinator-host=$IP)"; else echo "crosshost: $fail FAILED"; exit 1; fi
