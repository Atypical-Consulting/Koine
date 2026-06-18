namespace Koine.Compiler.Ast.Bound;

// ============================================================================
// The bound (resolved + lowered) intermediate tree — Roslyn's BoundNode analogue,
// distinct from the syntactic KoineNode hierarchy. TARGET-AGNOSTIC: no C#/TS
// rendering, naming, or type-mapping concept appears here. Every bound expression
// carries its resolved KoineType; every reference carries the interned Commit-3
// Symbol; every node keeps a back-pointer to the Syntax it was lowered from.
//
// The forms here cover the value-object slice: the expression forms reachable from a
// VO invariant condition or derived-member body (Commits 4 & 6), plus the VO field
// projection / invariant declaration forms (Commit 5). The C# emitter consumes both —
// projection (fields, defaults, ordering, collection shape) AND resolved expression
// types (enum hints, aggregate selector + let body types) — from these nodes rather
// than re-deriving them. Other declaration/expression forms (entities, commands, …)
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

/// <summary>
/// How a value-object field participates in construction (Commit 5). TARGET-NEUTRAL classification — it
/// names the field's role, not any C# rendering. A <see cref="CtorParam"/> is a stored field initialized
/// from a constructor parameter; a <see cref="Derived"/> field is a computed read-only projection over its
/// siblings (excluded from the constructor). Replaces the per-emit <c>MemberAnalysis.IsDerived</c> walk.
/// </summary>
public enum FieldKind
{
    /// <summary>A stored field, initialized from a constructor parameter.</summary>
    CtorParam,

    /// <summary>A computed read-only projection over sibling fields (not a constructor parameter).</summary>
    Derived
}

/// <summary>
/// The default-value disposition of a value-object constructor field (Commit 5). TARGET-NEUTRAL — it names
/// WHAT kind of default the field has, not how any target spells it. Pre-classifies what the C# emitter
/// previously re-derived in <c>FormatParam</c>/<c>WriteEnumDefaultCoalesce</c>. Only meaningful for
/// <see cref="FieldKind.CtorParam"/> fields; a <see cref="FieldKind.Derived"/> field is always
/// <see cref="None"/>.
/// </summary>
public enum DefaultKind
{
    /// <summary>Required: no initializer and not optional — the field has no constructor default.</summary>
    None,

    /// <summary>A constant initializer usable as a compile-time default (e.g. a number, string, or non-enum value).</summary>
    ConstantDefault,

    /// <summary>An enum-typed initializer — not a compile-time constant, so a target may need a nullable param + coalesce.</summary>
    EnumDefault,

    /// <summary>Optional with no initializer — defaults to the absent value (omittable).</summary>
    OptionalNull
}

/// <summary>
/// The collection shape of a value-object field (Commit 5), for defensive-copy and structural-equality
/// decisions. TARGET-NEUTRAL — derived from the resolved type, mirroring <c>ModelIndex</c>'s
/// List/Set/Map type names. <see cref="None"/> for a scalar.
/// </summary>
public enum CollectionShape
{
    /// <summary>A scalar (non-collection) field.</summary>
    None,

    /// <summary>An ordered list.</summary>
    List,

    /// <summary>An unordered set.</summary>
    Set,

    /// <summary>A keyed map.</summary>
    Map
}

/// <summary>
/// A value-object field lowered to its canonical, resolved form (Commit 5): its <see cref="FieldKind"/>
/// (ctor-param vs derived), <see cref="DefaultKind"/> default disposition, <see cref="CollectionShape"/>,
/// and resolved <see cref="Type"/> — the classification the C# (and future TS) emitter previously
/// re-derived from raw syntax on every emit. For a derived field, <see cref="DerivedInitializer"/> is the
/// lowered initializer body (else <c>null</c>). <see cref="BoundNode.Syntax"/> back-points to the
/// originating <see cref="Member"/> so a target can still map the syntactic type for its own rendering
/// without a C# concept leaking into this node. TARGET-AGNOSTIC.
/// </summary>
public sealed record BoundField(
    string Name,
    FieldKind Kind,
    DefaultKind DefaultKind,
    CollectionShape CollectionShape,
    BoundExpression? DerivedInitializer) : BoundNode
{
    /// <summary>The resolved member type — the genuinely-shared payload a future TS emitter consumes.</summary>
    public required KoineType Type { get; init; }
}

/// <summary>
/// A value object projected to its canonical, resolved field model plus its lowered invariants (Commit 5):
/// one <see cref="BoundField"/> per declared member (in declaration order) and the
/// <see cref="BoundInvariant"/> list (the Commit-4 slice, folded in). TARGET-AGNOSTIC.
/// <para><see cref="CtorParams"/> exposes the constructor parameters in canonical order — fields without a
/// default first, defaulted/optional fields last, declaration order preserved within each group (a
/// target-neutral policy most languages share). This is the relocated, byte-faithful equivalent of the
/// emitter's former <c>OrderCtorParams</c>; <see cref="StoredFields"/>/<see cref="DerivedFields"/> stay in
/// declaration order for property/equality/ToString emission.</para>
/// </summary>
public sealed record BoundValueObject(
    IReadOnlyList<BoundField> Fields,
    IReadOnlyList<BoundInvariant> Invariants) : BoundNode
{
    /// <summary>The non-derived (stored) fields, in declaration order.</summary>
    public IEnumerable<BoundField> StoredFields => Fields.Where(f => f.Kind == FieldKind.CtorParam);

    /// <summary>The derived (computed) fields, in declaration order.</summary>
    public IEnumerable<BoundField> DerivedFields => Fields.Where(f => f.Kind == FieldKind.Derived);

    /// <summary>
    /// The constructor parameters in canonical order: required fields first, defaulted/optional fields
    /// last (stable within each group). A byte-faithful relocation of the emitter's former
    /// <c>OrderCtorParams</c> (a stable <c>OrderBy</c> on "has a default"), now owned by the projection.
    /// </summary>
    public IEnumerable<BoundField> CtorParams =>
        StoredFields.OrderBy(f => f.DefaultKind == DefaultKind.None ? 0 : 1);
}
