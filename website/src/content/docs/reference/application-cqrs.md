---
title: "Application layer & CQRS"
description: "Unit of work, application services, read models and query objects."
---

## 15.1 General

Koine's domain model — entities, value objects, aggregates — describes the *write* side of your system. The application layer wires that model into the outside world: a transactional boundary (`IUnitOfWork`), use-case entry points (application services), and a *read* side built from flat projections (`readmodel`) and query DTOs (`query`).

Everything on this page is a pure abstraction. The emitted interfaces and records carry **no** infrastructure dependencies — no Entity Framework, no Dapper, no `DbContext`. You implement them in your host project however you like; Koine just gives you the shapes.

The four constructs that make up the application layer are:

| Construct | Koine keyword | Role |
| --- | --- | --- |
| Unit of work | *(emergent — no keyword)* | Transactional boundary over all aggregates in a context |
| Application service | `service` / `usecase` | Command side: async entry points for controllers, handlers, or endpoints |
| Read model | `readmodel` | Flat, denormalized projection of an aggregate with a static mapper |
| Query object | `query` | Request DTO over a read model with a generic handler contract |

## 15.2 Syntax

### 15.2.1 Application services

An application service is declared with the `service` keyword. Each use-case entry point is a `usecase` inside it:

```ebnf
service_decl
    : 'service' Identifier '{' service_member* '}'
    ;

service_member
    : operation_decl
    | usecase_decl
    ;

usecase_decl
    : 'usecase' Identifier '(' param_list? ')' ( ':' type_ref )?
    ;

param_list
    : param ( ',' param )*
    ;

param
    : Identifier ':' type_ref
    ;

type_ref
    : ( Identifier '.' )? Identifier ( '<' type_ref ( ',' type_ref )? '>' )? '?'?
    ;
```

`usecase_decl` names the use case, takes an optional parameter list, and returns an optional result type. A `usecase` with no `: type_ref` returns `Task` (void-async) in C#; one with a result type returns `Task<R>`. See [Specs, services & policies (§13)](/Koine/reference/specs-services-policies/) for the `operation_decl` variant (pure domain logic that lives on the same `service`).

```koine
service OrderingService {
  usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
  usecase CancelOrder(order: OrderId)
}
```

### 15.2.2 Read models

A read model is declared with `readmodel`, naming the source aggregate with `from`. Its body is a list of fields:

```ebnf
readmodel_decl
    : 'readmodel' Identifier 'from' Identifier '{' readmodel_field* '}'
    ;

readmodel_field
    : Identifier ( ':' type_ref '=' expression )?
    ;
```

A `readmodel_field` is one of two forms:

- **Direct** — a bare `Identifier` with no `: type_ref = expression`. The field is resolved from the source aggregate by name; its type is inherited from the source.
- **Derived** — the full `Identifier ':' type_ref '=' expression` form. Both the type and the expression are required — there is no type-only form.

The expression grammar is specified in [Expressions (§9)](/Koine/reference/expressions/).

```koine
readmodel OrderSummary from Order {
  id
  customer
  status
  lineCount: Int = lines.count
}
```

### 15.2.3 Query objects

A query object is a context-level declaration with `query`:

```ebnf
query_decl
    : 'query' Identifier '(' param_list? ')' ':' type_ref
    ;
```

Unlike `usecase_decl`, the result type (`: type_ref`) is **required** on `query_decl`. The result must be a read model name or `List<M>` where `M` is a read model name.

```koine
query OrdersByStatus(status: OrderStatus): List<OrderSummary>
```

## 15.3 Semantics

### 15.3.1 Unit-of-work generation

You never write a unit of work in `.koi`. It is **emergent**: any context that declares at least one `aggregate` automatically gets one `IUnitOfWork` interface, with one repository property per aggregate (in declaration order) plus a `SaveChangesAsync`.

- Each property is typed `I<Root>Repository` — the repository interface Koine generates from the aggregate (see [Aggregates & repositories (§7)](/Koine/reference/aggregates/)).
- Properties are named with the **pluralized** root entity name (`Order` → `Orders`).
- Properties appear in the same order the aggregates are declared.
- A context with **no** aggregates emits no `IUnitOfWork.cs` at all.

:::note
Pluralization follows English rules: `y` → `ies` (`Category` → `Categories`), words ending in `s`/`x`/`z`/`ch`/`sh` take `+es`, everything else takes `+s`. The property name comes from the **root entity** name, not the aggregate name (`aggregate Ledger root LedgerEntry` → `LedgerEntries`).
:::

:::tip
In a multi-file build each context gets its own `IUnitOfWork` under its own folder/namespace.
:::

### 15.3.2 Application-service rules

