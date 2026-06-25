# Skill-triggering evals

A **safe, repeatable** regression check for the four lifecycle skills' *descriptions* —
[`create-issue`](../.claude/skills/create-issue), [`implement-issue`](../.claude/skills/implement-issue),
[`merge-pr`](../.claude/skills/merge-pr), [`get-repo-profile`](../.claude/skills/get-repo-profile).

A skill's `description` is the *only* thing deciding when it fires, and the four boundaries are
deliberately close (e.g. `implement-issue` "sync an **in-flight** PR" vs `merge-pr` "sync **as part of
landing**"). With no automated coverage, a description edit can silently start over- or under-firing.
These evals catch that: each skill has a set of should-trigger phrasings and near-miss negatives, and
[`trigger_eval.py`](trigger_eval.py) measures the trigger rate of the *installed* description.

> Tooling/test-infra only — no product code. Issue #372 (builds on #370).

## Why a local runner (the `run_eval` 0-trigger diagnosis)

skill-creator ships `scripts/run_eval.py`, which tests a description by writing it as a **uniquified**
synthetic command file `<skill>-skill-<uuid>.md` and counting a trigger only when that exact
uuid-suffixed name appears in the model's `Skill`/`Read` tool input. During #370 it reported **0
triggers for every query across every description** here — the fingerprint of a broken detector, not a
weak description.

**Root cause:** in this repo all four lifecycle skills are *already installed* under `.claude/skills/`.
So a should-trigger query makes the model invoke the **canonical** skill — `Skill(skill="get-repo-profile")` —
never the uuid-suffixed `get-repo-profile-skill-<uuid>` the matcher waits for. The substring test
`clean_name in accumulated_json` therefore never matches → 0 triggers, regardless of description
quality. (Confirmed three ways: a raw `claude -p` capture of the real-skill query, a faithful
synthetic-command reproduction, and running the real `run_eval.py` — all fire the canonical name; the
uuid-suffixed name is absent. The stream event *shapes* — `stream_event` / `content_block_start` /
`content_block_delta` — match the detector exactly; only the matcher's expected *name* is wrong.)

**The fix** (`trigger_eval.py`): match the **canonical installed skill name** in addition to the
synthetic uuid-suffixed one. Detection then registers real triggers. The runner also records *which*
skill fired, so the `implement-issue` vs `merge-pr` boundary can be read off a single run.

## Safety (why this is safe even for the action skills)

A should-trigger query like *"merge PR 279"* makes the model invoke the **real** `merge-pr` skill — we
must never let it run. Safety comes from **killing the `claude -p` subprocess the instant a tool-use
intent is detected in the stream**, which is emitted while the assistant message is still streaming —
strictly *before* the harness executes the tool. At most one tool-use is ever observed per run, and the
process is killed before it executes. The synthetic command file is kept for faithfulness to the
skill-creator approach, but it is the **early kill** — not the command file — that makes this safe when
the real skills are installed. The runner never runs a skill body; it only observes the *intent* to.

## How to run

Requires the `claude` CLI on `PATH` and run from inside the repo (the runner strips `CLAUDECODE` so
`claude -p` can nest inside a Claude Code session). Each skill has a `<skill>-trigger-eval.json` set:

```bash
# one skill
python3 evals/trigger_eval.py --skill get-repo-profile \
  --eval-set evals/get-repo-profile-trigger-eval.json \
  --runs-per-query 3 --out evals/results/get-repo-profile.json

# all four + the boundary, refreshing the committed baseline
python3 evals/run_all.py --runs-per-query 3
```

Eval-set entries are `{"query": "...", "should_trigger": true|false, "note": "..."}`. A skill **passes**
a query when its trigger rate is `≥ threshold` (default 0.5) for should-trigger entries, and `< threshold`
for should-not entries. Treat run-to-run flakiness with `--runs-per-query ≥ 3`.

To re-check after a description edit: re-run the affected skill's set and compare `recall` /
`specificity` against the committed baseline in [`results/`](results).
