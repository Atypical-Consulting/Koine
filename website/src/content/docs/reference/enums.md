---
title: "Enums"
description: "Smart enums and enum members carrying associated data."
---

## 8.1 General

A Koine `enum` is not a plain integer. It compiles to a **smart enum**: a `sealed class` with
named static instances, value equality, and a small reflection-free API for looking members up by
name or ordinal. You get the ergonomics of `switch` over a closed set without the footguns of a
C# `enum` (no out-of-range integers, no silent casts).

Enums occupy their own declaration slot inside a `context` (alongside value objects, entities, and
aggregates — see [Contexts & types (§4)](/Koine/reference/contexts-and-types/)). They are the natural
companion to [Value objects (§5)](/Koine/reference/value-objects/) (quantities pair a `Decimal` amount
with an enum unit) and to the state-machine construct described in
[Commands, events & state machines (§11)](/Koine/reference/commands-events-state/) (`states` blocks
turn an enum field into a guarded lifecycle).

## 8.2 Syntax

An enum declaration names the type, an optional data signature, and one or more members:

```ebnf
enum_decl
    : annotation* 'enum' Identifier ( '(' param_list? ')' )? '{' enum_member ( ','? enum_member )* ','? '}'
    ;

enum_member
    : Identifier ( '(' ( expression ( ',' expression )* )? ')' )?
    ;

param_list
    : param ( ',' param )*
    ;

param
    : Identifier ':' type_ref
    ;
```

- `Identifier` after `'enum'` is the type name (`OrderStatus`, `Currency`, …).
- The optional `'(' param_list? ')'` is the **signature** — a parenthesized list of typed fields
  that each member must supply as an argument list. Omit it for a bare (data-free) enum.
