---
title: "Aggregates"
description: "Aggregate roots, the consistency boundary, repositories and versioning."
---

An **aggregate** is a cluster of domain types that change together and must stay consistent as a
whole. Koine makes the aggregate boundary explicit: you name the cluster, name its **root**, and nest
the entities and value objects it owns. The root becomes the single entry point — the only type that
gets a repository and the only handle the outside world holds onto.

## The shape

```koine
aggregate <AggregateName> root <RootEntityName> {
  // value objects, events, the root entity, and (optionally) a repository block
}
```

The first identifier names the aggregate; the identifier after `root` names the **root entity**, which
**must** be declared as a nested `entity` inside the body. Everything else the aggregate owns —
[value objects](/Koine/reference/value-objects/), domain events, nested entities — lives in the same
braces.

Here is the order aggregate from the demo, trimmed to its skeleton:

```koine
context Ordering {
  enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }

  value Money {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "an amount cannot be negative"
  }

  aggregate Order root Order {
    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Money
      invariant quantity >= 1   "an order line needs at least one unit"
    }

    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
      status:   OrderStatus = Draft

      total:    Money = lines.sum(l => l.unitPrice * l.quantity)
    }
  }
}
```

The root entity is identified the same way any [entity](/Koine/reference/entities-and-identity/) is — with
`identified by <IdType>` and an optional identity strategy. See
[repositories & concurrency](/Koine/reference/repositories-concurrency/) for the identity strategies.

## What gets emitted

The root entity implements the marker interface `IAggregateRoot`, and an `I<Root>Repository` contract
is emitted for it:

```csharp
namespace Ordering;

public sealed class Order : IAggregateRoot
{
    public OrderId Id { get; }
    public CustomerId Customer { get; }
    public IReadOnlyList<OrderLine> Lines { get; }
    public OrderStatus Status { get; private set; }

    public Money Total => Lines.Select(l => l.UnitPrice * l.Quantity).Aggregate((a, b) => a + b);
    // ...
}
```

`IAggregateRoot` is a pure marker emitted once into the self-contained `Koine.Runtime` namespace:

```csharp
namespace Koine.Runtime;

/// <summary>Marks an entity as the consistency boundary (root) of an aggregate.</summary>
public interface IAggregateRoot { }
```

:::note
**The root is the consistency boundary.** Nested value objects and entities have no independent
identity outside the aggregate — they are reached *through* the root. That's why only the root gets a
repository (below) and why the root's constructor enforces every nested invariant before the aggregate
can exist.
:::

## Only the root gets a repository

Declaring an `aggregate` emits a persistence-ignorant repository interface keyed on the root's id. The
default operation set is `GetByIdAsync`, `AddAsync`, `UpdateAsync`, and `RemoveAsync`:

```csharp
namespace Ordering;

/// <summary>Persistence-ignorant repository contract for the Order aggregate root.</summary>
public interface IOrderRepository
{
    Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default);
    Task AddAsync(Order aggregate, CancellationToken ct = default);
    Task UpdateAsync(Order aggregate, CancellationToken ct = default);
    Task RemoveAsync(Order aggregate, CancellationToken ct = default);
}
```

Non-root nested entities and standalone (context-level) entities get **no** repository — you can only
load and save a whole aggregate, never one of its inner parts. To restrict the mutating set or add
intention-revealing finders, use a `repository { … }` block; that and concurrency semantics are covered
in [repositories & concurrency](/Koine/reference/repositories-concurrency/).

A context that contains at least one aggregate also gets a generated `IUnitOfWork` exposing one
repository property per aggregate plus `SaveChangesAsync`.

## Versioned aggregates

Add the `versioned` soft keyword after `root <Entity>` (before the opening brace) to opt the aggregate
into optimistic concurrency:

```koine
aggregate Order root Order versioned {
  entity Order identified by OrderId {
    customer: CustomerId
  }
}
```

The root gains a get-only `Version` token, assigned by the persistence layer:

```csharp
public sealed class Order : IAggregateRoot
{
    public OrderId Id { get; }

    /// <summary>Optimistic-concurrency token, assigned by the persistence layer.</summary>
    public int Version { get; init; }
    // ...
}
```

