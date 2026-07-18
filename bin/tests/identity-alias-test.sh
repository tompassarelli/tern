#!/usr/bin/env bash
# Regression test for the presence-identity ALIASING bug (thread 019f2496-23f2,
# 2026-07-03): a parent session's NORTH_AGENT_ID env pin leaked through the process
# environment into its Claude subagents (SubagentSessionStart inherits the parent
# env but carries the subagent's OWN session_id). Both spawn + tooluse preferred the
# env pin over the per-session cache, so every subagent aliased the parent id — the
# roster, concern ledger, and peer-mail inbox all attributed several workstreams to
# one name, and mail was answered by whichever actor peeked first (cc-fram-d5523b3b,
# under the incident-era cc- prefix; spawn-derived ids are session-* since rename 2a).
#
# INVARIANT under test: one live actor == one id. A given id is renewed/registered
# ONLY by the session that first acquired it. An env pin is honored only when no OTHER
# session already owns it; an inherited pin yields a distinct per-sid id instead.
#
# Fully hermetic + fast: isolates XDG_RUNTIME_DIR (the id cache) into a temp dir and
# shims `bb` on PATH to record the id each hook registers — no JVM, no :7977, no net.
#   ./identity-alias-test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$(cd "$HERE/.." && pwd)"
SPAWN="$BIN/north-on-spawn"
TOOLUSE="$BIN/north-on-tooluse"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export XDG="$TMP/xdg"; mkdir -p "$XDG/north-agent-ids"
CACHE="$XDG/north-agent-ids"
export BB_REG_LOG="$TMP/registered.log"; : > "$BB_REG_LOG"

