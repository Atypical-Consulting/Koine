using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1048 (follow-up to #1031): <see cref="Koine.Compiler.Semantics.LiteralZeroDivisorAnalysis"/>'s
/// <c>HasDivisionByLiteralZero</c> walker recurses only through <c>BinaryExpr{Add,Sub,Mul,Div}</c> and
/// <c>UnaryExpr{Negate}</c> — mirroring <c>PhpEmitter.TryFoldNumericLiteral</c>'s own narrow fold shape.
/// A literal-zero divisor nested inside a <c>ConditionalExpr</c> (<c>if/then/else</c>),
/// <c>CoalesceExpr</c> (<c>??</c>), or <c>LetExpr</c> (<c>let ... in</c>) — all legal in a member
/// initializer position — hits the walker's <c>default: return false</c> arm and slips past KOI1606
/// entirely, even though Roslyn constant-folds BOTH branches of a C# ternary regardless of which one
/// is selected at runtime, so an "unreachable" <c>4 / 0</c> branch still trips
/// <c>CS0020: Division by constant zero</c> once emitted.
/// </summary>
public class DivisionByZeroConditionalCoverageTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    [Fact]
    public void Division_by_a_literal_zero_in_a_conditional_branch_is_rejected()
    {
        const string src = """
            context Pricing {
              value Rate {
                flag: Bool
                amount: Decimal = if flag then 4 else 4 / 0
              }
            }
            """;
        var divByZero = Diagnose(src).ShouldHaveSingleItem();
        divByZero.Code.ShouldBe(DiagnosticCodes.DivisionByZeroInConstantDefault);
        divByZero.Message.ShouldContain("amount");
    }

    /// <summary>The zero divisor can equally hide in the "then" branch — both sides must be checked.</summary>
    [Fact]
    public void Division_by_a_literal_zero_in_the_then_branch_is_rejected()
    {
        const string src = """
            context Pricing {
              value Rate {
                flag: Bool
                amount: Decimal = if flag then 4 / 0 else 4
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }

    [Fact]
    public void Division_by_a_literal_zero_in_a_coalesce_operand_is_rejected()
    {
        const string src = """
            context Pricing {
              value Rate {
                maybe: Decimal?
                amount: Decimal = maybe ?? 4 / 0
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }

    [Fact]
    public void Division_by_a_literal_zero_in_a_let_binding_is_rejected()
    {
        const string src = """
            context Pricing {
              value Rate {
                amount: Decimal = let x = 4 / 0 in x
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }

    [Fact]
    public void Division_by_a_literal_zero_in_a_let_body_is_rejected()
    {
        const string src = """
            context Pricing {
              value Rate {
                amount: Decimal = let x = 4 in x / 0
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }

    /// <summary>
    /// Nested composition: a <c>let</c>-bound value that is itself only reachable through a further
    /// conditional — recursion must compose naturally across wrapper node shapes.
    /// </summary>
    [Fact]
    public void Division_by_a_literal_zero_nested_through_let_and_conditional_is_rejected()
    {
        const string src = """
            context Pricing {
              value Rate {
                flag: Bool
                amount: Decimal = let x = (if flag then 1 else 4 / 0) in x
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }

    /// <summary>Negative control: an ordinary conditional with no zero divisor anywhere is never flagged.</summary>
    [Fact]
    public void A_conditional_with_no_zero_divisor_is_allowed()
    {
        const string src = """
            context Pricing {
              value Rate {
                flag: Bool
                amount: Decimal = if flag then 4 else 4 / 2
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }
}
