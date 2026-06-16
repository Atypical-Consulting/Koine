using Koine.Cli;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// R16.1: configured C# emitter options. A <c>targets.csharp.namespaces.&lt;Context&gt;</c> remap
/// must relocate a context's emitted namespace consistently — the namespace declaration, the
/// file's folder, cross-context <c>using</c>s, and fully-qualified type references all move with
/// it — while an empty options bag stays byte-identical to the unconfigured emitter.
/// </summary>
public class R16NamespaceMapTests
{
    // Two contexts: Sales imports Billing.Money (an unqualified cross-context use, needing a
    // `using`) and also references it qualified as `Billing.Money` (a fully-qualified ref).
    private const string CrossContextFixture = """
        context Billing {
          enum Currency { EUR, USD }
          value Money { amount: Decimal  currency: Currency }
        }
        context Sales {
          import Billing.{ Money }
          entity Quote identified by QuoteId { price: Money  freight: Billing.Money }
        }
        """;

    private static IReadOnlyList<EmittedFile> Emit(string fixture, CSharpEmitterOptions options)
    {
        var result = new KoineCompiler().Compile(fixture, new CSharpEmitter(options));
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static CSharpEmitterOptions MapBilling(string to) =>
        new(new Dictionary<string, string>(StringComparer.Ordinal) { ["Billing"] = to });

    private static EmittedFile File(IReadOnlyList<EmittedFile> files, string suffix) =>
        files.Single(f => f.RelativePath.EndsWith(suffix, StringComparison.Ordinal));

    [Fact]
    public void Empty_options_emit_byte_identical_to_default_emitter()
    {
        var defaultFiles = Emit(CrossContextFixture, CSharpEmitterOptions.Empty);
        var defaultRender = TestSupport.Render(defaultFiles);

        var unconfigured = TestSupport.Render(
            new KoineCompiler().Compile(CrossContextFixture, new CSharpEmitter()).Files);

        Assert.Equal(unconfigured, defaultRender);
    }

    [Fact]
    public void Namespace_remap_changes_the_emitted_namespace_declaration_and_folder()
    {
        var files = Emit(CrossContextFixture, MapBilling("Acme.Billing"));

        // The remapped context's types live under the new namespace AND the new folder.
        var money = File(files, "Money.cs");
        Assert.StartsWith("Acme/Billing/", money.RelativePath);
        Assert.Contains("namespace Acme.Billing;", money.Contents);
        Assert.DoesNotContain("namespace Billing;", money.Contents);

        // An unmapped context is untouched.
        var quote = File(files, "Quote.cs");
        Assert.StartsWith("Sales/", quote.RelativePath);
        Assert.Contains("namespace Sales;", quote.Contents);
    }

    [Fact]
    public void Namespace_remap_rewrites_cross_context_usings_and_qualified_refs()
    {
        var files = Emit(CrossContextFixture, MapBilling("Acme.Billing"));
        var quote = File(files, "Quote.cs");

        // The imported (unqualified) cross-context use now imports the remapped namespace.
        Assert.Contains("using Acme.Billing;", quote.Contents);
        Assert.DoesNotContain("using Billing;", quote.Contents);

        // The fully-qualified reference (`Billing.Money` in the model) is rewritten too, so the
        // relocated context is referenced by its new namespace everywhere.
        Assert.Contains("Acme.Billing.Money", quote.Contents);
        // The bare `Billing.Money` qualifier must not survive (guard against a substring of the new one).
        Assert.DoesNotContain(" Billing.Money", quote.Contents);
    }

    [Fact]
    public void Remapping_one_context_leaves_an_unmapped_context_unchanged_byte_for_byte()
    {
        var baseline = Emit(CrossContextFixture, CSharpEmitterOptions.Empty);
        var remapped = Emit(CrossContextFixture, MapBilling("Acme.Billing"));

        // The Currency enum lives in Billing -> it moves; QuoteId lives in Sales -> it must not.
        var baselineQuoteId = File(baseline, "ValueObjects/QuoteId.cs");
        var remappedQuoteId = File(remapped, "ValueObjects/QuoteId.cs");
        Assert.Equal(baselineQuoteId.RelativePath, remappedQuoteId.RelativePath);
        Assert.Equal(baselineQuoteId.Contents, remappedQuoteId.Contents);
    }

    // A derived Sales member whose `let … in` body returns a cross-context value type
    // (`Billing.Money`). The IIFE the C# emitter lowers `let` to names its delegate with the
    // body's type, which must honour the namespace remap so the file does not mix old + new
    // namespaces (and therefore still compiles).
    private const string LetReturningCrossContextFixture = """
        context Billing {
          enum Currency { EUR, USD }
          value Money { amount: Decimal  currency: Currency }
        }
        context Sales {
          entity Quote identified by QuoteId {
            freight: Billing.Money
            freightCopy: Billing.Money = let f = freight in f
          }
        }
        """;

    [Fact]
    public void Let_iife_return_type_honours_the_namespace_remap_and_compiles()
    {
        var files = Emit(LetReturningCrossContextFixture, MapBilling("Acme.Billing"));
        var quote = File(files, "Quote.cs");

        // The IIFE delegate's return type is the remapped, fully-qualified cross-context type.
        Assert.Contains("System.Func<Acme.Billing.Money>", quote.Contents);
        // The stale, unmapped qualifier must not survive anywhere in the file.
        Assert.DoesNotContain("System.Func<Billing.Money>", quote.Contents);
        Assert.DoesNotContain(" Billing.Money", quote.Contents);

        // The whole tree must Roslyn-compile: the file no longer mixes old + new namespaces.
        var (assembly, errors) = TestSupport.Compile(files);
        Assert.True(assembly is not null, string.Join("\n", errors));
    }

    [Fact]
    public void Let_iife_return_type_is_byte_identical_without_options()
    {
        // Default (no-options) output is unchanged by threading options through the translator.
        var defaultFiles = new KoineCompiler()
            .Compile(LetReturningCrossContextFixture, new CSharpEmitter()).Files;
        var emptyFiles = Emit(LetReturningCrossContextFixture, CSharpEmitterOptions.Empty);

        Assert.Equal(TestSupport.Render(defaultFiles), TestSupport.Render(emptyFiles));
    }

    [Fact]
    public void Cli_maps_parsed_namespace_block_into_the_emitter_options()
    {
        var config = KoineConfig.Parse("""
            target = csharp
            targets.csharp.namespaces.Billing = Acme.Billing
            targets.csharp.instantMode = nodaTime
            """);
        var parsed = config.OptionsFor("csharp");

        Assert.Equal("Acme.Billing", parsed.NamespaceMap["Billing"]);
        Assert.Equal("nodaTime", parsed.InstantMode);
    }
}
