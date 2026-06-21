---
title: "Entities & identity"
description: "Entities, identity-only equality, and the four identity strategies."
---

## 6.1 General

An **entity** is a domain object with a continuous identity. Two customers with the same name,
email, and address are still two different customers — what makes them the same is their
identity, not their data. Koine bakes this distinction into the language: you declare an entity
with a typed identity, and the compiler gives you identity-only equality and a strongly-typed
ID value object for free.

:::note
This is the deliberate opposite of a [value object (§5)](/Koine/reference/value-objects/), which has
**no** identity and compares structurally on all of its fields. Picking `entity` vs `value` is the
single most important DDD modelling decision the DSL asks you to make. Use `entity` when the thing
has a lifecycle and continuity (a `Customer`, an `Order`); use `value` when it is defined purely
by its attributes (a `Money`, an `Email`).
:::

Entity bodies support the full member vocabulary — required and optional (`T?`) fields, `Set<T>`
and `List<T>` collections, enum-typed fields, and derived fields
(`displayName: String = nickname ?? name`). See [Contexts & types (§4)](/Koine/reference/contexts-and-types/)
for the complete field and member vocabulary.

## 6.2 Syntax

An entity is declared with the `entity` keyword, an `identified by` clause naming the identity
type, and an optional `as` clause selecting the identity strategy (see [§6.5](#65-identity-strategies)):

```ebnf
entity_decl
    : 'entity' Identifier 'identified' 'by' Identifier identity_strategy?
      '{' member* invariant* states_decl* command_decl* factory_decl* '}'
    ;

identity_strategy
    : 'as' ( 'guid'
           | 'sequence'
           | 'natural' '(' type_name ')' )
    ;

member
    : Identifier ':' type_ref ( '=' expression )?
    ;

invariant
    : 'invariant' expression StringLiteral?
    ;
```

The first `Identifier` is the entity name; the second (after `identified by`) is the **identity
type name**. By convention it is the entity name plus `Id` (`Customer` → `CustomerId`, `Order` →
`OrderId`), but any name works. The identity type is generated automatically — you never declare it
yourself. The `identity_strategy` clause is optional; omitting it gives the Guid default.

The `member`, `invariant`, `states_decl`, `command_decl`, and `factory_decl` productions inside the
body are shared with other constructs. The expression grammar is specified in
[Expressions (§9)](/Koine/reference/expressions/); invariant guards are detailed in
[Invariants (§10)](/Koine/reference/invariants/).

```koine
entity Customer identified by CustomerId {
  name:            String
  email:           Email
  shippingAddress: PostalAddress
}
```

This is the same pattern you will see throughout the showcase domain: every aggregate root and every
standalone entity is `entity X identified by XId { … }`.

## 6.3 Semantics

### 6.3.1 Identity-only equality

The entity's `Equals` and `GetHashCode` compare **only** the `Id` field — every other field is
ignored. This means you can load an entity, mutate it, and still recognise it as "the same" object.
A `HashSet<Customer>` keys on identity. Re-fetching an aggregate from a repository and comparing it
to the one you held compares identity, not a snapshot of mutable state. You get the correct DDD
semantics without hand-writing `Equals`/`GetHashCode` (and without the classic bug of forgetting to
keep them in sync).

The generated `Id` value object provides the underlying equality. Its own equality is structural —
it compares the wrapped primitive — so `new CustomerId(g) == new CustomerId(g)` is `true`.

### 6.3.2 The `*Id` reference convention

Once an entity declares `identified by XId`, that `XId` type becomes a first-class reference you
can use anywhere a type is expected — most often to point one entity at another:

```koine
entity Order identified by OrderId {
  customer: CustomerId
}
```

Here `customer: CustomerId` references a `Customer` by its identity, not by embedding the whole
customer. This keeps aggregates small and the boundaries between them explicit — an `Order` holds a
`CustomerId`, not a `Customer`. The same `CustomerId` type flows through factory parameters, command
arguments, events, and repository finders.

:::tip
The convention is load-bearing for tooling, too. In the editor, hovering or go-to-definition on a
`CustomerId` reference jumps to the `entity … identified by CustomerId` that owns it — even when
that entity lives in another file or context. See [editor tooling](/Koine/guides/editor-tooling/).
:::

### 6.3.3 File naming

Each generated ID value object lands in its **own** file, named after the ID type, not the entity:
`CustomerId` → `Customers/CustomerId.cs`, `ProductCode` → `Catalog/ProductCode.cs`. The ID type
name must therefore be unique within its context.

## 6.4 Translation to C#

The entity becomes a plain `sealed class` with one twist: equality is computed **only** from the
identity. Here is the `Customer` entity from [§6.2](#62-syntax), as the compiler emits it:

```csharp
public sealed class Customer
{
    public CustomerId Id { get; }
    public string Name { get; }
    public Email Email { get; }
    public PostalAddress ShippingAddress { get; }

    public Customer(CustomerId id, string name, Email email, PostalAddress shippingAddress)
    {
        Id = id;
        Name = name;
        Email = email;
        ShippingAddress = shippingAddress;
    }

    public bool Equals(Customer? other) => other is not null && Id.Equals(other.Id);
    public override bool Equals(object? obj) => Equals(obj as Customer);
    public override int GetHashCode() => Id.GetHashCode();
}
```

Two `Customer` instances are equal exactly when their `Id` matches — every other field is ignored.

The generated `Id` property is of the emitted ID value object type. The ID value object itself
derives from `ValueObject` (in `Koine.Runtime`) and contributes the wrapped primitive to structural
equality via `GetEqualityComponents()`. The exact shape of the ID value object depends on the
identity strategy in use; see [§6.5](#65-identity-strategies) for per-strategy emitted shapes.

## 6.5 Identity strategies

By default an identity is a `Guid` that the client generates. But not every key is a Guid: SKUs are
strings from a supplier catalogue, invoice numbers are store-assigned sequences. The `as` clause
after `identified by XId` selects one of four strategies (introduced in epic R11). Omit it entirely
to get the Guid default.

| Strategy | Declaration | Backing type | `New()`? | Validation |
| --- | --- | --- | --- | --- |
| Guid (default) | `identified by XId` | `Guid` | yes — `XId.New()` | none |
| Natural string | `identified by XId as natural(String)` | `string` | no | rejects blank/whitespace |
| Natural int | `identified by XId as natural(Int)` | `int` | no | none |
| Sequence | `identified by XId as sequence` | `long` | no | none (store-assigned) |

The key distinction is **who creates the key**. Only the Guid default emits a client-side `New()`
generator. Natural keys come from the real world, and sequence keys are assigned by the persistence
store — so neither gets a `New()`.

### 6.5.1 Default: Guid

```koine
entity Customer identified by CustomerId {
  name: String
}
```

Emits a `Guid`-backed value object with a client-side generator:

```csharp
public sealed class CustomerId : ValueObject
{
    public Guid Value { get; }

    public CustomerId(Guid value) => Value = value;

    public static CustomerId New() => new(Guid.NewGuid());

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Value;
    }
}
```

This is the only strategy with a `New()` factory — call `CustomerId.New()` whenever you mint a
fresh entity. (Aggregate [factories (§12)](/Koine/reference/factories/) call it for you: a `create`
block synthesises `var id = CustomerId.New();` automatically.)

### 6.5.2 Natural string: `as natural(String)`

For keys that come from outside your system — a SKU, a country code, an ISBN. From the
`ProductCatalog` aggregate in the demo:

```koine
entity Product identified by ProductCode as natural(String) {
  sku:   Sku
  name:  String
  price: Price
}
```

Emits a `string`-backed key with **no** `New()`, and a constructor that rejects a blank or
whitespace-only key:

```csharp
public sealed class ProductCode : ValueObject
{
    public string Value { get; }

    public ProductCode(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new DomainInvariantViolationException(
                type: nameof(ProductCode),
                rule: "identity value cannot be blank");
        Value = value;
    }

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Value;
    }
}
```

Because the key is supplied from the real world, you construct it directly — `new ProductCode("ABC-123")`
— and the constructor guards against an empty string.

### 6.5.3 Natural int: `as natural(Int)`

The same idea backed by an `int` — a legacy numeric account number, a CSV row id:

```koine
entity LegacyAccount identified by AccountNo as natural(Int) {
  balance: Decimal
}
```

Emits `public int Value { get; }`, value-equality, and no `New()`.

:::caution
Natural keys accept only `String` or `Int` as the backing type. `as natural(Decimal)` — or any
other primitive — is a compile error (`NaturalIdBackingType`).
:::

### 6.5.4 Sequence: `as sequence`

For store-assigned monotonic keys — an invoice number, an audit-log row id. The persistence layer
hands you the value, so there is no generator and no argument:

```koine
entity Invoice identified by InvoiceNo as sequence {
  amount: Int
}
```

Emits a `long`-backed key (note: `long`, not `int`), value-equality, and no `New()`:

```csharp
public sealed class InvoiceNo : ValueObject
{
    public long Value { get; }

    public InvoiceNo(long value) => Value = value;

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Value;
    }
}
```

## 6.6 Entities, aggregates, and repositories

An entity can stand alone or sit inside an [aggregate (§7)](/Koine/reference/aggregates/). The two
biggest consequences of being an aggregate **root** are:

- A [repository (§14)](/Koine/reference/repositories-concurrency/) interface keyed on the root's identity
  (`IOrderRepository` keyed on `OrderId`) — non-root and standalone entities get none.
- A [factory (§12)](/Koine/reference/factories/) seam: declaring a `create` block makes the all-args
  constructor `private`, forcing construction through the factory.

```koine
aggregate ProductCatalog root Product {
  entity Product identified by ProductCode as natural(String) {
    sku:   Sku
    name:  String
    price: Price
  }
}
```

## 6.7 Example

```koine
context Sales {
  value OrderLine {
    product:  ProductId
    quantity: Int
  }

  // Standalone entity with the default Guid identity.
  entity Customer identified by CustomerId {
    name:  String
    email: String
  }

  // Aggregate root with a natural string key — no client-side New().
  aggregate Order root Order {
    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
    }
  }

  // Store-assigned sequence key, backed by long.
  entity Invoice identified by InvoiceNo as sequence {
    order:  OrderId
    amount: Decimal
  }
}
```

## See also

- [Value objects (§5)](/Koine/reference/value-objects/) — the structural, identity-free counterpart.
- [Aggregates (§7)](/Koine/reference/aggregates/) — roots, boundaries, and the aggregate body.
- [Factories (§12)](/Koine/reference/factories/) — `create` blocks and constructor privacy.
- [Repositories & concurrency (§14)](/Koine/reference/repositories-concurrency/) — interfaces keyed on the root identity.
- [Contexts & types (§4)](/Koine/reference/contexts-and-types/) — the full field and member vocabulary inside an entity body.
- [Expressions (§9)](/Koine/reference/expressions/) — the expression grammar used in derived fields and invariants.
- [Invariants (§10)](/Koine/reference/invariants/) — guard expressions shared across entities, value objects, and quantities.
