---
title: "Contexts & types"
description: "The context block, the type families, fields, defaults and derived members."
---

A `.koi` file is a list of bounded `context` blocks. Inside a context you declare the *types* of
your domain — value objects, entities, aggregates, enums, events, services, read models, and more.
This page is the ground-floor reference: the `context` block itself, the full menu of type families,
and the three field forms (`name: Type`, defaults, derived members) that appear in every body.

For the constructs that build *on top of* these — factories, commands, specs, repositories, the
context map — see the dedicated reference pages linked throughout.

## The `context` block

A context is a bounded context: one ubiquitous language, one namespace.

```koine
context Ordering {
  value Money { amount: Decimal  currency: Currency }
  enum Currency { EUR, USD, GBP }
}
```

Each `context Name { … }` compiles to exactly **one C# namespace** of the same name, with each
declared type emitted into its own file under a `Name/` folder (`Ordering/Money.cs`,
`Ordering/Currency.cs`, …).

A context name carries no equality or identity of its own — it is purely a grouping and a namespace.
The same context name may appear in several `.koi` files; in a directory build they **merge** into one
namespace, so a context split across files needs no imports for its own types. See
[multi-file & modules](/Koine/reference/multi-file-imports-modules/).

### Version clause

A context may carry an optional `version N` between its name and the `{`:

```koine
context Ordering version 1 {
  // …
}
```

The version is **metadata only** — it does not change the emitted C# at all (a versioned context emits
byte-identical code to an unversioned one). It surfaces in the generated glossary heading and feeds the
`@since` ceiling check (see [versioning](/Koine/reference/versioning/)). The literal is a bare integer;
omit the clause entirely for an unversioned context.

:::note
`version` (the context clause) and `versioned` (the aggregate concurrency marker) are different
keywords. The lexer prefers the longer `versioned`, so the two never collide.
:::

## The type families

Everything you declare inside a context is one of these families. The table is the quick map; each row
links to (or is detailed by) a fuller treatment.

| Declaration | Emits | Reference |
|-------------|-------|-----------|
| `value X { … }` | `sealed record` — get-only props, validating constructor, value equality | [value objects](/Koine/reference/value-objects/) |
| `quantity X { … }` | a value object with a `Decimal` amount + enum unit and unit-checked `+ - * /` | [value objects](/Koine/reference/value-objects/) |
| `entity X identified by XId { … }` | `sealed class` with identity-only equality + a generated `XId` value object | [entities & identity](/Koine/reference/entities-and-identity/) |
| `aggregate A root R { … }` | nested types; root `R` implements `IAggregateRoot`; an `I<R>Repository` contract | [aggregates](/Koine/reference/aggregates/) |
| `enum E { … }` | a self-contained **smart enum** (`sealed class`, `All`/`FromName`/`FromValue`, value equality) | [enums](/Koine/reference/enums/) |
| `event E { … }` | a domain-event record recorded into the aggregate's `DomainEvents` | [commands, events & state](/Koine/reference/commands-events-state/) |
| `integration event E { … }` | `sealed record : IIntegrationEvent` — a published, cross-boundary contract | [context maps & integration](/Koine/reference/context-maps-integration/) |
| `readmodel M from Src { … }` | a flat, value-equal DTO `record` + a static `ToM(this Src)` projection mapper | [application & CQRS](/Koine/reference/application-cqrs/) |
| `query Q(criteria): List<M>` | a query DTO `record` handled via the shared generic `IQueryHandler<TQuery,TResult>` | [application & CQRS](/Koine/reference/application-cqrs/) |
| `service S { … }` | an application interface `IS` (use cases) and/or a domain class `S` (operations) | [specs, services & policies](/Koine/reference/specs-services-policies/) |
| `spec Name on T = expr` | a reusable named boolean predicate over `T`, referenceable by name | [specs, services & policies](/Koine/reference/specs-services-policies/) |
| `policy Name when E then T.cmd(…)` | a handler interface + an abstract seam for a cross-aggregate reaction | [specs, services & policies](/Koine/reference/specs-services-policies/) |
| `module M { … }` | groups types into a `<Context>.<Module>` sub-namespace and folder | [multi-file & modules](/Koine/reference/multi-file-imports-modules/) |
| `import Ctx.{ T }` / `import Ctx.*` | a precise cross-context reference, emitting a tidy `using` | [multi-file & modules](/Koine/reference/multi-file-imports-modules/) |

