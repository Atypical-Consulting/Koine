---
id: 0017
title: A command publishes an integration event through a distinct `publish` clause, not a widened `emit`
status: proposed
date: 2026-08-02
tags: [language, semantics, emit-core]
links:
  - type: relates-to
    target: 0014
---

# A command publishes an integration event through a distinct `publish` clause, not a widened `emit`

## Context and Problem Statement

Koine models cross-context integration with three constructs: `integration event X { … }` (the
contract), `publishes X` (this context announces it), and `subscribes P.X` (that context reacts).
`IntegrationEventValidator` enforces the *shape* of that triangle well — KOI1409 through KOI1414 all
relate one declaration to another. What the triangle has never had is a **cause**: nothing in the
language expresses *"this command is what makes that integration event happen"*.

The block was semantic, not syntactic. `emitClause` is name-generic in the grammar, but
`EntityBehaviorValidator.ValidateEmit` resolved the emitted name and then required an `EventDecl`;
`integration event X` builds a separate `IntegrationEventDecl`, so `emit OrderPlaced` came back as
**KOI0601 `UnknownEvent`**. Both records derive from `TypeDecl` deliberately — an `EventDecl` may
reference internal value objects and an `IntegrationEventDecl` may not, which is exactly what KOI1409
enforces.

Three consequences made this worth deciding rather than leaving alone:

* `templates/pizzeria` declares `integration event OrderPlaced`, declares `publishes OrderPlaced`, is
  subscribed to by Kitchen, Delivery and Payment — and produces it from nothing. The template works
  around the gap with a near-duplicate internal twin, `OrderPlacedInternally`.
* Every code emitter generates the whole transactional outbox for a publishing context — the
  `OutboxMessage` record, the `IIntegrationEventHandler` seam, the dispatcher, and
  `UnitOfWork.Enqueue` — and **nothing emitted ever called `Enqueue`**. The emitted `IUnitOfWork`
  interface didn't even declare it, so application code couldn't reach the outbox without downcasting.
* [ADR 0014](0014-scenario-fan-out-by-reflective-in-process-dispatch.md)'s cross-context branch was
  structurally unreachable, not merely unimplemented. Its `ScenarioFanOutResolver` correctly maps a
  published event to its subscribing contexts, but the executor observes what the executed aggregate
  actually *recorded*, and no command could record a published event.

## Considered Options

* **Widen `emit`** to accept an `IntegrationEventDecl` the enclosing context declares — relax one
  guard in `ValidateEmit` and its twin in each emitter.
* **A distinct `publish` clause** — new lexer token, parser rule, `PublishClause` AST node, validator
  path, and an emitter case per target.
* **A declarative mapping** — `publishes X from Sales.place`, or a
  `translate OrderPlacedInternally -> OrderPlaced { … }` construct deriving the published event from
  an internal one.
* **Do nothing** — keep the internal-twin idiom and the hand-written relay.

## Decision Outcome

Chosen option: **a distinct `publish` clause**, because the two clauses have genuinely different
sinks and encoding that in the node type is cheaper and safer than re-deriving it from a type-test in
every emitter.

We will add `publish <IntegrationEvent>(field: expr, …)` as a command-body clause, parsed into
`PublishClause(string EventName, IReadOnlyList<EmitArg> Args) : CommandStmt` — a target-agnostic node
beside `EmitClause`, reusing `EmitArg` and the same payload syntax. `emit` keeps meaning
*intra-aggregate domain event*; `publish` means *published-language contract leaving the context*.
`publish` is the verb form of the `publishes` already in the language, so it introduces no new concept
for a reader.

Three rules bind it, in the context-map diagnostic block: the name must be an integration event of the
enclosing context (**KOI1420**), the context must declare `publishes X` (**KOI1421**), and it is legal
only on an aggregate root (**KOI1422**). Payload errors reuse `EmitPayloadMismatch` (KOI0602)
unchanged. `publishes` stays **required** — a producer does not silently widen a context's public
contract from inside a command body, because KOI1413 `SubscribeNotPublished` already keys off that
declaration.

