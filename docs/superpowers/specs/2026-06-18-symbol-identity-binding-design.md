# Symbol-identity binding (a real binder + binding table)

**Date:** 2026-06-18
**Status:** Revised after adversarial review — ready for implementation plan
**Scope:** Commit 3 of a sequenced "Roslyn-shaped architecture" effort (one opportunity per commit)

> **Sequencing note (read first — this was a blocking review finding).** Only **Commit 1**
> (`SyntaxGraph`, merged in #20) exists in the tree today. **Commit 2 (the typed
> `KoineSyntaxVisitor`/`KoineSyntaxVisitor<TResult>`/`KoineSyntaxRewriter` family) does NOT yet
> exist** — `grep KoineSyntaxVisitor` returns nothing. This commit **hard-depends on Commit 2** and
> is delivered **after it, on the same branch (`feat/roslyn-arch-2-3-4`)**: the `Binder` subclasses
> the Commit-2 `KoineSyntaxVisitor`. Until that phase merges, "the Commit-2 visitor" below is a
> *dependency on the immediately-preceding phase of this same PR*, not an already-shipped artifact.
> (Fallback if Commit 2 slips: the binder can be a hand-rolled recursive descent over
> `ContextNode→TypeDecl→Member/CommandDecl/SpecDecl`, reusing the existing `ExprWalker` for the Expr
> body sublanguage — the scope-stack push/pop maps naturally onto explicit recursion. The plan keeps
> the visitor dependency because Commit 2 lands first in the same branch.)

## Context

Koine's AST is already deliberately Roslyn-shaped: immutable value-equality `record` nodes
(`Ast/Nodes.cs`, `Ast/Expressions.cs`) under a base `KoineNode`, a `SemanticModel` façade, resolved
`KoineType` vs syntactic `TypeRef` with an `ErrorType` sentinel, lossless trivia, and — as of the
prior phases on this branch — a `SyntaxGraph` "red layer" (Commit 1: `Parent`/`Ancestors`/
`FirstAncestorOrSelf<T>`/`FindNode` over the immutable tree) and a typed, source-generated
`KoineSyntaxVisitor` / `KoineSyntaxVisitor<TResult>` / `KoineSyntaxRewriter` family (Commit 2, the
preceding phase).

The remaining divergences from Roslyn, in the planned order, are: **(this commit) string-based symbol
resolution instead of resolved symbol identity**; and a lowering / bound-IR layer (Commit 4).

Today there is a `Symbol` layer (`Ast/Symbols.cs`: `Symbol`/`TypeSymbol`/`MemberSymbol`/
`EnumMemberSymbol`/`SpecSymbol`/`IdValueObjectSymbol`), but it is **not** an identity layer. Each
`Symbol` is a lightweight, navigation-shaped data carrier (`Name`, `DeclSpan`, `Doc`, `Kind`) that is
**freshly allocated on every query** by `SemanticModel.GetSymbol(name, enclosingType)` —
`new TypeSymbol(...)`, `new MemberSymbol(...)` — and compared structurally (`DeclSpan == DeclSpan`,
`OwnerType == OwnerType`) by its consumers. There is:

- **No one-symbol-per-declaration identity.** Two `GetSymbol("Money")` calls return two different
  `TypeSymbol` instances; `ReferenceEquals` is meaningless, so `WorkspaceIndex` compares `DeclSpan`
  fields by value to decide "same declaration" (`m.DeclSpan == member.DeclSpan`,
  `em.DeclSpan == target.DeclSpan`). That works but is fragile and re-does resolution per token.
- **No reference → symbol binding table.** Nothing maps a *reference-bearing syntax node*
  (`IdentifierExpr`, `TypeRef`, `MemberAccessExpr` selector) to the declaration it resolves to.
  `SemanticModel.DefinitionAt(offset)` re-derives the answer from scratch each call: `FindNode`, then
  walk ancestors to find the enclosing type, then `GetSymbol(name, enclosingType)` — a fresh
  string-keyed `ModelIndex` lookup per query. The LSP calls this **per identifier token across whole
  files** (`WorkspaceIndex.FindReferences`/`EnumMemberReferences`), so resolution is repeated
  O(tokens) times.
- **No containment model.** A `Symbol` does not know its container (the type that declares a member,
  the context that declares a type). `MemberSymbol` carries `OwnerType` as a *string*; cross-context
  name sharing (R13.2 — two `Money` types) is disambiguated only by re-resolving in a context-scoped
  `ModelIndex` lookup at each site.

A TypeScript emitter is being built in parallel (`Emit/TypeScript/`). It consumes the resolution
surface the C# backend does — `SemanticModel.Index` → `ModelIndex` / `TypeResolver` / `KoineType`.
**This commit touches none of those types.** The binder is **additive: it sits *on top of*
`ModelIndex`**, reusing every existing resolution rule (R13.2 cross-context, the `*Id` convention,
enum-member ownership, specs) rather than reimplementing or replacing them. `ModelIndex`,
`TypeResolver`, `KoineType`, and `Emit/` are unchanged, so the commit is conflict-free with the
in-flight emitter.

## Goal

