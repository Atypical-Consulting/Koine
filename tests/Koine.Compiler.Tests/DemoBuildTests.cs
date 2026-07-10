namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1073: a runnable, self-checking demo per non-C# emitter target (TypeScript, Python, PHP,
/// Rust) — the polyglot analogue of <c>demo/Pizzeria.Domain</c>, which already proves the C# emitter
/// end-to-end by regenerating and compiling a template as part of its own build. Each demo lives at
/// <c>demo/&lt;lang&gt;/</c> and regenerates <c>templates/starters/ordering</c> to that target with the
/// Koine CLI, then (toolchain permitting) builds and runs a small hand-written driver that constructs the
/// generated <c>Order</c> aggregate and asserts VALUES (never emitted formatting), so these demos never
/// churn when the emitter's output shape changes.
/// <para>
/// Every demo's <c>run.sh</c> follows one contract: exit <c>0</c> on a clean generate+build+run+assert,
/// exit <c>3</c> as the toolchain-absent sentinel, non-zero on a real failure. <see cref="RunDemo"/>
/// shells that script and funnels the toolchain-presence decision through
/// <see cref="TestSupport.RequireOrSkip(bool, string)"/> — exactly like every <c>Conformance/</c> suite —
/// so a missing toolchain is a <c>Skipped</c> result locally and a hard <c>Failed</c> under
/// <c>KOINE_REQUIRE_CONFORMANCE</c> (CI, which installs every toolchain and runs this for real). The
/// script itself is ALWAYS run first, independent of the gate: a demo whose <c>run.sh</c> is missing or
/// broken must show up as a real failure once past the gate, not a false Skip.
/// </para>
/// </summary>
public class DemoBuildTests
{
    /// <summary>Notice shown when no TypeScript toolchain (tsc + node) is available locally.</summary>
    private const string NoTypeScriptToolchainNotice =
        "No tsc/node toolchain (set KOINE_TSC/KOINE_NODE) -- CI runs this for real.";

    /// <summary>
    /// R#1073 acceptance for the TypeScript target: <c>demo/typescript/run.sh</c> regenerates
    /// <c>templates/starters/ordering</c> to TypeScript, type-checks the emitted sources plus the
    /// hand-written driver under <c>tsc --strict</c>, transpiles, and runs the driver under <c>node</c> —
    /// which asserts the outcomes itself and exits non-zero on any failed assertion. Skipped (not failed)
    /// only when no tsc/node toolchain is present locally.
    /// </summary>
    [Fact]
    public void TypeScript_demo_builds_runs_and_asserts() =>
        RunDemo("typescript", TypeScriptToolchainAvailable, NoTypeScriptToolchainNotice);

    /// <summary>
    /// Shells <c>demo/&lt;demoDir&gt;/run.sh</c> from the repo root, ALWAYS (regardless of toolchain
    /// presence — a demo whose script is missing or broken must surface as a real failure once past the
    /// gate, never a silent Skip), then funnels the toolchain-presence decision through
    /// <see cref="TestSupport.RequireOrSkip(bool, string)"/>, and — only once past that gate, i.e. only
    /// when the toolchain IS present — asserts the script exited zero. Shared by every per-language demo
    /// fact in this file (and every later-added one): each language only supplies its own toolchain probe
    /// and notice.
    /// </summary>
    private static void RunDemo(string demoDir, Func<bool> toolchainAvailable, string notice)
    {
        string repoRoot = TestSupport.RepoPath(".");
        string script = Path.Combine(repoRoot, "demo", demoDir, "run.sh");
        File.Exists(script).ShouldBeTrue($"expected a run.sh for the '{demoDir}' demo at {script}");

        TestSupport.ProcessRun? run = TestSupport.RunProcess("/bin/bash", new[] { script }, workingDirectory: repoRoot);
        run.ShouldNotBeNull($"could not launch demo/{demoDir}/run.sh (is /bin/bash available?)");

        TestSupport.RequireOrSkip(toolchainAvailable(), notice);

        int exitCode = run!.Value.ExitCode;
        exitCode.ShouldBe(0,
            $"demo/{demoDir}/run.sh exited {exitCode} (expected 0):\n" +
            $"--- stdout ---\n{run.Value.StdOut}\n--- stderr ---\n{run.Value.StdErr}");
    }

    /// <summary>
    /// Whether a TypeScript toolchain (tsc + node) is available, probed the same way
    /// <see cref="Conformance.TypeScriptConformanceTests"/> does through <see cref="TestSupport"/>'s
    /// internal resolvers: an explicit <c>KOINE_TSC</c>/<c>KOINE_NODE</c> override always wins, otherwise
    /// a same-named binary on <c>PATH</c>.
    /// </summary>
    private static bool TypeScriptToolchainAvailable() =>
        ToolResolves("KOINE_TSC", "tsc") && ToolResolves("KOINE_NODE", "node");

    /// <summary>
    /// True when <paramref name="command"/> is resolvable: an explicit <paramref name="envVar"/> override
    /// (assumed valid, exactly like every <c>TestSupport</c> resolver) or a same-named binary on
    /// <c>PATH</c> (trying the Windows <c>.cmd</c>/<c>.exe</c> suffixes too). A tiny, dependency-free
    /// mirror of <c>TestSupport</c>'s private <c>OnPath</c> — shared by every per-language probe in this
    /// file, present and future.
    /// </summary>
    private static bool ToolResolves(string envVar, string command)
    {
        if (Environment.GetEnvironmentVariable(envVar) is { Length: > 0 })
        {
            return true;
        }

        string[] names = OperatingSystem.IsWindows()
            ? [command + ".cmd", command + ".exe", command]
            : [command];
        string[] dirs = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);

        return dirs
            .SelectMany(dir => names.Select(name => Path.Combine(dir, name)))
            .Any(File.Exists);
    }
}
