#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
TMP="$TMP_ROOT/state with spaces"
CHECKOUT="$TMP/north checkout"
SHIM="$TMP/shim"
HOME_DIR="$TMP/home"
HOST_PATH="$PATH"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$CHECKOUT/bin" "$CHECKOUT/out" "$CHECKOUT/cli" \
  "$SHIM" "$HOME_DIR" "$TMP/fram classpath"
cp "$ROOT/bin/north-clock-audit" "$ROOT/bin/north-stream-sync" "$CHECKOUT/bin/"

cat >"$SHIM/bb" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$BB_ARGS"
EOF
cat >"$SHIM/stat" <<'EOF'
#!/usr/bin/env bash
echo "GNU/BSD stat must not be required" >&2
exit 99
EOF
chmod +x "$SHIM/bb" "$SHIM/stat"

env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  BB_ARGS="$TMP/bb.args" FRAM_HOME="$TMP/absent Fram home" \
  FRAM_OUT="$TMP/fram classpath" \
  "$CHECKOUT/bin/north-clock-audit" --since 2026-01-01

mapfile -t bb_args <"$TMP/bb.args"
[[ "${bb_args[0]}" == -cp ]]
[[ "${bb_args[1]}" == "$CHECKOUT/out:$TMP/fram classpath" ]]
[[ "${bb_args[2]}" == "$CHECKOUT/cli/clock-audit.clj" ]]
[[ "${bb_args[3]}" == --since ]]
[[ "${bb_args[4]}" == 2026-01-01 ]]

SRC="$TMP/source root/project slug"
mkdir -p "$SRC"
printf '{"type":"checkout-default"}\n' \
  >"$SRC/12345678-1234-1234-1234-123456789abc.jsonl"

env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$TMP/source root"

