---
title: "Architecture"
description: "How the Koine compiler is layered, the design decisions behind the emitted C#, and where a second emitter plugs in."
---

Koine is built as a **strictly layered pipeline**. Each stage hands a richer artifact to the next and never reaches backwards: the parser doesn't know about semantics, the semantic model doesn't know about C#, and the emitter is the only place a target language exists. That discipline is the whole point — it's what lets a TypeScript or Rust backend slot in later without touching anything upstream.

This page walks the pipeline stage by stage, explains the notable design decisions baked into the emitter, describes how the compiler is tested, and shows exactly where a new emitter would attach.

## The pipeline

```
.koi source file(s)
  → Lexer / Parser           (ANTLR, from Grammar/KoineLexer.g4 + KoineParser.g4)
  → KoineModelBuilderVisitor  (Parsing/) → builds the semantic model
  → merge same-named contexts (R13.1 — open/additive contexts)
  → semantic model            (Ast/ + ModelIndex) — target-agnostic, NO C# concepts
  → SemanticValidator         (Semantics/) → diagnostics with file/line/column
  → IEmitter                  (Emit/) → CSharpEmitter (Emit/CSharp/)
  → EmittedFile[]             (relative path + contents)
```

The whole thing is orchestrated by `KoineCompiler` (`src/Koine.Compiler/Services/`), whose `Compile(sources, emitter)` method runs every stage and returns a `CompileResult` (the model, all diagnostics, and the emitted files). The CLI is a thin shell over it — see the [CLI reference](/Koine/guides/cli/).

### 1. Lexer and parser (ANTLR)

The grammar lives in two `.g4` files under `Grammar/`. Splitting it into a **separate lexer grammar** (`KoineLexer.g4`) and parser grammar (`KoineParser.g4`) isn't cosmetic: it lets `matches /regex/` use a dedicated lexer mode so a regex literal is read as a single token without the `/` colliding with the division operator.

ANTLR generates a lexer and parser; Koine drives them with the **visitor** pattern (not listeners). Syntax errors are captured by a `SyntaxErrorListener` that records each diagnostic against its own source file. If lexing or parsing fails, the pipeline stops here and returns syntax diagnostics — no model is built.

