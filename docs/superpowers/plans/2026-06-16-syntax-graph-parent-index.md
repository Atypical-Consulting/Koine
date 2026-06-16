# SyntaxGraph — parent links + position index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `SemanticModel` a build-once, query-many node graph (Roslyn red-layer style) that provides upward navigation and O(depth) position lookup, then route the six existing position methods through it.

**Architecture:** A new internal `SyntaxGraph` is built lazily from the immutable AST in a single DFS, holding reference-keyed `parent`, `children`, and `FullSpan` maps. Position lookups use Roslyn's `FindNode` model — top-down descent over `FullSpan` (O(depth)), not the current per-query full-tree reflection walks. `SemanticModel` exposes a Roslyn-idiomatic navigation API and delegates its position methods to the graph; observable behavior is unchanged (validated by the existing navigation/refactor suite as the equivalence oracle).

**Tech Stack:** C# / .NET 10 (`net10.0`, `Nullable enable`), xUnit (`[Fact]`, `Assert`), existing ANTLR-based `KoineCompiler` pipeline.

## Global Constraints

- Target framework: `net10.0`; `<Nullable>enable</Nullable>` — all new code must be null-annotation-clean.
- The AST namespace `Koine.Compiler.Ast` is TARGET-AGNOSTIC: no C#/emit concepts may enter it.
- `KoineNode` is an immutable value-equality `record` — every node-keyed dictionary MUST use **reference** identity, never value equality.
- Do NOT touch `Emit/`, `ModelIndex`, `TypeResolver`, or `KoineType` (conflict guard: a TypeScript emitter is in flight against that surface). The entire diff stays inside `src/Koine.Compiler/Ast/` + the test project.
- Test project `Koine.Compiler.Tests` already has `InternalsVisibleTo`, so `internal` types are directly testable.
- Commit style: Conventional Commits, lowercase scope — e.g. `feat(ast): …`, `test(ast): …`.
- Build/test: `./build.sh` (full) or `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj` (with `--filter` for a subset).

---

## File Structure

- **Create** `src/Koine.Compiler/Ast/SyntaxGraph.cs` — the node graph: parent/children/FullSpan maps + navigation (`Parent`, `ChildNodes`, `Ancestors`, `AncestorsAndSelf`, `FirstAncestorOrSelf<T>`) + position lookup (`FindNode`, `FindNameNode`). Internal.
- **Modify** `src/Koine.Compiler/Ast/NodeWalker.cs` — promote `ChildNodes` from `private static` to `internal static` so `SyntaxGraph` reuses the one reflection-based child enumerator.
- **Modify** `src/Koine.Compiler/Ast/SemanticModel.cs` — add a thread-safe lazy `_graph`, expose the navigation API, and rewrite the six position methods (`NodeAt`, `DeclarationNameAt`, `DeclaredSymbolAt`, `EnclosingFieldedTypeNameAt`, `EnclosingEnumNameAt`, `DefinitionAt`) to delegate; delete the now-dead `Contains` helper if unused.
- **Create** `tests/Koine.Compiler.Tests/SyntaxGraphTests.cs` — direct unit tests for the graph (reference-equality regression, structural invariants, position-lookup equivalence oracle).

---

### Task 1: `SyntaxGraph` structure + navigation API

Build the graph (parent/children/FullSpan) and the upward-navigation API. No position lookup yet, no `SemanticModel` wiring — so existing behavior is untouched and this is fully tested in isolation.

**Files:**
- Modify: `src/Koine.Compiler/Ast/NodeWalker.cs` (one-word visibility change)
- Create: `src/Koine.Compiler/Ast/SyntaxGraph.cs`
- Test: `tests/Koine.Compiler.Tests/SyntaxGraphTests.cs`