Introduce a **real binder** that assigns stable **symbol identity** — exactly one `Symbol` object per
declaration — and a **binding table** mapping every reference-bearing syntax node to the `Symbol` it
resolves to, plus an `ErrorSymbol` sentinel (mirroring `ErrorType`) for unresolved references.

1. **`SymbolTable`** — built once per `SemanticModel` from the `KoineModel`: one `Symbol` per
   declaration (`TypeDecl`, `Member`, `EnumMember`, `SpecDecl`, synthesized ID value objects, plus
   the new container/binding-scope symbols), with **containment** (`ContainingSymbol`) and **reference
   identity** (the same instance is returned for the same declaration everywhere).
2. **`Binder`** — walks the tree with the **Commit-2 `KoineSyntaxVisitor`**, and for each
   reference-bearing node (`IdentifierExpr`, `TypeRef`, `MemberAccessExpr` selector, `CallExpr`
   method, `SpecDecl.TargetType`, `*Id`/enum-member references) records `node → Symbol` in a
   **reference-keyed** `BindingTable` (identity comparer, mirroring `SyntaxGraph`).
3. **`SemanticModel.GetSymbolInfo(node)`** — the Roslyn-named façade entry point returning the bound
   `Symbol` for a reference node (or `ErrorSymbol` when unresolved), and
   **`GetDeclaredSymbol(node)`** returning the identity `Symbol` for a *declaration* node.

The existing string-keyed `GetSymbol`/`DefinitionAt`/`DeclaredSymbolAt`/`GetSymbol(name, enclosingType)`
methods are **retained as thin shims** that now hand back the *interned* identity symbols from the
table, so the LSP / `WorkspaceIndex` / `RefactorService` callers keep working **unchanged** while
silently gaining identity (`ReferenceEquals` becomes meaningful). No caller is rewritten in this
commit; the symbol-identity comparisons they could simplify to are noted as "what this unlocks", not
done here.

## Problem, concretely

`WorkspaceIndex.MemberReferences` resolves, **per token**, the member under each candidate and keeps
it only when its **value-compared** identity matches the target:

```csharp
sema.DefinitionAt(tokOffset) is MemberSymbol m
    && string.Equals(m.OwnerType, member.OwnerType, StringComparison.Ordinal)
    && m.DeclSpan == member.DeclSpan      // value comparison standing in for identity
```

`EnumMemberReferences` does the same with `em.DeclSpan == target.DeclSpan`. Each `DefinitionAt`
re-runs `FindNode` + ancestor walk + a fresh `ModelIndex` string lookup and allocates a brand-new
`Symbol`. With real identity, the same comparison is `ReferenceEquals(bound, target)` against a table
populated **once**. This commit *creates* that table and that identity; it deliberately does **not**
rewrite the callers to use `ReferenceEquals` (that is a follow-up that changes observable call sites).

The reference-bearing node kinds the binder must classify (read off the live model, all
target-agnostic):

| Reference node | Today's resolution path | Binds to |
|---|---|---|
| `TypeRef.Name` (a field/param/return/payload type) | `ModelIndex.Classify` + R13.2 `ResolveReference` | `TypeSymbol` / `IdValueObjectSymbol` / `null` (primitive/collection) |
| `IdentifierExpr` (in an invariant/command/factory/spec body) | `GetSymbol(name, enclosingType)`: member-of-enclosing-type → else enum member / spec / id | `MemberSymbol` / `ParameterSymbol` / `LocalSymbol` (let) / `LambdaParameterSymbol` / `EnumMemberSymbol` / `ErrorSymbol` |
| `MemberAccessExpr.MemberName` selector (`order.total`) | not resolved today (out of scope in `WorkspaceIndex`) | `MemberSymbol` when the receiver type is known, else `ErrorSymbol` |
| `CallExpr.Method` (`code.startsWith(..)`) | built-in op set; not a declaration | not bound (built-in, see Non-goals) |
| `SpecDecl.TargetType` (string on the decl) | `ModelIndex` type lookup | `TypeSymbol` of the target |
| Qualified enum ref `EnumType.Member` | `TypeResolver` member-access special case | `EnumMemberSymbol` |

## Critical correctness subtlety: identity over value-equality records (again)

This is the same hazard called out in Commits 1 and 2, in its third incarnation. `KoineNode` is a
value-equality `record`: the many `IdentifierExpr("amount")` reference nodes in a file are all
**value-equal**. A `BindingTable` keyed by syntax node **must** use `ReferenceEqualityComparer`
(`IdentityComparer`, `RuntimeHelpers.GetHashCode`) — exactly as `SyntaxGraph` does — or every
same-named reference would collide to one binding and the table would be silently, catastrophically
wrong. This gets a dedicated regression test (repeated `IdentifierExpr("amount")` in two different
types bind to two different `MemberSymbol`s).

There is a **second, new** identity hazard unique to this commit: the *symbols themselves* must be
**interned** — one instance per declaration, reused for every reference. The binder builds each
declaration's `Symbol` once into the `SymbolTable` and the `BindingTable` stores **references** to
those interned symbols. A binder that allocated a fresh `Symbol` per *reference* would defeat the
entire purpose (identity would again be meaningless). The interning invariant —
`GetDeclaredSymbol(decl)` returns the same instance every call, and every `GetSymbolInfo(ref)` to that
declaration returns that *same* instance — is the second dedicated regression test.

