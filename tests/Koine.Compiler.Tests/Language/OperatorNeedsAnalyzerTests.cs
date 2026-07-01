using Koine.Compiler.Ast;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Characterization tests pinning the exact per-value-object outputs of the demand-driven
/// <see cref="OperatorNeedsAnalyzer"/> — the analysis that decides which generated arithmetic
/// operators each value object needs. These guard the behaviour-preserving unification of the
/// analyzer's separate scalar / sum-fold / binary passes into one single-pass per-VO model
/// (issue #836): a fast, snapshot-independent net that fails the instant any of the four
/// projections drifts.
///
/// <para>The fixture is engineered so each analysis fires on a <b>distinct</b> value object —
/// scalar <c>*</c>/<c>/</c> on <c>Price</c>, the <c>sum</c> fold on <c>Weight</c>, plain binary
/// <c>+</c>/<c>-</c> on <c>Length</c> — so a refactor that conflated the analyses (recorded a need
/// against the wrong VO) would surface here.</para>
/// </summary>
public class OperatorNeedsAnalyzerTests
{
    /// <summary>
    /// A single host value object that exercises all four analyses on three distinct operand VOs:
    /// <list type="bullet">
    /// <item><description><c>Price</c> multiplied by an <c>Int</c> literal and a <c>Decimal</c> literal, and divided by an <c>Int</c> literal.</description></item>
    /// <item><description><c>Weight</c> folded by <c>sum(selector)</c>.</description></item>
    /// <item><description><c>Length</c> used directly in <c>+</c> and <c>-</c>.</description></item>
    /// </list>
    /// </summary>
    private const string Source = """
        context Shop {
          value Price {
            amount: Decimal
            invariant amount >= 0 "a price cannot be negative"
          }
          value Weight {
            grams: Decimal
          }
          value Length {
            meters: Decimal
          }
          value Sheet {
            unitPrice: Price
            parcels:   List<Weight>
            a:         Length
            b:         Length
            scaledInt: Price  = unitPrice * 2
            scaledDec: Price  = unitPrice * 0.9
            perUnit:   Price  = unitPrice / 4
            shipping:  Weight = parcels.sum(p => p)
            combined:  Length = a + b
            diff:      Length = a - b
          }
        }
        """;

    private static (KoineModel Model, ModelIndex Index) Build()
    {
        CompileResult result = new KoineCompiler().Compile(Source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        KoineModel model = result.Model!;
        ModelIndex index = new SemanticModel(model).Index;
        return (model, index);
    }

    [Fact]
    public void Scalar_multiply_needs_record_int_and_decimal_against_the_multiplied_vo()
    {
        var (model, index) = Build();

        IReadOnlyDictionary<string, IReadOnlySet<string>> needs =
            OperatorNeedsAnalyzer.BuildScalarOperatorNeeds(model, index);

        needs.Keys.ShouldBe(new[] { "Price" });
        needs["Price"].ShouldBe(new[] { "int", "decimal" }, ignoreOrder: true);
    }

    [Fact]
    public void Scalar_division_needs_record_int_against_the_divided_vo_only()
    {
        var (model, index) = Build();

        IReadOnlyDictionary<string, IReadOnlySet<string>> needs =
            OperatorNeedsAnalyzer.BuildScalarDivisionNeeds(model, index);

        needs.Keys.ShouldBe(new[] { "Price" });
        needs["Price"].ShouldBe(new[] { "int" }, ignoreOrder: true);
    }

    [Fact]
    public void Additive_needs_record_only_the_summed_vo()
    {
        var (model, index) = Build();

        IReadOnlySet<string> needs = OperatorNeedsAnalyzer.BuildAdditiveOperatorNeeds(model, index);

        needs.ShouldBe(new[] { "Weight" }, ignoreOrder: true);
    }

    [Fact]
    public void Binary_arithmetic_needs_record_add_and_sub_against_the_binary_vo()
    {
        var (model, index) = Build();

        IReadOnlyDictionary<string, IReadOnlySet<BinaryOp>> needs =
            OperatorNeedsAnalyzer.BuildValueObjectArithmeticNeeds(model, index);

        needs.Keys.ShouldBe(new[] { "Length" });
        needs["Length"].ShouldBe(new[] { BinaryOp.Add, BinaryOp.Sub }, ignoreOrder: true);
    }

    /// <summary>
    /// Direct coverage for the unified per-VO model and its <see cref="OperatorNeedsAnalyzer.ValueObjectOperatorNeeds.NeedsAdd"/>
    /// reconciliation (#836 Task 4) — the actual new surface this PR adds, previously only exercised
    /// indirectly through the PHP emitter's snapshot tests. Checks both ways <c>NeedsAdd</c> can become
    /// true (a <c>sum</c>-fold and a plain binary <c>+</c>) and the negative case (scalar-only).
    /// </summary>
    [Fact]
    public void Unified_model_computes_NeedsAdd_from_either_the_sum_fold_or_a_binary_plus()
    {
        var (model, index) = Build();

        IReadOnlyDictionary<string, OperatorNeedsAnalyzer.ValueObjectOperatorNeeds> needs =
            OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds(model, index);

        needs["Price"].IsSummable.ShouldBeFalse();
        needs["Price"].NeedsAdd.ShouldBeFalse();

        needs["Weight"].IsSummable.ShouldBeTrue();
        needs["Weight"].NeedsAdd.ShouldBeTrue();

        needs["Length"].IsSummable.ShouldBeFalse();
        needs["Length"].BinaryOps.ShouldContain(BinaryOp.Add);
        needs["Length"].NeedsAdd.ShouldBeTrue();
    }

    /// <summary>
    /// <see cref="OperatorNeedsAnalyzer.BuildOperatorNeeds"/> is cached per (model, index) so that the
    /// four public projections and <see cref="OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds"/> share
    /// one site enumeration across separate calls, not just within one (#836) — a repeat call with the
    /// same model/index must return the identical cached instance rather than re-running the pass.
    /// </summary>
    [Fact]
    public void Repeat_calls_for_the_same_model_and_index_return_the_same_cached_instance()
    {
        var (model, index) = Build();

        IReadOnlyDictionary<string, OperatorNeedsAnalyzer.ValueObjectOperatorNeeds> first =
            OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds(model, index);
        IReadOnlyDictionary<string, OperatorNeedsAnalyzer.ValueObjectOperatorNeeds> second =
            OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds(model, index);

        ReferenceEquals(first, second).ShouldBeTrue();
    }
}
