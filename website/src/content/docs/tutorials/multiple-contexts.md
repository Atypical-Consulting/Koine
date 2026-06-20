---
title: "5 · Many bounded contexts"
description: "Split a model across files, reference types across bounded contexts, and draw the context map that ties them together."
---

By [part 4](/Koine/tutorials/application-layer/) you had a complete Ordering context: an aggregate,
a unit of work, application services, read models and queries. Real systems aren't one context,
though — they're several, each owning its own language, meeting at well-defined seams.

This part splits the shop into **separate bounded contexts across separate files**, references types
**across** those contexts, and draws the **context map** that says how they relate. Koine doesn't just
record those relationships — it *enforces* them and *drives emission* from them.

## One model, many files

Point the compiler at a **directory** and every `.koi` under it compiles as a **single model**:

```bash
koine build ./models --out Generated
```

The CLI recurses for `*.koi` (in a deterministic order) and merges them before checking anything.
That has two consequences:

- **Same context, many files** — split a context across files freely; the types merge into one
  namespace and cross-reference each other with no ceremony.
- **The context map can name contexts from any file** — because the whole folder is one model, a map
  in `context-map.koi` can wire up contexts declared in `ordering.koi`, `shipping.koi`, and the rest.

Our shop has six contexts, one file each, plus the map:

```
Models/
├── catalog.koi       # Catalog   : products, prices, weights
├── customers.koi     # Customers : customers, addresses, loyalty
├── ordering.koi      # Ordering  : the Order aggregate
├── shipping.koi      # Shipping  : the Shipment aggregate
├── payments.koi      # Payments  : Payment + Ledger aggregates
├── legacy.koi        # Legacy    : an external gateway we don't control
└── context-map.koi   # the strategic map tying them together
```

## Reaching across contexts

A type in one context can't silently leak into another. If `Shipping` wants the `PostalAddress` value
object that `Customers` owns, you must say so — in one of three ways.

**Named import** — bring specific names in and use them unqualified:

```koine
context Shipping version 1 {
  import Customers.{ PostalAddress }

  // PostalAddress is now usable as-is
}
```

**Wildcard import** — `import Customers.*` brings in everything `Customers` exports.

**Fully-qualified reference** — skip the import and write `Customers.PostalAddress` inline.

The named import emits a precise `using Customers;` into the importing type's file; a qualified
reference emits the fully-qualified C# type and no `using`. Pick whichever reads best.

:::caution
Referencing a foreign context's type **without** an import, a qualifier, **or** a permitting context-map
relation is an error (`UnimportedReference`). Two wildcard imports that both export a `Money`, used
unqualified, is `AmbiguousReference`. The fix is always the same: a named import or a full qualifier.
:::

### Modules: sub-namespaces inside a context

Within a context, a `module` groups types into a sub-namespace **and** a sub-folder. Shipping nests its
aggregate inside `Fulfillment`:

```koine
context Shipping version 1 {
  import Customers.{ PostalAddress }

  module Fulfillment {
    aggregate Shipment root Shipment {
      entity Shipment identified by ShipmentId {
        order:       OrderId
        destination: PostalAddress
        weight:      Weight
        status:      ShipmentStatus = Pending
      }
    }
  }
}
```

`Shipment` now emits to `Shipping/Fulfillment/Shipment.cs` with `namespace Shipping.Fulfillment;`.
Identity types and the unit of work stay in the **base** namespace (`Shipping/ShipmentId.cs`,
`Shipping/IUnitOfWork.cs`), and the UoW references the module-qualified repository — exactly the
placement a hand-written DDD codebase would use.

## The context map

The strategic view is a **top-level `contextmap` block** — a sibling of `context`, never nested in one.
Each line names two contexts, an arrow, and a role:

