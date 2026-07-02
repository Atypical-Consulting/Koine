---
title: "About this specification"
description: "What this specification covers, how to read it, and a map of every Koine construct."
---

This section is the precise, construct-by-construct specification of the Koine language. If the [Start here](/Koine/start/what-is-koine/) and [Tutorials](/Koine/tutorials/values-and-invariants/) sections teach you *how to think* in Koine, the reference tells you *exactly* what each keyword does and what C# it emits.

Every page is grounded in the compiler's tests and the [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo), so the snippets compile and the emitted shapes are real.

## 1.1 How to read this specification

Each construct chapter follows a fixed **General → Syntax → Semantics → Translation** structure, uses
EBNF for grammar, and cites sections with the `§` glyph. The full set of conventions — grammar
notation, numbering, callouts, and diagnostics — is described in
[Notation & conventions (§2)](/Koine/reference/notation/). The token-level rules (comments,
identifiers, keywords, literals, operators) live in
[Lexical structure (§3)](/Koine/reference/lexical-structure/).

## 1.2 How the language is shaped

A `.koi` file declares one or more bounded `context`s. Inside a context you declare *types* (value objects, entities, aggregates, enums, quantities), the *behaviour* on those types (invariants, derived fields, commands, events, state machines, factories), the *strategic* pieces (specs, services, policies), and the *application* layer (repositories, use cases, read models, queries). At the top level — sibling to the contexts — a single `contextmap` wires the contexts together.

```koine
context Catalog {

  enum Currency { EUR, USD, GBP }

  value Money {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "a monetary amount cannot be negative"
  }
}
```

:::note[Target-agnostic by design]
The pipeline is **strictly layered**: lexer/parser → target-agnostic semantic model → validator → emitter. Nothing before the emitter knows what C# is. Koine ships **C#, TypeScript, Python, PHP, and Rust** emitters today. This reference describes the language through its C# emission — but the model itself is portable across every target.
:::

## 1.3 The construct map

Each construct family has its own reference page. Start here and follow the link for the one you need.

| Construct | What you write | Page |
|-----------|----------------|------|
| `context`, `module`, type basics | bounded contexts, sub-namespaces, the type families | [Contexts & types](/Koine/reference/contexts-and-types/) |
| `value`, `quantity`, `Range<T>` | immutable value objects, unit-checked quantities, intervals | [Value objects](/Koine/reference/value-objects/) |
| `entity … identified by …` | entities and the four identity strategies | [Entities & identity](/Koine/reference/entities-and-identity/) |
| `aggregate … root …` | aggregate roots, `IAggregateRoot`, versioning | [Aggregates](/Koine/reference/aggregates/) |
| `enum` | smart enums, with optional associated data | [Enums](/Koine/reference/enums/) |
| comparisons, arithmetic, `matches`, lambdas | the pure expression sublanguage | [Expressions](/Koine/reference/expressions/) |
| `invariant`, `spec` as guard | constructor guards, regex and conditional rules | [Invariants](/Koine/reference/invariants/) |
| `command`, `event`, `states` | behaviour, domain events, state machines | [Commands, events & state machines](/Koine/reference/commands-events-state/) |
| `create … { … -> … emit … }` | factory methods and `->` field initialization | [Factories](/Koine/reference/factories/) |
| `spec`, `service`, `policy` | named predicates, domain services, reaction seams | [Specs, services & policies](/Koine/reference/specs-services-policies/) |
| `repository`, `find`, `versioned` | repository contracts, finders, optimistic concurrency | [Repositories & concurrency](/Koine/reference/repositories-concurrency/) |
| `service … usecase …`, `readmodel`, `query` | application services, CQRS read models and queries | [Application layer & CQRS](/Koine/reference/application-cqrs/) |
| `import`, `module`, directory builds | multi-file models, imports, sub-namespaces | [Multi-file, imports & modules](/Koine/reference/multi-file-imports-modules/) |
| `contextmap`, `integration event`, `publishes`/`subscribes`, `acl` | context maps, the seven roles, shared kernels, integration events | [Context maps & integration](/Koine/reference/context-maps-integration/) |
| `version`, `@since`, `@deprecated`, `koine check` | model versioning, deprecation, compatibility checks | [Versioning & evolution](/Koine/reference/versioning/) |

For a feature-by-feature tour, see the [feature catalogue](/Koine/guides/feature-catalogue/). For the `koine build`/`koine check` flags, see the [CLI reference](/Koine/guides/cli/).

## 1.4 Primitive types

Koine has a small set of built-in primitives that map straight to C#:

| Koine | C# | Notes |
|-------|----|-------|
| `String` | `string` | not orderable |
| `Int` | `int` | orderable |
| `Decimal` | `decimal` | money / quantities; orderable |
| `Bool` | `bool` | |
| `Instant` | `DateTimeOffset` | orderable |
| `List<T>` | `IReadOnlyList<T>` | defensively copied in constructors |
| `<Name>Id` | generated ID value object | a `record` wrapping a `Guid` by default |

`List<T>`, `Set<T>`, `Map<K,V>`, and `Range<T>` are the four built-in generic type constructors. *Orderable* types (`Int`, `Decimal`, `Instant`) are the ones allowed in relational comparisons and as `Range<T>` element types — `String` is **not** orderable. See [Value objects (§5)](/Koine/reference/value-objects/) and [Expressions (§9)](/Koine/reference/expressions/) for the details.

## 1.5 Tokens, keywords, and operators

The lexical layer — comments, identifiers, the reserved (`invariant`, `matches`) vs soft keyword
rule, reserved type names, literals, and the atomic `->` / `<->` operators — is specified in
[Lexical structure (§3)](/Koine/reference/lexical-structure/).

## 1.6 Where to next

- New to the language? Read in sidebar order, starting with [Contexts & types](/Koine/reference/contexts-and-types/).
- Looking up one construct? Jump straight from [the construct map](#13-the-construct-map) above.
- Want to see it all wired together? Browse the [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo) or the [feature catalogue](/Koine/guides/feature-catalogue/).