checkout_raw="$CHECKOUT/streams/raw"
checkout_dest="$(find "$checkout_raw" -maxdepth 1 -type f -name '*.jsonl' -print -quit)"
[[ -n "$checkout_dest" ]]
cmp "$SRC/12345678-1234-1234-1234-123456789abc.jsonl" "$checkout_dest"
checkout_name="$(basename "$checkout_dest")"
[[ "$checkout_name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+-[0-9a-f]{16}\.[0-9a-f]{64}\.jsonl$ ]]
[[ "${#checkout_name}" -le 255 ]]
awk -F'\t' '
  NF != 6 || $1 != "v3" || $2 !~ /^[0-9]+$/ ||
  $4 !~ /^[0-9a-f]{64}$/ ||
  $5 !~ /^[A-Za-z0-9][A-Za-z0-9._-]*[.]jsonl$/ ||
  $6 !~ /^[0-9a-f]{64}$/ {
    exit 1
  }
' "$checkout_raw/.cursors"
checkout_hash="$(sha256sum "$checkout_raw/.cursors")"

env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$TMP/source root"
[[ "$checkout_hash" == "$(sha256sum "$checkout_raw/.cursors")" ]]
cmp "$SRC/12345678-1234-1234-1234-123456789abc.jsonl" "$checkout_dest"

# A killed owner cannot leave a permanent lock. The kernel releases fd 9 even
# though the harmless lock file remains on disk.
LOCK_SRC_ROOT="$TMP/lock source"
LOCK_PROJECT="$LOCK_SRC_ROOT/project"
LOCK_RAW="$TMP/lock raw"
LOCK_READY="$TMP/lock.ready"
mkdir -p "$LOCK_PROJECT" "$LOCK_RAW"
printf 'kernel lock recovery\n' >"$LOCK_PROJECT/lock-session.jsonl"
bash -c '
  exec 9>"$1/.stream-sync.lock"
  flock 9
  : >"$2"
  while :; do read -r -t 1 || :; done
' _ "$LOCK_RAW" "$LOCK_READY" &
lock_pid=$!
for _ in $(seq 1 100); do
  [[ -e "$LOCK_READY" ]] && break
  sleep 0.01
done
[[ -e "$LOCK_READY" ]]
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$LOCK_SRC_ROOT" --raw-dir "$LOCK_RAW"
[[ -z "$(find "$LOCK_RAW" -maxdepth 1 -type f -name '*.jsonl' -print -quit)" ]]
kill -9 "$lock_pid"
wait "$lock_pid" 2>/dev/null || true
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$LOCK_SRC_ROOT" --raw-dir "$LOCK_RAW"
LOCK_DEST="$(find "$LOCK_RAW" -maxdepth 1 -type f -name '*.jsonl' -print -quit)"
cmp "$LOCK_PROJECT/lock-session.jsonl" "$LOCK_DEST"

# The old mkdir-based lock migrates without a human cleanup command. Only the
# exact empty directory shape is disposable.
LEGACY_LOCK_ROOT="$TMP/legacy lock source"
LEGACY_LOCK_PROJECT="$LEGACY_LOCK_ROOT/project"
LEGACY_LOCK_RAW="$TMP/legacy lock raw"
mkdir -p "$LEGACY_LOCK_PROJECT" "$LEGACY_LOCK_RAW/.stream-sync.lock"
printf 'legacy lock migration\n' >"$LEGACY_LOCK_PROJECT/session.jsonl"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$LEGACY_LOCK_ROOT" --raw-dir "$LEGACY_LOCK_RAW"
[[ -f "$LEGACY_LOCK_RAW/.stream-sync.lock" ]]
LEGACY_LOCK_DEST="$(find "$LEGACY_LOCK_RAW" -maxdepth 1 -type f -name '*.jsonl' -print -quit)"
cmp "$LEGACY_LOCK_PROJECT/session.jsonl" "$LEGACY_LOCK_DEST"

BLOCKED_LOCK_ROOT="$TMP/blocked legacy lock source"
BLOCKED_LOCK_PROJECT="$BLOCKED_LOCK_ROOT/project"
BLOCKED_LOCK_RAW="$TMP/blocked legacy lock raw"
mkdir -p "$BLOCKED_LOCK_PROJECT" "$BLOCKED_LOCK_RAW/.stream-sync.lock"
printf 'must not sync\n' >"$BLOCKED_LOCK_PROJECT/session.jsonl"
printf 'not disposable\n' >"$BLOCKED_LOCK_RAW/.stream-sync.lock/evidence"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$BLOCKED_LOCK_ROOT" --raw-dir "$BLOCKED_LOCK_RAW" \
    >"$TMP/blocked-lock.out" 2>"$TMP/blocked-lock.err"; then
  echo "nonempty legacy lock directory was accepted" >&2
  exit 1
fi
grep -Fq "legacy lock directory is nonempty" "$TMP/blocked-lock.err"
[[ -f "$BLOCKED_LOCK_RAW/.stream-sync.lock/evidence" ]]
[[ ! -e "$BLOCKED_LOCK_RAW/.cursors" ]]
[[ -z "$(find "$BLOCKED_LOCK_RAW" -maxdepth 1 -type f -name '*.jsonl' -print -quit)" ]]

# Cursor and error state never follow symlinks or open special files.
STATE_ROOT="$TMP/state-shape source"
STATE_PROJECT="$STATE_ROOT/project"
STATE_RAW="$TMP/state-shape raw"
STATE_TARGET="$TMP/external cursor target"
mkdir -p "$STATE_PROJECT" "$STATE_RAW"
printf 'state shape\n' >"$STATE_PROJECT/session.jsonl"
printf 'external evidence\n' >"$STATE_TARGET"
ln -s "$STATE_TARGET" "$STATE_RAW/.cursors"
STATE_TARGET_HASH="$(sha256sum "$STATE_TARGET")"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$STATE_ROOT" --raw-dir "$STATE_RAW" \
    >"$TMP/state-shape.out" 2>"$TMP/state-shape.err"; then
  echo "symlinked cursor state was accepted" >&2
  exit 1
fi
grep -Fq "refusing symlinked state file" "$TMP/state-shape.err"
[[ "$STATE_TARGET_HASH" == "$(sha256sum "$STATE_TARGET")" ]]
[[ ! -e "$STATE_RAW/.stream-sync.lock" ]]
rm "$STATE_RAW/.cursors"
mkdir "$STATE_RAW/.stream-sync-errors"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$STATE_ROOT" --raw-dir "$STATE_RAW" \
    >"$TMP/state-dir.out" 2>"$TMP/state-dir.err"; then
  echo "directory error-state path was accepted" >&2
  exit 1
fi
grep -Fq "state path is not a regular file" "$TMP/state-dir.err"
[[ ! -e "$STATE_RAW/.cursors" ]]
[[ ! -e "$STATE_RAW/.stream-sync.lock" ]]

# Reject unbounded numeric inputs before creating a destination root. Bash and
# find must never reinterpret an accepted decimal outside their integer domain.
ARG_SRC_ROOT="$TMP/arg source"
ARG_PROJECT="$ARG_SRC_ROOT/project"
mkdir -p "$ARG_PROJECT"
printf 'argument bounds\n' >"$ARG_PROJECT/session.jsonl"
for invalid_args in \
  "--days 999999999999999999999999999" \
  "--min-bytes 999999999999999999999999999"; do
  ARG_RAW="$TMP/arg raw-$RANDOM"
  read -r -a invalid_argv <<<"$invalid_args"
  if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
    "$CHECKOUT/bin/north-stream-sync" "${invalid_argv[@]}" \
      --src-dir "$ARG_SRC_ROOT" --raw-dir "$ARG_RAW" \
      >"$TMP/arg.out" 2>"$TMP/arg.err"; then
    echo "out-of-range numeric argument was accepted: $invalid_args" >&2
    exit 1
  fi
  [[ ! -e "$ARG_RAW" ]]
done

# Source/destination overlap is rejected before mkdir, cursor, or lock writes.
OVERLAP_ROOT="$TMP/overlap root"
OVERLAP_SOURCE="$OVERLAP_ROOT/source"
mkdir -p "$OVERLAP_SOURCE/project"
printf 'overlap\n' >"$OVERLAP_SOURCE/project/session.jsonl"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$OVERLAP_SOURCE" --raw-dir "$OVERLAP_SOURCE/raw" \
    >"$TMP/overlap.out" 2>"$TMP/overlap.err"; then
  echo "destination nested in source was accepted" >&2
  exit 1
fi
[[ ! -e "$OVERLAP_SOURCE/raw" ]]

NESTED_RAW="$TMP/source nested in raw"
NESTED_SOURCE="$NESTED_RAW/source"
mkdir -p "$NESTED_SOURCE/project"
printf 'reverse overlap\n' >"$NESTED_SOURCE/project/session.jsonl"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$NESTED_SOURCE" --raw-dir "$NESTED_RAW" \
    >"$TMP/reverse-overlap.out" 2>"$TMP/reverse-overlap.err"; then
  echo "source nested in destination was accepted" >&2
  exit 1
fi
[[ ! -e "$NESTED_RAW/.cursors" ]]
[[ ! -e "$NESTED_RAW/.stream-sync.lock" ]]

# Ambiguous persisted destination ownership and unsafe TSV paths fail before a
# stream destination is mutated.
UNIQUE_SRC_ROOT="$TMP/unique source"
UNIQUE_PROJECT="$UNIQUE_SRC_ROOT/project"
UNIQUE_RAW="$TMP/unique raw"
mkdir -p "$UNIQUE_PROJECT" "$UNIQUE_RAW"
printf 'uniqueness probe\n' >"$UNIQUE_PROJECT/unique-session.jsonl"
UNIQUE_DIGEST_A="$(
  printf 'north-stream-source-v3\0anthropic\0project\0a' |
    sha256sum | cut -d' ' -f1
)"
UNIQUE_DIGEST_B="$(
  printf 'north-stream-source-v3\0anthropic\0project\0b' |
    sha256sum | cut -d' ' -f1
)"
printf 'v3\t1\t%s/a.jsonl\t%s\tshared.jsonl\t%s\n' \
  "$UNIQUE_PROJECT" \
  "$UNIQUE_DIGEST_A" "$(printf c%.0s {1..64})" >"$UNIQUE_RAW/.cursors"
