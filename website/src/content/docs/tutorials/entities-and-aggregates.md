---
title: "2 · Entities & aggregates"
description: "Add identity, aggregates, roots, and child value objects to your model."
---

In [part 1](/Koine/tutorials/values-and-invariants/) you modelled `Money` — a thing defined entirely by its
fields. But an *order* isn't like that. Two orders with identical lines are still two different orders.
What distinguishes them is **identity**: each one has its own `OrderId` that stays stable as the order
changes over its lifetime.

That distinction — identity vs. value — is the heart of this page. You'll turn the loose value objects
from part 1 into a real **aggregate**: a cluster of objects with a single **root entity** that guards a
consistency boundary.

## Value vs. entity

| | Value object | Entity |
|---|---|---|
| Identity | none — equality is by value | a dedicated `*Id` |
| Equality | all fields compared | **identity only** |
| Keyword | `value X { … }` | `entity X identified by XId { … }` |
| Emitted equality | `GetEqualityComponents()` over fields | compares `Id` and nothing else |

Two `Money`s of `10 EUR` are *the same money*. Two orders with the same lines are *different orders*.
Koine encodes exactly that difference in the generated `Equals`/`GetHashCode`.

## Declaring an entity

An entity is introduced with `entity ... identified by`. The identity type is a value object you don't
have to write by hand — Koine generates it:

```koine
entity Order identified by OrderId {
  customer: CustomerId
  status:   OrderStatus = Draft
}
```

This emits two types. First, the identity itself — a strongly-typed `Guid` wrapper with a `New()` factory:

```csharp
public sealed class OrderId : ValueObject
{
    public Guid Value { get; }
    public OrderId(Guid value) => Value = value;
    public static OrderId New() => new(Guid.NewGuid());

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Value;
    }
}
```

Second, the entity, whose equality ignores every field except `Id`:

```csharp
public bool Equals(Order? other) => other is not null && Id.Equals(other.Id);
public override bool Equals(object? obj) => Equals(obj as Order);
public override int GetHashCode() => Id.GetHashCode();
```

:::note
`Guid` is the default identity strategy. If your key is a meaningful string or integer — a SKU, an
invoice number — use `identified by Sku as natural(String)` (a validated string key, no `New()`),
`as natural(Int)`, or `as sequence` for a store-assigned `long`. See
[entities & identity](/Koine/reference/entities-and-identity/).
:::

## Wrapping it in an aggregate

A single entity is rarely interesting on its own. An order *has lines*; a customer *has addresses*. DDD
calls such a cluster an **aggregate**, with one **root** entity that's the only legal entry point. You
declare it with `aggregate ... root`:

```koine
aggregate Order root Order {
  // the root entity + the value objects it owns live here
}
```

The root entity implements the `IAggregateRoot` marker, which is how Koine expresses the boundary —
all the aggregate's types still share the one `<Context>` namespace:

```csharp
public sealed class Order : IAggregateRoot
{
    public OrderId Id { get; }
    // ...
}
```

:::note
Naming the aggregate the same as its root (`aggregate Order root Order`) compiles, but Koine flags it
with a code-smell warning (`KOI0109`). The boundary is a *cluster* the root presides over, not the root
itself — it reads as more than its root when you name it for the activity it groups, e.g.
`aggregate Sales root Order`. The root just has to be an entity declared inside the aggregate block.
:::

## Child value objects: `OrderLine`

The lines of an order have no identity of their own — a line is fully described by its product, quantity,
and price. So a line is a **value object**, declared *inside* the aggregate alongside the root. This is the
classic shape: an entity root composed of child values.

```koine
value OrderLine {
  product:   ProductId
  quantity:  Int
  unitPrice: Money
  lineTotal: Money = unitPrice * quantity
  invariant quantity >= 1   "an order line needs at least one unit"
}
```

