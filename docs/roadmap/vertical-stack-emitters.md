# Roadmap — Generate a real app's full vertical stack

**Status:** proposed · **Date:** 2026-07-05 · **Scope:** the `csharp` target (`Koine.Emit.CSharp`)

**Provenance.** This plan came out of a cross-repo audit of **Linelo** — a QR-code virtual-queue app that uses Koine for its domain + infrastructure layers and hand-writes everything above. The audit measured *why* Linelo still hand-writes 585 lines of application/API/realtime code and found: (1) one design mismatch that makes the **existing** Application layer unadoptable for apps of Linelo's shape, and (2) two natural opt-in layers Koine doesn't yet emit (endpoints, SignalR) — legitimate transport/presentation generation targets, not defects. Every workstream below is grounded in a concrete slice of Linelo's hand-written code as its acceptance target. All `file:line` anchors are against the current tree.

> **North star:** Koine already emits a domain + application + infrastructure C# core. Extend it — opt-in — with the transport and presentation layers so a realtime CRUD-style app can be generated end-to-end: thin, uniform, always-in-sync bindings, with app-specific policy staying hand-annotated. Linelo is the reference consumer that proves each step out.

---

## Summary

| # | Workstream | Effort | Sequence | Proves out on Linelo by generating |
|---|---|---|---|---|
| **W1** | Handler-shape options (make the Application layer adoptable) | M | — | the `QueueAppService` write path (282 LOC) |
| **W2** | ASP.NET endpoint/DTO C# layer (`api`, opt-in) | L | after W1 | uniform GET/POST binding in `Endpoints.cs` (8 GET + 17 POST) + DTO half of `Contracts.cs` |
| **W3** | SignalR/realtime C# layer (`realtime`, opt-in) | L | after W1 | the uniform push skeleton in `QueueHub.cs` + `QueueBroadcaster` (34 LOC) |
| **W4** | Land Mapperly mapping (finish a reserved feature) | M | — | the dispersed inline domain↔DTO projections |
| **W5** | `Layout` = single-project layer folders (default) + opt-in assembly split + optional emitted reflection arch-test | M–L | — | single-project `layerFirst` tree + an arch-test; opt-in `Linelo.{Domain,Application,Infrastructure}` split |

**Sequencing (risk-ordered, not priority-ordered):** do **W1** and **W4** first — they change no decision on record, are strictly lower-risk, and block nothing by waiting. Then **W2 ∥ W3** (the opt-in presentation layers; sequenced after W1 by recommendation, not hard dependency). **W5** any time. Sequencing W2/W3 later reflects risk order alone — they are in-thesis, not suspect.

---

## Governing architecture decision

**Add the new capabilities as *opt-in* C# layers inside the `csharp` target — not as new `--target`s.** Both audit passes concurred. Adding them as C# layers obliges nothing of the other targets — per the repo's own rule, "a further emitter is a new project" — so the ASP.NET/SignalR opinion is bounded twice over: by being opt-in layers, and by the package policy (Koine emits no csproj/PackageReference; consumers supply packages and the code references framework types by FQN). Reasoning:

