# 0007. Kotlin emitter target

Date: 2026-07-06

## Status

Proposed

<!-- One of: Proposed | Accepted | Rejected | Deprecated | Superseded by [NNNN](NNNN-xxx.md) -->

## Context

Koine compiles one target-agnostic semantic model to C#, TypeScript, Python, PHP, Rust, and — since
[#858](https://github.com/Atypical-Consulting/Koine/issues/858) — Java. The Java brainstorm weighed
"Kotlin first instead of Java", chose Java for reach, and explicitly deferred *"Kotlin can follow as
its own target."* Issue #1066 is that follow-up.

Kotlin stands on its own merits, independent of when the JVM baseline (#858) lands:

- **Android domain layers are Kotlin-first** — a clean dependency-free domain module is exactly what a
  Koine bounded context maps to.
- **Server-side Kotlin is mainstream** (Spring Boot + Kotlin, Ktor, http4k), with a DDD community that
  leans hard on `data class`es and sealed hierarchies.
- **Consuming the emitted Java from Kotlin erases what a DDD model cares about**: unannotated Java types
  arrive in Kotlin as *platform types*, so Koine's optional-vs-required field distinction evaporates at
  the boundary. A native Kotlin emitter expresses optionality in the type system (`T?`, never
  `Optional`), and `sealed` event hierarchies give compiler-enforced exhaustive `when`.

The pipeline is built for exactly this: `.koi → ANTLR parser → Ast/ (target-agnostic) → Semantics/ →
IEmitter`, and since [ADR-driven] issue #861 each backend is a self-contained
`src/Koine.Emit.<Target>` assembly over `Koine.Emit.Common`, registered once in
`BuiltInEmitterProviders.All`. Six code backends already prove the seam.

The open question is whether Kotlin should share a "JVM emitter core" with Java (#858).

## Decision

We will add a **new `--target kotlin` backend** as its own packable **`src/Koine.Emit.Kotlin`**
assembly behind the existing `IEmitter` / `IEmitterProvider` seam, with **zero changes to `Parsing/`,
`Ast/`, or `Semantics/`** (guarded by `AstPurityTests`). It mirrors the structure of the sibling JVM
backend (`Koine.Emit.Java`): one package per bounded context (`<base>.<context>`) plus a shared
`koine.runtime` package, one top-level type per `.kt` file.

We will **not** share a "JVM emitter core" with the Java backend. The emitted shapes diverge on nearly
every construct — `data class` / `@JvmInline value class` vs `record`; `T?` vs `Optional`; `sealed
interface DomainEvent` with exhaustive `when` vs Java's sealed interface; elvis `?:` vs conditional
expressions — so a shared core would degenerate into two code paths behind one facade and would couple
two otherwise-independent issues. The repo's proven grain is one self-contained backend per target.

Concrete choices:

- **Kotlin 2.0 language floor, JVM-only** for Phase 1. Scalar types map to JDK types (`java.time.LocalDate`,
  `java.time.Instant`, `java.math.BigDecimal`, `java.util.UUID`) — the JVM flavor of "dependency-free"
  (stdlib + JDK, no kotlinx-datetime / Arrow / Lombok). A Kotlin Multiplatform variant, which would
  force `kotlinx-datetime` + a decimal library, is a possible later emitter *option*, not Phase 1.
- **Failure model:** invariant violations throw `koine.runtime.DomainException : RuntimeException`,
  parallel to every other backend.
- **Scope: Phase 1** — the tactical core (value objects, generated IDs, smart enums, entities,
  aggregates) plus events/commands/repositories — the same surface Rust (#24) and Python (#21) shipped.
  The strategic/CQRS layer is a deliberate follow-up ("Kotlin Phase 2"), mirroring Python's #21 → #92.

## Consequences

**Easier:**

- Kotlin/Android and server-side-Kotlin teams can fold a `.koi` ubiquitous-language model into their
  codebase natively, preserving optionality and exhaustive event handling that consuming Java output
  would erase.
- The change is fully additive: one new assembly, one provider line in `BuiltInEmitterProviders.All`,
  one `ProjectReference` in `Koine.Emit.All`. The CLI, MCP, and Studio pick the target up from the
  registry with no further wiring.

**Harder / trade-offs accepted:**

- A seventh code backend raises the maintenance surface and sharpens the case for consolidating the
  demand-generated-operator model (#902) and the per-emitter csproj boilerplate (#977).
- Output is JVM-only for Phase 1; a multiplatform audience is not served until a later option lands.
- Conformance depends on a real `kotlinc` on CI. Locally, a missing toolchain makes the
  `KotlinConformanceTests` report **Skipped, never silent green** (the no-silent-toolchain rule),
  resolved from `KOINE_KOTLINC` or PATH.
- The strategic/CQRS layer is absent until "Kotlin Phase 2", so an aggregate's application layer is not
  yet emitted for Kotlin.
