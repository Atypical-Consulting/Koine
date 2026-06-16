---
title: "Multi-file, imports & modules"
description: "Compiling a directory as one model, cross-context references, and modules."
---

Real domains span dozens of bounded contexts and hundreds of types — you don't want
them all in one file. Koine lets you split a model across as many `.koi` files as you
like, reference types that another context owns, and group cohesive concepts into
modules. This page covers all three.

## Compile a directory as one model

Point `koine build` at a directory and it recursively discovers every `.koi` file under
it (in a deterministic order), parses each one, and merges them into a **single model**
before validation and emit.

```bash
# Compile every .koi under ./domain into one model
koine build ./domain --target csharp --out ./generated

# Just parse + validate the whole directory (prints OK, emits nothing)
koine build ./domain
```

Passing a single file still works exactly as before — directory mode is purely additive.

:::note
When `--out` is given, Koine **owns** the top-level namespace folders it generates: it
deletes and rewrites them on each build so stale files from renamed/removed types can't
linger. Keep generated output in a dedicated directory.
:::

### Same-named contexts merge

Two files that each declare a `context` of the **same name** contribute their types to
the same merged context. Contexts are open and additive, so you can grow one context
across many files without any glue:

```koine
// customers/address.koi
context Customers version 1 {
  value PostalAddress {
    street:  String
    city:    String
    zipCode: String
  }
}
```

```koine
// customers/profile.koi  — same context, different file, no import needed
context Customers version 1 {
  entity Customer identified by CustomerId {
    name:            String
    shippingAddress: PostalAddress   // resolves locally; same context
  }
}
```

Types declared in the same context resolve by simple name with **no import** — the file
boundary is invisible inside a context.

### Diagnostics keep their file

Every `SourceSpan` carries its originating file path, so a syntax or semantic error in any
file is reported against the **right** file:

```
customers/profile.koi:5:24: error KOI...: ...
```

The format is `file:line:col: severity CODE: message`, and any error exits non-zero.

## Cross-context references

The moment you reference a type that a **different** context owns, you must say so
explicitly. There are three ways to do it.

### `import Context.{ A, B }` — named import

Pull specific names from another context into the current context's scope. Imports go
**inside** the `context { ... }` body:

```koine
context Shipping version 1 {
  import Customers.{ PostalAddress }

  // PostalAddress now resolves unqualified, anywhere in Shipping
  aggregate Shipment root Shipment {
    entity Shipment identified by ShipmentId {
      destination: PostalAddress
    }
  }
}
```

### `import Context.*` — wildcard import

Bring in everything a context exports. Convenient, but it's the only form that can create
ambiguity (see below):

```koine
context Shipping version 1 {
  import Customers.*
}
```

### `Context.Type` — fully-qualified reference

Reference a foreign type inline with a single qualifier segment, no import required. This
always resolves and never collides:

```koine
context Sales version 1 {
  entity Quote identified by QuoteId {
    price:   Money               // local Money
    freight: Logistics.Money     // Logistics' Money, fully qualified
  }
}
```

:::caution One qualifier only
A fully-qualified reference has **exactly one** qualifier segment: `Context.Type`. There's
no deeper dotting (you can't reach a foreign context's module-scoped type from a type
reference) — stay within one qualifier.
:::

### Resolution rules at a glance

| Situation | Result |
| --- | --- |
| Same context, different file | Merges; **no import** needed |
| Different context, unqualified, no import | `UnimportedReference` — import it or qualify it |
| Two wildcard imports export the same name, used unqualified | `AmbiguousReference` — listing candidates |
| `import`/qualifier names an unknown context | `UnknownContext` |
| Import a name the target context doesn't export | `NotExported` |
| Same type name in two contexts (`A.Money`, `B.Money`) | Allowed; local use resolves to the **local** type |

To fix an `AmbiguousReference`, switch to a named import or a fully-qualified reference.
Note that emitted C# adds `using <TargetContext>;` **only** for contexts actually
referenced — imports you never use cost nothing in the output.

## Modules

A `module Name { ... }` groups cohesive types inside a context. Each module emits into a
`<Context>.<Module>` **sub-namespace** and a matching `<Context>/<Module>` **sub-folder**.
Modules may nest.

```koine
context Shipping version 1 {
  import Customers.{ PostalAddress }

  enum ShipmentStatus { Pending, Dispatched, Delivered, Returned }

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
```

Sibling and cross-module types within the same context still resolve **unqualified** —
`ShipmentStatus` above lives in the base context but is freely usable inside the module.
A `module` whose name equals a sibling type name in the same context is a coded
`ModuleNameCollision` (checked even across files in a directory build).

### Where things land for an aggregate-in-a-module

