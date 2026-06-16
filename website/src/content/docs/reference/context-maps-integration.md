---
title: "Context maps & integration events"
description: "The strategic map - typed relationships, shared kernel, ACL, and pub/sub."
---

A single `.koi` model usually holds several bounded contexts. The **context map** is the
strategic layer that sits *between* them: a top-level `contextmap { ... }` block that names how
each context relates to its neighbours. From those typed relationships Koine decides which
cross-context references are allowed, where shared types live, which translator interfaces to
emit, and which subscriptions are authorized.

This page covers the map itself, the seven relationship roles, the `shared-kernel` and
`anti-corruption-layer` blocks, and the `integration event` / `publishes` / `subscribes`
pub/sub seams.

## The map block

`contextmap` is a **top-level declaration** - a sibling of `context`, never nested inside one.
Both endpoints of every relation must be contexts you have actually declared.

```koine
context Catalog { value Sku { code: String } }
context Sales   { value Quote { n: Int } }

contextmap {
  Catalog -> Sales : conformist
}
```

Each line is one relation: an upstream context, an arrow, a downstream context, a colon, and a
role. Use `->` for a directed relation (upstream on the left, downstream on the right) and
`<->` for a bidirectional one:

```koine
contextmap {
  Catalog <-> Sales : partnership
}
```

:::caution
The arrows `->` and `<->` are single tokens. Keep spaces *around* them (`A -> B`) but never
*inside* them - write `<->`, not `< - >`. The role names are single hyphenated tokens too, so
write `shared-kernel`, never `shared - kernel`.
:::

The map emits no C# type of its own - it *drives* validation and downstream emission. A few
ground rules the compiler enforces:

| Situation | Result |
| --- | --- |
| Endpoint is not a declared context | `ContextMapUnknownContext` |
| A context related to itself (`A -> A`) | `SelfRelation` |
| The same pair declared twice (order-insensitive for `<->`) | `DuplicateContextRelation` |

In **directory mode** (`koine build <dir>`) every `.koi` file compiles as one model, so the
map can live in its own `map.koi` file and still name contexts declared elsewhere. Multiple
`contextmap` blocks - even across files - merge deterministically into one map.

## The seven roles

Every relation carries exactly one of the seven classic strategic DDD roles. Each spelled as a
single token:

| Role | What it does in Koine |
| --- | --- |
| `partnership` | Two contexts succeed or fail together. Documentary; no auto-permit. |
| `shared-kernel` | The pair jointly owns a small set of types (see below). Auto-permits references to the shared types. |
| `customer-supplier` | Upstream supplies, downstream consumes. **Authorizes** subscriptions; does *not* auto-permit direct references (import the type). |
| `conformist` | Downstream conforms to upstream's model. **Auto-permits** a direct reference to upstream types. |
| `anti-corruption-layer` | Downstream shields itself behind a translator (see below). |
| `open-host` | Upstream publishes a service for anyone. **Authorizes** subscriptions. |
| `published-language` | Upstream commits to a stable contract. Documentary. |

Two of these change how cross-context **references** resolve. With a `conformist` (or
`shared-kernel`) relation, the downstream context can name an upstream type directly and the
emitted file gets a precise `using` automatically - no `import` needed:

```koine
context Catalog { value Sku { code: String } }
context Sales   { value Quote { sku: Sku } }

contextmap { Catalog -> Sales : conformist }
```

`Sales/Quote.cs` is emitted with `using Catalog;` and compiles. Remove the relation and the same
field becomes an `UnimportedReference` error.

:::tip
`customer-supplier` and unrelated contexts do **not** auto-permit a direct reference. When you
need a neighbour's type across one of those, pull it in explicitly with a named import -
`import Customers.{ PostalAddress }` - which is exactly what the Shop demo's `Shipping` context
does. See [imports & cross-context references](/Koine/reference/multi-file-imports-modules/) for
the import syntax.
:::

Three roles **authorize** subscriptions: `open-host` and `customer-supplier` let a downstream
context subscribe to an upstream context's published events. `conformist` does *not* - a
`subscribes` over a conformist relation is a `SubscribeNoRelation` error.

## Shared kernel