### Critical scope limitation: identity is **per-`SemanticModel`**, NOT cross-document (review-flagged)

The adversarial review correctly flagged that the headline "callers can switch from `DeclSpan ==` to
`ReferenceEquals`" is **false for the multi-document LSP path**, and the original spec over-promised it.
Interning is **per `SemanticModel`** (one `Lazy<(SymbolTable, BindingTable)>` per model).
`WorkspaceIndex` holds **one `SemanticModel` per URI** (`_byUri`); `FindReferences` /
`MemberReferences` / `EnumMemberReferences` derive the `target` from the *active* document's
`SemanticModel`, then iterate **every other file**, resolving matches in *that file's own*
`SemanticModel`. Two different `SemanticModel`s intern **two different `Symbol` instances** for the
"same" declaration, so `ReferenceEquals(GetSymbolInfo(node), target)` is **`false` across files**.

The `DeclSpan ==` (value) comparison `WorkspaceIndex` uses today is value-based **precisely because it
must survive across `SemanticModel` boundaries**, and it must **stay** value-based. Therefore:

- **In-document** identity (`ReferenceEquals` within one `SemanticModel`): **delivered** by this commit.
- **Cross-document** identity: **explicit NON-GOAL.** True cross-document symbol identity needs a
  **workspace-level binder** (one symbol table spanning all files) — a much larger commit, out of scope.
  Until then, cross-file rename/find-references **must keep** `DeclSpan`-value comparison.

This limitation is stated as a **hard non-goal** below; the "what this unlocks" section is corrected to
promise only the in-document simplification.

## Design

### Decision 1 — extend the existing `Symbols.cs` hierarchy; do **not** introduce a parallel `ISymbol`

**Chosen: evolve the existing `abstract class Symbol`** rather than introduce a richer parallel
`ISymbol` interface. Rationale, weighed:

| Option | Caller churn | Identity | Verdict |
|---|---|---|---|
| **New `ISymbol` interface + new symbol classes** | Every LSP/RefactorService consumer of `Symbol` must migrate or get adapters. | Clean. | Rejected: large blast radius, conflicts the "bounded, additive" discipline of the prior commits; the existing `Symbol` already has the right shape. |
| **Extend `Symbol`** (chosen) | Zero — existing `TypeSymbol`/`MemberSymbol`/… keep their public surface; consumers untouched. | Achieved by **interning** + a new `ContainingSymbol`. | **Chosen.** |

Concretely:

- `Symbol` gains a `Symbol? ContainingSymbol { get; }` (the Roslyn containment spine). Identity is **by
  reference** (it is a `class`, reference equality is the default — we rely on interning, not on
  overriding equality). Existing fields (`Name`/`DeclSpan`/`Doc`/`Kind`) are unchanged.

  **`ContainingSymbol` mechanism (review-flagged — NOT free).** Adding a constructor parameter would
  force an edit to every subclass constructor **and** every ad-hoc construction site, contradicting
  "consumers untouched". Instead `ContainingSymbol` is an **`init`-only auto-property set by the
  `SymbolTable` builder during interning** (`public Symbol? ContainingSymbol { get; init; }`). This
  keeps every existing constructor and construction site source-compatible. Because containment
  requires the **container to be interned before the contained** (a `MemberSymbol`'s container is its
  `TypeSymbol`), the `SymbolTable` build has an explicit **ordering invariant**:
  **contexts → types → (members, parameters, enum members, id-VOs) → locals/lambda-params**. A symbol's
  `ContainingSymbol` is non-null for everything except a top-level `ContextSymbol` (whose container is
  `null`). A test asserts non-null containment for every non-context interned symbol.

  **Shim construction sites must route through the table (closes the null-container leak).** The legacy
  `MemberOf`/`DeclaredSymbolAt`/`GetSymbol` paths today `new MemberSymbol(...)`/`new TypeSymbol(...)`
  ad hoc; if left as-is those instances would carry a **null/garbage `ContainingSymbol`** and would
  **not** be the interned identity instances. So those construction sites are **re-pointed to return
  the interned symbol from the `SymbolTable`** (found by the declaration node / `(context,name)` key).
  This is the small, deliberate caller touch that makes "shims hand back interned identity symbols"
  actually true — it is **not** "zero edits to `SemanticModel.cs`", and the Files section lists it.

- New symbol kinds are added for the **binding scopes** that string resolution handled implicitly but
  never named:
  - **`ContextSymbol`** (a bounded **context**, e.g. `Billing`) — the container for the types it
    declares; resolves R13.2 name sharing structurally (two `Money` `TypeSymbol`s differ by
    `ContainingSymbol`). **Named `ContextSymbol`, not `NamespaceSymbol`** (review-flagged purity fix):
    the DSL term is *context*, and `ModelIndex` already computes the **C# namespace** separately
    (`NamespaceOf`). Calling this `NamespaceSymbol` would risk a reader/emitter conflating it with C#
    namespace emission and leak target vocabulary into `Ast/`. It models the Koine bounded context
    only — the unit R13.2 resolution disambiguates on — not any C#/TS module path.
  - `ParameterSymbol` (a command/factory/operation/finder/query `Param`) — container is the behavior's
    owning type symbol.
  - `LocalSymbol` (a `let`-binding name) — container is the enclosing member/spec symbol.
  - `LambdaParameterSymbol` (a collection-aggregate lambda parameter) — container is the enclosing
    expression's symbol.
