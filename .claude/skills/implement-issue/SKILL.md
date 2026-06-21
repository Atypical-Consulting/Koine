---
name: implement-issue
description: >-
  Do the actual coding for an existing GitHub issue and turn it into a finished pull request — the
  "go build it" counterpart to `create-issue` for the Koine project. Use this whenever an issue
  already carries an implementation plan (a `**🛠️ Implementation plan**` comment with a `### Task N`
  / `- [ ]` checklist) and the user wants it BUILT: it spins up a git worktree, opens a DRAFT pull
  request, then loops task-by-task — implement → commit → tick that task's checkbox on the live issue
  — until every box is checked, then runs the `code-review` skill, applies the fixes, merges the latest
  `main` into the branch and resolves any conflicts so the PR stays mergeable, runs the formatter, and
  flips the PR from draft to ready. ALWAYS reach for it when the user wants to implement, build, code,
  execute, ship, finish, knock out, work through, rebase/sync a branch, fix a PR that conflicts with
  `main`, resume, or "pick up" a
  GitHub issue or its plan — e.g. "implement issue 47", "knock out the tasks on issue 71", "execute
  the plan on this issue and mark the PR ready", "build the feature from issue #X and open a PR", or a
  bare issue link with "go build it." Does NOT apply to CREATING, filing, or planning a new issue
  (that's `create-issue`), to editing a plan, or to merely commenting on / closing / listing issues,
  or to ad-hoc coding with no issue plan to drive it.
---

# Implement a Koine issue from its plan comment

## What this does and why

`create-issue` ends every issue with a `**🛠️ Implementation plan**` comment: a checklist of
`### Task N` blocks whose every step is a Markdown checkbox (`- [ ]`), with the **last step of each
task being its commit message**. That comment is a contract an executor can run cold. This skill is
that executor.

It turns the plan into a real pull request the way a careful engineer would: isolated worktree,
draft PR opened up front so progress is visible, one commit per task, and — the part that makes the
issue itself a live progress board — **each task's checkboxes get ticked on the issue as the work
lands**. When the last box is checked, it runs a code review, fixes what surfaces, and marks the PR
ready.

The plans themselves prescribe their executor (`> REQUIRED SUB-SKILL: superpowers:subagent-driven-development …`),
so this skill leans on the **superpowers** skills to do the actual implementing — it owns the
GitHub/worktree/PR bookkeeping around them.

## Autonomy contract (important)

The user wants this to run **hands-off** once started — they watch, they don't babysit. Whenever a
sub-skill (worktree, executing-plans, code review) would pause for a question or a sign-off gate,
**pick the most reasonable default, state the assumption, and keep going.** Only stop for a genuine
blocker you cannot reasonably work past:

- `gh` is not authenticated, or you lack push access to the repo.
- No `🛠️ Implementation plan` comment exists on the issue (nothing to execute).
- A task's tests cannot be made green after a real, honest effort — don't fake green, don't
  `git commit` over a red bar, and don't tick a checkbox for work that doesn't pass. Stop and report
  the wall you hit with the failing output.
- A merge conflict you cannot resolve with confidence — both `main` and your branch rewrote the *same
  logic*, and choosing a side would silently drop a sibling PR's work. The mechanical conflicts
  (version, `CHANGELOG`, snapshots, lockfiles) have known-correct resolutions (Step 8) — handle those
  yourself; stop only for the genuinely ambiguous ones, and show both sides.

Never mark a checkbox, commit, or flip the PR to ready on the strength of an assumption. Those three
acts are claims that work is *done* — back them with evidence (tests run, output seen), per
`superpowers:verification-before-completion`. A resolved merge is the same kind of claim: re-build and
re-test on the merged tree before you trust it — a clean *textual* merge is not a clean *semantic* one.

## Checklist

Create a task (todo) for each item and work them in order. Steps 6 is the loop — one pass per task
in the plan.

1. **Preconditions** — `gh` works, you're in the Koine repo, resolve the issue number.
2. **Read the plan** — fetch the `🛠️ Implementation plan` comment; save its body and **comment id**.
3. **Pick the execution mode** — assess complexity → *Inline (Extra)* or *Subagent-per-task (Ultracode)*.
4. **Create the worktree** — via `superpowers:using-git-worktrees`; branch off `main`.
5. **Open the draft PR** — empty scaffold commit, push, `gh pr create --draft` linking the issue.
6. **Loop until every task is checked** — implement the next unchecked task → verify green → commit
   → tick that task's checkboxes on the issue → push.
7. **Code review** — run the `code-review` skill, apply + commit the fixes, push.
8. **Sync with `main`** — merge the latest `origin/main` into the branch and resolve any conflicts so
   the PR merges clean (Koine hot-spots: version, `CHANGELOG`, snapshots, lockfiles — see reference).
9. **Verify, format, then mark ready** — build/tests green on the merged tree AND
   `dotnet format --verify-no-changes` clean (commit any fixes), then `gh pr ready`.
10. **Report** — PR URL, what shipped, anything you assumed or deferred.

Resume-safe: re-running mid-flight is fine. A task is "done" when **all** its step checkboxes read
`- [x]`; start at the first task that isn't. Reuse an existing worktree/branch/PR for the issue
rather than making a second one (see `references/github-mechanics.md`).

---

## Step 1 — Preconditions

```bash
gh api user --jq .login                       # prints a login, or 401 → not authed
gh repo view --json nameWithOwner --jq .nameWithOwner   # confirm Atypical-Consulting/Koine
```

If auth fails, stop and tell the user to run `! gh auth login -h github.com` in the prompt (the `!`
prefix runs it in this session so the token lands in your environment), then re-check.

Resolve the **issue number** from the user's request — they may pass a number (`21`), an issue URL,
or a link to the plan comment itself (`…/issues/21#issuecomment-12345`). The comment-locating
snippets in `references/github-mechanics.md` handle all three.

## Step 2 — Read the plan

Fetch the implementation-plan comment via the **REST** API (its numeric `id` is what you later PATCH
to tick boxes — the GraphQL node id from `gh issue view --json comments` will NOT work):

```bash
ISSUE=21
gh api "repos/{owner}/{repo}/issues/$ISSUE/comments" --paginate \
  --jq 'map(select(.body | contains("🛠️ Implementation plan"))) | last | .id'   # → PLAN_COMMENT_ID
gh api "repos/{owner}/{repo}/issues/comments/$PLAN_COMMENT_ID" --jq .body > /tmp/koine-plan-$ISSUE.md
```

If several plan comments exist (the issue was re-planned), take the **latest** one — that's `last`
above. If none match the marker, fall back to the latest comment that contains `- [ ]` checkbox
lines; if there are still none, stop (Autonomy contract — nothing to execute).

Read `/tmp/koine-plan-$ISSUE.md` and parse it into tasks: each `### Task N: <name>` heading owns the
`- [ ]`/`- [x]` lines beneath it up to the next `### Task` (or end). Note the **Global Constraints**
preamble — version floors, the `Ast/`-stays-target-agnostic invariant, the commit identity, "no
`TreatWarningsAsErrors`" — these bind every task.

## Step 3 — Pick the execution mode

You can't change this session's reasoning-effort setting, so "Extra vs Ultracode" is a choice of
**execution strategy**, sized to the plan. State which you picked and why, then proceed — don't ask.

- **Inline ("Extra")** — implement here, one task at a time, in this session. Use for **small,
  localized** plans: roughly ≤3 tasks, changes confined to one area (e.g. one emitter file + its
  tests), no new grammar and no cross-layer churn.

- **Subagent-per-task ("Ultracode")** — invoke `superpowers:subagent-driven-development` and dispatch
  **one fresh-context subagent per task**, sequentially (tasks build on each other — the plan is a
  TDD chain, so do NOT parallelize them). Use for **broad or deep** plans: ~4+ tasks, OR touching
  multiple pipeline layers (grammar → builder visitor → semantic model → validators → emitter),
  OR introducing a new emitter target / language construct, OR a long file-touch list. In this mode
  also escalate the Step 7 review to `/code-review high` (or `ultra` for a very large change).

When it's a toss-up, prefer subagent-per-task — fresh context per task keeps quality high on the
longer plans where it matters. Either way, **this skill stays the parent**: it owns the worktree,
the draft PR, the per-task checkbox ticking, the review, and the ready-flip. A subagent implements a
task and reports back; the parent does the GitHub bookkeeping.

## Step 4 — Create the worktree

Use `superpowers:using-git-worktrees` to get an isolated workspace branched off `main`. Name the
branch for the issue so the PR and the worktree are obviously connected, e.g.
`feat/<issue>-<short-slug>` (derive the slug from the issue title). Do all subsequent work inside
that worktree. If a worktree/branch for this issue already exists (resume case), reuse it.

## Step 5 — Open the draft PR

The user wants the PR visible as a **draft before** the implementation loop, so create it up front.
A PR needs the branch to be ahead of `main`, so land an empty scaffold commit, push, then open it:

```bash
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit --allow-empty -m "chore(#$ISSUE): scaffold draft PR for <title>"
git push -u origin <branch>
gh pr create --draft --base main --head <branch> \
  --title "<title>" \
  --body "Implements #$ISSUE.

Closes #$ISSUE.

Executing the implementation-plan comment task-by-task; checkboxes are ticked on the issue as each
task lands. Opened as a draft — will be marked ready after the final task and a code-review pass."
```

Capture the PR URL/number. (If a PR for this branch already exists, skip creation and reuse it.)

## Step 6 — The implementation loop

For each task in plan order whose checkboxes aren't all `- [x]` yet:

1. **Implement it.** Follow the task's own steps exactly — they're written TDD-first (write the
   failing test → run it red → implement → run it green). Honor the Global Constraints and the
   project's layering (touch grammar → builder → `Ast/` → validators → emitter in order; **never
   leak a C# concept into `Ast/`**). Use the per-task `--filter` the plan gives so each task's tests
   run fast.
   - *Inline mode:* do this directly, using `superpowers:test-driven-development` discipline.
   - *Subagent-per-task mode:* dispatch a subagent with the task block, the Global Constraints, and
     the repo grain; have it implement to a green filtered test run and report a short diff summary.

2. **Verify green before you commit.** Run the task's test filter and confirm it actually passes —
   read the output, don't assume. A red bar means the task isn't done; fix it or stop (Autonomy
   contract). Never commit over failing tests.

3. **Commit** with the project identity and the **commit message from the task's final step**:
   ```bash
   git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
     commit -am "<message from the task's last - [ ] step>"
   ```

4. **Tick the task's checkboxes on the issue.** Flip every `- [ ]` line of *this task* (only this
   task) to `- [x]` in `/tmp/koine-plan-$ISSUE.md`, then PATCH the comment body back. Tick at task
   granularity — the task is committed and verified, so the whole block is genuinely done:
   ```bash
   jq -Rs '{body: .}' /tmp/koine-plan-$ISSUE.md \
     | gh api "repos/{owner}/{repo}/issues/comments/$PLAN_COMMENT_ID" -X PATCH --input -
   ```
   See `references/github-mechanics.md` for a robust flip (Edit-tool per line; never a blunt
   `sed s/\[ \]/[x]/g` that would tick *other* tasks too).