A `shared-kernel` relation can carry a brace-separated list of the types the two contexts
*jointly own*. Each shared type is emitted **once**, into a dedicated kernel namespace, instead
of being duplicated into both contexts:

```koine
context Sales {
  value Money { amount: Decimal }
  value Quote { price: Money }
}
context Shipping {
  value Label { cost: Money }
}

contextmap {
  Sales <-> Shipping : shared-kernel { Money }
}
```

`Money` lands in `Sales__Shipping/Kernel/Money.cs` under `namespace Sales__Shipping.Kernel;` -
and every partner file that references it (`Sales/Quote.cs`, `Shipping/Label.cs`) gets a precise
`using Sales__Shipping.Kernel;`. The kernel namespace is **order-normalized**: the two context
names are joined alphabetically with a double underscore, so it is `Sales__Shipping` whether you
write `Sales <-> Shipping` or `Shipping <-> Sales`.

The block is `shared-kernel { TypeA, TypeB }` - a comma-separated type list (trailing comma
allowed). A few constraints:

- Only **value objects and enums** are shareable. Sharing an entity or aggregate is
  `SharedKernelNotShareable`.
- An unknown type in the block is `UnknownSharedKernelType`; the same type shared across two
  kernels is `SharedKernelTypeConflict`.
- Sharing an `*Id` (e.g. `OrderId`) is redundant - ids are already global and stay in their owner
  namespace rather than moving to the kernel.
- A non-partner context that references the shared type still needs an import (or it
  `UnimportedReference`s).
- Attaching a `{ ... }` type list to a non-kernel role parses, but reports
  `SharedTypesOnNonKernel`. Only put it on a `shared-kernel` relation.

## Anti-corruption layer

An `anti-corruption-layer` relation can carry an `acl { ... }` block that maps upstream types to
downstream types. Koine turns those mappings into a **translator interface** in the downstream
context - the seam where you write the corruption-shielding glue by hand:

```koine
context Legacy {
  value Account { reference: String }
  value Charge  { amount: Decimal }
}
context Billing {
  value Customer { name: String }
  value Invoice  { total: Decimal }
}

contextmap {
  Legacy -> Billing : anti-corruption-layer
    acl { Legacy.Account -> Billing.Customer
          Legacy.Charge  -> Billing.Invoice }
}
```

This emits `Billing/ILegacyToBillingTranslator.cs`:

```csharp
namespace Billing;

public interface ILegacyToBillingTranslator
{
    Billing.Customer Translate(Legacy.Account source);
    Billing.Invoice Translate(Legacy.Charge source);
}
```

The interface is named `I<Upstream>To<Downstream>Translator`, lives in the downstream namespace,
and gets one fully-qualified `Translate` method per mapping. Notes:

- Each mapping is `Context.Type -> Context.Type` - both sides must be dotted (fully qualified).
- The source side must be an upstream type and the destination a downstream type, or it
  reports `AclMappingType`.
- The `acl { }` block only belongs on an `anti-corruption-layer` role (`AclOnNonAclRole`
  otherwise), and an ACL relation with **no** block emits no translator.
- Referencing an upstream type *directly* over an ACL relation is allowed but emits an
  `AclDirectUpstreamReference` **warning** - the point of an ACL is to translate, not to reach
  through.

## Integration events: the published language

Domain events stay inside their aggregate; an **integration event** is the cross-boundary
contract a context broadcasts to the rest of the system. Declare one with the two-word keyword
`integration event`:

```koine
context Sales {
  integration event OrderPlaced {
    orderId:  OrderId
    total:    Decimal
    placedAt: Instant
  }
}
```

This emits a `sealed record` carrying the runtime marker `IIntegrationEvent`:

```csharp
using Koine.Runtime;

namespace Sales;

public sealed record OrderPlaced : IIntegrationEvent
{
    public OrderId OrderId { get; }
    public decimal Total { get; }
    public DateTimeOffset PlacedAt { get; }
    public DateTimeOffset OccurredOn { get; init; } = DateTimeOffset.UtcNow;
    // constructor sets each field
}
```

The `Koine.Runtime.IIntegrationEvent` marker file is emitted only when at least one integration
event exists.

