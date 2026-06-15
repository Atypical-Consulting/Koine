# Koine Cross-File (Workspace) Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.koi` go-to-definition and hover resolve declarations across every file in the workspace (not just the open document), including `*Id` → owning entity.

**Architecture:** A new editor-agnostic `WorkspaceIndex` (built from a `uri → text` map) parses each document and resolves a name to declaration locations across files, local-file-first then unique cross-file. `KoineLanguageService.DefinitionAt`/`HoverAt` become workspace-aware (take the doc map + active URI); `DefinitionResult` gains a target `Uri`. `LspServer` scans the workspace for `*.koi` on `initialize` and overlays open/edited docs. Completion is untouched.

**Tech Stack:** C# / .NET 10, ANTLR4, xUnit. Spec: `docs/superpowers/specs/2026-06-15-koi-workspace-navigation-design.md`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/Koine.Compiler/Services/WorkspaceIndex.cs` | Create | Multi-document index; `ResolveDefinition`/`ResolveHover` with local-first + cross-file-unique + ID→entity |
| `src/Koine.Compiler/Services/KoineLanguageService.cs` | Modify | `DefinitionResult` gains `Uri`; `DefinitionAt`/`HoverAt` take `(documents, activeUri, …)`; hover rendering moves to `WorkspaceIndex` |
| `src/Koine.Cli/LspServer.cs` | Modify | Capture `rootUri`; scan `*.koi`; overlay `_docs`; target URI in definition; URI↔path |
| `tests/Koine.Compiler.Tests/WorkspaceIndexTests.cs` | Create | Cross-file resolution unit tests |
| `tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs` | Modify | Migrate hover/definition tests to the doc-map API; add cross-file case |
| `tests/Koine.Compiler.Tests/LspServerTests.cs` | Modify | Cross-file protocol test (target URI = declaring file) |
| `README.md`, `tooling/README.md` | Modify | Note cross-file navigation |

**Facts confirmed in the current (post-merge) code:**
- `KoineLanguageService` (namespace `Koine.Compiler.Services`) currently has `HoverAt(string source,int line,int character)`, `DefinitionAt(string source,int line,int character)`, records `HoverResult(string Markdown)` and `DefinitionResult(SourceSpan Target)`, and private static `RenderHover(string,ModelIndex)`, `AppendBody`, `KindLabel`, `TypeLabel`. It holds a `KoineCompiler _compiler`.
- `ModelIndex` exposes `TryGetDecl(string,out TypeDecl)`, `Classify(string):TypeKind`, `EnumsDeclaring(string):IReadOnlyList<string>`, `AllSpecs():IEnumerable<SpecDecl>`, `AllTypes():IEnumerable<TypeDecl>`, static `Primitives` (IReadOnlySet<string>), static `IsIdConvention(string)`, static consts `ListTypeName`/`SetTypeName`/`MapTypeName`/`RangeTypeName`.
- AST: `EntityDecl` has `IdentityName`, `Span`; `EnumDecl.Members` (each `EnumMember` has `Name`,`Span`); `SpecDecl` has `Name`,`TargetType`,`Span`; `TypeDecl` base has `Span`,`Doc`. `SourceSpan(int Line,int Column)` with `SourceSpan.None`.
- `KoineCompiler.Parse(source)` → `(KoineModel? Model, IReadOnlyList<Diagnostic>)`; null model on syntax error.
- `LspServer` (`Koine.Cli`, internal): fields `_compiler`, `_ls`, `_docs`; `initialize` case builds capabilities + serverInfo dict; `DefinitionResultJson`/`HoverResultJson`/`CompletionResult` helpers; `TryGetUri`/`TryGetPosition`. `Koine.Cli` has `InternalsVisibleTo Koine.Compiler.Tests`; `Koine.Compiler` has it too (added in the IntelliSense work).
- **Run tests:** `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj` (scope with `--filter "FullyQualifiedName~ClassName"`).

---

## Task 1: `WorkspaceIndex` — cross-file definition resolution

**Files:**
- Create: `src/Koine.Compiler/Services/WorkspaceIndex.cs`
- Test: `tests/Koine.Compiler.Tests/WorkspaceIndexTests.cs`

- [ ] **Step 1: Write the failing test file**

