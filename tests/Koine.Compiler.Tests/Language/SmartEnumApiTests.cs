using Koine.Compiler.Diagnostics;
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
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm.GetType("Shop.OrderStatus")!;
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
        ok.ShouldBeTrue();
        TestSupport.EnumValue(status, "Paid").Equals(args[1]).ShouldBeTrue();
    }

    [Fact]
    public void TryFromName_returns_false_and_null_for_unknown_name()
    {
        var status = StatusType();
        var args = new object?[] { "Nope", null };
        var ok = (bool)status.GetMethod("TryFromName")!.Invoke(null, args)!;
        ok.ShouldBeFalse();
        args[1].ShouldBeNull();
    }

    [Fact]
    public void TryFromValue_binds_member_and_returns_true_for_known_value()
    {
        var status = StatusType();
        var args = new object?[] { 2, null };
        var ok = (bool)status.GetMethod("TryFromValue")!.Invoke(null, args)!;
        ok.ShouldBeTrue();
        TestSupport.EnumValue(status, "Paid").Equals(args[1]).ShouldBeTrue();
    }

    [Fact]
    public void TryFromValue_returns_false_and_null_for_unknown_value()
    {
        var status = StatusType();
        var args = new object?[] { 99, null };
        var ok = (bool)status.GetMethod("TryFromValue")!.Invoke(null, args)!;
        ok.ShouldBeFalse();
        args[1].ShouldBeNull();
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
        result.ShouldBe("paid");
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
        hit.ShouldBe("shipped");
    }

    // ======================================================================
    // Member-name guards required by the new generated members
    // ======================================================================

    [Fact]
    public void Member_named_like_a_generated_method_is_rejected()
    {
        Diagnose("context C { enum E { Match, Other } }").ShouldContain(d => d.Code == DiagnosticCodes.ReservedEnumMember);
        Diagnose("context C { enum E { Switch, Other } }").ShouldContain(d => d.Code == DiagnosticCodes.ReservedEnumMember);
        Diagnose("context C { enum E { TryFromName, Other } }").ShouldContain(d => d.Code == DiagnosticCodes.ReservedEnumMember);
    }

    [Fact]
    public void Member_colliding_with_a_base_smart_enum_member_is_rejected()
    {
        // Pre-existing latent hole now closed: a member named `Value`/`All` collided
        // with the generated property of the same name and produced uncompilable C#.
        Diagnose("context C { enum E { Value, Other } }").ShouldContain(d => d.Code == DiagnosticCodes.ReservedEnumMember);
        Diagnose("context C { enum E { All, Other } }").ShouldContain(d => d.Code == DiagnosticCodes.ReservedEnumMember);
    }

    [Fact]
    public void Members_colliding_under_camel_case_are_rejected()
    {
        // Match/Switch generate one camelCase delegate parameter per member; two members
        // differing only by the case of their leading char would collapse to one parameter.
        Diagnose("context C { enum E { Foo, foo } }").ShouldContain(d => d.Code == DiagnosticCodes.EnumMemberCamelCaseCollision);
    }

    [Fact]
    public void Ordinary_enum_members_remain_valid()
    {
        Diagnose(Src).ShouldBeEmpty();
    }

    [Fact]
    public void Member_colliding_with_an_associated_data_property_is_rejected()
    {
        // `mass` generates a `Mass` property; a member also named `Mass` would declare the
        // same identifier twice (static field + property) and produce uncompilable C#.
        Diagnose("context C { enum E(mass: Int) { Mass(5) Other(3) } }").ShouldContain(d => d.Code == DiagnosticCodes.EnumReservedAssociatedField);
    }

    // ======================================================================
    // Behavioral coverage on shapes the bare fixture does not exercise
    // ======================================================================

    private static Type CompiledType(string source, string fqn)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm.GetType(fqn)!;
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
        match.Invoke(eur, new object[] { onEur, onUsd }).ShouldBe(1);
    }

    [Fact]
    public void Match_and_Switch_handle_a_single_member_enum()
    {
        var only = CompiledType("context C { enum E { Only } }", "C.E");
        var instance = TestSupport.EnumValue(only, "Only");

        var match = only.GetMethod("Match")!.MakeGenericMethod(typeof(int));
        Func<int> arm = () => 7;
        match.Invoke(instance, new object[] { arm }).ShouldBe(7);

        var ran = false;
        Action act = () => ran = true;
        only.GetMethod("Switch")!.Invoke(instance, new object[] { act });
        ran.ShouldBeTrue();
    }

    // ======================================================================
    // Member names that are C# keywords must emit as @-escaped identifiers,
    // while the member's Name string stays the original spelling.
    // ======================================================================

    [Fact]
    public void Keyword_named_member_emits_compilable_csharp_and_round_trips()
    {
        // `default` is a legal Koine identifier but a C# keyword; the static field, `All`,
        // and Match arm must escape it to `@default` while Name/FromName keep "default".
        var e = CompiledType("context C { enum E { Other, default } }", "C.E");

        var def = TestSupport.EnumValue(e, "default");
        e.GetProperty("Name")!.GetValue(def).ShouldBe("default");

        var fromName = e.GetMethod("FromName")!.Invoke(null, new object[] { "default" });
        def.Equals(fromName).ShouldBeTrue();

        var all = (System.Collections.IEnumerable)e.GetProperty("All")!.GetValue(null)!;
        all.Cast<object>().Count().ShouldBe(2);

        var match = e.GetMethod("Match")!.MakeGenericMethod(typeof(int));
        Func<int> onOther = () => 1;
        Func<int> onDefault = () => 2;
        match.Invoke(def, new object[] { onOther, onDefault }).ShouldBe(2);
    }

    [Fact]
    public void Keyword_named_member_works_as_enum_default_and_in_expressions()
    {
        // Exercises the enum-default emit site and bare-member scoped resolution in an
        // expression — both reference the member as a C# identifier and must escape it.
        var src = """
            context C {
              enum E { Other, default }
              value V {
                kind: E = default
                isDefault: Bool = kind == default
              }
            }
            """;
        CompiledType(src, "C.V").ShouldNotBeNull();
    }

    [Fact]
    public void Keyword_named_member_works_in_a_state_machine()
    {
        // Exercises the state-machine guard emit site, which references members as identifiers.
        var src = """
            context C {
              enum E { Other, default }
              aggregate A root R {
                entity R identified by RId {
                  kind: E = default
                  states kind { default -> Other }
                }
              }
            }
            """;
        CompiledType(src, "C.R").ShouldNotBeNull();
    }
}
