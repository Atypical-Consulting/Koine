using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Mcp;
using Koine.Mcp.Tools;

namespace Koine.Mcp.Tests;

/// <summary>
/// Tests for the transport-level input guards (<see cref="ToolGuards"/>) shared by the
/// validate/compile/format tools, plus the warning-count and <c># koine:disable</c> parity fixes in
/// <see cref="ValidationResult"/> / <see cref="ValidateTool"/>. The guards reject malformed inputs
/// with a stable <c>KOIMCP0xx</c> diagnostic before the compiler runs.
/// </summary>
public sealed class ToolGuardTests
{
    private static KoineFile[] Files(string source, string path = "test.koi") =>
        new[] { new KoineFile(path, source) };

    // ---- empty / missing files (KOIMCP001, finding 8) ----

    [Fact]
    public void Validate_with_no_files_fails_with_KOIMCP001()
    {
        var result = ValidateTool.Validate(Array.Empty<KoineFile>());

        result.Ok.ShouldBeFalse();
        result.Diagnostics.ShouldContain(d => d.Code == "KOIMCP001");
    }

    [Fact]
    public void Compile_with_no_files_fails_with_KOIMCP001()
    {
        var result = CompileTool.Compile(Array.Empty<KoineFile>());

        result.Success.ShouldBeFalse();
        result.Files.ShouldBeEmpty();
        result.Diagnostics.ShouldContain(d => d.Code == "KOIMCP001");
    }

    // ---- duplicate path (KOIMCP003, finding 3) ----

    [Fact]
    public void Validate_with_duplicate_path_fails_with_KOIMCP003()
    {
        var files = new[]
        {
            new KoineFile("dup.koi", "context A { enum Color { Red } }"),
            new KoineFile("dup.koi", "context B { enum Shade { Dark } }"),
        };

        var result = ValidateTool.Validate(files);

        // The guard must fire before compilation so the first file is not silently shadowed by the
        // second: we surface a duplicate-path error rather than dropping a file.
        result.Ok.ShouldBeFalse();
        var dup = result.Diagnostics.Where(d => d.Code == "KOIMCP003").ShouldHaveSingleItem();
        dup.Message.ShouldContain("dup.koi");
    }

    [Fact]
    public void Compile_with_duplicate_path_fails_with_KOIMCP003()
    {
        var files = new[]
        {
            new KoineFile("dup.koi", "context A { enum Color { Red } }"),
            new KoineFile("dup.koi", "context B { enum Shade { Dark } }"),
        };

        var result = CompileTool.Compile(files);

        result.Success.ShouldBeFalse();
        result.Files.ShouldBeEmpty();
        result.Diagnostics.ShouldContain(d => d.Code == "KOIMCP003");
    }

    // ---- malformed file entries (KOIMCP002, finding 7) ----

    [Fact]
    public void Validate_with_null_source_fails_with_KOIMCP002()
    {
        var files = new[] { new KoineFile("a.koi", null!) };

        var result = ValidateTool.Validate(files);

        result.Ok.ShouldBeFalse();
        result.Diagnostics.ShouldContain(d => d.Code == "KOIMCP002");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Validate_with_blank_path_fails_with_KOIMCP002(string path)
    {
        var files = new[] { new KoineFile(path, "context A { enum Color { Red } }") };

        var result = ValidateTool.Validate(files);

        result.Ok.ShouldBeFalse();
        result.Diagnostics.ShouldContain(d => d.Code == "KOIMCP002");
    }

    // ---- WarningCount counts ONLY Warning severity (finding 5) ----

    [Fact]
    public void ValidationResult_From_counts_only_warning_severity()
    {
        var span = new SourceSpan(1, 1);
        var diagnostics = new List<Diagnostic>
        {
            new(DiagnosticSeverity.Warning, "KOI1501", "a warning", span),
            new(DiagnosticSeverity.Info, "KOI9999", "an info note", span),
        };

        var result = ValidationResult.From(diagnostics);

        result.WarningCount.ShouldBe(1);
        result.ErrorCount.ShouldBe(0);
        result.Ok.ShouldBeTrue();
    }

    // ---- '# koine:disable' parity between validate and compile (finding 10) ----

    [Fact]
    public void Validate_and_compile_agree_on_koine_disable_suppression()
    {
        // A value object whose invariant inverts its inclusive bounds raises exactly one KOI0311
        // warning. A `// koine:disable KOI0311` directive on that line should suppress it for BOTH
        // tools — koine_compile already honored it; koine_validate now does too.
        const string notDisabled =
            "context C {\n" +
            "  value Temp { celsius: Int  invariant celsius >= 100 && celsius <= 0 }\n" +
            "}\n";

        const string disabled =
            "context C {\n" +
            "  value Temp { celsius: Int  invariant celsius >= 100 && celsius <= 0 } // koine:disable KOI0311\n" +
            "}\n";

        // Without the directive, the warning is present.
        var validateRaw = ValidateTool.Validate(Files(notDisabled));
        validateRaw.Diagnostics.Count(d => d.Code == "KOI0311").ShouldBeGreaterThan(0);

        var validateDisabled = ValidateTool.Validate(Files(disabled));
        var compileDisabled = CompileTool.Compile(Files(disabled));

        // Parity: the in-source suppression drops KOI0311 for both tools, and they agree on the
        // resulting diagnostic set.
        validateDisabled.Diagnostics.ShouldNotContain(d => d.Code == "KOI0311");
        compileDisabled.Diagnostics.ShouldNotContain(d => d.Code == "KOI0311");
        validateDisabled.Diagnostics.Count.ShouldBe(compileDisabled.Diagnostics.Count);
    }
}
