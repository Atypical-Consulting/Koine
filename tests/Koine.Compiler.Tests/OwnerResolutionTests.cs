using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="ModelIndex.ResolveCanonicalOwner"/> — the shared, target-agnostic owner
/// resolution policy the Rust and Java flat-module mappers delegate to (issue #1091). It answers "given
/// a possibly multi-owner type and a referencing context, which owning context's module qualifies it?"
/// deterministically, so both backends (and any future flat-module emitter) resolve a multi-owner
/// cross-context reference the same, resolvable way instead of degrading to a bare name.
/// </summary>
public class OwnerResolutionTests
{
    private static ModelIndex IndexOf(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return new SemanticModel(result.Model!).Index;
    }

    // `Beta` is declared BEFORE `Alpha` so the test proves the canonical owner is picked by a STABLE
    // ordinal sort, not by declaration/iteration order.
    private const string MultiOwnerNoImport = """
        context Beta {
          value Money { amount: Int }
        }
        context Alpha {
          value Money { amount: Int }
        }
        context Gamma {
          value Wallet { balance: Int }
        }
        """;

    [Fact]
    public void Multi_owner_type_resolves_to_a_stable_canonical_owner_from_a_third_context()
    {
        var index = IndexOf(MultiOwnerNoImport);
        // Money is declared in both Alpha and Beta; from a third context (Gamma) with no import, it
        // resolves to the ordinal-least declaring context (Alpha), independent of declaration order.
        index.ResolveCanonicalOwner("Money", "Gamma").ShouldBe("Alpha");
    }

    private const string MultiOwnerImportFromLarger = """
        context Alpha {
          value Money { amount: Int }
        }
        context Beta {
          value Money { amount: Int }
        }
        context Gamma {
          import Beta.{ Money }
          value Wallet { balance: Money }
        }
        """;

    [Fact]
    public void Multi_owner_reference_prefers_the_single_imported_owner_over_the_ordinal_default()
    {
        var index = IndexOf(MultiOwnerImportFromLarger);
        // Gamma explicitly imports Money from Beta, so the reference IS Beta.Money and must qualify to
        // Beta — even though Alpha is the ordinal-least owner. Picking the ordinal default here would
        // qualify to the WRONG (distinct) type.
        index.ResolveCanonicalOwner("Money", "Gamma").ShouldBe("Beta");
    }

    [Fact]
    public void Multi_owner_reference_from_within_an_owning_context_binds_locally()
    {
        var index = IndexOf(MultiOwnerNoImport);
        // #437: a reference from within one of the type's OWN owning contexts binds to the local
        // sibling, so the resolver returns that same context (the mapper then emits a bare name).
        index.ResolveCanonicalOwner("Money", "Alpha").ShouldBe("Alpha");
        index.ResolveCanonicalOwner("Money", "Beta").ShouldBe("Beta");
    }

    private const string UniqueOwner = """
        context Alpha {
          value Widget { size: Int }
        }
        context Gamma {
          value Wallet { balance: Int }
        }
        """;

    [Fact]
    public void Unique_owner_type_resolves_to_that_single_owner_unchanged()
    {
        var index = IndexOf(UniqueOwner);
        index.ResolveCanonicalOwner("Widget", "Gamma").ShouldBe("Alpha");
        index.ResolveCanonicalOwner("Widget", "Alpha").ShouldBe("Alpha");
    }

    private const string SharedKernel = """
        context Alpha {
          value Coin { amount: Int }
        }
        context Beta {
          value Coin { amount: Int }
        }
        contextmap {
          Alpha -> Beta : shared-kernel { Coin }
        }
        """;

    [Fact]
    public void Shared_kernel_type_resolves_to_its_canonical_kernel_owner_unchanged()
    {
        var index = IndexOf(SharedKernel);
        index.IsSharedKernelType("Coin").ShouldBeTrue();
        // A shared-kernel type is physically homed in one canonical owner's module regardless of the
        // referencing context — unchanged from the pre-#1091 behaviour.
        index.ResolveCanonicalOwner("Coin", "Beta").ShouldBe("Alpha");
        index.ResolveCanonicalOwner("Coin", "Alpha").ShouldBe("Alpha");
    }

    [Fact]
    public void A_non_declared_name_has_no_qualifiable_owner()
    {
        var index = IndexOf(UniqueOwner);
        index.ResolveCanonicalOwner("Nonexistent", "Gamma").ShouldBeNull();
    }
}
