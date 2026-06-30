---
name: implement-issue
description: >-
  Do the actual coding for an existing GitHub issue and turn it into a finished pull request — the
  "go build it" counterpart to `create-issue` for the Koine project. Use whenever an issue already
  carries an implementation plan (a `**🛠️ Implementation plan**` section in its description, or a
  comment on older issues, with a `### Task N` / `- [ ]` checklist) and the user wants it BUILT: it
  spins up a git worktree, opens a DRAFT pull request, then loops task-by-task — implement → commit →
  tick that task's checkbox on the live issue — until every box is checked, then runs the `code-review`
  skill, applies the fixes, merges the latest `main` into the branch and resolves any conflicts so the
  PR stays mergeable, runs the formatter, and flips the PR from draft to ready. ALWAYS reach for it when
  the user wants to implement, build, code, execute, ship, finish, knock out, work through, resume, or
  "pick up" a GitHub issue or its plan — or to keep that *in-flight* PR mergeable by rebasing/syncing
  its branch or fixing its conflicts with `main` while it's still being built — e.g. "implement issue
  47", "knock out the tasks on issue 71", "execute the plan on this issue and mark the PR ready", "build
  the feature from issue #X and open a PR", or a bare issue link with "go build it." Does NOT apply to
  CREATING, filing, or planning a new issue (that's `create-issue`), to editing a plan, to merely
  commenting on / closing / listing issues, to ad-hoc coding with no issue plan to drive it, or to
  *landing* a finished PR — syncing/un-conflicting a PR purely to merge it now is `merge-pr`.
---

# Implement an issue from its plan

## What this does

`create-issue` builds every issue around a `**🛠️ Implementation plan**` section: a checklist of
`### Task N` blocks whose every step is a `- [ ]` checkbox, with the **last step of each task being its
commit message**. (Older issues carry the same plan as a comment — this skill handles both.) That plan
is a contract an executor can run cold; this skill is that executor.

It turns the plan into a real PR the way a careful engineer would: isolated worktree, draft PR opened
up front so progress is visible, one commit per task, and — the part that makes the issue a live
progress board — **each task's checkboxes get ticked on the issue as the work lands.** When the last
box is checked, it runs a code review, fixes what surfaces, and marks the PR ready.

Plans prescribe their own executor (`> REQUIRED SUB-SKILL: superpowers:subagent-driven-development …`),
so this skill leans on the **superpowers** skills to do the implementing — it owns the
GitHub/worktree/PR bookkeeping around them.

## Autonomy contract

Run **hands-off** once started — the user watches, doesn't babysit. Whenever a sub-skill (worktree,
executing-plans, code review) would pause for a question or sign-off, **pick the reasonable default,
state the assumption, keep going.** Stop only for a genuine blocker:

- `gh` not authenticated, or no push access.
- No `🛠️ Implementation plan` on the issue — not in body, not in a comment (nothing to execute).
- A task's tests can't be made green after an honest effort — don't fake green, don't commit over a red bar, don't tick a box for work that doesn't pass. Stop and report the wall with the failing output.
- A merge conflict you can't resolve with confidence — both `main` and your branch rewrote the *same logic*, and picking a side would silently drop a sibling PR's work. The mechanical conflicts (version, changelog, snapshots, lockfiles) have known-correct resolutions (Step 8) — handle those; stop only for genuinely ambiguous ones, showing both sides.

Never tick a box, commit, or flip the PR to ready on an assumption — those three acts claim work is
*done*; back them with evidence (tests run, output seen), per
`superpowers:verification-before-completion`. A resolved merge is the same claim: re-build and re-test
on the merged tree — a clean *textual* merge is not a clean *semantic* one.

## Checklist

Create a task per item and work them in order. Step 6 is the loop — one pass per task.

