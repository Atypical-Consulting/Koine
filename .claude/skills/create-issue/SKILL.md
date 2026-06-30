---
name: create-issue
description: >-
  Create a fully-seeded GitHub issue for the Koine project — don't settle for a bare `gh issue create`.
  Files a template-compliant issue whose DESCRIPTION carries a brainstorm → spec → implementation-plan
  trail (via the superpowers skills), turning a one-line idea into something a contributor can pick up
  cold. ALWAYS reach for this whenever the user wants to open, file, add, raise, create, log, or track a
  NEW issue / feature request / idea / ticket / backlog item for this repo — including loose phrasings
  like "track this idea", "add an issue for X", "log a feature", "make a ticket", "raise an issue",
  "capture this for later", and batches of several ideas at once. Use it even though you could file the
  issue yourself with `gh` — the whole point is the seeded brainstorm/spec/plan. Does NOT apply to
  managing EXISTING issues (commenting on, closing, or listing them), or to standalone
  brainstorming/planning when there's no issue to file.
---

# Create a Koine GitHub issue (template-compliant, auto-seeded)

## What this does

Turns a raw idea into an issue a future contributor can pick up cold: one self-contained
**description** that obeys the project's issue template, then walks the idea from fuzzy to actionable —

1. **Brainstorm** — frames the problem, lays out 2-3 approaches with trade-offs, recommends one.
2. **Spec** — the formal design doc for the chosen approach.
3. **Implementation plan** — bite-sized, testable tasks an engineer (or `implement-issue`) can execute.

Brainstorm and plan come from the **superpowers** skills (`superpowers:brainstorming`,
`superpowers:writing-plans`) so the artifacts match how the project plans work.

**Everything lives in the issue body, not comments — deliberately.** GitHub's task-list **progress
meter** (the `3 of 8` bar on issue lists / project boards) counts checkboxes in the *body* only, and
`implement-issue` reads the plan straight from the description. So the trackable plan belongs in the
body, where ticking a task moves the needle.

## Autonomy contract

Run **hands-off**. The superpowers skills are normally interactive (ask one question at a time, stop at
approval gates); here you run them in **one-shot autonomous mode**. Whenever a sub-skill would ask or
wait for sign-off, **pick the most reasonable default**, state the assumption inline (a short
"Assumptions" note), and keep going. Only stop for a genuine blocker you can't assume past (`gh` not
authenticated, or an idea too vague to even name). Decide; don't hold up the line.

## Checklist

Create a task per item and complete in order. For a batch of ideas, run steps 2-8 once per idea.

1. **Preconditions** — confirm `gh` works and you're in the repo.
2. **Capture the idea(s)** — from the user's message; don't interrogate.
3. **Check for duplicates & related issues** — don't refile what exists; link what's adjacent.
4. **Build the template-compliant body fields** — read the live issue template and fill it.
5. **Brainstorm + Spec** — collapsible `<details>` sections (via `superpowers:brainstorming`).
6. **Implementation plan** (via `superpowers:writing-plans`) — a *visible* section whose `- [ ]` checkboxes feed the progress meter; never inside a `<details>`.
7. **Assemble the description, choose labels, create the issue** — one body, one `gh issue create`, labels (type + priority + effort + any scope) from the profile, then read the issue back.
8. **Report** — list each issue with its URL, point the user at `/implement-issue`.

---

## Step 1 — Preconditions

**Load the repo profile first.** Every repo-specific fact — label taxonomy, issue-template defaults,
architecture grain — lives in the committed file **`.claude/skills/repo-profile.md`**, not inline. Read it
directly — `cat .claude/skills/repo-profile.md` — and the steps below cite its sections (*Labels*, *Issue
templates*, *Architecture grain*). Only if that file is **missing** (or the user asks to refresh it) run
**`get-repo-profile`** to generate it first, then read it. If you genuinely can't get one, say so in the
report rather than inventing repo specifics.

```bash
gh api user --jq .login      # must print a login; if 401, the token is invalid
```

If this fails with an auth error, stop and tell the user to run `! gh auth login -h github.com` in the
prompt (the `!` prefix runs it in this session so the token lands in your environment). Re-check before
continuing. Confirm the working directory is the repo you mean to file in (`gh` targets its `origin`).

## Step 2 — Capture the idea(s)

Pull the idea(s) from the user's request — one ("add Rust generation") or several ("add python gen,
php gen, an IDE"). Don't open a Q&A — infer scope from the prompt, README, roadmap docs, and codebase.
Treat each named idea as its own issue and loop. For each, settle on a crisp **title** (imperative,
e.g. "Add Python emitter target") before writing anything.

## Step 3 — Check for duplicates & related issues