```koine
contextmap {

  // Shared kernel: Catalog and Ordering jointly own Currency.
  Catalog   <-> Ordering : shared-kernel { Currency }

  // Conformist: Shipping conforms to Catalog's Weight (direct reference permitted).
  Catalog    -> Shipping : conformist

  // Customer–supplier: Customers (upstream) supplies the PostalAddress Shipping imports.
  Customers  -> Shipping : customer-supplier

  // Open-host: Ordering publishes OrderPlaced; this authorizes the subscriptions below.
  Ordering   -> Shipping : open-host
  Ordering   -> Payments : open-host

  // Partnership: Shipping and Payments coordinate to fulfil an order together.
  Shipping  <-> Payments : partnership

  // Anti-corruption layer: Payments translates the Legacy gateway's model into its own.
  Legacy     -> Payments : anti-corruption-layer
    acl {
      Legacy.GatewayResult -> Payments.PaymentReceipt
    }
}
```

The arrows are atomic tokens: `->` is directed (upstream `->` downstream), `<->` is bidirectional. The
seven roles are single hyphenated tokens — `shared-kernel`, `customer-supplier`, `open-host`,
`anti-corruption-layer`, `conformist`, `partnership`, `published-language` — so never put spaces around
the hyphens. A given pair of contexts may carry **one** relation: declaring two (even with different
roles or directions) is `DuplicateContextRelation`.

| Role | Meaning | What Koine does with it |
|------|---------|-------------------------|
| `shared-kernel` | Both contexts jointly own the listed types | Emits each shared type **once** into a kernel namespace both share |
| `conformist` | Downstream takes upstream's model as-is | **Permits** a direct cross-context reference (no import needed) |
| `customer-supplier` | Upstream supplies, downstream consumes | Documents the supply relationship; downstream still imports |
| `open-host` | Upstream offers a published language | **Authorizes** downstream `subscribes` to its integration events |
| `partnership` | Two contexts evolve together | Records a bidirectional coordination relationship |
| `anti-corruption-layer` | Downstream shields itself behind a translator | Emits a translator interface from the `acl { }` mappings |
| `published-language` | A formally shared interchange model | Records the published-language relationship |

### Shared kernel — emitted once

`Catalog <-> Ordering : shared-kernel { Currency }` means `Currency` belongs to **both** contexts, so
Koine emits it exactly once into a dedicated kernel namespace rather than duplicating it:

```csharp
namespace Catalog__Ordering.Kernel;

public sealed class Currency : IEquatable<Currency>
{
    public static readonly Currency EUR = new("EUR", 0, "€", 2);
    public static readonly Currency USD = new("USD", 1, "$", 2);
    // ...
}
```

Both partners get a precise `using Catalog__Ordering.Kernel;` wherever they touch `Currency`. The
namespace is the two context names joined by `__`, alphabetically.

### Anti-corruption layer — a generated translator

`Legacy` is an external gateway we don't control, so `Payments` never references its `GatewayResult`
directly. The `acl { }` block maps the legacy type onto a Payments type, and Koine emits a translator
interface in the **downstream** context:

```csharp
namespace Payments;

/// <summary>Anti-corruption translator from upstream context Legacy into Payments.</summary>
public interface ILegacyToPaymentsTranslator
{
    Payments.PaymentReceipt Translate(Legacy.GatewayResult source);
}
```

One `Translate` method per `acl` mapping, with fully-qualified types. You implement it; the legacy
model never crosses the boundary.

## Integration events: publish and subscribe

The map authorizes the *shape* of collaboration; **integration events** are the actual messages that
flow across it. Unlike domain events (which stay inside an aggregate), an integration event is a
**published language** — its fields stay primitive, never leaking internal value objects.

Ordering declares the event and publishes it:

```koine
context Ordering version 1 {

  integration event OrderPlaced {
    orderId:   OrderId
    customer:  CustomerId
    total:     Decimal
    placedAt:  Instant
  }

  publishes OrderPlaced

  // ...the Order aggregate
}
```

`OrderPlaced` emits a `sealed record OrderPlaced : IIntegrationEvent` carrying an `OccurredOn` stamp.
Subscribers react to it. Both `Shipping` and `Payments` subscribe, each authorized by their `open-host`
relation to Ordering:

```koine
context Shipping version 1 {
  subscribes Ordering.OrderPlaced
  // ...
}
```

