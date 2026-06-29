---
title: "Reading the generated C#"
description: "How emitted files, namespaces, and the Koine.Runtime markers are organised."
---

You write `.koi` files; Koine emits idiomatic, self-contained C#. Before you wire the output into a
project it helps to know where things land and why. This page maps the output layout, the shared
runtime markers, the ID convention, and the Koine-to-C# type mapping — then shows one value object end
to end.

## One folder per context, one file per type

`koine build` writes a flat, predictable tree under your `--out` directory:

- **One folder per bounded `context`.** A `context Customers { … }` becomes a `Customers/` folder, and
  every type in it is emitted into the C# `namespace Customers`.
- **One file per declared type**, named after the type. A `value Email` produces `Customers/Email.cs`,
  an `entity Customer` produces `Customers/Customer.cs`, and so on.
- **One `Koine/Runtime/` folder** at the root holding the shared marker types (see below).
- A [`module`](/Koine/reference/multi-file-imports-modules/) nests one level deeper: types in `module Line` under context
  `Kitchen` land in `Kitchen/Line/` and `namespace Kitchen.Line`.

For the demo pizzeria domain that looks like this:

```
Generated/
├── Koine/Runtime/          # shared markers (emitted only when used)
├── Menu/
│   ├── Pizza.cs
│   ├── Topping.cs
│   ├── PizzaCode.cs
│   └── ...
├── Kitchen/
│   ├── Line/
│   │   └── KitchenTicket.cs
│   └── ...
└── Ordering/
    ├── Order.cs
    ├── OrderId.cs
    ├── IOrderRepository.cs
    └── ...
```

:::note
Aggregate-owned types are **not** put in a sub-namespace. Everything in a context — including the types
declared inside an `aggregate` — shares the single `<Context>` namespace. The aggregate boundary is
expressed by the root entity implementing `IAggregateRoot`, not by namespacing. This keeps generated
references simple and avoids name clashes.
:::

## The `Koine.Runtime` markers

Generated code has **no external dependencies**. Instead, a small set of shared types is emitted once
into `Koine/Runtime/` (namespace `Koine.Runtime`). Each one is **emitted only when something in your
model actually uses it** — a model with no events never gets `IDomainEvent`, a model with no `versioned`
aggregate never gets `ConcurrencyConflictException`.

| Runtime type | Emitted when your model… | Role |
|--------------|--------------------------|------|
| `DomainInvariantViolationException` | declares any `invariant` (and most other guards) | thrown when an invariant or illegal transition is violated |
| `ValueObject` | declares any `value`, `quantity`, or `*Id` type | base class giving by-value equality |
| `IAggregateRoot` | declares any `aggregate` | marks the consistency-boundary root entity |
| `IDomainEvent` | declares any `event` that gets emitted | the base contract for recorded domain facts |
| `Range` | uses a `Range<T>` field | the interval value object (`Start`/`End`, `Contains`, `Overlaps`) |
| `IQueryHandler<TQuery, TResult>` | declares any `query` | the shared CQRS query-handler contract |
| `ConcurrencyConflictException` | marks an aggregate `versioned` | optimistic-concurrency failure for stale writes |

Because they are plain framework types with no NuGet dependency, you can commit the generated tree
straight into a project and it compiles on its own.

## The ID convention (`*Id` types)

Any type whose name ends in `Id` and is used as a field or identity is generated as a strongly-typed ID
value object — even when no entity declares it via `identified by`. So a field `customer: CustomerId`
pulls a `CustomerId.cs` into existence whether or not `Customer` is in the same context.

By default an ID wraps a `Guid` and gets a `New()` factory:

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

The file is named after the **ID type**, not the entity: `entity Order identified by OrderId` emits
`OrderId.cs`. Other identity strategies (`as natural(String)`, `as natural(Int)`, `as sequence`) change
the wrapped primitive and drop `New()` — see [entities & identity](/Koine/reference/entities-and-identity/).

## Deterministic and idempotent

Codegen is **deterministic**: the same model always produces byte-identical output. File names, member
order, and the set of runtime markers are a pure function of the model, so regenerating into the same
folder is a no-op unless the model changed. That makes the generated tree safe to commit and easy to
diff in code review — a meaningful diff means a meaningful model change.

In directory mode (`koine build ./domain`) every `.koi` file under the folder is read in a stable order
and merged into one model, so multi-file domains are just as reproducible as single-file ones.

## The type mapping

Primitive Koine types map to their natural C# counterparts:

| Koine | C# | Notes |
|-------|-----|-------|
| `String` | `string` | |
| `Int` | `int` | |
| `Decimal` | `decimal` | money / quantities |
| `Bool` | `bool` | |
| `Instant` | `DateTimeOffset` | |
| `List<T>` | `IReadOnlyList<T>` | defensively copied in the constructor |
| `Range<T>` | `Range<T>` | the `Koine.Runtime` interval value object |
| `<XId>` | a generated ID value object | a `ValueObject` wrapping a `Guid` by default |

:::tip
`List<T>` becomes the **read-only** `IReadOnlyList<T>` in public surfaces and is copied in the
constructor, so a value object or entity can't be mutated through a shared list reference. This is part
of why the output is safe to expose directly from your application layer.
:::

## A value object, before and after

Here is the `Email` value object from the demo's Customers context — first the `.koi` source:

```koine
context Customers {

  value Email {
    raw:        String
    normalized: String = raw.trim.lower
    invariant raw.trim.length > 0                    "an email cannot be blank"
    invariant raw matches /^[^@]+@[^@]+\.[^@]+$/      "invalid email address"
  }
}
```

…and the C# Koine emits to `Customers/Email.cs`:

```csharp
// <auto-generated/>
#nullable enable

using System.Collections.Generic;
using System.Text.RegularExpressions;
using Koine.Runtime;

namespace Customers;

public sealed class Email : ValueObject
{
    public string Raw { get; }

    public Email(string raw)
    {
        if (!(raw.Trim().Length > 0))
            throw new DomainInvariantViolationException(
                type: nameof(Email),
                rule: "an email cannot be blank");

        if (!Regex.IsMatch(raw, @"^[^@]+@[^@]+\.[^@]+$", RegexOptions.None, TimeSpan.FromMilliseconds(1000)))
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

Reading it back against the source:

- The file opens with an `// <auto-generated/>` marker and `#nullable enable`, then a precise `using`
  set — only the namespaces actually referenced.
- `value` becomes a `sealed class : ValueObject`; the field `raw: String` becomes a get-only `Raw`
  property and a constructor parameter.
- Each `invariant` becomes a guard at the top of the constructor that throws
  `DomainInvariantViolationException` before the object is assigned — an invalid `Email` can never exist.
- The `matches /…/` regex invariant compiles to `Regex.IsMatch`.
- The derived field `normalized: String = raw.trim.lower` (it references another field) becomes a
  computed get-only property `Normalized`, **not** a constructor parameter.
- Equality is by value: `GetEqualityComponents` yields the identity-defining fields, and the
  `ValueObject` base supplies `Equals`, `GetHashCode`, and `==`/`!=`.

## Where to go next

- [Value objects](/Koine/reference/value-objects/) — invariants, derived fields, and quantities in depth.
- [Entities & identity](/Koine/reference/entities-and-identity/) — identity strategies and `*Id` types.
- [Repositories & concurrency](/Koine/reference/repositories-concurrency/) — repository contracts and `versioned` aggregates.
- [The CLI](/Koine/guides/cli/) — `build` / `check` and the `--target` / `--out` flags.
