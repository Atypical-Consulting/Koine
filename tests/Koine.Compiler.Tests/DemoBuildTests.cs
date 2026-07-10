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
/// shells that script (via <c>bash</c>, PATH-resolved) ALWAYS, independent of the toolchain gate — a
/// demo whose <c>run.sh</c> is missing must show up as a real assertion failure, never a false Skip —
/// and then funnels BOTH the toolchain-presence decision and whether the script could even be launched
/// (e.g. no <c>bash</c> on <c>PATH</c>) through <see cref="TestSupport.RequireOrSkip(bool, string)"/> —
/// exactly like every <c>Conformance/</c> suite — so either gap is a <c>Skipped</c> result locally and a
/// hard <c>Failed</c> under <c>KOINE_REQUIRE_CONFORMANCE</c> (CI, which installs every toolchain and a
/// shell and runs this for real).
/// </para>
/// </summary>
public class DemoBuildTests
{
    /// <summary>Notice shown when no TypeScript toolchain (tsc + node) is available locally.</summary>
    private const string NoTypeScriptToolchainNotice =
        "No tsc/node toolchain (set KOINE_TSC/KOINE_NODE) -- CI runs this for real.";

    /// <summary>Notice shown when no Python toolchain (mypy + a Python interpreter) is available locally.</summary>
    private const string NoPythonToolchainNotice =
        "No mypy/python toolchain (set KOINE_MYPY/KOINE_PYTHON) -- CI runs this for real.";

    /// <summary>Notice shown when no PHP toolchain (phpstan + a PHP interpreter) is available locally.</summary>
    private const string NoPhpToolchainNotice =
        "No phpstan/php toolchain (set KOINE_PHPSTAN/KOINE_PHP) -- CI runs this for real.";

    /// <summary>Notice shown when no Rust toolchain (cargo) is available locally.</summary>
    private const string NoRustToolchainNotice =
        "No cargo toolchain (set KOINE_CARGO) -- CI runs this for real.";

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
    /// R#1073 acceptance for the Python target: <c>demo/python/run.sh</c> regenerates
    /// <c>templates/starters/ordering</c> to Python, type-checks the generated package plus the
    /// hand-written driver under <c>mypy --strict</c>, and runs the driver under Python — which asserts
    /// the outcomes itself and exits non-zero on any failed assertion. Skipped (not failed) only when no
    /// mypy/python toolchain is present locally.
    /// </summary>
    [Fact]
    public void Python_demo_builds_runs_and_asserts() =>
        RunDemo("python", PythonToolchainAvailable, NoPythonToolchainNotice);

    /// <summary>
    /// R#1073 acceptance for the PHP target: <c>demo/php/run.sh</c> regenerates
    /// <c>templates/starters/ordering</c> to PHP, runs <c>php -l</c> over every emitted file plus the
    /// hand-written driver, type-checks the lot under <c>phpstan analyse --level max</c>, and runs the
    /// driver under <c>php</c> — which asserts the outcomes itself and exits non-zero on any failed
    /// assertion. Skipped (not failed) only when no phpstan/php toolchain is present locally.
    /// </summary>
    [Fact]
    public void Php_demo_builds_runs_and_asserts() =>
        RunDemo("php", PhpToolchainAvailable, NoPhpToolchainNotice);

    /// <summary>
    /// R#1073 acceptance for the Rust target: <c>demo/rust/run.sh</c> regenerates
    /// <c>templates/starters/ordering</c> to Rust as a <c>koine-domain</c> crate, then builds and
    /// runs the hand-written driver (<c>src/main.rs</c>) under <c>cargo run</c> — cargo's own
    /// compile step IS the type-check for this target, so there is no separate lint pass the way
    /// tsc/mypy/phpstan provide for the other three demos. The driver asserts the outcomes itself
    /// and exits non-zero on any failed assertion. Skipped (not failed) only when no cargo
    /// toolchain is present locally.
    /// </summary>
    [Fact]
    public void Rust_demo_builds_runs_and_asserts() =>
        RunDemo("rust", RustToolchainAvailable, NoRustToolchainNotice);

