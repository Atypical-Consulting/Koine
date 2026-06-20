# Koine language reference (cheatsheet)

Koine is a DSL for Domain-Driven Design. You write a bounded context's ubiquitous language in
`.koi` files; the compiler emits idiomatic, self-contained C#. The reference below is a compact
cheatsheet. For canonical, compilable syntax, also call `koine_examples` (`billing` for a small
single-context model; `pizzeria-*` for a multi-context domain). Validate everything with `koine_validate`.

Topics you can request via `koine_reference("<topic>")`:
`overview`, `types`, `value`, `entity`, `aggregate`, `enum`, `quantity`, `range`, `expressions`,
`invariants`, `command`, `event`, `state`, `factory`, `repository`, `service`, `readmodel`, `query`,
`spec`, `policy`, `integration-event`, `module`, `import`, `context-map`, `versioning`, `coverage`.

<!-- topic: overview -->
## Overview & file shape

A `.koi` file declares one or more top-level **bounded contexts** (and, optionally, one
`contextmap`). Tactical building blocks (value objects, entities, aggregates, enums, services, …)
live inside a `context`. In directory mode every `.koi` file under a folder compiles as **one
model**, so contexts of the same name merge and cross-file imports / context maps resolve.

```koine
context Billing {
  enum Currency { EUR, USD, GBP }

  value Money {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0 "must be >= 0"
  }

  entity Customer identified by CustomerId {
    name:  String
    email: Email
  }
}
```

- A context may carry a version: `context Ordering version 1 { … }` (used by model versioning).
- `///` doc comments above a declaration become the ubiquitous-language glossary/XML docs.
- **Fields are separated by newlines, one per line** — `;` and `,` are NOT field separators (a
  `;` inside a `{ … }` body is a `KOI0001` token error). Run `koine_format` to canonicalize layout.
- **Member order inside an entity / aggregate root is fixed and parser-enforced:** fields → derived
  fields → invariants → `states` → `command`s → `create` factories (always last). An `invariant`
  after a `command`, or a `command` after a `create`, is a parse error
  (`extraneous input … expecting {'create','}'}`).

<!-- topic: types -->
## Type system

Primitives and their C# mapping:

| Koine | C# |
|-------|----|
| `String` | `string` |
| `Int` | `int` |
| `Decimal` | `decimal` (money / quantities) |
| `Bool` | `bool` |
| `Instant` | `DateTimeOffset` |

Type modifiers and built-in generics:

- `T?` — optional/nullable field (use `.isPresent` / `.isNone`, and `??` to coalesce).
- `List<T>` → `IReadOnlyList<T>` (defensively copied). `Set<T>` → `IReadOnlySet<T>`.
  `Map<K,V>` → `IReadOnlyDictionary<K,V>`. `Range<T>` → an interval value (Start/End/Contains/Overlaps).
- Referencing another declared type (value/entity/enum) by name uses it directly. An entity's
  generated id type (e.g. `OrderId`) is itself a usable type.

<!-- topic: value -->
## Value objects (`value`)

Immutable, value-equal records validated in their constructor.

```koine
value Email {
  raw:        String
  normalized: String = raw.trim.lower          // derived (computed, get-only) field
  invariant raw.trim.length > 0           "an email cannot be blank"
  invariant raw matches /^[^@]+@[^@]+\.[^@]+$/  "invalid email address"
}
```

- `name: Type` — a property + constructor parameter.
- `name: Type = const` — a default value for the parameter.
- `name: Type = expr` — a **derived** get-only property computed from sibling fields (NOT a ctor param).
- `invariant …` — a constructor guard (see the `invariants` topic).

<!-- topic: entity -->
## Entities (`entity`)

Identity-based objects (equality by id). The id type is generated.

```koine
entity Order identified by OrderId {
  customer: CustomerId
  lines:    List<OrderLine>
  status:   OrderStatus = Draft
}
```