That `subscribes` emits a **handler seam** in the subscriber — never a copy of the event:

```csharp
namespace Shipping;

public interface IHandleOrderPlaced
{
    Task Handle(Ordering.OrderPlaced theEvent, CancellationToken ct = default);
}
```

The event type is fully qualified back to its publisher (`Ordering.OrderPlaced`); the subscriber depends
on it but never redefines it. Implement `IHandleOrderPlaced` in `Shipping` and `Payments` to wire each
context's reaction.

:::note
A `subscribes` only compiles when the publisher actually `publishes` that event **and** a permitting
relation (`open-host` here) exists. The map and the events are checked together — wiring that the
strategic design didn't authorize won't build.
:::

## The resulting tree

Building the whole `Models/` folder in one pass produces the cross-context artifacts that prove the map
was honoured:

```
Generated/
├── Catalog__Ordering/Kernel/Currency.cs      # shared kernel — emitted once
├── Ordering/OrderPlaced.cs                    # the integration event record
├── Shipping/IHandleOrderPlaced.cs             # subscription seam
├── Payments/IHandleOrderPlaced.cs             # subscription seam
├── Payments/ILegacyToPaymentsTranslator.cs    # ACL translator interface
├── Shipping/Fulfillment/Shipment.cs           # the module sub-namespace
└── Koine/Runtime/IIntegrationEvent.cs         # emitted once, when ≥1 integration event exists
```

## A complete two-context model

Here is the whole pattern — directory mode, an import, a module, a context map with three roles, and
pub/sub — small enough to read in one sitting. Save the three blocks as separate `.koi` files in one
folder and run `koine build <folder>`.

```koine
context Customers version 1 {
  value PostalAddress {
    line1:    String
    city:     String
    postcode: String
  }
}
```

```koine
context Ordering version 1 {

  enum Currency { EUR, USD, GBP }

  integration event OrderPlaced {
    orderId:  OrderId
    total:    Decimal
    placedAt: Instant
  }

  publishes OrderPlaced

  aggregate Order root Order {
    entity Order identified by OrderId {
      total:    Decimal
      currency: Currency
    }
  }
}
```

```koine
context Shipping version 1 {

  import Customers.{ PostalAddress }
  subscribes Ordering.OrderPlaced

  enum ShipmentStatus { Pending, Dispatched, Delivered }

  module Fulfillment {
    aggregate Shipment root Shipment {
      entity Shipment identified by ShipmentId {
        order:       OrderId
        destination: PostalAddress
        status:      ShipmentStatus = Pending
      }
    }
  }
}

contextmap {
  Customers  -> Shipping  : customer-supplier
  Ordering   -> Shipping  : open-host
  Customers <-> Ordering  : partnership
}
```

That single build emits `Customers`, `Ordering`, and `Shipping` namespaces, the `OrderPlaced` record,
an `IHandleOrderPlaced` seam in `Shipping`, and the `Shipping.Fulfillment` sub-namespace — every
boundary the map declared, materialised in the C#.

## What you learned

- A **directory build** compiles many files as one model; same-context files merge, cross-context refs
  need an import, a qualifier, or a permitting relation.
- **Modules** carve sub-namespaces and sub-folders inside a context.
- The **`contextmap`** is top-level and *drives emission*: a shared kernel emitted once, ACL
  translators, and the authorisation for pub/sub.
- **Integration events** + `publishes`/`subscribes` generate `IIntegrationEvent` records and
  `IHandle*` handler seams across the boundary.

For the full grammar and every emitted shape, see
[Multi-file, imports & modules](/Koine/reference/multi-file-imports-modules/) and
[Context maps & integration](/Koine/reference/context-maps-integration/).

:::tip[Next]
Your shop spans six contexts and publishes a contract to the world. What happens when that contract has
to *change*? Continue to [part 6 · Evolving a model](/Koine/tutorials/evolving-a-model/), where you
version contexts, annotate fields with `@since`, and use `koine check` to catch breaking changes before
they ship.
:::
