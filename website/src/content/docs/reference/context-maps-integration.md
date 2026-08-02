---
title: "Context maps & integration events"
description: "The strategic map — typed relationships, shared kernel, ACL, and pub/sub integration events."
---

## 17.1 General

A single `.koi` model usually holds several bounded contexts. The **context map** is the
strategic layer that sits *between* them: a top-level `contextmap { ... }` block that names how
each context relates to its neighbours. From those typed relationships Koine decides which
cross-context references are allowed, where shared types live, which translator interfaces to
emit, and which subscriptions are authorized.

This chapter covers the map block itself, the seven relationship roles, the `shared-kernel` and
`anti-corruption-layer` sub-blocks, the `integration event` type declaration, the
`publishes` / `subscribes` pub/sub seam, and the `publish` command clause that actually produces
a published event.

## 17.2 Syntax

### 17.2.1 Context map declaration

A `contextmap` is a **top-level declaration** — a sibling of `context`, never nested inside one.
Both endpoints of every relation must be contexts you have actually declared.

```ebnf
contextMapDecl
    : 'contextmap' '{' relationDecl* '}'
    ;

relationDecl
    : typeName relationArrow typeName ':' relationRole
      ( sharedKernelBlock | aclBlock )?
    ;

relationArrow
    : '->'     // directed: upstream on the left, downstream on the right
    | '<->'    // bidirectional
    ;

relationRole
    : 'partnership'
    | 'shared-kernel'
    | 'customer-supplier'
    | 'conformist'
    | 'anti-corruption-layer'
    | 'open-host'
    | 'published-language'
    ;

sharedKernelBlock
    : '{' typeName ( ',' typeName )* ','? '}'
    ;

aclBlock
    : 'acl' '{' aclMapping+ '}'
    ;

aclMapping
    : qualifiedType '->' qualifiedType
    ;

qualifiedType
    : typeName '.' typeName
    ;
```

Each `relationDecl` is one line: an upstream context name, an arrow, a downstream context name,
a colon, and a role. The optional trailing block is only meaningful on `shared-kernel` (a type
list) or `anti-corruption-layer` (an `acl` mapping block) — attaching either to any other role
is a validator error.

### 17.2.2 Integration event declaration

An integration event is declared inside a `context` (or `module`) body as a `typeDecl`. The
two-word keyword `integration event` is followed by an identifier and a brace-delimited field
list that follows the same `member*` grammar as value objects:

```ebnf
integrationEventDecl
    : annotation* 'integration' 'event' Identifier '{' member* '}'
    ;
```

The `annotation*` prefix (`@since(N)`, `@deprecated("reason")`) follows the same versioning
annotation grammar described in [Versioning (§18)](/Koine/reference/versioning/).

### 17.2.3 Publish and subscribe declarations

Publish and subscribe declarations appear inside a `context` body alongside other `contextMember`
items:

```ebnf
publishDecl
    : 'publishes' typeName
    ;

subscribeDecl
    : 'subscribes' typeName '.' typeName
    ;
```

`publishDecl` names a local integration event; `subscribeDecl` gives the publisher context and
event name as a dotted pair (`Sales.OrderPlaced`). Forward references are legal: `publishes` may
appear before the `integration event` it names.

### 17.2.4 Primary example

```koine
context Catalog { value Sku { code: String } }
context Sales   { value Quote { n: Int } }

contextmap {
  Catalog -> Sales : conformist
}
```

Use `->` for a directed relation (upstream on the left, downstream on the right) and `<->` for
a bidirectional one:

```koine
contextmap {
  Catalog <-> Sales : partnership
}
```

:::caution
The arrows `->` and `<->` are single tokens. Keep spaces *around* them (`A -> B`) but never
*inside* them — write `<->`, not `< - >`. The role names are single hyphenated tokens too, so
write `shared-kernel`, never `shared - kernel`. Roles are case-sensitive and always lower-case.
:::

## 17.3 Semantics

### 17.3.1 Map-level rules

The map emits no C# type of its own — it *drives* validation and downstream emission. The
compiler enforces:

