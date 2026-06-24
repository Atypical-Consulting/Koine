---
name: create-issue
description: >-
  Create a fully-seeded GitHub issue for the Koine project — and do NOT settle for a bare
  `gh issue create`. This files a template-compliant issue whose DESCRIPTION carries a brainstorm →
  spec → implementation-plan trail (via the superpowers skills), turning a one-line idea into
  something a contributor can pick up cold. ALWAYS reach for this whenever the user wants to open,
  file, add, raise, create, log, or track a NEW issue / feature request / idea / ticket / backlog
  item for this repo — including loose phrasings like "track this idea", "add an issue for X",
  "log a feature", "make a ticket", "raise an issue", or "capture this for later", and batches of
  several ideas at once. Use it even though you could obviously create the issue yourself with `gh`:
  the whole point is the seeded brainstorm/spec/plan, so filing a plain issue instead is the wrong
  move. Does NOT apply to managing EXISTING issues (commenting on, closing, or listing them), or to
  standalone brainstorming/planning when there's no issue to file.
---

# Create a Koine GitHub issue (template-compliant, auto-seeded)

## What this does and why

A good idea deserves more than a one-line ticket. This skill turns a raw idea into an issue that
a future contributor (or future you) can pick up cold: a single self-contained **description** that
obeys the project's own issue template and then walks the idea from fuzzy to actionable —

1. **Brainstorm** — frames the problem, lays out 2-3 approaches with trade-offs, and recommends one.
2. **Spec** — the formal design doc for the chosen approach.
3. **Implementation plan** — bite-sized, testable tasks an engineer can execute.

The brainstorm and plan are produced with the **superpowers** skills (`superpowers:brainstorming`
and `superpowers:writing-plans`) so the artifacts match how this project actually plans work.

**Everything lives in the issue body, not in comments — that's deliberate.** The description is what
a reader sees first; comments sit below the fold. More concretely, GitHub's task-list **progress
meter** (the `3 of 8` bar on issue lists and project boards) counts checkboxes in the *body* only —
checkboxes posted in a comment are tickable but never feed it. Since the whole value of the plan is
that it's *trackable*, it belongs in the body, where ticking a task actually moves the needle. The
sibling `implement-issue` skill also reads the plan straight from the description.

## Autonomy contract (important)

The user wants this to run **hands-off**. The superpowers skills are normally interactive — they
ask questions one at a time and stop at approval gates. Here you run them in **one-shot autonomous
mode**: never block waiting for the user. Whenever a sub-skill would ask a clarifying question or
wait for sign-off, instead **pick the most reasonable default**, state the assumption inline in the
artifact (e.g. a short "Assumptions" note), and keep going. Only stop to ask the user if something
is a genuine blocker you cannot reasonably assume your way past (e.g. `gh` is not authenticated, or
the idea is too vague to even name). Make decisions; don't hold up the line.

## Checklist

Create a task for each item and complete them in order. For a batch of ideas, run steps 2-8 once
per idea.

1. **Preconditions** — confirm `gh` works and you're in the repo.
2. **Capture the idea(s)** — from the user's message; don't interrogate.
3. **Check for duplicates & related issues** — don't refile something that already exists; link what's adjacent.
4. **Build the template-compliant body fields** — read the live issue template and fill it.
5. **Brainstorm + Spec** — written as collapsible `<details>` sections (both via `superpowers:brainstorming`).
6. **Implementation plan** (via `superpowers:writing-plans`) — a *visible* body section whose `- [ ]`
   checkboxes feed the issue's progress meter; never tuck it inside a `<details>`.
7. **Assemble the description, choose labels, create the issue** — one body, one `gh issue create`,
   labels (type + priority + effort, plus `studio` when it fits) applied at creation, then read the
   issue back to confirm it rendered.
8. **Report** — list each issue with its URL, and point the user at `/implement-issue` to build it.

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

## Step 3 — Check for duplicates & related issues

