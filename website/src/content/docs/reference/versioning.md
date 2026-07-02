---
title: "Versioning & evolution"
description: "Version-stamp contexts, annotate evolution, and check compatibility."
---

## 18.1 General

A bounded context is a contract. The moment another team subscribes to your integration
events or shares one of your kernel types, every change you make can quietly break them.
Koine makes that contract explicit: you stamp a context with a **version**, annotate when
members arrived (`@since`) or fell out of favour (`@deprecated`), and run
`koine check --baseline` to catch breaking changes **before** they ship.

This is Koine's model-versioning support. None of it changes your runtime behaviour — `version` and `@since` are
pure metadata that surface in the [glossary](/Koine/guides/cli/) and drive
diagnostics; only `@deprecated` emits anything to C# (an `[Obsolete]` attribute).

## 18.2 Syntax

Two grammar constructs carry versioning and evolution metadata: the optional `version`
clause on a context declaration, and the `annotation` prefix that may appear on any type or
field declaration.

```ebnf
context_decl
    : 'context' Identifier ( 'version' IntLiteral )? '{' context_member* '}'
    ;

annotation
    : AT Identifier ( '(' ( IntLiteral | StringLiteral ) ')' )?
    ;

type_decl
    : value_decl | quantity_decl | entity_decl | aggregate_decl
    | enum_decl | event_decl | integration_event_decl
    ;

value_declaration
    : annotation* 'value' Identifier '{' member* '}'
    ;

member
    : annotation* Identifier ':' type_ref ( '=' expression )?
    ;
```

The `version` clause is an optional `'version' IntLiteral` between the context name and its
opening brace. The integer is a bare, non-negative literal with no parentheses. Omitting the
clause leaves the context unversioned.

An `annotation` is a `@` sign followed by a bare identifier, with an optional single
argument in parentheses: an integer for `@since`, a string for `@deprecated`. Unknown
annotation names are silently ignored; only `since` and `deprecated` are acted on by the
compiler. Because `AT` (`@`) is the annotation prefix, `since` and `deprecated` are not
reserved as keywords — they may appear freely as field names.

`type_decl` is a bare dispatcher — it carries no `annotation*` of its own. Each individual
declaration rule (shown above for `value_declaration`; the same pattern applies to
`quantity_decl`, `entity_decl`, `aggregate_decl`, `enum_decl`, `event_decl`, and
`integration_event_decl`) begins with its own leading `annotation*` before the declaration
keyword. Likewise, a `member` rule carries its own leading `annotation*` before the field
name. This is where `@since` and `@deprecated` actually attach.

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

## 18.3 Semantics

### 18.3.1 Version stamp

The `version IntLiteral` clause sets the context's declared version. The version:

