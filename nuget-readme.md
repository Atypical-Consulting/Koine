# Koine

**Koine is a small, readable DSL for Domain-Driven Design.** You write a bounded context's
*ubiquitous language* once in `.koi` files, and the compiler emits idiomatic, self-contained code —
value objects, entities, aggregates, invariants, domain events, state machines, repositories, and the
application/CQRS layer. C# is the primary, most complete target; TypeScript, Python, PHP, Rust, Java,
and Kotlin emitters also ship, alongside living-docs, AsyncAPI, and OpenAPI generators.

The model *is* the ubiquitous language: there is no second copy to keep in sync, and the rules stay
front and centre instead of drowning in boilerplate.

## Install

Install the `koine` command-line compiler as a global .NET tool:

```bash
dotnet tool install --global Koine.Cli
```

Or embed the compiler and emitters in your own project:

```bash
dotnet add package Koine.Compiler
dotnet add package Koine.Emit.All
```

## Learn more

- **Documentation & language reference:** https://atypical-consulting.github.io/Koine/
- **Try it in your browser:** https://atypical-consulting.github.io/Koine/studio/
- **Source & issues:** https://github.com/Atypical-Consulting/Koine

Licensed under Apache-2.0.
