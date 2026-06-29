using Koine.Cli.Commands;
using Koine.Compiler.Emit.CSharp;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #794: the C# <c>matches</c>-invariant ReDoS-guard match timeout (#641) is user-settable via
/// <c>targets.csharp.regexMatchTimeoutMs</c>, so a present-but-invalid value must be rejected before it
/// reaches the generated <c>TimeSpan.FromMilliseconds(N)</c> — a non-integer would silently disarm the
/// guard (falling back to 1000 ms), and <c>0</c> / <c>&lt; -1</c> would throw at the generated code's
/// OWN runtime. Validation is two-layered: a friendly hard-error in <see cref="BuildSettings.TryResolve"/>
/// via <c>TargetOptions.TryValidate</c> (the same check coverage and the LSP preview share), plus a
/// defensive guard in the C# emitter for a programmatically-supplied value (MCP / Studio / tests).
/// </summary>
public sealed class BuildRegexTimeoutTests : IDisposable
{
    private readonly List<string> _tempFiles = new();

    private BuildSettings SettingsWithConfig(string rawValue)
    {
        var configPath = Path.Combine(Path.GetTempPath(), $"koine-{Guid.NewGuid():N}.config");
        File.WriteAllText(configPath, $"targets.csharp.regexMatchTimeoutMs = {rawValue}\n");
        _tempFiles.Add(configPath);
        return new BuildSettings { Path = "x.koi", Config = configPath };
    }

    public void Dispose()
    {
        // File.Delete is a no-op for an already-absent path, so this is safe even if a test never wrote.
        foreach (var path in _tempFiles)
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Positive_timeout_resolves_onto_the_plan()
    {
        // Also confirms the threading: the resolved value reaches BuildPlan.Options unchanged.
        SettingsWithConfig("250").TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.RegexMatchTimeoutMs.ShouldBe(250);
    }

    [Fact]
    public void Unset_timeout_resolves_to_null()
    {
        new BuildSettings { Path = "x.koi" }.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.RegexMatchTimeoutMs.ShouldBeNull();
    }

    [Fact]
    public void Zero_timeout_is_a_hard_error()
    {
        SettingsWithConfig("0").TryResolve(out _, out var error).ShouldBeFalse();
        error.ShouldNotBeNull();
        error.ShouldContain("regexMatchTimeoutMs");
        error.ShouldContain("positive");
        error.ShouldContain("'0'");
    }

    [Fact]
    public void Negative_timeout_is_a_hard_error()
    {
        SettingsWithConfig("-5").TryResolve(out _, out var error).ShouldBeFalse();
        error.ShouldNotBeNull();
        error.ShouldContain("-5");
    }

    [Fact]
    public void Non_integer_timeout_is_a_hard_error()
    {
        // The dangerous case: a typo like `50ms` must NOT silently fall back to the 1000 ms default and
        // ship a 20x-looser ReDoS bound than the user asked for. A present-but-unparseable value is a
        // hard error, showing the offending text.
        SettingsWithConfig("soon").TryResolve(out _, out var error).ShouldBeFalse();
        error.ShouldNotBeNull();
        error.ShouldContain("regexMatchTimeoutMs");
        error.ShouldContain("positive");
        error.ShouldContain("'soon'");
    }

    [Fact]
    public void Csharp_emitter_rejects_a_non_positive_match_timeout()
    {
        // Defense in depth: a programmatically-built options bag with an out-of-range timeout must fail
        // fast at emitter construction, never producing code that throws at its own runtime. We reject
        // <= 0; the infinite/disabled sentinel (-1) is intentionally unsupported — the point of #641 is
        // to HAVE a bound.
        Should.Throw<ArgumentOutOfRangeException>(
            () => new CSharpEmitter(CSharpEmitterOptions.Empty with { RegexMatchTimeoutMs = 0 }));
        Should.Throw<ArgumentOutOfRangeException>(
            () => new CSharpEmitter(CSharpEmitterOptions.Empty with { RegexMatchTimeoutMs = -1 }));
    }

    [Fact]
    public void Csharp_emitter_accepts_a_positive_match_timeout()
    {
        // The valid path (the default 1000 and any positive override) constructs without throwing.
        _ = new CSharpEmitter(CSharpEmitterOptions.Empty with { RegexMatchTimeoutMs = 250 });
        _ = new CSharpEmitter(CSharpEmitterOptions.Empty);
    }
}
