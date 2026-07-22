#!/usr/bin/env bash
# Exact native provider identity observations: SessionStart owns model, while
# Claude tool-context hooks own effective effort. Fully hermetic: fake HOME contains the
# north writer and PATH contains a no-op bb, so no production facts or network.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$(cd "$HERE/.." && pwd)"
SPAWN="$BIN/north-on-spawn"
TOOLUSE="$BIN/north-on-tooluse"
ACTOR_KEY="$BIN/north-actor-key"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAKE_HOME="$TMP/home"
XDG="$TMP/xdg"
SHIM="$TMP/shim"
LOG="$TMP/north.log"
BB_LOG="$TMP/bb.log"
REPO_DIR="$TMP/project"
mkdir -p "$FAKE_HOME/code/north/bin" "$SHIM" "$XDG" "$REPO_DIR"
: > "$LOG"
: > "$BB_LOG"

cat > "$FAKE_HOME/code/north/bin/north" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NORTH_IDENTITY_LOG"
[ "${NORTH_IDENTITY_FAIL:-0}" = 1 ] && exit 1
exit 0
EOF
cat > "$SHIM/bb" <<'EOF'
#!/usr/bin/env bash
[ -n "${NORTH_BB_LOG:-}" ] && printf '%s\n' "$*" >> "$NORTH_BB_LOG"
if [ "${1:-}" = "-e" ] && [ -n "${NORTH_NATIVE_SUBJECT:-}" ]; then
  [ "${NORTH_IDENTITY_FAIL:-0}" = 1 ] && exit 1
  subject="${NORTH_NATIVE_SUBJECT#@}"
  {
    printf 'tell %s kind session\n' "$subject"
    printf 'tell %s repo %s\n' "$subject" "$NORTH_NATIVE_REPO"
    printf 'tell %s provider %s\n' "$subject" "$NORTH_NATIVE_PROVIDER"
    printf 'tell %s model %s\n' "$subject" "$NORTH_NATIVE_MODEL"
    printf 'tell %s effort %s\n' "$subject" "$NORTH_NATIVE_EFFORT"
    printf 'tell %s execution_source provider-native\n' "$subject"
    printf 'tell %s execution_transport provider-hook\n' "$subject"
    printf 'tell %s provider_session_persistence unknown\n' "$subject"
    printf 'tell %s native_actor_kind %s\n' "$subject" "$NORTH_NATIVE_ACTOR_KIND"
    printf 'tell %s native_depth %s\n' "$subject" "$NORTH_NATIVE_DEPTH"
    printf 'tell %s dispatch_mode_at_start %s\n' "$subject" "$NORTH_NATIVE_DISPATCH_MODE_AT_START"
    printf 'tell %s display_handle %s\n' "$subject" "$NORTH_NATIVE_DISPLAY"
    printf 'tell %s display_name %s\n' "$subject" "$NORTH_NATIVE_DISPLAY"
  } >> "$NORTH_IDENTITY_LOG"
fi
exit 0
EOF
chmod +x "$FAKE_HOME/code/north/bin/north" "$SHIM/bb"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
has() { if grep -Fq "$2" "$LOG"; then ok "$1"; else bad "$1"; fi; }
lacks() { if grep -Fq "$2" "$LOG"; then bad "$1"; else ok "$1"; fi; }

run_hook() {
  local hook="$1" payload="$2"
  shift 2
  printf '%s' "$payload" | env -i HOME="$FAKE_HOME" PATH="$SHIM:$PATH" \
    XDG_RUNTIME_DIR="$XDG" NORTH_PORT=1 NORTH_IDENTITY_LOG="$LOG" \
    NORTH_BB_LOG="$BB_LOG" "$@" \
    bash "$hook" >/dev/null 2>&1
  # PostToolUse identity convergence is deliberately asynchronous. The
  # singleflight lock is removed only after the publisher and route-cache
  # commit finish, so it is the deterministic hermetic completion signal.
  for _ in $(seq 1 100); do
    if ! find "$XDG" -type d -name '*.lock' -print -quit 2>/dev/null | grep -q .; then
      break
    fi
    sleep 0.01
  done
}