printf 'v3\t1\t%s/b.jsonl\t%s\tshared.jsonl\t%s\n' \
  "$UNIQUE_PROJECT" \
  "$UNIQUE_DIGEST_B" "$(printf d%.0s {1..64})" >>"$UNIQUE_RAW/.cursors"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$UNIQUE_SRC_ROOT" --raw-dir "$UNIQUE_RAW" \
    >"$TMP/unique.out" 2>"$TMP/unique.err"; then
  echo "duplicate destination ownership was accepted" >&2
  exit 1
fi
grep -Fq "duplicate structured destination basename" "$TMP/unique.err"
[[ -z "$(find "$UNIQUE_RAW" -maxdepth 1 -type f -name '*.jsonl' -print -quit)" ]]

# A relative v1 source has no durable base directory. Reject it without guessing
# from the caller's cwd or duplicating its destination.
RELATIVE_ROOT="$TMP/relative source"
RELATIVE_PROJECT="$RELATIVE_ROOT/project"
RELATIVE_RAW="$TMP/relative raw"
mkdir -p "$RELATIVE_PROJECT" "$RELATIVE_RAW" "$TMP/unrelated cwd"
printf 'relative cursor\n' >"$RELATIVE_PROJECT/session.jsonl"
printf '1\tproject/session.jsonl\t2026-07-18\n' >"$RELATIVE_RAW/.cursors"
RELATIVE_CURSOR_HASH="$(sha256sum "$RELATIVE_RAW/.cursors")"
if (
  cd "$TMP/unrelated cwd"
  env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
    "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
      --src-dir "$RELATIVE_ROOT" --raw-dir "$RELATIVE_RAW"
) >"$TMP/relative.out" 2>"$TMP/relative.err"; then
  echo "relative legacy cursor source was accepted" >&2
  exit 1
fi
grep -Fq "relative legacy cursor source is ambiguous" "$TMP/relative.err"
[[ "$RELATIVE_CURSOR_HASH" == "$(sha256sum "$RELATIVE_RAW/.cursors")" ]]
[[ -z "$(find "$RELATIVE_RAW" -maxdepth 1 -type f -name '*.jsonl' -print -quit)" ]]

# Cursor-group validation is complete before a valid earlier line can migrate
# its legacy destination.
GROUP_ROOT="$TMP/group source"
GROUP_PROJECT="$GROUP_ROOT/project"
GROUP_RAW="$TMP/group raw"
GROUP_SOURCE="$GROUP_PROJECT/group-session.jsonl"
GROUP_LEGACY_DEST="$GROUP_RAW/2026-07-18-project.group-se.jsonl"
mkdir -p "$GROUP_PROJECT" "$GROUP_RAW"
printf 'group source\n' >"$GROUP_SOURCE"
printf 'group legacy destination\n' >"$GROUP_LEGACY_DEST"
printf '1\t%s\t2026-07-18\n' "$GROUP_SOURCE" >"$GROUP_RAW/.cursors"
printf 'malformed\tcursor\n' >>"$GROUP_RAW/.cursors"
GROUP_CURSOR_HASH="$(sha256sum "$GROUP_RAW/.cursors")"
GROUP_DEST_HASH="$(sha256sum "$GROUP_LEGACY_DEST")"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$GROUP_ROOT" --raw-dir "$GROUP_RAW" \
    >"$TMP/group.out" 2>"$TMP/group.err"; then
  echo "malformed cursor group was accepted" >&2
  exit 1
fi
[[ "$GROUP_CURSOR_HASH" == "$(sha256sum "$GROUP_RAW/.cursors")" ]]
[[ "$GROUP_DEST_HASH" == "$(sha256sum "$GROUP_LEGACY_DEST")" ]]
[[ "$(find "$GROUP_RAW" -maxdepth 1 -type f -name '*.jsonl' | wc -l)" -eq 1 ]]

