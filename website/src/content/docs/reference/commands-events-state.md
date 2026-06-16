---
title: "Commands, events & state machines"
description: "Behaviour on the aggregate: commands, domain events, and lifecycle guards."
---

So far the [entities](/Koine/reference/entities-and-identity/) and [value objects](/Koine/reference/value-objects/)
you have seen are structural — they describe shape and invariants. This page covers the three constructs that
give an aggregate *behaviour*: `command` mutates state, `event` records that something happened, and `states`
constrains which transitions are even legal.

All three live inside the root `entity` of an `aggregate`, and they all reinforce the same rule: **an aggregate
can never be observed in an invalid state.** A command re-checks every invariant *after* it mutates, and an
illegal lifecycle transition throws before any field changes.

## Commands

A `command` is a named, intention-revealing mutation. It declares preconditions with `requires`, assigns fields
with the transition operator `->`, and may `emit` domain events. It compiles to a `public void` method on the
entity (commands with parameters take those parameters) — or, when it declares a return type, a method that
hands a value back (see [Returning a value](#returning-a-value)).

```koine
command submit {
  requires status == Draft   "only a draft order can be submitted"
  requires !lines.isEmpty    "cannot submit an empty order"
  status      -> Submitted
  submittedAt -> now
  emit OrderSubmitted(orderId: id, lineCount: lines.count)
}
```

That command emits:

```csharp
public void Submit()
{
    if (!(Status == OrderStatus.Draft))
        throw new DomainInvariantViolationException(
            type: nameof(Order),
            rule: "only a draft order can be submitted");

    if (!(!(Lines.Count == 0)))
        throw new DomainInvariantViolationException(
            type: nameof(Order),
            rule: "cannot submit an empty order");

    // legal-transition guard injected by `states` (see below)
    if (!((Status == OrderStatus.Draft)))
        throw new DomainInvariantViolationException(
            type: nameof(Order),
            rule: "illegal transition of status to Submitted");
    Status = OrderStatus.Submitted;
    SubmittedAt = DateTimeOffset.UtcNow;

    // every aggregate invariant is re-checked here...
    _domainEvents.Add(new OrderSubmitted(Id, Lines.Count));
}
```

The body of a command runs in a fixed order:

1. **`requires` preconditions** — each becomes a guard that throws `DomainInvariantViolationException` with
   your message *before* any mutation.
2. **`field -> value` transitions** — straight assignments. Assigning a field that an enum `states` block
   governs also injects the legal-transition guard.
3. **`emit Evt(...)`** — records a domain event (see [Events](#domain-events)).
4. **Post-transition invariant re-check** — every aggregate invariant is evaluated again, so a command can
   never leave the aggregate in a state its `invariant`s forbid.

:::note
The `->` token (RARROW) is the **state-effect** arrow. It is used both for **transitions** in command
bodies and `states` blocks and for [factory](/Koine/reference/factories/) field **initialization** — the
enclosing `command {}` vs `create {}` block, not the arrow, distinguishes mutate from init. Keep the two
characters adjacent — write `status -> Submitted`, never `status - > Submitted`. Koine has just two
assignment-like arrows: `=` (declaration default) and `->` (state effect).
:::

### Preconditions vs. invariants

`requires` and `invariant` look similar but answer different questions:

| | Where | Checks | Failure |
|---|---|---|---|
| `invariant` | entity / value body | always true at construction *and* after every command | structural — the aggregate is malformed |
| `requires` | inside a `command` | true *before* this specific mutation runs | this command isn't applicable right now |

So `requires status == Draft` says "you can only submit a draft", while the aggregate-level `invariant
lines.all(...)` says "an order must always have valid lines, no matter how it got there".

### Commands with parameters

A command can take parameters, which become method parameters. Field names assigned by `->` reference the
parameters and existing members directly:

```koine
command record(amount: Decimal) {
  balance -> amount
}
```

```csharp
public void Record(decimal amount)
{
    Balance = amount;
}
```

`record` (lowercase) is fine as a command name — Koine PascalCases it to the C# method `Record`.

### Returning a value

A command is normally `void` — it mutates and emits. But the mainstream DDD case *"a command returns the
identity of what it created"* (a generated token, a receipt id, a child entity's id) needs the command to hand
a value back. Declare a return type after the signature with `: Type`, then end the body with a `result`
clause naming the expression to return:

```koine
command cancel(): OrderId {
  requires status != Cancelled "already cancelled"
  status -> Cancelled
  emit OrderCancelled(orderId: id)
  result id
}
```

```csharp
public OrderId Cancel()
{
    if (Status == OrderStatus.Cancelled)
        throw new DomainInvariantViolationException(
            type: nameof(Order),
            rule: "already cancelled");

    Status = OrderStatus.Cancelled;

    var __result = Id;
    _domainEvents.Add(new OrderCancelled(__result));

    return __result;
}
```

The `result` expression is evaluated over the **post-mutation** state, in the same scope as `emit` payloads, so
it can reference parameters, `id`, and just-assigned fields. It is the **terminal** statement: the value is only
returned from a fully-valid, fully-eventful aggregate (after the precondition guards, the post-transition
invariant re-check, and every `emit`). When the same value is also carried by an event — the *create-and-return-id*
idiom — Koine hoists it into a single `var __result`, computing it once. A result that no event references is
returned inline (`return <expr>;`).

Rules:

- `result` requires a declared return type. A `result` with no `: Type` is reported (`KOI0506`).
- A declared return type requires **exactly one** `result` clause — zero or more than one is reported (`KOI0507`).
- The `result` expression must be assignable to the declared return type (`KOI0508`).

This mirrors what [factories](/Koine/reference/factories/) (which already `return` the aggregate) and
[use-cases](/Koine/reference/application-layer/) (which already take an optional `: Type` mapping to `Task<T>`)
have always done. Commands without a return type are unchanged — they stay `public void`.

## Domain events

An `event` is a record of a fact that has happened. Declare it as a sibling member of the aggregate, then
`emit` it from a command or [factory](/Koine/reference/factories/):

```koine
event OrderSubmitted {
  orderId:   OrderId
  lineCount: Int
}
```

This compiles to an immutable record implementing the `IDomainEvent` runtime interface, with PascalCase
properties and an auto-stamped `OccurredOn`:

```csharp
public sealed record OrderSubmitted : IDomainEvent
{
    public OrderId OrderId { get; }
    public int LineCount { get; }
    public DateTimeOffset OccurredOn { get; init; } = DateTimeOffset.UtcNow;

    public OrderSubmitted(OrderId orderId, int lineCount)
    {
        OrderId = orderId;
        LineCount = lineCount;
    }
}
```

### Emitting and collecting events

`emit Evt(field: expr, ...)` appends an event instance to the aggregate's event collection. The first time any
member of the root `emit`s, Koine generates the event infrastructure on the root entity:

```csharp
private readonly List<IDomainEvent> _domainEvents = new();
public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents;
public void ClearDomainEvents() => _domainEvents.Clear();
```

Your application's unit of work reads `DomainEvents` after persisting the aggregate, dispatches them, then calls
`ClearDomainEvents()`. The `emit` argument names map positionally onto the event's constructor — `emit
OrderSubmitted(orderId: id, lineCount: lines.count)` becomes `new OrderSubmitted(Id, Lines.Count)`.

:::tip
For events you want to publish *outside* the bounded context, declare an `integration event` and `publishes`
it. Those keep their payload primitive and wire into the context map. See
[context maps & integration events](/Koine/reference/context-maps-integration/).
:::

## State machines

A `states` block declares the **legal lifecycle** of an enum-typed field. Each line lists a source state and the
states it may legally transition to, using the same `->` token. Terminal states are listed on their own.

```koine
enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }

states status {
  Draft     -> Submitted, Cancelled
  Submitted -> Paid, Cancelled
  Paid      -> Shipped, Cancelled
  Shipped
  Cancelled
}
```

`states status` names the governed field (`status: OrderStatus`). The block by itself emits nothing — it is a
*constraint*. Its effect appears wherever a command assigns that field: Koine injects a guard that allows the
assignment only if the current state legally transitions to the target.

Because the `submit` command does `status -> Submitted`, and only `Draft` may reach `Submitted`, the emitted
method gets:

```csharp
if (!((Status == OrderStatus.Draft)))
    throw new DomainInvariantViolationException(
        type: nameof(Order),
        rule: "illegal transition of status to Submitted");
Status = OrderStatus.Submitted;
```

A `cancel` command targeting `Cancelled` — reachable from `Draft`, `Submitted`, or `Paid` but *not* `Shipped` —
gets an OR of all legal sources:

```csharp
if (!((Status == OrderStatus.Draft) || (Status == OrderStatus.Submitted) || (Status == OrderStatus.Paid)))
    throw new DomainInvariantViolationException(
        type: nameof(Order),
        rule: "illegal transition of status to Cancelled");
Status = OrderStatus.Cancelled;
```

So a command can carry its *own* `requires` precondition (a business rule like "a shipped order cannot be
cancelled") and still get the structural transition guard for free from the `states` block — they stack.

:::caution
A field governed by a `states` block becomes `{ get; private set; }` so only commands can move it. Make sure
every state your commands transition *to* is reachable in the `states` block, or the generated guard will reject
the assignment at runtime.
:::

## Full example: the Payment aggregate

Here is a complete, copy-pasteable context that combines a state machine, two commands, a creation event, and a
[factory](/Koine/reference/factories/). Adapted from the demo's `payments.koi`:

```koine
context Payments version 1 {

  enum PaymentMethod { Card, Transfer, Voucher }
  enum PaymentStatus { Authorized, Captured, Refunded, Failed }

  value Money {
    amount:   Decimal
    currency: String
    invariant amount >= 0   "an amount cannot be negative"
  }

  aggregate Payment root Payment {

    /// Raised when a payment is authorized.
    event PaymentAuthorized {
      payment: PaymentId
      order:   OrderId
    }

    entity Payment identified by PaymentId {
      order:  OrderId
      amount: Money
      method: PaymentMethod
      status: PaymentStatus = Authorized

      states status {
        Authorized -> Captured, Failed
        Captured   -> Refunded
        Refunded
        Failed
      }

      /// Capture an authorized payment.
      command capture {
        requires status == Authorized   "only an authorized payment can be captured"
        status -> Captured
      }

      /// Refund a captured payment.
      command refund {
        requires status == Captured     "only a captured payment can be refunded"
        status -> Refunded
      }

      /// Authorize a payment for an order.
      create authorize(order: OrderId, amount: Money, method: PaymentMethod) {
        emit PaymentAuthorized(payment: id, order: order)
      }
    }
  }
}
```

:::note
`PaymentId` and `OrderId` are id value objects (`identified by PaymentId`). When compiling a single file,
`OrderId` must be declared or imported; in the demo it is brought in across contexts. See
[entities & identity](/Koine/reference/entities-and-identity/).
:::

## Where to go next

- [Factories](/Koine/reference/factories/) — the `create` block, the `->` initialization
  operator, and why the all-args constructor goes private.
- [Aggregates](/Koine/reference/aggregates/) — the consistency boundary that owns these
  commands and events.
- [Context maps & integration events](/Koine/reference/context-maps-integration/) — `integration event`,
  `publishes`/`subscribes`, and reacting to events across contexts.
- [Specs, services & policies](/Koine/reference/specs-services-policies/) — reacting to a domain event with
  `policy … when Event then Target.command(…)`.