key_of() { "$ACTOR_KEY" "$1" "$2"; }
id_of() { printf 'native-%s' "$(key_of "$1" "$2")"; }

SID="11112222-3333-4444-8555-666677778888"
ID_KEY="$(key_of session "$SID")"
ID="native-$ID_KEY"

echo "== SessionStart exact input outranks ambient adapter dials =="
run_hook "$SPAWN" \
  "{\"session_id\":\"$SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"SessionStart\",\"model\":\"claude-opus-4-8\",\"effort\":{\"level\":\"xhigh\"}}" \
  CLAUDECODE=1 AGENT_MODEL=wrong-model CLAUDE_EFFORT=high AGENT_EFFORT=low
has "records exact SessionStart model" "tell agent:$ID model claude-opus-4-8"
has "records exact structured effort" "tell agent:$ID effort xhigh"
has "records immutable dispatch mode at session start" "tell agent:$ID dispatch_mode_at_start north"
lacks "does not record ambient model over exact input" "tell agent:$ID model wrong-model"

echo "== Codex SessionStart records exact provider/model and honest effort absence =="
: > "$LOG"
run_hook "$SPAWN" \
  "{\"session_id\":\"$SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"SessionStart\",\"model\":\"gpt-5.6-sol\"}" \
  CODEX_CI=1
has "records Codex provider from its runtime marker" "tell agent:$ID provider openai"
has "records exact Codex hook model" "tell agent:$ID model gpt-5.6-sol"
has "records unavailable Codex hook effort without guessing" "tell agent:$ID effort unobserved"

echo "== explicit provider boundary outranks inherited parent markers =="
: > "$LOG"
run_hook "$SPAWN" \
  "{\"session_id\":\"$SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"SessionStart\",\"model\":\"claude-opus-4-8\"}" \
  AGENT_PROVIDER=anthropic CODEX_THREAD_ID=inherited-parent
has "records the explicitly dispatched provider" "tell agent:$ID provider anthropic"
lacks "does not misattribute an Anthropic child to its Codex parent" "tell agent:$ID provider openai"

echo "== SessionStart uses CLAUDE_EFFORT when structured effort is absent =="
: > "$LOG"
run_hook "$SPAWN" \
  "{\"session_id\":\"$SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"SessionStart\",\"model\":\"claude-sonnet-5\"}" \
  CLAUDECODE=1 CLAUDE_EFFORT=high AGENT_EFFORT=low
has "records CLAUDE_EFFORT" "tell agent:$ID effort high"
lacks "does not substitute generic effort" "tell agent:$ID effort low"

echo "== missing observations are explicit, never guessed =="
: > "$LOG"
run_hook "$SPAWN" \
  "{\"session_id\":\"$SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"SessionStart\"}" \
  CLAUDECODE=1
has "records known Claude provider" "tell agent:$ID provider anthropic"
has "records missing model as unobserved" "tell agent:$ID model unobserved"
has "records missing effort as unobserved" "tell agent:$ID effort unobserved"

echo "== PostToolUse refreshes only exact effective effort =="
: > "$LOG"
run_hook "$TOOLUSE" \
  "{\"session_id\":\"$SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"PostToolUse\",\"effort\":{\"level\":\"medium\"},\"tool_input\":{\"level\":\"wrong\",\"model\":\"also-wrong\"}}" \
  CLAUDE_EFFORT=low ANTHROPIC_MODEL=ambient-wrong
has "records structured effective effort" "tell agent:$ID effort medium"
lacks "does not use unrelated nested level" "tell agent:$ID effort wrong"
lacks "does not claim the nested tool-input model" "tell agent:$ID model also-wrong"
lacks "does not claim an ambient model" "tell agent:$ID model ambient-wrong"

: > "$LOG"
run_hook "$TOOLUSE" \
  "{\"session_id\":\"$SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"PostToolUse\"}" \
  CLAUDE_EFFORT=low
has "falls back to exact CLAUDE_EFFORT" "tell agent:$ID effort low"

