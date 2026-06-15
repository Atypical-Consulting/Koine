using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R3 — Compiler Quality &amp; Diagnostics.</summary>
public class R3DiagnosticsTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) =>
        new KoineCompiler().Diagnose(source);

    // ---- R3.1 stable diagnostic codes --------------------------------------

    [Fact]
    public void Diagnostics_carry_their_stable_code()
    {
        var diags = Diagnose("context C {\n  value V { x: Nope }\n}\n");
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.UnknownType);
    }

    [Fact]
    public void Diagnostic_to_string_includes_code()
    {
        var d = Diagnostic.Error(DiagnosticCodes.UnknownType, "unknown type 'Nope'", 2, 16);
        Assert.Equal("2:16: error KOI0101: unknown type 'Nope'", d.ToString());
    }

    [Fact]
    public void Catalogue_codes_are_unique_and_every_constant_is_documented()
    {
        // Every public const code on DiagnosticCodes must appear in the catalogue.
        var constants = typeof(DiagnosticCodes)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f is { IsLiteral: true, IsInitOnly: false } && f.FieldType == typeof(string))
            .Select(f => (string)f.GetRawConstantValue()!)
            .ToList();

        Assert.Equal(constants.Count, constants.Distinct().Count());          // codes are unique
        Assert.All(constants, c => Assert.True(DiagnosticCodes.Catalogue.ContainsKey(c), $"{c} undocumented"));
        Assert.Equal(constants.Count, DiagnosticCodes.Catalogue.Count);       // no stray catalogue entries
    }

    // ---- R3.2 parser error recovery ----------------------------------------

    [Fact]
    public void Multiple_syntax_errors_are_reported_in_one_pass()
    {
        const string src =
            "context C {\n" +
            "  value A { x: }\n" +    // missing type
            "  value B { : Int }\n" + // missing name
            "  value D { y Int }\n" + // missing colon
            "}\n";
        var diags = Diagnose(src);
        Assert.True(diags.Count >= 3, $"expected ≥3 syntax errors, got {diags.Count}");
        Assert.All(diags, d => Assert.Equal(DiagnosticCodes.SyntaxError, d.Code));
    }

    // ---- R3.3 did-you-mean -------------------------------------------------

    [Fact]
    public void Unknown_type_suggests_closest_known_type()
    {
        var diags = Diagnose("context C {\n  enum Currency { EUR }\n  value V { x: Currancy }\n}\n");
        Assert.Contains(diags, d => d.Message.Contains("did you mean 'Currency'?"));
    }

    [Fact]
    public void Unknown_field_suggests_sibling_member()
    {
        var diags = Diagnose("context C {\n  value V {\n    amount: Int\n    invariant amaunt >= 0 \"x\"\n  }\n}\n");
        Assert.Contains(diags, d => d.Message.Contains("did you mean 'amount'?"));
    }

    [Fact]
    public void Unknown_enum_default_suggests_member()
    {
        var diags = Diagnose("context C {\n  enum E { Draft, Placed }\n  value V {\n    s: E = Draf\n  }\n}\n");
        Assert.Contains(diags, d => d.Message.Contains("did you mean 'Draft'?"));
    }

    [Fact]
    public void No_suggestion_when_nothing_is_close()
    {
        var diags = Diagnose("context C {\n  value V { x: Wxyz }\n}\n");
        Assert.Contains(diags, d => d.Code == DiagnosticCodes.UnknownType && !d.Message.Contains("did you mean"));
    }

    // ---- R3.4 soft keywords ------------------------------------------------

    [Fact]
    public void Keywords_usable_as_field_names_compile()
    {
        const string src =
            "context C {\n" +
            "  value Measurement {\n" +
            "    value: Decimal\n" +
            "    unit:  String\n" +
            "    when:  Int\n" +
            "    doubled: Decimal = value + value\n" +
            "  }\n" +
            "}\n";
        Assert.Empty(Diagnose(src));

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));

        var m = asm.GetType("C.Measurement")!;
        var inst = Activator.CreateInstance(m, 4m, "kg", 1);
        Assert.Equal(8m, m.GetProperty("Doubled")!.GetValue(inst));
    }

    // ---- R3.5 scoped enum resolution ---------------------------------------

    [Fact]
    public void Shared_enum_member_resolves_by_context_and_compiles()
    {
        const string src =
            "context C {\n" +
            "  enum OrderStatus { Draft, Cancelled }\n" +
            "  enum RefundStatus { Pending, Cancelled }\n" +
            "  entity Order identified by OrderId {\n" +
            "    status: OrderStatus = Draft\n" +
            "    refund: RefundStatus = Pending\n" +
            "    done:    Bool = status == Cancelled\n" +
            "    refDone: Bool = refund == RefundStatus.Cancelled\n" +
            "  }\n" +
            "}\n";
        Assert.Empty(Diagnose(src));

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Ambiguous_bare_enum_member_is_reported()
    {
        const string src =
            "context C {\n" +
            "  enum A { Cancelled, Open }\n" +
            "  enum B { Cancelled, Closed }\n" +
            "  value V { flag: Bool = Cancelled == Cancelled }\n" +
            "}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.AmbiguousEnumMember);
    }

    [Fact]
    public void Qualified_enum_member_with_wrong_enum_is_reported()
    {
        const string src =
            "context C {\n" +
            "  enum OrderStatus { Draft }\n" +
            "  value V { ok: Bool = OrderStatus.Nope == OrderStatus.Draft }\n" +
            "}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.UnknownEnumMemberForType);
    }

    // ---- regressions found by the R3 review --------------------------------

    [Fact]
    public void Soft_keyword_fields_are_readable_via_dot_lambda_and_bare()
    {
        const string src =
            "context C {\n" +
            "  value Inner { value: Int  when: Int }\n" +
            "  value Outer {\n" +
            "    inner: Inner\n" +
            "    d: Int  = inner.value\n" +          // soft keyword after '.'
            "    e: Bool = inner.when > 0\n" +
            "  }\n" +
            "  value Bag {\n" +
            "    items: List<Inner>\n" +
            "    ok: Bool = items.all(value => value.value > 0)\n" + // soft-kw lambda param + access
            "  }\n" +
            "  value W { when: Int  positive: Bool = when > 0 }\n" + // bare 'when' read
            "}\n";
        Assert.Empty(Diagnose(src));

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));

        var inner = asm.GetType("C.Inner")!;
        var outer = asm.GetType("C.Outer")!;
        var i = Activator.CreateInstance(inner, 7, 3);
        var o = Activator.CreateInstance(outer, i);
        Assert.Equal(7, outer.GetProperty("D")!.GetValue(o));   // inner.value
    }

    [Fact]
    public void Shared_enum_member_resolves_in_conditional_and_coalesce()
    {
        const string src =
            "context C {\n" +
            "  enum OrderStatus { Draft, Cancelled }\n" +
            "  enum RefundStatus { Pending, Cancelled }\n" +   // shares 'Cancelled'
            "  value V {\n" +
            "    flag: Bool\n" +
            "    s:    OrderStatus?\n" +
            "    pickC: OrderStatus = if flag then Draft else Cancelled\n" +  // conditional
            "    pickN: OrderStatus = s ?? Cancelled\n" +                     // coalesce
            "  }\n" +
            "}\n";
        Assert.Empty(Diagnose(src)); // no false KOI0209/KOI0213

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Ambiguous_enum_member_in_conditional_is_reported()
    {
        const string src =
            "context C {\n" +
            "  enum A { Shared, OnlyA }\n" +
            "  enum B { Shared, OnlyB }\n" +
            "  value V { flag: Bool  pick: Bool = if flag then Shared == Shared else false }\n" +
            "}\n";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.AmbiguousEnumMember);
    }
}
