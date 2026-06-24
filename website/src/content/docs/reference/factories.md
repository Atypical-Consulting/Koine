---
title: "Factories"
description: "Named creation methods that enforce invariants and make the constructor private."
---

## 12.1 General

A **factory** is a named way to create an aggregate. Instead of handing callers a raw constructor,
you declare a `create` method that states its preconditions, fills the fields it cares about, and
records a creation event. Koine emits it as a `public static` method on the entity — and the moment
*any* factory exists, the all-args constructor becomes `private`, so the factory is the only legal door in.

This is the Domain-Driven Design "Factory" pattern: the aggregate is always born valid, named after
the business action that brought it into being (`Order.Open(...)`, not `new Order(...)`).

A factory is declared **inside an `entity` block** — after the entity's members, invariants, `states`,
and `command` declarations. It belongs to the entity, not to `aggregate`: a factory is an entity member,
never a direct child of `aggregate`. The host entity needs a **generatable identity** — a Guid-backed id
(the default) — because the factory mints that identity for you with `IdType.New()` (C#) /
`IdType::generate()` (Rust). A `natural(String)`, `natural(Int)`, or `sequence` key has no *meaningful*
client-side generator (a natural key is caller-supplied; a sequence key is store-assigned), so a `create`
factory on such an entity is rejected at compile time (see [§12.3.5](#1235-diagnostics-and-restrictions)).

Most factories sit on an aggregate **root** (as below), but a standalone, context-level entity may host
one too. The one wrinkle is `emit`: a creation event can only be raised from a standalone entity or an
aggregate root — a non-root nested entity may still declare a factory, but it cannot `emit`.

## 12.2 Syntax

A factory is introduced with the `create` keyword followed by a name and an optional parameter list:

```ebnf
factoryDecl
    : 'create' Identifier ( '(' paramList? ')' )? '{' factoryStmt* '}'
    ;

factoryStmt
    : requiresClause
    | initialization
    | emitClause
    ;

requiresClause
    : 'requires' expression StringLiteral?
    ;

initialization
    : softName '->' expression
    ;

emitClause
    : 'emit' Identifier ( '(' emitArgList? ')' )?
    ;

emitArgList
    : emitArg ( ',' emitArg )*
    ;

emitArg
    : softName ':' expression
    ;
```

The body of a factory is a fixed sequence of clauses: zero or more `requires` guards
([§12.3.2](#1232-requires-guards)), zero or more field initializations (`field -> expr`)
([§12.5](#125-the---init-arrow)), and zero or more `emit` clauses ([§12.6](#126-creation-events)).

The name `Identifier` is PascalCased in the emitted C# static method. The parameter list follows
the same `softName ':' type_ref` convention as commands (see
[Commands, events & state (§11)](/Koine/reference/commands-events-state/)).
The expression grammar used in `requiresClause` and `initialization` is specified in
[Expressions (§9)](/Koine/reference/expressions/).

```koine
context Sales {
  value OrderLine { product: ProductId  quantity: Int }
  enum OrderStatus { Draft, Placed, Shipped, Cancelled }

  aggregate Order root Order {
    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
      status:   OrderStatus = Draft

      create forCustomer(customer: CustomerId, lines: List<OrderLine>) {
        requires !lines.isEmpty "cannot open an empty order"
        emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
      }
    }

    event OrderOpened {
      orderId:   OrderId
      customer:  CustomerId
      lineCount: Int
    }
  }
}
```

:::note
The factory above raises a creation event, so its host entity must be a standalone entity or the
aggregate **root** (`aggregate Order root Order`). See [Aggregates (§7)](/Koine/reference/aggregates/) for the
root entity rules and how `emit` is restricted on nested entities.
:::

## 12.3 Semantics

### 12.3.1 Scope

The factory parameters and a synthetic `id` are the only names in scope inside the factory body.
Entity members are **not** in scope — the aggregate does not exist yet, so there is no `this` to
read from.

### 12.3.2 Requires guards

Each `requires <expr> "msg"` clause is a precondition. Guards are checked **before** construction
and throw `DomainInvariantViolationException` if the expression evaluates to false. The optional
`StringLiteral` becomes the `rule` message on the exception. Multiple guards are evaluated in
declaration order.

### 12.3.3 Field initialization precedence

The precedence Koine uses to fill each field, highest to lowest:

1. An explicit `field -> expr` initialization.
2. A same-named, same-typed parameter (auto-bind; see [§12.4.1](#1241-same-named-parameter-auto-bind)).
3. A field default (`= value`) or an optional `T?`.
4. `default!` for a required field the factory never set — which **also raises an
   `UninitializedFactoryField` warning** (non-fatal; it still compiles).

So a required field is satisfied by either an auto-binding parameter or an explicit `field -> expr`.
If you see the warning, you have a required field with no value flowing into it.

### 12.3.4 The constructor becomes private

With no factory, the all-args constructor is `public` and callers can `new` the entity directly:

```csharp
public Order(OrderId id, CustomerId customer, IReadOnlyList<OrderLine> lines, ...)
```

The instant you declare **any** `create`, that same constructor is emitted `private`:

```csharp
private Order(OrderId id, CustomerId customer, IReadOnlyList<OrderLine> lines, OrderStatus? status = null)
```

This is automatic — there is no extra keyword. The toggle is purely the presence or absence of `create`
declarations on the entity. Adding one factory closes the door for everyone; external code must now go
through `Order.Open(...)`.

:::tip
This is the whole point of a factory: **factory-only construction**. Once one named creation path
exists, you can be sure every `Order` in the system was born through a path that ran your invariants.
:::

### 12.3.5 Diagnostics and restrictions

- **`id` is reserved.** A factory parameter named `id` is rejected — it collides with the synthetic
  `var id = OrderId.New();`. Never name a create-param `id`.
- **The identity must be generatable (Guid).** A factory auto-generates the new aggregate's identity,
  but only the default Guid-backed id has a meaningful generator (`IdType.New()` / `IdType::generate()`).
  A `create` factory on an entity whose identity is `as natural(String)`, `as natural(Int)`, or
  `as sequence` is a hard error (`KOI0808`) — these keys are supplied by the caller or assigned by the
  store, not minted client-side. Either give the entity a Guid identity or drop the factory and construct
  with an explicit id. (Explicit-id factories for natural/sequence keys are a planned future enhancement.)
- **The factory name emits a `public static` method**, so it must not collide with a field, a property,
  a command name, or a synthesized member like `getHashCode`. Two factories with the same name is a
  duplicate-factory error.
- **Placement is strict.** Factories come after members, invariants, `states`, and commands inside the
  `entity` block — and never directly under `aggregate`.
- **`create` is a soft keyword.** It is still legal as a field name (e.g. `create: Int` in a value).
  The same holds for `requires` and `emit`.
- **Empty bodies are fine.** `create make { }` parses and compiles; unset fields fall back to defaults
  (and required ones trigger the `UninitializedFactoryField` warning).

## 12.4 Translation to C#

The factory compiles to a `public static` method with a fixed body order: generate the identity, run
the guards, construct via the private constructor with **named** arguments, record events, return.

```koine
create forCustomer(customer: CustomerId, lines: List<OrderLine>) {
  requires !lines.isEmpty   "cannot open an empty order"
  emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
}
```

emits:

```csharp
public static Order Open(CustomerId customer, IReadOnlyList<OrderLine> lines)
{
    var id = OrderId.New();

    if (!(!(lines.Count == 0)))
        throw new DomainInvariantViolationException(
            type: nameof(Order),
            rule: "cannot open an empty order");

    var instance = new Order(id, customer: customer, lines: lines);
    instance._domainEvents.Add(new OrderOpened(id, customer, lines.Count));
    return instance;
}
```

Notice three things:

- **The identity is generated for you.** `var id = OrderId.New();` is always the first statement. The
  caller never passes an id — and a factory parameter named `id` is a hard error (see [§12.3.5](#1235-diagnostics-and-restrictions)).
- **Construction uses named arguments.** Each field is passed positionally-by-name, so the order of
  declaration in the factory does not have to match the constructor.
- **Events are recorded after construction**, qualified on the freshly built `instance`.

### 12.4.1 Same-named parameter auto-bind

You do not always need an explicit `->`. If a factory parameter's **name and type match a field**, it
auto-binds to that field. In the `Open` example, `customer` and `lines` are passed straight through
(`customer: customer`, `lines: lines`) without a single line of initialization.

```koine
create forCustomer(customer: CustomerId, lines: List<OrderLine>) {
  emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
}
```

## 12.5 The `->` init arrow

Use `field -> expr` to set a constructor field from an expression. Each initialization becomes a named
constructor argument (`field: <expr>`).

```koine
context C {
  entity E identified by EId {
    n: Int
    create make(v: Int) {
      requires v > 0 "positive"
      n -> v
    }
  }
}
```

emits:

```csharp
public static E Make(int v)
{
    var id = EId.New();
    if (!(v > 0))
        throw new DomainInvariantViolationException(type: nameof(E), rule: "positive");
    var instance = new E(id, n: v);
    return instance;
}
```

A few rules for init targets:

- The target must be a real, constructor-settable field. Initializing an unknown field is an error.
- A **derived** field (one with a computed default, e.g. `doubled: Int = n + n`) cannot be initialized —
  it is recomputed from other fields, not stored. See [Value objects (§5)](/Koine/reference/value-objects/) for derived members.
- The RHS type must match the field's type, or you get a type-mismatch error (e.g. `n -> "x"` for an `Int`).
- Initializing the same field twice is a duplicate-initialization error.

:::note[Two arrows, not three]
Koine has exactly two assignment-like arrows. `=` is the **declaration default** (`status: OrderStatus = Draft`);
`->` is the **state effect** — it sets a field's value, whether that is a factory's initial value (`n -> v`
inside `create`) or a command's transition (`status -> Submitted` inside `command`). The enclosing
`create {}` vs `command {}` block — not the arrow — tells you whether it is initialization or mutation.
(`<-` was a third arrow for factory init; it has been merged into `->`.) `->` is a single atomic token:
keep the two characters adjacent (`n -> v`, never `n - > v`). It is distinct from the context-map `<->` operator.
:::

### 12.5.1 Folding over a parameter collection

Because the parameter's declared type tells the translator the element type, you can aggregate a
collection of value objects directly in an initialization:

```koine
context Sales {
  value Money  { amount: Decimal }
  value Line   { price: Money }
  aggregate Cart root Cart {
    entity Cart identified by CartId {
      total: Money
      create forLines(lines: List<Line>) {
        total -> lines.sum(l => l.price)
      }
    }
  }
}
```

When the selector returns a value object, `.sum(...)` folds with the VO's `+` operator rather than a
numeric sum:

```csharp
total: lines.Select(l => l.Price).Aggregate((a, b) => a + b)
```

## 12.6 Creation events

`emit Evt(arg: expr, ...)` records a domain event after the instance is constructed. The event type must
be declared as a sibling member of the aggregate, and the payload may reference `id` and the factory
parameters.

```koine
emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
```

Event field names become PascalCase C# properties, and emitting any event is what triggers Koine to
generate the `DomainEvents` infrastructure on the root. See [Aggregates (§7)](/Koine/reference/aggregates/)
for how `DomainEvents` is collected and cleared.

## See also

- [Aggregates (§7)](/Koine/reference/aggregates/) — roots, commands, state machines, and domain events.
- [Entities & identity (§6)](/Koine/reference/entities-and-identity/) — id types and the `identified by` clause.
- [Value objects (§5)](/Koine/reference/value-objects/) — invariants, operators, and derived members.
- [Commands, events & state (§11)](/Koine/reference/commands-events-state/) — the shared `requires`, `emit`, and `->` syntax used in commands.
- [Expressions (§9)](/Koine/reference/expressions/) — the expression grammar used in guards and initializations.