Create `tests/Koine.Compiler.Tests/WorkspaceIndexTests.cs`:

```csharp
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class WorkspaceIndexTests
{
    private const string Catalog =
        "context Catalog {\n" +
        "  enum Currency { EUR, USD }\n" +
        "  entity Product identified by ProductId {\n" +
        "    sku: String\n" +
        "  }\n" +
        "}\n";

    private const string Ordering =
        "context Ordering {\n" +
        "  value Line { product: ProductId }\n" +
        "}\n";

    private static WorkspaceIndex Index(params (string Uri, string Text)[] docs) =>
        new(docs.ToDictionary(d => d.Uri, d => d.Text));

    [Fact]
    public void Cross_file_id_resolves_to_owning_entity()
    {
        var idx = Index(("file:///ordering.koi", Ordering), ("file:///catalog.koi", Catalog));
        var def = idx.ResolveDefinition("file:///ordering.koi", "ProductId");
        Assert.NotNull(def);
        Assert.Equal("file:///catalog.koi", def!.Uri);
        Assert.Equal(3, def.Span.Line); // line of `entity Product` in Catalog
    }

    [Fact]
    public void Cross_file_type_resolves_to_declaring_file()
    {
        var a = "context A { value Wrap { c: Currency } }\n";
        var idx = Index(("file:///a.koi", a), ("file:///catalog.koi", Catalog));
        var def = idx.ResolveDefinition("file:///a.koi", "Currency");
        Assert.NotNull(def);
        Assert.Equal("file:///catalog.koi", def!.Uri);
    }

    [Fact]
    public void Local_declaration_wins_over_other_files()
    {
        var local = "context L {\n  enum Currency { GBP }\n  value V { c: Currency }\n}\n";
        var idx = Index(("file:///local.koi", local), ("file:///catalog.koi", Catalog));
        var def = idx.ResolveDefinition("file:///local.koi", "Currency");
        Assert.NotNull(def);
        Assert.Equal("file:///local.koi", def!.Uri); // local wins
    }

    [Fact]
    public void Ambiguous_cross_file_type_resolves_to_null()
    {
        var b = "context B { value Widget { x: Int } }\n";
        var c = "context C { value Widget { y: Int } }\n";
        var active = "context A { value Uses { w: Widget } }\n";
        var idx = Index(("file:///a.koi", active), ("file:///b.koi", b), ("file:///c.koi", c));
        Assert.Null(idx.ResolveDefinition("file:///a.koi", "Widget")); // declared in 2 other files
    }

    [Fact]
    public void Broken_file_does_not_poison_other_files()
    {
        var broken = "context Broken { value {{{ ";
        var idx = Index(("file:///broken.koi", broken), ("file:///catalog.koi", Catalog));
        var def = idx.ResolveDefinition("file:///broken.koi", "Product");
        Assert.NotNull(def); // resolves into catalog despite broken active file
        Assert.Equal("file:///catalog.koi", def!.Uri);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~WorkspaceIndexTests"`
Expected: FAIL to compile — `WorkspaceIndex` does not exist.

- [ ] **Step 3: Implement `WorkspaceIndex` with definition resolution**

Create `src/Koine.Compiler/Services/WorkspaceIndex.cs`:

