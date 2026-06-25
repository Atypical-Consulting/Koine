using Xunit.Sdk;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Collection for tests that mutate the process-wide <c>KOINE_REQUIRE_CONFORMANCE</c> environment
/// variable. <see cref="CollectionDefinitionAttribute.DisableParallelization"/> keeps this collection
/// from running alongside any other, so the env-var mutation can never leak into a conformance suite
/// reading the flag concurrently (the per-test <c>finally</c> restore only handles the sequential case).
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class EnvSensitiveCollection
{
    public const string Name = "env-sensitive";
}

/// <summary>
/// Unit tests for <see cref="TestSupport.RequireOrSkip"/> — the single decision point every conformance
/// suite funnels its "is the target toolchain present?" check through. The three branches are: present
/// (no-op), absent with the require-flag off (xUnit <c>Skipped</c>), absent with the flag on (hard
/// <c>Failed</c>). These tests own the process-wide <c>KOINE_REQUIRE_CONFORMANCE</c> flag, so the class
/// is in the non-parallel <see cref="EnvSensitiveCollection"/>.
/// </summary>
[Collection(EnvSensitiveCollection.Name)]
public class RequireOrSkipTests
{
    /// <summary>A present toolchain must let the test proceed — <c>RequireOrSkip(true, …)</c> never throws.</summary>
    [Fact]
    public void RequireOrSkip_with_toolchain_present_is_a_noop() =>
        Should.NotThrow(() => TestSupport.RequireOrSkip(true, "n"));

    /// <summary>
    /// Absent toolchain with the require-flag off must report the suite as <c>Skipped</c>, i.e. throw
    /// <see cref="SkipException"/> — surfacing the gap instead of hiding it inside a green Passed.
    /// </summary>
    [Fact]
    public void RequireOrSkip_absent_and_flag_off_skips() =>
        WithRequireConformance(null, () =>
            Should.Throw<SkipException>(() => TestSupport.RequireOrSkip(false, "n")));

    /// <summary>
    /// Sets <c>KOINE_REQUIRE_CONFORMANCE</c> to <paramref name="value"/> (<c>null</c> clears it) for the
    /// duration of <paramref name="body"/>, then restores the prior value — so the flag can never leak
    /// into a sibling test. Forcing the value (rather than assuming ambient absence) keeps these tests
    /// deterministic even in CI, which sets the flag globally.
    /// </summary>
    internal static void WithRequireConformance(string? value, Action body)
    {
        const string key = "KOINE_REQUIRE_CONFORMANCE";
        var prior = Environment.GetEnvironmentVariable(key);
        Environment.SetEnvironmentVariable(key, value);
        try
        {
            body();
        }
        finally
        {
            Environment.SetEnvironmentVariable(key, prior);
        }
    }
}