This is the one nuance worth memorizing. When you put an aggregate **inside** a module,
Koine splits the emitted types across two namespaces:

- The **repository** goes into the module namespace (`Shipping.Fulfillment.IShipmentRepository`).
- The aggregate's `*Id` value object and the context-level `IUnitOfWork` stay in the
  **base** namespace (`Shipping`).

That keeps identities and the transactional boundary at the context level where they
belong, while the aggregate's persistence contract lives with its module. The emitter
wires the `using` directives precisely so everything still references everything else:

```csharp
// Shipping/Fulfillment/IShipmentRepository.cs
namespace Shipping.Fulfillment;

using Shipping;   // to see ShipmentId, which lives in the base namespace

public interface IShipmentRepository
{
    Task<Shipment?> GetByIdAsync(ShipmentId id, CancellationToken ct = default);
    // ...
}
```

```csharp
// Shipping/IUnitOfWork.cs — stays in the BASE namespace
namespace Shipping;

public interface IUnitOfWork
{
    Shipping.Fulfillment.IShipmentRepository Shipments { get; }  // module-qualified
    Task<int> SaveChangesAsync(CancellationToken ct = default);
}
```

```csharp
// Shipping/ShipmentId.cs — the identity also stays in the BASE namespace
namespace Shipping;

public sealed class ShipmentId : ValueObject { /* ... */ }
```

The resulting folder layout mirrors the namespaces:

```
Generated/Shipping/
├── IUnitOfWork.cs              (Shipping)
├── OrderId.cs                 (Shipping — id value objects land in the base ns)
├── ShipmentId.cs              (Shipping — the root's own *Id)
├── ShipmentStatus.cs          (Shipping — the context-level enum)
└── Fulfillment/
    ├── IShipmentRepository.cs  (Shipping.Fulfillment)
    ├── Shipment.cs             (Shipping.Fulfillment)
    └── ShipmentScheduled.cs    (Shipping.Fulfillment)
```

:::tip
`import` and `module` are **soft keywords** — they're perfectly legal as field names
(`value V { import: Int  module: Int }` compiles clean). The reserved built-in type names
(`List<T>`, `Set<T>`, `Map<K,V>`, `Range`) still apply globally, so don't name a value,
entity, or module any of those.
:::

## Putting it together — the demo Shipping context

Here's the canonical demo `Shipping` context, exercising all three features at once: it
imports `PostalAddress` from `Customers`, references `OrderId` and `Weight` from sibling
contexts, and nests its aggregate under a `Fulfillment` module.

```koine
/// Shipping bounded context — getting orders to customers.
context Shipping version 1 {

  // A named import: Shipping reuses Customers' PostalAddress value object.
  import Customers.{ PostalAddress }

  enum ShipmentStatus { Pending, Dispatched, Delivered, Returned }

  // A module groups the fulfillment aggregate into Shipping.Fulfillment.
  module Fulfillment {

    aggregate Shipment root Shipment {

      /// Raised when a shipment is scheduled.
      event ShipmentScheduled {
        shipment: ShipmentId
        order:    OrderId
      }

      entity Shipment identified by ShipmentId {
        order:       OrderId
        destination: PostalAddress
        weight:      Weight
        status:      ShipmentStatus = Pending

        // The shipment lifecycle.
        states status {
          Pending    -> Dispatched, Returned
          Dispatched -> Delivered, Returned
          Delivered
          Returned
        }

        /// Advance a pending shipment onto a courier.
        command dispatch {
          requires status == Pending  "only a pending shipment can be dispatched"
          status -> Dispatched
        }

        /// Schedule a shipment for an order. Same-named parameters auto-bind the
        /// required fields; `status` defaults to Pending.
        create schedule(order: OrderId, destination: PostalAddress, weight: Weight) {
          emit ShipmentScheduled(shipment: id, order: order)
        }
      }
    }
  }
}
```

This compiles only as part of the full demo directory, because it references `OrderId`
(from `Ordering`), `Weight` (from `Catalog`), and `PostalAddress` (from `Customers`) — all
sibling `.koi` files in `demo/Shop.Domain/Models/`. That's exactly the point of directory
mode: each context stays in its own file, and Koine resolves the cross-context references
when it merges them into one model.

## See also

- [The CLI](/Koine/guides/cli/) — `build` and `check` flags in full.
- [Context maps & integration](/Koine/reference/context-maps-integration/) — declaring how contexts
  relate (`conformist`, `open-host`, …) and what those relations permit.
- [Aggregates & repositories](/Koine/reference/aggregates/) — what an aggregate emits.
- [Value objects](/Koine/reference/value-objects/) — the value types you'll be importing.
