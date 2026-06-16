using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// Decides whether an expression uses a LINQ-backed operation, so the file's <c>using</c>
/// block includes <c>System.Linq</c> exactly when needed. <c>.Count</c> (a property) and
/// <c>.Count()</c> (a LINQ call) are not distinguishable by a token scan, so this structural
/// check drives the decision instead.
///
/// <para>Stateless and reusable via <see cref="Instance"/>. Exhaustive by construction
/// (<see cref="ExprVisitor{T}"/>): every node is considered, so a node wrapping a LINQ call
/// (e.g. <c>??</c> or <c>let … in …</c>) can no longer silently hide it.</para>
/// </summary>
internal sealed class LinqUsageVisitor : ExprVisitor<bool>
{
    public static readonly LinqUsageVisitor Instance = new();

    private LinqUsageVisitor() { }

    protected override bool VisitCall(CallExpr n) =>
        BuiltinOps.TakesLambda(n.Method) || n.Method == "contains"
        || Visit(n.Target) || n.Args.Any(Visit);

    protected override bool VisitLambda(LambdaExpr n) => Visit(n.Body);

    protected override bool VisitBinary(BinaryExpr n) => Visit(n.Left) || Visit(n.Right);

    protected override bool VisitUnary(UnaryExpr n) => Visit(n.Operand);

    protected override bool VisitMemberAccess(MemberAccessExpr n) => Visit(n.Target);

    protected override bool VisitConditional(ConditionalExpr n) => Visit(n.Condition) || Visit(n.Then) || Visit(n.Else);

    protected override bool VisitCoalesce(CoalesceExpr n) => Visit(n.Left) || Visit(n.Right);

    protected override bool VisitGuard(GuardExpr n) => Visit(n.Body) || Visit(n.Condition);

    protected override bool VisitMatch(MatchExpr n) => Visit(n.Target);

    protected override bool VisitLet(LetExpr n) => n.Bindings.Any(b => Visit(b.Value)) || Visit(n.Body);

    protected override bool VisitIdentifier(IdentifierExpr n) => false;

    protected override bool VisitLiteral(LiteralExpr n) => false;
}
