using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class ParsingTests
{
    [Fact]
    public void Fixture_parses_without_syntax_errors()
    {
        var (model, diagnostics) = new KoineCompiler().Parse(TestSupport.BillingFixture);

        Assert.Empty(diagnostics);
        Assert.NotNull(model);
        Assert.Single(model.Contexts);
        Assert.Equal("Billing", model.Contexts[0].Name);
    }

    [Fact]
    public void Syntax_error_reports_line_and_column()
    {
        // Missing the type name after `value`.
        const string source = "context C {\n  value {\n  }\n}\n";

        var (model, diagnostics) = new KoineCompiler().Parse(source);

        Assert.Null(model);
        Assert.NotEmpty(diagnostics);
        var first = diagnostics[0];
        Assert.Equal(DiagnosticSeverity.Error, first.Severity);
        Assert.Equal(2, first.Line);          // the offending `{` is on line 2
        Assert.True(first.Column > 0);
    }

    [Fact]
    public void Empty_input_is_valid()
    {
        var (model, diagnostics) = new KoineCompiler().Parse("");

        Assert.Empty(diagnostics);
        Assert.NotNull(model);
        Assert.Empty(model.Contexts);
    }

    [Fact]
    public void Regex_on_following_line_parses()
    {
        // The regex literal may sit on the line after `matches`.
        const string src =
            "context C {\n  value V {\n    raw: String\n    invariant raw matches\n      /^[a-z]+$/ \"lower\"\n  }\n}\n";
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        Assert.Empty(diagnostics);
        Assert.NotNull(model);
    }

    [Fact]
    public void String_escapes_are_decoded()
    {
        // \n \t \\ \" must be decoded into real characters in the AST.
        const string src =
            "context C {\n  value V {\n    x: Int\n    invariant x >= 0 \"a\\nb\\tc\\\\d\\\"e\"\n  }\n}\n";
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        Assert.Empty(diagnostics);

        var value = (Ast.ValueObjectDecl)model!.Contexts[0].Types[0];
        Assert.Equal("a\nb\tc\\d\"e", value.Invariants[0].Message);
    }

    [Fact]
    public void Soft_keyword_as_declaration_name_reports_KOI0002()
    {
        // `from` is a soft keyword (legal as a field/member name) but cannot be the
        // bare declaration name following `value`.
        const string source = "context C {\n  value from {\n  }\n}\n";

        var (model, diagnostics) = new KoineCompiler().Parse(source);

        Assert.Null(model);
        var first = diagnostics[0];
        Assert.Equal(DiagnosticCodes.ReservedWordInDeclarationName, first.Code);
        Assert.Contains("'from' is a Koine keyword", first.Message);
        Assert.Contains("plain identifier", first.Message);
        Assert.Equal(2, first.Line);
    }

    [Fact]
    public void Soft_keyword_as_enum_name_reports_KOI0002()
    {
        // `query` is a soft keyword used in the hard-Identifier position after `enum`.
        const string source = "context C {\n  enum query {\n  }\n}\n";

        var (_, diagnostics) = new KoineCompiler().Parse(source);

        Assert.Contains(diagnostics,
            d => d.Code == DiagnosticCodes.ReservedWordInDeclarationName && d.Message.Contains("'query'"));
    }

    [Fact]
    public void Fully_reserved_word_as_declaration_name_reports_KOI0002()
    {
        // `invariant` is fully reserved and can never be a declaration name.
        const string source = "context C {\n  value invariant {\n  }\n}\n";

        var (model, diagnostics) = new KoineCompiler().Parse(source);

        Assert.Null(model);
        var first = diagnostics[0];
        Assert.Equal(DiagnosticCodes.ReservedWordInDeclarationName, first.Code);
        Assert.Contains("fully reserved", first.Message);
    }

    [Fact]
    public void Soft_keyword_as_field_name_still_parses()
    {
        // The same word is perfectly legal as a member name — KOI0002 must NOT fire here.
        const string source = "context C {\n  value V {\n    from: String\n  }\n}\n";

        var (model, diagnostics) = new KoineCompiler().Parse(source);

        Assert.NotNull(model);
        Assert.DoesNotContain(diagnostics, d => d.Code == DiagnosticCodes.ReservedWordInDeclarationName);
    }

    [Fact]
    public void Unrelated_syntax_error_stays_KOI0001()
    {
        // A non-keyword syntax error must keep the generic syntax diagnostic.
        const string source = "context C {\n  value {\n  }\n}\n";

        var (_, diagnostics) = new KoineCompiler().Parse(source);

        Assert.Equal(DiagnosticCodes.SyntaxError, diagnostics[0].Code);
    }
}