5. **Push** so the PR reflects the new commit: `git push`.

Continue until no task has an unchecked box. The issue's plan comment now reads all-`- [x]`.

## Step 7 — Code review

Run the **`code-review` skill** over the **whole feature branch** (`main...HEAD`, not just the last
commit) to catch what task-by-task TDD can miss — correctness bugs, missed reuse, cross-task
inconsistencies. Match the effort to the mode chosen in Step 3: `/code-review` (default) for an
inline/small change, `/code-review high` (or `ultra` for a very large one) for a subagent/broad
change. Letting it apply fixes with `--fix` is the fast path; otherwise read the findings and fix
them yourself.

This step earns its keep most when the green tests can't see the whole truth: a **code generator**
whose target toolchain is absent (so conformance logs INCONCLUSIVE), a snapshot suite that captures
output without executing it, anything where "tests pass" proves the C# ran but not that the *emitted*
artifact is valid. Point the review explicitly at the generated output in those cases — a passing
build is necessary, not sufficient.

Triage the findings with `superpowers:receiving-code-review` rigor — implement the real ones, push
back (in your report) on any that are wrong rather than performatively complying. Then commit the
fixes and push:

```bash
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit -am "fix: address code-review findings"
git push
```

If the review is clean, say so and skip the fix commit.

