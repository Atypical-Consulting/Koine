---
title: "Introducing Koine: a language for your domain"
description: "Koine is a DSL for Domain-Driven Design — write a bounded context's ubiquitous language once in a .koi file and compile idiomatic, self-contained C#. Here's why it exists and how the pipeline works."
excerpt: "You already write the ubiquitous language down — in tickets, in diagrams, in a wiki nobody reads. Koine makes it the source code, and compiles the boilerplate for you."
date: 2026-06-03
authors:
  - phmatray
tags:
  - announcement
  - domain-driven-design
  - dsl
---

Every Domain-Driven Design project starts with the same promise: the **ubiquitous language** is the
single source of truth. A `Money` value object cannot be negative; an `Order` in `Draft` has no
lines; an email must look like an email. Everyone agrees. Then the language gets written down three
times — in a wiki, in a class diagram, and (eventually, partially, drifting) in C# — and the three
copies start disagreeing the moment the first deadline lands.

**Koine** removes two of those copies. You write the bounded context's ubiquitous language **once**,
in a small readable DSL, and the compiler emits the idiomatic C# for you: value objects, entities,
aggregates, invariants, commands, events, state machines, repositories, the application/CQRS layer,
and context maps.

## The five-minute version

Here is a slice of a `Billing` context — a value object with an invariant, a regex-validated email,
a smart enum, and an entity with identity:

```koine
context Billing {

  value Money {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0        "a monetary amount cannot be negative"
  }

  enum Currency { EUR, USD, GBP }

  value Email {
    raw: String
    invariant raw matches /^[^@]+@[^@]+$/   "invalid email address"
  }

  entity Customer identified by CustomerId {
    name:  String
    email: Email
  }
}
```

Run `koine build billing.koi --target csharp --out ./generated` and you get a predictable, nested tree:
one folder per context, sub-folders by category (`ValueObjects/`, `Enums/`, `Entities/`, …), plus a
tiny `Koine/Runtime/` folder with the shared marker types. For example, `Money` lands at
`Billing/ValueObjects/Money.cs` and `Currency` at `Billing/Enums/Currency.cs` — namespaces stay flat
(`namespace Billing;`), only the folders are categorised. The emitted `Money.cs` is a
`sealed class : ValueObject` whose constructor throws **before** an invalid instance can exist — no
NuGet dependency, no reflection, nothing to learn. It's the C# you'd have written by hand on a good
day, every time.

## Why a *language*, not a library

Plenty of tools give you a DDD base library — a `ValueObject<T>`, a `Result`, an aggregate base class.
They help, but they leave the actual modeling work (and all the boilerplate) to you, and they put a
runtime dependency between your domain and the framework.

Koine takes the opposite bet. The `.koi` file is the model; the C# is **output**, not a contract you
implement against. That has three consequences worth the trade:

- **The model reads like the domain.** `invariant amount >= 0 "a monetary amount cannot be negative"`
  is a sentence a domain expert can check. The generated guard clause is a detail.
- **The output is yours.** It's plain, dependency-free C# you can read, review in a pull request, and
  commit to git. Delete Koine tomorrow and the generated code still compiles.
- **A green build proves the domain.** Every emitted type is snapshot-tested *and* compiled-and-run
  through an in-memory Roslyn meta-test. When the test suite is green, the generated C# is correct.

## How the pipeline works

Koine is strictly layered, and the parser and semantic model are kept **target-agnostic** on purpose:

```
.koi source
  → ANTLR lexer/parser
  → semantic model        (no C# concepts live here)
  → semantic validator    (diagnostics with line/column)
  → emitter               (C# today; TypeScript in progress)
  → idiomatic source files
```

Because no C# concept leaks into the semantic model, adding a second target is "write another
emitter," not "rewrite the compiler." C# ships today, a TypeScript emitter is in progress, and Rust is
on the roadmap.

## Try it without installing anything

The whole compiler runs in your browser as a WebAssembly module. Open the
[Playground](/Koine/playground/), edit the model, and watch it recompile to C# the moment you stop
typing — no install, no server.

When you're ready to go deeper, [What is Koine?](/Koine/start/what-is-koine/) walks through the
pipeline, and [your first model](/Koine/start/your-first-model/) gets you to generated code in a few
minutes. Welcome to Κοινή — the common tongue of your domain.
