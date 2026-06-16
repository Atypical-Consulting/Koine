using System.Diagnostics;

namespace Koine.Compiler.Ast;

/// <summary>
/// A value-producing, exhaustive traversal over the expression sublanguage: every node
/// maps to a result of type <typeparamref name="T"/>. Dispatch lives in a central
/// <see cref="Visit"/> switch here (NOT an <c>Accept</c> method on the nodes), so
/// <c>Expressions.cs</c> stays target-agnostic and free of visitor coupling.
///
/// <para>The per-node hooks are <b>abstract</b> on purpose: that is the exhaustiveness
/// lever. Adding a new <see cref="Expr"/> subtype forces one new arm in the central switch
/// AND a new method on every <see cref="ExprVisitor{T}"/> subclass — a compile error rather
/// than a silently-dropped node. (Several former hand-rolled switches used a <c>_ =&gt;</c>
/// fallback that silently mishandled <see cref="CoalesceExpr"/>/<see cref="LetExpr"/>; this
/// design makes that class of bug impossible.)</para>
///
/// <para>For a read-only walk that recurses by default, use <see cref="ExprWalker"/>.
/// Position- or flow-sensitive traversals (the C# expression translator, the semantic
/// <c>ExpressionChecker</c>) intentionally stay hand-rolled — a uniform visitor fights
/// their control flow.</para>
/// </summary>
public abstract class ExprVisitor<T>
{
    /// <summary>Dispatches to the per-node hook for <paramref name="e"/>'s runtime type.</summary>
    public T Visit(Expr e) => e switch
    {
        BinaryExpr b => VisitBinary(b),
        UnaryExpr u => VisitUnary(u),
        MatchExpr m => VisitMatch(m),
        GuardExpr g => VisitGuard(g),
        MemberAccessExpr ma => VisitMemberAccess(ma),
        CallExpr c => VisitCall(c),
        LambdaExpr l => VisitLambda(l),
        ConditionalExpr cd => VisitConditional(cd),
        CoalesceExpr co => VisitCoalesce(co),
        IdentifierExpr id => VisitIdentifier(id),
        LetExpr let => VisitLet(let),
        LiteralExpr lit => VisitLiteral(lit),
        _ => throw new UnreachableException($"Unhandled Expr node: {e.GetType().Name}")
    };

    protected abstract T VisitBinary(BinaryExpr n);
    protected abstract T VisitUnary(UnaryExpr n);
    protected abstract T VisitMatch(MatchExpr n);
    protected abstract T VisitGuard(GuardExpr n);
    protected abstract T VisitMemberAccess(MemberAccessExpr n);
    protected abstract T VisitCall(CallExpr n);
    protected abstract T VisitLambda(LambdaExpr n);
    protected abstract T VisitConditional(ConditionalExpr n);
    protected abstract T VisitCoalesce(CoalesceExpr n);
    protected abstract T VisitIdentifier(IdentifierExpr n);
    protected abstract T VisitLet(LetExpr n);
    protected abstract T VisitLiteral(LiteralExpr n);
}
