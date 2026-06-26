using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Php;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Conformance harness for the PHP backend. This exercises the
/// <see cref="TestSupport.TypeCheckPhp"/> plumbing (write emitted <c>.php</c> → run
/// <c>phpstan analyse --level max</c>) plus the always-on <see cref="TestSupport.SyntaxCheckPhp"/>
/// (<c>php -l</c> over every emitted <c>.php</c> file) so it is ready to validate the PHP emitter
/// as it lands. When no <c>phpstan</c>/<c>php</c> toolchain is present locally the check is funneled
/// through <see cref="TestSupport.RequireOrSkip"/>, which reports the test as <c>Skipped</c> (not a
/// false Passed) — keeping <c>dotnet test</c> green without a PHP toolchain while surfacing the gap.
/// It NEVER silently passes a real error: a real error is only assertable when <c>phpstan</c> is
/// present, and then it IS asserted. CI sets <c>KOINE_REQUIRE_CONFORMANCE</c> and installs the
/// toolchain, so a missing one there is a hard <c>Failed</c> rather than a silent skip.
/// </summary>
public class PhpConformanceTests
{
    private const string NoToolchainNotice =
        "No PHP toolchain (phpstan) available locally; type-check not run. " +
        "Install phpstan (or set KOINE_PHPSTAN) — CI runs this for real.";

    private const string NoInterpreterNotice =
        "No PHP interpreter available locally; syntax check not run. " +
        "Install PHP (or set KOINE_PHP) — CI runs this for real.";

    /// <summary>Clean, valid PHP must type-check (skipped if no toolchain).</summary>
    [Fact]
    public void Harness_accepts_valid_php()
    {
        var files = new[]
        {
            new EmittedFile("ok.php",
                "<?php\n" +
                "declare(strict_types=1);\n" +
                "function add(int $a, int $b): int {\n" +
                "    return $a + $b;\n" +
                "}\n"),
        };

        var r = TestSupport.TypeCheckPhp(files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// A real PHPStan error must be reported, not silently swallowed — this proves the
    /// harness is a genuine check (the analogue of the Python/TypeScript negative fixture).
    /// </summary>
    [Fact]
    public void Harness_rejects_invalid_php()
    {
        var files = new[]
        {
            // Calling an undefined function is a real PHPStan level-max error.
            new EmittedFile("bad.php",
                "<?php\n" +
                "declare(strict_types=1);\n" +
                "function broken(): int {\n" +
                "    return this_function_does_not_exist();\n" +
                "}\n"),
        };

        var r = TestSupport.TypeCheckPhp(files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeFalse();
        r.Errors.ShouldNotBeEmpty();
    }

    /// <summary>
    /// The outcome contract <see cref="TestSupport.RequireOrSkip"/> relies on: a missing toolchain
    /// yields a <see cref="TestSupport.PhpCheck.Skipped"/> result whose <c>ToolchainAvailable</c> and
    /// <c>Ok</c> are both <c>false</c> (and no errors) — so it can never be mistaken for a real pass,
    /// and the skip/fail branch is reached exactly when the toolchain is absent.
    /// </summary>
    [Fact]
    public void Skipped_result_does_not_claim_success()
    {
        TestSupport.PhpCheck.Skipped.ToolchainAvailable.ShouldBeFalse();
        TestSupport.PhpCheck.Skipped.Ok.ShouldBeFalse();
        TestSupport.PhpCheck.Skipped.Errors.ShouldBeEmpty();
    }

    /// <summary>
    /// Parity gate for the always-present <c>KoineRuntime.php</c>: the emitted runtime — including
    /// its bc-math <c>Decimal</c> helpers — must pass <c>phpstan analyse --level max</c> with zero
    /// findings, the same strict-type bar the TypeScript (<c>tsc --strict</c>) and Python
    /// (<c>mypy --strict</c>) outputs already hold. Before the runtime typed its bc-math operands as
    /// <c>numeric-string</c> this reported the four <c>bcadd</c>/<c>bcsub</c> findings (issue #478).
    /// <para>
    /// The runtime is type-checked <b>in isolation</b> so this stays a focused regression guard on
    /// the emitted runtime, independent of the per-model emitter (entities/enums/repositories/value
    /// objects), whose own level-max typing gaps are a separate, larger concern tracked as a
    /// follow-up. Skipped (not failed) only when no <c>phpstan</c> is present locally; CI installs the
    /// toolchain and runs it for real.
    /// </para>
    /// </summary>
    [Fact]
    public void Emitted_runtime_typechecks_at_phpstan_level_max()
    {
        // The runtime is self-contained (depends only on core PHP + its own namespace), so it can be
        // analysed on its own — exactly the surface issue #478 is about.
        var runtimeOnly = new[] { new EmittedFile(PhpRuntime.FileName, PhpRuntime.Source) };

        var r = TestSupport.TypeCheckPhp(runtimeOnly);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// The always-on syntax gate: a valid PHP snippet must pass <c>php -l</c>.
    /// Skipped (not failed) only when no interpreter is present; with one it MUST parse cleanly.
    /// </summary>
    [Fact]
    public void Syntax_check_parses_valid_php()
    {
        var files = new[]
        {
            new EmittedFile("syntax.php",
                "<?php\n" +
                "declare(strict_types=1);\n" +
                "final class Money {\n" +
                "    public function __construct(\n" +
                "        public readonly int $amount,\n" +
                "        public readonly string $currency,\n" +
                "    ) {}\n" +
                "}\n"),
        };

        var r = TestSupport.SyntaxCheckPhp(files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoInterpreterNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }
}
