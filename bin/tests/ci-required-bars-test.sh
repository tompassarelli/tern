#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/ci.yml"

shell_bars=(
  bin/tests/north-on-spawn-stress-test.sh
  bin/tests/north-on-tooluse-stress-test.sh
  bin/tests/north-mark-delegated-test.sh
  bin/tests/identity-alias-test.sh
  bin/tests/native-identity-test.sh
  cli/tests/north-coord-up-test.sh
  cli/tests/coord-log-fence-integration-test.sh
)
clojure_bars=(
  cli/tests/agent-identity-publication-integration-test.clj
  cli/tests/agents-cli-test.clj
  cli/tests/dashboard-doctor-exit-test.clj
  cli/tests/live-feed-integration-test.clj
  cli/tests/map-contract-test.clj
  cli/tests/message-audience-integration-test.clj
  cli/tests/pending-pagination-integration-test.clj
  cli/tests/pred-cli-test.clj
  cli/tests/routing-report-test.clj
  cli/tests/spawn-process-integration-test.clj
  cli/tests/peer-command-integration-test.clj
  cli/tests/worktree-allocation-integration-test.clj
  cli/tests/worktree-janitor-integration-test.clj
  cli/tests/reactor-sweep-large-corpus-test.clj
)

for entrypoint in "${shell_bars[@]}"; do
  [[ -x "$ROOT/$entrypoint" ]]
  grep -Fq "bash $entrypoint" "$WORKFLOW"
done
for entrypoint in "${clojure_bars[@]}"; do
  [[ -f "$ROOT/$entrypoint" ]]
  grep -Fq "bb $entrypoint" "$WORKFLOW"
done

# These are literal workflow expressions, not shell expansions in this process.
# shellcheck disable=SC2016
grep -Fq 'gaffer_repository=$(north/bin/github-flake-input-pin north/flake.lock gaffer repository)' "$WORKFLOW"
# shellcheck disable=SC2016
grep -Fq 'gaffer_ref=$(north/bin/github-flake-input-pin north/flake.lock gaffer revision)' "$WORKFLOW"
# shellcheck disable=SC2016
grep -Fq 'FRAM_TEST_CHECKOUT: ${{ github.workspace }}/fram' "$WORKFLOW"
# shellcheck disable=SC2016
grep -Fq 'GAFFER_HOME: ${{ github.workspace }}/gaffer' "$WORKFLOW"
grep -Fq 'test -s ../fram/coordination.log' "$WORKFLOW"
grep -Fq 'FRAM_LOG=../fram/coordination.log' "$WORKFLOW"
grep -Fq "grep -Fq 'Stage 4: lifecycle-as-rules == hand-coded PASS'" "$WORKFLOW"

# The patched executable's behavioral smoke must remain connected all the way
# from its reusable entrypoint to the x86_64 check and the release build job.
# shellcheck disable=SC2016
grep -Fq 'bash ${./bin/tests/codex-managed-hook-failure-smoke.sh}' "$ROOT/flake.nix"
grep -Fq 'codex-managed-hook-failure = codexManagedHookFailureSmoke;' "$ROOT/flake.nix"
grep -Fq "'path:.#checks.x86_64-linux.codex-managed-hook-failure'" "$WORKFLOW"
