---
title: "Invariants"
description: "Constructor guards: range, regex, conditional, and spec-backed."
---

## What an invariant is

An `invariant` is a rule that must hold for an object to exist. Koine compiles each
one into a guard at the **top of the constructor** (and re-checks them after a
command mutates state). If a guard fails, the object is never created and a
`DomainInvariantViolationException` is thrown.

That means you can never get your hands on an invalid `Sku`, `Money`, or `Order` — the
type system and the constructor enforce it. There is no separate "validate then use"
step; validity is a property of *having an instance*.

```koine
value Price {
  amount:   Decimal
  currency: Currency
  invariant amount >= 0   "a price cannot be negative"
}
```

```csharp
public Price(decimal amount, Currency currency)
{
    if (!(amount >= 0))
        throw new DomainInvariantViolationException(
            type: nameof(Price),
            rule: "a price cannot be negative");

    Amount = amount;
    Currency = currency;
}
```

:::note
`invariant` is a **fully reserved** word — unlike `value` or `quantity`, you cannot
use it as a field name. The same applies to `matches` (see [regex invariants](#regex-invariants-matches)).
:::

Invariants are valid inside `value`, `quantity`, `entity`, and aggregate roots. The
member order in a body is fixed: **fields first, then invariants**, then any states,
commands, and factories.

## Boolean invariants

The general form is `invariant <expr> "<message>"`. The expression must be boolean and
may reference any field of the type, derived fields, and the full Koine expression
language — comparisons, `&&` / `||`, string ops, and collection ops like `all`, `count`,
`sum`, and `distinctBy`.

```koine
value Sku {
  code:       String
  normalized: String = code.trim.upper
  invariant code.trim.length > 0   "a SKU cannot be blank"
}
```

```csharp
if (!(code.Trim().Length > 0))
    throw new DomainInvariantViolationException(
        type: nameof(Sku),
        rule: "a SKU cannot be blank");
```

The pattern is always the same: Koine emits `if (!(<expr>)) throw …`. The message string
becomes the `rule` argument, and `type` is the declaring type's name. On an aggregate
root with collection fields the expressions are richer, but the shape is identical:

```koine
invariant lines.all(l => l.quantity >= 1)    "every line needs a positive quantity"
invariant lines.distinctBy(l => l.product)   "no duplicate products in an order"
```

```csharp
if (!(lines.All(l => (l.Quantity >= 1))))
    throw new DomainInvariantViolationException(
        type: nameof(Order),
        rule: "every line needs a positive quantity");

if (!(lines.Select(l => l.Product).Distinct().Count() == lines.Count))
    throw new DomainInvariantViolationException(
        type: nameof(Order),
        rule: "no duplicate products in an order");
```

:::tip
`distinctBy(l => l.product)` is a uniqueness invariant — it reads as "these are
distinct by product" and compiles to the `Select(...).Distinct().Count() == Count`
check. Use it for "no duplicates" rules instead of writing the LINQ yourself.
:::

## Regex invariants (`matches`)

For string shape rules, use `invariant <field> matches /<regex>/ "<message>"`. Koine
emits a `Regex.IsMatch` guard and pulls in `using System.Text.RegularExpressions;`.

```koine
value Email {
  raw:        String
  normalized: String = raw.trim.lower
  invariant raw.trim.length > 0                "an email cannot be blank"
  invariant raw matches /^[^@]+@[^@]+\.[^@]+$/   "invalid email address"
}
```

```csharp
if (!Regex.IsMatch(raw, @"^[^@]+@[^@]+\.[^@]+$"))
    throw new DomainInvariantViolationException(
        type: nameof(Email),
        rule: "invalid email address");
```

The pattern between the slashes is copied verbatim into a C# verbatim string (`@"…"`),
so write the regex exactly as .NET's `Regex` expects it.

## Conditional invariants (`when`)

Sometimes a rule only applies in a particular state. Append a `when <cond>` clause and the
invariant body is only enforced when the condition holds:

```koine
invariant status == Draft when lines.isEmpty
```

This reads as "*when* the order has no lines, its status must be `Draft`". Koine compiles
the `when` condition into a short-circuiting `&&` in front of the negated body — the guard
only fires when the condition is true *and* the rule is broken:

```csharp
if (lines.Count == 0 && !(status == OrderStatus.Draft))
    throw new DomainInvariantViolationException(
        type: nameof(Order),
        rule: "status == Draft when lines.isEmpty");
```

:::note
A `when` invariant takes no message string — Koine synthesizes the `rule` text from the
source (`"status == Draft when lines.isEmpty"`), so the exception still describes exactly
which rule was violated.
:::

## Spec-backed invariants

A [specification](/Koine/reference/specs-services-policies/) is a named, reusable boolean predicate
declared with `spec <Name> on <Type> = <expr>`. You can reference it as an invariant by its
bare name — no message required — and Koine inlines the predicate into the constructor guard:

```koine
spec HasLines on Order = !lines.isEmpty

entity Order identified by OrderId {
  lines: List<OrderLine>
  invariant HasLines   "an order must have at least one line"
}
```

The spec's body is inlined at the guard site, so the emitted check is the same as if you
had written the expression directly — but the rule now lives in one named place and can be
reused in commands, derived fields, and other specs. The spec must target the same type the
invariant lives on (otherwise you get a `SpecTargetMismatch` error), and if the inlined body
uses collection ops, `using System.Linq;` is pulled into the file.

See [Specs, services & policies](/Koine/reference/specs-services-policies/) for the full story on declaring,
composing, and reusing named predicates.

## The exception

Every failing invariant throws the same runtime type, emitted once into your output as
`Koine.Runtime.DomainInvariantViolationException`:

```csharp
public sealed class DomainInvariantViolationException : Exception
{
    public string TypeName { get; }
    public string Rule { get; }

    public DomainInvariantViolationException(string type, string rule)
        : base($"Invariant violated on {type}: {rule}") { … }
}
```

The same exception is reused for illegal [state transitions](/Koine/reference/commands-events-state/)
and unmet [command preconditions](/Koine/reference/commands-events-state/) (`requires`), so a single
`catch (DomainInvariantViolationException ex)` can surface any domain-rule failure, with
`ex.TypeName` and `ex.Rule` available for logging or mapping to an API error.

## Quick reference

| Form | Emits |
| --- | --- |
| `invariant <expr> "msg"` | `if (!(<expr>)) throw …` |
| `invariant <field> matches /re/ "msg"` | `if (!Regex.IsMatch(<field>, @"re")) throw …` |
| `invariant <body> when <cond>` | `if (<cond> && !(<body>)) throw …` |
| `invariant <SpecName> "msg"?` | inlines the named spec's predicate into the guard |

## Related

- [Value objects](/Koine/reference/value-objects/) — where most invariants live.
- [Specs, services & policies](/Koine/reference/specs-services-policies/) — reusable named predicates you can use as invariants.
- [Commands, events & state machines](/Koine/reference/commands-events-state/) — `requires` preconditions (the command-level cousin of invariants) and legal transitions, also guarded by `DomainInvariantViolationException`.