1. **Preconditions** — `gh` works, you're in the target repo, resolve the issue number.
2. **Read the plan** — fetch the `🛠️ Implementation plan` from the issue body (or a comment, on older issues); save it and note where it lives.
3. **Pick the execution mode** — assess complexity → *Inline (Extra)* or *Subagent-per-task (Ultracode)*.
4. **Create the worktree** — via `superpowers:using-git-worktrees`; branch off `main`.
5. **Open the draft PR** — empty scaffold commit, push, `gh pr create --draft` linking the issue; PR title ends with `(#<issue>)`.
6. **Loop until every task is checked** — implement the next unchecked task → verify green → commit → tick that task on the issue plan *and* the PR description → push.
7. **Code review** — run the `code-review` skill, apply + commit the fixes, push.
8. **Sync with `main`** — merge the latest `origin/main` into the branch and resolve conflicts per the profile's *Conflict hot-spots* (version, changelog, snapshots, lockfiles — see reference).
9. **Verify, format, then mark ready** — build/tests green on the merged tree AND the profile's format/lint verify gate clean (commit fixes), then `gh pr ready`.
10. **Report** — PR URL, what shipped, anything assumed or deferred.

Resume-safe: re-running mid-flight is fine. A task is "done" when **all** its step checkboxes read
`- [x]`; start at the first that isn't. Reuse an existing worktree/branch/PR rather than making a second
(see `references/github-mechanics.md`).

---

## Step 1 — Preconditions

**Load the repo profile first.** This skill reads every repo-specific fact from the committed file
**`.claude/skills/repo-profile.md`**: commit identity, build/test/format commands and CI gates, conflict
hot-spots, architecture grain. Read it directly — `cat .claude/skills/repo-profile.md` — and the steps
below cite its sections. Only if that file is **missing** (or the user asks to refresh it) run
**`get-repo-profile`** to generate it first, then read it. Throughout, **`git <commit-identity>`** stands
for the author line from the profile's *Commit identity* (its `-c user.email=… -c user.name="…"` flags) —
substitute it in every commit/merge command. If you genuinely can't get a profile, say so in the report
rather than guessing repo specifics.

```bash
gh api user --jq .login                       # prints a login, or 401 → not authed
gh repo view --json nameWithOwner --jq .nameWithOwner   # confirm it's the repo the profile names
```

If auth fails, stop and tell the user to run `! gh auth login -h github.com` in the prompt, then re-check.

Resolve the **issue number** from the user's request — a number (`21`), an issue URL, or a link to the
plan comment (`…/issues/21#issuecomment-12345`). The locator snippets in
`references/github-mechanics.md` handle all three.

## Step 2 — Read the plan

`create-issue` writes the plan into the **issue body**, so read that first; only older issues carry it
as a comment:

```bash
ISSUE=21
gh api "repos/{owner}/{repo}/issues/$ISSUE" --jq .body > /tmp/koine-plan-$ISSUE.md
if grep -q '🛠️ Implementation plan' /tmp/koine-plan-$ISSUE.md; then
  PLAN_SRC=body                       # Step 6 ticks boxes by PATCHing the issue body
else
  PLAN_SRC=comment                    # legacy issue: the plan is a comment — locate and pull it instead
  PLAN_COMMENT_ID=$(gh api "repos/{owner}/{repo}/issues/$ISSUE/comments" --paginate \
    --jq 'map(select(.body | contains("🛠️ Implementation plan"))) | last | .id')
  gh api "repos/{owner}/{repo}/issues/comments/$PLAN_COMMENT_ID" --jq .body > /tmp/koine-plan-$ISSUE.md
fi
```

Carry `PLAN_SRC` forward (and `PLAN_COMMENT_ID` for a comment) — Step 6 PATCHes whichever source. For
the comment path the numeric REST `id` is what the PATCH endpoint edits; the GraphQL node id from
`gh issue view --json comments` will NOT work. If several plan comments exist, `last` takes the latest.
If neither body nor comment carries the marker, fall back to the latest comment with `- [ ]` lines;
still nothing → stop (nothing to execute). `references/github-mechanics.md` §2 has the full locator.

