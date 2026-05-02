#!/usr/bin/env bash
# Sets up a fresh workspace for a single run.
# Usage: ./runner/setup-run.sh <harness> <run-number>
# Example: ./runner/setup-run.sh claude-code 1

set -euo pipefail

HARNESS="${1:?usage: setup-run.sh <harness> <run-number>}"
RUN_NUM="${2:?usage: setup-run.sh <harness> <run-number>}"

# Validate harness name
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

if [ -d "$RUN_DIR" ]; then
  echo "ERROR: $RUN_DIR already exists. Delete it first if you want to redo this run."
  exit 1
fi

mkdir -p "$WORKSPACE"

# Copy starting state into the workspace (but NOT hidden/, NOT runner/, NOT results/)
cp -R "$RIG_ROOT/starting-state/." "$WORKSPACE/"
# Make the spec available inside the workspace so the harness can read it
mkdir -p "$WORKSPACE/spec"
cp "$RIG_ROOT/spec/library-api.yaml" "$WORKSPACE/spec/"

# Install deps so the harness can run typecheck/test against its own work
( cd "$WORKSPACE" && npm install --silent --no-audit --no-fund ) || {
  echo "WARN: npm install failed — continue anyway, harness can install"
}

# Record the start state
cat > "$RUN_DIR/run-info.json" <<JSON
{
  "harness": "$HARNESS",
  "run_number": $RUN_NUM,
  "setup_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "rig_commit": "$(cd "$RIG_ROOT" && git rev-parse HEAD 2>/dev/null || echo "not-a-git-repo")"
}
JSON

# Empty placeholders the user fills in
touch "$RUN_DIR/transcript.txt"
cat > "$RUN_DIR/notes.md" <<MD
# Run notes — $HARNESS run $RUN_PADDED

## Wall clock
- start: <fill in: ISO8601>
- end:   <fill in: ISO8601>

## Auth path
- <e.g. "Codex CLI signed into ChatGPT Plus" / "OpenCode Zen API key" / "BYO Anthropic key">

## Tool call observations
- approx tool calls: <count>
- clarifying questions asked: <count>
- early stop? <yes/no, with reason>

## Qualitative
- communication style:
- moments worth flagging:
MD

cat <<EOF

Workspace ready: $WORKSPACE

Now do this manually:
  1. cd $WORKSPACE
  2. Start your harness with the right model:
       claude-code:     claude --model claude-opus-4-7
       codex:           codex --model gpt-5.5     (must be signed into ChatGPT)
       opencode-gpt:    opencode  (configured for gpt-5.5)
       opencode-opus:   opencode  (configured for claude-opus-4-6)
       pi-gpt:          pi        (configured for gpt-5.5)
       pi-opus:         pi        (configured for claude-opus-4-7, fallback 4.6)
  3. Paste the prompt from prompt.md
  4. Note the start time. Let the harness run.
  5. When the harness says it's done, note the end time.
  6. Save the transcript to: $RUN_DIR/transcript.txt
  7. Fill in: $RUN_DIR/notes.md
  8. Then run: ./runner/grade-run.sh $HARNESS $RUN_NUM
EOF