:::caution Fields stay primitive
An integration event is a *published language* - its fields must be cross-boundary-safe so the
contract never leaks your internal model. Allowed types: primitives (`String`, `Decimal`,
`Int`), enums, `*Id` ids, other integration events, and `List<T>` of those. Referencing a value
object, entity, or domain event is `IntegrationEventLeaksInternals` (KOI1409). Use `List<T>` for
collections - `List` is a built-in generic.
:::

## Publish and subscribe

A context that owns an event declares `publishes <Event>`; a downstream context subscribes with
`subscribes <Publisher>.<Event>`. Together with an authorizing relation, this is the full
pub/sub triple:

```koine
context Sales {
  publishes OrderPlaced
  integration event OrderPlaced {
    orderId:  OrderId
    total:    Decimal
    placedAt: Instant
  }
}

context Shipping {
  subscribes Sales.OrderPlaced
}

contextmap {
  Sales -> Shipping : open-host
}
```

The subscriber gets a handler interface - the seam you implement to react to the event:

```csharp
using System.Threading;
using System.Threading.Tasks;
using Sales;

namespace Shipping;

public interface IHandleOrderPlaced
{
    Task Handle(Sales.OrderPlaced theEvent, CancellationToken ct = default);
}
```

The event type is **fully qualified** with the publisher's namespace; the subscriber never
re-emits the publisher's record. A publish-only context (one that only `publishes`) gets no
handler interface.

Note `publishes` may appear *before* the `integration event` it names - forward references are
fine. The rules the compiler checks:

| Statement | Requirement | Error if violated |
| --- | --- | --- |
| `publishes X` | `X` is an integration event in the same context | `UnknownPublishedEvent` |
| `subscribes P.X` | `P` is a known context | `SubscribeUnknownContext` |
| `subscribes P.X` | `P` actually `publishes X` | `SubscribeNotPublished` |
| `subscribes P.X` | An `open-host` or `customer-supplier` relation `P -> here` exists | `SubscribeNoRelation` |

:::note
With no context map at all, a `subscribes` is *not* flagged as a relation error - the authorizing
check only kicks in once a map exists. Subscribing twice is `DuplicateSubscribe`; subscribing to
two same-named events from different publishers is `SubscribeHandlerNameCollision`.
:::

## The Shop demo map

The Shop showcase wires all of this together across six contexts in a single `context-map.koi`:

```koine
contextmap {

  // Shared kernel: Catalog and Ordering jointly own the Currency enum.
  Catalog   <-> Ordering : shared-kernel { Currency }

  // Conformist: Shipping conforms to Catalog's published Weight.
  Catalog    -> Shipping : conformist

  // Customer-supplier: Customers supplies the PostalAddress Shipping imports.
  Customers  -> Shipping : customer-supplier

  // Open-host: Ordering publishes OrderPlaced; these authorize the subscriptions.
  Ordering   -> Shipping : open-host
  Ordering   -> Payments : open-host

  // Partnership: Shipping and Payments coordinate to fulfil an order.
  Shipping  <-> Payments : partnership

  // Anti-corruption layer: Payments translates the Legacy gateway's model.
  Legacy     -> Payments : anti-corruption-layer
    acl {
      Legacy.GatewayResult -> Payments.PaymentReceipt
    }
}
```

The `Ordering` context publishes the event and both downstream contexts subscribe:

```koine
context Ordering version 1 {
  integration event OrderPlaced {
    orderId:   OrderId
    customer:  CustomerId
    total:     Decimal
    placedAt:  Instant
  }
  publishes OrderPlaced
  // ...
}
```

From that one map, the compiler emits `Catalog__Ordering/Kernel/Currency.cs` (the shared
kernel), `Payments/ILegacyToPaymentsTranslator.cs` (the ACL translator), and an
`IHandleOrderPlaced.cs` handler seam in both `Shipping` and `Payments`.

## Related

- [Commands, events & state](/Koine/reference/commands-events-state/) - domain events, the in-context counterpart to integration events.
- [Multi-file, imports & modules](/Koine/reference/multi-file-imports-modules/) - the explicit cross-context reference path for non-permitting roles.
- [The CLI](/Koine/guides/cli/) - `koine build <dir>` directory mode that merges maps across files.