echo "== PostToolUse repairs a SessionStart identity write failure =="
RECOVERY_SID="99990000-aaaa-4bbb-8ccc-ddddeeeeffff"
RECOVERY_KEY="$(key_of session "$RECOVERY_SID")"
RECOVERY_ID="native-$RECOVERY_KEY"
rm -f "$XDG/north-agent-routes/$RECOVERY_KEY"
: > "$LOG"
run_hook "$SPAWN" \
  "{\"session_id\":\"$RECOVERY_SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"SessionStart\",\"model\":\"claude-opus-4-8\"}" \
  CLAUDECODE=1 NORTH_IDENTITY_FAIL=1
: > "$LOG"
run_hook "$TOOLUSE" \
  "{\"session_id\":\"$RECOVERY_SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"PostToolUse\",\"effort\":{\"level\":\"medium\"}}" \
  CLAUDECODE=1 CLAUDE_EFFORT=medium
has "repairs the session kind before the next presence renewal" "tell agent:$RECOVERY_ID kind session"
lacks "native repair omits managed Gaffer composition" "tell agent:$RECOVERY_ID composition_kind "
has "retains the observable provider during repair" "tell agent:$RECOVERY_ID provider anthropic"
has "repairs the exact SessionStart model from the observation seed" "tell agent:$RECOVERY_ID model claude-opus-4-8"
has "records the exact recovery-turn effort" "tell agent:$RECOVERY_ID effort medium"

echo "== Codex repair keeps provider/model without ambient PostToolUse markers =="
CODEX_RECOVERY_SID="88880000-aaaa-4bbb-8ccc-ddddeeeeffff"
CODEX_RECOVERY_KEY="$(key_of session "$CODEX_RECOVERY_SID")"
CODEX_RECOVERY_ID="native-$CODEX_RECOVERY_KEY"
rm -f "$XDG/north-agent-routes/$CODEX_RECOVERY_KEY" "$XDG/north-agent-routes/$CODEX_RECOVERY_KEY.seed"
: > "$LOG"
run_hook "$SPAWN" \
  "{\"session_id\":\"$CODEX_RECOVERY_SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"SessionStart\",\"model\":\"gpt-5.6-sol\"}" \
  CODEX_CI=1 NORTH_IDENTITY_FAIL=1
: > "$LOG"
# Deliberately omit CODEX_CI/CODEX_THREAD_ID: this is the real Codex PostToolUse
# shape that previously repaired model=sol with provider=unobserved.
run_hook "$TOOLUSE" \
  "{\"session_id\":\"$CODEX_RECOVERY_SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"PostToolUse\"}"
has "Codex repair retains the exact SessionStart provider seed" "tell agent:$CODEX_RECOVERY_ID provider openai"
has "Codex repair retains the exact SessionStart model seed" "tell agent:$CODEX_RECOVERY_ID model gpt-5.6-sol"
lacks "Codex repair never reverse-infers or falls back to unknown provider" "tell agent:$CODEX_RECOVERY_ID provider unobserved"

echo "== exact effort changes refresh stored projections once =="
: > "$LOG"
run_hook "$SPAWN" \
  "{\"session_id\":\"$SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"SessionStart\",\"model\":\"claude-opus-4-8\",\"effort\":{\"level\":\"high\"}}" \
  CLAUDECODE=1
: > "$LOG"
run_hook "$TOOLUSE" \
  "{\"session_id\":\"$SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"PostToolUse\",\"effort\":{\"level\":\"xhigh\"}}" \
  CLAUDE_EFFORT=xhigh
has "updates stored display_handle with exact effort" \
  "tell agent:$ID display_handle anthropic-claude-opus-4-8-xhigh-native-$ID_KEY"
has "updates stored display_name with exact effort" \
  "tell agent:$ID display_name anthropic-claude-opus-4-8-xhigh-native-$ID_KEY"
lacks "does not retain the stale high projection" \
  "tell agent:$ID display_handle anthropic-claude-opus-4-8-high-native-$ID_KEY"

: > "$LOG"
run_hook "$TOOLUSE" \
  "{\"session_id\":\"$SID\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"PostToolUse\",\"effort\":{\"level\":\"xhigh\"}}" \
  CLAUDE_EFFORT=xhigh
lacks "unchanged effort does not rewrite identity" "tell agent:$ID "

