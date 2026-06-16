# Koine demo — a Shop domain across six bounded contexts

This demo models an e-commerce domain across **six bounded contexts** tied together by a
**context map**, and shows the Koine-generated C# being **consumed from a real .NET project**.
It is the reference showcase: between the `.koi` models and `Samples.cs` it exercises **every
shipped Koine feature (R1–R15)**.

```
demo/Shop.Domain/
├── Models/                 # the source of truth — Koine .koi files (compiled as ONE model)
│   ├── catalog.koi         #   Catalog   (v2): products, prices, weights, sale windows
│   ├── customers.koi       #   Customers: customers, addresses, loyalty + a spec & service
│   ├── ordering.koi        #   Ordering : the Order aggregate (commands, events, states, CQRS)
│   ├── shipping.koi        #   Shipping : the Shipment aggregate (a module; imports; subscribes)
│   ├── payments.koi        #   Payments : Payment + Ledger aggregates; a policy; an ACL target
│   ├── legacy.koi          #   Legacy   : an external gateway, fronted by an anti-corruption layer
│   └── context-map.koi     #   the strategic map: shared kernel, conformist, open-host, ACL, …
├── Samples.cs              # hand-written builders that USE the generated types
├── Consumers.cs            # hand-written adapters that IMPLEMENT the emitted seams
│                           #   (repository, app service, query handler, subscriber, policy, ACL)
├── Program.cs              # runnable entry point: drives every sample and ASSERTS the outcomes
├── Generated/              # produced on build (git-ignored)
└── Shop.Domain.csproj      # regenerates + compiles the .koi models on every build

demo/reference/             # generated artifacts committed for reference (see its README):
├── shop.glossary.md        #   the ubiquitous-language glossary
├── koine-check.txt         #   a literal `koine check` transcript
└── emitted-cs/*.cs.txt     #   a couple of representative emitted C# files
```

## Run it

```bash
# build just the demo…
dotnet build demo/Shop.Domain/Shop.Domain.csproj
# …or the whole solution (the demo is part of Koine.slnx)
dotnet build
# …or RUN it — Program.cs drives every sample and asserts the documented outcomes
# (a failed assertion exits non-zero), so a clean run is a self-checking proof:
dotnet run --project demo/Shop.Domain
```

The project's `KoineGenerate` MSBuild target runs the `koine` CLI over the **whole `Models/`
directory in one pass** (directory mode), so cross-context `import`s, the context map, and
integration events all resolve across files. It then compiles the result together with
`Samples.cs`. A green build proves the generated domain code is correct and usable.

To see the generated C# directly:

```bash
dotnet run --project src/Koine.Cli -- build demo/Shop.Domain/Models --out /tmp/out
```

## What it exercises

### Tactical building blocks (v0 + R1–R9)

