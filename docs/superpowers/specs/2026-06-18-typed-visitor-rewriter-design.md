# Typed SyntaxVisitor / SyntaxRewriter (source-generated)

**Date:** 2026-06-18
**Status:** Revised after adversarial review — ready for implementation plan
**Scope:** Commit 2 of a sequenced "Roslyn-shaped architecture" effort (one opportunity per commit)

> **Sequencing note (read first).** Only **Commit 1** (`SyntaxGraph`, merged in #20) exists in the
> tree today. Commits 2/3/4 are delivered **together on one branch (`feat/roslyn-arch-2-3-4`), one
> commit per phase**, in dependency order. This spec therefore depends on Commit 1 only; Commits 3
> and 4 depend on *this* commit (the typed visitor/rewriter). Nothing in this spec assumes 3 or 4
> already exists.

## Context

Koine's AST is already deliberately Roslyn-shaped: immutable value-equality `record` nodes
(`Ast/Nodes.cs`, `Ast/Expressions.cs`) under a base `KoineNode`, a `SemanticModel` façade, a
`Symbol` layer, resolved `KoineType` vs syntactic `TypeRef`, lossless trivia, and — as of Commit 1
— a `SyntaxGraph` "red layer" giving `Parent`/`Ancestors`/`FirstAncestorOrSelf<T>`/`FindNode`
over the immutable tree without mutating it.

The remaining divergences from Roslyn, in the planned order, are: **(this commit) reflection-based
traversal instead of a typed, generated visitor**; symbol-identity binding (Commit 3); and a
lowering / bound-IR layer (Commit 4).

Today **all** structural traversal funnels through one place: `NodeWalker` (`Ast/NodeWalker.cs`),
which enumerates a node's children by **reflecting over its public properties** — any property that
is a `KoineNode`, or an `IEnumerable` that might contain `KoineNode`s, is treated as a child slot.
This is elegant (a new node kind is walked for free) but it is the AST's single largest piece of
**untyped, reflection-encoded structural knowledge**:

- It is the sole production consumer of reflection in the hot path. `SyntaxGraph.Build` calls
  `NodeWalker.ChildNodes` once per node per `SemanticModel`; the LSP rebuilds the model per request
  (`WorkspaceIndex` re-parses every file with no caching).
- It can only *read* the tree. There is no way to *transform* it — no Roslyn-style `CSharpSyntaxRewriter`
  that returns a new tree with some subtrees replaced. Commit 4's lowering pass and the
  refactor/rename engine both want exactly that.
- It has no *typed* dispatch. A consumer that wants "do X for an `EntityDecl`, Y for a `SpecDecl`"
  writes its own `switch` over runtime types, repeatedly, with no compiler check that every node
  kind is handled.

A TypeScript emitter is being built in parallel (`Emit/TypeScript/`). It consumes the same surface
the C# backend does — `SemanticModel.Index` → `ModelIndex` / `TypeResolver` / `KoineType`. **None of
those types are touched by this commit.** Traversal/visitor infrastructure lives entirely in `Ast/`
and is additive, so this commit is conflict-free with the in-flight emitter.

## Goal

Replace reflection-encoded traversal with a **typed, source-generated** visitor/rewriter family,
modeled on how Roslyn generates `CSharpSyntaxVisitor` / `CSharpSyntaxVisitor<TResult>` /
`CSharpSyntaxRewriter` from `Syntax.xml`:

1. `KoineSyntaxVisitor` — `void`-returning typed visitor (one `VisitFoo(FooNode)` per concrete node).
2. `KoineSyntaxVisitor<TResult>` — value-returning typed visitor (folds / queries).
3. `KoineSyntaxRewriter : KoineSyntaxVisitor<KoineNode?>` — returns a rewritten tree, **reference-equal
   to the input where nothing changed** (mandatory, see "Rewriter identity invariant").

The per-node child structure is **read from the record declarations at compile time** by an
incremental C# source generator, so the visitor cannot drift as nodes are added or as child slots
change — adding a node or a child property regenerates the dispatch with no hand edits.

Then **retarget `SyntaxGraph.Build` off `NodeWalker` onto the generated visitor** (the one production
consumer), proving the generated traversal is byte-for-byte equivalent to today's reflection walk.
`NodeWalker` is **retained** as a thin, generator-independent oracle for tests. Everything else
(SemanticTokenProvider, RefactorService, the emitters) is explicitly **deferred** — see Non-goals.

## Problem, concretely

`NodeWalker.ChildNodes` encodes, in reflection, exactly the knowledge a generated visitor needs:

```csharp
foreach (PropertyInfo prop in PropertiesFor(node.GetType()))  // public instance props that *could* hold nodes
{
    object? value = prop.GetValue(node);
    switch (value)
    {
        case KoineNode child: yield return child; break;                 // single child slot
        case IEnumerable seq and not string:                              // list slot
            foreach (var item in seq) if (item is KoineNode n) yield return n;
            break;
    }
}
```

Three child-slot shapes exist in the model, and the generator must reproduce exactly these:

| Slot shape | Example | NodeWalker behavior |
|---|---|---|
| **Single required** child (`T : KoineNode`) | `BinaryExpr.Left : Expr`, `Invariant.Condition : Expr` | yields the child |
| **Single optional** child (`T? where T : KoineNode`) | `Member.Initializer : Expr?`, `CommandDecl.ReturnType : TypeRef?`, `KoineModel.ContextMap : ContextMapNode?`, `AggregateDecl.Repository : RepositoryDecl?`, `StateRule.Guard : Expr?` | yields it when non-null |
| **List** child (`IReadOnlyList<T> where T : KoineNode`) | `ContextNode.Types`, `BinaryExpr`→none, `CallExpr.Args : IReadOnlyList<Expr>`, `EnumDecl.Members` | yields each element |

Crucially, the generator must **exclude** the property shapes that *look* like children but are not:

- `IReadOnlyList<string>` (`ContextNode.ModuleNames`, `ImportDecl.Names`, `ContextRelation.SharedTypes`,
  `StateRule.To`, `RepositoryDecl.Operations` — `IReadOnlyList<string>?`).
- `IReadOnlyList<SyntaxTrivia>` (`KoineNode.LeadingTrivia` / `TrailingTrivia`) — `SyntaxTrivia` is **not**
  a `KoineNode`, so NodeWalker's runtime `item is KoineNode` test already skips them; the generator must
  match by static element type.
- `enum` / `string` / `int?` / `bool` scalar properties (`BinaryExpr.Op`, `TypeDecl.Since`,
  `ContextNode.Version`, `ValueObjectDecl.IsQuantity`, `TypeRef.Qualifier`, etc.).
- The base `KoineNode` slots `Span` / `NameSpan` / `Doc` (scalars; never children).

`SyntaxGraph.Build` calls this once per node, boxing each property value and runtime-type-testing it.
A typed generated visitor turns each node's traversal into straight-line field access with no
reflection and no boxing, and — the real prize — gives us a `Rewriter` the reflection walker can never
provide.

## Critical correctness subtlety: the rewriter identity invariant

`KoineNode` is an immutable value-equality `record`. Commit 1's `SyntaxGraph` keys every map by
**reference identity** (`IdentityComparer`/`RuntimeHelpers.GetHashCode`) precisely because two
structurally-identical nodes (the many `IdentifierExpr("amount")` references in a file) are *value-equal*
and would collide in a value-keyed map.

A rewriter inherits the same hazard, sharpened:

> **A no-op rewrite MUST return the same instance (`ReferenceEquals`), and a node MUST be
> re-allocated (`with { … }`) only when at least one child actually changed (by reference).**

Why it is non-negotiable:

1. **SyntaxGraph validity.** `SemanticModel` caches a `SyntaxGraph` keyed by node *identity*. If a
   rewrite that changed nothing nonetheless allocated fresh records for every node, every cached
   identity key would be stale — `Parent(node)` / `FindNode` would silently return `null` for the new
   tree. Returning the *same* instance for unchanged subtrees keeps an unrelated subtree's identity —
   and therefore any graph built over it — valid.
2. **Cheap structural sharing.** Replacing one leaf in a deep tree must reallocate only the spine from
   that leaf to the root (`O(depth)` new nodes), not the whole tree — exactly Roslyn's behavior. The
   `ReferenceEquals` short-circuit is what delivers this.
3. **`with` preserves the base slots for free.** A `record`'s `with { Left = newLeft }` copies
   `Span`/`NameSpan`/`Doc`/`LeadingTrivia`/`TrailingTrivia` unchanged, so a rewrite preserves trivia and
   spans automatically — no per-node base-slot plumbing in the generator.

The generated `DefaultVisit` for the rewriter therefore computes each child via `Visit`, compares each
result to the original **by reference**, and:
- if every child is reference-equal to the original → returns `node` unchanged;
- otherwise → returns `node with { Slot = rewritten, … }`, rebuilding only changed list elements.

This is the single most important correctness decision in the commit and gets a dedicated regression
test (identity-preservation on a no-op rewrite, and minimal-spine reallocation on a one-node change).

### Rewriter contracts the review flagged as under-specified

**(a) Element comparison in `VisitList` MUST be `ReferenceEquals`, never `==`/`Equals`.** Because
`LetBinding`/`IdentifierExpr`/`LiteralExpr` are value-equality records, a value comparison would treat
a genuinely-rewritten-but-value-equal element as "unchanged" and **wrongly keep the old identity**,
silently defeating the rewrite. `VisitList<T>` therefore: visits each element, compares the result to
the original by `ReferenceEquals`, allocates a new array **only on first change**, and returns the
**same `IReadOnlyList` instance** when every element is reference-identical. This is the Commit-1
`ReferenceEqualityComparer` subtlety in its second incarnation, and it gets a dedicated test: rewrite
one element to a **different instance that is value-equal** to the original and assert the list **and
its spine DID reallocate** (`Assert.NotSame`).

**(b) Null / wrong-type returns into slots — defined contract (not UB).**
- **Required (non-nullable) child slot rewritten to `null`** → the rewriter **throws
  `InvalidOperationException`** naming the node type and slot (no null-forgiving `!` writing `null`
  into a non-null slot, which would produce a structurally-invalid tree that explodes later in
  `SyntaxGraph.Build` or the emitter, far from the cause). The earlier sketch's `Left = left!` is
  replaced by a generated `Required(left, nameof(node.Left))` guard helper.
- **Optional (`T?`) child slot rewritten to `null`** → allowed (that is how an optional child is
  cleared).
- **List element rewritten to `null`** → **throws** in this commit. "Delete this element" / node
  collapse needs a real design (Roslyn handles it specially); it is **deferred**, not silently
  dropped.
- **Wrong runtime type for a slot** (e.g. a rewrite returning a non-`Expr` for `BinaryExpr.Left`) →
  the generated cast `(Expr?)` throws `InvalidCastException` at rewrite time. This is acceptable
  fail-fast behavior and is now **documented** rather than incidental.

## Design

### Decision 1 — source-generated, not hand-written (with a reflection oracle test)

**Chosen: a Roslyn incremental source generator** that reads the `KoineNode` record hierarchy and emits
the three visitor base classes. Rationale, weighed against the alternatives:

| Option | Drift safety | Boilerplate | Verdict |
|---|---|---|---|
| **Hand-written visitors** | A new node silently falls through to `DefaultVisit`; nothing fails. Mitigated only by a separate "every node type is handled" reflection test. | ~70 `VisitFoo` methods × 3 classes, hand-maintained against the records. | Rejected: the boilerplate *is* the drift surface. |
| **Reflection at runtime (status quo, generalized)** | Perfect — reads the live type. | None. | Rejected for the *typed/rewriter* goal: reflection can't give typed `VisitFoo` dispatch or a `with`-based rewriter without per-node reflection-set, and stays in the hot path. |
| **Source generator (chosen)** | A new node/child slot **regenerates** dispatch automatically; if a node is somehow unmodeled, the *generated* `Visit` switch is non-exhaustive and a test catches it. | Zero hand-maintained; the generator is ~one file. | **Chosen.** |

This mirrors Roslyn exactly: Roslyn does **not** hand-write `CSharpSyntaxVisitor`; it generates it from
`Syntax.xml`. Koine has no `Syntax.xml` — **the records *are* the schema** — so the generator reads the
records directly (see Decision 2).

**Belt-and-suspenders oracle.** `NodeWalker` is **kept** (not deleted) as a reflection-based
ground truth that is, by construction, independent of the generator. A test asserts that for every node
in a representative corpus, the generated visitor's enumerated children are reference-identical, in the
same order, to `NodeWalker.ChildNodes`. If the generator ever miscategorizes a slot (e.g. starts
treating `IReadOnlyList<string>` as children, or drops an optional child), this fails loudly. This is
the same role the brute-force oracle played for `FindNode` in Commit 1.

### Decision 2 — how the generator enumerates node types and child slots

There is **no discriminator enum and no marker attribute** on the nodes today, and we add **none** — keeping
`Ast/` free of generator-coupling annotations preserves the target-agnostic, annotation-free model. The
generator discovers the hierarchy purely from the **semantic model of the `Ast/` source**:

1. **Node set.** Find the `INamedTypeSymbol` for `Koine.Compiler.Ast.KoineNode`. Every type in the
   compilation that transitively inherits it is a node. Partition into:
   - **Concrete** nodes (non-`abstract` records) → get a real `VisitFoo`. (~all `sealed record`s.)
   - **Abstract** nodes (`KoineNode`, `Expr`, `TypeDecl`, `CommandStmt`) → get **no** `Visit` method of
     their own; they are dispatch parents only. (Confirmed abstracts: `KoineNode`, `Expr`, `TypeDecl`,
     `CommandStmt`. `Member`/`Param`/etc. are concrete.)
2. **Child slots per node.** For each concrete node, walk its **public instance properties** (including
   inherited ones from `TypeDecl`, but **excluding** the base `KoineNode` scalar slots `Span`/`NameSpan`/
   `Doc`/`LeadingTrivia`/`TrailingTrivia`) and classify each property's *declared* type:
   - property type `IsKoineNode` and **not** nullable → **single required child**;
   - property type `IsKoineNode` and nullable (`T?`) → **single optional child** (`if (x is not null)`);
   - property type is `IReadOnlyList<U>` (or `IEnumerable<U>`) with `U : KoineNode` → **list child**;
   - anything else (scalars, `string`, enums, `IReadOnlyList<string>`,
     `IReadOnlyList<SyntaxTrivia>`) → **not a child**.

   `IsKoineNode(t)` = `t` is or inherits `KoineNode`. This is the *static-type* analogue of NodeWalker's
   runtime `item is KoineNode` filter — and it is **stricter** in the right way: NodeWalker's
   `CanYieldNodes` admits *any* non-string `IEnumerable` and filters elements at runtime, so it correctly
   skips `IReadOnlyList<SyntaxTrivia>` only because `SyntaxTrivia` fails the runtime cast. The generator
   reaches the same answer by checking the element's static type, with no runtime cost.
3. **Child order — defined by the GENERATOR, not by reflection (revised).** The critical review
   correctly flagged that "reproduce `NodeWalker`'s order" is an **unsafe contract**:
   `NodeWalker` enumerates `Type.GetProperties(BindingFlags.Public | Instance)`, whose order the CLR
   leaves **unspecified** — it is metadata-token order, which interleaves *inherited* `TypeDecl`
   slots (`ModulePath`/`Since`/`Deprecated`) with the derived record's primary-ctor params in a
   runtime-defined way. Roslyn's `INamedTypeSymbol.GetMembers()` is *source-declaration* order within
   a type and excludes inherited members unless base types are walked explicitly. Coupling the
   generator to reflection's order would be green on one SDK/runtime and red on the next.

   **Resolution — define a canonical order in the generator and stop depending on reflection's:**
   - The generated child-enumerator emits child slots in this fixed, deterministic order:
     **(a)** inherited child slots from base types, **base-first, then derived** (today this set is
     *empty* — `KoineNode`'s own slots `Span`/`NameSpan`/`Doc`/`LeadingTrivia`/`TrailingTrivia` are
     scalars, and `TypeDecl`/`Expr`/`CommandStmt` declare no child slots — so the rule is currently a
     no-op, but it is **pinned now while free**); then **(b)** the node's own primary-ctor child
     params in **source declaration order**; then **(c)** any body-declared `init` child properties in
     source order (none today).
   - **The oracle test does NOT assert order against reflection.** It asserts the generated enumerator
     yields the **same reference-identity SET** of children as `NodeWalker.ChildNodes` (a `HashSet`
     keyed by `ReferenceEqualityComparer`), plus a **separate** assertion that the generated order is
     the canonical order above. This is sound because `SyntaxGraph` itself is **order-insensitive**:
     `FullSpan` is a span *union* (commutative) and `FindNode` descends by per-child `FullSpan`
     containment, never by sibling index. The only consumer that documents "source order" is
     `ChildNodes()`'s public contract, which this commit redefines to mean the **generator-canonical**
     order above — a deliberate, documented contract, not an accident of reflection.
   - **`init`-only body child properties** are rare (none today — all child slots are primary-ctor
     params); the generator handles them in bucket (c) for forward-safety.

**Drift-on-evolution guarantee.** Because the generator reads the live record set on every build, adding
`record FooDecl(... ) : TypeDecl` or adding a child slot to an existing record **regenerates** `VisitFooDecl`
and the spine dispatch automatically. The only way to add an *un-walked* node is to add a child slot the
generator's classifier doesn't recognize — caught by the oracle test against `NodeWalker`.

### Generated surface (sketch)

The generator emits one file, `KoineSyntaxVisitor.g.cs`, into the `Koine.Compiler.Ast` namespace. Sketch
(showing representative nodes — `BinaryExpr` for required children, `Member` for an optional child,
`ContextNode` for list children):

```csharp
// <auto-generated/>  — emitted by Koine.Compiler.SourceGen.SyntaxVisitorGenerator
namespace Koine.Compiler.Ast;

/// <summary>Typed, void-returning visitor over the KoineNode tree (Roslyn CSharpSyntaxVisitor analogue).</summary>
internal abstract class KoineSyntaxVisitor
{
    // Dispatch is a GENERATED type-switch (NO Accept member on nodes — see "Dispatch" below).
    public virtual void Visit(KoineNode? node)
    {
        switch (node)
        {
            case null: return;
            case BinaryExpr n: VisitBinaryExpr(n); break;
            case Member n:     VisitMember(n);     break;
            // … one case per concrete node, generated …
        }
    }
    public virtual void DefaultVisit(KoineNode node) { }                  // visits children in canonical order

    public virtual void VisitBinaryExpr(BinaryExpr node) => DefaultVisit(node);
    public virtual void VisitMember(Member node)        => DefaultVisit(node);
    public virtual void VisitContextNode(ContextNode node) => DefaultVisit(node);
    // … one VisitXxx per concrete node …
}

/// <summary>Typed, value-returning visitor (folds/queries). Roslyn CSharpSyntaxVisitor&lt;TResult&gt; analogue.</summary>
internal abstract class KoineSyntaxVisitor<TResult>
{
    public virtual TResult? Visit(KoineNode? node) => node is null ? default : node.Accept(this);
    public virtual TResult? DefaultVisit(KoineNode node) => default;

    public virtual TResult? VisitBinaryExpr(BinaryExpr node) => DefaultVisit(node);
    // … one per concrete node …
}

/// <summary>
/// Returns a rewritten tree. Honors the IDENTITY INVARIANT: returns the SAME instance when no child
/// changed; reallocates (`with`) only the spine of changed subtrees. Roslyn CSharpSyntaxRewriter analogue.
/// </summary>
internal abstract class KoineSyntaxRewriter : KoineSyntaxVisitor<KoineNode?>
{
    public override KoineNode? DefaultVisit(KoineNode node) => node;       // overridden per-node below

    public override KoineNode? VisitBinaryExpr(BinaryExpr node)
    {
        var left  = (Expr?)Visit(node.Left);
        var right = (Expr?)Visit(node.Right);
        return ReferenceEquals(left, node.Left) && ReferenceEquals(right, node.Right)
            ? node
            // Required(x, slotName): throws InvalidOperationException if a non-null slot rewrote to null.
            : node with { Left = Required(left, "Left"), Right = Required(right, "Right") };
    }

    public override KoineNode? VisitMember(Member node)
    {
        var init = node.Initializer is null ? null : (Expr?)Visit(node.Initializer);   // optional child
        return ReferenceEquals(init, node.Initializer) ? node : node with { Initializer = init };
    }

    public override KoineNode? VisitContextNode(ContextNode node)
    {
        var types = VisitList(node.Types);     // list child; returns the SAME list if unchanged
        // … one VisitList per list slot …
        return ReferenceEquals(types, node.Types) /* && … */ ? node : node with { Types = types /*, …*/ };
    }

    // Generated helper: rewrites a list, comparing each element to the original by ReferenceEquals
    // (NOT ==/Equals — value-equal records would defeat the rewrite). Returns the SAME IReadOnlyList
    // instance if every element is reference-identical; allocates a new array only on first change.
    // A list element rewritten to null THROWS (element deletion is deferred — see contract (b)).
    private protected IReadOnlyList<T> VisitList<T>(IReadOnlyList<T> list) where T : KoineNode { /* … */ }

    // Generated guard: throws InvalidOperationException if a required (non-nullable) slot rewrote to null.
    private protected static T Required<T>(T? value, string slot) where T : KoineNode
        => value ?? throw new InvalidOperationException($"Rewriter returned null for required slot '{slot}'.");
}
```

**Dispatch via a generated `Accept`.** `Visit(node)` must dispatch to the right `VisitFoo` by the node's
runtime type. Two options:

- a generated `switch (node) { case BinaryExpr b => VisitBinaryExpr(b), … }` inside `Visit`, **or**
- a generated `internal abstract TResult Accept(...)` / `partial void Accept` per node.

**Chosen: a generated type-switch inside `Visit`** (and the typed `Visit<TResult>` and the
`KoineSyntaxChildEnumerator`), **not** an `Accept` method on the nodes. Rationale: adding an `Accept`
method to each record would put *visitor-shaped* (and, once a TypeScript visitor wants the same,
target-leaning) members **into `Ast/` node declarations**, coupling the nodes to the visitor. A switch
in the generated visitor keeps all visitor machinery in the generated file and the nodes pristine. The
switch is generated, so it is always exhaustive over the live node set; a non-exhaustive switch
(impossible by construction, but defended) falls through to `DefaultVisit`.

**Consistency note (resolves a review-flagged contradiction):** there is **NO `node.Accept(...)`
member anywhere**. The `SyntaxGraph.Build` retarget in Decision 3 dispatches through the **same
generated switch** — call it `ChildNodes.Of(node)` (a static facade over the generated
`KoineSyntaxChildEnumerator`'s switch). Any earlier prose reading `node.Accept(_childEnumerator)` is
shorthand for "the generated dispatch switch"; the implementable form is `ChildNodes.Of(node)`.

### Decision 3 — what is retargeted now vs deferred

**Retargeted in THIS commit (the one production traversal):**

- **`SyntaxGraph.Build`.** Replace `NodeWalker.ChildNodes(node)` with a generated *child-enumerator*. The
  cleanest, lowest-risk shape is a tiny generated `KoineSyntaxChildEnumerator` (a
  `KoineSyntaxVisitor<IEnumerable<KoineNode>>` whose every `VisitFoo` yields that node's children in source
  order) — i.e. the typed equivalent of `NodeWalker.ChildNodes`, so `SyntaxGraph.Build` changes one line:
  `NodeWalker.ChildNodes(node)` → `ChildNodes.Of(node)` (the static facade over the generated
  enumerator's dispatch switch — **no `Accept` member exists**, see Decision 2). This proves
  the generated structural knowledge is correct on the existing hot path, under the existing
  `SyntaxGraphTests` equivalence/oracle suite, **without** changing any observable behavior.

**Deferred (explicitly out of scope), with reasons:**

- **`SemanticTokenProvider`** does **not** use `NodeWalker` at all — it lexes for identifier tokens and
  classifies them against `ModelIndex`. Migrating it to a visitor is a *behavioral* rewrite (token-based →
  node-based highlighting) and touches `ModelIndex`-adjacent code; out of scope and unnecessary.
- **`NodeWalker.Descendants`** stays (still used by tests as the oracle and by `SyntaxGraphTests`). It can
  later be reimplemented on the visitor, but keeping it reflection-based preserves its value as an
  *independent* ground truth for the generated walker. Removing it would remove the oracle.
- **RefactorService / rename / lowering rewrites.** The whole *point* of shipping the `Rewriter` now is to
  unlock these, but **no consumer is migrated onto it in this commit** — we ship the base classes + the
  one `SyntaxGraph` retarget + tests. Commit 4 (lowering) is the first real `Rewriter` consumer.

Keeping the consumer surface to exactly one (`SyntaxGraph.Build`) keeps the diff bounded and the
equivalence provable, matching Commit 1's discipline.

### Decision 4 — where the generated code lives, project & build wiring

**A new project, `src/Koine.Compiler.SourceGen/Koine.Compiler.SourceGen.csproj`**, a Roslyn incremental
source generator (`netstandard2.0`, `Microsoft.CodeAnalysis.CSharp` analyzer-style), referenced by
`Koine.Compiler` as an **analyzer**:

```xml
<!-- Koine.Compiler.SourceGen.csproj -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.0</TargetFramework>   <!-- required for analyzers/source generators -->
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <LangVersion>latest</LangVersion>
    <IsRoslynComponent>true</IsRoslynComponent>
    <EnforceExtendedAnalyzerRules>true</EnforceExtendedAnalyzerRules>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="4.*" PrivateAssets="all" />
  </ItemGroup>
</Project>
```

```xml
<!-- Koine.Compiler.csproj — additive ItemGroup -->
<ItemGroup>
  <ProjectReference Include="..\Koine.Compiler.SourceGen\Koine.Compiler.SourceGen.csproj"
                    OutputItemType="Analyzer" ReferenceOutputAssembly="false" />
</ItemGroup>
```

Decisions and constraints:

- **`netstandard2.0`** is mandatory for a source generator loaded into the compiler host; this is the one
  project in the repo not on `net10.0`. `Directory.Build.props` applies `Nullable`/`ImplicitUsings`/
  `LangVersion latest`/`Deterministic` to it harmlessly (it does **not** set `TargetFramework`, so no
  conflict). The generator project takes **no** `net10.0`-only dependency.
- **`OutputItemType="Analyzer" ReferenceOutputAssembly="false"`** wires it as a generator without leaking the
  generator assembly into `Koine.Compiler`'s references — the standard pattern.
- **ANTLR is undisturbed.** `Antlr4BuildTasks` generates the lexer/parser into `Grammar/gen/` via its own MSBuild
  targets; the source generator is an orthogonal analyzer with no ordering coupling. The generator reads only
  the hand-written `Ast/` records (it doesn't need, and won't read, generated ANTLR types — those aren't
  `KoineNode`s).
- **`InternalsVisibleTo`.** The generated visitor classes are emitted as `internal` in the
  `Koine.Compiler.Ast` namespace **inside the `Koine.Compiler` compilation** (a source generator's output is
  compiled *as part of the referencing project*). So they are automatically visible to the test project and
  the CLI via the **existing** `InternalsVisibleTo("Koine.Compiler.Tests")` / `("Koine.Cli")` — no new
  `InternalsVisibleTo` is required.
- **Solution wiring.** Add `Koine.Compiler.SourceGen` to `Koine.slnx` under `/src/` so it builds in CI and
  `./build.sh`. The generator has **no test project of its own in this commit** — it is exercised end-to-end
  by `Koine.Compiler.Tests` (the generated visitor is referenced and run there). A dedicated generator-snapshot
  test project is a possible follow-up but is not needed to prove correctness here (the oracle test does).

### Laziness, threading, performance

- The generated child-enumerator is **stateless** and allocation-light; `SyntaxGraph` can hold a single
  shared static instance (or call a static `ChildNodes.Of(node)`), so wiring it costs nothing beyond the one
  call-site change. The graph is still built lazily per `SemanticModel` (Commit 1), so the emit path still
  pays nothing.
- Replacing reflection+boxing with a typed switch removes reflection from the one production traversal,
  but **performance is an explicit non-goal** — the real LSP cost is `WorkspaceIndex` re-parsing every
  file with no caching, which this commit does not address. No benchmark is claimed; correctness and
  typedness are the goal.
- `NodeWalker`'s static reflection cache and lock are retained as-is (still used by `Descendants`/tests).

### Generator must FAIL CLOSED (review-flagged trap)

Source generators classically **fail open**: if the generator cannot resolve `KoineNode` (a build-order
quirk, a renamed namespace) it would emit empty/zero-node visitors, every walk would return no children,
and `SyntaxGraph` would silently become a no-op — with a **green-ish build**. To prevent this:

- If the generator finds **zero concrete `KoineNode` subtypes**, it **emits a `Diagnostic` (error
  severity)** rather than empty visitors, failing the build with a clear message.
- A test asserts the generated visitor handles a **known-present** node (e.g. `BinaryExpr`) so a
  silently-empty generation is caught even if the diagnostic path regresses.

## Files

- **New:** `src/Koine.Compiler.SourceGen/Koine.Compiler.SourceGen.csproj` — incremental generator project
  (`netstandard2.0`, `IsRoslynComponent`).
- **New:** `src/Koine.Compiler.SourceGen/SyntaxVisitorGenerator.cs` — the `IIncrementalGenerator`: discovers
  the `KoineNode` hierarchy and child slots from the `Ast/` semantic model and emits
  `KoineSyntaxVisitor` / `KoineSyntaxVisitor<TResult>` / `KoineSyntaxRewriter` / `KoineSyntaxChildEnumerator`
  (+ the `Visit` dispatch switch and `VisitList` helper).
- **New (generated, not committed):** `KoineSyntaxVisitor.g.cs` — emitted into `Koine.Compiler` at build.
- **Modify:** `src/Koine.Compiler/Koine.Compiler.csproj` — add the analyzer `ProjectReference`
  (`OutputItemType="Analyzer" ReferenceOutputAssembly="false"`).
- **Modify:** `src/Koine.Compiler/Ast/SyntaxGraph.cs` — `Build` enumerates children via the generated
  child-enumerator instead of `NodeWalker.ChildNodes` (one call site).
- **Modify:** `Koine.slnx` — add the generator project under `/src/`.
- **Unchanged, intentionally retained:** `src/Koine.Compiler/Ast/NodeWalker.cs` (reflection oracle for tests;
  `ChildNodes` stays `internal`, `Descendants` stays).
- **New:** `tests/Koine.Compiler.Tests/SyntaxVisitorTests.cs` — visitor/rewriter behavior + the
  oracle-equivalence test.

## Testing

Match the stack (xUnit v2 plain asserts; Verify only where a snapshot adds value; the existing
`SyntaxGraphTests` is a regression oracle for the retarget).

1. **Oracle equivalence — SET, not ordered (revised).** For a representative corpus (the example `.koi`
   models + a hand-built tree with every slot shape), assert the generated child-enumerator yields the
   **same reference-identity SET** of children as `NodeWalker.ChildNodes` for every node — compared via a
   `HashSet<KoineNode>(ReferenceEqualityComparer.Instance)`, **not** as an ordered sequence (reflection
   order is unspecified — see Decision 2 §3). A **separate** assertion pins the generated order to the
   **generator-canonical** order. This guards the single/optional/list/excluded-slot classification
   (`IReadOnlyList<string>` / `SyntaxTrivia` must stay excluded; optional children appear iff non-null)
   without coupling the test to runtime reflection order.
2. **Rewriter identity invariant (the critical subtlety).**
   - A no-op rewriter (overrides nothing) over a parsed model returns the **same** root instance
     (`Assert.Same`), and every descendant is reference-identical (walk both trees in lockstep).
   - A rewriter that replaces exactly one leaf (e.g. one `LiteralExpr`) returns a new root, but **only the
     spine** from that leaf to the root is reallocated — every off-spine sibling subtree is `Assert.Same` to
     the original. Proves `O(depth)` structural sharing and that unchanged subtrees keep their identity (so a
     `SyntaxGraph` over them stays valid).
3. **VisitList value-equality trap.** Rewrite one list element to a **different instance that is value-equal**
   to the original; assert the list **and** the leaf→root spine **DID reallocate** (`Assert.NotSame`). Pins
   the `ReferenceEquals`-element rule against the records' value equality.
4. **Rewriter null/type contract.** A rewriter returning `null` for a **required** slot throws
   `InvalidOperationException` (named slot); returning `null` for an **optional** slot clears it (no throw);
   returning `null` for a **list element** throws. A rewrite returning a wrong-typed node for a slot throws
   `InvalidCastException`.
5. **Round-trip through the real pipeline.** Run a parsed model through a **no-op rewriter**, then re-run
   **validate + emit** on the result and assert it produces byte-identical diagnostics and emitted C# — the
   rewriter ships with no production consumer until Commit 4, so this is its only end-to-end exercise on a
   real model (a green build alone does **not** exercise it).
6. **Typed dispatch.** A `KoineSyntaxVisitor<int>` that counts `IdentifierExpr` nodes via an overridden
   `VisitIdentifierExpr` returns the same count as `NodeWalker.Descendants(...).OfType<IdentifierExpr>().Count()`.
7. **Optional / list edges.** A `Member` with `Initializer == null` yields no child for that slot; a
   `CallExpr` with empty `Args` yields no children from it; a `KoineModel` with `ContextMap == null` skips it.
8. **Generator fail-closed.** The generated visitor handles a known-present node (`BinaryExpr`); a
   zero-node generation would be caught (defends against silent fail-open).
9. **SyntaxGraph parity (regression).** The full existing `SyntaxGraphTests` (FindNode brute-force oracle,
   parent identity, FullSpan nesting) stays green **after** `Build` is retargeted — the end-to-end proof the
   generated traversal equals the reflection one on the real hot path.
10. **Whole suite + generator build gate.** `./build.sh` (~500 tests) is green **and the new
    `Koine.Compiler.SourceGen` project builds under it** (explicit acceptance gate, not an assumption) —
    proving emitted C# still compiles/runs and the generator coexists with `Directory.Build.props`
    (`Nullable`/`ImplicitUsings`/`LangVersion latest`/`Deterministic`, `netstandard2.0`, no net10-only BCL).

## Non-goals (guard rails)

- **No `Emit/`, `ModelIndex`, `TypeResolver`, or `KoineType` changes** — preserves zero conflict with the
  in-flight TypeScript emitter. The diff is confined to the new generator project, `Ast/SyntaxGraph.cs` (one
  line), the two `.csproj`/`.slnx` wirings, and tests.
- **No consumer migrated onto the `Rewriter`** in this commit (RefactorService/rename/lowering). The rewriter
  is shipped and tested but first *used* by Commit 4 (lowering).
- **No marker attribute or discriminator added to `Ast/` nodes** — the generator reads the record hierarchy
  directly; nodes stay annotation-free and target-agnostic.
- **No `Accept` member added to `KoineNode`/records** — dispatch is a generated switch in the visitor; the
  node declarations stay pristine.
- **`NodeWalker` is NOT deleted** — it is retained deliberately as the generator-independent reflection oracle.
- **`SemanticTokenProvider` not retargeted** (it doesn't use NodeWalker; node-based highlighting is a separate,
  behavioral change).
- **No symbol-identity binding, no bound-IR/lowering** — those are Commits 3 and 4.
- **AST-purity guard rail (hard boundary).** The generated `KoineSyntaxVisitor`/`KoineSyntaxVisitor<TResult>`/
  `KoineSyntaxRewriter` live in `Koine.Compiler.Ast` and must remain **pure tree-shape machinery** — like
  `NodeWalker`/`SyntaxGraph` already there. **No desugaring, lowering, or any target-specific (C#/TS)
  transform may be added to these classes or anywhere in `Ast/`.** All such logic belongs in the future
  bound-IR layer (Commit 4), which *consumes* the rewriter from outside `Ast/`. A reviewer can grep the
  generated file and the rewriter for any emit/target concept and must find none. The slot-typed casts
  (`(Expr?)`) encode the model's own type structure, not a C# target concept, so they are not a violation.

## What this unlocks

- **Commit 4 (lowering / bound-IR)** gets `KoineSyntaxRewriter` — the desugaring passes (derived-member
  expansion, `let` flattening, guard normalization) are rewriters that return a lowered tree with correct
  structural sharing and preserved spans/trivia, instead of hand-rolled tree copies.
- **Refactor/rename** can move from string-position patching to a typed `KoineSyntaxRewriter` that rewrites the
  exact bound nodes (compounds nicely with Commit 3's symbol identity).
- **The TypeScript emitter** (and any future emitter) *may* adopt the typed `KoineSyntaxVisitor<TResult>` to
  walk the model with compiler-checked, exhaustive dispatch — but this is **available, not forced**: the TS
  emitter currently builds bespoke `switch`-based traversal and is **not** migrated by this commit. Coordinate
  with the TS author so a competing traversal pattern is not entrenched; the visitors are additive and
  target-agnostic in `Ast/`, so no migration churn is imposed.
- **Drift safety becomes structural:** adding a node or a child slot regenerates the visitor; the reflection
  oracle test guarantees the generator's classifier stays honest.