**Interfaces:**
- Consumes: `NodeWalker.ChildNodes(KoineNode)` (newly `internal`), `KoineNode.Span` (`SourceSpan` with `int Offset`, `int Length`).
- Produces (relied on by Tasks 2 & 3):
  - `internal sealed class SyntaxGraph` with ctor `SyntaxGraph(KoineNode root)`
  - `KoineNode? Parent(KoineNode node)`
  - `IReadOnlyList<KoineNode> ChildNodes(KoineNode node)`
  - `IEnumerable<KoineNode> Ancestors(KoineNode node)` (nearest-first, excludes self, stops at root)
  - `IEnumerable<KoineNode> AncestorsAndSelf(KoineNode node)` (node first, then ancestors)
  - `T? FirstAncestorOrSelf<T>(KoineNode node) where T : KoineNode`

- [ ] **Step 1: Promote `NodeWalker.ChildNodes` to internal**

In `src/Koine.Compiler/Ast/NodeWalker.cs`, change the signature:

```csharp
    internal static IEnumerable<KoineNode> ChildNodes(KoineNode node)
```

(only `private` → `internal`; the body is unchanged).

- [ ] **Step 2: Write the failing tests for structure + navigation**

Create `tests/Koine.Compiler.Tests/SyntaxGraphTests.cs`:

```csharp
using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Direct unit tests for <see cref="SyntaxGraph"/>: the reference-keyed parent map (records use
/// value equality, so identity is mandatory), the upward-navigation API, and the FullSpan-descent
/// position lookup (equivalence with the previous full-tree scan).
/// </summary>
public class SyntaxGraphTests
{
    private static KoineModel Parse(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        Assert.Empty(diagnostics);
        Assert.NotNull(model);
        return model!;
    }

    private const string Src =
        "context Shop {\n" +
        "  value Money { amount: Decimal }\n" +
        "  spec Positive on Money = amount > 0\n" +
        "}\n";

    [Fact]
    public void Parent_uses_reference_identity_not_value_equality()
    {
        // Two value-EQUAL IdentifierExpr("x") with DIFFERENT parents. A value-keyed map would
        // collapse them to one entry; reference identity keeps them distinct.
        var idA = new IdentifierExpr("x");
        var idB = new IdentifierExpr("x");
        Assert.Equal(idA, idB);                 // value equality holds...
        Assert.NotSame(idA, idB);               // ...but they are distinct instances

        var lit0 = new LiteralExpr(LiteralKind.Int, "0");
        var lit9 = new LiteralExpr(LiteralKind.Int, "9");
        var gt = new BinaryExpr(BinaryOp.Gt, idA, lit0);
        var lt = new BinaryExpr(BinaryOp.Lt, idB, lit9);
        var root = new BinaryExpr(BinaryOp.And, gt, lt);

        var graph = new SyntaxGraph(root);

        Assert.Same(gt, graph.Parent(idA));
        Assert.Same(lt, graph.Parent(idB));
        Assert.Null(graph.Parent(root));
    }

    [Fact]
    public void Ancestors_are_nearest_first_and_AncestorsAndSelf_starts_with_self()
    {
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);

        // The "amount" identifier inside the spec body.
        var id = NodeWalker.Descendants(model).OfType<IdentifierExpr>().Single(n => n.Name == "amount");

        var ancestors = graph.Ancestors(id).ToList();
        Assert.DoesNotContain(id, ancestors);
        Assert.Same(model, ancestors[^1]);                       // walk terminates at the root

        var withSelf = graph.AncestorsAndSelf(id).ToList();
        Assert.Same(id, withSelf[0]);                            // self first
        Assert.Equal(ancestors, withSelf.Skip(1).ToList());      // then the ancestors, in order
    }

    [Fact]
    public void FirstAncestorOrSelf_finds_the_enclosing_spec()
    {
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);
        var id = NodeWalker.Descendants(model).OfType<IdentifierExpr>().Single(n => n.Name == "amount");

        // The "amount" reference here lives inside the spec body (`spec Positive on Money = amount > 0`),
        // so the nearest enclosing declaration is the SpecDecl — not the Money value object, which the
        // spec targets by name but does not lexically nest.
        var spec = graph.FirstAncestorOrSelf<SpecDecl>(id);
        Assert.NotNull(spec);
        Assert.Equal("Positive", spec!.Name);
    }

    [Fact]
    public void Parent_span_contains_child_span_for_positioned_nodes()
    {
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);

        foreach (var node in NodeWalker.Descendants(model))
        {
            if (node.Span.Length <= 0)
            {
                continue;
            }

            // Find the nearest ancestor that itself has a real span and assert containment.
            var ancestor = graph.Ancestors(node).FirstOrDefault(a => a.Span.Length > 0);
            if (ancestor is null)
            {
                continue;
            }

            Assert.True(ancestor.Span.Offset <= node.Span.Offset);
            Assert.True(ancestor.Span.Offset + ancestor.Span.Length >= node.Span.Offset + node.Span.Length);
        }
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~SyntaxGraphTests"`
Expected: FAIL — compile error, `SyntaxGraph` does not exist.