| Feature | Story | Where |
|---------|-------|-------|
| Value objects (immutable, structural equality) | v0 | `Sku`, `Price`, `Money`, `Email`, `PostalAddress` |
| Regex invariants (`matches /…/`) | v0 | `Sku.code`, `Email.raw` |
| Range invariants | v0 | `Price.amount >= 0`, `OrderLine.quantity >= 1` |
| Entities + identity-only equality | v0 | `Product`, `Customer`, `Order`, `Shipment`, `Payment` |
| Aggregates + `IAggregateRoot` | v0 | `Order`, `Shipment`, `Payment`, `Ledger`, `ProductCatalog` |
| Derived/computed fields + scalar arithmetic | v0 | `OrderLine.lineTotal`, `Order.total` |
| Conditional invariants (`when`) | v0 | `Order`: `status == Draft when lines.isEmpty` |
| Multiple bounded contexts → namespaces | v0 | all six contexts |
| Conditional expressions `if … then … else …` | R1.1 | `OrderLine.payable`, `Customer.freeShipping`, `LoyaltyService` |
| String operations (`trim`, `upper`, `lower`, `+`) | R1.2 | `Sku.normalized`, `Email.normalized`, `PostalAddress.formatted` |
| Collection ops + lambdas (`sum`, `count`, `all`, `distinctBy`) | R1.3 | `Order.total`, `Order` invariants |
| `Instant` comparison / `Range<Instant>` | R1.4 / R9.3 | `SalePeriod.window: Range<Instant>` |
| Optional fields `T?`, `??`, `isPresent` | R2.1 | `Product.description`/`sale`, `Customer.nickname`/`phone` |
| `Set<T>` → `IReadOnlySet<T>` (dedupes) | R2.2 | `Product.tags`, `Customer.segments` |
| `///` doc comments → C# XML `<summary>` | R4.1 | `ordering.koi`, `shipping.koi`, `payments.koi` |
| Glossary generation | R4.2 | `--glossary` (see below) |
| Commands: `requires` + `field -> value` + invariant re-check | R5 | `Order.submit/cancel`, `Shipment.dispatch`, `Payment.capture/refund` |
| Domain events: `event` + `emit` → `DomainEvents` | R6 | `OrderSubmitted`, `OrderOpened`, `ShipmentScheduled`, `PaymentAuthorized` |
| State machines: legal transitions | R7 | `Order`, `Shipment`, `Payment` lifecycles |
| **Factories** (`create … { requires; field -> value; emit }`) | R8 | `Order.open`, `Shipment.schedule`, `Payment.authorize` |
| **Enum with associated data** | R9.1 | `Currency(symbol, decimals)` |
| **Quantity value object** (unit-checked arithmetic) | R9.2 | `Weight { amount: Decimal  unit: MassUnit }` |
| **`Range<T>`** (Contains/Overlaps, start≤end) | R9.3 | `SalePeriod.window` |
| Smart enums (static instances, value equality) | — | every `enum` |

### Strategic & application layer (R10–R15)

| Feature | Story | Where |
|---------|-------|-------|
| **Specifications** (`spec N on T = …`) | R10.1 | `Customers`: `spec IsVip on Customer` |
| **Domain services** (`service { operation … }`) | R10.2 | `Customers`: `LoyaltyService.discountRate` |
| **Policies** (`policy N when Event then Target.command`) | R10.3 | `Payments`: `PostToLedger` |
| **Identity strategies** (`as natural(String)` / Guid) | R11.1 | `Product` (natural `ProductCode`), Guid ids elsewhere |
| **Repository interface** per aggregate root | R11.2 | every aggregate → `I<Root>Repository` |
| **Repository finders + operation set** (`repository { … }`) | R11.3 | `Ordering`: `byCustomer`, `mostRecent`, `operations: …` |
| **Optimistic concurrency** (`versioned`) | R11.4 | `Order` → `Version` + `ConcurrencyConflictException` |
| **Unit of Work** (per context, multi-aggregate) | R12.1 | `Payments.IUnitOfWork` (Payment + Ledger), `Catalog`, `Ordering` |
| **Application services** (`service { usecase … }`) | R12.2 | `Ordering`: `IOrderingService` |
| **Read models + projection mappers** (`readmodel … from`) | R12.3 | `Catalog.ProductCard`, `Ordering.OrderSummary` |
| **Query objects** (`query … : List<M>`) | R12.4 | `ProductsByAvailability`, `ProductByCode`, `OrdersByStatus` |
| **Directory compilation** (one model from many files) | R13.1 | the whole `Models/` folder |
| **Imports / qualified refs** (`import X.{ … }`) | R13.2 | `Shipping` imports `Customers.{ PostalAddress }` |
| **Modules** (sub-namespace + folder) | R13.3 | `Shipping`: `module Fulfillment { … }` |
| **Context map** (typed relationships) | R14.1 | `context-map.koi` (7 relationships) |
| **Shared kernel** (shared type, one emission) | R14.2 | `Catalog <-> Ordering : shared-kernel { Currency }` |
| **Anti-corruption layer** (translator stub) | R14.2 | `Legacy -> Payments`: `ILegacyToPaymentsTranslator` |
| **Integration events + pub/sub** | R14.3 | `Ordering` publishes `OrderPlaced`; `Shipping`/`Payments` subscribe |
| **Model versioning** (`context X version N`) | R15.1 | `Catalog version 2` |
| **Evolution annotations** (`@since(n)`) | R15.1 | `Product.barcode @since(2)` |
| **Backward-compatibility check** (`koine check`) | R15.2 | see below |

