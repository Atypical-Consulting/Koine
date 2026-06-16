---
title: "Language reference overview"
description: "A map of every Koine construct and where to read about it."
---

This section is the precise, construct-by-construct specification of the Koine language. If the [Start here](/Koine/start/what-is-koine/) and [Tutorials](/Koine/tutorials/values-and-invariants/) sections teach you *how to think* in Koine, the reference tells you *exactly* what each keyword does and what C# it emits.

Every page is grounded in the compiler's tests and the [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo), so the snippets compile and the emitted shapes are real.

## How the language is shaped

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
The pipeline is **strictly layered**: lexer/parser → target-agnostic semantic model → validator → emitter. Nothing before the emitter knows what C# is. **C# is the only emitter today**; TypeScript and Rust are on the [roadmap](/Koine/guides/roadmap/). Everything in this reference describes the language and its *current* C# emission — the model itself is portable.
:::

## The construct map

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
| `create … { … <- … emit … }` | factory methods and `<-` field initialization | [Factories](/Koine/reference/factories/) |
| `spec`, `service`, `policy` | named predicates, domain services, reaction seams | [Specs, services & policies](/Koine/reference/specs-services-policies/) |
| `repository`, `find`, `versioned` | repository contracts, finders, optimistic concurrency | [Repositories & concurrency](/Koine/reference/repositories-concurrency/) |
| `service … usecase …`, `readmodel`, `query` | application services, CQRS read models and queries | [Application layer & CQRS](/Koine/reference/application-cqrs/) |
| `import`, `module`, directory builds | multi-file models, imports, sub-namespaces | [Multi-file, imports & modules](/Koine/reference/multi-file-imports-modules/) |
| `contextmap`, `integration event`, `publishes`/`subscribes`, `acl` | context maps, the seven roles, shared kernels, integration events | [Context maps & integration](/Koine/reference/context-maps-integration/) |
| `version`, `@since`, `@deprecated`, `koine check` | model versioning, deprecation, compatibility checks | [Versioning & evolution](/Koine/reference/versioning/) |

For a feature-by-feature tour mapped to the R1–R15 roadmap, see the [feature catalogue](/Koine/guides/feature-catalogue/). For the `koine build`/`koine check` flags, see the [CLI reference](/Koine/guides/cli/).

## Primitive types

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

`List<T>`, `Set<T>`, `Map<K,V>`, and `Range<T>` are the four built-in generic type constructors. *Orderable* types (`Int`, `Decimal`, `Instant`) are the ones allowed in relational comparisons and as `Range<T>` element types — `String` is **not** orderable. See [Value objects](/Koine/reference/value-objects/) and [Expressions](/Koine/reference/expressions/) for the details.

## Reserved words and the soft-keyword rule

Koine deliberately keeps very few words off-limits, so that domain vocabulary almost never collides with the language.

### Soft keywords — usable as field names

Most Koine keywords are **soft**: outside their declaration position they are ordinary identifiers, so you can name a field after one. This includes (among others):

`context`, `module`, `value`, `quantity`, `entity`, `aggregate`, `enum`, `event`, `command`, `create`, `requires`, `emit`, `spec`, `service`, `operation`, `policy`, `usecase`, `readmodel`, `query`, `repository`, `find`, `operations`, `import`, `publishes`, `subscribes`, `integration`, `acl`, `by`, `root`, `versioned`, `as`, `natural`, `sequence`, `guid`, `from`, `on`, `when`, `then`, `if`, `version`, `since`, `deprecated`.

So all of these parse cleanly as plain fields:

```koine
context Inventory {
  value Tag {
    quantity:   Int
    version:    Int
    since:      Int
    deprecated: String
  }
}
```

The **declaration keywords** (`value`, `entity`, `enum`, …) may additionally be used as type names and inside expressions.

:::caution[Two words stay reserved]
`invariant` and `matches` are **fully reserved** — you cannot use them as field names. (`matches` switches the lexer into regex mode, and `invariant` opens a guard.)
:::

### Reserved type names

The four built-in generic constructors cannot be reused as your own type names. Declaring a `value`, `entity`, `enum`, `quantity`, or `module` called `List`, `Set`, `Map`, or `Range` is an error (`KOI0908`, `ReservedTypeName`).

### Annotations are not keywords

An annotation is `@` followed by an ordinary identifier, so `@since` and `@deprecated` only carry meaning in annotation position. Only `@since(n)` (with an integer argument) and `@deprecated("reason")` (with a string argument) are recognized; any other `@name` parses but is silently ignored. See [Versioning & evolution](/Koine/reference/versioning/).

## A note on operator spacing

Three multi-character operators are single, atomic tokens and must be written without internal spaces:

| Token | Meaning | Used in |
|-------|---------|---------|
| `<-` | field initialization | [factories](/Koine/reference/factories/) (`total <- lines.sum(…)`) |
| `->` | state transition / directed relation | [commands & state](/Koine/reference/commands-events-state/), [context maps](/Koine/reference/context-maps-integration/) |
| `<->` | bidirectional relation | [context maps](/Koine/reference/context-maps-integration/) (`A <-> B : partnership`) |

Because of maximal munch, write `n <- v`, not `n < - v`. One consequence: a comparison against a negative literal needs a space — write `x < -1`, not `x<-1`, so the `<-` token isn't formed.

## Where to next

- New to the language? Read in sidebar order, starting with [Contexts & types](/Koine/reference/contexts-and-types/).
- Looking up one construct? Jump straight from [the construct map](#the-construct-map) above.
- Want to see it all wired together? Browse the [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo) or the [feature catalogue](/Koine/guides/feature-catalogue/).
