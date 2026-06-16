---
title: "3 · Commands, events & state"
description: "Give the aggregate behaviour: commands, domain events, and a state machine."
---

This is part 3 of the tutorial. In [part 1](/Koine/tutorials/values-and-invariants/) we built value objects, and in [part 2](/Koine/tutorials/entities-and-aggregates/) we drew the aggregate boundary around an `Order` entity. So far that order is inert data with rules — you can construct it, but you can't *do* anything to it.

This part gives it behaviour. You'll write **commands** that mutate state under preconditions, **domain events** the aggregate raises when something happens, a **states** block that pins down the legal lifecycle, and a **factory** that is the only door into a valid aggregate.

We'll build up the `Order` from the `Ordering` context of the [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo).

## The order so far

Pick up where part 2 left off: an `Order` aggregate root with a `status` field driven by an enum, plus the value objects it owns.

```koine
enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }

value OrderLine {
  product:   ProductId
  quantity:  Int
  unitPrice: Money
  invariant quantity >= 1   "an order line needs at least one unit"
}

entity Order identified by OrderId {
  customer:    CustomerId
  lines:       List<OrderLine>
  status:      OrderStatus = Draft
  submittedAt: Instant?
}
```

Everything below lives **inside** the `entity Order { ... }` body.

## Commands: behaviour with preconditions

A `command` is a method that mutates the aggregate. It has three moving parts: `requires` preconditions that must hold *before* anything changes, field transitions written with the `->` arrow, and (optionally) events it emits. Here's `submit`:

```koine
/// Submit a drafted order for processing, stamping the time and
/// recording a domain event.
command submit {
  requires status == Draft   "only a draft order can be submitted"
  requires !lines.isEmpty    "cannot submit an empty order"
  status      -> Submitted
  submittedAt -> now
  emit OrderSubmitted(orderId: id, lineCount: lines.count)
}
```

Read it top to bottom — that's exactly the order it runs in:

| Construct | Meaning |
|-----------|---------|
| `requires <cond> "<msg>"` | A precondition. If it's false, the command throws **before** touching state. |
| `field -> value` | A state transition. Assigns `value` to `field`. |
| `-> now` | The current instant (`DateTimeOffset.UtcNow`). |
| `emit Event(...)` | Records a domain event (covered below). |

:::caution
The transition arrow `->` and the factory-init arrow `<-` are different tokens. Inside a `command`, mutating an existing field uses `->`. Keep them as single atomic tokens — `status -> Submitted`, not `status - > Submitted`.
:::

### What `submit` compiles to

Each command becomes a public method on the entity. Preconditions become guard clauses that throw `DomainInvariantViolationException` carrying your exact message, then the transitions run, then the invariants are re-checked, then the event is recorded:

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

    // ...legal-transition guard from the states block (see below)...
    Status = OrderStatus.Submitted;
    SubmittedAt = DateTimeOffset.UtcNow;

    // ...every entity invariant is re-checked here...

    _domainEvents.Add(new OrderSubmitted(Id, Lines.Count));
}
```

:::note
The invariant re-check at the end is automatic. After any command mutates the aggregate, **every** invariant you declared on the entity (part 1) is re-asserted — so a command can never leave the order in a state your invariants forbid. You write the rule once; Koine enforces it on construction *and* after every mutation.
:::

A second command, `cancel`, shows that a command needn't emit an event or stamp a time — it can be a single guarded transition:

```koine
/// Cancel an order that has not yet shipped.
command cancel {
  requires status != Shipped "a shipped order cannot be cancelled"
  status -> Cancelled
}
```

## Domain events

When `submit` runs it announces that something happened by emitting `OrderSubmitted`. A domain event is a small immutable record of a past fact. You declare it once, at the aggregate level (a sibling of the entity, inside `aggregate Order root Order { ... }`):

```koine
/// Raised when an order is submitted for processing.
event OrderSubmitted {
  orderId:   OrderId
  lineCount: Int
}
```

The `emit OrderSubmitted(orderId: id, lineCount: lines.count)` line inside `submit` constructs one and appends it to the aggregate's outbox. Each event compiles to a sealed record implementing `IDomainEvent`, with an `OccurredOn` timestamp added for you:

```csharp
public sealed record OrderSubmitted : IDomainEvent
{
    public OrderId OrderId { get; }
    public int LineCount { get; }
    public DateTimeOffset OccurredOn { get; init; } = DateTimeOffset.UtcNow;

