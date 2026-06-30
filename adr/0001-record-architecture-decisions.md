# 0001. Record architecture decisions

Date: 2026-06-30

## Status

Accepted

## Context

Koine has accumulated 600+ commits and a non-trivial pipeline (grammar → AST → semantics → multiple
emitters → tooling). Decisions about *why* the codebase looks the way it does — why the lexer
grammar is split from the parser grammar, why `Ast/` must stay target-agnostic, why warnings aren't
errors, why templates live under `templates/` as a single source of truth — currently live only in
`CLAUDE.md`, scattered PR descriptions, and the maintainer's memory. None of that is indexed,
none of it is dated, and none of it records the alternatives that were rejected and why.

As the project grows (more emitters, more contributors, more CI/release machinery), decisions that
are expensive to reverse need a durable, discoverable record — separate from `CLAUDE.md` (which
describes the current state) and separate from PR descriptions (which describe a single change, not
the decision's full context and consequences).

## Decision

We will record architecturally significant decisions as Architecture Decision Records (ADRs), using
the lightweight format described at [adr.github.io](https://adr.github.io/) (Michael Nygard's
original convention): one Markdown file per decision, numbered sequentially, each with **Context**,
**Decision**, and **Consequences** sections, stored under `/adr/` at the repository root.

`/adr/README.md` is the index and the contributor-facing instructions; `/adr/template.md` is the
starting point for a new record. `CLAUDE.md` enforces when an ADR is required.

## Consequences

- Future contributors (human or agent) can answer "why is it like this?" by reading `/adr/` instead
  of reverse-engineering intent from code or git blame.
- Every architecturally significant PR now carries a small amount of extra process: write or update
  an ADR. This is deliberate friction for decisions worth slowing down for; it does not apply to
  routine fixes/refactors.
- ADRs are immutable once accepted — superseding a decision means adding a new ADR, not editing
  history, so the record stays an honest timeline.
