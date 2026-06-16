# C# Emitter Kind-Based Output Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group each bounded context's generated C# files into DDD building-block subfolders (`Entities/`, `ValueObjects/`, `Enums/`, …) while keeping namespaces unchanged and placing aggregate roots at the context root.

**Architecture:** The C# emitter builds every output path as `$"{FolderFor(ns)}/{name}.cs"` at ~14 call sites, each of which statically knows the kind of file it emits. We introduce a `PathFor(ns, kindFolder, fileName)` helper plus a `KindFolder` constant set, then route each call site through it with the right kind. Namespaces are untouched; only on-disk paths change. The change is reviewed through the existing Verify snapshot suite and a new focused layout test.

**Tech Stack:** C# / .NET 10, xUnit, Verify.Xunit (snapshot tests), Roslyn (in-memory compile checks in `TestSupport`).

---

## Canonical kind → folder mapping (authoritative)

This table is the single source of truth for both the emitter call sites and the
test-literal updates. The kind of a type is its AST declaration kind.

| Emitted thing | Subfolder | Example new path |
| --- | --- | --- |
| Aggregate root entity | *(root — no subfolder)* | `Sales/Order.cs` |
| Standalone entity / aggregate-nested entity (non-root) | `Entities` | `Sales/Entities/OrderLine.cs` |
| Value object | `ValueObjects` | `Sales/ValueObjects/Money.cs` |
| Generated `*Id` value object | `ValueObjects` | `Sales/ValueObjects/OrderId.cs` |
| Enum (smart enum) | `Enums` | `Billing/Enums/Currency.cs` |
| Domain event | `Events` | `Sales/Events/OrderPlaced.cs` |
| Integration event | `IntegrationEvents` | `Sales/IntegrationEvents/OrderPlaced.cs` |
| Read model | `ReadModels` | `Sales/ReadModels/OrderSummary.cs` |
| Query object | `Queries` | `Sales/Queries/OrdersByStatus.cs` |
| Domain service (`<Name>.cs`) + application-service interface (`I<Name>.cs`) | `Services` | `Sales/Services/IPricing.cs` |
| Specifications file (`<Ctx>Specifications.cs`) | `Specifications` | `Shop/Specifications/ShopSpecifications.cs` |
| Policy (`<Name>Policy.cs`) | `Policies` | `Sales/Policies/ReserveStockPolicy.cs` |
| Repository interface (`I<Root>Repository.cs`) | `Repositories` | `Sales/Repositories/IOrderRepository.cs` |
| Unit of work (`IUnitOfWork.cs`) | `Abstractions` | `Sales/Abstractions/IUnitOfWork.cs` |
| Integration-event handler (`IHandle<Event>.cs`) | `Abstractions` | `Shipping/Abstractions/IHandleOrderPlaced.cs` |
| ACL translator (`I<Up>To<Down>Translator.cs`) | `Abstractions` | `Billing/Abstractions/ILegacyToBillingTranslator.cs` |
| Runtime support (`Koine/Runtime/*`) | *(root — UNCHANGED)* | `Koine/Runtime/ValueObject.cs` |

**Module paths (R13.3):** the kind subfolder is appended after the module path,
since the namespace folder already includes it. E.g. a value object in module
`Invoicing` → `Billing/Invoicing/ValueObjects/Money.cs`; an aggregate root in a
module stays at the module root → `Billing/Invoicing/Invoice.cs`.

**Shared kernel (R14.2):** kind rules apply under the existing kernel folder.
A kernel value object → `Sales__Shipping/Kernel/ValueObjects/Money.cs`; a kernel
enum → `Sales__Shipping/Kernel/Enums/Currency.cs`. The `__` name is unchanged.

---

## File structure

