---
title: "Specs, services & policies"
description: "Reusable predicates, domain services, and event-reaction policies."
---

## 13.1 General

Three constructs let you model behaviour that doesn't live inside a single entity: a **spec** names a
reusable business rule, a **service** holds stateless cross-entity operations, and a **policy**
documents how one aggregate reacts to another's domain event. All three are declared at context scope
(specs may also sit at aggregate scope) and stay free of imperative C# — Koine emits predicates, pure
methods, and seams, never hand-written orchestration.

## 13.2 Syntax

```ebnf
spec_declaration
    : 'spec' Identifier 'on' type_name '=' expression
    ;

service_declaration
    : 'service' Identifier '{' service_member* '}'
    ;

service_member
    : operation_decl
    | usecase_decl
    ;

operation_decl
    : 'operation' Identifier '(' param_list? ')' ':' type_ref ( '=' expression )?
    ;

policy_declaration
    : 'policy' Identifier 'when' Identifier 'then' policy_reaction
    ;

policy_reaction
    : type_name '.' soft_name ( '(' policy_arg_list? ')' )?
    ;

policy_arg_list
    : policy_arg ( ',' policy_arg )*
    ;

policy_arg
    : soft_name ':' expression
    ;
```

A `spec` binds a name to a boolean `expression` evaluated in terms of the named `type_name`'s
members. A `service` groups one or more `service_member` entries: each member is either an
`operation_decl` (a typed, optionally pure function) or a `usecase_decl` (an application-layer use
case that emits an async command/query handler — see [Application layer & CQRS (§15)](/Koine/reference/application-cqrs/)
for the full `usecase` grammar and emitted shape). An operation has a typed parameter list, a return
`type_ref`, and an optional `= expression` body that makes it pure. A `policy` names the event
keyword (`when Identifier`) and the target reaction (`type_name.command(...)`); each `policy_arg`
passes a named argument rooted in the event's fields. The expression grammar is specified in
[Expressions (§9)](/Koine/reference/expressions/).

:::note[Example]
A minimal context containing all three constructs:

```koine
context Customers {
  enum LoyaltyTier { Bronze, Silver, Gold }

  entity Customer identified by CustomerId {
    name: String
    tier: LoyaltyTier = Bronze
  }

  event CustomerUpgraded {
    customer: CustomerId
    tier:     LoyaltyTier
  }

  aggregate Rewards root RewardAccount {
    entity RewardAccount identified by RewardAccountId {
      customer: CustomerId
      points:   Int

      command grant(amount: Int) { points -> amount }
    }
  }

  // A reusable rule, inlined wherever it's referenced.
  spec IsVip on Customer = tier == Gold

  // Stateless, pure cross-entity logic.
  service LoyaltyService {
    operation discountRate(tier: LoyaltyTier): Decimal =
      if tier == Gold then 0.10 else if tier == Silver then 0.05 else 0.0
  }

  // A documented cross-aggregate reaction (handler seam emitted).
  policy GrantWelcomePoints when CustomerUpgraded then Rewards.grant(amount: 100)
}
```
:::

## 13.3 Semantics

### 13.3.1 Spec semantics

A `spec N on T = <bool>` binds a boolean predicate to a name that can be referenced by name inside an
[invariant (§10)](/Koine/reference/invariants/), a command `requires` clause, or another spec. A
referenced spec is **inlined** at its use site — composition is flattening, not a method call chain.
You compose specs with the boolean operators `&&`, `||`, and `!`:

```koine
context Shop {
  value Order {
    lineCount: Int
    total:     Int
    invariant IsLarge  "order must be large"
  }
  spec IsLarge on Order = lineCount > 10 || total > 1000
}
```

When `IsLarge` is named as an invariant, its predicate is inlined into the `Order` constructor; a
violation throws `DomainInvariantViolationException`.

:::caution
Referencing an unknown spec, or one whose target type doesn't match where it's used, is a
compile-time diagnostic. Spec composition is **cycle-checked**: a spec that references itself
(directly or transitively) is rejected rather than expanded forever.
:::

:::note
A spec may also be invoked from inside a `service operation` body, as a call on a parameter of the
spec's target type — it translates to the spec's generated extension method, so the call site keeps
the named predicate instead of duplicating its logic:

```koine
context Sales {
  value Order { lineCount: Int  total: Decimal }
  spec IsLarge on Order = lineCount > 10 || total > 1000
  service OrderRouting {
    operation isPriority(o: Order): Bool = o.IsLarge()
  }
}
```

Calling a spec on a receiver whose type is not the spec's declared target is a compile-time
diagnostic (`KOI1006`).
:::

### 13.3.2 Service semantics

A service is a home for logic that belongs to no single object. Operation parameter and return types
are validated against the context's types — a service may reference value objects, entities, enums,
and (as types) aggregates.

The shape of the emitted class depends on the operations it contains:

| Operations | Emitted as |
| --- | --- |
| All have expression bodies (pure) | `public sealed class` with concrete methods |
| Any operation is bodyless | `public abstract class` with that operation as an `abstract` method seam |

A bodyless operation is a deliberate seam — you declare the contract in the model and implement it in
C#:

```koine
service ExchangeRateService {
  operation convert(amount: Money, rate: Decimal): Money = amount * rate  // pure
  operation latestRate(from: String, to: String): Decimal                 // seam (bodyless)
}
```

