---
title: "Application layer & CQRS"
description: "Unit of work, application services, read models and query objects."
---

## 15.1 General

Koine's domain model — entities, value objects, aggregates — describes the *write* side of your system. The application layer wires that model into the outside world: a transactional boundary (`IUnitOfWork`), use-case entry points (application services), and a *read* side built from flat projections (`readmodel`) and query DTOs (`query`).

Everything on this page is a pure abstraction. The emitted interfaces and records carry **no** infrastructure dependencies — no Entity Framework, no Dapper, no `DbContext`. You implement them in your host project however you like; Koine just gives you the shapes.

The four constructs that make up the application layer are:

| Construct | Koine keyword | Role |
| --- | --- | --- |
| Unit of work | *(emergent — no keyword)* | Transactional boundary over all aggregates in a context |
| Application service | `service` / `usecase` | Command side: async entry points for controllers, handlers, or endpoints |
| Read model | `readmodel` | Flat, denormalized projection of an aggregate with a static mapper |
| Query object | `query` | Request DTO over a read model with a generic handler contract |

## 15.2 Syntax

### 15.2.1 Application services

An application service is declared with the `service` keyword. Each use-case entry point is a `usecase` inside it:

```ebnf
service_decl
    : 'service' Identifier '{' service_member* '}'
    ;

service_member
    : operation_decl
    | usecase_decl
    ;

usecase_decl
    : 'usecase' Identifier '(' param_list? ')' ( ':' type_ref )?
    ;

param_list
    : param ( ',' param )*
    ;

param
    : Identifier ':' type_ref
    ;

type_ref
    : ( Identifier '.' )? Identifier ( '<' type_ref ( ',' type_ref )? '>' )? '?'?
    ;
```

`usecase_decl` names the use case, takes an optional parameter list, and returns an optional result type. A `usecase` with no `: type_ref` returns `Task` (void-async) in C#; one with a result type returns `Task<R>`. See [Specs, services & policies (§13)](/Koine/reference/specs-services-policies/) for the `operation_decl` variant (pure domain logic that lives on the same `service`).

```koine
service OrderingService {
  usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
  usecase CancelOrder(order: OrderId)
}
```

### 15.2.2 Read models

A read model is declared with `readmodel`, naming the source aggregate with `from`. Its body is a list of fields:

```ebnf
readmodel_decl
    : 'readmodel' Identifier 'from' Identifier '{' readmodel_field* '}'
    ;

readmodel_field
    : Identifier ( ':' type_ref '=' expression )?
    ;
```

A `readmodel_field` is one of two forms:

- **Direct** — a bare `Identifier` with no `: type_ref = expression`. The field is resolved from the source aggregate by name; its type is inherited from the source.
- **Derived** — the full `Identifier ':' type_ref '=' expression` form. Both the type and the expression are required — there is no type-only form.

The expression grammar is specified in [Expressions (§9)](/Koine/reference/expressions/).

```koine
readmodel OrderSummary from Order {
  id
  customer
  status
  lineCount: Int = lines.count
}
```

### 15.2.3 Query objects

A query object is a context-level declaration with `query`:

```ebnf
query_decl
    : annotation* 'query' Identifier '(' param_list? ')' ':' type_ref
    ;
```

Unlike `usecase_decl`, the result type (`: type_ref`) is **required** on `query_decl`. The result must be a read model name or `List<M>` where `M` is a read model name.

```koine
query OrdersByStatus(status: OrderStatus): List<OrderSummary>
```

