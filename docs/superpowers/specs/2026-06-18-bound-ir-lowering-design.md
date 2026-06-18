# Lowering / Bound-IR layer

**Date:** 2026-06-18
**Status:** Revised after adversarial review — ready for implementation plan
**Scope:** Commit 4 of a sequenced "Roslyn-shaped architecture" effort (one opportunity per commit)

> **Sequencing note (read first — this was a blocking review finding).** Only **Commit 1**
> (`SyntaxGraph`, merged in #20) exists in the tree today. **Commits 2 and 3 do NOT yet exist**
> (`grep KoineSyntaxVisitor|GetSymbolInfo(node)|BindingTable` finds nothing; there is no
> `Ast/Bound/`). This commit **hard-depends on Commits 2 and 3** and is delivered **last on the same
> branch (`feat/roslyn-arch-2-3-4`)**, after both have merged as the preceding phases. Every
> reference below to "the Commit-2 visitor" / "the Commit-3 binder / `GetSymbolInfo`" is a dependency
> on an **earlier phase of this same PR**, not an already-shipped artifact. If either slips, this
> phase is blocked — it is not implementable on today's tree (the symbol-identity `Assert.Same`
> tests require Commit 3's interned symbols; today's `GetSymbol` mints fresh value-equality records
> for which `ReferenceEquals` is meaningless).

## Context

Koine's AST is already deliberately Roslyn-shaped: immutable value-equality `record` nodes
(`Ast/Nodes.cs`, `Ast/Expressions.cs`) under a base `KoineNode`, a `SemanticModel` façade, a
`Symbol` layer, resolved `KoineType` vs syntactic `TypeRef` with an `ErrorType` sentinel, lossless
trivia, and — as of the prior phases on this branch — a `SyntaxGraph` "red layer" (Commit 1:
`Parent`/`Ancestors`/`FirstAncestorOrSelf<T>`/`FindNode`), a typed, source-generated
`KoineSyntaxVisitor` / `KoineSyntaxVisitor<TResult>` / `KoineSyntaxRewriter` family (Commit 2), and a
real `Binder` producing one interned `Symbol` per declaration plus a reference-keyed `BindingTable`
exposed as `SemanticModel.GetSymbolInfo(node)` / `GetDeclaredSymbol(node)` (Commit 3).

The **last** remaining divergence from Roslyn is the one this commit closes: **there is no lowering /
bound-IR layer between the AST and the emitters.** Today every emitter re-derives semantics directly
from the syntax tree at emit time:

- `CSharpExpressionTranslator` re-runs a `TypeResolver` over the raw `Expr` (`new TypeResolver(index,
  context)`, `_scope = TypeScope.FromMembers(...)`) to recover the type of each subexpression it is
  translating, and re-classifies names against `ModelIndex` (member vs enum-member vs local) on every
  call — exactly the work the Commit-3 binder already did once.
- Desugaring is done **inline, in C# string-building code**, scattered across the emitter: the
  derived-vs-stored member split (`MemberAnalysis.IsDerived`), the invariant **message default**
  (`inv.Message ?? SynthesizeMessage(inv.Condition)`), the negated-guard form
  (`TranslateNegated`), the `when`-guard split (`GuardExpr` → `if (cond && !(body))`), the
  enum-default coalesce (`WriteEnumDefaultCoalesce`), the constructor-parameter reordering
  (`OrderCtorParams`), and the `?? `/optional handling. Each of these is a *lowering* expressed as
  ad-hoc string emission rather than as a transform on a resolved tree, so it must be re-implemented
  by every new backend.

That last point is the cost: the **shipped TypeScript emitter** (`Emit/TypeScript/`, delivered in R16)
redoes all of it — re-resolves types, re-classifies names, re-synthesizes invariant messages, re-splits
guards — because the only thing upstream of the emitters is the *syntactic* AST plus side tables. A bound tree
that is **fully resolved** (every reference carries its Commit-3 `Symbol`, every expression carries
its `KoineType`) and **desugared** to a small canonical set of forms would let both emitters consume
shared, lowered semantics instead of each re-deriving them.

