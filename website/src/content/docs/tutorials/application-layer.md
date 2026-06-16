---
title: "4 · The application layer"
description: "Repositories, optimistic concurrency, services, read models and queries."
---

This is part 4 of the tutorial. So far you have a rich domain: [value objects](/Koine/tutorials/values-and-invariants/), [entities and aggregates](/Koine/tutorials/entities-and-aggregates/), and an aggregate with [commands, events and a state machine](/Koine/tutorials/commands-events-state/). But a domain model is useless until something can **load it, save it, drive it, and query it**.

That is the application layer — and Koine generates almost all of it from the structure you already declared. You write *contracts*; the compiler emits persistence-ignorant interfaces, DTOs, and a unit of work that your real infrastructure implements. No domain logic leaks into them.

We will build out the `Ordering` context from the [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo): a repository for the `Order` aggregate, optimistic concurrency, an application service, a read model, and a query.

## Repositories come from aggregate roots

Every aggregate root gets a **repository interface** — for free. Declare the aggregate and Koine emits `I<Root>Repository`, keyed on the root's identity type:

```koine
aggregate Order root Order {
  entity Order identified by OrderId {
    customer: CustomerId
    lines:    List<OrderLine>
  }
}
```

That alone emits `Ordering/IOrderRepository.cs` with the full mutating set — get, add, update, remove:

```csharp
public interface IOrderRepository
{
    Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default);
    Task AddAsync(Order aggregate, CancellationToken ct = default);
    Task UpdateAsync(Order aggregate, CancellationToken ct = default);
    Task RemoveAsync(Order aggregate, CancellationToken ct = default);
}
```

The repository is keyed on the **root entity's id** (`OrderId`), and only the root gets one — non-root nested entities and standalone context-level entities never produce a repository. That is the rule that keeps aggregates the unit of persistence.

:::note
The interface is *persistence-ignorant*: no `DbContext`, no Dapper, no Mongo — just `Task`-returning method signatures. You implement it once in your infrastructure project against whatever store you like.
:::

## Tuning the repository: `operations` and `find`

The default four operations are rarely all you want, and you usually need intention-revealing finders. Add a `repository { ... }` block inside the aggregate:

```koine
repository {
  operations: getById, add, update
  find byCustomer(customer: CustomerId): List<Order>
  find mostRecent(customer: CustomerId): Order
}
```

The `operations:` clause **restricts** the mutating set — here we drop `remove` because orders are never hard-deleted. Two rules to remember:

- The order is fixed: at most one `operations:` clause, and it must come **before** any `find`.
- Operation names are a closed set: exactly `getById`, `add`, `update`, `remove`. Anything else is a compile error.

Each `find` becomes an async query method. The **result type decides the shape**: a `List<Root>` finder returns `IReadOnlyList<T>`; a bare `Root` finder returns a nullable `Root?`. Finder names are written `camelCase` and emitted PascalCase with an `Async` suffix:

```csharp
Task<IReadOnlyList<Order>> ByCustomerAsync(CustomerId customer, CancellationToken ct = default);
Task<Order?> MostRecentAsync(CustomerId customer, CancellationToken ct = default);
```

:::caution
A finder's result type must be the aggregate root or `List<Root>` — you cannot `find` your way to an arbitrary projection (use a [read model](#read-models-projecting-the-aggregate) for that). Also, don't name a finder parameter `ct`: it collides with the trailing `CancellationToken`.
:::

## Optimistic concurrency with `versioned`

Concurrent writes are a fact of life. Mark the aggregate `versioned` to opt into optimistic concurrency:

```koine
aggregate Order root Order versioned {
  // ...
}
```

`versioned` goes after `root <Entity>` and before the `{`. It does two things. First, the root entity gains a version token:

```csharp
public int Version { get; init; }
```

Second, the compiler emits a shared runtime exception, `Koine/Runtime/ConcurrencyConflictException.cs`, and the documentation on `UpdateAsync` now promises to throw it on a stale write:

```csharp
/// <summary>Enforces the aggregate's expected Version; throws ConcurrencyConflictException on a stale write.</summary>
Task UpdateAsync(Order aggregate, CancellationToken ct = default);
```

```csharp
public sealed class ConcurrencyConflictException : Exception
{
    public string TypeName { get; }
    public int ExpectedVersion { get; }
    public int ActualVersion { get; }

    public ConcurrencyConflictException(string type, int expected, int actual) { /* ... */ }
}
```