for unsafe_component in $'tab\tproject' $'line\nproject' 'slash\project'; do
  UNSAFE_SRC_ROOT="$TMP/unsafe-$RANDOM"
  UNSAFE_RAW="$TMP/unsafe-raw-$RANDOM"
  mkdir -p "$UNSAFE_SRC_ROOT/$unsafe_component"
  printf 'unsafe path\n' >"$UNSAFE_SRC_ROOT/$unsafe_component/session.jsonl"
  if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
    "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
      --src-dir "$UNSAFE_SRC_ROOT" --raw-dir "$UNSAFE_RAW" \
      >"$TMP/unsafe.out" 2>"$TMP/unsafe.err"; then
    echo "unsafe cursor path was accepted" >&2
    exit 1
  fi
  grep -Fq "source path cannot be represented safely" "$TMP/unsafe.err"
  [[ -z "$(find "$UNSAFE_RAW" -maxdepth 1 -type f -name '*.jsonl' -print -quit)" ]]
done

# A missing or truncated destination is reconstructed from the source through
# the durable cursor before new bytes are appended.
printf '{"type":"after-delete"}\n' \
  >>"$SRC/12345678-1234-1234-1234-123456789abc.jsonl"
touch -d '10 days ago' "$SRC/12345678-1234-1234-1234-123456789abc.jsonl"
rm "$checkout_dest"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 1 --min-bytes 999999 \
    --src-dir "$TMP/source root"
cmp "$SRC/12345678-1234-1234-1234-123456789abc.jsonl" "$checkout_dest"

truncate -s 3 "$checkout_dest"
printf '{"type":"after-short-destination"}\n' \
  >>"$SRC/12345678-1234-1234-1234-123456789abc.jsonl"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$TMP/source root"
cmp "$SRC/12345678-1234-1234-1234-123456789abc.jsonl" "$checkout_dest"

# Cursor-loss recovery adopts a lineage-named orphan only when it is an exact
# source prefix. The original destination name survives a date boundary.
ORPHAN_ROOT="$TMP/orphan source"
ORPHAN_PROJECT="$ORPHAN_ROOT/project"
ORPHAN_RAW="$TMP/orphan raw"
ORPHAN_SOURCE="$ORPHAN_PROJECT/orphan-session.jsonl"
mkdir -p "$ORPHAN_PROJECT" "$ORPHAN_RAW"
printf 'durable-prefix-and-tail\n' >"$ORPHAN_SOURCE"
ORPHAN_DIGEST="$(
  printf 'north-stream-source-v3\0anthropic\0project\0orphan-session' |
    sha256sum | cut -d' ' -f1
)"
ORPHAN_NAME="2026-01-01-crash-recovery.$ORPHAN_DIGEST.jsonl"
head -c 7 "$ORPHAN_SOURCE" >"$ORPHAN_RAW/$ORPHAN_NAME"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$ORPHAN_ROOT" --raw-dir "$ORPHAN_RAW"
[[ "$(cut -f5 "$ORPHAN_RAW/.cursors")" == "$ORPHAN_NAME" ]]
[[ "$(find "$ORPHAN_RAW" -maxdepth 1 -type f -name '*.jsonl' | wc -l)" -eq 1 ]]
cmp "$ORPHAN_SOURCE" "$ORPHAN_RAW/$ORPHAN_NAME"

BAD_ORPHAN_ROOT="$TMP/bad orphan source"
BAD_ORPHAN_PROJECT="$BAD_ORPHAN_ROOT/project"
BAD_ORPHAN_RAW="$TMP/bad orphan raw"
BAD_ORPHAN_SOURCE="$BAD_ORPHAN_PROJECT/bad-orphan-session.jsonl"
mkdir -p "$BAD_ORPHAN_PROJECT" "$BAD_ORPHAN_RAW"
printf 'authoritative source\n' >"$BAD_ORPHAN_SOURCE"
BAD_ORPHAN_DIGEST="$(
  printf 'north-stream-source-v3\0anthropic\0project\0bad-orphan-session' |
    sha256sum | cut -d' ' -f1
)"
BAD_ORPHAN_NAME="2026-01-01-unproven.$BAD_ORPHAN_DIGEST.jsonl"
printf 'mismatched orphan\n' >"$BAD_ORPHAN_RAW/$BAD_ORPHAN_NAME"
BAD_ORPHAN_HASH="$(sha256sum "$BAD_ORPHAN_RAW/$BAD_ORPHAN_NAME")"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$BAD_ORPHAN_ROOT" --raw-dir "$BAD_ORPHAN_RAW" \
    >"$TMP/bad-orphan.out" 2>"$TMP/bad-orphan.err"; then
  echo "mismatched orphan destination was accepted" >&2
  exit 1
fi
grep -Fq "orphan_destination_mismatch; quarantined" "$TMP/bad-orphan.err"
[[ "$BAD_ORPHAN_HASH" == "$(sha256sum "$BAD_ORPHAN_RAW/$BAD_ORPHAN_NAME")" ]]
[[ ! -s "$BAD_ORPHAN_RAW/.cursors" ]]

# Full-session digests keep sessions sharing the old eight-character prefix
# distinct, even inside one project.
COLLISION_SRC="$TMP/collision source/project"
COLLISION_RAW="$TMP/collision raw"
mkdir -p "$COLLISION_SRC"
printf 'first-collision-session\n' \
  >"$COLLISION_SRC/deadbeef-1111-1111-1111-111111111111.jsonl"
