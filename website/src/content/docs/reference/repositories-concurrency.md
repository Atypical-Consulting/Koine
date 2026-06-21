---
title: "Repositories & concurrency"
description: "Generated repository interfaces, finders, operation sets, and optimistic concurrency."
---

## 14.1 General

Every aggregate root in Koine gets a persistence-ignorant repository interface, automatically.
You never write `IOrderRepository` by hand — you declare the aggregate, and the compiler emits a
contract keyed on the root's identity. A `repository { ... }` block lets you trim the mutating
surface and add intention-revealing finders, and marking the aggregate `versioned` layers in
optimistic concurrency. This page covers all of it, grounded in the demo `Ordering` context.

An [aggregate (§7)](/Koine/reference/aggregates/) declares a root entity. That root — and only that
root — receives a repository. The interface name is `I<Root>Repository`, it lives in the context's
namespace, and it is keyed on the root entity's [id type (§6)](/Koine/reference/entities-and-identity/).

```koine
context Sales {
  value OrderLine { product: ProductId  quantity: Int }

  aggregate Order root Order {
    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
    }
  }
}
```

This emits `Sales/IOrderRepository.cs` with the full default mutating set:

```csharp
public interface IOrderRepository
{
    Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default);
    Task AddAsync(Order aggregate, CancellationToken ct = default);
    Task UpdateAsync(Order aggregate, CancellationToken ct = default);
    Task RemoveAsync(Order aggregate, CancellationToken ct = default);
}
```

The four default operations map one-to-one to the operation names `getById`, `add`, `update`,
`remove`. `GetByIdAsync` takes the root's id type (`OrderId`) and returns a nullable root; the
three mutators take the aggregate instance. Every method ends in a defaulted `CancellationToken ct`.

:::note
Only the aggregate **root** gets a repository. Non-root nested entities and standalone
context-level entities get none. To give any domain type a repository, wrap it in an aggregate
whose root it is — e.g. `aggregate Product root Product { entity Product identified by Sku as natural(String) { ... } }`.
:::

## 14.2 Syntax

The repository block is an optional member of an aggregate declaration. The `versioned` soft
keyword sits on the aggregate's root clause:

```ebnf
aggregate_decl
    : annotation* 'aggregate' Identifier 'root' Identifier 'versioned'? '{' aggregate_member* '}'
    ;

aggregate_member
    : type_decl | spec_decl | repository_decl
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

param_list
    : param ( ',' param )*
    ;

param
    : Identifier ':' type_ref
    ;
```

- The `'versioned'` modifier appears between the root entity name and the opening brace of the
  aggregate body. It is a soft keyword (declared as `VERSIONED` in the lexer) and is absent by
  default.
- A `repository` block is **at most one** per aggregate and, when present, must be the first
  `aggregate_member`.
- Inside the block, the `operations:` clause is optional and, when present, must come **before**
  any `find` declarations. This ordering is enforced syntactically — a second or misplaced
  `operations:` clause is a parse error, not a silent last-wins.
