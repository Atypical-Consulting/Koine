using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class ParsingTests
{
    [Fact]
    public void Fixture_parses_without_syntax_errors()
    {
        var (model, diagnostics) = new KoineCompiler().Parse(TestSupport.BillingFixture);

        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        model.Contexts.ShouldHaveSingleItem();
        model.Contexts[0].Name.ShouldBe("Billing");
    }

    [Fact]
    public void Syntax_error_reports_line_and_column()
    {
        // Missing the type name after `value`.
        const string source = "context C {\n  value {\n  }\n}\n";

        var (model, diagnostics) = new KoineCompiler().Parse(source);

        // Parsing is error-tolerant: a partial model is returned (never null), but the syntax
        // error is still reported with its line/column.
        model.ShouldNotBeNull();
        diagnostics.ShouldNotBeEmpty();
        var first = diagnostics[0];
        first.Severity.ShouldBe(DiagnosticSeverity.Error);
        first.Line.ShouldBe(2);          // the offending `{` is on line 2
        (first.Column > 0).ShouldBeTrue();
    }

    [Fact]
    public void Empty_input_is_valid()
    {
        var (model, diagnostics) = new KoineCompiler().Parse("");

        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        model.Contexts.ShouldBeEmpty();
    }

    [Fact]
    public void Regex_on_following_line_parses()
    {
        // The regex literal may sit on the line after `matches`.
        const string src =
            "context C {\n  value V {\n    raw: String\n    invariant raw matches\n      /^[a-z]+$/ \"lower\"\n  }\n}\n";
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
    }

    [Fact]
    public void String_escapes_are_decoded()
    {
        // \n \t \\ \" must be decoded into real characters in the AST.
        const string src =
            "context C {\n  value V {\n    x: Int\n    invariant x >= 0 \"a\\nb\\tc\\\\d\\\"e\"\n  }\n}\n";
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();

        var value = (Ast.ValueObjectDecl)model!.Contexts[0].Types[0];
        value.Invariants[0].Message.ShouldBe("a\nb\tc\\d\"e");
    }

    [Fact]
    public void Soft_keyword_as_declaration_name_reports_KOI0002()
    {
        // `from` is a soft keyword (legal as a field/member name) but cannot be the
        // bare declaration name following `value`.
        const string source = "context C {\n  value from {\n  }\n}\n";

        var (model, diagnostics) = new KoineCompiler().Parse(source);

        // Error-tolerant parsing returns a partial model, but the tailored KOI0002 still fires.
        model.ShouldNotBeNull();
        var first = diagnostics[0];
        first.Code.ShouldBe(DiagnosticCodes.ReservedWordInDeclarationName);
        first.Message.ShouldContain("'from' is a Koine keyword");
        first.Message.ShouldContain("plain identifier");
        first.Line.ShouldBe(2);
    }

    [Fact]
    public void Soft_keyword_as_enum_name_reports_KOI0002()
    {
        // `query` is a soft keyword used in the hard-Identifier position after `enum`.
        const string source = "context C {\n  enum query {\n  }\n}\n";

        var (_, diagnostics) = new KoineCompiler().Parse(source);

        diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.ReservedWordInDeclarationName && d.Message.Contains("'query'"));
    }

    [Fact]
    public void Fully_reserved_word_as_declaration_name_reports_KOI0002()
    {
        // `invariant` is fully reserved and can never be a declaration name.
        const string source = "context C {\n  value invariant {\n  }\n}\n";

        var (model, diagnostics) = new KoineCompiler().Parse(source);

        // Error-tolerant parsing returns a partial model, but the fully-reserved KOI0002 still fires.
        model.ShouldNotBeNull();
        var first = diagnostics[0];
        first.Code.ShouldBe(DiagnosticCodes.ReservedWordInDeclarationName);
        first.Message.ShouldContain("fully reserved");
    }

    [Fact]
    public void Soft_keyword_as_field_name_still_parses()
    {
        // The same word is perfectly legal as a member name — KOI0002 must NOT fire here.
        const string source = "context C {\n  value V {\n    from: String\n  }\n}\n";

        var (model, diagnostics) = new KoineCompiler().Parse(source);

        model.ShouldNotBeNull();
        diagnostics.ShouldNotContain(d => d.Code == DiagnosticCodes.ReservedWordInDeclarationName);
    }

    [Fact]
    public void Unrelated_syntax_error_stays_KOI0001()
    {
        // A non-keyword syntax error must keep the generic syntax diagnostic.
        const string source = "context C {\n  value {\n  }\n}\n";

        var (_, diagnostics) = new KoineCompiler().Parse(source);

        diagnostics[0].Code.ShouldBe(DiagnosticCodes.SyntaxError);
    }

    [Theory]
    // Regression for #603: a recovered parse of a malformed/unclosed postfix chain
    // (`.method(args)` / `.member`) must never throw out of the model builder. The walk in
    // BuildPostfix read `children[i]` / `children[i + 1]` past the end of the truncated subtree —
    // ANTLR's recovery does not synthesize the missing `)` / member name — so an unclosed call or a
    // dangling dot surfaced an ArgumentOutOfRangeException straight out of the public Parse API.
    // Each case must instead yield a clean syntax diagnostic carrying line/column.
    [InlineData("context C { value V { x: Int = a.b( } }")]   // unclosed empty call — `(` is the last child
    [InlineData("context C { value V { x: Int = a.b(1 } }")]  // unclosed call with one argument
    [InlineData("context C { value V { x: Int = a. } }")]     // dangling dot — no member name follows
    [InlineData("context C { value V { x: Int = a.b(). } }")] // dangling dot after a closed call
    public void Malformed_postfix_chain_yields_a_syntax_diagnostic_not_a_throw(string source)
    {
        // The throw used to come straight out of the public API; calling it must not throw.
        var (model, diagnostics) = Should.NotThrow(() => new KoineCompiler().Parse(source, "t.koi"));

        // The parser's own syntax error is surfaced as a clean diagnostic with a line/column, and the
        // best-effort partial model is still returned (never null) for downstream semantic analysis.
        model.ShouldNotBeNull();
        diagnostics.ShouldContain(d => d.Severity == DiagnosticSeverity.Error);
        var error = diagnostics.First(d => d.Severity == DiagnosticSeverity.Error);
        error.Line.ShouldBeGreaterThan(0);
        error.Column.ShouldBeGreaterThan(0);
    }
}