Parse `/tmp/koine-plan-$ISSUE.md` into tasks: each `### Task N: <name>` heading owns the `- [ ]`/`- [x]`
lines beneath it up to the next `### Task` (or end). When the plan came from the body, the file also
holds the template fields and collapsed brainstorm/spec above the plan — harmless, since you only ever
flip checkbox lines under a `### Task` heading. Note the **Global Constraints** preamble (version
floors, architecture invariants from *Architecture grain*, commit identity, build constraints) — these
bind every task.

## Step 3 — Pick the execution mode

You can't change this session's reasoning-effort setting, so "Extra vs Ultracode" is a choice of
**execution strategy**, sized to the plan. State which you picked and why, then proceed — don't ask.

- **Inline ("Extra")** — implement here, one task at a time, in this session. For **small, localized** plans: ≤3 tasks, one area (e.g. one module + its tests), no cross-layer churn.
- **Subagent-per-task ("Ultracode")** — invoke `superpowers:subagent-driven-development` and dispatch **one fresh-context subagent per task, sequentially** (tasks build on each other — the plan is a TDD chain, do NOT parallelize). For **broad/deep** plans: ~4+ tasks, OR multiple layers of the *Architecture grain*, OR a whole new subsystem/target, OR a long file-touch list. Also escalate the Step 7 review to `/code-review high` (or `ultra` for a very large change).

When it's a toss-up, prefer subagent-per-task — fresh context per task keeps quality high on the longer
plans. Either way **this skill stays the parent**: it owns the worktree, draft PR, per-task ticking,
review, and ready-flip; a subagent implements a task and reports back.

## Step 4 — Create the worktree

Use `superpowers:using-git-worktrees` for an isolated workspace branched off `main`. Name the branch
for the issue, e.g. `feat/<issue>-<short-slug>` (slug from the issue title). Do all work inside it. If a
worktree/branch for this issue already exists (resume case), reuse it.

## Step 5 — Open the draft PR

The PR should be visible as a **draft before** the implementation loop. A PR needs the branch ahead of
`main`, so land an empty scaffold commit, push, then open it.

**The PR title must end with `(#<issue>)`** — the issue title followed by the issue number, e.g.
`Surface the Rust emitter target in the IDE (#172)`. When the profile's *Integration style* is
squash-merge, GitHub appends the *PR* number to the squash commit's title — so titling with the *issue*
number makes the final `main` commit carry **both** (`… (#254) (#274)` — issue first, PR second). Drop
it and the merged commit records only the PR number, losing the link to the issue.

```bash
git <commit-identity> \
  commit --allow-empty -m "chore(#$ISSUE): scaffold draft PR for <title>"
git push -u origin <branch>
gh pr create --draft --base main --head <branch> \
  --title "<title> (#$ISSUE)" \
  --body "Implements #$ISSUE.

Closes #$ISSUE.

Executing the implementation plan task-by-task; the checklist below — and the plan on the issue — are
ticked as each task lands. Opened as a draft — will be marked ready after the final task and a
code-review pass.

### Plan
- [ ] Task 1: <name>
- [ ] Task 2: <name>
<one \`- [ ] Task N: <name>\` line per \`### Task N\` heading in the plan>"
```

Capture the PR URL/number. (If a PR for this branch already exists, reuse it.) The PR's `### Plan` list
is a task-level mirror (coarser than the issue's per-step boxes) for at-a-glance reviewer progress; Step
6 keeps it in lock-step. The issue plan stays the **canonical** source of truth — it's what a resumed
run reads.

## Step 6 — The implementation loop

For each task in plan order whose checkboxes aren't all `- [x]`:

1. **Implement it.** Follow the task's own TDD-first steps (write the failing test → run red →
   implement → run green). Honor the Global Constraints and the profile's *Architecture grain* (touch
   layers in order, don't break invariants). Use the per-task test filter the plan gives.
   - *Inline mode:* directly, with `superpowers:test-driven-development` discipline.
   - *Subagent-per-task mode:* dispatch a subagent with the task block, Global Constraints, and repo grain; have it implement to a green filtered test run and report a short diff summary.