- `enum_member` names each variant. When the enum has a signature, each member appends a matching
  argument list `'(' expression* ')'`. Argument expressions are [Expressions (§9)](/Koine/reference/expressions/)
  literals; only primitive literals are permitted (see [§8.5.1](#851-rules-for-associated-data)).
- Members are separated by whitespace or optional commas; a trailing comma is allowed.
- Annotations (`@since`, `@deprecated`) from [Versioning (§18)](/Koine/reference/versioning/) may
  precede the `'enum'` keyword.

The bare form:

```koine
context Ordering {
  enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }
}
```

The associated-data form (covered in detail in [§8.5](#85-members-with-associated-data)):

```koine
context Catalog {
  enum Currency(symbol: String, decimals: Int) {
    EUR("€", 2)
    USD("$", 2)
    GBP("£", 2)
  }
}
```

## 8.3 Semantics

Every `enum X { … }` produces a **closed set** of named instances. The rules that govern the
declaration are:

- **At least one member is required.** An empty body is a parse error.
- **Member names are unique within the enum.** Duplicate identifiers raise `KOI0911`.
- **Two members may not differ only by leading-character case** (e.g. `Foo` and `foo`), because
  both would collapse to the same `Match`/`Switch` delegate parameter (`KOI0911`).
- **Signature arity is uniform.** All members must supply exactly as many arguments as the
  signature declares (see [§8.5.1](#851-rules-for-associated-data), `KOI0901`).

### 8.3.1 Generated API

Every enum emits the following fixed surface:

| Member | Meaning |
| --- | --- |
| static instances | one `public static readonly` field per member (`OrderStatus.Draft`, …) |
| `Name` | the member identifier as a string (`"Draft"`) |
| `Value` | the 0-based ordinal, in declaration order |
| `All` | an `IReadOnlyList<T>` of every member, in declaration order |
| `FromName(string)` | look up by name; throws `ArgumentOutOfRangeException` if unknown |
| `FromValue(int)` | look up by ordinal; throws `ArgumentOutOfRangeException` if unknown |
| `TryFromName(string, out T)` | non-throwing name lookup; returns `false` (and `null`) if unknown |
| `TryFromValue(int, out T)` | non-throwing ordinal lookup; returns `false` (and `null`) if unknown |
| `Match<TResult>(…)` | exhaustive: one `Func<TResult>` per member, returns the matched arm's result |
| `Switch(…)` | exhaustive: one `Action` per member, runs the matched arm |
| `Equals` / `GetHashCode` | value equality on `Value` |
| `==` / `!=` | null-safe operators delegating to `Equals` |

:::note
The constructor is `private`. Members are created once as static fields, so there is exactly one
instance per value — reference equality and value equality coincide, and `==` is safe to use.
:::

### 8.3.2 Name reservation

Because the members in [§8.3.1](#831-generated-api) are generated on every enum, two naming rules
apply to **all** enums:

- A **member** may not be named after a generated member — `Name`, `Value`, `All`, `FromName`,
  `FromValue`, `TryFromName`, `TryFromValue`, `Match`, `Switch`, `ToString`, `Equals`, `GetHashCode`
  (`KOI0910`).
- **Signature field names** are case-insensitively reserved against the same list. A field named
  `value: Int` is rejected (`KOI0903`).

## 8.4 Translation to C#

### 8.4.1 Bare enum

A bare `enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }` emits a self-contained
sealed class:

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
    public static bool TryFromName(string name, out OrderStatus result) => /* ... */;
    public static bool TryFromValue(int value, out OrderStatus result) => /* ... */;

    public TResult Match<TResult>(Func<TResult> draft, Func<TResult> submitted, /* … */) => /* ... */;
    public void Switch(Action draft, Action submitted, /* … */) => /* ... */;

    public override string ToString() => Name;
    public bool Equals(OrderStatus? other) => other is not null && Value == other.Value;
    public override bool Equals(object? obj) => Equals(obj as OrderStatus);
    public override int GetHashCode() => Value;
    public static bool operator ==(OrderStatus? left, OrderStatus? right) => /* ... */;
    public static bool operator !=(OrderStatus? left, OrderStatus? right) => /* ... */;
}
```

### 8.4.2 Parsing at a boundary: `TryFromName` / `TryFromValue`

`FromName`/`FromValue` throw when the name or ordinal is unknown — correct for trusted internal
calls. But an enum is exactly the type you parse at a boundary: rehydrating from a database, mapping
a string off an HTTP or message-bus payload, validating user input. There, "unknown member" is
expected control flow, not an exception. The `Try*` pair gives you the .NET-canonical shape (it
mirrors `int.TryParse` / `Enum.TryParse`) without a `try`/`catch` on a hot path:

```csharp
if (OrderStatus.TryFromName(dto.Status, out var status))
    order.SetStatus(status);
else
    return Result.Fail($"unknown status '{dto.Status}'");
```

On a miss they return `false` and set the `out` to `null`; on a hit they return `true` and bind the
member. They ignore any associated-data signature, exactly like `FromName`/`FromValue`.

### 8.4.3 Exhaustive matching: `Match` / `Switch`

Because each member is a `static readonly` instance rather than a compile-time constant, smart-enum
members cannot appear as C# `case` labels. Instead, every enum emits an exhaustive `Match` (returns a
value) and `Switch` (runs a side effect) — one delegate per member, in declaration order:

```csharp
decimal fee = order.Status.Match(
    draft:     () => 0m,
    submitted: () => 0m,
    paid:      () => 1.5m,
    shipped:   () => 1.5m,
    cancelled: () => 0m);

order.Status.Switch(
    draft:     () => log.Info("still editable"),
    submitted: () => notify.Pending(order),
    paid:      () => ship.Enqueue(order),
    shipped:   () => { },
    cancelled: () => refund.Start(order));
```

The payoff is closed-set safety a C# `enum` cannot give: **adding a member adds a required delegate
parameter, so every call site stops compiling until it handles the new case.** Delegate parameters
are the camelCased member names (`OrderStatus.Draft` → `draft`).

Both are **total** over the closed set: there is exactly one arm per member and every instance
carries an in-range ordinal, so a match always hits an arm — you never write a fallback.

## 8.5 Members with associated data

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

### 8.5.1 Rules for associated data

The compiler enforces a few constraints so the emitted class is always well-formed:

- **Literal primitive field types only.** Signature fields must be `String`, `Int`, `Decimal`, or
  `Bool`. A `List<T>`, value object, or enum field is rejected (`KOI0909`). Because of this, enum
  associated data can never reference cross-context types.
- **Reserved associated-data field names.** Field names are case-insensitively reserved against the
  generated members: `Name`, `Value`, `All`, `FromName`, `FromValue`, `TryFromName`, `TryFromValue`,
  `Match`, `Switch`, `ToString`, `Equals`, `GetHashCode`. A field named `value: Int` is rejected
  (`KOI0903`).
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

## 8.6 Scoped member resolution

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

Resolution also flows from the **expected type** of the surrounding expression, not just a sibling
operand. In a comparison whose other side is itself a bare member, or in a `??`/conditional branch
feeding an enum-typed slot, the expected enum type disambiguates the bare member the same way. Only
when no operand and no expected type pins the enum does Koine report the ambiguity (`KOI0213`) and
ask you to qualify.

:::tip
Enum defaults read the same way: `status: OrderStatus = Draft` uses the bare member because the
field's declared type pins the enum.
:::

## 8.7 Enum defaults and lifecycle states

An enum-typed field can take a default member (`status: OrderStatus = Draft`). Because a smart-enum
instance is a static field rather than a compile-time constant, the emitted constructor parameter is
nullable and coalesced to the member — you never see this in your `.koi`, but it explains why the
default works for reference types.

Enum-typed fields are also the natural subject of a `states` block, which restricts the legal
transitions between members. See [Commands, events & state machines (§11)](/Koine/reference/commands-events-state/)
for how a `states status { … }` block turns an enum into a guarded state machine.

## 8.8 Example

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

- [Value objects (§5)](/Koine/reference/value-objects/) — quantities pair a `Decimal` amount with an enum unit.
- [Commands, events & state machines (§11)](/Koine/reference/commands-events-state/) — `states` blocks turn an enum into a guarded lifecycle.
- [Contexts & types (§4)](/Koine/reference/contexts-and-types/) — where enums live and how types reference each other.
- [Expressions (§9)](/Koine/reference/expressions/) — the expression grammar used in member arguments and scoped resolution.
- [Overview (§1)](/Koine/reference/overview/) — the full construct and type-mapping tables.
