#!/usr/bin/env bash
# Prove the effective container build context is a tiny, exact service allowlist.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
ENGINE="${CONTAINER_ENGINE:-podman}"
TAG="localhost/north-context-audit:${USER:-user}-$$"
SERVICE_TAG="localhost/north-service-audit:${USER:-user}-$$"
TMP="$(mktemp -d)"
CONTAINER=

cleanup() {
  if [[ -n "$CONTAINER" ]]; then
    "$ENGINE" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  "$ENGINE" image rm -f "$TAG" >/dev/null 2>&1 || true
  "$ENGINE" image rm -f "$SERVICE_TAG" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

"$ENGINE" build --target context-audit -t "$TAG" "$ROOT" >/dev/null
CONTAINER="$("$ENGINE" create "$TAG" /context)"
"$ENGINE" export -o "$TMP/context.tar" "$CONTAINER"
mkdir "$TMP/unpacked"
tar -xf "$TMP/context.tar" -C "$TMP/unpacked"

CONTEXT="$TMP/unpacked/context"
[[ -d "$CONTEXT" ]]
actual="$(
  cd "$CONTEXT"
  find . -type f -printf '%P\n' | LC_ALL=C sort
)"
expected="$(LC_ALL=C sort <<'EOF'
.dockerignore
Dockerfile
LICENSE
bin/github-flake-input-pin
deploy/gateway/gateway.clj
flake.lock
out/north/gatepolicy.clj
EOF
)"

if [[ "$actual" != "$expected" ]]; then
  echo "docker context test: effective file inventory drifted" >&2
  diff -u <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >&2 || true
  exit 1
fi

bytes="$(du -sb "$CONTEXT" | awk '{print $1}')"
if ((bytes > 524288)); then
  echo "docker context test: context is $bytes bytes (limit 524288)" >&2
  exit 1
fi

for forbidden in \
  sdk/node_modules streams/raw docs/private .git .direnv .hex .mix \
  web-v1-archive .qa-shots accounts telemetry.log facts.log; do
  if find "$CONTEXT" -path "*$forbidden*" -print -quit | grep -q .; then
    echo "docker context test: forbidden path entered context: $forbidden" >&2
    exit 1
  fi
done

"$ENGINE" build -t "$SERVICE_TAG" "$ROOT" >/dev/null
"$ENGINE" run --rm "$SERVICE_TAG" bash -c '
  set -euo pipefail
  test -s /opt/fram/.north-pinned-source
  test ! -e /opt/fram/.git
  if find /opt -type d -name .git -print -quit | grep -q .; then
    exit 1
  fi
'

printf 'docker closure: PASS · %s context bytes · %s context files · no runtime .git\n' \
  "$bytes" "$(printf '%s\n' "$actual" | wc -l)"
