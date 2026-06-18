# Koine

---

## 1. Mission

**Koine** is a domain-specific language for **Domain-Driven Design**. A developer writes the *ubiquitous language* of a domain once, in `.koi` files, and the Koine compiler generates the idiomatic, boilerplate-heavy tactical code (value objects, entities, aggregates, invariants, events) in a target language. The name evokes Koine Greek — the *common* language that became a lingua franca — and the long-term goal of compiling one domain model to many targets.

**Long-term vision:** compile to C#, TypeScript, and Rust from a single model, keeping the domain model consistent across stacks.

**This iteration's scope: C# only.** Do not build other backends yet, but keep the architecture target-agnostic so a second emitter can be added later without touching the parser or semantic model.

---

## 2. Starting point & tech stack

- **.NET 10**, C#.
- **ANTLR 4** for lexing/parsing, via the `Antlr4BuildTasks` MSBuild integration + `Antlr4.Runtime.Standard` runtime, generating a **visitor** (not a listener).
- Scaffold from the **`phmatray/Antlr4Library`** template (`dotnet new antlr4`). It ships a CSV grammar + visitor as a reference; we replace the CSV sample with Koine. Mirror its conventions:
  - `Grammar/*.g4` — the ANTLR grammar.
  - A visitor class that walks the parse tree and builds a model (the template's `CSVVisitor` is the pattern to follow).
  - `Models/` for the produced model types, `Services/` for the orchestration entry points.
  - **NUKE** build (`scripts/build/build.sh` / `build.ps1` / `build.cmd`).
- Configure the ANTLR build to emit a visitor: in the project file set the `Antlr4` item with `Visitor="true" Listener="false"`.

If `dotnet new antlr4` is available in the environment, scaffold from it and strip the CSV sample. If not, reproduce the equivalent layout by hand.

---

## 3. Target solution structure

```
Koine.sln
├── src/
│   ├── Koine.Compiler/         # class library: grammar, parser, semantic model, emitter
│   │   ├── Grammar/Koine.g4
│   │   ├── Ast/                # semantic model (target-agnostic)
│   │   ├── Parsing/            # KoineModelBuilderVisitor : KoineBaseVisitor<…>
│   │   ├── Semantics/          # name/type resolution, validation, diagnostics
│   │   └── Emit/
│   │       ├── IEmitter.cs     # target-agnostic emitter interface
│   │       └── CSharp/         # CSharpEmitter — the only emitter for now
│   └── Koine.Cli/              # `koine` command-line entry point
└── tests/
    └── Koine.Compiler.Tests/   # grammar, semantic, and emitter (snapshot) tests
```

The pipeline is strictly layered so backends are pluggable:

```
.koi source
  → Lexer/Parser (ANTLR, generated from Koine.g4)
  → KoineModelBuilderVisitor → semantic model (Ast/)
  → semantic validation (Semantics/) → diagnostics with line/column
  → IEmitter (CSharpEmitter) → C# source files
```

The semantic model in `Ast/` must contain **no C#-specific concepts**. All C# decisions live in `Emit/CSharp/`.

---

## 4. The Koine language (v0)

### 4.1 Constructs to support in this iteration

`context`, `value`, `entity … identified by`, `aggregate … root`, `enum`, typed fields, derived fields (`= expression`), and `invariant`. Commands/events/policies are **roadmap, not v0** (see §9).

### 4.2 Example `.koi` file (use as a fixture and acceptance target)

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
      subtotal:  Money = unitPrice * quantity
    }

    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
      status:   OrderStatus = Draft
      invariant status == Draft when lines.isEmpty
    }
  }
}
```

### 4.3 Primitive type mapping (Koine → C#)

| Koine      | C#                         | Notes                                          |
|------------|----------------------------|------------------------------------------------|
| `String`   | `string`                   |                                                |
| `Int`      | `int`                      |                                                |
| `Decimal`  | `decimal`                  | use for money/quantities                       |
| `Bool`     | `bool`                     |                                                |
| `Instant`  | `DateTimeOffset`           | leave a TODO for an optional NodaTime mode     |
| `List<T>`  | `IReadOnlyList<T>`         | defensively copied in constructor              |
| `<XId>`    | generated ID value object  | from `identified by XId`                        |

User-defined `value`, `entity`, and `enum` names resolve within their `context` (and enclosing `aggregate`) scope.

### 4.4 Grammar sketch (starting point for `Koine.g4`)

This is a guide, not the final grammar — refine it as the epics demand. Keep the expression sublanguage **small and pure** (no I/O, no statements).

```antlr
grammar Koine;

