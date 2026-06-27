using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Error-tolerant parsing (resilient syntax): a syntax error in one place must not blank the
/// whole file/workspace. The compiler now returns a <em>partial</em> model built from ANTLR's
/// recovered tree, while still reporting the syntax diagnostics — and the emit path must NOT
/// emit anything for broken input (no regression of the "broken never compiles" contract).
/// </summary>
public class ResilienceCompilerTests
{
    // ---- single file: one typo still yields a partial model + syntax diagnostic ----------

    [Fact]
    public void Parse_with_one_syntax_error_returns_partial_model_with_valid_declarations()
    {
        // The first value object is well-formed; the second has a broken member type. ANTLR
        // recovers, so the good `Good` value object must still be present in the model.
        const string source =
            "context C {\n" +
            "  value Good { n: Int }\n" +
            "  value Bad { broken: !!! }\n" +
            "}\n";

        var (model, diagnostics) = new KoineCompiler().Parse(source);

        model.ShouldNotBeNull();
        model.Contexts.ShouldHaveSingleItem();
        model.Contexts[0].Name.ShouldBe("C");
        model.Contexts[0].Types.ShouldContain(t => t.Name == "Good");
        diagnostics.ShouldContain(d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void Diagnose_on_broken_file_returns_syntax_diagnostics_and_keeps_the_valid_model()
    {
        const string source =
            "context C {\n" +
            "  value Good { n: Int }\n" +
            "  value Bad { broken: !!! }\n" +
            "}\n";

        var compiler = new KoineCompiler();

        // Diagnose surfaces the syntax error...
        var diagnostics = compiler.Diagnose(source);
        diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.SyntaxError);

        // ...while Parse still exposes the valid declaration (the LSP can answer over it).
        var (model, _) = compiler.Parse(source);
        model.ShouldNotBeNull();
        model.Contexts[0].Types.ShouldContain(t => t.Name == "Good");
    }

    // ---- two-file workspace: a broken file no longer blanks the good one -----------------

    [Fact]
    public void Workspace_with_one_broken_file_still_yields_the_other_files_contexts()
    {
        var (model, diagnostics) = new KoineCompiler().Parse(new[]
        {
            new SourceFile("a.koi", "context A {\n  value V { broken: !!! }\n}\n"),
            new SourceFile("b.koi", "context B {\n  value W { m: Int }\n}\n"),
        });

        // The good file `b.koi` is no longer blanked by `a.koi`'s syntax error.
        model.ShouldNotBeNull();
        model.Contexts.ShouldContain(c => c.Name == "B");
        model.Contexts.Single(c => c.Name == "B").Types.ShouldContain(t => t.Name == "W");

        // ...and the syntax error carries its originating file.
        diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.SyntaxError && d.File == "a.koi");
        diagnostics.ShouldNotContain(d => d.File == "b.koi");
    }

    // ---- emit guard: broken input never emits, and never loses its syntax diagnostics ----

    [Fact]
    public void Compile_on_broken_input_fails_and_emits_no_files()
    {
        const string source =
            "context C {\n" +
            "  value Good { n: Int }\n" +
            "  value Bad { broken: !!! }\n" +
            "}\n";

        var result = new KoineCompiler().Compile(source, new CSharpEmitter());

        result.Success.ShouldBeFalse();
        result.Files.ShouldBeEmpty();
        result.Diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.SyntaxError);
    }

    // ---- contextmap: a half-typed relation must not crash the never-throw Parse path (#595) ----

    [Theory]
    [InlineData("contextmap { A }")]
    [InlineData("contextmap { A -> B }")]
    [InlineData("contextmap { A : partnership }")]
    public void Parse_with_malformed_contextmap_relation_does_not_throw_and_reports_a_syntax_error(string source)
    {
        // A half-typed `contextmap` relation recovers to a `relationDecl` with null/short children
        // (`relationRole()`/`relationArrow()` null, fewer than two `typeName()`s). BuildRelation must
        // yield a partial model plus a syntax diagnostic instead of throwing (NRE/IndexOutOfRange).
        var (model, diagnostics) = Should.NotThrow(() => new KoineCompiler().Parse(source));

        model.ShouldNotBeNull();
        diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.SyntaxError);
    }
}
