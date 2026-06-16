---
title: "Expressions"
description: "The pure expression sublanguage used in derived fields, invariants and bodies."
---

Koine has one small, pure expression language. It is the same language everywhere a value or
condition is expected: in [derived fields](/Koine/reference/value-objects/), [invariants](/Koine/reference/invariants/),
command and factory bodies, [specs and service operations](/Koine/reference/specs-services-policies/),
and [read-model projections](/Koine/reference/application-cqrs/).

"Pure" is the whole point: no statements, no assignments, no loops, no I/O, no `null` literal. An expression
is a value computed from a field, a parameter, a literal, and a fixed set of operators and built-in operations.
Everything below translates to idiomatic C# — a derived field becomes a get-only computed property, an
invariant becomes a constructor guard.

## Where expressions are allowed

| Position | Form | Example |
|----------|------|---------|
| Derived field | `name: Type = expr` | `total: Money = lines.sum(l => l.payable)` |
| Invariant | `invariant expr "message"` | `invariant amount >= 0 "a price cannot be negative"` |
| Guarded invariant | `invariant body when cond` | `invariant status == Draft when lines.isEmpty` |
| Command precondition | `requires expr "message"` | `requires !lines.isEmpty "cannot submit an empty order"` |
| Spec body | `spec S on T = expr` | `spec IsVip on Customer = tier == Gold` |
| Operation body | `operation o(...): T = expr` | `operation discountRate(tier: LoyaltyTier): Decimal = ...` |
| Read-model field | `name: Type = expr` | `lineCount: Int = lines.count` |
| Factory init / command transition | `field -> expr` | `total -> lines.sum(l => l.price)` |

## Literals and identifiers

The atoms of every expression:

