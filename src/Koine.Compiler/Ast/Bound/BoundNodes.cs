namespace Koine.Compiler.Ast.Bound;

// ============================================================================
// The bound (resolved + lowered) intermediate tree — Roslyn's BoundNode analogue,
// distinct from the syntactic KoineNode hierarchy. TARGET-AGNOSTIC: no C#/TS
// rendering, naming, or type-mapping concept appears here. Every bound expression
// carries its resolved KoineType; every reference carries the interned Commit-3
// Symbol; every node keeps a back-pointer to the Syntax it was lowered from.
//
// This commit introduces ONLY the forms reachable from a value-object invariant
// condition (the one migrated emitter slice). Other declaration/expression forms
// are added by the slices that need them, to avoid unused-form churn.
// ============================================================================

/// <summary>
/// Base of the resolved, lowered intermediate tree (Roslyn <c>BoundNode</c> analogue). Distinct from
/// the syntactic <see cref="KoineNode"/> hierarchy. TARGET-AGNOSTIC.
/// </summary>
public abstract record BoundNode
{
    /// <summary>
    /// The syntax this node was lowered from (Roslyn <c>BoundNode.Syntax</c>) — for
    /// diagnostics/navigation. For every node in this slice it is the 1:1 syntactic origin; a future
    /// truly-synthesized node would carry the nearest meaningful enclosing node (the Roslyn convention).
    /// </summary>
    public required KoineNode Syntax { get; init; }
}

/// <summary>
/// A resolved expression: carries its <see cref="KoineType"/> (never <c>null</c> —
/// <see cref="ErrorType"/> for undeterminable, mirroring the resolver). Roslyn
/// <c>BoundExpression</c> analogue.
/// </summary>
public abstract record BoundExpression : BoundNode
{
    public required KoineType Type { get; init; }
}

// --- the canonical, lowered expression forms this slice needs ---

/// <summary>A binary op over two bound operands. <see cref="Op"/> is the target-agnostic <see cref="BinaryOp"/>.</summary>
public sealed record BoundBinary(BinaryOp Op, BoundExpression Left, BoundExpression Right) : BoundExpression;

/// <summary>A unary op over a bound operand.</summary>
public sealed record BoundUnary(UnaryOp Op, BoundExpression Operand) : BoundExpression;

/// <summary>
/// A resolved reference to a declaration: the <see cref="Symbol"/> is the Commit-3 interned identity
/// (member / parameter / local / enum member / id-VO), or <see cref="ErrorSymbol.Instance"/> for an
/// unresolved name (mirroring the binder — lowering never throws on an unresolved reference).
/// </summary>
public sealed record BoundReference(Symbol Symbol) : BoundExpression;

/// <summary>A literal carried through verbatim (kind + canonical text).</summary>
public sealed record BoundLiteral(LiteralKind Kind, string Text) : BoundExpression;

/// <summary>
/// A member access on a resolved receiver; <see cref="Member"/> is the selector symbol (Commit-3
/// best-effort — the binder does not bind member-access selectors, so it is
/// <see cref="ErrorSymbol.Instance"/> today) and <see cref="MemberName"/> the selected name.
/// </summary>
public sealed record BoundMemberAccess(BoundExpression Receiver, string MemberName, Symbol Member) : BoundExpression;

/// <summary>
/// A call on a resolved receiver (a built-in predicate/operation by name — built-ins have no symbol).
/// </summary>
public sealed record BoundCall(BoundExpression Receiver, string Method, IReadOnlyList<BoundExpression> Args) : BoundExpression;

/// <summary>A conditional (ternary): <c>if Condition then Then else Else</c>.</summary>
public sealed record BoundConditional(BoundExpression Condition, BoundExpression Then, BoundExpression Else) : BoundExpression;

/// <summary>Null-coalescing: <c>Left ?? Right</c>.</summary>
public sealed record BoundCoalesce(BoundExpression Left, BoundExpression Right) : BoundExpression;

/// <summary>A regex match: <c>Target matches /Pattern/</c>. <see cref="Pattern"/> is the body without slashes.</summary>
public sealed record BoundMatch(BoundExpression Target, string Pattern) : BoundExpression;

/// <summary>A guarded expression: <c>Body when Condition</c> (the invariant only needs to hold when the guard is true).</summary>
public sealed record BoundGuard(BoundExpression Body, BoundExpression Condition) : BoundExpression;

/// <summary>A single <c>name = value</c> binding of a <see cref="BoundLet"/>.</summary>
public sealed record BoundLetBinding(string Name, BoundExpression Value) : BoundNode;

/// <summary>Expression-local bindings: <c>let &lt;bindings&gt; in Body</c>.</summary>
public sealed record BoundLet(IReadOnlyList<BoundLetBinding> Bindings, BoundExpression Body) : BoundExpression;

/// <summary>
/// A single-parameter lambda selector/predicate: <c>Parameter =&gt; Body</c>. Defined because a
/// collection-aggregate call (<c>lines.all(l =&gt; …)</c>) can be reachable from a VO invariant.
/// </summary>
public sealed record BoundLambda(string Parameter, BoundExpression Body) : BoundExpression;

// --- bound member / declaration forms (the non-expression part of the IR) ---

/// <summary>
/// A value-object invariant lowered to its canonical form: a resolved boolean condition plus the FINAL
/// <b>C# default</b> message (the <c>?? SourceText(condition)</c> default already applied) — so the C#
/// emitter no longer re-derives it. NOTE: this is the C# message policy; other targets (TS) synthesize
/// their own message and do NOT consume this field (the positive <see cref="Condition"/> is the
/// genuinely-shared, target-neutral payload).
/// </summary>
public sealed record BoundInvariant(BoundExpression Condition, string Message) : BoundNode;