- Each `finder_decl` names the finder (`Identifier`), takes an optional parameter list, and
  declares its result as a `type_ref`. The result type is constrained to `Root` or `List<Root>`
  by the semantic validator (see [§14.3.2](#1432-finder-validation-rules)).
- The expression grammar used in parameter types is specified in
  [Expressions (§9)](/Koine/reference/expressions/).

```koine
aggregate Order root Order versioned {

  repository {
    operations: getById, add, update
    find byCustomer(customer: CustomerId): List<Order>
    find mostRecent(customer: CustomerId): Order
  }

  entity Order identified by OrderId {
    customer: CustomerId
    lines:    List<OrderLine>
  }
}
```

## 14.3 Semantics

### 14.3.1 The `operations:` clause

The `operations:` clause is a closed allow-list. Name only the operations you want; the rest are
omitted from the emitted interface. When the clause is absent the full default set is emitted.
The valid names are exactly:

| Operation name | Emitted method                          |
| -------------- | --------------------------------------- |
| `getById`      | `Task<Root?> GetByIdAsync(Id id, ...)`  |
| `add`          | `Task AddAsync(Root aggregate, ...)`    |
| `update`       | `Task UpdateAsync(Root aggregate, ...)` |
| `remove`       | `Task RemoveAsync(Root aggregate, ...)` |

:::caution
Any name outside that set (e.g. `purge`) is a compile error (`UnknownRepositoryOperation`). A
second or misplaced `operations:` clause is a **syntax** error — exactly one, and it must precede
every `find`.
:::

### 14.3.2 Finder validation rules

A `find` declaration adds a query method to the interface. The grammar is
`find <name>(<params>): <resultType>`. The result type must be the aggregate root or a
`List<Root>` — nothing else. The shape of the result drives the emitted signature:

| Finder result | Emitted return type           | Meaning           |
| ------------- | ----------------------------- | ----------------- |
| `List<Root>`  | `Task<IReadOnlyList<Root>>`   | zero or more      |
| `Root`        | `Task<Root?>`                 | one or none (nullable) |

:::caution
Finder validation rules (each a diagnostic, never a crash):

- Result type must be `Root` or `List<Root>` (`FinderResultType`).
- A parameter named `ct` is rejected — it would collide with the trailing `CancellationToken ct` (`ReservedFinderParameter`).
- A finder named after a built-in op (`getById`, `add`, `update`, `remove`) is rejected (`FinderNameCollision`).
- Duplicate finder names (`DuplicateFinder`) and duplicate parameter names within a finder (`DuplicateParameter`) are rejected.
:::

### 14.3.3 Versioned aggregates

Place the soft keyword `versioned` after `root <Entity>` and before the `{`:

```koine
aggregate Order root Order versioned {
  entity Order identified by OrderId { customer: CustomerId }
}
```

This does two things:

1. The root entity gains a synthetic concurrency token — `public int Version { get; init; }`.
2. A shared runtime type, `Koine/Runtime/ConcurrencyConflictException.cs`, is emitted once for the
   whole model (no duplication, however many versioned aggregates you have).

On a versioned root, `UpdateAsync` and `RemoveAsync` carry concurrency semantics: they enforce the
aggregate's expected `Version` and throw on a stale write. `AddAsync` does not — a fresh aggregate
has no prior version to conflict with.

:::caution
The synthetic `Version` member is reserved. A root member literally named `version` in a versioned
aggregate is rejected (`ReservedVersionMember`) — it would clash with the generated property. A
non-versioned aggregate emits no `Version` property and no `ConcurrencyConflictException` file.
:::

## 14.4 Translation to C#

### 14.4.1 Repository interface

The finder name is camelCase in `.koi` and emitted PascalCase with an `Async` suffix; parameters
are carried through verbatim, followed by the trailing `CancellationToken ct`. The two finders
from [§14.2](#142-syntax) emit:

```csharp
Task<IReadOnlyList<Order>> ByCustomerAsync(CustomerId customer, CancellationToken ct = default);
Task<Order?> MostRecentAsync(CustomerId customer, CancellationToken ct = default);
```

### 14.4.2 Versioned root

On a versioned root, the emitted contract documents the concurrency contract via a doc comment on
`UpdateAsync`:

```csharp
/// <summary>Enforces the aggregate's expected Version; throws ConcurrencyConflictException on a stale write.</summary>
Task UpdateAsync(Order aggregate, CancellationToken ct = default);
```

The runtime exception is a sealed type in `Koine.Runtime`:

```csharp
public sealed class ConcurrencyConflictException : Exception
{
    public string TypeName { get; }
    public int ExpectedVersion { get; }
    public int ActualVersion { get; }

    public ConcurrencyConflictException(string type, int expected, int actual)
        : base($"Concurrency conflict on {type}: expected version {expected}, found {actual}.")
    { TypeName = type; ExpectedVersion = expected; ActualVersion = actual; }
}
```

### 14.4.3 Unit of Work

Any context that declares aggregates also gets an `IUnitOfWork` — a transactional boundary that
exposes every `I<Root>Repository` in the context plus a `SaveChangesAsync`:

```csharp
public interface IUnitOfWork
{
    IOrderRepository Orders { get; }
    Task<int> SaveChangesAsync(CancellationToken ct = default);
}
```

Across a multi-file model, the Unit of Work aggregates every repository — using fully-qualified
names when they cross namespaces — so a single `SaveChangesAsync` commits the whole transaction.

## 14.5 Example: the demo `Ordering` context

The Shop demo's `Ordering` context combines all of the above: a `versioned` root, a tuned
operation set, and two finders.

```koine
context Ordering {

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
      invariant quantity >= 1   "an order line needs at least one unit"
    }

    entity Order identified by OrderId {
      customer:    CustomerId
      lines:       List<OrderLine>
      status:      OrderStatus  = Draft
      total:       Money = lines.sum(l => l.unitPrice)
      lineCount:   Int   = lines.count
      invariant lines.all(l => l.quantity >= 1)   "every line needs a positive quantity"
    }
  }
}
```

This emits `Ordering/IOrderRepository.cs`:

```csharp
public interface IOrderRepository
{
    Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default);
    Task AddAsync(Order aggregate, CancellationToken ct = default);

    /// <summary>Enforces the aggregate's expected Version; throws ConcurrencyConflictException on a stale write.</summary>
    Task UpdateAsync(Order aggregate, CancellationToken ct = default);

    Task<IReadOnlyList<Order>> ByCustomerAsync(CustomerId customer, CancellationToken ct = default);
    Task<Order?> MostRecentAsync(CustomerId customer, CancellationToken ct = default);
}
```

Note what is absent: there is no `RemoveAsync`, because `operations:` did not list `remove`.

:::tip
You implement these interfaces yourself (EF Core, Dapper, an in-memory store — Koine doesn't care).
The compiler's job is to give you a precise, persistence-ignorant contract that already encodes the
aggregate boundary, the id type, the allowed operations, and the concurrency policy.
:::

## See also

- [Aggregates (§7)](/Koine/reference/aggregates/) — declaring a root and its consistency boundary.
- [Entities & identity (§6)](/Koine/reference/entities-and-identity/) — the id strategies (`guid`, `natural`, `sequence`) that key these repositories.
- [Application layer & CQRS (§15)](/Koine/reference/application-cqrs/) — the use-case layer that orchestrates repositories and the Unit of Work.
