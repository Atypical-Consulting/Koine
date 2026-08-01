using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1771: the Java emitter resolves a bare enum-member reference (e.g. <c>Active</c> in
/// <c>status == Active</c>) by looking up every enum in the whole model that declares a member of that
/// name (<see cref="Ast.ModelIndex.EnumsDeclaring(string)"/>) and, when more than one does, falls back to
/// whichever one <see cref="Ast.ModelIndex.EnumMemberToType"/> happened to record first — ignoring the
/// concrete type of the operand it is being compared against. R13.2 lets two bounded contexts each
/// legally declare an enum sharing a member name, so a comparison like <c>status == Active</c> can
/// silently qualify <c>Active</c> against the <b>wrong</b> enum, one declared in a different
/// context/package — <c>javac</c> then rejects the reference with <c>cannot find symbol</c>. This is a
/// SILENT-wrong-code bug, not a compile error the emitter itself notices: <see cref="KoineCompiler"/>
/// reports <c>Success</c>, and a snapshot alone would happily capture the wrong-but-plausible-looking
/// text — the decisive assertion is which enum the emitted qualifier actually names, backed by a real
/// <c>javac --release 17</c> compile via <see cref="TestSupport.CompileJava"/> (skipped, not failed,
/// without a JDK 17+ toolchain — CI runs this for real).
/// <para>
/// The C# emitter already gets this right on the identical model shape
/// (<c>CSharpExpressionTranslator</c> threads a sibling-operand <c>enumHint</c> — inferred from the
/// OTHER side of the comparison — into <c>WriteIdentifier</c>); this issue ports that mechanism into
/// <c>JavaExpressionTranslator</c>. Discovered while implementing #1763 — that fix alone still left
/// <c>templates/saas-subscription</c> and <c>templates/library</c> emitting non-compiling Java, for this
/// separate reason.
/// </para>
/// <para>
/// The <c>enumHint</c> mechanism this suite pins only reaches bare members that sit on one side of a
/// binary <c>==</c>/<c>!=</c> whose OTHER operand types to an enum. When nothing hints — no comparison
/// context at all — resolution still fell through to the same context-blind owners list, which #1739
/// (for C#/TypeScript/PHP/Kotlin) and #1793 (Java/Python/Rust) scoped to the referencing context. That
/// complementary fallback fix is covered by
/// <see cref="EnumMemberContextScopeEmitterTests.Java_qualifies_both_operands_against_the_referencing_contexts_own_enum"/>;
/// the tests below stay the guard that the hint keeps PRIORITY over it whenever the hint resolves.
/// </para>
/// </summary>
public class JavaEnumMemberDisambiguationTests
{
    private const string NoToolchainNotice =
        "No usable JDK 17+ toolchain (javac >= 17) available; javac not run. " +
        "Install a JDK 17+ (or set KOINE_JAVAC to a javac >= 17) — CI runs this for real.";

    /// <summary>
    /// The issue's own minimal reproduction: two contexts, each with an enum sharing a member name. The
    /// AMBIGUOUS sibling (<c>Subscription</c>) is declared FIRST — <c>ModelIndex</c>'s owner-list order
    /// (and therefore the pre-fix <c>owners[0]</c> fallback) tracks registration order, which in
    /// directory-compile mode is the alphabetical file order (<c>subscription.koi</c> sorts before
    /// <c>tenant.koi</c>). Declaring <c>Tenant</c> first here would coincidentally "pass" even on the
    /// unfixed emitter — masking the exact bug both shipped templates hit.
    /// </summary>
    private const string MinimalFixture = """
        context Subscription {
          enum SubscriptionStatus { Trialing, Active, Cancelled }
        }

        context Tenant {
          enum TenantStatus { Onboarding, Active, Locked }

          entity Account identified by AccountId {
            status:   TenantStatus = Onboarding
            isActive: Bool = status == Active
          }
        }
        """;

    /// <summary>
    /// The exact shape shipped by <c>templates/saas-subscription</c>: <c>Tenant.isActive</c> compares its
    /// own <c>TenantStatus</c>-typed <c>status</c> against a member name also declared by the sibling
    /// <c>Subscription</c> context's <c>SubscriptionStatus</c>. Declared in the same file order the real
    /// template ships (<c>subscription.koi</c> before <c>tenant.koi</c>, alphabetically) so this fixture
    /// reproduces the exact failure directory-mode hits, not an order-masked near miss.
    /// </summary>
    private const string SaasSubscriptionShapeFixture = """
        context Subscription {
          enum SubscriptionStatus { Trialing, Active, Suspended, Cancelled }
        }

        context Tenant {
          enum TenantStatus { Onboarding, Active, Locked, Closed }

          entity Account identified by AccountId {
            status:    TenantStatus = Onboarding
            isActive:  Bool = status == Active
            isLocked:  Bool = status == Locked
          }
        }
        """;

    /// <summary>
    /// The exact shape shipped by <c>templates/library</c>'s <c>Members</c> context:
    /// <c>Member.isActive</c> compares its own <c>MembershipStatus</c>-typed <c>status</c> against a
    /// member name also declared by the sibling <c>Loans</c> context's <c>LoanStatus</c>. Declared
    /// <c>Loans</c>-before-<c>Members</c> (alphabetical file order, as the real template ships) so the
    /// pre-fix owner fallback actually mis-resolves, matching the shipped regression.
    /// </summary>
    private const string LibraryMemberShapeFixture = """
        context Loans {
          enum LoanStatus { Active, Returned, Overdue, Lost }
        }

        context Members {
          enum MembershipStatus { Active, Suspended, Closed }

          entity Member identified by MemberId {
            status:   MembershipStatus = Active
            isActive: Bool = status == Active
          }
        }
        """;

    /// <summary>
    /// The exact shape shipped by <c>templates/library</c>'s <c>Loans</c> context: a <c>Loan</c>'s guard
    /// compares its own <c>LoanStatus</c>-typed <c>status</c> against a member name also declared by the
    /// sibling <c>Inventory</c> context's <c>CopyStatus</c>. Declared <c>Inventory</c>-before-<c>Loans</c>
    /// (alphabetical file order, as the real template ships) so the pre-fix owner fallback actually
    /// mis-resolves, matching the shipped regression.
    /// </summary>
    private const string LibraryLoanShapeFixture = """
        context Inventory {
          enum CopyStatus { Available, OnLoan, Lost, Withdrawn }
        }

        context Loans {
          enum LoanStatus { Active, Returned, Overdue, Lost }

          entity Loan identified by LoanId {
            status: LoanStatus = Active
            isLost: Bool = status == Lost
          }
        }
        """;

    [Fact]
    public void A_shared_enum_member_qualifies_against_the_comparison_operands_own_enum()
    {
        var result = new KoineCompiler().Compile(MinimalFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var account = result.Files.Single(f => f.RelativePath.EndsWith("Account.java", StringComparison.Ordinal)).Contents;
        account.ShouldContain("TenantStatus.Active");
        account.ShouldNotContain("SubscriptionStatus.Active");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    [Fact]
    public void Saas_subscription_tenant_isActive_qualifies_against_TenantStatus()
    {
        var result = new KoineCompiler().Compile(SaasSubscriptionShapeFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var account = result.Files.Single(f => f.RelativePath.EndsWith("Account.java", StringComparison.Ordinal)).Contents;
        account.ShouldContain("TenantStatus.Active");
        account.ShouldContain("TenantStatus.Locked");
        account.ShouldNotContain("SubscriptionStatus.Active");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    [Fact]
    public void Library_member_isActive_qualifies_against_MembershipStatus()
    {
        var result = new KoineCompiler().Compile(LibraryMemberShapeFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var member = result.Files.Single(f => f.RelativePath.EndsWith("Member.java", StringComparison.Ordinal)).Contents;
        member.ShouldContain("MembershipStatus.Active");
        member.ShouldNotContain("LoanStatus.Active");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    [Fact]
    public void Library_loan_isLost_qualifies_against_LoanStatus()
    {
        var result = new KoineCompiler().Compile(LibraryLoanShapeFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var loan = result.Files.Single(f => f.RelativePath.EndsWith("Loan.java", StringComparison.Ordinal)).Contents;
        loan.ShouldContain("LoanStatus.Lost");
        loan.ShouldNotContain("CopyStatus.Lost");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }
}
