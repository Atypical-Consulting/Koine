using System.Globalization;
using Koine.Compiler.Ast;
using Koine.Compiler.Ast.Bound;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Semantics;
using Koine.Compiler.Services;

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

    // ----------------------------------------------------------------------
    // B2 — the satisfiability checker's contradiction diagnostics.
    // ----------------------------------------------------------------------

    private static IReadOnlyList<Diagnostic> Diagnose(string source) =>
        new KoineCompiler().Diagnose(source);

    [Fact]
    public void Satisfiability_FlagsInvertedBound()
    {
        // celsius must be >= 100 AND <= 0 — an inverted (inclusive) bound, low > high.
        var diags = Diagnose("context C { value Temp { celsius: Int  invariant celsius >= 100 && celsius <= 0 } }");

        diags.ShouldContain(d => d.Code == DiagnosticCodes.InvertedBound);
    }

    [Fact]
    public void Satisfiability_FlagsContradictoryPair()
    {
        // amount > 100 AND amount < 10 — an unsatisfiable pair of strict bounds.
        var diags = Diagnose("context C { value Money { amount: Decimal  invariant amount > 100 && amount < 10 } }");

        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnsatisfiableInvariantPair);
    }

    [Fact]
    public void Satisfiability_DoesNotFlagSatisfiable()
    {
        // A perfectly normal bounded range must NOT trip any satisfiability diagnostic.
        var diags = Diagnose("context C { value Score { points: Int  invariant points >= 0 && points <= 100 } }");

        var satisfiabilityCodes = new[]
        {
            DiagnosticCodes.InvertedBound,
            DiagnosticCodes.UnsatisfiableInvariantPair,
            DiagnosticCodes.ContradictoryInvariant,
            DiagnosticCodes.BoundOutsideConstraint,
        };
        diags.ShouldNotContain(d => satisfiabilityCodes.Contains(d.Code));
    }
}