:::note[Atomic operators]
Three multi-character operators — `<-` (field initialization), `->` (state transition / directed relation), and `<->` (bidirectional relation) — are single atomic lexer tokens, ordered before `<`, `-`, and `>` for maximal munch. This is why you write `n <- v`, never `n < - v`. See [operator spacing](/Koine/reference/overview/#a-note-on-operator-spacing).
:::

### 2. The model builder

`KoineModelBuilderVisitor` (`Parsing/`) walks the ANTLR parse tree and produces the **semantic model**: a tree of plain records in `Ast/` (`Nodes.cs`, `Expressions.cs`). This is the heart of the target-agnostic design. The model speaks pure domain vocabulary — contexts, value objects, entities, aggregates, invariants, commands — and knows nothing about `sealed record`, `IReadOnlyList<T>`, or any other C# shape.

Helpers in `Ast/` keep the model self-describing without leaking a target:

- `ModelIndex` — a lookup over every declared type, used everywhere downstream to resolve a name to its declaration. It also owns the reserved built-in generic names (`List`, `Set`, `Map`, `Range`).
- `TypeResolver`, `MemberAnalysis`, `BuiltinOps` — pure semantic queries (is this type orderable? is this member derived? what operators does this value object need?) that are equally true regardless of the eventual target.

### 3. Merge

When you run `koine build` on a directory, every `.koi` file under it is parsed separately and then **merged into one model** (R13.1). Contexts of the same name are *open and additive*: their declarations, imports, specs, services, policies, and integration wiring concatenate in first-seen order. Each declaration keeps the filename it came from, so a later diagnostic still points at the right file. See [multi-file models](/Koine/reference/multi-file-imports-modules/).

### 4. Semantic validation

`SemanticValidator` (`Semantics/`) walks the merged model and produces a flat list of `Diagnostic`s, each with a stable code (`KOI0908`, …), a severity, and a precise file/line/column. This is where every rule beyond grammar lives: unknown types, invariant type-checking, quantity cardinality, reserved names, identity-strategy backings, repository operation sets, cross-context import resolution, and so on. `ExpressionChecker` type-checks the expression sublanguage; `Suggestions` powers "did you mean…?" hints.

Crucially, **the same validator runs in the editor**. The language server (`koine lsp`) reuses `KoineCompiler.Diagnose`, so the squiggles you see in Rider or VS Code are exactly the errors `koine build` reports. Nothing about diagnostics is C#-specific.

If validation produces any error-severity diagnostic, the pipeline stops before emission.

### 5. Emission

Only now does a target language enter the picture. The emitter implements one small interface (`Emit/IEmitter.cs`):

```csharp
public sealed record EmittedFile(string RelativePath, string Contents);

public interface IEmitter
{
    string TargetName { get; }
    IReadOnlyList<EmittedFile> Emit(KoineModel model);
}
```

`CSharpEmitter` (`Emit/CSharp/`) is the primary implementation; `TypeScriptEmitter` (`Emit/TypeScript/`) and `PythonEmitter` (`Emit/Python/`) also ship. Each takes the validated model and produces a set of `EmittedFile`s — relative path plus file contents — which the CLI writes to `--out`. The C# emitter's work is split across focused collaborators:

- `CSharpEmitter` — orchestrates which files to emit and assembles them.
- `CSharpTypeMapper` — maps Koine primitives to C# (`Decimal` → `decimal`, `List<T>` → `IReadOnlyList<T>`, `Instant` → `DateTimeOffset`).
- `CSharpExpressionTranslator` — turns the pure expression sublanguage into C# expressions (`lines.isEmpty` → `Lines.Count == 0`, `lines.sum(l => l.qty)` → `.Sum(...)`).
- `CSharpNaming` — applies C# casing conventions (camelCase fields → PascalCase properties) and verbatim-escapes keywords.

A `GlossaryEmitter` (`Emit/Glossary/`) proves the seam works for a non-code target: it emits a Markdown glossary of the ubiquitous language instead of code (`--target glossary`). `TypeScriptEmitter` (`Emit/TypeScript/`) and `PythonEmitter` (`Emit/Python/`) prove it works for different programming languages.

## Notable design decisions

These are the choices that shape the emitted C#. They live entirely in the emitter — the semantic model stays neutral.

### ID convention

Any `*Id` type referenced as a field type (e.g. `customer: CustomerId`) is generated as an ID value object **even if no entity declares it** via `identified by`. This means a context can reference another aggregate's identity by name without redeclaring it. See [entities & identity](/Koine/reference/entities-and-identity/).

### Aggregate namespacing

Every type of a context — including aggregate-owned nested types — is emitted into the single `<Context>` namespace. The aggregate boundary is expressed not by a nested namespace but by the root entity implementing `IAggregateRoot`. This keeps generated cross-references flat and avoids a namespace-vs-type-name clash. See [aggregates](/Koine/reference/aggregates/).

### Value-object scalar arithmetic

So that a derived field like `subtotal: Money = unitPrice * quantity` (a `Money * int`) compiles, a value object with exactly one numeric field that gets multiplied by a scalar receives a generated scalar `*` operator: it scales the numeric field and carries the rest of the fields unchanged. **Only the operators actually used are generated** — the compiler analyzes every expression in the model first. See [value objects](/Koine/reference/value-objects/).

### Self-contained runtime

Shared runtime types — `DomainInvariantViolationException`, `IAggregateRoot`, `ConcurrencyConflictException`, `Range<T>`, `IQueryHandler<TQuery, TResult>` — are emitted **once** into a `Koine.Runtime` namespace, and only when something actually uses them. The generated code therefore has **no external package dependency**: it compiles on its own. See [reading the output](/Koine/start/reading-the-output/).

### Verbatim C# keyword fields

A Koine field whose name happens to be a C# keyword (e.g. `base`, `event`) is emitted as a verbatim identifier (`@base`, `@event`) so the output always compiles. This is a target-specific concern, so it lives in `CSharpNaming` — a TypeScript emitter would handle reserved words its own way.

## Beyond emission: tooling services

The same target-agnostic model feeds three services that aren't emitters at all — they live alongside the pipeline and reuse its earlier stages.

### The formatter

`KoineFormatter` (`Formatting/KoineFormatter.cs`) is a **token-stream reprinter**, not an AST printer. It lexes the source (so ordinary comments ride along as tokens) and re-emits the tokens with canonical whitespace, returning a `FormatResult(Text, Changed)`. Driving off the token stream — and re-emitting each token's exact text — makes the formatter total and **idempotent**: it never reflows or rewrites token content, only normalizes the spacing between tokens, so it can format any lexable file (even one that wouldn't pass semantic validation) and formatting twice is identical to formatting once. The CLI's `koine fmt` (and its `--check` mode) is a thin shell over it.

