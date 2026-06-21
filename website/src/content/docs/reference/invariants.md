---
title: "Invariants"
description: "Constructor guards: range, regex, conditional, and spec-backed."
---

## 10.1 General

An `invariant` is a rule that must hold for an object to exist. Koine compiles each
one into a guard at the **top of the constructor** (and re-checks them after a
command mutates state). If a guard fails, the object is never created and a
`DomainInvariantViolationException` is thrown.

That means you can never get your hands on an invalid `Sku`, `Money`, or `Order` — the
type system and the constructor enforce it. There is no separate "validate then use"
step; validity is a property of *having an instance*.

Invariants are valid inside `value`, `quantity`, `entity`, and aggregate roots. The
member order in a body is fixed: **fields first, then invariants**, then any states,
commands, and factories.

:::note
`invariant` is a **fully reserved** word — unlike `value` or `quantity`, you cannot
use it as a field name. The same applies to `matches` (see [§10.6](#106-regex-invariants-matches)).
:::

## 10.2 Syntax

An invariant is declared with the `invariant` keyword followed by a boolean expression
and an optional failure-message string. The expression may use the full Koine expression
language, including the `when` guard form and the `matches` regex form:

```ebnf
invariant
    : 'invariant' expression StringLiteral?
    ;
```

The `expression` grammar — including the `when` guard and `matches` — is specified in [Expressions §9.2](/Koine/reference/expressions/#92-syntax).

An `invariant` consists of:

- The keyword `invariant`.
- An `expression` — any well-formed boolean expression from the expression language
  ([Expressions (§9)](/Koine/reference/expressions/)). This includes comparisons, logical operators
  (`&&` / `||` / `!`), string operations, collection operations (`all`, `count`, `sum`,
  `distinctBy`), and the regex-match form `<expr> matches /pattern/`.
- An optional `StringLiteral` that becomes the failure message surfaced in
  `DomainInvariantViolationException.Rule`. When omitted (as with the `when` form and
  spec-backed invariants) Koine synthesizes the rule text from the source.

The `when` guard and the `matches` operator are both part of the full expression grammar
defined in [Expressions (§9)](/Koine/reference/expressions/). Writing
`invariant <body> when <cond>` makes the whole guard conditional on `<cond>`, while
`<field> matches /pattern/` switches the lexer into regex mode so the `/…/` is read as a
single token rather than two division operators.

```koine
value Price {
  amount:   Decimal
  currency: Currency
  invariant amount >= 0   "a price cannot be negative"
}
```

## 10.3 Semantics

### 10.3.1 Evaluation order and scope

Every `invariant` declared on a type is evaluated in declaration order at the top of the
constructor, before any field assignments. An invariant expression may reference any
field of the type (including derived fields whose expression does not itself depend on
uninitialized state) and the full expression language.

### 10.3.2 Message synthesis

When a `StringLiteral` message is present, it becomes the `rule` argument of
`DomainInvariantViolationException`. When the message is omitted — as with `when`-guarded
invariants and spec-backed invariants — Koine synthesizes the rule text from the source
representation of the invariant body.

### 10.3.3 Satisfiability analysis

The compiler statically folds the constant parts of each value object's invariants and
flags ones that can never hold — a value object whose invariants contradict each other
can never be constructed, so the generated code would always throw. These are warnings
(the code still compiles):

| Code | Meaning |
| --- | --- |
| `KOI0310` | The whole invariant condition is a constant that can never hold (always `false`). |
| `KOI0311` | A field's inclusive bounds are inverted (the lower bound exceeds the upper bound), e.g. `x >= 100 && x <= 0`. |
| `KOI0312` | A field's constant default lies outside the range its invariants require. |
| `KOI0313` | Two bounds on the same field cannot both hold; their intersection is empty, e.g. `amount > 100 && amount < 10`. |

A `when`-guarded invariant is conditional, so it is never flagged. Exhaustiveness of a
smart-enum `Match` stays a compile-time guarantee of the generated code — it is
deliberately *not* re-checked here.

### 10.3.4 Reserved words

`invariant` and `matches` are **fully reserved** — they cannot be used as field names
or identifiers anywhere in a `.koi` file. This is distinct from contextual keywords such
as `value` or `quantity`, which may appear as field names in positions where the parser
can unambiguously resolve them.

## 10.4 Translation to C#

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

The same exception is reused for illegal [state transitions (§11)](/Koine/reference/commands-events-state/)
and unmet [command preconditions (§11)](/Koine/reference/commands-events-state/) (`requires`), so a single
`catch (DomainInvariantViolationException ex)` can surface any domain-rule failure, with
`ex.TypeName` and `ex.Rule` available for logging or mapping to an API error.

The general emit pattern is always:

```csharp
if (!(<expr>))
    throw new DomainInvariantViolationException(
        type: nameof(DeclaringType),
        rule: "the message string");
```

Here is the C# Koine emits for the `Price` example above:

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

## 10.5 Boolean invariants

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

## 10.6 Regex invariants (`matches`)

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

## 10.7 Conditional invariants (`when`)

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

## 10.8 Spec-backed invariants

A [specification (§13)](/Koine/reference/specs-services-policies/) is a named, reusable boolean predicate
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

See [Specs, services & policies (§13)](/Koine/reference/specs-services-policies/) for the full story on declaring,
composing, and reusing named predicates.

## 10.9 Quick reference

| Form | Emits |
| --- | --- |
| `invariant <expr> "msg"` | `if (!(<expr>)) throw …` |
| `invariant <field> matches /re/ "msg"` | `if (!Regex.IsMatch(<field>, @"re")) throw …` |
| `invariant <body> when <cond>` | `if (<cond> && !(<body>)) throw …` |
| `invariant <SpecName> "msg"?` | inlines the named spec's predicate into the guard |

## See also

- [Value objects (§5)](/Koine/reference/value-objects/) — where most invariants live; see §5.3.1 for inline validating-constructor examples.
- [Expressions (§9)](/Koine/reference/expressions/) — the full expression grammar used in invariant bodies.
- [Specs, services & policies (§13)](/Koine/reference/specs-services-policies/) — reusable named predicates you can use as invariants.
- [Commands, events & state machines (§11)](/Koine/reference/commands-events-state/) — `requires` preconditions (the command-level cousin of invariants) and legal transitions, also guarded by `DomainInvariantViolationException`.