| `.koi` | Emitted C# |
| --- | --- |
| `usecase Name(...)` | one **async** method on the `I<Service>` interface |
| `usecase Name(...): R` | returns `Task<R>` |
| `usecase Name(...)` *(no return)* | returns `Task` |
| `List<T>` parameter | surfaces as `IReadOnlyList<T>` in the signature |
| service name `OrderingService` | interface `IOrderingService` |

A service that contains **only** use cases emits just the `I<Service>` interface — no domain class. If you mix `operation` (pure domain logic) and `usecase` in one service, Koine emits both files: the bare-named class for the operations and the `I`-prefixed interface for the use cases. See [Specs, services & policies (§13)](/Koine/reference/specs-services-policies/) for the `operation` side.

### 15.3.3 Read-model rules

- A direct field (bare name) must actually exist on the source aggregate; a missing name raises a `ReadModelUnknownField` diagnostic.
- The `from` source must be a type already declared in the context; an unknown source raises a `ReadModelUnknownSource` diagnostic.
- Duplicate fields are rejected — including case-only collisions, since field names PascalCase into record members (`total` and `Total` both become `Total`).
- Read models emit a plain record: no `IAggregateRoot`, no invariants.

### 15.3.4 Query-object rules

- A `query` is declared at **context level**, not inside a `service`.
- The result type is **required** (unlike `usecase`, where it is optional).
- The result type **must** be a read model — `readmodel M` or `List<M>` — otherwise the compiler raises a `QueryResultNotReadModel` diagnostic.
- The `IQueryHandler.cs` runtime file is emitted exactly once for the whole compilation, no matter how many queries you declare; a model with no queries emits no handler file.

:::tip
A `usecase` can return a read model too: `usecase GetOrder(order: OrderId): OrderSummary` becomes `Task<OrderSummary>`, and `usecase ListOrders(): List<OrderSummary>` becomes `Task<IReadOnlyList<OrderSummary>>`.
:::

:::caution
A `query` result type is **not** a `usecase` result type. `query` requires its result to be a declared read model; `usecase` may return any type in the model (an aggregate id, a value object, a read model, or nothing).
:::

## 15.4 Translation to C#

### 15.4.1 Unit of work

The Ordering context, which has a single `Order` aggregate:

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

emits `Ordering/IUnitOfWork.cs`:

```csharp
namespace Ordering;

/// <summary>Transactional boundary over this context's aggregate repositories.</summary>
public interface IUnitOfWork
{
    IOrderRepository Orders { get; }

    Task<int> SaveChangesAsync(CancellationToken ct = default);
}
```

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

## 15.5 Application services

### 15.5.1 Translation to C#

The `service` / `usecase` pair emits `Ordering/IOrderingService.cs`:

```csharp
namespace Ordering;

public interface IOrderingService
{
    Task<OrderId> PlaceOrder(CustomerId customer, IReadOnlyList<OrderLine> lines);

    Task CancelOrder(OrderId order);
}
```

## 15.6 Read models

The query side starts with a `readmodel`: a flat, denormalized projection of an aggregate, plus a static mapper that builds it. This keeps your read DTOs out of the domain model while staying type-safe.

### 15.6.1 Translation to C#

The `readmodel OrderSummary from Order { … }` declaration emits `Ordering/OrderSummary.cs` — a `record` and a projection extension method:

```csharp
namespace Ordering;

public sealed record OrderSummary(OrderId Id, CustomerId Customer, OrderStatus Status, int LineCount);

public static class OrderSummaryProjection
{
    public static OrderSummary ToOrderSummary(this Order src) =>
        new OrderSummary(src.Id, src.Customer, src.Status, src.Lines.Count);
}
```

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

## 15.7 Query objects

A `query` is a request DTO over a read model. Koine emits one `record` per query (the criteria become its constructor properties) and **one** shared handler interface for the whole model.

```koine
query OrdersByStatus(status: OrderStatus): List<OrderSummary>
```

### 15.7.1 Translation to C#

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

## 15.8 End-to-end example

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

- [Aggregates & repositories (§7)](/Koine/reference/aggregates/) — where `I<Root>Repository` and finders come from.
- [Specs, services & policies (§13)](/Koine/reference/specs-services-policies/) — the `operation`, `spec`, and `policy` constructs.
- [Contexts & types (§4)](/Koine/reference/contexts-and-types/) — how `List<T>`, `Instant`, and the rest map to C#.
- [Expressions (§9)](/Koine/reference/expressions/) — the expression grammar used in derived read-model fields.
- [Commands, events & state machines (§11)](/Koine/reference/commands-events-state/) — the `command` and `event` constructs that the application layer orchestrates.