**Modified (emitter):**
- `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.cs` — add `PathFor` + `KindFolder`; route `EmitEnum`, `EmitEvent`, `EmitIntegrationEvent`, `EmitIntegrationEventHandler`, `EmitAclTranslator`.
- `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.Entities.cs` — route `EmitEntity` (root vs `Entities`) and `EmitIdValueObject` (`ValueObjects`).
- `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.ValueObjects.cs` — route `EmitValueObject` (`ValueObjects`).
- `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.Aggregates.cs` — route `EmitRepository` (`Repositories`).
- `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.Cqrs.cs` — route `EmitUnitOfWork` (`Abstractions`), `EmitApplicationService` (`Services`), `EmitReadModel` (`ReadModels`), `EmitQuery` (`Queries`). Leave `EmitQueryHandlerInterface` (runtime) unchanged.
- `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.Behaviors.cs` — route `EmitSpecifications` (`Specifications`), `EmitService` (`Services`), `EmitPolicy` (`Policies`).
- `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.Runtime.cs` — **unchanged** (all runtime types stay at `Koine/Runtime/` root).

**Modified (tests):** the 9 Verify snapshots under `tests/Koine.Compiler.Tests/Snapshots/` (re-accepted) and path literals in: `R4DocsTests.cs`, `R5CommandTests.cs`, `R6EventTests.cs`, `R8FactoryTests.cs`, `R9ValueObjectTests.cs`, `R10ServicesTests.cs`, `R11IdentityRepositoryTests.cs`, `R12ApplicationTests.cs`, `R13ModulesImportsTests.cs`, `R14IntegrationEventsTests.cs`, `R14ContextMapsTests.cs`, `R14SharedKernelAclTests.cs`, `R15VersioningTests.cs`, `CommandReturnTests.cs`, `GeneratedCodeTests.cs`.

**Created (tests):**
- `tests/Koine.Compiler.Tests/KindFolderLayoutTests.cs` — focused assertions locking the new layout (root-at-root, each subfolder).

---

## Task 1: Add the `PathFor` helper and `KindFolder` constants

**Files:**
- Modify: `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.cs:1475-1476` (next to `FolderFor`)

- [ ] **Step 1: Add the helper and constants**

In `CSharpEmitter.cs`, immediately after the existing `FolderFor` method (line 1476), add:

```csharp
    /// <summary>
    /// Builds the output path for a generated file: the namespace folder, an
    /// optional DDD building-block subfolder (e.g. "Entities", "ValueObjects"),
    /// and the file name. An empty <paramref name="kindFolder"/> places the file
    /// at the namespace root — used for aggregate roots (the aggregate is the
    /// context's entry point) and for runtime support types.
    /// </summary>
    private static string PathFor(string ns, string kindFolder, string fileName)
        => kindFolder.Length == 0
            ? $"{FolderFor(ns)}/{fileName}"
            : $"{FolderFor(ns)}/{kindFolder}/{fileName}";

    /// <summary>The DDD building-block subfolders generated files are grouped into.</summary>
    private static class KindFolder
    {
        public const string Root = "";
        public const string Entities = "Entities";
        public const string ValueObjects = "ValueObjects";
        public const string Enums = "Enums";
        public const string Events = "Events";
        public const string IntegrationEvents = "IntegrationEvents";
        public const string ReadModels = "ReadModels";
        public const string Queries = "Queries";
        public const string Services = "Services";
        public const string Specifications = "Specifications";
        public const string Policies = "Policies";
        public const string Repositories = "Repositories";
        public const string Abstractions = "Abstractions";
    }
```

- [ ] **Step 2: Build to verify it compiles (no behavior change yet)**

Run: `dotnet build src/Koine.Compiler/Koine.Compiler.csproj`
Expected: Build succeeded. (The helper is unused so far — a CS warning about an unused private member is acceptable; it disappears in Task 2. If warnings are errors, proceed straight to Task 2 before building.)

- [ ] **Step 3: Commit**

```bash
git add src/Koine.Compiler/Emit/CSharp/CSharpEmitter.cs
git commit -m "refactor(emit): add PathFor helper and KindFolder constants"
```

