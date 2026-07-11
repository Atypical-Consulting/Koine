using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit;

/// <summary>
/// Shared, target-agnostic expression-to-string renderer for the Markdown documentation surfaces
/// (the glossary and the living docs). Renders guards, invariants, preconditions, and conditions
/// in compact source-like syntax. Exhaustive over every <see cref="Expr"/> subclass via the
/// <see cref="ExprVisitor{T}"/> base dispatch — including <c>let … in …</c> — so nothing collapses
/// to an ellipsis placeholder. Both <c>GlossaryEmitter</c> and <c>DocsEmitter</c> consume this one
/// implementation rather than duplicating it.
/// </summary>
public sealed class ExprDescriber : ExprVisitor<string>
{
    private static readonly ExprDescriber Instance = new();

    private ExprDescriber() { }

    /// <summary>A compact, target-agnostic rendering of an expression.</summary>
    public static string Describe(Expr e) => Instance.Visit(e);

    protected override string VisitIdentifier(IdentifierExpr n) => n.Name;

    protected override string VisitLiteral(LiteralExpr n) =>
        n.Kind == LiteralKind.String ? $"\"{n.Text}\"" : n.Text;

    protected override string VisitMemberAccess(MemberAccessExpr n) => $"{Visit(n.Target)}.{n.MemberName}";

    protected override string VisitCall(CallExpr n) =>
        $"{Visit(n.Target)}.{n.Method}({string.Join(", ", n.Args.Select(Visit))})";

    protected override string VisitLambda(LambdaExpr n) => $"{n.Parameter} => {Visit(n.Body)}";

    protected override string VisitConditional(ConditionalExpr n) =>
        $"if {Visit(n.Condition)} then {Visit(n.Then)} else {Visit(n.Else)}";

    protected override string VisitCoalesce(CoalesceExpr n) => $"{Visit(n.Left)} ?? {Visit(n.Right)}";

    protected override string VisitUnary(UnaryExpr n) => (n.Op == UnaryOp.Not ? "!" : "-") + Visit(n.Operand);

    protected override string VisitBinary(BinaryExpr n) => $"{Visit(n.Left)} {n.Op.Symbol()} {Visit(n.Right)}";

    protected override string VisitMatch(MatchExpr n) => $"{Visit(n.Target)} matches /{n.Pattern}/";

    protected override string VisitGuard(GuardExpr n) => $"{Visit(n.Body)} when {Visit(n.Condition)}";

    protected override string VisitLet(LetExpr n) =>
        $"let {string.Join(", ", n.Bindings.Select(b => $"{b.Name} = {Visit(b.Value)}"))} in {Visit(n.Body)}";
}