```csharp
using Koine.Compiler.Ast;

namespace Koine.Compiler.Services;

/// <summary>The file URI and 1-based span of a resolved declaration.</summary>
public sealed record DeclLocation(string Uri, SourceSpan Span);

/// <summary>
/// A workspace-wide declaration index built from a <c>uri → source</c> map. Each
/// document is parsed once; resolution is local-file-first, then a unique match
/// across the other files (ambiguity yields no result). Editor-agnostic — no LSP.
/// </summary>
public sealed class WorkspaceIndex
{
    private readonly Dictionary<string, ModelIndex> _byUri = new(StringComparer.Ordinal);

    public WorkspaceIndex(IReadOnlyDictionary<string, string> documents)
    {
        var compiler = new KoineCompiler();
        foreach (var (uri, text) in documents)
        {
            var (model, _) = compiler.Parse(text);
            if (model is not null)
                _byUri[uri] = new ModelIndex(model); // a file that fails to parse is simply absent
        }
    }

    /// <summary>
    /// Resolves <paramref name="name"/> to a declaration location: the active file
    /// wins if it declares the name; otherwise a unique declaration among the other
    /// files; otherwise null (unknown or ambiguous across ≥2 other files).
    /// </summary>
    public DeclLocation? ResolveDefinition(string activeUri, string name)
    {
        if (_byUri.TryGetValue(activeUri, out var active) && StrongSpan(active, name) is { } localSpan)
            return new DeclLocation(activeUri, localSpan);

        DeclLocation? found = null;
        foreach (var (uri, index) in _byUri)
        {
            if (string.Equals(uri, activeUri, StringComparison.Ordinal)) continue;
            if (StrongSpan(index, name) is { } span)
            {
                if (found is not null) return null; // ambiguous across files
                found = new DeclLocation(uri, span);
            }
        }
        return found;
    }

    /// <summary>
    /// The span of a "strong" declaration of <paramref name="name"/> within one
    /// model: a declared type, an unambiguous enum member, a spec, or the entity that
    /// owns the ID type. Null otherwise (primitives/collections are not declarations).
    /// </summary>
    internal static SourceSpan? StrongSpan(ModelIndex index, string name)
    {
        if (index.TryGetDecl(name, out var decl) && decl.Span != SourceSpan.None)
            return decl.Span;

        var owners = index.EnumsDeclaring(name);
        if (owners.Count == 1 && index.TryGetDecl(owners[0], out var ed) && ed is EnumDecl e)
        {
            var member = e.Members.FirstOrDefault(m => m.Name == name);
            if (member is not null && member.Span != SourceSpan.None)
                return member.Span;
        }

        var spec = index.AllSpecs().FirstOrDefault(s => s.Name == name);
        if (spec is not null && spec.Span != SourceSpan.None)
            return spec.Span;

        // ID type -> the entity that declares `identified by <name>`.
        var owner = index.AllTypes().OfType<EntityDecl>().FirstOrDefault(en => en.IdentityName == name);
        if (owner is not null && owner.Span != SourceSpan.None)
            return owner.Span;

        return null;
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~WorkspaceIndexTests"`
Expected: PASS (5 tests). If a `Span.Line` assertion is off, confirm the declaration-keyword line in the test fixture and correct the expectation — do not weaken the code.

- [ ] **Step 5: Commit**

```bash
git add src/Koine.Compiler/Services/WorkspaceIndex.cs tests/Koine.Compiler.Tests/WorkspaceIndexTests.cs
git commit -m "feat(lsp): add WorkspaceIndex with cross-file definition resolution"
```

---

## Task 2: `WorkspaceIndex` — cross-file hover (move rendering in)

**Files:**
- Modify: `src/Koine.Compiler/Services/WorkspaceIndex.cs`
- Modify: `src/Koine.Compiler/Services/KoineLanguageService.cs` (move the four rendering helpers out)
- Test: `tests/Koine.Compiler.Tests/WorkspaceIndexTests.cs`

- [ ] **Step 1: Add failing tests**

Append to `WorkspaceIndexTests`:

```csharp
    [Fact]
    public void Cross_file_type_hover_renders_card_from_other_file()
    {
        var a = "context A { value Wrap { c: Currency } }\n";
        var idx = Index(("file:///a.koi", a), ("file:///catalog.koi", Catalog));
        var md = idx.ResolveHover("file:///a.koi", "Currency");
        Assert.NotNull(md);
        Assert.Contains("Currency", md!);
        Assert.Contains("Enum", md);
    }

    [Fact]
    public void Cross_file_id_hover_shows_owning_entity()
    {
        var idx = Index(("file:///ordering.koi", Ordering), ("file:///catalog.koi", Catalog));
        var md = idx.ResolveHover("file:///ordering.koi", "ProductId");
        Assert.NotNull(md);
        Assert.Contains("Product", md!); // names the owning entity
    }

    [Fact]
    public void Primitive_hover_uses_weak_fallback()
    {
        var idx = Index(("file:///a.koi", "context A { value V { x: Int } }\n"));
        var md = idx.ResolveHover("file:///a.koi", "Decimal");
        Assert.NotNull(md);
        Assert.Contains("Primitive", md!);
    }

    [Fact]
    public void Unknown_name_hover_is_null()
    {
        var idx = Index(("file:///a.koi", "context A { value V { x: Int } }\n"));
        Assert.Null(idx.ResolveHover("file:///a.koi", "Nonexistent"));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~WorkspaceIndexTests"`
