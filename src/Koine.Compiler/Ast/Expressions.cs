namespace Koine.Compiler.Ast;

// ============================================================================
// The pure expression sublanguage: comparisons, arithmetic, logical operators,
// member access, regex match, a `when` guard, identifiers and literals.
// No statements, no I/O. TARGET-AGNOSTIC.
// ============================================================================

/// <summary>Base type for every expression node.</summary>
public abstract record Expr : KoineNode;

public enum BinaryOp
{
    Or, And,
    Eq, Neq,
    Lt, Le, Gt, Ge,
    Add, Sub, Mul, Div
}

public enum UnaryOp { Not, Negate }

public enum LiteralKind { Int, Decimal, String, Bool }

/// <summary>A binary operation: <c>left op right</c>.</summary>
public sealed record BinaryExpr(BinaryOp Op, Expr Left, Expr Right) : Expr;

/// <summary>A prefix unary operation: <c>op operand</c>.</summary>
public sealed record UnaryExpr(UnaryOp Op, Expr Operand) : Expr;

/// <summary>
/// A regex match: <c>target matches /pattern/</c>. <see cref="Pattern"/> is the
/// regex body WITHOUT the surrounding slashes.
/// </summary>
public sealed record MatchExpr(Expr Target, string Pattern) : Expr;

/// <summary>
/// A guarded expression: <c>Body when Condition</c>. The invariant
/// <see cref="Body"/> only needs to hold when <see cref="Condition"/> is true.
/// </summary>
public sealed record GuardExpr(Expr Body, Expr Condition) : Expr;

/// <summary>Member access: <c>target.MemberName</c> (e.g. <c>lines.isEmpty</c>).</summary>
public sealed record MemberAccessExpr(Expr Target, string MemberName) : Expr;

/// <summary>
/// An operation call on a receiver: <c>target.Method(arg, ...)</c>, e.g.
/// <c>code.startsWith("X")</c> or <c>lines.all(l =&gt; l.quantity &gt; 0)</c>.
/// Distinct from <see cref="MemberAccessExpr"/> (which is the no-parentheses
/// form). The set of legal methods is decided by the semantic/emit layers, not
/// the grammar.
/// </summary>
public sealed record CallExpr(Expr Target, string Method, IReadOnlyList<Expr> Args) : Expr;

/// <summary>
/// A single-parameter lambda used as a collection-operation selector/predicate:
/// <c>param =&gt; body</c>. The parameter is bound to the receiver collection's
/// element type. Appears only as an argument to a <see cref="CallExpr"/>.
/// </summary>
public sealed record LambdaExpr(string Parameter, Expr Body) : Expr;

/// <summary>
/// A conditional (ternary) expression: <c>if Condition then Then else Else</c>.
/// Carries no C# concepts; the emitter renders a parenthesized C# ternary.
/// </summary>
public sealed record ConditionalExpr(Expr Condition, Expr Then, Expr Else) : Expr;

/// <summary>
/// Null-coalescing: <c>Left ?? Right</c>. The result takes <see cref="Left"/>'s
/// value unless it is absent, in which case <see cref="Right"/>. The result type
/// is non-optional.
/// </summary>
public sealed record CoalesceExpr(Expr Left, Expr Right) : Expr;

/// <summary>A bare identifier: a field reference or an enum-member reference.</summary>
public sealed record IdentifierExpr(string Name) : Expr;

/// <summary>
/// Expression-local bindings: <c>let x = e (, y = e)* in body</c>. Each binding
/// is in scope for the bindings that follow it and for <see cref="Body"/>;
/// bindings see only earlier ones (sequential, like C# locals). The whole node is
/// an expression and nests anywhere a value is expected.
/// </summary>
public sealed record LetExpr(IReadOnlyList<LetBinding> Bindings, Expr Body) : Expr;

/// <summary>
/// A single <c>name = value</c> binding inside a <see cref="LetExpr"/>. A <see cref="KoineNode"/>
/// so the position→node walk descends into <see cref="Value"/> (making references inside a binding
/// navigable); <see cref="KoineNode.NameSpan"/> covers the introduced <see cref="Name"/>.
/// </summary>
public sealed record LetBinding(string Name, Expr Value) : KoineNode;

/// <summary>
/// A literal. <see cref="Text"/> is the canonical source text of the value:
/// for <see cref="LiteralKind.String"/> it is the UNESCAPED content without the
/// surrounding quotes; for numbers and booleans it is the literal as written.
/// </summary>
public sealed record LiteralExpr(LiteralKind Kind, string Text) : Expr;
