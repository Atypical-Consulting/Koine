using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1056 (follow-up to #1031/#1048): <see cref="Koine.Compiler.Semantics.LiteralZeroDivisorAnalysis"/>'s
/// <c>HasDivisionByLiteralZero</c> walker special-cases only <c>BinaryExpr{Add,Sub,Mul,Div}</c> — any
/// other <c>BinaryExpr</c> operator (a comparison or logical operator) hits the walker's
/// <c>default: return false</c> arm immediately, so a division nested one level deeper still escapes.
/// <c>GuardExpr</c> (<c>Body when Condition</c>) isn't recursed into at all. Both gaps let a literal-zero
/// divisor reach every emitter unchecked, exactly as #1048 documented for the conditional/coalesce/let
/// shapes it closed.
/// </summary>
public class DivisionByZeroExhaustiveCoverageTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    /// <summary>Issue #1056 repro (1): a literal-zero divisor wrapped in a comparison inside a
    /// <c>ConditionalExpr</c>'s condition — the walker's <c>BinaryExpr{Div}</c> special case never
    /// triggers because the outer node is <c>BinaryExpr{Gt}</c>, which falls straight to <c>default</c>.</summary>
    [Fact]
    public void Division_by_a_literal_zero_wrapped_in_a_comparison_in_a_condition_is_rejected()
    {
        const string src = """
            context Pricing {
              value Rate {
                amount: Decimal = if 4 / 0 > 1 then 1 else 2
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }

    /// <summary>Same comparison-wrapping gap, but with a logical operator (<c>And</c>) instead of a
    /// relational one — both hit the same unhandled <c>BinaryExpr</c> operator arm.</summary>
    [Fact]
    public void Division_by_a_literal_zero_wrapped_in_a_logical_and_in_a_condition_is_rejected()
    {
        const string src = """
            context Pricing {
              value Rate {
                flag: Bool
                amount: Decimal = if flag && 4 / 0 > 1 then 1 else 2
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }

    /// <summary>Issue #1056 repro (2): a literal-zero divisor as a bare <c>GuardExpr</c> body — the
    /// walker never recurses into <c>GuardExpr</c> at all, so this slips past unchecked regardless of
    /// what wraps it.</summary>
    [Fact]
    public void Division_by_a_literal_zero_in_a_guard_expr_body_is_rejected()
    {
        const string src = """
            context Pricing {
              value Rate {
                flag: Bool
                amount: Decimal = (4 / 0) when flag
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }

    /// <summary>The zero divisor can equally hide in a <c>GuardExpr</c>'s <c>Condition</c>, not just its
    /// <c>Body</c> — both must be checked.</summary>
    [Fact]
    public void Division_by_a_literal_zero_in_a_guard_expr_condition_is_rejected()
    {
        const string src = """
            context Pricing {
              value Rate {
                flag: Bool
                amount: Decimal = 4 when (flag && 1 / 0 > 0)
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }

    /// <summary>Negative control: an ordinary comparison-guarded conditional with no zero divisor
    /// anywhere is never flagged.</summary>
    [Fact]
    public void A_comparison_wrapped_condition_with_no_zero_divisor_is_allowed()
    {
        const string src = """
            context Pricing {
              value Rate {
                amount: Decimal = if 4 / 2 > 1 then 1 else 2
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }

    /// <summary>Negative control: an ordinary <c>GuardExpr</c> with no zero divisor anywhere is never
    /// flagged.</summary>
    [Fact]
    public void A_guard_expr_with_no_zero_divisor_is_allowed()
    {
        const string src = """
            context Pricing {
              value Rate {
                flag: Bool
                amount: Decimal = (4 / 2) when flag
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }

    /// <summary>
    /// A <c>LambdaExpr</c> body containing a literal-zero divisor is deliberately NOT flagged: a
    /// lambda's body isn't evaluated at the point the enclosing member default is evaluated — it only
    /// runs later, once (and if) the lambda is invoked by the collection operation (here, <c>sum</c>
    /// aggregating over <c>lines</c>). Recursing into it the way every other wrapper shape in this
    /// walker is recursed into would be a false positive: an empty (or non-empty but never-summed)
    /// <c>lines</c> never actually divides by zero at construction time. This is the one deliberate
    /// EXCLUSION from the walker's otherwise-exhaustive default recursion (<see
    /// cref="Koine.Compiler.Semantics.LiteralZeroDivisorAnalysis"/>'s <c>ZeroDivisorWalker.VisitLambda</c>
    /// override).
    /// </summary>
    [Fact]
    public void Division_by_a_literal_zero_in_a_lambda_body_is_not_flagged()
    {
        const string src = """
            context Pricing {
              value Line {
                qty: Int
              }
              value Rate {
                lines: List<Line>
                amount: Int = lines.sum(l => l.qty / 0)
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }
}