Expected: FAIL to compile — `ResolveHover` does not exist.

- [ ] **Step 3: Add hover rendering to `WorkspaceIndex` (leave `KoineLanguageService`'s copies in place for now)**

To keep every commit compiling, do NOT delete anything from `KoineLanguageService` in this task — its old `HoverAt` still calls its own `RenderHover`. You will add equivalent helpers to `WorkspaceIndex` here (brief duplication); Task 3 removes the now-unused originals from `KoineLanguageService` when it rewires the methods.

In `src/Koine.Compiler/Services/WorkspaceIndex.cs`, add `using System.Text;` at the top, and add these members to the class:

```csharp
    /// <summary>
    /// Renders a hover card for <paramref name="name"/>: a strong declaration in the
    /// active file, else a unique strong declaration across other files, else a weak
    /// minimal card for primitives/collections/ID-convention names. Null if unknown.
    /// </summary>
    public string? ResolveHover(string activeUri, string name)
    {
        if (_byUri.TryGetValue(activeUri, out var active) && StrongHover(active, name) is { } local)
            return local;

        string? found = null;
        foreach (var (uri, index) in _byUri)
        {
            if (string.Equals(uri, activeUri, StringComparison.Ordinal)) continue;
            if (StrongHover(index, name) is { } card)
            {
                if (found is not null) return null; // ambiguous across files
                found = card;
            }
        }
        return found ?? WeakCard(name);
    }

    /// <summary>A markdown card for a "strong" declaration in one model, or null.</summary>
    internal static string? StrongHover(ModelIndex index, string name)
    {
        if (index.TryGetDecl(name, out var decl))
        {
            var sb = new StringBuilder();
            sb.Append("**").Append(name).Append("** *(").Append(KindLabel(index.Classify(name))).Append(")*");
            AppendBody(sb, decl);
            if (decl.Doc is { Length: > 0 } doc)
                sb.Append("\n\n").Append(doc);
            return sb.ToString();
        }

        var owners = index.EnumsDeclaring(name);
        if (owners.Count == 1)
            return $"**{name}** *(enum member of {owners[0]})*";
        if (owners.Count >= 2)
            return $"**{name}** *(ambiguous enum member — declared in {string.Join(", ", owners)})*";

        var spec = index.AllSpecs().FirstOrDefault(s => s.Name == name);
        if (spec is not null)
            return $"**{name}** *(spec on {spec.TargetType})*";

        var owner = index.AllTypes().OfType<EntityDecl>().FirstOrDefault(en => en.IdentityName == name);
        if (owner is not null)
        {
            var sb = new StringBuilder();
            sb.Append("**").Append(name).Append("** *(identity of ").Append(owner.Name).Append(")*");
            AppendBody(sb, owner);
            return sb.ToString();
        }

        return null;
    }

    /// <summary>A minimal card for primitives, collection keywords, or ID-convention names.</summary>
    internal static string? WeakCard(string name)
    {
        if (ModelIndex.Primitives.Contains(name))
            return $"**{name}** *(Primitive)*";
        if (name is ModelIndex.ListTypeName or ModelIndex.SetTypeName or ModelIndex.MapTypeName or ModelIndex.RangeTypeName)
            return $"**{name}** *({name})*";
        if (ModelIndex.IsIdConvention(name))
            return $"**{name}** *(ID value object)*";
        return null;
    }

    private static string KindLabel(TypeKind kind) => kind switch
    {
        TypeKind.IdValueObject => "ID value object",
        _ => kind.ToString(),
    };

    private static string TypeLabel(TypeRef t)
    {
        var name = t.Element is null ? t.Name
            : t.Value is null ? $"{t.Name}<{TypeLabel(t.Element)}>"
            : $"{t.Name}<{TypeLabel(t.Element)}, {TypeLabel(t.Value)}>";
        return t.IsOptional ? name + "?" : name;
    }

    private static void AppendBody(StringBuilder sb, TypeDecl decl)
    {
        switch (decl)
        {
            case ValueObjectDecl v:
                foreach (var m in v.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case EntityDecl e:
                sb.Append("\n\nidentified by `").Append(e.IdentityName).Append("` (")
                  .Append(e.IdStrategy).Append(')');
                foreach (var m in e.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case EnumDecl en:
                sb.Append("\n\n").Append(string.Join(", ", en.MemberNames));
                break;
            case EventDecl ev:
                foreach (var m in ev.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case AggregateDecl agg:
                // Listing the aggregate's owned/nested types is intentionally omitted for now.
                sb.Append("\n\nroot `").Append(agg.RootName).Append('`');
                if (agg.IsVersioned) sb.Append(" *(versioned)*");
                break;
        }
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj`
Expected: PASS — the full suite still builds and passes (the four helpers are briefly duplicated between `KoineLanguageService` and `WorkspaceIndex`; both compile), plus the 4 new `WorkspaceIndexTests` (9 total in that class).

- [ ] **Step 5: Commit**

```bash
git add src/Koine.Compiler/Services/WorkspaceIndex.cs tests/Koine.Compiler.Tests/WorkspaceIndexTests.cs
git commit -m "feat(lsp): add cross-file hover resolution to WorkspaceIndex"
```

---

## Task 3: Rewire `KoineLanguageService` to the workspace API

**Files:**
- Modify: `src/Koine.Compiler/Services/KoineLanguageService.cs`
- Test: `tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs`

- [ ] **Step 1: Update the existing hover/definition tests to the doc-map API and add a cross-file test**

In `tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs`, the hover and definition tests currently call `Svc.HoverAt(src, line, character)` / `Svc.DefinitionAt(src, line, character)`. Replace EACH such call with the doc-map form using a single-entry map and a fixed active URI. Add a private helper at the top of the class:

```csharp
    private const string U = "file:///t.koi";
    private static IReadOnlyDictionary<string, string> Doc(string src) =>
        new Dictionary<string, string> { [U] = src };