- `SymbolKind` (the enum in `Symbols.cs`) gains `Context`, `Parameter`, `Local`, `LambdaParameter`,
  `Error`. **Additive** — existing arms (`Type`/`Member`/`EnumMember`/`Spec`/`IdValueObject`) are
  unchanged.
- `ErrorSymbol : Symbol` — a singleton sentinel (`ErrorSymbol.Instance`), `Kind == SymbolKind.Error`,
  `DeclSpan == SourceSpan.None`, mirroring `ErrorType.Instance`. `GetSymbolInfo(ref)` returns it (never
  `null`) for an unresolved reference, so the "never-null, explicit error" discipline matches the type
  side. (The legacy `GetSymbol` shim still returns `null` for unknown names — see Decision 4 — so the
  observable behavior of existing callers is unchanged.)

Containment mapping of the DSL's lexical scopes onto symbol containers:

```
ContextSymbol (bounded context)
 └─ TypeSymbol (value object / entity / aggregate / enum / event / read model / query / integration event)
     ├─ MemberSymbol (field)                         ContainingSymbol = the TypeSymbol
     ├─ EnumMemberSymbol (enum member)               ContainingSymbol = the enum TypeSymbol
     ├─ ParameterSymbol (command/factory/finder/query/operation param)
     ├─ IdValueObjectSymbol (synthesized *Id)        ContainingSymbol = the owning entity's TypeSymbol
     └─ (inside a body expression)
         ├─ LocalSymbol (let binding)                ContainingSymbol = the enclosing behavior/spec symbol
         └─ LambdaParameterSymbol                    ContainingSymbol = the enclosing expression symbol
 └─ SpecSymbol (named spec)                          ContainingSymbol = ContextSymbol (or aggregate TypeSymbol for aggregate-scoped specs)
```

Synthesized symbols (no standalone declaration node):

