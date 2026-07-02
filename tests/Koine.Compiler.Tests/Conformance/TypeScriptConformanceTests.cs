using Koine.Compiler.Emit;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// R16.4 conformance harness for the TypeScript backend. This exercises the
/// <see cref="TestSupport.TypeCheckTypeScript"/> plumbing (write emitted <c>.ts</c> → run
/// <c>tsc --noEmit --strict</c>) so it is ready to validate the TypeScript emitter as it lands
/// in R16.2. When no Node/<c>tsc</c> toolchain is present locally the check is funneled through
/// <see cref="TestSupport.RequireOrSkip"/>, which reports the test as <c>Skipped</c> (not a false
/// Passed) — keeping <c>dotnet test</c> green without a TypeScript toolchain while surfacing the gap.
/// It NEVER silently passes a real TS error: a real error is only assertable when <c>tsc</c> is
/// present, and then it IS asserted. CI sets <c>KOINE_REQUIRE_CONFORMANCE</c> and installs the
/// toolchain, so a missing one there is a hard <c>Failed</c> rather than a silent skip.
/// </summary>
public class TypeScriptConformanceTests
{
    private const string NoToolchainNotice =
        "No TypeScript toolchain (tsc) available locally; type-check not run. " +
        "Install TypeScript (or set KOINE_TSC) — CI runs this for real.";

    /// <summary>Clean, <c>--strict</c>-correct TypeScript must type-check (skipped if no toolchain).</summary>
    [Fact]
    public void Harness_accepts_well_typed_typescript()
    {
        var files = new[]
        {
            new EmittedFile("Money.ts", """
                export class Money {
                  constructor(public readonly amount: number) {}
                  add(other: Money): Money {
                    return new Money(this.amount + other.amount);
                  }
                }
                """),
        };

        var result = TestSupport.TypeCheckTypeScript(files);
        TestSupport.RequireOrSkip(result.ToolchainAvailable, NoToolchainNotice);

        result.Ok.ShouldBeTrue("expected well-typed TS to compile:\n" + string.Join("\n", result.Errors));
    }

    /// <summary>
    /// A real type error must be reported, not silently swallowed — this proves the harness is a
    /// genuine check (the analogue of the negative fixture in <see cref="AstPurityTests"/>).
    /// </summary>
    [Fact]
    public void Harness_rejects_ill_typed_typescript()
    {
        var files = new[]
        {
            new EmittedFile("Broken.ts", """
                export function takesNumber(n: number): number {
                  return n;
                }
                // strict type error: passing a string where a number is required.
                export const wrong: number = takesNumber("not a number");
                """),
        };

        var result = TestSupport.TypeCheckTypeScript(files);
        TestSupport.RequireOrSkip(result.ToolchainAvailable, NoToolchainNotice);

        result.Ok.ShouldBeFalse("expected ill-typed TS to be rejected by tsc --strict");
        result.Errors.ShouldNotBeEmpty();
    }

