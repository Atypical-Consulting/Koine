# Ubiquitous Language Glossary

## Catalog — version 2

### Currency — enum

Values: EUR, USD, GBP

### MassUnit — enum

Values: Gram, Kilogram

### Availability — enum

Values: InStock, OutOfStock, Discontinued

### Sku — value

| Field | Type | Description |
| --- | --- | --- |
| code | `String` |  |
| normalized | `String` | _derived_ |

**Business rules**
- a SKU cannot be blank
- SKU must look like ABC-1234

### Price — value

| Field | Type | Description |
| --- | --- | --- |
| amount | `Decimal` |  |
| currency | `Currency` |  |

**Business rules**
- a price cannot be negative

### Weight — quantity

| Field | Type | Description |
| --- | --- | --- |
| amount | `Decimal` |  |
| unit | `MassUnit` |  |

**Business rules**
- a weight cannot be negative

### SalePeriod — value

| Field | Type | Description |
| --- | --- | --- |
| window | `Range<Instant>` |  |

### ProductCatalog — aggregate (root: Product)

#### Product — entity

Identified by `ProductCode`.

| Field | Type | Description |
| --- | --- | --- |
| sku | `Sku` |  |
| name | `String` |  |
| price | `Price` |  |
| weight | `Weight` |  |
| availability | `Availability` |  |
| description | `String?` |  |
| tags | `Set<String>` |  |
| sale | `SalePeriod?` |  |
| barcode | `String?` | _(since v2)_ |
| displayName | `String` | _derived_ |
| summary | `String` | _derived_ |
| isAvailable | `Bool` | _derived_ |
| onSale | `Bool` | _derived_ |

## Customers — version 1

### LoyaltyTier — enum

Values: Bronze, Silver, Gold

### Email — value

| Field | Type | Description |
| --- | --- | --- |
| raw | `String` |  |
| normalized | `String` | _derived_ |

**Business rules**
- an email cannot be blank
- invalid email address

### PostalAddress — value

| Field | Type | Description |
| --- | --- | --- |
| street | `String` |  |
| city | `String` |  |
| postalCode | `String` |  |
| country | `String` |  |
| formatted | `String` | _derived_ |

### Customer — entity

Identified by `CustomerId`.

| Field | Type | Description |
| --- | --- | --- |
| name | `String` |  |
| email | `Email` |  |
| shippingAddress | `PostalAddress` |  |
| tier | `LoyaltyTier` |  |
| nickname | `String?` |  |
| phone | `String?` |  |
| displayName | `String` | _derived_ |
| hasPhone | `Bool` | _derived_ |
| segments | `Set<String>` |  |
| freeShipping | `Bool` | _derived_ |

### Specifications

- `IsVip` on `Customer`

### Services

- **LoyaltyService**
  - `discountRate(tier: LoyaltyTier): Decimal`

## Legacy — version 1

Legacy bounded context — an external payment gateway whose model we do not control. Payments shields itself from it with an anti-corruption layer (R14.2).

### GatewayResult — value

The raw result the legacy gateway returns. Payments never references this directly — it goes through the generated translator interface.

| Field | Type | Description |
| --- | --- | --- |
| rawReference | `String` |  |
| rawAmount | `Decimal` |  |

## Ordering — version 1

Ordering bounded context — placing and pricing customer orders.

### RefundStatus — enum

How far along a refund is. Shares the `Cancelled` member with OrderStatus — bare members resolve against the field/operand enum type (R3.5).

Values: None, Pending, Cancelled

### OrderStatus — enum

The lifecycle state of an order.

Values: Draft, Submitted, Paid, Shipped, Cancelled

### Money — value

A monetary amount in a specific currency. Never negative. `Currency` is a shared-kernel type owned with Catalog (see context-map.koi).

| Field | Type | Description |
| --- | --- | --- |
| amount | `Decimal` |  |
| currency | `Currency` |  |

**Business rules**
- an amount cannot be negative

### OrderPlaced — integration event