- **ID value objects** keep the existing `IdValueObjectSymbol` shape (it already points at the owning
  `EntityDecl` via `Owner`). The binder interns one per distinct `*Id` name (from `identified by`
  clauses **and** the `^[A-Z]\w*Id$` convention, exactly the set `ModelIndex.IdTypeNames` plus
  convention names), so a `product: ProductId` reference binds to a stable symbol even when no entity
  declares `ProductId` (matching `ModelIndex`'s existing behavior). `DeclSpan` is the owning entity's
  name span when one exists, else `SourceSpan.None`.
- **Enum members** keep `EnumMemberSymbol`; the binder interns one per `(enum, member)` pair.

### Decision 2 — `Binder` walks with the Commit-2 visitor; `BindingTable` is reference-keyed; lives in `Ast/`

**New files in `Ast/` (target-agnostic, alongside `SyntaxGraph`/`ModelIndex`):**

- **`Ast/SymbolTable.cs`** — the interned declaration symbols. Built by the binder; indexed for fast
  declaration→symbol and (context, name)→symbol lookup. Reuses `ModelIndex` for the *rules* (what
  context owns a type, the `*Id` set, enum ownership), but owns the *identity* (one `Symbol` per
  declaration).
- **`Ast/Binder.cs`** — the binder. A `KoineSyntaxVisitor` (Commit 2) subclass that descends the whole
  tree once, maintaining a lexical-scope stack (current context, current type, current
  member/spec/behavior, plus `let`/lambda locals), and for each reference-bearing node records the
  resolved interned `Symbol` into the binding table. Reference *resolution* delegates to
  `ModelIndex`/`SymbolTable` (no new resolution rules — it reproduces `GetSymbol(name, enclosingType)`
  and `ResolveReference` semantics, then *interns and records*).
- **`Ast/BindingTable.cs`** — `Dictionary<KoineNode, Symbol>` with the reference-identity comparer (the
  same discipline as `SyntaxGraph`; the comparer is the single most important correctness decision,
  dedicated test). Exposes `GetSymbolInfo(node) → Symbol` (returns `ErrorSymbol.Instance` when the node
  is reference-bearing but unresolved, or when the node is not a reference node at all — callers ask
  only about reference nodes).

**The reference-identity comparer (review-flagged — it is not a shared type today).** `IdentityComparer`
is currently a `private sealed class` **nested inside `SyntaxGraph`** (`SyntaxGraph.cs`), not a reusable
`Ast/` type — the original sketches referencing `IdentityComparer.Instance` from `BindingTable.cs`/
`SymbolTable.cs` could not compile. Two resolutions, **pick one in the plan**:
- **(preferred)** use the BCL `System.Collections.Generic.ReferenceEqualityComparer.Instance` directly
  for the `Dictionary<KoineNode, …>` keys — no custom type, zero touch to Commit-1 files; **or**
- promote `SyntaxGraph`'s nested `IdentityComparer` to a top-level `internal` `Ast/` type
  (e.g. `Ast/NodeIdentityComparer`) and re-point `SyntaxGraph` at it.

This spec adopts the **BCL `ReferenceEqualityComparer.Instance`** (smallest diff, no Commit-1 file
touch). All `Dictionary<KoineNode, …>` and `Dictionary<<value-equality record>, …>` keys in the binder
use it. The `*ByName`/`*Context` string-keyed dictionaries use ordinal string equality (fine).

Type sketch:

```csharp
// Ast/BindingTable.cs  — TARGET-AGNOSTIC
internal sealed class BindingTable
{
    private readonly Dictionary<KoineNode, Symbol> _bindings = new(ReferenceEqualityComparer.Instance); // ref-keyed!

    internal void Bind(KoineNode reference, Symbol symbol) => _bindings[reference] = symbol;

    /// <summary>The symbol a reference-bearing node resolves to; <see cref="ErrorSymbol.Instance"/> if unbound/unresolved.</summary>
    public Symbol GetSymbolInfo(KoineNode node) =>
        _bindings.TryGetValue(node, out Symbol? s) ? s : ErrorSymbol.Instance;
}

// Ast/SymbolTable.cs — TARGET-AGNOSTIC
internal sealed class SymbolTable
{
    // All node/record keys use BCL ReferenceEqualityComparer.Instance — Member/TypeDecl/EnumMember/
    // SpecDecl are value-equality records, so identity keying is MANDATORY (two structurally-identical
    // Members — e.g. two `id: String` fields with Span.None name spans — would otherwise merge).
    private readonly Dictionary<TypeDecl, TypeSymbol> _types = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<(string Context, string Name), TypeSymbol> _typesByName;   // R13.2 disambig
    private readonly Dictionary<Member, MemberSymbol> _members = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<EnumMember, EnumMemberSymbol> _enumMembers = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<SpecDecl, SpecSymbol> _specs = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<string, IdValueObjectSymbol> _idValueObjects;               // by *Id name
    private readonly Dictionary<string, ContextSymbol> _contexts;

    public SymbolTable(KoineModel model, ModelIndex index) { /* intern one Symbol per declaration */ }

    /// <summary>The single interned symbol for a declaration node (the Roslyn GetDeclaredSymbol target).</summary>
    public Symbol? DeclaredSymbol(KoineNode declaration) => /* dictionary dispatch by declaration kind */;
}

// Ast/Binder.cs — TARGET-AGNOSTIC; walks via the Commit-2 KoineSyntaxVisitor
internal sealed class Binder : KoineSyntaxVisitor
{
    private readonly SymbolTable _symbols;
    private readonly ModelIndex _index;
    private readonly BindingTable _bindings = new();
    private readonly ScopeStack _scope = new();   // context → type → member/spec → let/lambda locals

    public static (SymbolTable, BindingTable) Bind(KoineModel model, ModelIndex index) { … }

    public override void VisitIdentifierExpr(IdentifierExpr node) { _bindings.Bind(node, Resolve(node.Name)); }
    public override void VisitTypeRef(TypeRef node)              { if (Resolve(node) is { } s) _bindings.Bind(node, s); }
    // … VisitMemberAccessExpr (selector), VisitSpecDecl (TargetType), scope-pushing overrides for
    //    VisitValueObjectDecl/VisitEntityDecl/VisitCommandDecl/VisitLetExpr/VisitLambdaExpr/…
}
```

The binder's resolution logic is **a faithful re-expression of the existing string paths**, not new
semantics:

- `IdentifierExpr` resolution reproduces `GetSymbol(name, enclosingType)`: a `let` local or lambda
  parameter in the current scope first; then a field of the enclosing type (→ interned `MemberSymbol`);
  then an unambiguous enum member (→ interned `EnumMemberSymbol`); else `ErrorSymbol`. Built-in nullary
  value ops (`now`, etc., from `BuiltinOps.NullaryValueOps`) bind to **nothing** (not a declaration) —
  they are left unbound and `GetSymbolInfo` returns `ErrorSymbol`, which is correct (they have no
  go-to-definition target), and the legacy shim already returns `null` for them.
- `TypeRef` resolution reproduces `ModelIndex.ResolveReference` + `Classify`: a declared type in the
  current context (→ interned `TypeSymbol`), the `*Id` convention (→ interned `IdValueObjectSymbol`),
  a qualified `Context.T` (→ that context's `TypeSymbol`); primitives/collections bind to **nothing**.

### Decision 3 — `SemanticModel` exposes the binder lazily, thread-safe, mirroring `SyntaxGraph`

`SemanticModel` gains a third lazily-built artifact, with the **same** `LazyThreadSafetyMode.
ExecutionAndPublication` discipline as Commit 1's `_graph`, so the emit path pays nothing (emitters go
through `Index`, never the binder) and a cached/shared `SemanticModel` cannot race the build under
concurrent LSP requests:

```csharp
private readonly Lazy<(SymbolTable Symbols, BindingTable Bindings)> _binding;

public SemanticModel(KoineModel model)
{
    Model = model;
    Index = new ModelIndex(model);
    _graph   = new Lazy<SyntaxGraph>(() => new SyntaxGraph(Model), LazyThreadSafetyMode.ExecutionAndPublication);
    _binding = new Lazy<(SymbolTable, BindingTable)>(
        () => Binder.Bind(Model, Index), LazyThreadSafetyMode.ExecutionAndPublication);
}

/// <summary>The symbol a reference-bearing node resolves to (Roslyn GetSymbolInfo). Never null — an
/// unresolved reference is <see cref="ErrorSymbol.Instance"/>.</summary>
public Symbol GetSymbolInfo(KoineNode node) => _binding.Value.Bindings.GetSymbolInfo(node);

/// <summary>The interned symbol declared by a declaration node (Roslyn GetDeclaredSymbol), or null
/// when the node is not a declaration.</summary>
public Symbol? GetDeclaredSymbol(KoineNode declaration) => _binding.Value.Symbols.DeclaredSymbol(declaration);
```

The **existing** position methods are re-pointed to the table **without changing their signatures or
results**:

| Method | Today | After |
|---|---|---|
| `DefinitionAt(offset)` | `FindNode` → ancestor walk → `GetSymbol(name, enclosingType)` (fresh alloc) | `FindNode(offset)` → `GetSymbolInfo(node)`; map `ErrorSymbol` → `null` for the legacy contract |
| `DeclaredSymbolAt(offset)` | `FindNameNode` → switch → fresh `MemberSymbol`/`EnumMemberSymbol`/`GetSymbol(name)` | `FindNameNode(offset)` → `GetDeclaredSymbol(node)`; `null` → existing null |
| `GetSymbol(name, enclosingType)` | string lookup, fresh alloc | **kept** as a name-based shim (see Decision 4) — used by `WorkspaceIndex` when only a name (no node) is in hand |
| `GetSymbol(name)` | string lookup, fresh alloc | **kept** as the model-wide name shim (cross-file resolution in `WorkspaceIndex`) |

`DefinitionAt`/`DeclaredSymbolAt` now return **interned** symbols (identity), so a `WorkspaceIndex`
that compares two results gets `ReferenceEquals`-true for the same declaration — *and* the existing
`DeclSpan ==` comparisons keep working unchanged because the interned symbols carry the same
`DeclSpan`. **No behavior changes; identity is gained silently.**

### Decision 4 — `ModelIndex` is unchanged; `GetSymbol` stays a shim; error handling mirrors `ErrorType`

- **`ModelIndex` is not modified** (zero conflict with the in-flight TypeScript emitter). The binder is
  a *consumer* of `ModelIndex`: it asks `ModelIndex` the same questions the old `GetSymbol` asked
  (`TryGetDecl`, `TryGetDeclIn`, `Classify`, `EnumsDeclaring`, `ResolveReference`, `IdTypeNames`) and
  **interns** the answers into stable `Symbol`s. The single source of truth for *resolution rules*
  stays `ModelIndex`; the binder owns *identity* only.
- **`GetSymbol(name, …)` is retained verbatim as a shim** so `WorkspaceIndex.ResolveDefinition`,
  `ResolveTarget`, `ResolveHover`, `IsRenameableName`, and `RefactorService` (which call `GetSymbol`
  with a *name* — sometimes without a node in hand, e.g. cross-file name resolution) keep compiling
  and behaving identically. The shim *may* be reimplemented to return interned symbols from the table
  (so name-based and node-based lookups agree on identity), but its **null-for-unknown** contract is
  preserved — callers like `WorkspaceIndex.StrongSpan` (`GetSymbol(name)?.DeclSpan`) depend on it.
  This is the explicit bridge that keeps the LSP/RefactorService untouched.
- **Error/unresolved handling.** `GetSymbolInfo` returns `ErrorSymbol.Instance` (never null), mirroring
  `TypeResolver.TypeOf` returning `ErrorType.Instance`. **This commit raises no new diagnostics** —
  unresolved-name diagnostics already flow from the `SemanticValidator` / `ExpressionChecker` /
  `ModelIndex.ResolveReference` (KOI0101 etc.); the binder *reproduces* their resolution but does not
  duplicate or re-report them. The binding table is a navigation/identity artifact, not a second
  validation pass. (A future commit could let the validator consume the binder's `ErrorSymbol`s
  instead of re-resolving — noted as "what this unlocks", not done here.)

### Laziness, threading, performance

- Built lazily per `SemanticModel`, thread-safe, identical to `SyntaxGraph` — the emit path never
  forces it. The binder walks the tree **once** (Commit-2 visitor, no reflection), interning symbols
  and filling the table; subsequent `GetSymbolInfo`/`DefinitionAt` are O(1) dictionary hits instead of
  per-query `FindNode` + ancestor walk + string lookup + allocation. The LSP hot path
  (`FindReferences` over whole files) drops from O(tokens) re-resolutions to O(tokens) table hits over
  a once-built table.
- The binder may reuse the `SyntaxGraph` (already lazily available on the same `SemanticModel`) for the
  `DefinitionAt`/`DeclaredSymbolAt` `FindNode`→node step, but does **not** need parent links for its
  own walk (the visitor descends top-down, pushing scope as it goes).

## Files

- **New:** `src/Koine.Compiler/Ast/SymbolTable.cs` — interned declaration symbols + containment,
  built over `ModelIndex`. TARGET-AGNOSTIC.
- **New:** `src/Koine.Compiler/Ast/BindingTable.cs` — reference-keyed (BCL
  `ReferenceEqualityComparer.Instance`) node→`Symbol` map; `GetSymbolInfo`. TARGET-AGNOSTIC.
- **New:** `src/Koine.Compiler/Ast/Binder.cs` — `KoineSyntaxVisitor` (Commit-2) subclass that builds the
  symbol table and binding table in one walk; scope stack; resolution delegates to `ModelIndex`.
  TARGET-AGNOSTIC.
- **Modify:** `src/Koine.Compiler/Ast/Symbols.cs` — add `Symbol? ContainingSymbol { get; init; }`; add
  `ContextSymbol` / `ParameterSymbol` / `LocalSymbol` / `LambdaParameterSymbol` / `ErrorSymbol`;
  extend the `SymbolKind` enum additively (`Context`/`Parameter`/`Local`/`LambdaParameter`/`Error`).
  Existing symbol classes keep their public surface.
- **Modify:** `src/Koine.Compiler/Ast/SemanticModel.cs` — add the thread-safe lazy `_binding`; add
  `GetSymbolInfo(node)` / `GetDeclaredSymbol(node)`; re-point `DefinitionAt` / `DeclaredSymbolAt` to
  the table (results unchanged); **re-point the ad-hoc `new MemberSymbol`/`new TypeSymbol` sites in
  `MemberOf`/`DeclaredSymbolAt`/`GetSymbol` to return the interned table symbol** (closes the
  null-`ContainingSymbol` leak); keep `GetSymbol(name, …)` as the name shim with its null-for-unknown
  contract.
- **Decision on the comparer (no Commit-1 file touch):** uses the **BCL
  `ReferenceEqualityComparer.Instance`** rather than promoting `SyntaxGraph`'s private nested
  `IdentityComparer`. So **`SyntaxGraph.cs` is NOT modified** by this commit. (If a future commit wants
  a shared `Ast/NodeIdentityComparer`, that promotion — and the `SyntaxGraph.cs` edit it implies — is a
  separate change.)
- **Unchanged, intentionally:** `ModelIndex.cs`, `TypeResolver.cs`, `KoineType.cs`, all of `Emit/`,
  `WorkspaceIndex.cs`, `RefactorService.cs`, `KoineLanguageService.cs`, `LspServer.cs`, `SyntaxGraph.cs`
  — no caller is rewritten; identity is gained transparently in-document.
- **New:** `tests/Koine.Compiler.Tests/BinderTests.cs` (or `SymbolBindingTests.cs`) — identity +
  binding-table + equivalence tests.

## Testing

Match the stack (xUnit v2 plain asserts; the existing R17 navigation/rename suite —
`InExpressionNavigationTests`, `NodeAtNavigationTests`, `KoineLanguageServiceTests`,
`SemanticModelTests` — is the regression oracle, since `DefinitionAt`/`DeclaredSymbolAt` must stay
byte-identical).

1. **Reference-key identity regression (the value-equality risk).** A model with two types each
   declaring a `amount` field and an `amount` reference in each one's invariant: each
   `IdentifierExpr("amount")` reference binds to its **own** `MemberSymbol` (distinct instances,
   distinct `ContainingSymbol`). Fails loudly if the `BindingTable` ever drops `IdentityComparer`.
2. **Symbol interning invariant (the new identity hazard).** `GetDeclaredSymbol(decl)` returns the
   **same instance** (`Assert.Same`) on repeated calls; every `GetSymbolInfo(ref)` that resolves to a
   declaration returns that **same** instance (`Assert.Same` against `GetDeclaredSymbol`). Across N
   references to one `Money` type, all bind to **one** `TypeSymbol`.
3. **Binding-table equivalence (the resolution oracle).** For the example `.koi` corpus, for every
   reference-bearing node, the binder's symbol must match the legacy `DefinitionAt(offsetOfNode)` on
   **`Kind` AND `Name` AND `DeclSpan`** — **not `DeclSpan` alone** (review-flagged: synthesized
   `IdValueObjectSymbol`s have `DeclSpan == SourceSpan.None` when no entity declares the `*Id`, so a
   DeclSpan-only oracle proves nothing for them). Include an explicit **convention-only `*Id`** case
   (`product: ProductId` with **no** `ProductId` entity) that asserts the reference interns the
   synthesized `IdValueObjectSymbol` by `Kind`+`Name`. Proves R13.2 cross-context, `*Id` convention,
   enum ownership, and specs are reproduced exactly.
4. **Containment.** A `MemberSymbol`'s `ContainingSymbol` is the `TypeSymbol` of its declaring type; an
   R13.2 model with two `Money` types yields two `TypeSymbol`s with distinct `ContextSymbol`
   containers; a `let` local's container is the enclosing behavior symbol. **Every non-context interned
   symbol has a non-null `ContainingSymbol`** (guards the `init`-set build ordering).
5. **`ErrorSymbol` for unresolved.** `GetSymbolInfo` on an `IdentifierExpr` naming nothing returns
   `ErrorSymbol.Instance` (never null); the legacy `DefinitionAt` shim still returns `null` for it
   (contract preserved).
6. **Navigation/rename regression (the load-bearing oracle).** The full existing R17 navigation + rename
   suite stays green after `DefinitionAt`/`DeclaredSymbolAt` are re-pointed at the table — the
   end-to-end proof identity was gained with **no** behavior change (the `WorkspaceIndex` `DeclSpan ==`
   comparisons, including **cross-file**, still hold). **Note: Verify snapshots / the Roslyn meta-test
   are BLIND to binder regressions** — the binder is entirely off the emit path, so this xUnit
   `BinderTests` suite + the R17 navigation/rename suite are the **only** guards. Treat the navigation
   suite as the load-bearing oracle; the emitted-C# snapshot safety net does **not** apply here.
7. **Whole suite green.** `./build.sh` (~500 tests) — emitted C# unaffected (binder is off the emit
   path), and the new `Ast/` types build and run.

