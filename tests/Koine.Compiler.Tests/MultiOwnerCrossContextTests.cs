using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Cross-emitter regression for issue #1091: a type declared in <b>more than one</b> bounded context
/// and referenced from a <b>third</b> context must qualify to a resolvable owning module — not degrade
/// to a bare, unresolvable name. Before the shared owner-resolution fix, both the Rust and Java flat-
/// module backends emitted a bare <c>Money</c> (uncompilable) because their type mappers returned a
/// single owner only when a type was declared in exactly one context.
///
/// <para>Fixture: <c>Money</c> is declared in both <c>Alpha</c> and <c>Beta</c>; <c>Gamma</c> imports it
/// from <c>Alpha</c> and references it from a value object. The reference must resolve to
/// <c>Alpha</c>'s module (Rust <c>crate::alpha::Money</c> / Java <c>koine.generated.alpha.Money</c>),
/// while the owning modules still declare it bare.</para>
/// </summary>
public class MultiOwnerCrossContextTests
{
    /// <summary>Three contexts: <c>Money</c> owned by both Alpha and Beta, referenced from Gamma (imported from Alpha).</summary>
    private const string MultiOwnerFixture = """
        context Alpha {
          value Money {
            amount: Int
          }
        }

        context Beta {
          value Money {
            amount: Int
          }
        }

        context Gamma {
          import Alpha.{ Money }

          value Wallet {
            balance: Money
          }
        }
        """;

    [Fact]
    public void Rust_qualifies_a_multi_owner_cross_context_reference()
    {
        var result = new KoineCompiler().Compile(MultiOwnerFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var gamma = result.Files.Single(f => f.RelativePath.EndsWith("gamma.rs", StringComparison.Ordinal)).Contents;

        // The multi-owner reference must qualify to Alpha's module, NOT degrade to a bare `Money`
        // (which would be unresolvable in Gamma's flat crate module).
        gamma.ShouldContain("balance: crate::alpha::Money");
        gamma.ShouldNotContain("balance: Money,");

        // The owning module still declares the type bare (it never self-qualifies).
        var alpha = result.Files.Single(f => f.RelativePath.EndsWith("alpha.rs", StringComparison.Ordinal)).Contents;
        alpha.ShouldContain("pub struct Money");
    }

    [Fact]
    public void Java_qualifies_a_multi_owner_cross_context_reference()
    {
        var result = new KoineCompiler().Compile(MultiOwnerFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var wallet = result.Files.Single(f => f.RelativePath.EndsWith("gamma/Wallet.java", StringComparison.Ordinal)).Contents;

        // The multi-owner reference must be package-qualified to Alpha's package, NOT a bare `Money`
        // (which Gamma's own package does not declare, so the source would not compile).
        wallet.ShouldContain("koine.generated.alpha.Money");
        wallet.ShouldNotContain("(Money balance)");

        // The owning package still declares the type bare.
        var money = result.Files.Single(f => f.RelativePath.EndsWith("alpha/Money.java", StringComparison.Ordinal)).Contents;
        money.ShouldContain("record Money");
    }
}
