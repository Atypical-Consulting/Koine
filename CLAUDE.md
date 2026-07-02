# CLAUDE.md

Guidance for Claude Code working in the **Koine** project. This file is authoritative for this
subdirectory; the workspace-level `C:\repo\POC\CLAUDE.md` applies on top of it.

## What this is

Koine is a **domain-specific language for Domain-Driven Design**. You write a bounded context's
ubiquitous language once in `.koi` files and the compiler emits idiomatic, self-contained C#
(value objects, entities, aggregates, invariants, commands, events, state machines, repositories,
the application/CQRS layer, context maps, etc.). C# is the primary, most complete target; TypeScript,
Python, PHP, and Rust emitters also ship, and the parser and semantic model are kept strictly
target-agnostic so a further emitter is a new project, not a rewrite. Each backend lives in its own
`src/Koine.Emit.<Target>` assembly over a shared `Koine.Emit.Common` (issue #861).

Read `README.md` for the language overview and the full construct table, and `USER-STORIES.md` for the
roadmap (work is organized as releases **R1–R17**). The docs site source lives in `website/` (Astro
Starlight). The package version lives in `Directory.Build.props` and is bumped automatically by
release-please from Conventional Commits — don't hand-edit it (see
[ADR 0002](adr/0002-conventional-commits-and-automated-semver.md)).

## Architecture decisions (ADRs)

Significant architecture or process decisions (a new emitter target, a change to the compiler
pipeline layering, a new cross-cutting validator, CI/release-process changes, a dependency the whole
repo will lean on) **must** be captured as an Architecture Decision Record under
[`/adr/`](adr/README.md) before or alongside the implementing PR — copy `adr/template.md` to the
next `NNNN-title.md`, fill in Context/Decision/Consequences, and add it to `adr/README.md`'s index.
A change that contradicts an `Accepted` ADR needs a new ADR that supersedes it, not silent drift.
Skip an ADR for routine bug fixes and refactors that don't change a decision already on record.

## Commit identity (important)

Per the workspace rule, commit with the GitHub identity, not the work email:

```bash
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "..."
```

