---
title: "Specs, services & policies"
description: "Reusable predicates, domain services, and event-reaction policies."
---

Three constructs let you model behaviour that doesn't live inside a single entity: a **spec** names a reusable
business rule, a **service** holds stateless cross-entity operations, and a **policy** documents how one
aggregate reacts to another's domain event. All three are declared at context scope (specs may also sit at
aggregate scope) and stay free of imperative C# — Koine emits predicates, pure methods, and seams, never
hand-written orchestration.

## `spec` — named, reusable predicates

A specification names a boolean rule over a value object or entity:

```koine
spec IsVip on Customer = tier == Gold
```

The expression is written in terms of the target type's members — `tier` refers to `Customer.tier`. Each spec
becomes one boolean **extension method** on a per-context static class `<Context>Specifications`, with the
target instance bound to the parameter `x`. Because it extends the target type, you can call it fluently
(`customer.IsVip()`) or statically (`CustomersSpecifications.IsVip(customer)`):

```csharp
public static class CustomersSpecifications
{
    public static bool IsVip(this Customer x) => x.Tier == LoyaltyTier.Gold;
}

// usage: customer.IsVip()  (with `using Customers;` in scope)
```

### Composing and referencing specs

Specs are referenceable by name — inside an [invariant](/Koine/reference/invariants/), a command `requires`
clause, or another spec. A referenced spec is **inlined** at its use site (composition is
flattening, not a method call chain). You compose them with the boolean operators `&& || !`:

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

When `IsLarge` is named as an invariant, its predicate is inlined into the `Order` constructor; a violation
throws `DomainInvariantViolationException`. If a spec body uses a LINQ collection operation, the consuming
file pulls in `using System.Linq;` automatically.

:::caution
Referencing an unknown spec, or one whose target type doesn't match where it's used, is a compile-time
diagnostic. Spec composition is **cycle-checked**: a spec that references itself (directly or transitively)
is rejected rather than expanded forever.
:::

:::note
A spec referenced from inside a `service operation` body is not yet supported (v0). Specs compose with each
other and into invariants/preconditions today.
:::

## `service` — stateless domain operations

A service is a home for logic that belongs to no single object. Each `operation` has a signature and,
optionally, a pure expression body:

```koine
service LoyaltyService {
  operation discountRate(tier: LoyaltyTier): Decimal =
    if tier == Gold then 0.10 else if tier == Silver then 0.05 else 0.0
}
```

Because every operation here is pure (has an expression body), the service emits as a **`sealed class`** with
expression-bodied methods. Operation names become PascalCase methods; parameters stay camelCase:

```csharp
public sealed class LoyaltyService
{
    public decimal DiscountRate(LoyaltyTier tier)
        => ((tier == LoyaltyTier.Gold) ? 0.10m : ((tier == LoyaltyTier.Silver) ? 0.05m : 0.0m));
}
```

### Pure operations vs. bodyless seams

The shape of the emitted class depends on the operations it contains:

| Operations | Emitted as |
| --- | --- |
| All have expression bodies (pure) | `public sealed class` with concrete methods |
| Any operation is bodyless | `public abstract class` with that operation as an `abstract` method seam |

A bodyless operation is a deliberate seam — you declare the contract in the model and implement it in C#:

```koine
service ExchangeRateService {
  operation convert(amount: Money, rate: Decimal): Money = amount * rate  // pure
  operation latestRate(from: String, to: String): Decimal                 // seam (bodyless)
}
```

Because `latestRate` has no body, the whole service becomes an `abstract class` and `LatestRate` an
`abstract` method for the consumer to override.

:::tip
Value-object arithmetic in an operation body — like `amount * rate` above — forces the value object (here
`Money`) to emit its scalar `*` operator. The model stays declarative; the operators follow.
:::

Operation parameter and return types are validated against the context's types — a service may reference
value objects, entities, enums, and (as types) aggregates.

## `policy` — react to a domain event

A policy expresses a cross-aggregate reaction in the ubiquitous language: *when this event happens, that
command runs on another aggregate.*

```koine
policy PostToLedger when PaymentCaptured then Ledger.record(amount: capturedAmount)
```

This reads as: when a `PaymentCaptured` [event](/Koine/reference/aggregates/) is raised, post the captured
amount to the `Ledger` aggregate via its `record` command. The argument expression (`capturedAmount`) is
rooted in the event's fields.

Koine emits a **handler interface plus an abstract seam** — the intended call is recorded as documentation,
not generated:

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

The policy type is `PascalCase(name) + "Policy"`; the interface prefixes `I`. Inside the `Handle` body the
event is the parameter `e`, so the documented reaction roots its arguments at `e` (`e.CapturedAmount`). You
implement the wiring in a `partial` class.

:::caution
Koine deliberately does **not** generate the imperative `Ledger.record(...)` call — that would be cross-aggregate
orchestration, which the model leaves to you. The reaction is captured as a `<remarks>` sketch so intent isn't
lost. Referencing an unknown event or target command is a diagnostic.
:::

## Where they live

| Construct | Scope | Emitted file | Emitted shape |
| --- | --- | --- | --- |
| `spec N on T = <bool>` | context or aggregate | `<Context>Specifications.cs` | `static bool N(this T x)` extension-method predicate |
| `service N { operation … }` | context | `<Service>.cs` | `sealed class` (all pure) or `abstract class` (any seam) |
| `policy N when E then …` | context | `<N>Policy.cs` | `I<N>Policy` interface + `abstract partial class <N>Policy` |

These constructs round out the tactical toolkit alongside [aggregates, commands &
events](/Koine/reference/aggregates/) and [value objects](/Koine/reference/value-objects/). For application-level
`usecase` services that emit an async `I<Service>` interface and `IUnitOfWork`, see the
[application layer & CQRS](/Koine/reference/application-cqrs/) reference.

## Full example

Copy-pasteable context combining all three:

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