| Situation | Diagnostic |
| --- | --- |
| Endpoint is not a declared context | `ContextMapUnknownContext` |
| A context related to itself (`A -> A`) | `SelfRelation` |
| The same pair declared twice (order-insensitive for `<->`) | `DuplicateContextRelation` |

In **directory mode** (`koine build <dir>`) every `.koi` file compiles as one model, so the
map can live in its own `map.koi` file and still name contexts declared elsewhere. Multiple
`contextmap` blocks — even across files — merge deterministically into one map.

### 17.3.2 The seven roles

Every relation carries exactly one of the seven classic strategic DDD roles, each spelled as a
single token:

| Role | What it does in Koine |
| --- | --- |
| `partnership` | Two contexts succeed or fail together. Documentary; no auto-permit. |
| `shared-kernel` | The pair jointly owns a small set of types (see [§17.4](#174-shared-kernel)). Auto-permits references to the shared types. |
| `customer-supplier` | Upstream supplies, downstream consumes. **Authorizes** subscriptions; does *not* auto-permit direct references (import the type). |
| `conformist` | Downstream conforms to upstream's model. **Auto-permits** a direct reference to upstream types. |
| `anti-corruption-layer` | Downstream shields itself behind a translator (see [§17.5](#175-anti-corruption-layer)). |
| `open-host` | Upstream publishes a service for anyone. **Authorizes** subscriptions. |
| `published-language` | Upstream commits to a stable contract. Documentary. |

:::note
The role names are the **verbatim vocabulary from Eric Evans' DDD** — `shared-kernel`,
`customer-supplier`, `anti-corruption-layer`, `open-host`, `published-language`. The hyphen is
part of the spelling and these are the *only* place hyphens appear anywhere in the language.
Everywhere else `-` is the subtraction operator and identifiers may not contain it. Each role is
a single contextual keyword valid in exactly one position: as the role after the `:` in a
`relationDecl`. Because it occupies that one slot — and is never an identifier — matching the
literature verbatim creates no ambiguity.
:::

### 17.3.3 Reference auto-permit rules

Two roles change how cross-context **references** resolve. With a `conformist` (or
`shared-kernel`) relation, the downstream context can name an upstream type directly and the
emitted file gets a precise `using` automatically — no `import` needed:

```koine
context Catalog { value Sku { code: String } }
context Sales   { value Quote { sku: Sku } }

contextmap { Catalog -> Sales : conformist }
```

`Sales/Quote.cs` is emitted with `using Catalog;` and compiles. Remove the relation and the
same field becomes an `UnimportedReference` error.

:::tip
`customer-supplier` and unrelated contexts do **not** auto-permit a direct reference. When you
need a neighbour's type across one of those, pull it in explicitly with a named import —
`import Customers.{ PostalAddress }` — which is exactly what the Shop demo's `Shipping` context
does. See [Multi-file, imports & modules (§16)](/Koine/reference/multi-file-imports-modules/) for
the import syntax.
:::

Three roles **authorize** subscriptions: `open-host` and `customer-supplier` let a downstream
context subscribe to an upstream context's published events. `conformist` does *not* — a
`subscribes` over a conformist relation is a `SubscribeNoRelation` error.

### 17.3.4 Integration event field rules

An integration event is a *published language* — its fields must be cross-boundary-safe so the
contract never leaks your internal model.

:::caution
Fields must stay primitive. Allowed types: primitives (`String`, `Decimal`, `Int`), enums,
`*Id` ids, other integration events, and `List<T>` of those. Referencing a value object, entity,
or domain event is `IntegrationEventLeaksInternals` (KOI1409). Use `List<T>` for collections —
`List` is a built-in generic.
:::

### 17.3.5 Publish and subscribe rules

| Statement | Requirement | Diagnostic if violated |
| --- | --- | --- |
| `publishes X` | `X` is an integration event in the same context | `UnknownPublishedEvent` |
| `subscribes P.X` | `P` is a known context | `SubscribeUnknownContext` |
| `subscribes P.X` | `P` actually `publishes X` | `SubscribeNotPublished` |
| `subscribes P.X` | An `open-host` or `customer-supplier` relation `P -> here` exists | `SubscribeNoRelation` |

:::note
With no context map at all, a `subscribes` is *not* flagged as a relation error — the
authorizing check only kicks in once a map exists. Subscribing twice is `DuplicateSubscribe`;
subscribing to two same-named events from different publishers is
`SubscribeHandlerNameCollision`.
:::

## 17.4 Shared kernel

### 17.4.1 Declaration

A `shared-kernel` relation can carry a brace-separated list of the types the two contexts
*jointly own*. Each shared type is emitted **once**, into a dedicated kernel namespace, instead
of being duplicated into both contexts:

```koine
context Sales {
  value Money { amount: Decimal }
  value Quote { price: Money }
}
context Shipping {
  value Label { cost: Money }
}

contextmap {
  Sales <-> Shipping : shared-kernel { Money }
}
```

### 17.4.2 Translation to C# (shared kernel)

`Money` lands in `Sales__Shipping/Kernel/Money.cs` under `namespace Sales__Shipping.Kernel;` —
and every partner file that references it (`Sales/Quote.cs`, `Shipping/Label.cs`) gets a precise
`using Sales__Shipping.Kernel;`. The kernel namespace is **order-normalized**: the two context
names are joined alphabetically with a double underscore, so it is `Sales__Shipping` whether you
write `Sales <-> Shipping` or `Shipping <-> Sales`.

### 17.4.3 Shared kernel constraints

The block is `shared-kernel { TypeA, TypeB }` — a comma-separated type list (trailing comma
allowed). Constraints:

- Only **value objects and enums** are shareable. Sharing an entity or aggregate is
  `SharedKernelNotShareable`.
- An unknown type in the block is `UnknownSharedKernelType`; the same type shared across two
  kernels is `SharedKernelTypeConflict`.
- Sharing an `*Id` (e.g. `OrderId`) is redundant — ids are already global and stay in their
  owner namespace rather than moving to the kernel.
- A non-partner context that references the shared type still needs an import (or it raises
  `UnimportedReference`).
- Attaching a `{ ... }` type list to a non-kernel role parses, but reports
  `SharedTypesOnNonKernel`. Only put it on a `shared-kernel` relation.

## 17.5 Anti-corruption layer

### 17.5.1 Declaration

An `anti-corruption-layer` relation can carry an `acl { ... }` block that maps upstream types
to downstream types. Koine turns those mappings into a **translator interface** in the downstream
context — the seam where you write the corruption-shielding glue by hand:

```koine
context Legacy {
  value Account { reference: String }
  value Charge  { amount: Decimal }
}
context Billing {
  value Customer { name: String }
  value Invoice  { total: Decimal }
}

contextmap {
  Legacy -> Billing : anti-corruption-layer
    acl { Legacy.Account -> Billing.Customer
          Legacy.Charge  -> Billing.Invoice }
}
```

### 17.5.2 Translation to C# (anti-corruption layer)

The example above emits `Billing/ILegacyToBillingTranslator.cs`:

```csharp
namespace Billing;

public interface ILegacyToBillingTranslator
{
    Billing.Customer Translate(Legacy.Account source);
    Billing.Invoice Translate(Legacy.Charge source);
}
```

The interface is named `I<Upstream>To<Downstream>Translator`, lives in the downstream namespace,
and gets one fully-qualified `Translate` method per mapping.

### 17.5.3 ACL constraints

- Each mapping is `Context.Type -> Context.Type` — both sides must be dotted (fully qualified).
- The source side must be an upstream type and the destination a downstream type, or it reports
  `AclMappingType`.
- The `acl { }` block only belongs on an `anti-corruption-layer` role (`AclOnNonAclRole`
  otherwise), and an ACL relation with **no** block emits no translator.
- Referencing an upstream type *directly* over an ACL relation is allowed but emits an
  `AclDirectUpstreamReference` **warning** — the point of an ACL is to translate, not to reach
  through.

## 17.6 Integration events

### 17.6.1 Declaration

Domain events stay inside their aggregate; an **integration event** is the cross-boundary
contract a context broadcasts to the rest of the system. Declare one with the two-word keyword
`integration event`:

```koine
context Sales {
  integration event OrderPlaced {
    orderId:  OrderId
    total:    Decimal
    placedAt: Instant
  }
}
```

### 17.6.2 Translation to C# (integration event)

The declaration above emits a `sealed record` carrying the runtime marker `IIntegrationEvent`:

```csharp
using Koine.Runtime;

namespace Sales;

public sealed record OrderPlaced : IIntegrationEvent
{
    public OrderId OrderId { get; }
    public decimal Total { get; }
    public DateTimeOffset PlacedAt { get; }
    public DateTimeOffset OccurredOn { get; init; } = DateTimeOffset.UtcNow;
    // constructor sets each field
}
```

The `Koine.Runtime.IIntegrationEvent` marker file is emitted only when at least one integration
event exists.

## 17.7 Publish and subscribe

### 17.7.1 Declaration

A context that owns an event declares `publishes <Event>`; a downstream context subscribes with
`subscribes <Publisher>.<Event>`. Together with an authorizing relation, this is the full
pub/sub triple:

```koine
context Sales {
  publishes OrderPlaced
  integration event OrderPlaced {
    orderId:  OrderId
    total:    Decimal
    placedAt: Instant
  }
}

context Shipping {
  subscribes Sales.OrderPlaced
}

contextmap {
  Sales -> Shipping : open-host
}
```

### 17.7.2 Translation to C# (subscriber handler)

The subscriber gets a handler interface — the seam you implement to react to the event:

```csharp
using System.Threading;
using System.Threading.Tasks;
using Sales;

namespace Shipping;

public interface IHandleOrderPlaced
{
    Task Handle(Sales.OrderPlaced theEvent, CancellationToken ct = default);
}
```

The event type is **fully qualified** with the publisher's namespace; the subscriber never
re-emits the publisher's record. A publish-only context (one that only `publishes`) gets no
handler interface.

### 17.7.3 Producing the event: the `publish` clause

`publishes X` declares the contract; it does not, on its own, ever produce one. The verb that
does is the **`publish` clause** — a command-body statement, a peer of `requires`, `->` and
`emit`, written in the aggregate **root**'s commands:

```ebnf
publishClause
    : 'publish' Identifier ( '(' emitArgList? ')' )?
    ;
```

The payload grammar is `emit`'s, so the same `field: expression` pairs apply, evaluated in the
same scope and at the same point in the body. A `publish` argument also participates in the
command's [evaluate-the-result-once rule](/Koine/reference/commands-events-state/#1133-returning-a-value):
when the command's `result` expression is one of these arguments, every code target binds it to a
single `__result` local, so a `publish`, a sibling `emit` of the same expression, and the returned
value all carry the identical value — they never re-read a non-deterministic expression such as `now`:

```koine
command place {
  requires status == Draft   "only a draft order can be placed"
  requires !lines.isEmpty    "cannot place an empty order"
  status   -> Placed
  placedAt -> now
  emit OrderPlacedInternally(orderId: id, lineCount: lines.count)
  publish OrderPlaced(orderId: id, customer: customer, fulfillment: fulfillment,
                      total: total.amount, placedAt: now)
}
```

The two verbs in that body are deliberate, not redundant — they are the *only* place the model
draws the internal/external line:

| | `emit E(…)` | `publish X(…)` |
| --- | --- | --- |
| Names | a domain `event` of this aggregate | an `integration event` of this context |
| Audience | in-process, inside the boundary | other bounded contexts |
| Payload | may carry your value objects | primitive only ([§17.3.4](#1734-integration-event-field-rules)) |
| Recorded on | `DomainEvents` | `IntegrationEvents` |
| Delivered | dispatched in-process **after** the commit | persisted to the outbox **before** it |

The payload must be **complete**: every field the integration event declares needs a binding, and
each is type-checked against it — the same `EmitPayloadMismatch` (KOI0602) that guards `emit`
reports a missing, unknown, duplicated or ill-typed field. A `placedAt: Instant` field will not
accept an `Instant?` member, which is why the example binds the built-in `now` rather than the
just-assigned optional `placedAt`.

Three diagnostics are specific to the clause:

| Statement | Requirement | Diagnostic if violated |
| --- | --- | --- |
| `publish X(…)` | `X` is an integration event of the **enclosing** context | `PublishUnknownIntegrationEvent` (KOI1420) |
| `publish X(…)` | That context also declares `publishes X` | `PublishNotDeclared` (KOI1421) |
| `publish X(…)` | The command belongs to an aggregate **root** | `PublishOutsideRoot` (KOI1422) |

:::caution
`publishes X` stays **required**. A producer does not auto-declare its own published language:
`publishes` is what the subscribers, the context map, the AsyncAPI operations and the docs graph
read, so a `publish X(…)` in a context that never declared `publishes X` is KOI1421, not an
implicit declaration. Only the first name diagnostic that applies is reported — an unresolvable
name gets KOI1420 and the payload is not checked further.
:::

:::note
A non-root entity may still declare and `emit` its own domain events; only leaving the context is
reserved to the root. That reservation is stricter than `emit`'s in one further way: an entity
declared **outside** any `aggregate` may `emit` but may not `publish`. `emit` is fine there because
the domain event is still recorded and observable on the entity itself, whereas a published contract
only leaves the context when the aggregate's Unit of Work drains `IntegrationEvents` into the outbox
at commit — with no aggregate there is no Unit of Work, so the event would be recorded and never
delivered. KOI1422 covers both shapes. The rationale — why `publish` is a distinct keyword rather
than `emit` inferring the event kind from its name — is recorded in
[ADR 0019 — `publish` is a distinct clause from `emit`](https://github.com/Atypical-Consulting/Koine/blob/main/adr/0019-publish-is-a-distinct-clause-from-emit.md).
:::

### 17.7.4 Translation to C# (the outbox path)

A root that publishes gains a second event collection alongside `DomainEvents`, generated the
first time any of its commands carries a `publish`:

```csharp
private readonly List<IIntegrationEvent> _integrationEvents = new();
public IReadOnlyList<IIntegrationEvent> IntegrationEvents
    => _integrationEvents;
public void ClearIntegrationEvents()
    => _integrationEvents.Clear();

public void Place()
{
    // guards, transitions, invariant re-check …
    _domainEvents.Add(new OrderPlacedInternally(Id, Lines.Count));
    _integrationEvents.Add(new OrderPlaced(Id, Customer, Fulfillment, Total.Amount, DateTimeOffset.UtcNow));
}
```

The domain layer only *records* — it never dispatches, so it stays persistence- and
transport-ignorant. The rest of the path is picked up by the opt-in layers
([§15](/Koine/reference/application-cqrs/)). The generated handler relays what the root recorded
to the unit of work's enqueue seam **before** it commits:

```csharp
public async Task HandleAsync(OrderPlaceRequest request, CancellationToken ct = default)
{
    var aggregate = await _unitOfWork.Orders.GetByIdAsync(request.Id, ct)
        ?? throw new InvalidOperationException($"Order '{request.Id}' was not found.");
    aggregate.Place();
    foreach (var integrationEvent in aggregate.IntegrationEvents)
    {
        _unitOfWork.Enqueue(integrationEvent);
    }

    aggregate.ClearIntegrationEvents();
    await _unitOfWork.SaveChangesAsync(ct);
}
```

`IUnitOfWork` grows its `void Enqueue(IIntegrationEvent integrationEvent)` member for exactly the
contexts whose roots publish. With `--layers infrastructure`, the EF Core `UnitOfWork` turns each
enqueued event into an `OutboxMessage` row inside `SaveChangesAsync`, so the outbox is written in
the **same transaction** as the aggregate change — an event can never be lost on commit — and the
generated `IntegrationEventDispatcher` drains those rows afterwards.

The other targets follow the same shape: TypeScript, Python, PHP, Rust, Java and Kotlin each
record the published event into a second, integration-event collection on the root, distinct from
the domain-event one. The `docs` target renders a **Published — leaves the context** list under
the command, next to its **Events** list.

## 17.8 Example: the Shop demo map

The Shop showcase wires all of this together across six contexts in a single `context-map.koi`:

```koine
contextmap {

  // Shared kernel: Catalog and Ordering jointly own the Currency enum.
  Catalog   <-> Ordering : shared-kernel { Currency }

  // Conformist: Shipping conforms to Catalog's published Weight.
  Catalog    -> Shipping : conformist

  // Customer-supplier: Customers supplies the PostalAddress Shipping imports.
  Customers  -> Shipping : customer-supplier

  // Open-host: Ordering publishes OrderPlaced; these authorize the subscriptions.
  Ordering   -> Shipping : open-host
  Ordering   -> Payments : open-host

  // Partnership: Shipping and Payments coordinate to fulfil an order.
  Shipping  <-> Payments : partnership

  // Anti-corruption layer: Payments translates the Legacy gateway's model.
  Legacy     -> Payments : anti-corruption-layer
    acl {
      Legacy.GatewayResult -> Payments.PaymentReceipt
    }
}
```

The `Ordering` context publishes the event and both downstream contexts subscribe:

```koine
context Ordering version 1 {
  integration event OrderPlaced {
    orderId:   OrderId
    customer:  CustomerId
    total:     Decimal
    placedAt:  Instant
  }
  publishes OrderPlaced
  // ...
}
```

From that one map, the compiler emits `Catalog__Ordering/Kernel/Currency.cs` (the shared
kernel), `Payments/ILegacyToPaymentsTranslator.cs` (the ACL translator), and an
`IHandleOrderPlaced.cs` handler seam in both `Shipping` and `Payments`.

## 17.9 Emitting AsyncAPI 3.0

The same integration-event + context-map graph also drives a non-C# target: `--target asyncapi`
emits a **single AsyncAPI 3.0 document** (`asyncapi.yaml`) describing the domain's cross-boundary
event API. It reads only the target-agnostic model, so it works on any model that declares
integration events.

```bash
koine build ./Models --target asyncapi --out ./events
```

The mapping is mechanical and deterministic (channels, operations, and schemas are emitted in a
stable order, so re-running is byte-identical):

| Koine construct                              | AsyncAPI 3.0 output |
| -------------------------------------------- | ------------------- |
| Each `integration event`                     | a `channels/<Event>` entry (addressed by the event name) and a `components/messages/<Event>` |
| Event doc comment (`///`)                    | the message `summary` |
| Event fields                                 | a `components/schemas/<Event>Payload` JSON-Schema; non-optional fields are `required` |
| Primitive field (`String`/`Int`/`Bool`/`Decimal`/`Instant`) | `type: string`/`integer`/`boolean`/`string`/`string` + `format: date-time` (`Decimal` stays a string to preserve precision) |
| `enum` field                                 | an inline `type: string` with the `enum:` member list |
| ID value object (`*Id`) field               | a shared `components/schemas/<Name>` (`type: string`), referenced by `$ref` |
| A context that `publishes` the event         | an `operations/<Context>_send_<Event>` with `action: send` |
| A context whose `subscribes` the map authorizes | an `operations/<Context>_receive_<Event>` with `action: receive` |
| The bounded context owning an operation      | a `tags` entry on that operation |

A model with no integration events still emits a minimal valid document (the `info` block with
empty `channels`/`operations`). The emitter is target-agnostic — nothing AsyncAPI-specific lives in
the semantic model — so it sits alongside the C#, TypeScript, Python, PHP, Rust, and docs back-ends.

Names are normally unqualified, but the compiler does not force integration-event names to be unique
across contexts. When two contexts declare the same integration-event name, the channel, message,
payload schema, and operation `$ref`s for that name are **context-qualified** (`<Context>_<Event>`,
e.g. `Sales_OrderPlaced`) so neither context's contract is dropped; names declared in a single
context keep their bare form.

> An optional conformance check runs the [AsyncAPI CLI](https://www.asyncapi.com/tools/cli) over the
> emitted document when `KOINE_ASYNCAPI_VALIDATE` is set; it is skipped (INCONCLUSIVE) otherwise, so
> the build stays hermetic.

## See also

- [Commands, events & state (§11)](/Koine/reference/commands-events-state/) — domain events, the in-context counterpart to integration events.
- [Multi-file, imports & modules (§16)](/Koine/reference/multi-file-imports-modules/) — the explicit cross-context reference path for non-permitting roles.
- [Versioning (§18)](/Koine/reference/versioning/) — `@since`/`@deprecated` annotations on integration event fields.
- [Contexts & types (§4)](/Koine/reference/contexts-and-types/) — how Koine's built-in types lower to C#.
