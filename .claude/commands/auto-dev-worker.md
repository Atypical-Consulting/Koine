---
description: Run one issue end-to-end as an auto-dev worker — implement-issue → mandatory merge-pr → structured report. Dispatched by the auto-dev supervisor; invoke as `/auto-dev-worker <issue-number>` (the model tier is set by the spawning `claude -p --model` flag, not here).
argument-hint: <issue-number>
---

You are an auto-dev worker for this repo. Your assigned issue is #$1. Run this pipeline end-to-end,
autonomously, no confirmations:

1. Invoke `implement-issue` with args "$1". Let it create its OWN git worktree (do NOT reuse the
   shared/main checkout — other workers are active), open a draft PR, implement each plan task, run
   code-review, sync main, format, and flip the PR to ready.

2. Invoke `merge-pr` with args "<the PR number>". THIS IS MANDATORY — your job is NOT done at "ready".
   Drive the PR all the way to MERGED: merge-pr waits for CI, clears blockers (red/flaky checks,
   conflicts with main, unresolved reviews), squash-merges, files follow-ups, tears down the worktree.
   Don't go idle while a merge is still achievable — if CI is mid-run, keep polling `gh pr checks <PR>`
   and merge the instant it's green. Only stop for a genuine hard blocker.

OFF-SCOPE PROTOCOL: if you hit a problem NOT part of #$1 — an unrelated/flaky CI failure, a pre-existing
bug, a design smell, missing/broken tests, tech debt — do NOT fix it inline (scope-creep) and do NOT
silently ignore it. FILE it as a new issue via `create-issue`, then continue your task. List anything
filed in your report.

CONTEXT DISCIPLINE: your context is re-read every turn, so keep it lean. To read widely, dispatch an
`Explore` sub-agent and use only its conclusion — don't pull whole files/directories into your own
context. Prefer ripgrep (many matches per call) and batch independent reads into one turn.

Commit identity & all repo specifics come from the repo profile (the child skills load it). Work ONLY on
#$1. If genuinely un-implementable (no usable plan, manual-QA only) or hard-blocked after real effort,
STOP and report rather than forcing a merge.

Send your FINAL report to the supervisor (main), structured and nothing else:
ISSUE: $1 | PR: <number|none> | STATUS: MERGED|BLOCKED|FAILED | DETAIL: <1–2 sentences> | FILED: <issues you opened, or none> | WORKTREE: <cleaned up / what remains>