---

## Task 2: Route every emitter call site through `PathFor`

**Files:**
- Modify: `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.cs` (lines 372, 487, 546, 568, 600)
- Modify: `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.Entities.cs` (lines 165, 234)
- Modify: `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.ValueObjects.cs` (line 121)
- Modify: `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.Aggregates.cs` (line 148)
- Modify: `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.Cqrs.cs` (lines 39, 75, 131, 171)
- Modify: `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.Behaviors.cs` (lines 96, 162, 207)

- [ ] **Step 1: Edit `CSharpEmitter.cs` call sites**

`EmitEnum` (line 372):
```csharp
        return new EmittedFile(PathFor(ns, KindFolder.Enums, $"{name}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: true));
```

`EmitEvent` (line 487):
```csharp
        return new EmittedFile(PathFor(ns, KindFolder.Events, $"{ev.Name}.cs"),
            Assemble(emit, ns, sb.ToString(), UsesLinq(ev.Members, Array.Empty<Invariant>())));
```

`EmitIntegrationEvent` (line 546):
```csharp
        return new EmittedFile(PathFor(ns, KindFolder.IntegrationEvents, $"{ev.Name}.cs"),
            Assemble(emit, ns, sb.ToString(), UsesLinq(ev.Members, Array.Empty<Invariant>())));
```

`EmitIntegrationEventHandler` (line 568):
```csharp
        return new EmittedFile(PathFor(subscriberContext, KindFolder.Abstractions, $"IHandle{sub.EventName}.cs"),
            Assemble(emit, subscriberContext, sb.ToString(), usesLinq: false));
```

`EmitAclTranslator` (line 600):
```csharp
        return new EmittedFile(PathFor(r.Downstream, KindFolder.Abstractions, $"{iface}.cs"),
            Assemble(emit, r.Downstream, sb.ToString(), usesLinq: false));
```

- [ ] **Step 2: Edit `CSharpEmitter.Entities.cs` call sites**

`EmitEntity` (line 165) — root goes to the context root, everything else to `Entities`:
```csharp
        return new EmittedFile(PathFor(ns, isRoot ? KindFolder.Root : KindFolder.Entities, $"{entity.Name}.cs"),
            Assemble(emit, ns, sb.ToString(), EntityUsesLinq(entity) || SpecBodiesUseLinq(entity.Name, index)));
```

`EmitIdValueObject` (line 234):
```csharp
        return new EmittedFile(PathFor(ns, KindFolder.ValueObjects, $"{idName}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
```

- [ ] **Step 3: Edit `CSharpEmitter.ValueObjects.cs` (line 121)**

```csharp
        return new EmittedFile(PathFor(ns, KindFolder.ValueObjects, $"{vo.Name}.cs"),
            Assemble(emit, ns, sb.ToString(), UsesLinq(vo.Members, vo.Invariants) || SpecBodiesUseLinq(vo.Name, index)));
```

- [ ] **Step 4: Edit `CSharpEmitter.Aggregates.cs` (line 148)**

```csharp
        return new EmittedFile(PathFor(ns, KindFolder.Repositories, $"{iface}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
```

- [ ] **Step 5: Edit `CSharpEmitter.Cqrs.cs` call sites**

`EmitUnitOfWork` (line 39):
```csharp
        return new EmittedFile(PathFor(ns, KindFolder.Abstractions, "IUnitOfWork.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
```

`EmitApplicationService` (line 75):
```csharp
        return new EmittedFile(PathFor(ns, KindFolder.Services, $"{iface}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
```

`EmitReadModel` (line 131):
```csharp
        return new EmittedFile(PathFor(ns, KindFolder.ReadModels, $"{rm.Name}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq));
```

`EmitQuery` (line 171):
```csharp
        return new EmittedFile(PathFor(ns, KindFolder.Queries, $"{q.Name}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
```