printf 'second-collision-session\n' \
  >"$COLLISION_SRC/deadbeef-2222-2222-2222-222222222222.jsonl"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$TMP/collision source" --raw-dir "$COLLISION_RAW"
[[ "$(find "$COLLISION_RAW" -maxdepth 1 -type f -name '*.jsonl' | wc -l)" -eq 2 ]]
while IFS=$'\t' read -r version _bytes source digest destination prefix_digest; do
  [[ "$version" == v3 ]]
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]]
  [[ "$prefix_digest" =~ ^[0-9a-f]{64}$ ]]
  cmp "$source" "$COLLISION_RAW/$destination"
done <"$COLLISION_RAW/.cursors"

# A full UUID is not globally unique in Claude's real corpus. The project
# lineage is part of identity, so divergent same-UUID transcripts coexist.
REUSED_ROOT="$TMP/reused uuid source"
REUSED_A="$REUSED_ROOT/project-a"
REUSED_B="$REUSED_ROOT/project-b"
REUSED_RAW="$TMP/reused uuid raw"
REUSED_SESSION="010e0000-1111-2222-3333-444455556666"
mkdir -p "$REUSED_A" "$REUSED_B"
printf 'project-a history\n' >"$REUSED_A/$REUSED_SESSION.jsonl"
printf 'project-b divergent history\n' >"$REUSED_B/$REUSED_SESSION.jsonl"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$REUSED_ROOT" --raw-dir "$REUSED_RAW"
[[ "$(wc -l <"$REUSED_RAW/.cursors")" -eq 2 ]]
[[ "$(cut -f4 "$REUSED_RAW/.cursors" | sort -u | wc -l)" -eq 2 ]]
while IFS=$'\t' read -r version _bytes source _digest destination _prefix; do
  [[ "$version" == v3 ]]
  cmp "$source" "$REUSED_RAW/$destination"
done <"$REUSED_RAW/.cursors"

# Migrate a nonzero three-field cursor by adopting its exact legacy destination.
# Bytes past the cursor simulate a crash; the prefix is retained exactly once.
LEGACY_SRC_ROOT="$TMP/legacy source"
LEGACY_PROJECT="$LEGACY_SRC_ROOT/legacy-project"
LEGACY_RAW="$TMP/legacy raw"
LEGACY_SESSION="abcdefgh-1234-5678-9999-000000000000"
LEGACY_SOURCE="$LEGACY_PROJECT/$LEGACY_SESSION.jsonl"
mkdir -p "$LEGACY_PROJECT" "$LEGACY_RAW"
printf 'prefix-and-current-tail\n' >"$LEGACY_SOURCE"
printf 'prefix-duplicate-crash-garbage\n' \
  >"$LEGACY_RAW/2026-07-18-legacy-project.abcdefgh.jsonl"
printf '6\t%s\t2026-07-18\n' "$LEGACY_SOURCE" >"$LEGACY_RAW/.cursors"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$LEGACY_SRC_ROOT" --raw-dir "$LEGACY_RAW"
[[ ! -e "$LEGACY_RAW/2026-07-18-legacy-project.abcdefgh.jsonl" ]]
LEGACY_DEST="$(find "$LEGACY_RAW" -maxdepth 1 -type f -name '*.jsonl' -print -quit)"
cmp "$LEGACY_SOURCE" "$LEGACY_DEST"
[[ "$(cut -f1 "$LEGACY_RAW/.cursors")" == v3 ]]
[[ "$(awk -F'\t' '{print NF}' "$LEGACY_RAW/.cursors")" -eq 6 ]]

# The prior global-session v2 shape upgrades in place while preserving its
# exact destination ownership.
V2_ROOT="$TMP/v2 source"
V2_PROJECT="$V2_ROOT/project"
V2_RAW="$TMP/v2 raw"
V2_SOURCE="$V2_PROJECT/v2-session.jsonl"
V2_DEST_NAME="preserved-v2-destination.jsonl"
mkdir -p "$V2_PROJECT" "$V2_RAW"
printf 'v2-prefix-and-tail\n' >"$V2_SOURCE"
V2_BYTES=4
head -c "$V2_BYTES" "$V2_SOURCE" >"$V2_RAW/$V2_DEST_NAME"
V2_DIGEST="$(
  printf 'north-stream-session-v2\0v2-session' |
    sha256sum | cut -d' ' -f1
)"
V2_PREFIX="$(head -c "$V2_BYTES" "$V2_SOURCE" | sha256sum | cut -d' ' -f1)"
printf 'v2\t%s\t%s\t%s\t%s\t%s\n' \
  "$V2_BYTES" "$V2_SOURCE" "$V2_DIGEST" "$V2_DEST_NAME" "$V2_PREFIX" \
  >"$V2_RAW/.cursors"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$V2_ROOT" --raw-dir "$V2_RAW"
[[ "$(cut -f1 "$V2_RAW/.cursors")" == v3 ]]
[[ "$(cut -f5 "$V2_RAW/.cursors")" == "$V2_DEST_NAME" ]]
cmp "$V2_SOURCE" "$V2_RAW/$V2_DEST_NAME"

