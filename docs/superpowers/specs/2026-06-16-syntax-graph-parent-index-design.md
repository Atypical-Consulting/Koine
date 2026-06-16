# SyntaxGraph — parent links + position index

**Date:** 2026-06-16
**Status:** Approved design, ready for implementation plan
**Scope:** Commit 1 of a sequenced "Roslyn-shaped architecture" effort (one opportunity per commit)

## Context

Koine's AST is already deliberately Roslyn-shaped: immutable `record` nodes (`Ast/Nodes.cs`),
a `SemanticModel` façade over the syntax tree, a `Symbol` layer, resolved `KoineType` vs
syntactic `TypeRef`, an `ErrorType` sentinel, and lossless trivia. The largest remaining
divergences from Roslyn are: no parent pointers / red–green split, reflection-based traversal
instead of a typed generated visitor, string-based symbol resolution, and no lowering/bound-IR
layer between AST and emitter.

A TypeScript emitter is being built in parallel (`Emit/TypeScript/`). It consumes the same
surface the C# backend does — `SemanticModel.Index` → `ModelIndex` / `TypeResolver` / `KoineType`.
Therefore any change touching `ModelIndex`, `TypeResolver`, `KoineType`, or `Emit/` would
conflict with the in-flight work.

The **position/navigation** surface (`NodeAt`, `DefinitionAt`, `DeclaredSymbolAt`,
`DeclarationNameAt`, `NodeWalker`) is consumed **only** by `Services/` (WorkspaceIndex,
KoineLanguageService) and the LSP server — never by `Emit/`. That disjointness makes it the
correct first commit: high value, easy, zero conflict with the TypeScript emitter.

## Goal

Give `SemanticModel` a **build-once, query-many** node graph providing:

1. Upward navigation — `Parent` / `Ancestors` / `AncestorOfType<T>` (Roslyn's "red layer"
   capability, achieved without mutating the immutable records).
2. Innermost-node-at-offset lookup.

Then rewrite the six position methods to delegate to it, eliminating repeated full-tree
reflection walks.

## Problem, concretely

Per cursor query today:

- `NodeAt` → 1 full reflection walk (`NodeWalker.Descendants`)
- `DeclarationNameAt` → 1 full walk
- `DeclaredSymbolAt` → `DeclarationNameAt` + `EnclosingFieldedTypeNameAt` *or*
  `EnclosingEnumNameAt` = 2–3 full walks
- `DefinitionAt` → 1 full walk

`WorkspaceIndex` (rename / find-references) calls these **per token across whole files**, so the
LSP performs roughly O(tokens × nodes) reflective property access. The fix: walk the tree **once**
per `SemanticModel`, cache the structure, and answer queries from it.

## Critical correctness subtlety: records use value equality

`KoineNode` is a `record`. A `Dictionary<KoineNode, …>` keyed by a node uses **value equality**,
so two structurally-identical nodes — e.g. the many `IdentifierExpr("amount")` references across
a file, or two identical `LiteralExpr` — would collide to the same key. A naive parent map would
be silently, catastrophically wrong.

**Resolution:** every dictionary in `SyntaxGraph` is constructed with
`ReferenceEqualityComparer.Instance`. This is the single most important correctness decision in
the commit and gets a dedicated regression test.

## Design

### New type: `SyntaxGraph` (`src/Koine.Compiler/Ast/SyntaxGraph.cs`)

Modeled on Roslyn's red layer. Because `KoineNode` is an immutable value-equality `record`, a
mutable `Parent` field would destroy its value semantics, so the parent relation lives in a
**reference-keyed companion table** — the standard equivalent of Roslyn's lazily-materialized red
wrappers for an immutable tree. Position lookup uses Roslyn's `FindNode` model: a `FullSpan` per
node and **top-down descent** (O(depth)), not a flat scan.

```csharp
internal sealed class SyntaxGraph
{
    private readonly Dictionary<KoineNode, KoineNode?> _parent;       // ReferenceEqualityComparer; root → null
    private readonly Dictionary<KoineNode, IReadOnlyList<KoineNode>> _children; // ref-keyed, source order
    private readonly Dictionary<KoineNode, SourceSpan> _fullSpan;     // ref-keyed bounding span (node + all descendants)

    public SyntaxGraph(KoineModel root);                             // one DFS: parent + children + FullSpan

    // Roslyn-idiomatic navigation API
    public KoineNode? Parent(KoineNode node);
    public IReadOnlyList<KoineNode> ChildNodes(KoineNode node);
    public IEnumerable<KoineNode> Ancestors(KoineNode node);          // parent chain, nearest-first
    public IEnumerable<KoineNode> AncestorsAndSelf(KoineNode node);
    public T? FirstAncestorOrSelf<T>(KoineNode node) where T : KoineNode;

    public KoineNode? FindNode(int offset);                          // innermost real-Span node, via FullSpan descent
    public KoineNode? FindNameNode(int offset);                      // innermost NameSpan node containing offset
}
```

- **One DFS** builds parent, child-order, and `FullSpan` maps. Reuses `NodeWalker`'s child
  enumeration: refactor `NodeWalker.ChildNodes` from `private` to `internal static`; `Descendants`
  stays.
- **`FullSpan` (post-order):** `node.FullSpan = bound(node.Span, ⋃ child.FullSpan)`. Covers the
  node and every descendant, so a `Span.None` container (`KoineModel`, `ContextMapNode`) is
  transparent for its own width yet still routes descent into its positioned descendants.
