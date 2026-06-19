---
name: implement-issue
description: >-
  Execute a GitHub issue's implementation-plan comment end-to-end for the Koine project — the
  consumer side of `create-issue`. Reads the issue's `**🛠️ Implementation plan**` comment (the
  `### Task N` / `- [ ]` checklist), picks an execution mode by plan complexity, spins up a git
  worktree, opens a DRAFT pull request, then loops task-by-task: implement → commit → tick that
  task's checkbox on the live issue, until every task is checked. Finishes by running the
  `code-review` skill, committing the fixes, and flipping the PR from draft to ready. ALWAYS reach
  for this whenever the user wants to implement, build, execute, ship, work, do, knock out, or
  "start coding" a GitHub issue or its plan — including phrasings like "implement issue 21", "build
  the feature from issue #X", "execute the plan on this issue", "ship issue X", "do the
  implementation plan", "work issue X task-by-task", "pick up issue X", or "turn issue X into a PR".
  Does NOT apply to CREATING issues (use `create-issue` for that), to merely commenting on / closing
  / listing issues, or to ad-hoc coding with no issue plan to drive it.
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

Never mark a checkbox, commit, or flip the PR to ready on the strength of an assumption. Those three
acts are claims that work is *done* — back them with evidence (tests run, output seen), per
`superpowers:verification-before-completion`.

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
8. **Verify, then mark ready** — confirm the build/tests are green, then `gh pr ready`.
9. **Report** — PR URL, what shipped, anything you assumed or deferred.

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

## Step 8 — Verify, then mark ready

Marking a PR ready says "this is done." Earn it: build and run the relevant tests green first.

```bash
dotnet build
dotnet test                 # full suite needs the wasm workloads (see CLAUDE.md); if absent,
                            # run the plan's test filters + `dotnet build` and say so in the report
```

Only once it's green:

```bash
gh pr ready <pr-number>
```

## Step 9 — Report

Short and concrete:
- PR URL and its now-**ready** status; the issue it closes.
- One line per task shipped (and confirmation every checkbox is ticked).
- Code-review outcome — what you fixed, what you consciously dismissed and why.
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
  after the build/tests are green. Reviewers should never see a "ready" PR that doesn't compile.
- **Don't widen the blast radius.** Implement the plan, not your own ideas. If you spot adjacent work
  worth doing, note it in the report (or as a follow-up issue via `create-issue`) — don't smuggle it
  into this PR.
