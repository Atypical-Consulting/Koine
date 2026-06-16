---
title: "Versioning & evolution"
description: "Version-stamp contexts, annotate evolution, and check compatibility."
---

A bounded context is a contract. The moment another team subscribes to your integration
events or shares one of your kernel types, every change you make can quietly break them.
Koine makes that contract explicit: you stamp a context with a **version**, annotate when
members arrived (`@since`) or fell out of favour (`@deprecated`), and run
`koine check --baseline` to catch breaking changes **before** they ship.

This is epic R15. None of it changes your runtime behaviour — `version` and `@since` are
pure metadata that surface in the [glossary](/Koine/guides/cli/) and drive
diagnostics; only `@deprecated` emits anything to C# (an `[Obsolete]` attribute).

## Version-stamp a context

Add an optional `version <Int>` clause between the context name and its `{`:

```koine
context Catalog version 2 {
  enum Currency(symbol: String, decimals: Int) {
    EUR("€", 2)
    USD("$", 2)
  }
}
```

The literal is a bare integer (no parens). Omit the clause entirely for an unversioned
context. The version does **not** leak into the generated C# — `Catalog/Currency.cs` is
byte-for-byte identical whether or not you stamp a version. It only:

- becomes the glossary heading (`## Catalog — version 2`), and
- sets the ceiling for the `@since` check below.

:::note
`version` (the context clause) is distinct from `versioned` (the
[optimistic-concurrency marker](/Koine/reference/aggregates/) on an aggregate root). They
are different keywords; the lexer never confuses them.
:::

## Annotate evolution

### `@since(n)` — when a member or type arrived

`@since(n)` records the context version in which a declaration first appeared. It prefixes
the field name, or the declaration keyword for a whole type:

```koine
context Catalog version 2 {
  value Product {
    name:    String
    price:   Decimal
    // A field introduced in v2 of the context.
    @since(2) barcode: String?
  }

  // A whole type added in v2.
  @since(2) value Promotion { code: String }
}
```

`@since` emits **no** C# attribute. It sets the declaration's `Since` metadata, which the
glossary renders as a suffix on the member or type:

| Member | Type | |
| --- | --- | --- |
| barcode | `String?` | _(since v2)_ |

#### The `@since` ceiling check (KOI1501)

A `@since(n)` whose `n` is **greater than** the context's declared `version` is almost
always a typo — you are claiming a member arrived in a version that does not exist yet.
Koine warns:

```koine
context Sales version 1 {
  value Money {
    amount: Decimal
    @since(5) bonus: Decimal   // KOI1501: @since(5) > version 1
  }
}
```

```
sales.koi:4:5: warning KOI1501: Field 'bonus' is annotated @since(5) but context 'Sales' is only version 1.
```

The message names the exact member and the mismatched versions. A type-level `@since` above
the ceiling warns the same way (`'Promotion' is annotated @since(7) but context 'Catalog' is
only version 2.`).

:::tip
An **unversioned** context never warns, whatever `@since` values you use — there is no
ceiling to exceed. Stamp the context with a `version` to switch the check on, and keep all
`@since(n)` at or below it to stay clean.
:::

### `@deprecated("reason")` — mark something obsolete

`@deprecated` is the one annotation that reaches C#. It prefixes a field or a type and
renders as `[Obsolete]`:

```koine
context Sales {
  value Money {
    amount: Decimal
    @deprecated("use amount") legacyAmount: Decimal
  }

  @deprecated("use Money") value OldMoney { amount: Decimal }
}
```

emits, on the property and the class respectively:

```csharp
[Obsolete("use amount")]
public decimal LegacyAmount { get; }
```

```csharp
[Obsolete("use Money")]
public sealed class OldMoney { /* ... */ }
```

The compiler injects `using System;` into any file that gains an `[Obsolete]`, and
C#-escapes quotes in the reason. A model with no `@deprecated` annotations gets neither the
attribute nor the extra using. `@deprecated` works on every published shape too —
including [integration-event](/Koine/reference/context-maps-integration/) fields:

```koine
context Sales {
  publishes OrderPlaced
  integration event OrderPlaced {
    orderId: OrderId
    total:   Decimal
    @deprecated("use total") legacyAmount: Decimal
  }
}
```

:::note
`version`, `since`, and `deprecated` are **not** reserved — only `@` + identifier forms an
annotation, so `value Tag { version: Int  since: Int  deprecated: String }` is a perfectly
valid record with three ordinary fields. Annotation names other than `since`/`deprecated`
(and arg types other than the expected `Int`/`String`) are silently ignored.
:::

