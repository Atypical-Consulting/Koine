# Koine

**Koine** is a domain-specific language for **Domain-Driven Design**. You write the *ubiquitous
language* of a domain once, in `.koi` files, and the Koine compiler generates the idiomatic,
boilerplate-heavy tactical code — value objects, entities, aggregates, invariants — in a target
language.

The name evokes Koine Greek, the *common* language that became a lingua franca. The long-term goal
is to compile one domain model to many targets (C#, TypeScript, Rust). **This release targets C#
only**, but the architecture keeps the parser and semantic model strictly target-agnostic so a second
emitter can be added without touching them.

---

## Quick start

```bash
# Build everything and run the tests
./build.sh                       # or: dotnet build && dotnet test

# Compile a domain model to C#
dotnet run --project src/Koine.Cli -- build examples/billing.koi --target csharp --out ./generated

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
  → IEmitter (Emit/CSharp/CSharpEmitter) → C# source files
```

```
Koine.sln
├── src/
│   ├── Koine.Compiler/
│   │   ├── Grammar/        # KoineLexer.g4, KoineParser.g4
│   │   ├── Ast/            # semantic model + ModelIndex (NO C# concepts)
│   │   ├── Parsing/        # KoineModelBuilderVisitor, SyntaxErrorListener
│   │   ├── Semantics/      # SemanticValidator
│   │   ├── Emit/           # IEmitter + EmittedFile
│   │   │   └── CSharp/     # CSharpEmitter (the only emitter for now)
│   │   ├── Diagnostics/    # Diagnostic
│   │   └── Services/       # KoineCompiler (orchestrator)
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
  `query`, `when`, `if`, …) may now
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

---

## Tech stack

- .NET 10, C#
- ANTLR 4 via `Antlr4BuildTasks` + `Antlr4.Runtime.Standard` (visitor, not listener)
- Tests: xUnit, [Verify](https://github.com/VerifyTests/Verify) snapshots, and an in-memory **Roslyn**
  meta-test that compiles and executes the emitted C#.

## Status

Epics 0–5 of the brief are implemented: scaffold & pipeline, value objects (incl. regex invariants),
entities & identity, aggregates/enums/derived fields, semantics & diagnostics, and codegen/CLI ergonomics.

## Demo

[`demo/`](demo/) models a small Shop domain across three bounded contexts and consumes the
generated C# from a real .NET project (`dotnet build demo/Shop.Domain` regenerates and compiles it).

## Editor support

[`tooling/koine-textmate`](tooling/) is a TextMate grammar for `.koi` that works in **JetBrains Rider**
and **VS Code** — see [`tooling/README.md`](tooling/README.md) for one-step import.

For **live error squiggles** in the editor, run the bundled language server (`koine lsp`) and point
Rider at it via the LSP4IJ plugin — setup in [`tooling/README.md`](tooling/README.md#live-diagnostics-language-server).
It reuses the compiler's parser + validator, so editor diagnostics match `koine build`.

## Roadmap

The full gap analysis toward a complete DDD implementation — commands, events, policies, repositories,
read models, context mapping, and the TypeScript/Rust emitters — is captured as actionable user stories
in [`USER-STORIES.md`](USER-STORIES.md). In short: `command` / `event` / `policy`, repository interfaces,
then a second emitter (TypeScript) to prove the semantic model is truly target-agnostic, then Rust
(errors as `Result<T,E>` rather than exceptions).
