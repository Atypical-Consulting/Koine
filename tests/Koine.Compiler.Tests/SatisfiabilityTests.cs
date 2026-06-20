using System.Globalization;
using Koine.Compiler.Ast;
using Koine.Compiler.Ast.Bound;
using Koine.Compiler.Semantics;

namespace Koine.Compiler.Tests;

/// <summary>
/// Thread B of issue #73 — invariant satisfiability: constant folding over the bound IR (B1) and the
/// contradiction checks the <see cref="SatisfiabilityChecker"/> reports (B2), plus the guard test (B3)
/// pinning exhaustiveness as codegen's job, not the analyzer's.
/// </summary>
public class SatisfiabilityTests
{
    // ----------------------------------------------------------------------
    // B1 — constant folding over bound expressions.
    // ----------------------------------------------------------------------

    private static readonly KoineNode Stx = new IdentifierExpr("_");
    private static readonly KoineType IntTy = new PrimitiveType("Int");

    private static BoundLiteral Int(int n) =>
        new(LiteralKind.Int, n.ToString(CultureInfo.InvariantCulture)) { Syntax = Stx, Type = IntTy };

    private static BoundBinary Bin(BinaryOp op, BoundExpression l, BoundExpression r) =>
        new(op, l, r) { Syntax = Stx, Type = IntTy };

    [Fact]
    public void ConstantFolder_FoldsArithmetic()
    {
        // 2 + 3 * 4 == 14
        BoundExpression expr = Bin(BinaryOp.Add, Int(2), Bin(BinaryOp.Mul, Int(3), Int(4)));

        ConstantValue? folded = ConstantFolder.Fold(expr);

        var num = folded.ShouldBeOfType<ConstantValue.Num>();
        num.Value.ShouldBe(14m);
        num.IsInteger.ShouldBeTrue();
    }

    [Fact]
    public void ConstantFolder_DivByZero_NotConstant()
    {
        // 1 / 0 folds to "not constant" rather than throwing.
        BoundExpression expr = Bin(BinaryOp.Div, Int(1), Int(0));

        ConstantFolder.Fold(expr).ShouldBeNull();
    }
}