# An eight-character collision never destroys or adopts mismatched legacy
# content; the new destination is rebuilt from the exact source instead.
LEGACY_COLLISION_ROOT="$TMP/legacy collision source"
LEGACY_COLLISION_PROJECT="$LEGACY_COLLISION_ROOT/project"
LEGACY_COLLISION_RAW="$TMP/legacy collision raw"
LEGACY_COLLISION_SESSION="collision-aaaa-bbbb-cccc"
LEGACY_COLLISION_SOURCE="$LEGACY_COLLISION_PROJECT/$LEGACY_COLLISION_SESSION.jsonl"
LEGACY_COLLISION_OLD="$LEGACY_COLLISION_RAW/2026-07-18-project.collisio.jsonl"
mkdir -p "$LEGACY_COLLISION_PROJECT" "$LEGACY_COLLISION_RAW"
printf 'authoritative-source-content\n' >"$LEGACY_COLLISION_SOURCE"
printf 'different-session-content\n' >"$LEGACY_COLLISION_OLD"
printf '8\t%s\t2026-07-18\n' \
  "$LEGACY_COLLISION_SOURCE" >"$LEGACY_COLLISION_RAW/.cursors"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$LEGACY_COLLISION_ROOT" --raw-dir "$LEGACY_COLLISION_RAW"
grep -Fxq 'different-session-content' "$LEGACY_COLLISION_OLD"
LEGACY_COLLISION_NEW="$LEGACY_COLLISION_RAW/$(cut -f5 "$LEGACY_COLLISION_RAW/.cursors")"
cmp "$LEGACY_COLLISION_SOURCE" "$LEGACY_COLLISION_NEW"

# Validation precedes migration: a shrunk legacy source leaves the exact old
# destination and v1 cursor untouched while recording quarantine evidence.
LEGACY_SHRINK_ROOT="$TMP/legacy shrink source"
LEGACY_SHRINK_PROJECT="$LEGACY_SHRINK_ROOT/project"
LEGACY_SHRINK_RAW="$TMP/legacy shrink raw"
LEGACY_SHRINK_SESSION="shrunk00-rest"
LEGACY_SHRINK_SOURCE="$LEGACY_SHRINK_PROJECT/$LEGACY_SHRINK_SESSION.jsonl"
LEGACY_SHRINK_OLD="$LEGACY_SHRINK_RAW/2026-07-18-project.shrunk00.jsonl"
mkdir -p "$LEGACY_SHRINK_PROJECT" "$LEGACY_SHRINK_RAW"
printf 'tiny' >"$LEGACY_SHRINK_SOURCE"
printf 'durable-prefix-that-must-not-move\n' >"$LEGACY_SHRINK_OLD"
printf '12\t%s\t2026-07-18\n' \
  "$LEGACY_SHRINK_SOURCE" >"$LEGACY_SHRINK_RAW/.cursors"
LEGACY_SHRINK_CURSOR="$(sha256sum "$LEGACY_SHRINK_RAW/.cursors")"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$LEGACY_SHRINK_ROOT" --raw-dir "$LEGACY_SHRINK_RAW" \
    >"$TMP/legacy-shrink.out" 2>"$TMP/legacy-shrink.err"; then
  echo "shrunk legacy source was accepted" >&2
  exit 1
fi
[[ -e "$LEGACY_SHRINK_OLD" ]]
[[ "$LEGACY_SHRINK_CURSOR" == "$(sha256sum "$LEGACY_SHRINK_RAW/.cursors")" ]]
grep -Fq "source_shrank; quarantined" "$TMP/legacy-shrink.err"

# A project-directory rename updates source ownership by full session digest
# without moving or renaming the persisted destination.
RENAME_SRC_ROOT="$TMP/rename source"
RENAME_OLD="$RENAME_SRC_ROOT/old-project"
RENAME_NEW="$RENAME_SRC_ROOT/new-project"
RENAME_RAW="$TMP/rename raw"
RENAME_SESSION="rename-session-1234567890"
mkdir -p "$RENAME_OLD"
printf 'before-rename\n' >"$RENAME_OLD/$RENAME_SESSION.jsonl"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$RENAME_SRC_ROOT" --raw-dir "$RENAME_RAW"
RENAME_DEST="$(find "$RENAME_RAW" -maxdepth 1 -type f -name '*.jsonl' -print -quit)"
mv "$RENAME_OLD" "$RENAME_NEW"
printf 'after-rename\n' >>"$RENAME_NEW/$RENAME_SESSION.jsonl"
touch -d '10 days ago' "$RENAME_NEW/$RENAME_SESSION.jsonl"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 1 --min-bytes 999999 \
    --src-dir "$RENAME_SRC_ROOT" --raw-dir "$RENAME_RAW"
[[ "$(find "$RENAME_RAW" -maxdepth 1 -type f -name '*.jsonl' -print -quit)" == "$RENAME_DEST" ]]
[[ "$(cut -f3 "$RENAME_RAW/.cursors")" == "$RENAME_NEW/$RENAME_SESSION.jsonl" ]]
cmp "$RENAME_NEW/$RENAME_SESSION.jsonl" "$RENAME_DEST"

