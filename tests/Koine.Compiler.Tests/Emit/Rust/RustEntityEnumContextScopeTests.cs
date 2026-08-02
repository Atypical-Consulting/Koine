using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// <para>Issue #1870, Task 3 — the Rust entity emitter's three flat <c>ModelIndex.Classify(string)</c>
/// lookups: <c>BuildFactoryCtorArgs</c>'s required loop, its defaulted-parameter loop, and
/// <c>TransitionEnum</c>. Each answers "is this member's declared type an enum?" so it can hand
/// <c>RustExpressionTranslator</c> the expected-enum HINT that disambiguates a bare variant reference
/// shared by two enums. Asked flatly, the answer is decided by whichever context declared a type of
/// that simple name LAST in source order (R13.2 lets two contexts declare the same simple name), so an
/// unrelated <c>value Kind</c> in a sibling context silently suppresses the hint and the reference
/// binds to the wrong enum — on this target not merely a wrong qualifier but a hard <c>rustc</c>
/// E0308, since the emitted path names a variant of the wrong enum type.</para>
/// <para><b>Every fixture is asserted under BOTH context declaration orders</b> and must produce the
/// same, correct Rust either way: a one-order assertion proves luck, not context-awareness. Before the
/// fix the <c>Alpha</c>-first order failed and the <c>Zeta</c>-first order passed — that asymmetry IS
/// the bug.</para>
/// <para>The two enums are ordered <c>Tier</c> before <c>Kind</c> on purpose: without the hint the
/// translator falls back to <c>RustEmitter.BuildEnumMemberMap</c>'s FIRST-declaring-enum-wins map, so
/// the hint-less answer is <c>Tier</c> — a visibly wrong enum rather than an accidentally right
/// one.</para>
/// </summary>
public class RustEntityEnumContextScopeTests
{
    /// <summary>The sibling context whose same-named <c>value Kind</c> hijacks the flat lookup.</summary>
    private const string ZetaContext = """
        context Zeta {
          value Kind {
            label: String
          }
        }
        """;

    /// <summary>
    /// A factory that explicitly initializes a REQUIRED enum-typed member from a bare variant name that
    /// two of the context's own enums declare — <c>BuildFactoryCtorArgs</c>'s required loop.
    /// </summary>
    private const string RequiredCtorArgContext = """
        context Alpha {
          enum Tier { Basic, Elite }
          enum Kind { Basic, Premium }

          entity Widget identified by WidgetId {
            kind: Kind
            tier: Tier

            create make() {
              kind -> Basic
              tier -> Elite
            }
          }
        }
        """;

    /// <summary>
    /// The same shape with the enum-typed member carrying a DEFAULT, so it becomes a trailing
    /// <c>Option&lt;Kind&gt;</c> constructor parameter and the factory's explicit initialization runs
    /// through <c>BuildFactoryCtorArgs</c>'s defaulted-parameter loop instead.
    /// </summary>
    private const string DefaultedCtorArgContext = """
        context Alpha {
          enum Tier { Basic, Elite }
          enum Kind { Basic, Premium }

          entity Widget identified by WidgetId {
            tier: Tier
            kind: Kind = Premium

            create make() {
              tier -> Elite
              kind -> Basic
            }
          }
        }
        """;

    /// <summary>
    /// A command transition assigning the same ambiguous bare variant — <c>TransitionEnum</c>. The
    /// factory here uses the UNambiguous <c>Premium</c> so only the transition site is under test.
    /// </summary>
    private const string TransitionContext = """
        context Alpha {
          enum Tier { Basic, Elite }
          enum Kind { Basic, Premium }

          entity Widget identified by WidgetId {
            kind: Kind
            tier: Tier

            command downgrade() {
              kind -> Basic
            }

            create make() {
              kind -> Premium
              tier -> Elite
            }
          }
        }
        """;

    /// <summary>Both legal source orders of the two bounded contexts.</summary>
    public static TheoryData<bool> DeclarationOrders => new(true, false);

    private static (string Alpha, IReadOnlyList<EmittedFile> Files) Emit(string alphaContext, bool alphaFirst)
    {
        var source = alphaFirst
            ? alphaContext + "\n\n" + ZetaContext
            : ZetaContext + "\n\n" + alphaContext;

        var result = new KoineCompiler().Compile(source, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var alpha = result.Files.Single(f => f.RelativePath.EndsWith("alpha.rs", StringComparison.Ordinal)).Contents;
        return (alpha, result.Files!);
    }

    /// <summary>
    /// The wrong enum's variant is not a cosmetic qualifier slip on this target — <c>Tier::Basic</c> in a
    /// <c>Kind</c>-typed position is <c>rustc</c> E0308 — so each fixture is also handed to a real
    /// <c>cargo check</c>, which SKIPs (never silently passes) when no toolchain is present.
    /// </summary>
    private static void CargoCheck(IReadOnlyList<EmittedFile> files)
    {
        var check = TestSupport.CompileRust(files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable cargo toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Theory]
    [MemberData(nameof(DeclarationOrders))]
    public void Factory_required_ctor_arg_resolves_its_bare_enum_variant_in_the_entitys_own_context(bool alphaFirst)
    {
        (var alpha, IReadOnlyList<EmittedFile> files) = Emit(RequiredCtorArgContext, alphaFirst);

        alpha.ShouldContain("Self::new(id, Kind::Basic, Tier::Elite)");
        alpha.ShouldNotContain("Self::new(id, Tier::Basic");

        CargoCheck(files);
    }

    [Theory]
    [MemberData(nameof(DeclarationOrders))]
    public void Factory_defaulted_ctor_arg_resolves_its_bare_enum_variant_in_the_entitys_own_context(bool alphaFirst)
    {
        (var alpha, IReadOnlyList<EmittedFile> files) = Emit(DefaultedCtorArgContext, alphaFirst);

        alpha.ShouldContain("Self::new(id, Tier::Elite, Some(Kind::Basic))");
        // Scoped to the ctor call: `Some(Tier::Basic)` also, legitimately, appears inside `Tier`'s own
        // smart-enum `from_*` API.
        alpha.ShouldNotContain("Self::new(id, Tier::Elite, Some(Tier::Basic))");

        CargoCheck(files);
    }

    [Theory]
    [MemberData(nameof(DeclarationOrders))]
    public void Command_transition_resolves_its_bare_enum_variant_in_the_entitys_own_context(bool alphaFirst)
    {
        (var alpha, IReadOnlyList<EmittedFile> files) = Emit(TransitionContext, alphaFirst);

        alpha.ShouldContain("self.kind = Kind::Basic;");
        alpha.ShouldNotContain("self.kind = Tier::Basic;");

        CargoCheck(files);
    }
}
