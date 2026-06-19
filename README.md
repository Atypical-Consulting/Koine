# Koine

> Write your domain's **ubiquitous language** once, in `.koi` files. Koine compiles it to
> idiomatic, self-contained C# — value objects, entities, aggregates, invariants, the whole
> Domain-Driven Design toolkit.

[![Try it in your browser](https://img.shields.io/badge/try-in%20your%20browser-3245b8)](https://atypical-consulting.github.io/Koine/studio/)
[![Documentation](https://img.shields.io/badge/docs-koine-3245b8)](https://atypical-consulting.github.io/Koine/)
[![.NET](https://img.shields.io/badge/.NET-10-512BD4)](https://dotnet.microsoft.com/)
[![Tests](https://img.shields.io/badge/tests-950%2B%20passing-2ea44f)](tests/)
![Target](https://img.shields.io/badge/emits-C%23%20%C2%B7%20TypeScript%20%C2%B7%20Python%20%C2%B7%20PHP%20%C2%B7%20docs-178600)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## The problem

Domain-Driven Design gives you a precise vocabulary — value objects, entities, aggregates,
invariants, domain events, state machines — but in C# every one of those is a pile of mechanical
boilerplate: validating constructors, value equality, identity equality, defensive copies, guard
clauses, repository contracts. You write it by hand for every type. Then the model drifts from the
glossary on the wiki, the "ubiquitous language" stops being ubiquitous, and the rules you cared
about get buried in plumbing.

## The solution

**Koine is a small, readable DSL for DDD.** You describe a bounded context using the same words your
domain experts use, and the compiler emits the tactical code for you — correct, idiomatic, and with
no runtime to reference. The model *is* the ubiquitous language: there is no second copy to keep in
sync, and the rules stay front and centre instead of drowning in boilerplate.

The name evokes **Koine Greek**, the *common* language that became a lingua franca. The goal is to
compile one domain model to many targets. **C# is the primary, most complete target**; a
**TypeScript** emitter ships (`--target typescript`), a **Python** emitter ships (`--target python` →
dependency-free Python 3.11+, `mypy --strict`-clean; Phase 1 covers the tactical core), a **PHP 8.1**
emitter ships (`--target php` → dependency-free PHP 8.1, typed properties, readonly classes; Phase 1
covers the tactical core), a **docs** target emits living documentation (`--target docs` → Markdown +
Mermaid diagrams) straight from the model, and the parser and semantic model are kept strictly
target-agnostic so further emitters (e.g. Rust) can be added without touching them.

## See it run — in your browser

The Koine compiler is itself compiled to WebAssembly, so you can write a model and watch it become
C# without installing anything.

<p align="center">
  <a href="https://atypical-consulting.github.io/Koine/studio/">
    <img src="assets/koine-studio.png" width="100%"
         alt="Koine Studio: a .koi domain model on the left, the C# it compiles to on the right, with no diagnostics — running entirely in the browser." />
  </a>
</p>

<p align="center">
  <em>Koine Studio — your <code>.koi</code> model (left) and the C# it compiles to (right), live in the browser.</em>
</p>

- **[Koine Studio](https://atypical-consulting.github.io/Koine/studio/)** — the full web IDE: editor
  with live diagnostics, an emitted-code preview (C# / TypeScript), the ubiquitous-language glossary,
  context map, and model outline. *(Also ships as a native [Tauri](https://tauri.app/) desktop app —
  same UI, see [`tooling/koine-studio`](tooling/koine-studio).)*
- **[Playground](https://atypical-consulting.github.io/Koine/playground/)** — a lightweight,
  zero-install editor that recompiles to C#/TypeScript the moment you stop typing. Great for a quick
  taste or for following along with the [tutorial](https://atypical-consulting.github.io/Koine/start/your-first-model/).

> Both run the **same** parser, validator, and emitters as the `koine` CLI — what you see in the
> browser is exactly what the build produces.

📖 **Full docs → <https://atypical-consulting.github.io/Koine/>** — getting started, a six-part
tutorial, the complete language reference, the feature catalogue, and the CLI. (Source in
[`website/`](website/); run locally with `cd website && npm install && npm run dev`.)

## A taste of the language

A `.koi` file declares one or more bounded `context`s. Inside a context you declare value objects,
entities, aggregates, and enums:

```koine
context Billing {

  value Money {
    amount: Decimal
    currency: Currency
    invariant amount >= 0        "a monetary amount cannot be negative"
  }

  enum Currency { EUR, USD, GBP }

  value Email {
    raw: String
    invariant raw matches /^[^@]+@[^@]+$/   "invalid email address"
  }

  entity Customer identified by CustomerId {
    name: String
    email: Email
  }

  aggregate Order root Order {

    enum OrderStatus { Draft, Placed, Shipped, Cancelled }

    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Money
      subtotal:  Money = unitPrice * quantity     // derived (computed) field
    }

    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
      status:   OrderStatus = Draft               // default value
      invariant status == Draft when lines.isEmpty
    }
  }
}
```

That compiles to plain C# records and classes with validating constructors, value/identity equality,
a generated `OrderId`/`CustomerId`, an `IOrderRepository` contract, and the `Money * int` operator
needed for `subtotal` — nothing for you to write, and nothing external to reference.

## Why Koine?

- **One source of truth.** The model *is* the ubiquitous language — no drift between the glossary
  and the code.
- **Idiomatic, dependency-free output.** Generated C# is plain, readable, and self-contained; the
  `Koine.Runtime` markers are emitted alongside it, so there's nothing to install.
- **The whole tactical *and* strategic toolkit.** Value objects, entities, aggregates, smart enums,
  invariants, commands, domain events, state machines, factories, specifications, services,
  policies, repositories, optimistic concurrency, the application layer (UoW, read models, CQRS),
  multi-file modules, context maps, integration events, and model versioning — all shipped.
- **A green build proves the domain.** Every construct is snapshot-tested *and* compiled and executed
  through an in-memory Roslyn meta-test, so a passing build means the generated C# is correct and
  usable — not just that it parses.

## Quick start (CLI)

Requires **.NET 10**.

```bash
# Build everything and run the tests
./scripts/build/build.sh         # or: dotnet build && dotnet test

# Compile a domain model to C#
dotnet run --project src/Koine.Cli -- build examples/billing.koi --target csharp --out ./generated

# Emit to TypeScript instead
dotnet run --project src/Koine.Cli -- build examples/billing.koi --target typescript --out ./generated

# Or to Python (Phase 1: tactical core — value objects, smart enums, entities, events, repositories)
dotnet run --project src/Koine.Cli -- build examples/billing.koi --target python --out ./generated_py

# Or to PHP 8.1 (Phase 1: tactical core — value objects, smart enums, entities, events, repositories)
dotnet run --project src/Koine.Cli -- build examples/billing.koi --target php --out ./generated_php

# Generate living documentation (Markdown + Mermaid state/class/context-map diagrams)
dotnet run --project src/Koine.Cli -- build examples/billing.koi --target docs --out ./docs

# Just check a model parses & validates (no output)
dotnet run --project src/Koine.Cli -- build examples/billing.koi

# Version
dotnet run --project src/Koine.Cli -- --version
```

The generated C# in `./generated` is self-contained and compiles on its own. A path argument may be a
single `.koi` file **or a directory** — directory mode compiles every `.koi` underneath as one model,
so cross-file imports, context maps, and integration events resolve.

Other CLI commands: `check` (model-versioning compatibility against a `--baseline`), `fmt` (canonical
formatter), `init` (scaffold a project), `watch` (rebuild on change), and `lsp` (language server over
stdio). See the [CLI reference](https://atypical-consulting.github.io/Koine/guides/cli/).

## The language

### Constructs

| Construct | Emits |
|-----------|-------|
| `value X { … }` | `sealed record` with get-only properties, a validating constructor, value equality |
| `entity X identified by XId { … }` | `sealed class` with **identity-only** equality + a generated `XId` value object (Guid by default; `as natural(String\|Int)` or `as sequence` selects the strategy) |
| `aggregate A root R { … }` | nested types in the `<Context>` namespace; the root `R` implements `IAggregateRoot`, and an `I<R>Repository` contract is emitted for it |
| `aggregate A root R versioned { … }` | the root additionally gains a get-only `Version` token; `ConcurrencyConflictException` is emitted into `Koine.Runtime` |
| `repository { operations: … ; find name(p): List<R>\|R }` | tunes the root's repository — its mutating method set plus intention-revealing async finders |
| `service S { usecase U(p: T): R }` | an application-service interface `IS` with one async method per use case (`Task`/`Task<R>`); a context with aggregates also gets an `IUnitOfWork` |
| `readmodel M from Src { id; total: Int = … }` | a flat, value-equal DTO `record` + a static `ToM(this Src src)` projection mapper |
| `query Q(criteria): List<M>\|M` | a query DTO `record` handled via the shared generic `IQueryHandler<TQuery,TResult>` |
| `enum E { … }` | a self-contained **smart enum** (`sealed class`: static instances, `Name`/`Value`, `All`, `FromName`/`FromValue`, value equality, `==`/`!=`) |
| `name: Type` | a typed property + constructor parameter |
| `name: Type = const` | a constructor parameter with a default value |
| `name: Type = expr` (refs siblings) | a derived, get-only **computed** property (not in the constructor) |
| `invariant <expr> "msg"` | a constructor guard that throws `DomainInvariantViolationException` |
| `invariant <expr> matches /re/ …` | a regex guard (`Regex.IsMatch`) |
| `invariant <body> when <cond>` | a conditional guard (`if (cond && !body) throw`) |

The full construct set (commands, domain events, state machines, factories, specs, services,
policies, context maps, integration events, model versioning) is mapped construct-by-construct to the
C# it emits in the [**feature catalogue**](https://atypical-consulting.github.io/Koine/guides/feature-catalogue/).

### Expression sublanguage

Small and pure (no statements, no I/O): comparisons (`== != < <= > >=`), arithmetic (`+ - * /`),
logical (`&& || !`), member access (`lines.isEmpty`), regex `matches /…/`, a `when` guard,
identifiers, and literals.

### Primitive type mapping (Koine → C#)

| Koine | C# | Notes |
|-------|----|-------|
| `String` | `string` | |
| `Int` | `int` | |
| `Decimal` | `decimal` | money / quantities |
| `Bool` | `bool` | |
| `Instant` | `DateTimeOffset` | |
| `List<T>` | `IReadOnlyList<T>` | defensively copied in the constructor |
| `<XId>` | generated ID value object | a `record` wrapping a `Guid` |

### Current limitations

- **Soft keywords.** Most Koine keywords (`context`, `value`, `entity`, `aggregate`, `enum`, `command`,
  `service`, `policy`, `repository`, `readmodel`, `query`, `import`, `module`, …) may be used as field
  names, and declaration keywords additionally as type names and in expressions. Only `matches` and
  `invariant` remain reserved; keywords are *not* usable in the few hard-`Identifier` positions (a
  type/command/state/enum-member name). Because `<-` and `->` are atomic operators, a comparison against
  a negative operand needs a space (`x < -1`, not `x<-1`).
- **Reserved type names.** `List`, `Set`, `Map`, and `Range` are built-in generics; a user type may not
  take one of these names.
- **Specs in service operations.** A `spec` referenced from inside a `service` operation body is not yet
  supported.

## Architecture

The pipeline is strictly layered so backends are pluggable:

```
.koi source
  → Lexer/Parser (ANTLR, generated from Grammar/KoineLexer.g4 + KoineParser.g4)
  → KoineModelBuilderVisitor → semantic model (Ast/, target-agnostic)
  → SemanticValidator (Semantics/) → diagnostics with line/column
  → IEmitter (Emit/CSharp, Emit/TypeScript, Emit/Python, Emit/Php, …) → source files
```

```
Koine.slnx
├── src/
│   ├── Koine.Compiler/
│   │   ├── Grammar/        # KoineLexer.g4, KoineParser.g4
│   │   ├── Ast/            # semantic model + ModelIndex (NO target-specific concepts)
│   │   ├── Parsing/        # KoineModelBuilderVisitor, SyntaxErrorListener
│   │   ├── Semantics/      # SemanticValidator (+ focused validators)
│   │   ├── Emit/           # IEmitter + EmittedFile
│   │   │   ├── CSharp/     # CSharpEmitter (primary target)
│   │   │   ├── TypeScript/ # TypeScriptEmitter
│   │   │   ├── Python/     # PythonEmitter (Phase 1: tactical core)
│   │   │   ├── Php/        # PhpEmitter (Phase 1: tactical core, PHP 8.1)
│   │   │   ├── Glossary/   # ubiquitous-language glossary
│   │   │   └── Docs/       # living documentation (Markdown + Mermaid diagrams)
│   │   ├── Diagnostics/    # Diagnostic
│   │   └── Services/       # KoineCompiler (orchestrator) + LSP/tooling backend
│   ├── Koine.Cli/          # `koine` command-line tool
│   ├── Koine.Wasm/         # the compiler as a WebAssembly module (Playground + Studio web)
│   └── Koine.Mcp/          # MCP server for AI agents
└── tests/
    └── Koine.Compiler.Tests/   # parsing, semantic, snapshot (Verify), Roslyn compile meta-tests
```

The grammar is split into a separate **lexer grammar** so that `matches /regex/` can use a lexer mode —
this lets a regex literal be read as a single token without colliding with the `/` division operator.
The single most important invariant: **no C#-specific concept lives in `Ast/`** — that is what keeps
multiple emitters possible.

## Tooling

- **Web IDE.** [Koine Studio](https://atypical-consulting.github.io/Koine/studio/) and the
  [Playground](https://atypical-consulting.github.io/Koine/playground/) run the compiler in the
  browser (WebAssembly) — see [*See it run*](#see-it-run--in-your-browser) above. Studio also ships as
  a native desktop app ([`tooling/koine-studio`](tooling/koine-studio)).
- **Editor support.** [`tooling/koine-textmate`](tooling/) is a TextMate grammar for `.koi` that works
  in **JetBrains Rider** and **VS Code**. For **live error squiggles, completion, hover docs, and
  go-to-definition**, run the bundled language server (`koine lsp`) — it reuses the compiler's own
  parser + validator, so editor diagnostics match `koine build`, and hover/navigation resolve across
  every `.koi` file in the workspace. Setup in [`tooling/README.md`](tooling/README.md).
- **AI agents (MCP server).** [`src/Koine.Mcp`](src/Koine.Mcp) is an
  [MCP](https://modelcontextprotocol.io) server (`koine-mcp`) that lets an AI agent author a complete
  domain in `.koi`: tools to `koine_validate`, `koine_compile` (csharp/typescript/python/php/glossary/docs), and
  `koine_format`, plus `koine_reference` and `koine_examples` so the agent learns the language. Install
  with `dotnet tool install -g Koine.Mcp`, then register it:

  ```json
  { "mcpServers": { "koine": { "command": "koine-mcp" } } }
  ```

  From a checkout, `./scripts/install-mcp/install-mcp.sh` (or `.ps1` / `.cmd`) packs, installs, and
  registers the server with **Claude Desktop** in one step. Full tool list in the
  [MCP guide](https://atypical-consulting.github.io/Koine/guides/mcp-server/).

## Tech stack

- .NET 10, C#
- ANTLR 4 via `Antlr4BuildTasks` + `Antlr4.Runtime.Standard` (visitor, not listener)
- Tests: xUnit, [Verify](https://github.com/VerifyTests/Verify) snapshots, and an in-memory **Roslyn**
  meta-test that compiles and executes the emitted C#.

## Status & roadmap

Koine is at **v0.17.x** and has shipped through **R1–R17** of the roadmap: the full tactical *and*
strategic DDD toolkit, three more emitter targets (**TypeScript**, **Python**, and **PHP 8.1** — the
latter two Phase 1: tactical core) alongside C#, a **docs** target that emits living documentation
(Markdown + Mermaid diagrams), and the editor tooling (TextMate grammar,
`koine lsp` language server, and the `fmt` / `init` / `watch` commands). The
[feature catalogue](https://atypical-consulting.github.io/Koine/guides/feature-catalogue/) maps every
construct to the C# it emits.

**Next up:** a **Rust** emitter (errors as `Result<T,E>` rather than exceptions) to further prove the
semantic model is truly target-agnostic. The full roadmap lives in [`USER-STORIES.md`](USER-STORIES.md).

## Demo

[`demo/`](demo/) models a Shop domain across **six bounded contexts** tied together by a context map,
and consumes the generated C# from a real .NET project (`dotnet build demo/Shop.Domain` regenerates
and compiles it). Between the `.koi` models and `Samples.cs` it exercises **the full shipped feature
set** — see [`demo/README.md`](demo/README.md) for the feature-to-location map.

## Contributing

Contributions are welcome! See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to build, test, and submit
a change, and please follow our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues should be reported
privately — see [`SECURITY.md`](SECURITY.md). Notable changes are tracked in [`CHANGELOG.md`](CHANGELOG.md).

## License

Koine is licensed under the **Apache License 2.0** — see [`LICENSE`](LICENSE). Copyright © 2026 Atypical
Consulting / Philippe Matray.
