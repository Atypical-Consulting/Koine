using System.Diagnostics;

namespace Koine.Compiler.Ast;

/// <summary>
/// A read-only, depth-first walk over the expression sublanguage. Dispatch lives in a
/// central <see cref="Visit"/> switch here (NOT an <c>Accept</c> method on the nodes), so
/// <c>Expressions.cs</c> stays target-agnostic and free of visitor coupling.
///
/// <para>Each per-node hook defaults to recursing into that node's children, so a subclass
/// overrides ONLY the cases it cares about and calls <c>base.VisitX(node)</c> to keep
/// recursing. Adding a new <see cref="Expr"/> subtype forces one new arm in the central
/// switch (the <see cref="UnreachableException"/> default makes a missing arm fail loudly,
/// not silently).</para>
///
/// <para>Use this for collectors that accumulate into instance state. It is intentionally
/// NOT suited to position- or flow-sensitive traversals — the C# expression translator
/// (parenthesization / negation rewrites) and the semantic <c>ExpressionChecker</c>
/// (per-branch scope narrowing, short-circuiting children) stay hand-rolled. For a
/// value-producing, exhaustive traversal use <see cref="ExprVisitor{T}"/>.</para>
/// </summary>
public abstract class ExprWalker
{
    /// <summary>Dispatches to the per-node hook for <paramref name="e"/>'s runtime type.</summary>
    public virtual void Visit(Expr e)
    {
        switch (e)
        {
            case BinaryExpr b: VisitBinary(b); break;
            case UnaryExpr u: VisitUnary(u); break;
            case MatchExpr m: VisitMatch(m); break;
            case GuardExpr g: VisitGuard(g); break;
            case MemberAccessExpr ma: VisitMemberAccess(ma); break;
            case CallExpr c: VisitCall(c); break;
            case LambdaExpr l: VisitLambda(l); break;
            case ConditionalExpr cd: VisitConditional(cd); break;
            case CoalesceExpr co: VisitCoalesce(co); break;
            case IdentifierExpr id: VisitIdentifier(id); break;
            case LetExpr let: VisitLet(let); break;
            case LiteralExpr lit: VisitLiteral(lit); break;
            default: throw new UnreachableException($"Unhandled Expr node: {e.GetType().Name}");
        }
    }

    protected virtual void VisitBinary(BinaryExpr n) { Visit(n.Left); Visit(n.Right); }

    protected virtual void VisitUnary(UnaryExpr n) => Visit(n.Operand);

    protected virtual void VisitMatch(MatchExpr n) => Visit(n.Target);

    protected virtual void VisitGuard(GuardExpr n) { Visit(n.Body); Visit(n.Condition); }

    protected virtual void VisitMemberAccess(MemberAccessExpr n) => Visit(n.Target);

    protected virtual void VisitCall(CallExpr n)
    {
        Visit(n.Target);
        foreach (Expr arg in n.Args)
        {
            Visit(arg);
        }
    }

    protected virtual void VisitLambda(LambdaExpr n) => Visit(n.Body);

    protected virtual void VisitConditional(ConditionalExpr n) { Visit(n.Condition); Visit(n.Then); Visit(n.Else); }

    protected virtual void VisitCoalesce(CoalesceExpr n) { Visit(n.Left); Visit(n.Right); }

    protected virtual void VisitLet(LetExpr n)
    {
        foreach (LetBinding b in n.Bindings)
        {
            Visit(b.Value);
        }

        Visit(n.Body);
    }

    /// <summary>A leaf: no children to recurse into.</summary>
    protected virtual void VisitIdentifier(IdentifierExpr n) { }

    /// <summary>A leaf: no children to recurse into.</summary>
    protected virtual void VisitLiteral(LiteralExpr n) { }
}
