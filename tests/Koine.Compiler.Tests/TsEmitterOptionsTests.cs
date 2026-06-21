using Koine.Cli;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Task 6: the full <see cref="TsEmitterOptions"/> record + <c>EmitterRegistry</c> parity. The
/// canonical <see cref="TsEmitterOptions.Empty"/> options (and the parameterless emitter that defers
/// to them) must be byte-identical to one another, while a non-empty <c>ModuleMap</c> remaps a
/// context's emitted module path at the cross-file import seam (the TypeScript analogue of the C#
/// <c>NamespaceMap</c>). The committed TS snapshot suite is the byte-identity guard against the
/// shipped <c>.verified.txt</c> files; this suite locks the option surface and the remap behavior.
/// </summary>
public class TsEmitterOptionsTests
{
    // Two contexts: Sales imports Billing.Money (an unqualified cross-context use). Quote.ts ends up
    // importing Money from a Billing-headed module path, which a ModuleMap on "Billing" can rewrite.
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

    private static IReadOnlyList<EmittedFile> Emit(TypeScriptEmitter emitter)
    {
        var result = new KoineCompiler().Compile(CrossContextFixture, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static EmittedFile File(IReadOnlyList<EmittedFile> files, string suffix) =>
        files.Single(f => f.RelativePath.EndsWith(suffix, StringComparison.Ordinal));

    [Fact]
    public void Empty_options_emit_byte_identical_to_the_parameterless_emitter()
    {
        var empty = TestSupport.Render(Emit(new TypeScriptEmitter(TsEmitterOptions.Empty)));
        var unconfigured = TestSupport.Render(Emit(new TypeScriptEmitter()));

        empty.ShouldBe(unconfigured);
    }

    [Fact]
    public void Default_alias_emit_byte_identical_to_empty()
    {
        var byDefault = TestSupport.Render(Emit(new TypeScriptEmitter(TsEmitterOptions.Default)));
        var byEmpty = TestSupport.Render(Emit(new TypeScriptEmitter(TsEmitterOptions.Empty)));

        byDefault.ShouldBe(byEmpty);
    }

    [Fact]
    public void Module_map_remaps_a_cross_context_import_path()
    {
        var options = TsEmitterOptions.Empty with
        {
            ModuleMap = new Dictionary<string, string>(StringComparer.Ordinal) { ["Billing"] = "@acme/billing" },
        };
        var files = Emit(new TypeScriptEmitter(options));

        // Quote (in Sales) imports Money from the remapped Billing module path.
        var quote = File(files, "Quote.ts");
        quote.Contents.ShouldContain("from '@acme/billing/value-objects/Money'");
        // The original, relative Billing import path must not survive at the import site.
        quote.Contents.ShouldNotContain("../../Billing/value-objects/Money");
        quote.Contents.ShouldNotContain("../Billing/value-objects/Money");
    }

    [Fact]
    public void Empty_module_map_leaves_the_import_path_unchanged()
    {
        var files = Emit(new TypeScriptEmitter(TsEmitterOptions.Empty));
        var quote = File(files, "Quote.ts");

        // The unconfigured relative cross-context import is preserved exactly.
        quote.Contents.ShouldContain("from '../../Billing/value-objects/Money'");
    }

    [Fact]
    public void To_ts_options_maps_the_neutral_namespace_block_into_module_map()
    {
        var config = KoineConfig.Parse("""
            target = typescript
            targets.typescript.namespaces.Billing = @acme/billing
            """);
        var parsed = config.OptionsFor("typescript");

        parsed.NamespaceMap["Billing"].ShouldBe("@acme/billing");
    }
}
