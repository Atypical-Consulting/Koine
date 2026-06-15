# Demo Showcase + Koine Documentation Site — Design

> Status: approved 2026-06-16. Two deliverables: (1) grow the `demo/Shop.Domain` so it
> exercises **every shipped Koine feature (R1–R15)** with a green build, and (2) build a
> first-class **Astro Starlight** documentation site deployed to GitHub Pages.

## Context

Koine is a target-agnostic DDD DSL compiler (`.koi` → C#), feature-complete through epic R15.
The current demo (`demo/Shop.Domain`, three contexts: Catalog/Customers/Ordering) only exercises
R1–R7 plus smart enums. Epics R8–R15 — factories, richer value objects, specs/services/policies,
identity strategies/repositories/concurrency, the application layer & CQRS, multi-file
compilation/imports/modules, context maps/integration events, and model versioning — ship in the
compiler but are **undemonstrated**. There is also **no documentation site** for first-time users.

The compiler pipeline and conventions are unchanged by this work; this is a demo + docs effort.
**No compiler code changes** are in scope except, if strictly required, the demo `.csproj` build
target and the new CI workflow.

## Goals

1. A single, coherent Shop domain that demonstrates **all** shipped constructs and **compiles**
   (`./build.sh` green: build + 450 tests + demo `dotnet build`).
2. A polished docs site a newcomer can land on and go from zero → productive: clear story,
   getting-started, progressive tutorials, complete language reference, CLI reference,
   architecture, editor tooling, and roadmap.
3. Docs and demo stay in lock-step — every `.koi` snippet in the docs is valid and (where shown
   as a full model) compiles; tutorials build the *real* demo domain.

## Non-goals

- No browser playground (deferred; noted as a roadmap item with local-CLI instructions instead).
- No new compiler language features. No R16/R17 implementation.
- No changes to the parser/AST/validator/emitter beyond what the demo legitimately exercises.

---

## Part 1 — Demo domain showcase

### Correctness discipline (hard rule)

Every construct's **exact** syntax is verified against `src/Koine.Compiler/Grammar/KoineParser.g4`
and the owning epic's `tests/Koine.Compiler.Tests/RNNxxxTests.cs` **before** it is written into a
`.koi` file. No syntax is invented. The authoritative loop is author → `dotnet build` (which runs
`KoineGenerate`) → fix → repeat until green.

### Target file layout

```
demo/Shop.Domain/Models/
├── catalog.koi        # extended: Currency w/ associated data (R9), Sku natural key (R11),
│                      #   Weight as quantity (R9), SalePeriod as Range<Instant> (R9),
│                      #   OrderSummary-style readmodel/query (R12), @since/version (R15)
├── customers.koi      # extended: spec + service operations (R10), readmodel/query (R12)
├── ordering.koi       # extended: factory (R8), versioned + repository block (R11),
│                      #   usecase service + UoW (R12), spec/policy (R10), module (R13)
├── shipping.koi       # NEW context: imports Ordering.{OrderId} / Catalog.{Weight} (R13),
│                      #   Shipment aggregate w/ factory + state machine + events
├── payments.koi       # NEW context: imports Ordering.{OrderId, Money} (R13), Payment aggregate
└── context-map.koi    # NEW: context map w/ typed relationships, shared kernel, ACL stubs,
                       #   integration events published + subscribers (R14)
```

### Feature → location matrix (acceptance checklist)

| Epic | Construct | Demonstrated at |
|------|-----------|-----------------|
| R8 | Named factory / `create` on aggregate | `ordering.koi` `Order`, `shipping.koi` `Shipment` |
| R9 | Enum members with associated data | `catalog.koi` `Currency(symbol, decimals)` |
| R9 | `quantity` value object (unit arithmetic) | `catalog.koi` `Weight` |
| R9 | `Range<T>` value object | `catalog.koi` `SalePeriod` as `Range<Instant>` |
| R10 | `spec Name on T = …` | `ordering.koi` / `customers.koi` |
| R10 | `service` with pure `operation`s | `customers.koi` or `catalog.koi` pricing |
| R10 | `policy … when Event then Target.command` | `ordering.koi` / `context-map.koi` |
| R11 | `as natural(String|Int)` / `as sequence` | `catalog.koi` `Sku`, one sequence id |
| R11 | `repository { operations … find … }` | `ordering.koi` `Order` |
| R11 | `versioned` aggregate (+ concurrency) | `ordering.koi` `Order` |
| R12 | `service { usecase … }` + generated UoW | `ordering.koi` `OrderingService` |
| R12 | `readmodel M from Src { … }` + projection | `catalog.koi` / `ordering.koi` |
| R12 | `query Q(criteria): List<M>|M` | alongside the readmodels |
| R13 | `koine build <dir>` directory mode | `.csproj` build target switch |
| R13 | `import X.{…}` / `import X.*` / FQN refs | `shipping.koi`, `payments.koi` |
| R13 | `module Name { … }` sub-namespace | `ordering.koi` |
| R14 | `context map { … }` typed relationships | `context-map.koi` |
| R14 | shared kernel ownership + ACL stubs | `context-map.koi` |
| R14 | integration events + subscribers | `context-map.koi` |
| R15 | `context X version N` | all contexts |
| R15 | `@since(n)` / `@deprecated("…")` | evolved members; `koine check --baseline` |

### Build-target change (R13 enabler)

The demo `.csproj` `KoineGenerate` target currently invokes `koine build` **once per file**, which
cannot resolve cross-context `import`s. It will switch to a single **directory-mode** invocation:

```
koine build Models --out Generated   # one model; imports resolve across files
```

If directory mode changes the generated file set/paths, the `.csproj` compile globs and `.gitignore`
are updated to match. `Samples.cs` is extended to *use* representative new generated types (a factory
call, a repository interface, a readmodel projection, an integration-event record) so the green build
proves they are real and usable.

### R15 baseline check demonstration

A small `Models.baseline/` (or documented snapshot) lets the demo README show
`koine check --baseline <dir>` reporting a compatible/breaking change, exercising the
`CompatibilityChecker`.

### Demo acceptance criteria

- `./build.sh` is green (build, 450 existing tests, demo compiles with `Samples.cs`).
- Every row of the feature matrix is present in a `.koi` file and survives codegen.
- `demo/README.md` is rewritten to map all R1–R15 features to where they live, with run commands.
- `koine check --baseline` is demonstrated with a real before/after.

---

## Part 2 — Documentation site (Astro Starlight)

### Stack & deployment

- New top-level **`website/`** Astro + Starlight project (separate from `docs/superpowers/`).
- `astro.config.mjs`: `site: 'https://atypical-consulting.github.io'`, `base: '/Koine/'`
  (org project-pages path), Starlight integration, syntax highlighting incl. a `.koi`/`koine`
  language alias.
- New **`.github/workflows/deploy-docs.yml`**: build on push to `main`, deploy artifact to
  GitHub Pages (`actions/deploy-pages`). Concurrency-guarded; Pages permissions set.
- `.gitignore` updated for `website/node_modules`, `website/dist`, `.astro`.

### Information architecture

Written for the journey newcomer → power user:

1. **Home / landing** — what Koine is, why it exists (ubiquitous language once → idiomatic code),
   the `.koi`→C# value prop, a 30-second example, CTAs to Getting Started / Tutorials / GitHub.
2. **Getting Started** — prerequisites, install/build, your first `.koi`, `koine build`, reading the
   generated C#, what "green build = correct domain" means.
3. **Tutorials** — progressive and hands-on, building the **real** Shop domain in parts:
   values & invariants → entities & identity → aggregates, commands, events, state machines →
   the application layer (repositories, services, read models) → going multi-context (imports,
   context maps, integration events) → evolving a model (versioning + compatibility check).
4. **Language Reference** — one page (or grouped pages) per construct family, formal and complete:
   contexts; value objects; entities & identity strategies; aggregates & roots; enums (incl.
   associated data & smart enums); fields, defaults, derived/computed; invariants (range, regex,
   conditional); the expression sublanguage (conditionals, string/collection ops, lambdas,
   optionality, `Instant`); commands & state transitions; domain events; state machines; factories;
   specs, services & policies; repositories & optimistic concurrency; application services, read
   models & queries (CQRS); multi-file compilation, imports & modules; context maps & integration
   events; model versioning & evolution. Each: syntax, what it emits, a small example.
5. **Feature Catalogue** — the R1–R15 map (construct → emitted C#), mirroring the demo so readers
   can jump from a doc to the live demo file.
6. **CLI Reference** — `build` (`--target`, `--out`, `--glossary`), `check --baseline`, `lsp`,
   exit codes, diagnostics format (`KOIxxxx`).
7. **Architecture** — the strictly-layered pipeline (lexer/parser → model → validator → emitter),
   the target-agnostic semantic model, notable design decisions, how to add an emitter.
8. **Editor Tooling** — TextMate grammar import (Rider/VS Code) + the `koine lsp` language server
   (diagnostics, completion, hover, cross-file go-to-definition).
9. **Roadmap** — R16 (C# config, TypeScript, Rust emitters; conformance harness) and R17 (tooling),
   linking `USER-STORIES.md`.

### Grounding rule

Every page is grounded in **real artifacts** — README, USER-STORIES, the grammar, the test suite,
and the now-extended demo. No invented syntax, flags, or emitted shapes. Every fenced `.koi` block
is valid; every full-model example is taken from / verified against the demo.

### Orchestration (the dynamic workflow)

1. **Understand** (parallel): readers extract verified facts per area (exact construct syntax + what
   it emits, CLI surface, architecture, demo mapping) into structured notes.
2. **Author** (fan-out, parallel): one agent per docs section, each fed its grounding notes + the
   Starlight conventions, producing finished MDX.
3. **Critic** (parallel per page + one global): completeness (every R1–R15 construct covered),
   correctness (snippets valid), consistency (links resolve, terminology uniform, no contradictions).
   Findings feed a fix pass.
4. **Assemble & verify**: wire pages into the Starlight sidebar, `npm install && npm run build`,
   fix until the site builds clean.

### Docs acceptance criteria

- `website/` builds clean (`npm run build`, zero broken internal links).
- Every R1–R15 construct appears in the Language Reference and Feature Catalogue.
- A newcomer path exists end-to-end: Home → Getting Started → first compiling model → tutorials.
- The deploy workflow is valid and targets `…github.io/Koine/`.
- README links to the published docs site.

---

## Risks & mitigations

- **Invented syntax** (demo won't compile / docs mislead) → mandatory grammar+test verification
  before writing any construct; green build is the gate; doc snippets cross-checked against the demo.
- **Directory-mode build regressions** in the demo `.csproj` → change is isolated and validated by
  the existing demo compile; revert to per-file if a blocker surfaces and scope imports accordingly.
- **Pages base-path mistakes** (broken assets) → `base: '/Koine/'` set explicitly; verified by a
  local `npm run build` + link check.
- **Docs drift from reality** → grounding rule + critic pass tying every claim to a source artifact.

## Branch & sequencing

Branch `feat/demo-showcase-and-docs`. Sequence: Part 1 (demo, green build) **first** — directly,
with a tight author→build→fix loop grounded by a parallel syntax-extraction pass — so the docs in
Part 2 (dynamic workflow) can reference a real, compiling domain. Commit in logical chunks.
