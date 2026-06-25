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
  push → re-wait until the PR is green and CLEAN. Then it **squash-merges** the PR, files any follow-up work as fresh issues via the
  `create-issue` skill (both follow-ups passed inline as `--follow-up "…"` and ones discovered in the
  PR body / review threads), and finally tears down the local branch and its git worktree. ALWAYS
  reach for it on those merge/land/ship phrasings, including loose ones like "can you get that PR
  merged once CI's green" or "wrap up 279 and open follow-ups for the deferred bits." Does NOT apply
  to OPENING or implementing a PR — or to syncing/un-conflicting a PR you're still building rather than
  landing it right now — (that's `implement-issue`), to reviewing a PR without merging it (that's
  `code-review` / `review`), or to creating a standalone issue with no PR to land (that's `create-issue`).
---

# Merge a pull request

## What this does and why

`implement-issue` builds a PR and flips it to ready. This skill is the next and final step: it
**lands** that PR cleanly and cleans up after itself. The job isn't just `gh pr merge` — a PR that's
ready isn't necessarily *mergeable* a few minutes later, because `main` moves, CI runs, and reviewers
leave comments. So this skill closes the gap: it waits for CI, fixes whatever is actually blocking the
merge, squashes the PR in, turns deferred work into tracked issues, and removes the throwaway branch
and worktree so nothing lingers.

The shape mirrors `implement-issue`'s tail (sync-with-`main`, the profile's conflict hot-spots, the
commit identity) — reuse that machinery rather than reinventing it. The one genuinely new piece is the
**corrections loop**: keep clearing blockers and re-waiting until GitHub reports the PR `CLEAN`, then
merge.

## Autonomy contract (important)

The user wants this to run **hands-off** once started — they point at a PR and walk away. Whenever a
step *could* stop for a question, pick the most reasonable default, state the assumption, and keep
going. Only stop for a genuine blocker you cannot honestly work past:

- `gh` is not authenticated, or you lack merge/push rights on the repo.
- The PR doesn't exist, is already merged/closed, or the number is ambiguous.
- **CI stays red after a real fix attempt.** Don't merge over a red bar, don't disable a failing
  test to go green, don't `--admin`-override a required check just to get past it. Fix it for real or
  stop and show the failing output.
- **A merge conflict you can't resolve with confidence** — both `main` and the branch rewrote the
  *same logic* and picking a side would silently drop a sibling PR's work. The mechanical conflicts
  (version, changelog, snapshots, lockfiles) have known-correct fixes (Step 4) — handle those;
  stop only for the genuinely ambiguous ones, showing both sides.
- **A reviewer requested changes you can't satisfy** without guessing at intent, or the merge is
  blocked by a branch-protection rule you can't legitimately clear (required approvals you can't give
  yourself).

The merge itself is the irreversible act — earn it. Merge only when CI is **green on the
just-corrected branch** and GitHub reports the PR mergeable; a textual merge of `main` is not a
semantic one, so re-build/re-test after resolving conflicts before you trust it. Filing a follow-up
issue and deleting a local branch are reversible and cheap — those you can do on a reasonable default.

## Inputs

- **PR identifier** (required) — a number (`279`), an issue/PR URL, or a `gh` PR link. Resolve it to a
  number (Step 1).
- **`--follow-up "<idea>"`** (optional, repeatable) — follow-up work to file as issues after the merge.
  e.g. `/merge-pr 279 --follow-up "add Rust snapshot tests" --follow-up "document minimap config"`.
  These are *added to* whatever follow-ups Step 6 discovers in the PR itself.

## Checklist

Create a task (todo) for each item and work them in order. Step 4 is a loop — repeat until the PR is
mergeable.

1. **Preconditions & resolve the PR** — `gh` works, you're in the target repo, normalize the PR number,
   confirm it's open and capture its head branch + merge state.
2. **Locate (or create) the branch's worktree** — find the local worktree/branch for the PR's head so
   corrections land in the right checkout; create one tracking the remote branch if none exists.
3. **Wait for CI** — let the checks finish; read the rollup.
4. **Apply corrections (loop)** — clear each blocker the merge state reports (red CI · behind/dirty vs
   `main` · unresolved review · draft), push, and re-wait until the PR is `CLEAN`.
5. **Merge (squash)** — `gh pr merge --squash --delete-branch` once it's green and mergeable.
6. **File follow-ups** — gather inline `--follow-up` args + ones discovered in the PR, and file each via
   the `create-issue` skill.
7. **Delete the local branch & worktree** — from the main checkout, remove the PR's worktree and its
   local branch.
8. **Report** — merged PR URL, corrections applied, follow-up issues filed, cleanup done.

Resume-safe: re-running mid-flight is fine. If the PR is already merged, skip to Steps 6–7 (file
follow-ups, clean up). If the worktree/branch is already gone, skip Step 7.

