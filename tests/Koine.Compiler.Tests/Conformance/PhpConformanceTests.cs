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
