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

# Try to build the workspace if there's a tsconfig — we want to test
# the compiled output where possible.
echo "==> attempting build in workspace"
( cd "$WORKSPACE" && npm run build --silent 2>&1 ) || {
  echo "WARN: build failed or no build script — tests will try src/ directly"
}

# Capture diff against starting state (rough — for metrics only)
# Exclude node_modules and dist so the count reflects the harness's own work.
DIFF_FILE="$RUN_DIR/diff.patch"
( cd "$RIG_ROOT" && diff -ruN \
  --exclude=node_modules --exclude=dist --exclude=.git --exclude='package-lock.json' \
  starting-state "$WORKSPACE" > "$DIFF_FILE" 2>/dev/null ) || true
DIFF_LINES=$(wc -l < "$DIFF_FILE" | tr -d ' ')

# Run the hidden tests with vitest. WORKSPACE_DIR tells the suite where
# to look for the harness output.
echo "==> running hidden tests against $WORKSPACE"
cd "$RIG_ROOT"

# Make sure vitest is available at the rig root
if [ ! -d "$RIG_ROOT/node_modules" ]; then
  ( cd "$RIG_ROOT" && npm install --silent --no-audit --no-fund vitest@1.5.0 )
fi

set +e
WORKSPACE_DIR="$WORKSPACE" \
  npx vitest run --config "$RIG_ROOT/vitest.hidden.config.mjs" \
  > "$RUN_DIR/test-output.txt" 2>&1
TEST_EXIT=$?
set -e

# vitest writes JSON output to hidden/last-grade.json
if [ -f "$RIG_ROOT/hidden/last-grade.json" ]; then
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
  echo "WARN: no grade.json produced"
fi

# Build metrics.json — combines auto-captured and to-be-filled-in data
cat > "$RUN_DIR/metrics.json" <<JSON
{
  "harness": "$HARNESS",
  "run_number": $RUN_NUM,
  "graded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
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
