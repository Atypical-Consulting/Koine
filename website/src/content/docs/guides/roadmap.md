---
title: "Roadmap"
description: "What Koine ships today (R1–R17: full DDD toolkit, TypeScript, Python Phase 1, and editor tooling) and what comes next."
---

Koine is built as a sequence of **epics** (R1–R17), each a cohesive slice of Domain-Driven Design
capability. The compiler ships the **full tactical and strategic toolkit (R1–R15)**, the
**R16 multi-target emitters** (TypeScript and Python Phase 1), and the
**R17 editor tooling** — the TextMate grammar, the `koine lsp` language server, and the
`fmt`/`init`/`watch` commands. Every construct described in the reference is implemented, tested,
and demonstrated in the [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo).

This page is the honest status report — what you can rely on now, and what is still ahead.

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

## Shipped: R16 — Multi-target emitters (partial)

R16 is the capstone that proves the `IEmitter` seam is genuinely target-agnostic. Three of four
stories are delivered; Rust remains on the roadmap.

- **R16.1 — C# emitter configuration.** ✅ **Delivered** — a `koine.config` options object to remap
  contexts to concrete namespaces, choose the `Instant` mapping (`DateTimeOffset` default or NodaTime),
  and control output layout.
- **R16.2 — TypeScript emitter.** ✅ **Delivered** — `koine build model.koi --target typescript`
  producing idiomatic TypeScript: value objects, identity-equal entities, smart enums as typed
  `const` objects, `*Id` branded primitives. Output passes `tsc --noEmit --strict`.
- **R16.3 — Python emitter (Phase 1: tactical core).** ✅ **Delivered** — `koine build model.koi
  --target python` producing dependency-free Python 3.11+ from the tactical core:
  - `@dataclass(frozen=True)` value objects with invariant checks
  - `enum.Enum` smart enums (including data-carrying enums with associated fields)
  - Identity-equal entities with `Guid`/natural/sequence ID strategies
  - Frozen-dataclass domain events
  - `typing.Protocol` repository and service interfaces
  - Output is `mypy --strict`-clean and passes `ast.parse` syntax checking.
  - *Phase 2 (CQRS/strategic layer: read models, queries, policies, state machines, context maps)
    is not yet emitted in Python — document those as C#/TypeScript only.*
- **R16.4 — Rust emitter.** Not yet implemented. Invariants will surface as `Result<T, DomainError>`
  rather than panics — the strongest test of the seam. Fixture must pass `cargo check`.
- **R16.5 — Conformance harness.** ✅ **Delivered** — a suite that runs every fixture through each
  registered emitter and compiles the output (Roslyn for C#, `tsc` for TS, `mypy` for Python), plus an
  `AstPurityTests` guard that fails the build if anything under `Ast/` references a target-specific concept.

## Shipped: R17 — Editor tooling & developer experience

R17 closes the gap between "a compiler exists" and "developers enjoy writing `.koi`". **All three
stories are now delivered.**

- **R17.1 — TextMate grammar.** ✅ **Delivered** — syntax highlighting for VS Code and Rider.
  See [`tooling/README.md`](https://github.com/Atypical-Consulting/Koine/blob/main/tooling/README.md).
- **R17.2 — Language Server.** ✅ **Delivered** — a `koine lsp` server, reusing the compiler for
  diagnostics, hover, completion, and cross-file go-to-definition, backed by a workspace index over
  all `.koi` files. See the [editor tooling](/Koine/guides/editor-tooling/) guide.
- **R17.3 — `koine fmt`, `init`, and `watch`.** ✅ **Delivered** — a canonical, idempotent
  token-stream formatter (with `--check` for CI), a one-command project scaffold (`koine init`, with
  `--force`), and a `koine watch` mode that re-emits on every change for fast feedback. See the
  [CLI reference](/Koine/guides/cli/#koine-fmt).

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
