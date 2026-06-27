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
- **Model tier** — which model each worker runs on. Default **tiered, not all-Opus** (see *Token
  economics* below): mechanical/docs work on the cheapest capable model, typical bugs on a mid model,
  Opus reserved for cross-cutting/hard work and failure-escalation. This is the single biggest cost
  lever. The user may override ("run everything on Opus", "use Sonnet for all") — honor it.

## Token economics — run the fleet cheap

A long auto-dev run is **expensive in a specific, fixable way**, and knowing the shape lets you cut it
by ~80% with no quality loss. Measured over a 120-merge run: **~83% of all spend was context *cache*
(re-reading each agent's context every turn), only ~16% was generated output.** In an agentic loop you
pay for *context volume × number of turns*, not for thinking. Two levers follow directly:

**1. Tier the model to the task (the dominant lever — ~⅔ of the savings).** Cache-read tokens dominate,
and they are ~5× cheaper on a mid model and ~15× cheaper on a small model than on the top model. Most
fleet work is *mechanical* — make one failing test pass, fix a guard, regenerate a snapshot, edit docs —
and doesn't need the top model. **Route each worker by its issue labels** (use the profile's effort/area
labels; adapt the model names to whatever the runtime offers — typically a small/mid/top trio like
Haiku/Sonnet/Opus):

| Issue shape (by label) | Tier | Rationale |
|---|---|---|
| docs / templates / manifest, format & snapshot regen, `priority:low`+`effort:S` one-line guards | **small** (e.g. Haiku) | The failing-test-first + green-CI gates catch any miss |
| most bugs: emitter/validator/parser guards, studio TS, CLI, LSP — single-area `effort:S/M` | **mid** (e.g. Sonnet) | One clear repro → make a test green; well within a mid model |
| cross-cutting (touches many areas/emitters), ambiguous/design, **or any issue a lower tier failed to green** | **top** (e.g. Opus) | Reserve the costly model for genuine reasoning + escalation |

The **orchestrator (you)** stays on the top model — its dispatch/conflict reasoning is worth it — but
keep its *per-turn context* small (lever 2), because that context is what it pays to re-read every turn.

**2. Shrink what gets re-read every turn (the other big chunk).**
- **Don't accumulate a per-issue TaskList.** A task list grows unboundedly and is re-injected into your
  context on *every* turn — pure cache-read waste multiplied by thousands of turns. **The state file is
  your only working memory**; track the fleet there, not in a running task list.
- **Compact/`/clear` the orchestrator every ~20 merges.** Continuity lives in the state file, so a clear
  resets the cache-read base instead of dragging an ever-growing transcript across the whole run.
- **Keep worker FINAL REPORTs terse** (the structured one-liner below) — they get re-read on every later
  reconcile turn, so prose reports tax you repeatedly.
- **Don't poll on a short cadence** unless a green merge is truly imminent (see *Heartbeat*). Every wake
  re-reads your whole context; needless 2–4 min ticks are pure cache-read.

**Measure it.** After a run, `scripts/usage_report.py` aggregates tokens + $-equivalent across the
orchestrator and every worker session (and breaks it down by model, so you can see the tiering payoff).
Track **tokens/merge** and **$/merge** across runs so a regression shows up immediately. (Dollar figures
are API list-price equivalents; on a subscription they map to rate-limit budget, not cash.)

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
   any merge that stalled at "ready", end merged workers, refill their slots from the queue; **re-survey
   the backlog (Step 2) every ~5 merges** since `merge-pr` follow-ups + off-scope filings keep growing it.
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

The survey — list issues → check each for a plan → classify effort → drop manual-QA → order small-first
— is a deterministic sequence, so **run `scripts/survey.sh`** instead of re-deriving it from scratch
every time (one `gh issue list` + jq; fewer turns = less per-turn cache re-read). It prints one bucketed,
already-ordered row per issue:

```
QUEUE  #N  effort  plan=true  qa=false  [labels]  title   ← eligible (effort:S before :M), area-tag + dispatch
HOLD   #N  ...                                            ← effort L/XL, out of the default fleet (see Large issues)
SKIP   #N  ...                                            ← no plan, or manual-QA only — note the reason in state
```

