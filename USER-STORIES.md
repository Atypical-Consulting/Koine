# Koine — User Stories & DDD Roadmap

> The gaps between Koine **v0** (Epics 0–5 in [`BRIEF.md`](BRIEF.md) §6, all shipped) and a complete, production-grade Domain-Driven Design implementation — written as actionable user stories in the brief's style.

This roadmap was produced by analysing the current compiler (`src/Koine.Compiler`) against the DDD tactical *and* strategic patterns, then consolidating across four lenses: tactical building blocks, persistence & application layer, strategic design, and language/tooling/targets. Every story targets a **real gap** — nothing already implemented in v0.

## What v0 already delivers

`context`, `value`, `entity … identified by`, `aggregate … root`, `enum`, typed fields, derived fields, default values, invariants (incl. regex `matches` and `when` guards), a small pure expression language, `List<T>` → defensively-copied `IReadOnlyList<T>`, generated ID value objects, a shared `DomainInvariantViolationException` / `IAggregateRoot`, semantic diagnostics with line/column, and a C# emitter behind a target-agnostic `IEmitter` seam.

## How to read this

- Stories are grouped into **epics**, ordered roughly by delivery sequence (closest to current capability first). Dependencies generally precede dependents.
- Each story has a persona, an *As a … I want … so that …* statement, testable **acceptance criteria (AC)**, and a **priority**. Many include a proposed `.koi` snippet — illustrative, not final.
- Personas: **Domain Developer** (writes `.koi`), **Architect** (shapes contexts & integration), **Compiler Maintainer** (builds Koine).

### Epic index

1. **Expression Sublanguage Completeness** — 4 stories (3 high)
2. **Optionality & Richer Collections** — 2 stories (1 high)
3. **Compiler Quality & Diagnostics** — 5 stories (2 high)
4. **Ubiquitous Language Documentation & Glossary** — 2 stories (0 high)
5. **Commands & State Transitions** — 2 stories (2 high)
6. **Domain Events** — 3 stories (2 high)
7. **Entity Lifecycle & State Machines** — 2 stories (1 high)
8. **Factories & Lifecycle Creation** — 2 stories (0 high)
9. **Richer Value Objects** — 3 stories (0 high)
10. **Specifications, Domain Services & Policies** — 3 stories (0 high)
11. **Identity Strategies, Repositories & Optimistic Concurrency** — 4 stories (3 high)
12. **Application Services, Read Models & CQRS** — 4 stories (1 high)
13. **Multi-File Compilation, Imports & Modules** — 3 stories (2 high)
14. **Context Mapping & Integration Events** — 3 stories (3 high)
15. **Model Versioning & Evolution** — 2 stories (0 high)
16. **Multi-Target Emitters & Emitter Configuration** — 4 stories (2 high)
17. **Editor Tooling & Developer Experience** — 3 stories (0 high)

---

## Epic R1 — Expression Sublanguage Completeness

_v0's expression language (Ast/Expressions.cs) supports only comparisons, arithmetic, logical ops, member access with a single hardcoded `.isEmpty`, regex `matches`, and a `when` guard. Real DDD invariants and derived fields routinely need conditionals, string operations, collection predicates/aggregations, optionality, and date/time comparison. This is the lowest-risk, highest-frequency gap and a prerequisite for nearly every later epic (commands re-check invariants, aggregate consistency rules quantify over collections, read-model projections translate derived expressions). Delivering it first unblocks the rest while touching only the grammar, Ast/Expressions, the validator, and CSharpExpressionTranslator._

### R1.1 Conditional (ternary) expressions  ·  🔴 High
*As a Domain Developer, I want a conditional expression `if cond then a else b`, so that derived fields and invariants whose value depends on a branch can be expressed without dropping to native code.*

**Acceptance criteria**
- Grammar adds a conditional form at the lowest precedence above `when`, e.g. `effective = if quantity >= 10 then unitPrice * 0.9 else unitPrice`
- A new `ConditionalExpr(Condition, Then, Else)` node is added to Ast/Expressions.cs and built by the visitor; it carries no C# concepts
- CSharpExpressionTranslator emits a correctly parenthesized C# ternary `(cond ? a : b)`
- Semantic validation walks all three sub-expressions for unknown-identifier checks; type-incompatible branches produce a diagnostic with line/column
- Snapshot + Roslyn compile meta-test cover a derived field and an invariant using the form

```koine
value Discount {
  quantity:  Int
  unitPrice: Money
  effective: Money = if quantity >= 10 then unitPrice * 0.9 else unitPrice
}
```

### R1.2 String operations in expressions  ·  🔴 High
*As a Domain Developer, I want built-in string operations (length, trim, lower/upper, startsWith, endsWith, contains, isBlank), so that I can write string-shape invariants beyond regex and derive normalized fields.*

**Acceptance criteria**
- Forms like `raw.length`, `raw.trim`, `code.startsWith("X")`, `name.isBlank` parse
- CSharpExpressionTranslator maps each to the idiomatic BCL call (.Length, .Trim(), .ToLowerInvariant(), .StartsWith(...), string.IsNullOrWhiteSpace(...))
- A central whitelist of string ops replaces the ad-hoc handling; an unknown op on a String yields an 'unknown string operation' diagnostic instead of emitting invalid C#
- The semantic layer is type-aware enough to know the receiver is a String before allowing string ops
- Snapshot + Roslyn tests for `invariant raw.trim.length > 0` and a derived normalized field

```koine
value PostalCode {
  raw: String
  invariant raw.trim.length > 0   "postal code cannot be blank"
  normalized: String = raw.trim.upper
}
```

### R1.3 Collection operations and lambda selectors  ·  🔴 High
*As a Domain Developer, I want richer collection operations (count, isNotEmpty, all/any/none, sum/min/max, contains, distinctBy) with a `param => expr` lambda form, so that aggregate invariants and derived totals over child collections are expressible.*

**Acceptance criteria**
- `.isEmpty` stops being a hardcoded string in CSharpExpressionTranslator and becomes one entry in a typed collection-op registry
- `lines.count`, `lines.isNotEmpty`, `lines.all(l => l.quantity > 0)`, `lines.sum(l => l.subtotal)`, `lines.distinctBy(l => l.product)` parse and emit idiomatic LINQ
- A lambda mini-form `param => expr` is added to the grammar and Ast, with the parameter bound to the collection element type T and its members resolvable
- Type-aware validation: collection ops only allowed on `List<T>` (and later Set/Map); referencing an unknown element member inside a lambda is a diagnostic
- Snapshot + Roslyn tests for `invariant lines.all(l => l.quantity > 0)`, `invariant lines.distinctBy(l => l.product)`, and `total = lines.sum(l => l.subtotal)`

```koine
entity Order identified by OrderId {
  lines: List<OrderLine>
  invariant lines.all(l => l.quantity > 0)        "every line needs a positive quantity"
  invariant lines.distinctBy(l => l.product)       "no duplicate products in an order"
  total: Money = lines.sum(l => l.subtotal)
}
```

### R1.4 Date/time comparison on Instant  ·  🟡 Medium
*As a Domain Developer, I want date/time comparisons on `Instant` fields (e.g. `startsAt <= endsAt`), so that temporal invariants are expressible in the model.*

