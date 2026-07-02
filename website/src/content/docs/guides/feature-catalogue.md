---
title: "Feature catalogue"
description: "Every shipped Koine construct mapped to its .koi syntax, what it emits, and where the demo uses it."
---

This is the everything-at-a-glance page: every construct Koine ships — the full tactical and strategic
toolkit plus the developer tooling — with the short `.koi` syntax for it, the C# (or Markdown) it emits,
and a pointer into the canonical
[pizzeria demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo) (which compiles the
[`templates/pizzeria`](https://github.com/Atypical-Consulting/Koine/tree/main/templates/pizzeria)
template). Tables are grouped by capability. Each family links to its reference page for the full story.

:::tip
Everything in `templates/pizzeria/*.koi` exercises **every row below**. The fastest way to learn a
construct is to grep its demo location and read the surrounding `.koi`, then look at the matching file
under `demo/Pizzeria.Domain/Generated/`.
:::

## Tactical building blocks

The core DDD vocabulary: types, fields, invariants, and the expression language. See
[value objects](/Koine/reference/value-objects/), [entities and identity](/Koine/reference/entities-and-identity/),
[aggregates](/Koine/reference/aggregates/), [invariants](/Koine/reference/invariants/), and
[expressions](/Koine/reference/expressions/).

| Construct | `.koi` syntax (short) | Emits | Demo location |
|---|---|---|---|
| Value object | `value Price { amount: Decimal }` | `sealed record` with get-only props, validating ctor, value equality | `Money`, `Topping`, `Address`, `Coupon`, `Discount` |
| Entity + id | `entity Product identified by ProductCode { … }` | `sealed class` with identity-only equality + a generated id value object | `Pizza`, `Order`, `KitchenTicket`, `Delivery`, `Charge` |
| Aggregate root | `aggregate Order root Order { entity Order … }` | nested types in the context namespace; root implements `IAggregateRoot`; an `I<Root>Repository` is emitted | `Order`, `Catalog` (root `Pizza`), `Dispatch` (root `Delivery`), `Billing` (root `Charge`), `Books` (root `LedgerEntry`), `Kitchen.Line.KitchenTicket` |
| Typed field | `name: Type` | a typed property + ctor parameter | every type |
| Defaulted field | `status: OrderStatus = Draft` | a ctor parameter with a default value | `Order.status`, `KitchenTicket.stage` |
| Derived field | `lineTotal: Money = price * quantity` | a get-only **computed** property (not in the ctor) | `OrderLine.lineTotal`, `Order.total` |
| Range invariant | `invariant amount >= 0 "…"` | a ctor guard that throws `DomainInvariantViolationException` | `Money.amount >= 0`, `OrderLine.quantity >= 1` |
| Regex invariant | `invariant code matches /…/ "…"` | a `Regex.IsMatch` guard | `Coupon.code`, `Address.postalCode` |
| Conditional invariant | `invariant status == Draft when lines.isEmpty` | `if (cond && !body) throw` | `Order` draft rule |
| Conditional expression | `if cond then a else b` | a C# ternary | `OrderLine.payable` |
| String ops | `code.trim.upper`, `a + b` | `.Trim()`, `.ToUpperInvariant()`, string concat | `Coupon.normalized`, `Address.formatted` |
| Collection ops + lambdas | `lines.sum(l => l.lineTotal)`, `.count`, `.all`, `.distinctBy` | LINQ (`.Sum`, `.Count`, `.All`, `.DistinctBy`); pulls `using System.Linq;` | `Order.total`, `Order` invariants |
| Multiple contexts → namespaces | `context Catalog { … }` | one C# namespace + folder per context | all six contexts |

## Optionality, sets & docs

See [value objects](/Koine/reference/value-objects/) and [contexts and types](/Koine/reference/contexts-and-types/).

| Construct | `.koi` syntax (short) | Emits | Demo location |
|---|---|---|---|
| Optional field | `description: String?` | a nullable property; supports `??` and `.isPresent` | `Pizza.description`/`kcal`, `KitchenTicket.startedAt` |
| Set | `tags: Set<String>` | `IReadOnlySet<T>` (de-duplicated in the ctor) | `Pizza.toppings` |
| Doc comment | `/// summary text` | a C# XML `<summary>` on the member/type | `ordering.koi`, `menu.koi`, `payment.koi` |
| Glossary | `koine build … --glossary pizzeria.md` | a Markdown glossary grouped by context (each heading shows its `version`) then type | the `--glossary` flag |

## Commands, events & state

See [commands, events & state](/Koine/reference/commands-events-state/).

| Construct | `.koi` syntax (short) | Emits | Demo location |
|---|---|---|---|
| Command | `command submit() { requires …; status -> Placed; emit … }` | a mutating method that checks `requires`, applies `field -> value` transitions, re-checks invariants | `Order.place/cancel`, `Delivery.pickUp/depart/complete`, `Charge.capture/refund` |
| Command returning a value | `command cancel(): OrderId { …; result id }` | a typed method (`public <T> Name(…)`) that returns the `result` expression as its terminal statement (the create-and-return-id idiom) | — |
| Domain event | `event OrderSubmitted { … }` + `emit OrderSubmitted(…)` | a record recorded into the root's `DomainEvents` collection | `OrderOpened`, `OrderPlacedInternally`, `DeliveryScheduled`, `ChargeAuthorized` |
| State machine | `states { Draft -> Placed; … }` | runtime-checked legal transitions; illegal transition throws | `Order`, `Delivery`, `Charge`, `KitchenTicket` lifecycles |

:::caution
`->` (the single state-effect arrow: transition, state rule, **and** factory init below) is one atomic
token — keep the two characters adjacent (`status -> Placed`, never `status - > Placed`). Koine has just
two assignment-like arrows: `=` (declaration default) and `->` (state effect).
:::

## Factories

The aggregate's only public construction path. See [factories](/Koine/reference/factories/).

| Construct | `.koi` syntax (short) | Emits | Demo location |
|---|---|---|---|
| Named factory | `create open(customer: CustomerId, …) { … }` | `public static <Entity> Open(…)`: generate id, check `requires`, construct with named ctor args, emit, return | `Order.open`, `Delivery.schedule`, `Charge.authorize` |
| Field init | `total -> lines.sum(l => l.price)` | a named ctor argument `total: <expr>` | factory bodies |
| Auto-bind | `create open(customer: CustomerId, …)` (param name = field) | binds the matching field without an explicit `->` | `Order.open` |
| Creation event | `emit OrderOpened(orderId: id, …)` | records the event into `DomainEvents` after construction | factory bodies |
| Factory-only construction | (presence of any `create`) | the all-args constructor becomes `private` | every aggregate with a factory |

:::note
In a factory body only `id` and the factory's own parameters are in scope — entity members are not, because
the aggregate doesn't exist yet. A factory parameter named `id` is rejected (it collides with the generated
identity local).
:::

