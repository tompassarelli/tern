#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PIN="$ROOT/bin/github-flake-input-pin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

write_lock() {
  local input="$1" type="$2" owner="$3" repo="$4" rev="$5" hash="$6"
  jq -cn \
    --arg input "$input" \
    --arg type "$type" \
    --arg owner "$owner" \
    --arg repo "$repo" \
    --arg rev "$rev" \
    --arg hash "$hash" \
    '{nodes:{root:{inputs:{($input):"source_2"}},source_2:{locked:{type:$type,owner:$owner,repo:$repo,rev:$rev,narHash:$hash}}}}' \
    >"$TMP/flake.lock"
}

rev=0123456789abcdef0123456789abcdef01234567
write_lock fram github example fram "$rev" 'sha256-YWJjZA=='
[[ "$("$PIN" "$TMP/flake.lock" fram repository)" == example/fram ]]
[[ "$("$PIN" "$TMP/flake.lock" fram revision)" == "$rev" ]]
[[ "$("$PIN" "$TMP/flake.lock" fram url)" == https://github.com/example/fram.git ]]
"$PIN" "$TMP/flake.lock" fram json |
  jq -e --arg rev "$rev" \
    '.input == "fram" and .repository == "example/fram" and .rev == $rev and .narHash == "sha256-YWJjZA=="' \
    >/dev/null

for invalid in type owner revision hash; do
  case "$invalid" in
    type) write_lock fram git example fram "$rev" 'sha256-YWJjZA==' ;;
    owner) write_lock fram github 'example;touch-pwned' fram "$rev" 'sha256-YWJjZA==' ;;
    revision) write_lock fram github example fram main 'sha256-YWJjZA==' ;;
    hash) write_lock fram github example fram "$rev" 'not-a-hash' ;;
  esac
  if "$PIN" "$TMP/flake.lock" fram json >"$TMP/invalid.out" 2>&1; then
    echo "github-flake-input-pin test: accepted invalid $invalid" >&2
    exit 1
  fi
done

for invalid_root in missing follows-array missing-node unsafe-input; do
  case "$invalid_root" in
    missing)
      printf '{"nodes":{"root":{"inputs":{}}}}\n' >"$TMP/flake.lock"
      ;;
    follows-array)
      printf '{"nodes":{"root":{"inputs":{"fram":["parent","fram"]}}}}\n' >"$TMP/flake.lock"
      ;;
    missing-node)
      printf '{"nodes":{"root":{"inputs":{"fram":"absent"}}}}\n' >"$TMP/flake.lock"
      ;;
    unsafe-input)
      write_lock fram github example fram "$rev" 'sha256-YWJjZA=='
      ;;
  esac
  input=fram
  [[ "$invalid_root" == unsafe-input ]] && input='fram] | .evil'
  if "$PIN" "$TMP/flake.lock" "$input" repository >"$TMP/invalid-root.out" 2>"$TMP/invalid-root.err"; then
    echo "github-flake-input-pin test: accepted invalid root/input shape '$invalid_root'" >&2
    exit 1
  fi
  [[ ! -s "$TMP/invalid-root.out" ]]
  [[ -s "$TMP/invalid-root.err" ]]
done

for input in fram beagle; do
  current_repository="$("$PIN" "$ROOT/flake.lock" "$input" repository)"
  current_revision="$("$PIN" "$ROOT/flake.lock" "$input" revision)"
  [[ "$current_repository" == "$(jq -r --arg input "$input" '.nodes[.nodes.root.inputs[$input]].locked | .owner + "/" + .repo' "$ROOT/flake.lock")" ]]
  [[ "$current_revision" == "$(jq -r --arg input "$input" '.nodes[.nodes.root.inputs[$input]].locked.rev' "$ROOT/flake.lock")" ]]
done

echo "github flake input pin tests: PASS"
