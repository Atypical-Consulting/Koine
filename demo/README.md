# Koine demo — a small Shop domain

This demo models a tiny e-commerce domain across three bounded contexts and shows the
Koine-generated C# being **consumed from a real .NET project**.

```
demo/Shop.Domain/
├── Models/                 # the source of truth — Koine .koi files
│   ├── catalog.koi         #   Catalog: Product, Sku, Price, Weight, SalePeriod, Availability
│   ├── customers.koi       #   Customers: Customer, Email, PostalAddress, LoyaltyTier
│   └── ordering.koi        #   Ordering: the Order aggregate (Order, OrderLine, Money, OrderStatus, RefundStatus)
├── Samples.cs              # hand-written code that USES the generated types
├── Generated/              # produced on build (git-ignored)
└── Shop.Domain.csproj      # regenerates + compiles the .koi models on every build
```

## Run it

```bash
# build just the demo…
dotnet build demo/Shop.Domain/Shop.Domain.csproj
# …or the whole solution (the demo is part of Koine.slnx)
dotnet build
```

The project's `KoineGenerate` MSBuild target runs the `koine` CLI over each `Models/*.koi`
file into `Generated/`, then compiles the result together with `Samples.cs`. A green build
proves the generated domain code is correct and usable.

To see the generated C# directly:

```bash
dotnet run --project src/Koine.Cli -- build demo/Shop.Domain/Models/ordering.koi --out /tmp/out
```

## What it exercises

**v0 core**

| Feature | Where |
|---------|-------|
| Value objects (immutable classes deriving `ValueObject`, structural equality) | `Sku`, `Price`, `Money`, `Email`, `PostalAddress`, `Weight` |
| Regex invariants (`matches /…/`) | `Sku.code`, `Email.raw` |
| Range invariants | `Price.amount >= 0`, `OrderLine.quantity >= 1` |
| Entities + identity-only equality | `Product`, `Customer`, `Order` |
| Generated ID value objects | `ProductId`, `CustomerId`, `OrderId` |
| Enums + default values | `Availability = InStock`, `LoyaltyTier = Bronze`, `OrderStatus = Draft` |
| Aggregates + `IAggregateRoot` | `aggregate Order root Order` |
| Derived/computed fields + scalar arithmetic | `OrderLine.lineTotal = unitPrice * quantity` |
| Conditional invariants (`when`) | `Order`: `status == Draft when lines.isEmpty` |
| `List<T>` → defensively-copied `IReadOnlyList<T>` | `Order.lines` |
| Multiple bounded contexts → namespaces | `Catalog`, `Customers`, `Ordering` |

**Roadmap features now landed (R1–R3)**

| Feature | Story | Where |
|---------|-------|-------|
| Conditional expressions `if … then … else …` | R1.1 | `OrderLine.payable`, `Customer.freeShipping` |
| String operations (`trim`, `upper`, `lower`, `length`, `+`) | R1.2 | `Sku.normalized`, `Email.normalized`, `PostalAddress.formatted` |
| Collection ops + lambdas (`sum`, `count`, `all`, `distinctBy`) | R1.3 | `Order.total`, `Order.lineCount`, `Order` invariants |
| `Instant` comparison | R1.4 | `SalePeriod.startsAt <= endsAt` |
| Optional fields `T?`, `??`, `isPresent` | R2.1 | `Product.description`/`sale`, `Customer.nickname`/`phone`, `Order.submittedAt` |
| `Set<T>` → `IReadOnlySet<T>` (dedupes on construction) | R2.2 | `Product.tags`, `Customer.segments` |
| Soft keywords as field names | R3.4 | `Weight.value` |
| Scoped enum members (shared `Cancelled`) | R3.5 | `Order.isCancelled` (resolves to `OrderStatus`), `Order.isRefunded` (`RefundStatus.Cancelled`) |
| `///` doc comments → C# XML `<summary>` | R4.1 | `ordering.koi` (`Money`, `OrderLine.payable`, `Order`, …) |
| Commands: `requires` preconditions + `field -> value` transitions + invariant re-check | R5 | `Order.submit`, `Order.cancel` (driven from `Samples.BuildOrder`) |
| Domain events: `event` records + `emit` → `DomainEvents`/`ClearDomainEvents` | R6 | `OrderSubmitted` emitted by `Order.submit` |
| State machine: `states` block guarding legal transitions | R7 | `Order` lifecycle (Draft → Submitted → Paid → Shipped, with Cancelled) |
| Smart enums (static instances, value equality) | — | `Currency`, `OrderStatus`, `RefundStatus`, `Availability`, `LoyaltyTier` |

Generate the ubiquitous-language glossary (Markdown, grouped by context → aggregate):

```bash
dotnet run --project ../../src/Koine.Cli -- build Models/ordering.koi --glossary ordering.glossary.md
```

Diagnostics quality (R3.1 stable `KOIxxxx` codes, R3.2 multi-error recovery, R3.3 "did you mean …?")
surfaces when a model is **wrong** — try introducing a typo and running the CLI:

```bash
dotnet run --project ../../src/Koine.Cli -- build Models/catalog.koi
# e.g. a typo'd type prints:  catalog.koi:…: error KOI0101: unknown type 'Currancy' — did you mean 'Currency'?
```

Each context is self-contained (no cross-file references) — cross-context references are a
roadmap item; see [`../USER-STORIES.md`](../USER-STORIES.md).