## Non-goals (guard rails)

- **No bound-IR / lowering** — this commit produces a *binding table* (a side map: reference node →
  symbol), **not** a transformed bound tree. The desugared, resolved bound tree is Commit 4, which will
  consume this binder's symbols (and the Commit-2 rewriter).
- **No `ModelIndex` / `TypeResolver` / `KoineType` / `Emit/` changes** — preserves zero conflict with
  the in-flight TypeScript emitter. The binder is strictly additive *on top of* `ModelIndex`.
- **No caller rewrite.** `WorkspaceIndex` / `RefactorService` / `KoineLanguageService` / `LspServer`
  are untouched; they keep their `DeclSpan`-value comparisons and `GetSymbol(name)` calls. Migrating
  them to `ReferenceEquals(boundSymbol, target)` is a deliberate follow-up, not this commit.
- **No new diagnostics.** Unresolved-name reporting stays in the validator/`ExpressionChecker`;
  `ErrorSymbol` is a navigation sentinel, not a diagnostic source. The binder does not re-report.
- **No built-in-op symbols.** `CallExpr.Method` built-ins (`startsWith`, `sum`, …) and nullary value
  ops (`now`) are not declarations and bind to nothing (`GetSymbolInfo` → `ErrorSymbol`); they have no
  go-to-definition target today and gain none here.