Because `latestRate` has no body, the whole service becomes an `abstract class` and `LatestRate` an
`abstract` method for the consumer to override.

:::tip
Value-object arithmetic in an operation body — like `amount * rate` above — forces the value object
(here `Money`) to emit its scalar `*` operator. The model stays declarative; the operators follow.
:::

### 13.3.3 Policy semantics

A policy expresses a cross-aggregate reaction in the ubiquitous language: *when this event happens,
that command runs on another aggregate.* The argument expression in each `policy_arg` is rooted in
the event's fields.

:::caution
Koine deliberately does **not** generate the imperative command call — that would be cross-aggregate
orchestration, which the model leaves to you. The reaction is captured as a `<remarks>` sketch so
intent isn't lost. Referencing an unknown event or target command is a diagnostic.
:::

## 13.4 Translation to C#

The table below summarises the emitted shape for each construct:

| Construct | Scope | Emitted file | Emitted shape |
| --- | --- | --- | --- |
| `spec N on T = <bool>` | context or aggregate | `<Context>Specifications.cs` | `static bool N(this T x)` extension-method predicate |
| `service N { operation … }` | context | `<Service>.cs` | `sealed class` (all pure) or `abstract class` (any seam) |
| `policy N when E then …` | context | `<N>Policy.cs` | `I<N>Policy` interface + `abstract partial class <N>Policy` |

### 13.4.1 Spec translation

Each spec becomes one boolean **extension method** on a per-context static class
`<Context>Specifications`, with the target instance bound to the parameter `x`. Because it extends
the target type, you can call it fluently (`customer.IsVip()`) or statically
(`CustomersSpecifications.IsVip(customer)`):

```koine
spec IsVip on Customer = tier == Gold
```

```csharp
public static class CustomersSpecifications
{
    public static bool IsVip(this Customer x) => x.Tier == LoyaltyTier.Gold;
}

// usage: customer.IsVip()  (with `using Customers;` in scope)
```

If a spec body uses a LINQ collection operation, the consuming file pulls in `using System.Linq;`
automatically.

### 13.4.2 Service translation

Because every operation in the example below is pure (has an expression body), the service emits as a
`sealed class` with expression-bodied methods. Operation names become PascalCase methods; parameters
stay camelCase:

```koine
service LoyaltyService {
  operation discountRate(tier: LoyaltyTier): Decimal =
    if tier == Gold then 0.10 else if tier == Silver then 0.05 else 0.0
}
```

```csharp
public sealed class LoyaltyService
{
    public decimal DiscountRate(LoyaltyTier tier)
        => ((tier == LoyaltyTier.Gold) ? 0.10m : ((tier == LoyaltyTier.Silver) ? 0.05m : 0.0m));
}
```

### 13.4.3 Policy translation

A policy emits a **handler interface plus an abstract seam** — the intended call is recorded as
documentation, not generated:

```koine
policy PostToLedger when PaymentCaptured then Ledger.record(amount: capturedAmount)
```

```csharp
public interface IPostToLedgerPolicy
{
    void Handle(PaymentCaptured e);
}

public abstract partial class PostToLedgerPolicy : IPostToLedgerPolicy
{
    /// <remarks>Intended reaction: Ledger.record(amount: e.CapturedAmount).</remarks>
    public abstract void Handle(PaymentCaptured e);
}
```

The policy type is `PascalCase(name) + "Policy"`; the interface prefixes `I`. Inside the `Handle`
body the event is the parameter `e`, so the documented reaction roots its arguments at `e`
(`e.CapturedAmount`). You implement the wiring in a `partial` class.

## 13.5 Full example

Copy-pasteable context combining all three constructs:

```koine
context Customers {
  enum LoyaltyTier { Bronze, Silver, Gold }

  entity Customer identified by CustomerId {
    name: String
    tier: LoyaltyTier = Bronze
  }

  event CustomerUpgraded {
    customer: CustomerId
    tier:     LoyaltyTier
  }

  aggregate Rewards root RewardAccount {
    entity RewardAccount identified by RewardAccountId {
      customer: CustomerId
      points:   Int

      command grant(amount: Int) { points -> amount }
    }
  }

  // A reusable rule, inlined wherever it's referenced.
  spec IsVip on Customer = tier == Gold

  // Stateless, pure cross-entity logic.
  service LoyaltyService {
    operation discountRate(tier: LoyaltyTier): Decimal =
      if tier == Gold then 0.10 else if tier == Silver then 0.05 else 0.0
  }

  // A documented cross-aggregate reaction (handler seam emitted).
  policy GrantWelcomePoints when CustomerUpgraded then Rewards.grant(amount: 100)
}
```

## See also

- [Aggregates, commands & events (§11)](/Koine/reference/commands-events-state/) — the event and command constructs that specs and policies build on.
- [Invariants (§10)](/Koine/reference/invariants/) — the guard expression grammar shared by specs, value objects, and entities.
- [Expressions (§9)](/Koine/reference/expressions/) — the expression grammar used in spec bodies and operation bodies.
- [Value objects (§5)](/Koine/reference/value-objects/) — value objects that service operations may receive and return.
- [Application layer & CQRS (§15)](/Koine/reference/application-cqrs/) — for `usecase` declarations that emit async `I<Service>` interfaces and `IUnitOfWork`.
- [Repositories & concurrency (§14)](/Koine/reference/repositories-concurrency/) — the repository declarations that round out the tactical toolkit.