- The endpoint/hub code must **reference the C# types the `csharp` target already emits** — per-command request records + handlers + validators, per-query query handlers, per-service `I<Service>` impls, and the `Add<Context>Application` DI extension (`CSharpEmitter.Application.cs`). A separate `--target` emits into a disjoint compilation with no shared namespace, forcing duplication or cross-assembly references Koine doesn't model.
- The layered machinery already exists (`--layers domain,application,infrastructure`); endpoints/realtime are a natural, opt-in **presentation/transport** layer above `application` — enabled only when the consumer asks for it.
- Free reuse of `CSharpTypeMapper`, `CSharpNaming`, `UsingCollector`, `EmitContext` in the same emitter.
- **Precedent:** `Infrastructure` (issue #128) is already a C# layer that emits runnable, domain-referencing code (DbContext, repositories, outbox+dispatcher). Web/Realtime are the same shape.
- Keep the `openapi`/`asyncapi` `--target`s as the **spec-document** counterparts of the same surface.

> This decision is ratified as **[ADR-0006](../../adr/0006-transport-presentation-as-opt-in-csharp-layers.md)** — *Transport/presentation as opt-in C# layers inside the csharp target*. This doc is the implementation plan; the ADR is the one-page decision record.

---

## Shared implementation rules

These apply to every new option/layer below.

### The 8-hop option-plumbing chain

Every new C# option threads through these hops. Miss hop 4 or 5's `Empty` short-circuit and an unconfigured build stops being byte-identical (breaks the "off is identical" tests); miss hop 8 and a warm `--out` build won't regenerate when the option flips.

| Hop | File | Where |
|---|---|---|
| 1. CLI flag + help | `src/Koine.Cli/Commands/BuildCommand.cs` | `[CommandOption]` in `BuildSettings` (`:17-63`); merge/validate/write in `TryResolve` (merge `:120-121`, validate `:127-131`, `targetOptions with {…}` `:143-148`) |
| 2. Config key | `src/Koine.Cli/KoineConfig.cs` | `TargetOptions` param (`:16-25`); `ApplyTargetKey` switch (`:233-273`); `TargetBuilder` field (`:312-322`) + `Build()` (`:324-330`) |
| 3. Neutral bag | `src/Koine.Compiler/Emit/EmitterOptions.cs` | record positional param (`:30-40`) |
| 4. TargetOptions → neutral | `src/Koine.Cli/Infrastructure/EmitterRegistry.cs` | `ToEmitterOptions` (`:107-133`) — add to the `Empty` short-circuit (`:116-122`) **and** the ctor (`:129-132`) |
| 5. neutral → C# | `src/Koine.Emit.CSharp/CSharpEmitterProvider.cs` | `ToCSharpOptions` (`:27-51`) — add to the `Empty` short-circuit (`:32-38`) **and** the ctor (`:47-50`) |
| 6. C# options | `src/Koine.Emit.CSharp/CSharpEmitterOptions.cs` | record positional param (`:108-117`) + optional computed prop (pattern at `:126`, `:133`) |
| 7. Consume | the relevant `CSharpEmitter.*.cs` partial | the emit methods |
| 8. Incremental fingerprint | `src/Koine.Emit.CSharp/CSharpEmitter.cs` | append to the options fingerprint array (`:69-82`) — guarded by `IncrementalEmitTests` |

### New-C#-layer checklist (W2/W3)

- [ ] Enum member on `CSharpLayer` (`CSharpEmitterOptions.cs:41-51`) — its lower-cased name **must** equal the CLI token (`CSharpEmitter.cs:71` lower-cases for the fingerprint).
- [ ] Computed `EmitsX` prop (`CSharpEmitterOptions.cs` after `:133`).
- [ ] Gate in `CSharpEmitter.cs` after `:364`, mirroring `:349` / `:361`.
- [ ] New partial `CSharpEmitter.<Layer>.cs` (`public sealed partial class CSharpEmitter`) modelled on `CSharpEmitter.Application.cs`.
- [ ] `KindFolder` const (`CSharpEmitter.cs:2259-2280`) for the output subfolder.
- [ ] `ParseLayers` recognizes the token (`CSharpEmitterProvider.cs:59-80`).
- [ ] `ValidLayers` allowlist (`BuildCommand.cs:157-158`) — else `--layers <name>` is a hard error.
- [ ] `TryResolveLayers` normalization (`BuildCommand.cs:186-221`) — add a `wantsX` flag mirroring `wantsInfrastructure` (`:201-205`).
- [ ] **Fix `WithApplicationLayer` (`BuildCommand.cs:230-242`)** — it rebuilds the layer list preserving only `infrastructure` (`:232-238`) and will **silently drop the new layer** when `--app-mediatr`/`--app-mapping` imply application. Add preservation for the new layer.
- [ ] CLI help `[Description]` (`BuildCommand.cs:49-51`).
- [ ] No new config key needed — `targets.csharp.layers` already accepts arbitrary comma tokens (`KoineConfig.cs:244-247`); validation lives only in `ValidLayers`.

### Testing every option/layer

Project `tests/Koine.Compiler.Tests`, suite under `Emit/CSharp/`. Ship **both** styles:

- **Assertion facts** (`R18CSharp*Tests.cs`): for each new option/layer add (1) a config-parse fact, (2) a `BuildSettings.TryResolve` flag fact, (3) an **off-is-byte-identical** fact (template: `Application_layer_off_is_byte_identical_to_the_default_emitter`, `R18CSharpApplicationTests.cs:109-118`), (4) a bad-value hard-error fact.
- **Verify snapshot** (`EmitterSnapshotTests.cs` + `Snapshots/*.verified.txt`): one golden-file fact per new emitted shape, so the generated diff is reviewable.

### Package/dependency policy

Koine **never** emits `.csproj`/`PackageReference`/`Directory.Packages.props` — generated code references third-party types by fully-qualified name and the **consumer** supplies the package (precedent: FluentValidation in the app layer, EF Core in infra — Linelo hand-adds `Microsoft.EntityFrameworkCore` for the generated infra layer). Keep this contract: W2/W3 emit ASP.NET/SignalR by FQN and this plan **documents** the required `<FrameworkReference Include="Microsoft.AspNetCore.App" />`; W4 documents `Riok.Mapperly`.

---

## W1 — Make the Application layer adoptable  *(foundational · effort M · no deps)*

**Problem.** The generated command handlers return `void` and `throw InvalidOperationException` on a missing aggregate. Apps whose commands return an updated projection and map missing → 404 (Linelo, and most CRUD/realtime apps) cannot adopt them without re-loads and exception-to-404 translation — a net *increase* in hand-written code. This is the primary blocker for apps of Linelo's shape — the main reason Linelo's Application layer stayed hand-written.

**The shape is already half-present:** factory handlers do `return aggregate;` (`Application.cs:212`), and command handlers return `result` when the operation declares a `ReturnType` (`:162-167`). The `void`+`throw` path is confined to a few exact sites.

**Three new options, all consumed in `CSharpEmitter.Application.cs`:**

| Option | Values | Edit sites | Notes |
|---|---|---|---|
| `HandlerResult` | `void` · `aggregate` · `readModel` | void/result branch `:157-167`; `HandlerSignature :261-269`; `WriteVoidReturn :280-287`; `EmitRequestRecord :227-242` | `aggregate` → `return aggregate;`. `readModel` reuses the `To<RM>()` projection (`CSharpEmitter.Cqrs.cs:133-160`) + the read-model lookup the query handler already does (`Application.cs:446-460`). New enum `CSharpHandlerResult` beside `CSharpMappingMode` (`CSharpEmitterOptions.cs:23-30`); flag `--app-handler-result`, config `application.handlerResult`. |
| `NotFoundPolicy` | `throw` · `nullable` · `result` | the two not-found sites `:153-154` and `EmitQueryHandler :476-477`; `HandlerSignature :261-269` | **`nullable` is the cheapest adoption path** — `Task<T?>` + `if (aggregate is null) return null;`, no new runtime type. `result` needs a generated `Result<T>` (new emit in `CSharpEmitter.Runtime.cs`, sibling to `IDomainEvent` `:47-55`). Flag `--app-not-found`, config `application.notFound`. |
| `PostCommitDispatch` | bool | `WriteHandlerHeader :244-258` (inject `IDomainEventDispatcher`); after commit in `EmitCommandHandler :145-177` + `EmitFactoryHandler :201-221`; register in `EmitDiExtension :611-648` | **~80% wired already:** aggregates expose `DomainEvents` + `ClearDomainEvents()` (`CSharpEmitter.Entities.cs:152-169`, gated on `EmitsEvents`), but the handler never dispatches them. Add: emit an `IDomainEventDispatcher` interface, loop `aggregate.DomainEvents` after `SaveChangesAsync`, then `ClearDomainEvents()`. In MediatR mode the natural home is the emitted `TransactionBehavior` (`:578-605`). **This is the seam a SignalR broadcast rides** (→ W3). Flag `--app-dispatch-events`, config `application.dispatchEvents`. |

**Acceptance.** With `HandlerResult=aggregate` + `NotFoundPolicy=nullable`, a hand-written service can delegate its write path to the generated handlers with no re-load and no 404 translation — the exact blocker Linelo hit.

---

## W2 — ASP.NET endpoint/DTO layer (`api`)  *(opt-in presentation layer · effort L · sequence after W1)*

**What it is.** An opt-in C# presentation layer that emits the mechanical HTTP↔handler binding for the commands and queries the `csharp` target already produces. Koine emits an OpenAPI **spec** (`openapi` target → `openapi.yaml`) but no runnable endpoints; there is no `app.MapPost/MapGet` or HTTP DTO emitter anywhere in `src/`. A thin, uniform, always-in-sync transport skeleton is a valuable generation target in its own right — the same well-trodden shape as tRPC, Rails resource scaffolding, and OpenAPI client/server codegen. Because the routing is derived from the domain, the binding never drifts from the handlers it fronts.

**Design.** New `CSharpLayer.Api` + `CSharpEmitter.Api.cs` emitting a `MapGroup`/`MapPost`/`MapGet` extension that binds each command→POST / query→GET to the app layer's handler and returns its DTO.

**W2.0 — prerequisite refactor.** ✅ **Done (#1042).** OpenApi's route derivation was **AST-only** (reads AST + `ModelIndex`, no YAML input) but used to be baked into `YamlObject` and `private static` on `OpenApiEmitter`. It is now a target-agnostic `RouteDerivation` helper — `(entity, command|query) → { verb, route, operationId, requestShape, responseShape }` — in [`src/Koine.Emit.Common/RouteDerivation.cs`](../../src/Koine.Emit.Common/RouteDerivation.cs), consumed by **both** OpenApi (renders YAML, `OpenApiEmitter.Paths.cs`) and the `api` layer (renders endpoints, `CSharpEmitter.Api.cs`); OpenApi's Verify snapshots stayed byte-identical across the extraction. The shared atoms:

- verb: `RouteDerivation.ForCommand(...)` → `POST`, `RouteDerivation.ForQuery(...)` → `GET`
- route: `RouteDerivation.ForCommand(entity, command).Route` = `/{Kebab(entity)}/{Kebab(command)}`, `RouteDerivation.ForQuery(query).Route` = `/{Kebab(query)}`; the acronym-aware `RouteDerivation.Kebab` is now the single implementation both targets share — the extraction also fixed a divergence where the `api` layer's old private `Kebab` dashed before *every* uppercase, splitting an acronym like `XMLImport` differently from OpenApi's
- operationId: `RouteDerivation.ForCommand(entity, command).OperationId` = `{Entity}_{Command}`, `RouteDerivation.ForQuery(query).OperationId` = `query.Name`
- request/response shapes: `RouteInfo.RequestShape` (`command.Parameters` / `query.Criteria`), `RouteInfo.ResponseShape` (`command.ReturnType` / `query.ResultType`)

Request/response **records** need not be re-derived — reuse the Application layer's already-emitted command request records + read-model DTOs; the `api` layer emits only the binding.

**Scope of what's generated (honest acceptance).** v1 generates the *mechanical* binding skeleton — the uniform command→POST / query→GET wiring that's identical for every operation and therefore high-value to codegen and error-prone to hand-maintain. App-specific policy — authentication, non-default status codes, cookies, content negotiation — stays hand-annotated: it's genuinely per-app and stays out of v1 until the `@auth`/`@route`/status annotations land (v2). This is a convention-first layer with annotation escape hatches as the maturation path, not a gap to be closed before shipping.

**Sequencing (recommended, not required).** The `api` layer binds to the Application layer's *already-emitted* command request records and read-model DTOs, which exist today independent of W1. W1 only improves the *returned* shape (`HandlerResult=readModel`, `NotFound→404`), so it is a quality precedent that makes the generated endpoints cleaner — not a compile-time blocker. Sequence W2 after W1 by preference, not necessity.

**Grammar:** none for v1 (ship on the OpenApi convention). Optional `@route`/`@auth`/status annotations are the v2 override axis — see *Grammar note* (one small change adds `annotation*` to the `command`/`query` decl rules).

**Packages:** consumer adds `<FrameworkReference Include="Microsoft.AspNetCore.App" />` (per the package policy — Koine emits no csproj/PackageReference; the code references ASP.NET types by FQN).

**Acceptance.** Regenerates the uniform GET/POST binding in Linelo's `Endpoints.cs` — the 8 GET (query→GET) + 17 POST (command→POST) of its 149 LOC — plus the DTO half of `Contracts.cs`. The remaining 1 PUT (a non-default verb) and Linelo's bespoke cookie-auth glue stay hand-written until the verb/`@route` and `@auth` annotations land — the expected v1/v2 seam, not a shortfall.

---

## W3 — SignalR/realtime layer (`realtime`)  *(opt-in presentation layer · effort L · sequence after W1)*

**What it is.** An opt-in C# presentation layer that emits the mechanical realtime transport for the domain events the `csharp` target already produces. Koine emits an AsyncAPI **spec** (`asyncapi` target → `asyncapi.yaml`) from integration events, but no `Hub`/`IHubContext`/broadcaster C#. As with W2, a thin, uniform push layer that stays in lock-step with the events it broadcasts is a valid, valuable generation target.

**Design.** New `CSharpLayer.Realtime` + `CSharpEmitter.Realtime.cs` emitting a `Hub` + typed client-contract + broadcaster, riding W1's `PostCommitDispatch` seam.

**Reuses cleanly from AsyncApi (AST-only):**
- integration-event payload (`IntegrationEventDecl.Members`, `AsyncApiEmitter.Schemas.cs`) → a message DTO record
- event/channel (`AsyncApiEmitter.Channels.cs:18-58`) → a broadcast-method name / typed client-contract method
- `subscribes` → the `IHandle<Event>` handler seam Koine already emits

**Genuinely unmodeled — stays hand-annotated in v1:**
- **group/partition keys** — Linelo's `queue:{id}` / `merchant:{slug}` have no analog in the model today; integration events fan out to whole subscriber *contexts*, not per-entity groups.
- **client-callable hub methods** (`JoinQueue`/`LeaveQueue`) and **connection lifecycle** (`OnConnected`, `Groups.Add`) — the model has no client→server or connection concept.
- The AsyncApi pub/sub graph models **backend context-to-context** integration — a *different* fan-out from pushing a snapshot to connected browsers. So the realtime layer reuses AsyncApi's *payload/channel atoms* but derives its own browser-facing grouping rather than mirroring the context-to-context topology.

**Sequencing (recommended, not required).** The broadcaster rides W1's `PostCommitDispatch` seam, so W1 makes the dispatch wiring cleaner — but the AsyncApi payload/channel atoms the layer reuses exist today. Sequence W3 after W1 by preference, not necessity.

**v1 convention → v2 annotation.** v1 ships a convention: broadcast each event grouped by aggregate identity, with standard join/leave methods per aggregate. v2 adds an optional `@broadcast(groupKey)` annotation for app-specific grouping — and, because integration events already carry an `annotation*` prefix (`KoineParser.g4:94`), this needs **no grammar change** (see *Grammar note*). This is the normal convention→annotation maturation the whole plan follows — the group-key question is answered by a v1 default and refined by a v2 override, not a blocker to resolve first.

**Packages:** SignalR ships in `Microsoft.AspNetCore.App` (same `FrameworkReference`).

**Acceptance.** Regenerates the uniform push skeleton in Linelo's `QueueHub.cs` + `QueueBroadcaster` (34 LOC): 4 group join/leave methods + a broadcaster pushing `QueueSnapshotDto`. App-specific group keys stay hand-annotated until `@broadcast` lands.

---

## W4 — Land Mapperly mapping  *(effort M · independent)*

**Problem.** `ApplicationMapping=mapperly` is a no-op — a reserved forward value (`CSharpEmitterOptions.cs:23-30`) consumed only in the cache fingerprint (`CSharpEmitter.cs:80`); the audit confirmed it changes no output.

**Design.** Implement `CSharpMappingMode.Mapperly` → emit `[Mapper]` partial classes at the existing mapping sites (`CSharpEmitter.Cqrs.cs:133-160`) for domain↔DTO/read-model. Consumer adds `Riok.Mapperly`.

**Acceptance.** Replaces the hand-rolled `To<RM>()` projections; on the Linelo side, subsumes the dispersed inline mapping once Linelo declares read models.

---

## W5 — `Layout` support: single-project layer folders (default) + opt-in assembly split  *(effort M–L · independent · lowest priority)*

**Problem.** `Layout` is an inert forward key. It is plumbed config→options→provider but read by no emitter — `CSharpEmitterProvider.cs:21` documents it as *"accepted and currently a no-op (file-per-type is the only layout)"*, and `ToCSharpOptions` (`:27-51`) doesn't even forward it into the `CSharpEmitterOptions` ctor (`:47-50`). The **current** layout is context-first, file-per-type: `PathFor` (`CSharpEmitter.cs:2250`) → `FolderFor(ns)` = `ns.Replace('.','/')` (~`:2240`) → `<Context>/<KindFolder>/File.cs`. Domain aggregate roots land at the context root (`KindFolder.Root=""`, `:2261`); `Application/` (`:2276`) and `Infrastructure/` (`:2279`) are already **distinct per-context subfolders**. Two properties matter downstream: (1) opt-in layers always imply `domain` (`BuildCommand.cs:207-208`; `ParseLayers` seeds `CSharpLayer.Domain`, `CSharpEmitterProvider.cs:66`), so you can't emit application/infra standalone; (2) all three layers **share the same context namespace** (`CSharpEmitter.Application.cs:323` — "the application layer emits into the base context namespace"; snapshots emit `Billing.Invoicing` / `Sales` with no `.Application`/`.Infrastructure` suffix).

**The less-opinionated default: one project, layer-named folders.** The headline deliverable is `Layout=layerFirst` in a **single generated project** — group by layer then context (`Domain/<Context>/…`, `Application/<Context>/…`, `Infrastructure/<Context>/…`), one csproj, one assembly, zero project-wiring ceremony. This imposes strictly less than forcing a multi-assembly split: a team gets a legible layered tree without having to stand up and reference three projects. Keep `filePerType` (today's context-first tree) as the **back-compat default** so the "off is byte-identical" tests hold and existing snapshots don't churn for consumers who don't opt in.

Implementation is **contained**, not broad: layout is a single chokepoint — rework `PathFor` (`CSharpEmitter.cs:2250`) to map `(ns, kindFolder) → path` per the `Layout` value, and stop dropping the `layout` key at `ToCSharpOptions` (`CSharpEmitterProvider.cs:47-50`). Within the `csharp` target there is no per-emitter path sprawl to chase — every emit site already routes through `PathFor`.

**The honest caveat: folders organize, they do not enforce.** In a single assembly, a layer folder is documentation, not a boundary. C# accessibility is namespace/assembly-scoped, never folder-scoped — and today all three layers even share the one context namespace — so a `Domain/` file can freely `using` and reference an `Infrastructure/` type with nothing to stop it. `layerFirst` makes a leak *visible in review*; it cannot make it *fail the build*.

**Closing the gap: optionally emit an enforcement test.** To turn the folder convention into a checkable boundary, add `--emit-arch-test` (opt-in). Because layers currently share a namespace, this rides on one prerequisite: the layer-split layouts must give each layer a **distinct namespace segment** (`<Context>.Application`, `<Context>.Infrastructure`; Domain stays at `<Context>`) so the boundary is expressible at all — verified as *not* the case today. Koine then emits a **self-contained, package-light reflection-based xUnit test** (BCL `System.Reflection` + xUnit only — no NetArchTest, no Roslyn analyzer) that loads the emitted assembly, enumerates every type in the Domain namespace, and asserts that none of its **referenced** types — base types, implemented interfaces, field/property types, method parameter and return types, attribute types, and generic arguments — live in a `*.Application` or `*.Infrastructure` namespace.

*Honest limitation:* reflection sees a type's **API surface**, not its method bodies, so a Domain method that news-up an Infrastructure class internally slips through. That is the accepted v1 tradeoff (see the arch-test rationale below); a Roslyn analyzer is the heavier full-fidelity upgrade path if enforcement demand grows.

**Assembly split stays opt-in.** For teams that do want real assembly boundaries, gate it behind the `Layout` value plus a **"don't-imply-domain" flag** (relax `BuildCommand.cs:207` / `ParseLayers` `CSharpEmitterProvider.cs:66`) so a layer can emit standalone into its own `--out` tree. Per the doc-wide package policy, Koine still emits **no csproj** — the consumer owns the three project files; the distinct per-layer namespaces make those assemblies clean (no cross-assembly namespace collisions), and the emitted reflection arch-test gives them compile-time-adjacent enforcement.

> **~80% already ships today.** Because `Application/` and `Infrastructure/` are already distinct per-context subfolders, a consumer can point three csproj globs (`**/Application/**`, `**/Infrastructure/**`, and Domain = the remainder) at the current `filePerType` output *right now* and get a working split. W5's marginal value is therefore **not** the folder separation (which exists) but the three things it can't get today: clean per-layer namespaces, the "don't-imply-domain" flag, and the emitted arch-test that makes the boundary real instead of aspirational.

**Arch-test rationale (reflection over NetArchTest/Roslyn).** A **reflection-based** xUnit test is chosen deliberately: (1) *Package policy* — the doc-wide contract is that Koine emits no `PackageReference`, so a `NetArchTest.Rules`-based test wouldn't even **compile** until the consumer added the package (and Koine can't emit the csproj to declare it), whereas a reflection test needs only the BCL + the xUnit the test project already has, so it compiles and runs the moment it's emitted. (2) *Weight* — a Roslyn analyzer is a separate `Microsoft.CodeAnalysis` project packaged and wired as an analyzer, a build-tooling artifact far larger than a single emitted `[Fact]`; rejected for v1. (3) *Prerequisite is shared* — any namespace-keyed check (reflection or analyzer) is inert until the layer-split layouts give each layer a distinct namespace segment, so that requirement doesn't tip the choice; it just ships alongside. (4) *Honest limitation, stated not hidden* — reflection sees a type's API surface (base/interfaces, field/property types, method param/return types, attribute and generic-arg types), not method bodies; NetArchTest (IL via Mono.Cecil) and a Roslyn analyzer (full symbol graph) are strictly more thorough. The reflection test catches the common, most-visible structural leak at zero dependency cost; name the Roslyn analyzer as the heavier full-fidelity upgrade path if body-level enforcement is later demanded. The emitted test ships with its own Verify snapshot plus a Roslyn compile/execute meta-test asserting it passes on a clean model and fails on a seeded cross-layer reference.

**Acceptance.** Default vertical-stack story: a single-project `layerFirst` tree plus an emitted reflection arch-test that fails if Domain's surface references Application/Infrastructure. Opt-in: a clean `Linelo.Domain` / `Linelo.Application` / `Linelo.Infrastructure` assembly split via the `Layout` value + the don't-imply-domain flag.

**Effort: M–L.** The path rework is a single `PathFor` chokepoint (low risk), but the surrounding work adds up: every file path changes under `layerFirst` (large but mechanical snapshot churn), the per-layer namespace option, wiring the currently-dropped `layout` key through the option chain, the emitted arch-test (+ its own snapshot and a Roslyn compile/execute meta-test proving it passes on a clean model and fails on a seeded leak), and the don't-imply-domain flag.

---

## Grammar note (shared by W2/W3, deferred)

Annotations today take a **single int/string arg** (`KoineParser.g4:99`) and only `@since`/`@deprecated` are consumed (`Nodes.cs:399-403`). They attach to type-level decls **and to fields/members** (`member : annotation* …`, `KoineParser.g4:226`). Crucially, `integrationEventDecl` (`:94`) and `eventDecl` (`:222`) **already carry an `annotation*` prefix** — only `command` (`:160`), `query` (`:125`), and `usecase` (`:114`) do not. So the override surface splits cleanly:

- **`@broadcast("groupKey")` on an integration event (W3) needs no grammar change** — integration events already accept annotations; it is a builder-visitor + validator + emitter addition only.
- **`@route("…")`/`@get`/`@post`/`@auth("role")` on commands/queries (W2)** need **one** grammar change — add `annotation*` to the `command`/`query`/`usecase` decl rules (plus a widening of the annotation arg rule at `:99` only if a non-int/string arg is ever wanted).

**Not needed for v1** — both emitters ship on convention first. A first-class `endpoint`/`hub` block is the richer alternative but a large grammar+AST+validator+all-emitter surface; not recommended for v1.

**Prior-art check:** repo-wide grep found no existing intent toward a web/http/endpoint/controller/SignalR/realtime C# emitter — both are genuinely new surface, no collision risk.

---

## Appendix — seam index (quick reference)

- **Option plumbing:** `BuildCommand.cs` → `KoineConfig.cs` → `EmitterOptions.cs` → `EmitterRegistry.cs:107-133` → `CSharpEmitterProvider.cs:27-51` → `CSharpEmitterOptions.cs:108-117` → emitter → fingerprint `CSharpEmitter.cs:69-82`.
- **Handler emission:** `CSharpEmitter.Application.cs` — not-found `:153-154`/`:476-477`; void branch `:157-161`; `WriteCommit :271-278`; `HandlerSignature :261-269`; `WriteHandlerHeader :244-258`; factory-returns-aggregate `:212`.
- **Layer gates:** `CSharpEmitter.cs:349` (`EmitApplication`), `:361` (`EmitsInfrastructure`); enum `CSharpEmitterOptions.cs:41-51`.
- **Provider/registry:** `IEmitterProvider.cs`, `IEmitter.cs`; `BuiltInEmitterProviders.cs:16-27`; `EmitterRegistry.cs:34-100`.
- **Reusable spec logic:** OpenApi routes `OpenApiEmitter.Paths.cs:16-92`; AsyncApi channels `AsyncApiEmitter.Channels.cs:18-58` / operations `Operations.cs:21-94`.
- **Event material:** aggregate `DomainEvents`/`ClearDomainEvents` `CSharpEmitter.Entities.cs:152-169`; `IDomainEvent` runtime `CSharpEmitter.Runtime.cs:47-55`; integration outbox `CSharpEmitter.Infrastructure.Outbox.cs`.
- **Tests:** `tests/Koine.Compiler.Tests/Emit/CSharp/` — `R18CSharpApplicationTests.cs` (assertion), `EmitterSnapshotTests.cs` + `Snapshots/*.verified.txt` (golden).