What the script encodes (so you can trust the buckets): **Effort** from the profile's `effort: S/M/L/XL`
labels (S before M; L/XL held); **plan** present (`🛠️ Implementation plan` / a task-list — no plan ⇒
SKIP, or seed one via `create-issue` if the user insists); **manual-QA** dropped (a headless agent can't
"visually QA…" / "verify by hand…"). The **one judgment the script leaves to you is area-tagging** the
QUEUE rows (infer from title/labels: e.g. `compiler`, `php`, `website`, `studio-frontend`, `tests`,
`ci/build`) — that's what keeps concurrent workers off each other's files; you don't need perfect areas,
just enough to tell "these two would fight."

Persist a **state file** outside the repo (a scratch/temp dir, not a tracked path) so the fleet survives
context compaction and `loop` re-fires. Keep it small and current:

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

Choose the first N issues so that **no two share an area** — that disjointness is the whole conflict
strategy. Dispatch each as a **background sub-agent** using the worker-prompt contract below. Record each
in the state file's *In flight* section.

**Pick each worker's model from its labels** (see *Token economics*): small/mechanical → cheap model,
typical single-area bug → mid model, cross-cutting/hard → top model. Pass it explicitly when you spawn
the worker (the background-agent spawn takes a model parameter; if you launch the worker as its own CLI
session, pass the model flag). Record the chosen tier next to the issue in the state file so a `loop`
re-fire redispatches at the same tier — and so `usage_report.py`'s by-model rollup is interpretable.

### The worker-prompt contract

Every worker gets the same standing rules — so they live **once**, in the `/auto-dev-worker` command
(`.claude/commands/auto-dev-worker.md`), not re-typed per dispatch. Dispatch is then a deterministic
one-liner with the model tier set by the spawn flag:

```bash
claude -p "/auto-dev-worker <N>" --model <tier>   # <tier> chosen from the issue's labels (see below)
```

