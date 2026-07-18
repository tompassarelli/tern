#!/usr/bin/env bash
# Integration smoke test for the auth gateway: stands up a real coordinator + the
# gateway, then exercises auth, the body cap, the audit log, and revocation.
#   ./smoke_test.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FRAM="${FRAM_HOME:-$HOME/code/fram}"
CPORT=7891          # test coordinator port
GPORT=8891          # test gateway port
TMP="$(mktemp -d)"
LOG="$TMP/facts.log"; : > "$LOG"
WRONG_LOG="$TMP/wrong.log"; : > "$WRONG_LOG"
REG="$TMP/tenants.edn"
AUDIT="$TMP/audit.log"
TOKEN="test-token-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
HASH="$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)"
# new :tokens SET form (the gateway also accepts the legacy :token-sha256)
printf '{"acme" {:tokens #{"%s"} :coordinator-port %s :coordinator-log "%s"}}\n' \
  "$HASH" "$CPORT" "$LOG" > "$REG"

COORD_PID=""; GW_PID=""
cleanup() { [ -n "$GW_PID" ] && kill "$GW_PID" 2>/dev/null || true
            [ -n "$COORD_PID" ] && kill "$COORD_PID" 2>/dev/null || true
            rm -rf "$TMP"; }
trap cleanup EXIT

echo "starting coordinator on :$CPORT ..."
# Launch the REAL production daemon (JVM via bin/fram-daemon), not a bb stand-in —
# the test backend should be the same process operators run.
FRAM_REQUIRE_LOG_FENCE=1 "$FRAM/bin/fram-daemon" "$CPORT" "$LOG" >"$TMP/coord.log" 2>&1 &
COORD_PID=$!
for _ in $(seq 160); do   # JVM boot is slower than bb; allow up to ~40s on a cold runner
  ss -tlnH "sport = :$CPORT" 2>/dev/null | grep -q . && break
  sleep 0.25
done

echo "starting gateway on :$GPORT ..."
GATEWAY_PORT="$GPORT" GATEWAY_TENANTS="$REG" GATEWAY_AUDIT_LOG="$AUDIT" GATEWAY_MAX_BODY=64 \
  bb -cp "$HERE/../../out" "$HERE/gateway.clj" >"$TMP/gw.log" 2>&1 &
GW_PID=$!
for _ in $(seq 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$GPORT/healthz" 2>/dev/null)" = "200" ] && break
  sleep 0.25
done

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  [PASS] $1"; pass=$((pass+1))
          else echo "  [FAIL] $1 — expected '$2' got '$3'"; fail=$((fail+1)); fi; }
RPC="http://127.0.0.1:$GPORT/v1/rpc"

# 1. health
check "healthz is 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$GPORT/healthz)"

# 2. authed RPC forwards to the coordinator (expect a :version reply)
body="$(curl -s -H "Authorization: Bearer $TOKEN" --data '{:op :version}' "$RPC")"
case "$body" in *":version"*) check "authed /v1/rpc reaches coordinator" ok ok;;
                *)             check "authed /v1/rpc reaches coordinator" ok "got:$body";; esac
json_body="$(curl -s -H "Authorization: Bearer $TOKEN" \
  --data '{:op :version :fmt :json}' "$RPC")"
case "$json_body" in *'"version"'*) check "gateway preserves JSON response format" ok ok;;
                       *)             check "gateway preserves JSON response format" ok "got:$json_body";; esac

# 3. wrong token -> 401
check "bad token is 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' \
       -H 'Authorization: Bearer wrong' --data '{:op :version}' "$RPC")"

# 4. no auth -> 401
check "missing auth is 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' --data '{:op :version}' "$RPC")"

# 5. body over GATEWAY_MAX_BODY (64) -> 413
big="{:op :version :pad \"$(head -c 200 < /dev/zero | tr '\0' 'a')\"}"
check "oversized body is 413" "413" "$(curl -s -o /dev/null -w '%{http_code}' \
       -H "Authorization: Bearer $TOKEN" --data "$big" "$RPC")"

# 6. audit log captured the authed request (tenant + op, never the object value)
if grep -q ':tenant "acme"' "$AUDIT" && grep -q ':op :version' "$AUDIT"; then
  check "audit log has the request" ok ok
else
  check "audit log has the request" ok "missing"
fi

# 7. strict coordinator rejects an unfenced direct request
raw_reply=""
if exec 3<>"/dev/tcp/127.0.0.1/$CPORT"; then
  printf '%s\n' '{:op :version}' >&3
  IFS= read -r -t 2 raw_reply <&3 || raw_reply=""
  exec 3>&- 3<&-
fi
case "$raw_reply" in *"log-fence-required"*) check "raw coordinator bypass is rejected" ok ok;;
                      *)                     check "raw coordinator bypass is rejected" ok "got:$raw_reply";; esac

# 8. callers cannot smuggle their own corpus envelope through the gateway
check "client-authored corpus fence is 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' \
       -H "Authorization: Bearer $TOKEN" --data '{:op :for-log}' "$RPC")"

# 9. a registry row aimed at the wrong corpus fails closed before the inner write
before_log="$(sha256sum "$LOG" | cut -d' ' -f1)"
before_wrong="$(sha256sum "$WRONG_LOG" | cut -d' ' -f1)"
sleep 1
printf '{"acme" {:tokens #{"%s"} :coordinator-port %s :coordinator-log "%s"}}\n' \
  "$HASH" "$CPORT" "$WRONG_LOG" > "$REG"
check "wrong tenant corpus mapping is 502" "502" "$(curl -s -o /dev/null -w '%{http_code}' \
       -H "Authorization: Bearer $TOKEN" \
       --data '{:op :assert :te "@must-not-land" :p "x" :r "y" :base 0}' "$RPC")"
after_log="$(sha256sum "$LOG" | cut -d' ' -f1)"
after_wrong="$(sha256sum "$WRONG_LOG" | cut -d' ' -f1)"
check "wrong corpus request mutates neither log" "$before_log:$before_wrong" "$after_log:$after_wrong"

# Restore the valid route before checking token revocation.
sleep 1
printf '{"acme" {:tokens #{"%s"} :coordinator-port %s :coordinator-log "%s"}}\n' \
  "$HASH" "$CPORT" "$LOG" > "$REG"

# 10. revoke the token (empty the :tokens set) -> reload on mtime -> now 401
sleep 1
printf '{"acme" {:tokens #{} :coordinator-port %s :coordinator-log "%s"}}\n' "$CPORT" "$LOG" > "$REG"
check "revoked token is 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' \
       -H "Authorization: Bearer $TOKEN" --data '{:op :version}' "$RPC")"

echo
if [ "$fail" -eq 0 ]; then echo "gateway smoke: ALL $pass PASS"; else echo "gateway smoke: $fail FAILED"; exit 1; fi