## Richer value objects

See [enums](/Koine/reference/enums/) and [value objects](/Koine/reference/value-objects/).

| Construct | `.koi` syntax (short) | Emits | Demo location |
|---|---|---|---|
| Smart enum | `enum OrderStatus { Draft, Placed, Shipped }` | `sealed class` with static instances, `Name`/`Value`, `All`, `FromName`/`FromValue`, value equality, `==`/`!=` | every `enum` |
| Enum with associated data | `enum Currency(symbol: String, decimals: Int) { EUR("€", 2) }` | each signature field becomes a get-only PascalCase property | `Currency(symbol, decimals)` |
| Quantity | `quantity Weight { amount: Decimal  unit: MassUnit }` | a value object with unit-checked `+`/`-` (throws on mixed units) and scalar `*`/`/` that preserve the unit | `Portion` |
| `Range<T>` | `window: Range<Instant>` | the runtime `Koine/Runtime/Range.cs` (`Contains`, `Overlaps`, start≤end guard); element must be `Int`, `Decimal`, or `Instant` | `HappyHour.window` |

## Specifications, services & policies

See [specs, services & policies](/Koine/reference/specs-services-policies/).

| Construct | `.koi` syntax (short) | Emits | Demo location |
|---|---|---|---|
| Specification | `spec IsVip on Customer = …` | an extension-method predicate `bool IsVip(this Customer x)` in `<Context>Specifications.cs`; call as `customer.IsVip()`; reusable in invariants | `Promotions.IsFreeOrder` (on `Discount`) |
| Domain service (pure) | `service LoyaltyService { operation discountRate(…): Decimal = … }` | a `sealed class` with one expression-bodied method per operation | `Promotions.DiscountService` |
| Domain service (seam) | `service Calc { operation run(a: Int): Int }` | an `abstract class` with abstract method seams | (any bodyless operation) |
| Policy | `policy PostToLedger when ChargeCaptured then Books.record(…)` | `IPostToLedgerPolicy` + an abstract `PostToLedgerPolicy` seam (the reaction is a doc sketch, not executed code) | `Payment.PostToLedger` |

## Identity, repositories & concurrency

See [repositories & concurrency](/Koine/reference/repositories-concurrency/) and
[entities and identity](/Koine/reference/entities-and-identity/).

