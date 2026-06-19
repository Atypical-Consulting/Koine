---
title: "What is Koine?"
description: "Why Koine exists and how the .koi to C# pipeline works at a glance."
---

Koine is a target-agnostic compiler for **Domain-Driven Design**. You describe the *ubiquitous language* of a bounded context once, in plain `.koi` files, and Koine generates the idiomatic, boilerplate-heavy tactical code for you: value objects, entities, aggregates, invariants, commands, events, repositories, and more.

The model is written once and stays free of any host-language concepts. **This release emits C#**, with **TypeScript**, **Python 3.11+**, and **PHP 8.1** emitters also shipping today (all Phase 1: tactical core), and a Rust emitter on the roadmap — the parser and semantic model are kept strictly target-agnostic so a new backend is a new emitter, not a rewrite.

<a class="koi-try" href="/Koine/playground/">Try Koine now — the compiler runs in your browser</a>

## The problem

In a real DDD codebase, the *interesting* part of a value object or entity is tiny — a name, a few fields, an invariant or two. Everything else is mechanical:

- get-only properties and a validating constructor for every value object,
- identity-only equality (and a generated ID type) for every entity,
- defensive copies of collections, structural equality, guard clauses that throw,
- repository interfaces, unit-of-work plumbing, read-model DTOs and their mappers.

That boilerplate is where bugs hide, and it is exactly the code that **drifts from the ubiquitous language** over time. A rule that the team agreed on in a meeting ends up half-implemented across three constructors, or silently deleted in a refactor. The model in your head and the model in your `src/` folder slowly disagree.

## Koine's answer

Write the model — and only the model. Let the compiler own the mechanical translation, deterministically, every build.

```koine
context Catalog {

  enum Currency { EUR, USD, GBP }

  value Money {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "an amount cannot be negative"
  }
}
```

That `value Money` becomes a self-contained C# `sealed class` with get-only `Amount`/`Currency` properties, value equality (via the `ValueObject` runtime base), and a constructor that throws `DomainInvariantViolationException` when `amount` is negative — so an invalid `Money` simply cannot exist:

```csharp
public sealed class Money : ValueObject
{
    public decimal Amount { get; }
    public Currency Currency { get; }

    public Money(decimal amount, Currency currency)
    {
        if (!(amount >= 0))
            throw new DomainInvariantViolationException(
                type: nameof(Money),
                rule: "an amount cannot be negative");

        Amount = amount;
        Currency = currency;
    }

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Amount;
        yield return Currency;
    }
}
```

The same applies up the stack: `entity` emits a `sealed class` with identity-only equality and a generated ID type, `aggregate` wires up an `IAggregateRoot` and an `I<Root>Repository`, `enum` emits a smart enum, and so on. See the [language reference overview](/Koine/reference/overview/) for the full catalogue.

## The name

*Koine* (κοινή) is the Greek for "common" — the lingua franca that unified the Greek-speaking world. The pun is deliberate: Koine is the **common tongue** for your domain. One model, one source of truth, eventually many target languages.

## The pipeline at a glance

```
.koi source
  → Lexer/Parser            (ANTLR-generated)
  → semantic model          (target-agnostic AST)
  → SemanticValidator       (diagnostics with line/column)
  → IEmitter → C# files     (self-contained, no runtime deps)
```

Everything before the emitter is independent of C#. The generated code carries its own tiny `Koine.Runtime` namespace (the `ValueObject` base, exception types, `IAggregateRoot`, and friends), so there is **no package to reference** — you can read, diff, and check the output into source control like any other code.

You drive it from the CLI:

```bash
# Compile a model (or a whole directory) to C#
dotnet run --project src/Koine.Cli -- build Models --target csharp --out ./Generated

# Just parse and validate — no output, exit code tells you if it's clean
dotnet run --project src/Koine.Cli -- build Models
```

:::tip[A green build is a correct domain]
Because every invariant, identity rule, and state transition is generated from the model — and the demo even compiles and executes the emitted C# in its test suite — a build that goes green means your domain *as written* is internally consistent. The ubiquitous language and the code can no longer quietly disagree.
:::

## What's in the box

Koine is feature-complete through epic R15. The full tactical and strategic toolkit is supported: value objects, entities, aggregates, smart enums, derived/computed fields, regex and conditional invariants, optional fields and sets, commands, domain events, state machines, factories, quantities and ranges, specifications, domain and application services, repositories with finders, optimistic concurrency, read models, queries, multi-file imports and modules, context maps, and model versioning. The [Shop demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo) exercises every one of them in a compiling six-context domain.

## Next steps

- [Installation](/Koine/start/installation/) — get the `koine` CLI and editor tooling set up.
- [Your first model](/Koine/start/your-first-model/) — write a `.koi` file and compile it to C# in a few minutes.