- **No member-access receiver inference beyond what exists.** Binding a `MemberAccessExpr` selector
  (`order.total`) is *best-effort* by calling **existing** `ModelIndex`/`TypeResolver` member lookup
  (e.g. `ModelIndex.TryGetMemberType`); the binder **must not reimplement receiver-type inference** in
  `Ast/` (that would duplicate `TypeResolver` and risk over-binding to a wrong member). When the
  receiver type is undeterminable it binds to `ErrorSymbol` — matching `WorkspaceIndex`'s current
  "selectors out of scope" stance. Any selector it *can* bind via existing lookup is a bonus, not a
  contract.
- **No equality override on `Symbol`.** Identity is by reference (interning), not a custom
  `Equals`/`GetHashCode` — keeping the existing value-comparison callers working unchanged.
- **CROSS-DOCUMENT identity is a NON-GOAL (review-flagged).** Identity is interned **per-`SemanticModel`**;
  `WorkspaceIndex` holds one model per URI, so `ReferenceEquals` across files is meaningless. Cross-file
  rename/find-references **keep** `DeclSpan`-value comparison. True workspace-wide symbol identity needs a
  workspace-level binder (one table spanning all files) — explicitly out of scope.
- **No `ModelIndex` helper added for the binder.** The binder composes only **existing** `ModelIndex`
  queries; adding a `ModelIndex` accessor would touch a file the TS emitter reads (conflict risk).

