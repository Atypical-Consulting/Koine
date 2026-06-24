# Issue template → markdown mapping

`gh issue create` posts a plain markdown body; it does **not** render the GitHub *form* template in
`.github/ISSUE_TEMPLATE/*.yml`. So you read the YAML form and reconstruct an equivalent markdown body
by hand. This file shows how.

## The rule

For each entry in the template's `body:` array:

| YAML `type` | What to emit |
|-------------|--------------|
| `markdown`  | skip — it's instructional text shown to the human, not a field |
| `input`     | `## <attributes.label>` heading + a one-line answer |
| `textarea`  | `## <attributes.label>` heading + a prose/markdown answer |
| `dropdown`  | `## <attributes.label>` heading + the single best `options` value, verbatim |
| `checkboxes`| `## <attributes.label>` heading + a `- [x]` / `- [ ]` list |

Honor `validations.required: true` — every required field needs real, specific content. Apply the
template's top-level `labels:` via `--label` — but that's only the *type* label (e.g. `enhancement`).
The triage labels (`priority: *`, `effort: *`, `studio`) are not in the template; pick them from the
repo's live taxonomy per SKILL.md Step 4 (and the `effort:` one in Step 6).

## Worked example — `feature_request.yml`

The current feature_request form has required `Problem / motivation`, required `Proposed solution`,
optional `Alternatives considered`, and a required `Area` dropdown. A compliant body:

```markdown
## Problem / motivation

Koine compiles a target-agnostic semantic model to C# today, with a TypeScript emitter in progress.
Teams whose services live in Python can't share the same ubiquitous-language source of truth. A
Python emitter lets a Domain Developer author one `.koi` model and ship idiomatic Python alongside
C#/TS.

## Proposed solution

A new `Emit/Python/PythonEmitter` selected via `--target python`, mirroring the C# emitter's
split-by-concern partials:

- value objects → frozen dataclasses with validation in `__post_init__`
- entities/aggregates → classes with invariant guards
- smart enums → `enum.Enum` subclasses
- commands/events → dataclasses
- repositories → `Protocol` interfaces

Reuse the existing `Ast/` model untouched. Adds `PythonTypeMapper`, `PythonNaming`, and an
expression translator parallel to the C# ones.

## Alternatives considered

- Generating Python from the TypeScript output — rejected, lossy and couples two emitters.
- Hand-writing Python DTOs — defeats single-source-of-truth.

## Area

New emitter target
```

Create it with the type + priority labels (effort is added after the plan in SKILL.md Step 6):

```bash
gh issue create --title "Add Python emitter target" \
  --label enhancement --label "priority: medium" \
  --body-file /tmp/koine-issue-python.md
```

## Area dropdown values (feature_request)

Pick exactly one, copied verbatim:

- `Language / grammar`
- `Semantic model / validation`
- `C# emitter`
- `TypeScript emitter`
- `New emitter target`
- `CLI / LSP / tooling`
- `Docs / website`

## bug_report

Only use this template when the user is filing a defect (something emits wrong/crashes), not an idea.
Read `bug_report.yml` the same way and map its fields (repro steps, expected vs actual, version, etc.)
to headings. Its declared labels apply via `--label`.