## Check backward compatibility against a baseline

Annotations document intent; `koine check` enforces it. Point it at your current model and
a previously published baseline directory, and it diffs the two models' **published
surfaces** and exits non-zero on any breaking change:

```bash
koine check ./current --baseline ./published
```

Both arguments may be a single `.koi` file or a directory (a directory compiles every
`.koi` under it as one model). Three kinds of surface are compared — everything else
(internal value objects, entities, aggregates) is ignored:

| Published surface | How it becomes published |
| --- | --- |
| Integration events | `publishes <Name>` + `integration event <Name> { … }` |
| Shared-kernel types | a `shared-kernel { T … }` relation in the [context map](/Koine/reference/context-maps-integration/) |
| Open-host value objects | an `open-host` / `published-language` relation where the context is upstream |

### Breaking vs non-breaking

The diff classifies each change. A breaking change carries a KOI code and fails the build;
additive changes are reported as informational and pass.

| Change | Verdict | Code |
| --- | --- | --- |
| Published type removed | **breaking** | KOI1510 |
| Published field removed (or enum value removed) | **breaking** | KOI1511 |
| Published field's type changed | **breaking** | KOI1512 |
| Optional field made required (`T?` → `T`) | **breaking** | KOI1513 |
| New **required** field added | **breaking** | KOI1514 |
| New **optional** field added (`T?`) | non-breaking | — |
| New event / new type added | non-breaking | — |
| New enum value added | non-breaking | — |

Optionality is the `?` type suffix: `note: String?` is optional and additive; `note: String`
is required.

### A worked example

Take a v1 baseline that publishes an order-placed contract:

```koine
context Sales version 1 {
  integration event OrderPlaced {
    orderId: OrderId
    total:   Decimal
    coupon:  String
  }
  publishes OrderPlaced
}
```

Evolve it to v2: add an optional `note` (fine) but drop `coupon` (not fine):

```koine
context Sales version 2 {
  integration event OrderPlaced {
    orderId: OrderId
    total:   Decimal
    // coupon removed  ->  BREAKING
    @since(2) note: String?   // added optional field  ->  backward-compatible
  }
  publishes OrderPlaced
}
```

Running the check reports both changes and fails on the removal:

```bash
koine check examples/versioning/v2 --baseline examples/versioning/v1
```

```
breaking KOI1511: field 'coupon' of published integration event 'OrderPlaced' was removed.
non-breaking: field 'note' of published integration event 'OrderPlaced' was added.
error: 1 breaking change(s) to published surfaces
```

Reverse the comparison — i.e. treat v2 as the baseline and v1 as the new model — and you
see the mirror image: re-adding `coupon` as a required field is `KOI1514`, and dropping the
optional `note` is `KOI1511`.

:::tip
Wire `koine check <model> --baseline <last-release>` into CI. Keep the previous release's
`.koi` sources in a directory (or git tag) and any accidental contract break fails the
pipeline with an exact, line-addressable KOI code.
:::

### Publishing a surface via the context map

A field change is only breaking if the type is actually published. An integration event
declared with `publishes` is published by definition. To put a **value object** under the
same scrutiny, give it a published relation in the [context map](/Koine/reference/context-maps-integration/):

```koine
context Sales {
  value Money { amount: Decimal  currency: String }
}
context Billing { }
contextmap {
  // Money is now a shared-kernel contract owned with Billing.
  Sales <-> Billing : shared-kernel { Money }
}
```

Now removing `Money.currency`, changing its type, or making an optional field required all
become breaking changes that `koine check` will catch. An `open-host` relation
(`Sales -> Shipping : open-host`) publishes Sales' value objects the same way.

:::caution
Mind the operators: `<->` (bidirectional / shared-kernel) and `->` (directional /
open-host) are single atomic tokens — never split them as `< - >`. The hyphen in
`shared-kernel` and `open-host` is literal, part of the role name, not subtraction.
:::

## Related pages

- [Context maps & integration events](/Koine/reference/context-maps-integration/) — the published surfaces: integration events, shared-kernel, and open-host relations.
- [Evolving a model](/Koine/tutorials/evolving-a-model/) — a step-by-step walkthrough of versioning a context and running the baseline check.
- [CLI reference](/Koine/guides/cli/) — full `koine build` and `koine check` flags, plus the `--glossary` output where `version`, `@since`, and `@deprecated` surface for humans.