```

Then update every hover/definition call, e.g.:
- `Svc.HoverAt(src, line: 2, character: 23)` → `Svc.HoverAt(Doc(src), U, line: 2, character: 23)`
- `Svc.DefinitionAt(src, line: 2, character: 23)` → `Svc.DefinitionAt(Doc(src), U, line: 2, character: 23)`
- For definition tests that assert `def!.Target.Line`, that still works (the record keeps `Target`).

Add one cross-file definition test:

```csharp
    [Fact]
    public void DefinitionAt_resolves_across_files()
    {
        var ordering = "context Ordering {\n  value Line { product: ProductId }\n}\n";
        var catalog = "context Catalog {\n  entity Product identified by ProductId { sku: String }\n}\n";
        var docs = new Dictionary<string, string>
        {
            ["file:///ordering.koi"] = ordering,
            ["file:///catalog.koi"] = catalog,
        };
        // cursor on "ProductId" in ordering.koi line 1
        var def = Svc.DefinitionAt(docs, "file:///ordering.koi", line: 1, character: 25);
        Assert.NotNull(def);
        Assert.Equal("file:///catalog.koi", def!.Uri);
    }
```

(Verify `character: 25` lands on `ProductId` in `  value Line { product: ProductId }`; adjust if needed.)

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~KoineLanguageServiceTests"`
Expected: FAIL to compile — `HoverAt`/`DefinitionAt` don't have the doc-map overload yet, and `DefinitionResult` has no `Uri`.

- [ ] **Step 3: Rewrite the result record and the two methods**

In `src/Koine.Compiler/Services/KoineLanguageService.cs`:

Change the record:
```csharp
public sealed record DefinitionResult(string Uri, SourceSpan Target);
```

Replace the entire `HoverAt` method (the `public HoverResult? HoverAt(string source, …)` one) with:
```csharp
    public HoverResult? HoverAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character)
    {
        if (!documents.TryGetValue(activeUri, out var source))
            return null;

        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
            return null;

        var markdown = new WorkspaceIndex(documents).ResolveHover(activeUri, name);
        return markdown is null ? null : new HoverResult(markdown);
    }
```

