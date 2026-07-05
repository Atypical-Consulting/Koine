# 0006. Transport/presentation as opt-in C# layers inside the csharp target

Date: 2026-07-05

## Status

Proposed

## Context

Koine emits a domain + application + infrastructure C# core (value objects, entities, aggregates,
invariants, CQRS handlers/validators, the `Add<Context>Application` DI extension, and — since issue
#128 — an infrastructure layer with DbContext, repositories, and an outbox+dispatcher). Then it
stops at the transport edge: there is no runnable ASP.NET endpoint emitter and no SignalR/realtime
emitter in `src/`. The `openapi`/`asyncapi` targets emit *spec documents* for that surface, but no
code binds a request to a handler or pushes an event to a connected client.

A cross-repo audit of **Linelo** — a QR-code virtual-queue app that uses Koine for its domain and
infrastructure and hand-writes everything above — measured *why* 585 lines of application/API/realtime
code stayed hand-written. It found one design mismatch that makes the existing Application layer
unadoptable for CRUD/realtime-shaped apps (handlers return `void` and `throw` on a missing aggregate),
and two capabilities Koine doesn't yet emit: an endpoint layer and a realtime layer. The roadmap
`docs/roadmap/vertical-stack-emitters.md` turns those findings into five workstreams (W1–W5).

Two of those workstreams — an ASP.NET endpoint/DTO layer (W2) and a SignalR/realtime layer (W3) —
take Koine one presentation layer higher than it has gone before, which raises a scope question worth
recording rather than deciding silently in a PR. This is **not** a pivot to a full-stack scaffolder:
the new surface is opt-in, additive, reversible, and generates only the *mechanical binding
skeleton*. App-specific policy — authentication, status-code choices, cookies, SignalR group keys —
stays hand-written (or hand-annotated) by design. Thin, uniform, always-in-sync transport binding is
a well-precedented generation target (tRPC, Rails scaffolds, OpenAPI codegen); the honest design axis
is not *whether* to generate it but *how override-friendly* the generated code is.

The remaining question the audit surfaced is *where* these capabilities live in Koine's target model:
a new `--target`, or a new layer inside the existing `csharp` target. The endpoint/hub code must
reference the exact C# types the `csharp` target already emits (per-command request records,
handlers, validators, query handlers, `I<Service>` impls, the DI extension). A separate `--target`
emits into a disjoint compilation with no shared namespace, forcing duplication or cross-assembly
references Koine does not model — whereas the layered machinery (`--layers
domain,application,infrastructure`) already treats presentation as a natural layer above
`application`, and `Infrastructure` is the standing precedent for a C# layer that emits runnable,
domain-referencing code.

## Decision

We will add transport/presentation capabilities as **opt-in C# layers inside the `csharp` target,
not as new `--target`s**, and govern them by the following rules.

1. **Layers, not targets.** New presentation capabilities are new `CSharpLayer` values (`api`,
   `realtime`) emitted by new `CSharpEmitter.*.cs` partials, selected via `--layers`, and off by
   default. They live in the same compilation as the application layer and reference its emitted
   types directly. Adding one is never a change to `Ast/` or the emit contracts — it reuses
   `CSharpTypeMapper`, `CSharpNaming`, `UsingCollector`, and the existing 8-hop option-plumbing chain.

2. **`openapi`/`asyncapi` stay the spec counterparts.** They remain `--target`s that emit the
   spec-document view of the same surface (`openapi.yaml`, `asyncapi.yaml`). The AST-only route/channel
   derivation currently baked into those emitters is extracted into `Koine.Emit.Common` so the spec
   emitters and the new code layers share one source of truth rather than diverging.

3. **Convention-first, with annotation escape hatches.** v1 layers ship on convention (OpenApi-style
   `verb`/`route` derivation for `api`; broadcast-per-aggregate-identity for `realtime`) with no
   grammar change. App-specific overrides are a later, additive step: `@route`/`@get`/`@post`/`@auth`
   on commands/queries need one small grammar change (add `annotation*` to the `command`/`query`/
   `usecase` decl rules), while `@broadcast` on an integration event needs none (integration events
   already carry an `annotation*` prefix). Honest scope: the layers generate the mechanical binding
   skeleton; policy that the model does not carry (auth, status codes, cookies, group/partition keys)
   stays hand-annotated.

4. **No emitted project files.** Koine never emits `.csproj`, `PackageReference`, or
   `Directory.Packages.props`. Generated code references framework/third-party types by
   fully-qualified name and the consumer supplies the package (precedent: FluentValidation in the app
   layer, EF Core in infra). The `api`/`realtime` layers reference ASP.NET/SignalR by FQN and this
   plan *documents* the required `<FrameworkReference Include="Microsoft.AspNetCore.App" />`; the
   framework opinion is thereby bounded by (a) the layers being opt-in and (b) the consumer owning the
   package graph.

5. **Output organization: layer-folders by default, assembly split opt-in, arch-test optional.** The
   less-opinionated default is a single project with layer-named folders. A per-layer **assembly
   split** is opt-in (requires lifting the current "opt-in layers always imply `domain`" rule so a
   layer can emit standalone). Real layering *enforcement* is an **optionally-emitted architecture
   test** (a reflection-based fixture asserting the dependency direction), not something the physical
   assembly boundary is relied on to guarantee.

W1 (make the Application layer adoptable) and W4 (land the reserved Mapperly mapping) change no
decision on record — they are additive options within the existing `csharp` target and the existing
`ApplicationMapping` reserved value — and therefore **do not require an ADR**. They are sequenced
first only because they are strictly lower-risk and block nothing by waiting.

## Consequences

- **Presentation code stays in sync with the domain for free.** Endpoints and hubs reference the
  emitted app-layer types by name, so a domain change that alters a command or query is a compile
  error in the generated transport layer rather than silent drift — the property that motivates
  generating this surface at all.
- **Multi-target transport duplication is accepted, by name.** Because `api`/`realtime` are C#
  *layers*, they oblige nothing of the TypeScript/Python/PHP/Rust targets — "a further emitter is a
  new project." If those targets ever want their own transport layer, that binding logic is written
  per-target and will duplicate the *shape* of the C# one. We accept that: the alternative (a
  target-agnostic transport model in `Ast/`) would leak framework concepts into the semantic model
  and violate the invariant that keeps multiple emitters possible.
- **Framework opinion enters the emitter, but bounded.** The C# emitter now knows about ASP.NET
  Minimal APIs and SignalR. That opinion is contained by the layers being opt-in (default output is
  unchanged and byte-identical) and by the no-emitted-csproj policy (Koine expresses a *reference*,
  never a version or a package graph the consumer must accept).
- **v1 generates a skeleton, not a finished app.** Convention-first output covers the mechanical
  binding; auth glue, non-default status codes, cookies, and custom group keys stay hand-written
  until the annotation escape hatches land. This is intended, but it means the acceptance bar for
  W2/W3 is "regenerates the mechanical portion of Linelo's `Endpoints.cs`/`QueueHub.cs`," not "deletes
  all hand-written transport code."
- **Layering is enforced by an opt-in test, not the type system.** Choosing single-project
  layer-folders as the default keeps the common case simple but means nothing physically prevents a
  cross-layer reference unless the consumer opts into the emitted arch-test (or the assembly split).
  We prefer an honest, opt-in enforcement seam over forcing an assembly-per-layer structure on every
  generated app.
- **The layer surface grows without touching the core.** Each future presentation capability is a new
  `Koine.Emit`-side partial + option, guarded by the existing off-is-byte-identical and incremental
  fingerprint tests; the parser, semantic model, and emit contracts stay closed to it.