Filing a duplicate is noise the maintainer has to clean up, and an issue that ignores its neighbours
reads like it landed from orbit. So before drafting, see what already exists — search open *and*
closed issues for the idea's key terms:

```bash
gh issue list --state all --search "python emitter" --limit 10 \
  --json number,title,state,url --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
```

Then act on the verdict the way the Autonomy contract says — decide, don't interrogate:

- **Clear duplicate** (an open issue already captures this idea): don't file a second one. Report
  *"looks like #N already covers this — skipped"* and move on; only file anyway if the user asked you to.
- **Related but distinct** (adjacent work, a dependency, a closed issue worth linking): proceed, and
  carry the links forward. You'll add a short `**Related:** #N, #M` line near the top of the body in
  Step 7 — GitHub auto-renders those cross-references, and it's where the prior art your brainstorm
  builds on gets cited.
- **Nothing similar**: proceed clean.

## Step 4 — Build the template-compliant body fields

These fields are the **visible top of the description**; the brainstorm/spec/plan come after. The
fields MUST match the project's own issue form — never invent your own structure. Read the live
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
- The template's declared `labels:` (feature_request declares `enhancement`) are applied at creation
  in Step 7, not written into the body.

See `references/issue-template.md` for a worked feature_request example and the exact field→heading
mapping. Hold this markdown — you'll stitch it together with the rest in Step 7.

## Step 5 — Brainstorm & Spec (collapsible body sections)

Invoke `superpowers:brainstorming` to load its current methodology, then apply it **autonomously**
(per the Autonomy contract — no questions, pick the recommended option, note assumptions). The
brainstorming skill explores context, weighs approaches, and writes a design doc/spec; you split its
output into two sections so the trail reads brainstorm → spec.

**🧠 Brainstorm.** A focused exploration, not a wall of text:
- *Problem / context* — what need this serves, who the persona is, what exists today (cite README /
  `USER-STORIES.md` / relevant code where it helps).
- *Approaches* — 2-3 options, each with honest trade-offs.
- *Recommendation* — pick one and say why. This decision drives the spec and plan.

**📋 Spec.** The formal design for the recommended approach, following the structure the
brainstorming skill uses for its design doc (goal, scope/non-goals, the `.koi` surface or behavior,
what it emits, key types/files touched, validation rules, edge cases, an Assumptions note for
anything you defaulted). Keep it target-agnostic where the architecture demands it. Where the design
has *shape* — a state machine's transitions, a context map's relationships, an aggregate's structure
— embed a **mermaid diagram** (a `mermaid` fenced block); GitHub renders it inline, and for a
modeling DSL like Koine a diagram often carries more than a paragraph. Use it where it genuinely
clarifies; don't decorate.

Render both as **collapsible sections** so the description stays scannable — the reasoning is one
click away, not a slab of text sitting on top of the plan. GitHub needs a blank line after
`</summary>` (and before `</details>`) or the Markdown inside won't render:

```markdown
<details>
<summary><b>🧠 Brainstorm</b></summary>

… problem / approaches / recommendation …

</details>

<details>
<summary><b>📋 Spec</b></summary>

… design doc, with a mermaid diagram where it helps …

</details>
```

## Step 6 — Implementation plan (visible, with checkboxes)

Invoke `superpowers:writing-plans` to load its current guidance, then apply it autonomously to the
spec from Step 5, with the project's grain in mind (grammar → builder visitor → semantic model →
validators → emitter → tests; never leak a C# concept into `Ast/`). Keep tasks bite-sized and each
one independently testable.