A duplicate is noise; an issue that ignores its neighbours reads like it landed from orbit. Search open
*and* closed issues for the idea's key terms first:

```bash
gh issue list --state all --search "python emitter" --limit 10 \
  --json number,title,state,url --jq '.[] | "#\(.number) [\(.state)] \(.title)"'
```

Then decide (don't interrogate):

- **Clear duplicate** (open issue already captures it): don't refile. Report *"#N already covers this — skipped"* and move on; file anyway only if asked.
- **Related but distinct**: proceed, carry the links forward — add a `**Related:** #N, #M` line near the top of the body in Step 7 (GitHub auto-renders the cross-references, and it's where your brainstorm's prior art gets cited).
- **Nothing similar**: proceed clean.

## Step 4 — Build the template-compliant body fields

These are the **visible top of the description** (brainstorm/spec/plan come after). They MUST match the
project's issue form — never invent structure. Read the live template:

```bash
ls .github/ISSUE_TEMPLATE/
cat .github/ISSUE_TEMPLATE/feature_request.yml
```

`gh issue create` doesn't apply a form template, so reconstruct it as markdown:

- Use **feature_request** for ideas/enhancements (common case); `bug_report` only for a clear defect.
- For each `textarea`/`input` field, emit a `## <label>` heading and fill it. Honor `validations.required`.
- For each `dropdown`, pick the best-fitting option and write it under its heading, verbatim from the live YAML.
- The template's declared `labels:` apply at creation in Step 7, not in the body.

See `references/issue-template.md` for a worked feature_request example and the exact field→heading
mapping. Hold this markdown for Step 7.

## Step 5 — Brainstorm & Spec (collapsible body sections)

Invoke `superpowers:brainstorming`, then apply it **autonomously** (no questions, pick the recommended
option, note assumptions). Split its output into two sections so the trail reads brainstorm → spec.

**🧠 Brainstorm** — focused, not a wall of text: *Problem/context* (what need, who, what exists — cite
README / roadmap / code); *Approaches* (2-3 options with honest trade-offs); *Recommendation* (pick one
and why — this drives the spec and plan).

**📋 Spec** — the formal design for the recommended approach (goal, scope/non-goals, the `.koi` surface
or behavior, what it emits, key types/files, validation rules, edge cases, an Assumptions note).
Target-agnostic where the architecture demands. Where the design has *shape* — a state machine, a
context map, an aggregate — embed a **mermaid diagram**; GitHub renders it inline. Use it where it
clarifies; don't decorate.

Render both as **collapsible sections** so the description stays scannable. GitHub needs a blank line
after `</summary>` (and before `</details>`) or the Markdown won't render:

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

Invoke `superpowers:writing-plans`, then apply it autonomously to the Step 5 spec, shaping tasks to the
profile's *Architecture grain* (layer order + invariants a plan must not break). Tasks bite-sized and
each independently testable.

**Preserve the `- [ ]` checkbox format, and keep this section OUTSIDE any `<details>`.** GitHub renders
those as live tickable checkboxes *and* counts them in the progress meter — but only while they sit in
the open body. Two ways to throw that away, both forbidden: flattening steps into `- **Files:**` /
`- **Test:**` prose, or burying the plan in a collapsed `<details>` (the meter may stop counting it).
Keep it a flat, visible section under a `## 🛠️ Implementation plan` heading — exact phrase;
`implement-issue` anchors on it.

The plan MUST carry all three (issue #21's plan is the reference shape):

1. The writing-plans **header note, verbatim**:
   `> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.`
2. A short **Goal / Architecture / Tech Stack** preamble and a **Global Constraints** list (version floors, architecture invariants from *Architecture grain*, commit identity from *Commit identity*, build constraints) — exact values from the spec and profile.
3. One `### Task N: <name>` per task, each with **Files** + **Interfaces** lines, then **every step as its own `- [ ]` checkbox** (write the failing test → run red → implement → run green → commit). The final step is a `- [ ]` checkbox with the commit message.

Shape (abbreviated — keep the checkboxes, never flatten to prose):

```markdown
## 🛠️ Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: …

### Task 1: Runtime module + skeleton emitter wired into the CLI

**Files:** create `Emit/Python/PyRuntime.cs`, `PythonEmitter.cs`; modify the CLI's target switch; test `…/PythonRuntimeTests.cs`.

**Interfaces:** `PythonEmitter : IEmitter`, `sealed partial`, `TargetName => "python"`, `Emit(KoineModel)` returning the root files.

- [ ] **Step 1:** Write the failing test in `PythonRuntimeTests.cs` — assert `TargetName == "python"` and `Emit` contains `koine_runtime.py`.
- [ ] **Step 2:** Run that suite via the profile's *Build & test* single-suite filter → FAIL (types not found).
- [ ] **Step 3:** Implement `PyRuntime.cs` — fixed-string `Source` modeled on `TsRuntime.cs`, stdlib-only.
- [ ] **Step 4:** Re-run the suite filter → PASS.
- [ ] **Step 5:** Commit: `feat(emit-py): Python backend skeleton + runtime`.
```

Dispatching `writing-plans` to a **subagent** preserves the format most reliably (issue #21 was
generated that way); inline is fine too. Hold the plan markdown for Step 7's verify-checkboxes gate.

**You now know the real scope**, so settle on the **effort** size from what you wrote, matching the
profile's *Labels* taxonomy (one-task tweak = smallest; cross-layer/phased = largest). Apply it in Step 7.

## Step 7 — Assemble the description, choose labels, and create the issue

Stitch one description and file it in a single `gh issue create`. Because the plan exists, you know the
effort too — **all** labels go on at creation.

**Assemble the body** top (most-read) to bottom, into one temp file:

1. The template fields from Step 4 (Problem / Proposed solution / Area …) — visible.
2. The `**Related:** #N, #M` line from Step 3, if any.
3. The collapsible 🧠 **Brainstorm** and 📋 **Spec** from Step 5.
4. The 🛠️ **Implementation plan** from Step 6 — **visible, never inside a `<details>`**.

**Verify the plan survived** before filing — zero checkboxes means it got mangled; reformat into the
Step 6 task/checkbox structure:

```bash
grep -c '^- \[ \]' /tmp/koine-issue-<slug>.md   # must be > 0; expect one per actionable step
```

**Choose labels.** The taxonomy (exact strings, priority tiers and meanings, effort sizes, scope) lives
in the profile's *Labels* section. Read the **live** set first (labels drift):

```bash
gh label list --limit 100
```

Pick one label per axis (none are guesses — your analysis already implies them):

- **Type** — feature/idea for the common case (what feature_request declares), or bug for a defect; match the template you built from.
- **Priority** — exactly one tier (the judgment your brainstorm's Recommendation makes).
- **Effort** — exactly one size, the one you settled on in Step 6.
- **Scope** — a profile scope label when the idea falls in its area; don't invent area labels (the *Area* dropdown captures finer scope in the body).

Decide, note the call in the report, don't open a triage Q&A. Create with all of them:

```bash
gh issue create \
  --title "Add Python emitter target" \
  --label "<type>" \
  --label "<priority tier>" \
  --label "<effort size>" \
  --body-file /tmp/koine-issue-<slug>.md
```

Capture the printed URL and number. If a chosen label isn't in the live list, create without it rather
than failing, and flag the gap.

**Read it back.** The pre-create `grep` proved your *local* file; this proves *GitHub* stored it (a
malformed `<details>`, an oversized field, or a `--body-file` that didn't carry everything can leave a
broken issue that looks fine in the terminal):

```bash
NUM=<issue-number>
filed=$(grep -c '^- \[ \]' /tmp/koine-issue-<slug>.md)
live=$(gh issue view "$NUM" --json body --jq .body | grep -c '^- \[ \]')
echo "checkboxes — filed $filed / live $live"          # must be equal and > 0
gh issue view "$NUM" --json labels --jq '.labels[].name'   # confirm every intended label applied
```

If `live` ≠ `filed` (or zero), the body didn't round-trip — repair and push with
`gh issue edit "$NUM" --body-file …`. If a label is missing, re-add (`gh issue edit "$NUM"
--add-label …`) or flag it. Move on only once the readback is clean.

## Step 8 — Report

List every issue created with its title, URL, and applied labels (type / priority / effort / scope),
and flag anything assumed or skipped (a label not in the live list, a duplicate you declined, a
defaulted field). Then **close the loop**: point the user at **`/implement-issue #N`** to run the plan
(worktree → draft PR → task-by-task commits, ticking the body's checkboxes). For a batch, give the
command per issue. Keep the report short — the issues carry the detail.

---

## Notes on quality

- **Stay template-driven** — read `.github/ISSUE_TEMPLATE/*.yml` each run; don't hardcode fields that drift.
- **Ground content in the repo** — reference real files, the layered pipeline, and the roadmap; generic boilerplate is worthless.
- **Respect the architecture invariant** — shape specs/plans to the profile's *Architecture grain* so a plan reads like it belongs here.
- **The plan is a tracked checklist, not an essay** — preserve `writing-plans`' `- [ ]` checkboxes into the body and keep the section visible; flattened-to-prose or hidden-in-`<details>` loses its job and its place in the progress meter.
