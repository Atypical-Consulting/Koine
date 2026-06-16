---
title: "6 · Evolving a model"
description: "Version contexts, annotate evolution, and check backward compatibility."
---

Models do not stand still. New fields appear, old ones get superseded, and once a context
*publishes* a language to other teams, you cannot break it on a whim. This final tutorial part
shows the four tools Koine gives you for evolving a model safely:

1. `version N` to stamp a context with its current schema version.
2. `@since(n)` to record when a type or field was introduced.
3. `@deprecated("reason")` to fade a member out — it becomes `[Obsolete]` in the emitted C#.
4. `koine check --baseline` to diff your model against a previously published one and fail the
   build on a breaking change.

Everything here is real, compiling Koine. The breaking-change examples come straight from
`examples/versioning/` in the repo.

## Stamp a context with a version

Put `version <Int>` between the context name and its `{`:

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

The version is **metadata only** — a versioned context emits byte-identical C# to an unversioned
one. It does two things: it shows up in the generated glossary heading, and it sets the ceiling
for the `@since` check below.

:::note
`version` is the context-clause keyword; `versioned` is the unrelated optimistic-concurrency
marker on an aggregate (see [entities and aggregates](/Koine/tutorials/entities-and-aggregates/)).
Different words — don't mix them up.
:::

## Annotate when things appeared: `@since(n)`

When you add a field in a later version, record it with `@since(n)`. The annotation goes right
before the member:

```koine
context Catalog version 2 {
  aggregate Product root Product {
    entity Product identified by Sku as natural(String) {
      name:        String
      description: String?

      // A field introduced in v2 of the context.
      @since(2) barcode: String?
    }
  }
}
```

`@since` emits **no C# attribute** — like `version`, it is glossary metadata. In the glossary the
field heading gains a `since v2` suffix, so a reader can see exactly which version introduced it.
`@since` works on type declarations too — it goes before the declaration keyword:

```koine
@since(2) value GiftWrap { message: String }
```

:::caution KOI1501 — annotation above the context version
A `@since(n)` whose `n` is **greater** than the context's declared `version N` is a coded warning
(`KOI1501`, `AnnotationVersionAboveContext`) — it names a future version the context hasn't
reached. Keep every `@since(n)` at or below the context version. An *unversioned* context never
warns, regardless of `@since` values.
:::

## Fade a member out: `@deprecated("reason")`

When a member is on its way out but you can't remove it yet (downstream code still reads it),
mark it with `@deprecated("reason")`:

```koine
context Sales {
  value Money {
    amount: Decimal
    @deprecated("use amount") legacyAmount: Decimal
  }
}
```

Unlike `version` and `@since`, **`@deprecated` does reach the C#**: it renders as `[Obsolete]` on
the generated property, and Koine injects `using System;` into that file:

```csharp
[Obsolete("use amount")]
public decimal LegacyAmount { get; init; }
```

It works on whole types as well — the attribute lands on the class, on its own line:

```koine
@deprecated("use Money") value OldMoney { amount: Decimal }
```

```csharp
[Obsolete("use Money")]
public sealed class OldMoney
```

This works on every published-language declaration too — `value`, `entity`, `enum`, `aggregate`,
`event`, and `integration event`, plus their fields. Quotes inside the reason are escaped for C#
automatically.

:::tip
`version`, `since`, and `deprecated` are **not** reserved — only the `@` form is an annotation,
so `value Tag { version: Int  since: Int  deprecated: String }` is a perfectly valid value object
with three ordinary fields.
:::

## Check backward compatibility against a baseline

Annotations document evolution. The `koine check` command *enforces* it. Point it at a previously
published copy of your model and it diffs the **published surfaces** — integration events,
shared-kernel types, and open-host value objects — failing the build on any breaking change.

Here are two versions of the same published contract. `examples/versioning/v1`:

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

And the evolved `examples/versioning/v2` — it adds an optional `note` and removes `coupon`:

```koine
context Sales version 2 {

  integration event OrderPlaced {
    orderId: OrderId
    total:   Decimal
    // coupon removed   -> BREAKING (PublishedFieldRemoved)
    @since(2) note: String?     // added optional field -> backward-compatible
  }

  publishes OrderPlaced
}
```

Run the check (both the current model and the baseline can be a file or a directory):

```bash
koine check examples/versioning/v2 --baseline examples/versioning/v1
```

```text
breaking KOI1511: field 'coupon' of published integration event 'OrderPlaced' was removed.
non-breaking: field 'note' of published integration event 'OrderPlaced' was added.
error: 1 breaking change(s) to published surfaces
```

The command exits non-zero, so it fails CI. Adding the optional `note` is reported as
non-breaking; removing the published `coupon` is the breaking change that stops the build. Restore
`coupon` (or make `note` the only change) and `koine check` prints `OK: no breaking changes to
published surfaces` and exits zero.

### What counts as breaking

The check operates purely on the target-agnostic model, so the same rules will protect any future
emitter. Each breaking change carries a `KOI` code:

| Change | Code | Verdict |
| --- | --- | --- |
| Remove a published type | `KOI1510` | Breaking |
| Remove a published field (or enum value) | `KOI1511` | Breaking |
| Change a published field's type | `KOI1512` | Breaking |
| Make an optional published field required (`T?` → `T`) | `KOI1513` | Breaking |
| Add a **required** field to a published type | `KOI1514` | Breaking |
| Add an **optional** field (`T?`) | — | Non-breaking |
| Add a new event or enum value | — | Non-breaking |
| Any change to an internal (non-published) type | — | Ignored |

:::note
A field is optional when its type ends in `?` (`note: String?`); without the suffix it's
required. Only **published** surfaces are diffed — a plain value object in a context with no
shared-kernel or open-host relation can change freely.
:::

## What makes a surface "published"

`koine check` only cares about three things:

- **Integration events** declared with `publishes <Name>` and an `integration event` block.
- **Shared-kernel** types listed in a context-map relation:
  `Sales <-> Billing : shared-kernel { Money }`.
- **Open-host** value objects exposed by a directional relation:
  `Sales -> Shipping : open-host`.

Everything else is internal and invisible to the check — exactly the contracts you'd want a CI gate
to guard, and nothing more.

## You've finished the tutorial

That's the full arc: from a single value object to a versioned, multi-context model with an
enforced compatibility gate. From here:

- Browse the [reference](/Koine/reference/overview/) for the precise grammar of every construct, starting
  with [versioning & evolution](/Koine/reference/versioning/) for everything on this page.
- See the [feature catalogue](/Koine/guides/feature-catalogue/) for the complete R1–R15 list.
- Revisit [reading the output](/Koine/start/reading-the-output/) to map each construct to its
  emitted C#.

Happy modeling.