**Preserve the plan's checkbox task-list format, and keep this section OUTSIDE any `<details>`.**
`writing-plans` emits a plan whose every actionable step is a Markdown checkbox (`- [ ]`), and
GitHub renders those as *live, tickable checkboxes* on the issue **and** counts them in the
description's progress meter (`3 of 8 tasks`) — but only while they sit in the open body. A
contributor — or `implement-issue` running the plan — ticks off real progress as work lands. Two
ways to throw that away, both forbidden: collapsing steps into `- **Files:**` / `- **Test:**` prose
paragraphs, or burying the plan in a collapsed `<details>` where (depending on GitHub's renderer) the
meter may stop counting it. So the plan stays a flat, visible section under a `## 🛠️ Implementation
plan` heading — keep that exact phrase; `implement-issue` anchors on it.

Concretely, the plan MUST carry all three of these (issue #21's plan is the reference shape):

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
## 🛠️ Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: …

### Task 1: Runtime module + skeleton emitter wired into the CLI

**Files:** create `Emit/Python/PyRuntime.cs`, `PythonEmitter.cs`; modify `src/Koine.Cli/Program.cs`; test `…/PythonRuntimeTests.cs`.

**Interfaces:** `PythonEmitter : IEmitter`, `sealed partial`, `TargetName => "python"`, `Emit(KoineModel)` returning the root files.

- [ ] **Step 1:** Write the failing test in `PythonRuntimeTests.cs` — assert `TargetName == "python"` and `Emit` contains `koine_runtime.py`.
- [ ] **Step 2:** `dotnet test --filter "FullyQualifiedName~PythonRuntimeTests"` → FAIL (types not found).
- [ ] **Step 3:** Implement `PyRuntime.cs` — fixed-string `Source` modeled on `TsRuntime.cs`, stdlib-only.
- [ ] **Step 4:** `dotnet test --filter "FullyQualifiedName~PythonRuntimeTests"` → PASS.
- [ ] **Step 5:** Commit: `feat(emit-py): Python backend skeleton + runtime`.
```

Dispatching `writing-plans` to a **subagent** preserves the format most reliably — the plan comes
back as one clean artifact instead of competing with this skill's own framing mid-stream (issue #21,
which kept the checkboxes, was generated that way). Inline generation is fine too. Either way, hold
the plan markdown for Step 7, where the verify-checkboxes gate runs before anything is filed.

**You now know the real scope**, so settle on the **effort** size from what you just wrote — a
one-task tweak is `effort: S`, a few tasks within one layer `effort: M`, a cross-layer feature
(grammar → … → emitter → tests, the usual new-construct shape) `effort: L`, a phased multi-week
effort `effort: XL`. You'll apply it alongside the other labels in Step 7.

## Step 7 — Assemble the description, choose labels, and create the issue

Now stitch the one description together and file it in a single `gh issue create`. Because the plan
already exists, you know the effort too — so **all** labels go on at creation; nothing is deferred.

**Assemble the body** in this order, top (most-read) to bottom, into one temp file:

1. The template fields from Step 4 (Problem / Proposed solution / Area …) — visible.
2. The `**Related:** #N, #M` line from Step 3, if any.
3. The collapsible 🧠 **Brainstorm** and 📋 **Spec** from Step 5.
4. The 🛠️ **Implementation plan** from Step 6 — **visible, never inside a `<details>`**.

Then **verify the plan survived** before filing — zero checkboxes means the plan got mangled or
dropped into prose, and you must reformat into the task/checkbox structure from Step 6:

```bash
grep -c '^- \[ \]' /tmp/koine-issue-<slug>.md   # must be > 0; expect one per actionable plan step
```

**Choose labels.** This repo carries a small, deliberate label taxonomy that the maintainer actually
uses for triage — applying it is the difference between an issue that lands sorted and one that sits
unlabelled. Read the **live** set first (labels drift; never apply one that isn't there):

```bash
gh label list --limit 100
```

Pick across these axes — none of them are guesses, they're the labels your own analysis already
implies:

- **Type** — `enhancement` for an idea/feature (the common case, and what the feature_request
  template declares) or `bug` for a defect. Match whichever template you built the body from.
- **Priority** — exactly one tier, read from how essential the idea is (the same judgment your
  brainstorm's Recommendation makes):
  - `priority: high` — Tier 1: below a universal bar / a core deliverable the product needs.
  - `priority: medium` — Tier 2: an expected capability that's partial or absent. The safe default
    when an idea is clearly worth doing but not load-bearing.
  - `priority: low` — Tier 3: a differentiator or polish.
- **Effort** — exactly one size, the one you settled on at the end of Step 6 now that the plan
  reveals the real scope. (`effort: S` ≈ hours–1 day · `effort: M` ≈ a few days · `effort: L` ≈
  ~1-2 weeks / cross-layer · `effort: XL` ≈ multi-week / phased.)
- **Scope** — add `studio` when the idea concerns the Koine Studio IDE (`tooling/koine-studio`).
  It's the one area label that's earned its keep; don't invent new area labels — the feature_request
  *Area* dropdown already captures finer scope inside the body.

Per the Autonomy contract, just **decide** — pick the labels your framing implies and note the call
in the final report; don't open a Q&A about triage. Create with all of them at once:

```bash
gh issue create \
  --title "Add Python emitter target" \
  --label enhancement \
  --label "priority: medium" \
  --label "effort: L" \
  --body-file /tmp/koine-issue-<slug>.md
```

Capture the printed URL and issue number — you need them for the report. If a chosen label isn't in
the live list, create the issue without it rather than failing, and flag the gap in the final report.

**Read it back.** The pre-create `grep` proved your *local* file was good; this proves *GitHub* stored
it. A malformed `<details>` block, an oversized field, or a `--body-file` that didn't carry everything
can leave a broken issue that looks fine in the terminal — so fetch the live issue and confirm the
plan's checkboxes survived the round-trip and the labels actually stuck:

```bash
NUM=<issue-number>
filed=$(grep -c '^- \[ \]' /tmp/koine-issue-<slug>.md)
live=$(gh issue view "$NUM" --json body --jq .body | grep -c '^- \[ \]')
echo "checkboxes — filed $filed / live $live"          # must be equal and > 0
gh issue view "$NUM" --json labels --jq '.labels[].name'   # confirm every intended label applied
```

If `live` ≠ `filed` (or it's zero), the body didn't round-trip — repair it and push the fix with
`gh issue edit "$NUM" --body-file /tmp/koine-issue-<slug>.md` rather than leaving a broken issue
behind. If a label is missing, re-add it (`gh issue edit "$NUM" --add-label …`) or flag it in the
report. Only once the readback is clean do you move on.

## Step 8 — Report

List every issue created with its title, URL, and the labels you applied (type / priority / effort /
`studio`), and flag anything you assumed or skipped (a chosen label that wasn't in the live list, a
duplicate you declined to refile, a field you defaulted). Surfacing the labels lets the maintainer
re-triage with one glance if your call was off.

Then **close the loop**: the description already carries an executable plan, so point the user at the
sibling skill that runs it — **`/implement-issue #N`** turns the plan into a git worktree, a draft
PR, and task-by-task commits, ticking the body's checkboxes as each task lands. For a batch, give the
command per issue. Keep the report short — the issues themselves carry the detail.

---

## Notes on quality

- **Stay template-driven.** Read `.github/ISSUE_TEMPLATE/*.yml` each run; don't hardcode fields that
  could drift. The body's top section's job is to satisfy the template the maintainers chose.
- **Ground the content in the repo.** Generic feature-request boilerplate is worthless; reference
  real files, the layered pipeline, and the roadmap so the issue reads like it belongs here.
- **Respect the architecture invariant.** Koine keeps `Ast/` target-agnostic. Specs and plans for
  new emitters must add an emitter under `Emit/<Target>/` and must not push target concepts into the
  shared model.
- **The plan is a tracked checklist, not an essay.** It exists so someone can execute it task-by-task
  and tick off progress *on the issue itself*. Preserve `writing-plans`' `- [ ]` checkboxes all the
  way into the body, and keep the plan section visible (Step 6) — a plan flattened into prose, or
  hidden in a collapsed block, has lost its job and its place in the progress meter.
- **One pass, many issues.** When seeding a batch, create all issues, then give one consolidated
  report with each issue's `/implement-issue` hand-off.