Replace the entire `DefinitionAt` method with:
```csharp
    public DefinitionResult? DefinitionAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character)
    {
        if (!documents.TryGetValue(activeUri, out var source))
            return null;

        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
            return null;

        var loc = new WorkspaceIndex(documents).ResolveDefinition(activeUri, name);
        return loc is null ? null : new DefinitionResult(loc.Uri, loc.Span);
    }
```

Then **delete** the now-unused private static helpers `RenderHover`, `AppendBody`, `KindLabel`, and `TypeLabel` from `KoineLanguageService` — they were duplicated into `WorkspaceIndex` in Task 2 and nothing in the service references them anymore. (`_compiler` is still used by `CompleteAt`, so leave it. `CompleteAt` is unchanged.)

- [ ] **Step 3b: Update `LspServer`'s two call sites so the build stays green**

Removing the single-file overloads breaks `LspServer` (it still calls `_ls.HoverAt(text,line,ch)` / `_ls.DefinitionAt(text,line,ch)`). Update both helpers in `src/Koine.Cli/LspServer.cs` to the new doc-map signature, passing the live `_docs` dictionary as the document map (full workspace scan is added in Task 4). Replace the guard+call at the top of `HoverResultJson`:
```csharp
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch)
            || !_docs.TryGetValue(uri, out var text))
            return null;

        var hover = _ls.HoverAt(text, line, ch);
```
with:
```csharp
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch))
            return null;

        var hover = _ls.HoverAt(_docs, uri, line, ch);
```
And in `DefinitionResultJson`, replace:
```csharp
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch)
            || !_docs.TryGetValue(uri, out var text))
            return null;

        var def = _ls.DefinitionAt(text, line, ch);
        if (def is null)
            return null;
```
with:
```csharp
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch))
            return null;

        var def = _ls.DefinitionAt(_docs, uri, line, ch);
        if (def is null)
            return null;
```
and change the returned dictionary's `["uri"] = uri,` line to `["uri"] = def.Uri,` (the target may differ from the request once cross-file lands; with `_docs`-only it equals `uri`). Leave the comment about the single-file model for now — Task 4 updates it.

- [ ] **Step 4: Run to verify pass**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj`
Expected: the FULL suite builds and passes (existing protocol tests still pass — with one open doc in `_docs`, `def.Uri` equals the request URI), plus the migrated/added service tests. Adjust the cross-file test's `character: 25` column if the cursor lands off the token.

- [ ] **Step 5: Commit**

```bash
git add src/Koine.Compiler/Services/KoineLanguageService.cs src/Koine.Cli/LspServer.cs tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs
git commit -m "feat(lsp): make KoineLanguageService hover/definition workspace-aware"
```

---

## Task 4: `LspServer` — workspace scan, overlay, target URI

**Files:**
- Modify: `src/Koine.Cli/LspServer.cs`
- Test: `tests/Koine.Compiler.Tests/LspServerTests.cs`

- [ ] **Step 1: Add protocol tests**

In `tests/Koine.Compiler.Tests/LspServerTests.cs`, add an `InitializeWithRoot` helper and two tests. Test A (both files opened) is a regression guard — note it ALREADY passes after Task 3, because both files live in `_docs` and the server now resolves across the doc map. Test B (the real driver for this task) resolves into a file that is present **on disk in the workspace but never opened** — it fails until the scan exists.

```csharp
    private static byte[] InitializeWithRoot(string rootUri) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 1,
            method = "initialize",
            @params = new { rootUri },
        }));

    [Fact]
    public void Definition_resolves_across_open_files()
    {
        var ordering = "context Ordering {\n  value Line { product: ProductId }\n}\n";
        var catalog = "context Catalog {\n  entity Product identified by ProductId { sku: String }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///ordering.koi", ordering),
            DidOpen("file:///catalog.koi", catalog),
            Definition("file:///ordering.koi", 1, 25)); // on "ProductId"
        Assert.Contains("file:///catalog.koi", output); // target URI is the declaring file
        Assert.Contains("\"range\"", output);
    }

    [Fact]
    public void Definition_resolves_into_unopened_workspace_file()
    {
        // catalog.koi exists on disk in the workspace root but is NOT opened.
        var dir = Directory.CreateTempSubdirectory("koi-ws-");
        try
        {
            File.WriteAllText(Path.Combine(dir.FullName, "catalog.koi"),
                "context Catalog {\n  entity Product identified by ProductId { sku: String }\n}\n");
            var rootUri = new Uri(dir.FullName).AbsoluteUri;
            var orderingUri = new Uri(Path.Combine(dir.FullName, "ordering.koi")).AbsoluteUri;
            var ordering = "context Ordering {\n  value Line { product: ProductId }\n}\n";

            var output = RunSession(
                InitializeWithRoot(rootUri),
                DidOpen(orderingUri, ordering),
                Definition(orderingUri, 1, 25)); // on "ProductId"; catalog.koi NOT opened

            Assert.Contains("catalog.koi", output); // resolved via the on-disk workspace scan
        }
        finally { dir.Delete(recursive: true); }
    }