    public OrderSubmitted(OrderId orderId, int lineCount) { /* ... */ }
}
```

Every aggregate root gets a domain-event outbox for free:

```csharp
private readonly List<IDomainEvent> _domainEvents = new();
public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents;
public void ClearDomainEvents() => _domainEvents.Clear();
```

Your application layer drains `DomainEvents` after persisting, dispatches them, and calls `ClearDomainEvents()`. The aggregate doesn't know or care who listens — it just records facts.

:::tip
Keep domain-event fields to ids and scalars you already have on the aggregate. They describe *what happened here*. When you need to announce something to other bounded contexts, use an `integration event` instead — see [commands, events & state machines](/Koine/reference/commands-events-state/) and [context maps & integration](/Koine/reference/context-maps-integration/).
:::

## States: guarding the lifecycle

`requires status == Draft` on `submit` stops you submitting twice. But an order has a whole lifecycle — Draft becomes Submitted becomes Paid becomes Shipped — and you don't want to repeat that machine across every command. The `states` block declares it once, over the enum-typed field that holds the state:

```koine
// The order's legal lifecycle: only these transitions are permitted.
states status {
  Draft     -> Submitted, Cancelled
  Submitted -> Paid, Cancelled
  Paid      -> Shipped, Cancelled
  Shipped
  Cancelled
}
```

Each line lists a state and the states it may move to. `Shipped` and `Cancelled` list nothing after them — they're **terminal**. Once an order ships, no transition is legal.

This isn't documentation: every `status -> X` transition inside a command is now checked against this machine at runtime. That's the extra guard you saw in `Submit()` above — moving to `Submitted` is only allowed from `Draft`:

```csharp
if (!((Status == OrderStatus.Draft)))
    throw new DomainInvariantViolationException(
        type: nameof(Order),
        rule: "illegal transition of status to Submitted");
Status = OrderStatus.Submitted;
```

The `cancel` command's `status -> Cancelled` likewise compiles to a guard that allows the move from `Draft`, `Submitted`, or `Paid` — but not from `Shipped`, because `Shipped` is terminal:

```csharp
if (!((Status == OrderStatus.Draft) || (Status == OrderStatus.Submitted) || (Status == OrderStatus.Paid)))
    throw new DomainInvariantViolationException(
        type: nameof(Order),
        rule: "illegal transition of status to Cancelled");
