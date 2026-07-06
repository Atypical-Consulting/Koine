# GitHub / git mechanics for `merge-pr`

The fiddly `gh`/`git`/`jq`/GraphQL snippets the main workflow leans on. Read the section you need when
you hit it. `{owner}/{repo}` is a literal `gh` placeholder it resolves from `origin` (the repo the
profile names) — paste it as-is. And `git <commit-identity>` is the author line from the profile's
*Commit identity* (SKILL.md Step 1) — substitute its `-c user.email=… -c user.name="…"` flags below.

---

## 1. Resolve the PR number from whatever the user gave you

A bare number, a PR/issue URL, or a `gh` link all reduce to the first run of digits:

```bash
ARG="$1"   # e.g. 279 | https://github.com/<owner>/<repo>/pull/279 | "#279"
PR=$(printf '%s' "$ARG" | grep -oE '[0-9]+' | head -1)
```

Strip any `--follow-up "…"` args before this so their text can't contribute stray digits — parse the
command into the PR token and the list of follow-up strings first, then run the digit extraction on the
PR token alone.

Confirm it's a real, open PR before doing anything irreversible:

```bash
gh pr view "$PR" --json number,title,state,isDraft,mergeStateStatus,headRefName,baseRefName,url \
  --jq '"\(.number) [\(.state)\(if .isDraft then "/draft" else "" end)] \(.mergeStateStatus) \(.headRefName) — \(.title)"'
```

---

## 2. Find — or create — the branch's worktree

Corrections must land in a checkout of the PR's head branch. List worktrees and match the branch:

```bash
HEAD_BRANCH=$(gh pr view "$PR" --json headRefName --jq .headRefName)

# Print "<path> <branch>" per worktree, then grep the branch.
git worktree list --porcelain \
  | awk '/^worktree /{p=$2} /^branch /{sub("refs/heads/","",$2); print p, $2}' \
  | grep -E " ${HEAD_BRANCH}$"
```

If a worktree is found, `cd` to its path and `git pull --ff-only` so it's current. If not, and Step 4
shows corrections are needed, create one tracking the remote branch (prefer
`superpowers:using-git-worktrees`; this is the manual fallback):

```bash
git fetch origin "$HEAD_BRANCH"
WT=".claude/worktrees/merge-$PR"               # any ignored path; this is what Step 7 removes
git worktree add "$WT" "$HEAD_BRANCH"          # checks out the existing branch (tracks origin/$HEAD_BRANCH)
cd "$WT"
```

`.claude/worktrees/` is the repo's conventional (git-ignored) home for worktrees. Remember the exact
path — Step 7 removes it.

---

## 3. Waiting on CI

`--watch` blocks until every check concludes; its exit code is 0 only if all passed:

```bash
gh pr checks "$PR" --watch            # blocks; exit 0 = all green, non-zero = at least one failed
gh pr checks "$PR"                    # the table (re-read anytime): NAME / STATE / pass-fail / link
```

Inspect failures via the rollup (gives the log URL to read):

```bash
gh pr view "$PR" --json statusCheckRollup \
  --jq '.statusCheckRollup[] | select(.conclusion=="FAILURE") | {name, detailsUrl}'
```

- **"no checks reported"** error → the PR has no CI; treat CI as satisfied and let `mergeStateStatus`
  (§4) be the only gate.
- **Long pipelines** → `--watch` is fine (a real wait, not a `sleep`). If you'd rather not hold the turn
  open, poll instead: read the rollup, and if anything is `IN_PROGRESS`/`QUEUED`, come back later
  (e.g. via `ScheduleWakeup`) rather than busy-looping.

The repo's CI gates (so you can reproduce a red check locally) are the profile's *CI gates* — its build,
test, and format/lint **verify** commands, plus any prerequisite the profile flags (a workload, a
toolchain). The format/lint gate trips on style/analyzer diffs that compile fine; run the profile's
format/lint **apply** command, then its **verify** command to confirm it's clean. Heed the profile's
caveats — some analyzer diagnostics can't be auto-fixed and must be hand-corrected.

---

## 4. Sync with `main` and resolve conflicts (`BEHIND` / `DIRTY`)

Clears the `BEHIND`/`DIRTY` merge states in the corrections loop (SKILL.md Step 4): merge the latest
base into the branch and resolve conflicts so the PR is mergeable again, then loop back to wait for CI
(§3).

The procedure — merge-not-rebase, the union/regenerate/take-the-higher rule-of-thumb keyed off the
profile's *Conflict hot-spots* table, and finish-and-verify — is shared with `implement-issue` and
lives in [`../../_shared/sync-with-main.md`](../../_shared/sync-with-main.md). Never push a merge you
haven't at least built.

---

## 5. Unresolved review threads (`CHANGES_REQUESTED` / open conversations)

The overall decision:

```bash
gh pr view "$PR" --json reviewDecision --jq .reviewDecision   # APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
```

Inline review comments (REST — quick read of what reviewers said and where):

```bash
gh api "repos/{owner}/{repo}/pulls/$PR/comments" --paginate \
  --jq '.[] | {path, line, user:.user.login, body}'
```