Leave `EmitQueryHandlerInterface` (line 186, `Koine/Runtime/IQueryHandler.cs`) **unchanged**.

- [ ] **Step 6: Edit `CSharpEmitter.Behaviors.cs` call sites**

`EmitSpecifications` (line 96):
```csharp
        return new EmittedFile(PathFor(ns, KindFolder.Specifications, $"{ns}Specifications.cs"), Assemble(emit, ns, sb.ToString(), usesLinq));
```

`EmitService` (line 162):
```csharp
        return new EmittedFile(PathFor(ns, KindFolder.Services, $"{svc.Name}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq));
```

`EmitPolicy` (line 207):
```csharp
        return new EmittedFile(PathFor(ns, KindFolder.Policies, $"{policyType}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
```

- [ ] **Step 7: Build the compiler**

Run: `dotnet build src/Koine.Compiler/Koine.Compiler.csproj`
Expected: Build succeeded, 0 warnings (the helper is now used).

- [ ] **Step 8: Regenerate and review the Verify snapshots**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~EmitterSnapshotTests"`
Expected: FAIL — Verify writes `*.received.txt` next to each `*.verified.txt` under `tests/Koine.Compiler.Tests/Snapshots/`.

Review each received-vs-verified diff and confirm the ONLY changes are path headers (`// ==== … ====`) moving into the correct subfolder per the mapping table, e.g. `// ==== Sales/Money.cs ====` → `// ==== Sales/ValueObjects/Money.cs ====`, aggregate roots staying at the context root, runtime types unchanged. File *contents* (namespaces, code) must be identical.

Run: `git diff --no-index tests/Koine.Compiler.Tests/Snapshots/EmitterSnapshotTests.Billing_fixture_emits_expected_csharp.verified.txt tests/Koine.Compiler.Tests/Snapshots/EmitterSnapshotTests.Billing_fixture_emits_expected_csharp.received.txt`
Expected: only `====` header lines differ.

- [ ] **Step 9: Accept the snapshots**

After confirming every diff is path-only, accept by overwriting verified with received:

```bash
cd tests/Koine.Compiler.Tests/Snapshots
for f in *.received.txt; do mv "$f" "${f%.received.txt}.verified.txt"; done
cd -
```

Re-run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~EmitterSnapshotTests"`
Expected: PASS.

- [ ] **Step 10: Commit the emitter change + accepted snapshots**

```bash
git add src/Koine.Compiler/Emit/CSharp/*.cs tests/Koine.Compiler.Tests/Snapshots/*.verified.txt
git commit -m "feat(emit): group generated C# into DDD kind subfolders (roots at context root)"
```

---

## Task 3: Update path literals in the non-snapshot tests

The remaining tests match files by exact path via `f.RelativePath == "…"`,
`FileContents(files, "…")`, and the `Emit(src, emitter, "…")` helper. Apply the
mapping table. The failing assertion's message reveals the actual emitted path —
use it together with the mapping to update each literal. Do NOT change string
literals that are substring assertions over file *contents* (e.g.
`Assert.Contains("public sealed class Money", …)`) — only path arguments change.

`Koine/Runtime/*` literals never change.