- [ ] **Step 4: Implement `SyntaxGraph` (structure + navigation)**

Create `src/Koine.Compiler/Ast/SyntaxGraph.cs`:

```csharp
using System.Runtime.CompilerServices;

namespace Koine.Compiler.Ast;

/// <summary>
/// A build-once, query-many companion to an immutable <see cref="KoineNode"/> tree — Koine's
/// equivalent of Roslyn's "red layer". Because nodes are value-equality records, a mutable parent
/// pointer would break their value semantics, so the parent relation lives here in a
/// reference-keyed table. Built in a single DFS that also records each node's children (source
/// order) and its <c>FullSpan</c> (a bounding range over the node and all descendants), which
/// powers O(depth) position lookup via top-down descent (the Roslyn <c>FindNode</c> model).
/// TARGET-AGNOSTIC.
/// </summary>
internal sealed class SyntaxGraph
{
    /// <summary>Reference (identity) equality for node keys — never the records' value equality.</summary>
    private sealed class IdentityComparer : IEqualityComparer<KoineNode>
    {
        public static readonly IdentityComparer Instance = new();
        public bool Equals(KoineNode? a, KoineNode? b) => ReferenceEquals(a, b);
        public int GetHashCode(KoineNode node) => RuntimeHelpers.GetHashCode(node);
    }

    private readonly KoineNode _root;
    private readonly Dictionary<KoineNode, KoineNode?> _parent = new(IdentityComparer.Instance);
    private readonly Dictionary<KoineNode, IReadOnlyList<KoineNode>> _children = new(IdentityComparer.Instance);

    /// <summary>Bounding span per node as a half-open <c>[Start, End)</c>; an empty range never contains an offset.</summary>
    private readonly Dictionary<KoineNode, (int Start, int End)> _fullSpan = new(IdentityComparer.Instance);

    public SyntaxGraph(KoineNode root)
    {
        _root = root;
        Build(root, null);
    }

    private void Build(KoineNode node, KoineNode? parent)
    {
        _parent[node] = parent;
        IReadOnlyList<KoineNode> children = NodeWalker.ChildNodes(node).ToList();
        _children[node] = children;

        // Seed with the node's own span (if positioned), then union in each child's FullSpan.
        var start = node.Span.Length > 0 ? node.Span.Offset : int.MaxValue;
        var end = node.Span.Length > 0 ? node.Span.Offset + node.Span.Length : int.MinValue;

        foreach (KoineNode child in children)
        {
            Build(child, node);
            (int childStart, int childEnd) = _fullSpan[child];
            if (childStart < start)
            {
                start = childStart;
            }

            if (childEnd > end)
            {
                end = childEnd;
            }
        }

        _fullSpan[node] = (start, end);
    }

    /// <summary>The node's parent, or <c>null</c> for the root (or an unknown node).</summary>
    public KoineNode? Parent(KoineNode node) => _parent.GetValueOrDefault(node);

    /// <summary>The node's child nodes in source order (empty for a leaf or unknown node).</summary>
    public IReadOnlyList<KoineNode> ChildNodes(KoineNode node) =>
        _children.TryGetValue(node, out IReadOnlyList<KoineNode>? kids) ? kids : Array.Empty<KoineNode>();

    /// <summary>The parent chain, nearest-first, excluding <paramref name="node"/> and stopping at the root.</summary>
    public IEnumerable<KoineNode> Ancestors(KoineNode node)
    {
        for (KoineNode? p = Parent(node); p is not null; p = Parent(p))
        {
            yield return p;
        }
    }

    /// <summary><paramref name="node"/> first, then its <see cref="Ancestors(KoineNode)"/>.</summary>
    public IEnumerable<KoineNode> AncestorsAndSelf(KoineNode node)
    {
        yield return node;
        foreach (KoineNode a in Ancestors(node))
        {
            yield return a;
        }
    }

    /// <summary>The nearest <typeparamref name="T"/> in <see cref="AncestorsAndSelf(KoineNode)"/>, or <c>null</c>.</summary>
    public T? FirstAncestorOrSelf<T>(KoineNode node) where T : KoineNode
    {
        foreach (KoineNode n in AncestorsAndSelf(node))
        {
            if (n is T match)
            {
                return match;
            }
        }

        return null;
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~SyntaxGraphTests"`
Expected: PASS (all four tests).

