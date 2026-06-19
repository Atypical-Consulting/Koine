---
name: create-issue
description: >-
  Create a fully-seeded GitHub issue for the Koine project — and do NOT settle for a bare
  `gh issue create`. This files a template-compliant issue AND auto-adds a brainstorm → spec →
  implementation-plan comment trail (via the superpowers skills), turning a one-line idea into
  something a contributor can pick up cold. ALWAYS reach for this whenever the user wants to open,
  file, add, raise, create, log, or track a NEW issue / feature request / idea / ticket / backlog
  item for this repo — including loose phrasings like "track this idea", "add an issue for X",
  "log a feature", "make a ticket", "raise an issue", or "capture this for later", and batches of
  several ideas at once. Use it even though you could obviously create the issue yourself with `gh`:
  the whole point is the seeded brainstorm/spec/plan trail, so filing a plain issue instead is the
  wrong move. Does NOT apply to managing EXISTING issues (commenting on, closing, or listing them),
  or to standalone brainstorming/planning when there's no issue to file.
---

# Create a Koine GitHub issue (template-compliant, auto-seeded)

## What this does and why

A good idea deserves more than a one-line ticket. This skill turns a raw idea into an issue that
a future contributor (or future you) can pick up cold: a body that obeys the project's own issue
template, followed by three comments that walk the idea from fuzzy to actionable —

1. **Brainstorm** — frames the problem, lays out 2-3 approaches with trade-offs, and recommends one.
2. **Spec** — the formal design doc for the chosen approach.
3. **Implementation plan** — bite-sized, testable tasks an engineer can execute.

The brainstorm and plan are produced with the **superpowers** skills (`superpowers:brainstorming`
and `superpowers:writing-plans`) so the artifacts match how this project actually plans work.

## Autonomy contract (important)

The user wants this to run **hands-off**. The superpowers skills are normally interactive — they
ask questions one at a time and stop at approval gates. Here you run them in **one-shot autonomous
mode**: never block waiting for the user. Whenever a sub-skill would ask a clarifying question or
wait for sign-off, instead **pick the most reasonable default**, state the assumption inline in the
artifact (e.g. a short "Assumptions" note), and keep going. Only stop to ask the user if something
is a genuine blocker you cannot reasonably assume your way past (e.g. `gh` is not authenticated, or
the idea is too vague to even name). Make decisions; don't hold up the line.

## Checklist

Create a task for each item and complete them in order. For a batch of ideas, run steps 2-6 once
per idea.

1. **Preconditions** — confirm `gh` works and you're in the repo.
2. **Capture the idea(s)** — from the user's message; don't interrogate.
3. **Build a template-compliant body** — read the live issue template and fill it.
4. **Create the issue** — `gh issue create`, capture the number/URL.
5. **Comment 1 — Brainstorm**, then **Comment 2 — Spec** (both via `superpowers:brainstorming`).
6. **Comment 3 — Implementation plan** (via `superpowers:writing-plans`) — keep its `- [ ]`
   checkbox task-list format so the plan is trackable on the issue.
7. **Report** — list each issue with its URL.

---

## Step 1 — Preconditions

```bash
gh api user --jq .login      # must print a login; if 401, the token is invalid
```

If this fails with an auth error, stop and tell the user to run `! gh auth login -h github.com`
in the prompt (the `!` prefix runs it in this session so the token lands in your environment).
Re-check before continuing — don't draft issues you can't file.