A shared runtime exception is emitted once into `Koine.Runtime`, and the repository's `UpdateAsync` /
`RemoveAsync` operations document that they throw it on a stale write (`AddAsync` does not):

```csharp
namespace Koine.Runtime;

/// <summary>Thrown when a versioned aggregate is saved against a stale expected version.</summary>
public sealed class ConcurrencyConflictException : Exception
{
    public string TypeName { get; }
    public int ExpectedVersion { get; }
    public int ActualVersion { get; }

    public ConcurrencyConflictException(string type, int expected, int actual) { /* ... */ }
}
```

A non-versioned aggregate emits **no** `Version` property and **no** `ConcurrencyConflictException`
file — you pay only for what you opt into.

:::caution
The synthetic `Version` member collides with any root member literally named `version`. A
`version: Int` field on a `versioned` root is rejected (`ReservedVersionMember`).
:::

## Namespacing: one context, one namespace

All types of a context — including aggregate-owned value objects, events, and nested entities — are
emitted into the single `<Context>` namespace. The `aggregate` block is a **modeling boundary**, not a
C# namespace boundary: `Order`, `OrderLine`, and `OrderOpened` all land in `namespace Ordering`.

The aggregate boundary is expressed purely by the root entity implementing `IAggregateRoot`. This keeps
generated cross-references simple (no nested namespaces to qualify) and avoids a namespace/type-name
clash when the aggregate and its root share a name (as in `aggregate Order root Order`).

:::tip
You can give the aggregate and its root **different** names. The catalog demo uses
`aggregate ProductCatalog root Product { … }` — the aggregate is `ProductCatalog`, the root entity (and
the type the repository is keyed on) is `Product`, so the contract emitted is `IProductRepository`.
:::

## A complete, copy-pasteable model

```koine
context Ordering {
  enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }

  value Money {
    amount:   Decimal
    invariant amount >= 0   "an amount cannot be negative"
  }

  aggregate Order root Order versioned {

    repository {
      operations: getById, add, update
      find byCustomer(customer: CustomerId): List<Order>
      find mostRecent(customer: CustomerId): Order
    }

    event OrderOpened {
      orderId:   OrderId
      customer:  CustomerId
      lineCount: Int
    }

    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Money
      lineTotal: Money = unitPrice * quantity
      invariant quantity >= 1   "an order line needs at least one unit"
    }

    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
      status:   OrderStatus = Draft

      total:     Money = lines.sum(l => l.lineTotal)
      lineCount: Int   = lines.count

      invariant lines.all(l => l.quantity >= 1)    "every line needs a positive quantity"

      states status {
        Draft     -> Submitted, Cancelled
        Submitted -> Paid, Cancelled
        Paid      -> Shipped, Cancelled
        Shipped
        Cancelled
      }

      command submit {
        requires status == Draft   "only a draft order can be submitted"
        requires !lines.isEmpty    "cannot submit an empty order"
        status -> Submitted
        emit OrderSubmitted(orderId: id, lineCount: lines.count)
      }

      create open(customer: CustomerId, lines: List<OrderLine>) {
        requires !lines.isEmpty   "cannot open an empty order"
        emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
      }
    }

    event OrderSubmitted {
      orderId:   OrderId
      lineCount: Int
    }
  }
}
```

This model emits the `Order` root (implementing `IAggregateRoot`, with a `Version` token), a tuned
`IOrderRepository` with two finders, the nested `OrderLine` value object, both events, and an
`IUnitOfWork` for the `Ordering` context.

## Related pages

- [Commands](/Koine/reference/commands-events-state/) — how the root mutates state and emits events behind invariants.
- [Repositories & concurrency](/Koine/reference/repositories-concurrency/) — identity strategies, the `repository { … }` block, finders, and optimistic-concurrency semantics.
- [Entities](/Koine/reference/entities-and-identity/) — identity, derived fields, and lifecycle states on the root.
- [Value objects](/Koine/reference/value-objects/) — the immutable, equality-by-value building blocks an aggregate owns.