```

:::note
A `states` block and a `requires` precondition are complementary. The state machine enforces *which transitions exist*; `requires` enforces *the extra business conditions* on a particular command (such as `!lines.isEmpty`). Use the machine for the lifecycle, `requires` for everything else.
:::

## Factories: the only door in

There's one gap left. An order should never exist in an invalid state — but a public constructor would let callers build one however they like. A `create` factory closes that door: it's the named, validated way to bring a new aggregate into being.

```koine
/// Factory-only creation: open a draft order for a customer.
create open(customer: CustomerId, lines: List<OrderLine>) {
  requires !lines.isEmpty   "cannot open an empty order"
  emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
}
```

A factory takes the inputs a caller actually has, validates them with `requires`, and can emit a creation event. Notice it never takes an `id` — identity is generated. It compiles to a static factory method, and crucially, **the presence of any `create` makes the all-args constructor private**, so `Order.Open(...)` becomes the only way to make an order:

```csharp
public static Order Open(CustomerId customer, IReadOnlyList<OrderLine> lines)
{
    var id = OrderId.New();

    if (!(!(lines.Count == 0)))
        throw new DomainInvariantViolationException(
            type: nameof(Order),
            rule: "cannot open an empty order");

    var instance = new Order(id, customer: customer, lines: lines);
    instance._domainEvents.Add(new OrderOpened(id, customer, lines.Count));
    return instance;
}
```

The body order is fixed and worth noting: generate identity, run the `requires` guards, construct via the private constructor (which itself re-checks every invariant), record the creation event, return. A caller gets back a fully valid, freshly-eventful aggregate or an exception — never a half-built one.

:::tip
You can declare more than one factory — `Order.Open(...)`, `Order.Import(...)`, and so on — each with its own parameters and preconditions. The first `create` is enough to lock down the constructor.
:::

## The complete aggregate

Putting commands, events, the state machine, and the factory together, the `Ordering` context now reads as a small, executable specification of how an order behaves. As in [part 2](/Koine/tutorials/entities-and-aggregates/), we declare `Currency`, `Customer`, and `Product` locally so the snippet is self-contained:

```koine
/// Ordering bounded context — placing customer orders.
context Ordering {

  enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }

  value Currency { code: String }

  value Money {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "an amount cannot be negative"
  }

  entity Customer identified by CustomerId {
    name: String
  }

  entity Product identified by ProductId {
    name: String
  }

  aggregate Order root Order {

    /// Raised when an order is opened by the factory.
    event OrderOpened {
      orderId:   OrderId
      customer:  CustomerId
      lineCount: Int
    }

    /// Raised when an order is submitted for processing.
    event OrderSubmitted {
      orderId:   OrderId
      lineCount: Int
    }

    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Money
      invariant quantity >= 1   "an order line needs at least one unit"
    }

    entity Order identified by OrderId {
      customer:    CustomerId
      lines:       List<OrderLine>
      status:      OrderStatus = Draft
      submittedAt: Instant?

      invariant lines.distinctBy(l => l.product)   "no duplicate products in an order"

      // Only these transitions are permitted.
      states status {
        Draft     -> Submitted, Cancelled
        Submitted -> Paid, Cancelled
        Paid      -> Shipped, Cancelled
        Shipped
        Cancelled
      }

      /// Submit a drafted order, stamping the time and raising an event.
      command submit {
        requires status == Draft   "only a draft order can be submitted"
        requires !lines.isEmpty    "cannot submit an empty order"
        status      -> Submitted
        submittedAt -> now
        emit OrderSubmitted(orderId: id, lineCount: lines.count)
      }

      /// Cancel an order that has not yet shipped.
      command cancel {
        requires status != Shipped "a shipped order cannot be cancelled"
        status -> Cancelled
      }

      /// Open a draft order for a customer — the only way to construct one.
      create open(customer: CustomerId, lines: List<OrderLine>) {
        requires !lines.isEmpty   "cannot open an empty order"
        emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
      }
    }
  }
}
```

Here `Currency`, `Customer`, and `Product` live inside `Ordering` to keep the snippet self-contained. In the real [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo) they belong to neighbouring contexts; [part 5](/Koine/tutorials/multiple-contexts/) shows how those references cross bounded-context lines.

## Recap

You can now make an aggregate *do* things, safely:

- **`command`** — a mutating method: `requires` preconditions, `field -> value` transitions, and automatic invariant re-checks after every change.
- **`event`** — an immutable record of a past fact, raised with `emit` and collected in `DomainEvents`.
- **`states`** — a state machine over an enum field that makes illegal lifecycle transitions throw.
- **`create`** — a validated factory that generates identity and becomes the only way to construct the aggregate.

## Next

The order can now behave — but nothing can yet load it, save it, or drive it. Next we add the application layer: repositories with optimistic concurrency, the use-case service, read models, and queries — almost all of it generated from the structure you already declared.

→ Continue to [4 · The application layer](/Koine/tutorials/application-layer/).

See also the reference pages for [commands, events & state machines](/Koine/reference/commands-events-state/) and [factories](/Koine/reference/factories/).
