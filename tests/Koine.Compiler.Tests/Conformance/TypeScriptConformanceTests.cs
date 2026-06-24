using Koine.Compiler.Emit;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// R16.4 conformance harness for the TypeScript backend. This exercises the
/// <see cref="TestSupport.TypeCheckTypeScript"/> plumbing (write emitted <c>.ts</c> → run
/// <c>tsc --noEmit --strict</c>) so it is ready to validate the TypeScript emitter as it lands
/// in R16.2. When no Node/<c>tsc</c> toolchain is present locally the type-check is reported as
/// INCONCLUSIVE (a notice on the test output, no assertion) rather than failing — keeping
/// <c>dotnet test</c> green without a TypeScript toolchain. It NEVER silently passes a real TS
/// error: a real error is only assertable when <c>tsc</c> is present, and then it IS asserted.
/// CI is expected to provide the toolchain and therefore actually run the type-check.
/// </summary>
/// <remarks>
/// Dynamic skip (<c>Assert.Skip</c>) is an xUnit v3 feature; on the v2 (2.9.x) runner here it is
/// reported as a failure, so an absent toolchain is surfaced as a logged inconclusive notice.
/// </remarks>
public class TypeScriptConformanceTests
{
    private readonly ITestOutputHelper _output;

    public TypeScriptConformanceTests(ITestOutputHelper output) => _output = output;

    private const string NoToolchainNotice =
        "INCONCLUSIVE: no TypeScript toolchain (tsc) available locally; type-check not run. " +
        "Install TypeScript (or set KOINE_TSC) — CI runs this for real.";

    /// <summary>Clean, <c>--strict</c>-correct TypeScript must type-check (inconclusive if no toolchain).</summary>
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
        if (!result.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

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
        if (!result.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        result.Ok.ShouldBeFalse("expected ill-typed TS to be rejected by tsc --strict");
        result.Errors.ShouldNotBeEmpty();
    }

    /// <summary>
    /// The R16.2 acceptance check: the TypeScript the emitter actually produces for a representative
    /// domain (value object + invariant, entity with command/invariant/factory, smart enum, and a
    /// <c>Range</c>) must type-check cleanly under <c>tsc --noEmit --strict</c>. Inconclusive (logged,
    /// not failed) only when no toolchain is present; with one it MUST pass with zero diagnostics.
    /// </summary>
    [Fact]
    public void Emitted_typescript_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(TypeScriptSnapshotTests.Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

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
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        check.Ok.ShouldBeTrue("min/max over Decimal should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #241 acceptance: the full emitted set for a multi-aggregate context with a declarative finder
    /// — domain + the opt-in Infrastructure layer (concrete repositories over the in-memory store, the unit
    /// of work, the pipeline behaviors and the composition root) — must type-check under
    /// <c>tsc --noEmit --strict</c>. Inconclusive (logged, not failed) only when no toolchain is present.
    /// </summary>
    [Fact]
    public void Emitted_infrastructure_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(
            TypeScriptInfrastructureSnapshotTests.Fixture,
            new TypeScriptEmitter(TypeScriptInfrastructureSnapshotTests.InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        check.Ok.ShouldBeTrue("emitted infrastructure should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #241: a publishing context's infrastructure (the transactional outbox + dispatcher and the
    /// composition root that wires them, plus the enqueue-on-save unit of work) must also type-check under
    /// <c>tsc --noEmit --strict</c>. Inconclusive (logged, not failed) when no toolchain is present.
    /// </summary>
    [Fact]
    public void Emitted_publishing_infrastructure_typechecks_under_strict()
    {
        var result = new KoineCompiler().Compile(
            TypeScriptInfrastructureSnapshotTests.PublishingFixture,
            new TypeScriptEmitter(TypeScriptInfrastructureSnapshotTests.InfraOptions));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        check.Ok.ShouldBeTrue("emitted publishing infrastructure should type-check under --strict:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>A missing toolchain yields an inconclusive-shaped result rather than a false pass.</summary>
    [Fact]
    public void Skipped_result_does_not_claim_success()
    {
        TestSupport.TypeScriptCheck skipped = TestSupport.TypeScriptCheck.Skipped;
        skipped.ToolchainAvailable.ShouldBeFalse();
        skipped.Ok.ShouldBeFalse();
        skipped.Errors.ShouldBeEmpty();
    }
}