The sinks stay distinct all the way down. `emit` renders `_domainEvents.Add(new X(…))` on a
`List<IDomainEvent>`; `publish` renders `_integrationEvents.Add(new X(…))` on a separate
`List<IIntegrationEvent>`, because an integration event record is marked `IIntegrationEvent` and the
two markers are not interchangeable. The emitted command handler then relays that list into
`IUnitOfWork.Enqueue` **before** the commit, so outbox rows land in the same transaction as the
aggregate change — and `Enqueue` is lifted onto the emitted `IUnitOfWork` interface for a publishing
context, which is what makes the seam reachable at all.

Scope is deliberately narrow: command bodies only, not factories. `emit`, `EmitClause`,
`ValidateEmit` and `BuildEmitStatement` are not modified, so a model that does not use `publish` emits
byte-identical output.

## Consequences

**Easier:**

* `publishes`/`subscribes` becomes a modelled choreography rather than a declaration pair. The
  producer is in the model, so the docs emitters, AsyncApi's `send` operation, and the scenario runner
  can all attribute a published event to the command that causes it. On the `koine/runScenario` wire
  that attribution is an **additive `"published": true` flag** on the existing `kind: "emit"` step,
  written only when the step came from a `publish` — a `publish` and an `emit` are otherwise
  shape-identical, and a timeline that cannot tell them apart cannot show a contract leaving the
  context. A fourth `kind` was rejected: `kind` is the wire's discriminated union and the Studio
  panel's `renderStep` switch has no default arm, so a new value would render a published event as an
  empty row on any client not upgraded in lockstep, whereas an unread flag degrades to the previous
  rendering. Both engines set it, so executed and interpreted mode stay at parity.
* The outbox is complete. The enqueue call site — the one piece every emitter was missing — is now
  generated, and `IUnitOfWork` exposes the seam rather than hiding it on the concrete class.
* ADR 0014's declared-only cross-context branch becomes reachable from a real executed run, so it can
  be covered by a test instead of documented as unreachable.
* No emitter has to type-test a resolved declaration to pick a sink; the AST node already says which.
* Adding the clause was purely additive, so no existing snapshot for a non-publishing model moved.

**Harder / accepted trade-offs:**

* The language now has two event-production verbs, and every current and future code emitter must
  handle both. That cost is real and recurring — it is the price of not making the sink depend on a
  type-test repeated in seven emitters plus the docs emitters, the round-trip formatter and the
  scenario interpreter.
* `publish X` requires a matching `publishes X`, so the producer and the announcement can drift out of
  sync during editing until KOI1421 catches it. Inference would be more concise; it was rejected as
  action-at-a-distance on a context's public contract.
* A published event now rides a **second** recorded list on the root. Anything that observes recorded
  events — notably the scenario executor — must read both lists, not just `DomainEvents`. This is the
  one explicit coordination point with ADR 0014, and it is a widening of a read, not a change to that
  ADR's decision: fan-out still dispatches reflectively inside the same sandbox child, `Ast/` stays
  target-agnostic, and a `subscribes` handler remains a bodiless seam reported as declared-only.
* `publish` becomes a soft keyword, which reserves the bare word `publish` wherever the grammar needs a
  plain `Identifier` — `command publish { … }`, `find publish(…)` and `operation publish(…)` no longer
  parse. That is the same break class `emit` already carries, and the same trade the language accepted
  for every other soft keyword: a domain that genuinely needs the noun can still use it as a *field*
  name, which is where it most often appears.
* The declarative `translate`/ACL-mapping route (better long-term modelling of published-language
  translation) is deferred, not rejected. It can be layered later as sugar over this producer link —
  which has to exist first, because a producer that never touches the aggregate stays invisible to an
  executor that observes what the aggregate recorded.
