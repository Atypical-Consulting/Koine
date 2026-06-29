using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Services;

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
    /// Full-model parity gate (issue #496): a complete emitted PHP model — entities, aggregates,
    /// enums, repositories, value objects, plus the always-present <c>KoineRuntime.php</c> — must pass
    /// <c>phpstan analyse --level max</c> with zero findings, the same strict-type bar the TypeScript
    /// (<c>tsc --strict</c>) and Python (<c>mypy --strict</c>) outputs already hold.
    /// <para>
    /// Where <see cref="Emitted_runtime_typechecks_at_phpstan_level_max"/> guards only the emitted
    /// runtime, this guards the per-model emitter. Before this issue it reported the per-model findings:
    /// untyped iterable <c>array</c> shapes (entity/aggregate/repository), the always-true entity
    /// <c>instanceof</c> guard, enum mixed-<c>$this->name</c> / always-true match arms, and the
    /// ungenericised <c>Range</c>. Skipped (not failed) only when no <c>phpstan</c> is present locally;
    /// CI installs the toolchain and runs it for real.
    /// </para>
    /// </summary>
    [Fact]
    public void Emitted_model_typechecks_at_phpstan_level_max()
    {
        var result = new KoineCompiler().Compile(PhpSnapshotTests.Fixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #676 acceptance: a <c>distinctBy</c> over a value-object selector must type-check under
    /// <c>phpstan --level max</c>. The fix lowers it to a structural distinct count over the generated
    /// <c>equals()</c> (never <c>array_unique</c>, whose <c>SORT_STRING</c> cast fatals on a VO with no
    /// <c>__toString</c>); this guards that the emitted fold is strict-type clean. Skipped (not failed)
    /// only when no <c>phpstan</c> is present locally; CI installs the toolchain and runs it for real.
    /// </summary>
    [Fact]
    public void DistinctBy_over_value_object_selector_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  value Sku { code: String }\n" +
            "  value Line {\n" +
            "    sku: Sku\n" +
            "    tag: Sku?\n" +
            "  }\n" +
            "  value Basket {\n" +
            "    lines: List<Line>\n" +
            "    uniqueSkus: Bool = lines.distinctBy(l => l.sku)\n" +
            "    uniqueTags: Bool = lines.distinctBy(l => l.tag)\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #687 acceptance: a <c>distinctBy</c> over an <em>entity</em> selector must type-check
    /// under <c>phpstan --level max</c>. Like a value object, an entity is emitted as a class with no
    /// <c>__toString</c>, so the old <c>array_unique</c> path would fatal at runtime; the fix routes an
    /// entity selector through the same structural <c>equals()</c> fold as value objects. This guards
    /// that the emitted entity fold is strict-type clean. Skipped (not failed) only when no
    /// <c>phpstan</c> is present locally; CI installs the toolchain and runs it for real.
    /// </summary>
    [Fact]
    public void DistinctBy_over_entity_selector_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  aggregate Cart root Basket {\n" +
            "    entity Line identified by LineId {\n" +
            "      qty: Int\n" +
            "    }\n" +
            "    entity Basket identified by BasketId {\n" +
            "      lines: List<Line>\n" +
            "      uniqueLines: Bool = lines.distinctBy(l => l)\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #692 acceptance: a <c>sum</c> fold whose element <em>and</em> result are a value object
    /// (the pizzeria-style <c>total: Money = lines.sum(l =&gt; l)</c>) must type-check under
    /// <c>phpstan --level max</c> and stay type-preserving — the getter returns the value-object type,
    /// not <c>Decimal</c>. Before the fix the emitted <c>Decimal::sum(array&lt;Money&gt;)</c> reported
    /// <c>return.type</c> (the getter returns <c>Decimal</c> where <c>Money</c> is declared) and
    /// <c>argument.type</c> (<c>array&lt;Money&gt;</c> given, <c>array&lt;Decimal&gt;</c> expected); the
    /// generic <c>@template T of Summable</c> helper makes the fold preserve the element type. The
    /// Decimal-element fold (issue #601) stays clean too — see the runtime/model gates above. Skipped
    /// (not failed) only when no <c>phpstan</c> is present locally; CI installs the toolchain and runs
    /// it for real.
    /// </summary>
    [Fact]
    public void Value_object_element_sum_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value Basket {\n" +
            "    lines: List<Money>\n" +
            "    total: Money = lines.sum(l => l)\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #717 (Bug 1) acceptance: a <c>sum</c>/<c>map</c> fold that projects a <em>derived</em>
    /// member of the element (the pizzeria-style <c>total: Money = lines.sum(l =&gt; l.payable)</c>,
    /// where <c>payable</c> is a computed getter) must type-check under <c>phpstan --level max</c>.
    /// Before the fix the lambda body emitted a property read <c>$l-&gt;payable</c> instead of the
    /// getter call <c>$l-&gt;payable()</c> — <c>property.notFound</c>, and the mapped array degrades to
    /// <c>list&lt;mixed&gt;</c> so the generic <c>Decimal::sum</c> helper cannot bind its
    /// <c>@template T</c> (defeating #692 for a derived-member projection). The sibling of #615 for the
    /// <c>array_map</c>/fold lambda path. Skipped (not failed) only when no <c>phpstan</c> is present
    /// locally; CI installs the toolchain and runs it for real.
    /// </summary>
    [Fact]
    public void Derived_member_fold_projection_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value Line {\n" +
            "    base: Money\n" +
            "    payable: Money = base\n" +
            "  }\n" +
            "  value Cart {\n" +
            "    lines: List<Line>\n" +
            "    total: Money = lines.sum(l => l.payable)\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
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