The TypeScript emitter consumes the resolution surface the C# backend does — `SemanticModel.Index` →
`ModelIndex` / `TypeResolver` / `KoineType`. **This commit touches none of those types' signatures.**
The bound tree is a *new, additive layer* built on top of the Commit-1/2/3 infrastructure
(`SyntaxGraph`, `KoineSyntaxVisitor`, the binder's `GetSymbolInfo`/`GetTypeInfo`); `ModelIndex`,
`TypeResolver`, and `KoineType` keep their public shapes, so a future TS migration onto the bound
tree is *unblocked* by this commit without being *forced* by it.

## The scope decision (read this first — it governs everything below)

This is the riskiest commit in the sequence because it is the first that **touches the emitters**,
and the emitters are exactly where the shipped TypeScript backend lives (and where future emitter
work will). A full migration of
`CSharpEmitter` onto a bound tree would be a multi-thousand-line rewrite of the project's largest,
most snapshot-covered subsystem — precisely the kind of broad, conflict-prone diff the prior commits
were disciplined to avoid.

**Decision: this commit INTRODUCES the bound-tree + a `Lowerer`, and retargets exactly ONE narrow,
self-contained emitter slice onto it as a working proof — value-object invariant guards. Everything
else in `CSharpEmitter`, and ALL of the TypeScript emitter, is untouched.** A full emitter migration
is a deliberate FUTURE multi-commit effort, explicitly out of scope here (see Non-goals).

Why **value-object invariant guards** are the chosen slice (weighed against the alternatives):

| Candidate slice | Why considered | Verdict |
|---|---|---|
| **VO invariant guards** (chosen) | Self-contained (one `WriteInvariantGuards` path off `EmitValueObject`), exercises the *two* defining properties of the layer at once — **resolution** (the condition expr is bound + typed) and **desugaring** (the `inv.Message ?? SynthesizeMessage(...)` default and the `GuardExpr`/negation split are real lowerings, not just pass-throughs). Snapshot-bounded: only VO `.verified.txt` invariant lines are in play, and only if output drifts (it must not). | **Chosen.** |
| VO field projection (stored vs derived split) | Also self-contained and a real lowering (`MemberAnalysis.IsDerived`). | Rejected as the *first* slice: it is a structural split with little expression resolution, so it proves less of the "fully-resolved bound expression" half of the layer. Good as the *second* slice in a follow-up. |
| Whole `EmitValueObject` | Proves the most. | Rejected: too broad for one commit; reorders ctor params, equality, ToString, operators — large snapshot surface, high conflict risk. |
| Any entity/command/CQRS slice | High value | Rejected: command bodies (`Transition`/`requires`/`emit`/`result`) are the most semantically loaded paths; lowering them first maximizes blast radius. Defer. |

The guiding principle, inherited from Commits 1–3: **keep the consumer surface to exactly one
production call site, prove equivalence under the existing snapshot + Roslyn meta-test, and leave the
rest working unchanged.**

## Goal

1. **A bound tree** (`Ast/Bound/`): `BoundNode` base; `BoundExpression : BoundNode` (carries
   `KoineType Type`); bound declaration/member nodes; each bound node keeps a back-pointer to the
   `KoineNode Syntax` it was lowered from (Roslyn's `BoundNode.Syntax`, for diagnostics/navigation).
   Fully resolved: every reference-bearing bound expression carries the Commit-3 `Symbol` it binds to
   and every bound expression carries its `KoineType`. **Target-agnostic — no C# concepts.**
2. **A `Lowerer`** (`Ast/Bound/Lowerer.cs`): built on the Commit-2 `KoineSyntaxVisitor<TResult>` and
   the Commit-3 binder, it transforms a resolved `Expr` (and, for this slice, an `Invariant`) into
   bound nodes, performing the desugarings the chosen slice needs and **only** those.
3. **The one retargeted slice**: `CSharpEmitter`'s value-object invariant guards consume
   `BoundInvariant` / `BoundExpression` instead of re-resolving the raw `Invariant.Condition` — with
   **byte-identical** emitted C# (the existing Verify snapshots and the Roslyn meta-test stay green).

The bound tree is exposed off `SemanticModel` as a lazily-built, thread-safe artifact mirroring
`_graph` and `_binding`, so the layer is uniform with its predecessors and the emit path forces it
only for the migrated slice.

## Design

### Decision 1 — bound nodes are immutable `record`s in `Ast/Bound/`, carrying `Syntax` + resolved `Type`/`Symbol`

**Chosen: a parallel `BoundNode` `record` hierarchy in a new `Ast/Bound/` folder**, distinct from the
syntactic `KoineNode` hierarchy, mirroring Roslyn's separate `BoundNode` tree.

Rationale, weighed:

| Option | Verdict |
|---|---|
| **Annotate the existing `Expr`/`Node` records** with resolved type/symbol (e.g. add `KoineType? Type` to `Expr`) | **Rejected.** It would leak *resolved* (post-binding) state into the *syntactic*, target-agnostic AST, breaking the red/green-ish separation the whole effort maintains, and would force `with`-churn through `KoineSyntaxRewriter`. The AST stays purely syntactic. |
| **A separate `BoundNode` record tree** (chosen) | **Chosen.** Clean separation: the AST is syntax, the bound tree is resolved+lowered semantics. Matches Roslyn exactly (`BoundNode` is a distinct hierarchy from `SyntaxNode`). Records give value-equality + `with` for the lowering transforms and free structural sharing, exactly as the AST. |
| **A mutable bound tree** | **Rejected.** The project's entire model discipline is immutable records; a mutable IR would be the odd one out and lose the `with`/identity benefits. |

Concrete sketch (`Ast/Bound/BoundNodes.cs` — **TARGET-AGNOSTIC; no C# concept**):

```csharp
namespace Koine.Compiler.Ast.Bound;

/// <summary>Base of the resolved, lowered intermediate tree (Roslyn BoundNode analogue).
/// Distinct from the syntactic <see cref="KoineNode"/> hierarchy. TARGET-AGNOSTIC.</summary>
public abstract record BoundNode
{
    /// <summary>The syntax this node was lowered from (Roslyn BoundNode.Syntax) — for
    /// diagnostics/navigation. May be a synthesized-source span for desugared nodes.</summary>
    public required KoineNode Syntax { get; init; }
}

/// <summary>A resolved expression: carries its <see cref="KoineType"/> (never null —
/// <see cref="ErrorType"/> for undeterminable). Roslyn BoundExpression analogue.</summary>
public abstract record BoundExpression : BoundNode
{
    public required KoineType Type { get; init; }
}

// --- the canonical, lowered expression forms this slice needs ---

/// <summary>A binary op over two bound operands. Op is the target-agnostic <see cref="BinaryOp"/>.</summary>
public sealed record BoundBinary(BinaryOp Op, BoundExpression Left, BoundExpression Right) : BoundExpression;

/// <summary>A unary op over a bound operand.</summary>
public sealed record BoundUnary(UnaryOp Op, BoundExpression Operand) : BoundExpression;

/// <summary>A resolved reference to a declaration: the <see cref="Symbol"/> is the Commit-3
/// interned identity (member / parameter / local / enum member / id-VO / ErrorSymbol).</summary>
public sealed record BoundReference(Symbol Symbol) : BoundExpression;

/// <summary>A literal carried through verbatim (kind + canonical text).</summary>
public sealed record BoundLiteral(LiteralKind Kind, string Text) : BoundExpression;

/// <summary>A member access on a resolved receiver; <see cref="Member"/> is the selector
/// symbol (Commit-3 best-effort) or ErrorSymbol.</summary>
public sealed record BoundMemberAccess(BoundExpression Receiver, string MemberName, Symbol Member) : BoundExpression;

/// <summary>A call on a resolved receiver (built-in method by name — built-ins have no symbol).</summary>
public sealed record BoundCall(BoundExpression Receiver, string Method, IReadOnlyList<BoundExpression> Args) : BoundExpression;

// Forms REACHABLE from a value-object invariant condition — defined NOW because the slice reaches
// them (Decision 3 §3): BoundConditional (a ? b : c), BoundCoalesce (a ?? b), BoundMatch (matches /…/),
// BoundGuard (when-guard), and BoundLet (let … in) follow the same record shape, each carrying its
// resolved Type. BoundLambda is defined ONLY if a collection-aggregate lambda is reachable from a VO
// invariant (it is rare; if the corpus has none the form is added with the first slice that needs it,
// to avoid unused-form churn). The implementer enumerates the actual reachable set from the example
// corpus + the hand-built coverage model (Testing §6) and defines exactly that set — no more.

// --- bound member / declaration forms (the non-expression part of the IR) ---

/// <summary>A value-object invariant lowered to its canonical form: a resolved boolean condition
/// plus the FINAL <b>C# default</b> message (the <c>?? SourceText(condition)</c> default already
/// applied) — so the C# emitter no longer re-derives it. NOTE: this is the C# message policy; other
/// targets (TS) synthesize their own message and do NOT consume this field (see Decision 2).</summary>
public sealed record BoundInvariant(BoundExpression Condition, string Message) : BoundNode;
```

Key properties:

- **`Syntax` back-pointer** (Roslyn `BoundNode.Syntax`): every bound node names the `KoineNode` it
  came from, so a future diagnostic emitted over the bound tree still points at real source, and the
  `SyntaxGraph`/binder can be consulted for the original node. For *synthesized* lowerings (a node
  with no 1:1 syntactic origin) the `Syntax` is the nearest meaningful enclosing node — same
  convention Roslyn uses for compiler-synthesized bound nodes.
- **`Type` on every `BoundExpression`** is the Commit-3/`TypeResolver` result, never null
  (`ErrorType` for undeterminable) — mirroring the `KoineType`/`ErrorType` discipline.
- **`Symbol` on `BoundReference`/`BoundMemberAccess`** is the *interned* Commit-3 symbol
  (`ReferenceEquals`-meaningful), not a fresh string lookup.
- **No marker attribute, no C# concept.** The bound tree lives in `Ast/Bound/` precisely so the
  invariant "`Ast/` is target-agnostic" extends to it. A reviewer can grep `Ast/Bound/` for any C#
  string and find none.

### Decision 2 — the `Lowerer` is built on the Commit-2 visitor + Commit-3 binder; it lives in `Ast/Bound/`

**`Ast/Bound/Lowerer.cs`** lowers a resolved subtree to bound nodes. It is a
`KoineSyntaxVisitor<BoundNode>` (Commit-2) whose `VisitFoo` overrides build the corresponding bound
node, reading resolution from the Commit-3 binder and `TypeResolver` rather than re-deriving it:

```csharp
namespace Koine.Compiler.Ast.Bound;

/// <summary>Transforms a resolved syntax subtree into the bound (resolved + lowered) tree.
/// Built on the Commit-2 typed visitor and the Commit-3 binder; performs ONLY the desugarings
/// the migrated slice needs (see Decision 3). TARGET-AGNOSTIC.</summary>
internal sealed class Lowerer : KoineSyntaxVisitor<BoundNode>
{
    private readonly SemanticModel _model;     // GetSymbolInfo (Commit 3) + GetTypeInfo (TypeResolver)
    private readonly TypeScope _scope;         // the member scope for type resolution (see below)
    private readonly string? _context;

    public Lowerer(SemanticModel model, TypeScope scope, string? context) { … }

    public BoundExpression LowerExpr(Expr e) => (BoundExpression)Visit(e)!;

    // LowerInvariant is a PLAIN method, NOT a visitor override — `Invariant` is a KoineNode but not an
    // `Expr`, so it is not in the typed visitor's Expr dispatch. The condition (an Expr) is lowered via
    // the visitor; the message default is applied here.
    /// <summary>Lowers a value-object invariant: binds + types the condition, and applies the
    /// C# message default (<c>?? SourceText(condition)</c>) ONCE, here.</summary>
    public BoundInvariant LowerInvariant(Invariant inv) =>
        new(LowerExpr(inv.Condition), inv.Message ?? SourceText(inv.Condition))   // SourceText relocated verbatim
        { Syntax = inv };

    public override BoundNode VisitBinaryExpr(BinaryExpr n) =>
        new BoundBinary(n.Op, LowerExpr(n.Left), LowerExpr(n.Right))
        { Syntax = n, Type = _model.GetTypeInfo(n, _scope, _context) };

    public override BoundNode VisitIdentifierExpr(IdentifierExpr n) =>
        new BoundReference(_model.GetSymbolInfo(n))     // Commit-3 interned symbol
        { Syntax = n, Type = _model.GetTypeInfo(n, _scope, _context) };

    // … one override per Expr kind the slice reaches; the relocated SourceText helper (verbatim from
    //    CSharpEmitter) provides the message default. NO C# in any of it.
}
```

**`TypeScope` construction must mirror the emitter exactly (review-flagged plumbing).** Byte-identity
of resolved `Type`s hinges on the lowerer resolving in the **same** scope the C# emitter assumed when
it called `TypeResolver`. For a value-object invariant that scope is the VO's own members:
`BoundModel.Build` constructs the lowerer with `TypeScope.FromMembers(vo.Members)` and the VO's
context — the identical scope `CSharpExpressionTranslator` builds inline today. A wrong scope yields
wrong `Type`s on the bound nodes (caught by Testing §1, but the scope construction is specified here so
it is not left as "unaddressed plumbing").

Rationale:

- **Reuses Commit-2 traversal.** The lowerer is a typed visitor, so adding a node kind regenerates
  the dispatch and the lowerer's coverage gap (if any) is a missing override caught by tests, not
  silent reflection drift.
- **Reuses Commit-3 identity + Commit-1 graph implicitly.** `GetSymbolInfo`/`GetTypeInfo` are the
  *only* resolution entry points; the lowerer adds **no new resolution rules**. It is a pure
  *transform*, exactly as Commit 3 was a pure *identity* layer over `ModelIndex`.
- **`SourceText` (the Koine-source round-trip) moves down into `Ast/Bound/`** (from `CSharpEmitter`)
  because it is genuinely target-agnostic: `CSharpEmitter.SourceText(expr) =>
  SourceTextVisitor.Instance.Visit(expr)` renders **Koine source syntax** via an `ExprVisitor<string>`
  (Koine keywords `matches`/`when`/`let … in`), with **no C# in it**. The relocation must be
  **verbatim** — any reformatting would change synthesized invariant messages and break snapshots.

  **Honesty about scope (review-flagged — this is NOT a cross-emitter unification).** There are **two
  different** `SynthesizeMessage` implementations in the tree today:
  `CSharpEmitter.SynthesizeMessage(c) => SourceText(c)` (the Koine round-trip) vs
  `TypeScriptEmitter.SynthesizeMessage(c) => "invariant failed"` (a fixed literal). They produce
  **different output.** Therefore:
  - `BoundInvariant.Message` in this commit is the **C# message default only** — it is exactly the
    `inv.Message ?? SourceText(inv.Condition)` the C# emitter produced, relocated, byte-identical.
  - **This commit does NOT change TS** and does NOT make `BoundInvariant.Message` authoritative for all
    targets. TS keeps its own `"invariant failed"` synthesizer. Making the message a single shared
    bound field would *change* TS's emitted output (a snapshot break in the "untouched" TS emitter) —
    explicitly **not** done here. Message synthesis is, in fact, a per-target presentation choice
    (proven by the two differing implementations), so the bound tree carries the **positive condition**
    and the **C# default message**; cross-target message unification is a separate, opt-in future design
    with its own byte-equivalence proof per target.

### Decision 3 — what lowerings ship in THIS commit vs deferred; diagnostics are assumed upstream

**Ships now (only what the VO-invariant-guard slice reaches):**

1. **Reference resolution** — `IdentifierExpr`/`TypeRef`/member-access selectors in a VO invariant
   condition become `BoundReference`/`BoundMemberAccess` carrying the Commit-3 `Symbol` + `KoineType`.
2. **Invariant message default** — `inv.Message ?? SynthesizeMessage(inv.Condition)` is applied once
   in `LowerInvariant`, so `BoundInvariant.Message` is final.
3. **The expression forms reachable from a boolean VO invariant**: binary/unary/comparison,
   `MatchExpr`, `GuardExpr`, member access, calls (built-in predicates like `isEmpty`/`startsWith`),
   literals, conditional/coalesce. Each gets a bound form with its resolved `Type`.

**Deliberately deferred** (the un-migrated emitter keeps doing these inline, unchanged):

- The **negated-guard rendering** (`TranslateNegated`: `amount >= 0` → `if (amount < 0)`) and the
  `GuardExpr` → `if (cond && !(body))` split stay in `WriteGuard`/`CSharpExpressionTranslator` for
  now. **Rationale:** "emit the *negation* idiomatically" is a *C#-rendering* decision (which way to
  spell the failure test), not a target-agnostic desugaring — pushing it into the bound tree would
  bake a C#-leaning choice into `Ast/Bound/`. The bound tree carries the *positive* condition; the
  emitter still chooses how to render its negation. (A target-neutral "BoundNegation" normalization
  is a possible future lowering, but it is **not** this commit and would need its own
  byte-equivalence proof.)
- Derived-vs-stored member split, ctor-param reordering, enum-default coalesce, command/factory/CQRS
  bodies, state machines, quantity/operator synthesis — **all deferred**. They are not on the VO
  invariant path and migrating them is the future multi-commit effort.

**Diagnostics are assumed already-run.** The lowerer executes on a model the `SemanticValidator`
already validated (the pipeline order is parse → build → **validate** → emit; `KoineCompiler` only
emits when validation produced no errors). So the lowerer **raises no diagnostics** and assumes a
well-formed, resolvable input — an unresolved reference simply yields `ErrorSymbol`/`ErrorType` in the
bound node (mirroring the binder), never a throw. This matches Roslyn: lowering runs after binding
diagnostics, on already-bound trees.

### Decision 4 — the slice consumes bound nodes with byte-identical output (snapshots stay green)

The single retargeted call site is `CSharpEmitter`'s value-object invariant emission. Today
(`CSharpEmitter.ValueObjects.cs` → `WriteConstructor` → `WriteInvariantGuards` →
`WriteGuard`):

```
EmitValueObject → WriteConstructor(... vo.Invariants ...)
  → WriteInvariantGuards(sb, vo.Name, vo.Invariants, translator)
      foreach inv: WriteGuard(sb, typeName, inv.Condition, inv.Message ?? SynthesizeMessage(inv.Condition), translator, mode)
```

After:

```
EmitValueObject builds  IReadOnlyList<BoundInvariant> bound = semantic.BoundInvariantsFor(vo);
  → WriteInvariantGuards(sb, vo.Name, bound, translator)            // NEW BoundInvariant overload (VO only)
      foreach bi: WriteGuard(sb, typeName, bi /* .Condition.Syntax, .Message already final */, translator, mode)
```

**Shared-path safety (review-flagged blast radius).** `WriteGuard`/`WriteInvariantGuards` and the
`?? SynthesizeMessage` default are shared **today** across **three** callers: VO invariants, **entity
invariants** (`CSharpEmitter.cs:948`), and **command `requires`** (`:1192`). The slice adds a **new
`BoundInvariant` overload** of `WriteInvariantGuards`/`WriteGuard` used by **only** the VO path; the
existing raw-`Invariant` overload is **kept unchanged** for the entity and command callers. An
accidental *signature replacement* (instead of an additive overload) would force-migrate the
entity/command paths — out of scope, large blast radius — so the implementer must add, not replace.
The relocated `SourceText` helper is shared by both overloads (it is target-agnostic and identical).

Byte-identity is preserved because:

- **The message is identical.** `BoundInvariant.Message` is produced by the *same*
  `inv.Message ?? SourceText(condition)` expression (the C# default), now evaluated in the lowerer with
  `SourceText` relocated **verbatim** — moved, not changed. (TS is untouched and keeps its own
  `"invariant failed"`; the slice is C#-only.)
- **The rendered condition is identical.** `WriteGuard` still drives `CSharpExpressionTranslator`
  for the actual C# spelling (including `TranslateNegated`/`GuardExpr`/`MatchExpr` handling, which —
  per Decision 3 — stay in the translator). The slice changes *where the condition + message come
  from* (a `BoundInvariant` instead of a raw `Invariant`), **not** how the translator renders them.
  For this commit the translator still receives the *syntactic* `Expr` (read off
  `BoundInvariant.Syntax` / a `Condition.Syntax` accessor) so the rendering path is unchanged and
  provably byte-identical; the bound `Condition`'s resolved `Type`/`Symbol` are carried but the C#
  string rendering is not yet driven from them. **This is the deliberate "thin proof" shape**: the
  bound tree is *produced and threaded through the slice* (proving it builds correctly over the real
  corpus), the desugared `Message` is *consumed* from it (proving a real lowering is absorbed), and
  the expensive rendering swap is deferred so no snapshot moves.

> **The honesty of the proof.** A skeptic could ask "if the translator still renders from the raw
> `Expr`, what did the bound tree buy?" Answer: (1) it is **built over the entire VO-invariant corpus
> on every test run** and its `Type`/`Symbol` are asserted correct (Testing §1–2), so the layer is
> exercised, not dead; (2) it **absorbs the message-default desugaring** out of the emitter
> (`SynthesizeMessage` moves to `Ast/Bound/`), a concrete reduction of emitter-side semantics; (3) it
> establishes the **shape, ownership, and wiring** (`SemanticModel.BoundInvariantsFor`, lazy
> threading, byte-equivalence harness) that the *next* slices reuse to actually drive rendering from
> bound nodes. Driving the translator from bound nodes is the follow-up slice (VO field projection /
> derived members), where the snapshot surface is understood and the equivalence is proven
> incrementally — not bundled into the layer's introduction.

If any snapshot *does* move, that is a bug in the slice, not an accepted change: the commit's
contract is **zero snapshot diffs**. The Roslyn meta-test (compiles + executes emitted C#) is the
second gate — emitted invariants must still throw `DomainInvariantViolationException` identically.

### Laziness, threading, performance

`SemanticModel` gains a fourth lazily-built artifact, with the **same** `LazyThreadSafetyMode.
ExecutionAndPublication` discipline as `_graph` (Commit 1) and `_binding` (Commit 3):

```csharp
private readonly Lazy<BoundModel> _bound;

public SemanticModel(KoineModel model)
{
    …
    _bound = new Lazy<BoundModel>(() => BoundModel.Build(this), LazyThreadSafetyMode.ExecutionAndPublication);
}

/// <summary>The lowered invariants of a value object (the migrated slice's entry point).</summary>
internal IReadOnlyList<BoundInvariant> BoundInvariantsFor(ValueObjectDecl vo) => _bound.Value.InvariantsFor(vo);
```

- **Off the un-migrated emit path entirely.** Only the VO-invariant slice forces `_bound`; everything
  else in `CSharpEmitter` and all of the TS emitter never touch it, so they pay nothing.
- `BoundModel.Build` lowers **only** what the slice consumes in this commit (VO invariants),
  reference-keyed by `ValueObjectDecl` using the **BCL `ReferenceEqualityComparer.Instance`** (same
  comparer Commit 3 adopted — the recurring value-equality-record discipline, **4th incarnation**: two
  identically-named VOs across R13.2 contexts are value-equal as records and would collide to one cache
  entry without it). It can grow to cover more declarations as future slices migrate, without changing
  the `SemanticModel` surface.
- The lowerer reuses the already-lazy Commit-3 binder (`GetSymbolInfo`) and the shared `ModelIndex`
  (`GetTypeInfo`); it adds one more single-pass walk over VO invariant conditions, amortized once per
  `SemanticModel`.

## Files

- **New:** `src/Koine.Compiler/Ast/Bound/BoundNodes.cs` — the `BoundNode`/`BoundExpression`
  hierarchy + `BoundInvariant`. TARGET-AGNOSTIC, immutable records, `Syntax` back-pointer, resolved
  `Type`/`Symbol`.
- **New:** `src/Koine.Compiler/Ast/Bound/Lowerer.cs` — `KoineSyntaxVisitor<BoundNode>` that lowers a
  resolved subtree (the VO-invariant forms) to bound nodes; hosts the **relocated-verbatim** `SourceText`
  / `SourceTextVisitor` helper (the Koine-source round-trip used by the C# message default). Renders
  Koine syntax only — TARGET-AGNOSTIC.
- **New:** `src/Koine.Compiler/Ast/Bound/BoundModel.cs` — the per-`SemanticModel` bound artifact:
  lowers + caches VO invariants reference-keyed by `ValueObjectDecl`; `InvariantsFor(vo)`.
  TARGET-AGNOSTIC.
- **Modify:** `src/Koine.Compiler/Ast/SemanticModel.cs` — add the thread-safe lazy `_bound`; add the
  internal `BoundInvariantsFor(ValueObjectDecl)` slice entry point. (No change to existing methods.)
- **Modify:** `src/Koine.Compiler/Emit/CSharp/CSharpEmitter.cs` /
  `CSharpEmitter.ValueObjects.cs` — add a **new `BoundInvariant` overload** of `WriteInvariantGuards`/
  `WriteGuard` that the VO path calls (condition `Syntax` + final C# message off the bound node;
  rendering via the **unchanged** translator). `SourceText`/`SourceTextVisitor` move out to
  `Ast/Bound/` (the C# `SynthesizeMessage` one-liner now reads the bound `Message`). **Only the
  VO-invariant path changes**; the entity-invariant (`:948`) and command-`requires` (`:1192`) callers
  keep the **existing raw-`Invariant` overload unchanged** — additive overload, NOT a signature
  replacement (replacing would force-migrate those out-of-scope paths).
- **Unchanged, intentionally:** `ModelIndex.cs`, `TypeResolver.cs`, `KoineType.cs`, the entire
  `Emit/TypeScript/`, and every other `Emit/CSharp/` path. No signature of a TS-consumed type
  changes.
- **New:** `tests/Koine.Compiler.Tests/BoundIrLoweringTests.cs` — bound-tree construction +
  byte-equivalence tests.

## Testing

Match the stack (xUnit v2 plain asserts; Verify snapshots are the byte-equivalence oracle for the
slice; the Roslyn meta-test compiles + runs the emitted C#).

1. **Bound-tree resolution (the layer is real, not dead).** Over the example `.koi` corpus, for every
   value object with invariants, build `BoundInvariantsFor(vo)` and assert: each `BoundInvariant.
   Condition` is a `BoundExpression` whose `Type` is non-null (`ErrorType` only where the syntactic
   resolver also yields error); every `BoundReference` carries a Commit-3 interned `Symbol` that is
   `Assert.Same` as `GetSymbolInfo(thatReferenceNode)` (identity flows from the binder, not re-looked-
   up); every bound node's `Syntax` is the `KoineNode` it was lowered from.
2. **Message-default lowering (the desugaring is absorbed).** For an invariant with an explicit
   message, `BoundInvariant.Message` equals that message; for one without, it equals
   `SynthesizeMessage(inv.Condition)` — proving the `?? SynthesizeMessage` default now lives in the
   lowerer and produces the identical text the emitter used to.
3. **Reference-key identity (the recurring value-equality hazard, 4th incarnation).** A VO with two
   invariants each referencing `amount` → the two `BoundReference`s bind to the same interned
   `MemberSymbol` (`Assert.Same`), and `BoundModel`'s `ValueObjectDecl`-keyed cache uses the BCL
   `ReferenceEqualityComparer.Instance` (two distinct VOs named identically across R13.2 contexts are
   value-equal records and must NOT collide). A dedicated assertion builds two same-named VOs in
   different contexts and confirms distinct cache entries — fails loudly if the comparer is dropped.
4. **Byte-identical snapshots (the slice's contract).** The full Verify snapshot suite
   (`Snapshots/`, `Conformance/Snapshots/`) stays green with **zero** `.received.txt` diffs after the
   VO-invariant slice is retargeted — the end-to-end proof that the bound path emits the same C# for
   every VO invariant in the corpus.
5. **Roslyn meta-test (behavioral equivalence).** The in-memory compile-and-execute meta-test stays
   green: emitted value objects still throw `DomainInvariantViolationException` with the identical
   `rule:` message on a violated invariant — proving the relocated message synthesis and the bound
   condition rendering are behavior-preserving.
6. **Lowerer coverage / no-throw.** A hand-built model exercising every expression form reachable
   from a VO invariant (binary, unary, `matches`, `when`-guard, member access, built-in call,
   conditional, coalesce, literal) lowers without throwing and produces the expected bound shape;
   an invariant referencing an unknown name lowers to a `BoundReference(ErrorSymbol)` (no throw),
   matching the binder.
7. **Whole suite green.** `./build.sh` (~500 tests) — the un-migrated emitter paths and the TS
   emitter are unaffected, and the new `Ast/Bound/` types build and run.

## Non-goals (guard rails)

- **No full emitter migration.** Exactly one slice (value-object invariant guards) is retargeted onto
  the bound tree. Entity/command/factory/CQRS/state-machine/operator/field-projection paths keep
  re-deriving from the AST, unchanged. Migrating them is a deliberate FUTURE multi-commit effort.
- **No TypeScript emitter changes.** `Emit/TypeScript/` is untouched. The bound tree is additive and
  *available* to it as a future shared layer, but this commit neither modifies nor depends on it.
- **No `ModelIndex` / `TypeResolver` / `KoineType` signature changes.** The lowerer *consumes* them
  (`GetTypeInfo`, `GetSymbolInfo`) — it does not alter them. Zero conflict with the shipped TS emitter.
- **No C# concept in `Ast/Bound/`.** The bound tree is target-agnostic; the `Op`/`Kind`/`LiteralKind`
  it carries are the same target-neutral enums the AST uses. No C# rendering, naming, or type mapping
  enters `Ast/`. The relocated `SourceText`/`SourceTextVisitor` renders **Koine** source syntax only
  (verified: `ExprVisitor<string>` emitting Koine keywords) — it is the one borderline helper and a
  reviewer must confirm it contains no target string.
- **No baked cross-target presentation in `Ast/Bound/`.** `BoundInvariant.Message` carries the **C#
  message default** (the relocated Koine round-trip), NOT a single authoritative message for all
  targets — the existence of TS's different `"invariant failed"` policy proves message synthesis is a
  per-target *presentation* decision. The bound tree must not freeze one target's presentation as the
  canonical one; cross-target message unification is a separate future design. (The positive
  `Condition` is the genuinely-shared, target-neutral payload.)
- **`Syntax` back-pointer convention for synthesized nodes (documented now).** Every bound node carries
  `Syntax` (Roslyn `BoundNode.Syntax`). For nodes with a 1:1 syntactic origin (**all** nodes in *this*
  slice) it is that origin `KoineNode`. For *future* truly-synthesized nodes (no syntactic origin),
  `Syntax` is the **nearest meaningful enclosing node** — the Roslyn convention. The risk is latent
  this commit (every bound node has a real origin) but the convention is pinned before later slices
  introduce synthesized nodes.
- **No negation/guard normalization in the bound tree (yet).** `TranslateNegated` and the
  `GuardExpr` failure-test split stay in the C# emitter — they are C#-rendering choices, not
  target-agnostic desugarings. A future `BoundNegation` is its own commit.
- **No new diagnostics.** Lowering runs after validation, on already-validated models; unresolved
  references become `ErrorSymbol`/`ErrorType` in bound nodes, never throws or re-reported diagnostics
  (mirroring Commit 3's binder).
- **No driving the translator from bound nodes in this commit.** The translator still renders from
  the syntactic `Expr` (via `BoundInvariant.Syntax`) to guarantee byte-identical output; rendering
  from bound nodes is the next slice, proven incrementally.

## What this unlocks

- **The shared lowering layer both emitters wanted (future, opt-in).** Once the bound tree drives
  rendering (the follow-up slices), the C# and TypeScript emitters *could* consume **one** resolved,
  desugared IR instead of each re-resolving types, re-classifying names, and re-synthesizing
  messages/guards. **This commit does not wire TS up** — and message synthesis specifically stays
  per-target (TS keeps `"invariant failed"`); a shared IR is *available*, not imposed. The structural
  payoff is that a new backend *may* lower from `BoundNode` rather than raw syntax + side tables.
- **Incremental emitter migration becomes a sequence of bounded, snapshot-proven slices.** With the
  layer, `BoundModel`, byte-equivalence harness, and wiring established here, each subsequent slice
  (VO field projection → entity members → command bodies → CQRS) is the same shape: add bound forms +
  lowerings, retarget one call site, prove zero snapshot drift.
- **Bound-tree-driven analysis and refactors.** With `KoineSyntaxRewriter` (Commit 2) + symbol
  identity (Commit 3) + a resolved bound tree, later features (constant folding, dead-invariant
  detection, cross-target optimization, precise quick-fixes) operate on a fully-resolved IR rather
  than re-deriving semantics — the Roslyn capability that string/AST-walking structurally cannot
  provide.
- **Diagnostics over resolved semantics.** Because every bound node carries `Syntax`, a future
  validator pass could run on the bound tree and still point diagnostics at real source — letting the
  validator consume the binder's `ErrorSymbol`s (the unlock noted in Commit 3) on a lowered tree.
```
