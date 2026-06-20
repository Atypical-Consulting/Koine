# Ubiquitous Language Glossary

## Delivery — version 1

Delivery bounded context — getting a delivery order to the customer's door. It owns the `Address` value object (supplied downstream to nobody else here, but a customer-supplier candidate) and enforces the rule that anchors this context: a delivery order must carry a delivery address.

### DeliveryStatus — enum

How a delivery is doing. Drives the `states status { … }` machine below.

Values: Scheduled, PickedUp, EnRoute, Delivered, Failed

### Address — value

A street address a pizza can be delivered to. A first-class value object so a delivery destination is never a bare string, validated by shape and normalized via string ops (R1.2). Owned here and supplied to partners (see context-map).

| Field | Type | Description |
| --- | --- | --- |
| street | `String` |  |
| city | `String` |  |
| postalCode | `String` |  |
| country | `String` |  |
| formatted | `String` | _derived_ |

**Business rules**
- a delivery needs a street
- a delivery needs a city
- invalid postal code

### Courier — value

A driver assigned to a delivery. A small value object so an assignee is typed.

| Field | Type | Description |
| --- | --- | --- |
| name | `String` |  |
| phone | `String` |  |

**Business rules**
- a courier needs a name

### Dispatch — aggregate (root: Delivery)

The delivery aggregate: one record per delivery order. Being an aggregate root it gains an `IDeliveryRepository` and joins the context UoW; the repository block adds intention-revealing finders (R11.3).

#### DeliveryScheduled — event

Raised inside the aggregate when a delivery is scheduled by the factory (R6/R8).

| Field | Type | Description |
| --- | --- | --- |
| delivery | `DeliveryId` |  |
| order | `OrderId` |  |

#### DeliveryCompleted — event

Raised when a delivery is completed (R6).

| Field | Type | Description |
| --- | --- | --- |
| delivery | `DeliveryId` |  |

#### Delivery — entity

Identified by `DeliveryId`.

| Field | Type | Description |
| --- | --- | --- |
| order | `OrderId` |  |
| destination | `Address` |  |
| courier | `Courier?` |  |
| status | `DeliveryStatus` |  |
| assigned | `Bool` | _derived_ |
| isDelivered | `Bool` | _derived_ |

**Business rules**
- a delivery order requires a delivery address
- a delivery en route must have a courier

### Services

- **DeliveryService** — R12.2 — the application service interface (IDeliveryService).

## Kitchen — version 1

Kitchen bounded context — turning a placed order into a cooked pizza. It watches the orders Ordering publishes and runs each one through the kitchen workflow: a ticket is queued, prepped, baked, and put up on the pass. Kept in its own context so "how the kitchen cooks" evolves independently of "how an order is taken".

### Station — enum

The station a ticket is routed to. A plain enum used for load-balancing.

Values: OvenA, OvenB, Cold

### TicketStage — enum

The lifecycle state of a kitchen ticket. Drives the `states stage { … }` machine on the entity, so only the declared transitions are legal at runtime.

Values: Queued, Prepping, Baking, Ready, Served, Scrapped

### TicketReady — integration event

Raised when a ticket is finished and put up on the pass (R6). A delivery / dine-in handler reacts to it; kept primitive as a published fact.

| Field | Type | Description |
| --- | --- | --- |
| ticketId | `TicketId` |  |
| order | `OrderId` |  |
| readyAt | `Instant` |  |

### KitchenTicket — aggregate (root: KitchenTicket)

The kitchen-ticket aggregate: one ticket per order on the line. Being an aggregate root it gains an `IKitchenTicketRepository` and joins the context UoW; the repository block adds intention-revealing finders (R11.3).

#### TicketOpened — event

Raised inside the aggregate when a ticket is opened by the factory (R6/R8).

| Field | Type | Description |
| --- | --- | --- |
| ticketId | `TicketId` |  |
| order | `OrderId` |  |

#### TicketStartedBaking — event

Raised when a ticket goes into the oven (R6).

| Field | Type | Description |
| --- | --- | --- |
| ticketId | `TicketId` |  |
| station | `Station` |  |

#### KitchenTicket — entity

Identified by `TicketId`.