### The workspace index and language service

The editor experience is split into two reusable, LSP-free pieces so the same logic backs every editor:

- `WorkspaceIndex` (`Services/WorkspaceIndex.cs`) builds a **cross-file** view: it resolves a declaration reference (a type name, an `*Id`, a member) to the file URI and 1-based span that *declares* it, and renders the hover markdown card for it. Because it indexes every `.koi` in the workspace, an `OrderId`/`ProductId` reference resolves to the `entity … identified by …` that owns it even when that lives in another file.
- `KoineLanguageService` (`Services/KoineLanguageService.cs`) is the editor-facing query surface — completion candidates, hover cards, and go-to-definition targets — expressed in plain records with **no LSP or JSON concepts**. The `koine lsp` shell maps those records onto the wire protocol, and the diagnostics it serves come straight from `KoineCompiler`, so editor squiggles match `koine build` exactly.

### The compatibility checker

`CompatibilityChecker` (`Services/CompatibilityChecker.cs`) powers `koine check`. It takes a baseline model and a current model and **diffs only their published surfaces** — integration events, shared-kernel types, open-host value objects — classifying each change as breaking or non-breaking and returning them in deterministic order. Internal refactors are invisible to it by construction. The CLI exits non-zero when any change is breaking; see [versioning & evolution](/Koine/reference/versioning/) for the rules.

## How it's tested

The compiler's correctness rests on two complementary kinds of test in `tests/Koine.Compiler.Tests/`:

- **[Verify](https://github.com/VerifyTests/Verify) snapshots.** Each epic's fixtures emit C# that is snapshotted to a `.verified.cs` file. Any change to the emitted shape shows up as a reviewable diff, so emission is pinned exactly.
- **A Roslyn compile meta-test.** This is the load-bearing one: it takes the emitted C# and **compiles it in-memory with Roslyn** (and, for several fixtures, executes it). A snapshot can look right and still not compile; this test guarantees every shipped example is real, working C#. It's why every full `.koi` snippet in this documentation is copy-paste valid.

On top of these sit ordinary parsing and semantic unit tests that assert specific diagnostics (codes, messages, positions) for malformed models.

## Where a second emitter plugs in

Because every stage before emission is target-agnostic, adding a TypeScript, Python, or Rust backend is a **closed, additive change**:

1. Write a new class implementing `IEmitter` — say `PythonEmitter` — with `TargetName => "python"` and an `Emit(KoineModel model)` that walks the same `Ast/` model and returns `EmittedFile`s.
2. Register it in the CLI's `EmitterRegistry` (`src/Koine.Cli/Infrastructure/EmitterRegistry.cs`), next to `"csharp" => new CSharpEmitter()`.
3. Add a toolchain compile meta-test for the new target (e.g. `mypy --strict` for Python, `tsc --noEmit` for TypeScript, `cargo check` for Rust) plus Verify snapshots.

That's the entire surface area. You don't touch the grammar, the model builder, the `Ast/` model, or `SemanticValidator` — they already produce a portable model. The design decisions above (where to put a runtime type, how to escape a reserved word, which operators to synthesize) are re-answered inside the new emitter for its target language; the semantic facts they're answered *from* (`MemberAnalysis`, `BuiltinOps`, `TypeResolver`) are shared.

:::tip[Different targets, different idioms]
A Rust emitter would likely model invariant failures as `Result<T, E>` instead of throwing exceptions — a target-idiom choice that lives wholly in the emitter. The model just says "this construction has these preconditions"; how that becomes an exception, a `Result`, or a thrown `Error` is the emitter's call. See the [roadmap](/Koine/guides/roadmap/) for the planned target order.
:::

## Where to next

- [Reading the output](/Koine/start/reading-the-output/) — what the C# emitter actually produces, file by file.
- [Language reference overview](/Koine/reference/overview/) — the construct-by-construct spec the model is built from.
- [CLI reference](/Koine/guides/cli/) — the `koine build` / `koine check` flags that drive the pipeline.
- [Roadmap](/Koine/guides/roadmap/) — the shipped TypeScript and Python emitters, and the planned Rust emitter.