Identity strategies:

- `identified by OrderId` — generated `OrderId` wrapping a `Guid` (default).
- `identified by ProductCode as natural(String)` — a natural key (also `natural(Int)`); no client-side `New()`.
- `identified by … as sequence` — a sequence-assigned id.

Entities can also declare `command`s, a `states` machine, and `create` factories (see those topics).
**These members must appear in a fixed, parser-enforced order:** fields → derived fields →
invariants → `states` → `command`s → `create` (always last). Reordering them — e.g. an `invariant`
after a `command`, or a `command` after a `create` — is a parse error.

<!-- topic: aggregate -->
## Aggregates (`aggregate`)

A consistency boundary with a single **root** entity. Nested value objects / entities / enums /
events are declared inside it.

```koine
aggregate Order root Order versioned {
  repository {
    operations: getById, add, update
    find byCustomer(customer: CustomerId): List<Order>
  }
  event OrderSubmitted {
    orderId:   OrderId
    lineCount: Int
  }
  value OrderLine {
    product:   ProductId
    quantity:  Int
    unitPrice: Money
  }
  entity Order identified by OrderId { /* root: fields → derived → invariants → states → commands → create */ }
}
```

- The root implements `IAggregateRoot`; an `I<Root>Repository` contract is emitted; a context with
  aggregates also gets an `IUnitOfWork`.
- `versioned` adds an optimistic-concurrency `Version` token (+ `ConcurrencyConflictException`).

<!-- topic: enum -->
## Enums (`enum`)

Self-contained smart enums (static instances, `Name`/`Value`/`All`/`FromName`/`FromValue`, value equality).

```koine
enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }

// Enum members carrying associated data:
enum Currency(symbol: String, decimals: Int) {
  EUR("€", 2)
  USD("$", 2)
  GBP("£", 2)
}
```

A bare member (e.g. `Cancelled`) in an expression resolves against the operand's enum type; qualify
it (`RefundStatus.Cancelled`) to disambiguate when two enums share a member name.

<!-- topic: quantity -->
## Quantities (`quantity`)

A `Decimal` amount paired with an enum unit, with generated **unit-checked** arithmetic (adding
Grams to Kilograms throws).

```koine
enum MassUnit { Gram, Kilogram }
quantity Weight {
  amount: Decimal
  unit:   MassUnit
  invariant amount >= 0 "a weight cannot be negative"
}
```

<!-- topic: range -->
## Ranges (`Range<T>`)

The built-in `Range<T>` is an interval value with `Start`/`End`, a `start <= end` invariant, and
`Contains`/`Overlaps`. Use it as a field type:

```koine
value SalePeriod { window: Range<Instant> }
```

<!-- topic: expressions -->
## Expression sublanguage

Small and pure (no statements, no I/O). Used in derived fields, invariants, `requires`, specs, and
service operations.

- Comparisons: `== != < <= > >=`  •  Arithmetic: `+ - * /`  •  Logical: `&& || !`
- Conditional: `if cond then a else b` (chainable).
- Null handling: `a ?? b`, `x.isPresent`, `x.isNone`.
- Strings: `.length`, `.trim`, `.lower`, `.upper`, `.isBlank`, `.startsWith(...)`, `.endsWith(...)`, `.contains(...)`.
- Collections: `.count`, `.isEmpty`, `.isNotEmpty`, `.sum(x => expr)`, `.min`/`.max`,
  `.all(x => expr)`, `.any(x => expr)`, `.none(x => expr)`, `.contains(...)`, `.distinctBy(x => expr)`.
- Regex: `field matches /pattern/`.

**Collections are immutable and there is NO append / concat operator.** `list + element` does not add
an item — for a non-numeric element type it errors (`KOI0502`), and for a numeric one it may slip past
validation yet emit non-compiling code. To change a collection field, assign a **whole** new collection:
take a `List<T>` parameter and replace the field wholesale.

