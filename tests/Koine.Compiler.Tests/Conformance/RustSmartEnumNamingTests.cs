using System.Text.RegularExpressions;
using Koine.Compiler.Emit.Rust;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Regression for issue #315: two smart-enum members that differ only by the case of a NON-leading
/// character (<c>userID</c> vs <c>userId</c>) both snake_case-collapse to the same binding
/// (<c>user_id</c>). The Rust emitter derives each <c>match_</c>/<c>switch</c> closure-parameter name
/// from that snake_case form, so the collision produced two parameters named <c>user_id</c> —
/// non-compiling Rust (<c>E0415</c> identifier bound more than once). The fix de-duplicates the
/// per-enum binding names so each member maps to a distinct, compiling Rust binding.
/// <para>
/// The sibling case (issue #323) is the enum <b>variant</b> surface: two members that fold to the same
/// <c>PascalCase</c> variant under <c>RustNaming.Variant</c> (<c>EUR</c> vs <c>Eur</c>, both → <c>Eur</c>)
/// produced two identical variant declarations — non-compiling Rust (<c>E0428</c> duplicate definition).
/// The fix de-duplicates the per-enum variant names and threads the shared member→variant map through
/// every emission and reference site so each member maps to a distinct, compiling Rust variant.
/// </para>
/// </summary>
public class RustSmartEnumNamingTests
{
    private const string NoToolchainNotice =
        "No usable Rust toolchain (cargo, networked) available; cargo check not run.";

    /// <summary>
    /// The minimal repro from #315: an enum with two members distinguished only by an inner
    /// character's case, referenced from a value object.
    /// </summary>
    private const string CollapsingMembersFixture = """
        context Identity {
          enum ActorKind { userID, userId, System }

          value Actor {
            kind:  ActorKind
            label: String
            isUser: Bool = kind != ActorKind.System
          }
        }
        """;

    [Fact]
    public void Smart_enum_members_that_snake_case_collapse_emit_distinct_bindings()
    {
        var result = new KoineCompiler().Compile(CollapsingMembersFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var identity = result.Files
            .Single(f => f.RelativePath.EndsWith("identity.rs", StringComparison.Ordinal)).Contents;

        // Each member contributes one `match_` closure parameter. `userID` and `userId` both
        // snake_case to `user_id`; before the fix that produced two parameters with the same name
        // (non-compiling Rust). The three members must yield three DISTINCT binding names.
        var bindings = Regex.Matches(identity, @"(\w+): impl FnOnce\(\) -> R")
            .Select(m => m.Groups[1].Value)
            .ToList();

        bindings.Count.ShouldBe(3, $"expected three match_ closure parameters, got: {string.Join(", ", bindings)}");
        bindings.Distinct(StringComparer.Ordinal).Count()
            .ShouldBe(bindings.Count, $"bindings must be injective, got: {string.Join(", ", bindings)}");
    }

    [Fact]
    public void Smart_enum_with_collapsing_members_compiles()
    {
        var result = new KoineCompiler().Compile(CollapsingMembersFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// The #323 repro: an enum with two members that PascalCase-collapse to the same variant
    /// (<c>EUR</c> and <c>Eur</c> both → <c>Eur</c>), referenced from a value object (the colliding
    /// second member is referenced so the expression translator must resolve through the shared map too).
    /// </summary>
    private const string CollapsingVariantsFixture = """
        context Money {
          enum Currency { EUR, Eur }

          value Price {
            amount:   Decimal
            currency: Currency
            isLegacy: Bool = currency == Currency.Eur
          }
        }
        """;

    [Fact]
    public void Smart_enum_members_that_variant_collapse_emit_distinct_variants()
    {
        var result = new KoineCompiler().Compile(CollapsingVariantsFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files
            .Single(f => f.RelativePath.EndsWith("money.rs", StringComparison.Ordinal)).Contents;

        // The two members `EUR` and `Eur` both fold to the variant `Eur`; before the fix the enum
        // declaration emitted two identical `Eur,` variants (non-compiling Rust). Extract the variant
        // declarations from `pub enum Currency { ... }` and assert they are DISTINCT.
        var enumBody = Regex.Match(money, @"pub enum Currency \{\n(.*?)\n\}", RegexOptions.Singleline)
            .Groups[1].Value;
        var variants = Regex.Matches(enumBody, @"^\s*(\w+),\s*$", RegexOptions.Multiline)
            .Select(m => m.Groups[1].Value)
            .ToList();

        variants.Count.ShouldBe(2, $"expected two enum variants, got: {string.Join(", ", variants)}");
        variants.Distinct(StringComparer.Ordinal).Count()
            .ShouldBe(variants.Count, $"variants must be injective, got: {string.Join(", ", variants)}");
    }

    [Fact]
    public void Smart_enum_with_collapsing_variants_compiles()
    {
        var result = new KoineCompiler().Compile(CollapsingVariantsFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// A reference to the colliding (second) member must resolve to the SAME disambiguated variant the
    /// declaration emits — the expression translator and the enum emitter share one member→variant map,
    /// so the derived `is_legacy` accessor reads `Currency::Eur2`, not a (wrong) second `Currency::Eur`.
    /// </summary>
    [Fact]
    public void Member_reference_resolves_to_the_disambiguated_variant()
    {
        var result = new KoineCompiler().Compile(CollapsingVariantsFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files
            .Single(f => f.RelativePath.EndsWith("money.rs", StringComparison.Ordinal)).Contents;

        money.ShouldContain("Currency::Eur2", customMessage:
            "the `currency == Currency.Eur` reference must lower to the disambiguated `Currency::Eur2`");
    }

    [Fact]
    public void UniqueVariants_disambiguates_a_three_way_collapse_in_declaration_order()
    {
        // `EUR`, `Eur`, `eur` all fold to the variant `Eur`; the first keeps it, the rest take the
        // deterministic `2`, `3` suffixes.
        RustNaming.UniqueVariants(["EUR", "Eur", "eur"])
            .ShouldBe(["Eur", "Eur2", "Eur3"]);
    }

    [Fact]
    public void UniqueVariants_increments_past_a_member_whose_natural_variant_is_an_already_taken_suffix()
    {
        // A member literally named `Eur2` occupies the first disambiguator, so the colliding `Eur` skips
        // to `Eur3` — the suffix loop keeps going until the name is genuinely unique.
        RustNaming.UniqueVariants(["EUR", "Eur2", "Eur"])
            .ShouldBe(["Eur", "Eur2", "Eur3"]);
    }

    [Fact]
    public void UniqueVariants_leaves_non_colliding_members_byte_for_byte_unchanged()
    {
        // No collisions: each member keeps its idiomatic `Variant` form (acronyms title-folded), no suffix.
        RustNaming.UniqueVariants(["USD", "EUR", "Draft"])
            .ShouldBe(["Usd", "Eur", "Draft"]);
    }
}