- [ ] **Step 6: Commit**

```bash
git add src/Koine.Compiler/Ast/NodeWalker.cs src/Koine.Compiler/Ast/SyntaxGraph.cs tests/Koine.Compiler.Tests/SyntaxGraphTests.cs
git commit -m "feat(ast): SyntaxGraph parent/children/FullSpan + navigation API"
```

---

### Task 2: `FindNode` / `FindNameNode` position lookup (FullSpan descent)

Add the O(depth) top-down descent and prove it byte-for-byte equivalent to the previous full-tree scan with a brute-force oracle over every offset.

**Files:**
- Modify: `src/Koine.Compiler/Ast/SyntaxGraph.cs`
- Test: `tests/Koine.Compiler.Tests/SyntaxGraphTests.cs`

**Interfaces:**
- Consumes: `SyntaxGraph` internals (`_root`, `_children`, `_fullSpan`), `KoineNode.Span`, `KoineNode.NameSpan`.
- Produces (relied on by Task 3):
  - `KoineNode? FindNode(int offset)` — innermost node whose own `Span` (real, `Length > 0`) contains `offset`; `null` if none.
  - `KoineNode? FindNameNode(int offset)` — innermost node whose `NameSpan` contains `offset`; `null` if none.

- [ ] **Step 1: Write the failing equivalence tests**

Append to `tests/Koine.Compiler.Tests/SyntaxGraphTests.cs` (inside the class):

```csharp
    // Brute-force oracle: the previous behavior — smallest positioned span containing the offset,
    // first in pre-order on ties. FindNode must match this for every offset.
    private static KoineNode? BruteInnermost(KoineModel model, int offset, bool useNameSpan)
    {
        KoineNode? best = null;
        var bestLength = int.MaxValue;
        foreach (var node in NodeWalker.Descendants(model))
        {
            var span = useNameSpan ? node.NameSpan : node.Span;
            if (span.Length > 0
                && offset >= span.Offset && offset < span.Offset + span.Length
                && span.Length < bestLength)
            {
                best = node;
                bestLength = span.Length;
            }
        }

        return best;
    }

    [Fact]
    public void FindNode_matches_the_brute_force_scan_for_every_offset()
    {
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);

        for (var offset = 0; offset <= Src.Length; offset++)
        {
            Assert.Same(BruteInnermost(model, offset, useNameSpan: false), graph.FindNode(offset));
        }
    }

    [Fact]
    public void FindNameNode_matches_the_brute_force_scan_for_every_offset()
    {
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);

        for (var offset = 0; offset <= Src.Length; offset++)
        {
            Assert.Same(BruteInnermost(model, offset, useNameSpan: true), graph.FindNameNode(offset));
        }
    }

    [Fact]
    public void FindNode_returns_null_outside_any_positioned_node()
    {
        var graph = new SyntaxGraph(Parse(Src));
        Assert.Null(graph.FindNode(int.MaxValue));
        Assert.Null(graph.FindNode(-1));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~SyntaxGraphTests"`