**Acceptance criteria**
- `Instant` fields can be compared with `< <= > >= == !=` and emit valid C# against the chosen Instant type
- Comparing an Instant with a non-Instant produces a type diagnostic
- A `now` built-in is recognized and translated per target, but is rejected as a stored default (`field: Instant = now`) to preserve determinism
- Snapshot + Roslyn tests for `invariant startsAt <= endsAt "start must precede end"`

```koine
value DateRange {
  startsAt: Instant
  endsAt:   Instant
  invariant startsAt <= endsAt   "start must precede end"
}
```

---

## Epic R2 — Optionality & Richer Collections

_v0 has exactly one collection (`List<T>` -> `IReadOnlyList<T>`) and no notion of optional fields: every field is required and non-null. Real aggregates need genuinely absent values, uniqueness sets, and keyed maps. This is a small, foundational tactical gap that blocks modeling most non-trivial aggregates, and optionality in particular is referenced by commands, read models, and the expression layer (null-coalescing). It sits right next to existing capability (the type mapper and constructor-guard code), so it ships early._

### R2.1 Optional / nullable fields  ·  🔴 High
*As a Domain Developer, I want to mark a field optional with `?` and use null-coalescing/presence checks, so that absent values are modeled explicitly instead of every field being required.*

**Acceptance criteria**
- `shippedAt: Instant?` and `nickname: String?` parse; TypeRef gains an `IsOptional` flag (kept target-agnostic)
- CSharpTypeMapper emits the nullable form (`DateTimeOffset?`, nullable-annotated reference types); optional fields default to `null` and are excluded from non-null guards
- Null-coalescing `a ?? b` and presence checks `field.isPresent` / `field.isNone` parse and translate (`a ?? b`, `field is not null`)
- Invariants/derived expressions over an optional field are validated for null-safe usage or produce a diagnostic; guards are skipped when the value is null
- Existing required-field fixtures are unchanged; Roslyn meta-test covers an unset optional, a `??` default, and an `isPresent` guard

```koine
entity Customer identified by CustomerId {
  name:     String
  nickname: String?
  display:  String = nickname ?? name
}
```

### R2.2 Set and Map collection types  ·  🟡 Medium
*As a Domain Developer, I want `Set<T>` and `Map<K,V>` in addition to `List<T>`, so that uniqueness and keyed lookups are part of the model rather than enforced by hand.*

**Acceptance criteria**
- `Set<T>` maps to a defensively-copied `IReadOnlySet<T>`; `Map<K,V>` to `IReadOnlyDictionary<K,V>`
- The `typeRef` grammar supports two type arguments for `Map`
- Defensive copying in the constructor matches the existing List behavior; element/key/value type references are validated like List elements
- Roslyn meta-test: a Set rejects duplicates on construction (or the semantics are documented and tested)

```koine
entity Catalog identified by CatalogId {
  tags:   Set<String>
  prices: Map<ProductId, Money>
}
```

---

## Epic R3 — Compiler Quality & Diagnostics

