---
name: auto-dev
description: >-
  Autonomously burn down a GitHub issue backlog with a FLEET of N parallel sub-agents — each takes one
  issue through its whole lifecycle (`implement-issue` → `merge-pr` → report) then picks up the next, so
  N issues are always in flight. The orchestrator ABOVE `implement-issue`/`merge-pr`/`create-issue`:
  surveys open issues, orders them (small effort first, then medium), assigns each worker a NON-overlapping
  code area to avoid conflicts, keeps exactly N running (retires a worker the moment its PR merges and
  dispatches a replacement), has workers file off-scope finds as fresh issues, and verifies real merge
  state itself (workers tend to idle at "PR ready" without landing). ALWAYS use it when the user wants to
  work through MANY issues hands-off with parallelism — "implement issues small first then medium with 3
  agents", "keep N agents continuously implementing and merging issues", "burn down the backlog", "run the
  auto-dev loop", "spin up a fleet of agents to clear open issues", "auto-implement and merge everything
  that's ready" — and any loose phrasing pairing `implement-issue` with `merge-pr` across a queue rather
  than one issue. Composes with the `loop` skill for the heartbeat. Does NOT apply to building ONE issue
  (`implement-issue`), landing ONE PR (`merge-pr`), or filing ONE issue (`create-issue`).
---

# auto-dev — a continuous fleet that implements and merges issues

## What this does

`implement-issue` makes one planned issue into a ready PR; `merge-pr` lands one PR. **auto-dev
supervises them at scale**: N background workers each own one issue end-to-end (`implement-issue <N>` →
`merge-pr <PR>`); the moment a worker's PR merges it's retired and a fresh worker is dispatched onto the
next queued issue — so N issues stay in flight without you babysitting.

The value is the orchestration a naive "run them in a loop" lacks:

- **Conflict avoidance** — each concurrent worker gets an issue in a *different* code area, so branches rarely collide.
- **Ordering** — small self-contained issues first (fast wins, fewer conflicts), then medium. L/XL and manual-QA excluded by default.
- **Mandatory merge** — workers love to stop at "PR ready" (half a job). auto-dev verifies the *real* merge state from GitHub on every signal and re-drives any worker that stalled.
- **Off-scope capture** — a worker that trips over an unrelated bug files it via `create-issue` instead of fixing it inline (scope-creep) or dropping it. The backlog stays truthful.
- **Lifecycle hygiene** — finished agents are shut down; a state file survives restarts so the fleet is resumable.

## Autonomy contract

The user starts this and walks away — they watch a backlog drain, they don't approve each step. Run
**hands-off**: pick the reasonable default, state it, keep going. Stop only for genuine blockers:

- `gh` is unauthenticated, or you lack push/merge rights.
- **No eligible issues** (queue empty after filtering) — report the backlog drained.
- A worker's honest hard blocker (tests it can't green, a both-sides-rewrote-the-same-logic conflict, a required approval it can't self-give). Surface it; don't force a merge.

Never fake progress: a checkbox, a "ready" flip, or a merge claims work is *done* — back each with
evidence, as the child skills require. The **squash-merge is the only irreversible act** — it happens
only through `merge-pr` on a green, mergeable PR, never via an `--admin` override here.

## Inputs

- **Concurrency `N`** — workers at once. Default **3** (3–4 is the sweet spot; more = more contention and more areas to keep disjoint).
- **Ordering** — default effort small→medium. Honor whatever the user said.
- **Eligible set** — default: open issues that (a) carry an implementation plan, (b) are code tasks (not manual "QA"/"verify by hand"), (c) are within the effort ceiling (default ≤ medium). Honor narrowing ("only `studio` issues", "labeled `priority: high`").
- **Heartbeat** — normally launched *via* `loop` in dynamic mode, so the loop's self-paced wakeup is the heartbeat. If invoked directly, arm your own wakeup.
- **Model tier** — default **tiered, not all-Opus** (see Token economics): cheapest capable model for mechanical/docs, mid for typical bugs, top reserved for cross-cutting/hard work + failure-escalation. The single biggest cost lever. Honor an override ("everything on Opus", "Sonnet for all").

## Token economics — run the fleet cheap

A long run's cost is **~83% per-turn context cache-read, ~16% output** — you pay for *context volume ×
turns*, not for thinking. Apply these rules; full rationale + measurement in
[references/token-economics.md](references/token-economics.md).

