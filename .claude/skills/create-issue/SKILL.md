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
6. **Comment 3 — Implementation plan** (via `superpowers:writing-plans`).
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
spec from Step 5. Produce a plan with the project's grain in mind (grammar → builder visitor →
semantic model → validators → emitter → tests; never leak a C# concept into `Ast/`). Keep tasks
bite-sized and each one independently testable, following the skill's plan structure. Post it:

```bash
gh issue comment <number> --body-file /tmp/koine-c3-plan-<slug>.md
```

Prefix with `**🛠️ Implementation plan**`.

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
- **One commit, many issues.** When seeding a batch, create all issues and all comments, then give
  one consolidated report.