- becomes the glossary heading (`## Catalog — version 2`), and
- sets the ceiling for the `@since` ceiling check ([§18.3.2](#1832-since-ceiling-check-koi1501)).

The version does **not** leak into the generated C#. `Catalog/Currency.cs` is byte-for-byte
identical whether or not you stamp a version.

:::note
`version` (the context clause) is distinct from `versioned` (the
[optimistic-concurrency marker](/Koine/reference/aggregates/) on an aggregate root). They
are different keywords; the lexer never confuses them.
:::

### 18.3.2 `@since` ceiling check (KOI1501)

`@since(n)` records the context version in which a declaration first appeared. It may prefix
a field name or the declaration keyword for a whole type.

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

### 18.3.3 `@deprecated` semantics

`@deprecated("reason")` marks a field or type as obsolete. The reason argument is a string
literal. Unlike `@since`, `@deprecated` is not a pure-metadata annotation — it reaches the
emitter and produces a C# `[Obsolete]` attribute (see [§18.4](#184-translation-to-c)).

`@deprecated` works on every published shape too — including
[integration-event (§17)](/Koine/reference/context-maps-integration/) fields.

### 18.3.4 Annotation ignorance rule

`version`, `since`, and `deprecated` are **not** reserved — only `@` + identifier forms an
annotation, so `value Tag { version: Int  since: Int  deprecated: String }` is a perfectly
valid record with three ordinary fields. Annotation names other than `since`/`deprecated`
(and arg types other than the expected `Int`/`String`) are silently ignored.

## 18.4 Translation to C#

`@since(n)` emits **no** C# attribute. It sets the declaration's `Since` metadata, which the
glossary renders as a suffix on the member or type:

| Member | Type | |
| --- | --- | --- |
| barcode | `String?` | _(since v2)_ |

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
attribute nor the extra using.

`@deprecated` works on integration-event fields too:

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

## 18.5 Backward-compatibility checking

### 18.5.1 Overview

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
| Shared-kernel types | a `shared-kernel { T … }` relation in the [context map (§17)](/Koine/reference/context-maps-integration/) |
| Open-host value objects | an `open-host` / `published-language` relation where the context is upstream |

### 18.5.2 Breaking vs non-breaking changes

The diff classifies each change. A breaking change carries a KOI code and fails the build;
additive changes are reported as informational and pass.

| Change | Verdict | Code |
| --- | --- | --- |
| Published type removed | **breaking** | KOI1510 |
| Published **record** field removed | **breaking** | KOI1511 |
| Published field's type changed | **breaking** | KOI1512 |
| Optional field made required (`T?` → `T`) | **breaking** | KOI1513 |
| New **required** field added | **breaking** | KOI1514 |
| Published field renamed (same shape, new name) | **breaking** | KOI1515 |
| Published **enum value** removed | **breaking** | KOI1516 |
| Integration-event payload shape changed (a breaking add/remove/retype) | **breaking** | KOI1517 |
| New **optional** field added (`T?`) | non-breaking | — |
| New event / new type added | non-breaking | — |
| New enum value added | non-breaking | — |

Optionality is the `?` type suffix: `note: String?` is optional and additive; `note: String`
is required.

A **rename** (KOI1515) is detected when a removed field and an added field share the same shape
(type, ignoring nullability) and optionality — so `total: Decimal` → `amount: Decimal` reports a
single rename rather than a separate remove + add. An **integration event** is a wire contract, so
any breaking payload change additionally reports an event-level shape-change summary (KOI1517)
alongside the per-field code.

### 18.5.3 Per-rule severity (`koine.config`)

The default verdicts above are a policy, not a law. A `koine.config` can override the impact of any
code with a `check.severity.<CODE>` key — `Breaking`, `NonBreaking`, or `Ignored`:

```ini
# koine.config — relax the rename rule for this repo.
check.severity.KOI1515 = NonBreaking   # a rename no longer fails the gate
check.severity.KOI1512 = Ignored       # drop type-change reports entirely
```

`NonBreaking` downgrades a change so it no longer trips the exit code; `Ignored` drops it from the
report altogether; `Breaking` (re)promotes one. Codes with no override keep their default verdict.

### 18.5.4 A worked example

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

### 18.5.5 Publishing a surface via the context map

A field change is only breaking if the type is actually published. An integration event
declared with `publishes` is published by definition. To put a **value object** under the
same scrutiny, give it a published relation in the [context map (§17)](/Koine/reference/context-maps-integration/):

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

## See also

- [Context maps & integration events (§17)](/Koine/reference/context-maps-integration/) — the published surfaces: integration events, shared-kernel, and open-host relations.
- [Aggregates (§7)](/Koine/reference/aggregates/) — the `versioned` keyword for optimistic concurrency on an aggregate root, which is distinct from the context `version` clause.
- [Contexts & types (§4)](/Koine/reference/contexts-and-types/) — context declarations and their members.
- [Evolving a model](/Koine/tutorials/evolving-a-model/) — a step-by-step walkthrough of versioning a context and running the baseline check.
- [CLI reference](/Koine/guides/cli/) — full `koine build` and `koine check` flags, plus the `--glossary` output where `version`, `@since`, and `@deprecated` surface for humans.