- [ ] **Step 1: Run the full test project to surface every failing path assertion**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj`
Expected: FAIL — a batch of assertions in the files listed below, each pointing at an old flat path.

- [ ] **Step 2: Update each test file per the mapping**

Apply these replacements (verify each against the failing assertion before saving). Aggregate roots and `Koine/Runtime/*` are intentionally absent because they do not move.

`R12ApplicationTests.cs`:
- `Sales/IUnitOfWork.cs` → `Sales/Abstractions/IUnitOfWork.cs`
- `C/IUnitOfWork.cs` → `C/Abstractions/IUnitOfWork.cs`
- `Library/IUnitOfWork.cs` → `Library/Abstractions/IUnitOfWork.cs`
- `Sales/IOrderService.cs` → `Sales/Services/IOrderService.cs`
- `Sales/OrderService.cs` → `Sales/Services/OrderService.cs`
- `Sales/Pricing.cs` → `Sales/Services/Pricing.cs`
- `Sales/IPricing.cs` → `Sales/Services/IPricing.cs`
- `Sales/IQueries.cs` → `Sales/Services/IQueries.cs`
- `Sales/OrderSummary.cs` → `Sales/ReadModels/OrderSummary.cs`
- `C/CartTotal.cs` → `C/ReadModels/CartTotal.cs`
- `Sales/OrdersByStatus.cs` → `Sales/Queries/OrdersByStatus.cs`
- `Sales/OrderById.cs` → `Sales/Queries/OrderById.cs`
- `A/MoneyView.cs` → `A/ReadModels/MoneyView.cs`

`R11IdentityRepositoryTests.cs`:
- `Sales/IOrderRepository.cs` → `Sales/Repositories/IOrderRepository.cs`
- `Sales/IOrderLineRepository.cs` → `Sales/Repositories/IOrderLineRepository.cs`
- `Sales/ICustomerRepository.cs` → `Sales/Repositories/ICustomerRepository.cs`
- `Audit/IAuditEntryRepository.cs` → `Audit/Repositories/IAuditEntryRepository.cs`
- any `*Id.cs` literal → `…/ValueObjects/*Id.cs`

`R10ServicesTests.cs`:
- `Shop/ShopSpecifications.cs` → `Shop/Specifications/ShopSpecifications.cs`
- `Sales/ReserveStockPolicy.cs` → `Sales/Policies/ReserveStockPolicy.cs`

`R14IntegrationEventsTests.cs`:
- `Shipping/IHandleOrderPlaced.cs` → `Shipping/Abstractions/IHandleOrderPlaced.cs`
- `Sales/IHandleOrderPlaced.cs` → `Sales/Abstractions/IHandleOrderPlaced.cs`
- `Sales/OrderPlaced.cs` (integration event here) → `Sales/IntegrationEvents/OrderPlaced.cs`
- `Sales/Contracts/OrderPlaced.cs` → `Sales/Contracts/IntegrationEvents/OrderPlaced.cs`
- `Shipping/OrderPlaced.cs` (DoesNotContain) → `Shipping/IntegrationEvents/OrderPlaced.cs`

`R14SharedKernelAclTests.cs`:
- `Sales__Shipping/Kernel/Money.cs` → `Sales__Shipping/Kernel/ValueObjects/Money.cs`
- `Sales__Shipping/Kernel/Currency.cs` → `Sales__Shipping/Kernel/Enums/Currency.cs`
- `Sales/Money.cs` (DoesNotContain) → `Sales/ValueObjects/Money.cs`
- `Shipping/Money.cs` (DoesNotContain) → `Shipping/ValueObjects/Money.cs`
- `Billing/ILegacyToBillingTranslator.cs` → `Billing/Abstractions/ILegacyToBillingTranslator.cs`
- `Sales/Quote.cs`, `Shipping/Label.cs` — confirm each type's kind from the fixture (value/entity/aggregate root) and apply: a root stays put; a value object → `…/ValueObjects/…`; a non-root entity → `…/Entities/…`. The failing assertion shows the actual path.

`R15VersioningTests.cs`:
- `Sales/Money.cs` → `Sales/ValueObjects/Money.cs`
- `Sales/OldMoney.cs` → `Sales/ValueObjects/OldMoney.cs`
- `Sales/OrderPlaced.cs` (domain event here) → `Sales/Events/OrderPlaced.cs`

`R13ModulesImportsTests.cs`:
- `Billing/Pricing/Money.cs` → `Billing/Pricing/ValueObjects/Money.cs`
- `Billing/Invoicing/IOrderRepository.cs` → `Billing/Invoicing/Repositories/IOrderRepository.cs`
- `Billing/IUnitOfWork.cs` → `Billing/Abstractions/IUnitOfWork.cs`
- `Billing/Currency.cs` → `Billing/Enums/Currency.cs`
- `Billing/OrderId.cs` → `Billing/ValueObjects/OrderId.cs`
- `C/Outer/Inner/V.cs` → `C/Outer/Inner/ValueObjects/V.cs`
- `Billing/Invoicing/Invoice.cs` — aggregate root, UNCHANGED.

`R4DocsTests.cs`:
- `Billing/Money.cs` → `Billing/ValueObjects/Money.cs`
- `Billing/Currency.cs` → `Billing/Enums/Currency.cs`

`R9ValueObjectTests.cs`:
- `C/V.cs` → `C/ValueObjects/V.cs` (any value-object literal); `Koine/Runtime/Range.cs` UNCHANGED.

`R8FactoryTests.cs`, `R5CommandTests.cs`, `CommandReturnTests.cs`:
- `Sales/Order.cs`, `Sales/Cart.cs`, `C/Cart.cs` — aggregate roots, UNCHANGED.
- `C/E.cs` (non-root entity) → `C/Entities/E.cs`; `C/EKey.cs` (id VO) → `C/ValueObjects/EKey.cs`.

`R14ContextMapsTests.cs`, `GeneratedCodeTests.cs`:
- `Catalog/Sku.cs` → `Catalog/ValueObjects/Sku.cs`
- `Catalog/OrderId.cs` → `Catalog/ValueObjects/OrderId.cs`
- `Catalog/InvoiceNo.cs` → `Catalog/ValueObjects/InvoiceNo.cs`
- `Sales/Quote.cs`, `A/Wallet.cs` — confirm kind from fixture (root stays; entity → `Entities/`; value → `ValueObjects/`).

- [ ] **Step 3: Re-run the full test project until green**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj`
Expected: PASS. If any assertion still fails, its message names the actual emitted path — reconcile it against the mapping table (a mismatch means either a literal was missed or a type's kind was misjudged; the emitted path is correct by construction).

- [ ] **Step 4: Commit**

```bash
git add tests/Koine.Compiler.Tests/*.cs
git commit -m "test(emit): update path assertions for kind-based output folders"
```

---

## Task 4: Add a focused layout test

**Files:**
- Create: `tests/Koine.Compiler.Tests/KindFolderLayoutTests.cs`

- [ ] **Step 1: Write the test**

```csharp
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Locks the kind-based output layout: each DDD building block lands in its
/// subfolder, aggregate roots sit at the context root, and namespaces are
/// unchanged. Guards against accidental regression to a flat layout.
/// </summary>
public class KindFolderLayoutTests
{
    private const string Fixture = """
        context Catalog {
          enum Availability { InStock, OutOfStock }
          value Sku { code: String }
          aggregate Product root Product {
            entity Product identified by ProductId {
              sku:          Sku
              availability: Availability
            }
            entity ProductReview identified by ReviewId {
              rating: Int
            }
            event ProductListed { product: ProductId }
          }
        }
        """;

    private static IReadOnlyList<string> Paths()
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Select(f => f.RelativePath).ToList();
    }

    [Fact]
    public void Aggregate_root_sits_at_the_context_root()
    {
        Assert.Contains("Catalog/Product.cs", Paths());
    }

    [Fact]
    public void Non_root_entity_goes_under_Entities()
    {
        Assert.Contains("Catalog/Entities/ProductReview.cs", Paths());
    }

    [Fact]
    public void Value_objects_and_generated_ids_go_under_ValueObjects()
    {
        var paths = Paths();
        Assert.Contains("Catalog/ValueObjects/Sku.cs", paths);
        Assert.Contains("Catalog/ValueObjects/ProductId.cs", paths);
        Assert.Contains("Catalog/ValueObjects/ReviewId.cs", paths);
    }

    [Fact]
    public void Enums_go_under_Enums()
    {
        Assert.Contains("Catalog/Enums/Availability.cs", Paths());
    }

    [Fact]
    public void Domain_events_go_under_Events()
    {
        Assert.Contains("Catalog/Events/ProductListed.cs", Paths());
    }

    [Fact]
    public void Repository_interfaces_go_under_Repositories()
    {
        Assert.Contains("Catalog/Repositories/IProductRepository.cs", Paths());
    }

    [Fact]
    public void Unit_of_work_goes_under_Abstractions()
    {
        Assert.Contains("Catalog/Abstractions/IUnitOfWork.cs", Paths());
    }

    [Fact]
    public void Namespace_is_still_the_bare_context()
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter());
        var sku = result.Files.Single(f => f.RelativePath == "Catalog/ValueObjects/Sku.cs").Contents;
        Assert.Contains("namespace Catalog;", sku);
    }
}
```

- [ ] **Step 2: Run the new test**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~KindFolderLayoutTests"`
Expected: PASS (8 tests). If `Aggregate_root_sits_at_the_context_root` fails with the path showing `Catalog/Entities/Product.cs` or `Catalog/Aggregates/Product.cs`, the `isRoot` branch in Task 2 Step 2 is wrong — fix it.

- [ ] **Step 3: Commit**

```bash
git add tests/Koine.Compiler.Tests/KindFolderLayoutTests.cs
git commit -m "test(emit): lock kind-based output folder layout"
```

---

## Task 5: Verify the end-to-end demo build and full suite

**Files:**
- No source changes expected. `demo/Shop.Domain` regenerates into `Generated/` on build (the tree is wiped each build), so the new layout flows through automatically.

- [ ] **Step 1: Run the entire solution test suite**

Run: `dotnet test`
Expected: PASS. (Catches any path assertion outside `Koine.Compiler.Tests` — e.g. CLI or tooling tests — that the earlier grep did not surface.)

- [ ] **Step 2: Rebuild the demo to confirm generated code still compiles in the new layout**

Run: `dotnet build demo/Shop.Domain/Shop.Domain.csproj`
Expected: Build succeeded. Then confirm the new tree:

Run: `find demo/Shop.Domain/Generated -type d | sort`
Expected: per-context kind subfolders (e.g. `Catalog/Entities`, `Catalog/ValueObjects`, `Catalog/Enums`, `Ordering/Repositories`, `Ordering/Abstractions`), aggregate roots at context roots, and `Koine/Runtime` unchanged.

- [ ] **Step 3: Final commit (only if anything changed in Steps 1–2)**

```bash
git add -A
git commit -m "chore(emit): confirm kind-folder layout across suite and demo"
```

---

## Self-Review

**Spec coverage:** Every mapping-table row maps to a Task 2 call-site edit; aggregate-root-at-root → `EmitEntity` `isRoot` branch (Task 2 Step 2, locked by Task 4); module-path handling → inherited from `FolderFor` (no extra code, covered by R13 snapshot + literals); shared-kernel-with-kind → flows through the normal switch with the kernel `ns` (Task 2), asserted in Task 3 (`R14SharedKernelAclTests`); runtime-unchanged → explicitly left alone (Task 2 Steps 1/5). Snapshot regeneration (the 9 Verify files) → Task 2 Steps 8–9.

**Placeholder scan:** No TBD/TODO. The two "confirm each type's kind from the fixture" notes (Quote/Label/Wallet/Cart) are not placeholders — the mapping rule is fixed and the failing assertion deterministically reveals the emitted path; the note tells the engineer how to classify, with the test as the check.

**Type consistency:** `PathFor(string ns, string kindFolder, string fileName)` and `KindFolder.*` constants are used identically at every call site. `KindFolder.Root` (empty string) is the single mechanism for "no subfolder" and is used only by the `EmitEntity` root branch (runtime emitters keep their existing `FolderFor`-based paths untouched).
```
