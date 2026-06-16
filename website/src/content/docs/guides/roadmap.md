---
title: "Roadmap"
description: "What Koine ships today (R1–R15) and what comes next (R16 multi-target emitters, R17 editor tooling)."
---

Koine is built as a sequence of **epics** (R1–R17), each a cohesive slice of Domain-Driven Design
capability. The compiler is **feature-complete through R15**: every tactical and strategic construct
described in the reference is implemented, tested, and demonstrated in the [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo).

This page is the honest status report — what you can rely on now, and what is still ahead.

:::caution[C# only, for now]
Koine emits **C# exclusively** today. The parser and semantic model are kept strictly target-agnostic
(no C# concepts leak into `Ast/`), which is what makes the planned TypeScript and Rust emitters
possible — but they are **not shipped yet**. If you need another target language, that work lives in
[R16](#r16--multi-target-emitters), still on the roadmap.
:::

## Shipped: R1–R15

Everything below is live in the compiler and exercised by the demo. Each row links to the reference
page that documents it in depth.

| Epic | Capability | Reference |
|------|-----------|-----------|
| R1 | Expression sublanguage: conditionals, string/collection ops, lambdas, `Instant` comparison | [Expressions](/Koine/reference/expressions/) |
| R2 | Optional fields (`?`), `??`, presence checks; `Set<T>` and `Map<K,V>` | [Value objects](/Koine/reference/value-objects/) |
| R3 | Stable diagnostic codes (`KOI…`), parser error recovery, "did you mean", soft keywords, scoped enum members | [CLI](/Koine/guides/cli/) |
| R4 | `///` doc comments and a generated Markdown glossary | [CLI](/Koine/guides/cli/) |
| R5 | `command` with `requires` preconditions and `field -> value` state transitions | [Commands, events & state](/Koine/reference/commands-events-state/) |
| R6 | `event` types, `emit` from commands, the `IDomainEvent` contract | [Commands, events & state](/Koine/reference/commands-events-state/) |
| R7 | `states` blocks: legal transition graphs with optional `when` guards | [Commands, events & state](/Koine/reference/commands-events-state/) |
| R8 | `create` factories with preconditions and creation events | [Factories](/Koine/reference/factories/) |
| R9 | Richer value objects: data-carrying enums, `quantity` with unit-checked arithmetic, `Range<T>` | [Enums](/Koine/reference/enums/), [Value objects](/Koine/reference/value-objects/) |
| R10 | `spec`, `service` with `operation`, and `policy` reactions | [Specs, services & policies](/Koine/reference/specs-services-policies/) |
| R11 | Identity strategies (guid/natural/sequence), per-root repositories, `versioned` aggregates | [Repositories & concurrency](/Koine/reference/repositories-concurrency/) |
| R12 | `IUnitOfWork`, `usecase` services, `readmodel` projections, `query` objects + `IQueryHandler` | [Application & CQRS](/Koine/reference/application-cqrs/) |
| R13 | Compile a directory, `import` and qualified cross-context refs, `module` sub-namespaces | [Multi-file, imports & modules](/Koine/reference/multi-file-imports-modules/) |
| R14 | `contextmap` with typed relationships, shared-kernel/ACL enforcement, integration events | [Context maps & integration](/Koine/reference/context-maps-integration/) |
| R15 | `context … version n`, `@since(n)` / `@deprecated("…")`, and `koine check --baseline` compatibility diffing | [CLI](/Koine/guides/cli/) |

### A taste of the shipped surface

The features compose. Here is R5–R7 (commands, events, a state machine) and R15 (versioning) in one
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
[Shop demo `.koi` files](https://github.com/Atypical-Consulting/Koine/tree/main/demo/Shop.Domain/Models)
and the [emitted C#](https://github.com/Atypical-Consulting/Koine/tree/main/demo/Shop.Domain/Generated)
right next to them.

## Next: R16–R17

These epics are specified but **not yet implemented**. The acceptance criteria below are summarized from
[`USER-STORIES.md`](https://github.com/Atypical-Consulting/Koine/blob/main/USER-STORIES.md), which holds
the full gap analysis.

### R16 — Multi-target emitters

This is the capstone that proves the `IEmitter` seam is genuinely target-agnostic. Four stories:

- **R16.1 — C# emitter configuration.** A structured options object (via `koine.config` and/or CLI
  flags) to remap contexts to concrete namespaces, choose the `Instant` mapping (the current
  `DateTimeOffset` default **or NodaTime**, replacing the literal `// TODO: NodaTime` in the type
  mapper), and control output layout (`filePerType` / `filePerContext` / `filePerAggregate`).
- **R16.2 — TypeScript emitter.** `koine build model.koi --target typescript` producing idiomatic value
  objects, identity-equal entities, and enums (or string-literal unions), with `*Id` types as branded
  primitives. The full fixture must pass `tsc --noEmit`.
- **R16.3 — Rust emitter.** `koine build model.koi --target rust`, where invariants surface as
  `Result<T, DomainError>` constructors rather than panics — the strongest test of the seam, since the
  exception-vs-`Result` decision must live entirely in the emitter. The fixture must pass `cargo check`.
- **R16.4 — Conformance harness.** A shared suite that runs every fixture through every registered
  emitter and compiles the output (Roslyn for C#, `tsc` for TS, `cargo check` for Rust), plus a guard
  test that fails the build if anything under `Ast/` references a target-specific concept.

:::note
Until R16 lands, `koine build --target` accepts only `csharp` and `glossary`; any other value is a usage
error. The roadmap deliberately sequences emitters **last** so they build on a mature, stable AST.
:::

### R17 — Editor tooling & developer experience

Three stories that close the gap between "a compiler exists" and "developers enjoy writing `.koi`":

- **R17.1 — TextMate grammar.** ✅ **Already delivered** — syntax highlighting for VS Code and Rider.
  See [`tooling/README.md`](https://github.com/Atypical-Consulting/Koine/blob/main/tooling/README.md).
- **R17.2 — Language Server.** ✅ A `koine lsp` server is **already in place**, reusing the compiler for
  diagnostics, hover, completion, and cross-file go-to-definition. R17.2 tracks rounding it out further
  (richer completion and hover coverage). See the [editor tooling](https://github.com/Atypical-Consulting/Koine/blob/main/tooling/README.md) docs.
- **R17.3 — `koine fmt`, `init`, and `watch`.** A canonical idempotent formatter (with `--check`), a
  one-command project scaffold, and a `watch` mode that re-emits on change with fast feedback. **Not yet
  implemented.**

## The full gap analysis

Every epic above is written up as actionable user stories — with personas, *As a … I want … so that …*
statements, testable acceptance criteria, and priorities — in
[`USER-STORIES.md`](https://github.com/Atypical-Consulting/Koine/blob/main/USER-STORIES.md). It also
documents the sequencing rationale: R1–R4 sharpen the existing surface, R5–R10 add tactical behaviour,
R11–R12 add the persistence and application layers, R13–R15 unlock strategic design, and R16–R17 prove
target-agnosticism and round out the developer experience.

## Where to go next

- New here? Start with [What is Koine?](/Koine/start/what-is-koine/) and
  [your first model](/Koine/start/your-first-model/).
- Want the complete construct list? See the [feature catalogue](/Koine/guides/feature-catalogue/).
- Curious what the compiler emits? Read [reading the output](/Koine/start/reading-the-output/).
