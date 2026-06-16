---
title: "Application layer & CQRS"
description: "Unit of work, application services, read models and query objects."
---

Koine's domain model — entities, value objects, aggregates — describes the *write* side of your system. The application layer wires that model into the outside world: a transactional boundary (`IUnitOfWork`), use-case entry points (application services), and a *read* side built from flat projections (`readmodel`) and query DTOs (`query`).

Everything on this page is a pure abstraction. The emitted interfaces and records carry **no** infrastructure dependencies — no Entity Framework, no Dapper, no `DbContext`. You implement them in your host project however you like; Koine just gives you the shapes.

## Unit of work

You never write a unit of work in `.koi`. It is **emergent**: any context that declares at least one `aggregate` automatically gets one `IUnitOfWork` interface, with one repository property per aggregate (in declaration order) plus a `SaveChangesAsync`.

Take the Ordering context, which has a single `Order` aggregate:

```koine
context Ordering version 1 {
  aggregate Order root Order versioned {
    repository {
      operations: getById, add, update
      find byCustomer(customer: CustomerId): List<Order>
      find mostRecent(customer: CustomerId): Order
    }
    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
      status:   OrderStatus = Draft
    }
  }
}
```

That emits `Ordering/IUnitOfWork.cs`:

```csharp
namespace Ordering;

/// <summary>Transactional boundary over this context's aggregate repositories.</summary>
public interface IUnitOfWork
{
    IOrderRepository Orders { get; }

    Task<int> SaveChangesAsync(CancellationToken ct = default);
}
```

Each property:

- is typed `I<Root>Repository` — the repository interface Koine generates from the aggregate (see [aggregates & repositories](/Koine/reference/aggregates/)),
- is named with the **pluralized** root entity name (`Order` → `Orders`),
- appears in the same order the aggregates are declared.

A context with two aggregates exposes two repositories. Payments declares `Payment` and `Ledger` (root entity `LedgerEntry`):

```csharp
namespace Payments;

public interface IUnitOfWork
{
    IPaymentRepository Payments { get; }
    ILedgerEntryRepository LedgerEntries { get; }

    Task<int> SaveChangesAsync(CancellationToken ct = default);
}
```

:::note
Pluralization follows English rules: `y` → `ies` (`Category` → `Categories`), words ending in `s`/`x`/`z`/`ch`/`sh` take `+es`, everything else takes `+s`. The property name comes from the **root entity** name, not the aggregate name (`aggregate Ledger root LedgerEntry` → `LedgerEntries`).
:::

:::tip
A context with **no** aggregates emits no `IUnitOfWork.cs` at all. In a multi-file build each context gets its own `IUnitOfWork` under its own folder/namespace.
:::

## Application services

A `service` with `usecase` declarations becomes an application-service interface — one async method per use case. This is the command side: the entry points your controllers, message handlers, or endpoints call.

```koine
service OrderingService {
  usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
  usecase CancelOrder(order: OrderId)
}
```

Emits `Ordering/IOrderingService.cs`:

```csharp
namespace Ordering;

public interface IOrderingService
{
    Task<OrderId> PlaceOrder(CustomerId customer, IReadOnlyList<OrderLine> lines);

    Task CancelOrder(OrderId order);
}
```

The translation rules:

| `.koi` | Emitted C# |
| --- | --- |
| `usecase Name(...)` | one **async** method on the `I<Service>` interface |
| `usecase Name(...): R` | returns `Task<R>` |
| `usecase Name(...)` *(no return)* | returns `Task` |
| `List<T>` parameter | surfaces as `IReadOnlyList<T>` in the signature |
| service name `OrderingService` | interface `IOrderingService` |

A service that contains **only** use cases emits just the `I<Service>` interface — no domain class. If you mix `operation` (pure domain logic) and `usecase` in one service, Koine emits both files: the bare-named class for the operations and the `I`-prefixed interface for the use cases. See [specs, services & policies](/Koine/reference/specs-services-policies/) for the `operation` side.

:::tip
A `usecase` can return a read model too: `usecase GetOrder(order: OrderId): OrderSummary` becomes `Task<OrderSummary>`, and `usecase ListOrders(): List<OrderSummary>` becomes `Task<IReadOnlyList<OrderSummary>>`.
:::

## Read models

The query side starts with a `readmodel`: a flat, denormalized projection of an aggregate, plus a static mapper that builds it. This keeps your read DTOs out of the domain model while staying type-safe.

```koine
readmodel OrderSummary from Order {
  id
  customer
  status
  lineCount: Int = lines.count
}
```

Emits `Ordering/OrderSummary.cs` — a `record` and a projection extension method:

```csharp
namespace Ordering;

public sealed record OrderSummary(OrderId Id, CustomerId Customer, OrderStatus Status, int LineCount);

public static class OrderSummaryProjection
{
    public static OrderSummary ToOrderSummary(this Order src) =>
        new OrderSummary(src.Id, src.Customer, src.Status, src.Lines.Count);
}
```

A read-model field is one of two forms:

- **Direct** — a bare name (`id`, `customer`, `status`). The field is resolved from the source aggregate by name; its type is inherited from the source. The field must actually exist on the source, or you get a `ReadModelUnknownField` diagnostic.
- **Derived** — the full `name: Type = expression` form (`lineCount: Int = lines.count`). You must give *both* the type and the expression — there is no type-only form.

Projection expressions translate like the rest of Koine: `.count` becomes `.Count`, and LINQ aggregates pull in `using System.Linq;` automatically. The Catalog `ProductCard` uses a comparison expression:

```koine
readmodel ProductCard from Product {
  sku
  name
  price
  available: Bool = availability == InStock
}
```

A collection aggregate works the same way and adds the LINQ import:

```koine
readmodel CartTotal from Cart { units: Int = lines.sum(l => l.quantity) }
```

```csharp
// projection mapper body
new CartTotal(src.Lines.Sum(l => l.Quantity));   // file gains: using System.Linq;
```

:::note
The `from` source must be a type already declared in the context, or you get a `ReadModelUnknownSource` diagnostic. Duplicate fields are rejected — including case-only collisions, since field names PascalCase into record members (`total` and `Total` both become `Total`). Read models emit a plain record: no `IAggregateRoot`, no invariants.
:::

## Query objects

A `query` is a request DTO over a read model. Koine emits one `record` per query (the criteria become its constructor properties) and **one** shared handler interface for the whole model.

```koine
query OrdersByStatus(status: OrderStatus): List<OrderSummary>
```

Emits `Ordering/OrdersByStatus.cs`:

```csharp
namespace Ordering;

public sealed record OrdersByStatus(OrderStatus Status);
```

The result type — `List<OrderSummary>` vs a bare `OrderSummary` — does not change the DTO. It only documents the `TResult` you bind when implementing the handler. The single runtime file `Koine/Runtime/IQueryHandler.cs` carries that contract:

```csharp
namespace Koine.Runtime;

public interface IQueryHandler<TQuery, TResult>
{
    Task<TResult> HandleAsync(TQuery query, CancellationToken ct = default);
}
```

You implement one handler per query — for example `IQueryHandler<OrdersByStatus, IReadOnlyList<OrderSummary>>`. Catalog shows both a list query and a single-result query:

```koine
query ProductsByAvailability(availability: Availability): List<ProductCard>
query ProductByCode(code: ProductCode): ProductCard
```

:::caution
A `query` is declared at **context level**, not inside a `service`. Its result type is **required** (unlike `usecase`, where it is optional) and **must** be a read model — `readmodel M` or `List<M>` — otherwise you get a `QueryResultNotReadModel` diagnostic. The `IQueryHandler.cs` runtime file is emitted exactly once for the whole compilation, no matter how many queries you declare; a model with no queries emits no handler file.
:::

## How it fits together

For the Ordering context, one `.koi` file gives you the full vertical slice:

```koine
/// Ordering bounded context — placing and pricing customer orders.
context Ordering version 1 {

  enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }
  enum Currency { EUR, USD, GBP }

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
      customer:  CustomerId
      lines:     List<OrderLine>
      status:    OrderStatus = Draft
      total:     Money = lines.sum(l => l.lineTotal)
      lineCount: Int   = lines.count
    }
  }

  /// R12.2 — the application/use-case service interface.
  service OrderingService {
    usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
    usecase CancelOrder(order: OrderId)
  }

  /// R12.3 — a flat read model + projection mapper.
  readmodel OrderSummary from Order {
    id
    customer
    status
    lineCount: Int = lines.count
  }

  /// R12.4 — a query DTO over the read model.
  query OrdersByStatus(status: OrderStatus): List<OrderSummary>
}
```

From that single context Koine emits, in the `Ordering/` folder: the `Order` aggregate and `IOrderRepository`, an `IUnitOfWork` exposing `Orders`, the `IOrderingService` application interface, the `OrderSummary` record and projection, and the `OrdersByStatus` query DTO — plus the shared `Koine/Runtime/IQueryHandler.cs`. None of it references your database.

## See also

- [Aggregates & repositories](/Koine/reference/aggregates/) — where `I<Root>Repository` and finders come from.
- [Specs, services & policies](/Koine/reference/specs-services-policies/) — the `operation`, `spec`, and `policy` constructs.
- [Contexts & types](/Koine/reference/contexts-and-types/) — how `List<T>`, `Instant`, and the rest map to C#.
