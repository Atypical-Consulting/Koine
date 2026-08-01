using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1763 (the Java counterpart of #1756/PR #1760): a value object whose <c>invariant</c>
/// references a <b>derived</b> member emitted the member's bare camelCase name in the record's compact
/// constructor. A derived member has no constructor parameter — it is a get-only accessor computed from
/// the stored components — so the guard bound to nothing (<c>cannot find symbol</c>) and the shipped
/// <c>templates/saas-subscription</c> and <c>templates/library</c> emitted Java that did not compile.
/// <para>
/// These assert against a real <c>javac --release 17</c> compile via <see cref="TestSupport.CompileJava"/>
/// (skipped, not failed, without a JDK 17+ toolchain — CI runs this for real): the snapshot suites
/// happily captured the broken text for months without noticing, so the decisive assertion is that the
/// emitted Java compiles — the fix substitutes the derived member's defining expression over the compact
/// constructor's parameters, recursively, keeping the emitter's deliberate validate-before-assign
/// ordering.
/// </para>
/// </summary>
public class JavaDerivedMemberInvariantTests
{
    private const string NoToolchainNotice =
        "No usable JDK 17+ toolchain (javac >= 17) available; javac not run. " +
        "Install a JDK 17+ (or set KOINE_JAVAC to a javac >= 17) — CI runs this for real.";

    /// <summary>The issue's minimal reproduction: an invariant over a single derived member.</summary>
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

    /// <summary>A derived member defined over another derived member — substitution must recurse.</summary>
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

    /// <summary>
    /// A <b>diamond</b>: one invariant reaches <c>net</c> twice along two different paths. The visited
    /// set must scope re-entry to the path currently being expanded, not ban a member for the rest of
    /// the guard — otherwise the second path degrades to the old dangling name.
    /// </summary>
    private const string DiamondFixture = """
        context Subscription {
          value Split {
            gross:     Int
            rate:      Int
            net:       Int = gross - rate
            doubled:   Int = net * 2
            total:     Int = net + doubled
            overQuota: Bool = net > rate
            invariant total > 0   "the split total stays positive"
            invariant overQuota   "the net must exceed the rate"
          }
        }
        """;

    /// <summary>
    /// The <b>hygiene</b> case: the lambda binds <c>rate</c>, the same name the derivation reads. A
    /// lambda parameter and a compact-constructor parameter share one Java identifier space, so
    /// splicing <c>total = rate * 2</c> here would read the ELEMENT — quietly admitting an instance that
    /// violates the invariant that let it through. The emitter refuses instead, leaving the pre-#1763
    /// bare name (a loud <c>cannot find symbol</c>, never a silent mis-bind).
    /// </summary>
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

    /// <summary>The same shape with a lambda binding that shadows nothing — this one must substitute.</summary>
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

    /// <summary>
    /// A precedence case: the substituted derivation must stay fully parenthesized, so multiplying it
    /// does not silently rebind to only part of the expression (<c>overage * 2</c> must not become
    /// <c>consumed - includedQuota * 2</c>).
    /// </summary>
    private const string PrecedenceFixture = """
        context Subscription {
          value ScaledMeter {
            includedQuota: Int
            consumed:      Int
            overage:       Int = consumed - includedQuota
            invariant overage * 2 >= 0   "scaled overage can never be negative"
          }
        }
        """;

    /// <summary>
    /// An enum-typed derived member whose branches name members SHARED with another enum, so the
    /// substituted body needs the same expected-enum hint the derived accessor's own body gets —
    /// otherwise the two arms qualify to different enums and the emitted ternary does not compile.
    /// </summary>
    private const string SharedEnumMemberFixture = """
        context Shop {
          enum Grade { Low
                       High }
          enum Rank  { Low
                       Top }
          value Card {
            score: Int
            grade: Grade = if score > 10 then High else Low
            invariant grade == High   "a card must be high grade"
          }
        }
        """;

    /// <summary>An entity carrying the same shape — its guards run after assignment, over accessors.</summary>
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

    [Fact]
    public void Value_object_invariant_over_a_derived_member_compiles()
    {
        var result = new KoineCompiler().Compile(UsageMeterFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The guard evaluates the derivation over the compact constructor's own parameters, exactly what
        // the accessor will later compute — asserted directly, independent of whether a JDK is present.
        var meter = result.Files.Single(f => f.RelativePath.EndsWith("UsageMeter.java", StringComparison.Ordinal)).Contents;
        meter.ShouldContain("if (!(((consumed > includedQuota ? (consumed - includedQuota) : 0L)) >= 0L)) {");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    [Fact]
    public void Chained_derived_members_substitute_recursively()
    {
        var result = new KoineCompiler().Compile(ChainedFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var ledger = result.Files.Single(f => f.RelativePath.EndsWith("Ledger.java", StringComparison.Ordinal)).Contents;
        ledger.ShouldContain("gross - rate");
        ledger.ShouldContain("* 2L");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    [Fact]
    public void A_derived_member_reached_twice_in_one_guard_substitutes_on_both_paths()
    {
        var result = new KoineCompiler().Compile(DiamondFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    [Fact]
    public void A_lambda_binding_that_would_capture_the_derivation_is_not_substituted()
    {
        var result = new KoineCompiler().Compile(LambdaCaptureFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var cart = result.Files.Single(f => f.RelativePath.EndsWith("Cart.java", StringComparison.Ordinal)).Contents;

        // The emitted lambda parameter alpha-renames to `rate$1` (#1536), so a substituted `rate * 2`
        // inside it would silently read the ELEMENT under its ORIGINAL name. It must not appear —
        // the guard keeps the bare (dangling) `total` instead.
        cart.ShouldNotContain("rate$1 < ((rate$1 * 2L))");
        cart.ShouldContain("rate$1 < total");

        // …which is a KNOWN, LOUD limitation: this model does not compile, exactly as before #1763.
        // Silently mis-binding the invariant would be strictly worse.
        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeFalse();
        r.Errors.ShouldContain(e => e.Contains("total", StringComparison.Ordinal));
    }

    [Fact]
    public void A_lambda_binding_that_shadows_nothing_still_substitutes()
    {
        var result = new KoineCompiler().Compile(LambdaNoCaptureFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var basket = result.Files.Single(f => f.RelativePath.EndsWith("Basket.java", StringComparison.Ordinal)).Contents;
        basket.ShouldContain("line < ((rate * 2L))");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    [Fact]
    public void Precedence_is_preserved_when_a_derived_member_is_scaled()
    {
        var result = new KoineCompiler().Compile(PrecedenceFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var meter = result.Files.Single(f => f.RelativePath.EndsWith("ScaledMeter.java", StringComparison.Ordinal)).Contents;

        // The substituted derivation stays fully parenthesized, so `* 2L` scales the WHOLE difference —
        // never just `includedQuota`.
        meter.ShouldContain("((consumed - includedQuota)) * 2L");
        meter.ShouldNotContain("consumed - includedQuota * 2L");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    [Fact]
    public void An_enum_typed_derived_member_keeps_its_expected_enum_when_substituted()
    {
        var result = new KoineCompiler().Compile(SharedEnumMemberFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var card = result.Files.Single(f => f.RelativePath.EndsWith("Card.java", StringComparison.Ordinal)).Contents;

        // Both ternary arms must qualify to the SAME enum (Grade, not a mix of Grade/Rank) or javac
        // rejects the conditional as having no common type.
        card.ShouldContain("Grade.HIGH");
        card.ShouldContain("Grade.LOW");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    [Fact]
    public void Entity_invariant_over_a_derived_member_compiles()
    {
        var result = new KoineCompiler().Compile(EntityFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Entity guards run in Property mode, after assignment — unchanged by this fix (Non-goal).
        var meter = result.Files.Single(f => f.RelativePath.EndsWith("Meter.java", StringComparison.Ordinal)).Contents;
        meter.ShouldContain("this.overage()");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }
}
