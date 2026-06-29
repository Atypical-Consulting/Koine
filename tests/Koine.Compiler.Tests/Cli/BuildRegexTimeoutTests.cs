using Koine.Cli.Commands;
using Koine.Compiler.Emit.CSharp;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #794: the C# <c>matches</c>-invariant ReDoS-guard match timeout (#641) is user-settable via
/// <c>targets.csharp.regexMatchTimeoutMs</c>, so an invalid (non-positive) value must be rejected
/// before it reaches the generated <c>TimeSpan.FromMilliseconds(N)</c> — which throws at the generated
/// code's OWN runtime for <c>0</c> / <c>&lt; -1</c>. Validation is two-layered: a friendly CLI
/// hard-error in <see cref="BuildSettings.TryResolve"/> (mirroring how <c>--app-mapping</c> rejects an
/// unknown mode), plus a defensive guard in the C# emitter for a programmatically-supplied value
/// (MCP / Studio / tests).
/// </summary>
public class BuildRegexTimeoutTests
{
    private static BuildSettings SettingsWithConfig(string rawValue)
    {
        var configPath = Path.Combine(Path.GetTempPath(), $"koine-{Guid.NewGuid():N}.config");
        File.WriteAllText(configPath, $"targets.csharp.regexMatchTimeoutMs = {rawValue}\n");
        return new BuildSettings { Path = "x.koi", Config = configPath };
    }

    [Fact]
    public void Positive_timeout_resolves_onto_the_plan()
    {
        // Also confirms Task 2's threading: the resolved value reaches BuildPlan.Options unchanged.
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