| Construct | `.koi` syntax (short) | Emits | Demo location |
|---|---|---|---|
| Guid identity (default) | `identified by OrderId` | a Guid-backed id value object with a `New()` generator | most aggregates |
| Natural key | `identified by ProductCode as natural(String)` | a `String`/`Int`-backed id, value equality, **no** `New()`; blanks rejected | `Pizza` (`PizzaCode`) |
| Sequence identity | `identified by InvoiceNo as sequence` | a `long`-backed id, no `New()` (the store assigns it) | sequence ids |
| Repository interface | (any aggregate root) | `I<Root>Repository` with `GetByIdAsync`/`AddAsync`/`UpdateAsync`/`RemoveAsync` | every aggregate |
| Repository operations + finders | `repository { operations: add, getById  find byCustomer(…): List<Order> }` | tunes the mutating set; `find` → async `…Async` (list → `IReadOnlyList<>`, single → `Root?`) | `Ordering`: `byCustomer`, `mostRecent` |
| Optimistic concurrency | `aggregate Order root Order versioned { … }` | a get-only `Version`; `Koine.Runtime.ConcurrencyConflictException` on stale writes | `Order` |

:::caution
Repository operation names are a closed set: `getById`, `add`, `update`, `remove`. The `operations:` clause
must come before any `find`. A root member literally named `version` collides with the synthesized `Version`
on a `versioned` aggregate.
:::

## Application layer & CQRS

See [application layer & CQRS](/Koine/reference/application-cqrs/) and the
[application-layer tutorial](/Koine/tutorials/application-layer/).

| Construct | `.koi` syntax (short) | Emits | Demo location |
|---|---|---|---|
| Unit of Work | (≥1 aggregate in a context) | `<Context>/IUnitOfWork.cs` with one `I<Root>Repository` property per aggregate (pluralized) + `SaveChangesAsync` | `Payment.IUnitOfWork` (Billing + Books), Menu, Ordering |
| Application service | `service OrderingService { usecase PlaceOrder(…): OrderId }` | `IOrderingService` with one async method per use case (`Task`/`Task<T>`; `List<T>` params → `IReadOnlyList<T>`) | `Ordering.IOrderingService` |
| Read model + projection | `readmodel OrderSummary from Order { id  customer  lineCount: Int = lines.count }` | a `sealed record` + a static `ToOrderSummary(this Order src)` projection mapper | `Menu.MenuItem`, `Ordering.OrderSummary` |
| Query object | `query OrdersByStatus(status: OrderStatus): List<OrderSummary>` | a query DTO `record` + the shared `Koine.Runtime.IQueryHandler<TQuery, TResult>` | `PizzasBySize`, `PizzaByCode`, `OrdersByStatus` |

:::note
A query's result type is required and must be a read model (or `List<readmodel>`). `IQueryHandler<TQuery, TResult>`
is emitted exactly once for the whole model.
:::

## Multi-file, imports & modules

See [multi-file, imports & modules](/Koine/reference/multi-file-imports-modules/) and the
[multiple contexts tutorial](/Koine/tutorials/multiple-contexts/).

| Construct | `.koi` syntax (short) | Emits | Demo location |
|---|---|---|---|
| Directory compilation | `koine build templates/pizzeria/ …` | every `*.koi` under the directory merges into one model | the whole `templates/pizzeria` folder |
| Named import | `import Menu.{ Topping }` | a precise `using Menu;`; names usable unqualified | `Kitchen` imports `Menu.{ Topping }` |
| Wildcard import | `import Menu.*` | resolves all exported names from the context | (companion form) |
| Qualified reference | `address: Menu.Topping` | a fully-qualified C# type, no `using` added | cross-context refs |
| Module | `module Line { … }` | a `<Context>.<Module>` sub-namespace + sub-folder | `Kitchen.Line` |

## Context maps & integration events

See [context maps & integration events](/Koine/reference/context-maps-integration/) and the
[multiple contexts tutorial](/Koine/tutorials/multiple-contexts/). The map is **enforced** and
**drives emission**.

| Construct | `.koi` syntax (short) | Emits | Demo location |
|---|---|---|---|
| Context map | `contextmap { Menu -> Kitchen : conformist }` | no type by itself; validates and permits cross-context references | `context-map.koi` (8 relationships) |
| Relation roles | `partnership`, `shared-kernel`, `customer-supplier`, `conformist`, `anti-corruption-layer`, `open-host`, `published-language` | each role gates references/subscriptions differently | the map relations |
| Shared kernel | `Menu <-> Ordering : shared-kernel { Currency }` | the shared type emitted **once** into `Menu__Ordering/Kernel/`; partners get a precise `using` | `Currency` |
| Anti-corruption layer | `Gateway -> Payment : anti-corruption-layer` + `acl { Gateway.GatewayResult -> Payment.PaymentReceipt }` | a translator interface `IGatewayToPaymentTranslator` in the downstream context | `Gateway -> Payment` |
| Integration event | `integration event OrderPlaced { … }` | a `sealed record : IIntegrationEvent`; the marker is emitted once | `Ordering.OrderPlaced`, `Kitchen.TicketReady` |
| Publish | `publishes OrderPlaced` | marks the event as a published surface; authorizes subscribers | `Ordering`, `Kitchen` |
| Subscribe | `subscribes Ordering.OrderPlaced` | an `IHandleOrderPlaced` handler interface with the fully-qualified event type | `Kitchen`, `Delivery`, `Payment` |