---

## Step 1 — Preconditions & resolve the PR

**Load the repo profile first.** This skill reads every repo-specific fact from the repo profile, never
inline: the commit identity, the CI gate commands, the integration style, and the conflict hot-spots.
Run the **`get-repo-profile`** skill; it returns `.claude/skills/repo-profile.md` (generating it on
first use), and the steps below cite its named sections. Throughout, **`git <commit-identity>`** stands
for the author line from the profile's *Commit identity* (its `-c user.email=… -c user.name="…"` flags)
— substitute it in the commit/merge commands below. If no profile exists and you genuinely can't
generate one, say so in the report rather than guessing repo specifics.

```bash
gh api user --jq .login                                  # prints a login, or 401 → not authed
gh repo view --json nameWithOwner --jq .nameWithOwner    # confirm it's the repo the profile names
```

If auth fails, stop and tell the user to run `! gh auth login -h github.com` in the prompt (the `!`
prefix runs it in this session so the token lands in your environment), then re-check.

Normalize the PR identifier to a number (a bare number, an issue/PR URL, and a `gh` link all reduce to
the first run of digits — see `references/merge-mechanics.md` §1), then confirm it's real and open and
capture what drives the rest of the run:

```bash
gh pr view "$PR" --json number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefName,baseRefName,url \
  --jq '{number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,head:.headRefName,base:.baseRefName,url}'
```

- `state != OPEN` → if already `MERGED`, skip ahead to Steps 6–7 (follow-ups + cleanup); if `CLOSED`
  (not merged), stop and ask — merging a deliberately closed PR is not a safe default.
- `isDraft == true` → the user asked to *merge* it, so the draft flag is almost always just stale.
  Mark it ready (`gh pr ready "$PR"`), note the assumption, and continue. (If it's draft because it's
  genuinely unfinished, the CI/corrections loop will surface that.)
- Capture **`headRefName`** (the branch) and **`baseRefName`** (normally `main`) — Steps 2, 4, and 7
  all key off the branch name.

## Step 2 — Locate (or create) the branch's worktree

Corrections (Step 4) edit code, so they must land in a checkout of the PR's **head branch** — not
whatever worktree you happen to be in now. Find it:

```bash
git worktree list --porcelain        # match the entry whose branch == headRefName
```

- **A worktree for the branch exists** (the usual case — `implement-issue` left one): use it. `cd`
  there for all corrections. Pull first so it's current: `git -C <path> pull --ff-only`.
- **No local worktree/branch** (PR built elsewhere, or already cleaned): only create one **if** Step 4
  turns out to need corrections. If the PR is already `CLEAN` with green CI, you can merge without ever
  checking it out locally. When you do need it, create an isolated worktree tracking the remote branch
  via `superpowers:using-git-worktrees` (or `git worktree add <path> <branch>` as a fallback) — see
  `references/merge-mechanics.md` §2. Remember the path; it's what Step 7 removes.

Don't run corrections from the current session's own worktree if that isn't the PR's branch — you'd
edit the wrong checkout (a known footgun in this repo). Use `git -C <path>` rather than `cd` — a `cd`
in a compound command gets reset between calls here, so absolute-pathed git is the reliable form. And
note that raw `git fetch`/`git push` may be sandbox-blocked even though `gh` works (you'll see a
`port 443` timeout); re-run just those network commands with the sandbox disabled — local git
(merge/commit/worktree) needs no network. See `references/merge-mechanics.md` §8.

## Step 3 — Wait for CI

Let the checks finish before judging the PR — a half-run pipeline tells you nothing:

```bash
gh pr checks "$PR" --watch        # blocks until every check concludes; exit 0 = all green
```

- **No checks reported** (`gh` errors with "no checks") → this PR has no CI; that's fine, move on and
  let the merge-state in Step 4 be the gate.
- **All green** → go to Step 4 to confirm mergeability (green CI ≠ mergeable; `main` may have moved).
- **A check failed** → read which one and why before reacting; the failure feeds Step 4's correction:

```bash
gh pr checks "$PR"                                                   # the table: which check, pass/fail
gh pr view "$PR" --json statusCheckRollup \
  --jq '.statusCheckRollup[] | select(.conclusion=="FAILURE") | {name,detailsUrl}'   # failures + log links
```

