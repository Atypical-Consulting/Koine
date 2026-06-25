using Xunit.Sdk;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Unit tests for <see cref="TestSupport.RequireOrSkip"/> — the single decision point every conformance
/// suite funnels its "is the target toolchain present?" check through. The three branches are: present
/// (no-op), absent with the require-flag off (xUnit <c>Skipped</c>), absent with the flag on (hard
/// <c>Failed</c>). The branch logic is exercised through the explicit-flag overload and
/// <see cref="TestSupport.ParseRequireConformance"/> covers the env parsing, so these tests never mutate
/// the process-wide <c>KOINE_REQUIRE_CONFORMANCE</c> environment variable — keeping them deterministic
/// and free of any cross-collection env leak.
/// </summary>
public class RequireOrSkipTests
{
    /// <summary>A present toolchain must let the test proceed — <c>RequireOrSkip(true, …)</c> never throws,
    /// regardless of the require-flag (it short-circuits before the flag matters).</summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RequireOrSkip_with_toolchain_present_is_a_noop(bool requireConformance) =>
        Should.NotThrow(() => TestSupport.RequireOrSkip(true, "n", requireConformance));

    /// <summary>
    /// Absent toolchain with the require-flag off must report the suite as <c>Skipped</c>, i.e. throw
    /// <see cref="SkipException"/> — surfacing the gap instead of hiding it inside a green Passed.
    /// </summary>
    [Fact]
    public void RequireOrSkip_absent_and_flag_off_skips() =>
        Should.Throw<SkipException>(() => TestSupport.RequireOrSkip(false, "n", requireConformance: false));

    /// <summary>
    /// Absent toolchain with the require-flag on must turn a missing toolchain into a hard <c>Failed</c>,
    /// i.e. throw <see cref="FailException"/> (NOT a <see cref="SkipException"/>) — CI's contract that a
    /// dropped toolchain reddens the build instead of silently skipping.
    /// </summary>
    [Fact]
    public void RequireOrSkip_absent_and_flag_on_fails()
    {
        var ex = Should.Throw<FailException>(() => TestSupport.RequireOrSkip(false, "n", requireConformance: true));
        ex.ShouldNotBeAssignableTo<SkipException>();
    }

    /// <summary>
    /// <see cref="TestSupport.ParseRequireConformance"/> treats only <c>1</c> / <c>true</c>
    /// (case-insensitive) as truthy; everything else — including <c>0</c>, other words, empty, and unset
    /// (<c>null</c>) — is false, so the require-flag stays off unless deliberately enabled.
    /// </summary>
    [Theory]
    [InlineData("1", true)]
    [InlineData("true", true)]
    [InlineData("TRUE", true)]
    [InlineData("True", true)]
    [InlineData("0", false)]
    [InlineData("yes", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void ParseRequireConformance_reads_only_one_or_true_as_truthy(string? value, bool expected) =>
        TestSupport.ParseRequireConformance(value).ShouldBe(expected);
}
