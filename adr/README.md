# Architecture Decision Records

This directory records the architecturally significant decisions made for Koine, using
[MADR 4.0](https://adr.github.io/madr/) (see [ADR 0010](0010-adopt-madr-4.0-for-architecture-decision-records.md),
which supersedes the original Nygard-format choice in [ADR 0001](0001-record-architecture-decisions.md)).
An ADR captures a decision, the context that motivated it, and its consequences — so the *why* behind
the codebase survives long after the conversation or PR that produced it.

## Index

| #    | Title                                                                                   | Status   |
|------|------------------------------------------------------------------------------------------|----------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions                                       | Accepted |
| [0002](0002-conventional-commits-and-automated-semver.md) | Conventional Commits + automated semantic versioning via release-please | Accepted |
| [0003](0003-npm-workspace-for-front-end-packages.md) | npm workspace root for the front-end packages | Accepted |
| [0004](0004-concept-colors-single-palette-and-lsp-kind-modifiers.md) | Concept Colors — single palette + LSP kind modifiers | Proposed |
| [0005](0005-eslint-gate-for-frontend-safety-conventions.md) | ESLint flat-config gate for the front-end safety conventions | Proposed |
| [0006](0006-transport-presentation-as-opt-in-csharp-layers.md) | Transport/presentation as opt-in C# layers inside the csharp target | Proposed |
| [0007](0007-kotlin-emitter-target.md) | Kotlin emitter target | Proposed |
| [0008](0008-release-assets-in-release-please-run.md) | Release assets built inside the release-please run | Proposed |
| [0009](0009-active-context-scope-is-the-workbench-spine.md) | The active bounded-context scope is the workbench spine | Proposed |
| [0010](0010-adopt-madr-4.0-for-architecture-decision-records.md) | Adopt MADR 4.0 for architecture decision records | Proposed |

## When to write one

See `CLAUDE.md`'s "Architecture decisions (ADRs)" section for the enforcement rule. Short version:
significant, hard-to-reverse decisions get an ADR (a new emitter target, a change to the compiler
pipeline layering, a new cross-cutting validator, CI/release process changes, a dependency the whole
repo will lean on). Routine bug fixes and refactors that don't change a decision already on record
don't need one.

## Adding a new ADR

1. Copy [`template.md`](template.md) to `NNNN-short-title.md`, using the next sequential 4-digit
   number (zero-padded) and a kebab-case title.
2. Fill in the frontmatter (`id`, `title`, `date`; `status` starts at `proposed`) and the body:
   **Context and Problem Statement**, **Considered Options**, **Decision Outcome**, and
   **Consequences**. `deciders` / `tags` / `links` are optional frontmatter fields — add them where
   they're known.
3. Add a row to the index table above.
4. Once the PR merges, flip `status` to `accepted` (or `rejected` if the PR closes without merging).
5. If a later decision reverses an earlier one, don't edit the old ADR's Decision Outcome — add a new
   ADR, mark the old one's `status: superseded`, and record the relationship with a `links` entry
   (`type: superseded-by`) on the old ADR and (`type: supersedes`) on the new one. If only *part* of
   an earlier decision is reversed, the earlier ADR's status and content can stay as they are; instead
   add a `links` entry of `type: relates-to` on both ADRs and state the partial-supersession explicitly
   in the new ADR's Consequences (see [ADR 0008](0008-release-assets-in-release-please-run.md) for an
   example against [ADR 0002](0002-conventional-commits-and-automated-semver.md)).
