using Koine.Compiler.Ast;
using Shouldly;

namespace Koine.Compiler.Tests;

/// <summary>
/// #1522: pins the single shared <c>UnaryOp</c> → symbol mapping that
/// <c>ExpressionChecker.CheckUnaryOperandType</c>, <c>ExprDescriber.VisitUnary</c>, and every
/// code-emitting target's expression translator delegate to, replacing 7+ independent
/// ternaries/switches that had drifted apart — the same drift shape <c>BinaryOpExtensions.Symbol</c>
/// (#1313) fixed for <see cref="BinaryOp"/>.
/// </summary>
public class UnaryOpExtensionsTests
{
    [Theory]
    [InlineData(UnaryOp.Not, "!")]
    [InlineData(UnaryOp.Negate, "-")]
    public void Symbol_renders_every_UnaryOp_case(UnaryOp op, string expected)
    {
        op.Symbol().ShouldBe(expected);
    }
}
