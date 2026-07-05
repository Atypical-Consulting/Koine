using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Type inference for conditional (<c>if … then … else …</c>) bodies. A conditional whose numeric
/// branches differ in width must infer to the <b>common (wider)</b> numeric type — the same promotion
/// arithmetic already applies (<c>Int + Decimal → Decimal</c>) — so a narrowing <c>else</c> can't
/// smuggle a wider type past the KOI0217 narrowing guard by hiding behind an <c>Int</c>-looking
/// <c>then</c> (issue #975).
/// </summary>
public class ConditionalTypeInferenceTests
{
    private static SemanticModel Build(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticModel(model);
    }

    /// <summary>Infer the single conditional expression in <paramref name="src"/> against its value's member scope.</summary>
    private static KoineType InferConditional(string src)
    {
        SemanticModel sema = Build(src);
        var members = NodeWalker.Descendants(sema.Model).OfType<ValueObjectDecl>().Single().Members;
        TypeScope scope = TypeScope.FromMembers(members, sema.Index);
        ConditionalExpr conditional = NodeWalker.Descendants(sema.Model).OfType<ConditionalExpr>().Single();
        return sema.GetTypeInfo(conditional, scope);
    }

    [Fact]
    public void Mixed_numeric_branches_infer_to_the_wider_decimal_type()
    {
        // then = `0` (Int), else = `base` (Decimal) — the common type is the wider Decimal, not the
        // then-branch Int. Taking only `then` (the pre-#975 behavior) hid the Decimal else from KOI0217.
        const string src = """
            context Shop {
              value V {
                base:  Decimal
                total: Int = if base > 0 then 0 else base
              }
            }
            """;
        InferConditional(src).Name.ShouldBe("Decimal");
    }

    [Fact]
    public void Same_numeric_branches_still_infer_to_int()
    {
        // both branches Int — the common type is unchanged Int (no spurious widening).
        const string src = """
            context Shop {
              value V {
                a: Int
                b: Int
                total: Int = if a > 0 then a else b
              }
            }
            """;
        InferConditional(src).Name.ShouldBe("Int");
    }
}
