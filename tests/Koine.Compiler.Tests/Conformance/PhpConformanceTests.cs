using Koine.Compiler.Emit;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Conformance harness for the PHP backend. This exercises the
/// <see cref="TestSupport.TypeCheckPhp"/> plumbing (write emitted <c>.php</c> → run
/// <c>phpstan analyse --level max</c>) plus the always-on <see cref="TestSupport.SyntaxCheckPhp"/>
/// (<c>php -l</c> over every emitted <c>.php</c> file) so it is ready to validate the PHP emitter
/// as it lands. When no <c>phpstan</c>/<c>php</c> toolchain is present locally the type-check is
/// reported as INCONCLUSIVE (a notice on the test output, no assertion) rather than failing —
/// keeping <c>dotnet test</c> green without a PHP toolchain. It NEVER silently passes a real
/// error: a real error is only assertable when <c>phpstan</c> is present, and then it IS asserted.
/// CI is expected to provide the toolchain and therefore actually run the check.
/// </summary>
/// <remarks>
/// Dynamic skip (<c>Assert.Skip</c>) is an xUnit v3 feature; on the v2 (2.9.x) runner here it is
/// reported as a failure, so an absent toolchain is surfaced as a logged inconclusive notice.
/// </remarks>
public class PhpConformanceTests
{
    private readonly ITestOutputHelper _output;

    public PhpConformanceTests(ITestOutputHelper output) => _output = output;

    private const string NoToolchainNotice =
        "INCONCLUSIVE: no PHP toolchain (phpstan) available locally; type-check not run. " +
        "Install phpstan (or set KOINE_PHPSTAN) — CI runs this for real.";

    private const string NoInterpreterNotice =
        "INCONCLUSIVE: no PHP interpreter available locally; syntax check not run. " +
        "Install PHP (or set KOINE_PHP) — CI runs this for real.";

    /// <summary>Clean, valid PHP must type-check (inconclusive if no toolchain).</summary>
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
        if (!r.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        Assert.True(r.Ok, string.Join("\n", r.Errors));
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
        if (!r.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        Assert.False(r.Ok);
        Assert.NotEmpty(r.Errors);
    }

    /// <summary>A missing toolchain yields an inconclusive-shaped result rather than a false pass.</summary>
    [Fact]
    public void Skipped_result_does_not_claim_success()
    {
        Assert.False(TestSupport.PhpCheck.Skipped.ToolchainAvailable);
        Assert.False(TestSupport.PhpCheck.Skipped.Ok);
        Assert.Empty(TestSupport.PhpCheck.Skipped.Errors);
    }

    /// <summary>
    /// The always-on syntax gate: a valid PHP snippet must pass <c>php -l</c>.
    /// Inconclusive (logged, not failed) only when no interpreter is present; with one it MUST
    /// parse cleanly.
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
        if (!r.ToolchainAvailable)
        {
            _output.WriteLine(NoInterpreterNotice);
            return;
        }

        Assert.True(r.Ok, string.Join("\n", r.Errors));
    }
}