- **Numbers** — `10`, `0.9`, `0.0` (a decimal literal carries no suffix in `.koi`; the emitter adds `m` for `Decimal`).
- **Strings** — `"X"`, `", "` (double-quoted).
- **Booleans** — `true`, `false`.
- **Identifiers** — a field name, a factory/command parameter, or a bare enum member (resolved against the
  field's enum type, so two enums may share a member name).

```koine
isAvailable: Bool = availability == InStock
```

Here `availability` is a field and `InStock` is a bare member of its enum — both are identifiers.

## Arithmetic and comparison

Arithmetic `+ - * /` and comparison `== != < <= > >=` work as you expect. Arithmetic over a value object
uses that object's generated operators (so `unitPrice * quantity` multiplies `Money` by a scalar).

```koine
value OrderLine {
  product:   ProductId
  quantity:  Int
  unitPrice: Money
  lineTotal: Money = unitPrice * quantity
  invariant quantity >= 1   "an order line needs at least one unit"
}
```

Comparison is type-checked. Relational operators (`< <= > >=`) require **orderable** operands — exactly
`Int`, `Decimal`, and `Instant`. `String` is not orderable; compare strings with `==`/`!=` only.

:::note
`+` is overloaded: between numbers it adds, between strings it concatenates. `street + ", " + city`
produces a `String`; `amount + tax` over two `Money` value objects uses Money's `+` operator.
:::

## Logical operators

Boolean logic uses `&&` (and), `||` (or), and prefix `!` (not).

```koine
spec IsLargeOrder on Order = lines.count > 10 || total.amount > 1000
```

```koine
requires !lines.isEmpty   "cannot submit an empty order"
```

## Conditionals

`if cond then a else b` is an expression (a ternary), not a statement — it always yields a value, so both
branches are required and must have compatible types.

```koine
payable: Money = if quantity >= 10 then lineTotal * 0.9 else lineTotal
```

It emits a parenthesized C# ternary:

```csharp
public Money Payable => ((Quantity >= 10) ? (LineTotal * 0.9m) : LineTotal);
```

Conditionals nest in the `else` branch for multi-way logic:

```koine
operation discountRate(tier: LoyaltyTier): Decimal =
  if tier == Gold then 0.10 else if tier == Silver then 0.05 else 0.0
```

## String operations

String operations are written as member access on a `String` receiver. They chain left to right.

| Koine | Meaning | Emitted C# |
|-------|---------|------------|
| `s.length` | character count | `s.Length` |
| `s.trim` | strip surrounding whitespace | `s.Trim()` |
| `s.upper` | upper-case | `s.ToUpperInvariant()` |
| `s.lower` | lower-case | `s.ToLowerInvariant()` |

```koine
value Sku {
  code:       String
  normalized: String = code.trim.upper
  invariant code.trim.length > 0   "a SKU cannot be blank"
}
```

`code.trim.upper` chains, emitting `Code.Trim().ToUpperInvariant()`; the invariant
`code.trim.length > 0` becomes a constructor guard `if (!(code.Trim().Length > 0)) throw …`.

:::tip
For shape constraints beyond these ops, use the regex form `field matches /pattern/` in an invariant —
see [Invariants](/Koine/reference/invariants/).
:::

## Collection operations

Collection operations apply to a `List<T>` field. The element type `T` is in scope inside a lambda written
`param => expr`, with the element's members resolvable (`l => l.quantity`).

| Koine | Meaning | Emitted C# (sketch) |
|-------|---------|---------------------|
| `xs.count` | element count | `Xs.Count` |
| `xs.isEmpty` | is empty | `Xs.Count == 0` |
| `xs.isNotEmpty` | is non-empty | `Xs.Count != 0` |
| `xs.all(l => p)` | every element satisfies `p` | `Xs.All(l => p)` |
| `xs.any(l => p)` | some element satisfies `p` | `Xs.Any(l => p)` |
| `xs.sum(l => e)` | fold `e` over elements | numeric: `Xs.Sum(l => e)`; value object: `Xs.Select(l => e).Aggregate((a, b) => a + b)` |
| `xs.distinctBy(l => k)` | no two elements share key `k` | `Xs.Select(l => k).Distinct().Count() == Xs.Count` |

```koine
entity Order identified by OrderId {
  lines: List<OrderLine>
  total:     Money = lines.sum(l => l.payable)
  lineCount: Int   = lines.count
  invariant lines.all(l => l.quantity >= 1)    "every line needs a positive quantity"
  invariant lines.distinctBy(l => l.product)   "no duplicate products in an order"
}
```

`lines.sum(l => l.payable)` over a value-object selector folds with the element's `+` operator rather than
numeric `.Sum(...)`:

```csharp
public Money Total => Lines.Select(l => l.Payable).Aggregate((a, b) => a + b);
public int LineCount => Lines.Count;
```

:::note
`distinctBy` is a **uniqueness predicate**, not a transformation — used as an invariant it asserts there are
no duplicate keys, emitting a count comparison rather than returning a deduplicated list.
:::

## Instant comparison

`Instant` fields (emitted as `DateTimeOffset`) compare with the full relational set `< <= > >= == !=`.
Comparing an `Instant` against a non-`Instant` is a type error.

```koine
value DateRange {
  startsAt: Instant
  endsAt:   Instant
  invariant startsAt <= endsAt   "start must precede end"
}
```

The built-in `now` is recognized in command bodies (e.g. `submittedAt -> now`) but is **rejected as a stored
default** (`field: Instant = now`) so generated models stay deterministic.

## Optionality

Mark a field optional with a trailing `?` (`String?`, `Instant?`). Optional fields default to absent and are
excluded from non-null construction guards. Three expression forms work with optionals:

| Koine | Meaning | Emitted C# |
|-------|---------|------------|
| `a ?? b` | coalesce — `a` if present, else `b` | `(a ?? b)` |
| `field.isPresent` | true when set | `field is not null` |
| `field.isNone` | true when absent | `field is null` |

```koine
entity Customer identified by CustomerId {
  name:        String
  nickname:    String?
  phone:       String?
  displayName: String = nickname ?? name
  hasPhone:    Bool   = phone.isPresent
}
```

```csharp
public string DisplayName => (Nickname ?? Name);
public bool HasPhone => Phone is not null;
```

:::caution
There is no `null` literal in Koine — you never write `null`. Absence is expressed by leaving an optional
field unset; you reach for it with `??`, `.isPresent`, and `.isNone`.
:::

## Operator spacing: `->` and `<->` are atomic tokens

The state-effect arrow `->` (factory field init **and** command/state transition) and the context-map
operator `<->` are **single, indivisible tokens**. Keep their characters adjacent — never split them with a
space.

```koine
total -> lines.sum(l => l.price)   // correct: -> is one token (factory init)
status -> Submitted                // correct: -> is one token (command transition)
```

Writing `status - > …` would lex as a unary minus followed by a comparison `>`, not a state effect. The
lambda arrow `=>` is likewise atomic. Everywhere else, spacing is free.

:::tip[Two arrows, not three]
Koine has exactly two assignment-like arrows. `=` is the **declaration default** (`status: OrderStatus = Draft`),
and `->` is the **state effect** — it sets a field's value, whether that is a factory's initial value (`n -> v`
in a [factory](/Koine/reference/factories/)) or a command's transition (`status -> Submitted` in a
[command](/Koine/reference/commands-events-state/)). The enclosing `create {}` vs `command {}` block, not the
arrow, tells you which one you are reading. (A former third arrow, `<-` for factory init, has been merged into `->`.)
:::

## See also

- [Value objects](/Koine/reference/value-objects/) — derived fields use expressions.
- [Invariants](/Koine/reference/invariants/) — boolean expressions plus `matches` and `when` guards.
- [Commands, events & state](/Koine/reference/commands-events-state/) and [Factories](/Koine/reference/factories/) — bodies use `requires`, `->`, and `emit`.
- [Specs, services & policies](/Koine/reference/specs-services-policies/) — named expression bodies.