echo "== PostToolUse ignores unstable invocation agent_id and requires stable actor identity =="
TOOL_SID="77770000-aaaa-4bbb-8ccc-ddddeeeeffff"
TOOL_KEY="$(key_of session "$TOOL_SID")"
TOOL_ID="native-$TOOL_KEY"
rm -f "$XDG/north-agent-routes/$TOOL_KEY" "$XDG/north-agent-routes/$TOOL_KEY.seed"
: > "$LOG"; : > "$BB_LOG"
run_hook "$TOOLUSE" \
  "{\"session_id\":\"$TOOL_SID\",\"agent_id\":\"invocation-a03402d0\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"PostToolUse\"}" \
  CLAUDECODE=1
run_hook "$TOOLUSE" \
  "{\"session_id\":\"$TOOL_SID\",\"agent_id\":\"invocation-af753a18\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"PostToolUse\"}" \
  CLAUDECODE=1
has "unstable invocation ids converge on the stable session identity" "tell agent:$TOOL_ID kind session"
lacks "first invocation id never becomes an agent row" "agent:session-project-a03402d0"
lacks "second invocation id never becomes an agent row" "agent:session-project-af753a18"

echo "== spawned native subagents retain distinct actor identities on PostToolUse =="
PARENT_SID="66660000-aaaa-4bbb-8ccc-ddddeeeeffff"
SUB_A="aaaa0000-1111-4222-8333-444455556666"
SUB_B="bbbb0000-1111-4222-8333-444455556666"
SUB_A_ID="$(id_of agent "$SUB_A")"
SUB_B_ID="$(id_of agent "$SUB_B")"
: > "$LOG"; : > "$BB_LOG"
run_hook "$SPAWN" \
  "{\"session_id\":\"$PARENT_SID\",\"agent_id\":\"$SUB_A\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"SubagentStart\",\"model\":\"claude-sonnet-5\",\"effort\":{\"level\":\"medium\"}}" \
  CLAUDECODE=1
run_hook "$SPAWN" \
  "{\"session_id\":\"$PARENT_SID\",\"agent_id\":\"$SUB_B\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"SubagentStart\",\"model\":\"claude-sonnet-5\",\"effort\":{\"level\":\"medium\"}}" \
  CLAUDECODE=1
has "first native subagent owns its own row" "tell agent:$SUB_A_ID kind session"
has "second native subagent owns its own row" "tell agent:$SUB_B_ID kind session"
has "native subagent records provider-native execution provenance" "tell agent:$SUB_A_ID execution_source provider-native"
has "native subagent records its actor kind" "tell agent:$SUB_A_ID native_actor_kind subagent"
has "native subagent records bounded observed depth" "tell agent:$SUB_A_ID native_depth 1"

: > "$LOG"; : > "$BB_LOG"
run_hook "$TOOLUSE" \
  "{\"session_id\":\"$PARENT_SID\",\"agent_id\":\"$SUB_A\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"PostToolUse\",\"effort\":{\"level\":\"high\"}}" \
  CLAUDECODE=1
run_hook "$TOOLUSE" \
  "{\"session_id\":\"$PARENT_SID\",\"agent_id\":\"$SUB_B\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"PostToolUse\",\"effort\":{\"level\":\"xhigh\"}}" \
  CLAUDECODE=1
has "first subagent tool activity refreshes its cached row" "tell agent:$SUB_A_ID effort high"
has "second subagent tool activity refreshes its cached row" "tell agent:$SUB_B_ID effort xhigh"
lacks "subagent tool activity does not collapse onto the parent session" \
  "tell agent:$(id_of session "$PARENT_SID") effort"

: > "$LOG"; : > "$BB_LOG"
run_hook "$TOOLUSE" \
  "{\"agent_id\":\"invocation-no-session\",\"cwd\":\"$REPO_DIR\",\"hook_event_name\":\"PostToolUse\"}" \
  CLAUDECODE=1
if [ ! -s "$LOG" ] && [ ! -s "$BB_LOG" ]; then
  ok "missing stable actor id creates no identity or presence"
else
  bad "missing stable actor id creates no identity or presence"
fi

echo
echo "native-identity-test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