```koine
// NOT supported:  toppings -> toppings + topping
command reviseRecipe(newToppings: List<Topping>) {   // accept the full new list
  requires newToppings.isNotEmpty "a pizza needs at least one topping"
  toppings -> newToppings                            // assign it wholesale
}
```

```koine
total:    Money = lines.sum(l => l.payable)
payable:  Money = if quantity >= 10 then lineTotal * 0.9 else lineTotal
isPlaced: Bool  = submittedAt.isPresent
```

<!-- topic: invariants -->
## Invariants

Constructor guards. A violation throws `DomainInvariantViolationException`.

```koine
invariant amount >= 0                      "a monetary amount cannot be negative"
invariant code matches /^[A-Z]{3}-[0-9]{4}$/ "SKU must look like ABC-1234"   // regex guard
invariant status == Draft when lines.isEmpty                                  // conditional guard
invariant lines.all(l => l.quantity >= 1)  "every line needs a positive quantity"
invariant lines.distinctBy(l => l.product) "no duplicate products in an order"
```

`invariant <body> when <cond>` only enforces `<body>` when `<cond>` holds.

<!-- topic: command -->
## Commands (`command`)

A state transition on the root entity: preconditions, field assignments, and emitted events.

```koine
command submit {
  requires status == Draft "only a draft order can be submitted"
  requires !lines.isEmpty  "cannot submit an empty order"
  status      -> Submitted
  submittedAt -> now                                   // `now` stamps the current Instant
  emit OrderSubmitted(orderId: id, lineCount: lines.count)
}
```