If checks take long, `--watch` is still the simplest correct tool (it's a real wait, not a sleep).
For a very long pipeline you may prefer to poll periodically instead — see §3 of the reference.

## Step 4 — Apply corrections (the loop)

This is the heart of the skill. Re-read the merge state, clear whatever it reports, push, and re-wait
— until GitHub reports the PR `CLEAN`. `mergeStateStatus` is the driver:

```bash
gh pr view "$PR" --json mergeStateStatus,mergeable,reviewDecision \
  --jq '{state:.mergeStateStatus, mergeable, review:.reviewDecision}'
```

| `mergeStateStatus` | What it means | Correction |
|---|---|---|
| `CLEAN` | mergeable, all gates satisfied | Done — go to Step 5. |
| `UNKNOWN` | GitHub still computing | Re-poll after a short wait; don't act on it. |
| `DRAFT` | PR is a draft | `gh pr ready "$PR"` (per Step 1's assumption), re-poll. |
| `BEHIND` | base advanced; branch is behind `main` | **Sync with `main`** (below), push, re-wait CI. |
| `DIRTY` | merge conflicts with the base | **Sync with `main`** and resolve conflicts (below). |
| `UNSTABLE` | mergeable, but a check is pending/failing | If pending → wait (Step 3). If failing → **fix the red check** (below). |
| `BLOCKED` | a branch-protection gate is unmet | Usually `reviewDecision == CHANGES_REQUESTED` → **address review** (below). If it's *required approvals* you can't self-give, that's a genuine blocker — surface it. |

**Fix a red CI check.** Reproduce the failure locally in the branch's worktree, fix it for real, then
commit + push. Run the profile's *Build & test* commands and its *CI gates* — the same ones CI runs: the
**build** to catch compile errors, the **single-suite test filter** for the failing suite (the full
suite may need a CI-only prerequisite the profile flags), then the format/lint **apply** command
followed by its **verify** command (which must exit clean — CI fails the build on any diff).

Commit with the project identity, push, and loop back to Step 3 to let CI re-run:

```bash
git <commit-identity> commit -am "fix: <what you fixed for CI>"
git push
```

**Sync with `main` (for `BEHIND`/`DIRTY`).** Merge the latest base in and resolve conflicts. When the
profile's *Integration style* is squash-merge, a `merge` (not a rebase) is right — one pass per
conflict, no force-push, and the throwaway merge commit vanishes when the PR squashes. The profile's
*Conflict hot-spots* (version, changelog, README/docs, snapshots, lockfiles, additive code) have
known-correct resolutions — **union** additive files, **regenerate** derived files (snapshots,
lockfiles), **take the higher** version. The full table and finish/verify sequence live in
`references/merge-mechanics.md` §4 (identical to `implement-issue`'s Step 8). A clean *text* merge can
still break the build — re-build/re-test before pushing.

**Address unresolved review (for `CHANGES_REQUESTED` / open threads).** Read the review comments and
the unresolved threads, implement the real asks in the worktree, commit + push, and reply to (or
resolve) the threads so the decision flips off `CHANGES_REQUESTED`. The GraphQL for listing unresolved
threads and resolving them is in `references/merge-mechanics.md` §5. Triage with
`superpowers:receiving-code-review` rigor — fix the legitimate ones; for any you disagree with, reply
on the thread explaining why rather than silently ignoring it. (Note: this skill does **not** run a
fresh `code-review` pass — `implement-issue` already did that before marking ready. It only reacts to
review that already exists on the PR.)

After any correction, **push and return to Step 3** (CI must re-run on the new commits). Cap the loop
at a few rounds; if it won't converge to `CLEAN`, stop and report the sticking point (Autonomy
contract). Watch the race: a sibling PR merging mid-loop can knock this one `BEHIND` again — that's
normal, just re-sync; a re-sync right before the merge is the surest path to a clean landing.

## Step 5 — Merge (squash)

Only once CI is green **and** `mergeStateStatus == CLEAN`. The profile's *Integration style* sets how to
land it; for squash-merge (the `(#NNN)` commits on `main`):

```bash
gh pr merge "$PR" --squash --delete-branch \
  --subject "<PR title — already ends in (#issue)> (#$PR)"   # optional; omit to accept gh's default
```

**Prefer omitting `--subject`.** `implement-issue` deliberately titled the PR `… (#issue)`, and gh's
default squash subject is that PR title with `(#PR)` appended — giving the repo's canonical
`… (#issue) (#PR)` shape automatically. If you *do* override it, keep the `(#issue)` in the subject or
you drop the link back to the originating issue.

`--delete-branch` removes the **remote** branch and tidies the local ref where it can; Step 7 still
handles the local worktree + branch explicitly (gh can't delete a branch that's checked out in a
worktree). Confirm it landed:

```bash
gh pr view "$PR" --json state,mergedAt,mergeCommit --jq '{state, mergedAt, mergeCommit:.mergeCommit.oid}'
```

If the merge is rejected for a reason the loop didn't catch (e.g. a required check that only blocks at
merge time), do **not** reach for `--admin` to force it — surface the rejection and stop.

## Step 6 — File follow-ups via `create-issue`

Landing a PR often leaves a tail of "not now, but worth doing" work. Capture it as tracked issues so it
isn't lost. Gather follow-ups from two sources and **de-duplicate**:

1. **Inline args** — every `--follow-up "<idea>"` the user passed on the command.
2. **Discovered in the PR** — a `## Follow-ups` / "Deferred" / "Out of scope" section in the PR body,
   and review comments that explicitly defer work ("let's do X in a separate PR", "follow-up:", "TODO
   in a future change"). Pull the PR body + review comments and scan them (snippets in
   `references/merge-mechanics.md` §6). Don't manufacture follow-ups from ordinary code comments — only
   things genuinely flagged as deferred.

For **each** distinct follow-up, invoke the **`create-issue` skill** with that idea (it seeds the
brainstorm → spec → plan trail and labels the issue). Mention the just-merged PR for traceability,
e.g. *"Follow-up from #279: add Rust snapshot tests."* Batch them in one `create-issue` run when there
are several. If there are no follow-ups from either source, skip this step and say so.

## Step 7 — Delete the local branch & worktree

Clean up the throwaway workspace — but the right cleanup depends on **where** the PR's branch is
checked out, because you can't remove a worktree (or delete a branch) from inside it. Figure out which
case you're in first:

**Case A — the PR's branch lives in a *different* worktree** (the usual case: you ran `/merge-pr` from
the main checkout or another worktree). Move to the main checkout, remove the PR's worktree, then delete
its local branch:

