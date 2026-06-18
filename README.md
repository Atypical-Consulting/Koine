# Koine

> Write the *ubiquitous language* of your domain once, in `.koi` files — Koine compiles it to
> idiomatic, self-contained C#.

[![Documentation](https://img.shields.io/badge/docs-koine-3245b8)](https://atypical-consulting.github.io/Koine/)
[![.NET](https://img.shields.io/badge/.NET-10-512BD4)](https://dotnet.microsoft.com/)
[![Tests](https://img.shields.io/badge/tests-670%2B%20passing-2ea44f)](tests/)
![Target](https://img.shields.io/badge/emits-C%23%20%C2%B7%20TypeScript-178600)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Koine** is a domain-specific language for **Domain-Driven Design**. Instead of hand-writing the
boilerplate-heavy tactical code — value objects, entities, aggregates, invariants, repositories — you
describe a bounded context in a small, readable DSL and the Koine compiler generates it for you.

The name evokes Koine Greek, the *common* language that became a lingua franca. The goal is to compile
one domain model to many targets. **C# is the primary, most complete target**; a **TypeScript** emitter
also ships (`--target typescript`), a **docs** target emits living documentation (`--target docs` →
Markdown + Mermaid diagrams) straight from the model, and the architecture keeps the parser and semantic
model strictly target-agnostic so further emitters (e.g. Rust) can be added without touching them.

📖 **Read the docs → <https://atypical-consulting.github.io/Koine/>** — getting started, a six-part
tutorial, a complete language reference, the feature catalogue, and the CLI. (Source in
[`website/`](website/); run locally with `cd website && npm install && npm run dev`.)

## Why Koine?

- **One source of truth.** The model *is* the ubiquitous language — no drift between the glossary
  and the code.
- **Idiomatic, dependency-free output.** Generated C# is plain, readable, and self-contained; the
  `Koine.Runtime` markers are emitted alongside it, so there's nothing to reference.
- **The whole tactical *and* strategic toolkit.** Value objects, entities, aggregates, smart enums,
  invariants, commands, domain events, state machines, factories, specifications, services,
  policies, repositories, optimistic concurrency, the application layer (UoW, read models, CQRS),
  multi-file modules, context maps, integration events, and model versioning — all shipped.
- **A green build proves the domain.** The emitted code is snapshot- and Roslyn-compile-tested; a
  passing build means a correct, usable domain.

---

## Quick start

```bash
# Build everything and run the tests
./scripts/build/build.sh         # or: dotnet build && dotnet test

# Compile a domain model to C#
dotnet run --project src/Koine.Cli -- build examples/billing.koi --target csharp --out ./generated

# Generate living documentation (Markdown + Mermaid state/class/context-map diagrams)
dotnet run --project src/Koine.Cli -- build examples/billing.koi --target docs --out ./docs

# Just check a model parses & validates (no output)
dotnet run --project src/Koine.Cli -- build examples/billing.koi

# Version
dotnet run --project src/Koine.Cli -- --version
```

The generated C# in `./generated` is self-contained and compiles on its own.

---

## The language (v0)

A `.koi` file declares one or more bounded `context`s. Inside a context you declare value objects,
entities, aggregates, and enums.

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
| `name: Type = const` | a constructor parameter with a default value (an enum default becomes a nullable param coalesced to the smart-enum instance, since it isn't a compile-time constant) |
| `name: Type = expr` (refs siblings) | a derived, get-only **computed** property (not in the constructor) |
| `invariant <expr> "msg"` | a constructor guard that throws `DomainInvariantViolationException` |
| `invariant <expr> matches /re/ …` | a regex guard (`Regex.IsMatch`) |
| `invariant <body> when <cond>` | a conditional guard (`if (cond && !body) throw`) |

### Expression sublanguage

Small and pure (no statements, no I/O): comparisons (`== != < <= > >=`), arithmetic (`+ - * /`),
logical (`&& || !`), member access (`lines.isEmpty`), regex `matches /…/`, a `when` guard, identifiers,
and literals.

### Primitive type mapping (Koine → C#)

| Koine | C# | Notes |
|-------|----|-------|
| `String` | `string` | |
| `Int` | `int` | |
| `Decimal` | `decimal` | money / quantities |
| `Bool` | `bool` | |
| `Instant` | `DateTimeOffset` | (TODO: optional NodaTime mode) |
| `List<T>` | `IReadOnlyList<T>` | defensively copied in the constructor |
| `<XId>` | generated ID value object | a `record` wrapping a `Guid` |

---

## Architecture

The pipeline is strictly layered so backends are pluggable:

```
.koi source
  → Lexer/Parser (ANTLR, generated from Grammar/KoineLexer.g4 + KoineParser.g4)
  → KoineModelBuilderVisitor → semantic model (Ast/, target-agnostic)
  → SemanticValidator (Semantics/) → diagnostics with line/column
  → IEmitter (Emit/CSharp, Emit/TypeScript, …) → source files
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
│   │   │   ├── Glossary/   # ubiquitous-language glossary
│   │   │   └── Docs/       # living documentation (Markdown + Mermaid diagrams)
│   │   ├── Diagnostics/    # Diagnostic
│   │   └── Services/       # KoineCompiler (orchestrator) + LSP/tooling backend
│   └── Koine.Cli/          # `koine` command-line tool
└── tests/
    └── Koine.Compiler.Tests/   # parsing, semantic, snapshot (Verify), Roslyn compile meta-tests
```

The grammar is split into a separate **lexer grammar** so that `matches /regex/` can use a lexer mode —
this lets a regex literal be read as a single token without colliding with the `/` division operator.

### Notable design decisions

- **ID convention.** A `*Id` type referenced as a field type (e.g. `ProductId`) is generated as an ID
  value object even when no entity declares it via `identified by`.
- **Aggregate namespacing.** All types of a context — including aggregate-owned ones — are emitted into
  the single `<Context>` namespace; the aggregate boundary is expressed by the root entity implementing
  `IAggregateRoot`. (Keeps generated references simple and avoids a namespace/type name clash.)
- **Value-object scalar arithmetic.** So that `subtotal = unitPrice * quantity` (i.e. `Money * int`)
  compiles, a value object with exactly one numeric field that is multiplied by a scalar gets a generated
  scalar `*` operator (it scales the numeric field and carries the rest). Only the operators actually
  used are generated.
- **Self-contained runtime.** `DomainInvariantViolationException` and `IAggregateRoot` are emitted once
  into a `Koine.Runtime` namespace, so generated code has no external dependency.
- **C# keyword field names** (e.g. `base`, `event`) are emitted as verbatim identifiers (`@base`) so the
  output always compiles.

### Known limitations (v0)

- **Soft keywords.** Most Koine keywords (`context`, `value`, `quantity`, `entity`, `aggregate`, `enum`,
  `by`, `root`, `command`, `create`, `spec`, `on`, `service`, `operation`, `policy`, `as`, `natural`,
  `sequence`, `guid`, `versioned`, `repository`, `operations`, `find`, `usecase`, `readmodel`, `from`,
  `query`, `import`, `module`, `when`, `if`, …) may now
  be used as field names, and the declaration keywords additionally as type names and in expressions. The
  mode-switching `matches` and the `invariant` keyword remain reserved; the keywords are *not* usable in the
  few hard-`Identifier` positions (a type/command/state/enum-member name). Like `->`, the factory-initialization
  operator `<-` is atomic, so a comparison against a negative operand needs a space (`x < -1`, not `x<-1`).
- **Reserved type names.** `List`, `Set`, `Map`, and `Range` are built-in generics; a user type may not take
  one of these names.
- **Richer value objects.** Enum members may carry associated constant data
  (`enum Currency(symbol: String, decimals: Int) { EUR("€", 2) … }`; values are literals of a String/Int/
  Decimal/Bool field). A `quantity` is a value object with a `Decimal` amount and an enum unit, emitting
  unit-checked `+ - * /` (mixed-unit operations throw at runtime). `Range<T>` over an orderable `T`
  (Int/Decimal/Instant) generates a value object with `Start`/`End`, a `start <= end` invariant, and
  `Contains`/`Overlaps`.
- **Scoped enum members.** Bare enum members are resolved against the field/operand enum type, so two enums
  may share a member name (e.g. both `Cancelled`); a genuinely ambiguous bare member must be qualified
  (`OrderStatus.Cancelled`).
- **Specifications, services, policies.** A `spec Name on T = <bool expr>` is a reusable named predicate over
  `T`, referenceable by name in `T`'s invariants, command preconditions, derived fields, and other specs
  (cycle-checked). A `service` holds stateless `operation`s (pure expression bodies, or abstract seams). A
  `policy Name when Event then Target.command(args)` emits a handler interface plus an abstract seam — Koine
  records the intended cross-aggregate reaction but never generates the imperative call. A spec referenced
  from inside a service operation body is not yet supported (v0).
- **Identity strategies, repositories & concurrency.** An entity's identity defaults to a `Guid` wrapper
  with `New()`; `identified by Sku as natural(String)` emits a value-validated string key (no `New()`),
  `as natural(Int)` an `int` key, and `as sequence` a store-assigned `long` key. Every aggregate root gets
  an `I<Root>Repository` (async `GetByIdAsync`/`AddAsync`/`UpdateAsync`/`RemoveAsync`, keyed on its ID); a
  `repository { operations: add, getById … find byCustomer(c: CustomerId): List<Order> }` block restricts
  the mutating set and declares typed finders (`List<Root>` → `Task<IReadOnlyList<Root>>`, a single `Root`
  → `Task<Root?>`). Marking the aggregate `versioned` adds a get-only `Version` token and emits a shared
  `ConcurrencyConflictException` for optimistic-concurrency enforcement.
- **Application layer & CQRS.** Each context with an aggregate gets a generated `IUnitOfWork` (a repository
  property per aggregate plus `SaveChangesAsync`) — a pure abstraction with no infrastructure dependency. A
  `service` holding `usecase`s emits an `I<Service>` application interface whose async methods map the
  declared inputs/outputs. A `readmodel M from Src { … }` emits a flat, value-equal DTO record plus a static
  `ToM(this Src src)` projection mapper (direct fields map straight through; `total: Int = lines.count` style
  fields translate via the expression sublanguage). A `query Q(criteria): List<M>` emits a criteria DTO record
  handled through the generic `IQueryHandler<TQuery,TResult>` runtime interface.
- **Multi-file, imports & modules.** `koine build ./domain` compiles every `.koi` under a directory into one
  model — contexts of the same name across files are open/additive and merge; each diagnostic names its own
  source file. A context references another's types deliberately, via `import Billing.{ Money }` /
  `import Billing.*` or a fully-qualified `Billing.Money`; an un-imported or ambiguous cross-context reference
  is a coded error, and the emitter adds a precise `using` only for namespaces actually referenced. A
  `module Pricing { … }` (nestable) groups types into a `<Context>.<Module>` sub-namespace and folder.

---

## Tech stack

- .NET 10, C#
- ANTLR 4 via `Antlr4BuildTasks` + `Antlr4.Runtime.Standard` (visitor, not listener)
- Tests: xUnit, [Verify](https://github.com/VerifyTests/Verify) snapshots, and an in-memory **Roslyn**
  meta-test that compiles and executes the emitted C#.

## Status

Shipped through **R1–R17** of the roadmap — the full tactical *and* strategic DDD toolkit, a second
emitter target (**TypeScript**, R16) alongside C#, and the editor tooling (TextMate grammar, `koine lsp`
language server, and the `fmt`/`init`/`watch` commands). The
[feature catalogue](https://atypical-consulting.github.io/Koine/guides/feature-catalogue/) maps every
construct (R1–R17) to the C# it emits. A **docs** target also ships — `--target docs` emits living
documentation (Markdown with Mermaid state, class, context-map, and integration-event diagrams) straight
from the model. Next up: a **Rust** emitter (errors as `Result<T,E>` rather than exceptions) — see
[`USER-STORIES.md`](USER-STORIES.md).

## Demo

[`demo/`](demo/) models a Shop domain across **six bounded contexts** tied together by a context map,
and consumes the generated C# from a real .NET project (`dotnet build demo/Shop.Domain` regenerates
and compiles it). Between the `.koi` models and `Samples.cs` it exercises **the full shipped feature
set** — see [`demo/README.md`](demo/README.md) for the full feature-to-location map.

## Editor support

[`tooling/koine-textmate`](tooling/) is a TextMate grammar for `.koi` that works in **JetBrains Rider**
and **VS Code** — see [`tooling/README.md`](tooling/README.md) for one-step import.

For **live error squiggles, code completion, hover docs, and go-to-definition** in the editor, run the
bundled language server (`koine lsp`) and point Rider at it via the LSP4IJ plugin — setup in
[`tooling/README.md`](tooling/README.md#live-diagnostics-language-server).
It reuses the compiler's parser + validator, so editor diagnostics match `koine build`.
Hover and go-to-definition resolve **across all `.koi` files in the workspace** — e.g. an
`OrderId`/`ProductId` reference jumps to the `entity … identified by …` that owns it, even in another file.

## AI agents (MCP server)

[`src/Koine.Mcp`](src/Koine.Mcp) is an **MCP server** (`koine-mcp`) that lets an AI agent author a
complete domain in `.koi` over the [Model Context Protocol](https://modelcontextprotocol.io): tools
to `koine_validate`, `koine_compile` (csharp/typescript/glossary/docs), and `koine_format`, plus
`koine_reference` and `koine_examples` so the agent learns the language. It reuses the same parser,
validator, and emitters as `koine build`. Install with `dotnet tool install -g Koine.Mcp`, then add it
to your MCP client:

```json
{ "mcpServers": { "koine": { "command": "koine-mcp" } } }
```

From a checkout, `./scripts/install-mcp/install-mcp.sh` (or `install-mcp.ps1` / `install-mcp.cmd` in
the same folder) packs, installs, and
registers the server with **Claude Desktop** in one step.

See [`website` → Guides → MCP server](website/src/content/docs/guides/mcp-server.md) for the full
tool list and the typical author → validate → compile loop.

## Roadmap

The full roadmap — every release R1–R17 and what remains — is captured as actionable user stories in
[`USER-STORIES.md`](USER-STORIES.md). The tactical *and* strategic DDD toolkit (R1–R15), multi-target
emitters (R16: a TypeScript emitter alongside C#), and the editor tooling (R17) have shipped, as has a
**docs** target that emits living documentation (Markdown + Mermaid diagrams) from the model. What's
next: a **Rust** emitter (errors as `Result<T,E>` rather than exceptions) to further prove the semantic
model is truly target-agnostic.

## Contributing

Contributions are welcome! See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to build, test, and submit
a change, and please follow our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues should be reported
privately — see [`SECURITY.md`](SECURITY.md). Notable changes are tracked in [`CHANGELOG.md`](CHANGELOG.md).

## License

Koine is licensed under the **Apache License 2.0** — see [`LICENSE`](LICENSE). Copyright © 2026 Atypical
Consulting / Philippe Matray.
