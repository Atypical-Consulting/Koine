---
title: "Modeling money: value objects and invariants in Koine"
description: "A hands-on look at value objects in Koine — model Money with an invariant and a derived field, see the exact C# it compiles to, and understand why an invalid value object can never exist."
excerpt: "Money is the canonical value object: equal by value, never negative, immutable. Here's how you say that in Koine, and the guard-clause C# you get back."
date: 2026-06-17
authors:
  - phmatray
tags:
  - tutorial
  - value-objects
  - invariants
---

`Money` is the example everyone reaches for when explaining value objects, and for good reason. It's
defined entirely by its values (€10 *is* €10), it's immutable, and it carries a rule that must always
hold: an amount can't be negative. That makes it the perfect first thing to model in Koine.

## A value object is its values

Here's `Money` and the smart enum it depends on:

```koine
context Billing {

  enum Currency(symbol: String, decimals: Int) {
    EUR("€", 2)
    USD("$", 2)
    GBP("£", 2)
  }

  value Money {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "a monetary amount cannot be negative"
  }
}
```

Three things are happening:

- **`value Money`** declares a value object. Its identity is the tuple of its fields — two `Money`
  instances with the same amount and currency are equal, full stop.
- **`Currency` is a smart enum** whose members carry constant data. `EUR` isn't just a name; it knows
  its `symbol` and how many `decimals` it has.
- **The `invariant`** states a rule in domain language, with the message a user will see if it's
  violated.

## The C# you get back

`koine build` emits `Billing/ValueObjects/Money.cs` (output is nested by category — value objects go
under `ValueObjects/`, enums under `Enums/`). The shape is the same one you'd write by hand — a sealed
class, a validating constructor, by-value equality:

```csharp
public sealed class Money : ValueObject
{
    public decimal Amount { get; }
    public Currency Currency { get; }

    public Money(decimal amount, Currency currency)
    {
        if (amount < 0)
        {
            throw new DomainInvariantViolationException(
                type: nameof(Money),
                rule: "a monetary amount cannot be negative");
        }

        Amount = amount;
        Currency = currency;
    }

    public override string ToString()
        => $"Money {{ Amount = {Amount}, Currency = {Currency} }}";

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Amount;
        yield return Currency;
    }
}
```

The guard is **inverted**: the emitter negates `amount >= 0` to `amount < 0` and always wraps it in
braces — the constructor fails fast with the literal message you wrote in the model.

The `Currency` field type is the smart enum generated alongside Money into
`Billing/Enums/Currency.cs`. Here's a representative excerpt:

```csharp
/// <summary>A type-safe smart enum: static instances with value equality.</summary>
public sealed class Currency : IEquatable<Currency>
{
    public static readonly Currency EUR = new("EUR", 0, "€", 2);
    public static readonly Currency USD = new("USD", 1, "$", 2);
    public static readonly Currency GBP = new("GBP", 2, "£", 2);

    public string Name { get; }
    public int Value { get; }
    public string Symbol { get; }
    public int Decimals { get; }

    private Currency(string name, int value, string symbol, int decimals)
    {
        Name = name;
        Value = value;
        Symbol = symbol;
        Decimals = decimals;
    }

    public static IReadOnlyList<Currency> All { get; } = new[] { EUR, USD, GBP };

    public static Currency FromName(string name)
        => All.FirstOrDefault(e => e.Name == name)
            ?? throw new ArgumentOutOfRangeException(nameof(name), $"No Currency with name '{name}'.");

    // … TryFromName / FromValue / TryFromValue …

    public TResult Match<TResult>(
        Func<TResult> eUR,
        Func<TResult> uSD,
        Func<TResult> gBP)
        => Value switch
        {
            0 => eUR(),
            1 => uSD(),
            2 => gBP(),
            _ => throw new InvalidOperationException($"Unhandled Currency '{Name}'.")
        };

    // … Switch / ToString / Equals / GetHashCode / == / != …
}
```

`EUR` isn't just a name: it carries `Symbol = "€"` and `Decimals = 2`. The `Match` signature is
exhaustive — the compiler forces you to handle every member. This is the class that `Money.Currency`
references; `Money` carries a `Currency` reference, not a raw string or integer.

The key move is **where** the invariant lands: it's a guard at the *top* of the constructor, before any
field is assigned. There is no way to construct a negative `Money`. The object is valid by the time it
exists, or it doesn't exist — the rule isn't a method you have to remember to call, it's a property of
the type. Equality comes from the `ValueObject` base (a small emitted marker, not a NuGet package):
`GetEqualityComponents` lists the fields that define identity, and the base supplies `Equals`,
`GetHashCode`, and `==`/`!=`.

## Derived fields: computed, not stored

Often a value object exposes something computed from its other fields. Say you want a normalized SKU:

```koine
value Sku {
  code:       String
  normalized: String = code.trim.upper
  invariant code.trim.length > 0               "a SKU cannot be blank"
  invariant code matches /^[A-Z]{3}-[0-9]{4}$/  "SKU must look like ABC-1234"
}
```

A field with an `= expression` that references other fields is **derived**. It does *not* become a
constructor parameter — you can't pass it in — it becomes a get-only computed property:

```csharp
public string Normalized => Code.Trim().ToUpperInvariant();
```

That distinction is the whole point: `code` is input you supply; `normalized` is a consequence the
model computes. And the second invariant — `matches /…/` — compiles straight to `Regex.IsMatch`, so a
malformed SKU is rejected at construction time just like a negative amount.

## Why this is the part worth getting right

Value objects are where a domain model earns its keep. Push the rules down into the type and the rest
of the system gets simpler for free: an application service that accepts a `Money` never has to
re-check that it's non-negative, because a negative `Money` is unrepresentable. Koine makes stating
those rules cheap — one `invariant` line — and turns them into guard clauses you can read and trust.

From here, [value objects in the reference](/Koine/reference/value-objects/) covers quantities (a
`Decimal` plus a unit, with unit-checked arithmetic), `Range<T>` intervals, and more derived-field
patterns. Or open the [Playground](/Koine/playground/?example=values), tweak the `Money` invariant, and
watch the guard clause change as you type.
