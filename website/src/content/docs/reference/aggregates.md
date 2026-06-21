---
title: "Aggregates"
description: "Aggregate roots, the consistency boundary, repositories and versioning."
---

## 7.1 General

An **aggregate** is a cluster of domain types that change together and must stay consistent as a
whole. Koine makes the aggregate boundary explicit: you name the cluster, name its **root**, and nest
the entities and value objects it owns. The root becomes the single entry point — the only type that
gets a repository and the only handle the outside world holds onto.

The aggregate pattern comes from Domain-Driven Design: by enforcing that all mutations go through
the root, the model guarantees that invariants spanning the cluster are never violated by partial
updates. The compiler enforces this at the modeling level — nested types have no independent identity
outside the aggregate.

## 7.2 Syntax

An aggregate is declared with the `aggregate` keyword, a cluster name, the `root` keyword, and a
root-entity name. The optional `versioned` qualifier opts the aggregate into optimistic concurrency
([§7.5](#75-versioned-aggregates)):

```ebnf
aggregate_decl
    : annotation* 'aggregate' Identifier 'root' Identifier 'versioned'? '{' aggregate_member* '}'
    ;

aggregate_member
    : type_decl
    | spec_decl
    | repository_decl
    ;

repository_decl
    : 'repository' '{' operations_clause? finder_decl* '}'
    ;

operations_clause
    : 'operations' ':' Identifier ( ',' Identifier )*
    ;

finder_decl
    : 'find' Identifier '(' param_list? ')' ':' type_ref
    ;
```

The first `Identifier` names the **aggregate**; the second (after `root`) names the **root entity**,
which must be declared as a nested `entity` inside the body. Every `aggregate_member` is either a
nested type declaration (value objects, quantities, entities, nested aggregates, enums, events, and
integration events — the complete `type_decl` set), an aggregate-scoped specification, or a single
`repository` block.

The expression grammar used in specs and invariants is specified in
[Expressions (§9)](/Koine/reference/expressions/). The `annotation*` prefix supports `@since` and
`@deprecated` evolution annotations (see [Versioning (§18)](/Koine/reference/versioning/)).

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

The root entity is identified the same way any [entity (§6)](/Koine/reference/entities-and-identity/) is — with
`identified by <IdType>` and an optional identity strategy. See
[Repositories & concurrency (§14)](/Koine/reference/repositories-concurrency/) for the identity strategies.

## 7.3 Semantics

### 7.3.1 The consistency boundary

The root is the consistency boundary. Nested value objects and entities have no independent identity
outside the aggregate — they are reached *through* the root. That is why only the root gets a
repository and why the root's constructor enforces every nested invariant before the aggregate can
exist.

### 7.3.2 Root entity requirement

The identifier after `root` must match the name of exactly one `entity` declared directly inside the
aggregate body. The compiler raises a diagnostic if the named root entity is absent or if multiple
entities share that name.

### 7.3.3 Repository exposure

Declaring an `aggregate` emits a persistence-ignorant repository interface keyed on the root's id.
Non-root nested entities and standalone (context-level) entities get **no** repository — you can only
load and save a whole aggregate, never one of its inner parts. To restrict the mutating set or add
intention-revealing finders, use a `repository { … }` block; that and concurrency semantics are
covered in [Repositories & concurrency (§14)](/Koine/reference/repositories-concurrency/).

A context that contains at least one aggregate also gets a generated `IUnitOfWork` exposing one
repository property per aggregate plus `SaveChangesAsync`.

### 7.3.4 Namespacing: one context, one namespace

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

## 7.4 Translation to C#

### 7.4.1 Root entity

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

### 7.4.2 Repository interface

The default operation set emitted for any aggregate root is `GetByIdAsync`, `AddAsync`, `UpdateAsync`,
and `RemoveAsync`:

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

### 7.4.3 Unit of work

A context that contains at least one aggregate gets a generated `IUnitOfWork` exposing one repository
property per aggregate plus `SaveChangesAsync`. This interface is emitted into the context's namespace
alongside the aggregate types.

## 7.5 Versioned aggregates

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

## 7.6 Example

The complete model below declares a versioned `Order` aggregate with a tuned repository, two events,
a nested `OrderLine` value object, and a root entity with a state machine, commands, and a factory.
It is copy-pasteable and compiles with `koine build`:

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

## See also

- [Commands, events & state (§11)](/Koine/reference/commands-events-state/) — how the root mutates state and emits events behind invariants.
- [Repositories & concurrency (§14)](/Koine/reference/repositories-concurrency/) — identity strategies, the `repository { … }` block, finders, and optimistic-concurrency semantics.
- [Entities & identity (§6)](/Koine/reference/entities-and-identity/) — identity, derived fields, and lifecycle states on the root.
- [Value objects (§5)](/Koine/reference/value-objects/) — the immutable, equality-by-value building blocks an aggregate owns.
- [Invariants (§10)](/Koine/reference/invariants/) — the guard expression grammar used in nested types and root entities.
- [Expressions (§9)](/Koine/reference/expressions/) — the expression grammar used in derived fields, specs, and commands.