2. **Verify green before you commit.** Run the task's test filter and confirm it passes — read the
   output, don't assume. A red bar means it isn't done; fix it or stop. Never commit over failing tests.

3. **Commit** with the project identity and the **commit message from the task's final step**:
   ```bash
   git <commit-identity> \
     commit -am "<message from the task's last - [ ] step>"
   ```

4. **Tick the task — on the issue plan AND the PR description.** Flip it in **both** so neither goes
   stale (issue canonical, PR list its mirror).
   - **Issue plan** — flip every `- [ ]` line of *this task only* to `- [x]` in `/tmp/koine-plan-$ISSUE.md`, then PATCH the source back (issue body, or comment on legacy issues):
     ```bash
     if [ "$PLAN_SRC" = body ]; then
       jq -Rs '{body: .}' /tmp/koine-plan-$ISSUE.md \
         | gh api "repos/{owner}/{repo}/issues/$ISSUE" -X PATCH --input -
     else
       jq -Rs '{body: .}' /tmp/koine-plan-$ISSUE.md \
         | gh api "repos/{owner}/{repo}/issues/comments/$PLAN_COMMENT_ID" -X PATCH --input -
     fi
     ```
   - **PR description** — flip *this task's* `- [ ] Task N: …` line in the PR's `### Plan` list to `- [x]`, then write it back:
     ```bash
     gh pr view $PR_NUMBER --json body --jq .body > /tmp/koine-pr-$ISSUE.md
     # Edit-tool per line: flip only this task's "- [ ] Task N:" line to "- [x] Task N:".
     gh pr edit $PR_NUMBER --body-file /tmp/koine-pr-$ISSUE.md
     ```
   In both files flip with the **Edit tool per line** — never a blunt `sed s/\[ \]/[x]/g`, which ticks
   *other* tasks too. See `references/github-mechanics.md`.

5. **Push** so the PR reflects the new commit: `git push`.

Continue until no task has an unchecked box. The issue's plan now reads all-`- [x]`.

## Step 7 — Code review

Run the **`code-review` skill** over the **whole feature branch** (`main...HEAD`, not just the last
commit) to catch what task-by-task TDD misses — correctness bugs, missed reuse, cross-task
inconsistencies. Match effort to Step 3: `/code-review` (default) for inline/small, `/code-review high`
(or `ultra` for a very large change) for subagent/broad. `--fix` is the fast path; otherwise read the
findings and fix them yourself.

This earns its keep most when green tests can't see the whole truth: a **code generator** whose target
toolchain is absent (conformance logs INCONCLUSIVE), a snapshot suite that captures output without
executing it — anything where "tests pass" proves the C# ran but not that the *emitted* artifact is
valid. Point the review at the generated output in those cases.

Triage with `superpowers:receiving-code-review` rigor — implement the real findings, push back (in your
report) on wrong ones rather than performatively complying. Then commit and push:

```bash
git <commit-identity> \
  commit -am "fix: address code-review findings"
git push
```

If the review is clean, say so and skip the fix commit.

## Step 8 — Sync with `main` and resolve conflicts

`main` moves while this PR sits in draft. Mark it ready against a stale base and it merges with
conflicts — or won't merge. So before the final gate, pull the latest `main` into the branch, resolve
collisions, *then* re-verify on the merged tree.