## Step 8 — Sync with `main` and resolve conflicts

Several issues are usually in flight at once, and `main` moves while this PR sits in draft. Mark it
ready against a stale base and it merges with conflicts — or won't merge at all. So before the final
gate, pull the latest `main` into the branch, resolve anything that collides, *then* re-verify on the
merged tree.

The project **squash-merges** PRs (see the `(#NNN)` commits on `main`), so the branch's own history is
collapsed at merge time — which makes a **merge** of `main` into the branch the right tool here, not a
rebase: it resolves each conflict once, needs no force-push, and the throwaway merge commit disappears
when the PR squashes.

```bash
git fetch origin main
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" merge origin/main
```

- **"Already up to date" / clean merge** → nothing collided; go to Step 9.
- **Conflicts** → resolve them favoring *both sides' intent* — a parallel PR's work is as real as yours.
  Most Koine conflicts are mechanical with a known-correct fix; `references/github-mechanics.md` §7 has
  the hot-spot table (`Directory.Build.props` version, `CHANGELOG.md`, `README`/`USER-STORIES`, Verify
  snapshots, `package-lock.json`, emitter partials, test files). Two rules keep you from silent damage:
  - **Regenerate derived files; don't hand-merge them.** Verify `*.verified.txt` snapshots and
    `package-lock.json` must not be merged line-by-line — take one side to clear the conflict, then
    regenerate (re-run the affected tests and accept the fresh snapshot; `npm install` to rebuild the
    lockfile). A hand-stitched snapshot or lockfile will simply be wrong.
  - **A textual merge is not a semantic merge.** Don't trust a resolved merge until it builds and
    passes — `main` may have renamed a symbol your branch still calls. Step 9 is the proof.

