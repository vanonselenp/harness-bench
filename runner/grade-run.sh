#!/usr/bin/env bash
# Grades a completed run by running the hidden test suite against it.
# Usage: ./runner/grade-run.sh <harness> <run-number>

set -euo pipefail

HARNESS="${1:?usage: grade-run.sh <harness> <run-number>}"
RUN_NUM="${2:?usage: grade-run.sh <harness> <run-number>}"

RIG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_PADDED=$(printf "%02d" "$RUN_NUM")
RUN_DIR="$RIG_ROOT/results/$HARNESS/run-$RUN_PADDED"
WORKSPACE="$RUN_DIR/workspace"

if [ ! -d "$WORKSPACE" ]; then
  echo "ERROR: no workspace at $WORKSPACE"
  exit 1
fi

# Build the workspace first. This is a typed-client benchmark, so a
# non-compiling solution is a grading failure rather than a warning.
echo "==> attempting build in workspace"
set +e
( cd "$WORKSPACE" && npm run build --silent ) > "$RUN_DIR/build-output.txt" 2>&1
BUILD_EXIT=$?
set -e

# Capture diff against starting state (rough — for metrics only)
# Exclude node_modules and dist so the count reflects the harness's own work.
DIFF_FILE="$RUN_DIR/diff.patch"
( cd "$RIG_ROOT" && diff -ruN \
  --exclude=node_modules --exclude=dist --exclude=.git --exclude='package-lock.json' \
  starting-state "$WORKSPACE" > "$DIFF_FILE" 2>/dev/null ) || true
DIFF_LINES=$(wc -l < "$DIFF_FILE" | tr -d ' ')

cd "$RIG_ROOT"
rm -f "$RIG_ROOT/hidden/last-grade.json"

# Make sure vitest is available at the rig root
if [ ! -d "$RIG_ROOT/node_modules" ]; then
  ( cd "$RIG_ROOT" && npm install --silent --no-audit --no-fund vitest@1.5.0 )
fi

if [ "$BUILD_EXIT" -eq 0 ]; then
  # Run the hidden tests with vitest. WORKSPACE_DIR tells the suite where
  # to look for the harness output.
  echo "==> running hidden tests against $WORKSPACE"
  set +e
  WORKSPACE_DIR="$WORKSPACE" \
    npx vitest run --config "$RIG_ROOT/vitest.hidden.config.mjs" \
    > "$RUN_DIR/test-output.txt" 2>&1
  TEST_EXIT=$?
  set -e
else
  echo "ERROR: build failed — skipping hidden tests"
  cp "$RUN_DIR/build-output.txt" "$RUN_DIR/test-output.txt"
  TEST_EXIT=$BUILD_EXIT
fi

# vitest writes JSON output to hidden/last-grade.json
if [ "$BUILD_EXIT" -eq 0 ] && [ -f "$RIG_ROOT/hidden/last-grade.json" ]; then
  cp "$RIG_ROOT/hidden/last-grade.json" "$RUN_DIR/grade.json"

  # Pull a quick summary
  PASS=$(node -e "
    const r = JSON.parse(require('fs').readFileSync('$RUN_DIR/grade.json', 'utf8'));
    console.log(r.numPassedTests ?? 0);
  ")
  TOTAL=$(node -e "
    const r = JSON.parse(require('fs').readFileSync('$RUN_DIR/grade.json', 'utf8'));
    console.log(r.numTotalTests ?? 0);
  ")
else
  PASS=0
  TOTAL=0
  if [ "$BUILD_EXIT" -ne 0 ]; then
    cat > "$RUN_DIR/grade.json" <<JSON
{"success":false,"numPassedTests":0,"numTotalTests":0,"testResults":[],"message":"build failed; hidden tests were not run"}
JSON
  else
    echo "WARN: no grade.json produced"
  fi
fi

# Build metrics.json — combines auto-captured and to-be-filled-in data
cat > "$RUN_DIR/metrics.json" <<JSON
{
  "harness": "$HARNESS",
  "run_number": $RUN_NUM,
  "graded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "build": {
    "attempted": true,
    "success": $([ "$BUILD_EXIT" -eq 0 ] && echo true || echo false),
    "exit_code": $BUILD_EXIT
  },
  "tests": {
    "passed": $PASS,
    "total": $TOTAL,
    "exit_code": $TEST_EXIT
  },
  "diff_lines": $DIFF_LINES,
  "manual_fields": {
    "start_time": null,
    "end_time": null,
    "wall_clock_seconds": null,
    "tool_calls": null,
    "clarifying_questions": null,
    "early_stop": null,
    "auth_path": null
  }
}
JSON

echo
echo "==> grade summary for $HARNESS run $RUN_PADDED"
echo "    tests passed: $PASS / $TOTAL"
echo "    diff lines:   $DIFF_LINES"
echo
echo "Now fill in $RUN_DIR/metrics.json -> manual_fields from your notes."