- **`FindNode(offset)` = top-down descent:** start at root; among children pick the one whose
  `FullSpan` contains the offset and recurse; return the innermost node whose **own** `Span`
  (real, `Length > 0`) contains the offset. **O(depth)**, the Roslyn model — not a linear scan,
  not a global interval tree.
- **Tie-break preserved:** when sibling real spans don't overlap (the validated invariant below),
  descent yields exactly today's "smallest `Span` containing offset, first in pre-order".
- **Parent/children maps include every node** regardless of span, so ancestor walks pass through
  `Span.None` containers. Root maps to `null`.

### Rewriting the six `SemanticModel` methods (behavior identical)

| Method | New implementation |
|---|---|
| `NodeAt(off)` | `_graph.FindNode(off)` |
| `DeclarationNameAt(off)` | `_graph.FindNameNode(off)` |
| `EnclosingFieldedTypeNameAt(off)` | `FindNode(off)` → `FirstAncestorOrSelf` first `ValueObjectDecl`/`EntityDecl`/`EventDecl`/`IntegrationEventDecl`, return its `Name` |
| `EnclosingEnumNameAt(off)` | same, first `EnumDecl`, return its `Name` |
| `DefinitionAt(off)` | innermost name-bearing node (`IdentifierExpr`/`TypeRef`) at off; enclosing scope via `AncestorsAndSelf` (first fielded type, or `SpecDecl.TargetType`); then `GetSymbol(name, enclosingType)` |
| `DeclaredSymbolAt(off)` | unchanged switch; uses graph for name-node + ancestors for owner/enum |

**Equivalence argument:** the innermost node containing an offset has, as its ancestor chain,
exactly the lexically-enclosing nodes. Today's `Enclosing*` methods pick the smallest-span
*enclosing* declaration via a full scan; the nearest matching ancestor of the innermost node
yields the identical node. `DefinitionAt`'s current pre-order "last write wins" for the enclosing
type is equal to "nearest ancestor". Results are therefore byte-identical, and the existing R17
navigation/rename suite is the equivalence oracle.

### Laziness & lifecycle

The graph is built **lazily** on first position query, via
`Lazy<SyntaxGraph>(LazyThreadSafetyMode.ExecutionAndPublication)`, so the **emit path pays
nothing** — the emitters go through `SemanticModel.Index` and never touch positions — and a
cached/shared `SemanticModel` cannot race the build under concurrent LSP requests (Roslyn
materializes its red nodes thread-safely for the same reason). `NodeWalker` keeps its own static
reflection-cache lock.

### Public API surface (Roslyn vocabulary)

Exposed via `SemanticModel` as the red-layer API the next commits build on (the typed rewriter,
Commit 2; symbol-identity binding, Commit 3 — both need cheap upward navigation): `Parent`,
`ChildNodes`, `Ancestors`, `AncestorsAndSelf`, `FirstAncestorOrSelf<T>`, `FindNode`,
`FindNameNode`. Names mirror Roslyn so anyone Roslyn-literate (including the Rider-plugin work)
reads them instantly.

## Files

- **New:** `src/Koine.Compiler/Ast/SyntaxGraph.cs`
- **Modify:** `src/Koine.Compiler/Ast/SemanticModel.cs` — add the thread-safe lazy `_graph` field
  + public red-layer API (`Parent`/`ChildNodes`/`Ancestors`/`AncestorsAndSelf`/
  `FirstAncestorOrSelf`/`FindNode`/`FindNameNode`); rewrite the six position methods to delegate.
- **Modify:** `src/Koine.Compiler/Ast/NodeWalker.cs` — expose `ChildNodes` as `internal static`.
- **New:** `tests/Koine.Compiler.Tests/SyntaxGraphTests.cs`

## Testing

- **Safety net:** full existing suite green — this is a pure refactor of observable behavior
  (`./build.sh`).
- **New `SyntaxGraphTests.cs`:**
  1. **Reference-equality regression** (the value-equality risk): a model with repeated
     `IdentifierExpr("x")` / identical literals → each occurrence resolves to its own distinct
     parent. Fails loudly if the comparer is ever dropped.
  2. **`FullSpan` nesting invariant** (makes descent provably correct): across a representative
     corpus, every node's `FullSpan ⊆ parent.FullSpan`, and sibling real `Span`s do not overlap.
     A failure is a real malformed-span bug, surfaced here rather than as silent mis-navigation.
  3. Parent/ancestor invariants: `Ancestors` are nearest-first and all contain the node; root
     parent is null; `AncestorsAndSelf` starts with the node.
  4. `FindNode` / `FindNameNode` match the previous walk-based results across the corpus
     (equivalence oracle for the rewrite).
  5. Enclosing-scope resolution for nested aggregate → entity → command bodies.

## Non-goals (guard rails)

- No `Emit/` changes; no `ModelIndex` / `TypeResolver` / `KoineType` changes (avoids conflict
  with the in-flight TypeScript emitter).
- No incremental/red-green reuse; no global interval tree (FullSpan descent is used instead); no
  typed rewriter (those are later commits).
- The entire diff stays inside `Ast/` + tests.

## What this unlocks

The Roslyn-idiomatic red-layer API (`Parent`/`Ancestors`/`FirstAncestorOrSelf`/`FindNode`/…)
becomes the foundation for subsequent commits (typed visitor/rewriter; symbol-identity binding).
The LSP/refactor hot paths drop from per-query full-tree reflection walks to O(depth) descent
immediately.