# Claude may reuse a session UUID in a different project lineage. Without
# prefix proof the new source becomes an independent stream; the disappeared
# lineage and its destination remain untouched.
MISMATCH_ROOT="$TMP/mismatch rename source"
MISMATCH_OLD="$MISMATCH_ROOT/old"
MISMATCH_NEW="$MISMATCH_ROOT/new"
MISMATCH_RAW="$TMP/mismatch rename raw"
MISMATCH_SESSION="same-session-id"
mkdir -p "$MISMATCH_OLD"
printf 'original durable prefix\n' >"$MISMATCH_OLD/$MISMATCH_SESSION.jsonl"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$MISMATCH_ROOT" --raw-dir "$MISMATCH_RAW"
MISMATCH_CURSOR="$(cat "$MISMATCH_RAW/.cursors")"
MISMATCH_DEST="$MISMATCH_RAW/$(cut -f5 "$MISMATCH_RAW/.cursors")"
rm -rf "$MISMATCH_OLD"
mkdir -p "$MISMATCH_NEW"
printf 'replacement is not the same stream\n' >"$MISMATCH_NEW/$MISMATCH_SESSION.jsonl"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$MISMATCH_ROOT" --raw-dir "$MISMATCH_RAW"
[[ "$(wc -l <"$MISMATCH_RAW/.cursors")" -eq 2 ]]
grep -Fxq "$MISMATCH_CURSOR" "$MISMATCH_RAW/.cursors"
grep -Fxq 'original durable prefix' "$MISMATCH_DEST"
MISMATCH_NEW_DEST="$MISMATCH_RAW/$(
  awk -F'\t' -v s="$MISMATCH_NEW/$MISMATCH_SESSION.jsonl" \
    '$3==s {print $5}' "$MISMATCH_RAW/.cursors"
)"
cmp "$MISMATCH_NEW/$MISMATCH_SESSION.jsonl" "$MISMATCH_NEW_DEST"
[[ "$MISMATCH_NEW_DEST" != "$MISMATCH_DEST" ]]

# Even valid prefix proof is not enough when two current sources claim the same
# disappeared cursor. Neither inherits it; all three lineages remain distinct.
AMBIG_ROOT="$TMP/ambiguous rename source"
AMBIG_OLD="$AMBIG_ROOT/old-project"
AMBIG_A="$AMBIG_ROOT/new-project-a"
AMBIG_B="$AMBIG_ROOT/new-project-b"
AMBIG_RAW="$TMP/ambiguous rename raw"
AMBIG_SESSION="ambiguous-session"
mkdir -p "$AMBIG_OLD"
printf 'shared durable history\n' >"$AMBIG_OLD/$AMBIG_SESSION.jsonl"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$AMBIG_ROOT" --raw-dir "$AMBIG_RAW"
AMBIG_OLD_CURSOR="$(cat "$AMBIG_RAW/.cursors")"
AMBIG_OLD_DEST="$AMBIG_RAW/$(cut -f5 "$AMBIG_RAW/.cursors")"
rm -rf "$AMBIG_OLD"
mkdir -p "$AMBIG_A" "$AMBIG_B"
printf 'shared durable history\ncontinuation a\n' >"$AMBIG_A/$AMBIG_SESSION.jsonl"
printf 'shared durable history\ncontinuation b\n' >"$AMBIG_B/$AMBIG_SESSION.jsonl"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$AMBIG_ROOT" --raw-dir "$AMBIG_RAW" \
    >"$TMP/ambiguous.out" 2>"$TMP/ambiguous.err"
grep -Fq "ambiguous session relocation" "$TMP/ambiguous.err"
[[ "$(wc -l <"$AMBIG_RAW/.cursors")" -eq 3 ]]
grep -Fxq "$AMBIG_OLD_CURSOR" "$AMBIG_RAW/.cursors"
grep -Fxq 'shared durable history' "$AMBIG_OLD_DEST"
for ambiguous_source in \
  "$AMBIG_A/$AMBIG_SESSION.jsonl" \
  "$AMBIG_B/$AMBIG_SESSION.jsonl"; do
  ambiguous_dest="$AMBIG_RAW/$(
    awk -F'\t' -v s="$ambiguous_source" '$3==s {print $5}' \
      "$AMBIG_RAW/.cursors"
  )"
  cmp "$ambiguous_source" "$ambiguous_dest"
  [[ "$ambiguous_dest" != "$AMBIG_OLD_DEST" ]]
done

# Same-path replacement or in-place prefix mutation is equally detectable.
MUTATE_ROOT="$TMP/mutate source"
MUTATE_PROJECT="$MUTATE_ROOT/project"
MUTATE_RAW="$TMP/mutate raw"
MUTATE_SOURCE="$MUTATE_PROJECT/mutate-session.jsonl"
mkdir -p "$MUTATE_PROJECT"
printf 'immutable-prefix\n' >"$MUTATE_SOURCE"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$MUTATE_ROOT" --raw-dir "$MUTATE_RAW"
MUTATE_DEST="$MUTATE_RAW/$(cut -f5 "$MUTATE_RAW/.cursors")"
MUTATE_CURSOR="$(cat "$MUTATE_RAW/.cursors")"
printf 'X' | dd of="$MUTATE_SOURCE" bs=1 seek=0 conv=notrunc status=none
printf 'larger replacement tail\n' >>"$MUTATE_SOURCE"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$MUTATE_ROOT" --raw-dir "$MUTATE_RAW" \
    >"$TMP/mutate.out" 2>"$TMP/mutate.err"; then
  echo "same-path prefix mutation was accepted" >&2
  exit 1
fi
grep -Fq "source_prefix_mismatch; quarantined" "$TMP/mutate.err"
[[ "$MUTATE_CURSOR" == "$(cat "$MUTATE_RAW/.cursors")" ]]
grep -Fxq 'immutable-prefix' "$MUTATE_DEST"

