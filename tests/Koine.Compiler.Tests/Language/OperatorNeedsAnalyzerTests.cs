using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Characterization tests pinning the exact per-value-object outputs of the demand-driven
/// <see cref="OperatorNeedsAnalyzer"/> — the analysis that decides which generated arithmetic
/// operators each value object needs. These guard the behaviour-preserving unification of the
/// analyzer's separate scalar / sum-fold / binary passes into one single-pass per-VO model
/// (issue #836): a fast, snapshot-independent net that fails the instant any per-VO need signal
/// (<see cref="OperatorNeedsAnalyzer.ValueObjectOperatorNeeds.MultiplyFactors"/> /
/// <see cref="OperatorNeedsAnalyzer.ValueObjectOperatorNeeds.DivideFactors"/> /
/// <see cref="OperatorNeedsAnalyzer.ValueObjectOperatorNeeds.IsSummable"/> /
/// <see cref="OperatorNeedsAnalyzer.ValueObjectOperatorNeeds.BinaryOps"/>) drifts — read off the
/// single unified <see cref="OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds"/> surface every
/// emitter now consumes.
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

        IReadOnlyDictionary<string, OperatorNeedsAnalyzer.ValueObjectOperatorNeeds> needs =
            OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds(model, index);

        needs["Price"].MultiplyFactors.ShouldBe(new[] { "int", "decimal" }, ignoreOrder: true);
        // Only Price is multiplied by a scalar — no other VO records a multiply factor.
        needs.Where(kv => kv.Value.MultiplyFactors.Count > 0).Select(kv => kv.Key)
            .ShouldBe(new[] { "Price" });
    }

    [Fact]
    public void Scalar_division_needs_record_int_against_the_divided_vo_only()
    {
        var (model, index) = Build();

        IReadOnlyDictionary<string, OperatorNeedsAnalyzer.ValueObjectOperatorNeeds> needs =
            OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds(model, index);

        needs["Price"].DivideFactors.ShouldBe(new[] { "int" }, ignoreOrder: true);
        // Non-commutative: only the value-object-on-the-left form is recorded, and only for Price.
        needs.Where(kv => kv.Value.DivideFactors.Count > 0).Select(kv => kv.Key)
            .ShouldBe(new[] { "Price" });
    }

    [Fact]
    public void Additive_needs_record_only_the_summed_vo()
    {
        var (model, index) = Build();

        IReadOnlyDictionary<string, OperatorNeedsAnalyzer.ValueObjectOperatorNeeds> needs =
            OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds(model, index);

        // Only Weight is folded by a sum(selector), so only it is summable.
        needs.Where(kv => kv.Value.IsSummable).Select(kv => kv.Key)
            .ShouldBe(new[] { "Weight" });
    }

    [Fact]
    public void Binary_arithmetic_needs_record_add_and_sub_against_the_binary_vo()
    {
        var (model, index) = Build();

        IReadOnlyDictionary<string, OperatorNeedsAnalyzer.ValueObjectOperatorNeeds> needs =
            OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds(model, index);

        needs["Length"].BinaryOps.ShouldBe(new[] { BinaryOp.Add, BinaryOp.Sub }, ignoreOrder: true);
        // Only Length is used directly in plain binary +/-.
        needs.Where(kv => kv.Value.BinaryOps.Count > 0).Select(kv => kv.Key)
            .ShouldBe(new[] { "Length" });
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
    /// Regression for #1289: <c>ScalarOpWalker.InferOperand</c> used to classify ONLY a bare
    /// <see cref="IdentifierExpr"/>/<see cref="LiteralExpr"/> operand, so a compound operand — here a
    /// bare <c>ConditionalExpr</c> over a value-object type — was invisible to it and the multiply/divide
    /// need was never recorded, even though the emitter still lowered the operator unconditionally
    /// (a real Rust `cargo check` E0369). <see cref="ValueObjectArithmeticWalker"/> (the sibling
    /// <c>+</c>/<c>-</c> walker) already resolves the operand's full inferred type and has no such gap.
    /// </summary>
    [Fact]
    public void Scalar_multiply_and_divide_needs_recognize_a_conditional_value_object_operand()
    {
        const string source = """
            context Shop {
              value Price {
                amount: Decimal
              }
              value Mix {
                a: Price
                b: Price
                flag: Bool
                scaledConditional: Price = (if flag then a else b) * 2
                dividedConditional: Price = (if flag then a else b) / 4
              }
            }
            """;

        CompileResult result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        KoineModel model = result.Model!;
        ModelIndex index = new SemanticModel(model).Index;

        IReadOnlyDictionary<string, OperatorNeedsAnalyzer.ValueObjectOperatorNeeds> needs =
            OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds(model, index);

        needs["Price"].MultiplyFactors.ShouldBe(new[] { "int" }, ignoreOrder: true);
        needs["Price"].DivideFactors.ShouldBe(new[] { "int" }, ignoreOrder: true);
    }

    /// <summary>
    /// Sibling of <see cref="Scalar_multiply_and_divide_needs_recognize_a_conditional_value_object_operand"/>
    /// for the OTHER compound shape the fix's design explicitly calls out: a <c>let</c>-bound operand.
    /// <c>TypeResolver.TypeOf</c> follows a <c>let</c> binding through to its bound value's type (the same
    /// mechanism <see cref="ValueObjectArithmeticWalker"/> already relies on for <c>+</c>/<c>-</c>), so this
    /// pins that the fix's full-type-resolution approach genuinely generalizes rather than only covering
    /// the one shape (<c>ConditionalExpr</c>) the original bug report happened to use.
    /// </summary>
    [Fact]
    public void Scalar_multiply_and_divide_needs_recognize_a_let_bound_value_object_operand()
    {
        const string source = """
            context Shop {
              value Price {
                amount: Decimal
              }
              value Mix {
                a: Price
                scaledLet: Price = (let x = a in x) * 2
                dividedLet: Price = (let x = a in x) / 4
              }
            }
            """;

        CompileResult result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        KoineModel model = result.Model!;
        ModelIndex index = new SemanticModel(model).Index;

        IReadOnlyDictionary<string, OperatorNeedsAnalyzer.ValueObjectOperatorNeeds> needs =
            OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds(model, index);

        needs["Price"].MultiplyFactors.ShouldBe(new[] { "int" }, ignoreOrder: true);
        needs["Price"].DivideFactors.ShouldBe(new[] { "int" }, ignoreOrder: true);
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