The leading `annotation*` carries the optional HTTP surface — `@route`, a verb, `@auth` — covered in [§15.9](#159-api-annotations).

## 15.3 Semantics

### 15.3.1 Unit-of-work generation

You never write a unit of work in `.koi`. It is **emergent**: any context that declares at least one `aggregate` automatically gets one `IUnitOfWork` interface, with one repository property per aggregate (in declaration order) plus a `SaveChangesAsync`.

- Each property is typed `I<Root>Repository` — the repository interface Koine generates from the aggregate (see [Aggregates & repositories (§7)](/Koine/reference/aggregates/)).
- Properties are named with the **pluralized** root entity name (`Order` → `Orders`).
- Properties appear in the same order the aggregates are declared.
- A context with **no** aggregates emits no `IUnitOfWork.cs` at all.

:::note
Pluralization follows English rules: `y` → `ies` (`Category` → `Categories`), words ending in `s`/`x`/`z`/`ch`/`sh` take `+es`, everything else takes `+s`. The property name comes from the **root entity** name, not the aggregate name (`aggregate Ledger root LedgerEntry` → `LedgerEntries`).
:::

:::tip
In a multi-file build each context gets its own `IUnitOfWork` under its own folder/namespace.
:::

### 15.3.2 Application-service rules

| `.koi` | Emitted C# |
| --- | --- |
| `usecase Name(...)` | one **async** method on the `I<Service>` interface |
| `usecase Name(...): R` | returns `Task<R>` |
| `usecase Name(...)` *(no return)* | returns `Task` |
| `List<T>` parameter | surfaces as `IReadOnlyList<T>` in the signature |
| service name `OrderingService` | interface `IOrderingService` |

A service that contains **only** use cases emits just the `I<Service>` interface — no domain class. If you mix `operation` (pure domain logic) and `usecase` in one service, Koine emits both files: the bare-named class for the operations and the `I`-prefixed interface for the use cases. See [Specs, services & policies (§13)](/Koine/reference/specs-services-policies/) for the `operation` side.

### 15.3.3 Read-model rules

- A direct field (bare name) must actually exist on the source aggregate; a missing name raises a `ReadModelUnknownField` diagnostic.
- The `from` source must be a type already declared in the context; an unknown source raises a `ReadModelUnknownSource` diagnostic.
- Duplicate fields are rejected — including case-only collisions, since field names PascalCase into record members (`total` and `Total` both become `Total`).
- Read models emit a plain record: no `IAggregateRoot`, no invariants.

### 15.3.4 Query-object rules

- A `query` is declared at **context level**, not inside a `service`.
- The result type is **required** (unlike `usecase`, where it is optional).
- The result type **must** be a read model — `readmodel M` or `List<M>` — otherwise the compiler raises a `QueryResultNotReadModel` diagnostic.
- The `IQueryHandler.cs` runtime file is emitted exactly once for the whole compilation, no matter how many queries you declare; a model with no queries emits no handler file.

:::tip
A `usecase` can return a read model too: `usecase GetOrder(order: OrderId): OrderSummary` becomes `Task<OrderSummary>`, and `usecase ListOrders(): List<OrderSummary>` becomes `Task<IReadOnlyList<OrderSummary>>`.
:::

:::caution
A `query` result type is **not** a `usecase` result type. `query` requires its result to be a declared read model; `usecase` may return any type in the model (an aggregate id, a value object, a read model, or nothing).
:::

## 15.4 Translation to C#

### 15.4.1 Unit of work

The Ordering context, which has a single `Order` aggregate:

```koine
context Ordering version 1 {
  aggregate Order root Order versioned {
    repository {
      operations: getById, add, update
      find byCustomer(customer: CustomerId): List<Order>
      find mostRecent(customer: CustomerId): Order
    }
    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
      status:   OrderStatus = Draft
    }
  }
}
```

emits `Ordering/IUnitOfWork.cs`:

```csharp
namespace Ordering;

/// <summary>Transactional boundary over this context's aggregate repositories.</summary>
public interface IUnitOfWork
{
    IOrderRepository Orders { get; }

    Task<int> SaveChangesAsync(CancellationToken ct = default);
}
```

A context with two aggregates exposes two repositories. Payments declares `Payment` and `Ledger` (root entity `LedgerEntry`):

```csharp
namespace Payments;

public interface IUnitOfWork
{
    IPaymentRepository Payments { get; }
    ILedgerEntryRepository LedgerEntries { get; }

    Task<int> SaveChangesAsync(CancellationToken ct = default);
}
```

## 15.5 Application services

### 15.5.1 Translation to C#

The `service` / `usecase` pair emits `Ordering/IOrderingService.cs`:

```csharp
namespace Ordering;

public interface IOrderingService
{
    Task<OrderId> PlaceOrder(CustomerId customer, IReadOnlyList<OrderLine> lines);

    Task CancelOrder(OrderId order);
}
```

## 15.6 Read models

The query side starts with a `readmodel`: a flat, denormalized projection of an aggregate, plus a static mapper that builds it. This keeps your read DTOs out of the domain model while staying type-safe.

### 15.6.1 Translation to C#

The `readmodel OrderSummary from Order { … }` declaration emits `Ordering/OrderSummary.cs` — a `record` and a projection extension method:

```csharp
namespace Ordering;

public sealed record OrderSummary(OrderId Id, CustomerId Customer, OrderStatus Status, int LineCount);

public static class OrderSummaryProjection
{
    public static OrderSummary ToOrderSummary(this Order src) =>
        new OrderSummary(src.Id, src.Customer, src.Status, src.Lines.Count);
}
```

Projection expressions translate like the rest of Koine: `.count` becomes `.Count`, and LINQ aggregates pull in `using System.Linq;` automatically. The Catalog `ProductCard` uses a comparison expression:

```koine
readmodel ProductCard from Product {
  sku
  name
  price
  available: Bool = availability == InStock
}
```

A collection aggregate works the same way and adds the LINQ import:

```koine
readmodel CartTotal from Cart { units: Int = lines.sum(l => l.quantity) }
```

```csharp
// projection mapper body
new CartTotal(src.Lines.Sum(l => l.Quantity));   // file gains: using System.Linq;
```

:::note
The `from` source must be a type already declared in the context, or you get a `ReadModelUnknownSource` diagnostic. Duplicate fields are rejected — including case-only collisions, since field names PascalCase into record members (`total` and `Total` both become `Total`). Read models emit a plain record: no `IAggregateRoot`, no invariants.
:::

## 15.7 Query objects

A `query` is a request DTO over a read model. Koine emits one `record` per query (the criteria become its constructor properties) and **one** shared handler interface for the whole model.

```koine
query OrdersByStatus(status: OrderStatus): List<OrderSummary>
```

### 15.7.1 Translation to C#

Emits `Ordering/OrdersByStatus.cs`:

```csharp
namespace Ordering;

public sealed record OrdersByStatus(OrderStatus Status);
```

The result type — `List<OrderSummary>` vs a bare `OrderSummary` — does not change the DTO. It only documents the `TResult` you bind when implementing the handler. The single runtime file `Koine/Runtime/IQueryHandler.cs` carries that contract:

```csharp
namespace Koine.Runtime;

public interface IQueryHandler<TQuery, TResult>
{
    Task<TResult> HandleAsync(TQuery query, CancellationToken ct = default);
}
```

You implement one handler per query — for example `IQueryHandler<OrdersByStatus, IReadOnlyList<OrderSummary>>`. Catalog shows both a list query and a single-result query:

```koine
query ProductsByAvailability(availability: Availability): List<ProductCard>
query ProductByCode(code: ProductCode): ProductCard
```

:::caution
A `query` is declared at **context level**, not inside a `service`. Its result type is **required** (unlike `usecase`, where it is optional) and **must** be a read model — `readmodel M` or `List<M>` — otherwise you get a `QueryResultNotReadModel` diagnostic. The `IQueryHandler.cs` runtime file is emitted exactly once for the whole compilation, no matter how many queries you declare; a model with no queries emits no handler file.
:::

## 15.8 End-to-end example

For the Ordering context, one `.koi` file gives you the full vertical slice:

```koine
/// Ordering bounded context — placing and pricing customer orders.
context Ordering version 1 {

  enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }
  enum Currency { EUR, USD, GBP }

  value Money {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "an amount cannot be negative"
  }

  aggregate Order root Order versioned {
    repository {
      operations: getById, add, update
      find byCustomer(customer: CustomerId): List<Order>
      find mostRecent(customer: CustomerId): Order
    }

    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Money
      lineTotal: Money = unitPrice * quantity
      invariant quantity >= 1   "an order line needs at least one unit"
    }

    entity Order identified by OrderId {
      customer:  CustomerId
      lines:     List<OrderLine>
      status:    OrderStatus = Draft
      total:     Money = lines.sum(l => l.lineTotal)
      lineCount: Int   = lines.count
    }
  }

  /// The application/use-case service interface.
  service OrderingService {
    usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
    usecase CancelOrder(order: OrderId)
  }

  /// A flat read model + projection mapper.
  readmodel OrderSummary from Order {
    id
    customer
    status
    lineCount: Int = lines.count
  }

  /// A query DTO over the read model.
  query OrdersByStatus(status: OrderStatus): List<OrderSummary>
}
```

From that single context Koine emits, in the `Ordering/` folder: the `Order` aggregate and `IOrderRepository`, an `IUnitOfWork` exposing `Orders`, the `IOrderingService` application interface, the `OrderSummary` record and projection, and the `OrdersByStatus` query DTO — plus the shared `Koine/Runtime/IQueryHandler.cs`. None of it references your database.

## 15.9 API annotations

A `command`, a `query` and a `create` [factory (§12)](/Koine/reference/factories/) each already describe one HTTP operation, and two emitters derive it from the same convention: the [`openapi` target](/Koine/guides/cli/#emit-an-openapi-spec) and the C# **api** layer (`koine build … --layers api`). A command is `POST /{entity}/{command}`, a factory `POST /{entity}/{factory}`, a query `GET /{query}` — all kebab-cased. Three optional annotations override that convention one declaration at a time. They precede the declaration, in any order:

| Annotation | What it does | Rule |
| --- | --- | --- |
| `@route("/orders/{id}")` | replaces the derived path, verbatim | must be absolute (start with `/`) and a well-formed route template; at most one per declaration |
| `@get` `@post` `@put` `@delete` `@patch` | replaces the derived verb | bare — no argument; at most one per declaration |
| `@auth("admin")` | *adds* an authorization requirement | must name a non-blank value; at most one per declaration |

The three axes are **independent**: each falls back to the convention on its own, so `@auth` alone leaves an operation exactly where the convention put it. A declaration that carries none of them emits what it always did.

A `@route` path is pasted into the host's route table verbatim, so it is checked as a **route template**, not just as a string: `{}` parameters must be balanced, named, and un-nested, and the path may not contain whitespace or control characters. Constraints, optional and catch-all parameters, and the `{{`/`}}` escape for a literal brace are all accepted — `/orders/{id:int}`, `/orders/{id?}`, `/files/{*path}`, `/a/{{literal}}`. A malformed template such as `/orders/{id` would otherwise compile fine and then throw `RoutePatternException` when the host builds its routes, so it is a `KOI1208` error instead.

A `{token}` in a `@route` path is also **bound**: it resolves by name against the declaration's own parameters/criteria, or — for a command, when the token is `id` and nothing else claims it — the aggregate identity. A bound token is lifted into an explicit `[FromRoute]` parameter in the generated C# and re-bound into the request/query record with a non-destructive `with { … }`, so the URL and the value the handler actually uses can never silently disagree. See [§15.9.1](#1591-translation-to-c---layers-api) for the emitted shape and [§15.9.3](#1593-rules-and-diagnostics) for `KOI1215`, the diagnostic that catches a token naming nothing at all.

That identity fallback is a **command's** alone. A factory *mints* the identity it creates, so its generated request record is built from the factory's own parameters and carries no identity property at all — there is nothing for `{id}` to bind to. On a factory `{id}` therefore binds only when the factory declares a parameter of that name, and is otherwise an unbound token like any other. And on the default **Guid** identity a factory cannot declare one: `id` is reserved for the generated identity local (`KOI0807`), so `{id}` on a Guid-identity factory is *always* unbound — name the token after a real parameter, or take the explicit-id opt-in that a `natural`/`sequence` identity allows (`create register(id: BookId, …)` — [§12](/Koine/reference/factories/)).

```koine
context Ordering {
  enum OrderStatus { Draft, Submitted, Cancelled }

  aggregate Order root Order {
    entity Order identified by OrderId {
      status: OrderStatus = Draft

      /// Submit a draft order for fulfilment.
      @route("/orders/{id}")
      @put
      @auth("admin")
      command submit(note: String) {
        requires status == Draft "only a draft order can be submitted"
        status -> Submitted
      }

      /// Cancel an order that has not shipped yet.
      @route("/orders/{id}")
      @delete
      command cancel {
        requires status == Submitted "only a submitted order can be cancelled"
        status -> Cancelled
      }
    }
  }

  readmodel OrderRow from Order {
    status
  }

  /// All orders in a given lifecycle state.
  @auth("analyst")
  query OrdersByStatus(status: OrderStatus): List<OrderRow>
}
```

A factory annotates exactly the same way — same three axes, same rules, same fall-back-to-the-convention:

```koine
entity Order identified by OrderId {
  /// Open a new order for a customer.
  @route("/orders")
  @auth("admin")
  create open(customer: CustomerId) {
  }
}
```

That maps `POST /orders` — `@route` moved the path, no verb annotation was given so the conventional `POST` stands — behind the `admin` authorization policy, instead of the conventional `POST /order/open`.

### 15.9.1 Translation to C# (`--layers api`)

The annotated command maps through ASP.NET's per-verb Minimal-API method at the overridden path, and its chain gains `.RequireAuthorization(...)`. The route's `{id}` token names no parameter of `submit`, so it resolves to the aggregate identity: a fully-qualified `[FromRoute]` parameter is lifted ahead of the request, and the request is re-bound from it with `with { Id = id }` before the handler ever sees it:

```csharp
endpoints.MapPut("/orders/{id}", async ([Microsoft.AspNetCore.Mvc.FromRoute(Name = "id")] OrderId id, OrderSubmitRequest request, OrderSubmitHandler handler, CancellationToken ct) =>
{
    await handler.HandleAsync(request with { Id = id }, ct);
    return Results.Ok();
}).RequireAuthorization("admin");
```

`request` is still the same generated `OrderSubmitRequest` the conventional `POST /order/submit` endpoint would have bound — `note` still arrives in the body — but its `Id` property now comes from the URL, not from whatever the caller happened to put in the JSON. This works because every emitted identity value object carries a `TryParse(string?, out T?)` satisfying ASP.NET's Minimal-API binding convention, and a request record is a positional `record`, so `with { … }` compiles without touching the Application layer's contract.

`@auth` on its own moves nothing. The query keeps the conventional `MapGet` at the conventional route and only gains the call:

```csharp
endpoints.MapGet("/orders-by-status", async ([AsParameters] OrdersByStatus query, OrdersByStatusHandler handler, CancellationToken ct) =>
{
    var result = await handler.HandleAsync(query, ct);
    return Results.Ok(result);
}).RequireAuthorization("analyst");
```

A command mapped through a **body-less verb** — `@get` or `@delete` — still binds its generated `<Behavior>Request` record, so Koine marks the parameter `[FromBody]` explicitly. The `{id}` token's `[FromRoute]` parameter comes first, ahead of it, exactly as in the `PUT` case above:

```csharp
endpoints.MapDelete("/orders/{id}", async ([Microsoft.AspNetCore.Mvc.FromRoute(Name = "id")] OrderId id, [Microsoft.AspNetCore.Mvc.FromBody] OrderCancelRequest request, OrderCancelHandler handler, CancellationToken ct) =>
{
    await handler.HandleAsync(request with { Id = id }, ct);
    return Results.Ok();
});
```

ASP.NET only *infers* a complex parameter as the request body for verbs that define body semantics; for `GET`/`DELETE`/`HEAD`/`OPTIONS`/`TRACE`/`CONNECT` inferred-body binding is disabled, and an endpoint that relies on it throws `InvalidOperationException: Body was inferred but the method does not allow inferred body parameters` when the route table is built — at startup, not at compile time. The explicit attribute overrides that restriction. It is written by fully-qualified name, so the endpoints file needs no extra `using`. The body-taking verbs are untouched and keep the inferred binding.

A token resolves by name against the declaration's own parameters/criteria first — `OrdinalIgnoreCase`, mirroring ASP.NET's own route-value binding — and only falls back to the aggregate identity for a bare `id` on a command with no `id`-named parameter of its own. A command parameter *named* `id` therefore wins the match: the token binds to it, not the identity, and the identity's own request property is pushed to `AggregateId` instead of colliding with it (`CSharpNaming.CommandIdProperty`, shared by the handler and the endpoint so the two can never disagree). Only a **route-bindable** type lifts into `[FromRoute]` — a scalar (`String`/`Int`/`Decimal`/`Bool`/`Instant`), an enum, or an identity value object, all `TryParse`-able. A token that matches a parameter typed as a general value object stays unbound, with an explanatory `// route token '{x}': <Type> is not route-bindable` comment in the emitted lambda rather than code that would not compile or would compile and fail to bind at request time. A query has no aggregate identity to fall back to, so only its criteria can ever bind one of its tokens — and neither has a factory, which mints the identity it creates rather than loading one, so only its parameters can.

:::caution
`@auth("admin")` names an authorization **policy**, not a role. ASP.NET's `RequireAuthorization(params string[])` takes policy names, so the host app has to register a policy literally called `admin`:

```csharp
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("admin", policy => policy.RequireRole("admin"));
```

Koine cannot see your DI container, so an unregistered name is not a build error — it fails at request time, when the authorization middleware looks the policy up.
:::

### 15.9.2 Translation to OpenAPI

The `openapi` target keys the operation under the overridden path and the lower-cased verb, and adds a per-operation `security` requirement:

```yaml
paths:
  /orders-by-status:
    get:
      operationId: OrdersByStatus
      summary: "All orders in a given lifecycle state."
      # …
      security:
        - analyst: []
  "/orders/{id}":
    put:
      operationId: Order_submit
      summary: "Submit a draft order for fulfilment."
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
            format: uuid
      # …
      security:
        - admin: []
    delete:
      operationId: Order_cancel
      summary: "Cancel an order that has not shipped yet."
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
            format: uuid
      # …
```

Every `{token}` in the path becomes a required `in: path` parameter — OpenAPI requires it, and a document that declares a templated path without them is rejected by validators. The token's ASP.NET syntax is stripped down to the bare name (`{id:int}`, `{id?}`, `{*rest}` are declared as `id`, `id`, `rest`) and each token is typed off what it resolves to — the same resolution the C# `api` layer binds ([§15.9.1](#1591-translation-to-c---layers-api)), so the two can never disagree: a token bound to a parameter/criterion gets that member's own schema, `{id}` here gets the aggregate identity's schema (a `Guid`-strategy identity ⇒ `type: string, format: uuid`; `Sequence` ⇒ `type: integer, format: int64`; a `Natural` key ⇒ its backing primitive), and an unbound token — `KOI1215`'s concern, not the document's — still falls back to a bare `type: string`. On a query, path parameters come first and the criteria follow as `in: query` ones in the same array.

Two declarations may point `@route` at the same path as long as their **verbs differ** — OpenAPI keys a path item by path and then by verb, so they merge under one key rather than colliding. Sharing a path *and* a verb is a `KOI1211` error: the document would carry the same verb key twice under one path (a duplicate YAML mapping key, which no parser will read), and the C# `api` layer would register two indistinguishable endpoints, which ASP.NET rejects with `AmbiguousMatchException` at request time.

:::note
Koine emits no `components/securitySchemes`. The `@auth` value names a scheme the consuming document declares (bearer JWT, OAuth2 scopes, an API key); Koine models *which* operations require authorization, never *how* you authenticate.
:::

### 15.9.3 Rules and diagnostics

| Rule | Diagnostic |
| --- | --- |
| `@route` names no path (a bare `@route`), or a malformed one — not absolute, containing whitespace or control characters, or with unbalanced, nested, or empty `{}` parameters | `KOI1208` `InvalidRouteOverride` |
| a declaration carries more than one verb annotation | `KOI1209` `MultipleVerbAnnotations` |
| `@auth` names no role (a bare `@auth`), or a blank one | `KOI1210` `EmptyAuthRole` |
| two commands/queries/factories in one context resolve to the same route **and** verb | `KOI1211` `DuplicateApiRoute` |
| a declaration repeats `@route` or `@auth` | `KOI1212` `DuplicateApiAnnotation` |
| a verb annotation is given an argument (`@get("/orders")`) | `KOI1213` `VerbAnnotationArgument` |
| a `command` or a `create` factory carries `@since`/`@deprecated` | `KOI1214` `VersionAnnotationOnCommand` |
| a `@route` `{token}` names neither a parameter/criterion of the declaration nor — **for a command only** — the aggregate identity. A factory has no `{id}` fallback at all: it mints the identity it creates, so its request carries no identity property to bind one to. A *warning*, since a purely decorative token was legal before this axis bound anything at all | `KOI1215` `UnboundRouteToken` |

- The annotations attach to a `command`, a `query` and a `create` [factory (§12)](/Koine/reference/factories/) — one declaration, one endpoint, one set of rules. A factory that carries none of them keeps the conventional `POST /{entity}/{factory}`; either way it gets its own `openapi` operation (a `200` for the created aggregate, a `400` for a precondition/invariant violation) and claims its route in the `KOI1211` check below. A `usecase` has no HTTP surface at all.
- Every axis is single-valued. Repeating one would quietly keep the last and drop the rest, so it is an error rather than a silent last-one-wins.
- The `KOI1211` collision check compares whole route strings *exactly*, across every command, query, and factory of one bounded context, whether the route came from `@route` or from the convention. Two templates that differ only in letter case, or only in the *name* of a token (`/orders/{id}` vs `/orders/{orderId}`), are distinct OpenAPI keys and so are not reported — but ASP.NET would still consider them ambiguous, so avoid them. When the reported claimant is a factory that annotates **neither** its route nor its verb — so both still come from the convention — the message adds a hint: give that factory a `@route`/verb of its own, or move the one on the other declaration. If both sides are un-annotated factories, neither names a path yet, so the hint suggests annotating one, or renaming one factory or one entity so the conventional paths differ.
- Any other `@name` before a declaration parses and is silently ignored, per the [annotation ignorance rule (§18.3.4)](/Koine/reference/versioning/#1834-annotation-ignorance-rule) — with one exception. A `query` is a type declaration, so the [evolution annotations (§18.3)](/Koine/reference/versioning/) `@since`/`@deprecated` apply to it exactly as they do to a `value` or an `event` (a deprecated query emits `[Obsolete]`). A `command` and a `create` factory are *not* type declarations and have nowhere to keep them, so `@since`/`@deprecated` on either is a `KOI1214` error rather than an annotation that vanishes.
- Nothing here reaches the domain or application C#. Without `--layers api` or `--target openapi`, an annotated model emits exactly what an un-annotated one does.

## See also

- [Aggregates & repositories (§7)](/Koine/reference/aggregates/) — where `I<Root>Repository` and finders come from.
- [Specs, services & policies (§13)](/Koine/reference/specs-services-policies/) — the `operation`, `spec`, and `policy` constructs.
- [Contexts & types (§4)](/Koine/reference/contexts-and-types/) — how `List<T>`, `Instant`, and the rest map to C#.
- [Expressions (§9)](/Koine/reference/expressions/) — the expression grammar used in derived read-model fields.
- [Commands, events & state machines (§11)](/Koine/reference/commands-events-state/) — the `command` and `event` constructs that the application layer orchestrates.
- [CLI reference](/Koine/guides/cli/) — `--layers` (the C# application and api layers) and `--target openapi`, the two consumers of the [API annotations (§15.9)](#159-api-annotations).
