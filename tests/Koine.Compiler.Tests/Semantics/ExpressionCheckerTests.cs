using Koine.Compiler.Diagnostics;
using Koine.Compiler.Semantics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// #1563 — chaining a third operand onto two already guard-narrowed optionals (e.g.
/// <c>discount + qty + r</c> when <c>discount</c>/<c>qty</c> are narrowed present) must not trip a
/// false-positive <c>KOI0402</c>, since <c>IsNarrowed</c> now recurses into compound operands.
/// </summary>
public class ExpressionCheckerTests
{
    private static IReadOnlyList<Diagnostic> Validate(string source)
    {
        var (model, syntax) = new KoineCompiler().Parse(source);
        syntax.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticValidator().Validate(model);
    }

    [Fact]
    public void Chained_arithmetic_over_two_narrowed_optionals_does_not_report_KOI0402()
    {
        const string src =
            """
            context Shop {
              value Order {
                discount:    Decimal?
                qty:         Int?
                rates:       List<Decimal>
                allDistinct: Bool = if discount.isPresent && qty.isPresent
                                     then rates.distinctBy(r => discount + qty + r)
                                     else true
              }
            }
            """;

        Validate(src).ShouldNotContain(d => d.Code == DiagnosticCodes.OptionalDereference);
    }

    [Fact]
    public void Chained_arithmetic_mixing_a_narrowed_leaf_with_an_unguarded_leaf_reports_KOI0402_exactly_once()
    {
        const string src =
            """
            context Shop {
              value Order {
                discount:    Decimal?
                surcharge:   Decimal?
                qty:         Int?
                rates:       List<Decimal>
                allDistinct: Bool = if discount.isPresent && qty.isPresent
                                     then rates.distinctBy(r => discount + surcharge + r)
                                     else true
              }
            }
            """;

        Validate(src).Count(d => d.Code == DiagnosticCodes.OptionalDereference).ShouldBe(1);
    }

    /// <summary>
    /// #1589: two INDEPENDENTLY unguarded leaves at different nesting depths of the same chain — the
    /// inner pair's own unguarded operand, and the outer chain's own unguarded operand — are two
    /// genuinely distinct defects and must both be reported, not collapsed into one by the #1589 fix.
    /// </summary>
    [Fact]
    public void Chained_arithmetic_with_two_independently_unguarded_leaves_reports_KOI0402_twice()
    {
        const string src =
            """
            context Shop {
              value Order {
                surcharge: Decimal?
                fee:       Decimal?
                tax:       Decimal?
                rates:     List<Decimal>
                allDistinct: Bool = rates.distinctBy(r => surcharge + fee + tax)
              }
            }
            """;

        Validate(src).Count(d => d.Code == DiagnosticCodes.OptionalDereference).ShouldBe(2);
    }

    /// <summary>
    /// #1589: the comparison-operator check's relational branch shares the same gap as
    /// <c>CheckArithmeticNullSafety</c> — it independently re-derives whether its LEFT operand (here the
    /// compound <c>surcharge + fee</c>) is an unguarded optional, echoing the inner arithmetic check's
    /// own already-reported <c>KOI0402</c> a second time.
    /// </summary>
    [Fact]
    public void Comparison_over_an_unguarded_compound_arithmetic_operand_reports_KOI0402_exactly_once()
    {
        const string src =
            """
            context Shop {
              value Order {
                surcharge: Decimal?
                fee:       Decimal?
                threshold: Decimal
                overLimit: Bool = surcharge + fee < threshold
              }
            }
            """;

        Validate(src).Count(d => d.Code == DiagnosticCodes.OptionalDereference).ShouldBe(1);
    }
}