:::caution
A `subscribes` needs an authorizing relation in the map: `open-host` or `customer-supplier` from publisher to
subscriber. `conformist` does **not** authorize a subscription. Integration-event fields must be
cross-boundary-safe (primitives, enums, `*Id`s, other integration events) — leaking a value object or domain
event is an error.
:::

A context may even subscribe to **two same-named events from different publishers** (e.g. both
`Sales.Shipped` and `Returns.Shipped`). The bare `IHandleShipped` seam would collide, so each colliding
handler is **qualified by its publisher** — `IHandleSalesShipped` and `IHandleReturnsShipped`, each typed
on its own publisher's event. The common single-publisher case keeps the bare `IHandle<Event>` name
unchanged. The same publisher-qualification applies in the TypeScript and PHP emitters; Python emits no
per-subscription handler seam, so its same-named events simply live in their distinct context packages.

## Model versioning & evolution

See [model versioning](/Koine/reference/versioning/) and the
[evolving a model tutorial](/Koine/tutorials/evolving-a-model/).

| Construct | `.koi` syntax (short) | Emits | Demo location |
|---|---|---|---|
| Context version | `context Catalog version 2 { … }` | metadata only (glossary heading + `@since` ceiling check); byte-identical C# | `Menu version 2` |
| `@since(n)` | `@since(2) barcode: String?` | no C#; surfaces in the glossary as `since v2`; warns (KOI1501) if above the context version | `Pizza.kcal @since(2)` |
| `@deprecated("reason")` | `@deprecated("use amount") legacyAmount: Decimal` | `[Obsolete("reason")]` on the property/class + `using System;` | deprecation markers |
| Backward-compat check | `koine check v2 --baseline v1` | compares **published** surfaces; exits non-zero on breaking changes | `examples/versioning/` |

:::tip
`koine check` only flags changes to **published** surfaces — integration events, shared-kernel types, and
open-host value objects. Internal refactors are ignored. Adding an optional field (`note: String?`) is
non-breaking; removing a published field or making it required is breaking.
:::

## Developer tooling

Not language constructs, but the commands and editor support that make `.koi` pleasant to write. See
the [CLI reference](/Koine/guides/cli/) and [editor tooling](/Koine/guides/editor-tooling/).

| Tool | Invocation | What it does | Reference |
|---|---|---|---|
| Formatter | `koine fmt <path> [--check]` | Canonically, idempotently reformats `.koi` in place; `--check` verifies without writing (CI gate) | [CLI](/Koine/guides/cli/#koine-fmt) |
| Project scaffold | `koine init [dir] [--force]` | Writes a buildable starter `domain.koi`, `koine.config`, and `README.md`; `--force` overwrites | [CLI](/Koine/guides/cli/#koine-init) |
| Watch mode | `koine watch <path> [--out <dir>]` | Re-emits (or re-validates) on every `.koi` change with debounced fast feedback | [CLI](/Koine/guides/cli/#koine-watch) |
| Language server | `koine lsp` | LSP over stdio: live diagnostics, hover, completion, and cross-file go-to-definition | [Editor tooling](/Koine/guides/editor-tooling/) |
| TextMate grammar | (editor extension) | Syntax highlighting for `.koi` in VS Code and Rider | [Editor tooling](/Koine/guides/editor-tooling/) |

:::tip[Optionality is a feature, not a footnote]
Null-safety is a deliberate strength of the model, not an afterthought. A field is required by default;
you opt into absence explicitly with `?` (`description: String?`), and the emitted C# carries that
through as a nullable property with `??` and `.isPresent` support. Because optionality is part of the
*published* surface, `koine check` treats making a field required (or removing an optional one) as a
breaking change — so the model and the contract stay honest about what may legitimately be missing.
:::

## See also

- [What is Koine?](/Koine/start/what-is-koine/) — the one-page pitch.
- [Reference overview](/Koine/reference/overview/) — the language reference index.
- [Reading the output](/Koine/start/reading-the-output/) — how the emitted C# is laid out.
