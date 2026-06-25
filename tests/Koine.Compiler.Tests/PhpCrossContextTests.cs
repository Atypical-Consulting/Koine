using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// PHP emitter — cross-context type disambiguation (issue #394). When two bounded contexts declare a
/// type with the same short name (e.g. <c>Money</c> in both Menu and Payment), the PHP emitter must
/// resolve every reference to the FQN of the context it was <em>declared</em> in — not whichever copy a
/// flat last-writer-wins catalog happened to keep. Where a single file genuinely references two
/// same-named classes (the anti-corruption-layer <c>X -&gt; X</c> shape) PHP cannot <c>use</c> both
/// under one bare name, so the loser is imported <c>use … as &lt;Ctx&gt;&lt;Name&gt;</c> and its
/// reference sites rewritten to the alias. Emitted file names that would collide are qualified with the
/// publisher/upstream context.
/// </summary>
public class PhpCrossContextTests
{
    private static IReadOnlyList<EmittedFile> Emit(string source)
    {
        var result = new KoineCompiler().Compile(source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static string FileContent(IReadOnlyList<EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    // -----------------------------------------------------------------------
    // Task 1 — per-symbol resolution against the declaring context
    // -----------------------------------------------------------------------

    /// <summary>
    /// Two contexts each declare <c>value Money</c>; Menu's <c>MenuItem</c> read model projects a
    /// Menu <c>Money</c>. Its <c>use</c> must point at Menu's copy — the flat catalog kept Payment's
    /// (declared last) and wrongly imported <c>Koine\Payment\ValueObjects\Money</c>, which fatals under
    /// <c>declare(strict_types=1)</c> when the projection runs.
    /// </summary>
    private const string SameNameFixture = """
        context Menu {
          value Money {
            amount: Decimal
            invariant amount >= 0  "a price cannot be negative"
          }
          aggregate Catalog root Pizza {
            entity Pizza identified by PizzaCode as natural(String) {
              name:      String
              basePrice: Money
            }
          }
          readmodel MenuItem from Pizza {
            name
            basePrice
          }
        }
        context Payment {
          value Money {
            amount: Decimal
          }
        }
        """;

    [Fact]
    public void Read_model_field_resolves_to_its_own_contexts_same_named_type()
    {
        var files = Emit(SameNameFixture);
        var content = FileContent(files, "src/Menu/ReadModels/MenuItem.php");

        // basePrice is a Menu Money — the import must be Menu's, never Payment's.
        content.ShouldContain("use Koine\\Menu\\ValueObjects\\Money;");
        content.ShouldNotContain("use Koine\\Payment\\ValueObjects\\Money;");
    }
}