| Field | Type | Description |
| --- | --- | --- |
| order | `OrderId` |  |
| station | `Station` |  |
| stage | `TicketStage` |  |
| pizzas | `Int` |  |
| toppings | `List<Topping>` |  |
| startedAt | `Instant?` |  |
| isCooking | `Bool` | _derived_ |
| isDone | `Bool` | _derived_ |
| started | `Bool` | _derived_ |

**Business rules**
- a ticket must cook at least one pizza

## Menu — version 2

Menu bounded context — the catalogue of pizzas, sizes and toppings the pizzeria sells. It is the upstream that publishes the *ubiquitous language* of money and toppings; Ordering shares its `Currency` as a shared kernel and conforms to its `Topping` weight (see context-map.koi).  Version 2 of the published model (R15): a `kcal` nutrition field was added in v2, demonstrating contract evolution with `@since`.

### Currency — enum

Values: EUR("€", 2), USD("$", 2), GBP("£", 2)

### MassUnit — enum

The unit a topping's portion weight is expressed in. Drives the unit-checked arithmetic on the `Portion` quantity below.

Values: Gram, Kilogram

### Size — enum

The three pizza sizes on offer. A plain enum used for routing and pricing.

Values: Small, Medium, Large

### Availability — enum

Whether a menu item is currently sellable. Defaults to `Available`.

Values: Available, SoldOut, Seasonal

### Money — value

A monetary amount in a specific currency. Never negative. `Currency` is a shared-kernel type owned jointly with Ordering (see context-map.koi), so the same enum flows through both contexts without translation.

| Field | Type | Description |
| --- | --- | --- |
| amount | `Decimal` |  |
| currency | `Currency` |  |

**Business rules**
- a price cannot be negative

### Portion — quantity

| Field | Type | Description |
| --- | --- | --- |
| amount | `Decimal` |  |
| unit | `MassUnit` |  |

**Business rules**
- a portion weight cannot be negative

### HappyHour — value

| Field | Type | Description |
| --- | --- | --- |
| window | `Range<Instant>` |  |

### Topping — value

A topping that can be added to a pizza — pepperoni, mushrooms, extra cheese. A first-class value object so a "topping" is never just a bare string, and a rich one: it carries its own surcharge and portion weight. Exported to Kitchen, which conforms to Menu and imports it to list a ticket's toppings.

| Field | Type | Description |
| --- | --- | --- |
| name | `String` |  |
| surcharge | `Money` |  |
| portion | `Portion` |  |
| key | `String` | _derived_ |

**Business rules**
- a topping needs a name

### Catalog — aggregate (root: Pizza)

A pizza on the menu — the product the pizzeria sells. Its identity is a *natural* string key (`PizzaCode as natural(String)`, no client-side New()), and being an aggregate root it gains an `IPizzaRepository` and joins the context's generated `IUnitOfWork` (R11/R12). The `repository` block tunes the mutating set and adds intention-revealing finders (R11.3).

#### Pizza — entity

Identified by `PizzaCode`.

| Field | Type | Description |
| --- | --- | --- |
| name | `String` |  |
| size | `Size` |  |
| basePrice | `Money` |  |
| availability | `Availability` |  |
| description | `String?` |  |
| toppings | `Set<String>` |  |
| kcal | `Int?` | _(since v2)_ |
| displayName | `String` | _derived_ |
| summary | `String` | _derived_ |
| isAvailable | `Bool` | _derived_ |
| hasNutrition | `Bool` | _derived_ |

**Business rules**
- a pizza needs a name

## Ordering — version 1

Ordering bounded context — taking and pricing a customer's pizza order. This is the heart of the template: the `Order` aggregate is the headline aggregate, its lifecycle is an explicit state machine (R7), it is priced from its line items (R1), and it publishes `OrderPlaced` so Kitchen, Delivery and Payment can react.

### Fulfillment — enum

How the customer wants the order fulfilled. Drives routing into Delivery.

Values: DineIn, Pickup, Delivery

### OrderStatus — enum

The lifecycle state of an order. Drives the `states status { … }` machine on the entity, so only the transitions declared there are legal at runtime.

