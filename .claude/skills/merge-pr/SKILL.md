---
name: merge-pr
description: >-
  Land an open GitHub pull request for the Koine project the way a careful maintainer would — the
  "ship it" counterpart to `implement-issue`. Use this whenever the user wants to MERGE, land, ship,
  close out, or finish an already-open PR — e.g. "merge PR 279", "land #281", "ship this PR", "get
  279 in", or a bare PR link with "merge it." It does the whole tail of the lifecycle hands-off:
  waits for CI to finish, then APPLIES CORRECTIONS to clear whatever is blocking the merge — fixes
  red CI checks, merges the latest `main` into the branch and resolves conflicts so the PR stays
  mergeable *as part of landing it now*, and addresses unresolved review comments — looping fix →
  push → re-wait until the PR is green and CLEAN. Then it **squash-merges** the PR, files any
  follow-up work as fresh issues via the `create-issue` skill (both follow-ups passed inline as
  `--follow-up "…"` and ones discovered in the PR body / review threads), and finally tears down the
  local branch and its git worktree. ALWAYS reach for it on those merge/land/ship phrasings, including
  loose ones like "can you get that PR merged once CI's green" or "wrap up 279 and open follow-ups for
  the deferred bits." Does NOT apply to OPENING or implementing a PR — or to syncing/un-conflicting a
  PR you're still building rather than landing it right now — (that's `implement-issue`), to reviewing
  a PR without merging it (that's `code-review` / `review`), or to creating a standalone issue with no
  PR to land (that's `create-issue`).
---

# Merge a pull request

## What this does

`implement-issue` builds a PR and flips it to ready. This skill is the final step: it **lands** that PR
cleanly and cleans up after itself. The job isn't just `gh pr merge` — a PR that's ready isn't
necessarily *mergeable* minutes later, because `main` moves, CI runs, and reviewers leave comments. So
this skill closes the gap: waits for CI, fixes whatever is actually blocking the merge, squashes the PR
in, turns deferred work into tracked issues, and removes the throwaway branch and worktree.

The shape mirrors `implement-issue`'s tail (sync-with-`main`, the profile's conflict hot-spots, the
commit identity) — reuse that machinery. The one new piece is the **corrections loop**: keep clearing
blockers and re-waiting until GitHub reports the PR `CLEAN`, then merge.

## Autonomy contract

Run **hands-off** once started — the user points at a PR and walks away. Whenever a step *could* stop
for a question, pick the reasonable default, state the assumption, keep going. Stop only for a genuine
blocker:

- `gh` not authenticated, or no merge/push rights.
- The PR doesn't exist, is already merged/closed, or the number is ambiguous.
- **CI stays red after a real fix attempt.** Don't merge over a red bar, don't disable a failing test, don't `--admin`-override a required check. Fix it for real or stop and show the failing output.
- **A merge conflict you can't resolve with confidence** — both `main` and the branch rewrote the *same logic*. The mechanical conflicts (version, changelog, snapshots, lockfiles) have known-correct fixes (Step 4) — handle those; stop only for genuinely ambiguous ones, showing both sides.
- **A reviewer requested changes you can't satisfy** without guessing intent, or a branch-protection rule you can't legitimately clear (required approvals you can't self-give).

The merge is the irreversible act — earn it. Merge only when CI is **green on the just-corrected
branch** and GitHub reports the PR mergeable; a textual merge of `main` is not a semantic one, so
re-build/re-test after resolving conflicts. Filing a follow-up and deleting a local branch are
reversible and cheap.

## Inputs

- **PR identifier** (required) — a number (`279`), an issue/PR URL, or a `gh` PR link. Resolve to a number (Step 1).
- **`--follow-up "<idea>"`** (optional, repeatable) — follow-up work to file as issues after the merge, e.g. `/merge-pr 279 --follow-up "add Rust snapshot tests" --follow-up "document minimap config"`. *Added to* whatever Step 6 discovers in the PR itself.

## Checklist

Create a task per item and work them in order. Step 4 is a loop — repeat until the PR is mergeable.

1. **Preconditions & resolve the PR** — `gh` works, you're in the target repo, normalize the PR number, confirm it's open, capture its head branch + merge state.
2. **Locate (or create) the branch's worktree** — find the local worktree/branch for the PR's head so corrections land in the right checkout; create one tracking the remote branch if none exists.
3. **Wait for CI** — let the checks finish; read the rollup.
4. **Apply corrections (loop)** — clear each blocker the merge state reports (red CI · behind/dirty vs `main` · unresolved review · draft), push, re-wait until the PR is `CLEAN`.
5. **Merge (squash)** — `gh pr merge --squash --delete-branch` once green and mergeable.
6. **File follow-ups** — gather inline `--follow-up` args + ones discovered in the PR, file each via `create-issue`.
7. **Delete the local branch & worktree** — from the main checkout, remove the PR's worktree and local branch.
8. **Report** — merged PR URL, corrections applied, follow-ups filed, cleanup done.

Resume-safe: re-running mid-flight is fine. If the PR is already merged, skip to Steps 6–7. If the
worktree/branch is already gone, skip Step 7.

---

## Step 1 — Preconditions & resolve the PR

**Follow the shared preconditions reference** at [`../_shared/preconditions.md`](_shared/preconditions.md)
to load the repo profile, verify authentication, and prepare the commit identity shorthand.

Throughout this skill, **`git <commit-identity>`** stands for the author line from the profile's
*Commit identity* — substitute it in every commit/merge command.

Normalize the PR identifier to a number (bare number, issue/PR URL, and `gh` link all reduce to the
first run of digits — see `references/merge-mechanics.md` §1), then confirm it's real and open and
capture what drives the rest of the run:

```bash
gh pr view "$PR" --json number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefName,baseRefName,url \
  --jq '{number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,head:.headRefName,base:.baseRefName,url}'
```

- `state != OPEN` → if `MERGED`, skip to Steps 6–7 (follow-ups + cleanup); if `CLOSED` (not merged), stop and ask — merging a deliberately closed PR is not a safe default.
- `isDraft == true` → the user asked to *merge* it, so the flag is almost always stale. Mark ready (`gh pr ready "$PR"`), note the assumption, continue. (If genuinely unfinished, the CI/corrections loop surfaces it.)
- Capture **`headRefName`** (branch) and **`baseRefName`** (normally `main`) — Steps 2, 4, 7 key off the branch name.

## Step 2 — Locate (or create) the branch's worktree

Corrections (Step 4) edit code, so they must land in a checkout of the PR's **head branch** — not
whatever worktree you're in now. Find it:

```bash
git worktree list --porcelain        # match the entry whose branch == headRefName
```

- **A worktree for the branch exists** (usual case — `implement-issue` left one): use it. Pull first: `git -C <path> pull --ff-only`.
- **No local worktree/branch** (PR built elsewhere, or already cleaned): create one **only if** Step 4 needs corrections. If the PR is already `CLEAN` with green CI, merge without checking out locally. When needed, create an isolated worktree tracking the remote branch via `superpowers:using-git-worktrees` (or `git worktree add <path> <branch>` as fallback — reference §2). Remember the path; Step 7 removes it.

Don't run corrections from the current session's worktree if it isn't the PR's branch — you'd edit the
wrong checkout (a known footgun here). Use `git -C <path>` rather than `cd` (a `cd` in a compound
command gets reset between calls). Raw `git fetch`/`git push` may be sandbox-blocked even though `gh`
works (a `port 443` timeout) — re-run just those with the sandbox disabled; local git needs no network.
See `references/merge-mechanics.md` §8.

## Step 3 — Wait for CI

Let the checks finish before judging — a half-run pipeline tells you nothing:

```bash
gh pr checks "$PR" --watch        # blocks until every check concludes; exit 0 = all green
```

- **No checks reported** (`gh` errors "no checks") → no CI; move on, let Step 4's merge-state be the gate.
- **All green** → Step 4 to confirm mergeability (green CI ≠ mergeable; `main` may have moved).
- **A check failed** → read which and why before reacting; the failure feeds Step 4's correction:

```bash
gh pr checks "$PR"                                                   # the table: which check, pass/fail
gh pr view "$PR" --json statusCheckRollup \
  --jq '.statusCheckRollup[] | select(.conclusion=="FAILURE") | {name,detailsUrl}'   # failures + log links
```

`--watch` is the simplest correct wait. For a very long pipeline you may prefer to poll periodically — reference §3.

## Step 4 — Apply corrections (the loop)

The heart of the skill. Re-read the merge state, clear whatever it reports, push, re-wait — until
GitHub reports `CLEAN`. `mergeStateStatus` is the driver:

```bash
gh pr view "$PR" --json mergeStateStatus,mergeable,reviewDecision \
  --jq '{state:.mergeStateStatus, mergeable, review:.reviewDecision}'
```

| `mergeStateStatus` | What it means | Correction |
|---|---|---|
| `CLEAN` | mergeable, all gates satisfied | Done — go to Step 5. |
| `UNKNOWN` | GitHub still computing | Re-poll after a short wait; don't act on it. |
| `DRAFT` | PR is a draft | `gh pr ready "$PR"` (per Step 1's assumption), re-poll. |
| `BEHIND` | base advanced; branch behind `main` | **Sync with `main`** (below), push, re-wait CI. |
| `DIRTY` | merge conflicts with the base | **Sync with `main`** and resolve conflicts (below). |
| `UNSTABLE` | mergeable, but a check is pending/failing | Pending → wait (Step 3). Failing → **fix the red check** (below). |
| `BLOCKED` | a branch-protection gate is unmet | Usually `reviewDecision == CHANGES_REQUESTED` → **address review** (below). If it's *required approvals* you can't self-give, that's a genuine blocker — surface it. |

**Fix a red CI check.** Reproduce locally in the branch's worktree, fix it for real, commit + push. Run
the profile's *Build & test* and *CI gates* — the same ones CI runs: the **build** for compile errors,
the **single-suite test filter** for the failing suite (the full suite may need a CI-only prerequisite
the profile flags), then the format/lint **apply** then **verify** (verify must exit clean — CI fails
on any diff). Commit with the project identity, push, loop back to Step 3:

```bash
git <commit-identity> commit -am "fix: <what you fixed for CI>"
git push
```

**Sync with `main` (for `BEHIND`/`DIRTY`).** Merge the latest base in and resolve conflicts so the PR
is mergeable again. Follow the shared procedure in
[`../_shared/sync-with-main.md`](../_shared/sync-with-main.md) (merge-not-rebase, the conflict
rule-of-thumb keyed off the profile's *Conflict hot-spots*, and finish-and-verify);
`references/merge-mechanics.md` §4 has the merge-pr framing. A clean *text* merge can still break the
build — re-build/re-test before pushing.

**Address unresolved review (for `CHANGES_REQUESTED` / open threads).** Read the comments and unresolved
threads, implement the real asks in the worktree, commit + push, and reply to / resolve the threads so
the decision flips off `CHANGES_REQUESTED`. GraphQL for listing/resolving threads in
`references/merge-mechanics.md` §5. Triage with `superpowers:receiving-code-review` rigor — fix the
legitimate ones; for any you disagree with, reply on the thread rather than silently ignoring. (This
skill does **not** run a fresh `code-review` pass — `implement-issue` did that before ready; it only
reacts to review already on the PR.)

After any correction, **push and return to Step 3** (CI must re-run). Cap the loop at a few rounds; if
it won't converge to `CLEAN`, stop and report the sticking point. Watch the race: a sibling PR merging
mid-loop can knock this one `BEHIND` again — normal, just re-sync; a re-sync right before merge is the
surest path to a clean landing.

## Step 5 — Merge (squash)

Only once CI is green **and** `mergeStateStatus == CLEAN`. The profile's *Integration style* sets how to
land; for squash-merge (the `(#NNN)` commits on `main`):

```bash
gh pr merge "$PR" --squash --delete-branch \
  --subject "<PR title — already ends in (#issue)> (#$PR)"   # optional; omit to accept gh's default
```

**Prefer omitting `--subject`.** `implement-issue` titled the PR `… (#issue)`, and gh's default squash
subject is that title with `(#PR)` appended — giving the canonical `… (#issue) (#PR)` shape
automatically. If you override it, keep the `(#issue)` or you drop the link to the originating issue.

`--delete-branch` removes the **remote** branch and tidies the local ref where it can; Step 7 still
handles the local worktree + branch (gh can't delete a branch checked out in a worktree). Confirm:

```bash
gh pr view "$PR" --json state,mergedAt,mergeCommit --jq '{state, mergedAt, mergeCommit:.mergeCommit.oid}'
```

If the merge is rejected for a reason the loop didn't catch, do **not** reach for `--admin` — surface
the rejection and stop.

### Multi-issue PRs: keep the changelog honest

release-please derives the version bump and one CHANGELOG entry **per Conventional Commit on
`main`**. A squash-merge collapses the whole PR into a single commit, so a PR that closes several
issues yields exactly one release-notes line and one bump — under-reporting the work (this is what
happened with #1120 → the thin 0.246.1 notes).

When squash-merging a PR that closes **more than one issue**, write the squash-commit **body** with
one Conventional Commit line per distinct change, e.g.:

    fix(emit): qualify multi-owner cross-context type references (#1091)

    feat(emit): consolidate shared emitter infra onto #356 helpers (#581, #977)
    feat(emit): migrate C#/TS/Python emitters to the unified NeedsAdd model (#902)

Verify the resulting release PR lists an entry per line. If release-please does not split the body,
prefer not bundling unrelated issues into one squash in the first place.

## Step 6 — File follow-ups via `create-issue`

Landing a PR often leaves a tail of "not now, but worth doing" work. Capture it as tracked issues.
Gather from two sources and **de-duplicate**:

1. **Inline args** — every `--follow-up "<idea>"` passed on the command.
2. **Discovered in the PR** — a `## Follow-ups` / "Deferred" / "Out of scope" section in the PR body, and review comments that explicitly defer work ("let's do X in a separate PR", "follow-up:", "TODO in a future change"). Pull the PR body + review comments and scan (snippets in `references/merge-mechanics.md` §6). Don't manufacture follow-ups from ordinary code comments.

For **each** distinct follow-up, invoke the **`create-issue` skill** with that idea (it seeds the
brainstorm → spec → plan trail and labels it). Mention the just-merged PR for traceability, e.g.
*"Follow-up from #279: add Rust snapshot tests."* Batch several in one `create-issue` run. No follow-ups
→ skip and say so.

## Step 7 — Delete the local branch & worktree

Clean up the throwaway workspace — the right cleanup depends on **where** the branch is checked out
(you can't remove a worktree, or delete a branch, from inside it):

**Case A — the PR's branch lives in a *different* worktree** (usual: you ran `/merge-pr` from the main
checkout or another worktree). Move to the main checkout, remove the PR's worktree, delete its branch:

```bash
MAIN=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')   # the primary working tree
cd "$MAIN"

git worktree remove "<pr-worktree-path>"     # add --force if it has untracked/dirty leftovers
git worktree prune                           # clear any stale administrative entries
git branch -D "<headRefName>"                # -D (force): a squashed branch isn't "merged" by git's reckoning, so -d refuses
```

**Case B — the PR's branch is checked out in *this very session's* worktree.** Do **not** remove the
worktree you're running in. Here the *branch* is disposable, not the directory — switch this worktree
back to its prior branch (or detach), *then* delete the merged feature branch:

```bash
git -C "<this-worktree>" switch "<prior-branch>"   # or: git -C "<this-worktree>" switch --detach
git -C "<this-worktree>" branch -D "<headRefName>"
```

A native `ExitWorktree`/equivalent is the harness-aware way to leave the current worktree — use it in
place of the manual `switch` if you have one.

Either way, make each step tolerant of "already gone" — if Step 5's `--delete-branch` already removed
the local branch, or no worktree existed, that's success (guard with `|| true`; reference §7). Never
delete the main checkout or an unrelated worktree — match the path to the PR's branch exactly.

## Step 8 — Report

Short and concrete:
- The merged PR — URL and confirmation it's `MERGED` (with the squash commit sha); the branch it closed.
- **Corrections applied** — one line each: red checks fixed, conflicts resolved (which files, how), review addressed. "None needed — merged clean" is a fine report.
- **Follow-ups filed** — each new issue's title + URL, or "none."
- **Cleanup** — worktree removed and local branch deleted (or "already gone").
- Anything assumed, deferred, or unverifiable (e.g. full suite skipped for a missing local prerequisite the profile flags). Keep detail in the PR/issues; the report points there.

---

## Notes on quality

- **The merge is the one irreversible act — gate it hard.** Everything else (follow-up issues, branch deletion) is recoverable. Merge only on green CI **and** a `CLEAN` merge state, never by overriding a failing or required check.
- **Correct, don't paper over.** Fix the red test, resolve the real conflict, address the real review note. Skipping a test, forcing past a check, or hand-stitching a snapshot to clear a conflict all *look* like progress and are worse than stopping.
- **Stay resumable.** Every step keys off live GitHub/git state, so a re-run won't double-merge, double-file, or fail because a branch is already gone.
- **Follow-ups are tracked, not narrated** — deferred work belongs in an issue (via `create-issue`), not buried in the merge report.