## The context map

`context-map.koi` declares how the six contexts relate — and the relationships are *enforced* and
*drive emission*:

```
contextmap {
  Catalog   <-> Ordering : shared-kernel { Currency }   // Currency emitted once into a kernel namespace
  Catalog    -> Shipping : conformist                    // Shipping references Catalog.Weight directly
  Customers  -> Shipping : customer-supplier             // Shipping imports Customers.PostalAddress
  Ordering   -> Shipping : open-host                     // authorizes Shipping's subscription
  Ordering   -> Payments : open-host                     // authorizes Payments' subscription
  Shipping  <-> Payments : partnership
  Legacy     -> Payments : anti-corruption-layer
    acl { Legacy.GatewayResult -> Payments.PaymentReceipt }
}
```

This is why the generated tree contains `Catalog__Ordering/Kernel/Currency.cs` (shared once),
`Shipping/IHandleOrderPlaced.cs` and `Payments/IHandleOrderPlaced.cs` (subscription seams), and
`Payments/ILegacyToPaymentsTranslator.cs` (the ACL translator interface).

## Ubiquitous-language glossary (R4.2)

```bash
cd demo/Shop.Domain
dotnet run --project ../../src/Koine.Cli -- build Models --glossary shop.glossary.md
```

Produces Markdown grouped by context (each heading shows its `version`), then by type, listing
fields, derived fields, and business rules.

## Backward-compatibility check (R15.2)

A worked before/after lives under [`../../examples/versioning/`](../../examples/versioning):

```bash
# v2 removes a published field from OrderPlaced — a breaking change:
dotnet run --project src/Koine.Cli -- check examples/versioning/v2 --baseline examples/versioning/v1
#   breaking KOI1511: field 'coupon' of published integration event 'OrderPlaced' was removed.
#   non-breaking: field 'note' of published integration event 'OrderPlaced' was added.
#   error: 1 breaking change(s) to published surfaces      (exit code 1)
```

`koine check` only flags changes to **published** surfaces (integration events, shared-kernel
types, open-host value objects); internal refactors are ignored.

## Editor tooling (R17)

The same CLI that builds the model also formats, scaffolds, and watches it — the
building blocks the editor integration (grammar + LSP) is built on. Run these from
`demo/Shop.Domain` (paths are relative to it):

```bash
# Canonically format the models in place (or --check to verify only, in CI):
dotnet run --project ../../src/Koine.Cli -- fmt Models
dotnet run --project ../../src/Koine.Cli -- fmt Models --check

# Scaffold a fresh starter project (drop --force to avoid overwriting):
dotnet run --project ../../src/Koine.Cli -- init /tmp/my-shop

# Rebuild the whole Models/ directory on every save:
dotnet run --project ../../src/Koine.Cli -- watch Models --out Generated
```

> R16 multi-target emitters (TypeScript/SQL/… beyond C#) are **deferred**; today the
> only `--target` is `csharp` (plus the `glossary` output above).

## Diagnostics quality

Diagnostics (R3.1 stable `KOIxxxx` codes, R3.2 multi-error recovery, R3.3 "did you mean …?")
surface when a model is **wrong** — introduce a typo and rebuild:

```bash
dotnet run --project src/Koine.Cli -- build demo/Shop.Domain/Models
# e.g. a typo'd type prints:  catalog.koi:…: error KOI0101: unknown type 'Currancy' — did you mean 'Currency'?
```