```

(`Definition`/`DidOpen`/`Frame`/`Initialize` helpers already exist. The assertion uses the `catalog.koi` substring rather than the full URI to be robust against temp-path normalization, e.g. `/var` vs `/private/var` on macOS. Verify column 25 lands on `ProductId`.)

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~LspServerTests"`
Expected: `Definition_resolves_into_unopened_workspace_file` FAILS (no workspace scan yet → `catalog.koi` not in the doc map → no target). `Definition_resolves_across_open_files` already passes (both docs are open). Build still succeeds (Task 3 left it compiling).

- [ ] **Step 3: Add workspace fields and URI helpers**

In `src/Koine.Cli/LspServer.cs`, below `private readonly Dictionary<string, string> _docs = …;` add:
```csharp
    // On-disk baseline of every *.koi in the workspace (uri -> text), scanned at initialize.
    private readonly Dictionary<string, string> _workspaceFiles = new(StringComparer.Ordinal);
```

Add these helpers near `TryGetUri`:
```csharp
    /// <summary>Merged view: on-disk workspace files overlaid by open/edited docs (open wins).</summary>
    private Dictionary<string, string> Workspace()
    {
        var merged = new Dictionary<string, string>(_workspaceFiles, StringComparer.Ordinal);
        foreach (var (uri, text) in _docs)
            merged[uri] = text;
        return merged;
    }

    private static string? PathToUri(string path)
    {
        try { return new Uri(path).AbsoluteUri; } catch { return null; }
    }

    private static string? UriToPath(string uri)
    {
        try { var u = new Uri(uri); return u.IsFile ? u.LocalPath : null; } catch { return null; }
    }

    /// <summary>Scans the workspace root for *.koi files into <see cref="_workspaceFiles"/>.</summary>
    private void ScanWorkspace(string rootUri)
    {
        var root = UriToPath(rootUri);
        if (root is null || !Directory.Exists(root))
            return;
        try
        {
            foreach (var path in Directory.EnumerateFiles(root, "*.koi", SearchOption.AllDirectories))
            {
                if (path.Contains("/bin/") || path.Contains("/obj/") || path.Contains("/.git/"))
                    continue;
                var uri = PathToUri(path);
                if (uri is null) continue;
                try { _workspaceFiles[uri] = File.ReadAllText(path); }
                catch (Exception ex) { Log($"skip {path}: {ex.Message}"); }
            }
            Log($"workspace scan indexed {_workspaceFiles.Count} .koi file(s)");
        }
        catch (Exception ex) { Log("workspace scan failed: " + ex); }
    }
```

(`Log` is the existing stderr logger in `LspServer`.)

- [ ] **Step 4: Scan on `initialize`**

In the `initialize` case, before/after building the response (either works), capture and scan the root. Add at the top of the `case "initialize":` block, before `Respond(...)`:
```csharp
                        if (root.TryGetProperty("params", out var initParams))
                        {
                            if (initParams.TryGetProperty("rootUri", out var ru) && ru.ValueKind == JsonValueKind.String)
                                ScanWorkspace(ru.GetString()!);
                            if (initParams.TryGetProperty("workspaceFolders", out var folders)
                                && folders.ValueKind == JsonValueKind.Array)
                                foreach (var f in folders.EnumerateArray())
                                    if (f.TryGetProperty("uri", out var fu) && fu.ValueKind == JsonValueKind.String)
                                        ScanWorkspace(fu.GetString()!);
                        }
```

- [ ] **Step 5: Swap the hover/definition handlers from `_docs` to the merged workspace**

