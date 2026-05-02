# Multi-Harness Experiment

A rig for measuring how four AI coding harnesses behave on the same task,
across six harness/model cells, five runs each. Thirty runs total.

## The matrix

| Cell | Harness     | Model           | Notes                                    |
|------|-------------|-----------------|------------------------------------------|
| 1    | Claude Code | claude-opus-4-7 |                                          |
| 2    | Codex CLI   | gpt-5.5         | Requires ChatGPT auth (not API key)      |
| 3    | OpenCode    | gpt-5.5         | Auth path depends on local config        |
| 4    | OpenCode    | claude-opus-4-6 | Zen backend doesn't yet support 4.7      |
| 5    | pi.dev      | gpt-5.5         | Auth path depends on local config        |
| 6    | pi.dev      | claude-opus-4-7 | Falls back to 4.6 if unavailable         |

## What this measures

Build a typed TypeScript client for a synthetic Library API given an
OpenAPI spec. The same prompt, AGENTS.md, and starting state are used
for every run. After each run, a hidden test suite runs against whatever
the harness produced. The hidden tests are never visible to the harness.

## How to run a single cell

One-command setup, launch, and grade:

```bash
./runner/run-and-grade.sh <harness> <run-number>
# e.g. ./runner/run-and-grade.sh claude-code 1
```

If the harness command exits non-zero, grading is skipped by default. To grade
whatever was produced anyway:

```bash
GRADE_ON_FAILURE=1 ./runner/run-and-grade.sh <harness> <run-number>
```

One-command setup and launch only:

```bash
./runner/run-single.sh <harness> <run-number>
# e.g. ./runner/run-single.sh claude-code 1
```

This creates `results/<harness>/run-XX/workspace/`, starts the selected
harness from inside that workspace, passes in `prompt.md`, and records the
conversation to `transcript.txt`. After the harness exits, grade it:

```bash
./runner/grade-run.sh <harness> <run-number>
```

You can override the launch command for local config differences:

```bash
CLAUDE_CODE_CMD='claude --model claude-opus-4-7 "$RUN_PROMPT"' ./runner/run-single.sh claude-code 1
CODEX_CMD='codex exec --model gpt-5.5 "$RUN_PROMPT"' ./runner/run-single.sh codex 1
OPENCODE_GPT_CMD='opencode run --model openai/gpt-5.5 "$RUN_PROMPT"' ./runner/run-single.sh opencode-gpt 1
```

For `claude-code` runs, setup also writes
`workspace/.claude/settings.json` from `runner/claude-settings.json`. This
pre-approves routine file edits and local project commands while leaving any
other shell command subject to Claude Code's normal prompt.

Manual setup flow:

```bash
# Set up a fresh working directory for one run
./runner/setup-run.sh <harness> <run-number>
# e.g. ./runner/setup-run.sh claude-code 1
# This creates: results/claude-code/run-01/workspace/

# Now cd into that workspace and run the harness yourself, manually,
# with the prompt from prompt.md. Note start time and end time.

cd results/claude-code/run-01/workspace
# claude --model claude-opus-4-7 ... (paste prompt.md content)

# When the harness says it's done, exit and grade:
cd /path/to/rig
./runner/grade-run.sh claude-code 1

# This produces results/claude-code/run-01/grade.json and metrics.json
```

## What gets captured per run

- `workspace/` — what the harness produced
- `transcript.txt` — paste the harness conversation here yourself
- `metrics.json` — wall clock, diff size, your manual notes on tool calls
- `grade.json` — hidden test pass/fail
- `notes.md` — your qualitative read after reviewing the transcript

## Methodology notes

Auth paths differ across cells. GPT-5.5 in Codex CLI requires ChatGPT
authentication; in OpenCode and pi.dev it may route through different
backends. This is recorded per-run in `metrics.json` under `auth_path`
and is a real candidate explanation for any harness-level differences
in the GPT-5.5 cells.

LLM output is non-deterministic even at fixed sampling. Five runs per
cell gives medians; we will not claim more than that.
