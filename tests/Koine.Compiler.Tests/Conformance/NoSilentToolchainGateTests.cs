using System.Text.RegularExpressions;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Meta-test (issue #501) that bans the SILENT toolchain gate from the conformance suite.
/// <para>
/// Every external-toolchain conformance assertion (PHP <c>php -l</c>/<c>phpstan</c>, TypeScript
/// <c>tsc</c>, Python <c>mypy</c>, Rust <c>cargo</c>) must funnel the "is the toolchain present?"
/// decision through <see cref="TestSupport.RequireOrSkip(bool, string)"/> — which reports
/// <c>Skipped</c> locally and a hard <c>Failed</c> under <c>KOINE_REQUIRE_CONFORMANCE</c>. The wrong
/// idiom is the brace-guarded conditional
/// </para>
/// <code>
/// if (check.ToolchainAvailable)
/// {
///     check.Ok.ShouldBeTrue(...);   // toolchain absent → no assertion runs → test reports PASSED
/// }
/// </code>
/// <para>
/// which SILENTLY PASSES when the toolchain is missing — exactly the false confidence #240 set out to
/// eliminate and that #240/#399/#409/#413 each removed by hand. This <see cref="Fact"/> is the
/// structural guard those four migrations lacked: it scans every sibling <c>Conformance/*.cs</c> and
/// fails if any still carries the silent gate, so a fifth such site can no longer be merged unnoticed.
/// </para>
/// <para>
/// <b>The one subtlety</b> (not anticipated by the issue's "zero offenders" assumption):
/// <see cref="CrossEmitterConformanceTests"/> legitimately uses the brace-guarded
/// <c>if (ts.ToolchainAvailable) { … }</c> form, but it is <i>not</i> a silent gate — its C# half always
/// asserts, and it pairs the <c>if</c> with a trailing
/// <c>TestSupport.RequireOrSkip(ts.ToolchainAvailable, …)</c> that reports Skipped/Failed on absence.
/// So a brace-guarded gate on receiver <c>R</c> is treated as an offender ONLY when the same file does
/// not also route <c>R</c> through <c>RequireOrSkip(R.ToolchainAvailable, …)</c>. This keeps the guard
/// green on today's <c>main</c> while still catching every historical silent-gate shape (which carried
/// no <c>RequireOrSkip</c> at all). Ternary / early-return shapes are deliberately out of scope (per the
/// issue): the documented regressions all use the <c>if (…) { … }</c> form, and this can be tightened
/// later if a new shape appears.
/// </para>
/// </summary>
public class NoSilentToolchainGateTests
{
    /// <summary>
    /// This file's own name — excluded from the scan because it names the banned idiom in its doc,
    /// regex, and self-test fixtures. Also the anchor that proves directory resolution found the real
    /// source tree (see the defensive check below).
    /// </summary>
    private const string SelfFileName = "NoSilentToolchainGateTests.cs";

    /// <summary>
    /// The banned brace-guarded positive form: <c>if (&lt;receiver&gt;.ToolchainAvailable) {</c>, tolerant
    /// of internal whitespace/newlines and any single identifier receiver (<c>check</c>/<c>syntax</c>/
    /// <c>r</c>/<c>ts</c>/…). Deliberately matches neither <c>RequireOrSkip(x.ToolchainAvailable, …)</c>
    /// (no leading <c>if</c>) nor a bare boolean read, so the helper's own legitimate use passes.
    /// </summary>
    private static readonly Regex BraceGuardedGate = new(
        @"if\s*\(\s*(?<recv>[A-Za-z_][A-Za-z0-9_]*)\.ToolchainAvailable\s*\)\s*\{",
        RegexOptions.Compiled);

    /// <summary>
    /// No <c>Conformance/*.cs</c> may gate an assertion behind <c>if (… .ToolchainAvailable) { … }</c>
    /// without funneling the absence through <see cref="TestSupport.RequireOrSkip(bool, string)"/>.
    /// </summary>
    [Fact]
    public void No_conformance_site_silently_gates_on_ToolchainAvailable()
    {
        string dir = TestSupport.RepoPath(Path.Combine("tests", "Koine.Compiler.Tests", "Conformance"));
        Directory.Exists(dir).ShouldBeTrue(
            $"could not locate the Conformance source directory at '{dir}' — directory resolution is " +
            "broken, so a path bug must not masquerade as 'no offenders'.");

        var allFiles = Directory.EnumerateFiles(dir, "*.cs").ToList();

        // Defensive anchor: the resolved directory MUST contain this very meta-test. If it doesn't, we
        // scanned the wrong tree and an empty offender list would be a false green — fail loudly instead.
        allFiles.ShouldContain(
            f => Path.GetFileName(f) == SelfFileName,
            $"resolved Conformance dir '{dir}' does not contain {SelfFileName} — directory resolution is wrong.");

        var offenders = allFiles
            .Where(f => Path.GetFileName(f) != SelfFileName)
            .Select(f => (Name: Path.GetFileName(f), Unpaired: UnpairedGateReceivers(File.ReadAllText(f))))
            .Where(x => x.Unpaired.Count > 0)
            .Select(x => $"{x.Name} (gated on {string.Join(", ", x.Unpaired.Select(r => $"'{r}'"))} with no matching RequireOrSkip)")
            .ToList();

        offenders.ShouldBeEmpty(
            "These Conformance/ files gate an assertion behind `if (… .ToolchainAvailable) { … }` without " +
            "also funneling the toolchain absence through TestSupport.RequireOrSkip — so they SILENTLY PASS " +
            "when the toolchain is missing. Route the gate through " +
            "TestSupport.RequireOrSkip(receiver.ToolchainAvailable, notice) instead:\n" +
            string.Join("\n", offenders));
    }

    /// <summary>
    /// Sanity-check the guard itself, so the scan above is a real check and not a vacuous pass: a
    /// synthetic silent gate IS flagged, the legitimate <c>if</c>&#160;+&#160;<c>RequireOrSkip</c> pairing
    /// (the <see cref="CrossEmitterConformanceTests"/> shape) is NOT, and a bare <c>RequireOrSkip</c> is
    /// never an offender.
    /// </summary>
    [Fact]
    public void Guard_flags_a_silent_gate_but_allows_the_RequireOrSkip_pairing()
    {
        const string silent =
            "var check = TestSupport.TypeCheckPhp(files);\n" +
            "if (check.ToolchainAvailable)\n" +
            "{\n" +
            "    check.Ok.ShouldBeTrue(\"\");\n" +
            "}\n";
        UnpairedGateReceivers(silent).ShouldBe(new[] { "check" });

        const string paired =
            "var ts = RunTypeScript(koi, scenarios);\n" +
            "if (ts.ToolchainAvailable)\n" +
            "{\n" +
            "    ts.Outcomes[i].ShouldBe(csOutcomes[i]);\n" +
            "}\n" +
            "TestSupport.RequireOrSkip(ts.ToolchainAvailable, NoToolchainNotice);\n";
        UnpairedGateReceivers(paired).ShouldBeEmpty();

        const string requireOnly =
            "TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);\n" +
            "r.Ok.ShouldBeTrue(string.Join(\"\\n\", r.Errors));\n";
        UnpairedGateReceivers(requireOnly).ShouldBeEmpty();
    }

    /// <summary>
    /// The distinct receivers gated by a brace-guarded <c>if (R.ToolchainAvailable) { … }</c> that are
    /// NOT also funneled through <c>RequireOrSkip(R.ToolchainAvailable, …)</c> in the same source — i.e.
    /// the genuine silent gates. A receiver paired with a <c>RequireOrSkip</c> (as in
    /// <see cref="CrossEmitterConformanceTests"/>) reports Skipped/Failed on absence and is therefore safe.
    /// </summary>
    private static IReadOnlyList<string> UnpairedGateReceivers(string source)
    {
        var unpaired = new List<string>();
        foreach (Match m in BraceGuardedGate.Matches(source))
        {
            string recv = m.Groups["recv"].Value;
            if (unpaired.Contains(recv))
            {
                continue;
            }

            bool funneled = Regex.IsMatch(
                source, @"RequireOrSkip\s*\(\s*" + Regex.Escape(recv) + @"\.ToolchainAvailable\b");
            if (!funneled)
            {
                unpaired.Add(recv);
            }
        }

        return unpaired;
    }
}
