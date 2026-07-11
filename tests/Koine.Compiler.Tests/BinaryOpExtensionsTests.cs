using Koine.Compiler.Ast;
using Shouldly;

namespace Koine.Compiler.Tests;

/// <summary>
/// #1313: pins the single shared <c>BinaryOp</c> → symbol/verb mapping that
/// <c>ExprDescriber.Operator</c>, <c>Lowerer.SourceOp</c>, and
/// <c>ExpressionChecker.DescribeBinaryOp</c> all delegate to, replacing three independent switch
/// expressions. <c>Symbol</c> renders actual Koine source syntax — the lexer defines <c>AND</c> as
/// <c>&amp;&amp;</c> and <c>OR</c> as <c>||</c> (<c>Grammar/KoineLexer.g4</c>), so <c>Or</c>/<c>And</c>
/// render as <c>||</c>/<c>&amp;&amp;</c>, not the English words <c>Lowerer.SourceOp</c> used to emit —
/// that was a latent drift from the actual grammar, never exercised by any existing snapshot (no test
/// covers a compound unmessaged Or/And invariant), so unifying on it changes no observed output.
/// </summary>
public class BinaryOpExtensionsTests
{
    [Theory]
    [InlineData(BinaryOp.Or, "||")]
    [InlineData(BinaryOp.And, "&&")]
    [InlineData(BinaryOp.Eq, "==")]
    [InlineData(BinaryOp.Neq, "!=")]
    [InlineData(BinaryOp.Lt, "<")]
    [InlineData(BinaryOp.Le, "<=")]
    [InlineData(BinaryOp.Gt, ">")]
    [InlineData(BinaryOp.Ge, ">=")]
    [InlineData(BinaryOp.Add, "+")]
    [InlineData(BinaryOp.Sub, "-")]
    [InlineData(BinaryOp.Mul, "*")]
    [InlineData(BinaryOp.Div, "/")]
    public void Symbol_renders_every_BinaryOp_case(BinaryOp op, string expected)
    {
        op.Symbol().ShouldBe(expected);
    }

    [Theory]
    [InlineData(BinaryOp.Add, "add")]
    [InlineData(BinaryOp.Sub, "subtract")]
    [InlineData(BinaryOp.Mul, "multiply")]
    [InlineData(BinaryOp.Div, "divide")]
    public void Verb_renders_the_four_arithmetic_cases(BinaryOp op, string expected)
    {
        op.Verb().ShouldBe(expected);
    }
}