program        : contextDecl* EOF ;
contextDecl    : 'context' Identifier '{' typeDecl* '}' ;
typeDecl       : valueDecl | entityDecl | aggregateDecl | enumDecl ;

valueDecl      : 'value' Identifier '{' member* invariant* '}' ;
entityDecl     : 'entity' Identifier 'identified' 'by' Identifier
                 '{' member* invariant* '}' ;
aggregateDecl  : 'aggregate' Identifier 'root' Identifier '{' typeDecl* '}' ;
enumDecl       : 'enum' Identifier '{' Identifier (',' Identifier)* '}' ;

member         : Identifier ':' typeRef ( '=' expression )? ;
typeRef        : Identifier ( '<' typeRef '>' )? ;
invariant      : 'invariant' expression StringLiteral? ;

// minimal pure expression language: comparisons, arithmetic,
// member access, calls like lines.isEmpty, literals, regex `matches`,
// and a `when` guard suffix.
expression     : /* implement incrementally per epic */ ;

Identifier     : [a-zA-Z_][a-zA-Z0-9_]* ;
StringLiteral  : '"' (~["\\] | '\\' .)* '"' ;
WS             : [ \t\r\n]+ -> skip ;
LINE_COMMENT   : '//' ~[\r\n]* -> skip ;
```

---

## 5. Golden output: Value Object → C#

`value Money { amount: Decimal; currency: Currency; invariant amount >= 0 "…" }` must emit a **non-positional `record`** (so the validating constructor has a home, while keeping record value-equality over the declared properties):

```csharp
public sealed record Money
{
    public decimal Amount { get; }
    public Currency Currency { get; }

    public Money(decimal amount, Currency currency)
    {
        if (!(amount >= 0))
            throw new DomainInvariantViolationException(
                type: nameof(Money),
                rule: "a monetary amount cannot be negative");

        Amount = amount;
        Currency = currency;
    }
}
```

- **Value objects** → `sealed record` with get-only properties, validating constructor, value equality.
- **Entities** → `sealed class` whose `Equals`/`GetHashCode` use **only the identity**; the ID (`OrderId`) is itself a generated value object wrapping a `Guid`.
- **Derived fields** (`subtotal = unitPrice * quantity`) → computed get-only properties.
- **Invariants** → guard clauses in the constructor (and re-checked after any state transition once commands land). A shared `DomainInvariantViolationException` carries the type name and the rule message.
- Emit **one file per top-level type**, namespaced after the `context` (e.g. `Billing`). Emitted code must itself compile.

---

## 6. User stories

Personas: **Domain Developer** (writes `.koi`), **Compiler Maintainer** (builds Koine). Stories are grouped into epics — ship them in order. Each story is done only when its acceptance criteria (AC) pass with tests.

### Epic 0 — Scaffold & pipeline
- **0.1** As a Compiler Maintainer, I want the solution scaffolded from the Antlr4Library template with the CSV sample replaced by `Koine.g4`, so that `dotnet build` regenerates a Koine lexer/parser/visitor.
  - AC: solution has `Koine.Compiler`, `Koine.Cli`, `Koine.Compiler.Tests`; building regenerates parser from `Koine.g4`; ANTLR configured for visitor-only; `koine --version` runs.
- **0.2** As a Compiler Maintainer, I want a `koine build <file.koi>` CLI command that parses a file and reports syntax errors with line/column, so I have an end-to-end skeleton to grow.
  - AC: valid file exits 0; a syntax error prints `file:line:col: message` and exits non-zero.

### Epic 1 — Value objects (the first vertical slice)
- **1.1** As a Domain Developer, I want to declare a `value` with typed fields and have Koine emit an immutable C# `record` with value equality, so I stop hand-writing equality/immutability.
  - AC: `Money` emits per §5 (minus the invariant); two equal-valued instances are `Equal`; properties are get-only.
- **1.2** As a Domain Developer, I want `invariant <expr> "<message>"` on a value to become a constructor guard that throws on violation, so invalid value objects cannot exist.
  - AC: constructing `Money(-1, …)` throws `DomainInvariantViolationException` with the message; `Money(0, …)` succeeds.
- **1.3** As a Domain Developer, I want a `matches /regex/` invariant (e.g. `Email`), so I can validate string shapes.
  - AC: `Email` validates against the pattern; invalid input throws.

### Epic 2 — Entities & identity
- **2.1** As a Domain Developer, I want `entity X identified by XId` to emit a class with identity-based equality plus a generated `XId` value object, so identity semantics are correct by default.
  - AC: `Customer` equality compares only `CustomerId`; `CustomerId` is a `record` wrapping a `Guid`; two customers with the same id but different names are `Equal`.

### Epic 3 — Aggregates, enums & derived fields
- **3.1** As a Domain Developer, I want `enum` declarations emitted as C# enums and usable as field types.
  - AC: `OrderStatus` emits; `status: OrderStatus = Draft` compiles with the default.
- **3.2** As a Domain Developer, I want `aggregate Order root Order` to emit the nested value/entity/enum types within the aggregate's namespace, with the root marked, so the aggregate boundary is explicit.
  - AC: all nested types emit; the root is annotated (e.g. an `IAggregateRoot` marker or attribute).
- **3.3** As a Domain Developer, I want derived fields (`subtotal = unitPrice * quantity`) emitted as computed properties.
  - AC: `OrderLine.Subtotal` is a get-only computed property; no setter, not in the constructor.

### Epic 4 — Semantics & diagnostics
- **4.1** As a Domain Developer, I want clear compile errors for unknown type references, duplicate members, and invariants/expressions referencing unknown fields, with line/column, so modeling mistakes fail fast.
  - AC: each error case produces a precise diagnostic and a non-zero exit; valid models stay clean.
- **4.2** As a Domain Developer, I want `List<T>` fields defensively copied into `IReadOnlyList<T>`, so aggregates can't be mutated from outside.
  - AC: `lines` exposed as `IReadOnlyList<OrderLine>`; constructor copies the input.

### Epic 5 — Codegen output & CLI ergonomics
- **5.1** As a Domain Developer, I want `koine build model.koi --target csharp --out ./generated` to write one `.cs` file per type, namespaced by context, idempotently.
  - AC: re-running produces byte-identical output; files compile via `dotnet build` of the generated folder.

---

## 7. Definition of done (per story)

- Unit tests for the grammar: golden `.koi` inputs parse without errors; malformed inputs fail with the expected diagnostic.
- **Snapshot tests** on emitted C# (e.g. Verify) so output changes are reviewed deliberately.
- A meta-test that **compiles the emitted C#** in-memory (Roslyn) and asserts success — the generated code must always build.
- `README` updated with the current language surface and a runnable example.
- The full `.koi` fixture in §4.2 parses, validates, and emits compiling C# once Epics 1–3 are complete.

---

## 8. Non-goals for v0 (do not build yet)

- Any target other than C# (keep the seam, skip the implementation).
- Commands, domain events, policies/sagas, repositories, and `native { … }` escape hatches.
- Method bodies / imperative logic beyond declarative invariants and derived expressions.
- LSP / editor tooling.

---

## 9. Roadmap (context only — don't implement now)

After v0: `command` (preconditions + state transitions + `emits`), `event`, `policy` (cross-aggregate reactions), repository interfaces, then a second emitter (TypeScript) to validate that the semantic model is truly target-agnostic, then Rust (where error handling maps to `Result<T, E>` rather than exceptions). Keep these in mind when shaping the `Ast/` and `IEmitter` boundaries.

---

## 10. Working agreement

- One user story per commit/PR, in epic order; never start an epic before the previous one is green.
- Run the build and the test suite before declaring a story done; never leave the tree red.
- Treat the semantic model as the contract: if a change would leak C# concepts into `Ast/`, stop and reconsider.
- Ask before introducing heavy dependencies; prefer the .NET BCL + ANTLR runtime.
