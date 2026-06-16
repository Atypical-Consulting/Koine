---
title: "Factories"
description: "Named creation methods that enforce invariants and make the constructor private."
---

A **factory** is a named way to create an aggregate. Instead of handing callers a raw constructor,
you declare a `create` method that states its preconditions, fills the fields it cares about, and
records a creation event. Koine emits it as a `public static` method on the entity — and the moment
*any* factory exists, the all-args constructor becomes `private`, so the factory is the only legal door in.

This is the Domain-Driven Design "Factory" pattern: the aggregate is always born valid, named after
the business action that brought it into being (`Order.Open(...)`, not `new Order(...)`).

## Where factories live

A factory is declared **inside an `entity` block** — after the entity's members, invariants, `states`,
and `command` declarations. It belongs to the entity, not to `aggregate`: a factory is an entity member,
never a direct child of `aggregate`. The host entity needs identity (an `identified by` clause), because
the factory generates that identity for you with `IdType.New()`.

Most factories sit on an aggregate **root** (as below), but a standalone, context-level entity may host
one too. The one wrinkle is `emit`: a creation event can only be raised from a standalone entity or an
aggregate root — a non-root nested entity may still declare a factory, but it cannot `emit`.

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

The body of a factory is a fixed sequence of clauses: zero or more `requires` guards, zero or more
field initializations (`field -> expr`), and zero or more `emit` clauses.

:::note
The factory above raises a creation event, so its host entity must be a standalone entity or the
aggregate **root** (`aggregate Order root Order`). See [aggregates](/Koine/reference/aggregates/) for the
root entity rules and how `emit` is restricted on nested entities.
:::

## Anatomy of a factory

```koine
create open(customer: CustomerId, lines: List<OrderLine>) {
  requires !lines.isEmpty   "cannot open an empty order"
  emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
}
```

| Clause | Meaning |
| --- | --- |
| `create open(...)` | Declares a `public static Order Open(...)` method. The name is PascalCased. |
| `requires <expr> "msg"` | A precondition. Checked **before** construction; throws `DomainInvariantViolationException` if false. |
| `field -> expr` | Initializes a constructor field. Init reuses the `->` arrow (see below). |
| `emit Evt(...)` | Records a creation event after the instance is built. |

The factory parameters and a synthetic `id` are the only names in scope. Entity members are **not** in
scope inside the body — the aggregate does not exist yet, so there is no `this` to read from.

## What it emits

The factory above compiles to a static method with a fixed body order: generate the identity, run the
guards, construct via the private constructor with **named** arguments, record events, return.

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
  caller never passes an id — and a factory parameter named `id` is a hard error (see below).
- **Construction uses named arguments.** Each field is passed positionally-by-name, so the order of
  declaration in the factory does not have to match the constructor.
- **Events are recorded after construction**, qualified on the freshly built `instance`.

## The constructor becomes private

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

## The `->` init arrow

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

The right-hand side is evaluated in factory scope, where `id` and the parameters are locals:

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
  it is recomputed from other fields, not stored. See [derived members on value objects](/Koine/reference/value-objects/).
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

## Same-named parameter auto-binds a field

You do not always need an explicit `->`. If a factory parameter's **name and type match a field**, it
auto-binds to that field. In the `Open` example, `customer` and `lines` are passed straight through
(`customer: customer`, `lines: lines`) without a single line of initialization.

```koine
create forCustomer(customer: CustomerId, lines: List<OrderLine>) {
  emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
}
```

The precedence Koine uses to fill each field, highest to lowest:

1. An explicit `field -> expr`.
2. A same-named, same-typed parameter (auto-bind).
3. A field default (`= value`) or an optional `T?`.
4. `default!` for a required field the factory never set — which **also raises an
   `UninitializedFactoryField` warning** (non-fatal; it still compiles).

So a required field is satisfied by either an auto-binding parameter or an explicit `field -> expr`.
If you see the warning, you have a required field with no value flowing into it.

## Creation events

`emit Evt(arg: expr, ...)` records a domain event after the instance is constructed. The event type must
be declared as a sibling member of the aggregate, and the payload may reference `id` and the factory
parameters.

```koine
emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
```

Event field names become PascalCase C# properties, and emitting any event is what triggers Koine to
generate the `DomainEvents` infrastructure on the root. See [aggregates](/Koine/reference/aggregates/)
for how `DomainEvents` is collected and cleared.

## Folding over a parameter collection

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

## Rules and gotchas

- **`id` is reserved.** A factory parameter named `id` is rejected — it collides with the synthetic
  `var id = OrderId.New();`. Never name a create-param `id`.
- **The factory name emits a `public static` method**, so it must not collide with a field, a property,
  a command name, or a synthesized member like `getHashCode`. Two factories with the same name is a
  duplicate-factory error.
- **Placement is strict.** Factories come after members, invariants, `states`, and commands inside the
  `entity` block — and never directly under `aggregate`.
- **`create` is a soft keyword.** It is still legal as a field name (e.g. `create: Int` in a value).
  The same holds for `requires` and `emit`.
- **Empty bodies are fine.** `create make { }` parses and compiles; unset fields fall back to defaults
  (and required ones trigger the uninitialized-field warning).

## See also

- [Aggregates](/Koine/reference/aggregates/) — roots, commands, state machines, and domain events.
- [Entities and identity](/Koine/reference/entities-and-identity/) — id types and the `identified by` clause.
- [Value objects](/Koine/reference/value-objects/) — invariants, operators, and derived members.
