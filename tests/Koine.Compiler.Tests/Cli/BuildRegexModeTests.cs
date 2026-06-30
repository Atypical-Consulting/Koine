using Koine.Cli.Commands;
using Koine.Compiler.Emit;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #831: the C# <c>matches</c>-invariant regex-evaluation mode is user-selectable via
/// <c>targets.csharp.regexMode</c>. A koine.config with <c>regexMode = sourceGenerated</c> must
/// select the <c>[GeneratedRegex]</c> form end-to-end; the absent/default path must remain
/// byte-identical (inline <c>Regex.IsMatch(…)</c> form) so no snapshot churn occurs; and an invalid
/// value must fail the build with a friendly diagnostic before the emitter is constructed.
/// The validation is two-layered: a friendly hard-error in <see cref="BuildSettings.TryResolve"/>
/// via <c>TargetOptions.TryValidate</c> (the same check the LSP preview shares), consistent with
/// <see cref="BuildRegexTimeoutTests"/>.
/// </summary>
public sealed class BuildRegexModeTests : IDisposable
{
    private readonly List<string> _tempFiles = new();

    private BuildSettings SettingsWithConfig(string rawValue)
    {
        var configPath = Path.Combine(Path.GetTempPath(), $"koine-{Guid.NewGuid():N}.config");
        File.WriteAllText(configPath, $"targets.csharp.regexMode = {rawValue}\n");
        _tempFiles.Add(configPath);
        return new BuildSettings { Path = "x.koi", Config = configPath };
    }

    public void Dispose()
    {
        foreach (var path in _tempFiles)
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Source_generated_mode_resolves_onto_the_plan()
    {
        // Also confirms the threading: the resolved text reaches BuildPlan.Options unchanged.
        SettingsWithConfig("sourceGenerated").TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.RegexModeText.ShouldBe("sourceGenerated");
    }

    [Fact]
    public void Unset_regex_mode_resolves_to_null()
    {
        new BuildSettings { Path = "x.koi" }.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.RegexModeText.ShouldBeNull();
    }

    [Fact]
    public void Invalid_regex_mode_is_a_hard_error()
    {
        // The dangerous case: a typo like 'sourcegen' must NOT silently fall back to the Inline default
        // and disarm the user's explicit opt-in. A present-but-unrecognized value is a hard error.
        SettingsWithConfig("sourcegen").TryResolve(out _, out var error).ShouldBeFalse();
        error.ShouldNotBeNull();
        error.ShouldContain("regexMode");
        error.ShouldContain("inline");
        error.ShouldContain("sourceGenerated");
        error.ShouldContain("'sourcegen'");
    }

    [Fact]
    public void Source_generated_mode_emits_generated_regex_attribute()
    {
        // End-to-end: a koine.config that sets regexMode = sourceGenerated must select the
        // [GeneratedRegex] form for the matches-invariant guard — proving the whole pipeline
        // (KoineConfig → TargetOptions → EmitterOptions → CSharpEmitterOptions) threads the value.
        var emitter = new CSharpEmitterProvider().Create(
            new Koine.Compiler.Emit.EmitterOptions(
                new Dictionary<string, string>(System.StringComparer.Ordinal),
                RegexMode: "sourceGenerated"));

        var emailCs = EmitEmailGuard(emitter);
        emailCs.ShouldContain("[GeneratedRegex");
        emailCs.ShouldNotContain("Regex.IsMatch(");
    }

    [Fact]
    public void Inline_mode_emits_regex_is_match()
    {
        // Default (no key set) must remain byte-identical: the inline Regex.IsMatch(…) form,
        // not [GeneratedRegex]. This is the snapshot-guard test: absent regexMode ⇒ no churn.
        var emailCs = EmitEmailGuard(new CSharpEmitterProvider().Create(
            Koine.Compiler.Emit.EmitterOptions.Empty));

        emailCs.ShouldContain("Regex.IsMatch(");
        emailCs.ShouldNotContain("[GeneratedRegex");
    }

    [Fact]
    public void Cli_registry_threads_source_generated_mode_into_emitter()
    {
        // End-to-end through the CLI seam: a koine.config that sets ONLY regexMode = sourceGenerated
        // must reach the emitted guard — proving KoineConfig → TargetOptions → EmitterOptions →
        // CSharpEmitterOptions all carry the value and no empty-bag guard short-circuits it (issue #831).
        var opts = Koine.Cli.KoineConfig.Parse("targets.csharp.regexMode = sourceGenerated\n").OptionsFor("csharp");
        Koine.Cli.Infrastructure.EmitterRegistry.TryCreate("csharp", opts, out var emitter).ShouldBeTrue();

        var emailCs = EmitEmailGuard(emitter);
        emailCs.ShouldContain("[GeneratedRegex");
        emailCs.ShouldNotContain("Regex.IsMatch(");
    }

    [Fact]
    public void Cli_registry_keeps_inline_mode_when_key_absent()
    {
        // No regexMode key ⇒ byte-identical to the historical default.
        var opts = Koine.Cli.KoineConfig.Parse("target = csharp\n").OptionsFor("csharp");
        Koine.Cli.Infrastructure.EmitterRegistry.TryCreate("csharp", opts, out var emitter).ShouldBeTrue();

        var emailCs = EmitEmailGuard(emitter);
        emailCs.ShouldContain("Regex.IsMatch(");
        emailCs.ShouldNotContain("[GeneratedRegex");
    }

    /// <summary>
    /// Emits the one-value-object matches-invariant fixture and returns the generated Email source,
    /// where the regex guard lives (either <c>Regex.IsMatch(…)</c> or <c>[GeneratedRegex]</c>).
    /// </summary>
    private static string EmitEmailGuard(Koine.Compiler.Emit.IEmitter emitter)
    {
        const string src =
            "context C {\n  value Email {\n    raw: String\n" +
            "    invariant raw matches /^[^@]+@[^@]+$/  \"invalid email address\"\n  }\n}\n";
        var result = new Services.KoineCompiler().Compile(src, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath.EndsWith("Email.cs")).Contents;
    }
}
