---
name: auto-dev
description: >-
  Autonomously burn down a GitHub issue backlog by running a FLEET of parallel sub-agents, each taking
  one issue through its whole lifecycle — `implement-issue` → `merge-pr` → report — and immediately
  picking up the next one, so N issues are always in flight. This is the orchestrator that sits ABOVE
  `implement-issue`/`merge-pr`/`create-issue`: it surveys the open issues, orders them (small effort
  first, then medium), assigns each worker an issue in a NON-overlapping code area to avoid merge
  conflicts, keeps exactly N workers running (ends each agent the moment its PR merges and dispatches a
  replacement), makes workers file off-scope problems they discover as fresh issues, and verifies real
  merge state itself because workers tend to idle at "PR ready" without landing. ALWAYS reach for this
  whenever the user wants to work through MANY issues hands-off with parallelism — "implement issues
  small first then medium with 3 agents", "keep N agents continuously implementing and merging issues",
  "burn down the backlog", "run the auto-dev loop", "spin up a fleet of agents to clear open issues",
  "auto-implement and merge everything that's ready" — including the loose phrasings and any request
  pairing `implement-issue` with `merge-pr` across a queue rather than one issue. Composes with the
  `loop` skill for the self-paced heartbeat. Does NOT apply to building ONE specific issue (that's
  `implement-issue` directly), landing ONE specific PR (`merge-pr`), or filing a single issue
  (`create-issue`) — auto-dev is the multi-issue, multi-agent supervisor that drives those skills at scale.
---

# auto-dev — a continuous fleet that implements and merges issues

## What this does and why

`implement-issue` turns one planned issue into a ready PR; `merge-pr` lands one PR. Run by hand, you
drive them one issue at a time. **auto-dev is the supervisor that drives them at scale**: it keeps a
fleet of **N** background workers churning through the backlog, each worker owning one issue end-to-end
(`implement-issue <N>` → `merge-pr <PR>`), and the moment a worker's PR merges it is retired and a fresh
worker is dispatched onto the next queued issue — so the repo always has N issues in flight without you
babysitting.

The value is in the **orchestration around** those skills, which is where a naive "just run them in a
loop" falls down:

- **Conflict avoidance** — N PRs against one `main` collide if they touch the same files. auto-dev
  assigns each concurrent worker an issue in a *different* code area, so branches rarely conflict.
- **Ordering** — small, self-contained issues first (fast wins, fewer conflicts), then medium. Large/XL
  and manual-QA issues are excluded by default.
- **Mandatory merge** — workers love to stop at "PR is ready." That's half a job. auto-dev verifies the
  *real* merge state from GitHub on every signal and re-drives any worker that idled before landing.
- **Off-scope capture** — a worker that trips over an unrelated bug, flaky CI, or tech debt files it via
  `create-issue` instead of fixing it inline (scope-creep) or dropping it. The backlog grows truthfully.
- **Lifecycle hygiene** — finished agents are shut down, not left idle; a persistent state file survives
  restarts so the fleet is resumable.

## Autonomy contract (important)

The user starts this and walks away — they watch a backlog drain, they don't approve each step. Run
**hands-off**: pick the most reasonable default, state it, keep going. Only stop for genuine blockers:

- `gh` is unauthenticated, or you lack push/merge rights.
- There are **no eligible issues** (queue empty after filtering) — report that the backlog is drained.
- A worker reports a hard blocker it honestly can't pass (tests it can't green, a both-sides-rewrote-the
  -same-logic conflict, a required approval it can't give itself). Surface it; don't force a merge.

Never fake progress: a checkbox, a "ready" flip, or a merge is a claim that work is *done* — back each
with evidence, exactly as the child skills require. Spawning a worker and filing a follow-up are cheap
and reversible; **the squash-merge is the irreversible act** — it only happens through `merge-pr` on a
green, mergeable PR, never via an `--admin` override here.

## Inputs

- **Concurrency `N`** — how many workers run at once. Default **3**. More workers = more throughput but
  more merge contention and more areas to keep disjoint; 3–4 is the sweet spot for most repos.
