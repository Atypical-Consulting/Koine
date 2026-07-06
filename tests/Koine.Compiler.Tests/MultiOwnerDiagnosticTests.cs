using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1091 — the validation warning (KOI1419) that surfaces an ambiguous multi-owner cross-context
/// type reference to the modeller. When a type declared in more than one bounded context is referenced
/// from a third, the flat-module emitters must pick a canonical owner to qualify it; this diagnostic
/// makes that otherwise-silent choice visible, naming the declaring contexts and the chosen owner.
/// </summary>
public class MultiOwnerDiagnosticTests
{
    private static IReadOnlyList<Diagnostic> MultiOwnerWarnings(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        // A warning does not fail the build.
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Diagnostics
            .Where(d => d.Code == DiagnosticCodes.AmbiguousMultiOwnerReference)
            .ToList();
    }

    // `Money` is declared in Alpha and Beta; Gamma references it un-imported, un-qualified, and the
    // context map permits it from BOTH Alpha and Beta — so no single signal determines the owner and the
    // resolver falls back to the ordinal-least (Alpha). Line 8 (1-based) is the `balance: Money` ref.
    private const string GenuinelyAmbiguousFixture = """
        context Alpha {
          value Money { amount: Int }
        }
        context Beta {
          value Money { amount: Int }
        }
        context Gamma {
          value Wallet { balance: Money }
        }
        contextmap {
          Alpha -> Gamma : open-host
          Beta -> Gamma : open-host
        }
        """;

    [Fact]
    public void Genuinely_ambiguous_multi_owner_reference_warns_once_naming_owners_and_canonical()
    {
        var warnings = MultiOwnerWarnings(GenuinelyAmbiguousFixture);

        // Exactly one warning, for the single genuinely-ambiguous reference.
        warnings.Count.ShouldBe(1);

        var w = warnings[0];
        w.Severity.ShouldBe(DiagnosticSeverity.Warning);
        // The message names the type, both declaring contexts, the referencing context, and the owner.
        w.Message.ShouldContain("Money");
        w.Message.ShouldContain("Alpha");
        w.Message.ShouldContain("Beta");
        w.Message.ShouldContain("Gamma");
        // It carries the reference's own source span (the `balance: Money` line), not a placeholder 0/0.
        w.Line.ShouldBe(8);
        w.Column.ShouldBeGreaterThan(0);
    }

    // A single import (Alpha) determines the owner unambiguously, so the reference is NOT ambiguous —
    // KOI1419 must stay silent even though Money is declared in both Alpha and Beta.
    private const string SingleImportFixture = """
        context Alpha {
          value Money { amount: Int }
        }
        context Beta {
          value Money { amount: Int }
        }
        context Gamma {
          import Alpha.{ Money }
          value Wallet { balance: Money }
        }
        """;

    [Fact]
    public void A_single_import_determines_the_owner_and_stays_silent()
    {
        MultiOwnerWarnings(SingleImportFixture).ShouldBeEmpty();
    }

    // Gamma references `Beta.Money` with an EXPLICIT qualifier — the modeller has disambiguated, so the
    // reference is not ambiguous and KOI1419 must stay silent (it names the same owner the emitters pick).
    private const string ExplicitQualifierFixture = """
        context Alpha {
          value Money { amount: Int }
        }
        context Beta {
          value Money { amount: Int }
        }
        context Gamma {
          value Wallet { balance: Beta.Money }
        }
        """;

    [Fact]
    public void An_explicit_qualifier_suppresses_the_ambiguous_multi_owner_warning()
    {
        MultiOwnerWarnings(ExplicitQualifierFixture).ShouldBeEmpty();
    }
}