Confirm the working directory is the Koine repo (the `gh` commands target the repo's `origin`).

## Step 2 — Capture the idea(s)

Pull the idea(s) straight from the user's request. They may give one ("add Rust generation") or
several at once ("add python gen, add php gen, build an IDE"). Do **not** open a Q&A — infer scope
from the prompt, the README, `USER-STORIES.md`, and the codebase. If the user named several ideas,
treat each as its own issue and loop.

For each idea, settle on a crisp **title** (imperative, e.g. "Add Python emitter target") before
writing anything.

## Step 3 — Build a template-compliant body

The body MUST match the project's own issue form — never invent your own structure. Read the live
template so this stays correct even if the template changes:

```bash
ls .github/ISSUE_TEMPLATE/
cat .github/ISSUE_TEMPLATE/feature_request.yml
```

`gh issue create` does not apply a form template automatically, so you reconstruct it as markdown:

- Use the **feature_request** template for ideas/enhancements (the common case). Use `bug_report`
  only if the user is clearly filing a defect.
- For each `textarea`/`input` field in the YAML, emit a `## <label>` heading and fill it from the
  idea. Honor `validations.required` — every required field must have real content.
- For each `dropdown`, pick the single option that best fits and write it under its heading. The
  feature_request `Area` options are: *Language / grammar*, *Semantic model / validation*,
  *C# emitter*, *TypeScript emitter*, *New emitter target*, *CLI / LSP / tooling*, *Docs / website*.
- Apply the template's declared `labels:` (feature_request declares `enhancement`).

Write the body to a temp file and create with `--body-file` (clean multi-line handling). See
`references/issue-template.md` for a worked feature_request example and the exact field→heading
mapping.

## Step 4 — Create the issue

```bash
gh issue create \
  --title "Add Python emitter target" \
  --label enhancement \
  --body-file /tmp/koine-issue-<slug>.md
```

Capture the printed URL and issue number — you need the number for the comments. If a label in the
template doesn't exist on the remote, create the issue without it rather than failing, and mention
it in the final report.

## Step 5 — Comments 1 & 2: Brainstorm, then Spec

Invoke `superpowers:brainstorming` to load its current methodology, then apply it **autonomously**
(per the Autonomy contract — no questions, pick the recommended option, note assumptions). The
brainstorming skill explores context, weighs approaches, and writes a design doc/spec; you split its
output into two comments so the trail reads brainstorm → spec.

**Comment 1 — Brainstorm.** A focused exploration, not a wall of text:
- *Problem / context* — what need this serves, who the persona is, what exists today (cite README /
  `USER-STORIES.md` / relevant code where it helps).
- *Approaches* — 2-3 options, each with honest trade-offs.
- *Recommendation* — pick one and say why. This decision drives the spec and plan.

**Comment 2 — Spec.** The formal design for the recommended approach, following the structure the
brainstorming skill uses for its design doc (goal, scope/non-goals, the `.koi` surface or behavior,
what it emits, key types/files touched, validation rules, edge cases, an Assumptions note for
anything you defaulted). Keep it target-agnostic where the architecture demands it.

Post each:

```bash
gh issue comment <number> --body-file /tmp/koine-c1-brainstorm-<slug>.md
gh issue comment <number> --body-file /tmp/koine-c2-spec-<slug>.md
```

Prefix each comment with a bold marker so the trail is scannable: `**🧠 Brainstorm**` and
`**📋 Spec**`.

## Step 6 — Comment 3: Implementation plan

Invoke `superpowers:writing-plans` to load its current guidance, then apply it autonomously to the
spec from Step 5, with the project's grain in mind (grammar → builder visitor → semantic model →
validators → emitter → tests; never leak a C# concept into `Ast/`). Keep tasks bite-sized and each
one independently testable.

**Preserve the plan's checkbox task-list format — that's the whole point of this comment.**
`writing-plans` emits a plan whose every actionable step is a Markdown checkbox (`- [ ]`), and
GitHub renders those as *live, tickable checkboxes* on the issue. A contributor — or an agentic
worker running `subagent-driven-development` — checks off real progress against the plan as they go.
A plan rewritten as prose bullets reads almost the same but throws that tracking away; it becomes a
wall of text nobody can mark up. So when you compose the comment, the checkboxes must survive: never
collapse steps into `- **Files:**` / `- **Test:**` prose paragraphs.

Concretely, the posted plan MUST carry all three of these (issue #21's plan is the reference shape):

1. The writing-plans **header note, verbatim**, so an executor knows how to run it:
   `> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.`
2. A short **Goal / Architecture / Tech Stack** preamble and a **Global Constraints** list (version
   floors, the `Ast/`-stays-target-agnostic invariant, the commit-identity line, "no
   `TreatWarningsAsErrors`") — exact values copied from the spec.
3. One `### Task N: <name>` per task, each with **Files** + **Interfaces** lines, then **every step
   as its own `- [ ]` checkbox** (write the failing test → run it red → implement → run it green →
   commit). The final step of each task is a `- [ ]` checkbox with the commit message.

Shape (abbreviated — keep the checkboxes, never flatten them into prose):

```markdown
### Task 1: Runtime module + skeleton emitter wired into the CLI

**Files:** create `Emit/Python/PyRuntime.cs`, `PythonEmitter.cs`; modify `src/Koine.Cli/Program.cs`; test `…/PythonRuntimeTests.cs`.

**Interfaces:** `PythonEmitter : IEmitter`, `sealed partial`, `TargetName => "python"`, `Emit(KoineModel)` returning the root files.

- [ ] **Step 1:** Write the failing test in `PythonRuntimeTests.cs` — assert `TargetName == "python"` and `Emit` contains `koine_runtime.py`.
- [ ] **Step 2:** `dotnet test --filter "FullyQualifiedName~PythonRuntimeTests"` → FAIL (types not found).
- [ ] **Step 3:** Implement `PyRuntime.cs` — fixed-string `Source` modeled on `TsRuntime.cs`, stdlib-only.
- [ ] **Step 4:** `dotnet test --filter "FullyQualifiedName~PythonRuntimeTests"` → PASS.
- [ ] **Step 5:** Commit: `feat(emit-py): Python backend skeleton + runtime`.
```

Write the plan to a temp file, then **verify it actually contains checkboxes before posting** — zero
`- [ ]` lines means you drifted into prose and must reformat into the task/checkbox structure above:

```bash
grep -c '^- \[ \]' /tmp/koine-c3-plan-<slug>.md   # must be > 0; expect one per actionable step
gh issue comment <number> --body-file /tmp/koine-c3-plan-<slug>.md
```

Prefix with `**🛠️ Implementation plan**`. Dispatching `writing-plans` to a **subagent** preserves
the format most reliably — the plan comes back as one clean artifact instead of competing with this
skill's own framing mid-stream (issue #21, which kept the checkboxes, was generated that way).
Inline generation is fine too, as long as the `grep` check above passes before you post.

## Step 7 — Report

List every issue created with its title and URL, and flag anything you assumed or skipped (e.g. a
missing label). Keep it short — the issues themselves carry the detail.

---

## Notes on quality

- **Stay template-driven.** Read `.github/ISSUE_TEMPLATE/*.yml` each run; don't hardcode fields that
  could drift. The body's job is to satisfy the template the maintainers chose.
- **Ground the content in the repo.** Generic feature-request boilerplate is worthless; reference
  real files, the layered pipeline, and the roadmap so the issue reads like it belongs here.
- **Respect the architecture invariant.** Koine keeps `Ast/` target-agnostic. Specs and plans for
  new emitters must add an emitter under `Emit/<Target>/` and must not push target concepts into the
  shared model.
- **The plan is a checklist, not an essay.** The implementation-plan comment exists so someone can
  execute it task-by-task and tick off progress. Preserve `writing-plans`' `- [ ]` checkboxes all the
  way into the posted comment (see Step 6); a plan flattened into prose bullets has lost its job.
- **One commit, many issues.** When seeding a batch, create all issues and all comments, then give
  one consolidated report.
