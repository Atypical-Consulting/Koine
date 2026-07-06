---
title: "Multi-file, imports & modules"
description: "Compiling a directory as one model, cross-context references, and modules."
---

Real domains span dozens of bounded contexts and hundreds of types — you don't want
them all in one file. Koine lets you split a model across as many `.koi` files as you
like, reference types that another context owns, and group cohesive concepts into
modules. This page covers all three mechanisms.

## 16.1 General

Koine is designed for models that grow across files and teams. The compiler's unit of
work is the **model**, not the file: when you point `koine build` at a directory it
discovers every `.koi` file under it, parses each one independently, and merges them
into a single semantic model before validation and emit. Within that merged model the
three constructs on this page govern how declarations relate to each other:

- **Directory build** — purely a CLI feature; no syntax is required. Every `.koi` in the
  directory contributes to one model, and contexts of the same name merge automatically.
- **`import`** — an explicit cross-context reference that brings a foreign type (or all
  types) into scope inside a `context` body.
- **`module`** — a sub-namespace that groups related types inside a single context.

These three mechanisms compose: a module may appear in one file, reference a type
imported from another context, and itself be split across files if needed. The
overriding rule is that **the file boundary is invisible inside the semantic model** —
the compiler sees contexts and modules, not filenames.

See [Context maps & integration (§17)](/Koine/reference/context-maps-integration/) for
how contexts declare strategic relationships (`conformist`, `open-host`, …) on top of
the import mechanism.

## 16.2 Syntax

