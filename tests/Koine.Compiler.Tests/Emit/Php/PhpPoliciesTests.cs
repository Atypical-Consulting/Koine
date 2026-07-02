using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// PHP emitter — policy slice (R10.3). Verifies that <see cref="PhpEmitter"/> emits a cross-aggregate
/// policy as a reactor <c>interface</c> seam (<c>&lt;Name&gt;Policy</c> with
/// <c>react(&lt;Event&gt; $event): void</c>), with the intended <c>&lt;Target&gt;::&lt;command&gt;(…)</c>
/// reaction documented in the docblock and NEVER generated imperatively — matching the C#/Python/TS
/// "no imperative logic in the model" stance.
/// </summary>
public class PhpPoliciesTests
{
    /// <summary>
    /// A focused policy cross-section: a domain <c>event</c>, an aggregate with a <c>command</c>, and a
    /// <c>policy … when &lt;Event&gt; then &lt;Aggregate&gt;.&lt;command&gt;(arg: &lt;eventField&gt;)</c>.
    /// </summary>
    private const string PolicyFixture = """
        context Sales {
          /// Recorded when a charge is captured. Triggers the ledger-posting policy.
          event ChargeCaptured {
            charge:         Int
            capturedAmount: Decimal
          }

          aggregate Books root LedgerEntry {
            entity LedgerEntry identified by LedgerEntryId {
              charge:  Int
              balance: Decimal

              /// Post an amount to the ledger entry.
              command record(amount: Decimal) {
                balance -> amount
              }
            }
          }

          /// R10.3 — react to a captured charge by posting it to the ledger.
          policy PostToLedger when ChargeCaptured then Books.record(amount: capturedAmount)
        }
        """;

    private static IReadOnlyList<EmittedFile> Emit(string source)
    {
        var result = new KoineCompiler().Compile(source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static string FileContent(IReadOnlyList<EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    [Fact]
    public void Policy_emits_reactor_interface_with_documented_reaction()
    {
        var files = Emit(PolicyFixture);

        // Emitted into the Policies/ subfolder, file named for the <Name>Policy class.
        files.ShouldContain(f => f.RelativePath == "src/Sales/Policies/PostToLedgerPolicy.php");
        var content = FileContent(files, "src/Sales/Policies/PostToLedgerPolicy.php");

        // PHP file header.
        content.ShouldContain("<?php");
        content.ShouldContain("declare(strict_types=1)");
        content.ShouldContain("namespace Koine\\Sales\\Policies");

        // The triggering event lives in a sibling namespace and must be imported.
        content.ShouldContain("use Koine\\Sales\\Events\\ChargeCaptured;");

        // A reactor INTERFACE seam — not a class.
        content.ShouldContain("interface PostToLedgerPolicy");
        content.ShouldNotContain("class PostToLedgerPolicy");

        // The seam: a bodyless `react` method (ends in `;`), typed on the triggering event.
        content.ShouldContain("public function react(ChargeCaptured $event): void;");

        // The intended reaction is DOCUMENTED (rooted at $event), never generated imperatively.
        content.ShouldContain("Intended reaction:");
        content.ShouldContain("Books::record(amount: $event->capturedAmount)");
        content.ShouldContain("does not generate");
    }

    [Fact]
    public Task Policy_snapshot()
    {
        var files = Emit(PolicyFixture);
        var content = FileContent(files, "src/Sales/Policies/PostToLedgerPolicy.php");
        return Verify(content);
    }
}