When the profile's *Integration style* is squash-merge, the branch's history is collapsed at merge time
— which makes a **merge** of `main` into the branch the right tool, not a rebase: resolves each conflict
once, no force-push, and the throwaway merge commit disappears when the PR squashes. (For a rebase- or
merge-commit repo, follow the profile's *Integration style*.)

```bash
git fetch origin main
git <commit-identity> merge origin/main
```

- **"Already up to date" / clean merge** → go to Step 9.
- **Conflicts** → resolve favoring *both sides' intent* — a parallel PR's work is as real as yours. Most are mechanical; the profile's *Conflict hot-spots* table (and `references/github-mechanics.md` §7) lists them by file. Two rules prevent silent damage:
  - **Regenerate derived files; don't hand-merge them.** Snapshots and lockfiles must not be merged line-by-line — take one side to clear the conflict, then regenerate (re-run affected tests and accept the fresh snapshot; reinstall deps to rebuild the lockfile).
  - **A textual merge is not a semantic merge.** Don't trust it until it builds and passes — `main` may have renamed a symbol your branch still calls. Step 9 is the proof.

Finish the merge with the project identity once it builds, then push:

```bash
git add -A
git <commit-identity> commit --no-edit   # completes the merge
git push
```

If a conflict is genuinely ambiguous — both sides rewrote the same logic — stop and surface it with both
sides shown rather than guessing. Note the race: if another PR merges *after* you sync but before this
lands, you may have to re-run this step — it's cheap, and a re-sync right before merge is the surest path
to a clean integration.

---

## Step 9 — Verify, format, then mark ready

Marking a PR ready says "this is done." Earn it: build and tests green **on the just-merged tree**, and
**the same gates CI runs** clean. The exact commands are the profile's *Build & test* and *CI gates* —
run those, not hardcoded ones.

**1. Build + tests.** Run the profile's *Build* then *Full test*. If the profile flags a prerequisite
that can't be satisfied locally (a workload, a toolchain), run the plan's per-task test filters plus the
build instead, and say so in the report.

**2. Format/lint gate (CI enforces it — so must you).** The profile's *CI gates* include a format/lint
**verify** command that **fails the build** on any diff. New code routinely trips style/analyzer rules
that compile fine but the gate rejects. So before the ready-flip, run the profile's format/lint **apply**
command (scoped to the files/projects you touched), then its whole-repo **verify** (must exit clean — that's
the CI check). Heed the profile's caveats — some analyzer diagnostics can't be auto-fixed. Commit:

```bash
git <commit-identity> \
  commit -am "style: satisfy the format/lint gate" && git push
```

**3. Mark ready** — only once build, tests, and the format/lint verify gate are all green:

```bash
gh pr ready <pr-number>
```

## Step 10 — Report

Short and concrete:
- PR URL and its now-**ready** status; the issue it closes.
- One line per task shipped (and confirmation every checkbox is ticked).
- Code-review outcome — what you fixed, what you dismissed and why.
- Merge sync — clean, or which conflicts you resolved (and how).
- Anything assumed, deferred, or unverifiable (e.g. full suite skipped for a missing local prerequisite the profile flags). Keep detail in the PR/issue; the report points there.

Then **close the loop**: the PR is ready but not landed — a human owns the merge decision. Point the
user at **`/merge-pr #<pr>`** (waits for CI, applies corrections to keep it mergeable, squash-merges,
files follow-ups, tears down the branch/worktree).

---

## Notes on quality

- **The checkbox is a promise.** Ticking `- [x]` on the live issue says that task is done and tested. Only ever tick after a real green test run + commit — a checked box over a red bar lies.
- **One commit per task, message from the plan** (its final step) — verbatim, so git history mirrors the plan and the issue.
- **Stay resumable.** Everything keys off the issue's checkbox state and the existing branch/PR, so a re-run picks up where it left off.
- **Don't widen the blast radius.** Implement the plan, not your own ideas. Record adjacent work under a `## Follow-ups` heading in the **PR description** (and call it out in the report) — that's where `/merge-pr` harvests deferred work and files it as tracked issues; noting it only in the ephemeral report would lose it. Don't smuggle the work into this PR.
