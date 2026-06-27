# Koine demo — a Pizzeria domain across six bounded contexts

This demo models a pizzeria's domain across **six bounded contexts** (plus an external card
Gateway) tied together by a **context map**, and shows the Koine-generated C# being **consumed
from a real .NET project**. It compiles straight from the **`templates/pizzeria`** model — the
single validated source of truth (issue #101) — so **building the demo is what proves the
pizzeria template emits compiling, runnable C# end-to-end**. Between the `.koi` template and
`Samples.cs` it exercises **every shipped tactical & strategic Koine feature (R1–R15)**; the
multi-target emitters (R16) and editor tooling (R17) are shown in the CLI sections below.

```
templates/pizzeria/             # the SOURCE of truth — Koine .koi files (compiled as ONE model)
├── menu.koi                    #   Menu     (v2): pizzas, sizes, toppings, prices, happy hour
├── ordering.koi               #   Ordering : the Order aggregate (commands, events, states, CQRS)
├── kitchen.koi                #   Kitchen  : the KitchenTicket aggregate (a module; imports; subscribes)
├── delivery.koi               #   Delivery : the Delivery aggregate; the Address VO; the "needs an address" rule
├── payment.koi                #   Payment  : Charge + Ledger aggregates; a policy; an ACL target; + the Gateway
├── promotions.koi             #   Promotions: a Discount VO; a spec; a domain service
└── context-map.koi            #   the strategic map: shared kernel, conformist, open-host, ACL, …

demo/Pizzeria.Domain/
├── Samples.cs                  # hand-written builders that USE the generated types
├── Consumers.cs                # hand-written adapters that IMPLEMENT the emitted seams
│                               #   (repository, app service, query handler, subscriber, policy, ACL)
├── Program.cs                  # runnable entry point: drives every sample and ASSERTS the outcomes
├── Generated/                  # produced on build (git-ignored)
└── Pizzeria.Domain.csproj      # regenerates + compiles templates/pizzeria on every build

demo/reference/                 # generated artifacts committed for reference (see its README):
├── pizzeria.glossary.md        #   the ubiquitous-language glossary
├── koine-check.txt             #   a literal `koine check` transcript
└── emitted-cs/*.cs.txt         #   a few representative emitted C# files
```

## Run it

```bash
# build just the demo…
dotnet build demo/Pizzeria.Domain/Pizzeria.Domain.csproj
# …or the whole solution (the demo is part of Koine.slnx)
dotnet build
# …or RUN it — Program.cs drives every sample and asserts the documented outcomes
# (a failed assertion exits non-zero), so a clean run is a self-checking proof:
dotnet run --project demo/Pizzeria.Domain
```

The project's `KoineGenerate` MSBuild target runs the `koine` CLI over the **whole
`templates/pizzeria` directory in one pass** (directory mode), so cross-context `import`s, the
context map, and integration events all resolve across files. It then compiles the result
together with `Samples.cs`. A green build proves the generated domain code is correct and usable.

To see the generated C# directly:

```bash
dotnet run --project src/Koine.Cli -- build templates/pizzeria --out /tmp/out
```

## What it exercises

### Tactical building blocks (v0 + R1–R9)

| Feature | Story | Where |
|---------|-------|-------|
| Value objects (immutable, structural equality) | v0 | `Money`, `Topping`, `Address`, `Courier`, `Coupon`, `Discount`, `PaymentReceipt` |
| Regex invariants (`matches /…/`) | v0 | `Address.postalCode`, `Coupon.code` |
| Range invariants | v0 | `Money.amount >= 0`, `OrderLine.quantity >= 1`, `Discount.amountOff <= orderTotal` |
| Entities + identity-only equality | v0 | `Order`, `KitchenTicket`, `Delivery`, `Charge`, `LedgerEntry`, `Pizza` |
| Aggregates + `IAggregateRoot` | v0 | `Order`, `KitchenTicket`, `Delivery`, `Charge`, `LedgerEntry`, `Pizza` |
| Derived/computed fields + scalar arithmetic | v0 | `OrderLine.lineTotal`, `Order.total` |
| Conditional invariants (`when`) | v0 | `Order`: `status == Draft when lines.isEmpty`; `Delivery`: `courier.isPresent when status == EnRoute` |
| Multiple bounded contexts → namespaces | v0 | all six contexts + the external Gateway |
| Conditional expressions `if … then … else …` | R1.1 | `OrderLine.payable` (5+ → 10% off), `DiscountService.cap/rate` |
| String operations (`trim`, `upper`, `lower`, `+`) | R1.2 | `Address.formatted`, `Topping.key`, `Coupon.normalized` |
| Collection ops + lambdas (`sum`, `count`, `all`, `distinctBy`) | R1.3 | `Order.total`, `Order` invariants |
| `Instant` comparison / `Range<Instant>` | R1.4 / R9.3 | `HappyHour.window: Range<Instant>` |
| Optional fields `T?`, `??`, `isPresent` | R2.1 | `Order.placedAt`, `Delivery.courier`, `Pizza.description`/`kcal` |
| `Set<T>` → `IReadOnlySet<T>` (dedupes) | R2.2 | `Pizza.toppings` |
| `///` doc comments → C# XML `<summary>` | R4.1 | every `.koi` file |
| Glossary generation | R4.2 | `--glossary` (see below) |
| Commands: `requires` + `field -> value` + invariant re-check | R5 | `Order.place/cancel`, `KitchenTicket.prep/bake/putUp/serve`, `Delivery.pickUp/depart/complete`, `Charge.capture/refund` |
| Domain events: `event` + `emit` → `DomainEvents` | R6 | `OrderOpened`, `TicketStartedBaking`, `DeliveryCompleted`, `ChargeCaptured` |
| State machines: legal transitions | R7 | `Order`, `KitchenTicket`, `Delivery`, `Charge` lifecycles |
| **Factories** (`create … { requires; field -> value; emit }`) | R8 | `Order.open`, `KitchenTicket.open`, `Delivery.schedule`, `Charge.authorize` |
| **Enum with associated data** | R9.1 | `Currency(symbol, decimals)` |
| **Quantity value object** (unit-checked arithmetic) | R9.2 | `Portion { amount: Decimal  unit: MassUnit }` |
| **`Range<T>`** (Contains/Overlaps, start≤end) | R9.3 | `HappyHour.window` |
| Smart enums (static instances, value equality) | — | every `enum` |

### Strategic & application layer (R10–R15)

| Feature | Story | Where |
|---------|-------|-------|
| **Specifications** (`spec N on T = …`) | R10.1 | `Promotions`: `spec IsFreeOrder on Discount` |
| **Domain services** (`service { operation … }`) | R10.2 | `Promotions`: `DiscountService.cap/rate` |
| **Policies** (`policy N when Event then Target.command`) | R10.3 | `Payment`: `PostToLedger` |
| **Identity strategies** (`as natural(String)` / Guid) | R11.1 | `Pizza` (natural `PizzaCode`), Guid ids elsewhere |
| **Repository interface** per aggregate root | R11.2 | every aggregate → `I<Root>Repository` |
| **Repository finders + operation set** (`repository { … }`) | R11.3 | `Ordering`: `byCustomer`, `mostRecent`; `Kitchen`: `atStation`, `inProgress` |
| **Optimistic concurrency** (`versioned`) | R11.4 | `Order` → `Version` + `ConcurrencyConflictException` |
| **Unit of Work** (per context, multi-aggregate) | R12.1 | `Payment.IUnitOfWork` (Charge + Ledger), `Menu`, `Ordering` |
| **Application services** (`service { usecase … }`) | R12.2 | `Ordering`: `IOrderingService`; `Delivery`, `Payment` |
| **Read models + projection mappers** (`readmodel … from`) | R12.3 | `Ordering.OrderSummary`, `Kitchen.TicketBoard`, `Delivery.DeliveryTicket`, `Menu.MenuItem` |
| **Query objects** (`query … : List<M>`) | R12.4 | `OrdersByStatus`, `TicketsByStage`, `DeliveriesByStatus`, `PizzasBySize` |
| **Directory compilation** (one model from many files) | R13.1 | the whole `templates/pizzeria` folder |
| **Imports / qualified refs** (`import X.{ … }`) | R13.2 | `Kitchen` imports `Menu.{ Topping }` |
| **Modules** (sub-namespace + folder) | R13.3 | `Kitchen`: `module Line { … }` |
| **Context map** (typed relationships) | R14.1 | `context-map.koi` (8 relationships) |
| **Shared kernel** (shared type, one emission) | R14.2 | `Menu <-> Ordering : shared-kernel { Currency }` |
| **Anti-corruption layer** (translator stub) | R14.2 | `Gateway -> Payment`: `IGatewayToPaymentTranslator` |
| **Integration events + pub/sub** | R14.3 | `Ordering` publishes `OrderPlaced`; `Kitchen`/`Delivery`/`Payment` subscribe |
| **Model versioning** (`context X version N`) | R15.1 | `Menu version 2` |
| **Evolution annotations** (`@since(n)`) | R15.1 | `Pizza.kcal @since(2)` |
| **Backward-compatibility check** (`koine check`) | R15.2 | see below |

## The context map

`context-map.koi` declares how the contexts relate — and the relationships are *enforced* and
*drive emission*:

```
contextmap {
  Menu      <-> Ordering : shared-kernel { Currency }   // Currency emitted once into a kernel namespace
  Menu       -> Kitchen  : conformist                    // Kitchen imports Menu.Topping directly
  Ordering   -> Kitchen  : open-host                     // authorizes Kitchen's subscription
  Ordering   -> Delivery : open-host                     // authorizes Delivery's subscription
  Ordering   -> Payment  : open-host                     // authorizes Payment's subscription
  Promotions -> Ordering : customer-supplier
  Kitchen   <-> Delivery : partnership
  Gateway    -> Payment  : anti-corruption-layer
    acl { Gateway.GatewayResult -> Payment.PaymentReceipt }
}
```

This is why the generated tree contains `Menu__Ordering/Kernel/Enums/Currency.cs` (shared once),
`Kitchen/Abstractions/IHandleOrderPlaced.cs`, `Delivery/Abstractions/IHandleOrderPlaced.cs` and
`Payment/Abstractions/IHandleOrderPlaced.cs` (subscription seams), and
`Payment/Abstractions/IGatewayToPaymentTranslator.cs` (the ACL translator interface).

## Ubiquitous-language glossary (R4.2)

```bash
dotnet run --project src/Koine.Cli -- build templates/pizzeria --glossary demo/reference/pizzeria.glossary.md
```

Produces Markdown grouped by context (each heading shows its `version`), then by type, listing
fields, derived fields, and business rules.

## Backward-compatibility check (R15.2)

A worked before/after lives under [`../examples/versioning/`](../examples/versioning):

```bash
# v2 removes a published field from OrderPlaced — a breaking change:
dotnet run --project src/Koine.Cli -- check examples/versioning/v2 --baseline examples/versioning/v1
#   breaking KOI1511: field 'coupon' of published integration event 'OrderPlaced' was removed.
#   non-breaking: field 'note' of published integration event 'OrderPlaced' was added.
#   breaking KOI1517: Published integration event 'OrderPlaced' changed its payload shape.
#   error: 2 breaking change(s) to published surfaces      (exit code 1)
```

`koine check` only flags changes to **published** surfaces (integration events, shared-kernel
types, open-host value objects); internal refactors are ignored.

## Editor tooling (R17)

The same CLI that builds the model also formats, scaffolds, and watches it — the
building blocks the editor integration (grammar + LSP) is built on:

```bash
# Canonically format the template in place (or --check to verify only, in CI):
dotnet run --project src/Koine.Cli -- fmt templates/pizzeria
dotnet run --project src/Koine.Cli -- fmt templates/pizzeria --check

# Scaffold a fresh starter project (drop --force to avoid overwriting):
dotnet run --project src/Koine.Cli -- init /tmp/my-pizzeria

# Rebuild the whole template directory on every save:
dotnet run --project src/Koine.Cli -- watch templates/pizzeria --out /tmp/out
```

> Koine emits more than C#. The shipped `--target` values are `csharp` (the most complete),
> `typescript`, `python`, `php`, and `rust`, plus the non-code outputs `glossary`, `docs`,
> `asyncapi`, and `openapi`. Try e.g. `--target php` or `--target typescript`.

## Diagnostics quality

Diagnostics (R3.1 stable `KOIxxxx` codes, R3.2 multi-error recovery, R3.3 "did you mean …?")
surface when a model is **wrong** — introduce a typo and rebuild:

```bash
dotnet run --project src/Koine.Cli -- build templates/pizzeria
# e.g. a typo'd type prints:  ordering.koi:…: error KOI0101: unknown type 'Currancy' — did you mean 'Currency'?
```