Expected: FAIL — `FindNode` / `FindNameNode` not defined.

- [ ] **Step 3: Implement the descent**

Add to `src/Koine.Compiler/Ast/SyntaxGraph.cs` (inside the class, after `FirstAncestorOrSelf`):

```csharp
    /// <summary>The innermost node whose own <see cref="KoineNode.Span"/> contains <paramref name="offset"/>.</summary>
    public KoineNode? FindNode(int offset) => Descend(_root, offset, static n => n.Span);

    /// <summary>The innermost node whose <see cref="KoineNode.NameSpan"/> contains <paramref name="offset"/>.</summary>
    public KoineNode? FindNameNode(int offset) => Descend(_root, offset, static n => n.NameSpan);

    /// <summary>
    /// Top-down descent (Roslyn <c>FindNode</c> model): routes by each child's <c>FullSpan</c> and
    /// returns the deepest node on the path whose <paramref name="select"/>ed span actually contains
    /// the offset. O(depth) given the validated nesting invariant (parent FullSpan ⊇ child FullSpan,
    /// real sibling spans disjoint).
    /// </summary>
    private KoineNode? Descend(KoineNode node, int offset, Func<KoineNode, SourceSpan> select)
    {
        SourceSpan span = select(node);
        KoineNode? best = span.Length > 0 && offset >= span.Offset && offset < span.Offset + span.Length
            ? node
            : null;

        foreach (KoineNode child in _children[node])
        {
            (int start, int end) = _fullSpan[child];
            if (offset >= start && offset < end && Descend(child, offset, select) is { } deeper)
            {
                best = deeper;
            }
        }

        return best;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~SyntaxGraphTests"`
Expected: PASS (all seven tests).

- [ ] **Step 5: Commit**

```bash
git add src/Koine.Compiler/Ast/SyntaxGraph.cs tests/Koine.Compiler.Tests/SyntaxGraphTests.cs
git commit -m "feat(ast): SyntaxGraph FindNode/FindNameNode via FullSpan descent"
```

---

### Task 3: Wire `SemanticModel` through `SyntaxGraph`

Replace the per-query reflection walks with delegation to the lazily-built graph, and expose the navigation API. Behavior is unchanged; the existing navigation/refactor suite is the equivalence oracle.

**Files:**
- Modify: `src/Koine.Compiler/Ast/SemanticModel.cs`

**Interfaces:**
- Consumes: everything Tasks 1 & 2 produced on `SyntaxGraph`.
- Produces: unchanged public signatures of `NodeAt`, `DeclarationNameAt`, `DeclaredSymbolAt`, `DefinitionAt`; plus new public `Parent`, `ChildNodes`, `Ancestors`, `AncestorsAndSelf`, `FirstAncestorOrSelf<T>` (red-layer API for later commits).

- [ ] **Step 1: Add the lazy graph field and the navigation API**

In `src/Koine.Compiler/Ast/SemanticModel.cs`, add `using System.Threading;` at the top, then add the field initialization in the constructor and the new members. The constructor currently reads:

```csharp
    public SemanticModel(KoineModel model)
    {
        Model = model;
        Index = new ModelIndex(model);
    }
```

Replace it with:

```csharp
    private readonly Lazy<SyntaxGraph> _graph;

    public SemanticModel(KoineModel model)
    {
        Model = model;
        Index = new ModelIndex(model);
        // Built on first position/navigation query only — the emit path never touches it.
        // Thread-safe so a cached/shared SemanticModel can't race the build under concurrent LSP requests.
        _graph = new Lazy<SyntaxGraph>(() => new SyntaxGraph(Model), LazyThreadSafetyMode.ExecutionAndPublication);
    }

    /// <summary>The node's parent, or <c>null</c> for the root. Red-layer navigation (Roslyn <c>Parent</c>).</summary>
    public KoineNode? Parent(KoineNode node) => _graph.Value.Parent(node);

    /// <summary>The node's child nodes in source order.</summary>
    public IReadOnlyList<KoineNode> ChildNodes(KoineNode node) => _graph.Value.ChildNodes(node);

    /// <summary>The parent chain, nearest-first, excluding <paramref name="node"/>.</summary>
    public IEnumerable<KoineNode> Ancestors(KoineNode node) => _graph.Value.Ancestors(node);

    /// <summary><paramref name="node"/> first, then its ancestors.</summary>
    public IEnumerable<KoineNode> AncestorsAndSelf(KoineNode node) => _graph.Value.AncestorsAndSelf(node);

    /// <summary>The nearest <typeparamref name="T"/> at or above <paramref name="node"/>, or <c>null</c>.</summary>
    public T? FirstAncestorOrSelf<T>(KoineNode node) where T : KoineNode => _graph.Value.FirstAncestorOrSelf<T>(node);
```