Task 3 already moved these two helpers to the doc-map signature using `_docs`. Now change the single call in each to use the merged `Workspace()` map instead.

In `HoverResultJson`, change `_ls.HoverAt(_docs, uri, line, ch)` → `_ls.HoverAt(Workspace(), uri, line, ch)`.

In `DefinitionResultJson`, change `_ls.DefinitionAt(_docs, uri, line, ch)` → `_ls.DefinitionAt(Workspace(), uri, line, ch)`, and update the now-stale `// Single-file model: …` comment above `["uri"] = def.Uri,` to:
```csharp
        // The target may live in a different file than the request (cross-file resolution).
```
For reference, `DefinitionResultJson` should read:
```csharp
    private object? DefinitionResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch))
            return null;

        var def = _ls.DefinitionAt(Workspace(), uri, line, ch);
        if (def is null)
            return null;

        // SpanOf points at the declaration keyword (1-based); the LSP range is 0-based
        // and zero-width. The target URI may be a different file than the request.
        var startLine = Math.Max(0, def.Target.Line - 1);
        var startChar = Math.Max(0, def.Target.Column - 1);
        return new Dictionary<string, object?>
        {
            ["uri"] = def.Uri,
            ["range"] = new Dictionary<string, object?>
            {
                ["start"] = new Dictionary<string, object?> { ["line"] = startLine, ["character"] = startChar },
                ["end"] = new Dictionary<string, object?> { ["line"] = startLine, ["character"] = startChar },
            },
        };
    }
```

(Note: `CompletionResult` still uses `_docs.TryGetValue(uri, …)` — leave it; completion stays single-file.)

- [ ] **Step 6: Run to verify pass**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj`
Expected: PASS — the full suite (existing + new cross-file protocol test). Confirm `System.IO` is available (it is via implicit usings; if not, add `using System.IO;`).

- [ ] **Step 7: Commit**

```bash
git add src/Koine.Cli/LspServer.cs tests/Koine.Compiler.Tests/LspServerTests.cs
git commit -m "feat(lsp): scan workspace .koi files and resolve definition/hover across them"
```

---

## Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `tooling/README.md`

- [ ] **Step 1: Update README.md**

In the LSP paragraph (the line listing "live error squiggles, code completion, hover docs, and go-to-definition"), append a sentence after it:
```markdown
Hover and go-to-definition resolve **across all `.koi` files in the workspace** — e.g. an `OrderId`/`ProductId` reference jumps to the `entity … identified by …` that owns it, even in another file.
```

- [ ] **Step 2: Update tooling/README.md**

In the `### Editor features` subsection, replace the **Go-to-definition** and **Hover** bullets with:
```markdown
- **Hover** — a markdown card showing a type's kind, members (with full generic types like
  `List<OrderLine>`), and doc comment; resolves across files, and an `*Id` shows its owning entity.
- **Go-to-definition** — jump from a type, enum-member, spec, or `*Id` reference to its declaration
  in any `.koi` file in the workspace. (Navigation lands on the declaration keyword; cross-file
  *ambiguous* names — declared in two files — are not navigated. Files edited outside the editor
  re-index on server restart.)
```

- [ ] **Step 3: Verify and commit**

Run: `git diff --stat README.md tooling/README.md`
Expected: both modified.

```bash
git add README.md tooling/README.md
git commit -m "docs(lsp): document cross-file workspace navigation"
```

---

## Final verification

- [ ] **Full suite**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj`
Expected: all pass (existing 341 + new WorkspaceIndex/service/protocol tests).

- [ ] **Manual smoke (optional):** rebuild Release, point a session at the demo models, and confirm go-to-definition on `ProductId` in `ordering.koi` jumps to `catalog.koi`.

---

## Notes & limitations (from the spec)

- External edits to **closed** files re-index only on server restart; open files are live.
- Cross-file **ambiguity** (a name declared as a type in ≥2 other files) → no navigation.
- A file with a **syntax error** drops out of the index until fixed; other files still resolve.
- **Completion stays single-file** (lexer-only) — unchanged.
- Per-file parse caching (keyed by content/version) is a future perf optimization; for now each hover/definition rebuilds the `WorkspaceIndex`.