    /// <summary>
    /// The R16.2 acceptance check: the TypeScript the emitter actually produces for a representative
    /// domain (value object + invariant, entity with command/invariant/factory, smart enum, and a
    /// <c>Range</c>) must type-check cleanly under <c>tsc --noEmit --strict</c>. Skipped (not failed)
    /// only when no toolchain is present; with one it MUST pass with zero diagnostics.
    /// </summary>
    [Fact]
    public void Emitted_typescript_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(TypeScriptSnapshotTests.Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("emitted TypeScript should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// <c>min</c>/<c>max</c> over a <c>Decimal</c> collection must reduce via the runtime's
    /// <c>compareTo</c> (not <c>Math.min/max</c>, which wants <c>number</c> and is money-lossy):
    /// the emitted TS must type-check under <c>--strict</c>.
    /// </summary>
    [Fact]
    public void Min_and_max_over_decimal_typecheck_under_strict()
    {
        const string src =
            "context C {\n" +
            "  value Bag {\n" +
            "    items: List<Decimal>\n" +
            "    biggest: Decimal = items.max(x => x)\n" +
            "    smallest: Decimal = items.min(x => x)\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(new[] { new SourceFile("c.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("min/max over Decimal should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #788 acceptance: <c>scalar * value-object</c> with the scalar on the LEFT
    /// (<c>0.9 * base</c>) must emit the value object's own scalar multiply
    /// (<c>this.base.multiply(0.9)</c>, byte-identical to the canonical <c>base * 0.9</c>) and
    /// type-check under <c>--strict</c>. Before the fix the translator inferred only the left operand
    /// and emitted <c>new Decimal('0.9').multiply(this.base)</c>, passing the value object as a
    /// <c>Decimal | number</c> factor (TS2345). This mirrors the merged PHP Bug-2 fix (#778); the model
    /// exercises both operand orders (<c>base * 0.9</c> and <c>1.1 * base</c>).
    /// </summary>
    [Fact]
    public void Reversed_scalar_times_value_object_typechecks_under_strict()
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
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("scalar * value-object should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issues #608/#607/#606 acceptance: collection ops on a <c>Set</c> (and emptiness on a
    /// <c>Map</c>) must type-check under <c>--strict</c>. A <c>Set&lt;T&gt;</c> maps to
    /// <c>ReadonlySet&lt;T&gt;</c> and a <c>Map&lt;K,V&gt;</c> to <c>ReadonlyMap&lt;K,V&gt;</c>, which
    /// expose <c>size</c>/<c>has</c> but none of the JS Array surface — so the lambda/aggregate ops
    /// must normalize the receiver to an array, <c>contains</c> must lower to <c>.has</c>, and
    /// <c>isEmpty</c>/<c>isNotEmpty</c> to <c>.size</c>. Before the fix this emitted Array methods on a
    /// <c>ReadonlySet</c> and failed with TS2339/TS7006.
    /// </summary>
    [Fact]
    public void Set_and_map_collection_ops_typecheck_under_strict()
    {
        const string src =
            "context C {\n" +
            "  value T {\n" +
            "    tags:   Set<String>\n" +
            "    scores: Set<Int>\n" +
            "    counts: Map<String, Int>\n" +
            "    allOk:      Bool = tags.all(t => t.length > 0)\n" +
            "    anyOk:      Bool = tags.any(t => t.length > 0)\n" +
            "    noneOk:     Bool = tags.none(t => t.length > 0)\n" +
            "    hasX:       Bool = tags.contains(\"x\")\n" +
            "    emptyS:     Bool = tags.isEmpty\n" +
            "    notEmptyS:  Bool = tags.isNotEmpty\n" +
            "    emptyM:     Bool = counts.isEmpty\n" +
            "    notEmptyM:  Bool = counts.isNotEmpty\n" +
            "    distinctT:  Bool = tags.distinctBy(t => t)\n" +
            "    maxScore:   Int  = scores.max(s => s)\n" +
            "    minScore:   Int  = scores.min(s => s)\n" +
            "    totalScore: Int  = scores.sum(s => s)\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(new[] { new SourceFile("c.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("Set/Map collection ops should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #712 acceptance: a <c>distinctBy</c> over an <em>entity</em> selector must type-check
    /// under <c>tsc --noEmit --strict</c>. The fix routes an entity selector through the same
    /// <c>structuralEquals</c> fold as a value object (instead of a reference-identity <c>Set</c>);
    /// <c>structuralEquals</c> delegates to the entity's own <c>equals</c> (by id), so the dedupe
    /// matches C#'s <c>.Distinct()</c> and PHP (post-#687). This guards that the emitted entity fold —
    /// <c>.map(...).filter((__x, __i, __xs) =&gt; ...structuralEquals...)</c> over an entity array — is
    /// strict-type clean. Skipped (not failed) only when no <c>tsc</c> toolchain is present locally;
    /// CI installs Node/tsc and runs it for real.
    /// </summary>
    [Fact]
    public void DistinctBy_over_entity_selector_typechecks_under_strict()
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
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("distinctBy over an entity selector should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #241 acceptance: the full emitted set for a multi-aggregate context with a declarative finder
    /// — domain + the opt-in Infrastructure layer (concrete repositories over the in-memory store, the unit
    /// of work, the pipeline behaviors and the composition root) — must type-check under
    /// <c>tsc --noEmit --strict</c>. Skipped (not failed) only when no toolchain is present.
    /// </summary>
    [Fact]
    public void Emitted_infrastructure_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(
            TypeScriptInfrastructureSnapshotTests.Fixture,
            new TypeScriptEmitter(TypeScriptInfrastructureSnapshotTests.InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("emitted infrastructure should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #241: a publishing context's infrastructure (the transactional outbox + dispatcher and the
    /// composition root that wires them, plus the enqueue-on-save unit of work) must also type-check under
    /// <c>tsc --noEmit --strict</c>. Skipped (not failed) when no toolchain is present.
    /// </summary>
    [Fact]
    public void Emitted_publishing_infrastructure_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(
            TypeScriptInfrastructureSnapshotTests.PublishingFixture,
            new TypeScriptEmitter(TypeScriptInfrastructureSnapshotTests.InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("emitted publishing infrastructure should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #834: a plain (non-quantity) value object used directly in binary arithmetic —
    /// <c>combined: Money = base + base</c> / <c>diff: Money = base - base</c> — must emit a real
    /// <c>add</c>/<c>subtract</c> method so the derived members type-check under <c>tsc --strict</c>.
    /// The translator already lowers <c>value + value</c> / <c>value - value</c> to
    /// <c>.add(...)</c>/<c>.subtract(...)</c>; before the fix the emitter only generated <c>add</c>
    /// (and only when the VO was <c>sum</c>-folded), so <c>subtract</c> was a call to an undefined
    /// method (TS2339). Brings TS to parity with PHP/C#.
    /// </summary>
    [Fact]
    public void Value_object_plain_arithmetic_typechecks_under_tsc()
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
            "    diff: Money = base - base\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("subtract");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("plain value-object +/- should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #879 (follow-up to #832, which demand-generated <c>operator /</c> for the C# emitter):
    /// a plain value object divided by a numeric scalar — <c>half: Money = fee / 2</c> — must emit a
    /// real <c>divide</c> method, mirroring the existing demand-generated <c>multiply</c>. Before the
    /// fix <c>OperatorNeedsAnalyzer.BuildScalarDivisionNeeds</c> was recorded but never consumed
    /// by the TS emitter, and the translator fell through to a bare JS <c>/</c> on a class instance
    /// (TS2362); the derived member's type-check fails until both the emission and the translator
    /// routing land.
    /// </summary>
    [Fact]
    public void Value_object_divided_by_a_scalar_typechecks_under_tsc()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  entity Order identified by OrderId {\n" +
            "    fee: Money\n" +
            "  }\n" +
            "  readmodel FeeSplit from Order {\n" +
            "    half: Money = fee / 2\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("divide");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("value-object / scalar should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// The outcome contract <see cref="TestSupport.RequireOrSkip"/> relies on: a missing toolchain
    /// yields a <see cref="TestSupport.TypeScriptCheck.Skipped"/> result whose <c>ToolchainAvailable</c>
    /// and <c>Ok</c> are both <c>false</c> — so it can never be mistaken for a real pass.
    /// </summary>
    [Fact]
    public void Skipped_result_does_not_claim_success()
    {
        TestSupport.TypeScriptCheck skipped = TestSupport.TypeScriptCheck.Skipped;
        skipped.ToolchainAvailable.ShouldBeFalse();
        skipped.Ok.ShouldBeFalse();
        skipped.Errors.ShouldBeEmpty();
    }
}
