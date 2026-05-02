#!/usr/bin/env bash
# Sets up a fresh workspace for one run, then starts the selected harness
# with prompt.md as the initial prompt.
# Usage: ./runner/run-single.sh <harness> <run-number>

set -euo pipefail

HARNESS="${1:?usage: run-single.sh <harness> <run-number>}"
RUN_NUM="${2:?usage: run-single.sh <harness> <run-number>}"

case "$HARNESS" in
  claude-code|codex|opencode-gpt|opencode-opus|pi-gpt|pi-opus) ;;
  *)
    echo "ERROR: unknown harness '$HARNESS'"
    echo "valid: claude-code | codex | opencode-gpt | opencode-opus | pi-gpt | pi-opus"
    exit 1
    ;;
esac

RIG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_PADDED=$(printf "%02d" "$RUN_NUM")
RUN_DIR="$RIG_ROOT/results/$HARNESS/run-$RUN_PADDED"
WORKSPACE="$RUN_DIR/workspace"
PROMPT_FILE="$RIG_ROOT/prompt.md"

"$RIG_ROOT/runner/setup-run.sh" "$HARNESS" "$RUN_NUM"

RUN_PROMPT="$(<"$PROMPT_FILE")"
export RUN_PROMPT

case "$HARNESS" in
  claude-code)
    DEFAULT_CMD='claude --model claude-opus-4-7 "$RUN_PROMPT"'
    OVERRIDE_VAR="CLAUDE_CODE_CMD"
    ;;
  codex)
    DEFAULT_CMD='codex exec --model gpt-5.5 "$RUN_PROMPT"'
    OVERRIDE_VAR="CODEX_CMD"
    ;;
  opencode-gpt)
    DEFAULT_CMD='opencode run "$RUN_PROMPT"'
    OVERRIDE_VAR="OPENCODE_GPT_CMD"
    ;;
  opencode-opus)
    DEFAULT_CMD='opencode run "$RUN_PROMPT"'
    OVERRIDE_VAR="OPENCODE_OPUS_CMD"
    ;;
  pi-gpt)
    DEFAULT_CMD='pi "$RUN_PROMPT"'
    OVERRIDE_VAR="PI_GPT_CMD"
    ;;
  pi-opus)
    DEFAULT_CMD='pi "$RUN_PROMPT"'
    OVERRIDE_VAR="PI_OPUS_CMD"
    ;;
esac

CMD="${!OVERRIDE_VAR:-$DEFAULT_CMD}"
START_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

node -e '
const fs = require("node:fs");
const [path, harness, runNumber, startedAt, command, overrideEnvVar] = process.argv.slice(1);
fs.writeFileSync(path, JSON.stringify({
  harness,
  run_number: Number(runNumber),
  started_at: startedAt,
  command,
  override_env_var: overrideEnvVar,
}, null, 2) + "\n");
' "$RUN_DIR/launch.json" "$HARNESS" "$RUN_NUM" "$START_TIME" "$CMD" "$OVERRIDE_VAR"

echo
echo "==> starting $HARNESS run $RUN_PADDED"
echo "    workspace:  $WORKSPACE"
echo "    transcript: $RUN_DIR/transcript.txt"
echo "    command:    $CMD"
echo

set +e
(
  cd "$WORKSPACE"
  bash -lc "$CMD"
) 2>&1 | tee "$RUN_DIR/transcript.txt"
HARNESS_EXIT=${PIPESTATUS[0]}
set -e

END_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

node -e '
const fs = require("node:fs");
const path = process.argv[1];
const launch = JSON.parse(fs.readFileSync(path, "utf8"));
launch.ended_at = process.argv[2];
launch.exit_code = Number(process.argv[3]);
fs.writeFileSync(path, JSON.stringify(launch, null, 2) + "\n");
' "$RUN_DIR/launch.json" "$END_TIME" "$HARNESS_EXIT"

echo
echo "==> harness exited with code $HARNESS_EXIT"
echo "    start: $START_TIME"
echo "    end:   $END_TIME"
echo
echo "Next: ./runner/grade-run.sh $HARNESS $RUN_NUM"

exit "$HARNESS_EXIT"