- **Ordering** — default **effort: small first, then medium**. Honor whatever the user said.
- **Eligible set / filters** — default to open issues that (a) carry an implementation plan, (b) are code
  tasks (not manual "QA"/"verify by hand"), and (c) are within the effort ceiling (default ≤ medium).
  The user may narrow it ("only `studio` issues", "everything labeled `priority: high`") — respect that.
- **Heartbeat** — this skill is normally launched *via* `loop` in dynamic mode (no interval), so the
  loop's self-paced wakeup is the supervisor's heartbeat. If invoked directly, arm your own wakeup.

## How it works (the model)

```
        ┌─────────────────────── auto-dev (you, the supervisor) ───────────────────────┐
        │  state file: queue (small→medium), in-flight slots, completed, filed          │
        │  on every signal → reconcile vs GitHub → end-merged + refill → keep N running  │
        └───────────────────────────────────────────────────────────────────────────────┘
            │ dispatch (area-isolated)        ▲ structured report / idle notification
            ▼                                 │
   Worker A ─ implement-issue → merge-pr ─ report ─┐
   Worker B ─ implement-issue → merge-pr ─ report ─┤  N background agents, one issue each,
   Worker C ─ implement-issue → merge-pr ─ report ─┘  retired on merge, replaced from the queue
```

Workers are **background sub-agents**. You communicate by reading their structured reports (and idle
notifications) and by messaging them; you never read their raw transcript files (a local agent's output
is a huge conversation log that will blow your context — rely on the report + GitHub ground truth).

## Checklist

Track these as todos. Steps 4–6 are the long-running supervision loop.

1. **Preconditions & profile** — `gh` works; load the repo profile via `get-repo-profile`.
2. **Build the work queue** — survey open issues, filter to eligible, order small→medium, persist a
   state file.
3. **Dispatch the first N workers** — area-isolated, using the worker-prompt contract.
4. **Supervise (loop)** — on every worker report / idle notification: reconcile against GitHub, re-drive
   any merge that stalled at "ready", end merged workers, refill their slots from the queue.
5. **Heartbeat** — keep a self-paced wakeup armed (via `loop`) as the safety net; poll CI only when
   actively driving a merge.
6. **Stop & report** — when the queue drains (or the user stops), let the last workers finish, then
   summarize merged PRs, filed follow-ups, and anything blocked.

Resume-safe: the state file + live GitHub state are the source of truth, so a re-run (or a `loop`
re-fire) reconstructs the fleet rather than double-dispatching.

---

## Step 1 — Preconditions & profile

Confirm `gh api user` succeeds and you're in the target repo. **Load the repo profile** by running the
`get-repo-profile` skill — auto-dev reads every repo-specific fact from it (the effort/priority **labels**
used for ordering, the **area** conventions used for conflict-avoidance, the commit identity, the CI
gates). The child skills load it too; you mainly need its *Labels* and *Architecture grain* sections.

## Step 2 — Build the work queue

Survey the open issues and shape them into an ordered, filtered queue. List with labels:

```bash
gh issue list --state open --limit 200 \
  --json number,title,labels \
  --jq 'sort_by(.number) | .[] | "\(.number)\t[\(.labels|map(.name)|join(","))]\t\(.title)"'
```

Then classify each issue:

- **Effort** — from the profile's effort labels (`effort: S/M/L/XL`). Queue **S first, then M**; hold
  **L/XL** out of the default fleet (they're long, conflict-prone, and usually want a human's nod — see
  *Large issues* below).
- **Eligibility** — keep an issue only if it can actually be built headlessly:
  - **Has a plan.** `implement-issue` needs a `🛠️ Implementation plan` (or a legacy plan comment).
    Cheaply check: `gh issue view <N> --json body --jq 'if (.body|test("Implementation plan|### Task|- \\[ \\]")) then "plan" else "noplan" end'`. No plan → skip it (or, if the user wants it built, file/seed a plan first via `create-issue`).
  - **Is a code task.** Drop pure "visually QA…", "verify by hand from the UI…" issues — a headless
    agent can't do them. Note them as *skipped* in the state file with the reason.
- **Area** — tag each issue with the code area it touches (infer from the title/labels: e.g. `compiler`,
  `php`, `website`, `studio-frontend`, `tests`, `ci/build`). This is what keeps concurrent workers off
  each other's files. You don't need perfect areas — just enough to tell "these two would fight."