```bash
MAIN=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')   # the primary working tree
cd "$MAIN"

git worktree remove "<pr-worktree-path>"     # add --force if it has untracked/dirty leftovers
git worktree prune                           # clear any stale administrative entries
git branch -D "<headRefName>"                # -D (force): a squashed branch isn't "merged" by git's reckoning, so -d refuses
```

**Case B — the PR's branch is checked out in *this very session's* worktree.** Do **not** remove the
worktree you're running in: you'd pull the rug out from under the session, and it's the user's active
workspace, not a throwaway. Here the *branch* is what's disposable, not the directory — so switch this
worktree back to whatever branch it held before (or detach), *then* delete the merged feature branch:

```bash
git -C "<this-worktree>" switch "<prior-branch>"   # or: git -C "<this-worktree>" switch --detach
git -C "<this-worktree>" branch -D "<headRefName>"
```

A native `ExitWorktree`/equivalent is the harness-aware way to leave the current worktree if you have
one — use it in place of the manual `switch`.

Either way, make each step tolerant of "already gone" — if `--delete-branch` in Step 5 already removed
the local branch, or no worktree existed, that's success, not an error (guard with `|| true` or check
first; see reference §7). The remote branch is already gone via Step 5's `--delete-branch`; gh leaves
the local side untouched when the branch is checked out in a worktree, which is exactly why this step
exists. Never delete the main checkout or an unrelated worktree — match the path to the PR's branch
exactly before removing.

## Step 8 — Report

Short and concrete:
- The merged PR — URL and confirmation it's `MERGED` (with the squash commit sha); the branch it closed.
- **Corrections applied** — one line each: red checks fixed, conflicts resolved (which files, how),
  review comments addressed. "None needed — merged clean" is a perfectly good report.
- **Follow-ups filed** — each new issue's title + URL, or "none."
- **Cleanup** — worktree removed and local branch deleted (or "already gone").
- Anything you assumed, deferred, or couldn't verify (e.g. full test suite skipped for a missing local
  prerequisite the profile flags). Keep detail in the PR/issues; the report just points there.

---

## Notes on quality

- **The merge is the one irreversible act — gate it hard.** Everything else (follow-up issues, branch
  deletion) is recoverable. Merge only on green CI **and** a `CLEAN` merge state, never by overriding a
  failing or required check. A PR that goes red the instant it lands, or that needed `--admin` to get
  in, wasn't ready.
- **Correct, don't paper over.** "Apply corrections" means making the PR genuinely mergeable — fix the
  red test, resolve the real conflict, address the real review note. Skipping a test, forcing past a
  check, or hand-stitching a snapshot to clear a conflict all *look* like progress and are worse than
  stopping.
- **Stay resumable.** Every step keys off live GitHub/git state (PR status, merge state, worktree
  list), so a re-run picks up where it left off — it won't double-merge, double-file, or fail because a
  branch is already gone.
- **A textual merge is not a semantic merge.** After syncing `main`, re-build and re-test on the merged
  tree before pushing — `main` may have renamed a symbol the branch still calls.
- **Follow-ups are tracked, not narrated.** Deferred work belongs in an issue (via `create-issue`), not
  buried in the merge report where it's forgotten. File it so someone can pick it up cold.
- **Clean up after yourself.** A merged PR's branch and worktree are dead weight — leaving them around
  clutters `git worktree list` and the branch list for everyone. Remove them, but only ever the PR's
  own — match the path/branch exactly.
