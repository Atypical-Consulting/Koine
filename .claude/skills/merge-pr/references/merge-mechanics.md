# GitHub / git mechanics for `merge-pr`

The fiddly `gh`/`git`/`jq`/GraphQL snippets the main workflow leans on. Read the section you need when
you hit it. `{owner}/{repo}` is a literal `gh` placeholder it resolves from `origin` (here
`Atypical-Consulting/Koine`) — paste it as-is.

---

## 1. Resolve the PR number from whatever the user gave you

A bare number, a PR/issue URL, or a `gh` link all reduce to the first run of digits:

```bash
ARG="$1"   # e.g. 279 | https://github.com/Atypical-Consulting/Koine/pull/279 | "#279"
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

Koine's CI gates (so you can reproduce a red check locally — see `.github/workflows/ci.yml`): restore
with the `wasm-tools wasm-experimental` workloads, `dotnet build`, `dotnet test`, and
`dotnet format Koine.slnx --verify-no-changes --no-restore`. The format gate trips on style/analyzer
diffs that compile fine (e.g. `IDE0011` missing braces); run `dotnet format Koine.slnx` to apply, then
the `--verify-no-changes` form to confirm it's clean. A few analyzer diagnostics (e.g. `IDE1006`
naming) can't be auto-fixed — `dotnet format` prints "doesn't support Fix All"; rename by hand.

---

## 4. Sync with `main` and resolve conflicts (`BEHIND` / `DIRTY`)

Identical to `implement-issue`'s Step 8 — the project squash-merges, so **merge, don't rebase**: one
pass per conflict, no force-push, merge commit squashed away at landing.

```bash
git fetch origin main
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" merge origin/main
```

Passing `-c user.email/-c user.name` on the merge means the auto-created merge commit carries the
GitHub identity too.

### Koine conflict hot-spots — known-correct resolutions

The great majority of conflicts here are mechanical with one right answer:

| File | Why it collides | Resolution |
|------|-----------------|------------|
| `Directory.Build.props` — `<Version>` **and** `<InformationalVersion>` | every feature bumps the patch version | Keep the **higher** of the two (both lines must match). Never stack both bumps into a double increment. |
| `CHANGELOG.md` | everyone appends an entry | **Union** — keep *both* entries under the current heading. |
| `README.md`, `USER-STORIES.md`, feature catalogue, `website/` docs | parallel features document themselves | **Union** — keep both sides' sections. |
| Verify snapshots `*.verified.txt` | two branches changed emitted output | **Don't hand-merge.** Take *either* side to clear the conflict, then re-run that test and accept the fresh `*.received.txt` → `.verified.txt`. The regenerated snapshot is ground truth. |
| `tooling/koine-studio/package-lock.json` | lockfiles conflict constantly | **Don't hand-merge.** Take either side, then `npm install` in `tooling/koine-studio` to regenerate; commit the result. |
| `tooling/koine-studio/package.json` | both add deps/scripts | Union deps/scripts, then regenerate the lockfile (above). |
| Emitter partials (`Emit/CSharp/CSharpEmitter.*.cs`), `UsingCollector`, `CSharpNaming` | both add methods/usings to the same partial | **Union** — keep both; let the build catch a genuine clash. |
| Test files (`R##…Tests.cs`, focused suites) | both append tests to the same class | **Union** — keep both sets of tests. |
| `.csproj`, `Koine.slnx` | both add files/projects | **Union** the item groups. |
| Studio front-end (`tooling/koine-studio/src/**`) | parallel Studio features touch shared components | **Union** where additive (new components, new routes); for the same component edited both ways, understand both intents — don't blindly take one side. |

Rule of thumb: **union** additive files (docs, tests, `CHANGELOG`), **regenerate** derived files
(snapshots, lockfiles), **take-the-higher** for the version. Anything where both sides edited the *same
logic* is a real semantic conflict — resolve by understanding both intents, or stop and surface it with
both sides shown (Autonomy contract).

### Finish and verify the merge

A clean text merge can still break the build. Prove it before pushing:

```bash
git add -A
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit --no-edit   # completes the merge
dotnet build                          # + the affected test filters; full suite needs wasm workloads
git push
```

Then loop back to wait for CI (§3) — never push a merge you haven't at least built.

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

You can't remove a worktree or delete a branch you're standing in, so move to the main checkout first:

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

Guards matter here — this step runs after the irreversible merge, so it must never *fail the run* just
because something was already cleaned up. "Already gone" is success.

**Native worktree tools:** if the PR's worktree happens to be the one *this session* is running in, a
native `ExitWorktree`/equivalent is the right tool (it knows the harness state). For any *other*
worktree, use `git worktree remove` — a native "exit" tool only manages the current one.

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