- `requires <expr> "msg"` — a precondition.
- `field -> value` — assign a new value (a state field's target must be a legal `states` transition).
- `emit Event(arg: expr, …)` — record a domain event.
- **Avoid naming a parameter the same as the field it assigns.** In `field -> param`, a parameter
  that shadows the field makes the right-hand side ambiguous; name it distinctly (e.g. a parameter
  `newToppings` assigning the field `toppings`).

<!-- topic: event -->
## Domain events (`event`) 

Immutable records of something that happened, declared inside the aggregate and recorded via `emit`.

```koine
event OrderOpened {
  orderId:   OrderId
  customer:  CustomerId
  lineCount: Int
}
```

<!-- topic: state -->
## State machines (`states`)

The legal lifecycle of a state field. Commands may only transition along these edges.

```koine
states status {
  Draft     -> Submitted, Cancelled
  Submitted -> Paid, Cancelled
  Paid      -> Shipped, Cancelled
  Shipped              // terminal
  Cancelled            // terminal
}
```

<!-- topic: factory -->
## Factories (`create`)

Named, validated construction. Declaring any `create` makes the all-args constructor private, so
callers must go through the factory (e.g. `Order.Open(...)`). A `create` must be the **last** member of
its entity (after fields, invariants, `states`, and `command`s).

```koine
create open(customer: CustomerId, lines: List<OrderLine>) {
  requires !lines.isEmpty "cannot open an empty order"
  emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
}
```

- **Fields are initialized by parameter-name match:** each parameter whose name equals a field
  (`customer`, `lines`) sets that field. A required field with no matching parameter and no default /
  `?` is left uninitialized and raises `KOI0806` — give it a same-named parameter, a default, or make
  it optional.

<!-- topic: repository -->
## Repositories (`repository`)

Tunes the aggregate root's repository: its mutating operations plus intention-revealing finders.

```koine
repository {
  operations: getById, add, update
  find byCustomer(customer: CustomerId): List<Order>
  find mostRecent(customer: CustomerId): Order
}
```

Async `GetByIdAsync`/`AddAsync`/`UpdateAsync`/`RemoveAsync` plus a typed method per `find` are emitted.

<!-- topic: service -->
## Services (`service`)

Two flavours:

```koine
// Application service: one async use-case method each; a context with aggregates also gets a UoW.
service OrderingService {
  usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
  usecase CancelOrder(order: OrderId)
}

// Domain service: a pure operation with an expression body (or an abstract seam if bodyless).
service LoyaltyService {
  operation discountRate(tier: LoyaltyTier): Decimal =
    if tier == Gold then 0.10 else if tier == Silver then 0.05 else 0.0
}
```

<!-- topic: readmodel -->
## Read models (`readmodel`)

A flat, value-equal DTO projected from a source type, plus a static `To<Name>(this Src)` mapper.

```koine
readmodel OrderSummary from Order {
  id
  customer
  status
  lineCount: Int = lines.count      // derived projection field
}
```

<!-- topic: query -->
## Queries (`query`)

A query DTO handled through the shared generic `IQueryHandler<TQuery, TResult>`.

```koine
query OrdersByStatus(status: OrderStatus): List<OrderSummary>
query ProductByCode(code: ProductCode): ProductCard
```

<!-- topic: spec -->
## Specifications (`spec`)

A named, reusable predicate over a type, emitted as a static method (`<Context>Specifications.<Name>`).

```koine
spec IsVip on Customer = tier == Gold
```

<!-- topic: policy -->
## Policies (`policy`)

A reaction to an event: emits a handler interface / abstract seam (never auto-invoked).

```koine
policy NotifyOnPlaced when OrderPlaced then Notifications.send(order: orderId)
```

<!-- topic: integration-event -->
## Integration events (`integration event`)

A **published language** announced to other contexts. Its fields stay primitive (ids/scalars) and
never leak internal value objects. A context declares what it `publishes`.

```koine
integration event OrderPlaced {
  orderId:  OrderId
  customer: CustomerId
  total:    Decimal
  placedAt: Instant
}
publishes OrderPlaced
```

<!-- topic: module -->
## Modules (`module`)

Namespace grouping inside a context → a `<Context>.<Module>` sub-namespace and folder.

```koine
context Shipping {
  module Fulfillment {
    // value/entity/aggregate declarations live under Shipping.Fulfillment
  }
}
```

<!-- topic: import -->
## Imports (`import`)

Bring types from another context into scope (directory/multi-file mode). An unqualified, unimported
cross-context reference is an error.

```koine
import Customers.PostalAddress      // a specific type
import Customers.*                  // everything published by Customers
```

<!-- topic: context-map -->
## Context map (`contextmap`)

A top-level strategic view (sibling of `context`, not nested). Relationship operators: `->`
(upstream → downstream) and `<->` (mutual).

```koine
contextmap {
  Catalog   <-> Ordering : shared-kernel { Currency }   // jointly owned types
  Catalog    -> Shipping : conformist
  Customers  -> Shipping : customer-supplier
  Ordering   -> Shipping : open-host                     // authorizes downstream subscriptions
  Shipping  <-> Payments : partnership
  Legacy     -> Payments : anti-corruption-layer
    acl { Legacy.GatewayResult -> Payments.PaymentReceipt }
}
```

<!-- topic: versioning -->
## Versioning (`@since`, `context … version N`)

Annotate a field with the context version that introduced it; `koine check --baseline` flags
breaking changes to published surfaces.

```koine
context Catalog version 2 {
  entity Product identified by ProductCode as natural(String) {
    name: String
    @since(2) barcode: String?     // added in v2
  }
}
```

<!-- topic: coverage -->
## Coverage (`koine_coverage`)

`koine_coverage(files, target)` reports which of a model's declared types the chosen `target`
actually emits — a quick way to confirm a target covers your whole model, or to spot what a
not-yet-complete emitter (e.g. an in-progress `typescript`) still skips. Each declared
value/entity/aggregate/enum/event/integration-event/read-model/query is matched against the
generated output and reported as `Covered` or `Missing`; the report carries `Total`/`Covered`
rollups and an `IsComplete` flag (true when nothing is `Missing`).
