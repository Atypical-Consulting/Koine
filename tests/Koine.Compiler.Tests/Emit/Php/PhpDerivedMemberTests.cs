using Koine.Compiler.Ast;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Regression tests for #396: a reference to a DERIVED (computed) member must render as a PHP
/// method call (<c>$receiver-&gt;member()</c>), matching how the value-object/entity emitter emits
/// derived members — as getter methods. A stored-member reference stays a property access. The
/// pre-existing gap surfaced as a runtime fatal (<c>Error: Attempt to read undefined property</c>)
/// in the pizzeria <c>IsFreeOrder</c> spec, whose <c>discountedTotal == 0</c> emitted
/// <c>$target-&gt;discountedTotal-&gt;equals(...)</c> instead of <c>$target-&gt;discountedTotal()-&gt;equals(...)</c>.
/// </summary>
public class PhpDerivedMemberTests
{
    // `discountedTotal` references sibling stored members in its initializer, so it is DERIVED
    // (a computed getter); `subtotal`/`discount` are stored fields.
    private const string Source =
        """
        context Shop {
          value Order {
            subtotal: Decimal
            discount: Decimal
            discountedTotal: Decimal = subtotal - discount
          }
        }
        """;

    private static PhpExpressionTranslator Make(string memberReceiver = "this")
    {
        var result = new KoineCompiler().Compile(Source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        ModelIndex index = new SemanticModel(model).Index;

        var order = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<ValueObjectDecl>()
            .First(v => v.Name == "Order");

        return new PhpExpressionTranslator(
            index, order.Members, index.EnumMemberToType, context: "Shop", memberReceiver: memberReceiver);
    }

    private static IdentifierExpr Id(string name) => new(name);
    private static LiteralExpr Decimal(string text) => new(LiteralKind.Decimal, text);

    [Fact]
    public void Derived_member_reference_renders_as_method_call()
    {
        Make().Translate(Id("discountedTotal")).ShouldBe("$this->discountedTotal()");
    }

    [Fact]
    public void Stored_member_reference_stays_a_property_access()
    {
        Make().Translate(Id("subtotal")).ShouldBe("$this->subtotal");
    }

    [Fact]
    public void Derived_member_reference_uses_the_configured_receiver()
    {
        // Spec context roots members at $target, not $this.
        Make("target").Translate(Id("discountedTotal")).ShouldBe("$target->discountedTotal()");
    }

    [Fact]
    public void Derived_member_composes_as_a_call_receiver()
    {
        // The #396 fatal: `discountedTotal == 0` must CALL the derived getter before `->equals(...)`.
        // The Decimal-literal argument is now parenthesised uniformly (#907) — harmless in argument
        // position — while the derived-getter receiver (`$target->discountedTotal()`) is unchanged.
        var expr = new BinaryExpr(BinaryOp.Eq, Id("discountedTotal"), Decimal("0"));
        Make("target").Translate(expr)
            .ShouldBe("$target->discountedTotal()->equals((new \\Koine\\Runtime\\Decimal('0')))");
    }
}