# Source truncation quarantines only that identity. Another safe transcript in
# the same scan still commits its bytes and cursor before the run reports error.
HEALTHY_SESSION="healthy-session"
HEALTHY_SOURCE="$RENAME_NEW/$HEALTHY_SESSION.jsonl"
printf 'healthy-before\n' >"$HEALTHY_SOURCE"
env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$RENAME_SRC_ROOT" --raw-dir "$RENAME_RAW"
HEALTHY_DEST="$RENAME_RAW/$(awk -F'\t' -v s="$HEALTHY_SOURCE" '$3==s{print $5}' "$RENAME_RAW/.cursors")"
BAD_CURSOR_BEFORE="$(awk -F'\t' -v s="$RENAME_NEW/$RENAME_SESSION.jsonl" '$3==s{print}' "$RENAME_RAW/.cursors")"
printf 'healthy-after\n' >>"$HEALTHY_SOURCE"
truncate -s 2 "$RENAME_NEW/$RENAME_SESSION.jsonl"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 999999 \
    --src-dir "$RENAME_SRC_ROOT" --raw-dir "$RENAME_RAW" \
    >"$TMP/shrink.out" 2>"$TMP/shrink.err"; then
  echo "source shrink was silently accepted" >&2
  exit 1
fi
grep -Fq "source_shrank; quarantined" "$TMP/shrink.err"
BAD_CURSOR_AFTER="$(awk -F'\t' -v s="$RENAME_NEW/$RENAME_SESSION.jsonl" '$3==s{print}' "$RENAME_RAW/.cursors")"
[[ "$BAD_CURSOR_BEFORE" == "$BAD_CURSOR_AFTER" ]]
cmp "$HEALTHY_SOURCE" "$HEALTHY_DEST"
grep -Fq $'v1\tsource_shrank\t' "$RENAME_RAW/.stream-sync-errors"
if env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$RENAME_SRC_ROOT" --raw-dir "$RENAME_RAW" \
    >"$TMP/shrink-repeat.out" 2>"$TMP/shrink-repeat.err"; then
  echo "persistently quarantined source went falsely green" >&2
  exit 1
fi
grep -Fq "source_shrank; quarantined" "$TMP/shrink-repeat.err"

# Copying is bounded to the source size captured at scan time. Growth injected
# immediately before dd remains for the next run instead of making destination
# bytes run ahead of their cursor.
GROW_ROOT="$TMP/grow source"
GROW_PROJECT="$GROW_ROOT/project"
GROW_RAW="$TMP/grow raw"
GROW_SOURCE="$GROW_PROJECT/grow-session.jsonl"
GROW_SHIM="$TMP/grow shim"
GROW_MARKER="$TMP/grow.marker"
REAL_DD="$(command -v dd)"
mkdir -p "$GROW_PROJECT" "$GROW_SHIM"
printf 'captured-before-growth\n' >"$GROW_SOURCE"
cat >"$GROW_SHIM/dd" <<EOF
#!/usr/bin/env bash
if [ ! -e "\$STREAM_TEST_GROW_MARKER" ]; then
  printf 'arrived-during-copy\n' >>"\$STREAM_TEST_GROW_SOURCE"
  : >"\$STREAM_TEST_GROW_MARKER"
fi
exec "$REAL_DD" "\$@"
EOF
chmod +x "$GROW_SHIM/dd"
CAPTURED_SIZE="$(wc -c <"$GROW_SOURCE" | tr -d '[:space:]')"
env -i HOME="$HOME_DIR" PATH="$GROW_SHIM:$SHIM:$HOST_PATH" \
  STREAM_TEST_GROW_SOURCE="$GROW_SOURCE" STREAM_TEST_GROW_MARKER="$GROW_MARKER" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$GROW_ROOT" --raw-dir "$GROW_RAW"
GROW_DEST="$GROW_RAW/$(cut -f5 "$GROW_RAW/.cursors")"
[[ "$(cut -f2 "$GROW_RAW/.cursors")" -eq "$CAPTURED_SIZE" ]]
[[ "$(wc -c <"$GROW_DEST" | tr -d '[:space:]')" -eq "$CAPTURED_SIZE" ]]
[[ "$(wc -c <"$GROW_SOURCE" | tr -d '[:space:]')" -gt "$CAPTURED_SIZE" ]]
env -i HOME="$HOME_DIR" PATH="$GROW_SHIM:$SHIM:$HOST_PATH" \
  STREAM_TEST_GROW_SOURCE="$GROW_SOURCE" STREAM_TEST_GROW_MARKER="$GROW_MARKER" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$GROW_ROOT" --raw-dir "$GROW_RAW"
cmp "$GROW_SOURCE" "$GROW_DEST"

XDG_STATE="$TMP/xdg state"
env -i HOME="$HOME_DIR" XDG_STATE_HOME="$XDG_STATE" \
  NORTH_PACKAGE_MODE=nix-store PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$TMP/source root"

packaged_raw="$XDG_STATE/north/streams/raw"
packaged_dest="$(find "$packaged_raw" -maxdepth 1 -type f -name '*.jsonl' -print -quit)"
[[ -n "$packaged_dest" ]]
cmp "$SRC/12345678-1234-1234-1234-123456789abc.jsonl" "$packaged_dest"

echo "package helper smoke tests: PASS"