# --- bb shim: record the id passed to `presence-cli register`, swallow inbox-peek ---
SHIM="$TMP/shim"; mkdir -p "$SHIM"
cat > "$SHIM/bb" <<'EOF'
#!/usr/bin/env bash
# test double for `bb`: log the id from a `... register <ID> ...` call; else no-op.
a=("$@")
for ((i=0; i<${#a[@]}; i++)); do
  if [ "${a[$i]}" = "register" ]; then printf '%s\n' "${a[$((i+1))]}" >> "$BB_REG_LOG"; fi
done
exit 0
EOF
chmod +x "$SHIM/bb"

# fram-named non-git cwd -> hooks fall back to REPO=cwd, RN=fram (mirrors the incident)
REPO_DIR="$TMP/fram"; mkdir -p "$REPO_DIR"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     expected [%s] got [%s]\n' "$1" "$2" "$3"; }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
ne()   { if [ "$2" != "$3" ]; then ok "$1"; else bad "$1" "not $2" "$3"; fi; }

json() {
  if [ -n "${4:-}" ]; then
    printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","agent_id":"%s"}' "$1" "$2" "$3" "$4"
  else
    printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s"}' "$1" "$2" "$3"
  fi
}

# run a hook with a controlled env; returns the id it registered (via the shim).
# usage: reg=$(run_hook <hookpath> <sid> <evt> [PIN] [AGENT_ID])
run_hook() {
  local hook="$1" sid="$2" evt="$3" pin="${4:-}" agent_id="${5:-}"
  : > "$BB_REG_LOG"
  if [ -n "$pin" ]; then
    json "$sid" "$REPO_DIR" "$evt" "$agent_id" | env -i HOME="$HOME" PATH="$SHIM:$PATH" \
      XDG_RUNTIME_DIR="$XDG" BB_REG_LOG="$BB_REG_LOG" NORTH_PORT=1 \
      NORTH_AGENT_ID="$pin" bash "$hook" >/dev/null 2>&1
  else
    json "$sid" "$REPO_DIR" "$evt" "$agent_id" | env -i HOME="$HOME" PATH="$SHIM:$PATH" \
      XDG_RUNTIME_DIR="$XDG" BB_REG_LOG="$BB_REG_LOG" NORTH_PORT=1 \
      bash "$hook" >/dev/null 2>&1
  fi
  # PostToolUse renewals are asynchronous and singleflight-coalesced. Lock
  # removal is the completion signal; wait for it before reading the shim log.
  for _ in $(seq 1 100); do
    if ! find "$XDG" -type d -name '*.lock' -print -quit 2>/dev/null | grep -q .; then
      break
    fi
    sleep 0.01
  done
  tail -n1 "$BB_REG_LOG" 2>/dev/null || true
}
cache_of() { cat "$CACHE/$1" 2>/dev/null || true; }

PARENT="d5523b3b-47bb-446d-b5ae-f08ff8c0eba4"   # -> session-fram-d5523b3b (the incident id)
SUB="aaaa1111-0000-4000-8000-000000000001"      # -> session-fram-aaaa1111
SUB2="bbbb2222-0000-4000-8000-000000000002"     # -> session-fram-bbbb2222
FRESH="cccc3333-0000-4000-8000-000000000003"
NOCACHE="dddd4444-0000-4000-8000-000000000004"

echo "== 1. parent SessionStart (no env pin) acquires its derived id =="
reg="$(run_hook "$SPAWN" "$PARENT" SessionStart)"
eq "parent registers session-fram-d5523b3b" "session-fram-d5523b3b" "$reg"
eq "parent cache file == its id"        "session-fram-d5523b3b" "$(cache_of "$PARENT")"

echo "== 2. subagent SubagentSessionStart w/ INHERITED env pin gets its OWN id =="
# parent already owns session-fram-d5523b3b (case 1 seeded the cache); the subagent
# inherits NORTH_AGENT_ID=session-fram-d5523b3b but has its own session_id.
reg="$(run_hook "$SPAWN" "$SUB" SubagentSessionStart "session-fram-d5523b3b")"
ne "subagent does NOT alias parent id"  "session-fram-d5523b3b" "$reg"
eq "subagent gets own derived id"       "session-fram-aaaa1111" "$reg"
eq "subagent cache file == own id"      "session-fram-aaaa1111" "$(cache_of "$SUB")"
eq "parent cache untouched"             "session-fram-d5523b3b" "$(cache_of "$PARENT")"

echo "== 2b. provider SubagentStart parent session_id + unique agent_id stays distinct =="
NATIVE_AGENT="agent-eeee5555-0000-4000-8000-000000000005"
reg="$(run_hook "$SPAWN" "$PARENT" SubagentStart "session-fram-d5523b3b" "$NATIVE_AGENT")"
eq "native subagent derives from agent_id, not parent session_id" "session-fram-eeee5555" "$reg"
eq "native subagent cache is keyed by agent_id" "session-fram-eeee5555" "$(cache_of "$NATIVE_AGENT")"
reg="$(run_hook "$TOOLUSE" "$PARENT" PostToolUse "session-fram-d5523b3b" "$NATIVE_AGENT")"
eq "native subagent tooluse renews its agent_id row" "session-fram-eeee5555" "$reg"

echo "== 3. dispatch-style fresh process: env pin, NO prior owner -> keeps pin =="
reg="$(run_hook "$SPAWN" "$FRESH" SessionStart "sdk-custom-xyz")"
eq "fresh process keeps its env pin"    "sdk-custom-xyz" "$reg"
eq "fresh cache file == pinned id"      "sdk-custom-xyz" "$(cache_of "$FRESH")"

echo "== 4. tooluse renews the CACHE id even when env pin is set (cache > env) =="
# subagent SUB has cache=session-fram-aaaa1111 but still inherits the parent env pin.
reg="$(run_hook "$TOOLUSE" "$SUB" PostToolUse "session-fram-d5523b3b")"
eq "tooluse renews cached subagent id"  "session-fram-aaaa1111" "$reg"
ne "tooluse ignores inherited env pin"  "session-fram-d5523b3b" "$reg"

echo "== 5. tooluse env FALLBACK when no cache (SDK-dispatched, spawn hook unfired) =="
reg="$(run_hook "$TOOLUSE" "$NOCACHE" PostToolUse "sdk-fallback")"
eq "tooluse falls back to env pin"      "sdk-fallback" "$reg"

echo "== 6. concurrent siblings both inherit pin -> both derive DISTINCT ids =="
# parent owns session-fram-d5523b3b; two siblings spawn with the inherited pin.
r1="$(run_hook "$SPAWN" "$SUB"  SubagentSessionStart "session-fram-d5523b3b")"
r2="$(run_hook "$SPAWN" "$SUB2" SubagentSessionStart "session-fram-d5523b3b")"
ne "sibling A not aliased to parent"    "session-fram-d5523b3b" "$r1"
ne "sibling B not aliased to parent"    "session-fram-d5523b3b" "$r2"
ne "siblings not aliased to each other" "$r1" "$r2"
eq "sibling A own id"                   "session-fram-aaaa1111" "$r1"
eq "sibling B own id"                   "session-fram-bbbb2222" "$r2"

echo
echo "identity-alias-test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