**1. Tier the model to the task** — the dominant lever (~⅔ of savings); cache-read is ~5× cheaper on a
mid model and ~15× on a small one. Route each worker by its issue labels (adapt names to the runtime's
small/mid/top trio, e.g. Haiku/Sonnet/Opus):

| Issue shape (by label) | Tier |
|---|---|
| docs/templates/manifest, format & snapshot regen, `priority:low`+`effort:S` one-line guards | **small** (e.g. Haiku) |
| most bugs: emitter/validator/parser guards, studio TS, CLI, LSP — single-area `effort:S/M` | **mid** (e.g. Sonnet) |
| cross-cutting (many areas/emitters), ambiguous/design, **or any issue a lower tier failed to green** | **top** (e.g. Opus) |

The orchestrator (you) stays on the top model, but keep its *per-turn context* small (lever 2).

**2. Shrink what's re-read every turn.**
- **No per-issue TaskList** — it grows unboundedly and re-injects every turn. The **state file is your only working memory.**
- **Compact deliberately** at ~40–50% (`/context`) or every ~20 merges, with a focus directive — e.g. `/compact keep the slot→issue/PR map, merge counter, queue order, filed follow-ups`. First action after any compact / `/clear` / `loop` re-fire: **re-read the state file.**
- **Keep worker FINAL REPORTs terse** — they're re-read on every later reconcile turn.
- **Delegate heavy reads to throwaway `Explore` sub-agents** — the file-dump dies with the sub-agent instead of riding your context.
- **Strip MCP servers workers don't need** — launch with `--strict-mcp-config`.

**3. Take fewer turns** (each round-trip re-reads the whole context).
- **Batch independent tool calls** into one turn (parallel reads/greps/`gh`).
- **Let scripts collapse query+classify** — `scripts/survey.sh`, `scripts/reconcile.sh`.
- **Don't poll on a short cadence** unless a merge is imminent — a needless wake re-reads everything, and one past the ~5-min cache TTL pays a full cache *write* (1.25×), not a read (0.1×).

**Measure it:** after a run, `scripts/usage_report.py` aggregates tokens + $-equivalent by model. Track
**tokens/merge** and **$/merge** across runs.

## How it works

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

Workers are **background sub-agents**. Communicate via their structured reports (and idle
notifications) and by messaging them; **never read their raw transcript files** — a local agent's
output is a huge log that will blow your context. Rely on the report + GitHub ground truth.

## Checklist

Track these as todos. Steps 4–6 are the long-running supervision loop.

1. **Preconditions & profile** — `gh` works; load the repo profile via `get-repo-profile`.
2. **Build the work queue** — survey open issues, filter to eligible, order small→medium, persist a state file.
3. **Dispatch the first N workers** — area-isolated, using the worker-prompt contract.
4. **Supervise (loop)** — on every report / idle notification: reconcile against GitHub, re-drive any merge stalled at "ready", end merged workers, refill slots from the queue; **re-survey the backlog (Step 2) every ~5 merges**.
5. **Heartbeat** — keep a self-paced wakeup armed (via `loop`) as the safety net; poll CI only while actively driving a merge.
6. **Stop & report** — when the queue drains (or the user stops), let the last workers finish, then summarize merged PRs, filed follow-ups, and anything blocked.

Resume-safe: the state file + live GitHub state are the source of truth, so a re-run (or `loop` re-fire)
reconstructs the fleet rather than double-dispatching.

---

## Step 1 — Preconditions & profile

Confirm `gh api user` succeeds and you're in the target repo. **Load the repo profile** via the
`get-repo-profile` skill — auto-dev reads every repo-specific fact from it (the effort/priority
**labels** for ordering, the **area** conventions for conflict-avoidance, commit identity, CI gates).
You mainly need its *Labels* and *Architecture grain* sections.

## Step 2 — Build the work queue

The survey (list issues → check each for a plan → classify effort → drop manual-QA → order small-first)
is deterministic, so **run `scripts/survey.sh`** instead of re-deriving it (one `gh issue list` + jq;
fewer turns = less cache re-read). It prints one bucketed, ordered row per issue:

```
QUEUE  #N  effort  plan=true  qa=false  [labels]  title   ← eligible (effort:S before :M), area-tag + dispatch
HOLD   #N  ...                                            ← effort L/XL, out of the default fleet (see Large issues)
SKIP   #N  ...                                            ← no plan, or manual-QA only — note the reason in state
```

What the buckets encode: **Effort** from the profile's `effort: S/M/L/XL` labels (S before M; L/XL
held); **plan** present (`🛠️ Implementation plan` / a task-list — no plan ⇒ SKIP, or seed one via
`create-issue` if the user insists); **manual-QA** dropped (a headless agent can't "visually QA…").
The **one judgment left to you is area-tagging** the QUEUE rows (infer from title/labels: `compiler`,
`php`, `website`, `studio-frontend`, `tests`, `ci/build`) — enough to tell "these two would fight."

Persist a **state file** outside the repo (a scratch/temp dir, not a tracked path) so the fleet
survives compaction and `loop` re-fires. Keep it small and current:

```markdown
# auto-dev state — <repo>, N=<concurrency> · merges: <total> · queue last refreshed @ <merge# of last refresh>
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

Choose the first N issues so **no two share an area** — that disjointness is the whole conflict
strategy. Dispatch each as a **background sub-agent** using the worker-prompt contract below; record
each in the state file's *In flight* section.

**Pick each worker's model from its labels** (see Token economics): small/mechanical → cheap, typical
single-area bug → mid, cross-cutting/hard → top. Pass it explicitly on spawn (the background-agent
spawn takes a model parameter; a `claude -p` worker takes the `--model` flag). Record the chosen tier
next to the issue in the state file so a `loop` re-fire redispatches at the same tier and
`usage_report.py`'s by-model rollup stays interpretable.

### The worker-prompt contract

Every worker gets the same standing rules, so they live **once** in the `/auto-dev-worker` command
(`.claude/commands/auto-dev-worker.md`), not re-typed per dispatch. Dispatch is a deterministic
one-liner with the tier set by the spawn flag:

```bash
claude -p "/auto-dev-worker <N>" --model <tier> --strict-mcp-config   # <tier> from labels; --strict-mcp-config drops unused MCP schema weight
```

(As a background sub-agent instead, pass the command file's body as the prompt and set its model
parameter to the same tier.) The command expands to the full contract: `implement-issue <N>` in its
**own** worktree → **mandatory** `merge-pr` driven to MERGED (never idle at "ready") → off-scope
protocol (`create-issue`, don't fix inline) → one structured FINAL report line back:

```
ISSUE: <N> | PR: <number|none> | STATUS: MERGED|BLOCKED|FAILED | DETAIL: … | FILED: … | WORKTREE: …
```

Why those clauses earn their place (don't trim them from the command): *own worktree* — parallel
workers sharing a checkout corrupt each other; *mandatory merge / don't idle at ready* — the #1 failure
is stopping at "ready", so the explicit "drive to MERGED, keep polling CI" closes that gap; *off-scope
protocol* — keeps the backlog truthful instead of scope-creeping the PR; *structured report* — your
reconciliation needs a terse parseable signal, not prose.

## Step 4 — Supervise (the loop)

You're woken by a worker's report, an **idle notification**, or your heartbeat. On every wake,
**reconcile against GitHub** — never trust a worker's silence or even its "done" without checking. Run
`scripts/reconcile.sh` (one call: open PRs with draft/ready + `mergeStateStatus`, plus the last 10
merged) rather than re-typing the gh queries each tick. Then, per slot:

- **Reported MERGED** (GitHub agrees) → **end the agent** (send a shutdown request) and **refill the slot**: pick the next queued issue whose area isn't currently held, dispatch a fresh worker (Step 3). Keeps the fleet at N.
- **Idle, but PR is READY and unmerged** → it stalled at "ready." Message it to run `merge-pr <PR>` now and not idle until merged. `mergeable=UNKNOWN` is usually a transient recompute after `main` moved — its `merge-pr` will sync and resolve; nudge a main-sync if it persists. If a worker idles at "ready" **twice**, take over: once CI is green, land it (`gh pr merge <PR> --squash --delete-branch`) and shut the worker down.
- **Idle with a draft PR / no PR yet** → still implementing; leave it. If long with no progress, send a one-line status ping (don't read its transcript).
- **Reported BLOCKED/FAILED** → first **tier-escalate if it was on a lower model**: if the failure looks like the model wasn't strong enough (rather than a genuine hard blocker — un-mergeable conflict, missing approval, no plan), re-dispatch the *same* issue **once** on the top model. If already on top, or it fails again → record it, surface it, end the agent, refill the slot (don't let one blocked issue stall the fleet). This escalation is what makes cheap-by-default tiering safe.

After any change, update the state file (in flight, completed, filed, queue).

**Merge sequencing for same-area PRs.** If two workers' PRs touch the same area, let them land one at a
time — the second's `merge-pr` will sync the freshly-moved `main` and resolve. Don't block; just expect
a transient conflict and re-nudge if needed.

**Re-survey the backlog every ~5 merges — the queue is NOT static.** Every PR you land tends to spawn
more issues: `merge-pr` files deferred work as follow-ups and workers file off-scope discoveries. So
the open-issue set *grows as you drain it*, and newcomers are often small and in areas your current
workers don't hold — exactly what breaks a same-area logjam. Re-run the Step 2 survey roughly every 5
merges (or sooner if refills cluster into one area or the queue looks empty), fold newcomers in (small-
first, area-tagged, eligibility-checked), and note what changed. Keep a **merge counter** in the state
file (record the count at the last refresh) so a `loop` re-fire knows when the next refresh is due.

**Keep your own context lean** (Token economics lever 2): the state file is your only working memory
(**no per-issue TaskList**), worker reports stay terse, and **compact or `/clear` ~every 20 merges**.

## Step 5 — Heartbeat

The wake signals that matter — worker reports and idle notifications — arrive on their own; **don't
poll for them.** Keep one self-paced wakeup armed as a *safety net* for a silently-hung worker. The
natural way to run auto-dev is under `loop` in dynamic mode: each re-fire is a reconcile tick. Use a
**long fallback** (~20–30 min) for the idle heartbeat. **Drop to a short cadence (2–4 min) only while
actively waiting on a specific CI run** to land a merge — that's external GitHub state the harness
can't notify you about; return to the long fallback once it lands. (Cache nuance in Token economics: a
wake past the ~5-min TTL pays a full cache write, so batch pending reconcile work into a long-idle
wake.)

## Step 6 — Stop & report

Stop dispatching when the eligible queue is empty (or the user says stop). Let the in-flight workers
finish and land, end them, then summarize: issues merged (with PR numbers), follow-ups filed, anything
blocked or skipped (with reasons), and what remains (e.g. held L/XL items).

**Cost accounting.** Run `scripts/usage_report.py <project-transcript-dir> --main <orchestrator-session-id>`
to aggregate tokens + $-equivalent across the orchestrator and every worker, broken down by model.
Report **tokens/merge** and **$/merge**. (Auto-detects the transcript dir from `$PWD`; dollar figures
are API list-price equivalents — on a subscription they're rate-limit budget, not cash; the
authoritative cash figure is `/cost`.)

---

## Large issues (L/XL)

By default L/XL stay out of the fleet — they run long, touch many areas (conflict magnets), and often
deserve a human's go-ahead. When a worker *files* a high-priority large issue (e.g. a production outage
it found), **surface it** rather than silently auto-assigning; if the user says "prioritize it,"
dispatch it — optionally as a temporary extra worker, then converge back to N by skipping the next slot
that frees. Hold the line at N unless told otherwise.

## Gotchas (hard-won)

- **"Ready" is not "merged."** Throughput is gated on actually *landing* PRs; the #1 stall is idling at ready. Verify merge state from GitHub on every signal; re-drive or take over.
- **Don't read a worker's transcript** — it overflows your context. Use its structured report + `gh`.
- **One area per concurrent worker** — the entire conflict strategy. If the next-queued issue shares an area with an in-flight one, skip down to a disjoint area (note the reorder).
- **`mergeable=UNKNOWN` is normal right after `main` moves** — GitHub recomputes; it resolves to CLEAN once the branch syncs. Not a blocker.
- **End finished agents** once their PR merges; the fresh replacement starts clean.
- **File, don't fix, off-scope work** — a filed follow-up keeps both the diff and the issue's scope clean.
- **Plans drive eligibility, effort labels drive ordering** — no plan → not eligible (seed one with `create-issue` if the user insists); manual-QA → skip with a noted reason.
