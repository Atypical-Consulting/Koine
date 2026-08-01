using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Rust sibling of the C# fix in #1756/#1760 (<c>DerivedMemberInvariantTests</c>). A value object's
/// <c>invariant</c> guard runs in <see cref="RustExpressionTranslator.NameMode.Parameter"/>, BEFORE
/// <c>Ok(Self { .. })</c> constructs the instance, so a member reference there renders as the bare
/// constructor parameter of the same name. That is exact for a <b>stored</b> field (it IS a
/// parameter) but wrong for a <b>derived</b> one — a computed accessor with no constructor parameter
/// at all — which used to emit a dangling bare name that binds to nothing (<c>rustc</c> E0425).
/// Fixed by substituting the derived member's defining expression at the reference site (issue
/// #1764). Skipped (not failed) when no Rust toolchain is present; CI installs one and runs for real.
/// </summary>
public class RustDerivedMemberInvariantTests
{
    private const string NoToolchainNotice =
        "No usable Rust toolchain (cargo, networked) available; compile not run. " +
        "Install Rust (or set KOINE_CARGO) — CI runs this for real.";

    // The issue's own minimal repro.
    private const string UsageMeterModel = """
        context Subscription {
          value UsageMeter {
            includedQuota: Int
            consumed:      Int
            overage:       Int = if consumed > includedQuota then consumed - includedQuota else 0
            invariant overage >= 0 "overage can never be negative"
          }
        }
        """;