## What this unlocks

- **Commit 4 (lowering / bound-IR)** consumes the binder: the bound tree's nodes carry resolved
  `Symbol` references (not strings), so desugaring (`let` flattening, derived-member expansion, guard
  normalization) and the emitters read fully-resolved identity instead of re-deriving it from
  `ModelIndex` strings. The Commit-2 `KoineSyntaxRewriter` produces the lowered tree; this commit
  supplies the symbols it binds to.
- **Refactor/rename simplification — IN-DOCUMENT ONLY.** For references resolved **within one
  `SemanticModel`**, `WorkspaceIndex` can move from `DeclSpan ==`-value comparison to
  `ReferenceEquals(GetSymbolInfo(node), target)`. **Cross-file** comparisons MUST stay value-based
  (identity is per-model — see the non-goal). `ContainingSymbol` can refine in-document disambiguation;
  the cross-file rename gate is unchanged by this commit. A bounded follow-up, not done here.
- **Validator unification.** A later commit can let `ExpressionChecker` consume the binder's
  `ErrorSymbol`s as the single unresolved-name signal, retiring duplicate string resolution in the
  validators.
- **The TypeScript emitter** (and any future emitter) gains a target-agnostic
  `GetSymbolInfo`/`GetDeclaredSymbol` identity surface it *may later* consume — **available, not wired
  up by this commit** (the TS emitter currently re-derives everything from `ModelIndex` strings exactly
  like the C# one, and is not touched here). Additive, since the binder lives in `Ast/` and touches no
  emitter type.
- **Identity becomes the foundation** for find-all-references, call hierarchy, and precise rename in
  the Rider/LSP tooling — the Roslyn capability that string resolution structurally cannot provide.