PR titles (which become the squash-merge commit message) **must** follow [Conventional
Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`,
`test:`, `ci:`, etc., optionally scoped (e.g. `fix(emit-cs): …`). This isn't just a style nit: CI
(`pr-title-lint.yml`) rejects a non-conforming title, and `release-please` parses these commits to
derive the next semantic version and changelog entry — see
[ADR 0002](adr/0002-conventional-commits-and-automated-semver.md).

## Build, test, run

.NET 10. Solution is the modern `Koine.slnx`. From this directory:

> **Prerequisite:** `Koine.slnx` includes `src/Koine.Wasm` (browser-wasm RID), so a bare
> `dotnet build` / `dotnet test` over the solution needs the WebAssembly workloads. Install
> them once: `dotnet workload install wasm-tools wasm-experimental`. Without them the solution
> restore/build fails on the wasm project. (CI installs the same pair; see `.github/workflows/ci.yml`.)

```bash
./scripts/build/build.sh    # dotnet build && dotnet test (build.ps1 / build.cmd are equivalents)
dotnet build                # build only
dotnet test                 # run all tests (~1900)
dotnet test --filter "FullyQualifiedName~R9ValueObjectTests"   # a single test class

# Run the CLI
dotnet run --project src/Koine.Cli -- build templates/starters/billing/billing.koi --target csharp --out ./generated
dotnet run --project src/Koine.Cli -- build templates/starters/billing/billing.koi    # parse + validate only, no output
dotnet run --project src/Koine.Cli -- --version
```

`Directory.Build.props` sets `Nullable`, `ImplicitUsings`, `LangVersion latest`, `Deterministic`.
**`TreatWarningsAsErrors` is intentionally NOT set** — the generated demo code may emit warnings and
must still build, so don't add it.

### CLI commands (`src/Koine.Cli/Program.cs`)

`build` (compile/validate; `--target`, `--out`, `--glossary`, `--config`), `check` (model-versioning
compatibility against a `--baseline`), `fmt` (canonical formatter), `init` (scaffold), `watch`
(rebuild on change), `lsp` (language server over stdio), `mcp` (the MCP server — stdio by default, or
`--http [--port N] [--host H]` to serve it over HTTP for any client by URL; reuses `Koine.Mcp`'s
hosts). A path argument may be a single `.koi` file
**or a directory** — directory mode compiles every `.koi` under it as one model so cross-file
imports, context maps, and integration events resolve (R13/R14).

## Architecture (the pipeline is strictly layered — keep it that way)

```
.koi source
  → ANTLR lexer/parser   (src/Koine.Compiler/Grammar/KoineLexer.g4 + KoineParser.g4, visitor mode)
  → KoineModelBuilderVisitor (Parsing/) → semantic model (Ast/, NO C# concepts)
  → SemanticValidator (Semantics/) → diagnostics with line/column
  → IEmitter (Koine.Emit.CSharp/CSharpEmitter) → C# source files
```

The whole thing is orchestrated by `Services/KoineCompiler.cs`.

> **Emitters are separate assemblies (issue #861).** Each backend lives in its own packable
> `src/Koine.Emit.<Target>` project (`CSharp`, `TypeScript`, `Python`, `Php`, `Rust`, `Glossary`,
> `Docs`, `AsyncApi`, `OpenApi`), over a shared `Koine.Emit.Common` (helpers like `FactoryIdBinding`,
> `MarkdownDoc`, `OperatorNeedsAnalyzer`). `Koine.Compiler` keeps only the emit **contracts**
> (`IEmitter`, `IEmitterProvider`, `EmitterOptions`, `EmitterRegistry`, `EmitterLoader`) — the
> orchestrator needs them — plus target-agnostic model utilities the core also consumes
> (`ExprDescriber`, `Emit/Glossary/GlossaryModelBuilder`). The `Koine.Emit.All` aggregator owns
> `BuiltInEmitterProviders.All` and is what the CLI / MCP / Wasm / tests reference. **Emitter
> implementations live in the root `Koine.Compiler` namespace** (assembly name ≠ namespace); only the
> emit **contracts** stay under `Koine.Compiler.Emit`. So adding a target is a new
> `Koine.Emit.<Target>` project, never a change to `Ast/` or the contracts.

- **`Ast/`** is the target-agnostic semantic model (`SemanticModel`, `Nodes`, `Expressions`,
  `KoineType`, `ModelIndex`, `TypeResolver`). **No C#-specific concept belongs here** — that's the
  invariant that keeps multiple emitters possible.
- **`Semantics/`** holds the validators (`SemanticValidator` plus focused ones for CQRS, context
  maps, integration events, entity behaviors, expressions). Diagnostics carry source spans.
- **`Koine.Emit.CSharp`** is the C# emitter, split by concern across partial classes
  (`CSharpEmitter.ValueObjects.cs`, `.Entities.cs`, `.Aggregates.cs`, `.Behaviors.cs`, `.Cqrs.cs`,
  `.Runtime.cs`). Supporting pieces: `CSharpTypeMapper`, `CSharpNaming`, `CSharpExpressionTranslator`,
  `UsingCollector`, `CSharpEmitterOptions` (plus `OperatorNeedsAnalyzer`, now in `Koine.Emit.Common`
  since the five code emitters share it). `Koine.Emit.Glossary` emits the ubiquitous-language glossary;
  `Koine.Emit.{TypeScript,Python,Php,Rust}` are the additional language emitters; `Koine.Emit.Docs`,
  `Koine.Emit.AsyncApi`, `Koine.Emit.OpenApi` emit living docs and API specs. All these emitter
  implementations live in the root `Koine.Compiler` namespace (the emit contracts stay under
  `Koine.Compiler.Emit`).
- **`Services/`** also hosts the editor/tooling backend reused by `koine lsp`: `WorkspaceIndex`,
  `KoineLanguageService`, `SemanticTokenProvider`, `TokenLocator`, `RefactorService`,
  `CompatibilityChecker`.

The grammar is **split into a separate lexer grammar** so `matches /regex/` can use a lexer mode and
read a regex literal as one token without colliding with the `/` division operator. ANTLR sources are
generated at build time by `Antlr4BuildTasks` into `Grammar/gen/` — don't hand-edit generated parser
code; edit the `.g4` files.

## Testing stack & conventions

xUnit v3 + **Shouldly** assertions + **Verify** snapshots + an in-memory **Roslyn** meta-test
(`Microsoft.CodeAnalysis.CSharp`) that actually compiles and executes the emitted C#. Tests live in `tests/Koine.Compiler.Tests/`, with
files named per release (`R1ExpressionTests.cs` … `R17ToolingTests.cs`) plus focused suites.

- A **green build proves the domain**: emitted code is snapshot-tested *and* Roslyn-compile-tested, so
  a passing `dotnet test` means the generated C# is correct and usable.
- **Snapshots** (`Snapshots/`, `Conformance/Snapshots/`) are Verify `.verified.txt` files. When you
  intentionally change emitter output, review and accept the new `.received.txt` (the diff *is* the
  review of generated code). Don't blindly overwrite.
- The compiler exposes internals to the test and CLI projects via `InternalsVisibleTo`.
- The suite runs on **xUnit v3** with **Shouldly** assertions (`actual.ShouldBe(expected)`), matching the
  workspace house standard. Verify `await Verify(...)` snapshots and the Roslyn compile/execute meta-test
  are **not** assertions — leave them exactly as-is.

## Templates (`templates/`)

`templates/` is the **single validated source of truth** for Koine's example domains (issue #101). A
*template* is a folder holding one or more `.koi` files plus a `template.json` manifest. The manifest is
validated against [`templates/template.schema.json`](templates/template.schema.json) and carries: `id`
(must equal the folder name), `name`, `tagline`, `description`, `difficulty` (∈
`starter`/`beginner`/`intermediate`/`advanced`), `tags[]`, `contexts[]`, `coreAggregate`, `entryFile`
(must be a `.koi` file in the folder), `teaches[]`, and `icon`. The families today: single-file
**starters** (`starters/{billing,ordering,contextmap,values}`) and full domains
(`ticketing`, `pizzeria` (six contexts + an external Gateway), `saas-subscription`, `library`).

`TemplatesValidationTests` (in `tests/Koine.Compiler.Tests/`) compiles every template green and
validates each manifest against the schema — so a passing `dotnet test` proves all templates compile
and are well-described. The templates feed three consumers: the C# demo (below), Koine Studio's
template gallery, and the website playground (both via a build-time-generated manifest).

## The demo (`demo/Pizzeria.Domain`)

A real .NET project that regenerates and compiles the generated C# as part of its own build: an MSBuild
`KoineGenerate` target shells out to the CLI (`build <KoineModelsDir> --target csharp --out Generated/
--glossary glossary.md`) before `CoreCompile`. `KoineModelsDir` points at `templates/pizzeria` — the
demo compiles the pizzeria **template in place** rather than a local `Models/` copy, so building the
demo is what proves that template emits compiling C# end-to-end. So `dotnet build demo/Pizzeria.Domain`
is an end-to-end check that the CLI + emitter produce compiling code for a six-context pizzeria domain.
`Generated/` is wiped each build and excluded from the default compile glob; `glossary.md` is likewise
regenerated each build and git-ignored (not committed) — the committed reference copy is
`demo/reference/pizzeria.glossary.md`.

## When adding language features

Touch the layers in order and keep the boundary clean: grammar (`.g4`) → builder visitor (`Parsing/`)
→ semantic model (`Ast/`) → validators (`Semantics/`) → emitter (`Koine.Emit.<Target>`) → tests (a new
`R##…Tests.cs` with snapshot + Roslyn coverage). Never leak a C# concept into `Ast/`. Update `README.md`
/ `website/` reference docs and the feature catalogue when a construct's emitted shape changes.
