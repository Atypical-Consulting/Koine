---
title: "Enums"
description: "Smart enums and enum members carrying associated data."
---

A Koine `enum` is not a plain integer. It compiles to a **smart enum**: a `sealed class` with
named static instances, value equality, and a small reflection-free API for looking members up by
name or ordinal. You get the ergonomics of `switch` over a closed set without the footguns of a
C# `enum` (no out-of-range integers, no silent casts).

## Declaring an enum

The bare form lists the members:

```koine
context Ordering {
  enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }
}
```

Members are separated by commas. Whitespace separation works too, and a trailing comma is allowed.

That declaration emits a self-contained class:

```csharp
public sealed class OrderStatus : IEquatable<OrderStatus>
{
    public static readonly OrderStatus Draft = new("Draft", 0);
    public static readonly OrderStatus Submitted = new("Submitted", 1);
    public static readonly OrderStatus Paid = new("Paid", 2);
    public static readonly OrderStatus Shipped = new("Shipped", 3);
    public static readonly OrderStatus Cancelled = new("Cancelled", 4);

    public string Name { get; }
    public int Value { get; }

    private OrderStatus(string name, int value)
    {
        Name = name;
        Value = value;
    }

    public static IReadOnlyList<OrderStatus> All { get; } = new[] { Draft, Submitted, Paid, Shipped, Cancelled };

    public static OrderStatus FromName(string name) => /* ... */;
    public static OrderStatus FromValue(int value) => /* ... */;

    public override string ToString() => Name;
    public bool Equals(OrderStatus? other) => other is not null && Value == other.Value;
    public override bool Equals(object? obj) => Equals(obj as OrderStatus);
    public override int GetHashCode() => Value;
    public static bool operator ==(OrderStatus? left, OrderStatus? right) => /* ... */;
    public static bool operator !=(OrderStatus? left, OrderStatus? right) => /* ... */;
}
```

### What you can rely on

| Member | Meaning |
| --- | --- |
| static instances | one `public static readonly` field per member (`OrderStatus.Draft`, …) |
| `Name` | the member identifier as a string (`"Draft"`) |
| `Value` | the 0-based ordinal, in declaration order |
| `All` | an `IReadOnlyList<T>` of every member, in declaration order |
| `FromName(string)` | look up by name; throws `ArgumentOutOfRangeException` if unknown |
| `FromValue(int)` | look up by ordinal; throws `ArgumentOutOfRangeException` if unknown |
| `Equals` / `GetHashCode` | value equality on `Value` |
| `==` / `!=` | null-safe operators delegating to `Equals` |

:::note
The constructor is `private`. Members are created once as static fields, so there is exactly one
instance per value — reference equality and value equality coincide, and `==` is safe to use.
:::

## Members with associated data

An enum can carry data alongside each member. Give the enum a **signature** — a parenthesized list
of typed fields — then supply a matching argument list for each member (R9.1):

```koine
context Catalog {
  enum Currency(symbol: String, decimals: Int) {
    EUR("€", 2)
    USD("$", 2)
    GBP("£", 2)
  }
}
```

Each signature field becomes a get-only PascalCase property; the rest of the smart-enum API is
unchanged:

```csharp
public sealed class Currency : IEquatable<Currency>
{
    public static readonly Currency EUR = new("EUR", 0, "€", 2);
    public static readonly Currency USD = new("USD", 1, "$", 2);
    public static readonly Currency GBP = new("GBP", 2, "£", 2);

    public string Name { get; }
    public int Value { get; }
    public string Symbol { get; }
    public int Decimals { get; }

    private Currency(string name, int value, string symbol, int decimals) { /* ... */ }

    public static IReadOnlyList<Currency> All { get; } = new[] { EUR, USD, GBP };
    // FromName / FromValue / Equals / ToString / == / != as above
}
```

Now `Currency.EUR.Symbol` is `"€"` and `Currency.GBP.Decimals` is `2` — no lookup table, no switch.
Member arguments may be separated by whitespace or optional commas; both `EUR("€", 2)` and
`EUR("€" 2)` parse.

### Rules for associated data

The compiler enforces a few constraints so the emitted class is always well-formed:

- **Literal primitive field types only.** Signature fields must be `String`, `Int`, `Decimal`, or
  `Bool`. A `List<T>`, value object, or enum field is rejected (`KOI0910`). Because of this, enum
  associated data can never reference cross-context types.
- **Reserved member names.** Field names are case-insensitively reserved against the generated
  members: `Name`, `Value`, `All`, `FromName`, `FromValue`, `ToString`, `Equals`, `GetHashCode`.
  A field named `value: Int` is rejected (`KOI0903`).
- **Arity must match.** Each member's argument count must equal the signature arity (`KOI0901`).
  Supplying args to a signature-less enum (`enum E { X(1) }`) is the same error.
- **Argument types must match.** A literal's type must fit the field's type (`KOI0902`). `Int`
  literals widen to `Decimal` fields, and negative numeric literals are allowed (e.g. `Cold("cold", -5)`).

```koine
context Sensors {
  enum Threshold(label: String, limit: Decimal) {
    Cold(-5)            // ✗ KOI0901: arity mismatch — signature wants two args
    Warm("warm", 30)    // ✓
  }
}
```

:::caution
A bare enum and an enum with associated data are different shapes. A bare `enum S { A, B, C }` emits
`private S(string name, int value)` and **no** associated properties. Add a signature only when the
members genuinely carry data.
:::

## Scoped (type-directed) member resolution

When you compare against an enum-typed field, you can write the member **bare** — without qualifying
it by the enum name. Koine resolves the bare member against the type of the field or operand (R3.5).
This keeps expressions readable and lets two enums share member names without clashing:

```koine
context Ordering {
  enum RefundStatus { None, Pending, Cancelled }
  enum OrderStatus  { Draft, Submitted, Paid, Shipped, Cancelled }

  aggregate Order root Order {
    entity Order identified by OrderId {
      status: OrderStatus  = Draft
      refund: RefundStatus = None

      // Bare `Cancelled` resolves to OrderStatus, because `status` is an OrderStatus.
      isCancelled: Bool = status == Cancelled
      // The qualified form is always available when you want to be explicit.
      isRefunded:  Bool = refund == RefundStatus.Cancelled
    }
  }
}
```

Both `OrderStatus` and `RefundStatus` define `Cancelled`. The bare `Cancelled` on line `status ==
Cancelled` binds to `OrderStatus.Cancelled` because the left operand is an `OrderStatus`. When the
target type is not obvious from context — or you simply prefer to be explicit — use the qualified
`EnumName.Member` form.

:::tip
Enum defaults read the same way: `status: OrderStatus = Draft` uses the bare member because the
field's declared type pins the enum.
:::

## Enums as defaults and lifecycle states

An enum-typed field can take a default member (`status: OrderStatus = Draft`). Because a smart-enum
instance is a static field rather than a compile-time constant, the emitted constructor parameter is
nullable and coalesced to the member — you never see this in your `.koi`, but it explains why the
default works for reference types.

Enum-typed fields are also the natural subject of a `states` block, which restricts the legal
transitions between members. See [commands, events & state machines](/Koine/reference/commands-events-state/)
for how a `states status { … }` block turns an enum into a guarded state machine.

## A complete example

```koine
context Catalog {
  enum Currency(symbol: String, decimals: Int) {
    EUR("€", 2)
    USD("$", 2)
    GBP("£", 2)
  }

  enum Availability { InStock, OutOfStock, Discontinued }

  value Price {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "a price cannot be negative"
  }
}
```

This emits `Catalog.Currency` (with `Symbol`/`Decimals` properties), `Catalog.Availability` (a bare
smart enum), and a `Catalog.Price` value object whose `currency` field is the smart enum.

## See also

- [Value objects](/Koine/reference/value-objects/) — quantities pair a `Decimal` amount with an enum unit.
- [Commands, events & state machines](/Koine/reference/commands-events-state/) — `states` blocks turn an enum into a guarded lifecycle.
- [Contexts & types](/Koine/reference/contexts-and-types/) — where enums live and how types reference each other.
- [Overview](/Koine/reference/overview/) — the full construct and type-mapping tables.
