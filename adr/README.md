# Architecture Decision Records

This directory records the architecturally significant decisions made for Koine, using the
lightweight [ADR](https://adr.github.io/) format originated by Michael Nygard. An ADR captures a
decision, the context that motivated it, and its consequences — so the *why* behind the codebase
survives long after the conversation or PR that produced it.

## Index

| #    | Title                                                                                   | Status   |
|------|------------------------------------------------------------------------------------------|----------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions                                       | Accepted |
| [0002](0002-conventional-commits-and-automated-semver.md) | Conventional Commits + automated semantic versioning via release-please | Accepted |
| [0003](0003-npm-workspace-for-front-end-packages.md) | npm workspace root for the front-end packages | Accepted |
| [0004](0004-concept-colors-single-palette-and-lsp-kind-modifiers.md) | Concept Colors — single palette + LSP kind modifiers | Proposed |
| [0005](0005-eslint-gate-for-frontend-safety-conventions.md) | ESLint flat-config gate for the front-end safety conventions | Proposed |

## When to write one

See `CLAUDE.md`'s "Architecture decisions (ADRs)" section for the enforcement rule. Short version:
significant, hard-to-reverse decisions get an ADR (a new emitter target, a change to the compiler
pipeline layering, a new cross-cutting validator, CI/release process changes, a dependency the whole
repo will lean on). Routine bug fixes and refactors that don't change a decision already on record
don't need one.

## Adding a new ADR

1. Copy [`template.md`](template.md) to `NNNN-short-title.md`, using the next sequential 4-digit
   number (zero-padded) and a kebab-case title.
2. Fill in **Context**, **Decision**, and **Consequences**. Status starts at `Proposed`.
3. Add a row to the index table above.
4. Once the PR merges, flip the status to `Accepted` (or `Rejected` if the PR closes without
   merging).
5. If a later decision reverses an earlier one, don't edit the old ADR's Decision — add a new ADR
   and mark the old one `Superseded by [NNNN](NNNN-xxx.md)`.
