using Koine.Cli;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Task 2 (issue #69) — the diagnostic remap/suppression pass: <see cref="DiagnosticFilter"/>'s
/// fixed apply order (config overrides → warnings-as-errors → <c>// koine:disable</c> → drop
/// <c>none</c>), the <c>diagnostics.&lt;CODE&gt;</c> config family, and the wire-through to
/// <see cref="CompileResult.Success"/>.
/// </summary>
public class DiagnosticFilterTests
{
    // A value object whose invariant inverts its inclusive bounds — raises exactly one KOI0311 Warning.
    private const string InvertedBoundModel =
        "context C {\n  value Temp { celsius: Int  invariant celsius >= 100 && celsius <= 0 }\n}\n";

    private const string Warn = DiagnosticCodes.InvertedBound; // KOI0311, a Warning.

    private static CompileResult Compile(string source, DiagnosticFilterOptions options) =>
        new KoineCompiler().Compile(source, new CSharpEmitter(), options);

    // ---- (unit) DiagnosticFilter apply order & remap -----------------------

    private static readonly Diagnostic WarnAt =
        Diagnostic.Warning(Warn, "inverted", 2, 30);

    [Fact]
    public void Override_to_error_promotes_severity()
    {
        var map = new Dictionary<string, string> { [Warn] = "error" };
        var result = DiagnosticFilter.Apply(
            new[] { WarnAt }, new DiagnosticFilterOptions(map), source: "", file: null);

        result.ShouldHaveSingleItem().Severity.ShouldBe(DiagnosticSeverity.Error);
    }

    [Fact]
    public void Override_to_none_drops_the_diagnostic()
    {
        var map = new Dictionary<string, string> { [Warn] = "none" };
        var result = DiagnosticFilter.Apply(
            new[] { WarnAt }, new DiagnosticFilterOptions(map), source: "", file: null);

        result.ShouldBeEmpty();
    }

    [Fact]
    public void WarningsAsErrors_promotes_remaining_warnings()
    {
        var result = DiagnosticFilter.Apply(
            new[] { WarnAt }, new DiagnosticFilterOptions(WarningsAsErrors: true), source: "", file: null);

        result.ShouldHaveSingleItem().Severity.ShouldBe(DiagnosticSeverity.Error);
    }

    [Fact]
    public void WarningsAsErrors_beats_a_config_warning_override()
    {
        // ORDER: remap to `warning` first, THEN the global promotion → error.
        var map = new Dictionary<string, string> { [Warn] = "warning" };
        var result = DiagnosticFilter.Apply(
            new[] { WarnAt }, new DiagnosticFilterOptions(map, WarningsAsErrors: true), source: "", file: null);

        result.ShouldHaveSingleItem().Severity.ShouldBe(DiagnosticSeverity.Error);
    }

    [Fact]
    public void Hidden_and_info_are_kept_only_none_is_dropped()
    {
        var map = new Dictionary<string, string> { [Warn] = "hidden" };
        var result = DiagnosticFilter.Apply(
            new[] { WarnAt }, new DiagnosticFilterOptions(map), source: "", file: null);

        result.ShouldHaveSingleItem().Severity.ShouldBe(DiagnosticSeverity.Hidden);
    }

    [Fact]
    public void Disable_directive_suppresses_only_the_matching_line()
    {
        var keep = Diagnostic.Warning(Warn, "kept", 3, 1);
        // Directive on line 2 only: source line 2 carries the comment, line 3 does not.
        var source = "a\n// koine:disable " + Warn + "\nb\n";

        var result = DiagnosticFilter.Apply(
            new[] { WarnAt, keep }, DiagnosticFilterOptions.None, source, file: null);

        result.ShouldHaveSingleItem().Line.ShouldBe(3); // the line-3 diagnostic survives.
    }

    [Fact]
    public void Noop_options_with_no_directives_return_the_input_unchanged()
    {
        var input = new[] { WarnAt };
        DiagnosticFilter.Apply(input, DiagnosticFilterOptions.None, source: "", file: null)
            .ShouldBeSameAs(input);
    }

    // ---- (integration) through the real compile path -----------------------

    [Fact]
    public void Compile_baseline_warning_does_not_fail_the_build()
    {
        var result = Compile(InvertedBoundModel, DiagnosticFilterOptions.None);

        result.Success.ShouldBeTrue();
        result.Diagnostics.ShouldContain(d => d.Code == Warn && d.Severity == DiagnosticSeverity.Warning);
    }

    [Fact]
    public void Compile_with_override_to_error_fails_the_build()
    {
        var map = new Dictionary<string, string> { [Warn] = "error" };
        var result = Compile(InvertedBoundModel, new DiagnosticFilterOptions(map));

        result.Success.ShouldBeFalse();
        result.Diagnostics.ShouldContain(d => d.Code == Warn && d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void Compile_with_override_to_none_removes_it_and_build_succeeds()
    {
        var map = new Dictionary<string, string> { [Warn] = "none" };
        var result = Compile(InvertedBoundModel, new DiagnosticFilterOptions(map));

        result.Success.ShouldBeTrue();
        result.Diagnostics.ShouldNotContain(d => d.Code == Warn);
    }

    [Fact]
    public void Compile_with_warnings_as_errors_fails_the_build()
    {
        var result = Compile(InvertedBoundModel, new DiagnosticFilterOptions(WarningsAsErrors: true));

        result.Success.ShouldBeFalse();
    }

    [Fact]
    public void Compile_disable_directive_suppresses_one_warning_leaving_the_adjacent_one()
    {
        // Put a disable directive on the SECOND warning's line (Heat, line 3) only; the first
        // warning (Temp, line 2) must survive.
        var src =
            "context C {\n" +
            "  value Temp { celsius: Int  invariant celsius >= 100 && celsius <= 0 }\n" +
            "  value Heat { kelvin: Int  invariant kelvin >= 100 && kelvin <= 0 } // koine:disable " + Warn + "\n" +
            "}\n";

        var result = Compile(src, DiagnosticFilterOptions.None);

        var warnings = result.Diagnostics.Where(d => d.Code == Warn).ToList();
        warnings.ShouldHaveSingleItem().Line.ShouldBe(2); // Temp's warning remains; Heat's is suppressed.
    }

    // ---- KoineConfig parsing of the diagnostics.<CODE> family --------------

    [Fact]
    public void Config_parses_diagnostics_code_family()
    {
        var config = KoineConfig.Parse("diagnostics.KOI0311 = error\ndiagnostics.KOI0806 = none\n");

        config.DiagnosticSeverity.ShouldNotBeNull();
        config.DiagnosticSeverity![DiagnosticCodes.InvertedBound].ShouldBe("error");
        config.DiagnosticSeverity[DiagnosticCodes.UninitializedFactoryField].ShouldBe("none");
    }

    [Fact]
    public void Config_keeps_check_severity_separate_from_diagnostics()
    {
        var config = KoineConfig.Parse("check.severity.KOI1510 = warning\ndiagnostics.KOI0311 = error\n");

        config.Severity.ShouldNotBeNull();
        config.Severity!["KOI1510"].ShouldBe("warning");
        config.Severity.ShouldNotContainKey("KOI0311");
        config.DiagnosticSeverity!["KOI0311"].ShouldBe("error");
    }

    [Fact]
    public void Config_without_any_diagnostics_keys_leaves_map_null()
    {
        KoineConfig.Parse("target = csharp\nout = generated\n").DiagnosticSeverity.ShouldBeNull();
    }
}
