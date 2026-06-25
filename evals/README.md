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

As defense-in-depth, each subprocess runs with `--disallowedTools Bash Edit Write NotebookEdit`, so
even if the early kill ever lost the race (e.g. a future CLI stopped emitting partial tool-use events),
an action skill still could not mutate anything — the tools that do are denied. This does not change
*which* skill the model invokes (what we measure): the `Skill` tool stays allowed and fires first.

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
`specificity` against the committed baseline in [`results/`](results). A scoped
`python3 evals/run_all.py --skills <name>` *merges* into the committed `baseline.json` (it refreshes
only that skill and leaves the others intact), so it is safe to re-run one skill at a time.

## Baseline

Captured with `--runs-per-query 3`, threshold 0.5 (full data in [`results/`](results); summary in
[`results/baseline.json`](results/baseline.json)). A description edit that moves any of these is the
signal to look at.

| Skill | Queries | Pass | Recall (should-trigger) | Specificity (should-not) |
|-------|--------:|-----:|:-----------------------:|:------------------------:|
| `create-issue`     | 18 | 18/18 | 1.0 | 1.0 |
| `implement-issue`  | 18 | 18/18 | 1.0 | 1.0 |
| `merge-pr`         | 18 | 18/18 | 1.0 | 1.0 |
| `get-repo-profile` | 18 | 18/18 | 1.0 | 1.0 |

Specificity is *real*, not just "nothing fired": each near-miss negative fires the **expected sibling**
skill (e.g. `implement issue 47` → `implement-issue`, `file an issue …` → `create-issue`,
`set up the repo profile` → `get-repo-profile`), recorded in each result's `fired` histogram.

## The `implement-issue` ↔ `merge-pr` boundary (#370)

The deliberately-close boundary #370's description edits targeted — sync an **in-flight** PR
(→ `implement-issue`) vs sync **as part of landing** (→ `merge-pr`) — is measured by
[`boundary-trigger-eval.json`](boundary-trigger-eval.json), run against **both** skills
([`results/boundary-implement-issue.json`](results/boundary-implement-issue.json),
[`results/boundary-merge-pr.json`](results/boundary-merge-pr.json)):

| Intent framing | Example | Fires | Result |
|----------------|---------|-------|--------|
| **In-flight** ("still building it, sync the branch / rebase / keep it mergeable") | *"rebase my in-flight feature branch on main and resolve the conflicts while I keep adding tasks"* | `implement-issue` | 3/3 ✓ |
| **Land-now** ("merge it now, resolve conflicts as part of landing / squash-merge") | *"land #281: fix the conflicts with main and squash-merge it"* | `merge-pr` | 3/3 ✓ |

All six framings resolve to exactly one skill, 3/3 each — **#370's edits cleanly separate the two
intents.** The genuinely *unmarked* query (no in-flight/land-now cue), `"the PR conflicts with main,
fix it"`, defaults to **`implement-issue`** (the sync interpretation) — `merge-pr` never fired for it —
so a bare "fix the conflicts" never accidentally *lands* a PR. No description gap found; no follow-up
needed.