(If you launch the worker as a background sub-agent rather than a `claude -p` session, pass the command
file's body as the sub-agent prompt and set its model parameter to the same tier.) The command expands to
the full contract: `implement-issue <N>` in its **own** worktree → **mandatory** `merge-pr` driven to
MERGED (never idle at "ready") → off-scope protocol (`create-issue`, don't fix inline) → a single
structured FINAL report line back to you:

```
ISSUE: <N> | PR: <number|none> | STATUS: MERGED|BLOCKED|FAILED | DETAIL: … | FILED: … | WORKTREE: …
```

Why those clauses earn their place (don't trim them from the command):
- *Own worktree* — parallel workers sharing a checkout corrupt each other; isolation is non-negotiable.
- *Mandatory merge / don't idle at ready* — the single most common failure is a worker stopping once the
  PR is "ready." The explicit "drive to MERGED, keep polling CI" is what closes that gap.
- *Off-scope protocol* — turns incidental discoveries into a truthful, growing backlog instead of either
  lost knowledge or scope-crept PRs.
- *Structured report to main* — your reconciliation depends on a terse, parseable signal, not prose.

## Step 4 — Supervise (the loop)

You'll be woken by a worker's report, an **idle notification**, or your heartbeat. On every wake,
**reconcile against GitHub** — never trust a worker's silence or even its "done" without checking. Run
`scripts/reconcile.sh` (one call: open PRs with draft/ready + `mergeStateStatus`, plus the last 10
merged) rather than re-typing the gh queries each tick. It gives you the ground truth; you supply the
judgment below.

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
- **Worker reported BLOCKED/FAILED** → first, **tier-escalate if it was on a lower model**: if the
  failure looks like the model wasn't strong enough (couldn't green a test, tangled the fix) rather than
  a genuine hard blocker (un-mergeable conflict, missing approval, no plan), re-dispatch the *same* issue
  **once** on the top model before giving up. If it was already on the top model, or fails again → record
  it, surface it to the user, end the agent, and refill the slot with the next queued issue (don't let
  one blocked issue stall the fleet). This escalation is what makes cheap-by-default tiering safe.

After any change, update the state file (in flight, completed, filed, queue).

**Merge sequencing for same-area PRs.** If two workers' PRs do end up touching the same area, let them
land one at a time — the second worker's `merge-pr` will sync the freshly-moved `main` and resolve. You
don't need to block; just don't be surprised by a transient conflict, and re-nudge if needed.

**Re-survey the backlog every ~5 merges — the queue is NOT static.** Every PR you land tends to spawn
more issues: `merge-pr` files deferred work as fresh follow-ups, and workers file off-scope discoveries
via `create-issue`. So the open-issue set *grows as you drain it*, and the newcomers are often small and
in areas your current workers don't hold — which is exactly what breaks a same-area logjam (e.g. when
every remaining small issue is in one subsystem, a freshly-filed diagnostic/test follow-up in another
subsystem becomes the ideal next pick). Don't run the whole session off the initial Step 2 snapshot:
after **roughly every 5 merges** — or sooner if refills start clustering into one area or the eligible
queue looks empty — **re-run the Step 2 survey**, fold the newcomers in (small-first, area-tagged, plan-
and eligibility-checked), and note what changed. Keep a **merge counter** in the state file (increment on
each confirmed merge; record the count at the last refresh) so a `loop` re-fire knows when the next
refresh is due. A stale queue silently costs you: missed easy disjoint wins and mis-ordered work.

**Keep your own context lean** — it's re-read every turn, so apply *Token economics* lever 2 right here:
the state file is your only working memory (**no per-issue TaskList**), worker reports stay terse, and
**compact or `/clear` yourself ~every 20 merges** (continuity is reconstructable from the state file +
live GitHub, so clearing resets the cache-read base).

## Step 5 — Heartbeat

The wake signals that matter — worker reports and idle notifications — arrive on their own; **don't poll
for them.** Keep one self-paced wakeup armed as a *safety net* in case a worker hangs silently. The
natural way to run auto-dev is under the `loop` skill in dynamic mode: each `loop` re-fire is a
reconcile tick. Use a **long fallback** (~20–30 min) for the idle heartbeat. **Drop to a short cadence
(2–4 min) only while you're actively waiting on a specific CI run** to land a merge — that's external
GitHub state the harness can't notify you about, so it's the one case worth polling; return to the long
fallback once it lands. Each wake re-reads your whole context from cache, so a needless short tick is
pure cost (see *Token economics*) — let event notifications, not the clock, drive the common case.

## Step 6 — Stop & report

Stop dispatching when the eligible queue is empty (or the user says stop). Let the in-flight workers
finish and land, end them, then give a final summary: issues merged (with PR numbers), follow-ups filed,
anything blocked or skipped (with reasons), and what remains in the backlog (e.g. the held L/XL items).

**Cost accounting.** Run `scripts/usage_report.py <project-transcript-dir> --main <orchestrator-session-id>`
to aggregate tokens + $-equivalent across the orchestrator and every worker session, broken down by
model. Report **tokens/merge** and **$/merge** so the user can see the run's unit economics and track
them across runs. (The script auto-detects the transcript dir from `$PWD` if not given; dollar figures
are API list-price equivalents — on a subscription they're rate-limit budget, not cash, and the
authoritative cash figure for this session is the built-in `/cost`.)

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
- **The backlog grows as you drain it.** `merge-pr` follow-ups and off-scope filings add fresh issues
  mid-run — often small and in subsystems your current workers don't hold. Re-survey every ~5 merges
  (Step 4) so you keep working off the *live* backlog, not a stale opening snapshot, and don't miss the
  easy disjoint-area wins that break a same-area logjam.
- **The state file is your memory.** Keep it terse and current so a compaction or `loop` re-fire
  reconstructs the fleet exactly — and it's your *only* working memory (no per-issue TaskList).
- **Cost lives in *Token economics*, not here.** The whole money story is stated once in that section —
  ~83% of spend is per-turn context re-read, so tier the model to the task (cheap-by-default + top-model
  escalation) and shrink per-turn context. Re-read that section; this list won't re-summarize it.
```
