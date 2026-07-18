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
checkout_hash="$(sha256sum "$checkout_raw/.cursors")"

env -i HOME="$HOME_DIR" PATH="$SHIM:$HOST_PATH" \
  "$CHECKOUT/bin/north-stream-sync" --days 30 --min-bytes 1 \
    --src-dir "$TMP/source root"
[[ "$checkout_hash" == "$(sha256sum "$checkout_raw/.cursors")" ]]
cmp "$SRC/12345678-1234-1234-1234-123456789abc.jsonl" "$checkout_dest"

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
