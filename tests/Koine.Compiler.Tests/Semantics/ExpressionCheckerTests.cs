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
    public void Chained_arithmetic_mixing_a_narrowed_leaf_with_an_unguarded_leaf_still_reports_KOI0402()
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

        Validate(src).ShouldContain(d => d.Code == DiagnosticCodes.OptionalDereference);
    }
}
