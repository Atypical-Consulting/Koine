using Koine.Compiler.Emit;
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
    /// Issue #717 (Bug 2) acceptance: a <c>value-object × scalar</c> (and <c>scalar × value-object</c>)
    /// multiplication — the pizzeria-style <c>payable: Money = lineTotal * 0.9</c> — must type-check
    /// under <c>phpstan --level max</c> and be runtime-correct. Before the fix the translator routed it
    /// through the Decimal-arithmetic path, wrapping the value-object operand in
    /// <c>new \Koine\Runtime\Decimal($this-&gt;base())</c> (the <c>Decimal</c> ctor expects
    /// <c>string|int</c>) — <c>argument.type</c>, plus a wrong runtime value. The fix routes either
    /// operand-order to the value object's generated <c>multipliedBy(Decimal $factor): Money</c> scalar
    /// op (driven by <c>OperatorNeedsAnalyzer.BuildScalarOperatorNeeds</c>). Skipped (not failed) only
    /// when no <c>phpstan</c> is present locally; CI installs the toolchain and runs it for real.
    /// </summary>
    [Fact]
    public void Value_object_times_scalar_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value Line {\n" +
            "    base: Money\n" +
            "    discounted: Money = base * 0.9\n" +
            "    surcharged: Money = 1.1 * base\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #813 acceptance (plain face): a <c>value op value</c> arithmetic — the canonical
    /// <c>combined: Money = base + base</c> on a single-field decimal value object — must type-check
    /// under <c>phpstan --level max</c>. The call site already lowers to <c>$this-&gt;base-&gt;add(...)</c>
    /// (<see cref="PhpExpressionTranslator"/>'s value-object arithmetic path), but the PHP emitter does
    /// not generate the <c>add()</c> method unless the model folds the value object with <c>sum</c>
    /// (<c>OperatorNeedsAnalyzer.BuildAdditiveOperatorNeeds</c> only fires on a <c>sum(selector)</c>), so
    /// <c>add()</c> is undefined and phpstan reports <c>method.notFound</c>. The fix records a value
    /// object used in plain <c>+</c>/<c>-</c> arithmetic as needing the operator method and emits a
    /// concrete <c>add(self $other): self</c> delegating to the backing <c>Decimal</c>'s runtime
    /// <c>add</c>. Skipped (not failed) only when no <c>phpstan</c> is present locally; CI installs the
    /// toolchain and runs it for real.
    /// </summary>
    [Fact]
    public void Value_object_Decimal_arithmetic_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value Line {\n" +
            "    base: Money\n" +
            "    combined: Money = base + base\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #717 (Bug 3) acceptance: a <c>String + String</c> concatenation — the pizzeria-style
    /// <c>full: String = street + ", " + city</c> — must type-check under <c>phpstan --level max</c>
    /// and be runtime-correct. Before the fix the translator emitted PHP numeric <c>+</c>
    /// (<c>($this-&gt;street + ', ') + $this-&gt;city</c>), which phpstan rejects (a binary <c>+</c> on
    /// strings) and which throws a <c>TypeError</c> at runtime; the fix emits the PHP string operator
    /// <c>.</c> for a <c>String + String</c> chain while leaving <c>Decimal</c>/<c>Int</c> arithmetic
    /// untouched. Skipped (not failed) only when no <c>phpstan</c> is present locally; CI installs the
    /// toolchain and runs it for real.
    /// </summary>
    [Fact]
    public void String_concatenation_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  value Address {\n" +
            "    street: String\n" +
            "    city: String\n" +
            "    full: String = street + \", \" + city\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #787 acceptance: a <c>String + String</c> concatenation whose left operand is a
    /// <b>guard-narrowed optional</b> <c>String?</c> — <c>if name.isPresent then name + "!" …</c> —
    /// must type-check under <c>phpstan --level max</c>. Narrowing in Koine is validator-only
    /// (<c>ExpressionChecker._present</c>) and never reaches <see cref="Koine.Compiler.Ast.TypeResolver"/>,
    /// so the operand still infers as <c>String?</c> and #717's routing (gated on
    /// <c>IsString(IsOptional: false)</c>) fell back to the numeric <c>+</c> — invalid PHP on strings
    /// (<c>binaryOp.invalid</c>). The fix relaxes the routing so an optional <c>String</c> operand still
    /// selects <c>.</c> and writes it through a null-coalescing wrapper (<c>($expr ?? '')</c>) so the
    /// <c>.</c> site is provably non-null. The result member is optional (and the <c>else</c> branch
    /// yields the optional <c>name</c>) because the narrowed concat itself still infers as <c>String?</c>,
    /// which <c>OptionalAssignedToNonOptional</c> rejects for a non-optional member. Skipped (not failed)
    /// only when no <c>phpstan</c> is present locally; CI installs the toolchain and runs it for real.
    /// </summary>
    [Fact]
    public void Guarded_optional_String_concatenation_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  value Profile {\n" +
            "    name: String?\n" +
            "    label: String? = if name.isPresent then name + \"!\" else name\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #787 sibling: the guarded-optional <b>Decimal</b> arithmetic gap that shares the
    /// <c>IsDecimal(IsOptional: false)</c> shape. A guard-narrowed <c>Decimal?</c> operand
    /// (<c>if base.isPresent then base + base …</c>) still infers as <c>Decimal?</c>, so
    /// <c>TryWriteValueBinary</c> did not route it to the runtime <c>Decimal::add</c> and fell back to
    /// the native <c>+</c> — numeric arithmetic on a <c>\Koine\Runtime\Decimal</c> object, again
    /// <c>binaryOp.invalid</c>. The fix routes a guarded optional Decimal operand to <c>add</c>/… with a
    /// Decimal-non-null wrapper so the receiver/argument is never <c>Decimal|null</c>.
    /// <para>
    /// This fixture is an <b>entity</b> (not a value object) deliberately, to keep it focused on the
    /// guarded-optional <em>arithmetic</em> path: an entity's generated <c>equals()</c> compares its
    /// <c>id</c> alone, whereas a value object's structural <c>equals()</c> would <em>also</em> call
    /// <c>$this-&gt;base-&gt;equals(...)</c> on the nullable <c>Decimal?</c> member, dragging an unrelated
    /// concern into this fixture. When #787 landed, that structural-nullable-<c>equals()</c> concern was an
    /// independent untested gap (<c>method.nonObject</c> on <c>Decimal|null</c>); it is <b>now closed and
    /// locked</b> — the structural branch null-guards a nullable object member (shipped with #686 / PR
    /// #802) and is covered by
    /// <see cref="Value_object_nullable_member_equals_typechecks_at_phpstan_level_max"/> (#814). The entity
    /// here is retained only to keep this test on the arithmetic path. Skipped (not failed) only when no
    /// <c>phpstan</c> is present locally; CI runs it for real.
    /// </para>
    /// </summary>
    [Fact]
    public void Guarded_optional_Decimal_arithmetic_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  entity Account identified by AccountId {\n" +
            "    base: Decimal?\n" +
            "    total: Decimal? = if base.isPresent then base + base else base\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #814 acceptance: a <c>value</c> with a nullable <em>object-typed</em> member — a
    /// <c>Decimal?</c> or a value-object-typed optional — emits a structural <c>equals()</c> that must
    /// type-check under <c>phpstan --level max</c>. An object-typed member compares via its own
    /// <c>equals()</c> (#686), so a <em>nullable</em> one would, unguarded, call
    /// <c>$this-&gt;low-&gt;equals(...)</c> on <c>Decimal|null</c> — <c>method.nonObject</c> at phpstan-max
    /// and a <c>TypeError</c> at runtime when the member is actually <c>null</c>.
    /// <para>
    /// The guard that makes this clean shipped with #686 (PR #802): the structural branch wraps a
    /// nullable member in a null-first ternary
    /// (<c>$this-&gt;m === null ? $other-&gt;m === null : ($other-&gt;m !== null &amp;&amp; $this-&gt;m-&gt;equals($other-&gt;m))</c>)
    /// — both-null equal, one-null unequal, both-present structural. This fixture is the regression lock
    /// that was missing: it lets a <c>Decimal?</c> member live on a <c>value</c> rather than forcing the
    /// entity workaround #799 used (see <see cref="Guarded_optional_Decimal_arithmetic_typechecks_at_phpstan_level_max"/>).
    /// It covers both object-typed nullable kinds at once — the scalar <c>Decimal?</c> and a value-object
    /// optional (<c>Money?</c>) — since both route through the same structural-nullable branch. Skipped
    /// (not failed) only when no <c>phpstan</c> is present locally; CI installs the toolchain and runs it
    /// for real.
    /// </para>
    /// </summary>
    [Fact]
    public void Value_object_nullable_member_equals_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Catalog {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value PriceRange {\n" +
            "    low:  Decimal?\n" +   // the issue's exact repro: a nullable scalar-runtime object member
            "    high: Decimal\n" +
            "    cap:  Money?\n" +     // a value-object-typed optional — same structural-nullable branch
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1377 acceptance: an entity's generated <c>equals()</c> must compare its <c>id</c> member
    /// by <em>value</em> — via the branded id value object's own <c>equals()</c> — not by PHP's
    /// <c>===</c> object-reference identity. Two <c>OrderId</c> instances wrapping the same underlying
    /// value are the same identity even when they are two separate PHP objects (exactly what a
    /// repository rehydrating an entity from a persisted id on two separate loads produces); <c>===</c>
    /// on two PHP objects is reference identity and would wrongly report them as different entities.
    /// Matches the TypeScript (<c>this.id.equals(other.id)</c>) and Python
    /// (<c>self.id == other.id</c>, structural via the frozen dataclass) backends, and mirrors #686's
    /// fix for nested value-object fields inside a value object's own <c>equals()</c>
    /// (<c>PhpEmitter.ValueObjects.cs</c>'s <c>WriteEquals</c>) — that fix never propagated to the
    /// entity-equals path. Always-on guard (no phpstan toolchain needed): asserts the emitted body calls
    /// <c>$this-&gt;id-&gt;equals($other-&gt;id)</c> and never reference-compares the id with <c>===</c>.
    /// </summary>
    [Fact]
    public void Entity_equals_compares_id_by_value_not_by_reference()
    {
        const string src =
            "context Ordering {\n" +
            "  aggregate Sales root Order {\n" +
            "    entity Order identified by OrderId {\n" +
            "      status: String = \"Draft\"\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var orderPhp = result.Files.Single(f => f.RelativePath.EndsWith("Order.php", StringComparison.Ordinal)).Contents;
        orderPhp.ShouldContain("$this->id->equals($other->id)");
        orderPhp.ShouldNotContain("$this->id === $other->id");

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #813 acceptance (guarded-optional face — the #787 deferred half): a guard-narrowed
    /// optional value-object operand in arithmetic — <c>if base.isPresent then base + base else base</c>
    /// on a <c>Money?</c> member — must type-check under <c>phpstan --level max</c>. Narrowing in Koine
    /// is validator-only, so the operand still infers as <c>Money?</c> and
    /// <see cref="PhpExpressionTranslator"/>'s value-object arithmetic path (gated on the
    /// non-optional <c>IsArithmeticValueObject</c>) skipped it, falling back to the native <c>+</c> —
    /// invalid PHP on a class operand (<c>binaryOp.invalid</c>). The fix admits a guard-narrowed optional
    /// value-object operand to the method path and coalesces it to a non-null receiver/argument (mirror
    /// of the <c>Decimal</c> wrapper pattern in PR #799), so the <c>add()</c> site never sees
    /// <c>Money|null</c>. The fixture is an <b>entity</b> (its <c>equals()</c> compares its <c>id</c>
    /// alone) to isolate the guarded-optional arithmetic from the independent nullable-member structural
    /// <c>equals()</c> gap — identical reasoning to
    /// <see cref="Guarded_optional_Decimal_arithmetic_typechecks_at_phpstan_level_max"/>. Skipped (not
    /// failed) only when no <c>phpstan</c> is present locally; CI runs it for real.
    /// </summary>
    [Fact]
    public void Guarded_optional_value_object_arithmetic_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "  }\n" +
            "  entity Account identified by AccountId {\n" +
            "    base: Money?\n" +
            "    total: Money? = if base.isPresent then base + base else base\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #813 regression: an <b>unguarded</b> optional value-object operand in arithmetic —
    /// <c>total: Money? = base + base</c> with no <c>isPresent</c> guard — must stay a compile error.
    /// The guarded-optional fix relaxes only the PHP <em>emission/routing</em>; it must not weaken the
    /// validator, which still rejects dereferencing a possibly-absent optional in arithmetic (the same
    /// null-safety check that guards the <c>Decimal?</c> case). Guards the routing relaxation against
    /// silently accepting genuinely-nullable arithmetic.
    /// </summary>
    [Fact]
    public void Unguarded_optional_value_object_arithmetic_is_a_compile_error()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "  }\n" +
            "  entity Account identified by AccountId {\n" +
            "    base: Money?\n" +
            "    total: Money? = base + base\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());

        result.Success.ShouldBeFalse();
    }

    /// <summary>
    /// Issue #786 acceptance (the #778 follow-up for mixed operands): a
    /// <c>String + &lt;stringable-non-String&gt;</c> concatenation — and its reverse order — must
    /// type-check under <c>phpstan --level max</c> and be runtime-correct. PR #778 (#717, Bug 3)
    /// diverted only the <c>String + String</c> case to PHP's <c>.</c> operator and deliberately left
    /// the mixed case (e.g. <c>label: String = "Order #" + number</c>, where <c>number</c> is an
    /// <c>Int</c>) on numeric <c>+</c>, which phpstan rejects (<c>binaryOp.invalid</c>, "Binary
    /// operation + between string and int results in an error") and which throws a <c>TypeError</c> at
    /// runtime. The fix routes <c>String + Int</c> (in either operand order) to <c>.</c> too — PHP's
    /// <c>.</c> coerces an <c>int</c> on either side — while never routing a non-stringable operand
    /// (enum / value object / branded Id) to <c>.</c>. Skipped (not failed) only when no <c>phpstan</c>
    /// is present locally; CI installs the toolchain and runs it for real.
    /// </summary>
    [Fact]
    public void String_plus_non_string_concatenation_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  value Ticket {\n" +
            "    number: Int\n" +
            // mixed String + Int (Int on the right)
            "    label: String = \"Order #\" + number\n" +
            // mixed Int + String (Int on the left) — exercises both operand orders
            "    caption: String = number + \" items\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #805 acceptance: a <b>chained</b> mixed concatenation whose chain is led by a
    /// <em>non-String</em> operand — <c>display: String = hours + ":" + minutes</c>, with
    /// <c>hours</c>/<c>minutes</c> both <c>Int</c> — must type-check under <c>phpstan --level max</c>.
    /// PR #800 (#786) routed a single <c>String + &lt;stringable-non-String&gt;</c> join to PHP's
    /// <c>.</c> operator in either order, so a String-led chain concatenates correctly end-to-end. But
    /// for the left-associative <c>(hours + ":") + minutes</c>, <see cref="Koine.Compiler.Ast.TypeResolver"/>
    /// inferred the inner <c>Int + String</c> as <c>Int</c> (its <c>+</c> fallback was left-biased), so the
    /// outer <c>(…) + minutes</c> looked like <c>Int + Int</c> and stayed on numeric <c>+</c> —
    /// <c>(($this-&gt;hours . ':') + $this-&gt;minutes)</c>, which phpstan rejects (<c>binaryOp.invalid</c>).
    /// The fix adds a target-agnostic "String wins" rule to <c>TypeResolver</c>: any <c>+</c> with at least
    /// one <c>String</c> operand infers <c>String</c>, so the chain carries <c>String</c> forward and every
    /// join routes to <c>.</c> — <c>(($this-&gt;hours . ':') . $this-&gt;minutes)</c>. No PHP emitter change is
    /// needed once the types are right. Skipped (not failed) only when no <c>phpstan</c> is present locally;
    /// CI installs the toolchain and runs it for real.
    /// </summary>
    [Fact]
    public void Int_led_chained_mixed_concatenation_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Scheduling {\n" +
            "  value TimeOfDay {\n" +
            "    hours: Int\n" +
            "    minutes: Int\n" +
            // Int-led chain: (hours + ":") + minutes — the inner join must carry String to the outer one.
            "    display: String = hours + \":\" + minutes\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (runs without a phpstan toolchain): the #805 regression surface is the OUTER
        // join staying on numeric `+`. Assert the emitted chain routes to PHP's `.` at both joins so the
        // target-agnostic "String wins" inference is locked everywhere, not only on a phpstan-equipped CI.
        var php = string.Join("\n", result.Files.Select(f => f.Contents));
        php.ShouldContain("($this->hours . ':') . $this->minutes");
        php.ShouldNotContain("+ $this->minutes");

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #806 acceptance: <c>String + Bool</c> (and <c>Bool + String</c>) concatenation must
    /// type-check under <c>phpstan --level max</c> and produce the canonical cross-target
    /// <c>"true"</c>/<c>"false"</c> strings. PR #800 (#786) routes <c>String + Int</c> to PHP's <c>.</c>
    /// operator but deliberately excluded <c>Bool</c> from the stringable allow-list because PHP's native
    /// bool→string coercion (<c>"1"</c>/<c>""</c>) diverges from C# (<c>"True"</c>/<c>"False"</c>) and
    /// TypeScript (<c>"true"</c>/<c>"false"</c>). The fix admits non-optional <c>Bool</c> behind an
    /// explicit <c>($expr ? 'true' : 'false')</c> ternary that yields the canonical cross-target strings
    /// and is provably <c>string</c>-typed at the <c>.</c> site. Always-on guard: asserts the emitted
    /// ternary shape regardless of the local phpstan toolchain so the lowering is locked end-to-end.
    /// </summary>
    [Fact]
    public void String_plus_bool_concatenation_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Account {\n" +
            "  value Membership {\n" +
            "    isActive: Bool\n" +
            // String-led: String + Bool
            "    label: String = \"active: \" + isActive\n" +
            // Bool-led: Bool + String
            "    caption: String = isActive + \" status\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard: the Bool operand must be lowered to a ternary in both operand orders,
        // so the emitted PHP is provably string-typed at the `.` site (not the raw bool, which
        // phpstan --level max rejects as `binaryOp.invalid`).
        var php = string.Join("\n", result.Files.Select(f => f.Contents));
        php.ShouldContain("($this->isActive ? 'true' : 'false')");
        php.ShouldNotContain("+ $this->isActive");
        php.ShouldNotContain("$this->isActive +");
        php.ShouldNotContain(". $this->isActive");
        php.ShouldNotContain("$this->isActive .");

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Follow-up to #825 acceptance: a <c>value-object / scalar</c> division — <c>perUnit: Money = base / 4</c>
    /// — must type-check under <c>phpstan --level max</c>. The translator lowers it to
    /// <c>$this-&gt;base-&gt;dividedBy(...)</c>, but the PHP emitter's scalar-scaling emitter
    /// (<c>WriteScalarOp</c>) emits only <c>multipliedBy</c>, so <c>dividedBy</c> is undefined and phpstan
    /// reports <c>method.notFound</c>. The fix emits a <c>dividedBy(\Koine\Runtime\Decimal $factor): self</c>
    /// method delegating to the runtime <c>Decimal::div</c>, mirroring the <c>multipliedBy</c> companion
    /// (#717) and the quantity path. Skipped (not failed) only when no <c>phpstan</c> is present locally.
    /// </summary>
    [Fact]
    public void Value_object_dividedBy_scalar_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value Line {\n" +
            "    base: Money\n" +
            "    scaled: Money = base * 2\n" +
            "    perUnit: Money = base / 4\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1301 acceptance: a <b>divide-only</b> non-quantity value object — divided by a scalar
    /// somewhere in the model, but never multiplied by one anywhere — must still get a
    /// <c>dividedBy(\Koine\Runtime\Decimal $factor): self</c> method. Before the fix, PHP's demand-driven
    /// scalar-scaling gate (<c>PhpEmitter.ValueObjects.cs</c>, <c>WriteScalarOp</c>'s call site) checked
    /// only <c>needs.MultiplyFactors.Count &gt; 0</c> — <c>needs.DivideFactors</c> was never independently
    /// consulted — so <c>WriteScalarOp</c> never fired at all for a divide-only VO and neither
    /// <c>multipliedBy</c> nor <c>dividedBy</c> was emitted, even though the translator still
    /// unconditionally lowers <c>vo / scalar</c> to <c>$this-&gt;dividedBy(...)</c>. Always-on guard (no
    /// phpstan toolchain needed): asserts the emitted <c>Money</c> class declares <c>dividedBy</c>.
    /// </summary>
    [Fact]
    public void Divide_only_value_object_emits_dividedBy_method()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value Line {\n" +
            "    base: Money\n" +
            "    perUnit: Money = base / 4\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var moneyPhp = result.Files.Single(f => f.RelativePath.EndsWith("Money.php", StringComparison.Ordinal)).Contents;
        moneyPhp.ShouldContain("public function dividedBy(\\Koine\\Runtime\\Decimal $factor): self");
    }

    /// <summary>
    /// Issue #1301, other half of the fix: a <b>multiply-only</b> non-quantity value object — multiplied
    /// by a scalar somewhere in the model, but never divided by one anywhere — must get exactly
    /// <c>multipliedBy</c>, NOT a dead, unreachable <c>dividedBy</c> alongside it. Before the fix,
    /// <c>WriteScalarOp</c> unconditionally emitted BOTH methods together once its combined gate fired on
    /// <c>MultiplyFactors</c> alone, so a multiply-only VO wastefully declared a <c>dividedBy</c> no call
    /// site ever reaches. Always-on guard (no phpstan toolchain needed).
    /// </summary>
    [Fact]
    public void Multiply_only_value_object_does_not_emit_dividedBy_method()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value Line {\n" +
            "    base: Money\n" +
            "    scaled: Money = base * 2\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var moneyPhp = result.Files.Single(f => f.RelativePath.EndsWith("Money.php", StringComparison.Ordinal)).Contents;
        moneyPhp.ShouldContain("public function multipliedBy(\\Koine\\Runtime\\Decimal $factor): self");
        moneyPhp.ShouldNotContain("dividedBy");
    }

    /// <summary>
    /// Issue #1301 real-toolchain regression: the issue's own minimal repro — a divide-only <c>Money</c>
    /// (<c>perUnit: Money = base / 4</c>, no <c>*</c> anywhere in the model) — must type-check under
    /// <c>phpstan analyse --level max</c>, not just pass the always-on static guard above. Before the
    /// fix, <c>phpstan</c> reported <c>Call to an undefined method …Money::dividedBy()</c> because the
    /// gate never fired at all for a divide-only value object. Skipped (not failed) only when no
    /// <c>phpstan</c> is present locally; CI installs the toolchain and runs it for real.
    /// </summary>
    [Fact]
    public void Divide_only_value_object_typechecks_at_phpstan_level_max()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value Line {\n" +
            "    base: Money\n" +
            "    perUnit: Money = base / 4\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (runs without a phpstan toolchain): dividedBy must be declared on Money.
        var moneyPhp = result.Files.Single(f => f.RelativePath.EndsWith("Money.php", StringComparison.Ordinal)).Contents;
        moneyPhp.ShouldContain("public function dividedBy(\\Koine\\Runtime\\Decimal $factor): self");

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

    /// <summary>
    /// Issue #1587 (PHP twin of #1558's TypeScript fix): bare <c>Int / Int</c> division in an ordinary
    /// derived member — no value object scalar method involved, just a plain binary expression — must
    /// truncate toward zero, matching the value-object scalar-divide rule #938 already established. Before
    /// the fix, <c>TryWriteValueBinary</c> declines (neither operand is Decimal or a Koine value object)
    /// and the plain-numeric fallback renders a bare PHP <c>/</c>; because PHP's <c>/</c> promotes to
    /// <c>float</c> on any inexact division and the emitted method is declared to return <c>int</c> under
    /// <c>declare(strict_types=1)</c>, this is a hard runtime <c>TypeError</c> — worse than TypeScript's
    /// silent fraction. A phpstan-only check cannot see this (the static return type is nominally
    /// <c>int</c>); only executing the emitted PHP proves it. Skipped (not failed) when no <c>php</c>
    /// interpreter is present locally; CI runs it for real.
    /// </summary>
    [Fact]
    public void Int_field_derived_division_truncates_toward_zero_at_runtime()
    {
        const string src =
            """
            context Shop {
              value Order {
                qty:  Int
                half: Int = qty / 2
              }
            }
            """;
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            <?php
            declare(strict_types=1);
            require __DIR__ . '/src/Shop/ValueObjects/Order.php';

            $positive = new Koine\Shop\ValueObjects\Order(7);
            if ($positive->half() !== 3) {
                fwrite(STDERR, "positive half expected 3, got " . var_export($positive->half(), true) . "\n");
                exit(1);
            }

            $negative = new Koine\Shop\ValueObjects\Order(-7);
            if ($negative->half() !== -3) {
                fwrite(STDERR, "negative half expected -3, got " . var_export($negative->half(), true) . "\n");
                exit(1);
            }
            """;

        TestSupport.PhpCheck run = TestSupport.RunPhp(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);

        run.Ok.ShouldBeTrue(
            "Int/Int derived-member division should truncate toward zero (7/2==3, -7/2==-3), not throw:\n"
            + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// Issue #1598: the optional twin of #1587. A <b>guard-narrowed</b> <c>Int?</c> division — <c>qty / 2
    /// when qty.isPresent</c> — still infers as optional <c>Int?</c> at the binary-expression call site
    /// (guard narrowing is validator-only and never reaches <see cref="TypeResolver"/>), so before the fix
    /// <c>IsIntDivision</c>'s <c>IsOptional: false</c> gate excluded it and the plain-numeric fallback
    /// rendered a bare PHP <c>/</c> — the exact runtime <c>TypeError</c> #1587 fixed for the non-optional
    /// case, reachable again through the guarded path because the emitted member is still declared to
    /// return <c>?int</c> under <c>declare(strict_types=1)</c>. Skipped (not failed) when no <c>php</c>
    /// interpreter is present locally; CI runs it for real.
    /// </summary>
    [Fact]
    public void Guarded_optional_int_division_truncates_toward_zero_at_runtime()
    {
        const string src =
            """
            context Shop {
              value Order {
                qty:  Int?
                half: Int? = qty / 2 when qty.isPresent
              }
            }
            """;
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            <?php
            declare(strict_types=1);
            require __DIR__ . '/src/Shop/ValueObjects/Order.php';

            $positive = new Koine\Shop\ValueObjects\Order(7);
            if ($positive->half() !== 3) {
                fwrite(STDERR, "positive half expected 3, got " . var_export($positive->half(), true) . "\n");
                exit(1);
            }

            $negative = new Koine\Shop\ValueObjects\Order(-7);
            if ($negative->half() !== -3) {
                fwrite(STDERR, "negative half expected -3, got " . var_export($negative->half(), true) . "\n");
                exit(1);
            }
            """;

        TestSupport.PhpCheck run = TestSupport.RunPhp(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);

        run.Ok.ShouldBeTrue(
            "Guard-narrowed Int?/Int division should truncate toward zero (7/2==3, -7/2==-3), not throw:\n"
            + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// Issue #1620: <c>ModelIndex.Classify</c> is context-blind — its flat, last-write-wins
    /// <c>_byName</c> index can answer for the WRONG context's same-named declaration (R13.2 legally
    /// lets two contexts each declare their own <c>Status</c>). Here <c>Shipping</c>'s <c>value Status</c>
    /// is registered after <c>Billing</c>'s <c>enum Status</c>, so a context-blind
    /// <c>Classify("Status")</c> answers <c>Value</c> for <c>Billing.Invoice</c>'s own <c>status</c>/
    /// <c>archivedStatus</c> members, and <see cref="PhpExpressionTranslator"/>'s
    /// <c>IsArithmeticValueObject</c>/<c>IsArithmeticValueObjectOperand</c> checks (which decide whether
    /// <c>==</c> between two Status-typed members routes to a value object's structural
    /// <c>-&gt;equals()</c> or PHP's <c>===</c>) wrongly pick the value-object path for an enum. Before
    /// the fix this emits <c>$this-&gt;status-&gt;equals($this-&gt;archivedStatus)</c> — a call to
    /// <c>equals()</c>, a method a PHP backed enum does not have — a runtime fatal <c>phpstan</c>/
    /// <c>php -l</c> alone cannot see (the emitted code is syntactically valid PHP); only executing it
    /// proves the bug.
    /// <para>
    /// Deliberately compares two MEMBERS (not a bare enum literal like <c>status == Open</c>): a bare
    /// enum-member reference resolves via <see cref="Koine.Compiler.Ast.ModelIndex.EnumsDeclaring"/>,
    /// which itself walks <see cref="Koine.Compiler.Ast.ModelIndex.AllTypes"/> — the SAME flat,
    /// last-write-wins <c>_byName</c> map, so a same-named-type collision silently drops the
    /// LOSING context's enum from that index entirely. That gap (and the sibling one in
    /// <see cref="Koine.Compiler.Ast.TypeResolver.IsValueLike"/>/<c>IsUserType</c>, used by this same
    /// value object's <c>equals()</c> method) is a separate, deeper context-blindness in the shared
    /// <c>Ast/</c> layer — out of scope for this issue's PHP-emitter-only call-site migration — so this
    /// fixture avoids it to isolate exactly the 13 call sites this issue migrates.
    /// </para>
    /// </summary>
    [Fact]
    public void Same_named_type_across_two_contexts_resolves_the_correct_context_for_an_equality_comparison()
    {
        const string src =
            """
            context Billing {
              enum Status { Open Closed }
              value Invoice {
                status: Status
                archivedStatus: Status
                sameStatus: Bool = status == archivedStatus
              }
            }
            context Shipping {
              value Status { code: Int }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            <?php
            declare(strict_types=1);
            require __DIR__ . '/src/Billing/Enums/Status.php';
            require __DIR__ . '/src/Billing/ValueObjects/Invoice.php';

            $same = new Koine\Billing\ValueObjects\Invoice(Koine\Billing\Enums\Status::OPEN, Koine\Billing\Enums\Status::OPEN);
            if ($same->sameStatus() !== true) {
                fwrite(STDERR, "expected sameStatus() true for two Status::OPEN, got " . var_export($same->sameStatus(), true) . "\n");
                exit(1);
            }

            $different = new Koine\Billing\ValueObjects\Invoice(Koine\Billing\Enums\Status::OPEN, Koine\Billing\Enums\Status::CLOSED);
            if ($different->sameStatus() !== false) {
                fwrite(STDERR, "expected sameStatus() false for Status::OPEN vs Status::CLOSED, got " . var_export($different->sameStatus(), true) . "\n");
                exit(1);
            }
            """;

        TestSupport.PhpCheck run = TestSupport.RunPhp(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);

        run.Ok.ShouldBeTrue(
            "A same-named Status in another context must not make Billing.Invoice's own Status "
            + "misclassify as a value object (a fatal call to the undefined Status::equals()):\n"
            + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// Issue #1633: the sibling gap the previous test's doc comment flags as out of scope for #1620 —
    /// <see cref="Koine.Compiler.Ast.TypeResolver.IsValueLike"/>/<c>IsUserType</c>, used by
    /// <c>PhpEmitter.ValueObjects.cs</c>'s <c>WriteEquals</c> to decide whether a field compares via
    /// PHP <c>===</c> or a structural <c>-&gt;equals()</c> call. #1641 made <c>IsValueLike</c>/
    /// <c>IsUserType</c> themselves context-aware (routing through the resolver's own <c>Context</c>),
    /// but <c>WriteEquals</c>'s supporting <c>resolver</c> was constructed with no context at all
    /// (<c>new TypeResolver(emit.Index)</c>), so #1641 alone was a no-op for this call site:
    /// <c>ModelIndex.Classify(null, "Status")</c> still falls through to the context-blind global
    /// answer, and <c>Shipping</c>'s unrelated <c>value Status</c> (registered after <c>Billing</c>'s
    /// own <c>enum Status</c>) still wins. Before the fix, calling the generated
    /// <c>Invoice::equals()</c> itself (not just a derived member built from <c>==</c>, which
    /// <see cref="PhpExpressionTranslator"/> already resolves correctly since #1620) fatals on a call
    /// to the undefined <c>Status::equals()</c> — a PHP backed enum has no such method. Only executing
    /// the emitted PHP proves this; skipped (not failed) when no <c>php</c> interpreter is present
    /// locally, CI runs it for real.
    /// </summary>
    [Fact]
    public void Same_named_type_across_two_contexts_resolves_the_correct_context_for_structural_equals()
    {
        const string src =
            """
            context Billing {
              enum Status { Open Closed }
              value Invoice {
                status: Status
                archivedStatus: Status
              }
            }
            context Shipping {
              value Status { code: Int }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            <?php
            declare(strict_types=1);
            require __DIR__ . '/src/Billing/Enums/Status.php';
            require __DIR__ . '/src/Billing/ValueObjects/Invoice.php';

            $a = new Koine\Billing\ValueObjects\Invoice(Koine\Billing\Enums\Status::OPEN, Koine\Billing\Enums\Status::OPEN);
            $b = new Koine\Billing\ValueObjects\Invoice(Koine\Billing\Enums\Status::OPEN, Koine\Billing\Enums\Status::OPEN);
            if ($a->equals($b) !== true) {
                fwrite(STDERR, "expected equals() true for two identical Invoices, got " . var_export($a->equals($b), true) . "\n");
                exit(1);
            }

            $c = new Koine\Billing\ValueObjects\Invoice(Koine\Billing\Enums\Status::OPEN, Koine\Billing\Enums\Status::CLOSED);
            if ($a->equals($c) !== false) {
                fwrite(STDERR, "expected equals() false when archivedStatus differs, got " . var_export($a->equals($c), true) . "\n");
                exit(1);
            }
            """;

        TestSupport.PhpCheck run = TestSupport.RunPhp(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);

        run.Ok.ShouldBeTrue(
            "A same-named Status in another context must not make Billing.Invoice's generated equals() "
            + "misclassify its own enum-typed members as value-like (a fatal call to the undefined "
            + "Status::equals()):\n"
            + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// Issue #1638: <c>PhpTypeMapper</c> is constructed ONCE per compile and reused across every
    /// context, so it carries no ambient context of its own — only the <c>TypeRef.Qualifier</c>,
    /// which the parser leaves <c>null</c> for the common, BARE (unqualified) same-context
    /// reference. Here <c>Billing</c> (declared FIRST) owns an ENUM named <c>Status</c>; a
    /// differently-KINDED sibling <c>Status</c> (a VALUE OBJECT) is declared in <c>Shipping</c>
    /// AFTER it, so the flat index's last-write-wins registration resolves a context-blind
    /// <c>Classify("Status")</c> to Shipping's value object, not Billing's own enum — exactly the
    /// TypeScript regression pinned by
    /// <c>TypeScriptConformanceTests.Bare_unqualified_member_field_resolves_the_correct_context_for_a_same_named_sibling_type</c>.
    /// <para>
    /// Unlike TypeScript — whose enum/non-enum branches emit visibly different strings (a bare
    /// <c>Status</c> value vs. a <c>StatusMember</c> type), so the misclassification breaks
    /// <c>tsc --strict</c> — PHP's <c>PhpTypeMapper.MapBase</c> enum/non-enum branches both return
    /// the identical <c>PhpNaming.ClassName(type.Name)</c> string (a PHP backed enum's own class name
    /// IS the type-hint, exactly like a value object's), and <c>IsEnum</c> itself has no emitter
    /// caller today. So this full-pipeline construct does NOT actually regress before the fix —
    /// phpstan already accepts the field as-is either way, and the type-catalog import resolver (a
    /// separate mechanism from <c>PhpTypeMapper.Classify</c> — see <c>PhpEmitter.Support.cs</c>'s
    /// <c>CollectUses</c>/<c>BuildTypeCatalog</c>) already resolves <c>Invoice.status</c>'s
    /// <c>use Koine\Billing\Enums\Status;</c> import correctly regardless. This test therefore pins
    /// the CORRECT, already-passing behavior (not a fail-before/pass-after reproduction); the actual
    /// observable gap this task closes lives one layer down, in
    /// <c>PhpTypeMapperTests.IsEnum_resolves_bare_reference_against_declaring_context_not_flat_last_writer</c>,
    /// which fails before the fix and passes after (verified directly against
    /// <see cref="PhpTypeMapper.IsEnum"/>). Threading <c>context</c> through
    /// <c>Map</c>/<c>MapBase</c>/<c>DocType</c>/<c>IsEnum</c> here is still the right fix: it keeps
    /// PHP's API consistent with the TS/Rust/Python mappers and protects <c>IsEnum</c> for any
    /// future caller.
    /// </para>
    /// </summary>
    [Fact]
    public void Bare_unqualified_member_field_resolves_the_correct_context_for_a_same_named_sibling_type()
    {
        const string src =
            """
            context Billing {
              enum Status {
                Open
                Closed
              }
              value Invoice {
                status: Status
              }
            }

            context Shipping {
              value Status {
                code: Int
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath == "src/Billing/ValueObjects/Invoice.php").Contents;
        invoice.ShouldContain("use Koine\\Billing\\Enums\\Status;");
        invoice.ShouldContain("public readonly Status $status");

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(
            "a bare, unqualified reference to Billing's OWN enum Status must not misclassify against "
            + "Shipping's differently-kinded, same-named sibling Status:\n" + string.Join("\n", r.Errors));
    }

    /// <summary>
    /// The <c>readmodel</c> fixture shared by
    /// <see cref="Read_model_direct_field_import_resolves_against_the_source_s_own_context"/> and
    /// <see cref="Read_model_direct_field_binds_the_source_s_own_type_at_runtime"/> (issue #1701):
    /// <c>Billing</c>'s <c>ItemSummary</c> projects <c>Ordering.Item</c>'s <c>status</c> (an
    /// <c>Ordering</c>-owned enum) while <c>Billing</c> separately declares its own, differently-kinded,
    /// same-named <c>Status</c> value object.
    /// </summary>
    private const string ReadModelCrossContextImportFixture = """
        context Billing {
          value Status {
            code: String
          }

          import Ordering.{ Item }

          readmodel ItemSummary from Item {
            status
          }
        }

        context Ordering {
          enum Status {
            Pending
            Shipped
            Delivered
          }

          value Item {
            status: Status = Pending
          }
        }
        """;

    /// <summary>
    /// Issue #1701 — a read model's DIRECT-field <c>use</c> import is a SEPARATE code path
    /// (<c>PhpEmitter.Support.cs</c>'s <c>CollectUses</c>/<c>Assemble</c>) from the
    /// <c>PhpTypeMapper.Map</c>/<c>Classify</c> calls #1638 already made context-aware. Before this
    /// fix, <c>EmitReadModel</c> called <c>Assemble</c> with no per-symbol hint, so a direct field's
    /// type always resolved its import against the read model's OWN declaring context, not the
    /// source member's, silently binding the unrelated local class. Skipped (not failed) when no
    /// <c>phpstan</c> toolchain is present locally; CI runs it for real.
    /// </summary>
    [Fact]
    public void Read_model_direct_field_import_resolves_against_the_source_s_own_context()
    {
        var result = new KoineCompiler().Compile(ReadModelCrossContextImportFixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var summary = result.Files.Single(f => f.RelativePath == "src/Billing/ReadModels/ItemSummary.php").Contents;
        summary.ShouldContain("use Koine\\Ordering\\Enums\\Status;");
        summary.ShouldNotContain("use Koine\\Billing\\ValueObjects\\Status;");

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(
            "ItemSummary's direct 'status' field must import Ordering's own Status enum, not Billing's "
            + "differently-kinded, same-named sibling value object:\n" + string.Join("\n", r.Errors));
    }

    /// <summary>
    /// The runtime twin of <see cref="Read_model_direct_field_import_resolves_against_the_source_s_own_context"/>
    /// (issue #1701): non-observable via <c>phpstan</c>/<c>php -l</c> alone today (PHP's enum/non-enum
    /// <c>Map</c> branches render the identical class-name string, per the earlier same-named-sibling
    /// test's comment), but a REAL bug — the wrong import means the promoted constructor parameter ends
    /// up type-hinted against Billing's own <c>Status</c> while the value actually passed is an
    /// <c>Ordering\Enums\Status</c> case, a hard runtime <c>TypeError</c> under
    /// <c>declare(strict_types=1)</c>. Only executing the emitted PHP proves it; skipped (not failed)
    /// when no <c>php</c> interpreter is present locally, CI runs it for real.
    /// </summary>
    [Fact]
    public void Read_model_direct_field_binds_the_source_s_own_type_at_runtime()
    {
        var result = new KoineCompiler().Compile(ReadModelCrossContextImportFixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            <?php
            declare(strict_types=1);
            require __DIR__ . '/src/Ordering/Enums/Status.php';
            require __DIR__ . '/src/Ordering/ValueObjects/Item.php';
            require __DIR__ . '/src/Billing/ValueObjects/Status.php';
            require __DIR__ . '/src/Billing/ReadModels/ItemSummary.php';

            $item = new Koine\Ordering\ValueObjects\Item(Koine\Ordering\Enums\Status::SHIPPED);
            $summary = Koine\Billing\ReadModels\toItemSummary($item);
            if ($summary->status !== Koine\Ordering\Enums\Status::SHIPPED) {
                fwrite(STDERR, "expected Ordering's own Status::SHIPPED, got " . var_export($summary->status, true) . "\n");
                exit(1);
            }
            """;

        TestSupport.PhpCheck run = TestSupport.RunPhp(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);
        run.Ok.ShouldBeTrue(
            "Projecting Item to ItemSummary must bind Ordering's own Status enum (not Billing's wrongly "
            + "imported same-named sibling value object) at runtime:\n" + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// Issue #1701 Task 3 — a narrower sibling gap in the same area as the two tests above:
    /// <c>WriteMethodDoc</c>/<c>docParams</c> (the phpstan <c>@param</c>/<c>@return</c> PHPDoc
    /// refiner) passed the read model's own context UNIFORMLY to <c>DocType</c> for every field,
    /// including a direct one whose source lives in a foreign context. Here <c>Billing</c>'s
    /// <c>ItemSummary</c> directly projects <c>Ordering.Item</c>'s <c>statuses: List&lt;Status&gt;</c>
    /// (an <c>Ordering</c>-owned enum), while <c>Billing</c> separately declares its own,
    /// differently-kinded, same-named <c>Status</c> value object — exactly the collection-nested case
    /// <c>DocType</c> recurses into (a non-collection field's <c>DocType</c> call is null and skipped,
    /// per <see cref="PhpTypeMapper.DocType"/>'s doc comment).
    /// <para>
    /// Like the sibling same-named-sibling test above, this does NOT actually regress before the fix:
    /// <c>PhpTypeMapper.MapBase</c>'s enum/non-enum branches render the identical
    /// <c>PhpNaming.ClassName</c> string regardless of which context <c>Classify</c> resolves against,
    /// so <c>list&lt;Status&gt;</c> renders correctly either way today. This test pins that CORRECT
    /// behavior and guards it: threading the field's own resolved context through
    /// <c>WriteMethodDoc</c>'s per-parameter overload keeps this call site consistent with every other
    /// context-aware call site in the file (#1638) and protects it the moment <c>Map</c>/<c>DocType</c>
    /// ever gains a visible enum/non-enum divergence (the <c>IsEnum</c> gap the sibling test's own
    /// comment flags as the actually-observable layer, one level down in
    /// <c>PhpTypeMapperTests.IsEnum_resolves_bare_reference_against_declaring_context_not_flat_last_writer</c>).
    /// </para>
    /// </summary>
    [Fact]
    public void Read_model_direct_collection_field_doc_type_resolves_against_the_source_s_own_context()
    {
        const string src =
            """
            context Billing {
              value Status {
                code: String
              }

              import Ordering.{ Item }

              readmodel ItemSummary from Item {
                statuses
              }
            }

            context Ordering {
              enum Status {
                Pending
                Shipped
                Delivered
              }

              value Item {
                statuses: List<Status>
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var summary = result.Files.Single(f => f.RelativePath == "src/Billing/ReadModels/ItemSummary.php").Contents;
        summary.ShouldContain("@param list<Status> $statuses");

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(
            "ItemSummary's direct 'statuses' collection field must refine its phpstan doc tag against "
            + "Ordering's own Status enum, not Billing's differently-kinded, same-named sibling value "
            + "object:\n" + string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Code-review finding on issue #1701's own PR: <c>CollectImportHints</c>'s <c>default</c> case
    /// recorded <c>symbolContext[name] = context</c> (the SOURCE type's resolved OWNER context)
    /// unconditionally — every other resolution call site in this emitter uses the
    /// <c>type.Qualifier ?? context</c> idiom instead, since a field's own declared type can carry an
    /// EXPLICIT <c>Context.Type</c> qualifier (R13.2) that wins over the ambient/owner context. Here
    /// <c>Ordering.Item</c>'s <c>status</c> field is declared <c>Shipping.Status</c> — an EXPLICIT
    /// qualifier to a THIRD context — while <c>Ordering</c> separately declares its own, unrelated
    /// <c>Status</c> enum (the type <c>ResolveOwner(rm.SourceType, ...)</c> would resolve to as
    /// <c>Item</c>'s owning context). Before the fix, the import hint ignored the qualifier and bound
    /// <c>Ordering</c>'s own <c>Status</c> instead of the field's actually-declared <c>Shipping.Status</c>.
    /// <para>
    /// Deliberately asserts only the emitted <c>use</c> line, not a full <c>phpstan</c> pass: this
    /// fixture's SOURCE field (<c>Item.status: Shipping.Status</c>) trips a separate, pre-existing,
    /// out-of-scope gap in <c>Item.php</c>'s OWN field emission (tracked as #1712) — a value
    /// object's own qualified-field import ignores its qualifier the same way this call site used to,
    /// but that call site is untouched by this PR. Gating on full <c>phpstan</c> here would make this
    /// test red for a DIFFERENT bug than the one it verifies.
    /// </para>
    /// </summary>
    [Fact]
    public void Read_model_direct_field_import_honors_an_explicit_qualifier_over_the_source_s_owning_context()
    {
        const string src =
            """
            context Billing {
              value Status {
                code: String
              }

              import Ordering.{ Item }

              readmodel ItemSummary from Item {
                status
              }
            }

            context Ordering {
              enum Status {
                Alpha
                Beta
                Gamma
              }

              value Item {
                status: Shipping.Status
              }
            }

            context Shipping {
              enum Status {
                Active
                Inactive
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var summary = result.Files.Single(f => f.RelativePath == "src/Billing/ReadModels/ItemSummary.php").Contents;
        summary.ShouldContain("use Koine\\Shipping\\Enums\\Status;");
        summary.ShouldNotContain("use Koine\\Ordering\\Enums\\Status;");
        summary.ShouldNotContain("use Koine\\Billing\\ValueObjects\\Status;");
    }

    /// <summary>
    /// Issue #1712 — the sibling gap the previous test's own comment flags as out-of-scope there: a
    /// value object's/entity's OWN field import ignores an EXPLICIT cross-context qualifier
    /// (R13.2's <c>Context.Type</c> syntax). <c>EmitValueObject</c>/<c>WriteConstructor</c> never
    /// built a <c>symbolContext</c> hint at all (unlike #1701's now-fixed read-model path), so
    /// <c>Assemble</c>/<c>CollectUses</c> always fell back to the declaring VO's own context. Here
    /// <c>Ordering.Item</c>'s <c>status</c> field is declared <c>Shipping.Status</c> — an EXPLICIT
    /// qualifier to a THIRD context — while <c>Ordering</c> separately declares its own, unrelated
    /// <c>Status</c> enum (the type <c>Item</c>'s own context would resolve to without a hint).
    /// Before the fix, <c>Item.php</c> imported <c>Ordering</c>'s own <c>Status</c> instead of the
    /// field's actually-declared <c>Shipping.Status</c>.
    /// </summary>
    [Fact]
    public void Value_object_own_field_import_honors_an_explicit_qualifier_over_the_owning_context()
    {
        const string src =
            """
            context Ordering {
              enum Status {
                Alpha
                Beta
                Gamma
              }

              value Item {
                status: Shipping.Status
              }
            }

            context Shipping {
              enum Status {
                Active
                Inactive
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath == "src/Ordering/ValueObjects/Item.php").Contents;
        item.ShouldContain("use Koine\\Shipping\\Enums\\Status;");
        item.ShouldNotContain("use Koine\\Ordering\\Enums\\Status;");
    }

    /// <summary>
    /// The runtime twin of <see cref="Value_object_own_field_import_honors_an_explicit_qualifier_over_the_owning_context"/>:
    /// non-observable via <c>phpstan</c>/<c>php -l</c> alone (PHP's enum/non-enum <c>Map</c> branches
    /// render the identical class-name string regardless of which context resolves), but a REAL bug —
    /// the wrong import means the promoted constructor parameter ends up type-hinted against
    /// <c>Ordering</c>'s own <c>Status</c> while the value actually passed is a
    /// <c>Shipping\Enums\Status</c> case, a hard runtime <c>TypeError</c> under
    /// <c>declare(strict_types=1)</c>. Only executing the emitted PHP proves it; skipped (not failed)
    /// when no <c>php</c> interpreter is present locally, CI runs it for real.
    /// </summary>
    [Fact]
    public void Value_object_own_field_binds_the_qualified_type_at_runtime()
    {
        const string src =
            """
            context Ordering {
              enum Status {
                Alpha
                Beta
                Gamma
              }

              value Item {
                status: Shipping.Status
              }
            }

            context Shipping {
              enum Status {
                Active
                Inactive
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            <?php
            declare(strict_types=1);
            require __DIR__ . '/src/Shipping/Enums/Status.php';
            require __DIR__ . '/src/Ordering/Enums/Status.php';
            require __DIR__ . '/src/Ordering/ValueObjects/Item.php';

            $item = new Koine\Ordering\ValueObjects\Item(Koine\Shipping\Enums\Status::ACTIVE);
            if ($item->status !== Koine\Shipping\Enums\Status::ACTIVE) {
                fwrite(STDERR, "expected Shipping's own Status::ACTIVE, got " . var_export($item->status, true) . "\n");
                exit(1);
            }
            """;

        TestSupport.PhpCheck run = TestSupport.RunPhp(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);
        run.Ok.ShouldBeTrue(
            "Item's own 'status' field must bind Shipping's own Status enum (not Ordering's wrongly "
            + "imported, differently-cased same-named sibling enum) at runtime:\n" + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// The entity-emission counterpart of
    /// <see cref="Value_object_own_field_import_honors_an_explicit_qualifier_over_the_owning_context"/>
    /// (issue #1712): <c>EmitEntityClass</c> shares the exact same qualifier-blind
    /// <c>Assemble</c>/<c>CollectUses</c> gap as <c>EmitValueObject</c> did.
    /// </summary>
    [Fact]
    public void Entity_own_field_import_honors_an_explicit_qualifier_over_the_owning_context()
    {
        const string src =
            """
            context Ordering {
              enum Status {
                Alpha
                Beta
                Gamma
              }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: Shipping.Status
                }
              }
            }

            context Shipping {
              enum Status {
                Active
                Inactive
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.php", StringComparison.Ordinal)).Contents;
        order.ShouldContain("use Koine\\Shipping\\Enums\\Status;");
        order.ShouldNotContain("use Koine\\Ordering\\Enums\\Status;");
    }

    /// <summary>
    /// Issue #1716 — the THIRD call site of the #1701/#1712 qualifier-blind import gap: a command's
    /// own PARAMETER ignores an EXPLICIT cross-context qualifier (R13.2's <c>Context.Type</c> syntax).
    /// <c>WriteCommand</c> runs inside <c>EmitEntityClass</c>, but before this fix nothing fed
    /// command-parameter types into the <c>symbolContext</c> hint dictionary #1712 introduced for the
    /// entity's own fields — so <c>Assemble</c>/<c>CollectUses</c> fell back to the entity's own
    /// context for a parameter too. Here <c>setShippingStatus</c>'s <c>newStatus</c> parameter is
    /// declared <c>Shipping.Status</c> — an EXPLICIT qualifier — while <c>Ordering</c> separately
    /// declares its own, unrelated <c>Status</c> enum (what the entity's own context would resolve to
    /// without a hint). Before the fix, <c>Order.php</c> imported <c>Ordering</c>'s own <c>Status</c>
    /// instead of the parameter's actually-declared <c>Shipping.Status</c> (verified live: reverting
    /// this fix reproduces exactly that wrong import).
    /// </summary>
    [Fact]
    public void Command_parameter_import_honors_an_explicit_qualifier_over_the_owning_context()
    {
        const string src =
            """
            context Ordering {
              enum Status {
                Alpha
                Beta
                Gamma
              }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  quantity: Int

                  command setShippingStatus(newStatus: Shipping.Status): Shipping.Status {
                    result newStatus
                  }
                }
              }
            }

            context Shipping {
              enum Status {
                Active
                Inactive
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.php", StringComparison.Ordinal)).Contents;
        order.ShouldContain("use Koine\\Shipping\\Enums\\Status;");
        order.ShouldNotContain("use Koine\\Ordering\\Enums\\Status;");
        order.ShouldContain("function setShippingStatus(Status $newStatus): Status");
    }

    /// <summary>
    /// The runtime twin of <see cref="Command_parameter_import_honors_an_explicit_qualifier_over_the_owning_context"/>:
    /// with the wrong import, <c>setShippingStatus</c>'s parameter is type-hinted against
    /// <c>Ordering</c>'s own <c>Status</c>, so calling it with <c>Shipping</c>'s own
    /// <c>Status::ACTIVE</c> is a hard runtime <c>TypeError</c> under <c>declare(strict_types=1)</c>
    /// — not observable via <c>phpstan</c>/<c>php -l</c> alone, since both branches render the
    /// identical short class name in source. Skipped (not failed) when no <c>php</c> interpreter is
    /// present locally; CI runs it for real.
    /// </summary>
    [Fact]
    public void Command_parameter_binds_the_qualified_type_at_runtime()
    {
        const string src =
            """
            context Ordering {
              enum Status {
                Alpha
                Beta
                Gamma
              }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  quantity: Int

                  command setShippingStatus(newStatus: Shipping.Status): Shipping.Status {
                    result newStatus
                  }
                }
              }
            }

            context Shipping {
              enum Status {
                Active
                Inactive
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            <?php
            declare(strict_types=1);
            require __DIR__ . '/src/Shipping/Enums/Status.php';
            require __DIR__ . '/src/Ordering/Enums/Status.php';
            require __DIR__ . '/src/Ordering/ValueObjects/OrderId.php';
            require __DIR__ . '/src/Ordering/Entities/Order.php';

            $order = new Koine\Ordering\Entities\Order(Koine\Ordering\ValueObjects\OrderId::generate(), 1);
            $result = $order->setShippingStatus(Koine\Shipping\Enums\Status::ACTIVE);
            if ($result !== Koine\Shipping\Enums\Status::ACTIVE) {
                fwrite(STDERR, "expected Shipping's own Status::ACTIVE, got " . var_export($result, true) . "\n");
                exit(1);
            }
            """;

        TestSupport.PhpCheck run = TestSupport.RunPhp(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoInterpreterNotice);
        run.Ok.ShouldBeTrue(
            "setShippingStatus's 'newStatus' parameter must bind Shipping's own Status enum (not "
            + "Ordering's wrongly imported, differently-cased same-named sibling enum) at runtime:\n"
            + string.Join("\n", run.Errors));
    }

    /// <summary>
    /// The factory-emission counterpart of
    /// <see cref="Command_parameter_import_honors_an_explicit_qualifier_over_the_owning_context"/>
    /// (issue #1716): <c>WriteFactory</c> shares the exact same qualifier-blind parameter-hint gap as
    /// <c>WriteCommand</c> did — a <c>create</c> factory's own parameter, not just a command's.
    /// </summary>
    [Fact]
    public void Factory_parameter_import_honors_an_explicit_qualifier_over_the_owning_context()
    {
        const string src =
            """
            context Ordering {
              enum Status {
                Alpha
                Beta
                Gamma
              }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  quantity: Int

                  create place(quantity: Int, newStatus: Shipping.Status) {
                    emit OrderPlaced(order: id)
                  }
                }
              }

              event OrderPlaced {
                order: OrderId
              }
            }

            context Shipping {
              enum Status {
                Active
                Inactive
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files.Single(f => f.RelativePath.EndsWith("Order.php", StringComparison.Ordinal)).Contents;
        order.ShouldContain("use Koine\\Shipping\\Enums\\Status;");
        order.ShouldNotContain("use Koine\\Ordering\\Enums\\Status;");
        order.ShouldContain("public static function place(int $quantity, Status $newStatus): self");
    }

    /// <summary>
    /// Issue #1531 (audit, Task 4) — the Rust (#1467/PR #1476) and Java (#1480/PR #1521) emitters both
    /// shipped the identical bug in their factory constructor-argument loop's auto-bound branch: a
    /// <c>required</c>-bucket member declared optional but carrying no member-level default
    /// (<c>total: Decimal?</c>), auto-bound to a NON-optional same-named factory parameter
    /// (<c>create make(total: Decimal)</c>), had its bare value passed straight into a constructor slot
    /// typed <c>Option&lt;T&gt;</c>/<c>Optional&lt;T&gt;</c> — a real <c>rustc</c> E0308 / <c>javac</c>
    /// "incompatible types" error, fixed by wrapping in <c>Some(…)</c>/<c>Optional.of(…)</c>.
    /// <para>
    /// PHP's <c>WriteFactory</c> likewise passes the bare value — but it maps <c>T?</c> to the NULLABLE
    /// type <c>?T</c> (<c>PhpTypeMapper</c>), not to a wrapper value, and a non-null <c>T</c> is
    /// directly assignable to a <c>?T</c> parameter. There is no wrap construct to apply and none is
    /// needed. This test records that negative audit result and locks it in: it asserts the
    /// nullable-typed constructor slot AND the bare, unwrapped argument, then proves with a real
    /// <c>phpstan analyse --level max</c> run (plus the always-on <c>php -l</c> gate) that the pair
    /// type-checks.
    /// </para>
    /// </summary>
    [Fact]
    public void Factory_autobound_parameter_binding_to_an_optional_declared_required_member_needs_no_wrap()
    {
        const string src =
            """
            context Shop {
              entity Product identified by ProductId {
                total: Decimal?

                create make(total: Decimal) {
                }
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no phpstan required): the optional-declared member's constructor slot is a
        // NULLABLE `?T`, so the auto-bound non-optional parameter is passed through bare.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.php", StringComparison.Ordinal)).Contents;
        product.ShouldContain("?\\Koine\\Runtime\\Decimal $total = null");
        product.ShouldContain("$instance = new self($id, $total);");

        TestSupport.PhpCheck syntax = TestSupport.SyntaxCheckPhp(result.Files);
        TestSupport.RequireOrSkip(syntax.ToolchainAvailable, NoInterpreterNotice);
        syntax.Ok.ShouldBeTrue("emitted PHP should parse (php -l):\n" + string.Join("\n", syntax.Errors));

        TestSupport.PhpCheck types = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(types.ToolchainAvailable, NoToolchainNotice);
        types.Ok.ShouldBeTrue(
            "an auto-bound non-optional parameter must be assignable straight into an optional-declared "
            + "member's `?T` constructor slot:\n" + string.Join("\n", types.Errors));
    }

    /// <summary>
    /// The explicit-init half of the same #1531 audit — the branch Rust #1452/PR #1464 and Java
    /// #1479/PR #1518 fixed. A <c>total -&gt; 5.0</c> initialization of an optional-declared,
    /// default-less <c>required</c> member yields a non-optional value; Rust/Java must wrap it, PHP must
    /// not, for the same nullable-vs-wrapper reason. Since nothing is ever wrapped, the double-wrap
    /// hazard the Rust/Java fixes had to guard against cannot arise here at all.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_declared_required_member_needs_no_wrap()
    {
        const string src =
            """
            context Shop {
              entity Product identified by ProductId {
                total: Decimal?

                create make() {
                  total -> 5.0
                }
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.php", StringComparison.Ordinal)).Contents;
        product.ShouldContain("?\\Koine\\Runtime\\Decimal $total = null");
        product.ShouldContain("$instance = new self($id, new \\Koine\\Runtime\\Decimal('5.0'));");

        TestSupport.PhpCheck syntax = TestSupport.SyntaxCheckPhp(result.Files);
        TestSupport.RequireOrSkip(syntax.ToolchainAvailable, NoInterpreterNotice);
        syntax.Ok.ShouldBeTrue("emitted PHP should parse (php -l):\n" + string.Join("\n", syntax.Errors));

        TestSupport.PhpCheck types = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(types.ToolchainAvailable, NoToolchainNotice);
        types.Ok.ShouldBeTrue(
            "an explicitly initialized non-optional value must be assignable straight into an "
            + "optional-declared member's `?T` constructor slot:\n" + string.Join("\n", types.Errors));
    }
}