Values: Draft, Placed, InKitchen, OutForDelivery, Completed, Cancelled

### Money — value

A monetary amount in a specific currency. Never negative. `Currency` is a shared-kernel type owned jointly with Menu (see context-map.koi) — the same enum flows through both contexts without translation.

| Field | Type | Description |
| --- | --- | --- |
| amount | `Decimal` |  |
| currency | `Currency` |  |

**Business rules**
- an amount cannot be negative

### OrderPlaced — integration event

Announced to the rest of the system when an order is placed (R14.3). An integration event is a *published language* — its fields stay primitive (ids/scalars/enums), never leaking internal value objects. Kitchen, Delivery and Payment all subscribe to it (authorized by the open-host relations).

| Field | Type | Description |
| --- | --- | --- |
| orderId | `OrderId` |  |
| customer | `CustomerId` |  |
| fulfillment | `Fulfillment` |  |
| total | `Decimal` |  |
| placedAt | `Instant` |  |

### Order — aggregate (root: Order)

The order aggregate. `versioned` adds an optimistic-concurrency token (R11.4); the `repository` block tunes the mutating set and adds intention-revealing finders (R11.3); being an aggregate it also joins the context `IUnitOfWork`.

#### OrderOpened — event

Raised when an order is opened by the factory (R6/R8).

| Field | Type | Description |
| --- | --- | --- |
| orderId | `OrderId` |  |
| customer | `CustomerId` |  |
| lineCount | `Int` |  |

#### OrderPlacedInternally — event

Raised when an order is placed for processing (R6).

| Field | Type | Description |
| --- | --- | --- |
| orderId | `OrderId` |  |
| lineCount | `Int` |  |

#### OrderCancelled — event

Raised when an order is cancelled (R6).

| Field | Type | Description |
| --- | --- | --- |
| orderId | `OrderId` |  |

#### OrderLine — value

One line of an order: a pizza, how many, and the unit price. The pricing value object of the template — it derives its own totals.

| Field | Type | Description |
| --- | --- | --- |
| pizza | `PizzaCode` |  |
| quantity | `Int` | How many of this pizza. At least one. |
| unitPrice | `Money` |  |
| lineTotal | `Money` | _derived_ |
| payable | `Money` | _derived_ — What the customer actually pays for this line (10% off at 5+ pizzas). |

**Business rules**
- an order line needs at least one pizza

#### Order — entity

The order a customer places — the consistency boundary of this aggregate.

Identified by `OrderId`.

| Field | Type | Description |
| --- | --- | --- |
| customer | `CustomerId` |  |
| fulfillment | `Fulfillment` |  |
| lines | `List<OrderLine>` |  |
| status | `OrderStatus` |  |
| placedAt | `Instant?` |  |
| total | `Money` | _derived_ |
| lineCount | `Int` | _derived_ |
| isPlaced | `Bool` | _derived_ |
| isCancelled | `Bool` | _derived_ |
| isDelivery | `Bool` | _derived_ |

**Business rules**
- every line needs a positive quantity
- no duplicate pizzas in an order
- status == Draft when lines.isEmpty

### Services

- **OrderingService** — R12.2 — the application/use-case service interface (IOrderingService). Each use case maps to one async method; a context with aggregates also gets a UoW.

## Payment — version 1

Payment bounded context — charging the customer for an order and keeping the books. It is downstream of a third-party card gateway whose model we do NOT control, so it shields itself with an anti-corruption layer (R14.2): the raw gateway result is translated into our own `PaymentReceipt` (the acl block lives in context-map.koi). Two aggregates — Billing and Ledger — exercise a multi- aggregate context with a cross-aggregate policy.  Naming note: the root entity is `Charge`, deliberately NOT `Payment`. A C# type must not share its enclosing namespace's name, and this context emits into a `Payment` namespace; an entity called `Payment` would collide with it, exactly as the demo avoided by pairing a `Payments` context with a `Payment` entity.

### PaymentMethod — enum

Values: Card, Cash, Voucher

### ChargeStatus — enum

Values: Authorized, Captured, Refunded, Failed

### Money — value