Announced to the rest of the system when an order is placed (R14.3). An integration event is a *published language* — its fields stay primitive (ids/scalars), never leaking internal value objects.

| Field | Type | Description |
| --- | --- | --- |
| orderId | `OrderId` |  |
| customer | `CustomerId` |  |
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

#### OrderSubmitted — event

Raised when an order is submitted for processing (R6).

| Field | Type | Description |
| --- | --- | --- |
| orderId | `OrderId` |  |
| lineCount | `Int` |  |

#### OrderLine — value

One line of an order: a product, a quantity, and a unit price.

| Field | Type | Description |
| --- | --- | --- |
| product | `ProductId` |  |
| quantity | `Int` | How many units of the product. At least one. |
| unitPrice | `Money` |  |
| lineTotal | `Money` | _derived_ |
| payable | `Money` | _derived_ — What the customer actually pays for this line (10% off at 10+ units). |

**Business rules**
- an order line needs at least one unit

#### Order — entity

The order a customer places — the consistency boundary of this aggregate.

Identified by `OrderId`.

| Field | Type | Description |
| --- | --- | --- |
| customer | `CustomerId` |  |
| lines | `List<OrderLine>` |  |
| status | `OrderStatus` |  |
| refund | `RefundStatus` |  |
| submittedAt | `Instant?` |  |
| total | `Money` | _derived_ |
| lineCount | `Int` | _derived_ |
| isPlaced | `Bool` | _derived_ |
| isCancelled | `Bool` | _derived_ |
| isRefunded | `Bool` | _derived_ |

**Business rules**
- every line needs a positive quantity
- no duplicate products in an order
- status == Draft when lines.isEmpty

### Services

- **OrderingService** — R12.2 — the application/use-case service interface (IOrderingService). Each use case maps to one async method; a context with aggregates also gets a UoW.

## Payments — version 1

Payments bounded context — authorizing and capturing money for orders.

### PaymentMethod — enum

Values: Card, Transfer, Voucher

### PaymentStatus — enum

Values: Authorized, Captured, Refunded, Failed

### Money — value

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

### PaymentCaptured — event

Recorded when a payment is captured. Triggers the ledger-posting policy.

| Field | Type | Description |
| --- | --- | --- |
| payment | `PaymentId` |  |
| capturedAmount | `Decimal` |  |

### Payment — aggregate (root: Payment)

The payment aggregate.

#### PaymentAuthorized — event

Raised when a payment is authorized (R6/R8).

| Field | Type | Description |
| --- | --- | --- |
| payment | `PaymentId` |  |
| order | `OrderId` |  |

#### Payment — entity

Identified by `PaymentId`.

| Field | Type | Description |
| --- | --- | --- |
| order | `OrderId` |  |
| amount | `Money` |  |
| method | `PaymentMethod` |  |
| status | `PaymentStatus` |  |

### Ledger — aggregate (root: LedgerEntry)

A second aggregate — the revenue ledger. Two aggregates in one context means the generated IUnitOfWork exposes both repositories (R12.1).

#### LedgerEntry — entity

Identified by `LedgerEntryId`.

| Field | Type | Description |
| --- | --- | --- |
| payment | `PaymentId` |  |
| balance | `Decimal` |  |

### Policies

- **PostToLedger** — when `PaymentCaptured` then `Ledger.record`

## Shipping — version 1

Shipping bounded context — getting orders to customers.

### ShipmentStatus — enum

Values: Pending, Dispatched, Delivered, Returned

### Shipment — aggregate (root: Shipment)

#### ShipmentScheduled — event

Raised when a shipment is scheduled (R6/R8).

| Field | Type | Description |
| --- | --- | --- |
| shipment | `ShipmentId` |  |
| order | `OrderId` |  |

#### Shipment — entity

Identified by `ShipmentId`.

| Field | Type | Description |
| --- | --- | --- |
| order | `OrderId` |  |
| destination | `PostalAddress` |  |
| weight | `Weight` |  |
| status | `ShipmentStatus` |  |
