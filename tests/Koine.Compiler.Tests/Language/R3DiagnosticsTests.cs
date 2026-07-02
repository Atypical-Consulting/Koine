using System.Reflection;
using Koine.Compiler.Diagnostics;
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
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownType);
    }

    [Fact]
    public void Diagnostic_to_string_includes_code()
    {
        var d = Diagnostic.Error(DiagnosticCodes.UnknownType, "unknown type 'Nope'", 2, 16);
        d.ToString().ShouldBe("2:16: error KOI0101: unknown type 'Nope'");
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

        constants.Distinct().Count().ShouldBe(constants.Count);          // codes are unique
        constants.ShouldAllBe(c => DiagnosticCodes.Catalogue.ContainsKey(c));
        DiagnosticCodes.Catalogue.Count.ShouldBe(constants.Count);       // no stray catalogue entries
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
        // Diagnose is now error-tolerant: it reports every syntax error in one pass AND runs the
        // semantic validator over the recovered partial model (so unrelated semantic diagnostics may
        // also appear). The contract under test is that all three syntax errors surface together.
        var diags = Diagnose(src);
        var syntaxErrors = diags.Where(d => d.Code == DiagnosticCodes.SyntaxError).ToList();
        (syntaxErrors.Count >= 3).ShouldBeTrue($"expected ≥3 syntax errors, got {syntaxErrors.Count}");
    }

    // ---- R3.3 did-you-mean -------------------------------------------------

    [Fact]
    public void Unknown_type_suggests_closest_known_type()
    {
        var diags = Diagnose("context C {\n  enum Currency { EUR }\n  value V { x: Currancy }\n}\n");
        diags.ShouldContain(d => d.Message.Contains("did you mean 'Currency'?"));
    }

    [Fact]
    public void Unknown_field_suggests_sibling_member()
    {
        var diags = Diagnose("context C {\n  value V {\n    amount: Int\n    invariant amaunt >= 0 \"x\"\n  }\n}\n");
        diags.ShouldContain(d => d.Message.Contains("did you mean 'amount'?"));
    }

    [Fact]
    public void Unknown_enum_default_suggests_member()
    {
        var diags = Diagnose("context C {\n  enum E { Draft, Placed }\n  value V {\n    s: E = Draf\n  }\n}\n");
        diags.ShouldContain(d => d.Message.Contains("did you mean 'Draft'?"));
    }

    [Fact]
    public void No_suggestion_when_nothing_is_close()
    {
        var diags = Diagnose("context C {\n  value V { x: Wxyz }\n}\n");
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownType && !d.Message.Contains("did you mean"));
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
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var m = asm.GetType("C.Measurement")!;
        var inst = Activator.CreateInstance(m, 4m, "kg", 1);
        m.GetProperty("Doubled")!.GetValue(inst).ShouldBe(8m);
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
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
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
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.AmbiguousEnumMember);
    }

    [Fact]
    public void Qualified_enum_member_with_wrong_enum_is_reported()
    {
        const string src =
            "context C {\n" +
            "  enum OrderStatus { Draft }\n" +
            "  value V { ok: Bool = OrderStatus.Nope == OrderStatus.Draft }\n" +
            "}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownEnumMemberForType);
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
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var inner = asm.GetType("C.Inner")!;
        var outer = asm.GetType("C.Outer")!;
        var i = Activator.CreateInstance(inner, 7, 3);
        var o = Activator.CreateInstance(outer, i);
        outer.GetProperty("D")!.GetValue(o).ShouldBe(7);   // inner.value
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
        Diagnose(src).ShouldBeEmpty(); // no false KOI0209/KOI0213

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
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
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.AmbiguousEnumMember);
    }

    // A bare shared member in a comparison resolves against the EXPECTED enum type
    // flowing in (not just the sibling operand): the comparison path now uses the
    // same fallback context as the conditional/coalesce paths and the emitter, so a
    // comparison the enclosing enum type makes unambiguous no longer needs
    // qualification. (Deferred design: contextual typing for shared bare members.)
    [Fact]
    public void Shared_enum_member_in_comparison_resolves_by_expected_type()
    {
        const string src =
            "context C {\n" +
            "  enum A { Shared, OnlyA }\n" +
            "  enum B { Shared, OnlyB }\n" +
            // expected type A flows into the coalesce, pinning both bare `Shared`
            // members in the right-hand comparison to enum A — no KOI0213.
            "  value V { flag: Bool?  pick: A = flag ?? (Shared == Shared) }\n" +
            "}\n";
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.AmbiguousEnumMember);
    }

    // The expected type must be an enum that declares the member; when the expected
    // type is Bool (the result of `==`), neither operand nor context selects a
    // unique enum, so the bare-vs-bare comparison is still genuinely ambiguous.
    [Fact]
    public void Shared_enum_member_in_comparison_still_ambiguous_when_expected_is_not_enum()
    {
        const string src =
            "context C {\n" +
            "  enum A { Shared, OnlyA }\n" +
            "  enum B { Shared, OnlyB }\n" +
            "  value V { flag: Bool = Shared == Shared }\n" +
            "}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.AmbiguousEnumMember);
    }

    // ---- Phase 5: node-sourced diagnostics carry an exact end --------------

    [Fact]
    public void Node_sourced_diagnostic_carries_exact_end_span()
    {
        // The duplicate-member diagnostic is raised from the member's full node span,
        // so it underlines the exact member text rather than relying on a forward scan.
        const string src =
            "context C {\n" +
            "  value V {\n" +
            "    amount: Int\n" +
            "    amount: Int\n" +
            "  }\n" +
            "}\n";
        var dup = Diagnose(src).Single(d => d.Code == DiagnosticCodes.DuplicateMember);
        dup.HasEnd.ShouldBeTrue();
        dup.Line.ShouldBe(4);            // second occurrence on source line 4
        dup.EndLine.ShouldBe(4);
        (dup.EndColumn > dup.Column).ShouldBeTrue(); // a real width, not a zero-length point
    }

    [Fact]
    public void Span_overloads_preserve_a_real_width_end()
    {
        // The Error/Warning(code, message, span) overloads must carry the span's end so
        // the printer underlines the full token, not a single caret.
        var span = new Ast.SourceSpan(3, 5, 3, 12, 0, 7);

        var err = Diagnostic.Error(DiagnosticCodes.UnknownType, "boom", span);
        err.HasEnd.ShouldBeTrue();
        err.EndLine.ShouldBe(3);
        err.EndColumn.ShouldBe(12);

        var warn = Diagnostic.Warning(DiagnosticCodes.UnknownType, "boom", span);
        warn.HasEnd.ShouldBeTrue();
        warn.EndLine.ShouldBe(3);
        warn.EndColumn.ShouldBe(12);
    }

    [Fact]
    public void Span_overloads_preserve_a_multi_line_end()
    {
        // A span crossing lines must carry the distinct end line/column so the printer
        // and LSP ranges cover the full multi-line construct, not just the first line.
        var span = new Ast.SourceSpan(3, 5, 4, 2, 0, 10);

        var err = Diagnostic.Error(DiagnosticCodes.UnknownType, "boom", span);
        err.HasEnd.ShouldBeTrue();
        err.EndLine.ShouldBe(4);
        err.EndColumn.ShouldBe(2);

        var warn = Diagnostic.Warning(DiagnosticCodes.UnknownType, "boom", span);
        warn.HasEnd.ShouldBeTrue();
        warn.EndLine.ShouldBe(4);
        warn.EndColumn.ShouldBe(2);
    }

    [Fact]
    public void Span_overloads_leave_a_zero_width_point_span_without_an_end()
    {
        // A point span (end == start) stays a point diagnostic — behavior preserved.
        var point = new Ast.SourceSpan(3, 5);

        var err = Diagnostic.Error(DiagnosticCodes.UnknownType, "boom", point);
        err.HasEnd.ShouldBeFalse();
        err.EndLine.ShouldBe(0);
        err.EndColumn.ShouldBe(0);

        var warn = Diagnostic.Warning(DiagnosticCodes.UnknownType, "boom", point);
        warn.HasEnd.ShouldBeFalse();
        warn.EndLine.ShouldBe(0);
        warn.EndColumn.ShouldBe(0);
    }

    // ---- recovered parse: a trailing operator must not crash the never-throw Diagnose path (#597) ----

    [Theory]
    [InlineData("context C { value V { x: Int = a + } }")]
    [InlineData("context C { value V { x: Int = a.+ } }")]
    public void Diagnose_with_trailing_operator_does_not_throw_and_reports_an_error(string source)
    {
        // A trailing binary operator (`a +`) leaves `unaryExpr` matching neither alternative, so
        // BuildUnary passes a null PostfixExprContext to BuildPostfix. The error-tolerant Diagnose
        // path must report diagnostics rather than throwing a NullReferenceException.
        var diagnostics = Should.NotThrow(() => Diagnose(source));

        diagnostics.ShouldContain(d => d.Severity == DiagnosticSeverity.Error);
    }
}