Finish the merge with the project identity once it builds, then push:

```bash
git add -A
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit --no-edit   # completes the merge
git push
```

If a conflict is genuinely ambiguous — both sides rewrote the same logic and you can't tell which wins —
stop and surface it with both sides shown (Autonomy contract) rather than guessing and dropping work.
And note the race: if another PR merges *after* you sync but before this one lands, you may have to run
this step again — it's cheap, and a re-sync right before merge is the surest way to a clean integration.

---

## Step 9 — Verify, format, then mark ready

Marking a PR ready says "this is done." Earn it: build and tests green **on the just-merged tree**, and
**the same gates CI runs** clean — a PR that goes red in CI the moment it's opened wasn't ready.

**1. Build + tests.**

```bash
dotnet build
dotnet test                 # full suite needs the wasm workloads (see CLAUDE.md); if absent,
                            # run the plan's test filters + `dotnet build` and say so in the report
```

**2. Format gate (CI enforces it — so must you).** CI runs
`dotnet format Koine.slnx --verify-no-changes --no-restore` and **fails the build** on any diff. New
code routinely trips analyzer style rules (e.g. `IDE0011` missing braces) that compile fine but the
formatter rejects. So before the ready-flip, run the formatter in **apply** mode and commit what it
changes:

```bash
dotnet format Koine.slnx                                  # applies whitespace + style + analyzer fixes
dotnet format Koine.slnx --verify-no-changes --no-restore # must now exit 0 — this is the CI check
```

Scope the apply to the projects you touched (e.g. `dotnet format src/Koine.Compiler/Koine.Compiler.csproj`)
so you don't sweep unrelated files; then run the whole-solution `--verify-no-changes` to match CI
exactly. Some analyzer diagnostics — notably `IDE1006` naming (a snake_case test method that must
start uppercase) — **can't be auto-fixed** (`dotnet format` prints "doesn't support Fix All"); rename
those by hand. Commit the result:

```bash
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit -am "style: satisfy dotnet format" && git push
```

**3. Mark ready** — only once build, tests, and `--verify-no-changes` are all green:

```bash
gh pr ready <pr-number>
```

## Step 10 — Report

Short and concrete:
- PR URL and its now-**ready** status; the issue it closes.
- One line per task shipped (and confirmation every checkbox is ticked).
- Code-review outcome — what you fixed, what you consciously dismissed and why.
- Merge sync — whether `main` merged clean or which conflicts you resolved (and how).
- Anything you assumed, deferred, or couldn't verify (e.g. full suite skipped for missing wasm
  workloads). Keep the detail in the PR/issue; the report just points there.

---

## Notes on quality

- **The checkbox is a promise.** Ticking `- [x]` on the live issue tells everyone that task is done
  and tested. Only ever tick after a real green test run + commit. A checked box over a red bar is
  worse than an unchecked one — it lies.
- **One commit per task, message from the plan.** The plan already chose each task's commit message
  (its final step). Use it verbatim so the git history mirrors the plan and the issue.
- **Stay resumable.** Everything keys off the issue's checkbox state and the existing branch/PR, so a
  re-run picks up where it left off instead of starting over or double-committing.
- **Respect the architecture invariant.** Koine keeps `Ast/` target-agnostic and the pipeline
  strictly layered. Implement tasks along that grain; a plan that says "add an emitter" means a new
  `Emit/<Target>/`, never target concepts pushed into the shared model.
- **Draft until proven.** The PR stays a draft through the whole loop and review; it only goes ready
  after the build/tests are green **and CI's own gates pass locally** — run `dotnet format
  --verify-no-changes` (the formatter CI enforces) and fix what it flags. Reviewers should never see a
  "ready" PR that doesn't compile, or that goes red in CI the instant it opens.
- **Don't widen the blast radius.** Implement the plan, not your own ideas. If you spot adjacent work
  worth doing, note it in the report (or as a follow-up issue via `create-issue`) — don't smuggle it
  into this PR.
- **Merge clean, or don't merge.** Issues run in parallel here, so `main` almost always moves under a
  draft PR. A ready PR that conflicts with `main` (or goes red once `main` advances) stalls everyone.
  Merge the latest `main` into the branch right before the ready-flip and resolve the collisions —
  *regenerate* derived files (snapshots, lockfiles) rather than hand-merging them, take the **higher**
  version, **union** additive files (docs, tests, `CHANGELOG`), and re-verify. The mechanical 90% have
  known-correct fixes (see `references/github-mechanics.md` §7); only the rare both-sides-rewrote-the-
  same-logic case deserves a human.
