using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="ModelIndex.ResolveOwner(string, string)"/> — the shared, target-agnostic owner
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
        index.ResolveOwner("Money", "Gamma").Owner.ShouldBe("Alpha");
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
        index.ResolveOwner("Money", "Gamma").Owner.ShouldBe("Beta");
    }

    [Fact]
    public void Multi_owner_reference_from_within_an_owning_context_binds_locally()
    {
        var index = IndexOf(MultiOwnerNoImport);
        // #437: a reference from within one of the type's OWN owning contexts binds to the local
        // sibling, so the resolver returns that same context (the mapper then emits a bare name).
        index.ResolveOwner("Money", "Alpha").Owner.ShouldBe("Alpha");
        index.ResolveOwner("Money", "Beta").Owner.ShouldBe("Beta");
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
        index.ResolveOwner("Widget", "Gamma").Owner.ShouldBe("Alpha");
        index.ResolveOwner("Widget", "Alpha").Owner.ShouldBe("Alpha");
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
        index.ResolveOwner("Coin", "Beta").Owner.ShouldBe("Alpha");
        index.ResolveOwner("Coin", "Alpha").Owner.ShouldBe("Alpha");
    }

    [Fact]
    public void A_non_declared_name_has_no_qualifiable_owner()
    {
        var index = IndexOf(UniqueOwner);
        index.ResolveOwner("Nonexistent", "Gamma").Owner.ShouldBeNull();
    }

    // ---- ResolveOwner: the owner PLUS whether the choice was the ambiguous multi-owner tie-break ----
    // WasAmbiguous is the single source of truth KOI1419 and the flat-module mappers now share, so it
    // must be true ONLY for the multi-owner-from-a-third-context branch and false everywhere else.

    [Fact]
    public void ResolveOwner_flags_the_multi_owner_ordinal_fallback_as_ambiguous()
    {
        var index = IndexOf(MultiOwnerNoImport);
        var res = index.ResolveOwner("Money", "Gamma");
        res.Owner.ShouldBe("Alpha");
        res.WasAmbiguous.ShouldBeTrue();
    }

    [Fact]
    public void ResolveOwner_does_not_flag_a_single_import_choice_as_ambiguous()
    {
        var index = IndexOf(MultiOwnerImportFromLarger);
        // A single import determines the owner unambiguously — the reference IS Beta.Money — so the
        // choice is NOT ambiguous (KOI1419 must stay silent for it), even though Money is multi-owner.
        var res = index.ResolveOwner("Money", "Gamma");
        res.Owner.ShouldBe("Beta");
        res.WasAmbiguous.ShouldBeFalse();
    }

    [Fact]
    public void ResolveOwner_does_not_flag_a_local_bind_as_ambiguous()
    {
        var index = IndexOf(MultiOwnerNoImport);
        var res = index.ResolveOwner("Money", "Alpha");
        res.Owner.ShouldBe("Alpha");
        res.WasAmbiguous.ShouldBeFalse();
    }

    [Fact]
    public void ResolveOwner_does_not_flag_a_unique_owner_as_ambiguous()
    {
        var index = IndexOf(UniqueOwner);
        var res = index.ResolveOwner("Widget", "Gamma");
        res.Owner.ShouldBe("Alpha");
        res.WasAmbiguous.ShouldBeFalse();
    }

    [Fact]
    public void ResolveOwner_does_not_flag_a_shared_kernel_type_as_ambiguous()
    {
        var index = IndexOf(SharedKernel);
        var res = index.ResolveOwner("Coin", "Beta");
        res.Owner.ShouldBe("Alpha");
        res.WasAmbiguous.ShouldBeFalse();
    }

    [Fact]
    public void ResolveOwner_returns_a_null_owner_and_no_ambiguity_for_a_non_declared_name()
    {
        var index = IndexOf(UniqueOwner);
        var res = index.ResolveOwner("Nonexistent", "Gamma");
        res.Owner.ShouldBeNull();
        res.WasAmbiguous.ShouldBeFalse();
    }

    // ---- #1124: an explicit Context.T qualifier and a context-map permit both pin the owner ----

    [Fact]
    public void Explicit_qualifier_pins_the_owner_over_the_ordinal_default()
    {
        var index = IndexOf(MultiOwnerNoImport);
        // Money is declared in Alpha and Beta; the ordinal-least default from a third context is Alpha,
        // but an explicit `Beta.Money` qualifier is the modeller's intent and must win — determinately.
        var res = index.ResolveOwner("Money", "Beta", "Gamma");
        res.Owner.ShouldBe("Beta");
        res.WasAmbiguous.ShouldBeFalse();
    }

    // Money in Alpha + Beta; the context map lets Gamma reference Beta's types without an import
    // (`Beta -> Gamma : open-host`), so an un-imported, un-qualified reference resolves to Beta.
    private const string MapPermittedUnimported = """
        context Alpha {
          value Money { amount: Int }
        }
        context Beta {
          value Money { amount: Int }
        }
        context Gamma {
          value Wallet { balance: Int }
        }
        contextmap {
          Beta -> Gamma : open-host
        }
        """;

    [Fact]
    public void Map_permitted_un_imported_owner_resolves_to_that_owner()
    {
        var index = IndexOf(MapPermittedUnimported);
        // A single map-permitted upstream (Beta) determines the owner — not the ordinal-least Alpha —
        // and is not ambiguous.
        var res = index.ResolveOwner("Money", null, "Gamma");
        res.Owner.ShouldBe("Beta");
        res.WasAmbiguous.ShouldBeFalse();
    }

    [Fact]
    public void An_invalid_qualifier_is_ignored_and_falls_back()
    {
        var index = IndexOf(MultiOwnerNoImport);
        // A qualifier naming a context that does NOT declare the type is ignored by the resolver (it is
        // surfaced by ResolveReference instead), so resolution falls through to the ordinal-least default.
        var res = index.ResolveOwner("Money", "Nonexistent", "Gamma");
        res.Owner.ShouldBe("Alpha");
        res.WasAmbiguous.ShouldBeTrue();
    }
}