- [ ] **Step 2: Rewrite `NodeAt` and `DeclarationNameAt` to delegate**

Replace the existing `NodeAt` method body (the whole method, currently a `foreach` over `NodeWalker.Descendants`) with:

```csharp
    /// <summary>
    /// The innermost node whose <see cref="SourceSpan"/> contains the 0-based absolute
    /// <paramref name="offset"/>, or <c>null</c> when none does. The position→node map that powers
    /// in-expression and spec-body navigation.
    /// </summary>
    public KoineNode? NodeAt(int offset) => _graph.Value.FindNode(offset);
```

Replace the existing `DeclarationNameAt` method body with:

```csharp
    /// <summary>
    /// The innermost declaration/member node whose <see cref="KoineNode.NameSpan"/> covers the
    /// 0-based absolute <paramref name="offset"/>; <c>null</c> when the offset is not on any
    /// declaration name. Used by rename to classify a token as a declaration's own name.
    /// </summary>
    public KoineNode? DeclarationNameAt(int offset) => _graph.Value.FindNameNode(offset);
```

- [ ] **Step 3: Rewrite the two enclosing-scope helpers**

Replace the existing `EnclosingFieldedTypeNameAt` and `EnclosingEnumNameAt` methods (the two `foreach`-over-`Descendants` private helpers) with:

```csharp
    /// <summary>The name of the innermost value/entity/event/integration-event declaration enclosing <paramref name="offset"/>.</summary>
    private string? EnclosingFieldedTypeNameAt(int offset)
    {
        if (_graph.Value.FindNode(offset) is not { } node)
        {
            return null;
        }

        foreach (KoineNode anc in _graph.Value.AncestorsAndSelf(node))
        {
            if (anc is ValueObjectDecl or EntityDecl or EventDecl or IntegrationEventDecl)
            {
                return ((TypeDecl)anc).Name;
            }
        }

        return null;
    }

    /// <summary>The name of the innermost enum declaration enclosing <paramref name="offset"/>.</summary>
    private string? EnclosingEnumNameAt(int offset)
    {
        if (_graph.Value.FindNode(offset) is not { } node)
        {
            return null;
        }

        return _graph.Value.FirstAncestorOrSelf<EnumDecl>(node)?.Name;
    }
```

Then delete the now-unused `private static bool Contains(SourceSpan span, int offset)` helper (it was only used by the two methods just replaced). If a later step reports it is still referenced, leave it; otherwise remove it to avoid a dead-code warning.

- [ ] **Step 4: Rewrite `DefinitionAt` to use the graph**

Replace the existing `DefinitionAt` method body (the single-pass `foreach` over `Descendants` that tracks `enclosingType` inline) with:

```csharp
    /// <summary>
    /// Resolves go-to-definition at a 0-based absolute <paramref name="offset"/>: finds the innermost
    /// name-bearing node under the cursor (a bare identifier reference or a type reference) and
    /// resolves it via <see cref="GetSymbol(string, string?)"/> using the enclosing type as the
    /// lexical scope. <c>null</c> when nothing name-bearing sits at the offset or it does not resolve.
    /// </summary>
    public Symbol? DefinitionAt(int offset)
    {
        if (_graph.Value.FindNode(offset) is not { } node)
        {
            return null;
        }

        string? name = node switch
        {
            IdentifierExpr id => id.Name,
            TypeRef tr => tr.Name,
            _ => null
        };
        if (name is null)
        {
            return null;
        }

        // The lexical scope: the nearest enclosing fielded type, or a spec body's target type.
        string? enclosingType = null;
        foreach (KoineNode anc in _graph.Value.AncestorsAndSelf(node))
        {
            if (anc is ValueObjectDecl or EntityDecl or EventDecl or IntegrationEventDecl)
            {
                enclosingType = ((TypeDecl)anc).Name;
                break;
            }

            if (anc is SpecDecl spec)
            {
                enclosingType = spec.TargetType;
                break;
            }
        }

        return GetSymbol(name, enclosingType);
    }
```

Then delete the now-unused `private static (string Name, int Length)? NameAtNode(KoineNode node, int offset)` helper (it was only used by the old `DefinitionAt`). `DeclaredSymbolAt` is left as-is: it already calls `DeclarationNameAt`, `EnclosingFieldedTypeNameAt`, and `EnclosingEnumNameAt`, which now delegate to the graph.

- [ ] **Step 5: Run the navigation + refactor suite (the equivalence oracle)**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~NodeAtNavigationTests|FullyQualifiedName~InExpressionNavigationTests|FullyQualifiedName~RefactorServiceTests|FullyQualifiedName~KoineLanguageServiceTests|FullyQualifiedName~SyntaxGraphTests"`
Expected: PASS — behavior is unchanged; these tests lock `NodeAt`/`DefinitionAt`/`DeclaredSymbolAt`/rename.

- [ ] **Step 6: Run the full build + test suite**

Run: `./build.sh`
Expected: build succeeds (no dead-code/unused-using warnings from the deletions) and the entire test suite is green.

- [ ] **Step 7: Commit**

```bash
git add src/Koine.Compiler/Ast/SemanticModel.cs
git commit -m "refactor(ast): route SemanticModel position queries through SyntaxGraph"
```

---

## Self-Review

**1. Spec coverage:**
- `SyntaxGraph` type with parent/children/FullSpan + ref-keyed identity → Task 1 (Step 4). ✓
- Reference-equality (value-equality risk) regression → Task 1 (Step 2, `Parent_uses_reference_identity_not_value_equality`). ✓
- `FullSpan` + O(depth) top-down descent (`FindNode` model) → Task 2 (Step 3). ✓
- FullSpan-nesting / equivalence validated by test → Task 1 (`Parent_span_contains_child_span…`) + Task 2 brute-force oracle over every offset. ✓
- Roslyn-idiomatic API (`Parent`/`ChildNodes`/`Ancestors`/`AncestorsAndSelf`/`FirstAncestorOrSelf`/`FindNode`/`FindNameNode`) → Task 1 + Task 2 + exposed on `SemanticModel` in Task 3 (Step 1). ✓
- Thread-safe lazy build (`ExecutionAndPublication`), emit path pays nothing → Task 3 (Step 1). ✓
- Rewrite the six position methods → Task 3 (Steps 2–4); `DeclaredSymbolAt` unchanged but now delegates transitively. ✓
- `NodeWalker.ChildNodes` made `internal` → Task 1 (Step 1). ✓
- Conflict guard (no `Emit/`/`ModelIndex`/`TypeResolver`/`KoineType` changes; diff confined to `Ast/` + tests) → honored across all tasks. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows complete code. ✓

**3. Type consistency:** `SyntaxGraph` ctor `SyntaxGraph(KoineNode root)` used identically in Tasks 1–3 (tests pass both a hand-built `BinaryExpr` and a `KoineModel`, both `KoineNode`). `FindNode`/`FindNameNode`/`Parent`/`ChildNodes`/`Ancestors`/`AncestorsAndSelf`/`FirstAncestorOrSelf<T>` names match between the graph (Tasks 1–2) and the `SemanticModel` delegations (Task 3). `_fullSpan` half-open `[Start, End)` containment (`offset >= start && offset < end`) is consistent between `Build` and `Descend`. ✓
