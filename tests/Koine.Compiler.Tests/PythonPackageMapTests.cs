using Koine.Cli;
using Koine.Cli.Infrastructure;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The Python emitter's package remap (<c>targets.python.namespaces.&lt;Context&gt;</c>) must honour
/// the mixed-case context key the user writes in <c>koine.config</c>. The emitter computes package
/// heads in <c>snake_case</c> (<c>Catalog → catalog</c>), so the config key has to be matched in that
/// same form — otherwise a perfectly valid <c>Catalog = acme.catalog</c> entry silently no-ops. This
/// drives the whole chain: config text → parsed <see cref="TargetOptions"/> →
/// <see cref="EmitterRegistry"/> → emitted folder + import paths.
/// </summary>
public class PythonPackageMapTests
{
    // One context, two value objects where Product references Sku — so the emitted Product module
    // both lives under the context's package folder AND imports Sku via that package path. A remap
    // therefore has to move the file and rewrite the import together.
    private const string Fixture = """
        context Catalog {
          value Sku { code: String }
          value Product {
            sku:  Sku
            name: String
          }
        }
        """;

    private static IReadOnlyList<EmittedFile> EmitPythonWithConfig(string config)
    {
        var options = KoineConfig.Parse(config).OptionsFor("python");
        Assert.True(EmitterRegistry.TryCreate("python", options, out var emitter));
        var result = new KoineCompiler().Compile(Fixture, emitter);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static EmittedFile File(IReadOnlyList<EmittedFile> files, string suffix) =>
        files.Single(f => f.RelativePath.EndsWith(suffix, StringComparison.Ordinal));

    [Fact]
    public void Mixed_case_package_remap_key_relocates_folder_and_imports()
    {
        // The config key is the context as the user writes it: PascalCase `Catalog`.
        var files = EmitPythonWithConfig("""
            target = python
            targets.python.namespaces.Catalog = acme.catalog
            """);

        // The remapped context's modules live under the new package folder...
        var product = File(files, "product.py");
        Assert.Equal("acme/catalog/value_objects/product.py", product.RelativePath);

        // ...and an intra-context import resolves Sku through the remapped dotted package.
        Assert.Contains("from acme.catalog.value_objects.sku import Sku", product.Contents);

        // The un-remapped `catalog` package head must not survive anywhere.
        Assert.DoesNotContain("from catalog.", product.Contents);
        Assert.DoesNotContain("from catalog.", File(files, "sku.py").Contents);
        Assert.False(
            files.Any(f => f.RelativePath.StartsWith("catalog/", StringComparison.Ordinal)),
            "no module should remain under the un-remapped `catalog/` folder");
    }
}