Persist a **state file** outside the repo (a scratch/temp dir, not a tracked path) so the fleet survives
context compaction and `loop` re-fires. Keep it small and current:

```markdown
# auto-dev state — <repo>, N=<concurrency>
## In flight
- Slot A → #<n> (<area>) — <phase: implementing / PR #<pr> ready→merging / merged>
- Slot B → ...
## Queue — SMALL (then MEDIUM), eligible & area-tagged
<#n (area), ...>
## Completed
- #<n> → PR #<pr> MERGED (<commit>)
## Off-scope issues filed by workers
- #<n> — <title> (label) from #<source>
## Skipped (ineligible: no-plan / manual-QA)
- #<n> — <reason>
```

## Step 3 — Dispatch the first N workers

Choose the first N issues so that **no two share an area** — that disjointness is the whole conflict
strategy. Dispatch each as a **background sub-agent** using the worker-prompt contract below. Record each
in the state file's *In flight* section.

### The worker-prompt contract

Each worker gets one issue and the same standing rules. Fill in `<N>` and dispatch in the background:

```
You are an auto-dev worker for <repo>. Your assigned issue is #<N> ("<title>").
Run this pipeline end-to-end, autonomously, no confirmations:

1. Invoke the `implement-issue` skill with args "<N>". Let it create its OWN git worktree (do NOT reuse
   the shared/main checkout — other workers are active), open a draft PR, implement each plan task, run
   code-review, sync main, format, and flip the PR to ready.

2. Invoke the `merge-pr` skill with args "<the PR number>". THIS IS MANDATORY — your job is NOT done at
   "ready". Drive the PR all the way to MERGED: merge-pr waits for CI, clears blockers (red/flaky checks,
   conflicts with main, unresolved reviews), squash-merges, files follow-ups, tears down the worktree.
   Do NOT go idle while a merge is still achievable — if CI is mid-run, keep polling `gh pr checks <PR>`
   and merge the instant it's green. Only stop for a genuine hard blocker.

OFF-SCOPE PROTOCOL: if you hit a problem that is NOT part of #<N> — an unrelated or flaky CI failure, a
pre-existing bug, a design smell, missing/broken tests, tech debt — do NOT fix it inline (scope-creep)
and do NOT silently ignore it. FILE it as a new issue via the `create-issue` skill, then continue your
own task. List anything you filed in your report.

Commit identity & all repo specifics come from the repo profile (the child skills load it). Work ONLY on
#<N>. If genuinely un-implementable (no usable plan, manual-QA only) or hard-blocked after real effort,
STOP and report it rather than forcing a merge.

Send your FINAL report to the supervisor (main), structured and nothing else:
ISSUE: <N> | PR: <number|none> | STATUS: MERGED|BLOCKED|FAILED | DETAIL: <1–2 sentences>
| FILED: <issues you opened, or none> | WORKTREE: <cleaned up / what remains>
```

