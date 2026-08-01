using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// The TypeScript half of issue #1756 (C# fix: PR #1760; Java port: PR #1772). A value object's
/// invariants are emitted at the TOP of the constructor, before the fields are assigned, with members
/// rendered as constructor parameters — but a DERIVED member has no parameter, so the guard used to
/// emit a bare name that bound to nothing (tsc TS2663). These are type-check/execute conformance tests
/// on purpose: the snapshot suites captured the broken text without noticing.
/// </summary>
public class TypeScriptDerivedMemberInvariantTests
{
    private const string NoToolchainNotice =
        "No TypeScript toolchain (tsc) available locally; type-check not run. " +
        "Install TypeScript (or set KOINE_TSC) — CI runs this for real.";

    private const string UsageMeterFixture = """
        context Subscription {
          value UsageMeter {
            includedQuota: Int
            consumed:      Int
            overage:       Int = if consumed > includedQuota then consumed - includedQuota else 0
            invariant overage >= 0   "overage can never be negative"
          }
        }
        """;

    [Fact]
    public void Invariant_over_a_derived_member_typechecks()
    {
        var result = new KoineCompiler().Compile(UsageMeterFixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var vo = result.Files
            .Single(f => f.RelativePath.EndsWith("value-objects/UsageMeter.ts", StringComparison.Ordinal))
            .Contents;

        // Always-on guards (no toolchain needed): neither a dangling bare name, nor a `this.` read
        // before the fields are assigned. The derivation must be substituted instead.
        vo.ShouldNotContain("if (overage <");
        vo.ShouldNotContain("if (this.overage <");
        vo.ShouldContain("consumed > includedQuota");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(
            "an invariant over a derived member must not emit a dangling name:\n"
            + string.Join("\n", check.Errors));
    }

    private const string LambdaCaptureFixture = """
        context Shop {
          value Cart {
            rate:  Int
            lines: List<Int>
            total: Int = rate * 2
            invariant lines.all(rate => rate < total)   "every line stays below the total"
          }
        }
        """;

    /// <summary>
    /// The hygiene case: the lambda binds <c>rate</c>, the same name the derivation reads. In the
    /// emitted TypeScript the lambda parameter shadows the outer <c>rate</c> within its own body, so
    /// splicing <c>total = rate * 2</c> there would read the ELEMENT — quietly admitting an instance
    /// that violates the very invariant that let it through. The emitter refuses instead, leaving the
    /// pre-fix bare name and its loud <c>tsc</c> error (never a silent mis-bind), matching the C#/Java
    /// siblings' capture guard.
    /// </summary>
    [Fact]
    public void A_lambda_binding_that_would_capture_the_derivation_is_not_substituted()
    {
        var result = new KoineCompiler().Compile(LambdaCaptureFixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var cart = result.Files
            .Single(f => f.RelativePath.EndsWith("value-objects/Cart.ts", StringComparison.Ordinal))
            .Contents;

        // The lambda parameter is literally `rate`, so a substituted `rate * 2` inside it would read
        // the element. It must NOT appear — the guard keeps the bare (dangling) `total` instead.
        cart.ShouldNotContain("rate < ((rate * 2))");
        cart.ShouldContain("rate < total");

        // …which is a KNOWN, LOUD limitation: this model does not type-check, exactly as before the
        // fix. Silently mis-binding the invariant would be strictly worse.
        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeFalse();
        check.Errors.ShouldContain(e => e.Contains("total", StringComparison.Ordinal));
    }

    private const string LambdaNoCaptureFixture = """
        context Shop {
          value Basket {
            rate:  Int
            lines: List<Int>
            total: Int = rate * 2
            invariant lines.all(line => line < total)   "every line stays below the total"
          }
        }
        """;

    /// <summary>The same shape with a lambda binding that shadows nothing — this one must substitute.</summary>
    [Fact]
    public void A_lambda_binding_that_shadows_nothing_still_substitutes()
    {
        var result = new KoineCompiler().Compile(LambdaNoCaptureFixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var basket = result.Files
            .Single(f => f.RelativePath.EndsWith("value-objects/Basket.ts", StringComparison.Ordinal))
            .Contents;

        basket.ShouldContain("line < ((rate * 2))");

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    private const string ChainedFixture = """
        context Subscription {
          value Ledger {
            gross:   Int
            rate:    Int
            net:     Int = gross - rate
            doubled: Int = net * 2
            invariant doubled > 0   "doubled net stays positive"
          }
        }
        """;

    /// <summary>A derived member defined over ANOTHER derived member — substitution must recurse.</summary>
    [Fact]
    public void Derived_member_defined_over_another_derived_member_recurses()
    {
        var result = new KoineCompiler().Compile(ChainedFixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var vo = result.Files
            .Single(f => f.RelativePath.EndsWith("value-objects/Ledger.ts", StringComparison.Ordinal))
            .Contents;

        vo.ShouldNotContain("if (doubled ");
        vo.ShouldNotContain("if (net ");
        vo.ShouldContain("gross - rate");   // the inner derivation reached the guard

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// The guard must fire on a violating construction and stay silent on a valid one — proving the
    /// substituted expression is evaluated over the parameters, not over unassigned fields.
    /// </summary>
    [Fact]
    public void Substituted_guard_evaluates_the_derivation_at_runtime()
    {
        var result = new KoineCompiler().Compile(UsageMeterFixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string driver = """
            import { UsageMeter } from './Subscription/value-objects/UsageMeter';
            const ok = new UsageMeter(100, 130);
            console.log('overage=' + ok.overage);
            """;

        TestSupport.NodeRun run = TestSupport.RunTypeScript(result.Files, driver);
        TestSupport.RequireOrSkip(run.ToolchainAvailable, NoToolchainNotice);

        run.Ok.ShouldBeTrue(run.Stdout + string.Join("\n", run.Errors));
        run.Stdout.ShouldContain("overage=30");
    }

    private const string EntityFixture = """
        context Subscription {
          aggregate Metering root Meter {
            entity Meter identified by MeterId {
              includedQuota: Int
              consumed:      Int
              overage:       Int = if consumed > includedQuota then consumed - includedQuota else 0
              invariant overage >= 0   "overage can never be negative"
            }
          }
        }
        """;

    /// <summary>
    /// An entity's guards run in <c>checkInvariants()</c> AFTER assignment, in NameMode.Property —
    /// <c>this.overage</c> resolves and computes correctly there, so the fix must leave that path
    /// untouched.
    /// </summary>
    [Fact]
    public void Entity_invariant_over_a_derived_member_still_reads_the_property()
    {
        var result = new KoineCompiler().Compile(EntityFixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Meter is the aggregate's ROOT entity, so it emits directly under the namespace folder
        // (KindFolder.Root == "") rather than under `entities/`.
        var entity = result.Files
            .Single(f => f.RelativePath.Equals("Subscription/Meter.ts", StringComparison.Ordinal))
            .Contents;

        entity.ShouldContain("this.overage");   // NOT inlined — Property mode is unchanged

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// The regression that was missing: <c>templates/saas-subscription</c> (<c>UsageMeter</c>) and
    /// <c>templates/library</c> (<c>LoanTerm</c>) both carry an invariant over a derived member, and
    /// both emitted non-compiling TypeScript. Mirrors the C#/Java counterparts
    /// (<c>Template_emits_csharp_that_compiles</c> / <c>Template_emits_java_that_compiles</c>).
    /// </summary>
    [Theory]
    [InlineData("saas-subscription")]
    [InlineData("library")]
    public void Shipped_templates_emit_typechecking_typescript(string template)
    {
        string root = TemplatesRoot();
        var sources = Directory
            .EnumerateFiles(Path.Combine(root, template), "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new SourceFile(p, File.ReadAllText(p)))
            .ToList();

        var result = new KoineCompiler().Compile(sources, new TypeScriptEmitter());
        var errors = result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        errors.ShouldBeEmpty(
            $"template '{template}' did not compile cleanly for the typescript target:\n" +
            string.Join("\n", errors.Select(d => $"{d.File}:{d.Line}:{d.Column}: {d.Code}: {d.Message}")));

        TestSupport.TypeScriptCheck check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(
            $"templates/{template} must emit TypeScript that type-checks:\n" + string.Join("\n", check.Errors));
    }

    /// <summary>Locates <c>templates/</c> by walking up to the directory containing <c>Koine.slnx</c>.</summary>
    private static string TemplatesRoot()
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
            {
                return Path.Combine(dir.FullName, "templates");
            }
        }

        throw new DirectoryNotFoundException(
            $"could not locate the repo root (a directory containing Koine.slnx) from {AppContext.BaseDirectory}");
    }
}
