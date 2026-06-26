# Changelog

All notable changes to Koine are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Koine is pre-1.0, so minor versions
may include breaking changes.

## [Unreleased]

### Added
- **Koine Studio — Source Control (git) panel.** A new right-rail **Source Control** view brings git into
  the IDE for `.koi` models kept under version control (issue #272): the current branch with a switcher,
  changed files grouped into **Staged** / **Changes** / **Untracked** with per-row stage/unstage and an
  inline diff, a commit box, and the recent-commit log. Git is a host capability behind a new `canUseGit`
  flag on `Platform` — the desktop (Tauri) host shells `git` in the opened folder via new `git_*` sidecar
  commands (`git_status`/`git_diff`/`git_stage`/`git_unstage`/`git_commit`/`git_branches`/`git_checkout`/
  `git_log`), while the browser host (no shell) degrades gracefully to a "desktop only" empty state, and a
  non-repo folder shows a "not a git repository" empty state. This is the umbrella git plumbing the
  per-element inspector history (#150) reuses.
- **TypeScript & Python infrastructure layer (`--layers infrastructure`).** The opt-in
  `--layers infrastructure` selector — previously C#-only (EF Core) — now also applies to the
  **TypeScript** and **Python** targets (issue #241), closing the largest cross-emitter parity gap.
  Per bounded context with an entity-rooted aggregate, each emits a **dependency-light**, runnable
  realization of the domain contracts: a concrete repository over an injectable `AggregateStore` with a
  zero-dependency **in-memory default** (declarative finders → concrete lookups), a concrete unit of
  work, a transactional **outbox** + dispatcher (publishing contexts only), validation/transaction
  **pipeline behaviors**, and a composition-root factory (TS) / provider helper (Python). Shared
  primitives live once in an emitted `infrastructure-runtime.ts` / `koine_infrastructure.py`. Off by
  default — an unconfigured emit is byte-identical; the output is `tsc --strict` / `mypy --strict`-clean.
- **Koine Studio — aggregate-scoped palette constructs (Repository & Rule).** The visual editor's
  structured-edit seam now targets a *selected aggregate* (not only a context): a new
  `addAggregateMember` edit inserts a re-validating `aggregateMember` and re-emits the whole aggregate.
  The two muted palette buttons are activated, gated on an aggregate being selected — **Repository**
  inserts `repository { operations: add, getById }`, and **Rule** maps to an aggregate-scoped
  `spec <Name> on <Root> = true` (a named, reusable boolean rule over the root; no new grammar). A
  second repository on the same aggregate is refused; a duplicate rule name is rejected by re-validation.
- **MCP server (`koine-mcp`).** A Model Context Protocol server (`src/Koine.Mcp`) that lets an AI agent
  author a complete domain in `.koi` over stdio: `koine_validate`, `koine_compile`
  (csharp/typescript/glossary/docs), and `koine_format` tools, plus `koine_reference` and
  `koine_examples` (also exposed as `koine://` resources) so the agent learns the language. Reuses the
  same parser, validator, and emitters as `koine build`. Packaged as a `dotnet tool`.
- Documentation emitter (`--target docs`): emits Markdown with Mermaid diagrams (context maps as
  flowcharts, state machines as state diagrams, integration-event flows) — _in progress_.

## [0.17.x] — Tooling & multi-target

### Added
- **R16 — Multi-target emitters & emitter configuration.** TypeScript emitter (`--target typescript`)
  behind the same target-agnostic `IEmitter` seam as C#, plus per-target output configuration via
  `koine.config`. Generated C# is grouped into DDD "kind" subfolders.
- **R17 — Editor tooling & developer experience.** TextMate grammar for `.koi` (Rider + VS Code),
  a `koine lsp` language server (live diagnostics, completion, hover, go-to-definition across files),
  AST-scoped rename / extract-value-object refactorings, and the `fmt` / `init` / `watch` CLI commands.
- Build-time ubiquitous-language **glossary** emission (`--target glossary`).

## [0.1.0 – 0.16.x] — Core language (R1–R15)

The full tactical *and* strategic DDD toolkit on the C# emitter, delivered as releases R1–R15:

- **Tactical building blocks** — value objects, entities (`identified by`, identity strategies),
  aggregates, smart enums, derived/default fields, invariants (incl. regex `matches` and `when` guards),
  the pure expression sublanguage, factories, specifications, domain services, and policies.
- **Persistence & application layer** — repositories, optimistic concurrency (`versioned`), the
  application layer (Unit of Work, read models, CQRS queries/handlers).
- **Strategic design** — multi-file compilation, imports & modules, context maps, integration events,
  and model versioning / evolution checks.
- Self-contained `Koine.Runtime` markers emitted alongside the generated code (no external dependency).
- Snapshot (Verify) + in-memory Roslyn compile/execute meta-tests throughout.

[Unreleased]: https://github.com/Atypical-Consulting/Koine/commits/main