`OrderLine` emits a normal `ValueObject` with value equality over all three stored fields and a guarded
constructor — exactly the machinery you met in [part 1](/Koine/tutorials/values-and-invariants/).

## Collections and optional fields

The root holds *many* lines. Koine has two collection types and an optional marker:

| Koine | C# | Notes |
|---|---|---|
| `List<T>` | `IReadOnlyList<T>` | ordered; defensively copied in the constructor |
| `Set<T>` | `IReadOnlySet<T>` | unordered, de-duplicated |
| `T?` | `T?` (nullable) | an optional field; use `.isPresent` to test it |

Put together, the order root looks like this:

```koine
entity Order identified by OrderId {
  customer:    CustomerId
  lines:       List<OrderLine>
  status:      OrderStatus = Draft
  submittedAt: Instant?

  total:       Money = lines.sum(l => l.payable)
  lineCount:   Int   = lines.count
  isPlaced:    Bool  = submittedAt.isPresent

  invariant lines.all(l => l.quantity >= 1)   "every line needs a positive quantity"
}
```

A few things are happening:

- `lines: List<OrderLine>` becomes an `IReadOnlyList<OrderLine>`, copied into a fresh list in the
  constructor so callers can't mutate it behind the aggregate's back.
- `submittedAt: Instant?` is an optional timestamp — `DateTimeOffset?` in C#. The derived `isPlaced`
  reads it with `submittedAt.isPresent`, which compiles to `SubmittedAt is not null`.
- The derived `total` and `lineCount` use the same derived-field syntax you met in
  [part 1](/Koine/tutorials/values-and-invariants/), but now they fold over the `lines` collection, and the
  invariant checks *every* line.

:::caution
A `List<T>` field maps to a read-only collection on purpose: an aggregate owns its children. You change
the order through the root's behaviour (commands and factories, covered in
[part 3](/Koine/tutorials/commands-events-state/)), never by reaching into `Lines` directly.
:::

## The full model so far

Here's the aggregate as one compiling slice — copy it into a `.koi` file and run `koine build`. It
references `CustomerId`, `ProductId`, and `Currency`, so we declare those identities and shared types
locally to keep it self-contained.

```koine
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

    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Money
      lineTotal: Money = unitPrice * quantity
      payable:   Money = if quantity >= 10 then lineTotal * 0.9 else lineTotal
      invariant quantity >= 1   "an order line needs at least one unit"
    }

    entity Order identified by OrderId {
      customer:    CustomerId
      lines:       List<OrderLine>
      status:      OrderStatus = Draft
      submittedAt: Instant?

      total:       Money = lines.sum(l => l.payable)
      lineCount:   Int   = lines.count
      isPlaced:    Bool  = submittedAt.isPresent

      invariant lines.all(l => l.quantity >= 1)   "every line needs a positive quantity"
    }
  }
}
```

## What you also got for free

Declaring an aggregate root does more than emit a class. Koine also generates an
`IOrderRepository` — a persistence-ignorant contract for loading and storing the aggregate:

```csharp
public interface IOrderRepository
{
    Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default);
    Task AddAsync(Order aggregate, CancellationToken ct = default);
    Task UpdateAsync(Order aggregate, CancellationToken ct = default);
    Task RemoveAsync(Order aggregate, CancellationToken ct = default);
}
```

You don't implement this yet — and you don't have to think about it until
[part 4](/Koine/tutorials/application-layer/), where we tune the repository, add intention-revealing
finders, and wire up the application service. For now it's enough to know the boundary you drew is the
boundary that gets persisted.

## Where we are

You now have an aggregate with a root entity (identity-only equality, a generated `OrderId`), a child
value object (`OrderLine`), a `List<T>` of those children, and an optional `Instant?`. The shape is right
— but the order is still inert. It can't be opened, submitted, or cancelled, and nothing stops a caller
from putting it in a nonsensical state.

That's [part 3 · Commands, events & state](/Koine/tutorials/commands-events-state/), where the order
learns to behave.
