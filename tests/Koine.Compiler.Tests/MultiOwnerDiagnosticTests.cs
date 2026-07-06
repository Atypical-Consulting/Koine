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
    // `Money` is declared in Alpha and Beta; Gamma imports it from Alpha and references it once.
    // Line 9 (1-based) is the `balance: Money` reference the warning must point at.
    private const string MultiOwnerFixture = """
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
    public void Multi_owner_cross_context_reference_warns_once_naming_owners_and_canonical()
    {
        var result = new KoineCompiler().Compile(MultiOwnerFixture, new CSharpEmitter());
        // A warning does not fail the build.
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var warnings = result.Diagnostics
            .Where(d => d.Code == DiagnosticCodes.AmbiguousMultiOwnerReference)
            .ToList();

        // Exactly one warning, for the single ambiguous reference.
        warnings.Count.ShouldBe(1);

        var w = warnings[0];
        w.Severity.ShouldBe(DiagnosticSeverity.Warning);
        // The message names the type, both declaring contexts, the referencing context, and the owner.
        w.Message.ShouldContain("Money");
        w.Message.ShouldContain("Alpha");
        w.Message.ShouldContain("Beta");
        w.Message.ShouldContain("Gamma");
        // It carries the reference's own source span (the `balance: Money` line), not a placeholder 0/0.
        w.Line.ShouldBe(9);
        w.Column.ShouldBeGreaterThan(0);
    }
}