A monetary amount. `currency` is intentionally a primitive String, not the shared-kernel `Currency` enum: Payment is downstream of the shared kernel and does not import Currency (see context-map.koi), so it keeps money's currency loose to match whatever the gateway hands back.

| Field | Type | Description |
| --- | --- | --- |
| amount | `Decimal` |  |
| currency | `String` |  |

**Business rules**
- an amount cannot be negative

### PaymentReceipt — value

| Field | Type | Description |
| --- | --- | --- |
| reference | `String` |  |
| amount | `Decimal` |  |

**Business rules**
- a receipt amount cannot be negative

### ChargeCaptured — event

Recorded when a charge is captured. Triggers the ledger-posting policy.

| Field | Type | Description |
| --- | --- | --- |
| charge | `ChargeId` |  |
| capturedAmount | `Decimal` |  |

### Billing — aggregate (root: Charge)

The charge aggregate — one charge against an order.

#### ChargeAuthorized — event

Raised when a charge is authorized by the factory (R6/R8).

| Field | Type | Description |
| --- | --- | --- |
| charge | `ChargeId` |  |
| order | `OrderId` |  |

#### Charge — entity

Identified by `ChargeId`.

| Field | Type | Description |
| --- | --- | --- |
| order | `OrderId` |  |
| amount | `Money` |  |
| method | `PaymentMethod` |  |
| status | `ChargeStatus` |  |
| isSettled | `Bool` | _derived_ |

### Books — aggregate (root: LedgerEntry)

A second aggregate — the revenue ledger. Two aggregates in one context means the generated IUnitOfWork exposes both repositories (R12.1).

#### LedgerEntry — entity

Identified by `LedgerEntryId`.

| Field | Type | Description |
| --- | --- | --- |
| charge | `ChargeId` |  |
| balance | `Decimal` |  |

### Services

- **PaymentService** — R12.2 — the application service interface (IPaymentService).

### Policies

- **PostToLedger** — when `ChargeCaptured` then `Books.record`

## Gateway — version 1

Gateway bounded context — the external card processor whose model we do not control. Payment never references this directly; it goes through the generated anti-corruption translator interface (see the acl block in context-map.koi).

### GatewayResult — value

The raw result the third-party gateway returns. Payment shields itself from this shape with its anti-corruption layer.

| Field | Type | Description |
| --- | --- | --- |
| rawReference | `String` |  |
| rawAmount | `Decimal` |  |

## Promotions — version 1

Promotions bounded context — the deals and discounts the pizzeria runs. It owns the rule that anchors this context: a discount can lower an order's total, but it can never drive that total below zero. The rule is enforced as an invariant on a `Discount` value object, exposed as a reusable spec, and computed by a pure domain operation.

### DealKind — enum

The kind of deal a coupon represents. A plain enum used for reporting.

Values: Percentage, FixedAmount, FreeDelivery

### Coupon — value

A coupon code a customer can apply. A first-class value object so a coupon is never a bare string, validated by shape (R1.2).

| Field | Type | Description |
| --- | --- | --- |
| code | `String` |  |
| normalized | `String` | _derived_ |

**Business rules**
- a coupon code cannot be blank
- a coupon must look like PIZZA10

### Discount — value

A discount applied to an order total. THE rule of this context: the discounted total can never be negative — a deal can take the total to exactly zero (a free pizza) but no further. Both the gross total and the discount are non-negative, and the invariant proves the result stays non-negative too.

| Field | Type | Description |
| --- | --- | --- |
| kind | `DealKind` |  |
| orderTotal | `Decimal` | The order total before the discount is applied. Never negative. |
| amountOff | `Decimal` | How much money the discount takes off. Never negative. |
| discountedTotal | `Decimal` | _derived_ |

**Business rules**
- the order total cannot be negative
- a discount cannot be negative
- a discount cannot drive the order total negative

### Specifications

- `IsFreeOrder` on `Discount`

### Services

- **DiscountService** — R10.2 — a domain service with pure operations (expression bodies). `cap` clamps a requested discount so it can never exceed the order total (the safe way to build a `Discount`); `rate` gives the percentage rate for a deal kind.
  - `cap(orderTotal: Decimal, requested: Decimal): Decimal`
  - `rate(kind: DealKind): Decimal`