    /// <summary>
    /// Shells <c>demo/&lt;demoDir&gt;/run.sh</c> from the repo root, ALWAYS (regardless of toolchain
    /// presence — a demo whose script is missing or broken must surface as a real failure once past the
    /// gate, never a silent Skip), then folds both the toolchain-presence probe AND whether the script
    /// could even be launched into a single <see cref="TestSupport.RequireOrSkip(bool, string)"/> gate —
    /// so a machine with no <c>bash</c> on <c>PATH</c> degrades to a clean local Skip (and a hard Failed
    /// under <c>KOINE_REQUIRE_CONFORMANCE</c> / CI) exactly like every other toolchain-absence case,
    /// rather than a hard crash on a null process result. Only once past that gate, i.e. only when the
    /// toolchain IS present and the script DID launch, does it assert the script exited zero. Shared by
    /// every per-language demo fact in this file (and every later-added one): each language only
    /// supplies its own toolchain probe and notice.
    /// </summary>
    private static void RunDemo(string demoDir, Func<bool> toolchainAvailable, string notice)
    {
        string repoRoot = TestSupport.RepoPath(".");
        string script = Path.Combine(repoRoot, "demo", demoDir, "run.sh");
        File.Exists(script).ShouldBeTrue($"expected a run.sh for the '{demoDir}' demo at {script}");

        TestSupport.ProcessRun? run = TestSupport.RunProcess("bash", new[] { script }, workingDirectory: repoRoot);

        TestSupport.RequireOrSkip(toolchainAvailable() && run is not null, notice);

        int exitCode = run!.Value.ExitCode;
        exitCode.ShouldBe(0,
            $"demo/{demoDir}/run.sh exited {exitCode} (expected 0):\n" +
            $"--- stdout ---\n{run.Value.StdOut}\n--- stderr ---\n{run.Value.StdErr}");
    }

    /// <summary>
    /// Whether a TypeScript toolchain (tsc + node) is available, resolved by calling
    /// <see cref="TestSupport.ResolveTsc"/> / <see cref="TestSupport.ResolveNode"/> directly — the same
    /// resolvers <see cref="Conformance.TypeScriptConformanceTests"/> uses, including the repo-local
    /// <c>tsc</c> / <c>npx --no-install</c> fallback tiers, so this probe never diverges from what those
    /// tests (and CI) actually resolve.
    /// </summary>
    private static bool TypeScriptToolchainAvailable() =>
        TestSupport.ResolveTsc() is not null && TestSupport.ResolveNode() is not null;

    /// <summary>
    /// Whether a Python toolchain (mypy + a Python 3.11+ interpreter) is available, resolved by calling
    /// <see cref="TestSupport.ResolvePython"/> / <see cref="TestSupport.ResolveMypy"/> directly — the
    /// same resolvers <see cref="Conformance.PythonConformanceTests"/> uses, including the "actually
    /// launch it and require exit 0" checks those resolvers perform, so this probe never reports a
    /// toolchain as available when the real resolver would call it absent.
    /// </summary>
    private static bool PythonToolchainAvailable() =>
        TestSupport.ResolvePython() is not null && TestSupport.ResolveMypy() is not null;

    /// <summary>
    /// Whether a PHP toolchain (phpstan + a PHP interpreter) is available, resolved by calling
    /// <see cref="TestSupport.ResolvePhp"/> / <see cref="TestSupport.ResolvePhpStan"/> directly — the
    /// same resolvers <see cref="Conformance.PhpConformanceTests"/> uses, including the "actually launch
    /// it and require exit 0" check those resolvers perform, so a stray non-executable
    /// <c>vendor/bin/phpstan</c> is correctly reported as absent here too.
    /// </summary>
    private static bool PhpToolchainAvailable() =>
        TestSupport.ResolvePhp() is not null && TestSupport.ResolvePhpStan() is not null;

    /// <summary>
    /// Whether a Rust toolchain (cargo) is available, resolved by calling
    /// <see cref="TestSupport.ResolveCargo"/> directly — the same resolver
    /// <see cref="Conformance.RustConformanceTests"/> uses. Unlike <see cref="TestSupport.CompileRust"/>,
    /// this probe does not additionally require the dependency fetch to succeed offline — an absent
    /// registry is a <c>run.sh</c>-level failure the demo's own <c>cargo run</c> surfaces directly,
    /// not a silent Skip.
    /// </summary>
    private static bool RustToolchainAvailable() =>
        TestSupport.ResolveCargo() is not null;
}