Unresolved **threads** need GraphQL (REST doesn't expose `isResolved`):

```bash
gh api graphql -f query='
  query($owner:String!,$repo:String!,$pr:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$pr){
        reviewThreads(first:100){
          nodes{ id isResolved isOutdated
            comments(first:1){ nodes{ path body author{login} } } } } } } }' \
  -F owner='{owner}' -F repo='{repo}' -F pr="$PR" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | {id, path:.comments.nodes[0].path, body:.comments.nodes[0].body}'
```

Fix the legitimate asks in the worktree, commit + push (project identity). Then either reply to the
thread explaining the fix, or resolve it once addressed (`THREAD_ID` from the query above):

```bash
gh api graphql -f query='
  mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' \
  -F id="$THREAD_ID"
```

For a comment you disagree with, **reply on the thread** with your reasoning rather than silently
ignoring it (`superpowers:receiving-code-review` discipline). The goal is to flip `reviewDecision` off
`CHANGES_REQUESTED` honestly. A required-approvals block you can't self-clear is a genuine
blocker — surface it.

---

## 6. Discovering follow-ups in the PR

Two sources beyond the inline `--follow-up` args:

**PR body** — look for a deferred-work section:

```bash
gh pr view "$PR" --json body --jq .body \
  | grep -iA12 -E '^#+ *(follow[ -]?ups?|deferred|out[ -]of[ -]scope|future work)'
```

**Review comments that defer work** — phrases that explicitly punt to a later change:

```bash
gh api "repos/{owner}/{repo}/pulls/$PR/comments" --paginate --jq '.[].body' \
  | grep -iE 'follow[ -]?up|separate (pr|issue)|in a (later|future) (pr|change)|out of scope|TODO.*(later|future)'
```

Only treat as a follow-up something **explicitly flagged as deferred** — not every `// TODO` in the
diff. De-dup against the inline args (don't file the same idea twice), then hand each distinct idea to
the `create-issue` skill, noting the source PR for traceability.

---

## 7. Teardown — remove the worktree and local branch

You can't remove a worktree or delete a branch you're standing in, so the move depends on **where** the
PR's branch is checked out. Decide the case from §2's worktree listing.

### Case A — the PR's branch is in a *different* worktree (the usual case)

Move to the main checkout, remove the PR's worktree, then delete its local branch:

```bash
MAIN=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')   # first entry = primary working tree
cd "$MAIN"

# Remove the PR's worktree (force only if it has dirty/untracked leftovers — a merged PR shouldn't).
git worktree remove "$PR_WORKTREE_PATH" 2>/dev/null || git worktree remove --force "$PR_WORKTREE_PATH" 2>/dev/null || true
git worktree prune

# Delete the local branch. -D (not -d): after a squash-merge the branch isn't "merged" in git's view,
# so -d refuses. Tolerate "not found" — gh pr merge --delete-branch may already have removed it.
git branch -D "$HEAD_BRANCH" 2>/dev/null || true
```

### Case B — the PR's branch is checked out in *this session's own* worktree

This happens when `/merge-pr` is invoked from inside the very worktree that holds the PR branch.
**Don't remove this worktree** — it's the session's live workspace, not a throwaway, and git won't let
you delete a directory you're standing in anyway. The disposable thing is the *branch*. So switch this
worktree off it (back to its prior branch, or detach), then delete the merged branch:

```bash
# A native ExitWorktree/equivalent is the harness-aware way to leave the current worktree — prefer it.
# Manual fallback: switch off the merged branch, then delete it.
git -C "$THIS_WORKTREE" switch "$PRIOR_BRANCH" 2>/dev/null || git -C "$THIS_WORKTREE" switch --detach
git -C "$THIS_WORKTREE" branch -D "$HEAD_BRANCH" 2>/dev/null || true
```

Tip: if the branch was *created* in this worktree this session (no meaningful prior branch), detaching
is cleanest. Re-fetching `origin/main` and switching to a fresh branch off it is also fine if you need
the post-merge tree (e.g. to keep working).

### Both cases

Guards matter — this step runs after the irreversible merge, so it must never *fail the run* just
because something was already cleaned up. "Already gone" is success. The **remote** branch is already
gone via Step 5's `--delete-branch`; gh leaves the **local** side untouched when the branch is checked
out in a worktree (you'll see `failed to delete local branch … used by worktree` or `'main' is already
used by worktree`), which is exactly why this step exists.

**Safety:** never remove `$MAIN` or a worktree whose branch isn't the PR's head. Match the path to the
branch (via §2's listing) before removing — a wrong `git worktree remove --force` throws away someone
else's in-progress work.

---

## 8. Environment gotchas (this sandbox)

Two things that bite a real run here:

- **Raw `git` network ops can be sandbox-blocked while `gh` is allowed.** `gh api`/`gh pr …` work, but
  `git fetch`/`git push` (and the merge's push) may time out with `Failed to connect to github.com
  port 443`. `gh` proves the host is reachable, so this is a sandbox restriction on git's traffic, not
  an outage — re-run those specific commands with the sandbox disabled. The *local* git ops (`merge`,
  conflict resolution, `commit`, `worktree remove`, `branch -D`) need no network and run normally.
- **`cd` in a compound command gets reset between tool calls.** Prefer `git -C <path> …` and
  `--prefix`/absolute paths over `cd <path> && …` so each command targets the right tree deterministically
  — especially the teardown, which must run against `$MAIN`, not the worktree being deleted.
