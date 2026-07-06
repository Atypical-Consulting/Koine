---
title: "Roadmap"
description: "An honest status report on Koine — the capabilities you can rely on today (the full DDD toolkit; C#, TypeScript, Python, PHP, Rust, and Java emitters; and editor tooling), with per-target maturity and what comes next."
---

Koine ships the **full tactical and strategic Domain-Driven Design toolkit**, emitters for six
languages, and first-class editor tooling. This page is the honest status report — organized by
**what you can do**, with a per-target maturity matrix so you know exactly what to rely on now and
what is still ahead. Every construct below is implemented, tested, and demonstrated in the
[pizzeria demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo).

## What you can do today

Everything below is live in the compiler and exercised by the demo. Each capability links to the
reference page that documents it in depth.

### Model values & shapes

| What you can do | Reference |
|-----------------|-----------|
| An expression sublanguage: conditionals, string/collection ops, lambdas, `Instant` comparison | [Expressions](/Koine/reference/expressions/) |
| Optional fields (`?`), `??`, presence checks; `Set<T>` and `Map<K,V>` | [Value objects](/Koine/reference/value-objects/) |
| Data-carrying enums, `quantity` with unit-checked arithmetic, `Range<T>` | [Enums](/Koine/reference/enums/), [Value objects](/Koine/reference/value-objects/) |

### Give models behavior

| What you can do | Reference |
|-----------------|-----------|
| `command` with `requires` preconditions and `field -> value` state transitions | [Commands, events & state](/Koine/reference/commands-events-state/) |
| `event` types, `emit` from commands, the `IDomainEvent` contract | [Commands, events & state](/Koine/reference/commands-events-state/) |
| `states` blocks: legal transition graphs with optional `when` guards | [Commands, events & state](/Koine/reference/commands-events-state/) |
| `create` factories with preconditions and creation events | [Factories](/Koine/reference/factories/) |

### Encode rules & coordination

| What you can do | Reference |
|-----------------|-----------|
| `spec` predicates, `service` with `operation`, and `policy` reactions | [Specs, services & policies](/Koine/reference/specs-services-policies/) |

### Persist & query

| What you can do | Reference |
|-----------------|-----------|
| Identity strategies (guid/natural/sequence), per-root repositories, `versioned` aggregates | [Repositories & concurrency](/Koine/reference/repositories-concurrency/) |
| `IUnitOfWork`, `usecase` services, `readmodel` projections, `query` objects + `IQueryHandler` | [Application & CQRS](/Koine/reference/application-cqrs/) |

### Design across bounded contexts

| What you can do | Reference |
|-----------------|-----------|
| Compile a directory, `import` and qualified cross-context refs, `module` sub-namespaces | [Multi-file, imports & modules](/Koine/reference/multi-file-imports-modules/) |
| `contextmap` with typed relationships, shared-kernel/ACL enforcement, integration events | [Context maps & integration](/Koine/reference/context-maps-integration/) |

### Evolve safely

| What you can do | Reference |
|-----------------|-----------|
| `context … version n`, `@since(n)` / `@deprecated("…")`, and `koine check --baseline` compatibility diffing | [CLI](/Koine/guides/cli/) |

### Work in your editor

| What you can do | Reference |
|-----------------|-----------|
| Stable diagnostic codes (`KOI…`), parser error recovery, "did you mean", soft keywords, scoped enum members | [CLI](/Koine/guides/cli/) |
| `///` doc comments and a generated Markdown glossary | [CLI](/Koine/guides/cli/) |
| A TextMate grammar, the `koine lsp` language server, and `fmt` / `init` / `watch` | [Editor tooling](/Koine/guides/editor-tooling/) |
| `koine coverage` — proof that every declaration in your model is emitted | [Model as spec](/Koine/guides/model-as-spec/) |

## Generate to your stack

The parser and semantic model are strictly **target-agnostic**, so the same `.koi` model compiles to
six languages. C# is the primary, most complete target; the others cover progressively more of the
construct set. Point `koine build` at `--target csharp | typescript | python | php | rust | java` (see the
[CLI reference](/Koine/guides/cli/#koine-build)).

### Maturity by target

Each target is verified by compiling (or type-checking) its emitted output in CI — a green build is
the proof, not a promise.

| Target | Coverage today | Proven by |
|--------|----------------|-----------|
| **C#** | Complete — every construct in the [feature catalogue](/Koine/guides/feature-catalogue/): tactical through strategic, application/CQRS, and versioning | Roslyn compile **and execute** |
| **Python** | Full tactical **and** strategic/CQRS layer — value objects, smart enums, entities, events, read models, queries, policies, and context-map/ACL translators | `mypy --strict` + `ast.parse` |
| **PHP** | Full tactical **and** strategic/CQRS layer | `phpstan` + `php -l` |
| **Rust** | Tactical core plus multi-context references and the CQRS read side — value objects, smart enums, entities/aggregates, factories, events, query DTOs, read-model projections, and repository traits | `cargo check` |
| **Java** | Tactical core plus events/commands/repositories — value objects & events as validating `record`s, smart enums, entities/aggregates with invariant-guarded behaviors, generated IDs, a sealed `DomainEvent`, and repository interfaces; multi-context references package-qualify; dependency-free Java 17 | `javac --release 17` |
| **TypeScript** | Tactical core — value objects, identity-equal entities, smart enums as typed `const` objects, `*Id` branded primitives | `tsc --noEmit --strict` |

## A taste of the shipped surface

The features compose. Here is behavior (commands, events, a state machine) and model versioning in one
aggregate, all generating compiling C# today:

```koine
context Sales version 3 {

  enum OrderStatus { Draft, Placed, Shipped, Cancelled }

  event OrderPlaced {
    orderId:   OrderId
    placedAt:  Instant
    lineCount: Int
  }

  aggregate Order root Order {

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
      @deprecated("use lines.count") legacyCount: Int = 0

      states status {
        Draft   -> Placed, Cancelled
        Placed  -> Shipped, Cancelled
        Shipped
        Cancelled
      }

      command place {
        requires lines.isNotEmpty "cannot place an empty order"
        status -> Placed
        emit OrderPlaced(orderId: id, placedAt: now, lineCount: lines.count)
      }
    }
  }
}
```

For the complete, copy-pasteable showcase, browse the
[pizzeria template `.koi` files](https://github.com/Atypical-Consulting/Koine/tree/main/templates/pizzeria)
and the [emitted C#](https://github.com/Atypical-Consulting/Koine/tree/main/demo/Pizzeria.Domain/Generated)
the demo produces from them.

## What's next

- **Broaden TypeScript** to the strategic/CQRS layer, for parity with Python and PHP.
- **A structured multi-target config block** — `targets.<name> = { … }` for per-target namespace maps,
  `Instant` mapping, and output layout — is sketched in the scaffolded `koine.config` but not yet wired
  up (see the [CLI reference](/Koine/guides/cli/)).
- **Deeper Rust coverage** as the emitter matures beyond its current tactical-plus-CQRS surface.

Every capability above is written up as actionable user stories — with personas, *As a … I want … so
that …* statements, testable acceptance criteria, and priorities — in
[`USER-STORIES.md`](https://github.com/Atypical-Consulting/Koine/blob/main/USER-STORIES.md), the
contributor roadmap.

## Where to go next

- New here? Start with [What is Koine?](/Koine/start/what-is-koine/) and
  [your first model](/Koine/start/your-first-model/).
- Want the complete construct list? See the [feature catalogue](/Koine/guides/feature-catalogue/).
- Curious what the compiler emits? Read [reading the output](/Koine/start/reading-the-output/).
