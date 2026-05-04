#!/usr/bin/env bash
# Runs and grades every configured harness for runs 1 through 5.
# Usage: ./runner/run-all.sh
# Optional env:
#   RUNS="1 2 3"                 Override run numbers
#   HARNESSES="claude-code codex" Override harness list
#   CONTINUE_ON_FAILURE=1         Continue after a failed harness run
#   GRADE_ON_FAILURE=1            Grade workspaces even if harness exits non-zero

set -euo pipefail

RIG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

RUNS="${RUNS:-1 2 3 4 5}"
HARNESSES="${HARNESSES:-claude-code codex opencode-gpt opencode-opus pi-gpt pi-opus}"
CONTINUE_ON_FAILURE="${CONTINUE_ON_FAILURE:-0}"

failures=()

for run in $RUNS; do
  for harness in $HARNESSES; do
    echo
    echo "==> running $harness run $run"

    if GRADE_ON_FAILURE="${GRADE_ON_FAILURE:-0}" "$RIG_ROOT/runner/run-and-grade.sh" "$harness" "$run"; then
      echo "==> completed $harness run $run"
    else
      status=$?
      failures+=("$harness run $run exited $status")
      echo "ERROR: $harness run $run failed with exit code $status"

      if [ "$CONTINUE_ON_FAILURE" != "1" ]; then
        echo
        echo "Stopping. Re-run with CONTINUE_ON_FAILURE=1 to keep going."
        exit "$status"
      fi
    fi
  done
done

echo
"$RIG_ROOT/runner/summarise.sh"

if [ "${#failures[@]}" -gt 0 ]; then
  echo
  echo "Failures:"
  for failure in "${failures[@]}"; do
    echo "- $failure"
  done
  exit 1
fi
