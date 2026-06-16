using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Smart-enum API enhancements: non-throwing <c>TryFromName</c>/<c>TryFromValue</c>
/// lookups and exhaustive <c>Match</c>/<c>Switch</c>, plus the member-name guards
/// those generated members require to stay compilable.
/// </summary>
public class SmartEnumApiTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private const string Src = """
        context Shop {
          enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }
        }
        """;

    private static Type StatusType(string source = Src)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm!.GetType("Shop.OrderStatus")!;
    }

    // ======================================================================
    // Non-throwing Try* lookups
    // ======================================================================

    [Fact]
    public void TryFromName_binds_member_and_returns_true_for_known_name()
    {
        var status = StatusType();
        var args = new object?[] { "Paid", null };
        var ok = (bool)status.GetMethod("TryFromName")!.Invoke(null, args)!;
        Assert.True(ok);
        Assert.True(TestSupport.EnumValue(status, "Paid").Equals(args[1]));
    }

    [Fact]
    public void TryFromName_returns_false_and_null_for_unknown_name()
    {
        var status = StatusType();
        var args = new object?[] { "Nope", null };
        var ok = (bool)status.GetMethod("TryFromName")!.Invoke(null, args)!;
        Assert.False(ok);
        Assert.Null(args[1]);
    }

    [Fact]
    public void TryFromValue_binds_member_and_returns_true_for_known_value()
    {
        var status = StatusType();
        var args = new object?[] { 2, null };
        var ok = (bool)status.GetMethod("TryFromValue")!.Invoke(null, args)!;
        Assert.True(ok);
        Assert.True(TestSupport.EnumValue(status, "Paid").Equals(args[1]));
    }

    [Fact]
    public void TryFromValue_returns_false_and_null_for_unknown_value()
    {
        var status = StatusType();
        var args = new object?[] { 99, null };
        var ok = (bool)status.GetMethod("TryFromValue")!.Invoke(null, args)!;
        Assert.False(ok);
        Assert.Null(args[1]);
    }

    // ======================================================================
    // Exhaustive Match / Switch
    // ======================================================================

    [Fact]
    public void Match_dispatches_to_the_delegate_for_the_member()
    {
        var status = StatusType();
        var paid = TestSupport.EnumValue(status, "Paid");
        var match = status.GetMethod("Match")!.MakeGenericMethod(typeof(string));

        Func<string> draft = () => "draft";
        Func<string> submitted = () => "submitted";
        Func<string> paidArm = () => "paid";
        Func<string> shipped = () => "shipped";
        Func<string> cancelled = () => "cancelled";

        var result = match.Invoke(paid, new object[] { draft, submitted, paidArm, shipped, cancelled });
        Assert.Equal("paid", result);
    }

    [Fact]
    public void Switch_invokes_the_action_for_the_member()
    {
        var status = StatusType();
        var shipped = TestSupport.EnumValue(status, "Shipped");

        string? hit = null;
        Action draft = () => hit = "draft";
        Action submitted = () => hit = "submitted";
        Action paid = () => hit = "paid";
        Action shippedArm = () => hit = "shipped";
        Action cancelled = () => hit = "cancelled";

        status.GetMethod("Switch")!.Invoke(shipped, new object[] { draft, submitted, paid, shippedArm, cancelled });
        Assert.Equal("shipped", hit);
    }

    // ======================================================================
    // Member-name guards required by the new generated members
    // ======================================================================

    [Fact]
    public void Member_named_like_a_generated_method_is_rejected()
    {
        Assert.Contains(Diagnose("context C { enum E { Match, Other } }"),
            d => d.Code == DiagnosticCodes.ReservedEnumMember);
        Assert.Contains(Diagnose("context C { enum E { Switch, Other } }"),
            d => d.Code == DiagnosticCodes.ReservedEnumMember);
        Assert.Contains(Diagnose("context C { enum E { TryFromName, Other } }"),
            d => d.Code == DiagnosticCodes.ReservedEnumMember);
    }

    [Fact]
    public void Member_colliding_with_a_base_smart_enum_member_is_rejected()
    {
        // Pre-existing latent hole now closed: a member named `Value`/`All` collided
        // with the generated property of the same name and produced uncompilable C#.
        Assert.Contains(Diagnose("context C { enum E { Value, Other } }"),
            d => d.Code == DiagnosticCodes.ReservedEnumMember);
        Assert.Contains(Diagnose("context C { enum E { All, Other } }"),
            d => d.Code == DiagnosticCodes.ReservedEnumMember);
    }

    [Fact]
    public void Members_colliding_under_camel_case_are_rejected()
    {
        // Match/Switch generate one camelCase delegate parameter per member; two members
        // differing only by the case of their leading char would collapse to one parameter.
        Assert.Contains(Diagnose("context C { enum E { Foo, foo } }"),
            d => d.Code == DiagnosticCodes.EnumMemberCamelCaseCollision);
    }

    [Fact]
    public void Ordinary_enum_members_remain_valid()
    {
        Assert.Empty(Diagnose(Src));
    }

    [Fact]
    public void Member_colliding_with_an_associated_data_property_is_rejected()
    {
        // `mass` generates a `Mass` property; a member also named `Mass` would declare the
        // same identifier twice (static field + property) and produce uncompilable C#.
        Assert.Contains(Diagnose("context C { enum E(mass: Int) { Mass(5) Other(3) } }"),
            d => d.Code == DiagnosticCodes.EnumReservedAssociatedField);
    }

    // ======================================================================
    // Behavioral coverage on shapes the bare fixture does not exercise
    // ======================================================================

    private static Type CompiledType(string source, string fqn)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm!.GetType(fqn)!;
    }

    [Fact]
    public void Match_dispatches_correctly_on_an_associated_data_enum()
    {
        var currency = CompiledType(
            """context Catalog { enum Currency(symbol: String, decimals: Int) { EUR("e", 2) USD("d", 2) } }""",
            "Catalog.Currency");
        var eur = TestSupport.EnumValue(currency, "EUR");
        var match = currency.GetMethod("Match")!.MakeGenericMethod(typeof(int));
        Func<int> onEur = () => 1;
        Func<int> onUsd = () => 2;
        Assert.Equal(1, match.Invoke(eur, new object[] { onEur, onUsd }));
    }

    [Fact]
    public void Match_and_Switch_handle_a_single_member_enum()
    {
        var only = CompiledType("context C { enum E { Only } }", "C.E");
        var instance = TestSupport.EnumValue(only, "Only");

        var match = only.GetMethod("Match")!.MakeGenericMethod(typeof(int));
        Func<int> arm = () => 7;
        Assert.Equal(7, match.Invoke(instance, new object[] { arm }));

        var ran = false;
        Action act = () => ran = true;
        only.GetMethod("Switch")!.Invoke(instance, new object[] { act });
        Assert.True(ran);
    }
}
