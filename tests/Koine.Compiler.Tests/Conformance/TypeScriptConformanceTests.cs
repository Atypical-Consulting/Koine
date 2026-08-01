using Koine.Compiler.Emit;
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
    /// Issue #1269, TypeScript sibling of #1084 (Rust): a <c>quantity</c> value object's scalar
    /// <c>/ scalar</c> — <c>halved: Weight = base / 2</c> — must emit a real <c>divide</c> method,
    /// mirroring the already-emitted <c>multiply</c>. Before the fix <c>WriteQuantityOps</c> only ever
    /// emitted <c>add</c>/<c>subtract</c>/<c>multiply</c> for a quantity, so the general arithmetic
    /// path's <c>.divide(...)</c> call referenced a method the class never defined (a real
    /// <c>tsc --noEmit</c> TS2339).
    /// </summary>
    [Fact]
    public void Quantity_scalar_divide_typechecks_under_tsc()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit\n" +
            "  }\n" +
            "  value Box {\n" +
            "    base: Weight\n" +
            "    halved: Weight = base / 2\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no tsc required): the quantity class must define the method it's called on,
        // and its zero-divisor guard must name the quantity itself (parity with the plain-VO divide's
        // error identity), not the generic Decimal runtime type.
        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("divide(divisor: number): Weight");
        rendered.ShouldContain("DomainInvariantViolationError('Weight', 'division by zero')");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("quantity / scalar should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1700: <c>WriteQuantityOps</c>'s unit-detection (<c>TypeScriptEmitter.Types.cs</c>) picked a
    /// quantity's "unit" member via <c>index.Classify(m.Type.Qualifier, m.Type.Name)</c> — but for a bare
    /// (unqualified) type reference, <c>m.Type.Qualifier</c> is <see langword="null"/>, so this call
    /// degraded to the flat, context-BLIND <c>Classify(typeName)</c> overload exactly like the
    /// <c>EnumExpected</c> call sites (#1638's fix never touched <c>WriteQuantityOps</c>, out of its
    /// declared <c>TypeMapper</c>-only scope). The fix threads the emitting context as a fallback
    /// resolution frame (<c>m.Type.Qualifier ?? context</c>), mirroring <see cref="EnumExpected"/>'s own
    /// fix — and the same fallback was applied to <c>WriteCommand</c>'s transition <c>expectedEnum</c>
    /// inline classify (the identical blind shape, one call site over) and to all four
    /// <see cref="EnumExpected"/> call sites (now context-parameterized).
    /// <para>
    /// <b>A same-named-sibling repro proved unreachable within this emitter's scope</b> — for the same
    /// structural reason documented on <c>RustConformanceTests</c>'
    /// <c>Defaulted_member_s_bare_enum_initializer_disambiguates_against_its_own_declared_type</c>: a
    /// same-named, differently-kinded sibling in another context is the ONLY way to make blind vs.
    /// context-aware classification diverge, but for a <c>quantity</c>'s unit member specifically that
    /// same collision is independently rejected by <c>SemanticValidator.ValidateQuantity</c>'s OWN
    /// <c>IsUnit</c> check (<c>index.Classify(m.Type.Name) == TypeKind.Enum</c>, in
    /// <c>Semantics/SemanticValidator.cs</c> — also context-blind, but out of this emitter-only PR's
    /// scope) before the model ever reaches emission (confirmed empirically: the collision model fails
    /// compilation with <c>KOI0904</c>, "must declare exactly one enum-typed unit member, found 0").
    /// Closing this fully needs that validator fixed too — filed as a follow-up alongside the
    /// <c>ModelIndex.AllTypes()</c>/<c>EnumsDeclaring</c> gap (see the PR description).
    /// </para>
    /// <para>
    /// This test instead pins the REACHABLE part of the fix's contract: a quantity's unit-checked
    /// operators are still correctly emitted once a second, non-colliding context exists in the model —
    /// regression coverage for the <c>ModelIndex</c>-&gt;<c>context</c>-parameter signature change.
    /// </para>
    /// </summary>
    [Fact]
    public void Quantity_ops_still_emit_with_the_context_parameter_threaded_through()
    {
        const string src =
            "context Freight {\n" +
            "  enum Weight { Light, Heavy }\n" +
            "  quantity Load {\n" +
            "    amount: Decimal\n" +
            "    unit: Weight\n" +
            "  }\n" +
            "}\n" +
            "context Shipping {\n" +
            "  enum PackageSize { Small, Large }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(new[] { new SourceFile("freight.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("add(other: Load): Load");
        rendered.ShouldContain("subtract(other: Load): Load");
        rendered.ShouldContain("multiply(factor: number): Load");
        rendered.ShouldContain("divide(divisor: number): Load");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("quantity unit detection should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1344: a <c>ConditionalExpr</c> derived-member body whose branches disagree ONLY in numeric
    /// type (a non-optional <c>Int</c> branch against a <c>Decimal</c> sibling) must widen the <c>Int</c>
    /// branch to <c>Decimal.fromInt(...)</c> so both ternary arms share a type — <c>tsc --strict</c>
    /// rejects a bare <c>number</c> where a <c>Decimal</c> (a class) is expected. Before the fix this
    /// emitted an unreconciled <c>(this.amount > 0 ? this.amount : this.amountDecimal)</c> that fails
    /// TS2322/TS2322 under <c>--strict</c>.
    /// </summary>
    [Fact]
    public void Conditional_branch_numeric_widen_typechecks_under_strict()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    amountDecimal: Decimal\n" +
            "    total: Decimal = if amount > 0 then amount else amountDecimal\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("Decimal.fromInt(");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("numeric-mismatched conditional branches should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1344: a <c>ConditionalExpr</c> derived-member body whose branches disagree ONLY in
    /// optionality (a non-optional branch against an optional sibling of the SAME underlying type) is
    /// already <c>--strict</c>-clean in TypeScript with no emitter change: an optional Koine type maps to
    /// a union with <c>undefined</c> (<c>T | undefined</c>), and a bare <c>T</c> value is structurally
    /// assignable wherever <c>T | undefined</c> is expected — unlike Rust's <c>Option&lt;T&gt;</c> or
    /// Java's <c>Optional&lt;T&gt;</c>, which are distinct nominal types that need an explicit wrap. This
    /// guards that TypeScript keeps taking the no-op path (no wrap emitted) for this shape.
    /// </summary>
    [Fact]
    public void Conditional_branch_optionality_only_mismatch_typechecks_under_strict()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    bonus: Int?\n" +
            "    total: Int? = if amount > 0 then amount else bonus\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("optionality-only-mismatched conditional branches should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1344 (the issue's exact repro): a <c>ConditionalExpr</c> derived-member body whose branches
    /// disagree in BOTH numeric type and optionality at once — a non-optional <c>Decimal</c> branch
    /// against an optional <c>Int</c> sibling — must null-check-and-widen the optional <c>Int</c> branch
    /// so both ternary arms are <c>Decimal | undefined</c>-compatible. Before the fix TypeScript rendered
    /// a bare <c>(this.decimalAmount > 0 ? this.decimalAmount : this.intBonus)</c> — a <c>Decimal</c>
    /// against a bare <c>number | undefined</c> — which <c>tsc --strict</c> rejects with exactly
    /// <c>TS2322: Type 'number | undefined' is not assignable to type 'Decimal | undefined'</c>.
    /// </summary>
    [Fact]
    public void Conditional_branch_with_optional_int_widen_typechecks_under_strict()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    decimalAmount: Decimal\n" +
            "    intBonus: Int?\n" +
            "    total: Decimal? = if decimalAmount > 0 then decimalAmount else intBonus\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("Decimal.fromInt(");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("both-mismatched conditional branches should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1344: the <c>needsWiden</c> widen must apply against an OPTIONAL <c>Decimal?</c> sibling
    /// too (not just a non-optional one) — a non-optional <c>Int</c> branch against a <c>Decimal?</c>
    /// sibling must still widen to <c>Decimal.fromInt(...)</c>; no further wrap is needed since a bare
    /// <c>Decimal</c> is already assignable where <c>Decimal | undefined</c> is expected. Mirrors the
    /// Rust/Java <c>Cash</c> fixture's widen+wrap composition case (TypeScript just never needs the wrap
    /// half — see <see cref="Conditional_branch_optionality_only_mismatch_typechecks_under_strict"/>).
    /// </summary>
    [Fact]
    public void Conditional_branch_numeric_widen_against_optional_sibling_typechecks_under_strict()
    {
        const string src =
            "context Shop {\n" +
            "  value Cash {\n" +
            "    amount: Int\n" +
            "    bonusAmount: Decimal?\n" +
            "    total: Decimal? = if amount > 0 then amount else bonusAmount\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("Decimal.fromInt(");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("widen-against-optional-sibling conditional branches should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1344: a nested <c>ConditionalExpr</c> used as one branch of an outer conditional must itself
    /// reconcile its own two arms BEFORE the outer branch is emitted, so the inner ternary's inferred
    /// (joined, #975) type lines up with the outer sibling's type. Here the inner <c>if</c> widens
    /// <c>amount</c> (<c>Int</c>) against <c>bonus</c> (<c>Decimal</c>) to <c>Decimal</c>, which then
    /// already matches the outer <c>else</c> branch <c>fallback: Decimal</c> with no further outer-level
    /// reconciliation needed.
    /// </summary>
    [Fact]
    public void Conditional_branch_with_nested_conditional_typechecks_under_strict()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    bonus: Decimal\n" +
            "    fallback: Decimal\n" +
            "    total: Decimal = if amount > 0 then (if amount > 10 then amount else bonus) else fallback\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("Decimal.fromInt(");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue("nested-conditional branches should type-check under --strict:\n" + string.Join("\n", check.Errors));
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

    /// <summary>
    /// Issue #938: an <c>Int</c> field's value-object scalar <c>multiply</c>/<c>divide</c> must
    /// truncate toward zero (<c>Math.trunc</c>), matching the C#/Python/Rust emitters, instead of
    /// rounding half-up (<c>Math.round</c>). Before the fix this was the one target that diverged —
    /// the same <c>.koi</c> model produced a different number in TypeScript than everywhere else.
    /// </summary>
    [Fact]
    public void Int_field_scalar_multiply_and_divide_truncate_toward_zero()
    {
        var result = new KoineCompiler().Compile(TypeScriptSnapshotTests.IntFieldScalarFixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rendered = TestSupport.Render(result.Files);
        rendered.ShouldContain("Math.trunc(");
        rendered.ShouldNotContain("Math.round(");
    }

    /// <summary>
    /// Issue #938 runtime proof: the emitted <c>divide</c>/<c>multiply</c> must actually evaluate to the
    /// truncated-toward-zero result under Node — including a negative operand, where truncation
    /// (<c>-7 / 2 === -3</c>) differs from both half-up rounding (<c>Math.round(-3.5) === -3</c>,
    /// coincidentally the same here) and floor (<c>Math.floor(-3.5) === -4</c>, which truncation must
    /// NOT match). Skipped (not failed) when no Node/tsc toolchain is present locally; CI runs it for real.
    /// </summary>
    [Fact]
    public void Int_field_divide_truncates_toward_zero_at_runtime()
    {
        var result = new KoineCompiler().Compile(TypeScriptSnapshotTests.IntFieldScalarFixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            import { Weight } from './Shop/value-objects/Weight.js';

            const positive = new Weight(7).divide(2);
            const negative = new Weight(-7).divide(2);
            const fractional = new Weight(5).multiply(1.5);
            console.log(JSON.stringify({ positive: positive.grams, negative: negative.grams, fractional: fractional.grams }));
            """;

        TestSupport.NodeRun run = TestSupport.RunTypeScript(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoToolchainNotice);

        run.Ok.ShouldBeTrue("Int-field divide/multiply should evaluate under node:\n" + string.Join("\n", run.Errors));
        run.Stdout.ShouldContain("\"positive\":3");
        run.Stdout.ShouldContain("\"negative\":-3");
        run.Stdout.ShouldContain("\"fractional\":7");
    }

    /// <summary>
    /// Issue #1558: bare <c>Int / Int</c> division in an ordinary derived member — no value object
    /// scalar method involved, just a plain binary expression — must also truncate toward zero,
    /// matching the value-object scalar-divide rule #938 already established. Before the fix,
    /// <c>TryWriteValueArithmetic</c> declines (neither operand is Decimal or a Koine value object)
    /// and the plain-numeric fallback renders a bare JS <c>/</c> — a silent fractional runtime value
    /// for a field TypeScript declares (and Koine models) as <c>Int</c>.
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
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            import { Order } from './Shop/value-objects/Order.js';

            const positive = new Order(7).half;
            const negative = new Order(-7).half;
            console.log(JSON.stringify({ positive, negative }));
            """;

        TestSupport.NodeRun run = TestSupport.RunTypeScript(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoToolchainNotice);

        run.Ok.ShouldBeTrue("Int/Int derived-member division should evaluate under node:\n" + string.Join("\n", run.Errors));
        run.Stdout.Trim().ShouldBe("{\"positive\":3,\"negative\":-3}");
    }

    /// <summary>
    /// Issue #1597: a guard-narrowed <c>Int? / Int</c> division — narrowed present via
    /// <c>if qty.isPresent then … else …</c> — must also truncate toward zero, closing the
    /// optional-operand gap #1558 left open. <c>IsIntDivision</c>'s original gate required the binary
    /// expression's own inferred type to be non-optional <c>Int</c>; a guarded optional still infers as
    /// optional at this call site (guard narrowing is validator-only and never reaches
    /// <c>TypeResolver.Infer</c>), so the gate excluded it and the plain-numeric fallback rendered a
    /// bare JS <c>/</c> inside the narrowed ternary branch — a silent fractional runtime value
    /// (<c>3.5</c> instead of <c>3</c>) even though the validator already guarantees the operand is
    /// present at the arithmetic site. (The <c>if/then/else</c> form is used here rather than the
    /// bare-postfix <c>qty / 2 when qty.isPresent</c> from the issue's repro: TypeScript's own
    /// control-flow narrowing needs the <c>this.qty !== undefined ? … : …</c> ternary the conditional
    /// form emits — the bare <c>when</c> form renders the guarded body with no narrowing check at all,
    /// which fails <c>tsc --strict</c> for ANY operator on the optional operand, not just division; a
    /// broader, pre-existing gap tracked separately.)
    /// </summary>
    [Fact]
    public void Guarded_optional_int_field_derived_division_truncates_toward_zero_at_runtime()
    {
        const string src =
            """
            context Shop {
              value Order {
                qty:  Int?
                half: Int? = if qty.isPresent then qty / 2 else 0
              }
            }
            """;
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            import { Order } from './Shop/value-objects/Order.js';

            const positive = new Order(7).half;
            const negative = new Order(-7).half;
            console.log(JSON.stringify({ positive, negative }));
            """;

        TestSupport.NodeRun run = TestSupport.RunTypeScript(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoToolchainNotice);

        run.Ok.ShouldBeTrue("Guarded-optional Int/Int derived-member division should evaluate under node:\n" + string.Join("\n", run.Errors));
        run.Stdout.Trim().ShouldBe("{\"positive\":3,\"negative\":-3}");
    }

    /// <summary>
    /// Issue #1604: a bare postfix <c>when</c> guard (<c>GuardExpr</c>, not the <c>if/then/else</c>
    /// <c>ConditionalExpr</c> form #1597 exercises above) must narrow the same way — before the fix,
    /// <c>TypeScriptExpressionTranslator</c>'s <c>GuardExpr</c> case rendered only the body, dropping
    /// the guard condition entirely, so the emitted getter kept the field's full <c>T | undefined</c>
    /// type with no narrowing check at all: a real <c>tsc --strict</c> TS2532 on ANY operator over the
    /// guard-narrowed optional operand, not specific to division.
    /// </summary>
    [Fact]
    public void Postfix_when_guarded_optional_int_division_narrows_and_truncates_toward_zero_at_runtime()
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
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(
            "Postfix when-guarded optional Int arithmetic should type-check under --strict:\n" + string.Join("\n", check.Errors));

        const string driver = """
            import { Order } from './Shop/value-objects/Order.js';

            const present = new Order(7).half;
            const absent = new Order(undefined).half;
            console.log(present, String(absent));
            """;

        TestSupport.NodeRun run = TestSupport.RunTypeScript(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoToolchainNotice);

        run.Ok.ShouldBeTrue("Postfix when-guarded optional Int/Int derived-member division should evaluate under node:\n" + string.Join("\n", run.Errors));
        run.Stdout.Trim().ShouldBe("3 undefined");
    }

    /// <summary>
    /// Issue #1537 acceptance: Decimal arithmetic against a non-Decimal Int operand — an Int LITERAL,
    /// an Int MEMBER, on either side of the operator, across all four of <c>+ - * /</c>, and a guarded
    /// OPTIONAL Int member — must all widen to <c>Decimal</c> at the call site and type-check under
    /// <c>tsc --strict</c>. Before the fix, <c>rate + 1</c> emitted the bare literal
    /// <c>this.rate.add(1)</c> against the runtime's strict <c>add(other: Decimal)</c> — a TS2345 on
    /// the single most ordinary Decimal-arithmetic shape in the language, needing no shadowing, no
    /// <c>let</c>, no lambda.
    /// </summary>
    [Fact]
    public void Decimal_arithmetic_against_int_operands_typechecks_under_strict()
    {
        const string src =
            """
            context Shop {
              value Order {
                rate:       Decimal
                qty:        Int
                discount:   Int?
                literalPlus:    Decimal = rate + 1
                literalOnLeft:  Decimal = 1 + rate
                memberPlus:     Decimal = rate + qty
                memberMinus:    Decimal = rate - qty
                memberTimes:    Decimal = rate * qty
                memberDivided:  Decimal = rate / qty
                withOptional:   Decimal? = if discount.isPresent then rate - discount else rate
              }
            }
            """;
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(
            "Decimal arithmetic against Int literals/members/an optional member should type-check under --strict:\n"
            + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1557 acceptance: a guarded OPTIONAL <c>Decimal</c> operand — the sibling bug class to
    /// #1537's optional-Int case above — must map-widen the same way when consumed inside a NESTED
    /// closure (a <c>distinctBy</c> selector lambda), where TypeScript's own control-flow narrowing of
    /// the outer guard doesn't reach. Also covers a guarded optional <c>Decimal</c> AND a guarded
    /// optional <c>Int</c> together in the SAME value object (independent guards, each consumed in its
    /// own nested closure) so both optional-widen paths are exercised side by side in one conformance
    /// case. Before the fix, <c>this.discount.add(r)</c> rendered bare — a real <c>tsc</c> TS2532
    /// (<c>this.discount</c> still typed <c>Decimal | undefined</c> inside the closure).
    /// </summary>
    [Fact]
    public void Decimal_and_int_guarded_optionals_inside_nested_closures_typecheck_under_strict()
    {
        const string src =
            """
            context Shop {
              value Order {
                rate:            Decimal
                discount:        Decimal?
                qty:             Int?
                rates:           List<Decimal>
                discountApplied: Bool = if discount.isPresent then rates.distinctBy(r => discount + r) else true
                qtyApplied:      Bool = if qty.isPresent then rates.distinctBy(r => rate + qty) else true
              }
            }
            """;
        var result = new KoineCompiler().Compile(new[] { new SourceFile("shop.koi", src) }, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(
            "a guarded optional Decimal and a guarded optional Int, each consumed inside a nested "
            + "closure, should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1622: <c>ModelIndex.Classify(string)</c> is context-blind — its flat, last-write-wins
    /// <c>_byName</c> index resolves a same-named enum declared in a DIFFERENT context (R13.2 legally
    /// allows this), so a qualified enum-member reference (<c>Status.Open</c>) can be classified
    /// against the WRONG context's <c>Status</c> declaration depending on <c>ModelIndex</c>
    /// registration order relative to the sibling context's same-named enum. This pins the case where
    /// the referencing context (<c>Billing</c>) is declared AFTER its same-named sibling
    /// (<c>Shipping</c>) — the order under which <c>Billing</c>'s own reference to its own
    /// <c>Status.Open</c> must still resolve correctly post-migration, guarding the context-aware
    /// <c>Classify(context, typeName)</c> call sites against regressing.
    /// <para>
    /// NOTE: the REVERSE declaration order (the referencing context declared FIRST) currently fails
    /// semantic validation outright with KOI0106 ("unknown enum member") — a separate, deeper,
    /// out-of-scope bug: <c>Semantics/ExpressionChecker.CheckMember</c>'s own qualified-enum-reference
    /// gate (<c>ModelIndex.IsEnumType</c>/<c>EnumsDeclaring</c>) shares the same flat, context-blind
    /// <c>_byName</c>/<c>_enumMembersByName</c> index, so it rejects a legally-valid same-named-enum
    /// model before the TypeScript emitter's own call sites (migrated here) are ever reached. Filed
    /// separately as it's outside #1622's emitter-only scope and affects every emit target, not just
    /// TypeScript.
    /// </para>
    /// </summary>
    [Fact]
    public void Same_named_enum_across_two_contexts_resolves_the_correct_context_for_a_qualified_reference()
    {
        const string src =
            """
            context Shipping {
              enum Status {
                Pending
                Delivered
              }
            }

            context Billing {
              enum Status {
                Open
                Closed
              }
              value Invoice {
                status: Status
                isOpen: Bool = status == Status.Open
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(
            "a same-named enum in a sibling context must not misclassify Billing.Status's own "
            + "qualified reference:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1638: <c>TypeScriptTypeMapper</c> is constructed ONCE per compile and reused across every
    /// context, so it carries no ambient context of its own — only the <c>TypeRef.Qualifier</c>, which
    /// the parser leaves <c>null</c> for the common, BARE (unqualified) same-context reference. Unlike
    /// the qualified-reference case pinned above (<c>Status.Open</c>, which already carries a non-null
    /// <c>Qualifier</c>), a plain field declaration such as <c>status: Status</c> has NO qualifier at
    /// all, so <c>MapBase</c>/<c>IsEnum</c>'s <c>_index.Classify(type.Qualifier, type.Name)</c> degrades
    /// straight to the flat, context-blind, last-write-wins <c>Classify(typeName)</c> fallback. Here
    /// <c>Billing</c> (declared FIRST) owns an ENUM named <c>Status</c>; a differently-KINDED sibling
    /// <c>Status</c> (a VALUE OBJECT) is declared in <c>Shipping</c> AFTER it, so the flat index's
    /// last-write-wins registration resolves bare <c>Classify("Status")</c> to Shipping's value object,
    /// not Billing's own enum. Before the fix, <c>Invoice.status</c> — a member of <c>Billing</c>
    /// referencing <c>Billing</c>'s OWN enum by its bare name — is misclassified as non-enum, so the
    /// emitted field type is the bare <c>Status</c> (the enum's exported <c>const</c> OBJECT, not a
    /// type) instead of the correct <c>StatusMember</c> interface: a genuine <c>tsc --strict</c> error
    /// ("'Status' refers to a value, but is being used as a type here"), not merely a stylistic
    /// mismatch. This is the exact gap the qualified-reference test above does NOT exercise, since a
    /// qualified reference already carries a non-null <c>Qualifier</c>.
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
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(
            "a bare, unqualified reference to Billing's OWN enum Status must not misclassify against "
            + "Shipping's differently-kinded, same-named sibling Status:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1638 code-review finding: a read model's DIRECT field (<c>TypeScriptEmitter.Cqrs.cs</c>)
    /// copies a like-named member straight off the SOURCE type — which, per R12.3, may live in a
    /// DIFFERENT bounded context than the read model itself (here the read model is declared in
    /// <c>Billing</c>, projecting <c>Ordering.Order</c> via an explicit import). The very first draft of
    /// this issue's fix passed the read model's OWN context (<c>Billing</c>) as the classification
    /// fallback for the source field's bare (unqualified) type — but that field is declared ON
    /// <c>Order</c>, i.e. WITHIN <c>Ordering</c>'s own model, so its correct resolution frame is
    /// <c>Ordering</c>, not the projecting read model's context. <c>Billing</c> independently declaring
    /// its own, differently-kinded <c>Status</c> (a value object, vs. <c>Ordering.Status</c>'s data-free
    /// enum) makes the misclassification observable: the read model's <c>status</c> field would be typed
    /// <c>Status</c> (Billing's own value-object interface) instead of <c>StatusMember</c>
    /// (<c>Ordering</c>'s enum interface) — a genuine <c>tsc --strict</c> error ("Type 'StatusMember' is
    /// missing the following properties from type 'Status'"). The fix resolves the SOURCE type's own
    /// owning context via <c>ModelIndex.ResolveOwner</c> and passes THAT as the classify-fallback for a
    /// direct field's type, instead of the read model's own context.
    /// </summary>
    [Fact]
    public void Read_model_direct_field_from_a_foreign_context_resolves_against_the_source_s_own_context()
    {
        const string src =
            """
            context Billing {
              value Status {
                code: String
              }

              import Ordering.{ Order }

              readmodel OrderSummary from Order {
                status
              }
            }

            context Ordering {
              enum Status {
                Pending
                Shipped
                Delivered
              }

              entity Order identified by OrderId {
                status: Status = Pending
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(
            "a read model's direct field must classify the SOURCE type's own bare member reference against "
            + "the source's own owning context, not the read model's:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1531 (audit, Task 2) — the Rust (#1467/PR #1476) and Java (#1480/PR #1521) emitters both
    /// shipped the identical bug in their factory constructor-argument loop's auto-bound branch: a
    /// <c>required</c>-bucket member declared optional but carrying no member-level default
    /// (<c>total: Decimal?</c>), auto-bound to a NON-optional same-named factory parameter
    /// (<c>create make(total: Decimal)</c>), had its bare value passed straight into a constructor slot
    /// typed <c>Option&lt;T&gt;</c>/<c>Optional&lt;T&gt;</c> — a real <c>rustc</c> E0308 / <c>javac</c>
    /// "incompatible types" error, fixed by wrapping in <c>Some(…)</c>/<c>Optional.of(…)</c>.
    /// <para>
    /// TypeScript's <c>WriteFactory</c> likewise passes the bare value — but it maps <c>T?</c> to the
    /// UNION <c>T | undefined</c> (<c>TypeScriptTypeMapper</c>), not to a wrapper value, and <c>T</c> is
    /// a member of that union, so the assignment is already well-typed. There is no wrap construct to
    /// apply and none is needed. This test records that negative audit result and locks it in: it
    /// asserts the union-typed constructor slot AND the bare, unwrapped argument, then proves with a
    /// real <c>tsc --noEmit --strict</c> run that the pair type-checks. Were the TypeScript backend ever
    /// to move to a wrapper-typed optional representation, this test fails and the Rust/Java wrap
    /// becomes required.
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
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no tsc required): the optional-declared member's constructor slot is a
        // `T | undefined` UNION, so the auto-bound non-optional parameter is passed through bare.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain("total: Decimal | undefined = undefined)");
        product.ShouldContain("return new Product(id, total);");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(
            "an auto-bound non-optional parameter must be assignable straight into an optional-declared "
            + "member's `T | undefined` constructor slot:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// The explicit-init half of the same #1531 audit — the branch Rust #1452/PR #1464 and Java
    /// #1479/PR #1518 fixed. A <c>total -&gt; 5.0</c> initialization of an optional-declared,
    /// default-less <c>required</c> member yields a non-optional value; Rust/Java must wrap it,
    /// TypeScript must not, for the same union-vs-wrapper reason. Since nothing is ever wrapped, the
    /// double-wrap hazard the Rust/Java fixes had to guard against cannot arise here at all.
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
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain("total: Decimal | undefined = undefined)");
        product.ShouldContain("return new Product(id, new Decimal('5.0'));");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(
            "an explicitly initialized non-optional value must be assignable straight into an "
            + "optional-declared member's `T | undefined` constructor slot:\n"
            + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1731: the factory constructor-argument loop matched a same-named factory parameter to
    /// an entity member by NAME ONLY (<c>factoryParams.Contains(m.Name)</c>), not via the shared,
    /// target-agnostic <c>MemberAnalysis.AutoBinds</c> predicate already used by the C#, Kotlin,
    /// Java and Rust emitters — which additionally requires matching type shape and that an OPTIONAL
    /// parameter never auto-bind to a NON-optional member. This is the reverse direction from the
    /// #1531 audit pinned above (there the MEMBER was optional and the parameter was not); here the
    /// PARAMETER is optional (<c>total: Decimal?</c>) and the member is not (<c>total: Decimal</c>).
    /// Before the fix, the optional parameter was bound straight into the non-optional constructor
    /// slot — a real <c>tsc --strict</c> TS2345 (<c>Decimal | undefined</c> is not assignable to
    /// <c>Decimal</c>).
    /// </summary>
    [Fact]
    public void Optional_parameter_does_not_auto_bind_a_non_optional_member()
    {
        const string src =
            """
            context Shop {
              entity Product identified by ProductId {
                total: Decimal

                create make(total: Decimal?) {
                }
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no tsc required): the optional parameter must NOT be passed directly into
        // the non-optional member's constructor slot; instead the ctor-arg loop falls all the way
        // through to the required-and-unset branch (`undefined as never`) since the member has
        // neither a factory init nor its own default.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldNotContain("return new Product(id, total);");
        product.ShouldContain("return new Product(id, undefined as never);");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(
            "an optional factory parameter must not auto-bind into a non-optional member's "
            + "constructor slot:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1732: the explicit-init branch of <c>WriteFactory</c>'s ctor-args loop never reconciled
    /// the value's inferred type against the member's declared type, so an <c>Int</c> literal
    /// initializing a <c>Decimal</c> member emitted a bare <c>number</c> where the runtime <c>Decimal</c>
    /// class is required — a real <c>tsc --strict</c> TS2345 "Argument of type 'number' is not
    /// assignable to parameter of type 'Decimal'" error. Mirrors Kotlin's #1732 fix.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_a_decimal_member_from_an_int_literal_is_decimal_coerced()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal\n" +
            "\n" +
            "    create make() {\n" +
            "      total -> 5\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no tsc required): the Int-typed initializer must be widened to Decimal to
        // match the constructor's Decimal parameter, not passed through as a bare number literal.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain("return new Product(id, Decimal.fromInt(5));");
        product.ShouldNotContain("return new Product(id, 5);");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Zero-change regression guard: a <c>Decimal</c>-typed value explicit-initializing a
    /// <c>Decimal</c>-declared member must be unaffected by #1732's coercion — no extra
    /// <c>Decimal.fromInt(...)</c> wrap added around an already-<c>Decimal</c> value.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_a_decimal_member_from_a_decimal_literal_is_unaffected()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal\n" +
            "\n" +
            "    create make() {\n" +
            "      total -> 5.0\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain("return new Product(id, new Decimal('5.0'));");
        product.ShouldNotContain("Decimal.fromInt(new Decimal");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Zero-change regression guard for the coalesce double-widen trap: a <c>CoalesceExpr</c> whose own
    /// effective type ALREADY matches the declared member (both <c>Decimal</c>-shaped) must be left
    /// entirely unwrapped by <c>TranslateReconciled</c>'s <c>InferCtorArgValueType</c> guard — pins that
    /// the guard degrades to "no reconciliation needed" rather than wrapping the whole
    /// <c>(a ?? b)</c> in a <c>Decimal.fromInt(...)</c> call that would not type-check against a
    /// <c>Decimal</c>-typed right operand.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_a_decimal_member_from_a_matching_coalesce_is_unaffected()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal\n" +
            "\n" +
            "    create make(a: Decimal?, b: Decimal) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain("return new Product(id, (a ?? b));");
        product.ShouldNotContain("Decimal.fromInt(");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1732: an ALREADY-optional <c>number | undefined</c> initializing expression (a factory
    /// parameter) that is ALSO numerically mismatched against an optional-declared <c>Decimal?</c>
    /// member needs the null-check-and-widen shell (<see cref="WriteOptionalMap"/>) — a bare
    /// <c>Decimal.fromInt(...)</c> wrap around a possibly-<c>undefined</c> value does not type-check.
    /// Mirrors Kotlin's #1732 fix and Java's #1519 follow-up.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_decimal_member_from_an_already_optional_int_source_is_null_check_widened()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(discount: Int?) {\n" +
            "      total -> discount\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no tsc required): the already-optional number value must be null-check-and-
        // widened, never bare-wrapped (a real tsc --strict "not assignable" error).
        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain("Decimal.fromInt(__v)");
        product.ShouldNotContain("return new Product(id, discount);");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1762: a coalesce (<c>??</c>) whose two operands are optional but of DIFFERENT numeric
    /// types (<c>Int?</c> vs <c>Decimal?</c>) must reconcile that mismatch before emitting TypeScript's
    /// nullish-coalescing <c>??</c> — unreconciled, the expression's static type is the union
    /// <c>number | Decimal | undefined</c>, a real <c>tsc --strict</c> TS2345/TS2322 wherever a
    /// <c>Decimal | undefined</c> is expected. The narrower <c>Int?</c> left operand must
    /// null-check-and-widen (<see cref="WriteOptionalMap"/>'s shell around
    /// <c>Decimal.fromInt(__v)</c>) before the <c>??</c>, mirroring Kotlin's <c>WriteCoalesce</c>
    /// (#1615) and Java's <c>Optional.or</c>/<c>.orElse</c> fix (#1548).
    /// </summary>
    [Fact]
    public void Coalesce_reconciles_a_numeric_type_mismatch_between_nullable_operands()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(a: Int?, b: Decimal?) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no tsc required): the narrower Int? operand is null-check-and-widened before
        // the `??`, so both sides agree on `Decimal | undefined`.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain("Decimal.fromInt(__v)");
        product.ShouldContain(")(a) ?? b)");
        product.ShouldNotContain("(a ?? b)");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// #1762's symmetric operand order: the LEFT operand is already the wider <c>Decimal?</c> (no widen
    /// needed), while the narrower <c>Int?</c> RIGHT operand must null-check-and-widen after the
    /// <c>??</c> — each side is classified against the OTHER'S type independently, exactly as Kotlin's
    /// <c>WriteCoalesce</c> does.
    /// </summary>
    [Fact]
    public void Coalesce_reconciles_a_numeric_type_mismatch_symmetric_operand_order()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(a: Decimal?, b: Int?) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain("(a ?? ((__v");
        product.ShouldContain("Decimal.fromInt(__v)");
        product.ShouldNotContain("(a ?? b)");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Zero-change regression guard for #1762: a coalesce whose two operands ALREADY agree in numeric
    /// type (the common, already-correct case) must keep emitting a bare <c>??</c> with no widening
    /// wrap — byte-identical to the pre-fix output.
    /// </summary>
    [Fact]
    public void Coalesce_with_same_typed_nullable_operands_emits_unchanged()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(a: Decimal?, b: Decimal?) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain("return new Product(id, (a ?? b));");
        product.ShouldNotContain("Decimal.fromInt(");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// #1762 edge case 2 (the shape #1615's own code review caught for Kotlin): a nested coalesce as the
    /// RIGHT operand must stay atomized when the widen attaches, so the widen covers the WHOLE nested
    /// coalesce rather than only its innermost operand. TypeScript's own <c>Write</c> already
    /// parenthesizes a <c>CoalesceExpr</c> and <see cref="WriteOptionalMap"/> parenthesizes its argument
    /// slot, so the widen composes safely — this pins that.
    /// </summary>
    [Fact]
    public void Coalesce_reconciles_a_numeric_type_mismatch_against_a_nested_coalesce_right_operand()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(a: Decimal?, x: Int?, y: Int?) {\n" +
            "      total -> a ?? (x ?? y)\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The widen wraps the whole `(x ?? y)`, not just `x` or just `y`.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain("Decimal.fromInt(__v)");
        product.ShouldContain("))((x ?? y))");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// #1762: a nested coalesce as the LEFT operand is the case that forces the effective-type helper to
    /// RECURSE. <c>TypeResolver.VisitCoalesce</c> reports <c>(x ?? b)</c>'s type as <c>x</c>'s own
    /// <c>Int?</c>, but the fixed rendering widens <c>x</c>, so the nested coalesce actually renders as
    /// <c>Decimal | undefined</c>. Classifying the outer operands against the RAW resolver types would
    /// therefore see <c>Int?</c> vs <c>Int?</c>, leave the outer right operand unwidened, and emit a
    /// <c>Decimal | number | undefined</c> union — the very TS2322 this issue exists to fix.
    /// </summary>
    [Fact]
    public void Coalesce_reconciles_against_a_nested_coalesce_left_operand_s_widened_type()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(x: Int?, b: Decimal?, c: Int?) {\n" +
            "      total -> (x ?? b) ?? c\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Both the inner `x` and the outer `c` must be widened — two independent shells.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain(")(x) ?? b) ?? ");
        product.ShouldContain(")(c))");
        product.ShouldNotContain("?? c)");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// #1762 edge case 4: the fix lives in the shared <c>CoalesceExpr</c> case, not a narrower call
    /// site, so a command-body state transition and a derived-member body get the reconciliation for
    /// free. Mirrors Java's #1548 Task 2 coverage.
    /// </summary>
    [Fact]
    public void Coalesce_reconciles_in_a_state_transition_and_a_derived_member()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "    fallback: Decimal?\n" +
            "    hint: Int?\n" +
            "    best: Decimal? = hint ?? fallback\n" +
            "\n" +
            "    command adjust(a: Int?, b: Decimal?) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        product.ShouldContain(")(this.hint) ?? this.fallback)");   // derived member
        product.ShouldContain(")(a) ?? b)");                        // command transition
        product.ShouldNotContain("(this.hint ?? this.fallback)");
        product.ShouldNotContain("(a ?? b)");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// #1762 × #1732 regression: #1732's <c>InferCtorArgValueType</c> guard exists so the factory
    /// ctor-arg wrap does NOT misfire on a coalesce. Now that the coalesce rendering itself reconciles,
    /// the guard must still see the coalesce's own (joined) type and add NO second widen on top —
    /// exactly one <c>Decimal.fromInt(__v)</c> shell (the operand's), never a
    /// <c>Decimal.fromInt((… ?? …))</c> wrapped around the whole thing.
    /// </summary>
    [Fact]
    public void Factory_ctor_arg_guard_does_not_double_widen_a_reconciled_coalesce()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(a: Int?, b: Decimal?) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("entities/Product.ts", StringComparison.Ordinal)).Contents;
        var factory = product.Split('\n').Single(l => l.Contains("return new Product(", StringComparison.Ordinal));

        // Exactly one widen shell — the reconciled LEFT operand's — and no outer wrap around the coalesce.
        factory.Split("Decimal.fromInt(__v)").Length.ShouldBe(2);
        factory.ShouldNotContain("Decimal.fromInt((");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }
}