_v0 diagnostics carry only severity + message + line/col (Diagnostics/Diagnostic.cs has no Code field), the parser aborts on the first syntax error (KoineCompiler.Parse), there are no 'did you mean' suggestions, and two documented limitations remain: keywords cannot be field names, and bare enum members must be globally unique. These are cross-cutting quality improvements that every later epic benefits from (stable codes to assert in tests, multi-error reporting, soft keywords so the ubiquitous language isn't constrained). It is sequenced early because it is independent of new language constructs and improves the authoring loop immediately._

### R3.1 Stable diagnostic codes  ·  🔴 High
*As a Compiler Maintainer, I want every diagnostic to carry a stable code (e.g. KOI0203), so that errors can be referenced in docs, suppressed selectively, and asserted in tests without matching message text.*

**Acceptance criteria**
- The Diagnostic record gains a `Code` field populated at every call site in SemanticValidator and SyntaxErrorListener
- CLI output becomes the Roslyn/MSBuild-parseable `file:line:col: error KOI0203: message`
- A central catalogue enumerates all codes with one-line descriptions; a test asserts uniqueness and that every emitted code is documented
- Existing tests are updated to assert on codes, not message substrings

```koine
// emits: billing.koi:7:14: error KOI0203: unknown type 'Currancy' — did you mean 'Currency'?
```

### R3.2 Parser error recovery (report multiple syntax errors)  ·  🔴 High
*As a Domain Developer, I want the compiler to recover from a syntax error and keep parsing, so that I see all my mistakes in one pass instead of fixing them one at a time.*

**Acceptance criteria**
- KoineCompiler.Parse no longer bails after the first syntax error; it collects multiple diagnostics via ANTLR's error-recovery strategy
- A file with three independent syntax errors reports all three with correct line/column
- Recovery never produces a partial model that crashes the semantic layer; if recovery is impossible, a single clear diagnostic is emitted
- A fixture with multiple errors asserts the full diagnostic set

### R3.3 'Did you mean' suggestions for unknown names  ·  🟡 Medium
*As a Domain Developer, I want unknown type/field/enum-member references to suggest the closest known name, so that typos are fixed in seconds.*

**Acceptance criteria**
- When validation reports an unknown name, a Levenshtein-nearest in-scope candidate (distance <= 2) is appended as `— did you mean 'X'?`
- Suggestions are scope-aware: type refs suggest known types, field refs suggest sibling members, enum defaults suggest members of that enum
- No suggestion is appended when no candidate is within threshold
- Tests cover a near-miss type name, field name, and enum member

### R3.4 Soft keywords for field and type names  ·  🟡 Medium
*As a Domain Developer, I want to use words like `value`, `status`, `by`, or `when` as field names where unambiguous, so that the ubiquitous language isn't constrained by reserved words (removing a documented v0 limitation).*

**Acceptance criteria**
- The grammar treats Koine keywords as contextual/soft keywords so they may appear as member/type identifiers where unambiguous
- The README 'reserved words' limitation is removed
- A model declaring `value: Decimal` and `status: OrderStatus` parses, validates, and emits compiling C# (reusing the existing `@`-escaping for genuine C# keywords)
- Genuinely ambiguous uses still produce a clear diagnostic; tests cover several keyword-as-identifier cases

```koine
value Measurement {
  value: Decimal
  unit:  String
}
```

### R3.5 Scoped (type-directed) enum member resolution  ·  🟡 Medium
*As a Domain Developer, I want bare enum members in expressions resolved against the field's declared enum type, so that two enums can share a member name (e.g. both `Cancelled`) without collisions (removing a documented v0 limitation).*

**Acceptance criteria**
- In `status == Draft`, `Draft` resolves to the enum type of `status` via the comparison's other operand / surrounding context, replacing the global-uniqueness assumption
- A genuinely ambiguous bare enum member yields a diagnostic asking for qualification `Enum.Member`
- Qualified `OrderStatus.Cancelled` is always accepted
- Tests cover two enums sharing a member name used in invariants on different types

---

## Epic R4 — Ubiquitous Language Documentation & Glossary

_The deepest purpose of DDD is the ubiquitous language, yet v0 captures no human description on any declaration (Nodes.cs has no Doc field; the lexer skips comments as trivia) and produces no documentation output. Capturing meaning once and projecting it into generated XML docs and a glossary turns the .koi model into the authoritative lingua franca the project's name promises. It is sequenced here because it is a self-contained, additive feature that later strategic epics (versioning, glossary grouping by context) build on._

### R4.1 Doc comments on declarations and members  ·  🟡 Medium
*As a Domain Developer, I want to attach `///` doc comments to contexts, types, fields, and invariants, so that the ubiquitous-language intent travels into the model and the generated code's IntelliSense.*

**Acceptance criteria**
- The lexer captures `///` doc comments (distinct from skipped `//` comments) and the model builder attaches them to the following declaration/member as an optional target-agnostic `Doc` string on the AST node
- Doc text is preserved with its SourceSpan; the Ast/ namespace gains no C# formatting
- The C# emitter renders captured docs as `/// <summary>…</summary>` on the generated type/property, escaping XML special characters; multi-line docs are preserved
- Absence of a doc comment produces no XML doc and no diagnostic (docs are optional)
- Snapshot tests show summaries on a value, an entity, and a field

```koine
/// A monetary amount in a specific currency.
value Money {
  /// The amount; never negative.
  amount: Decimal
  currency: Currency
}
```

### R4.2 Generate a ubiquitous-language glossary  ·  🟡 Medium
*As an Architect, I want `koine build … --glossary ./glossary.md` to emit a Markdown glossary grouped by bounded context, so that domain experts and developers share one authoritative dictionary of terms.*

**Acceptance criteria**
- A `--glossary <file>` option (and/or `--target glossary`) produces a Markdown document grouped by context, then module/aggregate
- Each entry lists the type, its kind (value/entity/aggregate/enum/event), its doc, and its fields with types and docs; invariant messages are listed under their owning type as business rules
- Re-running is byte-identical (idempotent), consistent with the existing emit guarantee
- The glossary emitter consumes only the target-agnostic model, proving doc data lives in Ast/ not Emit/CSharp/

---

## Epic R5 — Commands & State Transitions

_v0 emits only immutable constructors and constructor-time invariants; there is no way to express behavior that changes aggregate state — the single most important tactical gap and the first roadmap item in BRIEF §9. DDD aggregates are consistency boundaries whose state evolves only through intention-revealing commands that enforce preconditions and re-check invariants (BRIEF §5 explicitly anticipates 're-checked after any state transition once commands land'). Without commands, generated entities are anemic. This epic depends on the richer expression language and optionality shipped earlier, and it provides the `emit` seam that the Domain Events epic completes._

### R5.1 Declare commands with preconditions on an aggregate root  ·  🔴 High
*As a Domain Developer, I want to declare a `command` on an entity/aggregate root with named parameters and `requires` preconditions, so that state-changing operations are intention-revealing and reject illegal calls before mutating state.*

**Acceptance criteria**
- `command Name(param: Type, ...) { requires <expr> "msg" ... }` parses inside an entity or aggregate-root body, including the no-parameter, empty-body form `command cancel { }`
- Each `requires` clause emits a guard at the top of the generated method that throws DomainInvariantViolationException with the message before any mutation
- Parameters are resolvable in `requires` expressions; a reference resolving to neither a parameter nor a member is an 'unknown field' diagnostic
- The command AST node carries no C#-specific concepts (target-agnostic test)
- Snapshot + Roslyn meta-test: the emitted method compiles, a violated precondition throws, a satisfied one proceeds

```koine
entity Order identified by OrderId {
  status: OrderStatus = Draft
  lines:  List<OrderLine>

  command place {
    requires !lines.isEmpty   "cannot place an empty order"
    requires status == Draft  "order already placed"
    status -> Placed
  }
}
```

### R5.2 Express state transitions inside commands  ·  🔴 High
*As a Domain Developer, I want a command body to assign new values to mutable fields via `field -> value`, so that aggregate state evolves through controlled operations instead of being frozen at construction.*

**Acceptance criteria**
- `field -> expr` inside a command body parses as a state transition and emits an assignment; a transition to an unknown or derived field is a diagnostic
- A field's generated property gains `private set` only when at least one command mutates it; otherwise it stays get-only (existing fixtures unaffected)
- After all transitions, every entity invariant is re-checked and throws if violated
- Roslyn meta-test: a command mutates state and the post-state invariant re-check fires on violation

```koine
command cancel {
  requires status != Shipped "shipped orders cannot be cancelled"
  status -> Cancelled
}
```

---

## Epic R6 — Domain Events

_Events are first-class DDD tactical objects and a stated roadmap item (BRIEF §9), but v0 has no `event` construct, no `IDomainEvent` marker, and no occurrence-metadata conventions. Commands need events to `emit`; policies (later) need events to react to; read-side and integration events build on the same idea. This epic supplies the immutable event value type, the `emit` semantics inside commands, and the shared runtime contract — keeping the seam target-agnostic._

### R6.1 Declare immutable domain event types  ·  🔴 High
*As a Domain Developer, I want to declare an `event` with typed fields, so that significant domain occurrences are captured as immutable, named, value-equal records.*

**Acceptance criteria**
- `event Name { field: Type ... }` parses inside a context or aggregate
- An event emits a `sealed record` implementing the runtime `IDomainEvent` marker with get-only properties and value equality
- Event fields support the same type references as value objects (primitives, value objects, IDs, enums); commands/transitions on an event are a diagnostic
- Snapshot + Roslyn meta-test confirms the event record compiles and is value-equal

```koine
event OrderPlaced {
  orderId:   OrderId
  placedAt:  Instant
  lineCount: Int
}
```

### R6.2 Emit domain events from commands  ·  🔴 High
*As a Domain Developer, I want a command to `emit` one or more domain events with payloads drawn from parameters and state, so that the aggregate records what happened for downstream reactions.*

**Acceptance criteria**
- `emit EventName(field: value, ...)` inside a command body parses and references a declared `event`
- Emitted events are appended to a generated `IReadOnlyList<IDomainEvent> DomainEvents` collection on the aggregate root, with a `ClearDomainEvents()` method
- An `emit` whose payload fields do not match the event declaration is a diagnostic; the `emit` AST node carries no C#-specific concepts
- Roslyn meta-test: invoking the command records the expected event instance in DomainEvents

```koine
command place {
  requires !lines.isEmpty "cannot place an empty order"
  status -> Placed
  emit OrderPlaced(orderId: id, lineCount: lines.count)
}
```

### R6.3 Generate the IDomainEvent runtime contract with occurrence metadata  ·  🟡 Medium
*As a Compiler Maintainer, I want a single `IDomainEvent` interface emitted into `Koine.Runtime` carrying occurrence metadata, so that all events share a uniform contract for dispatch and ordering.*

**Acceptance criteria**
- `IDomainEvent` is emitted once into Koine.Runtime alongside DomainInvariantViolationException and IAggregateRoot
- The interface (or a base) exposes an `OccurredOn` (DateTimeOffset) member that emitted events default at construction
- Re-running emission is byte-identical (idempotent)
- A meta-test compiles the runtime file in isolation

---

## Epic R7 — Entity Lifecycle & State Machines

_v0 allows `status: OrderStatus = Draft` but the enum is inert: nothing constrains which status may follow which. DDD entities frequently have an explicit lifecycle where only certain transitions are valid. Encoding the legal transition graph lets Koine generate guarded transitions and reject illegal ones — a major safety gap over a bare enum field. It is sequenced right after commands because a state machine constrains exactly the `field -> value` transitions commands introduce._

### R7.1 Declare a state machine with legal transitions  ·  🔴 High
*As a Domain Developer, I want a `states` block defining the legal transitions between an entity's lifecycle states, so that illegal state changes are rejected by generated code rather than scattered invariants.*

**Acceptance criteria**
- `states statusField { Draft -> Placed, Cancelled; Placed -> Shipped, Cancelled; ... }` parses inside an entity, bound to an enum-typed field
- The emitter generates a transition check so a command's `status -> X` throws DomainInvariantViolationException when X is not reachable from the current state
- States in the graph must be members of the bound enum; otherwise a diagnostic. Terminal states reject any outgoing transition
- Roslyn meta-test: a legal transition succeeds, an illegal one throws

```koine
entity Order identified by OrderId {
  status: OrderStatus = Draft
  states status {
    Draft   -> Placed, Cancelled
    Placed  -> Shipped, Cancelled
    Shipped
    Cancelled
  }
}
```

### R7.2 Attach guard conditions to state transitions  ·  ⚪ Low
*As a Domain Developer, I want to attach a guard to a specific transition, so that moving between states can require domain conditions beyond simply being in the source state.*

**Acceptance criteria**
- A transition may carry a guard: `Placed -> Shipped when isFullyPaid`
- The guard expression is validated against the entity's members/specs and emits an additional precondition on that transition
- An unguarded transition behaves as in the base state-machine story; a guard referencing an unknown identifier is a diagnostic

```koine
states status {
  Placed -> Shipped when isFullyPaid
}
```

---

## Epic R8 — Factories & Lifecycle Creation

_v0 generates exactly one all-args constructor per type plus a `New()` for IDs. There is no way to express the DDD Factory pattern for encapsulating valid construction of complex aggregates, nor a 'birth' operation that emits a creation event and assigns identity. Developers must hand-write factories around generated types, defeating the boilerplate-elimination mission. This epic reuses the `requires`/`emit` seams from Commands and Domain Events, so it follows them._

### R8.1 Declare named factory methods on aggregates  ·  🟡 Medium
*As a Domain Developer, I want to declare a `create` factory on an aggregate root with parameters, preconditions, and field initialization, so that valid aggregates are constructed through an intention-revealing entry point instead of a raw constructor.*

**Acceptance criteria**
- `create Name(param: Type, ...) { requires ... ; field <- expr ; emit ... }` parses on an aggregate root
- A factory emits a `public static` method returning the aggregate root, generating identity (e.g. `OrderId.New()`) automatically when not supplied
- Preconditions emit guards that throw before construction; a factory may `emit` a creation event reusing the Domain Events seam
- Roslyn meta-test: the factory produces a valid aggregate and rejects invalid arguments

```koine
entity Order identified by OrderId {
  customer: CustomerId
  lines:    List<OrderLine>
  status:   OrderStatus = Draft

  create forCustomer(customer: CustomerId) {
    emit OrderOpened(orderId: id, customer: customer)
  }
}
```

### R8.2 Make construction factory-only when a factory exists  ·  ⚪ Low
*As an Architect, I want an entity's all-args constructor to become non-public once it declares a factory, so that the only way to create the aggregate is through its validated factory.*

**Acceptance criteria**
- When an entity declares at least one `create` factory, its generated constructor is emitted `private`/`internal` rather than `public`
- When no factory is declared, behavior is unchanged (public constructor, preserving v0 fixtures)
- A diagnostic warns if a factory references fields that are never initialized and have no default
- A snapshot test makes the access-modifier change reviewable

---

## Epic R9 — Richer Value Objects

_v0 value objects support primitive/VO/enum/ID fields, a single List<T>, and one special-cased scalar `*` operator (README 'value-object scalar arithmetic'). Production DDD relies on far richer value semantics: enums that carry data, quantities with units, and ranges/intervals. These are core tactical building blocks the current emitter cannot express, forcing developers back to hand-written code. Sequenced after the core behavioral epics since these are additive value-type features that don't block commands/events._

### R9.1 Enum members carrying associated data  ·  🟡 Medium
*As a Domain Developer, I want enum members to carry associated constant data (e.g. a currency's symbol and decimal places), so that the enum is a true value object rather than a bare name and I stop writing lookup tables by hand.*

**Acceptance criteria**
- `enum Currency(symbol: String, decimals: Int) { EUR("€", 2) USD("$", 2) }` parses
- The emitter generates a richer type (smart-enum record or enum plus metadata) exposing the associated data as properties
- Bare-member enums (v0 syntax) continue to compile unchanged; mismatched arity/types between a member and the declared signature is a diagnostic
- Roslyn meta-test: `Currency.EUR.Symbol == "€"` (or equivalent accessor) holds

```koine
enum Currency(symbol: String, decimals: Int) {
  EUR("€", 2)
  USD("$", 2)
  GBP("£", 2)
}
```

### R9.2 Quantity/unit value objects with typed arithmetic  ·  🟡 Medium
*As a Domain Developer, I want a first-class quantity (a value with a unit) with unit-aware, type-safe arithmetic, instead of the ad-hoc single scalar `*` operator v0 special-cases.*

**Acceptance criteria**
- A way to declare a quantity value object combining a numeric amount with a unit (enum or unit type)
- Generated arithmetic (`+`, `-`, scalar `*`, `/`) is unit-checked: adding two quantities of different units is rejected (compile-time where possible, otherwise a thrown domain error)
- This explicit, declared capability replaces/extends the current implicit scalar-operator heuristic; existing Money fixtures are unaffected (opt-in)
- Roslyn meta-test: same-unit addition works, mixed-unit addition is prevented

```koine
value Weight {
  amount: Decimal
  unit:   MassUnit
}
```

### R9.3 Range/interval value objects with containment  ·  ⚪ Low
*As a Domain Developer, I want a `range` value object over an ordered type, so that date ranges, price bands, and numeric intervals get generated min<=max validation and containment/overlap operations.*

**Acceptance criteria**
- `range<Instant>` (or `range of Instant`) parses as a value-object shape
- The generated record has `Start`/`End` get-only properties and a constructor invariant that `start <= end`; `Contains(value)` and `Overlaps(other)` members compile
- A range over a non-ordered type is a diagnostic
- Roslyn meta-test: containment and the min<=max invariant both behave

```koine
value BookingPeriod {
  period: range<Instant>
}
```

---

## Epic R10 — Specifications, Domain Services & Policies

_v0 invariants are anonymous boolean expressions checked only at construction; there is no way to name, reuse, or compose a business rule (the Specification pattern is absent), no home for cross-entity logic that belongs to no single object (Domain Services), and no cross-aggregate reactions (policies are a BRIEF §9 roadmap item). This epic adds the named-rule and reactive glue v0 lacks; policies depend on Domain Events, so it follows that epic._

### R10.1 Declare named, reusable specifications  ·  🟡 Medium
*As a Domain Developer, I want to declare a named `spec` over a type with a boolean expression, so that I can name a business rule once and reuse it in invariants, command preconditions, and queries.*

**Acceptance criteria**
- `spec Name on TypeName = <boolean expr>` parses at context or aggregate scope
- A specification emits a reusable predicate (e.g. an `ISpecification<T>` / static `Func<T,bool>`) over the target type
- A spec can be referenced by name inside an invariant or a `requires` clause; referencing an unknown spec or a type-mismatched spec is a diagnostic; specs may be composed with `&& || !` (with cycle detection)
- Roslyn meta-test: the emitted specification evaluates correctly and is shared between two call sites

```koine
spec IsLargeOrder on Order = lines.count > 10 || total.amount > 1000
spec IsPreferred  on Customer = HasManyOrders && !IsDelinquent
```

### R10.2 Declare domain services with pure operations  ·  🟡 Medium
*As a Domain Developer, I want to declare a `service` with named operations whose signatures and pure result expressions are in the model, so that cross-entity logic that belongs to no single object has a first-class home.*

**Acceptance criteria**
- `service Name { operation op(a: T, b: U): R = <pure expr> }` parses at context scope
- The emitter generates a stateless class (or interface + impl); pure-expression bodies are emitted directly, non-declarative ones emit an abstract/partial seam consistent with BRIEF's no-imperative-logic stance
- Operation parameter/return type references are validated; a domain service may reference value objects, entities, and specs
- Roslyn meta-test: a pure-expression operation computes the expected result

```koine
service ExchangeRateService {
  operation convert(amount: Money, rate: Decimal): Money = amount * rate
}
```

### R10.3 Declare policies that react to domain events across aggregates  ·  🟡 Medium
*As an Architect, I want to declare a `policy` that listens for a domain event and expresses the resulting command on another aggregate, so that cross-aggregate process logic is modeled in the ubiquitous language rather than buried in handwritten handlers.*

**Acceptance criteria**
- `policy Name when EventName then <command-on-other-aggregate>` parses at context scope
- A policy emits a handler interface/skeleton bound to the event type (e.g. `IHandle<TEvent>`), honoring BRIEF's no-imperative-logic non-goal by emitting an abstract seam for non-declarative steps
- Referencing an unknown event or target command is a diagnostic; the policy AST node carries no C#-specific concepts
- Snapshot test shows the generated handler seam

```koine
policy ReserveStock when OrderPlaced then Inventory.reserve(order: orderId)
```

---

## Epic R11 — Identity Strategies, Repositories & Optimistic Concurrency

_v0 hardcodes every generated ID as a Guid wrapper with `New()` (EmitIdValueObject / IsIdConvention) and emits nothing for retrieving or saving aggregates — repositories are an explicit v0 non-goal (BRIEF §8) and a roadmap item (§9). A production tactical toolkit needs selectable identity (natural/sequence keys), per-aggregate-root repository abstractions keyed on identity, and concurrency control. These belong together because the repository contract and concurrency token depend on the chosen identity. Repositories are generated only for aggregate ROOTS, which the model already distinguishes via `aggregate A root R`._

### R11.1 Selectable identity generation strategy per ID  ·  🔴 High
*As a Domain Developer, I want to choose how each identity is generated and typed (guid, sequence, or natural key over String/Int), so that the emitted ID value object matches the persistence reality of that aggregate instead of being forced into Guid.*

**Acceptance criteria**
- `identified by OrderId` keeps current behavior: a Guid-wrapping record with `New()` (no regression)
- A strategy can be specified, e.g. `identified by Sku as natural(String)` (string-wrapping, value-validated, no `New()`) or `identified by InvoiceNo as sequence` (long-wrapping, no client-side `New()`)
- The strategy is represented in the AST (`IdentityStrategy`: Guid | Sequence | Natural) so the emitter, not the parser, decides the C# representation; a non-Guid ID may carry a format invariant reusing the `matches` machinery
- Snapshot tests cover all three strategies; a String-backed ID compiles, value-equals, and validates its format

```koine
entity Product identified by Sku       as natural(String) { name: String }
entity Invoice identified by InvoiceNo as sequence       { total: Money }
entity Order   identified by OrderId                       { customer: CustomerId }  // default: guid
```

### R11.2 Generate a repository interface per aggregate root  ·  🔴 High
*As a Domain Developer, I want Koine to generate an `I<Root>Repository` interface for each aggregate root, so that my application code depends on a typed, persistence-ignorant contract instead of hand-written boilerplate.*

**Acceptance criteria**
- For `aggregate Order root Order`, an `IOrderRepository` is emitted into the aggregate namespace declaring `Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default)` and `Task AddAsync(Order aggregate, CancellationToken ct = default)`, keyed on the root's ID value object
- A repository is generated ONLY for the root entity; non-root and standalone entities get none
- Interface name, method signatures, and ID type derive purely from the AST (no C# concepts in Ast/)
- A Roslyn meta-test confirms the emitted interface compiles against the emitted aggregate types

```koine
aggregate Order root Order {
  entity Order identified by OrderId { customer: CustomerId; lines: List<OrderLine> }
}
// emits: interface IOrderRepository { Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct); Task AddAsync(Order o, CancellationToken ct); }
```

### R11.3 Declarative repository finders and configurable operation set  ·  🟡 Medium
*As a Domain Developer, I want to declare finder queries and control which mutating operations a repository exposes, so that the generated interface has intention-revealing lookups and read-mostly/append-only aggregates don't advertise forbidden operations.*

**Acceptance criteria**
- A `repository { ... }` block lets the developer declare finders, e.g. `find byCustomer(customer: CustomerId): List<Order>`, emitting `Task<Order?>` for single and `Task<IReadOnlyList<Order>>` for list results
- An `operations: add, getById` clause controls the mutating method set; default is `add, update, remove, getById`. `RemoveAsync`/`UpdateAsync` are absent when not requested
- Finders and the operation set are represented as a target-agnostic `RepositoryDecl`; finder parameter types are validated; a finder on a non-aggregate type, or an unknown operation keyword, is a diagnostic with line/column
- Snapshot tests cover a list finder, a single finder, and an append-only aggregate emitting no UpdateAsync/RemoveAsync

```koine
aggregate AuditLog root AuditEntry {
  repository {
    operations: add, getById
    find byMessage(message: String): List<AuditEntry>
  }
  entity AuditEntry identified by AuditEntryId { message: String }
}
```

### R11.4 Aggregate version field for optimistic concurrency  ·  🔴 High
*As a Domain Developer, I want to mark an aggregate root as versioned, so that the generated root and repository contract carry a concurrency token and enable optimistic concurrency checks.*

**Acceptance criteria**
- A root can be declared `versioned`; the emitted root gains a get-only `Version` property (Int/Long) represented in the AST so it stays target-agnostic
- A `ConcurrencyConflictException` is emitted once into `Koine.Runtime` (mirroring DomainInvariantViolationException) and the save/update contract documents that an expected version is enforced
- Non-versioned aggregates emit no `Version` property (no change to existing fixtures)
- Roslyn meta-test confirms a versioned aggregate plus its repository compile

```koine
aggregate Order root Order versioned {
  entity Order identified by OrderId { customer: CustomerId }
}
```

---

## Epic R12 — Application Services, Read Models & CQRS

_A production DDD system separates write (aggregates) from read concerns and needs an application layer that orchestrates aggregates transactionally. v0 has no use cases, application services, unit of work, DTOs, projections, or query objects — the model stops at domain types whose only equality is identity-based, so application/UI code has no generated way to project or orchestrate them. This epic depends on repositories and is the natural companion to the commands construct, generating interfaces (not infrastructure) to keep the domain pure._

### R12.1 Generate a Unit-of-Work abstraction per context  ·  🟡 Medium
*As an Architect, I want a generated `IUnitOfWork` per bounded context, so that application code can commit changes across aggregates atomically without hand-writing the transactional seam.*

**Acceptance criteria**
- Each context with at least one aggregate emits an `IUnitOfWork` with `Task<int> SaveChangesAsync(CancellationToken ct = default)`, optionally exposing each aggregate's repository as a property in declaration order
- The unit-of-work is a generated abstraction only — no EF Core/ADO/other infrastructure type appears (verified by a banned-namespace test)
- Contexts with no aggregates emit no IUnitOfWork
- Roslyn meta-test compiles the interface against the generated repositories

```koine
context Billing {
  aggregate Order root Order { /* ... */ }
}
// emits: interface IUnitOfWork { IOrderRepository Orders { get; } Task<int> SaveChangesAsync(CancellationToken ct); }
```

### R12.2 Application/use-case service interfaces  ·  🟡 Medium
*As a Domain Developer, I want to declare use cases and have Koine emit an application service interface, so that the application boundary is explicit and typed without me writing the plumbing.*

**Acceptance criteria**
- A `service`/`usecase` declaration names operations with typed inputs/outputs, e.g. `usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId`
- Each context with use cases emits an `I<Name>Service` whose methods map declared inputs/outputs through the type mapper, returning `Task<...>`
- Use cases are represented as target-agnostic `UseCaseDecl` nodes; unknown parameter/return types and duplicate names are diagnostics with line/column
- Snapshot + Roslyn meta-tests cover a command-style use case (returns an ID) and a query-style one (returns a read model)

```koine
context Billing {
  service OrderService {
    usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
    usecase CancelOrder(order: OrderId)
  }
}
```

### R12.3 Declare read models / DTOs and emit projection mappers  ·  🔴 High
*As a Domain Developer, I want to declare a `readmodel` shaped from an aggregate and get a generated projection mapper, so that I return flat, serialization-friendly DTOs from queries without hand-writing projection code.*

**Acceptance criteria**
- `readmodel OrderSummary from Order { id; customer; status; lineCount: Int = lines.count }` emits a `sealed record` with value equality, no invariants/factories, and no IAggregateRoot marker
- Field types resolve against the source aggregate's members and derived fields; an unknown field name is a diagnostic with line/column
- A static mapper (e.g. `ToOrderSummary(this Order src)`) is emitted; direct-name fields map directly and declared derived projections translate via the expression translator; unresolvable projections fail at compile time rather than emit non-compiling code
- Read models and the mapper are target-agnostic `ReadModelDecl` nodes; re-running is byte-identical; a Roslyn meta-test constructs an Order and asserts the projection output

```koine
readmodel OrderSummary from Order {
  id
  customer
  status
  lineCount: Int = lines.count
}
```

### R12.4 Query objects with typed criteria  ·  🟡 Medium
*As a Domain Developer, I want to declare query objects with typed criteria over a read model, so that read-side queries have a first-class, typed shape instead of stringly-typed filters.*

**Acceptance criteria**
- `query OrdersByStatus(status: OrderStatus): List<OrderSummary>` emits a query DTO record plus a handler interface `IQueryHandler<OrdersByStatus, IReadOnlyList<OrderSummary>>`
- The generic `IQueryHandler<TQuery,TResult>` runtime interface is emitted exactly once into Koine.Runtime, alongside the existing IAggregateRoot/DomainInvariantViolationException
- Criteria parameters and the result read-model type are validated (unknown read-model target reported with line/column); query objects are target-agnostic `QueryDecl` nodes (name, criteria, result read model, cardinality)
- Snapshot + Roslyn meta-tests cover a list-returning and a single-returning query

```koine
query OrdersByStatus(status: OrderStatus): List<OrderSummary>
query OrderById(id: OrderId): OrderSummary
```

---

## Epic R13 — Multi-File Compilation, Imports & Modules

_v0 compiles exactly ONE source string (File.ReadAllText in the CLI) and ModelIndex resolves every type by flat simple-name across one in-memory model. There is no way to split a domain across files, organize a large context into sub-namespaces, or reference a type from another file/context. Real DDD systems span dozens of contexts and hundreds of types; this is the foundational structural gap that every strategic-design feature depends on, so it leads the strategic block._

### R13.1 Compile a directory of .koi files as one model  ·  🔴 High
*As a Domain Developer, I want `koine build ./domain --out ./generated` to discover and compile every `.koi` file under a path into a single model, so that I can organize my domain across many files instead of one monolith.*

**Acceptance criteria**
- `koine build <dir>` recursively enumerates `*.koi`, parses each, and merges them into one model before validation and emit; passing a single file still works (backward compatible)
- Two files each declaring a `context` of the SAME name contribute their types to the same merged context (contexts are open/additive)
- A syntax error in any file reports `file:line:col: message` with the correct originating file path and exits non-zero
- SourceSpan carries the source file path so all downstream diagnostics name the right file

```koine
// billing/money.koi  and  billing/order.koi  both: context Billing { ... }  — merged into one Billing context
```

### R13.2 Imports and qualified cross-context references  ·  🔴 High
*As a Domain Developer, I want to `import Billing.{ Money }` (or reference `Billing.Money` fully qualified) at the top of a context, so that I can deliberately reference types owned by another bounded context instead of relying on a global flat namespace.*

**Acceptance criteria**
- Grammar supports `import <Context>.{ Id (, Id)* }`, `import <Context>.*`, and a dotted `Context.Type` typeRef qualifier
- ModelIndex resolves names per-context using a context-local scope plus the explicit import set, replacing today's flat global resolution; an un-imported cross-context reference is a coded error
- When two contexts both declare `Money`, an unqualified `Money` in a third context that imports both is an ambiguous-reference error listing candidates; a fully-qualified reference always resolves without an import
- Importing a name the target context does not export is a coded error; emitted C# adds `using <TargetContext>;` only for contexts actually referenced

```koine
context Sales {
  import Billing.{ Money }
  entity Quote identified by QuoteId { price: Money; freight: Logistics.Money }
}
```

### R13.3 Declare modules inside a context  ·  🟡 Medium
*As a Domain Developer, I want to group types into a `module Pricing { … }` inside a context, so that cohesive concepts live together and emit into a `<Context>.<Module>` sub-namespace.*

**Acceptance criteria**
- Grammar supports `module Identifier { typeDecl* }` nested within a context (modules may nest)
- Types inside a module emit into namespace `<Context>.<Module>` and folder `<Context>/<Module>`; sibling and cross-module types within the same context still resolve unqualified
- ModelIndex records the owning module path of every declaration so the emitter can compute namespaces
- A `module` sharing a name with a type produces a coded name-collision diagnostic

```koine
context Billing {
  module Pricing  { value Money { amount: Decimal; currency: Currency } }
  module Invoicing { entity Invoice identified by InvoiceId { total: Money } }
}
```

---

## Epic R14 — Context Mapping & Integration Events

_Strategic DDD is fundamentally about relationships between bounded contexts (partnership, shared kernel, customer/supplier, conformist, anti-corruption layer, open-host/published-language) and the stable, published messages they exchange. v0 has NO notion of inter-context relationships or integration events whatsoever — contexts are isolated namespaces. This is the centerpiece of strategic completeness, depending on multi-file/imports to even reference foreign types. Integration events are distinct from the intra-aggregate Domain Events epic: they are a published-language contract carried across a boundary._

### R14.1 Declare a context map with typed relationships  ·  🔴 High
*As an Architect, I want a top-level `contextmap { … }` block declaring directed relationships between contexts with roles, so that the strategic design is captured in the model and not just in a diagram.*

**Acceptance criteria**
- A top-level `contextmap { relation* }` supports roles `partnership`, `shared-kernel`, `customer-supplier`, `conformist`, `anti-corruption-layer`, `open-host`, `published-language`
- Each relation names two declared contexts; referencing an undeclared context is a coded error
- Cross-context type references are validated AGAINST the map: a `conformist` downstream may reference upstream types directly, but an `anti-corruption-layer` downstream referencing an upstream type without going through a translated type is a coded warning/error
- The map is part of the target-agnostic Ast/

```koine
contextmap {
  Catalog -> Sales    : conformist
  Sales   -> Shipping : customer-supplier
  Billing <-> Sales   : shared-kernel { Money, Currency }
  Legacy  -> Billing  : anti-corruption-layer
}
```

### R14.2 Enforce shared-kernel ownership and emit ACL translator stubs  ·  🔴 High
*As an Architect, I want a `shared-kernel` relation to enumerate exactly which types are shared and an `anti-corruption-layer` relation to emit a translator interface, so that the kernel is explicit and small and ACLs have a clear mapping seam.*

**Acceptance criteria**
- A `shared-kernel { TypeA, TypeB }` relation declares kernel membership; both partner contexts may reference those types without an `import`; shared-kernel types are emitted once into a dedicated kernel namespace, not duplicated per context
- A context referencing a foreign type that is neither shared nor imported is a coded unshared-reference error; listing a type neither partner declares is a coded unknown-kernel-type error
- For each `X -> Y : anti-corruption-layer` with an `acl { Upstream -> Local }` mapping block, the emitter generates an `I<X>To<Y>Translator` interface in Y with one `Translate` method per mapped upstream type, referencing the correct namespaces
- No translator is generated for non-ACL relations (no spurious output)

```koine
contextmap {
  Legacy -> Billing : anti-corruption-layer
    acl { Legacy.Account -> Billing.Customer
          Legacy.Charge  -> Billing.Invoice }
}
```

### R14.3 Declare integration events as a published language with subscribers  ·  🔴 High
*As a Domain Developer, I want to declare `integration event OrderPlaced { … }` that a context `publishes` and another `subscribes` to, so that downstream contexts have a stable contract to consume instead of reaching into my internal model.*

**Acceptance criteria**
- `integration event Identifier { member* }` parses at context/module scope and emits an immutable C# record plus a marker `IIntegrationEvent` in Koine.Runtime
- Integration-event field types are restricted to primitives, enums, other integration events, and ID value objects; referencing an internal entity is a coded 'event leaks internals' error
- A context declares `publishes`/`subscribes`; subscribing to an event from a context with no open-host/published-language/customer-supplier relation on the map is a coded error, and subscribing to an event not actually published is a coded error
- For `subscribes Sales.OrderPlaced` in Shipping, the emitter generates `IHandleOrderPlaced` with `Handle(OrderPlaced)`, referencing the publisher's type via the correct using; no handler is generated for events a context only publishes

```koine
context Sales {
  publishes OrderPlaced
  integration event OrderPlaced {
    orderId: OrderId
    total:   Money
    placedAt: Instant
  }
}
context Shipping { subscribes Sales.OrderPlaced }
```

---

## Epic R15 — Model Versioning & Evolution

_v0 has no concept of model version, schema evolution, or compatibility (README lists no versioning). Once integration events and published languages exist, they are worthless across teams if they cannot evolve safely. Production strategic design requires versioned context contracts, deprecation, and automated breaking-change detection so upstream changes don't silently break downstream consumers. Sequenced after context mapping/integration events because it operates on exactly those published surfaces._

### R15.1 Version-stamp contexts and annotate evolution  ·  ⚪ Low
*As an Architect, I want `context Sales version 3 { … }` plus `@since(n)` / `@deprecated("reason")` annotations on types and fields, so that the evolution of a context and its published language is explicit in the model.*

**Acceptance criteria**
- Grammar supports an optional `version <Int>` clause on a context and `@since(<Int>)`, `@deprecated(<String>)` annotations on type/field declarations, stored on target-agnostic AST nodes
- The C# emitter renders `@deprecated` as `[Obsolete("reason")]` on the generated type/property
- `@since` and `version` surface in the generated glossary
- An annotation referencing a version higher than the context's declared version is a coded warning

```koine
context Sales version 3 {
  integration event OrderPlaced {
    orderId: OrderId
    total:   Money
    @since(2) couponCode: String
    @deprecated("use total") legacyAmount: Decimal
  }
}
```

### R15.2 Check backward compatibility against a baseline model  ·  ⚪ Low
*As a Compiler Maintainer, I want `koine check --baseline ./prev` to compare the current model against a previously published one and flag breaking changes to published surfaces, so that downstream consumers are protected from accidental contract breaks.*

**Acceptance criteria**
- `koine check --baseline <dir>` parses both models and diffs their published surfaces (integration events, shared-kernel types, open-host types)
- Removing a published type/field, narrowing a type, or making an optional field required is reported as a coded breaking change with the type/field name and exits non-zero
- Additive changes (new optional field, new event) are reported as non-breaking and exit zero; internal (non-published) changes are ignored
- The diff logic operates purely on the target-agnostic model so it is reusable across future emitters

---

## Epic R16 — Multi-Target Emitters & Emitter Configuration

_BRIEF §9 and the README position TypeScript and Rust as the proof that the Ast/ + IEmitter seam is genuinely target-agnostic; today only CSharpEmitter exists and the CLI hard-rejects any non-csharp target (Program.cs). Rust in particular forces error handling to map to `Result<T,E>` instead of the exception-based DomainInvariantViolationException — the strongest test of the seam. Real projects also need to configure the existing C# emitter (namespace mapping, NodaTime mode — still a literal 'TODO: NodaTime' in CSharpTypeMapper, output layout). This is the capstone of the long-term vision, sequenced last because it benefits from a mature, stable AST._

> **⏸ Deferred.** R16 is intentionally held until the compiler core is stronger and the AST has stabilized (it is the capstone, and a multi-target seam is only worth proving on a mature model). `koine init` already emits a forward-compatible `koine.config` whose structured `targets.*` block (R16.1) is reserved but ignored by today's build, so adopting R16 later needs no migration.

### R16.1 C# emitter configuration (namespaces, NodaTime, layout)  ·  🟡 Medium
*As an Architect, I want a structured emitter options object to map contexts to concrete namespaces, choose the Instant mapping, and control output layout, so that generated code drops into our existing project conventions.*

**Acceptance criteria**
- An options object carries a context-name -> namespace map (plus optional root prefix), an `instantMode` (dateTimeOffset default | nodaTime), and a `layout` (filePerType default | filePerContext | filePerAggregate), supplied via a `koine.config` and/or CLI flags
- In nodaTime mode CSharpTypeMapper emits `Instant` with `using NodaTime;` (removing the 'TODO: NodaTime' comment) and `now` translates to the mode-appropriate API; mapped namespaces are used consistently including cross-namespace usings so output still compiles
- Shared runtime types emit consistently regardless of layout; idempotent re-runs remain byte-identical for every layout and the stale-orphan cleanup still works
- Snapshot + Roslyn tests cover remapped namespaces, both Instant modes, and each layout

```koine
// koine.config: targets.csharp = { namespaces = { Billing = "Acme.Sales.Billing" }, instantMode = nodaTime, layout = filePerContext }
```

### R16.2 TypeScript emitter  ·  🔴 High
*As a Domain Developer, I want `koine build model.koi --target typescript --out ./ts`, so that the same domain model produces idiomatic TypeScript value objects, entities, and enums for my frontend.*

**Acceptance criteria**
- A `TypeScriptEmitter : IEmitter` (TargetName 'typescript') is added under Emit/TypeScript without touching Ast/ or Semantics/
- Value objects emit as classes/readonly records with validating constructors throwing a shared DomainInvariantViolationException; entities use identity equality; enums emit as TS enums or string-literal unions
- A primitive mapping table is defined (String->string, Int/Decimal->number, Bool->boolean, Instant->Date or documented choice, List<T>->ReadonlyArray<T>, *Id->branded type)
- The full billing.koi fixture emits TypeScript that passes `tsc --noEmit`; snapshot tests cover the output

### R16.3 Rust emitter with Result-based error handling  ·  🔴 High
*As a Domain Developer, I want `koine build model.koi --target rust`, so that invariants surface as `Result<T, DomainError>` constructors rather than panics, matching idiomatic Rust.*

**Acceptance criteria**
- A `RustEmitter : IEmitter` (TargetName 'rust') emits structs with private fields and `pub fn new(...) -> Result<Self, DomainError>` constructors that return `Err` on invariant violation instead of throwing
- The exception-vs-Result decision lives entirely in the emitter; Ast/ gains no error-handling concept (verifying the seam)
- Entities derive identity-based PartialEq/Eq on the id field; value objects derive structural equality; enums map to Rust enums; primitive mapping defined (Decimal->rust_decimal or documented, Instant->chrono/time choice, List<T>->Vec<T>, *Id->newtype around Uuid)
- The billing.koi fixture emits Rust that passes `cargo check`; snapshot tests cover output

```koine
// value Money { amount: Decimal; invariant amount >= 0 "..." }
// -> pub fn new(amount: Decimal, currency: Currency) -> Result<Money, DomainError> { ... }
```

### R16.4 Emitter conformance test harness  ·  🟡 Medium
*As a Compiler Maintainer, I want a shared conformance suite that runs every fixture through every emitter and compiles the output, so that adding a target can't silently regress and the AST stays truly target-agnostic.*

**Acceptance criteria**
- A parameterized test runs each .koi fixture through each registered IEmitter
- Per-target compile checks run in CI: Roslyn for C#, `tsc --noEmit` for TS, `cargo check` for Rust
- A guard test fails the build if any type under Ast/ references a target-specific concept (assembly/namespace allow-list)
- Adding a new emitter requires only registering it; the suite picks it up automatically

---

## Epic R17 — Editor Tooling & Developer Experience

_BRIEF §8 lists LSP/editor tooling as a v0 non-goal, but it is squarely in scope for a production-grade tool and the team already tracks a Rider-highlighting task. Today .koi files have no syntax highlighting, no language server, no formatter, and the CLI supports only `build`/`--version` (no `init`/`watch`). These close the gap between 'a compiler exists' and 'developers enjoy writing .koi'. Sequenced last because the LSP and formatter are most valuable once the language surface from the earlier epics has stabilized, and the LSP reuses the coded diagnostics from the Compiler Quality epic._

### R17.1 TextMate grammar for VS Code and Rider  ·  🟡 Medium
✅ **Delivered this session** — *As a Domain Developer, I want syntax highlighting for .koi files in VS Code and Rider, so that I can read and write domain models comfortably.*

**Acceptance criteria**
- A TextMate grammar highlights keywords, types, identifiers, numbers, strings, regex literals, and comments, with distinct scopes for primitive vs user-defined types
- Packaged for both a minimal VS Code extension and a Rider/IntelliJ TextMate bundle
- Highlighting is verified on examples/billing.koi including the regex invariant and the `when` guard

### R17.2 Language Server Protocol implementation  ·  🟡 Medium
✅ **Delivered** — *As a Domain Developer, I want an LSP server for Koine, so that I get inline diagnostics, hover, completion, and go-to-definition while editing .koi files.*

**Acceptance criteria**
- A `koine lsp` (or separate Koine.LanguageServer) speaks LSP over stdio and reuses KoineCompiler for parse + semantic diagnostics
- publishDiagnostics streams the same coded diagnostics as the CLI on every edit with correct ranges
- Hover shows a type's/field's resolved type and its doc comment; go-to-definition jumps from a reference to its declaration; completion suggests in-scope type names, field names, and enum members
- Integration tests drive the server with sample LSP messages and assert responses

### R17.3 koine fmt, init, and watch  ·  ⚪ Low
✅ **Delivered** — *As a Domain Developer, I want `koine fmt`, `koine init`, and `koine watch`, so that .koi files stay canonically formatted, new projects scaffold in one command, and edits regenerate code automatically with fast feedback.*

**Acceptance criteria**
- `koine fmt <file|dir>` rewrites files to a canonical style (consistent indentation, aligned `: type` columns, normalized operator spacing, preserved doc comments) and is idempotent; `--check` exits non-zero on unformatted files without writing
- `koine init [dir]` scaffolds a starter .koi, a koine.config, and a README stub; it refuses to overwrite without `--force`; the scaffold builds end-to-end via `koine build` immediately
- `koine watch` monitors input(s) and re-runs the build on change (honoring the same --target/--out/config), debounces rapid saves, keeps watching after reporting errors, and prints a timestamped result
- Tests cover formatter idempotency, that the init scaffold builds, and that a simulated file change triggers a re-emit

---

## Notes

- **R17.1 (TextMate grammar)** is already implemented — see [`tooling/koine-textmate`](tooling/) and the Rider/VS Code import steps in [`tooling/README.md`](tooling/README.md).
- The [`demo/`](demo/) project exercises the full v0 surface across three bounded contexts and is the natural place to validate new stories end-to-end.
- Sequencing rationale: **R1–R4** sharpen the existing surface (expressions, optionality, diagnostics, docs) at low risk; **R5–R10** add the missing tactical behaviour (commands, events, lifecycle, factories, richer value objects, specifications/services/policies); **R11–R12** add the persistence & application abstractions; **R13–R15** unlock multi-file and strategic design; **R16–R17** prove target-agnosticism (TypeScript/Rust) and round out developer experience.