The two syntactic constructs this page defines are `import_decl` and `module_decl`.
Directory-build behaviour is a CLI property — no new syntax — and is described in
[§16.3](#163-semantics).

```ebnf
import_decl
    : 'import' type_name '.' ( '{' type_name ( ',' type_name )* '}' | '*' )
    ;

module_decl
    : 'module' Identifier '{' module_member* '}'
    ;

module_member
    : typeDecl
    | module_decl
    ;
```

`type_name` in the grammar is any `Identifier` or soft-keyword identifier (see
[§3.5.2 Soft keywords](/Koine/reference/lexical-structure/#352-soft-keywords) for the soft-keyword list).
`Identifier` is `[a-zA-Z_][a-zA-Z0-9_]*`.

Both `import` and `module` appear as alternatives of `contextMember` — the body of a
`context` declaration. A `moduleDecl` may contain nested `moduleDecl`s, so modules nest
to arbitrary depth. A `typeDecl` is any of `valueDecl`, `quantityDecl`, `entityDecl`,
`aggregateDecl`, `enumDecl`, `eventDecl`, or `integrationEventDecl` — the full set of
type-level constructs defined across this specification.

The cross-context qualifier used in a `typeRef` is not a separate declaration — it is
inline syntax in a type reference:

```ebnf
type_ref
    : ( type_name '.' )? type_name ( '<' type_ref ( ',' type_ref )? '>' )? '?'?
    ;
```

The optional `type_name '.'` prefix is the **one-segment qualifier** that lets you name
a foreign type without a prior `import`.

### 16.2.1 Named import

`import Context.{ A, B }` pulls specific names from another context's exported set into
the current context's scope. Imports go **inside** the `context { ... }` body:

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

### 16.2.2 Wildcard import

`import Context.*` brings in everything a context exports. Convenient, but it's the
only form that can create ambiguity (see [§16.3.2](#1632-cross-context-references)):

```koine
context Shipping version 1 {
  import Customers.*
}
```

### 16.2.3 Fully-qualified reference

Reference a foreign type inline with a single qualifier segment — no `import` required.
This always resolves and never collides:

```koine
context Sales version 1 {
  entity Quote identified by QuoteId {
    price:   Money               // local Money
    freight: Logistics.Money     // Logistics' Money, fully qualified
  }
}
```

:::caution
A fully-qualified reference has **exactly one** qualifier segment: `Context.Type`. There
is no deeper dotting — you cannot reach a foreign context's module-scoped type from a
type reference. Stay within one qualifier.
:::

### 16.2.4 Module declaration

`module Name { ... }` groups cohesive types inside a context. Each module emits into a
`<Context>.<Module>` sub-namespace and a matching `<Context>/<Module>` sub-folder.
Modules may nest:

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

## 16.3 Semantics

### 16.3.1 Directory build

Point `koine build` at a directory and it recursively discovers every `.koi` file under
it in a deterministic order, parses each one, and merges them into a **single model**
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
deletes and rewrites them on each build so stale files from renamed or removed types
cannot linger. Keep generated output in a dedicated directory.
:::

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

Every `SourceSpan` carries its originating file path, so a syntax or semantic error in
any file is reported against the **right** file:

```
customers/profile.koi:5:24: error KOI...: ...
```

The format is `file:line:col: severity CODE: message`, and any error exits non-zero.

### 16.3.2 Cross-context references

The moment you reference a type that a **different** context owns, you must say so
explicitly. There are three ways to do it: named import ([§16.2.1](#1621-named-import)),
wildcard import ([§16.2.2](#1622-wildcard-import)), and fully-qualified reference
([§16.2.3](#1623-fully-qualified-reference)).

**Resolution rules at a glance:**

| Situation | Result |
| --- | --- |
| Same context, different file | Merges; **no import** needed |
| Different context, unqualified, no import | `UnimportedReference` — import it or qualify it |
| Two wildcard imports export the same name, used unqualified | `AmbiguousReference` — listing candidates |
| `import`/qualifier names an unknown context | `UnknownContext` |
| Import a name the target context does not export | `NotExported` |
| Same type name in two contexts (`A.Money`, `B.Money`) | Allowed; local use resolves to the **local** type |
| Same type name in two contexts, referenced from a **third** (via import/qualifier) | Allowed; flat-module targets qualify to a deterministic canonical owner and warn (`AmbiguousMultiOwnerReference`, KOI1419) — see [§16.3.4](#1634-multi-owner-types-in-flat-module-targets) |

To fix an `AmbiguousReference`, switch to a named import or a fully-qualified reference.
Note that emitted C# adds `using <TargetContext>;` **only** for contexts actually
referenced — imports you never use cost nothing in the output.

### 16.3.3 Module scoping

A `module` whose name equals a sibling type name in the same context raises
`ModuleNameCollision` — this is checked even across files in a directory build.

Types declared at any depth inside a module remain **visible by simple name** anywhere
in the same context, including outside the module. Modules define a namespace for
emission purposes; they do not restrict visibility inside the model.

### 16.3.4 Multi-owner types in flat-module targets

Two contexts may each declare a type of the same simple name (`A.Money`, `B.Money`) —
they are **distinct** types, and a reference from *within* either context binds to its
own local one. The nuance is a reference from a **third** context. The C# emitter puts
each context in its own namespace, so a precise `using` disambiguates. The **flat-module
targets — Rust (`crate::<module>::Type`) and Java (`<package>.Type`) — cannot** emit a
bare name there: a bare `Money` in the third context's module would not resolve.

So those emitters qualify a multi-owner cross-context reference to a **deterministic
canonical owner**, chosen the same way build-to-build:

1. the single context the name is **imported** from, when that is unambiguous (the
   reference binds there, so the qualification names exactly that type); otherwise
2. the **ordinal-least** declaring context — a stable fallback independent of
   declaration/file order.

Because that choice is otherwise invisible in the generated code, the compiler raises a
**warning**, `AmbiguousMultiOwnerReference` (`KOI1419`), on the reference — naming the
declaring contexts and the owner it qualified to:

```
gamma.koi:9:20: warning KOI1419: type 'Money' is declared in contexts 'Alpha', 'Beta'
and referenced from 'Gamma'; qualifying to 'Alpha'
```

The warning never blocks a build; it flags a genuine cross-context name collision so you
can rename one type or import the intended owner explicitly. Two cases are deliberately
**silent** because there is nothing to disambiguate: a reference from within one of the
type's own owning contexts (it binds locally), and a **shared-kernel** type, which is
physically homed in one canonical module by design (see
[Context maps & integration §17.2](/Koine/reference/context-maps-integration/)).

:::tip
`import` and `module` are **soft keywords** — they are perfectly legal as field names
(`value V { import: Int  module: Int }` compiles clean). The reserved built-in type
names (`List<T>`, `Set<T>`, `Map<K,V>`, `Range`) still apply globally, so do not name
a value, entity, or module any of those.
:::

## 16.4 Translation to C#

### 16.4.1 Directory-level output

When `--out` is given, the emitter writes one top-level folder per context under the
output root, then sub-folders for modules. The directory tree mirrors the
context/module namespace hierarchy exactly.

### 16.4.2 Import — emitted `using` directives

Each `import` (named or wildcard) that is actually referenced in the context body
produces a `using <TargetContext>;` directive in every generated file that needs it.
Imports that are declared but never used produce no C# output — they are silent no-ops
in the emitted code.

### 16.4.3 Module — sub-namespace and sub-folder

A `module Fulfillment { ... }` inside `context Shipping { ... }` emits all enclosed
types into the `Shipping.Fulfillment` namespace and writes them to
`<out>/Shipping/Fulfillment/`. Nested modules extend the namespace path one segment per
nesting level.

### 16.4.4 Aggregate inside a module — namespace split

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

## 16.5 Example — the demo Shipping context

Here is the canonical demo `Shipping` context, exercising all three features at once: it
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

This compiles only as part of a full multi-context directory, because it references
`OrderId` (from `Ordering`), `Weight` (from `Catalog`), and `PostalAddress` (from
`Customers`) — each a sibling `.koi` file compiled in the same directory pass. That is
exactly the point of directory mode: each context stays in its own file, and Koine
resolves the cross-context references when it merges them into one model.

:::note
For a real, compiling example, see the
[`templates/pizzeria`](https://github.com/Atypical-Consulting/Koine/tree/main/templates/pizzeria)
template, where `Kitchen` imports `Menu`'s `Topping`.
:::

## See also

- [Context maps & integration (§17)](/Koine/reference/context-maps-integration/) — declaring how contexts relate (`conformist`, `open-host`, …) and what those relations permit.
- [Aggregates (§7)](/Koine/reference/aggregates/) — what an aggregate emits, including the repository and `IUnitOfWork`.
- [Value objects (§5)](/Koine/reference/value-objects/) — the value types you will be importing.
- [Contexts & types (§4)](/Koine/reference/contexts-and-types/) — the `context` declaration and built-in type set.
- [Application & CQRS (§15)](/Koine/reference/application-cqrs/) — use cases and read models that span multiple contexts.
- [The CLI](/Koine/guides/cli/) — `build` and `check` flags in full.