A handful of these are **context-level only** (`service`, `readmodel`, `query`, `spec`, `policy`,
`import`, `module`, `integration event`, the context-map `publishes`/`subscribes`). The tactical
families — `value`, `quantity`, `entity`, `enum`, `event` — also live happily inside an `aggregate`
or `module` body.

:::tip
`List`, `Set`, `Map`, and `Range` are **reserved built-in generic type names**. You cannot declare a
`value`/`entity`/`enum` with one of those names; you use them as wrappers in field types
(`lines: List<OrderLine>`, `tags: Set<String>`, `window: Range<Instant>`).
:::

## Fields

A type body is a whitespace-separated list of members. (Commas between members are optional and
conventionally omitted everywhere except enum member lists.) Every member takes one of three forms.

### Plain field — `name: Type`

The workhorse: a typed, get-only property plus a matching constructor parameter.

```koine
value Money {
  amount:   Decimal
  currency: Currency
}
```

A trailing `?` makes the field **optional** (a nullable type in C#); `List<T>` / `Set<T>` collect:

```koine
entity Product identified by ProductCode as natural(String) {
  name:        String
  description: String?          // optional
  tags:        Set<String>      // a uniqueness set
}
```

### Default — `name: Type = const`

A constant after `=` becomes a constructor parameter with a default value:

```koine
entity Order identified by OrderId {
  status: OrderStatus = Draft   // default value
}
```

The right-hand side is a literal or a bare enum member. (An enum default is emitted as a nullable
parameter coalesced to the smart-enum instance, since a smart-enum value isn't a compile-time constant.)

### Derived — `name: Type = expr`

When the `=` right-hand side references **other members** of the same type, the field is a *derived*
(computed) get-only property — it is **not** a constructor parameter:

```koine
value OrderLine {
  product:   ProductId
  quantity:  Int
  unitPrice: Money
  lineTotal: Money = unitPrice * quantity                          // derived
  payable:   Money = if quantity >= 10 then lineTotal * 0.9 else lineTotal
}
```

Derived members use the [expression sublanguage](/Koine/reference/expressions/): arithmetic,
comparisons, `&&`/`||`/`!`, member access (`name.trim`, `lines.count`), coalescing (`description ?? name`),
presence checks (`sale.isPresent`), collection ops (`lines.sum(l => l.payable)`), and the `if … then …
else …` form. They may reference plain fields and other derived fields.

:::note
The distinction between a *default* and a *derived* field is purely whether the `= expr` references
sibling members. `status: OrderStatus = Draft` is a default (a literal); `total: Money = lines.sum(…)`
is derived (it reads `lines`).
:::

## Invariants

A type body may also carry `invariant` guards, which become constructor checks that throw
`DomainInvariantViolationException`:

```koine
value Price {
  amount:   Decimal
  currency: Currency
  invariant amount >= 0                          "a price cannot be negative"
}

value Sku {
  code: String
  invariant code matches /^[A-Z]{3}-[0-9]{4}$/   "SKU must look like ABC-1234"
}
```

`invariant` and `matches` are the two **fully reserved** keywords — unlike the type-family keywords,
they can never be used as field names. The full invariant repertoire (regex, `when` conditions, named
specs) is covered under [value objects](/Koine/reference/value-objects/),
[invariants](/Koine/reference/invariants/) and
[specs, services & policies](/Koine/reference/specs-services-policies/).

## Doc comments

Koine has two comment forms:

```koine
// A line comment — ignored entirely.

/// A doc comment — captured and surfaced in the generated glossary
/// and carried through as a /// XML summary on the emitted member.
value Money {
  amount: Decimal
  /// How many minor units; never negative.
  decimals: Int
}
```

`//` comments are dropped. `///` doc comments attach to the declaration or member that follows and
flow into both the glossary and the emitted C# `<summary>` documentation.

## Soft keywords

Most Koine keywords are **soft**: they are only keywords in the position where they introduce a
declaration, and remain usable as ordinary field names everywhere else. So this is valid:

```koine
context Inventory {
  value Tag {
    version:  Int
    since:    Int
    deprecated: String
    quantity: Int
    service:  Int
    query:    Int
  }
}
```

Soft keywords include `context`, `value`, `quantity`, `entity`, `aggregate`, `enum`, `event`,
`by`, `root`, `command`, `create`, `spec`, `on`, `service`, `operation`, `usecase`, `policy`,
`as`, `natural`, `sequence`, `guid`, `versioned`, `repository`, `operations`, `find`, `readmodel`,
`from`, `query`, `import`, `module`, `when`, `then`, `publishes`, `subscribes`, `integration`, `acl`,
`version`, `since`, `deprecated`, and more.

The exceptions:

- **`invariant` and `matches` are reserved** — never field names.
- **`List`, `Set`, `Map`, `Range`** are reserved *type* names (built-in generics).
- A handful of **hard-`Identifier` positions** — a type / command / state / enum-member name — must be
  plain identifiers and cannot reuse a declaration keyword.
- A `versioned` aggregate root cannot have a member literally named `version` (it collides with the
  synthesized `Version` property).

:::caution
The operators `<-` (factory initialization), `->` (state transition / context-map arrow), and `<->`
(bidirectional context-map relation) are **single atomic tokens** — keep their characters adjacent
(`status -> Submitted`, not `status - > Submitted`). Because `<-` is lexed before `<`, a comparison
against a negative literal needs a space: write `x < -1`, not `x<-1`.
:::

## Primitive type mapping

The built-in scalar and collection types map to C# as follows:

| Koine | C# | Notes |
|-------|----|-------|
| `String` | `string` | |
| `Int` | `int` | |
| `Decimal` | `decimal` | money / quantities |
| `Bool` | `bool` | |
| `Instant` | `DateTimeOffset` | |
| `List<T>` | `IReadOnlyList<T>` | defensively copied in the constructor |
| `Set<T>` | uniqueness set | |
| `Map<K,V>` | keyed map | |
| `Range<T>` | generated `Range<T>` value object | over an orderable `T`: `Int`, `Decimal`, `Instant` |
| `T?` | nullable `T` | an optional field |
| `<XId>` | generated ID value object | a record wrapping a `Guid` by default |

A `*Id` type name used as a field type (e.g. `ProductId`) is generated as an ID value object even when
no entity declares it via `identified by` — see [entities & identity](/Koine/reference/entities-and-identity/).
The orderable types (`Int`, `Decimal`, `Instant`) are exactly those usable in relational comparisons and
as `Range<T>` element types.

## A complete context

Putting the pieces together — types, fields, defaults, derived members, doc comments, and a version
clause:

```koine
/// Catalog bounded context — the products a shop sells.
context Catalog version 2 {

  enum Currency(symbol: String, decimals: Int) {
    EUR("€", 2)
    USD("$", 2)
    GBP("£", 2)
  }

  enum MassUnit { Gram, Kilogram }

  enum Availability { InStock, OutOfStock, Discontinued }

  /// A stock-keeping unit, validated by shape and normalized via string ops.
  value Sku {
    code:       String
    normalized: String = code.trim.upper             // derived
    invariant code.trim.length > 0                   "a SKU cannot be blank"
    invariant code matches /^[A-Z]{3}-[0-9]{4}$/      "SKU must look like ABC-1234"
  }

  value Price {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "a price cannot be negative"
  }

  /// A quantity value object: a Decimal amount plus an enum unit.
  quantity Weight {
    amount: Decimal
    unit:   MassUnit
    invariant amount >= 0   "a weight cannot be negative"
  }

  value SalePeriod {
    window: Range<Instant>
  }

  aggregate ProductCatalog root Product {

    entity Product identified by ProductCode as natural(String) {
      sku:          Sku
      name:         String
      price:        Price
      weight:       Weight
      availability: Availability = InStock     // default

      description:  String?                    // optional
      tags:         Set<String>
      sale:         SalePeriod?

      @since(2) barcode: String?               // added in v2 of the context

      displayName:  String = name.trim         // derived
      summary:      String = description ?? name
      isAvailable:  Bool   = availability == InStock
      onSale:       Bool   = sale.isPresent
    }
  }

  readmodel ProductCard from Product {
    sku
    name
    price
    available: Bool = availability == InStock
  }

  query ProductsByAvailability(availability: Availability): List<ProductCard>
  query ProductByCode(code: ProductCode): ProductCard
}
```

## Where to go next

- [Value objects](/Koine/reference/value-objects/) — invariants, quantities, `Range<T>`.
- [Entities & identity](/Koine/reference/entities-and-identity/) — `identified by` and the identity strategies.
- [Aggregates](/Koine/reference/aggregates/) — roots, repositories, versioning.
- [Enums](/Koine/reference/enums/) — smart enums and associated data.
- [Expressions](/Koine/reference/expressions/) — the derived-field and invariant sublanguage.
- [Multi-file & modules](/Koine/reference/multi-file-imports-modules/) — splitting and importing across contexts.
