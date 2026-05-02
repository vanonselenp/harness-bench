#!/usr/bin/env bash
# Sets up a fresh workspace, starts the selected harness with prompt.md,
# then grades the completed run.
# Usage: ./runner/run-and-grade.sh <harness> <run-number>

set -euo pipefail

HARNESS="${1:?usage: run-and-grade.sh <harness> <run-number>}"
RUN_NUM="${2:?usage: run-and-grade.sh <harness> <run-number>}"

RIG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

set +e
"$RIG_ROOT/runner/run-single.sh" "$HARNESS" "$RUN_NUM"
RUN_EXIT=$?
set -e

if [ "$RUN_EXIT" -ne 0 ] && [ "${GRADE_ON_FAILURE:-0}" != "1" ]; then
  echo
  echo "==> not grading because harness exited with code $RUN_EXIT"
  echo "    To grade the produced workspace anyway, rerun with GRADE_ON_FAILURE=1"
  echo "    Or run manually: ./runner/grade-run.sh $HARNESS $RUN_NUM"
  exit "$RUN_EXIT"
fi

if [ "$RUN_EXIT" -ne 0 ]; then
  echo
  echo "==> grading despite harness exit code $RUN_EXIT because GRADE_ON_FAILURE=1"
fi

"$RIG_ROOT/runner/grade-run.sh" "$HARNESS" "$RUN_NUM"
