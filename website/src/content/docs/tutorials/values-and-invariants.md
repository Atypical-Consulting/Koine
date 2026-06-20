---
title: "1 · Values & invariants"
description: "Build value objects with derived fields, defaults, and three kinds of invariant."
---

This is part 1 of a hands-on tutorial that builds up to the [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo). We start where every domain starts: the small, immutable, self-validating types that everything else is built from — **value objects**.

By the end you will be able to declare fields with defaults, compute **derived fields** from other fields, and guard correctness with the three kinds of **invariant** Koine supports.

<a class="koi-try" href="/Koine/studio/">Follow along in Koine Studio</a>

## A first value object

A value object is a type defined entirely by its data, with no identity of its own. In Koine you declare one with `value`:

```koine
value Price {
  amount:   Decimal
  currency: Currency
  invariant amount >= 0   "a price cannot be negative"
}
```

Each `name: Type` line is a **field**. Koine maps its small set of primitives straight onto idiomatic C#:

| Koine | C# |
|-------|-----|
| `String` | `string` |
| `Int` | `int` |
| `Decimal` | `decimal` |
| `Bool` | `bool` |
| `Instant` | `DateTimeOffset` |

Fields become constructor parameters and get-only properties (PascalCased: `amount` becomes `Amount`). The emitted class derives from a `ValueObject` base that gives it structural equality — two `Price` values with the same `amount` and `currency` are equal. See [value objects](/Koine/reference/value-objects/) for the full reference.

:::note
Field names are written `camelCase` in `.koi` and emitted `PascalCase` in C#. The compiler handles the casing for you.
:::

## Defaults

Give a field a constant default with `= value`. The field becomes a constructor parameter with that default, so callers can omit it:

```koine
entity Customer identified by CustomerId {
  name: String
  tier: LoyaltyTier = Bronze
}
```

`tier: LoyaltyTier = Bronze` means new customers start at the `Bronze` loyalty tier unless told otherwise. (Enum defaults are coalesced to the smart-enum instance, since the value isn't a compile-time constant in C#.)

## Derived fields

A field with `= expression` (rather than `= constant`) is **derived**: instead of being stored and passed in, it is computed from the other fields. Derived fields become get-only expression-bodied properties — they cost nothing to store and can never drift out of sync.

Derived fields are where Koine's small, pure expression sublanguage shines. Here is the `Sku` value object from the Catalog context, which normalizes its raw code:

```koine
value Sku {
  code:       String
  normalized: String = code.trim.upper
  invariant code.trim.length > 0                  "a SKU cannot be blank"
  invariant code matches /^[A-Z]{3}-[0-9]{4}$/    "SKU must look like ABC-1234"
}
```

`normalized: String = code.trim.upper` emits a `Normalized => Code.Trim().ToUpperInvariant()` property. A few of the building blocks you can use in derived expressions:

| What | Koine | Example |
|------|-------|---------|
| String ops | `.trim` `.upper` `.lower` `.length` | `raw.trim.lower` |
| Concatenation | `+` | `street + ", " + city` |
| Coalescing | `??` | `description ?? name` |
| Presence | `.isPresent` (on optionals) | `phone.isPresent` |
| Comparison | `== != < <= > >=` | `availability == InStock` |
| Conditional | `if … then … else …` | `if tier == Gold then true else false` |

These compose. The `Customer` entity from the Customers context mixes coalescing, a presence check, and a conditional all at once:

```koine
nickname:     String?
phone:        String?
displayName:  String = nickname ?? name
hasPhone:     Bool   = phone.isPresent
freeShipping: Bool   = if tier == Gold then true else false
```

`freeShipping` emits the tidy `FreeShipping => Tier == LoyaltyTier.Gold;`. A `String?` is an optional field; `.isPresent` and `??` are how you safely read one. Optionals, defaults and derived members get their own treatment in [contexts & types](/Koine/reference/contexts-and-types/).

:::tip
Reach for a derived field whenever a value can be *computed* from the others. It keeps your model honest — there is no way to construct a `Sku` whose `normalized` disagrees with its `code`.
:::

## The three invariants

An **invariant** is a rule the value must always satisfy. Koine enforces it in the constructor: build an invalid value and it throws `DomainInvariantViolationException` before you ever hold a bad object. There are three forms.

### 1. Boolean guard

The plain form is any boolean expression plus a message:

```koine
invariant amount >= 0   "a price cannot be negative"
```

This emits a constructor guard: `if (!(amount >= 0)) throw …`.

### 2. Regex `matches /…/`

Use `matches /regex/` to validate string shape. The pattern goes between literal slashes:

```koine
invariant code matches /^[A-Z]{3}-[0-9]{4}$/    "SKU must look like ABC-1234"
```

This emits a `Regex.IsMatch(code, @"^[A-Z]{3}-[0-9]{4}$")` guard. Note you can combine a `matches` rule with an ordinary boolean rule in the same type, as `Sku` does above (one for non-blankness, one for shape).

### 3. Conditional `when`

A `when` clause makes the rule apply only under a condition — `invariant <body> when <cond>` emits `if (cond && !body) throw …`:

```koine
invariant status == Draft when lines.isEmpty
```

Read it as: *when there are no lines, the status must be `Draft`*. The guard is skipped entirely when the condition is false.

:::caution
`invariant` and `matches` are fully reserved words — unlike most Koine keywords, you can't use them as field names.
:::

## The emitted C#

Put it together. Here is `Email` from the Customers context — two invariants (one boolean, one regex) and a derived field:

```koine
value Email {
  raw:        String
  normalized: String = raw.trim.lower
  invariant raw.trim.length > 0                "an email cannot be blank"
  invariant raw matches /^[^@]+@[^@]+\.[^@]+$/  "invalid email address"
}
```

The compiler emits a self-contained, dependency-free C# value object:

```csharp
public sealed class Email : ValueObject
{
    public string Raw { get; }

    public Email(string raw)
    {
        if (!(raw.Trim().Length > 0))
            throw new DomainInvariantViolationException(
                type: nameof(Email),
                rule: "an email cannot be blank");

        if (!Regex.IsMatch(raw, @"^[^@]+@[^@]+\.[^@]+$"))
            throw new DomainInvariantViolationException(
                type: nameof(Email),
                rule: "invalid email address");

        Raw = raw;
    }

    public string Normalized => Raw.Trim().ToLowerInvariant();

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Raw;
    }
}
```

Notice what you got for free: structural equality via `GetEqualityComponents`, the derived `Normalized` property, and both invariants enforced before construction completes. You write the rules once; the compiler writes the boilerplate.

## A complete, compiling context

Everything above lives inside a `context` — a bounded context that becomes one C# namespace. Here is a minimal but complete model you can paste into a `.koi` file and compile with `koine build`:

```koine
context Catalog {
  enum Currency(symbol: String, decimals: Int) {
    EUR("€", 2)
    USD("$", 2)
    GBP("£", 2)
  }

  value Sku {
    code:       String
    normalized: String = code.trim.upper
    invariant code.trim.length > 0                  "a SKU cannot be blank"
    invariant code matches /^[A-Z]{3}-[0-9]{4}$/    "SKU must look like ABC-1234"
  }

  value Price {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "a price cannot be negative"
  }
}
```

Run it:

```bash
koine build catalog.koi --target csharp --out gen/
```

## Next

You now have validated, self-contained value objects. In part 2 we give a type **identity** and turn it into an entity, then assemble entities into an aggregate.

Continue to [2 · Entities & aggregates](/Koine/tutorials/entities-and-aggregates/), or dig deeper in the [value objects reference](/Koine/reference/value-objects/).
