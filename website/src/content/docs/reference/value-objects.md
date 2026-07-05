---
title: "Value objects"
description: "Immutable value types: structural equality, validating constructors, derived fields."
---

## 5.1 General

A **value object** is a small immutable type defined entirely by its data — two of them are equal when
their fields are equal, not when they are the same instance. In Koine you declare one with the `value`
keyword; the compiler emits a `sealed class` deriving the `ValueObject` runtime base, with get-only
properties, a validating constructor, and structural equality. You never write `Equals`, `GetHashCode`,
or a copy constructor by hand.

## 5.2 Syntax

A value object is declared with the `value` keyword (a `quantity` — [§5.5](#55-quantities) — shares
the same body grammar):

```ebnf
value_declaration
    : 'value' Identifier '{' member* invariant* '}'
    ;

member
    : Identifier ':' type_ref ( '=' expression )?   // '= expression' makes it a derived field
    ;

invariant
    : 'invariant' expression StringLiteral?         // the string is the failure message
    ;

type_ref
    : Identifier ( '<' type_ref ( ',' type_ref )? '>' )? '?'?   // T, List<T>, Map<K,V>, T?
    ;
```

A `member` with an `= expression` initialiser that references sibling fields is a **derived field**
([§5.3](#53-semantics)); without it, the member is a constructor parameter. The expression grammar is
specified in [Expressions (§9)](/Koine/reference/expressions/).

```koine
value Price {
  amount:   Decimal
  currency: Currency
  invariant amount >= 0   "a price cannot be negative"
}
```

## 5.3 Semantics

Every `value X { … }` produces a class with four guarantees:

| Aspect | Emitted shape |
| --- | --- |
| Immutability | Every field becomes a `{ get; }`-only property, set once in the constructor |
| Validation | Each `invariant` becomes a guard that throws `DomainInvariantViolationException` before assignment |
| Structural equality | Equality (and `==` / `!=` / `GetHashCode`) compares the declared fields, in order |
| Sealed | The class is `sealed` — value objects are not meant to be subclassed |

:::note
A value object is constructed positionally and validated eagerly. If an invariant fails, the constructor
throws — there is no half-built `Price` with a negative amount. This is the core promise of the type:
**if you hold an instance, it is valid.**
:::

### 5.3.1 Validating constructors

Every `invariant` you declare becomes a guard at the top of the constructor, in declaration order, each
throwing `DomainInvariantViolationException(type, rule)` with your message as the `rule`. Invariants can
use string operations, comparisons, presence checks, and regex literals:

```koine
value Sku {
  code:       String
  normalized: String = code.trim.upper
  invariant code.trim.length > 0                  "a SKU cannot be blank"
  invariant code matches /^[A-Z]{3}-[0-9]{4}$/     "SKU must look like ABC-1234"
}
```

emits:

```csharp
public Sku(string code)
{
    if (!(code.Trim().Length > 0))
        throw new DomainInvariantViolationException(
            type: nameof(Sku),
            rule: "a SKU cannot be blank");

    if (!Regex.IsMatch(code, @"^[A-Z]{3}-[0-9]{4}$", RegexOptions.None, TimeSpan.FromMilliseconds(1000)))
        throw new DomainInvariantViolationException(
            type: nameof(Sku),
            rule: "SKU must look like ABC-1234");

    Code = code;
}
```

See [Invariants (§10)](/Koine/reference/invariants/) for the full guard expression grammar and how the same
`invariant` syntax applies to entities and quantities.

### 5.3.2 Derived (computed) fields

A field written `name: Type = expr` where `expr` references sibling fields is a **derived field**. It is
*not* a constructor parameter and *not* part of equality — it is emitted as a get-only computed property:

```koine
value Sku {
  code:       String
  normalized: String = code.trim.upper   // derived
}
```

The `normalized` field becomes an expression-bodied property, evaluated on each access:

```csharp
public string Normalized => Code.Trim().ToUpperInvariant();
```

Derived fields keep your invariants and accessors declarative. In the demo's `OrderLine`, pricing is
expressed entirely as derived fields over the two real inputs (`quantity` and `unitPrice`):

```koine
value OrderLine {
  product:   ProductId
  quantity:  Int
  unitPrice: Money
  // Derived: scale Money by a scalar, then apply a conditional discount.
  lineTotal: Money = unitPrice * quantity
  payable:   Money = if quantity >= 10 then lineTotal * 0.9 else lineTotal
}
```

:::tip
Only the *real* fields (here `product`, `quantity`, `unitPrice`) appear in the constructor and in
equality. `lineTotal` and `payable` recompute from them, so two `OrderLine`s with the same inputs are
always equal regardless of derived values.
:::

### 5.3.3 Defensive copies of collections

When a value object field is a `List<T>` or `Set<T>`, the constructor takes a defensive copy and exposes
it as a read-only view (`IReadOnlyList<T>` / `IReadOnlySet<T>`). A caller cannot mutate your value object
by holding onto the collection they passed in. Collection fields participate in equality by element —
ordered for `List<T>`, order-insensitive for `Set<T>` — via the runtime's `Ordered(...)` / `Unordered(...)`
helpers on the `ValueObject` base.

See [Contexts & types (§4)](/Koine/reference/contexts-and-types/) for the full list of how Koine types lower to C#.

## 5.4 Translation to C#

Per-aspect emitted C# is shown inline in [§5.3](#53-semantics) above; this section gives the canonical emitted shape.

Here is the C# Koine emits for the `Price` above:

```csharp
public sealed class Price : ValueObject
{
    public decimal Amount { get; }
    public Currency Currency { get; }

    public Price(decimal amount, Currency currency)
    {
        if (!(amount >= 0))
            throw new DomainInvariantViolationException(
                type: nameof(Price),
                rule: "a price cannot be negative");

        Amount = amount;
        Currency = currency;
    }

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Amount;
        yield return Currency;
    }
}
```

The base `ValueObject` (in `Koine.Runtime`) implements `Equals`, `GetHashCode`, and the `==` / `!=`
operators once for every value object, comparing the sequence returned by `GetEqualityComponents()`. Your
generated type only contributes the ordered list of components.

### 5.4.1 Scalar arithmetic operators

A value object with a numeric field can be multiplied or divided by a scalar, and Koine
generates the corresponding operator — but **only for the operations your model actually uses**. The
emitter scans derived fields, factories, and commands; each scalar operation it sees on a value object
produces exactly one operator overload, carrying the remaining fields unchanged.

In the demo, `Money` is multiplied by an `Int` (`unitPrice * quantity`) and by a `Decimal` (`lineTotal * 0.9`),
and two `Money`s are summed (`lines.sum(...)`). So Koine emits three operators and nothing more:

```koine
value Money {
  amount:   Decimal
  currency: Currency
  invariant amount >= 0   "an amount cannot be negative"
}
```

```csharp
public static Money operator *(Money left, decimal right) => new Money(left.Amount * right, left.Currency);

public static Money operator *(Money left, int right) => new Money(left.Amount * right, left.Currency);

public static Money operator +(Money left, Money right) => new Money(left.Amount + right.Amount, left.Currency);
```

Notice the operators preserve `Currency` and route the result back through the validating constructor, so
the arithmetic can never produce an invalid value object.

Division is the dual of multiplication and is demand-generated the same way. A derived field such as
`half: Money = fee / 2` makes the emitter generate the matching `operator /`:

```csharp
public static Money operator /(Money left, int right) => new Money(left.Amount / right, left.Currency);
```

It divides the numeric field, carries the rest, and routes through the validating constructor — `money / 2`
scales a value *down*, exactly as `money * 2` scales it up.

When a scaled field is `Int` and the arithmetic doesn't land on a whole number — a fractional factor
(`weight * 1.5`) or a non-integer quotient (`weight / 2`) — the result **truncates toward zero**: the
fractional part is dropped and the sign is kept, e.g. `7 / 2 = 3` and `-7 / 2 = -3` (not `-4`). This is
**consistent across every emitter target** (C#, TypeScript, Python, Rust) — the same `.koi` model
produces the same number regardless of target. `Int × Int` is always exact, and a `Decimal` field keeps
full precision throughout. PHP is the one outlier: an `Int` field's scalar arithmetic routes through its
BCMath-backed `Decimal` runtime rather than a native integer, so it neither rounds nor truncates the way
the other four targets do.

Same-type values combine **directly**, too — not only through a `sum` fold. A derived field such as
`total: Money = fee + fee` or `diff: Money = fee - fee` demand-generates the matching same-type
`operator +` / `operator -`:

```csharp
public static Money operator -(Money left, Money right) => new Money(left.Amount - right.Amount, left.Currency);
```

Like `+`, `-` subtracts each numeric field, carries the rest, guards that the non-numeric fields agree
(`EUR - USD` throws), and routes through the validating constructor — so a difference that would be
negative throws the `amount >= 0` invariant at construction, exactly as any other invalid value would.

A value object **scales** by a scalar — multiply in either operand order (`money * 2`, `2 * money`) or
divide it down (`money / 2`) — and combines with another value of its **own type** through `+`/`-`,
whether written directly (`fee + fee`) or via a `sum` fold (`lines.sum(...)`). But a bare scalar is never
a valid `+`/`-` operand: `5.0 + money` or `money - 1` is a type mismatch (`KOI0215`), because there is no
`value-object ± scalar` operation in any target. Division is one-directional too: `money / 2` scales the
value down, but `2 / money` is meaningless — a scalar cannot be divided *by* a value object — and is
rejected the same way (`KOI0215`). Use `*` or `/` to scale.

:::caution
Operators are demand-driven, not exhaustive. If you want `Money / int` available to hand-written code, use
it somewhere in a `.koi` derived field or command so the emitter generates it. There is no flag to emit
every possible overload.
:::

## 5.5 Quantities

A `quantity` is a value object with a `Decimal` amount and an enum unit that emits *unit-checked* `+` / `-`
operators — adding grams to kilograms throws. It also gets scalar `*` / `/` by `Int` and `Decimal`,
preserving the unit. It still validates and compares structurally like any other value object:

```koine
quantity Weight {
  amount: Decimal
  unit:   MassUnit
  invariant amount >= 0   "a weight cannot be negative"
}
```

```csharp
public static Weight operator +(Weight left, Weight right)
{
    if (left.Unit != right.Unit)
        throw new DomainInvariantViolationException(
            type: nameof(Weight),
            rule: "cannot add quantities of different units");
    return new Weight(left.Amount + right.Amount, left.Unit);
}
```

## 5.6 Example

The full `Catalog` context below declares three value objects (`Sku`, `Price`, `SalePeriod`), a
`quantity` (`Weight`), and the enums they depend on. It is copy-pasteable and compiles with
`koine build`:

```koine
context Catalog version 2 {

  enum Currency(symbol: String, decimals: Int) {
    EUR("€", 2)
    USD("$", 2)
    GBP("£", 2)
  }

  enum MassUnit { Gram, Kilogram }

  // Validated by shape, normalized with a derived field.
  value Sku {
    code:       String
    normalized: String = code.trim.upper
    invariant code.trim.length > 0                  "a SKU cannot be blank"
    invariant code matches /^[A-Z]{3}-[0-9]{4}$/     "SKU must look like ABC-1234"
  }

  // Two real fields, one invariant.
  value Price {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "a price cannot be negative"
  }

  // A quantity: amount + enum unit, with unit-checked arithmetic.
  quantity Weight {
    amount: Decimal
    unit:   MassUnit
    invariant amount >= 0   "a weight cannot be negative"
  }

  // A Range<Instant> interval value object. The built-in Range<T> supplies
  // Start/End, a start<=end check, and Contains/Overlaps.
  value SalePeriod {
    window: Range<Instant>
  }
}
```

## 5.7 Relation to entities

The key distinction: **value objects have no identity**. An [entity (§6)](/Koine/reference/entities-and-identity/) is
identified by an id and two entities with identical fields are still different things; two value objects
with identical fields *are the same value*. Use a value object for a measurement, a money amount, an
address, a code — anything you'd happily replace wholesale rather than mutate.

:::caution
Because a value object has no identity, its fields must stay **data**: primitives, enums, `*Id` ids,
other value objects, and `List`/`Set`/`Map`/`Range` of those. A field whose type is an entity or an
aggregate is `ValueObjectReferencesEntity` (KOI1601) — reference it by its `*Id` instead. The same
data-only rule governs [command/factory parameters and domain-event fields](/Koine/reference/commands-events-state/)
(KOI1603 / KOI1604).
:::

Identity types themselves (`ProductId`, `OrderId`, …) are generated value objects too — small records
wrapping a `Guid` (or a natural key). See [Entities & identity (§6)](/Koine/reference/entities-and-identity/) for the strategies.

## See also

- [Invariants (§10)](/Koine/reference/invariants/) — the guard expression grammar shared across value objects, entities, and quantities.
- [Entities & identity (§6)](/Koine/reference/entities-and-identity/) — identity-bearing types and how they differ from value objects.
- [Contexts & types (§4)](/Koine/reference/contexts-and-types/) — how Koine field types lower to C#.
- [Expressions (§9)](/Koine/reference/expressions/) — the expression grammar used in derived fields and invariants.
