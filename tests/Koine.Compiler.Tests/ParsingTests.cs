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

        var value = (Koine.Compiler.Ast.ValueObjectDecl)model!.Contexts[0].Types[0];
        Assert.Equal("a\nb\tc\\d\"e", value.Invariants[0].Message);
    }
}