    /// <summary>
    /// Task 1 — Red: an invariant over a derived member must emit Rust that actually compiles. Before
    /// the fix this failed with <c>error[E0425]: cannot find value `overage` in this scope</c>.
    /// </summary>
    [Fact]
    public void Invariant_over_derived_member_emits_compiling_rust()
    {
        var result = new KoineCompiler().Compile(UsageMeterModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    // The same shape as the repro, but on an entity: its smart constructor's invariant guards go
    // through the same NameMode.Parameter WriteIdentifier path (RustEmitter.Entities.cs), so the fix
    // must cover it too even though no shipped template hits it today.
    private const string EntityModel = """
        context Metering {
          entity Meter identified by MeterId {
            includedQuota: Int
            consumed:      Int
            overage:       Int = if consumed > includedQuota then consumed - includedQuota else 0
            invariant overage >= 0 "overage can never be negative"
          }
        }
        """;

    /// <summary>Task 3, Step 1 — the entity smart-constructor invariant path shares
    /// <see cref="RustExpressionTranslator.WriteIdentifier"/> with the value-object one, so it must
    /// already compile with no further emitter change.</summary>
    [Fact]
    public void Entity_invariant_over_derived_member_emits_compiling_rust()
    {
        var result = new KoineCompiler().Compile(EntityModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    // A derived member defined over ANOTHER derived member (`doubled` over `net` over the stored
    // fields), referenced by the invariant — proves the substitution recurses.
    private const string ChainedModel = """
        context Billing {
          value Chained {
            gross:   Int
            rate:    Int
            net:     Int = gross - rate
            doubled: Int = net * 2
            invariant doubled > 0 "doubled must be positive"
          }
        }
        """;

    /// <summary>Task 3, Step 2 — a derived member referencing another derived member must expand
    /// all the way down to the constructor parameters.</summary>
    [Fact]
    public void Invariant_over_chained_derived_member_emits_compiling_rust()
    {
        var result = new KoineCompiler().Compile(ChainedModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        // `doubled`'s own definition (`net * 2`) must itself expand `net` (`gross - rate`) rather
        // than leaving a dangling `net` in the guard.
        rust.ShouldNotContain("!(net *");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    // A non-Copy (String) derived member referenced by an invariant — the Rust-only ownership/borrow
    // risk the C# sibling fix has no analogue for: substituting `raw.trim` into the guard must not
    // move the `raw` constructor parameter that `Ok(Self { raw })` still needs afterward.
    private const string NonCopyModel = """
        context Catalog {
          value Article {
            raw:  String
            slug: String = raw.trim
            invariant slug.length > 0 "slug cannot be blank"
          }
        }
        """;

    /// <summary>Task 3, Step 3 — a String-typed derived member must substitute without moving the
    /// stored parameter its own body reads (would otherwise fail `cargo check` with E0382/E0507).</summary>
    [Fact]
    public void Invariant_over_non_copy_derived_member_emits_compiling_rust()
    {
        var result = new KoineCompiler().Compile(NonCopyModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    // The HYGIENE case (mirrors the C# sibling's LambdaCaptureFixture, DerivedMemberInvariantTests.cs):
    // the lambda binds `rate`, the same name `total`'s derivation reads. A lambda parameter and a
    // constructor parameter share one Rust identifier space, so splicing `rate * 2` here would read the
    // ELEMENT — quietly admitting an instance that violates the invariant that let it through. `.amount`
    // (not a bare `Int`) sidesteps the unrelated, pre-existing `List<Int>` comparison-vs-scalar E0308 gap
    // (issue #1775) that a raw-scalar-list fixture would otherwise trip here.
    private const string LambdaCaptureModel = """
        context Shop {
          value LineItem {
            amount: Decimal
          }
          value Cart {
            rate:  Decimal
            lines: List<LineItem>
            total: Decimal = rate * 2
            invariant lines.all(rate => rate.amount < total) "every line stays below the total"
          }
        }
        """;

    /// <summary>The same shape with a lambda binding that shadows nothing — this one must substitute.</summary>
    private const string LambdaNoCaptureModel = """
        context Shop {
          value LineItem {
            amount: Decimal
          }
          value Basket {
            rate:  Decimal
            lines: List<LineItem>
            total: Decimal = rate * 2
            invariant lines.all(line => line.amount < total) "every line stays below the total"
          }
        }
        """;

    /// <summary>
    /// The capture/shadow guard (<c>WouldBeCaptured</c>) is the OTHER safety mechanism this fix
    /// introduces alongside the cycle guard, and is otherwise untested: a lambda parameter that shares
    /// a name with a free identifier the derivation reads must NOT get substituted — that would
    /// silently read the lambda's element instead of the outer constructor parameter, admitting an
    /// instance that violates the very invariant meant to reject it. The emitter must refuse instead,
    /// leaving the pre-fix dangling name (and its loud, pre-existing E0425) rather than trade a compile
    /// error for a silently unsound guard.
    /// </summary>
    [Fact]
    public void A_lambda_binding_that_would_capture_the_derivation_is_not_substituted()
    {
        var result = new KoineCompiler().Compile(LambdaCaptureModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var shop = result.Files.Single(f => f.RelativePath.EndsWith("shop.rs", StringComparison.Ordinal));

        // The emitted lambda parameter is literally `rate`, so a substituted `rate * 2` inside it would
        // read the element. It must NOT appear — the guard keeps the bare (dangling) `total` instead.
        shop.Contents.ShouldNotContain("rate.amount() < ((rate * Decimal::from(2i64)))");
        shop.Contents.ShouldContain("rate.amount() < total");

        // …which is a KNOWN, LOUD limitation: this model does not compile, exactly as before #1764.
        // Silently mis-binding the invariant would be strictly worse. Hygienic renaming is tracked
        // separately (C# sibling: #1768); the guarantee asserted here is "never silently wrong".
        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeFalse();
        r.Errors.ShouldContain(e => e.Contains("E0425", StringComparison.Ordinal) && e.Contains("total", StringComparison.Ordinal));
    }

    /// <summary>The mirror case: a lambda binding that shadows nothing the derivation reads must still
    /// substitute and compile — the capture guard must not be so conservative it refuses safe cases.</summary>
    [Fact]
    public void A_lambda_binding_that_shadows_nothing_still_substitutes()
    {
        var result = new KoineCompiler().Compile(LambdaNoCaptureModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    // The repro's own invariant (`overage >= 0`) is a TAUTOLOGY given the clamping `if/then/else` —
    // `overage` can mathematically never be negative for any `Int` input, so it can never actually be
    // rejected at runtime. The behavioral proof needs a derived-member invariant that a real input CAN
    // violate; this keeps the same conditional-derivation shape (still proving the guard evaluates the
    // `if/then/else`, not just type-checks it) with a cap the derivation can genuinely exceed.
    private const string UsageMeterBehavioralModel = """
        context Subscription {
          value UsageMeter {
            includedQuota: Int
            consumed:      Int
            overage:       Int = if consumed > includedQuota then consumed - includedQuota else 0
            invariant overage <= 100 "overage cannot exceed the metering cap"
          }
        }
        """;

    /// <summary>
    /// Task 3, Step 4 — behavioral proof, not just type-checking: the substituted guard must actually
    /// EVALUATE the derivation and reject a violating input, not merely compile. Constructs a valid
    /// <c>UsageMeter</c> within its cap and one that overshoots it, asserting the latter is rejected
    /// with the declared invariant's <c>DomainError::InvariantViolation</c>.
    /// </summary>
    [Fact]
    public void Invariant_over_derived_member_actually_rejects_a_violating_input()
    {
        var result = new KoineCompiler().Compile(UsageMeterBehavioralModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string integrationTest =
            """
            use koine_domain::subscription::{DomainError, UsageMeter};

            #[test]
            fn within_cap_is_ok() {
                let meter = UsageMeter::new(1000, 1050).expect("valid UsageMeter");
                assert_eq!(meter.overage(), 50);
            }

            #[test]
            fn beyond_cap_is_rejected() {
                match UsageMeter::new(10, 1000) {
                    Err(DomainError::InvariantViolation { rule, .. }) => {
                        assert_eq!(rule, "overage cannot exceed the metering cap");
                    }
                    other => panic!("expected an InvariantViolation, got {other:?}"),
                }
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Task 4 — the regression fence for the issue's own impact statement: both shipped templates that
    /// carry an invariant over a derived member (<c>saas-subscription</c>'s <c>UsageMeter.overage</c>,
    /// <c>library</c>'s <c>LoanTerm.fineCents</c>) must emit compiling Rust, not just the hand-authored
    /// fixtures above. Before the fix both failed <c>cargo check</c> with E0425.
    /// </summary>
    [Theory]
    [InlineData("saas-subscription")]
    [InlineData("library")]
    public void Template_with_derived_member_invariant_emits_compiling_rust(string folder)
    {
        if (FindTemplateDir(folder) is not { } sources)
        {
            Assert.Skip($"Template '{folder}' not found from the test assembly; compile not run.");
            return;
        }

        var result = new KoineCompiler().Compile(sources, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>Loads every <c>.koi</c> file under a <c>templates/&lt;folder&gt;</c> directory as one model's
    /// sources — mirrors <c>RustSnapshotTests.FindTemplateDir</c>.</summary>
    private static IReadOnlyList<SourceFile>? FindTemplateDir(string folder)
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (!Directory.Exists(Path.Combine(dir.FullName, ".git")) && !File.Exists(Path.Combine(dir.FullName, ".git")))
            {
                continue;
            }

            var templateDir = Path.Combine(dir.FullName, "templates", folder);
            return Directory.Exists(templateDir)
                ? Directory
                    .EnumerateFiles(templateDir, "*.koi", SearchOption.AllDirectories)
                    .OrderBy(p => p, StringComparer.Ordinal)
                    .Select(p => new SourceFile(p, File.ReadAllText(p)))
                    .ToList()
                : null;
        }

        return null;
    }
}
