#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

grep -Fq '"test": "bun test --isolate --preload ./test/support/hermetic-preload.ts ./test"' \
  "$ROOT/sdk/package.json"
grep -Fq 'cd ~/code/north/sdk && bun run check && bun run test' "$ROOT/AGENTS.md"
grep -Eq '^[[:space:]]+bun run test[[:space:]]*$' "$ROOT/.github/workflows/ci.yml"

if grep -Eq '^[[:space:]]+bun test[[:space:]]*$' "$ROOT/.github/workflows/ci.yml"; then
  echo "CI bypasses the SDK package's hermetic test entrypoint" >&2
  exit 1
fi
if grep -Fq 'bun test ./test' "$ROOT/AGENTS.md"; then
  echo "AGENTS.md recommends a non-hermetic SDK test command" >&2
  exit 1
fi