Your repository implementation compares the incoming `Version` to the stored one and throws when they diverge. `add` carries no concurrency check (the row doesn't exist yet); only `update` and `remove` do. The runtime exception is emitted **once** per build, no matter how many versioned aggregates you have.

:::caution
A `versioned` aggregate reserves the synthetic `Version` member, so a root field literally named `version` is rejected. Pick another name.
:::

## The unit of work — generated, not written

You never declare a unit of work in Koine. Any context with **at least one aggregate** gets an `IUnitOfWork` automatically — one repository property per aggregate (in declaration order), plus a save method:

```csharp
public interface IUnitOfWork
{
    IOrderRepository Orders { get; }
    Task<int> SaveChangesAsync(CancellationToken ct = default);
}
```

The property name is the **pluralized** root name (`Order` becomes `Orders`, `Category` becomes `Categories`), and the property type is that aggregate's repository interface. Like the repositories themselves, `IUnitOfWork` references **no** infrastructure namespace — it is a pure transactional boundary your store implements.

## Application services: use cases

Repositories and the unit of work are *plumbing*. The application's actual operations — the things a controller or message handler calls — are **use cases**. Declare them on a `service`:

```koine
service OrderingService {
  usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
  usecase CancelOrder(order: OrderId)
}
```

Each `usecase` becomes one async method on `IOrderingService` (the interface name is `I` + the service name):

```csharp
public interface IOrderingService
{
    Task<OrderId> PlaceOrder(CustomerId customer, IReadOnlyList<OrderLine> lines);
    Task CancelOrder(OrderId order);
}
```

Two details worth noting:

- The **return type is optional**. `PlaceOrder(...): OrderId` yields `Task<OrderId>`; `CancelOrder(...)` (no return type) yields a bare `Task`.
- `List<T>` parameters surface as `IReadOnlyList<T>` in the signature — the application boundary hands you read-only collections.

A service made entirely of use cases emits only the interface — there is no domain class to generate, because the implementation is yours to write (orchestrating the repository, factory, and unit of work).

:::tip
A service can mix `usecase` (application boundary, in `IServiceName`) with `operation` (a pure domain calculation, in a `ServiceName` class). See [specs, services & policies](/Koine/reference/specs-services-policies/) for the distinction.
:::

## Read models: projecting the aggregate

Loading a whole aggregate to render a list is wasteful. A `readmodel` declares a flat, query-optimized DTO **projected from** an aggregate — and Koine generates the mapper too:

```koine
readmodel OrderSummary from Order {
  id
  customer
  status
  lineCount: Int = lines.count
}
```

A field is either a **bare name** (resolved and typed directly from the source) or a full `name: Type = expr` derived projection. This emits a record plus a static projection extension:

```csharp
public sealed record OrderSummary(OrderId Id, CustomerId Customer, OrderStatus Status, int LineCount);

public static class OrderSummaryProjection
{
    public static OrderSummary ToOrderSummary(this Order src) =>
        new OrderSummary(src.Id, src.Customer, src.Status, src.Lines.Count);
}
```

`lineCount: Int = lines.count` becomes `src.Lines.Count`. The same expression sublanguage you met with derived fields works here — a LINQ aggregate like `lines.sum(l => l.quantity)` lowers to `.Sum(...)` and pulls in `using System.Linq;` automatically.

:::note
The `from` source must be a known type. A bare field that isn't on the source, or two fields that PascalCase to the same record member, are compile errors — the read model can never drift from its aggregate.
:::

## Queries: typed DTOs over read models

The last piece is the **query** — a named request, declared at context level, whose result is a read model:

```koine
query OrdersByStatus(status: OrderStatus): List<OrderSummary>
```

Each query emits a DTO record carrying its criteria (parameters become PascalCased properties):

```csharp
public sealed record OrdersByStatus(OrderStatus Status);
```

Whether the result is `List<OrderSummary>` or a single `OrderSummary` doesn't change the DTO — it only documents the intended result type. Alongside the DTOs, Koine emits one shared handler interface, `Koine/Runtime/IQueryHandler.cs`:

```csharp
public interface IQueryHandler<TQuery, TResult>
{
    Task<TResult> HandleAsync(TQuery query, CancellationToken ct = default);
}
```

You write `IQueryHandler<OrdersByStatus, IReadOnlyList<OrderSummary>>`, run it straight against your read store, and return the projection — no aggregate hydration required. Like the concurrency exception, `IQueryHandler` is emitted exactly once for the whole model.

:::caution
A query's result type **must** be a read model (or `List<readmodel>`), and the result type is required — unlike a use case, you can't omit it. `query` lives at context level, not inside a `service`.
:::

## The full picture

Here is the complete application layer of the `Ordering` context, assembled from every piece above:

```koine
context Ordering {

  enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }

  value Money {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "an amount cannot be negative"
  }

  aggregate Order root Order versioned {

    repository {
      operations: getById, add, update
      find byCustomer(customer: CustomerId): List<Order>
      find mostRecent(customer: CustomerId): Order
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
      total:    Money = lines.sum(l => l.lineTotal)
    }
  }

  service OrderingService {
    usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
    usecase CancelOrder(order: OrderId)
  }

  readmodel OrderSummary from Order {
    id
    customer
    status
    lineCount: Int = lines.count
  }

  query OrdersByStatus(status: OrderStatus): List<OrderSummary>
}
```

From this single declaration the compiler emits the repository, the versioned concurrency token and its exception, the unit of work, the application-service interface, the read-model record and projection mapper, the query DTO, and the shared query-handler interface — every contract your infrastructure needs, and not one line of persistence code you have to keep in sync by hand.

:::note
`Currency`, `CustomerId`, and `ProductId` are shared-kernel types the full demo declares in sibling contexts. See the [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo) for the cross-context wiring; in this snippet they stand in for any imported type.
:::

## Next

Your context is now a complete, layered model. In [part 5](/Koine/tutorials/multiple-contexts/) we split it across files and connect bounded contexts with a context map — the strategic glue that turns several aggregates into a system.