Why these clauses earn their place (don't trim them):
- *Own worktree* — parallel workers sharing a checkout corrupt each other; isolation is non-negotiable.
- *Mandatory merge / don't idle at ready* — the single most common failure is a worker stopping once the
  PR is "ready." The explicit "drive to MERGED, keep polling CI" is what closes that gap.
- *Off-scope protocol* — turns incidental discoveries into a truthful, growing backlog instead of either
  lost knowledge or scope-crept PRs.
- *Structured report to main* — your reconciliation depends on a terse, parseable signal, not prose.

## Step 4 — Supervise (the loop)

You'll be woken by a worker's report, an **idle notification**, or your heartbeat. On every wake,
**reconcile against GitHub** — never trust a worker's silence or even its "done" without checking:

```bash
gh pr list --state open  --json number,isDraft,headRefName,mergeStateStatus --jq '.[]|"\(.number)\t\(if .isDraft then "DRAFT" else "READY" end)\t\(.mergeStateStatus)\t\(.headRefName)"'
gh pr list --state merged --limit 8 --json number,title,mergedAt
```

Then, per slot:

- **Worker reported MERGED** (and GitHub agrees the PR is merged) → **end the agent** (send it a shutdown
  request) and **refill the slot**: pick the next queued issue whose area isn't currently held by another
  worker, and dispatch a fresh worker (Step 3). This keeps the fleet at N.
- **Worker idle, but its PR is READY and unmerged** → it stalled at "ready." Message it to run
  `merge-pr <PR>` now and not idle until merged. If GitHub shows `mergeable=UNKNOWN`, that's usually a
  transient recompute after `main` moved — the worker's `merge-pr` will sync and resolve; if it's been
  UNKNOWN a while, nudge a main-sync. If a worker idles at "ready" **twice**, take over yourself: once CI
  is green, land it (`gh pr merge <PR> --squash --delete-branch`) and shut the worker down.
- **Worker idle with a draft PR / no PR yet** → still implementing; leave it. If it's been a long time
  with no progress, send a one-line status ping (don't read its transcript).
- **Worker reported BLOCKED/FAILED** → record it, surface it to the user, end the agent, and refill the
  slot with the next queued issue (don't let one blocked issue stall the fleet).

After any change, update the state file (in flight, completed, filed, queue).

**Merge sequencing for same-area PRs.** If two workers' PRs do end up touching the same area, let them
land one at a time — the second worker's `merge-pr` will sync the freshly-moved `main` and resolve. You
don't need to block; just don't be surprised by a transient conflict, and re-nudge if needed.

## Step 5 — Heartbeat

The wake signals that matter — worker reports and idle notifications — arrive on their own; **don't poll
for them.** Keep one self-paced wakeup armed as a *safety net* in case a worker hangs silently. The
natural way to run auto-dev is under the `loop` skill in dynamic mode: each `loop` re-fire is a
reconcile tick. Use a **long fallback** (~20–30 min) for the idle heartbeat. **Drop to a short cadence
(2–4 min) only while you're actively waiting on a specific CI run** to land a merge — that's external
GitHub state the harness can't notify you about, so it's the one case worth polling; return to the long
fallback once it lands.

## Step 6 — Stop & report

Stop dispatching when the eligible queue is empty (or the user says stop). Let the in-flight workers
finish and land, end them, then give a final summary: issues merged (with PR numbers), follow-ups filed,
anything blocked or skipped (with reasons), and what remains in the backlog (e.g. the held L/XL items).

---

## Large issues (L/XL) and prioritization

By default L/XL stay out of the fleet — they run long, touch many areas (conflict magnets), and often
deserve a human's go-ahead. When a worker *files* a high-priority large issue (e.g. a production
outage it discovered), **surface it** rather than silently auto-assigning it; if the user says
"prioritize it," dispatch it — optionally as a temporary extra worker, then converge back to N by
skipping the next slot that frees. Hold the line at N unless told otherwise.

## Quality notes & gotchas (hard-won)

- **"Ready" is not "merged."** Re-read this until it's reflexive. The fleet's throughput is gated almost
  entirely on actually *landing* PRs, and the #1 stall is a worker idling at ready. Verify merge state
  from GitHub on every signal; re-drive or take over.
- **Don't read a worker's transcript.** A background agent's raw output is an enormous conversation log —
  reading it overflows your context. Use its structured report and `gh` for ground truth.
- **One area per concurrent worker.** This is the entire conflict strategy. When the next-queued issue
  shares an area with an in-flight one, skip down the queue to a disjoint area (note the reorder).
- **`mergeable=UNKNOWN` is normal right after `main` moves** — GitHub recomputes mergeability. It usually
  resolves to CLEAN on its own once the branch syncs; don't treat it as a blocker.
- **End finished agents.** Idle finished workers consume a slot's worth of attention and clutter the
  roster. Shut each down once its PR merges; the fresh replacement starts clean.
- **File, don't fix, off-scope work.** The backlog should tell the truth. A worker fixing an unrelated
  bug inside its PR muddies the diff and the issue's scope; a filed follow-up keeps both clean.
- **Effort labels drive ordering, plans drive eligibility.** No plan → not eligible (seed one with
  `create-issue` first if the user insists). Manual-QA → skip with a noted reason.
- **The state file is your memory.** Keep it terse and current so a compaction or `loop` re-fire
  reconstructs the fleet exactly.
```
